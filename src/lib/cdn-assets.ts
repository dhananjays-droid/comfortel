/**
 * Product photographs served from our own CDN instead of the vendor's site.
 *
 * GPT Image 2 refuses to fetch comfortelfurniture.com URLs, so kie.server.ts
 * used to download every reference and re-upload it to kie's storage before it
 * could start a render — measured at ~16.7s of dead time per render, paid
 * again on almost every request because that cache is an in-process Map and
 * Vercel wipes it on cold start.
 *
 * The same bytes on web-assets.quickads.ai are fetched without complaint
 * (verified: a createTask against a CDN URL reached `generating` in 0.4s), so
 * the mirror step disappears for anything listed here.
 *
 * The data is written by scripts/sync-cdn-assets.mjs. Source URLs stay in the
 * catalogue and are recorded here beside a sha256 of the bytes, so a re-scrape
 * can hash what it finds, compare, and re-upload only what actually changed.
 *
 * Server-only by convention: this JSON is ~900 entries and has no business in
 * the client bundle. kie.server.ts is its sole importer, and that module is
 * itself only ever reached through a dynamic import on the server.
 */
import raw from "@/data/cdn-assets.json";

export type CdnAsset = {
  /** The vendor URL this was copied from. Never dropped — see the note above. */
  source: string;
  cdn: string;
  sha256: string;
  bytes: number;
  content_type: string;
  uploaded_at: string;
};

const BY_SOURCE = new Map<string, string>(
  (raw.assets as CdnAsset[]).map((asset) => [asset.source, asset.cdn]),
);

/**
 * The CDN copy of a vendor image URL, or null when we don't have one.
 *
 * Null is a normal answer, not an error: a product scraped since the last sync
 * simply falls back to the upload path. Callers must keep that fallback.
 */
export function cdnFor(sourceUrl: string): string | null {
  return BY_SOURCE.get(sourceUrl) ?? null;
}

/** How many photographs are mirrored. Used by the tests to catch an empty file. */
export function cdnAssetCount(): number {
  return BY_SOURCE.size;
}
