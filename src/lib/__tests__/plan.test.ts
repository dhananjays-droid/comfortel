import { describe, expect, it } from "vitest";

import {
  QUANTITY_MODES,
  describePlan,
  expectedFrom,
  linesFrom,
  planPieces,
  planTotal,
  quantitiesFor,
} from "@/lib/plan";

const CHAIR = { id: "c1", name: "Panther Barbers Chair", price: 1090 };
const MIRROR = { id: "m1", name: "Villa II Mirror", price: 305 };
const DESK = { id: "d1", name: "Walker Reception Desk", price: 2190 };

describe("linesFrom", () => {
  it("treats a product with no quantity as one", () => {
    expect(linesFrom([CHAIR], {})).toEqual([
      { id: "c1", name: "Panther Barbers Chair", qty: 1, price: 1090 },
    ]);
  });

  it("carries the quantities a package set", () => {
    const lines = linesFrom([CHAIR, DESK], { c1: 4 });
    expect(lines.map((l) => l.qty)).toEqual([4, 1]);
  });

  it("never lets a quantity fall below one", () => {
    // A zero would silently drop a piece the customer is still being charged for.
    expect(linesFrom([CHAIR], { c1: 0 })[0]?.qty).toBe(1);
    expect(linesFrom([CHAIR], { c1: -3 })[0]?.qty).toBe(1);
  });

  it("survives a missing quantity map", () => {
    expect(linesFrom([CHAIR], undefined)[0]?.qty).toBe(1);
  });
});

describe("planTotal and planPieces", () => {
  it("multiplies by quantity, which is the whole point", () => {
    // The bug this replaces: a tray showing $5,962 under a message promising
    // $14,788, because it priced one of each.
    const lines = linesFrom([CHAIR, MIRROR, DESK], { c1: 4, m1: 4 });
    expect(planTotal(lines)).toBe(4 * 1090 + 4 * 305 + 2190);
    expect(planPieces(lines)).toBe(9);
  });

  it("counts a priceless product as free rather than as NaN", () => {
    const lines = linesFrom([{ id: "x", name: "Unpriced", price: null }], { x: 2 });
    expect(planTotal(lines)).toBe(0);
    expect(planPieces(lines)).toBe(2);
  });

  it("is zero on an empty plan", () => {
    expect(planTotal([])).toBe(0);
    expect(planPieces([])).toBe(0);
  });
});

describe("describePlan", () => {
  it("says plainly when there is nothing in it", () => {
    const text = describePlan([]);
    expect(text).toMatch(/EMPTY/);
    expect(text).toMatch(/nothing to render/);
  });

  it("states every line with its quantity and id", () => {
    const text = describePlan(linesFrom([CHAIR, DESK], { c1: 4 }));
    expect(text).toContain("4 × Panther Barbers Chair");
    expect(text).toContain("id c1");
    expect(text).toContain("1 × Walker Reception Desk");
  });

  it("gives the model the same total the tray shows", () => {
    const text = describePlan(linesFrom([CHAIR, MIRROR], { c1: 4, m1: 4 }));
    expect(text).toContain("$5,580");
    expect(text).toContain("8 pieces");
  });

  it("prices a repeated line 'each', so the total is not read as the unit price", () => {
    expect(describePlan(linesFrom([CHAIR], { c1: 4 }))).toContain("$1,090 each");
    expect(describePlan(linesFrom([CHAIR], {}))).not.toContain("each");
  });

  it("tells the model the plan beats the transcript", () => {
    // The failure this exists for: a package proposed twenty turns ago is still
    // in the history in full, and the model kept quoting it after the customer
    // had removed two pieces.
    const text = describePlan(linesFrom([CHAIR], {}));
    expect(text).toMatch(/OVERRIDES anything earlier/);
    expect(text).toMatch(/do not bring it back/);
  });

  it("maps the words a customer actually uses onto the plan", () => {
    const text = describePlan(linesFrom([CHAIR], {}));
    expect(text).toContain('"these"');
    expect(text).toContain('"my plan"');
  });
});

describe("quantitiesFor", () => {
  const qty = { c1: 4, m1: 4, d1: 1 };

  it("applies to a refit, which is the mode that installs a stated number", () => {
    expect(quantitiesFor("refit_room", ["c1", "m1", "d1"], qty)).toEqual({ c1: 4, m1: 4 });
  });

  it("drops singles, because they are the default", () => {
    expect(quantitiesFor("refit_room", ["d1"], qty)).toBeUndefined();
  });

  it("stays out of the modes where a count would contradict the instruction", () => {
    // replace_all takes its count from the room; a lineup gives every position a
    // different product. A quantity in either would be reported as a shortfall.
    expect(quantitiesFor("replace_all", ["c1"], qty)).toBeUndefined();
    expect(quantitiesFor("lineup", ["c1", "m1"], qty)).toBeUndefined();
    expect(quantitiesFor("add", ["c1"], qty)).toBeUndefined();
  });

  it("only covers the ids in this render", () => {
    // A zone render holds part of the plan; the rest belongs to other images.
    expect(quantitiesFor("refit_room", ["c1"], qty)).toEqual({ c1: 4 });
  });

  it("is nothing when the plan has no quantities at all", () => {
    expect(quantitiesFor("refit_room", ["c1"], undefined)).toBeUndefined();
    expect(quantitiesFor("refit_room", ["c1"], {})).toBeUndefined();
  });
});

describe("expectedFrom", () => {
  it("counts only what repeats", () => {
    // A lone reception desk behind the camera would otherwise produce a
    // shortfall note on almost every render.
    const lines = linesFrom([CHAIR, MIRROR, DESK], { c1: 4, m1: 2 });
    expect(expectedFrom(lines)).toEqual([
      { name: "Panther Barbers Chair", qty: 4 },
      { name: "Villa II Mirror", qty: 2 },
    ]);
  });

  it("is empty when nothing repeats", () => {
    expect(expectedFrom(linesFrom([CHAIR, DESK], {}))).toEqual([]);
  });
});

describe("quantitiesFor — every furnishing mode", () => {
  const qty = { a: 6, b: 2, c: 1 };

  it("carries counts for each mode that furnishes a room", () => {
    // The fault this prevents: a mode was compared by string literal, so
    // adding staged_room silently dropped every quantity and a 24-piece plan
    // rendered as one of each.
    for (const mode of QUANTITY_MODES) {
      expect(quantitiesFor(mode, ["a", "b", "c"], qty)).toEqual({ a: 6, b: 2 });
    }
  });

  it("leaves lineup alone, where a count would be meaningless", () => {
    expect(quantitiesFor("lineup", ["a", "b"], qty)).toBeUndefined();
  });

  it("ignores single-piece modes", () => {
    expect(quantitiesFor("replace", ["a"], qty)).toBeUndefined();
    expect(quantitiesFor("add", ["a"], qty)).toBeUndefined();
  });
});
