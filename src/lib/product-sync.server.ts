import { productDb } from "@/lib/managed-catalog.server";
import { metaProduct, type ProductRow } from "@/lib/product-management";
import { authenticated } from "@/lib/wa-admin.server";
import { timingSafeEqual } from "node:crypto";
type Job = {
  product_id: string;
  lease_id: string;
  desired_revision: number;
  meta_id: string | null;
};
async function graph(path: string, body?: Record<string, unknown>) {
  const token = process.env["META_CATALOG_ACCESS_TOKEN"];
  if (!token) throw new Error("Meta catalog access is not configured");
  const response = await fetch(`https://graph.facebook.com/v25.0/${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  const detail = typeof data.error?.message === "string"
    ? data.error.message.replaceAll(token, "[redacted]").replace(/EAA[A-Za-z0-9_-]{20,}/g, "[redacted]").slice(0, 500)
    : "Check catalog permissions and product requirements.";
  if (!response.ok || data.error)
    throw new Error(
      `Meta rejected product sync (code ${data.error?.code ?? response.status}): ${detail}`,
    );
  return data as { id?: string; success?: boolean; data?: Array<{permission: string; status: string}> };
}
export async function runProductSync() {
  const { data: settings, error } = await productDb
    .from("catalog_settings")
    .select("*")
    .eq("id", true)
    .single();
  if (
    error ||
    !settings?.sync_enabled ||
    !settings.catalog_id ||
    !process.env["META_CATALOG_ACCESS_TOKEN"]
  )
    return {
      configured: false,
      processed: 0,
      message: "Catalog connection is not enabled yet. Product changes remain safely queued.",
    };
  // Verify asset access before claiming any rows. A token/configuration failure
  // is a connection problem, not 201 independent merchandising failures.
  try {
    const catalog = await graph(`${settings.catalog_id}?fields=id,name`);
    if (catalog.id !== settings.catalog_id) throw new Error("Meta catalog access was not confirmed");
  } catch (error) {
    let permissions = "";
    try {
      const result = await graph("me/permissions");
      const granted = (result.data ?? []).filter(p => p.status === "granted").map(p => p.permission);
      permissions = granted.includes("catalog_management")
        ? " The token has catalog_management; check its system user's access to this catalog."
        : " The token does not report catalog_management permission.";
    } catch { /* The original asset-access error remains actionable. */ }
    return { configured: false, processed: 0, message: `${error instanceof Error ? error.message : "Catalog connection unavailable"}${permissions}` };
  }
  const { data: jobs, error: claimError } = await productDb.rpc("claim_product_sync", {
    p_limit: 10,
  });
  if (claimError) throw new Error("Could not claim catalog changes");
  let synced = 0,
    failed = 0;
  await Promise.all(
    (jobs as Job[]).map(async (job) => {
      let revision = job.desired_revision,
        metaId = job.meta_id;
      let failure: string | null = null;
      try {
        const { data, error } = await productDb
          .from("managed_products")
          .select("*")
          .eq("id", job.product_id)
          .single();
        if (error || !data) throw new Error("Product unavailable");
        const row = data as ProductRow;
        revision = row.revision;
        // Stable retailer ID + allow_upsert makes timeout retries idempotent.
        if (row.product.archived) {
          // Never create an archived item, or require its old merchandising fields to hide it.
          if (metaId) await graph(metaId, { availability: "out of stock", visibility: "staging" });
        } else {
          const result = await graph(`${settings.catalog_id}/products`, {
            ...metaProduct(row.product),
            visibility: "published",
            allow_upsert: true,
          });
          if (!result.id) throw new Error("Meta did not return a product ID; sync not confirmed");
          metaId = result.id;
        }
        synced++;
      } catch (error) {
        failure = error instanceof Error ? error.message : "Sync failed";
        failed++;
      }
      const { error: finishError } = await productDb.rpc("finish_product_sync", {
        p_id: job.product_id,
        p_lease: job.lease_id,
        p_revision: revision,
        p_meta_id: metaId,
        p_error: failure,
      });
      if (finishError)
        throw new Error("Sync acknowledgement unavailable; lease recovery will retry safely");
    }),
  );
  return { configured: true, processed: jobs.length, synced, failed };
}
export async function handleProductSync(request: Request) {
  const secret = process.env["PRODUCT_SYNC_SECRET"];
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  const scheduler = !!secret && actual.length === expected.length && timingSafeEqual(actual, expected);
  if (!scheduler && !authenticated(request)) return new Response("Unauthorized", { status: 401 });
  if (!["POST", "GET"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
  return Response.json(await runProductSync());
}
