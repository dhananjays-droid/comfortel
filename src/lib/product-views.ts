import raw from "@/data/product-views.json";

/**
 * Angles a reference photo can show. Written by
 * scripts/classify-product-views.mjs, which asks a vision model which of a
 * product's photos show the SAME physical product, and from what side.
 *
 * Filenames cannot answer that. Of the 102 products whose extra photos went
 * unused, 12 were lifestyle or retail shots, 30 were unclassifiable by name,
 * and some "extra" photos are a different colourway or base variant of the
 * product. Feeding one of those in as another angle is worse than sending
 * nothing — it shows the model a different chair and calls it the same one,
 * which is exactly how the armrest and base faults arise.
 */
export type ViewAngle = "hero" | "front" | "side" | "back" | "detail";

export type ProductView = { url: string; angle: ViewAngle };

/**
 * How each angle is described to the image model.
 *
 * visualize-prompt.ts carries its own copy because it must stay free of data
 * imports for the client bundle. product-views.test.ts asserts the two agree.
 */
export const ANGLE_PHRASE: Record<ViewAngle, string> = {
  hero: "as the catalogue shows it",
  front: "from the front",
  side: "from the side",
  back: "from the back",
  detail: "in close-up detail",
};

const VIEWS = raw as unknown as Record<string, ProductView[]>;

/** Verified views for one product, hero first. Empty when unclassified. */
export function viewsFor(id: string): ProductView[] {
  return VIEWS[id] ?? [];
}
