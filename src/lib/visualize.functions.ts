import { createServerFn } from "@tanstack/react-start";

import catalogFull from "@/data/catalog-full.json";
import catalogSlim from "@/data/catalog-slim.json";
import {
  buildRenderRequest,
  isVisualizeMode,
  MAX_REFERENCES,
  type VisualizeMode,
  type VisualizeProduct,
} from "@/lib/visualize-prompt";

type StartInput = {
  /** One id for the placement modes; up to MAX_REFERENCES for refit_room. */
  productIds: string[];
  roomImageBase64: string;
  mode: VisualizeMode;
  aspectRatio?: string;
};

/** ~1024px longest edge at JPEG q0.85 lands well under this; anything larger is a client bug. */
const MAX_BASE64_CHARS = 8_000_000;

/**
 * What gpt-image accepts — verified against the live API, which rejects
 * anything else with "This aspect_ratio is not within the range of allowed
 * options". There is no "auto": a photo must be mapped to one of these three.
 *
 * Declared here rather than imported from kie.server.ts because the validator
 * below runs on the client too, and kie.server.ts must never reach the browser
 * bundle.
 */
const ASPECT_RATIOS = new Set(["1:1", "3:2", "2:3"]);

/** gpt-image's own default, and the closest match to a landscape room photo. */
const DEFAULT_ASPECT_RATIO = "3:2";

async function readCache(hash: string): Promise<string | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("visualizations")
      .select("image_url")
      .eq("hash", hash)
      .maybeSingle();
    return data?.image_url ?? null;
  } catch (err) {
    console.error("visualize cache read failed, generating instead", err);
    return null;
  }
}

async function writeCache(row: {
  hash: string;
  taskId: string;
  productId: string;
  mode: string;
}): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("visualizations").upsert({
      hash: row.hash,
      task_id: row.taskId,
      product_id: row.productId,
      mode: row.mode,
      image_url: null,
    });
  } catch (err) {
    // Costs a re-render next time the same photo comes through. Not fatal.
    console.error("visualize cache write failed", err);
  }
}

export const visualizeStart = createServerFn({ method: "POST" })
  .validator((input: StartInput) => {
    const productIds = Array.isArray(input?.productIds)
      ? input.productIds.filter((id) => typeof id === "string" && id.length > 0)
      : [];
    if (!productIds.length) throw new Error("productIds required");
    if (!input?.roomImageBase64 || typeof input.roomImageBase64 !== "string") {
      throw new Error("roomImageBase64 required");
    }
    if (input.roomImageBase64.length > MAX_BASE64_CHARS) {
      throw new Error("roomImageBase64 too large");
    }
    return {
      productIds: productIds.slice(0, MAX_REFERENCES),
      roomImageBase64: input.roomImageBase64,
      mode: isVisualizeMode(input.mode) ? input.mode : "replace",
      aspectRatio:
        typeof input.aspectRatio === "string" && ASPECT_RATIOS.has(input.aspectRatio)
          ? input.aspectRatio
          : DEFAULT_ASPECT_RATIO,
    };
  })
  .handler(async ({ data }): Promise<{ taskId?: string; imageUrl?: string }> => {
    try {
      const catalog = catalogFull as unknown as Record<string, VisualizeProduct>;
      const slim = catalogSlim as unknown as Array<{ id: string; col?: string }>;

      const products = data.productIds.map((id) => {
        const product = catalog[id];
        if (!product) throw new Error("PRODUCT_NOT_FOUND");
        if (!product.images?.[0]) throw new Error("PRODUCT_HAS_NO_IMAGE");
        return { ...product, col: slim.find((p) => p.id === id)?.col || null };
      });

      // prompt and reference list come from one call, so the prompt's
      // positional references always match the array actually sent
      const { prompt, imageUrls } = buildRenderRequest(products, data.mode);

      const { uploadToKie, createVisualizeTask } = await import("@/lib/kie.server");

      // Cache key: sha256(ids + mode + roomImageBase64). Mode is in the key
      // because the same photo and products render differently per mode.
      const encoded = new TextEncoder().encode(
        data.productIds.join(",") + data.mode + data.roomImageBase64,
      );
      const digest = await crypto.subtle.digest("SHA-256", encoded);
      const hash = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      // The cache is an optimisation, not a dependency. A Supabase outage or a
      // missing service-role key should make a render slow, not impossible, so
      // both the read and the write are best-effort.
      const cached = await readCache(hash);
      if (cached) return { imageUrl: cached };

      const roomUrl = await uploadToKie(data.roomImageBase64);
      const taskId = await createVisualizeTask(roomUrl, imageUrls, prompt, data.aspectRatio);

      await writeCache({
        hash,
        taskId,
        // The column holds one id; for a refit that is the lead reference.
        productId: data.productIds[0] as string,
        mode: data.mode,
      });

      return { taskId };
    } catch (err) {
      console.error("visualizeStart failed", err);
      if (err instanceof Error) {
        if (err.message === "PRODUCT_NOT_FOUND") throw new Error("PRODUCT_NOT_FOUND");
        // Same reasoning as the chat codes: a host missing its kie key needs a
        // different fix from a render that genuinely failed, so say which.
        if (err.message.includes("KIE_API_KEY")) throw new Error("VISUALIZE_NOT_CONFIGURED");
      }
      throw new Error("VISUALIZE_FAILED");
    }
  });

export const visualizeStatus = createServerFn({ method: "POST" })
  .validator((input: { taskId: string }) => {
    if (!input?.taskId || typeof input.taskId !== "string") throw new Error("taskId required");
    return { taskId: input.taskId };
  })
  .handler(async ({ data }): Promise<{ done: boolean; progress?: number; imageUrl?: string }> => {
    const { getTaskResult } = await import("@/lib/kie.server");
    let result;
    try {
      result = await getTaskResult(data.taskId);
    } catch (err) {
      console.error("visualizeStatus failed", err);
      throw new Error("VISUALIZE_FAILED");
    }

    if (!result.done) return { done: false, progress: result.progress };

    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin
        .from("visualizations")
        .update({ image_url: result.imageUrl })
        .eq("task_id", data.taskId);
    } catch (err) {
      // A cache write failure costs a re-render next time; it is not worth
      // failing a generation the customer is already looking at.
      console.error("visualizeStatus cache update failed", err);
    }

    return { done: true, imageUrl: result.imageUrl };
  });
