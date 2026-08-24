import catalogFull from "@/data/catalog-full.json";
import catalogSlim from "@/data/catalog-slim.json";

export type FullProduct = {
  id: string;
  name: string;
  price: number | null;
  mrp: number | null;
  url: string;
  images: string[];
  description: string | null;
  specs: Record<string, string> | null;
  dims_cm: { w: number | null; d: number | null; h: number | null } | null;
  placement: string | null;
  in_stock: boolean;
};

export type SlimProduct = {
  id: string;
  n: string;
  c: string;
  p: number | null;
  col: string;
  d: string;
  v: number;
};

export const CATALOG_FULL = catalogFull as unknown as Record<string, FullProduct>;
export const CATALOG_SLIM = catalogSlim as unknown as SlimProduct[];

export const SLIM_BY_ID: Record<string, SlimProduct> = Object.fromEntries(
  CATALOG_SLIM.map((p) => [p.id, p]),
);

export function getProduct(id: string): FullProduct | undefined {
  return CATALOG_FULL[id];
}

export function isVisualizable(id: string): boolean {
  return SLIM_BY_ID[id]?.v === 1;
}

/** Indian comma grouping with a rupee prefix, e.g. 1,23,456 */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}
