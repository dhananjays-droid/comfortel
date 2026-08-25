import { describe, expect, it } from "vitest";

import {
  ASSUMED,
  CLEARANCE,
  capacity,
  depthFits,
  stationsAlongWall,
  wallForStations,
} from "@/lib/layout";

describe("stationsAlongWall", () => {
  it("charges the wall-end clearance once per end, not per station", () => {
    // 600cm wall, 60cm chair, 30cm gaps, 15cm at each end.
    // usable 570 -> floor((570 + 30) / 90) = 6 chairs; 6*60 + 5*30 = 510 used.
    const fit = stationsAlongWall(600, 60);
    expect(fit.count).toBe(6);
    expect(fit.pitch).toBe(90);
    expect(fit.used).toBe(510);
  });

  it("returns zero when even one chair will not fit", () => {
    expect(stationsAlongWall(70, 60).count).toBe(0);
    expect(stationsAlongWall(0, 60).count).toBe(0);
  });

  it("fits exactly one when there is room for one and no gap", () => {
    expect(stationsAlongWall(90, 60).count).toBe(1);
  });

  it("falls back to an assumed width when the product has none", () => {
    expect(stationsAlongWall(600, 0).pitch).toBe(ASSUMED.stationWidth + CLEARANCE.betweenStations);
  });

  it("round-trips against wallForStations", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const needed = wallForStations(n, 65);
      expect(stationsAlongWall(needed, 65).count).toBe(n);
      // One cm short must lose a station, or the inverse is not tight.
      expect(stationsAlongWall(needed - 1, 65).count).toBe(n - 1);
    }
  });
});

describe("wallForStations", () => {
  it("fits four 65cm chairs on a 4m wall, which is tighter than it looks", () => {
    // 4*65 + 3*30 + 2*15 = 380. Worth pinning: a 4m wall does take four
    // stations, and an earlier version of this suite assumed it did not.
    expect(wallForStations(4, 65)).toBe(380);
    expect(stationsAlongWall(400, 65).count).toBe(4);
    expect(stationsAlongWall(300, 65).count).toBe(3);
  });

  it("is zero for no stations", () => {
    expect(wallForStations(0, 60)).toBe(0);
  });

  it("adds gaps only between stations", () => {
    // 4 * 60 + 3 * 30 + 2 * 15 = 360
    expect(wallForStations(4, 60)).toBe(360);
  });
});

describe("depthFits", () => {
  it("requires the item depth plus a walkway", () => {
    const check = depthFits(200, 60);
    expect(check.needed).toBe(160);
    expect(check.fits).toBe(true);
    expect(check.short).toBe(0);
  });

  it("reports how far short a shallow room is", () => {
    const check = depthFits(120, 60);
    expect(check.fits).toBe(false);
    expect(check.short).toBe(40);
  });
});

describe("capacity", () => {
  const chair = { w: 65, d: 120, h: 90 };

  it("hedges the language when the room was estimated from a photo", () => {
    const result = capacity({ wallCm: 300, depthCm: 300, confidence: "estimated" }, chair, 4);
    expect(result.hedged).toBe(true);
    expect(result.warnings.join(" ")).toContain("reads as roughly");
    // Never a flat refusal on an estimate.
    expect(result.warnings.join(" ")).not.toMatch(
      /^\d+ stations need [\d.]+m of wall and you have/,
    );
  });

  it("states it plainly when the room was measured", () => {
    const result = capacity({ wallCm: 300, confidence: "measured" }, chair, 4);
    expect(result.hedged).toBe(false);
    expect(result.warnings.join(" ")).toContain("so 3 fit");
  });

  it("says nothing when the request fits", () => {
    const result = capacity({ wallCm: 600, depthCm: 300, confidence: "measured" }, chair, 3);
    expect(result.fits).toBeGreaterThanOrEqual(3);
    expect(result.warnings).toEqual([]);
  });

  it("flags a room too shallow for the piece plus a walkway", () => {
    const result = capacity({ wallCm: 600, depthCm: 150, confidence: "measured" }, chair, 2);
    expect(result.warnings.join(" ")).toContain("of depth");
  });

  it("admits when it is working from an assumed width", () => {
    const result = capacity(
      { wallCm: 600, confidence: "measured" },
      { w: null, d: null, h: null },
      2,
    );
    expect(result.warnings.join(" ")).toContain("assumes 60cm");
  });
});
