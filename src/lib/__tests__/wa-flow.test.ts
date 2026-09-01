import { describe, expect, it } from "vitest";

import { WA } from "@/lib/whatsapp";
import {
  INITIAL,
  advance,
  categoryRows,
  describeIntake,
  isGreeting,
  parseWall,
  welcome,
} from "@/lib/wa-flow";

describe("isGreeting", () => {
  it("opens the menu for the ways people actually say hello", () => {
    for (const text of ["Hi", "hi", "hiii", "Hey!", "hello", "Good morning", "menu", "START"]) {
      expect(isGreeting(text)).toBe(true);
    }
  });

  it("does not swallow a real question that happens to start with hi", () => {
    expect(isGreeting("Hi, do you have oxblood styling chairs?")).toBe(false);
    expect(isGreeting("highchair")).toBe(false);
  });
});

describe("welcome", () => {
  it("offers no more buttons than WhatsApp allows", () => {
    const action = welcome().action;
    expect(action?.kind).toBe("buttons");
    if (action?.kind === "buttons") {
      expect(action.buttons.length).toBeLessThanOrEqual(WA.buttons);
    }
  });

  it("keeps every button title inside the label limit", () => {
    const action = welcome().action;
    if (action?.kind === "buttons") {
      for (const button of action.buttons) {
        expect(button.title.length).toBeLessThanOrEqual(WA.buttonTitle);
      }
    }
  });

  it("stays short enough to read without scrolling", () => {
    // Industry guidance is to stay under ~250 characters for a welcome.
    expect(welcome().text.length).toBeLessThan(250);
  });
});

describe("advance", () => {
  it("answers a greeting with the menu, without reaching the model", () => {
    const out = advance(INITIAL, "Hi");
    expect(out).not.toBeNull();
    expect(out?.reply.action?.kind).toBe("buttons");
  });

  it("opens the visualize intake from a tap, and remembers it is waiting", () => {
    const out = advance(INITIAL, "wa:visualize");
    expect(out?.reply.awaiting).toBe("visualize");
    expect(out?.state.awaiting).toBe("visualize");
    expect(out?.reply.wantsPhoto).toBe(true);
  });

  it("asks for everything in one message when planning", () => {
    // One message, not five questions: there is no form on WhatsApp, and a
    // five-turn interrogation is how a business number gets muted.
    const out = advance(INITIAL, "wa:build");
    expect(out?.state.awaiting).toBe("build");
    expect(out?.reply.text).toContain("stations");
    expect(out?.reply.text).toContain("budget");
    expect(out?.reply.action).toBeUndefined();
  });

  it("lets an ask go straight to free text", () => {
    const out = advance(INITIAL, "wa:ask");
    expect(out?.state.awaiting).toBeUndefined();
    expect(out?.reply.awaiting).toBeUndefined();
  });

  it("accepts a typed number as well as a tap", () => {
    expect(advance(INITIAL, "1")?.state.awaiting).toBe("visualize");
    expect(advance(INITIAL, "2")?.state.awaiting).toBe("build");
    expect(advance(INITIAL, "3")?.state.awaiting).toBeUndefined();
  });

  it("accepts the button label typed out", () => {
    expect(advance(INITIAL, "Plan my salon")?.state.awaiting).toBe("build");
  });

  it("never offers more list rows than WhatsApp allows", () => {
    const rows = categoryRows();
    expect(rows.length).toBeLessThanOrEqual(WA.listRows);
    for (const row of rows) {
      expect(row.title.length).toBeLessThanOrEqual(WA.listRowTitle);
      expect(row.description.length).toBeLessThanOrEqual(WA.listRowDescription);
    }
  });

  it("hands an answer to its own question onward instead of answering it", () => {
    // null means "the menu has nothing to add" — the route attaches what it
    // parsed and calls the model, which is better at "warm and modern".
    expect(advance({ awaiting: "build" }, "4 chairs, about $15k, warm and modern")).toBeNull();
    expect(advance({ awaiting: "visualize" }, "a black styling chair")).toBeNull();
  });

  it("does not re-open the menu while waiting on an answer", () => {
    // "1" is a menu shortcut, but here it is far more likely to be one station.
    expect(advance({ awaiting: "build" }, "1")).toBeNull();
  });

  it("falls through to the model for anything the menu cannot serve", () => {
    expect(advance(INITIAL, "do you have anything in oxblood")).toBeNull();
    expect(advance(INITIAL, "")).toBeNull();
  });

  it("does not treat an out-of-range number as a menu choice", () => {
    expect(advance(INITIAL, "9")).toBeNull();
  });
});

describe("parseWall", () => {
  it("reads feet and metres", () => {
    expect(parseWall("16 ft")).toBeCloseTo(4.8768);
    expect(parseWall("4.5m")).toBeCloseTo(4.5);
    expect(parseWall("about 20 feet")).toBeCloseTo(6.096);
  });

  it("reads a bare number as feet, this being a US catalogue", () => {
    expect(parseWall("16")).toBeCloseTo(4.8768);
  });

  it("returns null when there is no number", () => {
    expect(parseWall("not sure")).toBeNull();
    expect(parseWall("")).toBeNull();
  });

  it("rejects a zero or negative length", () => {
    expect(parseWall("0 ft")).toBeNull();
  });
});

describe("describeIntake", () => {
  it("says what it read", () => {
    expect(describeIntake({ stations: 4, budget: 15000 })).toContain("4 stations");
    expect(describeIntake({ stations: 4, budget: 15000 })).toContain("$15,000");
  });

  it("says what it is assuming, rather than guessing silently", () => {
    // A silent guess shapes the whole package and is discovered only when the
    // total comes back wrong.
    const out = describeIntake({ stations: 4 });
    expect(out).toContain("Not given");
    expect(out).toContain("budget");
  });

  it("treats a measured wall as answering the station question", () => {
    const out = describeIntake({ wallCm: 488, budget: 15000 });
    expect(out).toContain("16ft wall");
    expect(out).not.toContain("station count");
  });

  it("says nothing was read when nothing was", () => {
    expect(describeIntake({})).not.toContain("Read from that");
    expect(describeIntake({})).toContain("Not given");
  });
});
