import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/wa-render-jobs.server", () => ({
  getActiveRenderState: async () => ({
    count: 0,
    pending: 0,
    generating: 0,
    oldestCreatedAt: null,
  }),
}));
vi.mock("@/lib/chat.functions", () => ({
  parseChatInput: (x: unknown) => x,
  runChatTurn: async () => ({
    text: "Which products would you like in the image?",
    productIds: [],
  }),
}));
vi.mock("@/lib/commerce-pdf.server", () => ({
  buildCommercePdf: async () => new Uint8Array([1, 2]),
}));
import { handleInboundMessage } from "@/lib/wa-runtime";
import { EMPTY_SESSION, sanitizeSession } from "@/lib/wa-session";
import { requestIntent } from "@/lib/wa-requests";
import { knowledgeAnswer } from "@/lib/wa-knowledge";
import { handleDocumentInbound } from "@/lib/wa-documents.server";
import { readEditVerdict } from "@/lib/wa-edit-check.server";
import { whatsappImagePrompt } from "@/lib/wa-image-scope";
import { whatsappNeeds, enforceWhatsAppNeeds } from "@/lib/wa-package-needs";
import { buildPackages, needsFor } from "@/lib/packages";
import { localizeActions } from "@/lib/wa-language";
const fresh = () => structuredClone(EMPTY_SESSION);
const send = (state: typeof EMPTY_SESSION, text: string) =>
  handleInboundMessage(state, "qa:regression", "15550000000", { kind: "text", text });
describe("Customer audit regression acceptance", () => {
  it("keeps the budget fallback and discards stale model explanations", () => {
    const needs = needsFor(4);
    const fallback = buildPackages(8000, needs)[0]!;
    const expensive = buildPackages(40000, needs).find((pkg) => pkg.tier === "balanced")!;
    const result = enforceWhatsAppNeeds(
      { ...expensive, reasons: ["Under budget"] },
      needs,
      fallback,
      8000,
    );
    expect(result.total).toBeLessThanOrEqual(8000);
    expect(result.reasons).toEqual([]);
  });
  it("honours package exclusions and explicit wash count without deleting styling chairs", () => {
    const needs = whatsappNeeds(
      4,
      "4 styling stations with $8000 budget. Include two shampoo units. No reception desk or waiting chairs needed.",
    );
    expect(needs.find((need) => need.role === "styling")?.qty).toBe(4);
    expect(needs.find((need) => need.role === "wash")?.qty).toBe(2);
    expect(needs.some((need) => ["reception", "waiting"].includes(need.role))).toBe(false);
    const wrong = buildPackages(8000, needsFor(2))[0]!;
    const fallback = buildPackages(8000, needs)[0]!;
    const corrected = enforceWhatsAppNeeds(wrong, needs, fallback);
    expect(corrected.lines.find((line) => line.role === "styling")?.qty).toBe(4);
    expect(corrected.lines.some((line) => line.role === "reception")).toBe(false);
    expect(corrected.total).toBeCloseTo(
      corrected.lines.reduce((sum, line) => sum + line.subtotal, 0),
    );
  });
  it("translates button labels without changing their action IDs", () => {
    const turns = localizeActions(
      [
        {
          kind: "buttons",
          text: "What would help you decide?",
          action: {
            kind: "buttons",
            buttons: [{ id: "offer:auto:330334", title: "Preview in a room" }],
          },
        },
      ],
      "es",
    );
    expect(JSON.stringify(turns)).toContain("¿Qué te ayudaría a decidir?");
    expect(JSON.stringify(turns)).toContain("offer:auto:330334");
    expect(JSON.stringify(turns)).not.toContain("Preview in a room");
  });
  it("keeps four stations when two wash units are added", async () => {
    const first = await send(fresh(), "I need 4 salon stations with a total budget of $8000");
    expect(JSON.stringify(first.turns)).toContain("4 styling stations");
    const next = await send(
      first.session,
      "That must include chairs mirrors and two shampoo units",
    );
    expect(JSON.stringify(next.turns)).toContain("4 styling stations");
    expect(JSON.stringify(next.turns)).toContain("8,000");
    expect(JSON.stringify(next.turns)).toContain("two shampoo units");
    const revised = await send(next.session, "Actually 6 salon stations with $12000 budget");
    expect(JSON.stringify(revised.turns)).toContain("6 styling stations");
    expect(JSON.stringify(revised.turns)).toContain("12,000");
  });
  it("does not turn a quantified image request into budget planning", async () => {
    const result = await send(
      fresh(),
      "Show them in an example salon with two chairs and two mirrors",
    );
    expect(result.session.flow.awaiting).not.toBe("confirm_build");
    expect(result.session.pendingRender).toBeNull();
  });
  it.each([
    "Can you change the delivery address?",
    "My chair keeps sinking after 4 months",
    "I'm going to dispute the charge",
    "My client was hurt when the chair collapsed",
    "Can a manager deal with this?",
    "Delete my data and chat history",
  ])("routes action: %s", (text) => expect(requestIntent(text)).not.toBeNull());
  it.each([
    "Has the address actually been changed now?",
    "Can you guarantee matching colour batches next year?",
    "How much is Archie and do you ship to Florida?",
  ])("does not swallow compound/contextual question: %s", (text) =>
    expect(knowledgeAnswer(text)).toBeNull(),
  );
  it("persists and resends a comparison without changing the shopping plan", async () => {
    const session = fresh();
    await handleDocumentInbound(
      session,
      { kind: "text", text: "Compare Chloe Tan and Blake Textured Black" },
      "first",
    );
    expect(session.lastDocument?.ids).toHaveLength(2);
    const loaded = sanitizeSession(JSON.parse(JSON.stringify(session)));
    const turns = await handleDocumentInbound(
      loaded,
      { kind: "text", text: "Please send that comparison as a PDF" },
      "second",
    );
    expect(turns?.[0]?.kind).toBe("document");
    expect(loaded.plan.ids).toEqual([]);
  });
  it("returns canonical links without images", async () => {
    const session = fresh();
    session.shownProductIds = ["330334"];
    const result = await send(session, "link pls, no photos");
    expect(result.turns.every((turn) => turn.kind === "text")).toBe(true);
    expect(JSON.stringify(result.turns)).toContain("https://comfortelfurniture.com/");
  });
  it("updates only the requested quote quantity and remembers it for the next PDF", async () => {
    const session = fresh();
    await handleDocumentInbound(
      session,
      { kind: "text", text: "PDF quote for 4 Chloe Tan and 4 Nero Round Salon Mirror" },
      "quote",
    );
    const first = { ...session.lastDocument!.qty };
    const turns = await handleDocumentInbound(
      session,
      { kind: "text", text: "Can you change the quantity to 6 chairs?" },
      "amend",
    );
    expect(turns?.[0]?.kind).toBe("buttons");
    expect(Object.values(session.lastDocument!.qty).sort()).toEqual([4, 6]);
    expect(Object.values(first)).toEqual([4, 4]);
    const resend = await handleDocumentInbound(
      session,
      { kind: "text", text: "Send me the updated PDF quote" },
      "resend",
    );
    expect(resend?.[0]?.kind).toBe("document");
    expect(Object.values(session.lastDocument!.qty).sort()).toEqual([4, 6]);
  });
  it("does not describe a catalog PDF as an image generation", async () => {
    const turns = await handleDocumentInbound(
      fresh(),
      { kind: "text", text: "Generate a full catalog PDF" },
      "catalog",
    );
    expect(JSON.stringify(turns)).toContain("complete catalog PDF");
    expect(JSON.stringify(turns)).not.toContain("new image");
  });
  it("rejects collateral changes even when the target edit is complete", () => {
    expect(
      readEditVerdict({
        complete: true,
        preserved: false,
        targets: [{ satisfied: true }],
        issue: "Trolley also removed",
      }).editCheck,
    ).toBe("failed");
    expect(readEditVerdict({ complete: true, targets: [{ satisfied: true }] }).editCheck).toBe(
      "unavailable",
    );
  });
  it("overrides destructive full-room removal only in the WhatsApp prompt", () => {
    const original =
      "Step 1 — REMOVE: strip out the salon's existing furniture — every chair.\nStep 2 — INSTALL: selected desk.";
    const scoped = whatsappImagePrompt(original, "refit_room");
    expect(scoped).toContain("ONLY in the stated zone");
    expect(scoped).not.toContain("strip out");
    expect(whatsappImagePrompt(original, "staged_room")).toBe(original);
  });
});
