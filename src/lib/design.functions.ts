import { createServerFn } from "@tanstack/react-start";

export type SharedRender = { imageUrl: string; label: string };

export type SharedDesign = {
  productIds: string[];
  renders: SharedRender[];
  subtotalCents: number | null;
  createdAt: string;
};

/** Codes are for links, so they avoid characters that get mangled or misread. */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 12;

/**
 * A random share code.
 *
 * 32^12 is far beyond guessing, which matters because the table has no policy
 * and the code is the only thing standing between a link and someone else's
 * salon photos. Generated from crypto, never from a counter or a timestamp —
 * a sequential id would let one link expose the next.
 */
function makeCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

const MAX_RENDERS = 12;
const MAX_LABEL = 80;

export const shareDesign = createServerFn({ method: "POST" })
  .validator((input: { productIds: string[]; renders: SharedRender[]; subtotalCents?: number }) => {
    const productIds = Array.isArray(input?.productIds)
      ? input.productIds.filter((id) => typeof id === "string" && id.length > 0).slice(0, 20)
      : [];
    if (!productIds.length) throw new Error("productIds required");

    // Only accept render URLs we actually produced. Anything else and a shared
    // page becomes a way to host an arbitrary image on our domain's link.
    const renders = (Array.isArray(input?.renders) ? input.renders : [])
      .filter(
        (r): r is SharedRender =>
          typeof r?.imageUrl === "string" &&
          /^https:\/\/[a-z0-9.-]*(aiquickdraw\.com|redpandaai\.co)\//i.test(r.imageUrl),
      )
      .slice(0, MAX_RENDERS)
      .map((r) => ({
        imageUrl: r.imageUrl,
        label: typeof r.label === "string" ? r.label.slice(0, MAX_LABEL) : "Render",
      }));

    return {
      productIds,
      renders,
      subtotalCents:
        typeof input.subtotalCents === "number" && Number.isFinite(input.subtotalCents)
          ? Math.max(0, Math.round(input.subtotalCents))
          : null,
    };
  })
  .handler(async ({ data }): Promise<{ code: string }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const code = makeCode();
    const { error } = await supabaseAdmin.from("shared_designs").insert({
      share_code: code,
      product_ids: data.productIds,
      renders: data.renders,
      subtotal_cents: data.subtotalCents,
    });

    if (error) {
      console.error("shareDesign failed", error);
      throw new Error("SHARE_FAILED");
    }
    return { code };
  });

export const loadDesign = createServerFn({ method: "POST" })
  .validator((input: { code: string }) => {
    // Shape-check before it reaches the database: the code comes straight from a
    // URL segment.
    if (typeof input?.code !== "string" || !/^[a-z2-9]{6,32}$/.test(input.code)) {
      throw new Error("DESIGN_NOT_FOUND");
    }
    return { code: input.code };
  })
  .handler(async ({ data }): Promise<SharedDesign> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row, error } = await supabaseAdmin
      .from("shared_designs")
      .select("product_ids, renders, subtotal_cents, created_at")
      .eq("share_code", data.code)
      .maybeSingle();

    if (error) {
      console.error("loadDesign failed", error);
      throw new Error("DESIGN_UNAVAILABLE");
    }
    if (!row) throw new Error("DESIGN_NOT_FOUND");

    return {
      productIds: (row.product_ids ?? []) as string[],
      renders: (row.renders ?? []) as SharedRender[],
      subtotalCents: row.subtotal_cents ?? null,
      createdAt: row.created_at as string,
    };
  });
