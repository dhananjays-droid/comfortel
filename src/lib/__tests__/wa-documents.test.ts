import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SESSION } from "@/lib/wa-session";
import { handleDocumentInbound } from "@/lib/wa-documents.server";
import { sendDocument } from "@/lib/wa-client.server";

vi.mock("@/lib/commerce-pdf.server", () => ({
  buildCommercePdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const fresh = () => structuredClone(EMPTY_SESSION);

describe("WhatsApp PDF journey", () => {
  it.each([
    "Hi",
    "Replace both black chairs with white",
    "My chair is broken",
    "Where is my order?",
  ])("does not intercept %s", async (text) => {
    expect(await handleDocumentInbound(fresh(), { kind: "text", text }, "message")).toBeNull();
  });
  it("creates a plan PDF with quantities and a bounded final-quote button", async () => {
    const session = fresh();
    session.plan = { ids: ["330334", "330283"], qty: { 330334: 4, 330283: 2 } };
    const snapshot = structuredClone(session);
    const turns = await handleDocumentInbound(
      session,
      { kind: "text", text: "PDF quote" },
      "message",
    );
    expect(turns?.[0]?.kind).toBe("document");
    const follow = turns?.[1];
    expect(follow?.kind).toBe("buttons");
    if (follow?.kind === "buttons") {
      expect(follow.text).toBe("Would you like our team to confirm delivery?");
      expect(follow.action.buttons[0]!.id).toContain(":4,2:");
      expect(follow.action.buttons[0]!.id.length).toBeLessThanOrEqual(256);
      expect(follow.action.buttons[0]!.title.length).toBeLessThanOrEqual(20);
    }
    expect(session).toEqual(snapshot);
  });
  it("creates a comparison for exactly the named variants", async () => {
    const turns = await handleDocumentInbound(
      fresh(),
      { kind: "text", text: "Compare Chloe Tan and Blake Textured Black" },
      "message",
    );
    expect(turns?.[0]?.kind).toBe("document");
  });
  it("lets complaints containing comparison words reach support", async () => {
    expect(
      await handleDocumentInbound(
        fresh(),
        { kind: "text", text: "My chair arrived damaged, compare it to the product photo" },
        "message",
      ),
    ).toBeNull();
  });
  it("uses rendered quantities instead of an unrelated saved plan", async () => {
    const session = fresh();
    session.plan = { ids: ["330334"], qty: { 330334: 8 } };
    const turns = await handleDocumentInbound(
      session,
      { kind: "button", id: "docs:quote:330334:2" },
      "message",
    );
    const follow = turns?.[1];
    if (follow?.kind !== "buttons") throw new Error("Missing follow-up");
    expect(follow.action.buttons[0]!.id).toContain(":330334:2:");
  });
  it("does not substitute the current plan for an unrecognised selection", async () => {
    const session = fresh();
    session.plan = { ids: ["330334"], qty: { 330334: 4 } };
    const turns = await handleDocumentInbound(
      session,
      { kind: "text", text: "PDF quote for nonexistent chair" },
      "message",
    );
    expect(turns?.[0]?.kind).toBe("text");
  });
  it("asks for products when no saved plan exists", async () => {
    const turns = await handleDocumentInbound(
      fresh(),
      { kind: "text", text: "PDF quote" },
      "message",
    );
    expect(turns?.[0]?.kind).toBe("text");
  });
  it("rejects more than three comparison products", async () => {
    const turns = await handleDocumentInbound(
      fresh(),
      { kind: "button", id: "docs:compare:330334,330283,330276,343609" },
      "message",
    );
    expect(turns?.[0]?.kind).toBe("text");
  });
});

describe("WhatsApp document transport", () => {
  it("uploads private PDF bytes then sends a media-id document", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "test-token");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "test-id");
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "media-id" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: "wamid.pdf" }] })));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await sendDocument(
        "15551234567",
        new Uint8Array([37, 80, 68, 70]),
        "estimate.pdf",
        "Your estimate",
      ),
    ).toBe("wamid.pdf");
    expect(fetcher.mock.calls[0]![0]).toMatch(/\/media$/);
    expect(fetcher.mock.calls[0]![1].body).toBeInstanceOf(FormData);
    expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toMatchObject({
      type: "document",
      document: { id: "media-id", filename: "estimate.pdf", caption: "Your estimate" },
    });
  });
  it("does not send a document after a failed media upload", async () => {
    vi.stubEnv("WHATSAPP_ACCESS_TOKEN", "test-token");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "test-id");
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      sendDocument("15551234567", new Uint8Array([1]), "estimate.pdf", "caption"),
    ).rejects.toThrow("upload failed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
