import { describe, expect, it } from "vitest";
import { salonPlans } from "@/lib/wa-advisor-tools";
import { productFit } from "@/lib/wa-product-fit";
import { CATALOG_FULL } from "@/lib/catalog";
import { buildRenderRequest } from "@/lib/visualize-prompt";

describe("fit-aware equipment planning", () => {
  it("recognises double-sided pole mirrors even without Double in their name", () => {
    const p = Object.values(CATALOG_FULL).find((p) => /with Pole Frame/i.test(p.name))!;
    expect(productFit(p).mirrorLayout).toBe("island");
  });
  it("enhances useful capacity without adding stations or spending beyond the budget", () => {
    const plan = salonPlans({ stations: 3, budget: 25000, currency: "USD", scope: "equipment" });
    const chosen = plan.options.find((p) => p.tier === "balanced")!;
    expect(chosen.total).toBeLessThanOrEqual(25000);
    expect(chosen.lines.find((l) => l.role === "styling")?.qty).toBe(3);
    expect(chosen.lines.find((l) => l.role === "mirror")?.qty).toBe(3);
    expect(chosen.lines.find((l) => l.role === "trolley")?.qty).toBe(3);
    expect(chosen.lines.find((l) => l.role === "wash")?.qty).toBe(2);
    expect(chosen.total).toBeGreaterThan(plan.essentialsTotal);
    expect(chosen.total).toBe(chosen.lines.reduce((s, l) => s + l.price! * l.qty, 0));
    expect(plan.budgetNote).toContain("not added extra stations");
    for (const l of chosen.lines.filter((l) => l.role === "mirror"))
      expect(productFit(CATALOG_FULL[l.id]!).mirrorLayout).toBe("wall-assumed");
  });
  it("does not use the enhanced quantities when they exceed the budget", () => {
    const p = salonPlans({ stations: 3, budget: 4000, currency: "USD", scope: "equipment" });
    expect(p.enhancement).toBeNull();
    expect(p.budgetNote).toContain("above your budget");
    expect(p.budgetNote).not.toContain("allowance");
    expect(p.recommendedTier).toBe("lean");
    expect(p.reducedScope?.total).toBeLessThanOrEqual(4000);
    expect(p.reducedScope?.lines.find((l) => l.name.includes("Mirror"))?.qty).toBe(3);
  });
  it("compares identical quantities in every tier and offers unselected expansion options", () => {
    const p = salonPlans({ stations: 3, budget: 25000, currency: "USD", scope: "equipment" });
    const quantities = p.options.map((o) => o.lines.map((l) => [l.role, l.qty]));
    expect(quantities[0]).toEqual(quantities[1]);
    expect(quantities[1]).toEqual(quantities[2]);
    expect(p.options[2]!.total).toBeGreaterThanOrEqual(p.options[1]!.total);
    expect(p.expansionOptions.length).toBeGreaterThan(0);
    for (const extra of p.expansionOptions) {
      expect(extra.requiresConfirmation).toBe(true);
      expect(p.options.every((o) => !o.lines.some((l) => l.id === extra.id))).toBe(true);
    }
  });
  it("uses explicit LED and reclining needs rather than a universal mirror shortlist", () => {
    const p = salonPlans({
      stations: 3,
      budget: 25000,
      currency: "USD",
      scope: "equipment",
      mirror_feature: "led",
      chair_feature: "reclining",
    });
    for (const o of p.options) {
      expect(o.lines.find((l) => l.role === "mirror")?.name).toMatch(/LED/i);
      expect(o.lines.find((l) => l.role === "styling")?.name).toMatch(/reclin/i);
    }
  });
  it("counts known double-sided island mirrors by faces", () => {
    const p = salonPlans({
      stations: 3,
      budget: 25000,
      currency: "USD",
      scope: "equipment",
      mirror_layout: "island",
    });
    for (const o of p.options) {
      const mirror = o.lines.find((l) => l.role === "mirror")!;
      expect(mirror.qty).toBe(2);
      expect(productFit(CATALOG_FULL[mirror.id]!).stationFaces).toBe(2);
      expect(o.lines.find((l) => l.role === "styling")?.qty).toBe(3);
    }
  });
  it("passes exact product references and counts to a wide staged composition", () => {
    const p = Object.values(CATALOG_FULL).find(
      (p) => p.salon_placement === "styling_chair" && p.images.length,
    )!;
    const request = buildRenderRequest([{ ...p, qty: 3 }], "staged_room");
    expect(request.imageUrls).toContain(p.images[0]);
    expect(request.prompt).toContain(p.name);
    expect(request.prompt).toContain("wide corner-to-corner");
    expect(request.prompt).toContain("3 ×");
    expect(request.prompt).toContain("reflections are not extra stations");
  });
});
