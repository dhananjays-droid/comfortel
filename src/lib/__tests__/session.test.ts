import { describe, expect, it } from "vitest";

import type { ChatMessageInput } from "@/lib/chat.functions";
import {
  MAX_CONTENT,
  MAX_PLAN_IDS,
  MAX_TRANSCRIPT,
  ROOM_TTL_MS,
  appendTurn,
  isSessionKey,
  liveRoom,
  newSessionKey,
  sanitizeFlow,
  sanitizePlan,
  sanitizeTranscript,
} from "@/lib/session";

const resolves = (id: string) => id.startsWith("ok");

describe("session keys", () => {
  it("mints keys that pass its own shape check", () => {
    for (let i = 0; i < 20; i++) expect(isSessionKey(newSessionKey())).toBe(true);
  });

  it("mints a different key every time", () => {
    const keys = new Set(Array.from({ length: 50 }, () => newSessionKey()));
    expect(keys.size).toBe(50);
  });

  it("accepts a WhatsApp key and rejects junk", () => {
    expect(isSessionKey(`wa:${"a".repeat(64)}`)).toBe(true);
    // Ambiguous glyphs are outside the alphabet, so a misread key fails closed
    // rather than landing on someone else's conversation.
    expect(isSessionKey("short")).toBe(false);
    expect(isSessionKey("wa:notahexdigest")).toBe(false);
    expect(isSessionKey("../../etc/passwd")).toBe(false);
    expect(isSessionKey(null)).toBe(false);
  });
});

describe("sanitizePlan", () => {
  it("drops ids the catalogue no longer resolves", () => {
    // The fault this prevents: a stale id sits in the plan as an invisible
    // line, counted in the subtotal, with no card to remove it by.
    const plan = sanitizePlan({ ids: ["ok1", "gone", "ok2"], qty: {} }, resolves);
    expect(plan.ids).toEqual(["ok1", "ok2"]);
  });

  it("keeps counts above one and drops the rest", () => {
    const plan = sanitizePlan({ ids: ["ok1", "ok2"], qty: { ok1: 4, ok2: 1 } }, resolves);
    expect(plan.qty).toEqual({ ok1: 4 });
  });

  it("ignores a count for an id that did not survive", () => {
    const plan = sanitizePlan({ ids: ["ok1"], qty: { gone: 9 } }, resolves);
    expect(plan.qty).toEqual({});
  });

  it("clamps a hostile count instead of storing it", () => {
    const plan = sanitizePlan({ ids: ["ok1"], qty: { ok1: 1e9 } }, resolves);
    expect(plan.qty["ok1"]).toBe(99);
  });

  it("holds the plan to the tray's own limit", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `ok${i}`);
    expect(sanitizePlan({ ids, qty: {} }, resolves).ids).toHaveLength(MAX_PLAN_IDS);
  });

  it("survives every shape of nonsense", () => {
    for (const raw of [null, undefined, 42, "plan", [], { ids: "no", qty: 7 }]) {
      expect(sanitizePlan(raw, resolves)).toEqual({ ids: [], qty: {} });
    }
  });
});

describe("sanitizeTranscript", () => {
  it("keeps only turns the model would accept", () => {
    const out = sanitizeTranscript([
      { role: "user", content: "hi" },
      { role: "system", content: "nope" },
      { role: "assistant", content: "   " },
      { role: "assistant", content: "hello" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("keeps the newest turns, not the oldest", () => {
    const many = Array.from({ length: MAX_TRANSCRIPT + 10 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    const out = sanitizeTranscript(many);
    expect(out).toHaveLength(MAX_TRANSCRIPT);
    expect(out.at(-1)?.content).toBe(`m${MAX_TRANSCRIPT + 9}`);
  });

  it("truncates a turn to the same cap chat.functions applies", () => {
    const out = sanitizeTranscript([{ role: "user", content: "x".repeat(MAX_CONTENT + 500) }]);
    expect(out[0]?.content).toHaveLength(MAX_CONTENT);
  });
});

describe("sanitizeFlow", () => {
  it("keeps the two states the menu can wait in", () => {
    expect(sanitizeFlow({ awaiting: "wall" })).toEqual({ awaiting: "wall" });
    expect(sanitizeFlow({ awaiting: "photo" })).toEqual({ awaiting: "photo" });
  });

  it("discards anything else", () => {
    expect(sanitizeFlow({ awaiting: "admin" })).toEqual({});
    expect(sanitizeFlow(null)).toEqual({});
  });
});

describe("liveRoom", () => {
  const at = new Date("2026-09-01T12:00:00Z").toISOString();
  const now = Date.parse(at);

  it("returns a room that is still fetchable", () => {
    const room = liveRoom({ url: "https://x/r.jpg", aspect: "2:3", at }, now + 60_000);
    expect(room?.url).toBe("https://x/r.jpg");
    expect(room?.aspect).toBe("2:3");
  });

  it("drops one past kie's tempfile window", () => {
    // The fault this prevents: a stale URL reads as an attached photo, the
    // model emits a render line, and we pay for a task that cannot fetch it.
    expect(liveRoom({ url: "https://x/r.jpg", aspect: "2:3", at }, now + ROOM_TTL_MS + 1)).toBe(
      undefined,
    );
  });

  it("drops one with no url or an unreadable timestamp", () => {
    expect(liveRoom({ url: "", aspect: "2:3", at }, now)).toBe(undefined);
    expect(liveRoom({ url: "https://x/r.jpg", aspect: "2:3", at: "never" }, now)).toBe(undefined);
    expect(liveRoom(null, now)).toBe(undefined);
  });
});

describe("appendTurn", () => {
  it("appends without mutating the caller's array", () => {
    const before = [{ role: "user" as const, content: "hi" }];
    const after = appendTurn(before, "assistant", "hello");
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
  });

  it("ignores an empty turn", () => {
    const before = [{ role: "user" as const, content: "hi" }];
    expect(appendTurn(before, "assistant", "   ")).toBe(before);
  });

  it("holds the window while appending", () => {
    let t: ChatMessageInput[] = Array.from({ length: MAX_TRANSCRIPT }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    t = appendTurn(t, "assistant", "newest");
    expect(t).toHaveLength(MAX_TRANSCRIPT);
    expect(t.at(-1)?.content).toBe("newest");
  });
});
