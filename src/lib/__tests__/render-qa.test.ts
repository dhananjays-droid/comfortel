import { describe, expect, it } from "vitest";

import {
  FAULTS,
  FAULT_KINDS,
  MAX_RETRIES,
  correctionFor,
  isFaultKind,
  readVerdict,
  shortfallFrom,
  shortfallNote,
  shouldRetry,
} from "@/lib/render-qa";

describe("readVerdict", () => {
  it("passes a clean check", () => {
    expect(readVerdict({ faults: [], note: "" })).toEqual({ ok: true, faults: [] });
  });

  it("reads real faults", () => {
    const verdict = readVerdict({ faults: ["intersecting"], note: "chair in the timber panel" });
    expect(verdict.ok).toBe(false);
    expect(verdict.faults).toEqual(["intersecting"]);
    expect(verdict.note).toBe("chair in the timber panel");
  });

  // An invented category cannot be described back to the generator, so acting on
  // it would spend a render chasing something we cannot express.
  it("drops fault names it does not recognise", () => {
    const verdict = readVerdict({ faults: ["vibes_are_off", "intersecting"] });
    expect(verdict.faults).toEqual(["intersecting"]);
  });

  it("passes when every named fault was unrecognised", () => {
    expect(readVerdict({ faults: ["vibes_are_off"] }).ok).toBe(true);
  });

  it("lets the fault list win over a contradictory ok flag", () => {
    expect(readVerdict({ ok: true, faults: ["leftover"] }).ok).toBe(false);
    expect(readVerdict({ ok: false, faults: [] }).ok).toBe(true);
  });

  it("treats a missing, null or malformed reply as a pass", () => {
    // Never block delivery on a check that did not happen.
    for (const input of [null, undefined, "nope", 42, {}]) {
      expect(readVerdict(input).ok, String(input)).toBe(true);
    }
  });

  it("ignores a blank note", () => {
    expect(readVerdict({ faults: ["floating"], note: "   " }).note).toBeUndefined();
  });
});

describe("correctionFor", () => {
  it("says nothing when there is nothing to fix", () => {
    expect(correctionFor({ ok: true, faults: [] })).toBe("");
  });

  it("names the fault in the generator's own terms", () => {
    const text = correctionFor({ ok: false, faults: ["intersecting"] });
    expect(text).toContain(FAULTS.intersecting);
  });

  it("carries the inspector's location detail into the retry", () => {
    const text = correctionFor({
      ok: false,
      faults: ["intersecting"],
      note: "second chair from the left",
    });
    expect(text).toContain("second chair from the left");
  });

  it("describes several faults in one correction", () => {
    const text = correctionFor({ ok: false, faults: ["intersecting", "stale_mirror"] });
    expect(text).toContain(FAULTS.intersecting);
    expect(text).toContain(FAULTS.stale_mirror);
  });

  it("tells the model to change only the fault", () => {
    // Without this a retry re-rolls the whole room and loses what was right.
    expect(correctionFor({ ok: false, faults: ["floating"] })).toMatch(/keeping everything else/);
  });

  it("names a shortfall even when there is no fault", () => {
    // Confirmed live: a customer asked for 10 mirrors and got 8 — a passing
    // verdict (nothing was broken), but still worth a correction.
    const text = correctionFor({ ok: true, faults: [] }, [
      { name: "Circa LED Round Salon Mirror", asked: 10, seen: 8 },
    ]);
    expect(text).toContain("only 8 of 10");
    expect(text).toContain("Circa LED Round Salon Mirror");
    expect(text).toMatch(/hard requirement/);
  });

  it("describes both a fault and a shortfall together", () => {
    const text = correctionFor({ ok: false, faults: ["intersecting"] }, [
      { name: "Blake Styling Chair", asked: 4, seen: 3 },
    ]);
    expect(text).toContain(FAULTS.intersecting);
    expect(text).toContain("only 3 of 4");
  });

  it("says nothing extra when the shortfall list is empty", () => {
    expect(correctionFor({ ok: true, faults: [] }, [])).toBe("");
  });
});

describe("shouldRetry", () => {
  it("retries a broken first attempt", () => {
    expect(shouldRetry({ ok: false, faults: ["intersecting"] }, 0)).toBe(true);
  });

  it("never retries a passing render", () => {
    expect(shouldRetry({ ok: true, faults: [] }, 0)).toBe(false);
  });

  // Each retry is a real generation: money, plus another 80-98s of waiting.
  it("stops after the cap, however broken", () => {
    expect(shouldRetry({ ok: false, faults: ["deformed"] }, MAX_RETRIES)).toBe(false);
    expect(shouldRetry({ ok: false, faults: ["deformed"] }, MAX_RETRIES + 5)).toBe(false);
  });

  it("retries a passing render that still came up short", () => {
    // Used to be excluded on purpose ("not a reason to re-render") — right
    // for a refit against a real room with a real limit, wrong for
    // staged_room, which invents its own room and has no such excuse.
    expect(
      shouldRetry({ ok: true, faults: [] }, 0, [{ name: "Chloe Tan", asked: 10, seen: 8 }]),
    ).toBe(true);
  });

  it("does not retry a passing render with nothing short", () => {
    expect(shouldRetry({ ok: true, faults: [] }, 0, [])).toBe(false);
    expect(shouldRetry({ ok: true, faults: [] }, 0)).toBe(false);
  });

  it("still stops a shortfall retry at the cap", () => {
    expect(
      shouldRetry({ ok: true, faults: [] }, MAX_RETRIES, [
        { name: "Chloe Tan", asked: 10, seen: 8 },
      ]),
    ).toBe(false);
  });
});

describe("the fault taxonomy", () => {
  it("describes every kind it exposes", () => {
    for (const kind of FAULT_KINDS) {
      expect(FAULTS[kind], kind).toBeTruthy();
      expect(isFaultKind(kind)).toBe(true);
    }
  });

  it("covers the faults actually seen in output", () => {
    // A chair half-buried in a wall panel, and a mirror showing a removed chair.
    expect(FAULT_KINDS).toContain("intersecting");
    expect(FAULT_KINDS).toContain("stale_mirror");
  });

  it("rejects anything outside the taxonomy", () => {
    expect(isFaultKind("looks_cheap")).toBe(false);
    expect(isFaultKind("")).toBe(false);
  });
});

describe("counting what the render actually delivered", () => {
  const asked = [
    { name: "Panther Barbers Chair", qty: 4 },
    { name: "Villa II Mirror", qty: 4 },
  ];

  it("reads counts and the placement hint off the reply", () => {
    const verdict = readVerdict({
      faults: [],
      counts: [{ item: "Panther Barbers Chair", seen: 2 }],
      elsewhere: "along the empty wall opposite the entrance",
    });
    expect(verdict.counts).toEqual([{ item: "Panther Barbers Chair", seen: 2 }]);
    expect(verdict.elsewhere).toBe("along the empty wall opposite the entrance");
  });

  it("does not treat a short count as a fault", () => {
    // A room that holds two stations holds two however many times we re-render.
    const verdict = readVerdict({
      faults: [],
      counts: [{ item: "Panther Barbers Chair", seen: 1 }],
    });
    expect(verdict.ok).toBe(true);
    expect(shouldRetry(verdict, 0)).toBe(false);
  });

  it("finds the shortfall", () => {
    const verdict = readVerdict({
      faults: [],
      counts: [
        { item: "Panther Barbers Chair", seen: 2 },
        { item: "Villa II Mirror", seen: 4 },
      ],
    });
    expect(shortfallFrom(asked, verdict)).toEqual([
      { name: "Panther Barbers Chair", asked: 4, seen: 2 },
    ]);
  });

  it("matches names regardless of case", () => {
    const verdict = readVerdict({
      faults: [],
      counts: [{ item: "panther barbers CHAIR", seen: 1 }],
    });
    expect(shortfallFrom(asked, verdict)).toHaveLength(1);
  });

  it("ignores a line the inspector never reported", () => {
    // Far likelier that it skipped a line than that a whole product vanished,
    // and inventing a shortfall puts a wrong sentence under a correct picture.
    const verdict = readVerdict({ faults: [], counts: [{ item: "Villa II Mirror", seen: 4 }] });
    expect(shortfallFrom(asked, verdict)).toEqual([]);
  });

  it("says nothing when the render delivered everything", () => {
    const verdict = readVerdict({
      faults: [],
      counts: [
        { item: "Panther Barbers Chair", seen: 4 },
        { item: "Villa II Mirror", seen: 5 },
      ],
    });
    expect(shortfallFrom(asked, verdict)).toEqual([]);
  });

  it("never claims a shortfall on a plan with nothing repeated", () => {
    const verdict = readVerdict({ faults: [], counts: [{ item: "Walker Desk", seen: 0 }] });
    expect(shortfallFrom([{ name: "Walker Desk", qty: 1 }], verdict)).toEqual([]);
  });

  it("says nothing at all when no counting was asked for", () => {
    expect(shortfallFrom(asked, readVerdict({ faults: [] }))).toEqual([]);
  });

  it("drops malformed count rows rather than reading NaN", () => {
    const verdict = readVerdict({
      faults: [],
      counts: [{ item: "Chair" }, { seen: 2 }, "nope", { item: "Villa II Mirror", seen: "3" }],
    });
    expect(verdict.counts).toEqual([{ item: "Villa II Mirror", seen: 3 }]);
  });
});

describe("shortfallNote", () => {
  it("is empty when nothing is short", () => {
    expect(shortfallNote([])).toBe("");
  });

  it("tells the customer what fitted and where the rest goes", () => {
    const text = shortfallNote(
      [{ name: "Panther Barbers Chair", asked: 4, seen: 2 }],
      "along the empty wall opposite the entrance",
    );
    expect(text).toContain("4 × Panther Barbers Chair");
    expect(text).toContain("this view holds 2");
    expect(text).toContain("The remaining 2 pieces would go along the empty wall");
  });

  it("still explains itself without a placement hint", () => {
    const text = shortfallNote([{ name: "Backwash Unit", asked: 2, seen: 1 }]);
    expect(text).toContain("The remaining 1 piece sit");
    expect(text).toContain("still in your plan and your quote");
  });

  it("reads as English when none of them fitted", () => {
    expect(shortfallNote([{ name: "Backwash Unit", asked: 2, seen: 0 }])).toContain(
      "this view holds none",
    );
  });

  it("covers several short lines in one sentence", () => {
    const text = shortfallNote([
      { name: "Chair", asked: 4, seen: 2 },
      { name: "Mirror", asked: 4, seen: 3 },
    ]);
    expect(text).toContain("4 × Chair");
    expect(text).toContain("4 × Mirror");
    expect(text).toContain("remaining 3 pieces");
  });

  it("does not stutter when the hint already starts with 'they could go'", () => {
    const text = shortfallNote(
      [{ name: "Chair", asked: 2, seen: 1 }],
      "they could go against the far wall",
    );
    expect(text).toContain("would go against the far wall");
    expect(text).not.toMatch(/go they could go/);
  });
});
