import { afterEach, describe, expect, it } from "vitest";

import { CATALOG_FULL } from "@/lib/catalog";
import {
  EMPTY_SESSION,
  liveOffered,
  liveRoom,
  sanitizeFlow,
  sanitizeOffered,
  sanitizePendingQuote,
  sanitizePlan,
  sanitizeRoom,
  sanitizeRoomSpec,
  sanitizeSession,
  sanitizeTranscript,
} from "@/lib/wa-session";
import { waSessionKey } from "@/lib/wa-session.server";

const ORIGINAL_SECRET = process.env["WHATSAPP_SESSION_SECRET"];
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env["WHATSAPP_SESSION_SECRET"];
  else process.env["WHATSAPP_SESSION_SECRET"] = ORIGINAL_SECRET;
});

const REAL_IDS = Object.keys(CATALOG_FULL).slice(0, 3);
const REAL_ID = REAL_IDS[0]!;

describe("waSessionKey", () => {
  it("mints a deterministic 'wa:' key from a phone number", () => {
    process.env["WHATSAPP_SESSION_SECRET"] = "test-secret";
    const a = waSessionKey("+1 (555) 123-4567");
    const b = waSessionKey("15551234567");
    expect(a).toBe(b);
    expect(a.startsWith("wa:")).toBe(true);
  });

  it("never leaks the phone number itself into the key", () => {
    process.env["WHATSAPP_SESSION_SECRET"] = "test-secret";
    const key = waSessionKey("15551234567");
    expect(key).not.toContain("5551234567");
  });

  it("produces a different key under a different secret", () => {
    process.env["WHATSAPP_SESSION_SECRET"] = "secret-a";
    const a = waSessionKey("15551234567");
    process.env["WHATSAPP_SESSION_SECRET"] = "secret-b";
    const b = waSessionKey("15551234567");
    expect(a).not.toBe(b);
  });

  it("throws rather than minting an unkeyed key when the secret is missing", () => {
    delete process.env["WHATSAPP_SESSION_SECRET"];
    expect(() => waSessionKey("15551234567")).toThrow();
  });

  it("throws on a phone number with no digits", () => {
    process.env["WHATSAPP_SESSION_SECRET"] = "test-secret";
    expect(() => waSessionKey("not-a-phone")).toThrow();
  });
});

describe("liveRoom", () => {
  const room = { url: "https://example.com/room.jpg", at: 1_000_000 };

  it("keeps a room photo inside the 15-minute TTL", () => {
    expect(liveRoom(room, 1_000_000 + 60_000)).toEqual(room);
  });

  it("expires a room photo past the TTL", () => {
    expect(liveRoom(room, 1_000_000 + 16 * 60_000)).toBeNull();
  });

  it("passes null through", () => {
    expect(liveRoom(null, 1_000_000)).toBeNull();
  });
});

describe("liveOffered", () => {
  const offered = {
    packages: [],
    choice: { stations: 4, budget: 15000, note: "", byZone: false },
    at: 1_000_000,
  };

  it("keeps an offer inside the 30-minute TTL", () => {
    expect(liveOffered(offered, 1_000_000 + 60_000)).toEqual(offered);
  });

  it("expires an offer past the TTL", () => {
    expect(liveOffered(offered, 1_000_000 + 31 * 60_000)).toBeNull();
  });
});

describe("sanitizePlan", () => {
  it("keeps only ids that resolve against the real catalog", () => {
    const out = sanitizePlan({ ids: [REAL_ID, "totally-invented-id"], qty: {} });
    expect(out.ids).toEqual([REAL_ID]);
  });

  it("clamps quantity to 1..99, matching chat.functions.ts's own clamp", () => {
    const out = sanitizePlan({ ids: [REAL_ID], qty: { [REAL_ID]: 500 } });
    expect(out.qty[REAL_ID]).toBe(99);
    const out2 = sanitizePlan({ ids: [REAL_ID], qty: { [REAL_ID]: -3 } });
    expect(out2.qty[REAL_ID]).toBe(1);
  });

  it("drops a duplicate id rather than double-counting it", () => {
    const out = sanitizePlan({ ids: [REAL_ID, REAL_ID], qty: {} });
    expect(out.ids).toEqual([REAL_ID]);
  });

  it("caps the plan at 10 lines", () => {
    const ids = Object.keys(CATALOG_FULL).slice(0, 15);
    expect(ids.length).toBeGreaterThan(10);
    const out = sanitizePlan({ ids, qty: {} });
    expect(out.ids.length).toBe(10);
  });

  it("tolerates a hostile / malformed payload", () => {
    expect(sanitizePlan(null)).toEqual({ ids: [], qty: {} });
    expect(sanitizePlan({ ids: "not-an-array" })).toEqual({ ids: [], qty: {} });
    expect(sanitizePlan({ ids: [{ evil: true }] })).toEqual({ ids: [], qty: {} });
  });
});

describe("sanitizeTranscript", () => {
  it("keeps only well-formed user/assistant turns", () => {
    const out = sanitizeTranscript([
      { role: "user", content: "hi" },
      { role: "system", content: "should be dropped" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "hello" },
    ]);
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("trims to the last 24 turns", () => {
    const turns = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn ${i}`,
    }));
    const out = sanitizeTranscript(turns);
    expect(out.length).toBe(24);
    expect(out[0]!.content).toBe("turn 16");
  });

  it("caps each message at 4000 chars", () => {
    const out = sanitizeTranscript([{ role: "user", content: "x".repeat(5000) }]);
    expect(out[0]!.content.length).toBe(4000);
  });

  it("tolerates a hostile payload", () => {
    expect(sanitizeTranscript("not-an-array")).toEqual([]);
    expect(sanitizeTranscript([{ role: "user", content: 42 }])).toEqual([]);
  });
});

describe("sanitizeFlow", () => {
  it("accepts a known Await value", () => {
    expect(sanitizeFlow({ awaiting: "build" })).toEqual({ awaiting: "build" });
  });

  it("drops an unknown awaiting value rather than trusting it", () => {
    expect(sanitizeFlow({ awaiting: "definitely-not-real" })).toEqual({});
  });

  it("tolerates a hostile payload", () => {
    expect(sanitizeFlow(null)).toEqual({});
    expect(sanitizeFlow("nope")).toEqual({});
  });
});

describe("sanitizePendingQuote", () => {
  it("keeps real catalogue ids", () => {
    expect(sanitizePendingQuote({ productIds: [REAL_ID] })).toEqual({ productIds: [REAL_ID] });
  });

  it("drops ids that don't resolve against the catalogue", () => {
    expect(sanitizePendingQuote({ productIds: [REAL_ID, "not-a-real-id"] })).toEqual({
      productIds: [REAL_ID],
    });
  });

  it("becomes null once every id is dropped", () => {
    expect(sanitizePendingQuote({ productIds: ["not-a-real-id"] })).toBeNull();
  });

  it("tolerates a hostile payload", () => {
    expect(sanitizePendingQuote(null)).toBeNull();
    expect(sanitizePendingQuote({ productIds: "not-an-array" })).toBeNull();
  });
});

describe("sanitizeRoom", () => {
  it("keeps a well-formed room photo", () => {
    const out = sanitizeRoom({ url: "https://x/y.jpg", at: 123 });
    expect(out).toEqual({ url: "https://x/y.jpg", at: 123 });
  });

  it("rejects a room with no url", () => {
    expect(sanitizeRoom({ at: 123 })).toBeNull();
  });

  it("tolerates a hostile payload", () => {
    expect(sanitizeRoom(null)).toBeNull();
    expect(sanitizeRoom({ url: 42 })).toBeNull();
  });
});

describe("sanitizeRoomSpec", () => {
  it("keeps well-formed dimensions, independent of any photo", () => {
    expect(sanitizeRoomSpec({ wallCm: 400, depthCm: 300 })).toEqual({
      wallCm: 400,
      depthCm: 300,
    });
  });

  it("keeps a wall length with no depth given", () => {
    expect(sanitizeRoomSpec({ wallCm: 400 })).toEqual({ wallCm: 400 });
  });

  it("clamps to visualize.functions.ts's own 100..3000 range", () => {
    expect(sanitizeRoomSpec({ wallCm: 99999 })?.wallCm).toBe(3000);
  });

  it("rejects a spec with no usable wall length", () => {
    expect(sanitizeRoomSpec({ depthCm: 300 })).toBeNull();
    expect(sanitizeRoomSpec(null)).toBeNull();
  });
});

describe("sanitizeOffered", () => {
  it("rebuilds a package's total from the real catalog rather than trusting a stored total", () => {
    const product = CATALOG_FULL[REAL_ID]!;
    const offered = sanitizeOffered({
      packages: [
        {
          tier: "balanced",
          // A hostile/stale total, deliberately wrong.
          reasons: ["fits your budget"],
          lines: [{ role: "styling", product: { id: REAL_ID }, qty: 2 }],
        },
      ],
      choice: { stations: 4, budget: 15000, note: "four chairs please", byZone: false },
      at: 1000,
    });
    expect(offered).not.toBeNull();
    const pkg = offered!.packages[0]!;
    expect(pkg.total).toBe((product.price ?? 0) * 2);
    expect(pkg.lines[0]!.subtotal).toBe((product.price ?? 0) * 2);
  });

  it("drops a package whose every line references an invented product", () => {
    const offered = sanitizeOffered({
      packages: [{ tier: "lean", lines: [{ role: "styling", product: { id: "nope" }, qty: 1 }] }],
      choice: { stations: 4, budget: 15000, note: "", byZone: false },
      at: 1000,
    });
    expect(offered).toBeNull();
  });

  it("tolerates a hostile payload", () => {
    expect(sanitizeOffered(null)).toBeNull();
    expect(sanitizeOffered({ packages: "not-an-array" })).toBeNull();
  });
});

describe("sanitizeSession", () => {
  it("rebuilds a fully empty, safe session from nothing", () => {
    expect(sanitizeSession(null)).toEqual(EMPTY_SESSION);
    expect(sanitizeSession(undefined)).toEqual(EMPTY_SESSION);
    expect(sanitizeSession({})).toEqual(EMPTY_SESSION);
  });

  it("round-trips a well-formed session unchanged", () => {
    const session = {
      transcript: [{ role: "user", content: "hi" }],
      plan: { ids: [REAL_ID], qty: { [REAL_ID]: 3 } },
      flow: { awaiting: "visualize" },
      roomSpec: { wallCm: 400 },
      room: { url: "https://x/y.jpg", at: 1 },
      offered: null,
      pendingZoneRender: true,
      pendingQuote: { productIds: [REAL_ID] },
      handoff: true,
    };
    expect(sanitizeSession(session)).toEqual(session);
  });
});
