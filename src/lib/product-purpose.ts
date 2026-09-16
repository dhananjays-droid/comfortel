import type { FullProduct } from "@/lib/catalog";

/** Store categories include compatible parts. Determine the item itself, not
 * words in its description (which often describe the equipment it attaches to). */
export function productPurpose(p: FullProduct): string {
  const n = p.name;
  if (p.is_component || /\b(accessor(?:y|ies)|joiner|shelf only|box \d|holder|hose|comfortneck|fixture|breaker kit|hair trap|shower head|wheel option|hydraulic|footrest)\b/i.test(n) ||
      /^salon pole frame\b|\bdouble bench\b|^hair repellent wheel/i.test(n)) return "accessory";
  if (/\b(shampoo system|wash lounge|backwash unit)\b/i.test(n)) return "wash";
  if (/\bbasin\b/i.test(n)) return "basin";
  if (/\bmirror\b|\bwith pole frame\b/i.test(n) && p.salon_placement === "mirror_unit") return "mirror";
  if (/\bstool\b/i.test(n)) return "stool";
  if (/\b(sofa|ottoman|waiting chair|waiting seat)\b/i.test(n)) return "waiting";
  if (/\bchair\b/i.test(n) && p.salon_placement === "styling_chair") return "chair";
  if (/\btrolley\b/i.test(n)) return "trolley";
  if (/\breception desk\b/i.test(n)) return "reception";
  if (/\b(retail shelves|magazine rack)\b/i.test(n)) return "retail";
  if (/\btreatment table\b/i.test(n)) return "treatment";
  return "other";
}

export function requestedPurposes(query: string): string[] {
  // Explicit spare-part requests remain searchable; never hide accessories
  // globally or prevent an exact-ID lookup for support/comparison.
  if (/\b(accessor(?:y|ies)|parts?|replacement|joiner|shelf|shelves|bench|holders?|hoses?|footrests?|hydraulic|bases?|wheels?|frames? only)\b/i.test(query)) return [];
  const types: string[] = [];
  if (/\bmirrors?\b/i.test(query)) types.push("mirror");
  if (/\b(chairs?|seats?)\b/i.test(query)) types.push(/\bwaiting\b/i.test(query) ? "waiting" : "chair");
  if (/\b(stools?)\b/i.test(query)) types.push("stool");
  if (/\b(trolleys?|trollies)\b/i.test(query)) types.push("trolley");
  if (/\b(wash|backwash|shampoo)\b/i.test(query)) types.push("wash");
  else if (/\bbasins?\b/i.test(query)) types.push("basin");
  if (/\b(reception|desks?)\b/i.test(query)) types.push("reception");
  if (/\b(sofas?|ottomans?)\b/i.test(query)) types.push("waiting");
  if (/\btreatment\b/i.test(query)) types.push("treatment");
  return types;
}

export function matchesProductPurpose(p: FullProduct, query: string): boolean {
  const purposes = requestedPurposes(query);
  return !purposes.length || purposes.includes(productPurpose(p));
}
