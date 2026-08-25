/**
 * Recovering product dimensions from the spec sheet.
 *
 * 130 of 202 products had no usable W×D×H, which blocked every capacity and
 * fit calculation. It turned out not to be missing data: 82 of them already
 * carried dimensions in `specs` under labels the original parser did not know —
 * "Total Width", "Seat Width", "Basin Height", "Bench Depth", "Mirror Width".
 * The other 48 genuinely have none, and checking their product pages confirmed
 * the site does not publish any, so scraping would add nothing.
 *
 * Hence a parser rather than a scraper.
 */

export type Dims = { w: number | null; d: number | null; h: number | null };

const INCH_TO_CM = 2.54;

/**
 * The first real measurement in a spec value, in centimetres.
 *
 * Spec strings are messy and inconsistent, e.g.
 *   `64cm / 25.2" (83cm / 32.6" with Arm Rest)`  -> 64
 *   `58cm -82cm / 22.8"-32.2"`                   -> 58  (a range yields its min)
 *   `48-60.6" / 120-152cm`                       -> 120 (unit only on the max)
 *   `27.5"`                                      -> 69.85 (converted)
 *
 * A range takes the minimum deliberately: for a height range it is the lowest
 * working position, and for anything else the smaller footprint is the safer
 * number to plan a room around. A reclining chair's extended length is a
 * clearance question, not a footprint one.
 *
 * Note the spec sheets are written INCHES / CM, not the other way round, so the
 * cm figure is usually the second number on the line.
 */
export function parseCm(raw: string | undefined | null): number | null {
  if (!raw) return null;

  // Ignore anything in parentheses — it is an optional variant ("with Arm
  // Rest"), not the base measurement.
  const base = raw.replace(/\([^)]*\)/g, " ");

  // Ranges first. They appear in two shapes and only one puts the unit on the
  // leading number, so a single-value match reads `58cm -82cm` as 58 but
  // `120-152cm` as 152 — the maximum, which is the opposite of intended.
  const cmRange = base.match(/(\d+(?:\.\d+)?)\s*(?:cm)?\s*[-–—]\s*(\d+(?:\.\d+)?)\s*cm/i);
  if (cmRange?.[1]) return round(Number(cmRange[1]));

  const cm = base.match(/(\d+(?:\.\d+)?)\s*cm/i);
  if (cm?.[1]) return round(Number(cm[1]));

  const inch = base.match(/(\d+(?:\.\d+)?)\s*(?:in\b|inch|")/i);
  if (inch?.[1]) return round(Number(inch[1]) * INCH_TO_CM);

  return null;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Spec labels that carry each dimension, best first.
 *
 * Overall measurements outrank component ones: "Total Width" is the footprint a
 * room has to fit, while "Seat Width" is a detail of the same product and would
 * badly under-report it. Seat and internal measurements are last-resort only.
 */
const LABELS: Record<keyof Dims, string[]> = {
  w: [
    "Total Width",
    "Full Width",
    "Overall Width",
    "Width",
    "Chair width",
    "Bench Width",
    "Mirror Width",
    "Base Plate Option Width",
    "Seat Width",
    "Internal Seat Width",
  ],
  d: [
    "Total Depth",
    "Overall Depth",
    "Depth",
    "Length",
    "Bench Depth",
    "Frame Depth",
    "Seat Depth",
    "Recline Length Range",
  ],
  h: [
    "Total Height",
    "Overall Height",
    "Height",
    "Height range",
    "Bench Height",
    "Mirror Height",
    "Basin Height",
    "Seat Height Range",
    "Seat Height",
  ],
};

/** Shipping-carton figures describe the box, not the product. */
const EXCLUDED = /carton|shipping|weight|cubic/i;

/**
 * A single dimension from a spec sheet, or null.
 *
 * Matching is case-insensitive and label-exact rather than substring, because
 * substring matching is what conflated "Seat Width" with "Width" and produced
 * chairs half their real size.
 */
export function dimFromSpecs(
  specs: Record<string, string> | null | undefined,
  axis: keyof Dims,
): number | null {
  if (!specs) return null;

  const entries = Object.entries(specs).filter(([label]) => !EXCLUDED.test(label));

  for (const wanted of LABELS[axis]) {
    const hit = entries.find(([label]) => label.toLowerCase() === wanted.toLowerCase());
    const value = parseCm(hit?.[1]);
    if (value !== null) return value;
  }
  return null;
}

/** W×D×H from a spec sheet. Any axis the sheet does not describe stays null. */
export function dimsFromSpecs(specs: Record<string, string> | null | undefined): Dims {
  return {
    w: dimFromSpecs(specs, "w"),
    d: dimFromSpecs(specs, "d"),
    h: dimFromSpecs(specs, "h"),
  };
}

/** True when every axis is known — the bar for planning a layout. */
export function isComplete(dims: Dims | null | undefined): boolean {
  return Boolean(dims?.w && dims?.d && dims?.h);
}

/**
 * The best dimensions available for a product: what the catalogue already
 * recorded, else what its spec sheet yields.
 *
 * Resolved at call time rather than baked into a generated file — the parser is
 * pure and cheap, and `specs` is already in the catalogue, so a derived data
 * file would only be one more thing to keep in step.
 */
export function resolveDims(product: {
  dims_cm?: Dims | null;
  specs?: Record<string, string> | null;
}): Dims {
  if (isComplete(product.dims_cm)) return product.dims_cm as Dims;

  const parsed = dimsFromSpecs(product.specs);
  const existing = product.dims_cm;
  // Prefer any axis the catalogue already had; fill the gaps from the sheet.
  return {
    w: existing?.w ?? parsed.w,
    d: existing?.d ?? parsed.d,
    h: existing?.h ?? parsed.h,
  };
}
