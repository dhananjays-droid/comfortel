import { describe, expect, it } from "vitest";

import { lastUserTurn, wantsRender } from "@/lib/render-intent";

describe("wantsRender — asks", () => {
  const asking = [
    "show me the Blake in my salon",
    "show me how that looks",
    "can you show me the Harper",
    "could I see that in my room",
    "let me see it",
    "I'd like to see them in my space",
    "render the Harper into my photo",
    "can you visualise this",
    "mock up my salon with those",
    "give me a preview",
    "what would the Oakley look like in here",
    "how does that look with four stations",
    "put them in my room",
    "try it in the photo",
    "I want to see it",
  ];
  for (const text of asking) {
    it(`asks: ${text}`, () => expect(wantsRender(text)).toBe(true));
  }
});

describe("wantsRender — not asks", () => {
  /**
   * These are the exact turns that produced unasked-for renders when the only
   * gate was "is a photo attached". Four of the eight billed.
   */
  const reacting = [
    "the chairs look a bit too big in that",
    "I like it",
    "hmm the colour looks off",
    "that's not quite the layout I meant",
    "nice, but can the mirrors be bigger",
    "why does it look so dark",
    "the trolley is in the wrong place",
    "what do you think of it?",
  ];
  for (const text of reacting) {
    it(`reacts: ${text}`, () => expect(wantsRender(text)).toBe(false));
  }

  const chatting = [
    "what colours does the Harper come in?",
    "how much is the Blake?",
    "do you deliver to Sydney?",
    "what's the warranty on these?",
    "how wide is the Harper?",
    "which one is more hard-wearing?",
    "",
    "   ",
  ];
  for (const text of chatting) {
    it(`chats: ${text || "(empty)"}`, () => expect(wantsRender(text)).toBe(false));
  }
});

describe("wantsRender — refusals beat asks", () => {
  // Every one of these contains a phrase that would otherwise read as the
  // strongest possible ask, which is the worst way to get it wrong.
  const refusing = [
    "don't render that, just tell me the price",
    "no need to render, I just want the dimensions",
    "please don't generate an image",
    "just answer, no image",
    "can you explain it without rendering anything",
    "no renders please",
    "text only please",
  ];
  for (const text of refusing) {
    it(`refuses: ${text}`, () => expect(wantsRender(text)).toBe(false));
  }
});

describe("wantsRender — guards", () => {
  it("is case-insensitive", () => {
    expect(wantsRender("SHOW ME THAT IN MY SALON")).toBe(true);
  });

  it("survives a non-string", () => {
    expect(wantsRender(undefined as unknown as string)).toBe(false);
    expect(wantsRender(null as unknown as string)).toBe(false);
  });
});

describe("lastUserTurn", () => {
  it("reads the most recent user message, not an earlier one", () => {
    // The fault this prevents: a render request two turns ago was already
    // satisfied, and must not license a second paid render now.
    const turns = [
      { role: "user", content: "show me the Harper in my room" },
      { role: "assistant", content: "Here it is." },
      { role: "user", content: "the chairs look too big" },
    ];
    expect(lastUserTurn(turns)).toBe("the chairs look too big");
    expect(wantsRender(lastUserTurn(turns))).toBe(false);
  });

  it("returns empty when there is no user turn", () => {
    expect(lastUserTurn([{ role: "assistant", content: "hello" }])).toBe("");
    expect(lastUserTurn([])).toBe("");
  });
});
