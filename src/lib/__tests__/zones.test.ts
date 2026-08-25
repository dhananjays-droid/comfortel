import { describe, expect, it } from "vitest";

import { groupByZone, isSplittable, zoneOf, ZONE_ORDER } from "@/lib/zones";

const p = (id: string, placement?: string) => ({ id, salon_placement: placement ?? null });

describe("zoneOf", () => {
  it("keeps a chair, its mirror and its trolley in one zone", () => {
    expect(zoneOf(p("1", "styling_chair"))).toBe("styling");
    expect(zoneOf(p("2", "mirror_unit"))).toBe("styling");
    expect(zoneOf(p("3", "trolley"))).toBe("styling");
  });

  it("separates the wash bay, reception and drying", () => {
    expect(zoneOf(p("4", "shampoo_unit"))).toBe("wash");
    expect(zoneOf(p("5", "reception"))).toBe("reception");
    expect(zoneOf(p("6", "dryer"))).toBe("drying");
  });

  it("defaults the catalogue's generic floor bucket to styling", () => {
    expect(zoneOf(p("7", "floor"))).toBe("styling");
    expect(zoneOf(p("8"))).toBe("styling");
    expect(zoneOf(p("9", "something-new"))).toBe("styling");
  });
});

describe("groupByZone", () => {
  it("returns one group when everything belongs together", () => {
    const groups = groupByZone([p("1", "styling_chair"), p("2", "mirror_unit")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.zone).toBe("styling");
    expect(groups[0]?.products).toHaveLength(2);
  });

  it("orders groups by the customer journey, not insertion order", () => {
    const groups = groupByZone([
      p("1", "dryer"),
      p("2", "shampoo_unit"),
      p("3", "reception"),
      p("4", "styling_chair"),
    ]);
    expect(groups.map((g) => g.zone)).toEqual(["reception", "styling", "wash", "drying"]);
  });

  it("drops zones with nothing in them", () => {
    const groups = groupByZone([p("1", "styling_chair"), p("2", "shampoo_unit")]);
    expect(groups.map((g) => g.zone)).toEqual(["styling", "wash"]);
    expect(groups).toHaveLength(2);
  });

  it("handles an empty plan", () => {
    expect(groupByZone([])).toEqual([]);
  });

  it("names each zone for the prompt", () => {
    const [group] = groupByZone([p("1", "shampoo_unit")]);
    expect(group?.label).toBe("Wash bay");
    expect(group?.scene).toContain("wash bay");
  });

  it("covers every zone in ZONE_ORDER", () => {
    const all = ZONE_ORDER.map((zone, i) =>
      p(
        String(i),
        { reception: "reception", styling: "styling_chair", wash: "shampoo_unit", drying: "dryer" }[
          zone
        ],
      ),
    );
    expect(groupByZone(all).map((g) => g.zone)).toEqual(ZONE_ORDER);
  });
});

describe("isSplittable", () => {
  it("is false when a split would produce one image", () => {
    expect(isSplittable([p("1", "styling_chair"), p("2", "trolley")])).toBe(false);
    expect(isSplittable([])).toBe(false);
  });

  it("is true only when there is more than one zone", () => {
    expect(isSplittable([p("1", "styling_chair"), p("2", "shampoo_unit")])).toBe(true);
  });
});
