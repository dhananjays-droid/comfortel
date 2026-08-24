import { createServerFn } from "@tanstack/react-start";

import catalogFull from "@/data/catalog-full.json";
import { buildPlacementPrompt, type VisualizeProduct } from "@/lib/visualize-prompt";

export const visualize = createServerFn({ method: "POST" })
  .inputValidator((input: { productId: string; roomImageBase64: string }) => {
    if (!input?.productId || typeof input.productId !== "string") {
      throw new Error("productId required");
    }
    if (!input?.roomImageBase64 || typeof input.roomImageBase64 !== "string") {
      throw new Error("roomImageBase64 required");
    }
    return { productId: input.productId, roomImageBase64: input.roomImageBase64 };
  })
  .handler(async ({ data }): Promise<{ imageUrl: string }> => {
    try {
      const catalog = catalogFull as unknown as Record<string, VisualizeProduct>;
      const product = catalog[data.productId];
      if (!product) throw new Error("PRODUCT_NOT_FOUND");

      const prompt = buildPlacementPrompt(product);

      // Cache key: sha256(productId + roomImageBase64)
      const encoded = new TextEncoder().encode(data.productId + data.roomImageBase64);
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

      const { callKieImageEdit } = await import("@/lib/kie.server");
      const imageUrl = await callKieImageEdit(
        data.roomImageBase64,
        product.images?.[0] ?? "",
        prompt,
      );

      await supabaseAdmin
        .from("visualizations")
        .upsert({ hash, product_id: data.productId, image_url: imageUrl });

      return { imageUrl };
    } catch (err) {
      console.error("visualize failed", err);
      if (err instanceof Error && err.message === "PRODUCT_NOT_FOUND") {
        throw new Error("PRODUCT_NOT_FOUND");
      }
      throw new Error("VISUALIZE_FAILED");
    }
  });
