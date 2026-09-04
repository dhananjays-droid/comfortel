import { describe, expect, it } from "vitest";

import { CATALOG_FULL } from "@/lib/catalog";
import { handleInboundMessage, proactiveOfferTurn, productTurns } from "@/lib/wa-runtime";
import { EMPTY_SESSION, type SessionState } from "@/lib/wa-session";

/**
 * ANTHROPIC_API_KEY and SUPABASE_SERVICE_ROLE_KEY are not present in
 * process.env for a plain `vitest run` (nothing in this repo loads .env into
 * Node's process.env for tests — only Vite's dev/build pipeline does), so
 * chat.functions.ts's chat() and curate.functions.ts's curatePackages() take
 * their "not configured" fallback paths, and wa-render-jobs.server.ts's
 * enqueueRenderJob() fails its Supabase client construction and swallows it —
 * exactly the resilience behavior those modules document. That means every
 * scripted path below except a live model reply is exercised for real, with
 * no mocking framework needed, matching this repo's existing test style.
 */

const SESSION_KEY = "wa:test-session";
const TEST_PHONE = "15551234567";
const fresh = (): SessionState => ({ ...EMPTY_SESSION });
const REAL_ID = Object.keys(CATALOG_FULL)[0]!;

describe("handleInboundMessage — greeting", () => {
  it("opens with the three-button menu on a customer's very first message, whatever they said", async () => {
    const { session, turns } = await handleInboundMessage(fresh(), SESSION_KEY, TEST_PHONE, {
      kind: "text",
      text: "Do you sell barber chairs?",
    });
    expect(turns[0]?.kind).toBe("buttons");
    if (turns[0]?.kind === "buttons") {
      expect(turns[0].action.buttons.map((b) => b.id)).toEqual(["visualize", "build", "ask"]);
    }
    // The greeting joins the transcript ahead of anything the customer said,
    // the same order the web's pre-seeded greetingMessage() would produce.
    expect(session.transcript[0]).toMatchObject({ role: "assistant" });
  });

  it("does not double-send the menu when the first message is already a greeting", async () => {
    const { turns } = await handleInboundMessage(fresh(), SESSION_KEY, TEST_PHONE, {
      kind: "text",
      text: "Hi",
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.kind).toBe("buttons");
  });

  it("only greets once — a session with prior history gets no menu", async () => {
    const first = await handleInboundMessage(fresh(), SESSION_KEY, TEST_PHONE, {
      kind: "text",
      text: "Hi",
    });
    const second = await handleInboundMessage(first.session, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: "ask",
    });
    expect(second.turns).toHaveLength(1);
    expect(second.turns[0]?.kind).toBe("text");
  });
});

describe("handleInboundMessage — the guided build flow", () => {
  it("walks menu tap → intake → package options → a chosen package fills the plan", async () => {
    let state: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
    };

    let result = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: "build",
    });
    state = result.session;
    expect(state.flow.awaiting).toBe("build");
    expect(result.turns[0]?.kind).toBe("text");

    result = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "text",
      text: "4 stations, about $15,000, a 16 ft wall",
    });
    state = result.session;
    expect(state.flow.awaiting).toBeUndefined();
    expect(state.offered?.packages.length).toBeGreaterThan(0);
    expect(state.roomSpec?.wallCm).toBeGreaterThan(0);
    expect(result.turns[0]?.kind).toBe("buttons");

    const tierId =
      result.turns[0]?.kind === "buttons" ? result.turns[0].action.buttons[0]?.id : undefined;
    expect(tierId).toMatch(/^pkg:/);

    result = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: tierId!,
    });
    state = result.session;
    expect(state.offered).toBeNull();
    expect(state.plan.ids.length).toBeGreaterThan(0);
    // The wall length given during intake means the package promises a
    // zone-by-zone render once a photo arrives.
    expect(state.pendingZoneRender).toBe(true);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.kind).toBe("text");
  });

  it("re-curates rather than crashing on a tap against an expired offer", async () => {
    const withStaleOffer: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
      offered: {
        packages: [],
        choice: { stations: 4, budget: 15000, note: "", byZone: false },
        at: Date.now() - 31 * 60 * 1000, // past OFFER_TTL_MS (30 min)
      },
    };
    const { session, turns } = await handleInboundMessage(withStaleOffer, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: "pkg:balanced",
    });
    expect(session.offered).toBeNull();
    expect(session.flow.awaiting).toBe("build");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.kind).toBe("text");
  });

  it("ignores a package tap that names a tier not on the table", async () => {
    const withOffer: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
      offered: {
        packages: [],
        choice: { stations: 4, budget: 15000, note: "", byZone: false },
        at: Date.now(),
      },
    };
    const { turns } = await handleInboundMessage(withOffer, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: "pkg:premium",
    });
    // No packages were actually offered, so nothing matches — same
    // "re-curate rather than silently do nothing" fallback.
    expect(turns[0]?.kind).toBe("text");
  });
});

describe("handleInboundMessage — render request", () => {
  /**
   * enqueueRenderJob has no Supabase credentials in this test environment
   * (same as every other DB-touching path in this suite), so — correctly,
   * since Phase 5's reliability fix — it fails even after its internal
   * retries, and startRenderTurn/renderPlanByZoneTurn now report that
   * honestly instead of sending a confirmation for a render that was never
   * actually queued. These two tests assert on that honest failure path;
   * the "real render actually gets queued" path needs a real database and
   * is verified manually, same testing-boundary stance as the render
   * worker's own orchestration.
   */
  it("reports honestly, rather than falsely confirming, when a zone render can't be enqueued", async () => {
    let state: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
    };

    state = (
      await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, { kind: "button", id: "build" })
    ).session;
    let result = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "text",
      text: "3 stations, $12,000, 20 by 12 ft",
    });
    state = result.session;
    const tierId =
      result.turns[0]?.kind === "buttons" ? result.turns[0].action.buttons[0]?.id : undefined;
    result = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: tierId!,
    });
    state = result.session;
    expect(state.pendingZoneRender).toBe(true);

    result = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "photo",
      url: "https://example.com/room.jpg",
    });
    state = result.session;
    // pendingZoneRender is cleared and the room is recorded by handlePhoto()
    // before the enqueue is even attempted, so both still hold regardless.
    expect(state.pendingZoneRender).toBe(false);
    expect(state.room?.url).toBe("https://example.com/room.jpg");
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.kind).toBe("text");
    if (result.turns[0]?.kind === "text") {
      expect(result.turns[0].text.toLowerCase()).toContain("went wrong");
    }
  }, 10_000);

  it("reports honestly, rather than falsely confirming, when a tapped offer can't be enqueued", async () => {
    const withRoom: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
      room: { url: "https://example.com/room.jpg", at: Date.now() },
    };
    const { session, turns } = await handleInboundMessage(withRoom, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: `offer:add:${REAL_ID}`,
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.kind).toBe("text");
    if (turns[0]?.kind === "text") expect(turns[0].text.toLowerCase()).toContain("went wrong");
    // No phantom "here's your render" turn was recorded into history either.
    expect(session.transcript).toEqual(withRoom.transcript);
  }, 10_000);

  it("declines a placement-mode offer once the room photo has expired", async () => {
    const staleRoom: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
      room: { url: "https://example.com/room.jpg", at: Date.now() - 16 * 60 * 1000 }, // past ROOM_TTL_MS (15 min)
    };
    const { turns } = await handleInboundMessage(staleRoom, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: `offer:add:${REAL_ID}`,
    });
    expect(turns).toHaveLength(0);
  });

  it("renders staged_room with no photo at all", async () => {
    const state: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
    };
    const { turns } = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: `offer:staged_room:${REAL_ID}`,
    });
    expect(turns).toHaveLength(1);
  });

  it("ignores an offer naming a product that isn't real", async () => {
    const state: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
    };
    const { turns } = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: "offer:staged_room:not-a-real-id",
    });
    expect(turns).toHaveLength(0);
  });
});

describe("handleInboundMessage — compliance handoff", () => {
  it("escalates on request and goes silent afterwards", async () => {
    let state: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
    };
    let result = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "text",
      text: "I'd like to talk to a person please",
    });
    state = result.session;
    expect(state.handoff).toBe(true);
    expect(result.turns).toHaveLength(1);

    result = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "text",
      text: "hello?",
    });
    expect(result.turns).toHaveLength(0);
    expect(result.session).toBe(state);
  });
});

describe("handleInboundMessage — unsupported input", () => {
  it("answers politely instead of crashing on an unhandled message type", async () => {
    const state: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
    };
    const { turns } = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "unsupported",
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]?.kind).toBe("text");
  });
});

describe("handleInboundMessage — add to plan", () => {
  it("adds the tapped product to an empty plan, with its named quantity", async () => {
    const state: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
    };
    const { session, turns } = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: `plan:add:${REAL_ID}:3`,
    });
    expect(session.plan.ids).toEqual([REAL_ID]);
    expect(session.plan.qty[REAL_ID]).toBe(3);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.kind).toBe("text");
    if (turns[0]?.kind === "text") expect(turns[0].text).toContain(CATALOG_FULL[REAL_ID]!.name);
  });

  it("adds to an existing quantity rather than overwriting it", async () => {
    const state: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
      plan: { ids: [REAL_ID], qty: { [REAL_ID]: 2 } },
    };
    const { session } = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: `plan:add:${REAL_ID}:1`,
    });
    expect(session.plan.qty[REAL_ID]).toBe(3);
  });

  it("ignores a tap naming no real product", async () => {
    const state: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
    };
    const { session, turns } = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: "plan:add:not-a-real-id:2",
    });
    expect(turns).toHaveLength(0);
    expect(session.plan.ids).toEqual([]);
  });
});

describe("handleInboundMessage — get a quote", () => {
  it("starts the guided intake and remembers which products it is for", async () => {
    const state: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
    };
    const { session, turns } = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "button",
      id: `quote:${REAL_ID}`,
    });
    expect(session.flow.awaiting).toBe("quote");
    expect(session.pendingQuote?.productIds).toEqual([REAL_ID]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.kind).toBe("text");
    if (turns[0]?.kind === "text") expect(turns[0].text.toLowerCase()).toContain("email");
  });

  it("re-prompts rather than guessing when the reply has no email in it", async () => {
    const state: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
      flow: { awaiting: "quote" },
      pendingQuote: { productIds: [REAL_ID] },
    };
    const { session, turns } = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "text",
      text: "Jamie Lee",
    });
    expect(session.flow.awaiting).toBe("quote");
    expect(session.pendingQuote?.productIds).toEqual([REAL_ID]);
    expect(turns).toHaveLength(1);
    if (turns[0]?.kind === "text") expect(turns[0].text.toLowerCase()).toContain("email");
  });

  it("reports honestly, rather than falsely confirming, when the enquiry can't be submitted", async () => {
    // No SUPABASE_SERVICE_ROLE_KEY in this test environment (see the file
    // header comment), so runSubmitEnquiry fails closed the same way
    // enqueueRenderJob does — this asserts that failure surfaces to the
    // customer rather than a phony "done" reply going out regardless.
    const state: SessionState = {
      ...fresh(),
      transcript: [{ role: "assistant", content: "already greeted" }],
      flow: { awaiting: "quote" },
      pendingQuote: { productIds: [REAL_ID] },
    };
    const { session, turns } = await handleInboundMessage(state, SESSION_KEY, TEST_PHONE, {
      kind: "text",
      text: "Jamie Lee, jamie@lee.com",
    });
    expect(session.flow.awaiting).toBeUndefined();
    expect(session.pendingQuote).toBeNull();
    expect(turns).toHaveLength(1);
    expect(turns[0]?.kind).toBe("text");
    if (turns[0]?.kind === "text")
      expect(turns[0].text.toLowerCase()).toContain("didn't go through");
  });
});

describe("productTurns", () => {
  it("turns a real product id into an image turn with name, price and link", () => {
    const product = CATALOG_FULL[REAL_ID]!;
    const turns = productTurns([REAL_ID]);
    expect(turns).toHaveLength(1);
    const turn = turns[0]!;
    expect(turn.kind).toBe("product");
    if (turn.kind === "product") {
      expect(turn.imageUrl).toBe(product.images[0]);
      expect(turn.caption).toContain(product.name);
      expect(turn.caption).toContain(product.url);
    }
  });

  it("drops an id that doesn't resolve against the real catalog", () => {
    expect(productTurns(["not-a-real-id"])).toHaveLength(0);
  });

  it("drops a real product that has no photo rather than sending a broken image", () => {
    const noPhotoId = Object.keys(CATALOG_FULL).find((id) => CATALOG_FULL[id]!.images.length === 0);
    if (noPhotoId) expect(productTurns([noPhotoId])).toHaveLength(0);
  });

  it("preserves order and handles several ids", () => {
    const ids = Object.keys(CATALOG_FULL)
      .filter((id) => CATALOG_FULL[id]!.images.length > 0)
      .slice(0, 3);
    const turns = productTurns(ids);
    expect(turns).toHaveLength(ids.length);
    turns.forEach((turn, i) => {
      if (turn.kind === "product") expect(turn.imageUrl).toBe(CATALOG_FULL[ids[i]!]!.images[0]);
    });
  });
});

describe("proactiveOfferTurn", () => {
  it("offers a staged_room button carrying every id shown", () => {
    const turn = proactiveOfferTurn([REAL_ID, "another-id"]);
    expect(turn?.kind).toBe("buttons");
    if (turn?.kind === "buttons") {
      expect(turn.action.buttons).toHaveLength(1);
      expect(turn.action.buttons[0]?.id).toBe(`offer:staged_room:${REAL_ID},another-id`);
      // WhatsApp's own 20-char button-title cap — a title over this silently
      // gets truncated by WhatsApp itself, a real bug a customer flagged
      // ("See this in your space" was 22 chars).
      expect(turn.action.buttons[0]?.title.length).toBeLessThanOrEqual(20);
    }
  });

  it("offers nothing when there is nothing to point the button at", () => {
    expect(proactiveOfferTurn([])).toBeNull();
  });
});
