import { CATALOG_FULL, type FullProduct } from "@/lib/catalog";

export type DocumentLine = { product: FullProduct; qty: number; unitCents: number | null };
export type CommerceDocument = {
  kind: "quote" | "comparison";
  reference: string;
  issuedAt: string;
  lines: DocumentLine[];
};
export const usd = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export function documentLines(
  ids: string[],
  quantities: Record<string, number> = {},
): DocumentLine[] {
  if (!ids.length || ids.length > 10) throw new Error("Choose between 1 and 10 products.");
  return [...new Set(ids)].map((id) => {
    const product = CATALOG_FULL[id];
    if (!product)
      throw new Error("That product is no longer in the catalog. Please choose it again.");
    const qty = quantities[id] ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > 99)
      throw new Error("Quantities must be whole numbers from 1 to 99.");
    return {
      product,
      qty,
      unitCents:
        product.price !== null && Number.isFinite(product.price) && product.price >= 0
          ? Math.round(product.price * 100)
          : null,
    };
  });
}

export function documentTotals(lines: DocumentLine[]) {
  return {
    pricedSubtotal: lines.reduce((sum, l) => sum + (l.unitCents ?? 0) * l.qty, 0),
    unknownPrices: lines.filter((l) => l.unitCents === null).length,
    pieces: lines.reduce((sum, l) => sum + l.qty, 0),
  };
}

/** Only exact catalog spec labels; carton dimensions and shipping weight are
 * deliberately NOT substituted for installed dimensions or load capacity. */
export const comparisonFields = [
  ["Finish", ["Colour", "Color"]],
  ["Overall width", ["Total Width", "Width"]],
  ["Seat width", ["Seat Width"]],
  ["Depth", ["Total Depth", "Depth"]],
  ["Height / range", ["Height range", "Height Range", "Height", "Total Height"]],
  ["Base", ["Base"]],
  [
    "Load capacity",
    ["Weight Capacity", "Weight capacity", "Maximum Weight Capacity", "Max Weight"],
  ],
] as const;

export function productSpec(product: FullProduct, keys: readonly string[]): string {
  const specs = product.specs ?? {};
  for (const key of keys) {
    const value = specs[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Not listed - ask our team";
}

export function comparisonSummary(lines: DocumentLine[]): string {
  const priced = lines
    .filter((l) => l.unitCents !== null)
    .sort((a, b) => a.unitCents! - b.unitCents!);
  const sameCategory = new Set(lines.map((l) => l.product.category)).size === 1;
  const cost =
    priced.length === lines.length
      ? priced[0]!.unitCents === priced.at(-1)!.unitCents
        ? `These options have the same listed unit price (${usd(priced[0]!.unitCents!)}).`
        : `Listed unit prices range from ${usd(priced[0]!.unitCents!)} to ${usd(priced.at(-1)!.unitCents!)} - a difference of ${usd(priced.at(-1)!.unitCents! - priced[0]!.unitCents!)} per item.`
      : "Some prices need confirmation, so a complete price ranking is not available.";
  return `${cost} ${sameCategory ? "Use the measurements and finish comparison to narrow your choice; confirm fit before ordering." : "These products serve different functions, so price alone is not a like-for-like comparison."}`;
}

/** No fuzzy guess: every meaningful word of a model name must be supplied.
 * Variants whose full name is contained in a longer matched variant lose. */
export function resolveDocumentSelection(text: string): {
  ids: string[];
  quantities: Record<string, number>;
} {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const ignored = new Set(["styling", "salon", "chair", "chairs", "barber", "with", "the", "and"]);
  const empty = { ids: [], quantities: {} };
  const ids: string[] = [],
    quantities: Record<string, number> = {};
  const parts = text
    .replace(
      /\b(?:please|can|could|you|send|give|make|create|download|print|me|a|my|the|pdf|quote|estimate|quotation|itemised|itemized|comparison|compare|for|between)\b/gi,
      " ",
    )
    .split(/\s+(?:and|versus|vs\.?)\s+|[,;+&\n]/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const numberWords: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  for (let part of parts) {
    const quantity = part.match(
      /^(-?\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:x\s*|of\s+|\s+)/i,
    );
    const qty = quantity
      ? /^-?\d/.test(quantity[1]!)
        ? Number(quantity[1])
        : numberWords[quantity[1]!.toLowerCase()]
      : undefined;
    if (quantity) part = part.slice(quantity[0].length);
    if (qty !== undefined && (!Number.isInteger(qty) || qty < 1 || qty > 99)) return empty;
    const words = new Set(normalize(part).split(" "));
    const explicit = [...words].filter((w) => /^\d{6,}$/.test(w));
    let matches = explicit.length
      ? explicit.map((id) => CATALOG_FULL[id]).filter((p): p is FullProduct => Boolean(p))
      : Object.values(CATALOG_FULL).filter((p) => {
          if (p.sku && normalize(part) === normalize(p.sku)) return true;
          const tokens = normalize(p.name)
            .split(" ")
            .filter((w) => !ignored.has(w));
          return tokens.length >= 2 && tokens.every((w) => words.has(w));
        });
    if (explicit.some((id) => !CATALOG_FULL[id])) return empty;
    // Prefer Textured Black over Black within one named selection, but keep
    // both when the user explicitly separated the two variants with "and".
    matches = matches.filter(
      (p) =>
        !matches.some((other) => {
          const own = normalize(p.name)
            .split(" ")
            .filter((w) => !ignored.has(w));
          const theirs = normalize(other.name)
            .split(" ")
            .filter((w) => !ignored.has(w));
          return (
            other.id !== p.id && theirs.length > own.length && own.every((w) => theirs.includes(w))
          );
        }),
    );
    if (matches.length !== 1 || ids.includes(matches[0]!.id)) return empty;
    const allowed = new Set([
      ...normalize(matches[0]!.name).split(" "),
      ...normalize(matches[0]!.sku ?? "").split(" "),
      ...ignored,
      matches[0]!.id,
      "products",
      "product",
    ]);
    if ([...words].some((w) => !allowed.has(w))) return empty;
    const id = matches[0]!.id;
    ids.push(id);
    if (qty !== undefined) quantities[id] = qty;
  }
  return { ids, quantities };
}

export const resolveDocumentProducts = (text: string) => resolveDocumentSelection(text).ids;

export function quoteRequestContext(button: string): string | null {
  if (!button.startsWith("request:sales:quote:")) return null;
  const [, , , idList, quantityList, reference] = button.split(":");
  if (!/^CQ-[A-F0-9]{10}$/.test(reference ?? "")) return null;
  const ids = idList?.split(",") ?? [],
    quantities = quantityList?.split(",") ?? [];
  if (ids.length !== quantities.length) return null;
  try {
    const lines = documentLines(
      ids,
      Object.fromEntries(ids.map((id, i) => [id, Number(quantities[i])])),
    );
    return `Please confirm a final quote for estimate ${reference}:\n${lines.map((l) => `${l.qty} x ${l.product.name} (SKU ${l.product.sku ?? l.product.id})`).join("\n")}`;
  } catch {
    return null;
  }
}
