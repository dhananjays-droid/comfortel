import { describe, expect, it } from "vitest";

import { WA } from "@/lib/whatsapp";
import { INITIAL, advance, isGreeting, parseWall, welcome } from "@/lib/wa-flow";

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

  it("opens the browse list from a tap", () => {
    const out = advance(INITIAL, "wa:browse");
    expect(out?.reply.action?.kind).toBe("list");
  });

  it("accepts a typed number as well as a tap", () => {
    expect(advance(INITIAL, "1")?.reply.action?.kind).toBe("list");
    expect(advance(INITIAL, "2")?.reply.awaiting).toBe("wall");
    expect(advance(INITIAL, "3")?.reply.handoff).toBe(true);
  });

  it("accepts the button label typed out", () => {
    expect(advance(INITIAL, "Browse the range")?.reply.action?.kind).toBe("list");
  });

  it("never offers more list rows than WhatsApp allows", () => {
    const action = advance(INITIAL, "wa:browse")?.reply.action;
    if (action?.kind === "list") {
      expect(action.rows.length).toBeLessThanOrEqual(WA.listRows);
      for (const row of action.rows) {
        expect(row.title.length).toBeLessThanOrEqual(WA.listRowTitle);
        expect((row.description ?? "").length).toBeLessThanOrEqual(WA.listRowDescription);
      }
    }
  });

  it("returns a category to list when a row is picked", () => {
    const out = advance(INITIAL, "wa:salon/styling-chairs");
    expect(out?.reply.category).toBe("salon/styling-chairs");
  });

  it("asks for the wall when planning, and remembers it is waiting", () => {
    const out = advance(INITIAL, "wa:plan");
    expect(out?.reply.awaiting).toBe("wall");
    expect(out?.state.awaiting).toBe("wall");
  });

  it("re-asks rather than guessing when the measurement is unreadable", () => {
    const out = advance({ awaiting: "wall" }, "not sure really");
    expect(out?.state.awaiting).toBe("wall");
    expect(out?.reply.text).toContain("didn't catch");
  });

  it("hands a real measurement onward instead of answering it itself", () => {
    // null means "the menu has nothing to add" — the route runs the arithmetic.
    expect(advance({ awaiting: "wall" }, "16 ft")).toBeNull();
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
