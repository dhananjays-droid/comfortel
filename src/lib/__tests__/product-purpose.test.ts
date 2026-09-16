import { describe, expect, it } from "vitest";
import { CATALOG_FULL } from "@/lib/catalog";
import { productPurpose, matchesProductPurpose } from "@/lib/product-purpose";
import { recommendProducts } from "@/lib/wa-advisor-tools";
import { selectionProfile } from "@/lib/product-selection";
import { candidates } from "@/lib/packages";

describe("product purpose rather than broad storefront category", () => {
  it.each([
    ["I want to buy a mirror for my salon", "mirror"],
    ["salon chairs", "chair"], ["salon stools", "stool"],
    ["shampoo wash units", "wash"], ["salon trolleys", "trolley"],
    ["waiting sofas", "waiting"], ["reception desk", "reception"],
  ])("%s only returns complete matching equipment", (query, purpose) => {
    const results = recommendProducts({ query });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result.productPurpose).toBe(purpose);
  });
  it.each(["300024", "301087", "9619", "348676", "344021"])("mirror accessory %s is not a mirror", id => {
    expect(productPurpose(CATALOG_FULL[id]!)).toBe("accessory");
    expect(selectionProfile(CATALOG_FULL[id]!).primaryUse).toBe("component");
    expect(matchesProductPurpose(CATALOG_FULL[id]!, "mirror")).toBe(false);
  });
  it.each(["348673", "348674", "343727", "301097"])("complete mirror assembly %s remains eligible", id => {
    expect(matchesProductPurpose(CATALOG_FULL[id]!, "mirror")).toBe(true);
  });
  it("still permits explicit accessory searches and exact ID support lookups", () => {
    expect(recommendProducts({ query: "mirror joiner shelf" }).some(p => p.id === "301087")).toBe(true);
    expect(recommendProducts({ query: "mirror", ids: ["301087"] }).map(p => p.id)).toEqual(["301087"]);
  });
  it("guards every package role without treating retail shelving as seating", () => {
    for (const role of ["mirror", "wash", "stool", "trolley", "reception", "waiting", "styling"] as const) {
      expect(candidates(role).length).toBeGreaterThan(0);
      for (const p of candidates(role)) expect(productPurpose(p)).toBe(role === "styling" ? "chair" : role);
    }
  });
  it("does not mistake basins, ottomans or holders for complete wash units", () => {
    for (const id of ["345215", "6211", "4124", "320076"])
      expect(matchesProductPurpose(CATALOG_FULL[id]!, "shampoo unit")).toBe(false);
  });
});
