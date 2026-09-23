import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleConversation, type ConversationServices } from "@/lib/wa-conversation.server";
import { handleRequestInbound, requestOverview } from "@/lib/wa-requests.server";
import {
  confirmationTurns,
  faqAnswer,
  faqMenu,
  groundedFields,
  type RequestRecord,
} from "@/lib/wa-requests";
import { budgetCurrency } from "@/lib/wa-currency";
import { EMPTY_SESSION, type SessionState } from "@/lib/wa-session";
import { conversationMemory } from "@/lib/wa-conversation-state";
import type { ShoppingModel } from "@/lib/wa-shopping.server";
import type { InboundEvent, WaTurn } from "@/lib/wa-runtime";
import { memoryRequestStore } from "./helpers/request-store";

// Regression coverage for the Comfortel chatbot bug sheet (bugs 1-8). The
// advisor is scripted here: each test states the decision the model is
// expected to make, and asserts what the application then does with it.
// Nothing reaches Anthropic, WhatsApp or the database.
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get() {
        throw new Error("Regression tests cannot access the database");
      },
    },
  ),
}));

type Decision = Record<string, unknown> & { tool?: string };
const QUOTE = "request:sales:quote:330334:2:CQ-ABCDEF1234";

function harness(initial: Partial<SessionState> = {}) {
  const db = memoryRequestStore();
  const script = new Map<string, Decision[]>();
  const contexts: Record<string, unknown>[] = [];
  const model = vi.fn<ShoppingModel>(async (messages, context) => {
    const customer = [...messages]
      .reverse()
      .find((m) => m.role === "user" && typeof m.content === "string")!.content as string;
    contexts.push(JSON.parse(context.split("\nFINAL TURN")[0]!));
    const next = script.get(customer)?.shift();
    if (!next) throw new Error(`Unscripted advisor call: ${customer}`);
    const { tool = "finish", ...input } = next;
    return [{ type: "tool_use", id: `call-${contexts.length}`, name: tool, input }];
  });
  const services: ConversationServices = {
    model,
    requestContext: async (_key, reference) =>
      (db.rows.find((r) => r.reference === reference) as unknown as RequestRecord) ?? null,
    overview: (key) => requestOverview(key, db),
    request: (input) => handleRequestInbound(input, db),
    runtime: vi.fn(async (s) => ({
      session: s,
      turns: [{ kind: "text" as const, text: "Main menu" }],
    })),
    render: vi.fn(async (s) => ({
      session: s,
      turns: [{ kind: "text" as const, text: "Confirm first" }],
    })),
    document: vi.fn(async () => null),
    history: vi.fn(async () => null),
  };
  let session: SessionState = { ...structuredClone(EMPTY_SESSION), ...initial };
  let serial = 0;
  const send = async (event: InboundEvent) => {
    const out = await handleConversation(
      { sessionKey: "wa:qa", phone: "15550000000", waMessageId: `m-${++serial}`, event },
      session,
      services,
    );
    session = out.session;
    return out.turns;
  };
  return {
    db,
    model,
    contexts,
    get session() {
      return session;
    },
    decide: (text: string, ...decisions: Decision[]) => script.set(text, decisions),
    say: (text: string) => send({ kind: "text", text }),
    tap: (id: string) => send({ kind: "button", id }),
    drafts: () => db.rows.filter((r) => r.status === "draft"),
  };
}
const body = (turns: WaTurn[]) =>
  turns.map((t) => ("text" in t ? t.text : "caption" in t ? t.caption : "")).join("\n");
const buttons = (turns: WaTurn[]) =>
  turns.flatMap((t) =>
    t.kind === "buttons" ? t.action.buttons : t.kind === "list" ? t.action.rows : [],
  );

beforeEach(() => vi.stubEnv("WHATSAPP_PHONE_ENC_KEY", "test-only-key"));

describe("Loom sales continuity: four focused chats", () => {
  it("1. saves a budget-only enquiry and asks a focused product question", async () => {
    const h = harness();
    await h.tap("request:sales");
    h.decide("My budget is $500", { action: "request_start", category: "sales", text: "Thanks" });
    const reply = await h.say("My budget is $500");
    expect(body(reply)).toContain("Which products");
    expect(body(reply)).not.toContain("Happy to help");
    expect(buttons(reply)).toHaveLength(0);
    h.decide("chairs", {
      action: "request_details",
      text: "How many chairs do you need?",
      readyToReview: false,
      fields: { product: "chairs" },
    });
    expect(body(await h.say("chairs"))).toContain("How many chairs");
    const ref = h.drafts()[0]!.reference;
    expect(buttons(await h.tap(`request:review:${ref}`))).toHaveLength(0);
    expect(body(await h.tap(`request:submit:${ref}`))).toContain("Please add");
  });

  it("2. updates $500 to $600 without a model call for the pending amount", async () => {
    const h = harness();
    await h.tap("request:sales");
    h.decide("I want chairs on budget $500", {
      action: "request_details",
      text: "Thanks",
      fields: { product: "chairs" },
    });
    await h.say("I want chairs on budget $500");
    const ref = h.drafts()[0]!.reference;
    await h.tap(`request:edit:${ref}`);
    expect(body(await h.say("I'm ready to adjust my budget"))).toContain("new budget");
    expect(buttons(await h.tap(`request:review:${ref}`))).toHaveLength(0);
    const calls = h.model.mock.calls.length;
    const result = body(await h.say("$600"));
    expect(h.model).toHaveBeenCalledTimes(calls);
    expect(result).toContain("Budget: 600");
    expect(result).toContain("Currency: USD");
    expect(result).not.toContain("500");
    expect(JSON.stringify(h.drafts()[0]!.details)).toContain("500"); // audit history retained
    expect(h.drafts()[0]!.status).toBe("draft");
  });

  it("3. handles a legacy draft correction while preserving explicit CAD", async () => {
    const h = harness();
    await h.tap("request:sales");
    const draft = h.drafts()[0]!;
    draft.details = [{ messageId: "old", text: "I want chairs, my budget is CAD $500" }];
    await h.say("change my budget");
    const reply = body(await h.say("$600"));
    expect(reply).not.toContain("500");
    expect(body(confirmationTurns(h.drafts()[0] as unknown as RequestRecord))).not.toContain(
      "Submit request",
    );
    expect(JSON.stringify(h.drafts()[0]!.details)).toContain('"currency":"CAD"');
    h.decide("chairs", { action: "request_details", text: "Thanks", fields: { product: "chairs" } });
    const review = body(await h.say("chairs"));
    expect(review).toContain("Budget: 600");
    expect(review).not.toContain("500");
  });

  it("4. product advice asks its question without competing resume controls", async () => {
    const h = harness();
    await h.tap("request:sales");
    h.decide("Is Oakley suitable?", {
      action: "answer",
      text: "Would you like alternatives within your budget?",
    });
    const reply = await h.say("Is Oakley suitable?");
    expect(body(reply)).not.toContain("Continue it whenever");
    expect(buttons(reply)).toHaveLength(0);
    expect(h.drafts()).toHaveLength(1);
  });
});

describe("bug 1: a new intent after delivery details", () => {
  it("routes 'sales' without repeating the saved delivery address", async () => {
    const h = harness();
    await h.tap(QUOTE);
    h.decide("India, 441108", {
      action: "request_details",
      text: "Thanks",
      fields: { country: "India", postcode: "441108" },
    });
    const review = await h.say("India, 441108");
    expect(body(review)).toContain("Postcode: 441108");
    const reply = await h.say("sales");
    expect(h.model).toHaveBeenCalledTimes(1); // "sales" is a menu command, not advisor input
    expect(body(reply)).not.toContain("441108");
    expect(body(reply)).toContain("already have an unsent delivery request");
    expect(buttons(reply).map((b) => b.title)).toEqual(["Continue it", "Start new", "Main menu"]);
    // The saved details are retained, and "Continue it" brings them back once.
    const draft = h.drafts()[0]!;
    expect(JSON.stringify(draft.details)).toContain("441108");
    expect(body(await h.tap(`request:review:${draft.reference}`))).toContain("Postcode: 441108");
  });
  it("starting a new sales enquiry replaces the old draft only when chosen", async () => {
    const h = harness();
    await h.tap(QUOTE);
    const old = h.drafts()[0]!.reference;
    await h.say("sales");
    const reply = await h.tap(`request:new:sales:${old}`);
    expect(h.db.rows.find((r) => r.reference === old)?.status).toBe("cancelled");
    expect(h.drafts()).toHaveLength(1);
    expect(body(reply)).toContain("which products you're interested in");
  });
});

describe("bug 2: support details are request details, not product searches", () => {
  it("support draft -> issue details -> review -> submit", async () => {
    const h = harness();
    await h.tap("ask");
    await h.tap("request:support");
    h.decide("My Chloe chair pump leaks oil and the seat keeps sinking", {
      action: "request_details",
      text: "Customer reports a leaking pump.",
      fields: { product: "Chloe chair", issue: "pump leaks oil and the seat keeps sinking" },
    });
    const review = await h.say("My Chloe chair pump leaks oil and the seat keeps sinking");
    // The advisor saw the draft it was working on, with its missing fields.
    const request = h.contexts[0]!["workflow"] as { request: Record<string, unknown> };
    expect(request.request).toMatchObject({ customerIsWorkingOnDraft: true });
    expect(review.some((t) => t.kind === "product")).toBe(false);
    expect(body(review)).not.toContain("Customer reports"); // staff-style note never shown
    expect(body(review)).toContain("Product: Chloe chair");
    const draft = h.drafts()[0]!;
    expect(buttons(review).map((b) => b.id)).toContain(`request:submit:${draft.reference}`);
    expect(draft.status).toBe("draft"); // never submitted without confirmation
    const receipt = await h.tap(`request:submit:${draft.reference}`);
    expect(h.db.rows[0]!.status).toBe("open");
    expect(body(receipt)).toContain("support request has been received");
  });
  it("asks for the missing slot instead of treating a partial description as ready", async () => {
    const h = harness();
    await h.tap("request:support");
    h.decide("It keeps sinking", {
      action: "request_details",
      text: "Which chair?",
      fields: { issue: "keeps sinking" },
    });
    const reply = await h.say("It keeps sinking");
    expect(body(reply)).toContain("Which product is this about?");
    expect(h.drafts()[0]!.stage).toBe("details");
  });
  it("support draft -> product question -> resume support without losing the draft", async () => {
    const h = harness();
    await h.tap("request:support");
    h.decide(
      "Before that, do you have white styling chairs?",
      { tool: "find_products", query: "white styling chair" },
      { action: "answer", text: "Yes, we have white styling chairs such as the Chloe." },
    );
    const reply = await h.say("Before that, do you have white styling chairs?");
    const draft = h.drafts()[0]!;
    expect(draft.details).toEqual([]); // the question was not appended to the ticket
    expect(buttons(reply).map((b) => b.id)).toContain(`request:review:${draft.reference}`);
    expect(body(reply)).toContain("still saved and hasn't been sent");
    const resumed = await h.tap(`request:review:${draft.reference}`);
    expect(body(resumed)).toContain("support request");
    expect(h.session.conversation?.activeTask).toBe("request");
  });
  it("the advisor cannot move the conversation off an active request by patching task state", async () => {
    const h = harness();
    await h.tap("request:support");
    h.decide("What's your warranty?", {
      action: "answer",
      text: "One-year limited warranty.",
      project: { activeTask: "browse", suspendedTask: null },
    });
    await h.say("What's your warranty?");
    expect(h.session.conversation?.activeTask).toBe("request");
  });
  it("request_details without a draft opens the request instead of dropping the message", async () => {
    const h = harness();
    h.decide("My pump is leaking oil", {
      action: "request_details",
      category: "support",
      text: "What would you like our team to help with?",
      fields: { issue: "pump is leaking oil" },
    });
    const reply = await h.say("My pump is leaking oil");
    expect(h.drafts()).toHaveLength(1);
    expect(JSON.stringify(h.drafts()[0]!.details)).toContain("My pump is leaking oil");
    expect(body(reply)).toContain("Which product is this about?");
  });
});

describe("bug 3: callback intake advances on acknowledgements", () => {
  it("collects time and timezone once, then reviews and submits a callback request", async () => {
    const h = harness();
    await h.tap("request:sales");
    h.decide("I'd like to set up a call.", {
      action: "request_details",
      text: "Sure",
      fields: { contact: "call" },
    });
    const ask = await h.say("I'd like to set up a call.");
    expect(body(ask)).toContain("What day and time suit you for a call");
    const reference = h.drafts()[0]!.reference;

    for (const ack of ["please go ahead", "ok"]) {
      const reply = await h.say(ack);
      expect(body(reply)).not.toContain("I'd like to set up a call.");
      expect(body(reply)).toContain("day and time");
    }
    expect(h.model).toHaveBeenCalledTimes(1); // acknowledgements never reach the advisor
    expect(h.drafts()[0]!.details).toHaveLength(1); // and are never saved as details

    h.decide("Tuesday 3pm EST", {
      action: "request_details",
      text: "Thanks",
      fields: { preferred_time: "Tuesday 3pm", timezone: "EST" },
    });
    const review = await h.say("Tuesday 3pm EST");
    const text = body(review);
    expect(text).toContain("callback request");
    expect(text).toContain("Preferred time: Tuesday 3pm");
    expect(text).toContain("Timezone: EST");
    expect(text).toContain("Contact: this WhatsApp number");
    expect(text).toContain("Nothing is booked");
    expect(text).not.toMatch(/appointment (?:is )?(?:booked|confirmed)|call is booked/i);

    const receipt = await h.say("ok");
    expect(h.db.rows.find((r) => r.reference === reference)?.status).toBe("open");
    expect(body(receipt)).toContain("callback request has been received");
    expect(body(receipt)).toContain("time still needs to be confirmed");
    // A repeated "ok" does not open a second request.
    const again = await h.say("ok");
    expect(body(again)).toContain("already with our team");
    expect(h.db.rows).toHaveLength(1);
  });
  it("drops slot values the customer did not write", () => {
    expect(
      groundedFields({ postcode: "10001", country: "India" }, "sales", "Deliver to India please"),
    ).toEqual({ country: "India" });
  });
});

describe("bug 4: cancellation targets", () => {
  it("asks which item to cancel when an unsent enquiry exists, and cancels only after the choice", async () => {
    const h = harness();
    await h.tap(QUOTE);
    const draft = h.drafts()[0]!;
    h.decide("I want to cancel my order", {
      action: "request_cancel",
      target: "order",
      text: "Sure",
    });
    const ask = await h.say("I want to cancel my order");
    expect(body(ask)).toContain("Which would you like to cancel?");
    expect(buttons(ask).map((b) => b.title)).toEqual([
      "Cancel unsent draft",
      "Cancel placed order",
      "Keep everything",
    ]);
    expect(body(ask)).not.toContain("Submit request");
    expect(h.drafts()).toHaveLength(1); // nothing cancelled yet
    const done = await h.tap(`request:cancel:${draft.reference}`);
    expect(body(done)).toContain("Nothing was sent");
    expect(h.drafts()).toHaveLength(0);
    // Repeating the tap does not act twice or claim anything new.
    expect(body(await h.tap(`request:cancel:${draft.reference}`))).toContain("already cancelled");
  });
  it("prepares a staff cancellation request for a placed order without claiming it is cancelled", async () => {
    const h = harness();
    h.decide("Please cancel my order 12345", {
      action: "request_cancel",
      target: "order",
      text: "Done, your order is cancelled.",
      fields: { order_number: "12345" },
    });
    const review = await h.say("Please cancel my order 12345");
    const text = body(review);
    expect(text).toContain("order cancellation request");
    expect(text).toContain("Order number: 12345");
    expect(text).toContain("isn't cancelled until they confirm");
    expect(text).not.toMatch(/order (?:is|has been) cancelled/i);
    const draft = h.drafts()[0]!;
    await h.tap(`request:submit:${draft.reference}`);
    const repeat = await h.tap(`request:submit:${draft.reference}`);
    expect(body(repeat)).toContain("already sent");
    expect(h.db.rows.filter((r) => r.status === "open")).toHaveLength(1);
  });
  it("asks for the order number when a placed-order cancellation has none", async () => {
    const h = harness();
    h.decide("cancel my order", { action: "request_cancel", target: "order", text: "Ok" });
    const reply = await h.say("cancel my order");
    expect(body(reply)).toContain("What's your order number?");
    h.decide("cancel my order", { action: "request_cancel", target: "order", text: "Ok" });
    await h.say("cancel my order"); // repeated message: same draft, no duplicate
    expect(h.db.rows).toHaveLength(1);
  });
  it("confirms before cancelling a draft", async () => {
    const h = harness();
    await h.tap(QUOTE);
    h.decide("cancel this enquiry", { action: "request_cancel", target: "draft", text: "Ok" });
    const ask = await h.say("cancel this enquiry");
    expect(body(ask)).toContain("Nothing has been sent to our team yet");
    expect(buttons(ask).map((b) => b.title)).toEqual(["Yes, cancel it", "Keep it"]);
    expect(h.drafts()).toHaveLength(1);
  });
  it("asks staff to cancel a submitted request once, and reports that it is still open", async () => {
    const h = harness();
    await h.tap(QUOTE);
    h.decide("10001, USA", {
      action: "request_details",
      text: "Thanks",
      fields: { postcode: "10001", country: "USA" },
    });
    await h.say("10001, USA");
    const reference = h.drafts()[0]!.reference;
    await h.tap(`request:submit:${reference}`);
    h.decide("please cancel the request I sent", {
      action: "request_cancel",
      target: "submitted",
      text: "Ok",
    });
    const offer = await h.say("please cancel the request I sent");
    expect(buttons(offer).map((b) => b.id)).toContain(`request:withdraw:${reference}`);
    const first = await h.tap(`request:withdraw:${reference}`);
    expect(body(first)).toContain("isn't cancelled until they confirm");
    const second = await h.tap(`request:withdraw:${reference}`);
    expect(body(second)).toContain("already asked");
    const row = h.db.rows.find((r) => r.reference === reference)!;
    expect(row.status).toBe("open");
    expect(
      (row.details as unknown[]).filter((d) => JSON.stringify(d).includes("cancel this request")),
    ).toHaveLength(1);
  });
});

describe("bug 5: complaint intake is separate from a sales draft", () => {
  it("starts a complaint without delivery requirements and keeps the sales draft", async () => {
    const h = harness();
    await h.tap(QUOTE);
    const sales = h.drafts()[0]!.reference;
    const prompt = await h.tap("request:complaint");
    expect(body(prompt)).toContain("What went wrong");
    expect(body(prompt)).not.toMatch(/postcode|delivery (?:details|address)|country/i);
    expect(body(prompt)).toContain("delivery request is saved separately");
    expect(
      h
        .drafts()
        .map((d) => d.category)
        .sort(),
    ).toEqual(["complaint", "sales"]);
    h.decide("The mirror arrived with a cracked frame", {
      action: "request_details",
      text: "Sorry",
      fields: { issue: "mirror arrived with a cracked frame" },
    });
    const review = await h.say("The mirror arrived with a cracked frame");
    expect(body(review)).toContain("*Your complaint*");
    expect(body(review)).not.toMatch(/Estimate|postcode/i);
    const complaint = h.drafts().find((d) => d.category === "complaint")!.reference;
    const receipt = await h.tap(`request:submit:${complaint}`);
    expect(body(receipt)).toContain("complaint has been received");
    expect(buttons(receipt).map((b) => b.id)).toContain(`request:review:${sales}`);
    const kept = h.db.rows.find((r) => r.reference === sales)!;
    expect(kept.status).toBe("draft");
    expect(JSON.stringify(kept.details)).toContain("CQ-ABCDEF1234");
    expect(JSON.stringify(kept.details)).not.toContain("cracked");
  });
});

describe("bug 6: FAQ topics", () => {
  const now = Date.parse("2026-09-23T00:00:00Z");
  it("lists the six topics as selectable rows", async () => {
    const h = harness();
    const turns = await h.tap("request:faq");
    expect(turns[0]!.kind).toBe("list");
    expect(buttons(turns).map((r) => r.title)).toEqual([
      "Delivery",
      "Returns",
      "Warranty",
      "Payments",
      "Financing",
      "Showroom visits",
    ]);
    expect(buttons([faqMenu()]).every((r) => r.title.length <= 24)).toBe(true);
  });
  it.each([
    ["delivery", "10–15 business days", null],
    ["returns", "return authorization number", "request:order"],
    ["warranty", "one-year limited warranty", "request:support"],
    ["payments", "Prices are in US dollars", "request:order"],
    ["financing", "Beneficial Capital", null],
    ["showrooms", "Carlstadt, NJ", "request:sales"],
  ])("%s opens its verified answer with Back to FAQs", (topic, fact, action) => {
    const turns = faqAnswer(topic, now)!;
    expect(body(turns)).toContain(fact);
    expect(body(turns)).toContain("comfortelfurniture.com");
    const ids = buttons(turns).map((b) => b.id);
    expect(ids[0]).toBe("request:faq");
    if (action) expect(ids).toContain(action);
    expect(buttons(turns).every((b) => b.title.length <= 20)).toBe(true);
  });
  it("defers to the team once the policy snapshot expires instead of stating old terms", () => {
    const turns = faqAnswer("financing", Date.parse("2027-01-01"))!;
    expect(body(turns)).not.toContain("Beneficial Capital");
    expect(body(turns)).toContain("contact-us");
  });
  it("topic taps work while a draft is open and never touch it", async () => {
    const h = harness();
    await h.tap(QUOTE);
    const before = JSON.stringify(h.drafts());
    const answer = await h.tap("request:faq:warranty");
    expect(body(answer)).toContain("warranty");
    const back = await h.tap("request:faq");
    expect(back[0]!.kind).toBe("list");
    expect(JSON.stringify(h.drafts())).toBe(before);
  });
});

describe("bug 7: delivery confirmation layout", () => {
  const request: RequestRecord = {
    reference: "CF-0123456789ABCDEF",
    session_key: "wa:qa",
    category: "sales",
    status: "draft",
    stage: "confirm",
    details: [
      {
        messageId: "q",
        text: "Please confirm a final quote for estimate CQ-ABCDEF1234:\n2 x Chloe (SKU 1)",
      },
      {
        messageId: "a",
        text: "Priya Shah, 12 Main Road Nagpur India 441108",
        fields: {
          recipient: "Priya Shah",
          address: "12 Main Road Nagpur",
          country: "India",
          postcode: "441108",
        },
      },
    ],
  };
  it("shows short labelled lines once, with the next action", () => {
    const turns = confirmationTurns(request);
    const text = body(turns);
    for (const line of [
      "Estimate: CQ-ABCDEF1234",
      "2 x Chloe (SKU 1)",
      "Recipient: Priya Shah",
      "Address: 12 Main Road Nagpur",
      "Postcode: 441108",
      "Country: India",
    ])
      expect(text.split("\n")).toContain(line);
    expect(text).toContain("\n\nNext: tap Submit request");
    expect(text.match(/441108/g)).toHaveLength(1);
    expect(turns.every((t) => t.kind !== "buttons" || t.text.length <= 1024)).toBe(true);
  });
  it("omits empty fields", () => {
    const text = body(
      confirmationTurns({
        ...request,
        details: [
          request.details[0]!,
          { messageId: "b", text: "10001, USA", fields: { postcode: "10001", country: "USA" } },
        ],
      }),
    );
    expect(text).not.toContain("Recipient:");
    expect(text).not.toContain("Address:");
    expect(text).toContain("Postcode: 10001");
  });
  it("starts the delivery request with a short checklist, not a paragraph", async () => {
    const h = harness();
    const turns = await h.tap(QUOTE);
    expect(body(turns)).toContain("Please send:\n• Delivery postcode and country");
  });
});

describe("bug 8: bare $ budgets default to USD", () => {
  const planInput = {
    tool: "plan_salon",
    stations: 4,
    budget: 35000,
    currency: "USD",
    scope: "equipment",
    mirror_layout: "wall",
    service_focus: "hair_styling",
  };
  const planMessage = "Plan 4 stations for $35,000, wall mirrors, mainly hair styling";
  it("plans immediately and labels the amount as USD in the reply", async () => {
    const h = harness();
    h.decide(planMessage, planInput);
    const turns = await h.say(planMessage);
    expect(body(turns)).toContain("Here’s your draft plan for $35,000 (USD)");
    expect(body(turns)).not.toMatch(/confirm.{0,40}USD|another currency/i);
    expect(h.session.conversation?.currency).toBe("USD");
    expect(h.session.plan.ids.length).toBeGreaterThan(0);
  });
  it("rejects a USD confirmation question or currency disclaimer and plans instead", async () => {
    const h = harness();
    h.decide(
      planMessage,
      { action: "answer", text: "Great! Just to confirm, is your $35,000 budget in USD?" },
      planInput,
    );
    const turns = await h.say(planMessage);
    expect(h.model).toHaveBeenCalledTimes(2);
    expect(body(turns)).toContain("(USD)");
    expect(body(turns)).not.toContain("Just to confirm");
  });
  it("keeps an earlier explicit currency when a later amount has a bare $", async () => {
    const h = harness({ conversation: conversationMemory({ currency: "CAD", stations: 4 }) });
    h.decide("Make it $40,000", planInput, {
      action: "answer",
      text: "Our catalog is priced in USD only. What is your equipment budget in USD?",
    });
    const turns = await h.say("Make it $40,000");
    expect(h.session.conversation?.currency).toBe("CAD");
    expect(h.session.plan.ids).toEqual([]);
    const toolError = JSON.stringify(h.model.mock.calls[1]![0]);
    expect(toolError).toContain("CAD");
    expect(toolError).toContain("no currency conversion");
    expect(body(turns)).toContain("USD only");
  });
  it.each(["4 stations, budget 40,000 CAD", "4 stations for C$40,000", "4 stations, 40k AUD"])(
    "never relabels an explicit non-US budget (%s) as USD",
    async (message) => {
      const h = harness();
      h.decide(
        message,
        { ...planInput, budget: 40000 },
        {
          action: "answer",
          text: "Our prices are in USD only. What is your equipment budget in USD?",
          project: { currency: "USD", budget: 40000 },
        },
      );
      await h.say(message);
      expect(h.session.conversation?.currency).not.toBe("USD");
      expect(h.session.plan.ids).toEqual([]);
    },
  );
  it("applies a later currency correction", async () => {
    const h = harness({
      conversation: conversationMemory({ currency: "CAD", stations: 4, budget: 35000 }),
    });
    h.decide("Sorry, I meant US dollars", planInput);
    const turns = await h.say("Sorry, I meant US dollars");
    expect(h.session.conversation?.currency).toBe("USD");
    expect(body(turns)).toContain("$35,000 (USD)");
  });
  it("keeps a per-item price separate from the total budget", async () => {
    const h = harness();
    h.decide("Chairs under $800 each, total budget $35,000", {
      action: "answer",
      text: "Got it. How many stations do you need?",
      memory: { maxUnitPrice: 800 },
      project: { budget: 35000, budgetScope: "equipment" },
    });
    await h.say("Chairs under $800 each, total budget $35,000");
    expect(h.session.shoppingMemory?.maxUnitPrice).toBe(800);
    expect(h.session.conversation).toMatchObject({ budget: 35000, currency: "USD" });
  });
  it.each([
    ["$35,000 for 4 stations", { currency: "USD", explicit: false }],
    ["35k dollars", { currency: "USD", explicit: false }],
    ["USD 20000", { currency: "USD", explicit: true }],
    ["US$20,000", { currency: "USD", explicit: true }],
    ["C$40k", { currency: "CAD", explicit: true }],
    ["A$40k", { currency: "AUD", explicit: true }],
    ["£20k", { currency: "GBP", explicit: true }],
    ["€20.000", { currency: "EUR", explicit: true }],
    ["₹5,00,000", { currency: "other", explicit: true }],
    ["We're a Canadian salon, $30k", { currency: "USD", explicit: false }],
    ["budget 35000", null],
  ])("reads %s", (text, expected) => expect(budgetCurrency(text)).toEqual(expected));
});

describe("deploy order: before the per-category draft migration", () => {
  it("explains the unsent draft instead of failing when the old one-draft index rejects a second draft", async () => {
    const db = memoryRequestStore();
    const create = db.create;
    db.create = async (row) => {
      if (db.rows.some((r) => r.session_key === row.session_key && r.status === "draft"))
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      return create(row);
    };
    const input = { sessionKey: "wa:qa", phone: "15550000000" };
    await handleRequestInbound(
      { ...input, waMessageId: "a", event: { kind: "button", id: QUOTE } },
      db,
    );
    const reply = await handleRequestInbound(
      { ...input, waMessageId: "b", event: { kind: "button", id: "request:complaint" } },
      db,
    );
    expect(body(reply!)).toContain("Please submit or cancel it before starting a complaint");
    expect(db.rows).toHaveLength(1);
  });
});
