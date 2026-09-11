import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/integrations/supabase/types";
import { handleRequestInbound, type RequestStore } from "@/lib/wa-requests.server";
import {
  requestIntent,
  requestMenu,
  requestReceipt,
  requestStatusText,
  type RequestRecord,
} from "@/lib/wa-requests";
import { knowledgeAnswer, whatsappKnowledgeInstructions } from "@/lib/wa-knowledge";
import type { InboundEvent } from "@/lib/wa-runtime";

type Row = Database["public"]["Tables"]["wa_requests"]["Row"];
let rows: Row[];
let serial = 0;
const db: RequestStore = {
  latest: async (session) => [...rows].reverse().find((r) => r.session_key === session) ?? null,
  replay: async (session, message) =>
    rows.find((r) => r.session_key === session && r.last_inbound_id === message) ?? null,
  create: async (row) => {
    rows.push({
      status: "draft",
      stage: "details",
      details: [],
      last_inbound_id: null,
      last_reply: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...row,
    });
  },
  update: async (reference, session, patch) => {
    const row = rows.find((r) => r.reference === reference && r.session_key === session);
    if (!row) throw new Error("missing");
    Object.assign(row, patch);
  },
};
const send = (event: InboundEvent, message = `m-${++serial}`, session = "wa:test") =>
  handleRequestInbound(
    { sessionKey: session, phone: "15551234567", waMessageId: message, event },
    db,
  );
const text = (value: string, id?: string) => send({ kind: "text", text: value }, id);

beforeEach(() => {
  rows = [];
  vi.stubEnv("WHATSAPP_PHONE_ENC_KEY", "test-only-key");
});

describe("WhatsApp intent routing", () => {
  it.each([
    ["My chair arrived damaged", "support"],
    ["The pump is not lifting", "support"],
    ["I received the wrong chair", "support"],
    ["Where is my order?", "order"],
    ["Please cancel my order 123", "order"],
    ["I want a refund", "order"],
    ["I want to make a complaint", "complaint"],
    ["This is unsafe, it has sparks", "complaint"],
    ["Book a showroom visit for Friday", "sales"],
    ["Please call me", "sales"],
    ["Can I place an order?", "sales"],
    ["Talk to a person", "support"],
    ["real human", "support"],
  ])("routes %s to %s", (input, category) => expect(requestIntent(input)).toBe(category));
  it.each([
    "Show me barber chairs",
    "replace both black chairs with white",
    "I need 4 stations for $12000",
    "What is your warranty?",
    "What is the return policy?",
    "How long does delivery take?",
  ])("does not create tickets for %s", (input) => expect(requestIntent(input)).toBeNull());
  it("leaves design messages and greetings in the existing flow", async () => {
    expect(await text("Hi")).toBeNull();
    expect(await text("Replace both black chairs with white")).toBeNull();
    expect(rows).toHaveLength(0);
  });
  it("does not steal a quote contact answer as a policy question", async () => {
    expect(
      await handleRequestInbound(
        {
          sessionKey: "wa:test",
          phone: "15551234567",
          waMessageId: "quote-contact",
          salesIntakeActive: true,
          event: { kind: "text", text: "My name is Test and my email is test@example.com" },
        },
        db,
      ),
    ).toBeNull();
  });
  it("provides bounded WhatsApp menu choices", () => {
    const menu = requestMenu();
    expect(menu.kind).toBe("list");
    if (menu.kind === "list")
      expect(menu.action.rows.every((r) => r.title.length <= 24)).toBe(true);
  });
});

describe("durable request intake", () => {
  it("records a draft, details and confirmed request, with an encrypted contact", async () => {
    await text("My chair is broken");
    expect(rows[0]?.status).toBe("draft");
    expect(rows[0]?.customer_phone_enc).not.toContain("15551234567");
    const review = await text("Order 123, Chloe chair will not lift. Please arrange a repair.");
    expect(review?.[0]?.kind).toBe("buttons");
    expect(rows[0]?.stage).toBe("confirm");
    const saved = await text("yes");
    expect(rows[0]?.status).toBe("open");
    expect(JSON.stringify(saved)).toContain(rows[0]!.reference);
    expect(JSON.stringify(saved)).toContain("waiting for our support team's review");
    expect(JSON.stringify(saved)).not.toContain("admin inbox");
    expect(await text("Hi")).toBeNull();
  });
  it("stores photos as request evidence, never room renders", async () => {
    await text("support");
    const reply = await send({
      kind: "photo",
      url: "https://example.com/damage.jpg",
      caption: "Broken arm",
    });
    expect(reply?.[0]?.kind).toBe("buttons");
    expect(JSON.stringify(rows[0]?.details)).toContain("damage.jpg");
  });
  it("replays saved input without duplicating details or creating another ticket", async () => {
    const first = await text("support", "once");
    expect(await text("support", "once")).toEqual(first);
    expect(rows).toHaveLength(1);
    await text("Order unknown, pump broken", "detail-once");
    await text("Order unknown, pump broken", "detail-once");
    expect(rows[0]?.details).toHaveLength(2);
    const confirm = await text("submit request", "confirm-once");
    expect(await text("submit request", "confirm-once")).toEqual(confirm);
    expect(rows).toHaveLength(1);
  });
  it("requires review before submission", async () => {
    await text("support");
    expect(JSON.stringify(await text("submit request"))).toContain("details first");
    expect(rows[0]?.status).toBe("draft");
  });
  it("rejects stale and cross-customer submit buttons", async () => {
    await text("support");
    const reference = rows[0]!.reference;
    await text("Order 123, pump failed");
    await send({ kind: "button", id: `request:submit:${reference}` }, undefined, "wa:other");
    expect(rows[0]?.status).toBe("draft");
    expect(JSON.stringify(await send({ kind: "button", id: "request:submit:CF-OLD" }))).toContain(
      "older request",
    );
  });
  it("cancels a draft and allows shopping afterwards", async () => {
    await text("support");
    await text("cancel request");
    expect(rows[0]?.status).toBe("cancelled");
    expect(await text("Show me styling chairs")).toBeNull();
  });
  it("unsupported media does not submit or start a render", async () => {
    await text("support");
    const reply = await send({ kind: "unsupported" });
    expect(JSON.stringify(reply)).toContain("can't read voice messages or videos");
    expect(rows[0]?.status).toBe("draft");
  });
  it("does not report a saved ticket after write failure", async () => {
    await text("support");
    await text("Order unknown, broken chair");
    const brokenDb = {
      ...db,
      update: async () => {
        throw new Error("database unavailable");
      },
    };
    await expect(
      handleRequestInbound(
        {
          sessionKey: "wa:test",
          phone: "15551234567",
          waMessageId: "fail",
          event: { kind: "text", text: "submit request" },
        },
        brokenDb,
      ),
    ).rejects.toThrow("database unavailable");
    expect(rows[0]?.status).toBe("draft");
  });
  it("fails honestly when request storage is unavailable without breaking greetings", async () => {
    const brokenDb = {
      ...db,
      replay: async () => {
        throw new Error("offline");
      },
    };
    const input = {
      sessionKey: "wa:test",
      phone: "15551234567",
      waMessageId: "offline",
      event: { kind: "text" as const, text: "support" },
    };
    expect(JSON.stringify(await handleRequestInbound(input, brokenDb))).toContain(
      "couldn't open your request",
    );
    expect(
      await handleRequestInbound({ ...input, event: { kind: "text", text: "Hi" } }, brokenDb),
    ).toBeNull();
  });
});

describe("sourced WhatsApp knowledge", () => {
  const now = Date.parse("2026-09-11T00:00:00Z");
  it("answers multiple policy topics with their sources", () => {
    const answer = knowledgeAnswer("Shipping time and warranty?", now);
    expect(answer).toContain("10–15");
    expect(answer).toContain("standard one-year");
    expect(answer).toContain("/service-support/warranty/");
  });
  it("holds contradictory returns for human review", () => {
    expect(knowledgeAnswer("refund policy", now)).toContain("confirm the return window, any fees");
    expect(knowledgeAnswer("refund policy", now)).not.toContain("inconsistent");
  });
  it("expires static facts instead of silently using old policies", () => {
    expect(knowledgeAnswer("warranty", Date.parse("2027-01-01"))).toContain(
      "check the latest details",
    );
    expect(whatsappKnowledgeInstructions(Date.parse("2027-01-01"))).not.toContain("one-year");
  });
  it("does not inject the old duties-inclusive claim", () => {
    expect(whatsappKnowledgeInstructions(now)).toContain("not the earlier Common questions");
    expect(knowledgeAnswer("Canadian tariff", now)).not.toContain("final total");
  });
});

describe("customer-facing request copy", () => {
  const request: RequestRecord = {
    reference: "CF-1234567890ABCDEF",
    category: "support",
    session_key: "wa:test",
    status: "open",
    stage: "confirm",
    details: [],
  };
  it("keeps support receipts relevant and avoids delivery promises", () => {
    const receipt = requestReceipt(request);
    expect(receipt).toContain("support request has been received");
    expect(receipt).toContain(request.reference);
    expect(receipt).not.toMatch(/admin inbox|refund|appointment|shortly|reply times|notified/i);
  });
  it("retains the relevant confirmation safeguard for order and visit enquiries", () => {
    expect(requestReceipt({ ...request, category: "order" })).toContain(
      "still needs their confirmation",
    );
    expect(requestReceipt({ ...request, category: "sales" })).toContain(
      "time still needs to be confirmed",
    );
  });
  it("does not describe an open ticket as already being reviewed", () => {
    expect(requestStatusText(request)).toContain("waiting for our team's review");
    expect(requestStatusText(request)).not.toContain("internal");
    expect(requestStatusText({ ...request, status: "in_progress" })).toContain(
      "marked your request as being reviewed",
    );
  });
  it("keeps audit notes out of the model's customer-answer data", () => {
    const prompt = whatsappKnowledgeInstructions(Date.parse("2026-09-11"));
    expect(prompt).not.toContain('"reviewNote"');
    expect(prompt).not.toContain("30 days from purchase versus receipt");
    expect(prompt).not.toContain("AU footer links");
    expect(prompt).toContain("Never imply that a person has been notified");
  });
});
