import type { InboundEvent, WaTurn } from "@/lib/wa-runtime";
import knowledge from "@/data/wa-knowledge.json";
import { budgetCurrency } from "@/lib/wa-currency";

export const REQUEST_CATEGORIES = ["sales", "support", "order", "complaint"] as const;
export type RequestCategory = (typeof REQUEST_CATEGORIES)[number];

/** Free-text slots the advisor may extract from the customer's own message.
 * Every value must appear in that message (see groundedFields); the model
 * never supplies evidence, it only labels what the customer wrote. */
export const REQUEST_TEXT_FIELDS = [
  "product",
  "quantity",
  "budget",
  "currency",
  "issue",
  "order_number",
  "purchase",
  "preferred_time",
  "timezone",
  "location",
  "recipient",
  "address",
  "postcode",
  "country",
  "phone",
  "email",
] as const;
export type RequestTextField = (typeof REQUEST_TEXT_FIELDS)[number];
export type RequestFields = Partial<Record<RequestTextField, string>> & {
  budget_pending?: boolean;
  /** Sales intent only: a callback or a showroom visit. */
  contact?: "call" | "visit";
  /** Order intent only: the customer wants a placed order cancelled. */
  cancel_order?: boolean;
};
export type RequestDetail = {
  pendingQuestion?: string;
  messageId: string;
  text: string;
  imageUrl?: string;
  fields?: RequestFields;
};
export type RequestRecord = {
  reference: string;
  session_key: string;
  category: RequestCategory;
  status: "draft" | "open" | "in_progress" | "resolved" | "cancelled";
  stage: "details" | "confirm";
  details: RequestDetail[];
};

/** Deliberately separates buying advice from an action requiring a staff request.
 * Ambiguous prose stays in the existing sales assistant; the explicit menu is
 * always available. No model is allowed to mark an order changed or ticket saved.
 */
export function requestIntent(text: string): RequestCategory | null {
  if (/\b(hurt|collapsed|dispute the charge|manager|escalate)\b/i.test(text)) return "complaint";
  if (
    /\b(delete|erase|remove)\b.*\b(my data|chat history|personal data)\b|\b(keeps? sinking|won.t stay up)\b/i.test(
      text,
    )
  )
    return "support";
  if (/\b(change|update|amend)\b.*\b(delivery|shipping) address\b/i.test(text)) return "order";
  if (
    /\b(complain(?:t|ts)?|unacceptable|unhappy|disappointed|angry|chargeback|injur(?:y|ed)|unsafe|electric shock|smoke|sparks)\b/i.test(
      text,
    )
  )
    return "complaint";
  if (
    /\b(my|our|the)\b.*\b(broken|damaged|defective|cracked|leaking|won.t (?:lift|work|recline)|not (?:working|lifting)|missing (?:part|item))\b|\b(arrived (?:broken|damaged)|received (?:the )?wrong|broken (?:chair|pump|mirror)|repair request|warranty claim|support ticket|need (?:technical )?support|file a claim)\b|^support[.!?]*$/i.test(
      text,
    )
  )
    return "support";
  if (
    /\b(where(?:'s| is) (?:my|our) order|track (?:my|our) order|order (?:status|help)|(?:cancel|change|amend|update|return|refund) (?:my|our|the|this) (?:order|purchase)|(?:my|our) order.*(?:late|missing|not arrived|not delivered)|request (?:a )?(?:return|refund)|want (?:a )?refund)\b/i.test(
      text,
    )
  )
    return "order";
  if (
    /\b(book (?:a |an |my )?(?:visit|appointment|showroom)|schedule (?:a |an )?(?:visit|appointment|call)|sales request|(?:bulk|wholesale) quote|(?:sales team|sales person|sales rep)|call me|call ?back|place (?:an |my |the )?order|buy (?:this|these)|order (?:this|these))\b/i.test(
      text,
    )
  )
    return "sales";
  if (
    /\b(talk|speak) to (?:a |the )?(?:person|human|agent|someone)|\b(?:human|agent) please\b|\breal (?:human|person)\b|^customer service[.!?]*$/i.test(
      text,
    )
  )
    return "support";
  return null;
}

/** A reply that only acknowledges our last message. It is never request
 * evidence: during intake it advances the flow, on a review it confirms it. */
export function isAcknowledgement(text: string): boolean {
  return /^(?:ok(?:ay)?|k|yes(?: please)?|yep|yeah|sure|fine|alright|all right|great|perfect|done|sounds good|(?:please )?(?:go ahead|proceed|continue|carry on)(?: please)?|(?:ok(?:ay)?|yes)[, ]+(?:please )?(?:go ahead|proceed|continue|submit(?: it)?|send(?: it)?)|send it|submit it)[.!\s]*$/i.test(
    text.trim(),
  );
}

export function requestMenu(): WaTurn {
  return {
    kind: "list",
    text: "How can I help? Choose an option below, or tell me what you need.",
    action: {
      kind: "list",
      button: "View options",
      rows: [
        { id: "request:sales", title: "Sales / visit request" },
        { id: "request:support", title: "Product support" },
        { id: "request:order", title: "Order help" },
        { id: "request:complaint", title: "Make a complaint" },
        { id: "request:status", title: "My requests" },
        { id: "request:faq", title: "FAQs and policies" },
      ],
    },
  };
}

export function requestDetailsPrompt(category: RequestCategory): string {
  const prompts: Record<RequestCategory, string> = {
    sales:
      "Happy to help. Tell me which products you're interested in and how many you need. If you'd like a showroom visit or a call, share your location and preferred date/time, including your timezone.",
    support:
      "I'll help you put together a support request. Which product do you need help with, and what's happened? Include your order number if you have it, and feel free to add photos. It's okay if you can't find the order number.",
    order:
      "What would you like help with on your order? Share your order number and what you need checked or changed. If you can't find the number, tell me what you purchased instead.",
    complaint:
      "I'm sorry you've had a frustrating experience. What went wrong, and how would you like us to help? An order number or a photo helps if you have one, but it's optional. If equipment seems unsafe, stop using it and get qualified help before using it again.",
  };
  return `${prompts[category]}\n\nYou'll be able to review everything before sending. Please leave out card details, passwords and ID documents. Type 'cancel request' if you'd like to stop.`;
}

const requestLabels: Record<RequestCategory, string> = {
  sales: "sales enquiry",
  support: "support request",
  order: "order enquiry",
  complaint: "complaint",
};

const QUOTE_PREFIX = "Please confirm a final quote for estimate ";
const isQuoteDetail = (d: RequestDetail) => d.text.startsWith(QUOTE_PREFIX);

/** All structured slots saved so far; later answers correct earlier ones. */
export function requestFields(
  request: Pick<RequestRecord, "details"> & Partial<Pick<RequestRecord, "category">>,
): RequestFields {
  const current: RequestFields = {};
  for (const detail of request.details) {
    Object.assign(
      current,
      request.category === "sales" ? salesBudgetFields(detail.text, current) : {},
      detail.fields ?? {},
    );
  }
  return current;
}

/** Resolve explicit budget edits, including short answers to our budget question.
 * Raw details remain the audit trail; the latest value is the current summary. */
export function salesBudgetFields(text: string, current: RequestFields = {}): RequestFields {
  if (/\?|\b(?:don't|do not|not ready|maybe|could|would|can I|should)\b/i.test(text)) return {};
  const mentionsBudget = /\bbudget\b/i.test(text);
  const shortAmount =
    /^(?:(?:USD|CAD|AUD|EUR|GBP)\s*)?[$£€]?\s*\d[\d,.]*(?:\s*k)?(?:\s*(?:USD|CAD|AUD|EUR|GBP|dollars?))?[.! ]*$/i.test(
      text.trim(),
    );
  if (!mentionsBudget && !(current.budget_pending && shortAmount)) return {};
  // Multiple amounts need contextual interpretation; never pick the first
  // amount from a per-item/total comparison or a "500 to 600" correction.
  if ((text.match(/\d[\d,]*(?:\.\d+)?\s*k?/gi) ?? []).length > 1) return {};
  const amount =
    text.match(/(?:[$£€]\s*|\bbudget\s*(?:(?:is|of|to|at)\s*)?)(\d[\d,]*(?:\.\d+)?\s*k?)/i) ??
    (shortAmount ? text.match(/(\d[\d,]*(?:\.\d+)?\s*k?)/i) : null);
  if (!amount)
    return /\b(?:adjust|change|update|increase|decrease|raise|lower)\b/i.test(text)
      ? { budget_pending: true }
      : {};
  const stated = budgetCurrency(text);
  return {
    budget: `${amount[1]!.trim()}${/\b(?:each|per (?:chair|item|unit|station))\b/i.test(text) ? " per item" : ""}`,
    ...(stated
      ? { currency: stated.explicit ? stated.currency : (current.currency ?? stated.currency) }
      : {}),
    budget_pending: false,
  };
}

type RequestKind = "delivery" | "call" | "visit" | "cancel_order" | RequestCategory;
export function requestKind(request: Pick<RequestRecord, "category" | "details">): RequestKind {
  const fields = requestFields(request);
  if (request.category === "sales") {
    if (request.details.some(isQuoteDetail)) return "delivery";
    if (fields.contact) return fields.contact;
  }
  if (request.category === "order" && fields.cancel_order) return "cancel_order";
  return request.category;
}

/** Customer-facing name for this particular draft. */
export function requestLabel(request: Pick<RequestRecord, "category" | "details">): string {
  const kind = requestKind(request);
  return (
    (
      {
        delivery: "delivery request",
        call: "callback request",
        visit: "showroom visit request",
        cancel_order: "order cancellation request",
      } as Record<string, string>
    )[kind] ?? requestLabels[request.category]
  );
}

type Slot = { any: RequestTextField[] };
const NEEDS: Record<RequestKind, Slot[]> = {
  delivery: [{ any: ["postcode"] }, { any: ["country"] }],
  call: [{ any: ["preferred_time"] }, { any: ["timezone"] }],
  visit: [{ any: ["location"] }, { any: ["preferred_time"] }],
  sales: [{ any: ["product"] }],
  support: [{ any: ["product"] }, { any: ["issue"] }],
  order: [{ any: ["issue"] }, { any: ["order_number", "purchase"] }],
  cancel_order: [{ any: ["order_number", "purchase"] }],
  complaint: [{ any: ["issue"] }],
};

/** Required slots still missing, or null for a legacy unstructured draft. */
export function missingSlots(
  request: Pick<RequestRecord, "category" | "details">,
): RequestTextField[] | null {
  const fields = requestFields(request);
  if (fields.budget_pending) return ["budget"];
  if (!Object.keys(fields).length) return null;
  return NEEDS[requestKind(request)]
    .filter((slot) => !slot.any.some((key) => fields[key]?.trim()))
    .map((slot) => slot.any[0]!);
}

const SHOWROOMS = "Carlstadt, NJ; Katy, TX; or Richmond Hill, Ontario";

/** One focused, customer-facing question for the first missing slot. The
 * application owns this copy so staff-facing notes never reach the customer. */
export function nextQuestion(
  request: Pick<RequestRecord, "category" | "details">,
  again = false,
): string {
  const missing = missingSlots(request) ?? [];
  if (!missing.length && request.details.at(-1)?.pendingQuestion)
    return request.details.at(-1)!.pendingQuestion!;
  const kind = requestKind(request);
  const has = (k: RequestTextField) => missing.includes(k);
  if (has("budget")) return "What would you like your new budget to be?";
  // After "ok" / "go ahead": say what is still needed instead of repeating.
  if (again && kind === "call" && (has("preferred_time") || has("timezone")))
    return "To set up the call I just need a day and time that suit you, plus your timezone (for example: Tuesday 3pm EST). Our team will then contact you to confirm.";
  if (again) return `To continue, I just need one more detail. ${nextQuestion(request)}`;
  if (kind === "call") {
    if (has("preferred_time") && has("timezone"))
      return "What day and time suit you for a call, and which timezone are you in? We'll use this WhatsApp number unless you tell me another.";
    if (has("preferred_time")) return "What day and time suit you for the call?";
    if (has("timezone")) return "Which timezone are you in, so our team calls at the right time?";
  }
  if (kind === "visit") {
    if (has("location")) return `Which showroom would you like to visit: ${SHOWROOMS}?`;
    if (has("preferred_time")) return "What day and time would you prefer for the visit?";
  }
  if (kind === "delivery") {
    if (has("postcode") && has("country")) return "What's the delivery postcode and country?";
    if (has("postcode")) return "What's the delivery postcode?";
    if (has("country")) return "Which country is the delivery going to?";
  }
  if (has("product"))
    return kind === "sales"
      ? "Which products are you interested in, and how many do you need?"
      : "Which product is this about? The model name or a photo of its label helps.";
  if (has("issue"))
    return kind === "complaint"
      ? "What went wrong? An order number or photo helps if you have one, but it's optional."
      : kind === "order"
        ? "What do you need help with on this order?"
        : "What's happening with it? A photo helps if you can send one.";
  if (has("order_number"))
    return "What's your order number? If you can't find it, tell me what you bought and roughly when.";
  return "Is there anything else our team should know?";
}

const FIELD_LABELS: [RequestTextField, string][] = [
  ["product", "Product"],
  ["quantity", "Quantity"],
  ["budget", "Budget"],
  ["currency", "Currency"],
  ["order_number", "Order number"],
  ["purchase", "Purchase"],
  ["recipient", "Recipient"],
  ["address", "Address"],
  ["postcode", "Postcode"],
  ["country", "Country"],
  ["location", "Showroom"],
  ["preferred_time", "Preferred time"],
  ["timezone", "Timezone"],
  ["phone", "Phone"],
  ["email", "Email"],
];

/** Short labelled lines, empty fields omitted, nothing printed twice. */
export function requestSummary(request: Pick<RequestRecord, "category" | "details">): string {
  const fields = requestFields(request);
  const kind = requestKind(request);
  const blocks: string[] = [];
  for (const quote of request.details.filter(isQuoteDetail)) {
    const [head, ...lines] = quote.text.split("\n");
    blocks.push(
      [`Estimate: ${head!.slice(QUOTE_PREFIX.length).replace(/:$/, "")}`, ...lines].join("\n"),
    );
  }
  const labelled = FIELD_LABELS.filter(([key]) => fields[key]?.trim()).map(
    ([key, label]) => `${label}: ${fields[key]!.trim()}`,
  );
  if (kind === "call")
    labelled.push(`Contact: ${fields.phone ? fields.phone : "this WhatsApp number"}`);
  if (labelled.length) blocks.push(labelled.join("\n"));
  // A message that only answered a slot question is already shown above.
  const notes = request.details
    .filter((d) => !isQuoteDetail(d) && !isAcknowledgement(d.text))
    .filter(
      (d) =>
        !d.fields ||
        Object.keys(d.fields).length === 0 ||
        d.fields.issue ||
        d.imageUrl ||
        (d.fields.budget && !d.fields.product),
    )
    .map((d) => {
      const text =
        fields.budget && /\bbudget\b/i.test(d.text)
          ? d.text
              .replace(
                /\b(?:my |on |a )?budget\s*(?:(?:is|of|to|at)\s*)?(?:(?:USD|CAD|AUD|EUR|GBP)\s*)?[$£€]?\s*\d[\d,.]*\s*k?(?:\s*(?:USD|CAD|AUD|EUR|GBP|dollars?))?/gi,
                "",
              )
              .replace(
                /^(?:I'm ready to |I want to )?(?:adjust|change|update)\s*(?:my )?budget[.! ]*$/i,
                "",
              )
              .trim()
          : d.fields?.budget && /^\s*\$?\s*\d[\d,.]*\s*$/.test(d.text)
            ? ""
            : d.text;
      return `${text}${d.imageUrl ? " [photo attached]" : ""}`;
    })
    .filter(Boolean);
  if (notes.length) blocks.push(`Details:\n${notes.join("\n")}`);
  return blocks.join("\n\n").slice(0, 2000);
}

function nextStep(request: Pick<RequestRecord, "category" | "details">): string {
  switch (requestKind(request)) {
    case "delivery":
      return "Our team will confirm delivery options and cost.";
    case "call":
      return "Our team will contact you to arrange the call. Nothing is booked until they confirm a time.";
    case "visit":
      return "Our team will confirm a visit time. Please wait for their confirmation before travelling.";
    case "cancel_order":
      return "Our team will check whether the order can still be cancelled. It isn't cancelled until they confirm.";
    default:
      return "Our team will review it.";
  }
}

export function requestReceipt(request: RequestRecord): string {
  const next: Record<RequestCategory, string> = {
    sales:
      "It's waiting for our team's review. If you've requested a visit or call, the time still needs to be confirmed.",
    support:
      "It's waiting for our support team's review. Keep any photos or order details handy in case they're needed.",
    order:
      "It's waiting for our team's review. Any change, cancellation or refund still needs their confirmation.",
    complaint: "Your concerns have been recorded for our team's review.",
  };
  return `Thank you—your ${requestLabel(request)} has been received.\nReference: ${request.reference}\n\n${next[request.category]}\n\nType 'request status' to check progress, or 'menu' to continue browsing.`;
}

export function requestStatusText(request: RequestRecord): string {
  const states: Record<RequestRecord["status"], string> = {
    draft: "Not sent yet. Add your details, then review and submit when you're ready.",
    open: "Received—waiting for our team's review.",
    in_progress: "Our team has marked your request as being reviewed.",
    resolved:
      "Our team has marked this request as resolved. Still need help? Type 'help' to start another request.",
    cancelled: "This draft wasn't submitted. Type 'help' if you'd like to start again.",
  };
  return `Your ${requestLabel(request)}\nReference: ${request.reference}\n\n${states[request.status]}${request.category === "order" ? "\nThis update is about your enquiry. For shipment tracking, check your dispatch email." : ""}`;
}

/** Review with Submit, or the one question still needed before review. */
export function confirmationTurns(request: RequestRecord): WaTurn[] {
  const missing = missingSlots(request);
  if (request.details.at(-1)?.pendingQuestion)
    return [{ kind: "text", text: nextQuestion(request) }];
  if (missing?.length) return [{ kind: "text", text: nextQuestion(request) }];
  if (!requestHasDetails(request))
    return [{ kind: "text", text: requestDetailsPrompt(request.category) }];
  const label = requestLabel(request);
  const buttons = {
    kind: "buttons" as const,
    buttons: [
      { id: `request:submit:${request.reference}`, title: "Submit request" },
      { id: `request:edit:${request.reference}`, title: "Add details" },
      { id: `request:cancel:${request.reference}`, title: "Cancel request" },
    ],
  };
  const review = `*Your ${label}* (not sent yet)\n\n${requestSummary(request)}`;
  const next = `Next: tap Submit request to send it. ${nextStep(request)}`;
  // WhatsApp caps an interactive body at 1024 characters: never truncate it.
  if (review.length + next.length > 950)
    return [
      { kind: "text", text: review },
      { kind: "buttons", text: next, action: buttons },
    ];
  return [{ kind: "buttons", text: `${review}\n\n${next}`, action: buttons }];
}

export function confirmationTurn(request: RequestRecord): WaTurn {
  return confirmationTurns(request).at(-1)!;
}

/** A number, navigation command or empty draft is not a usable staff enquiry. */
export function requestHasDetails(request: Pick<RequestRecord, "details">): boolean {
  return request.details.some(
    (d) =>
      d.text.trim().length >= 8 &&
      !isAcknowledgement(d.text) &&
      !/^(?:menu|hi|hello|help|support|sales|I (?:want|need)(?: to buy)? (?:\d+|one|two|three|four|five|six|seven|eight|nine|ten))[.!? ]*$/i.test(
        d.text.trim(),
      ),
  );
}

const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}@+'.-]+/gu, " ")
    .trim();

/** Keeps only slots whose values the customer actually wrote in this message. */
export function groundedFields(
  fields: RequestFields | undefined,
  category: RequestCategory,
  text: string,
): RequestFields {
  if (!fields) return {};
  const source = ` ${normalize(text)} `;
  const out: RequestFields = {};
  for (const key of REQUEST_TEXT_FIELDS) {
    const value = fields[key]?.trim();
    if (value && value.length <= 200 && normalize(value) && source.includes(normalize(value)))
      out[key] = value;
  }
  if (category === "sales" && (fields.contact === "call" || fields.contact === "visit"))
    out.contact = fields.contact;
  if (category === "order" && fields.cancel_order === true) out.cancel_order = true;
  return out;
}

export function detailFrom(
  event: InboundEvent,
  messageId: string,
  fields?: RequestFields,
): RequestDetail | null {
  const extra = fields && Object.keys(fields).length ? { fields } : {};
  if (event.kind === "text") return { messageId, text: event.text.trim().slice(0, 2500), ...extra };
  if (event.kind === "photo")
    return {
      messageId,
      text: event.caption?.trim().slice(0, 2500) || "Photo supplied by customer",
      imageUrl: event.url,
      ...extra,
    };
  return null;
}

const FAQ_TOPICS = [
  { id: "delivery", title: "Delivery", entry: "delivery", action: null },
  {
    id: "returns",
    title: "Returns",
    entry: "returns",
    action: { id: "request:order", title: "Order help" },
  },
  {
    id: "warranty",
    title: "Warranty",
    entry: "warranty",
    action: { id: "request:support", title: "Product support" },
  },
  {
    id: "payments",
    title: "Payments",
    entry: "orders",
    action: { id: "request:order", title: "Order help" },
  },
  { id: "financing", title: "Financing", entry: "finance", action: null },
  {
    id: "showrooms",
    title: "Showroom visits",
    entry: "showrooms",
    action: { id: "request:sales", title: "Sales / visit" },
  },
] as const;

export function faqMenu(): WaTurn {
  return {
    kind: "list",
    text: "Which topic would you like to know about?",
    action: {
      kind: "list",
      button: "Choose a topic",
      rows: FAQ_TOPICS.map((t) => ({ id: `request:faq:${t.id}`, title: t.title })),
    },
  };
}

/** Verified website knowledge only; an expired snapshot defers to the team. */
export function faqAnswer(topic: string, now = Date.now()): WaTurn[] | null {
  const faq = FAQ_TOPICS.find((t) => t.id === topic);
  const entry = faq && knowledge.entries.find((e) => e.id === faq.entry);
  if (!faq || !entry) return null;
  const current = now <= Date.parse(`${knowledge.reviewAfter}T23:59:59Z`);
  const body = current
    ? `*${faq.title}*\n${entry.answer}\n\nMore details: ${entry.source}`
    : `*${faq.title}*\nLet's check the latest details with our team before you make a decision. You can contact them here: https://comfortelfurniture.com/contact-us/`;
  return [
    {
      kind: "buttons",
      text: body,
      action: {
        kind: "buttons",
        buttons: [
          { id: "request:faq", title: "Back to FAQs" },
          ...(current && faq.action ? [faq.action] : []),
          { id: "nav:menu", title: "Main menu" },
        ],
      },
    },
  ];
}
