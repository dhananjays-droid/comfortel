/**
 * CSV in and out of the product library.
 *
 * One row per product, a fixed header, and the same schema the editor saves
 * with — so a file that imports cleanly is exactly a set of products the
 * editor could have produced. Two design choices worth knowing:
 *
 * - An import is a merge, never a replacement. A column the file omits keeps
 *   its current value; a column the file includes always applies, and a blank
 *   there clears the field. Products absent from the file are not touched.
 *   Matching is by `id`, which cannot be renamed.
 * - `specs` is written as one `Name: value` per line inside the cell rather
 *   than JSON, because the people editing this file will do so in Excel or
 *   Sheets, where a JSON blob breaks on the first stray quote. Import also
 *   accepts `Name: value; Other: value` on a single line — a `;` starts a new
 *   spec only when a `Name:` follows it, so a value may itself contain
 *   semicolons ("Listed with: Chair A; Chair B").
 */
import { managedProductSchema, type ManagedProduct } from "@/lib/product-management";

export const CSV_COLUMNS = [
  "id",
  "name",
  "sku",
  "category",
  "price",
  "mrp",
  "currency",
  "in_stock",
  "archived",
  "visualizable",
  "is_component",
  "colour",
  "chat_summary",
  "description",
  "url",
  "source_image_link",
  "updated_image_link",
  "images",
  "dims_w_cm",
  "dims_d_cm",
  "dims_h_cm",
  "placement",
  "salon_placement",
  "product_type",
  "delivery_date",
  "replaces",
  "specs",
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** Products per import request. The browser sends a file in chunks this size
 * so a 200-row import shows progress and a failure in row 140 cannot lose the
 * 139 before it; the server refuses anything larger. */
export const IMPORT_CHUNK = 25;

export type FieldChange = { field: string; from: string; to: string };
export type ImportRow = {
  /** 1-based line in the file where this row starts — what the preview shows. */
  line: number;
  id: string;
  kind: "add" | "update" | "invalid";
  product?: ManagedProduct;
  changes: FieldChange[];
  errors: string[];
};
export type ImportPlan = {
  headerError?: string;
  /** Columns the file has that we don't know — surfaced so a typo like
   * `Price` isn't silently ignored. */
  unknownColumns: string[];
  rows: ImportRow[];
};

/** The shape the editor starts a new product from; also the base for a CSV row
 * whose id is new. Kept here so the two never drift apart. */
export function emptyProduct(id = ""): ManagedProduct {
  return {
    id,
    name: "",
    price: null,
    mrp: null,
    url: "",
    images: [],
    description: "",
    specs: {},
    dims_cm: null,
    placement: null,
    in_stock: true,
    category: "",
    sku: "",
    product_type: null,
    is_component: false,
    delivery_date: null,
    salon_placement: null,
    replaces: null,
    source_image_link: "",
    updated_image_link: "",
    archived: false,
    visualizable: false,
    currency: "USD",
    chat_summary: "",
    colour: "",
  };
}

// ---------------------------------------------------------------- serialize

const num = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

/** Every field as the string it takes in a cell. Also what the diff compares. */
export function productToCells(p: ManagedProduct): Record<CsvColumn, string> {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku ?? "",
    category: p.category ?? "",
    price: num(p.price),
    mrp: num(p.mrp),
    currency: p.currency,
    in_stock: String(p.in_stock),
    archived: String(p.archived),
    visualizable: String(p.visualizable),
    is_component: String(p.is_component),
    colour: p.colour,
    chat_summary: p.chat_summary,
    description: p.description ?? "",
    url: p.url,
    source_image_link: p.source_image_link,
    updated_image_link: p.updated_image_link,
    images: p.images.join("|"),
    dims_w_cm: num(p.dims_cm?.w),
    dims_d_cm: num(p.dims_cm?.d),
    dims_h_cm: num(p.dims_cm?.h),
    placement: p.placement ?? "",
    salon_placement: p.salon_placement ?? "",
    product_type: p.product_type ?? "",
    delivery_date: p.delivery_date ?? "",
    replaces: p.replaces ?? "",
    specs: Object.entries(p.specs ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
  };
}

function quote(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

export function serializeProductsCsv(products: ManagedProduct[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const p of products) {
    const cells = productToCells(p);
    lines.push(CSV_COLUMNS.map((c) => quote(cells[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// -------------------------------------------------------------------- parse

/** RFC 4180: quoted fields may hold commas, quotes (doubled) and newlines.
 * Each row remembers the line it started on so errors can point at it. */
export function parseCsv(text: string): {
  header: string[];
  rows: { line: number; cells: string[] }[];
} {
  const records: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const src = text.startsWith("﻿") ? text.slice(1) : text;

  const endRow = () => {
    if (cells.length || cell) {
      cells.push(cell);
      records.push({ line: rowLine, cells });
    }
    cells = [];
    cell = "";
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === "\n" || (ch === "\r" && src[i + 1] !== "\n")) line++;
        else if (ch === "\r") {
          line++;
          i++;
          cell += "\n";
          continue;
        }
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      endRow();
      line++;
      rowLine = line;
    } else cell += ch;
  }
  endRow();

  const [header = { cells: [] }, ...rows] = records;
  return {
    header: header.cells.map((h) => h.trim()),
    rows: rows.filter((r) => r.cells.some((c) => c !== "")),
  };
}

// ------------------------------------------------------------ interpretation

const NULLABLE_TEXT = new Set<CsvColumn>([
  "sku",
  "category",
  "description",
  "placement",
  "salon_placement",
  "product_type",
  "delivery_date",
  "replaces",
]);
const PLAIN_TEXT = new Set<CsvColumn>([
  "name",
  "colour",
  "chat_summary",
  "url",
  "source_image_link",
  "updated_image_link",
  "currency",
]);
const BOOLEAN = new Set<CsvColumn>(["in_stock", "archived", "visualizable", "is_component"]);
const MONEY = new Set<CsvColumn>(["price", "mrp"]);
const DIMS: Record<string, "w" | "d" | "h"> = { dims_w_cm: "w", dims_d_cm: "d", dims_h_cm: "h" };

function parseBoolean(cell: string): boolean | undefined {
  const v = cell.trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(v)) return true;
  if (["false", "no", "n", "0"].includes(v)) return false;
  return undefined;
}

function parseSpecs(cell: string): Record<string, string> {
  // One spec per line is the exported form. A single-line cell may instead be
  // the hand-typed `Name: value; Other: value` form — but a product with ONE
  // spec also exports as a single line, and if that spec's value contains
  // semicolons ("Listed with: Chair A; Chair B; Chair C") a plain split on `;`
  // shreds it and every fragment after the first fails as "not Name: value".
  // That was 25 of 201 rows in a real export re-imported untouched. So on a
  // single line, split only at a `;` that is followed by another `Name:` key.
  const entries = /\r?\n/.test(cell) ? cell.split(/\r?\n/) : cell.split(/;\s*(?=[^;:\r\n]+:)/);
  const out: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.trim()) continue;
    const at = entry.indexOf(":");
    if (at <= 0) throw new Error(`specs: "${entry.trim()}" is not "Name: value"`);
    out[entry.slice(0, at).trim()] = entry.slice(at + 1).trim();
  }
  return out;
}

/** Apply one row's present columns over a base product. Throws with a
 * field-prefixed message for anything that cannot be interpreted. */
function applyRow(base: ManagedProduct, header: string[], cells: string[]): ManagedProduct {
  const next: Record<string, unknown> = { ...base };
  let dims: { w: number | null; d: number | null; h: number | null } | undefined;

  header.forEach((rawName, i) => {
    const column = rawName as CsvColumn;
    if (!(CSV_COLUMNS as readonly string[]).includes(column)) return;
    const cell = cells[i] ?? "";
    if (column === "id") return;

    if (NULLABLE_TEXT.has(column)) {
      // A present blank clears the field — except that an existing empty
      // string stays an empty string, so an export re-imports byte-for-byte.
      next[column] =
        cell === "" ? ((base as Record<string, unknown>)[column] === "" ? "" : null) : cell;
    } else if (PLAIN_TEXT.has(column)) {
      next[column] = column === "name" ? cell : cell.trim();
    } else if (BOOLEAN.has(column)) {
      if (cell.trim() === "") return; // blank keeps the current flag
      const value = parseBoolean(cell);
      if (value === undefined) throw new Error(`${column}: use true or false, not "${cell}"`);
      next[column] = value;
    } else if (MONEY.has(column)) {
      if (cell.trim() === "") next[column] = null;
      else {
        const value = Number(cell.replace(/[$,\s]/g, ""));
        if (!Number.isFinite(value)) throw new Error(`${column}: "${cell}" is not a number`);
        next[column] = value;
      }
    } else if (column === "images") {
      next["images"] = cell
        .split("|")
        .map((u) => u.trim())
        .filter(Boolean);
    } else if (column in DIMS) {
      dims ??= {
        w: base.dims_cm?.w ?? null,
        d: base.dims_cm?.d ?? null,
        h: base.dims_cm?.h ?? null,
      };
      if (cell.trim() === "") dims[DIMS[column]!] = null;
      else {
        const value = Number(cell);
        if (!Number.isFinite(value)) throw new Error(`${column}: "${cell}" is not a number`);
        dims[DIMS[column]!] = value;
      }
    } else if (column === "specs") {
      if (cell.trim() !== "") next["specs"] = parseSpecs(cell);
    }
  });

  if (dims) next["dims_cm"] = dims.w === null && dims.d === null && dims.h === null ? null : dims;
  return next as ManagedProduct;
}

function diff(before: ManagedProduct, after: ManagedProduct): FieldChange[] {
  const a = productToCells(before);
  const b = productToCells(after);
  return CSV_COLUMNS.filter((c) => a[c] !== b[c]).map((c) => ({ field: c, from: a[c], to: b[c] }));
}

/**
 * Turn a file into a plan: what would be added, what would change on each
 * updated product, and which rows can't be applied and why. Nothing here
 * writes anything — the plan is what the customer approves before an import.
 */
export function productsFromCsv(text: string, existing: Map<string, ManagedProduct>): ImportPlan {
  const { header, rows } = parseCsv(text);
  if (!header.includes("id"))
    return {
      headerError: "The file needs an id column — it's how rows are matched to products.",
      unknownColumns: [],
      rows: [],
    };
  const unknownColumns = header.filter((h) => !(CSV_COLUMNS as readonly string[]).includes(h));
  const idAt = header.indexOf("id");
  const seen = new Map<string, number>();
  const plan: ImportRow[] = [];

  for (const { line, cells } of rows) {
    const id = (cells[idAt] ?? "").trim();
    if (!id) {
      plan.push({ line, id: "", kind: "invalid", changes: [], errors: ["id is required"] });
      continue;
    }
    const firstAt = seen.get(id);
    if (firstAt !== undefined) {
      plan.push({
        line,
        id,
        kind: "invalid",
        changes: [],
        errors: [`duplicate id — already used on line ${firstAt}`],
      });
      continue;
    }
    seen.set(id, line);

    const current = existing.get(id);
    try {
      const merged = applyRow(current ?? emptyProduct(id), header, cells);
      const parsed = managedProductSchema.safeParse(merged);
      if (!parsed.success) {
        plan.push({
          line,
          id,
          kind: "invalid",
          changes: [],
          errors: parsed.error.issues.map((i) => `${i.path.join(".") || "row"}: ${i.message}`),
        });
        continue;
      }
      plan.push({
        line,
        id,
        kind: current ? "update" : "add",
        product: parsed.data,
        changes: current ? diff(current, parsed.data) : [],
        errors: [],
      });
    } catch (err) {
      plan.push({
        line,
        id,
        kind: "invalid",
        changes: [],
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }
  return { unknownColumns, rows: plan };
}

/** Two complete rows in the exact format the importer reads. */
export function sampleCsv(): string {
  const chair: ManagedProduct = {
    ...emptyProduct("SAMPLE-CHAIR-01"),
    name: "Aria Styling Chair",
    sku: "4135S",
    category: "salon/styling-chairs",
    price: 489,
    mrp: 699,
    colour: "stone",
    chat_summary: "Compact styling chair with a wire frame and hydraulic pump.",
    description: "Stone upholstery on a black frame with a chrome footrest.",
    url: "https://example.com/shop/aria-styling-chair",
    source_image_link: "https://example.com/images/aria-hero.jpg",
    updated_image_link: "https://example.com/images/aria-hero.jpg",
    images: [
      "https://example.com/images/aria-front.jpg",
      "https://example.com/images/aria-side.jpg",
    ],
    dims_cm: { w: 60, d: 70, h: 110 },
    in_stock: true,
    visualizable: true,
    specs: { "Seat height": "45–60 cm", Base: "5-star, black", Footrest: "Chrome" },
  };
  const mirror: ManagedProduct = {
    ...emptyProduct("SAMPLE-MIRROR-01"),
    name: "Arch LED Salon Mirror",
    category: "salon/mirrors",
    price: 179,
    colour: "black",
    chat_summary: "Wall-mounted LED mirror with dimmable warm and cool light.",
    url: "https://example.com/shop/arch-led-mirror",
    source_image_link: "https://example.com/images/arch-mirror.jpg",
    updated_image_link: "https://example.com/images/arch-mirror.jpg",
    dims_cm: { w: 75, d: null, h: 110 },
    specs: { Mounting: "Wall", Lighting: "Dimmable LED" },
  };
  return serializeProductsCsv([chair, mirror]);
}
