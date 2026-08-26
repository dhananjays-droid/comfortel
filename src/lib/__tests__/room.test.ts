import { describe, expect, it } from "vitest";

import { ASSUMED, CLEARANCE } from "@/lib/layout";
import {
  MAX_WALL_CM,
  MIN_WALL_CM,
  formatLength,
  fromCm,
  genericCapacity,
  planSummary,
  toCm,
  toRoom,
  validate,
  type RoomSpec,
} from "@/lib/room";

describe("unit conversion", () => {
  it("converts metres and feet to cm", () => {
    expect(toCm(4.2, "m")).toBeCloseTo(420);
    expect(toCm(10, "ft")).toBeCloseTo(304.8);
  });

  it("round-trips through cm without drift", () => {
    for (const unit of ["m", "ft"] as const) {
      expect(fromCm(toCm(13.7, unit), unit)).toBeCloseTo(13.7);
    }
  });

  it("formats in the unit the customer typed", () => {
    expect(formatLength(420, "m")).toBe("4.2 m");
    expect(formatLength(304.8, "ft")).toBe("10 ft");
    // A whole number should not carry a decimal it never had.
    expect(formatLength(500, "m")).toBe("5 m");
  });
});

describe("validate", () => {
  const base = { unit: "m" as const };

  it("requires a wall length", () => {
    expect(validate({ ...base })).toEqual([
      { field: "wall", message: "Add the length of your styling wall." },
    ]);
  });

  it("catches a units slip in both directions", () => {
    expect(validate({ ...base, wallCm: MIN_WALL_CM - 1 })[0]?.field).toBe("wall");
    expect(validate({ ...base, wallCm: MAX_WALL_CM + 1 })[0]?.field).toBe("wall");
  });

  it("accepts a wall with no depth and no station count", () => {
    expect(validate({ ...base, wallCm: 420 })).toEqual([]);
  });

  it("bounds the station count", () => {
    expect(validate({ ...base, wallCm: 420, stations: 0 })[0]?.field).toBe("stations");
    expect(validate({ ...base, wallCm: 420, stations: 21 })[0]?.field).toBe("stations");
    expect(validate({ ...base, wallCm: 420, stations: 4 })).toEqual([]);
  });
});

describe("toRoom", () => {
  it("treats typed dimensions as measured, not estimated", () => {
    expect(toRoom({ wallCm: 420, unit: "m" }).confidence).toBe("measured");
  });

  it("omits depth entirely rather than passing zero", () => {
    expect("depthCm" in toRoom({ wallCm: 420, unit: "m" })).toBe(false);
    expect(toRoom({ wallCm: 420, depthCm: 300, unit: "m" }).depthCm).toBe(300);
  });
});

describe("genericCapacity", () => {
  it("never warns about a missing product width, since no product is chosen yet", () => {
    const fit = genericCapacity({ wallCm: 420, unit: "m" });
    expect(fit.warnings.some((w) => w.includes("No measured width"))).toBe(false);
  });

  it("uses the assumed station footprint", () => {
    const fit = genericCapacity({ wallCm: 420, unit: "m" });
    expect(fit.pitch).toBe(ASSUMED.stationWidth + CLEARANCE.betweenStations);
  });

  // 420 - 15*2 = 390 usable; pitch 90; (390 + 30) / 90 = 4.67 -> 4 stations.
  it("fits four stations on a 4.2m wall", () => {
    expect(genericCapacity({ wallCm: 420, unit: "m" }).fits).toBe(4);
  });

  // Needs usable wall (wall - 15*2) below one 60cm station, so under 90cm.
  // validate() rejects anything under MIN_WALL_CM anyway, so this branch is
  // only reachable by a caller that skips validation.
  it("reports zero on a wall too short for one station", () => {
    expect(genericCapacity({ wallCm: 85, unit: "m" }).fits).toBe(0);
  });

  it("answers plainly rather than hedging, because the numbers were typed", () => {
    expect(genericCapacity({ wallCm: 420, unit: "m" }).hedged).toBe(false);
  });
});

describe("planSummary", () => {
  const spec: RoomSpec = { wallCm: 420, depthCm: 300, stations: 4, unit: "m" };

  it("states the room back in the customer's own unit", () => {
    const text = planSummary(spec);
    expect(text).toContain("4.2 m");
    expect(text).toContain("3 m");
  });

  it("carries the station count so the model never has to do the sum", () => {
    expect(planSummary(spec)).toContain("takes 4 stations");
  });

  it("tells the model not to recalculate", () => {
    expect(planSummary(spec)).toContain("don't recalculate");
  });

  it("states the assumed footprint it planned with", () => {
    expect(planSummary(spec)).toContain(`${ASSUMED.stationWidth}cm station`);
    expect(planSummary(spec)).toContain(`${CLEARANCE.betweenStations}cm between chairs`);
  });

  it("passes the shortfall warning through when the ask does not fit", () => {
    const text = planSummary({ wallCm: 250, stations: 4, unit: "m" });
    expect(text).toMatch(/4 stations need/);
  });

  it("omits depth and station clauses when they were not given", () => {
    const text = planSummary({ wallCm: 420, unit: "m" });
    expect(text).not.toContain("depth");
    expect(text).not.toContain("I'd like");
  });

  it("stays singular for a one-station wall", () => {
    // 190 - 30 = 160 usable; pitch 90; (160 + 30) / 90 = 2.1 -> 2. Use 150.
    const text = planSummary({ wallCm: 150, unit: "m" });
    expect(text).toContain("takes 1 station.");
  });
});

describe("warnings answer in the customer's unit", () => {
  it("uses feet when the room was typed in feet", () => {
    const text = planSummary({ wallCm: toCm(16, "ft"), stations: 8, unit: "ft" });
    expect(text).toContain("ft");
    expect(text).not.toMatch(/\d+\.\dm\b/);
  });

  it("still uses metres when the room was typed in metres", () => {
    const text = planSummary({ wallCm: 490, stations: 8, unit: "m" });
    expect(text).toContain(" m");
  });
});
