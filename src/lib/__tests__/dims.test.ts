import { describe, expect, it } from "vitest";

import { dimFromSpecs, dimsFromSpecs, isComplete, parseCm, resolveDims } from "@/lib/dims";

describe("parseCm", () => {
  it("reads a plain cm value", () => {
    expect(parseCm('64cm / 25.2"')).toBe(64);
  });

  it("takes the minimum of a range", () => {
    expect(parseCm('58cm -82cm / 22.8"-32.2"')).toBe(58);
  });

  it("takes the minimum when only the max carries the unit", () => {
    // Real Crow Barbers Chair spec. Read naively this returns 152, the max.
    expect(parseCm('48-60.6" / 120-152cm')).toBe(120);
    expect(parseCm('23.25-29.5" / 55-74cm')).toBe(55);
  });

  it("reads cm even though specs are written inches-first", () => {
    expect(parseCm('32.5" / 82.5cm')).toBe(82.5);
    // 278" is a typo in their data; the cm figure is the trustworthy one.
    expect(parseCm('278" / 71cm')).toBe(71);
  });

  it("ignores optional variants in parentheses", () => {
    // 83cm is "with Arm Rest" — the base product is 64cm.
    expect(parseCm('64cm / 25.2" (83cm / 32.6" with Arm Rest)')).toBe(64);
  });

  it("converts an inches-only value", () => {
    expect(parseCm('27.5"')).toBe(69.9);
    expect(parseCm("12 in")).toBe(30.5);
  });

  it("returns null for a value with no measurement", () => {
    expect(parseCm("White Powder Coated Steel")).toBeNull();
    expect(parseCm("")).toBeNull();
    expect(parseCm(undefined)).toBeNull();
  });
});

describe("dimFromSpecs", () => {
  it("prefers an overall width over a seat width", () => {
    // The regression this guards: substring matching treated "Seat Width" as
    // the product width and halved the footprint.
    expect(dimFromSpecs({ "Seat Width": "48cm", "Total Width": "66cm" }, "w")).toBe(66);
  });

  it("falls back to seat width only when nothing better exists", () => {
    expect(dimFromSpecs({ "Seat Width": "48cm" }, "w")).toBe(48);
  });

  it("never reads shipping carton figures", () => {
    expect(
      dimFromSpecs({ "Carton Dimensions (shipping)": "70.5 × 26.8 × 31.1 in" }, "w"),
    ).toBeNull();
    expect(dimFromSpecs({ "Shipping Weight": "165.4 lbs" }, "h")).toBeNull();
  });

  it("matches labels case-insensitively but not by substring", () => {
    expect(dimFromSpecs({ "chair width": "55cm" }, "w")).toBe(55);
    expect(dimFromSpecs({ "Widthwise Clearance": "55cm" }, "w")).toBeNull();
  });

  it("treats Length as depth", () => {
    expect(dimFromSpecs({ Length: '190cm / 74.8"' }, "d")).toBe(190);
  });

  it("reads a height range as its minimum", () => {
    expect(dimFromSpecs({ "Height range": '58cm -82cm / 22.8"-32.2"' }, "h")).toBe(58);
  });
});

describe("dimsFromSpecs", () => {
  it("recovers a full set from real Aquarius specs", () => {
    expect(
      dimsFromSpecs({
        Width: '64cm / 25.2" (83cm / 32.6" with Arm Rest)',
        Length: '190cm / 74.8"',
        "Height range": '58cm -82cm / 22.8"-32.2"',
        "Carton Dimensions (shipping)": "70.5 × 26.8 × 31.1 in",
      }),
    ).toEqual({ w: 64, d: 190, h: 58 });
  });

  it("leaves unknown axes null rather than guessing", () => {
    expect(dimsFromSpecs({ Width: "60cm" })).toEqual({ w: 60, d: null, h: null });
  });

  it("handles a missing spec sheet", () => {
    expect(dimsFromSpecs(null)).toEqual({ w: null, d: null, h: null });
  });
});

describe("isComplete", () => {
  it("requires all three axes", () => {
    expect(isComplete({ w: 60, d: 60, h: 90 })).toBe(true);
    expect(isComplete({ w: 60, d: null, h: 90 })).toBe(false);
    expect(isComplete(null)).toBe(false);
  });
});

describe("resolveDims", () => {
  it("keeps catalogue dimensions when they are complete", () => {
    const dims = { w: 60, d: 60, h: 90 };
    expect(resolveDims({ dims_cm: dims, specs: { Width: "999cm" } })).toEqual(dims);
  });

  it("recovers from the spec sheet when the catalogue has none", () => {
    expect(
      resolveDims({
        dims_cm: null,
        specs: { "Total Width": '27.8" / 71cm', Length: '47.2" / 120cm', Height: '21.6" / 55cm' },
      }),
    ).toEqual({ w: 71, d: 120, h: 55 });
  });

  it("fills only the missing axes, never overriding a known one", () => {
    expect(
      resolveDims({
        dims_cm: { w: 55, d: null, h: null },
        specs: { Width: "70cm", Depth: "60cm" },
      }),
    ).toEqual({ w: 55, d: 60, h: null });
  });
});
