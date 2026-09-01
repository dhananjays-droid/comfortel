import { createServerFn } from "@tanstack/react-start";

import catalogFull from "@/data/catalog-full.json";
import catalogSlim from "@/data/catalog-slim.json";
import { resolveDims } from "@/lib/dims";
import { viewsFor } from "@/lib/product-views";
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
  /** Empty for staged_room, which invents the room instead of using one. */
  roomImageBase64: string;
  /** The customer's stated room size, when they gave one. */
  room?: { wallCm: number; depthCm?: number } | undefined;
  mode: VisualizeMode;
  aspectRatio?: string;
  /** Which part of the salon this render covers, for a zone render. */
  scene?: string;
  /** A fault the inspector found in a previous attempt at this same render. */
  correction?: string;
  /**
   * How many of each product to install, by id. Absent entries mean one.
   *
   * Kept separate from productIds rather than folded into it: one reference
   * image covers any number of the same piece, so repeating an id would send
   * the same photograph four times and spend fidelity on nothing.
   */
  quantities?: Record<string, number>;
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

/**
 * A plausible ceiling on one product's count in one render, and on how many
 * entries the map may carry. Both come from the browser, so both are bounded:
 * a count of 900 would reach the prompt verbatim.
 */
const MAX_QTY = 20;

function readQuantities(input: unknown): Record<string, number> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(input as Record<string, unknown>).slice(
    0,
    MAX_REFERENCES,
  )) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 1) continue;
    out[id] = Math.min(MAX_QTY, Math.round(n));
  }
  return out;
}

/** Stable regardless of key order, so the same plan always hashes the same. */
function quantityKey(quantities: Record<string, number>): string {
  return Object.keys(quantities)
    .sort()
    .map((id) => `${id}:${quantities[id]}`)
    .join(",");
}

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
    // staged_room is the one mode with nothing to upload: the references are
    // the input and the room is invented, so requiring a photo here is what
    // used to make a photo the price of admission for seeing your own plan.
    const staged = input?.mode === "staged_room";
    if (!staged && (!input?.roomImageBase64 || typeof input.roomImageBase64 !== "string")) {
      throw new Error("roomImageBase64 required");
    }
    if ((input.roomImageBase64?.length ?? 0) > MAX_BASE64_CHARS) {
      throw new Error("roomImageBase64 too large");
    }
    return {
      productIds: productIds.slice(0, MAX_REFERENCES),
      roomImageBase64: staged ? "" : input.roomImageBase64,
      // Rebuilt rather than trusted, and bounded: a hostile depth would
      // otherwise reach the prompt verbatim.
      ...(input.room && Number.isFinite(Number(input.room.wallCm))
        ? {
            room: {
              wallCm: Math.min(3000, Math.max(100, Math.round(Number(input.room.wallCm)))),
              ...(Number.isFinite(Number(input.room.depthCm))
                ? {
                    depthCm: Math.min(3000, Math.max(100, Math.round(Number(input.room.depthCm)))),
                  }
                : {}),
            },
          }
        : {}),
      // replace_all, not replace: single-unit replacement needs the model to
      // track one instance among identical units, which it does not do
      // reliably. replace_all has been correct in every live test, mirrors
      // included. See GUIDE.md.
      mode: isVisualizeMode(input.mode) ? input.mode : "replace_all",
      aspectRatio:
        typeof input.aspectRatio === "string" && ASPECT_RATIOS.has(input.aspectRatio)
          ? input.aspectRatio
          : DEFAULT_ASPECT_RATIO,
      // Free text, so it is length-capped: it lands inside the prompt, which has
      // a hard limit the assembler must still be able to honour.
      scene: typeof input.scene === "string" && input.scene.length <= 120 ? input.scene : undefined,
      correction:
        typeof input.correction === "string" && input.correction.length <= 400
          ? input.correction
          : undefined,
      quantities: readQuantities(input.quantities),
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
        // Spread conditionally: exactOptionalPropertyTypes rejects an explicit
        // undefined for an optional property.
        const views = viewsFor(id);
        const qty = data.quantities[id];
        return {
          ...product,
          col: slim.find((p) => p.id === id)?.col || null,
          // Recovered from the spec sheet when the catalogue lacked them, which
          // is 31 more products getting an accurate scale clause in the prompt.
          dims_cm: resolveDims(product),
          ...(views.length ? { views } : {}),
          ...(qty && qty > 1 ? { qty } : {}),
        };
      });

      // prompt and reference list come from one call, so the prompt's
      // positional references always match the array actually sent
      const { prompt, imageUrls } = buildRenderRequest(
        products,
        data.mode,
        data.scene,
        data.correction,
        data.room,
      );

      const { uploadToKie, createVisualizeTask } = await import("@/lib/kie.server");

      // Cache key: sha256(ids + mode + roomImageBase64). Mode is in the key
      // because the same photo and products render differently per mode.
      const encoded = new TextEncoder().encode(
        // The scene is part of the key: without it, two zone renders of the same
        // photo and product set would collide and the second would serve the
        // first's image.
        // The correction belongs in the key too. Without it a retry hashes
        // identically to the attempt it is retrying, hits the cache, and serves
        // back the very image the inspector just rejected.
        data.productIds.join(",") +
          data.mode +
          (data.scene ?? "") +
          (data.correction ?? "") +
          // Quantities change the prompt, so they change the image. Left out of
          // the key, a four-chair render would collide with the one-chair render
          // of the same plan and serve back the wrong picture.
          quantityKey(data.quantities) +
          // The stated room size changes the prompt, so it changes the image.
          `${data.room?.wallCm ?? ""}x${data.room?.depthCm ?? ""}` +
          data.roomImageBase64,
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

      const roomUrl = data.roomImageBase64 ? await uploadToKie(data.roomImageBase64) : null;
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
