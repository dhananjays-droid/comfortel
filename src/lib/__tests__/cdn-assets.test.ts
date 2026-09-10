import { describe, expect, it } from "vitest";
import catalogRaw from "@/data/catalog-full.json";
import cdnRaw from "@/data/cdn-assets.json";
import viewsRaw from "@/data/product-views.json";
import { type CdnAsset, cdnAssetCount, cdnFor } from "@/lib/cdn-assets";

const CATALOG = catalogRaw as unknown as Record<string, { images?: string[] }>;
const VIEWS = viewsRaw as unknown as Record<string, Array<{ url: string }>>;
const ASSETS = (cdnRaw as unknown as { assets: CdnAsset[] }).assets;

/** Every photograph the renderer can reach for, catalogue plus classified views. */
function renderableSources(): string[] {
  const urls = new Set<string>();
  for (const product of Object.values(CATALOG)) for (const u of product.images ?? []) urls.add(u);
  for (const list of Object.values(VIEWS)) for (const v of list) urls.add(v.url);
  return [...urls];
}

describe("cdnFor", () => {
  it("returns null for a URL we have not mirrored", () => {
    expect(cdnFor("https://example.com/not-mirrored.jpg")).toBeNull();
  });

  it("maps a known source to a quickads CDN URL", () => {
    const first = ASSETS[0]!;
    expect(cdnFor(first.source)).toBe(first.cdn);
    expect(first.cdn).toMatch(/^https:\/\/web-assets\.quickads\.ai\//);
  });

  it("is not empty — an empty file would silently restore the 16s mirror path", () => {
    expect(cdnAssetCount()).toBeGreaterThan(800);
  });
});

describe("cdn-assets.json", () => {
  it("keeps the vendor source URL on every entry", () => {
    // The re-scrape story depends on this: without the source there is nothing
    // to hash against, and every future sync re-uploads all 900 files.
    const missing = ASSETS.filter((a) => !a.source?.startsWith("http"));
    expect(missing).toEqual([]);
  });

  it("carries a sha256 for every entry, so an unchanged photo is never re-uploaded", () => {
    const bad = ASSETS.filter((a) => !/^[0-9a-f]{64}$/.test(a.sha256));
    expect(bad).toEqual([]);
  });

  it("has no duplicate sources", () => {
    expect(new Set(ASSETS.map((a) => a.source)).size).toBe(ASSETS.length);
  });

  it("covers every photograph the renderer can actually request", () => {
    const uncovered = renderableSources().filter((u) => cdnFor(u) === null);
    expect(uncovered).toEqual([]);
  });
});
