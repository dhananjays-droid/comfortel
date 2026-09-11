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
    text: "What can we help with? Requests are saved for staff review; bookings and order changes need their confirmation.",
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
      "Share the product/quantity or what you need help buying. For a showroom visit or callback, include your location, preferred date/time and timezone.",
    support:
      "Share the product/model, what went wrong and your order reference if you have it. You can attach photos; describe what each shows. No order number? Say 'unknown'.",
    order:
      "Share your order reference and what you need checked or changed. If you don't have it, say 'unknown' and describe the purchase. Do not send payment details.",
    complaint:
      "I'm sorry this has been frustrating. Describe what happened and the outcome you would like; add your order reference if available. If equipment appears unsafe, stop using it and seek qualified help; this chat is not an emergency service.",
  };
  return `${prompts[category]}\n\nThis prepares a ${category} request for the admin inbox. Nothing is submitted until you confirm. Don't send card numbers, passwords or identity documents. Type 'cancel request' to leave this intake.`;
}

export function confirmationTurn(request: RequestRecord): WaTurn {
  const summary = request.details
    .map((d) => `${d.text}${d.imageUrl ? " [photo attached]" : ""}`)
    .join("\n")
    .slice(0, 2200);
  return {
    kind: "buttons",
    text: `Review your ${request.category} request:\n${summary}\n\nSubmit to the admin inbox? This is not an order, refund approval or confirmed booking.`,
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
