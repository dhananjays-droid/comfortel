import { describe, expect, it, vi } from "vitest";
import { handleConversation, type ConversationServices } from "@/lib/wa-conversation.server";
import { EMPTY_SESSION, sanitizeSession } from "@/lib/wa-session";
import { conversationMemory } from "@/lib/wa-conversation-state";
import { salonPlans, recommendProducts } from "@/lib/wa-advisor-tools";
import { confirmationTurn } from "@/lib/wa-requests";
import { handleShoppingInbound, type ShoppingModel } from "@/lib/wa-shopping.server";

vi.mock("@/lib/commerce-pdf.server", () => ({
  buildCommercePdf: async () => new Uint8Array([37, 80, 68, 70]),
}));
const finish = (input: unknown): ShoppingModel =>
  vi.fn(async () => [{ type: "tool_use", name: "finish", id: "f", input }]);
const draft = {
  reference: "CF-test",
  session_key: "test",
  category: "sales" as const,
  status: "draft" as const,
  stage: "details" as const,
  details: [],
};
function setup(model: ShoppingModel = finish({ action: "answer", text: "Which product?" })) {
  const services: ConversationServices = {
    model,
    requestContext: vi.fn(async () => draft),
    request: vi.fn(async () => [{ kind: "text" as const, text: "Request details" }]),
    runtime: vi.fn(async (s) => ({ session: s, turns: [{ kind: "text" as const, text: "Menu" }] })),
    render: vi.fn(async (s) => ({
      session: s,
      turns: [{ kind: "text" as const, text: "Confirm first" }],
    })),
    document: vi.fn(async () => [{ kind: "text" as const, text: "Document" }]),
  };
  const session = structuredClone(EMPTY_SESSION);
  const send = (text: string) =>
    handleConversation(
      {
        sessionKey: "test",
        phone: "15550000000",
        waMessageId: "synthetic",
        event: { kind: "text", text },
      },
      session,
      services,
    );
  return { services, session, send };
}
describe("unified conversation owner", () => {
  it("resolves add to my plan against the last render without asking the model", async () => {
    const { session, send, services } = setup();
    session.lastRender = { resultUrl: "https://example.com/render.jpg", mode: "refit_room", productIds: ["330334"], quantities: { "330334": 5 }, at: 1 };
    await send("add to my plan");
    expect(services.runtime).toHaveBeenCalledWith(expect.anything(), "test", "15550000000", { kind: "button", id: "plan:add:330334:5" });
    expect(services.model).not.toHaveBeenCalled();
  });
  it("clears the whole shopping project before the model or pending staff intake", async () => {
    const { session, send, services } = setup();
    session.plan = { ids: ["330334"], qty: { "330334": 5 } };
    session.conversation = conversationMemory({ stations: 5, budget: 25000, activeTask: "request" });
    session.transcript = [{ role: "user", content: "I want 5 stations for 25000" }];
    session.room = { url: "https://example.com/room.jpg", at: 1 };
    const result = await send("clear");
    expect(result.session.plan.ids).toEqual([]);
    expect(result.session.conversation?.budget).toBeNull();
    expect(result.session.conversation?.stations).toBeNull();
    expect(result.session.room).toEqual(session.room);
    expect(JSON.stringify(result.session.transcript)).not.toContain("25000");
    expect(services.model).not.toHaveBeenCalled();
    expect(services.request).not.toHaveBeenCalled();
  });
  it("routes explicit support directly without an advisor call", async () => {
    const model = finish({ action: "answer", text: "unused" });
    const { services, send } = setup(model);
    await send("support request");
    expect(model).not.toHaveBeenCalled();
    expect(services.requestContext).not.toHaveBeenCalled();
    expect(services.request).toHaveBeenCalledWith(
      expect.objectContaining({ event: { kind: "button", id: "request:support" } }),
    );
  });
  it("handles thanks without an advisor call or modifying a staff request", async () => {
    const model = finish({ action: "answer", text: "unused" });
    const { services, send } = setup(model);
    await send("Thank you!");
    expect(model).not.toHaveBeenCalled();
    expect(services.request).not.toHaveBeenCalled();
  });
  it("a request draft does not consume product or policy interruptions", async () => {
    const { services, send } = setup();
    const out = await send("Before that, which mirror works for three stations?");
    expect(services.model).toHaveBeenCalledOnce();
    expect(services.request).not.toHaveBeenCalled();
    expect(services.runtime).not.toHaveBeenCalled();
    expect(out.session.transcript).toHaveLength(2);
  });
  it.each(["menu", "Hi", "hello", "hey"])(
    "%s navigates without creating an empty confirmation",
    async (text) => {
      const { services, send } = setup();
      await send(text);
      expect(services.request).not.toHaveBeenCalled();
      expect(services.runtime).toHaveBeenCalledOnce();
      expect(services.model).not.toHaveBeenCalled();
    },
  );
  it("passes original customer details, not generated prose, to requests", async () => {
    const { services, send } = setup(
      finish({ action: "request_details", text: "Fabricated staff summary" }),
    );
    await send("The chair pump leaks oil");
    expect(services.request).toHaveBeenCalledWith(
      expect.objectContaining({ event: { kind: "text", text: "The chair pump leaks oil" } }),
    );
  });
  it("does not permit a model submit action", async () => {
    const { services, send } = setup(finish({ action: "submit", text: "Submitted" }));
    await send("yes");
    expect(services.request).not.toHaveBeenCalled();
  });
  it("model render action calls only the proposal capability", async () => {
    const { services, send } = setup(finish({ action: "render", text: "Generating now" }));
    const out = await send("Show these in my room photo");
    expect(out.turns).toEqual([{ kind: "text", text: "Confirm first" }]);
    expect(services.render).toHaveBeenCalledOnce();
    expect(services.runtime).not.toHaveBeenCalled();
  });
  it("retains project requirements across session serialization and policy answers", async () => {
    const { session, send } = setup(
      finish({ action: "answer", text: "Warranty terms", project: { pendingQuestion: null } }),
    );
    session.conversation = conversationMemory({
      stations: 3,
      budget: 20000,
      currency: "USD",
      budgetScope: "equipment",
      activeTask: "plan",
    });
    const out = sanitizeSession((await send("What is the warranty?")).session);
    expect(out.conversation).toMatchObject({ stations: 3, budget: 20000, activeTask: "plan" });
  });
  it("an empty draft never contains a Submit button", () => {
    expect(confirmationTurn(draft).kind).toBe("text");
    expect(
      confirmationTurn({ ...draft, details: [{ messageId: "m", text: "I want 5" }] }).kind,
    ).toBe("text");
  });
});

describe("advisor business tools", () => {
  it("accepts a short yes only for an outstanding USD confirmation", async () => {
    const s = structuredClone(EMPTY_SESSION);
    s.conversation = conversationMemory({
      stations: 3,
      budget: 20000,
      pendingQuestion: "confirm_usd",
    });
    const model: ShoppingModel = vi.fn(async () => [
      {
        type: "tool_use",
        id: "plan",
        name: "plan_salon",
        input: { stations: 3, budget: 20000, currency: "USD", scope: "equipment" },
      },
    ]);
    await handleShoppingInbound(s, { kind: "text", text: "yes" }, "m", model, { unified: true });
    expect(s.conversation?.currency).toBe("USD");
    expect(s.plan.ids.length).toBeGreaterThan(0);
    const unknown = structuredClone(EMPTY_SESSION);
    await handleShoppingInbound(unknown, { kind: "text", text: "yes" }, "n", model, {
      unified: true,
    });
    expect(unknown.plan.ids).toEqual([]);
  });
  it("one planning call both persists and presents the draft with matching totals", async () => {
    const s = structuredClone(EMPTY_SESSION);
    const model: ShoppingModel = vi.fn(async () => [
      {
        type: "tool_use",
        id: "p",
        name: "plan_salon",
        input: { stations: 3, budget: 20000, currency: "USD", scope: "equipment" },
      },
    ]);
    const turns = await handleShoppingInbound(
      s,
      { kind: "text", text: "Plan 3 stations, equipment only, 20000 USD" },
      "m",
      model,
      { unified: true },
    );
    expect(model).toHaveBeenCalledOnce();
    expect(s.plan.ids.length).toBeGreaterThanOrEqual(5);
    expect(
      turns?.some(
        (t) => t.kind === "buttons" && t.action.buttons.some((b) => b.id === "shop:quote"),
      ),
    ).toBe(true);
    expect(s.pendingRender).toBeNull();
  });
  it("caps a longer product shortlist at three without failing the conversation", async () => {
    const s = structuredClone(EMPTY_SESSION);
    const products = recommendProducts({ query: "mirror" }).slice(0, 5);
    s.shownProductIds = products.map((p) => p.id);
    const turns = await handleShoppingInbound(
      s,
      { kind: "text", text: "show options" },
      "m",
      finish({
        action: "show",
        text: "Here are the options",
        lines: products.map((p) => ({ id: p.id, qty: 1 })),
      }),
      { unified: true },
    );
    expect(s.shownProductIds).toHaveLength(3);
    expect(turns?.filter((t) => t.kind === "product").length).toBeLessThanOrEqual(3);
  });
  it("an old shortlist cannot be used after a newer shortlist is shown", async () => {
    const s = structuredClone(EMPTY_SESSION);
    s.shownProductIds = ["330334"];
    s.shoppingMemory = { quantity: 2 };
    const model = finish({ action: "show", text: "Here it is", lines: [{ id: "330334", qty: 2 }] });
    const turns = await handleShoppingInbound(s, { kind: "text", text: "show it" }, "old", model, {
      unified: true,
    });
    const last = turns?.at(-1);
    if (last?.kind !== "buttons") throw new Error("Expected buttons");
    const oldId = last.action.buttons[0]!.id;
    await handleShoppingInbound(s, { kind: "text", text: "show again" }, "new", model, {
      unified: true,
    });
    await handleShoppingInbound(s, { kind: "button", id: oldId }, "click", model, {
      unified: true,
    });
    expect(s.plan.ids).toEqual([]);
  });
  it.each(Array.from({ length: 100 }, (_, i) => [1 + (i % 10), 5000 + Math.floor(i / 10) * 2500]))(
    "plans %i stations with %i USD using real totals",
    (stations, budget) => {
      const out = salonPlans({ stations, budget, currency: "USD", scope: "equipment" });
      expect(out.options).toHaveLength(3);
      for (const option of out.options) {
        expect(option.total).toBeCloseTo(
          option.lines.reduce((sum, l) => sum + l.price! * l.qty, 0),
          2,
        );
        expect(option.withinBudget).toBe(option.total <= budget);
        expect(option.lines.find((l) => l.role === "styling")?.qty).toBe(stations);
      }
    },
  );
  it("refuses unknown currency or whole-project budget", () => {
    expect(() =>
      salonPlans({ stations: 3, budget: 20000, currency: "AUD", scope: "equipment" }),
    ).toThrow();
    expect(() =>
      salonPlans({ stations: 3, budget: 20000, currency: "USD", scope: "whole_project" }),
    ).toThrow();
  });
  it("plural conversational search finds mirrors", () => {
    expect(
      recommendProducts({ query: "show me salon mirrors" }).some((p) => /mirror/i.test(p.name)),
    ).toBe(true);
  });
  it("repairs invalid arguments and finishes without mutating unknown products", async () => {
    const model = vi
      .fn<ShoppingModel>()
      .mockResolvedValueOnce([
        {
          type: "tool_use",
          id: "1",
          name: "finish",
          input: { action: "select", text: "done", lines: [{ id: "fake", qty: 1 }] },
        },
      ])
      .mockResolvedValueOnce([
        {
          type: "tool_use",
          id: "2",
          name: "finish",
          input: { action: "answer", text: "Which model did you mean?" },
        },
      ]);
    const s = structuredClone(EMPTY_SESSION);
    const turns = await handleShoppingInbound(s, { kind: "text", text: "that one" }, "m", model, {
      unified: true,
    });
    expect(turns).toEqual([{ kind: "text", text: "Which model did you mean?" }]);
    expect(s.plan.ids).toEqual([]);
    expect(JSON.stringify(model.mock.calls[1]?.[0])).toContain("Unknown or duplicate");
  });
});
