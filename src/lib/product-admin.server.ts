import { authenticated } from "@/lib/wa-admin.server";
import { productDb, readProducts } from "@/lib/managed-catalog.server";
import { managedProductSchema } from "@/lib/product-management";
import raw from "@/data/catalog-full.json";
import slim from "@/data/catalog-slim.json";
import { cdnFor } from "@/lib/cdn-assets";
import { withProductSpecifications } from "@/lib/product-specifications";
import type { FullProduct } from "@/lib/catalog";
import type { ManagedProduct } from "@/lib/product-management";
import { isCdnUrl, mirrorImageToCdn } from "@/lib/asset-cdn.server";
import { IMPORT_CHUNK } from "@/lib/product-csv";

/**
 * Every image a product will be served from goes onto our CDN first; the
 * original stays in `source_image_link` untouched. Same URL twice in one
 * product uploads once. Anything already on the CDN is left alone.
 */
async function withCdnImages(product: ManagedProduct): Promise<ManagedProduct> {
  const primary = product.updated_image_link || product.source_image_link;
  const wanted = [primary, ...product.images].filter((u) => u && !isCdnUrl(u));
  const mirrored = new Map<string, string>();
  await Promise.all(
    [...new Set(wanted)].map(async (u) => mirrored.set(u, await mirrorImageToCdn(u))),
  );
  const cdn = (u: string) => mirrored.get(u) ?? u;
  return {
    ...product,
    updated_image_link: primary ? cdn(primary) : product.updated_image_link,
    images: product.images.map(cdn),
  };
}

type ImportResult = { id: string; status: "added" | "updated" | "failed"; error?: string };
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
export async function handleProductAdmin(request: Request): Promise<Response> {
  if (!authenticated(request)) return json({ error: "Unauthorized" }, 401);
  try {
    if (request.method === "GET") {
      const [products, sync, settings] = await Promise.all([
        readProducts(),
        productDb.from("product_meta_sync").select("*"),
        productDb.from("catalog_settings").select("*").single(),
      ]);
      if (sync.error || settings.error) throw new Error("Product database unavailable");
      return json({ products, sync: sync.data, settings: settings.data });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const rawBody = await request.text();
    if (rawBody.length > 100000) return json({ error: "Request too large" }, 413);
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (!body || typeof body !== "object") return json({ error: "Invalid request" }, 400);
    if (body.action === "seed") {
      // Never overwrite a product already managed by staff.
      const existing = new Set((await readProducts()).map((p) => p.id));
      let added = 0;
      const remaining = Object.values(raw).filter((p) => p.id !== "347812" && !existing.has(p.id));
      for (const value of remaining.slice(0, 20)) {
        if (value.id === "347812" || existing.has(value.id)) continue;
        const p = withProductSpecifications(value as FullProduct);
        const source = p.images[0] ?? "";
        const product = {
          ...p,
          source_image_link: source,
          updated_image_link: cdnFor(source) ?? source,
          currency: "USD",
          archived: false,
          visualizable: slim.find((s) => s.id === p.id)?.v === 1,
          chat_summary: slim.find((s) => s.id === p.id)?.d ?? "",
          colour: slim.find((s) => s.id === p.id)?.col ?? "",
        };
        // Strip scraped auxiliary keys; retain all typed product/spec fields.
        const fields = managedProductSchema.innerType().strip().parse(product);
        const { error } = await productDb.rpc("save_managed_product", {
          p_product: fields,
          p_expected_revision: 0,
        });
        if (error) throw new Error("Import interrupted; retry to import only remaining products");
        added++;
      }
      return json({ added, remaining: Math.max(0, remaining.length - added) });
    }
    if (body.action === "import") {
      if (!Array.isArray(body.products)) return json({ error: "products must be an array" }, 400);
      if (body.products.length > IMPORT_CHUNK)
        return json({ error: `Import at most ${IMPORT_CHUNK} products per request` }, 400);
      // Matching is by id against what exists right now; a product absent from
      // the file is never touched, so there is no delete path here at all.
      const revisions = new Map((await readProducts()).map((r) => [r.id, r.revision]));
      const results: ImportResult[] = [];
      for (const raw of body.products) {
        const id = typeof raw?.id === "string" ? raw.id : "?";
        const parsed = managedProductSchema.safeParse(raw);
        if (!parsed.success) {
          results.push({
            id,
            status: "failed",
            error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
          });
          continue;
        }
        let product: ManagedProduct;
        try {
          product = await withCdnImages(parsed.data);
        } catch (err) {
          results.push({
            id,
            status: "failed",
            error: `Image upload failed: ${err instanceof Error ? err.message : "unknown"}`,
          });
          continue;
        }
        const revision = revisions.get(product.id);
        const { error } = await productDb.rpc("save_managed_product", {
          p_product: product,
          p_expected_revision: revision ?? 0,
        });
        if (error)
          results.push({
            id,
            status: "failed",
            error:
              error.code === "PT409"
                ? "Someone edited this product. Reload it before saving."
                : "Product could not be saved",
          });
        else results.push({ id, status: revision === undefined ? "added" : "updated" });
      }
      return json({ results });
    }
    if (body.action === "sync") {
      const { runProductSync } = await import("@/lib/product-sync.server");
      return json(await runProductSync());
    }
    if (body.action === "save") {
      const parsed = managedProductSchema.safeParse(body.product);
      if (!parsed.success)
        return json(
          { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
          400,
        );
      if (!Number.isSafeInteger(body.revision) || body.revision < 0)
        return json({ error: "Invalid revision" }, 400);
      const { data, error } = await productDb.rpc("save_managed_product", {
        p_product: parsed.data,
        p_expected_revision: body.revision,
      });
      if (error)
        return json(
          {
            error:
              error.code === "PT409"
                ? "Someone edited this product. Reload it before saving."
                : "Product could not be saved",
          },
          error.code === "PT409" ? 409 : 503,
        );
      return json({ product: data, message: "Saved. Catalog sync is pending." });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (error) {
    console.error(
      "Product admin operation failed",
      error instanceof Error ? error.message : "unknown",
    );
    return json({ error: "Product service unavailable. Refresh before retrying." }, 503);
  }
}
