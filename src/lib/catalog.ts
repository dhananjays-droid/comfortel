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
  category: string | null;
  sku: string | null;
  delivery_date: string | null;
  salon_placement: string | null;
  replaces: string | null;
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

const RAW_FULL = catalogFull as unknown as Record<string, FullProduct>;
const RAW_SLIM = catalogSlim as unknown as SlimProduct[];

/**
 * Placeholder rows that exist on the source site but are not sellable products.
 * Kept as an explicit id list rather than a name heuristic so a real product
 * never disappears because it happens to contain the word "test".
 */
const NOT_A_PRODUCT = new Set(["347812"]);

export const CATALOG_SLIM: SlimProduct[] = RAW_SLIM.filter((p) => !NOT_A_PRODUCT.has(p.id));

export const CATALOG_FULL: Record<string, FullProduct> = Object.fromEntries(
  Object.entries(RAW_FULL).filter(([id]) => !NOT_A_PRODUCT.has(id)),
);

export const SLIM_BY_ID: Record<string, SlimProduct> = Object.fromEntries(
  CATALOG_SLIM.map((p) => [p.id, p]),
);

/** Human labels for the functional category slugs used in `c` / `category`. */
const CATEGORY_LABEL: Record<string, string> = {
  "salon/styling-chairs": "Styling chair",
  "salon/stools": "Stool",
  "salon/all-purpose-chairs": "All-purpose chair",
  "salon/trolleys": "Trolley",
  "salon/reception-desks": "Reception desk",
  "salon/waiting-retail": "Waiting & retail",
  "salon/shampoo-area": "Shampoo area",
  "salon/mirrors": "Mirror",
  "salon/mats": "Anti-fatigue mat",
  "salon/footrests-dryer-holders": "Footrest & holders",
  "salon/electrical": "Equipment",
  "barbers/barber-chairs": "Barber chair",
  "spa/treatment-tables": "Treatment table",
  "spa/trolleys": "Spa trolley",
  components: "Component",
};

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return "Salon furniture";
  return CATEGORY_LABEL[category] ?? "Salon furniture";
}

export function getProduct(id: string): FullProduct | undefined {
  return CATALOG_FULL[id];
}

export function isVisualizable(id: string): boolean {
  return SLIM_BY_ID[id]?.v === 1;
}

/**
 * Comfortel's storefront prices this catalog in US dollars — every source
 * record carries currency "USD", ships in inches and pounds, and its SKUs are
 * suffixed "-US". Formatting must match the site a customer will check.
 */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** e.g. "62 W x 48 H cm" — omits axes the source never printed. */
export function dimsLabel(product: FullProduct): string {
  const d = product.dims_cm;
  if (!d) return "";
  const parts: string[] = [];
  if (d.w) parts.push(`${d.w} W`);
  if (d.d) parts.push(`${d.d} D`);
  if (d.h) parts.push(`${d.h} H`);
  return parts.length ? `${parts.join(" x ")} cm` : "";
}

export function discountPercent(product: FullProduct): number | null {
  if (product.mrp === null || product.price === null) return null;
  if (product.mrp <= product.price) return null;
  return Math.round(((product.mrp - product.price) / product.mrp) * 100);
}

/** Spec rows worth showing a buyer, in the order they should appear. */
const SPEC_ORDER = [
  "Total Width",
  "Width",
  "Depth",
  "Height",
  "Height Range",
  "Seat Width",
  "Seat Height Range",
  "Length",
  "Colour",
  "Color",
  "Material",
  "Materials",
  "Base/Frame",
  "Frame",
  "Upholstery",
  "Finish",
  "Base",
  "Weight Capacity",
  "Warranty",
];

/** Shipping-carton rows are noise on a product sheet — the buyer wants the product. */
const SPEC_HIDDEN = /^(Carton Dimensions|Shipping )/i;

export function displaySpecs(product: FullProduct): Array<[string, string]> {
  const specs = product.specs ?? {};
  const entries = Object.entries(specs).filter(([k, v]) => v && !SPEC_HIDDEN.test(k));
  entries.sort((a, b) => {
    const ai = SPEC_ORDER.indexOf(a[0]);
    const bi = SPEC_ORDER.indexOf(b[0]);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  return entries.slice(0, 8) as Array<[string, string]>;
}

/**
 * Source descriptions are scraped from the storefront and 25 of them end on a
 * colon introducing a list of customisation options the scrape never captured
 * ("...Customize the look of your chair:"). Drop that dangling clause rather
 * than printing a sentence that goes nowhere.
 */
export function productDescription(product: FullProduct): string | null {
  const raw = product.description?.trim();
  if (!raw) return null;
  if (!raw.endsWith(":")) return raw;
  const cut = raw.lastIndexOf(".");
  return cut > 40 ? raw.slice(0, cut + 1) : raw;
}
