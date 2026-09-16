import { describe, expect, it, vi } from "vitest";
import {
  handleShoppingInbound,
  findShoppingProducts,
  type ShoppingModel,
} from "@/lib/wa-shopping.server";
import { EMPTY_SESSION, sanitizeSession } from "@/lib/wa-session";
import { CATALOG_FULL } from "@/lib/catalog";
import { shoppingEligible } from "@/lib/wa-shopping-routing";

vi.mock("@/lib/commerce-pdf.server", () => ({
  buildCommercePdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
}));
const fresh = () => structuredClone(EMPTY_SESSION);
const finish = (input: unknown): ShoppingModel =>
  vi.fn(async () => [{ type: "tool_use", name: "finish", id: "f", input }]);
const id = "330334";
const other = "330283";
const text = (text: string) => ({ kind: "text" as const, text });

describe("shopping conversation tool boundary", () => {
  it("rejects an accessory card for a mirror request even when remembered from history", async () => {
    const s = fresh();
    s.shownProductIds = ["301087", "8221"];
    const model: ShoppingModel = vi.fn()
      .mockResolvedValueOnce([{ type: "tool_use", name: "finish", id: "bad", input: {
        action: "show", text: "Here is a mirror shelf.", lines: [{ id: "301087", qty: 1 }],
      } }])
      .mockResolvedValueOnce([{ type: "tool_use", name: "finish", id: "good", input: {
        action: "show", text: "Here is a complete mirror.", lines: [{ id: "8221", qty: 1 }],
      } }]);
    const turns = await handleShoppingInbound(s, text("I want to buy a mirror for my salon"), "purpose-test", model);
    expect(model).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(turns)).not.toContain("Here is a mirror shelf");
    expect(s.shownProductIds).toEqual(["8221"]);
  });
  it("shortlist buttons use the remembered quantity and are safe to replay", async () => {
    const s = fresh();
    s.shownProductIds = [id];
    s.shoppingMemory = { quantity: 5 };
    const turns = await handleShoppingInbound(
      s,
      text("show chairs"),
      "1",
      finish({ action: "show", text: "Here is that chair.", lines: [{ id, qty: 5 }] }),
    );
    const last = turns?.at(-1);
    if (last?.kind !== "buttons") throw new Error("Missing selection buttons");
    const event = { kind: "button" as const, id: last.action.buttons[0]!.id };
    const model = finish({});
    await handleShoppingInbound(s, event, "2", model);
    await handleShoppingInbound(s, event, "3", model);
    expect(s.plan.qty[id]).toBe(5);
    expect(s.plan.ids).toEqual([id]);
    expect(model).not.toHaveBeenCalled();
    s.shoppingMemory.quantity = 3;
    await handleShoppingInbound(s, event, "4", model);
    expect(s.plan.qty[id]).toBe(5);
  });
  it.each([
    "stop",
    "menu",
    "request status",
    "my chair is broken",
    "where is my order?",
    "generate an image in my salon",
    "?",
    "is it ready?",
  ])("preserves existing handling for %s", (message) => {
    expect(shoppingEligible(fresh(), text(message))).toBe(false);
  });
  it("does not steal an active form or render confirmation", () => {
    const s = fresh();
    s.flow = { awaiting: "quote" };
    expect(shoppingEligible(s, text("Jamie"))).toBe(false);
  });
  it("routes shopping questions and natural quantity corrections", () => {
    for (const message of [
      "I want five",
      "What is the warranty?",
      "Actually make that three",
      "Send me a PDF estimate",
    ])
      expect(shoppingEligible(fresh(), text(message))).toBe(true);
  });
  it("asks rather than creating a selection for an ambiguous quantity, and preserves the quantity preference", async () => {
    const s = fresh();
    const turns = await handleShoppingInbound(
      s,
      text("I want five"),
      "1",
      finish({ action: "answer", text: "Five of which product?", memory: { quantity: 5 } }),
    );
    expect(s.plan.ids).toEqual([]);
    expect(s.shoppingMemory?.quantity).toBe(5);
    expect(turns?.[0]).toEqual({ kind: "text", text: "Five of which product?" });
  });
  it("retrieves products before selecting and exposes tool results to the model", async () => {
    const s = fresh();
    const model = vi
      .fn<ShoppingModel>()
      .mockResolvedValueOnce([
        { type: "tool_use", id: "lookup", name: "find_products", input: { query: "", ids: [id] } },
      ])
      .mockResolvedValueOnce([
        {
          type: "tool_use",
          id: "final",
          name: "finish",
          input: { action: "select", text: "Selected", lines: [{ id, qty: 5 }] },
        },
      ]);
    const turns = await handleShoppingInbound(
      s,
      text(`Five ${CATALOG_FULL[id]!.name}`),
      "1",
      model,
    );
    expect(s.plan.qty[id]).toBe(5);
    expect(JSON.stringify(model.mock.calls[1]?.[0])).toContain("tool_result");
    expect(turns?.[0]?.kind).toBe("buttons");
  });
  it("preserves the selection during an interruption then corrects a quantity and produces a PDF", async () => {
    let s = fresh();
    s.plan = { ids: [id, other], qty: { [id]: 5, [other]: 2 } };
    await handleShoppingInbound(
      s,
      text("What is the warranty?"),
      "1",
      finish({
        action: "answer",
        text: "Coverage depends on the published terms. Shall we continue your estimate?",
      }),
    );
    expect(s.plan.qty[id]).toBe(5);
    // Represents a separate webhook load: memory/selection survive sanitizing.
    s = sanitizeSession(s);
    await handleShoppingInbound(
      s,
      text("Actually make the first one three"),
      "2",
      finish({
        action: "select",
        text: "Updated",
        lines: [
          { id, qty: 3 },
          { id: other, qty: 2 },
        ],
      }),
    );
    const turns = await handleShoppingInbound(
      s,
      { kind: "button", id: "shop:quote" },
      "3",
      finish({}),
    );
    expect(turns?.[0]?.kind).toBe("document");
    expect(s.lastDocument?.qty).toEqual({ [id]: 3, [other]: 2 });
  });
  it.each(["delegate", "answer"])(
    "%s never executes model-supplied selection lines",
    async (action) => {
      const s = fresh();
      s.shownProductIds = [id];
      await handleShoppingInbound(
        s,
        text("Hello"),
        "1",
        finish({ action, text: "Hello", lines: [{ id, qty: 9 }] }),
      );
      expect(s.plan.ids).toEqual([]);
    },
  );
  it.each([0, -1, 1.5, 100])("rejects invalid quantity %s without mutation", async (qty) => {
    const s = fresh();
    s.shownProductIds = [id];
    const before = structuredClone(s);
    await handleShoppingInbound(
      s,
      text("change quantity"),
      "1",
      finish({ action: "select", text: "Updated", lines: [{ id, qty }] }),
    );
    expect(s).toEqual(before);
  });
  it.each(["not-real", other])("rejects invented or unobserved product %s", async (unknownId) => {
    const s = fresh();
    s.shownProductIds = [id];
    await handleShoppingInbound(
      s,
      text("that one"),
      "1",
      finish({ action: "select", text: "Done", lines: [{ id: unknownId, qty: 2 }] }),
    );
    expect(s.plan.ids).toEqual([]);
  });
  it("bounds provider calls and leaves state unchanged when tools loop", async () => {
    const s = fresh();
    const before = structuredClone(s);
    const model = vi.fn<ShoppingModel>(async () => [
      { type: "tool_use", id: "q", name: "find_products", input: { query: "chair" } },
    ]);
    await handleShoppingInbound(s, text("chairs"), "1", model);
    expect(model).toHaveBeenCalledTimes(3);
    expect(s).toEqual(before);
  });
  it("does not apply changes on a provider failure", async () => {
    const s = fresh();
    const before = structuredClone(s);
    const turns = await handleShoppingInbound(s, text("chairs"), "1", async () => {
      throw new Error("timeout");
    });
    expect(s).toEqual(before);
    expect(turns?.[0]?.kind).toBe("buttons");
  });
  it("delegates existing render buttons without a model call", async () => {
    const model = finish({});
    expect(
      await handleShoppingInbound(
        fresh(),
        { kind: "button", id: "render:start:existing" },
        "1",
        model,
      ),
    ).toBeNull();
    expect(model).not.toHaveBeenCalled();
  });
  it("clears the draft and invalidates any old render proposal without generating", async () => {
    const s = fresh();
    s.plan = { ids: [id], qty: { [id]: 2 } };
    s.shoppingMemory = { quantity: 2 };
    await handleShoppingInbound(s, { kind: "button", id: "shop:clear" }, "1", finish({}));
    expect(s.plan.ids).toEqual([]);
    expect(s.shoppingMemory).toEqual({});
    expect(s.pendingRender).toBeNull();
  });
  it("rejects unsupported action tools", async () => {
    const s = fresh();
    const before = structuredClone(s);
    await handleShoppingInbound(s, text("start"), "1", async () => [
      { type: "tool_use", name: "start_render", input: {} },
    ]);
    expect(s).toEqual(before);
  });
  it("persists validated preferences without treating them as product facts", () => {
    expect(
      sanitizeSession({
        ...fresh(),
        shoppingMemory: { quantity: 5, finish: "white", goal: "quote" },
      }).shoppingMemory,
    ).toEqual({ quantity: 5, finish: "white", goal: "quote" });
    expect(
      sanitizeSession({ ...fresh(), shoppingMemory: { confirmedOrder: true } }).shoppingMemory,
    ).toEqual({});
  });
  it("filters by actual budget and never substitutes unrelated products", () => {
    expect(findShoppingProducts({ query: "nonexistent-product-zzy" })).toEqual([]);
    expect(
      findShoppingProducts({ query: "chair", max_price: 500 }).every(
        (p) => p.price !== null && p.price <= 500,
      ),
    ).toBe(true);
  });
});
