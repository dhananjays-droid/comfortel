import { describe, expect, it } from "vitest";

import { BRIEF_PLACEHOLDER, readBrief, readIntake, readWall } from "@/lib/brief";

describe("readBrief — stations", () => {
  it("reads digits and words alike", () => {
    expect(readBrief("a 4 chair salon").stations).toBe(4);
    expect(readBrief("a four-chair salon").stations).toBe(4);
    expect(readBrief("six styling stations").stations).toBe(6);
    expect(readBrief("Twelve seats").stations).toBe(12);
  });

  it("ignores counts that cannot be a salon", () => {
    expect(readBrief("0 chairs").stations).toBeUndefined();
    expect(readBrief("400 chairs").stations).toBeUndefined();
  });

  it("returns nothing when no count is given", () => {
    expect(readBrief("somewhere warm and modern").stations).toBeUndefined();
  });
});

describe("readBrief — budget", () => {
  it("reads the ways people write money", () => {
    expect(readBrief("budget $15,000").budget).toBe(15000);
    expect(readBrief("about $15k").budget).toBe(15000);
    expect(readBrief("15k to spend").budget).toBe(15000);
    expect(readBrief("spending around 20000").budget).toBe(20000);
    expect(readBrief("up to 9,500").budget).toBe(9500);
  });

  it("does not mistake a station count for a budget", () => {
    // The whole reason for the floor: "4 chairs" must not mean $4.
    expect(readBrief("4 chairs").budget).toBeUndefined();
    expect(readBrief("six stations, nothing fancy").budget).toBeUndefined();
  });

  it("ignores a bare number with no money language around it", () => {
    expect(readBrief("we opened in 2019").budget).toBeUndefined();
  });

  it("returns nothing when no budget is given", () => {
    expect(readBrief("a warm modern salon").budget).toBeUndefined();
  });
});

describe("readBrief — together", () => {
  it("pulls both out of one real sentence", () => {
    const brief = readBrief(
      "A four-chair salon in a converted shopfront. Warm and modern. Budget around $15,000.",
    );
    expect(brief).toEqual({ stations: 4, budget: 15000 });
  });

  it("survives an empty or useless description", () => {
    expect(readBrief("")).toEqual({});
    expect(readBrief("hi")).toEqual({});
  });

  // If the example we show people does not parse, the feature looks broken to
  // the first person who takes the hint literally.
  it("understands its own placeholder", () => {
    expect(readBrief(BRIEF_PLACEHOLDER)).toEqual({ stations: 4, budget: 15000 });
  });
});

describe("readWall", () => {
  it("reads a wall with an explicit unit", () => {
    expect(readWall("the wall is 16ft")).toBe(488);
    expect(readWall("about 5 metres")).toBe(500);
    expect(readWall("4.5m along the back")).toBe(450);
  });

  it("ignores a bare number, which is ambiguous in a combined reply", () => {
    // "4 chairs, 15000 budget" must not yield a 4cm or 15000cm wall.
    expect(readWall("4 chairs and a 15000 budget")).toBeUndefined();
  });

  it("rejects a length no salon wall could be", () => {
    expect(readWall("0.5m")).toBeUndefined();
    expect(readWall("400 feet")).toBeUndefined();
  });
});

describe("readIntake", () => {
  it("reads everything one ordinary sentence happens to contain", () => {
    const out = readIntake("4 chair salon, warm and modern, around $15k, the wall is 16ft");
    expect(out.stations).toBe(4);
    expect(out.budget).toBe(15000);
    expect(out.wallCm).toBe(488);
  });

  it("returns only what was actually there", () => {
    const out = readIntake("something modern, not sure on numbers yet");
    expect(out.stations).toBeUndefined();
    expect(out.budget).toBeUndefined();
    expect(out.wallCm).toBeUndefined();
  });
});
