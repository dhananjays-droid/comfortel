/**
 * Splitting a plan into salon zones.
 *
 * One render holding ten products gives each of them too few pixels to stay
 * recognisable — the reason RECOMMENDED_REFERENCES exists. Zones are the answer:
 * a chair, its mirror and its trolley belong in one frame together, but a
 * backwash unit and a reception desk do not, and forcing them into the same
 * image costs fidelity for no benefit.
 *
 * Rendering per zone also parallelises for free, because each render already
 * polls its own task.
 */

export type Zone = "reception" | "styling" | "wash" | "drying";

/** Customer-journey order: what they walk past, in the order they walk past it. */
export const ZONE_ORDER: Zone[] = ["reception", "styling", "wash", "drying"];

export const ZONE_LABEL: Record<Zone, string> = {
  reception: "Reception",
  styling: "Styling floor",
  wash: "Wash bay",
  drying: "Drying area",
};

/** What the render is told the zone is, so the prompt names the right place. */
export const ZONE_SCENE: Record<Zone, string> = {
  reception: "the reception area by the entrance",
  styling: "the styling floor at the mirror stations",
  wash: "the wash bay",
  drying: "the drying and waiting area",
};

/**
 * Placement type to zone.
 *
 * Mirrors and trolleys deliberately land in `styling`: they are what surrounds a
 * styling chair, and separating them would put a mirror in an image with no
 * chair under it.
 *
 * `floor` is the catalogue's generic bucket — 83 of 202 products carry it — so it
 * defaults to styling rather than getting a zone of its own. That is a guess, and
 * the reason a placement backfill is still worth doing.
 */
const PLACEMENT_ZONE: Record<string, Zone> = {
  styling_chair: "styling",
  mirror_unit: "styling",
  trolley: "styling",
  shampoo_unit: "wash",
  reception: "reception",
  dryer: "drying",
  floor: "styling",
};

export type ZonedProduct = {
  id: string;
  placement?: string | null;
  salon_placement?: string | null;
};

export function zoneOf(product: ZonedProduct): Zone {
  const key = product.salon_placement || product.placement || "floor";
  return PLACEMENT_ZONE[key] ?? "styling";
}

export type ZoneGroup<T> = { zone: Zone; label: string; scene: string; products: T[] };

/**
 * Group a plan by zone, in journey order, dropping empty zones.
 *
 * Returns one group when everything belongs together, which is the signal to
 * render a single image rather than offering a split.
 */
export function groupByZone<T extends ZonedProduct>(products: T[]): Array<ZoneGroup<T>> {
  const buckets = new Map<Zone, T[]>();
  for (const product of products) {
    const zone = zoneOf(product);
    const bucket = buckets.get(zone);
    if (bucket) bucket.push(product);
    else buckets.set(zone, [product]);
  }

  return ZONE_ORDER.filter((zone) => buckets.get(zone)?.length).map((zone) => ({
    zone,
    label: ZONE_LABEL[zone],
    scene: ZONE_SCENE[zone],
    products: buckets.get(zone) as T[],
  }));
}

/** True when splitting would actually produce more than one image. */
export function isSplittable(products: ZonedProduct[]): boolean {
  return groupByZone(products).length > 1;
}
