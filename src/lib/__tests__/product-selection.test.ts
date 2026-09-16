import { describe, it, expect } from "vitest";
import { CATALOG_FULL } from "@/lib/catalog";
import { selectionProfile, selectionEvidenceFor } from "@/lib/product-selection";
import { salonPlans, productFacts, recommendProducts } from "@/lib/wa-advisor-tools";
const plan = (extra: Record<string, unknown> = {}) =>
  salonPlans({ stations: 3, budget: 25000, currency: "USD", scope: "equipment", ...extra });
const chosen = (extra: Record<string, unknown> = {}) => {
  const p = plan(extra);
  return p.options.find((o) => o.tier === p.recommendedTier)!;
};
describe("source-backed selection profiles", () => {
  it("distinguishes a wall-supported single from its linked double mirror", () => {
    const single = Object.values(CATALOG_FULL).find((p) => /Verona Grande.*Single/.test(p.name))!;
    const double = Object.values(CATALOG_FULL).find((p) => /Verona Grande.*Double/.test(p.name))!;
    expect(selectionProfile(single).stationFaces).toBe(1);
    expect(selectionProfile(single).mounting).toBe("wall_or_rear_support");
    expect(selectionProfile(double).stationFaces).toBe(2);
    expect(selectionProfile(double).mirrorLayout).toBe("island");
  });
  it("distinguishes beauty-service chairs from ordinary hair-styling chairs", () => {
    expect(selectionProfile(CATALOG_FULL["7938"]!).primaryUse).toBe("beauty_services");
    expect(selectionProfile(CATALOG_FULL["330334"]!).primaryUse).toBe("hair_styling");
    expect(selectionProfile(CATALOG_FULL["300862"]!).primaryUse).toBe("barber");
    expect(chosen().lines.find((l) => l.role === "styling")?.id).not.toBe("7938");
    expect(
      selectionProfile(CATALOG_FULL[chosen().lines.find((l) => l.role === "styling")!.id]!)
        .primaryUse,
    ).toBe("hair_styling");
  });
  it("uses a beauty chair and no automatic wash units for dedicated makeup service", () => {
    const p = chosen({ service_focus: "makeup_brows" });
    expect(p.lines.some((l) => l.role === "wash")).toBe(false);
    expect(
      selectionProfile(CATALOG_FULL[p.lines.find((l) => l.role === "styling")!.id]!).primaryUse,
    ).toBe("beauty_services");
  });
  it("prefers published daylight lighting for colour work", () => {
    const p = chosen({ service_focus: "colour" });
    const mirror = p.lines.find((l) => l.role === "mirror")!;
    expect(selectionProfile(CATALOG_FULL[mirror.id]!).features.daylightLighting).toBe(true);
  });
  it("uses documented compact features rather than guessing dimensions", () => {
    const p = chosen({ chair_priority: "compact" });
    expect(
      selectionProfile(CATALOG_FULL[p.lines.find((l) => l.role === "styling")!.id]!).features
        .compact,
    ).toBe(true);
    expect(selectionProfile(CATALOG_FULL["330334"]!).checks.join(" ")).toContain(
      "operating/recline clearance",
    );
  });
  it("keeps source facts separate from unknowns and rejects stale model overlays", () => {
    const p = CATALOG_FULL["330334"]!;
    expect(selectionEvidenceFor(p)?.sourceUrl).toBe(p.url);
    expect(
      selectionEvidenceFor({ ...p, description: "Admin changed this configuration" }),
    ).toBeNull();
    expect(selectionEvidenceFor({ ...p, url: "https://example.com/another-model" })).toBeNull();
    expect(productFacts(p.id).selection_profile.checkedAt).toBeTruthy();
    expect(
      selectionProfile({
        ...p,
        id: "new",
        name: "Test styling chair",
        description: "Without reclining. Optional massage upgrade.",
        category: "salon/styling-chairs",
      }).features.reclining,
    ).toBeNull();
  });
  it("does not interpret design-led styling as LED lighting", () => {
    expect(selectionProfile(CATALOG_FULL["348679"]!).features.led).toBeNull();
    const results = recommendProducts({ query: "LED mirror" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((p) => p.selection_profile.documentedFeatures.includes("led"))).toBe(true);
  });
  it("exposes intended service evidence in a makeup product search", () => {
    const products = recommendProducts({ query: "makeup chair" });
    expect(products.some((p) => p.selection_profile.primaryUse === "beauty_services")).toBe(true);
  });
});
