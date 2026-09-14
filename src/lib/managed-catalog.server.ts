import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { setCatalogResolver } from "@/lib/catalog";
import { productSnapshot, type CatalogSnapshot, type ProductRow } from "@/lib/product-management";

// These tables are isolated here until the generated database types are refreshed.
export const productDb = supabaseAdmin as unknown as SupabaseClient;
const context = new AsyncLocalStorage<CatalogSnapshot>();
setCatalogResolver(() => context.getStore());
export async function readProducts(): Promise<ProductRow[]> {
  const rows: ProductRow[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await productDb
      .from("managed_products")
      .select("*")
      .order("id")
      .range(offset, offset + 499);
    if (error) throw new Error("Product database unavailable");
    rows.push(...(data as ProductRow[]));
    if (data.length < 500) break;
  }
  return rows;
}
export async function withManagedCatalog<T>(work: () => Promise<T>): Promise<T> {
  if (context.getStore()) return work();
  // Explicit switch allows migration, seeding and readback before activation.
  if (process.env["MANAGED_CATALOG_ENABLED"] !== "true") return work();
  const rows = await readProducts();
  if (!rows.length) throw new Error("Product catalog has not been initialized");
  return context.run(productSnapshot(rows), work);
}
