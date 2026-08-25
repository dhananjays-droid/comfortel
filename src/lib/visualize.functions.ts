import { createServerFn } from "@tanstack/react-start";

import catalogFull from "@/data/catalog-full.json";
import catalogSlim from "@/data/catalog-slim.json";
import { buildSalonPrompt, type VisualizeMode, type VisualizeProduct } from "@/lib/visualize-prompt";

const ASPECT_RATIOS = new Set(["auto", "1:1", "3:2", "2:3"]);

type StartInput = {
  productId: string;
  roomImageBase64: string;
  mode: VisualizeMode;
  aspectRatio?: string;
};

export const visualizeStart = createServerFn({ method: "POST" })
  .inputValidator((input: StartInput) => {
    if (!input?.productId || typeof input.productId !== "string") {
      throw new Error("productId required");
    }
    if (!input?.roomImageBase64 || typeof input.roomImageBase64 !== "string") {
      throw new Error("roomImageBase64 required");
    }
    const mode: VisualizeMode = input.mode === "add" ? "add" : "replace";
    const aspectRatio =
      input.aspectRatio && ASPECT_RATIOS.has(input.aspectRatio) ? input.aspectRatio : "auto";
    return {
      productId: input.productId,
      roomImageBase64: input.roomImageBase64,
      mode,
      aspectRatio,
    };
  })
  .handler(async ({ data }): Promise<{ taskId?: string; imageUrl?: string }> => {
    try {
      const catalog = catalogFull as unknown as Record<string, VisualizeProduct>;
      const product = catalog[data.productId];
      if (!product) throw new Error("PRODUCT_NOT_FOUND");

      const slim = (catalogSlim as unknown as Array<{ id: string; col?: string }>).find(
        (p) => p.id === data.productId,
      );
      const prompt = buildSalonPrompt({ ...product, col: slim?.col || null }, data.mode);

      // Cache key: sha256(productId + mode + roomImageBase64)
      const encoded = new TextEncoder().encode(
        data.productId + data.mode + data.roomImageBase64,
      );
      const digest = await crypto.subtle.digest("SHA-256", encoded);
      const hash = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      const { data: cached } = await supabaseAdmin
        .from("visualizations")
        .select("image_url")
        .eq("hash", hash)
        .maybeSingle();

      if (cached?.image_url) return { imageUrl: cached.image_url };

      const { uploadToKie, createVisualizeTask } = await import("@/lib/kie.server");
      const roomUrl = await uploadToKie(data.roomImageBase64);
      const taskId = await createVisualizeTask(
        roomUrl,
        product.images?.[0] ?? "",
        prompt,
        data.aspectRatio,
      );

      await supabaseAdmin.from("visualizations").upsert({
        hash,
        task_id: taskId,
        product_id: data.productId,
        mode: data.mode,
        image_url: null,
      });

      return { taskId };
    } catch (err) {
      console.error("visualizeStart failed", err);
      if (err instanceof Error && err.message === "PRODUCT_NOT_FOUND") {
        throw new Error("PRODUCT_NOT_FOUND");
      }
      throw new Error("VISUALIZE_FAILED");
    }
  });

export const visualizeStatus = createServerFn({ method: "POST" })
  .inputValidator((input: { taskId: string }) => {
    if (!input?.taskId || typeof input.taskId !== "string") throw new Error("taskId required");
    return { taskId: input.taskId };
  })
  .handler(
    async ({
      data,
    }): Promise<{ done: boolean; progress?: number; imageUrl?: string }> => {
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
        console.error("visualizeStatus cache update failed", err);
      }

      return { done: true, imageUrl: result.imageUrl };
    },
  );
