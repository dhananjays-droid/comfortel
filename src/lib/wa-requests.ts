import type { InboundEvent, WaTurn } from "@/lib/wa-runtime";

export const REQUEST_CATEGORIES = ["sales", "support", "order", "complaint"] as const;
export type RequestCategory = (typeof REQUEST_CATEGORIES)[number];
export type RequestDetail = { messageId: string; text: string; imageUrl?: string };
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

export function requestMenu(): WaTurn {
  return {
    kind: "list",
    text: "How can I help? Choose an option below, or tell me what you need.",
    action: {
      kind: "list",
      button: "Choose help",
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
      "I'm sorry you've had a frustrating experience. Tell me what happened and how you'd like us to help. Include your order number if you have it. If equipment seems unsafe, stop using it and get qualified help before using it again.",
  };
  return `${prompts[category]}\n\nYou'll be able to review everything before sending. Please leave out card details, passwords and ID documents. Type 'cancel request' if you'd like to stop.`;
}

const requestLabels: Record<RequestCategory, string> = {
  sales: "sales enquiry",
  support: "support request",
  order: "order enquiry",
  complaint: "complaint",
};

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
  return `Thank you—your ${requestLabels[request.category]} has been received.\nReference: ${request.reference}\n\n${next[request.category]}\n\nType 'request status' to check progress, or 'menu' to continue browsing.`;
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
  return `Your ${requestLabels[request.category]}\nReference: ${request.reference}\n\n${states[request.status]}${request.category === "order" ? "\nThis update is about your enquiry. For shipment tracking, check your dispatch email." : ""}`;
}

export function confirmationTurn(request: RequestRecord): WaTurn {
  const summary = request.details
    .map((d) => `${d.text}${d.imageUrl ? " [photo attached]" : ""}`)
    .join("\n")
    .slice(0, 2200);
  return {
    kind: "buttons",
    text: `Here's your ${requestLabels[request.category]}:\n\n${summary}\n\nDoes that look right? Tap Submit request to send it for our team to review, or Add details if there's anything else.`,
    action: {
      kind: "buttons",
      buttons: [
        { id: `request:submit:${request.reference}`, title: "Submit request" },
        { id: `request:edit:${request.reference}`, title: "Add details" },
        { id: `request:cancel:${request.reference}`, title: "Cancel request" },
      ],
    },
  };
}

export function detailFrom(event: InboundEvent, messageId: string): RequestDetail | null {
  if (event.kind === "text") return { messageId, text: event.text.trim().slice(0, 2500) };
  if (event.kind === "photo")
    return {
      messageId,
      text: event.caption?.trim().slice(0, 2500) || "Photo supplied by customer",
      imageUrl: event.url,
    };
  return null;
}
