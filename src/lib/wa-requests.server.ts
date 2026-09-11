import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { encryptPhone } from "@/lib/wa-phone-crypto.server";
import type { InboundEvent, WaTurn } from "@/lib/wa-runtime";
import { knowledgeAnswer } from "@/lib/wa-knowledge";
import {
  confirmationTurn,
  detailFrom,
  requestDetailsPrompt,
  requestIntent,
  requestMenu,
  requestReceipt,
  requestStatusText,
  REQUEST_CATEGORIES,
  type RequestCategory,
  type RequestRecord,
} from "@/lib/wa-requests";

type Row = Database["public"]["Tables"]["wa_requests"]["Row"];
type Patch = Database["public"]["Tables"]["wa_requests"]["Update"];
export type RequestStore = {
  latest(session: string): Promise<Row | null>;
  replay(session: string, message: string): Promise<Row | null>;
  create(row: Database["public"]["Tables"]["wa_requests"]["Insert"]): Promise<void>;
  update(reference: string, session: string, patch: Patch): Promise<void>;
};
const store: RequestStore = {
  async latest(session) {
    const { data, error } = await supabaseAdmin
      .from("wa_requests")
      .select("*")
      .eq("session_key", session)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  },
  async replay(session, message) {
    const { data, error } = await supabaseAdmin
      .from("wa_requests")
      .select("*")
      .eq("session_key", session)
      .eq("last_inbound_id", message)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data;
  },
  async create(row) {
    const { error } = await supabaseAdmin.from("wa_requests").insert(row);
    if (error) throw error;
  },
  async update(reference, session, patch) {
    const { data, error } = await supabaseAdmin
      .from("wa_requests")
      .update(patch)
      .eq("reference", reference)
      .eq("session_key", session)
      .select("reference")
      .single();
    if (error || !data) throw error ?? new Error("Request not found");
  },
};
const textTurn = (text: string): WaTurn[] => [{ kind: "text", text }];

/** Returns null only when the established sales/design flow should handle it.
 * Request intake has separate durable state: render workers cannot overwrite it.
 */
export async function handleRequestInbound(
  input: {
    sessionKey: string;
    phone: string;
    waMessageId: string;
    event: InboundEvent;
    salesIntakeActive?: boolean;
  },
  db: RequestStore = store,
): Promise<WaTurn[] | null> {
  const { event, sessionKey, waMessageId } = input;
  const text =
    event.kind === "text"
      ? event.text.trim()
      : event.kind === "photo"
        ? (event.caption?.trim() ?? "")
        : "";
  const button = event.kind === "button" ? event.id : "";
  const explicitCategory = button.startsWith("request:") ? button.split(":")[1] : null;
  const category = REQUEST_CATEGORIES.includes(explicitCategory as RequestCategory)
    ? (explicitCategory as RequestCategory)
    : requestIntent(text);
  if (button === "ask" || /^(?:help|support menu|requests|customer service menu)$/i.test(text))
    return [requestMenu()];
  if (button === "request:faq" || /^(?:faq|faqs|policies)$/i.test(text))
    return textTurn(
      "What would you like to know? I can help with delivery, returns, warranty, payments, financing and showroom visits.",
    );

  let latest: Row | null;
  try {
    const replay = await db.replay(sessionKey, waMessageId);
    if (replay?.last_reply) return replay.last_reply as unknown as WaTurn[];
    latest = await db.latest(sessionKey);
  } catch (error) {
    console.error(
      "WhatsApp request lookup failed",
      error instanceof Error ? error.message : "database error",
    );
    // Do not break existing greetings/designs if a migration is unavailable.
    if (category || button.startsWith("request:") || /^(?:submit|cancel) request$/i.test(text))
      return textTurn(
        "Sorry, I couldn't open your request just now. Please try again in a moment. If you need help sooner, contact our team: https://comfortelfurniture.com/contact-us/",
      );
    const answer = input.salesIntakeActive ? null : knowledgeAnswer(text);
    return answer ? textTurn(answer) : null;
  }
  const record = latest as unknown as RequestRecord | null;
  const saveReply = async (patch: Patch, turns: WaTurn[]) => {
    await db.update(record!.reference, sessionKey, {
      ...patch,
      last_inbound_id: waMessageId,
      last_reply: turns as unknown as Json,
      updated_at: new Date().toISOString(),
    });
    return turns;
  };
  if (button === "request:status" || /^(?:my requests|ticket status|request status)$/i.test(text)) {
    return textTurn(
      record
        ? requestStatusText(record)
        : "I couldn't find a request from this chat yet. Type 'help' and I'll help you get started.",
    );
  }
  if (record?.status === "draft") {
    if (/^request:(submit|edit|cancel):/.test(button) && !button.endsWith(`:${record.reference}`))
      return textTurn(
        "That button belongs to an older request. Type 'request status' to check your current request.",
      );
    if (
      button === `request:cancel:${record.reference}` ||
      /^(?:cancel request|discard request|back to shopping|start over)$/i.test(text)
    ) {
      return saveReply(
        { status: "cancelled" },
        textTurn(
          "Okay, I haven't submitted this request. Your salon plan is still here—type 'menu' whenever you're ready to continue.",
        ),
      );
    }
    if (button === `request:edit:${record.reference}`)
      return saveReply(
        { stage: "details" },
        textTurn(
          "Of course—send any extra details or photos you'd like to include, and I'll show you the updated request.",
        ),
      );
    if (
      button === `request:submit:${record.reference}` ||
      /^(?:submit request|confirm request)$/i.test(text) ||
      (record.stage === "confirm" && /^(?:yes|yes please|confirm|submit)[.!]*$/i.test(text))
    ) {
      if (record.stage !== "confirm")
        return textTurn(
          "Please add a few details first so our team knows what you need help with. I'll then show you the request to review.",
        );
      return saveReply({ status: "open" }, textTurn(requestReceipt(record)));
    }
    if (
      /^(?:menu|hi|hello|help)$/i.test(text) ||
      button.startsWith("request:") ||
      event.kind === "button"
    )
      return [
        confirmationTurn(record),
        ...textTurn(
          "We haven't sent this request yet. You can submit it, add details, or type 'cancel request' to do something else.",
        ),
      ];
    const detail = detailFrom(event, waMessageId);
    if (!detail?.text)
      return textTurn(
        "Could you send that as text or a photo with a short description? I can't read voice messages or videos here. Keep any videos handy in case our team needs them later.",
      );
    if (record.details.length >= 12)
      return [
        confirmationTurn(record),
        ...textTurn(
          "That's all I can attach to one request. You can submit it now, or type 'cancel request' to start again.",
        ),
      ];
    const next = { ...record, stage: "confirm" as const, details: [...record.details, detail] };
    return saveReply({ stage: "confirm", details: next.details as unknown as Json }, [
      confirmationTurn(next),
    ]);
  }
  if (/^request:(submit|edit|cancel):/.test(button))
    return textTurn(
      record
        ? `${requestStatusText(record)}\n\nThat review button is no longer active. Type 'help' if you need anything else.`
        : "That request is no longer available. Type 'help' and I'll help you start a new one.",
    );
  if (category) {
    const reference = `CF-${createHash("sha256").update(`${sessionKey}:${waMessageId}`).digest("hex").slice(0, 16).toUpperCase()}`;
    const detail = detailFrom(event, waMessageId);
    const turns = textTurn(requestDetailsPrompt(category));
    await db.create({
      reference,
      session_key: sessionKey,
      source_message_id: waMessageId,
      category,
      details: detail ? ([detail] as unknown as Json) : [],
      customer_phone_enc: encryptPhone(input.phone),
      last_inbound_id: waMessageId,
      last_reply: turns as unknown as Json,
    });
    return turns;
  }
  // Existing quote/planning answers can contain words like "email" or
  // "shipping address". Do not steal those form answers as unrelated FAQs.
  const isQuestion = /\?|^(?:what|how|when|where|can|do|does|is|are|will)\b/i.test(text);
  const answer = input.salesIntakeActive && !isQuestion ? null : knowledgeAnswer(text);
  return answer
    ? [
        ...textTurn(answer),
        {
          kind: "buttons",
          text: "How would you like to continue?",
          action: {
            kind: "buttons",
            buttons: [
              { id: "request:support", title: "Product support" },
              { id: "request:sales", title: "Sales / visit" },
              { id: "request:order", title: "Order help" },
            ],
          },
        },
      ]
    : null;
}
