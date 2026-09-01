import { describe, expect, it } from "vitest";

import catalogFull from "@/data/catalog-full.json";
import { type Dims, resolveDims } from "@/lib/dims";
import { stationsAlongWall } from "@/lib/layout";

/**
 * The planner against the real catalogue. Unit tests cover the arithmetic; this
 * guards the join — a dims-parsing regression would feed nonsense widths in here
 * long before anyone noticed a bad render.
 */
type CatalogProduct = {
  name: string;
  replaces?: string | null;
  dims_cm?: Dims | null;
  specs?: Record<string, string> | null;
};

const catalog = catalogFull as unknown as Record<string, CatalogProduct>;

const chairIds = Object.keys(catalog).filter((id) =>
  /styling chair|barber chair/i.test(catalog[id]?.replaces ?? ""),
);

describe("planner against the real catalogue", () => {
  it("finds chairs to plan with", () => {
    expect(chairIds.length).toBeGreaterThan(20);
  });

  it("gives every measured chair a physically plausible width", () => {
    const measured = chairIds
      .map((id) => ({ id, name: catalog[id]!.name, w: resolveDims(catalog[id]!).w }))
      .filter((c): c is { id: string; name: string; w: number } => c.w !== null);

    expect(measured.length).toBeGreaterThan(15);

    for (const chair of measured) {
      // A salon chair is not narrower than a dining chair nor wider than a sofa.
      // This is the range that catches a seat-width/total-width mix-up or an
      // inches value that never got converted.
      expect(chair.w, `${chair.name} width ${chair.w}cm`).toBeGreaterThan(40);
      expect(chair.w, `${chair.name} width ${chair.w}cm`).toBeLessThan(120);
    }
  });

  it("fits a sensible number of real chairs on a 6m wall", () => {
    for (const id of chairIds) {
      const w = resolveDims(catalog[id]!).w;
      if (w === null) continue;
      const fit = stationsAlongWall(600, w);
      // Anything outside 3..8 on six metres means the width is wrong.
      expect(fit.count, `${catalog[id]!.name} (${w}cm) -> ${fit.count}`).toBeGreaterThanOrEqual(3);
      expect(fit.count, `${catalog[id]!.name} (${w}cm) -> ${fit.count}`).toBeLessThanOrEqual(8);
    }
  });
});
