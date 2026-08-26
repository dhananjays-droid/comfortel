import { describe, expect, it } from "vitest";

import {
  FAULTS,
  FAULT_KINDS,
  MAX_RETRIES,
  correctionFor,
  isFaultKind,
  readVerdict,
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
