import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database, Json } from "@/integrations/supabase/types";
import { encryptPhone } from "@/lib/wa-phone-crypto.server";
import type { InboundEvent, WaTurn } from "@/lib/wa-runtime";
import { knowledgeAnswer } from "@/lib/wa-knowledge";
import { quoteRequestContext } from "@/lib/commerce-documents";
import {
  confirmationTurns,
  detailFrom,
  faqAnswer,
  faqMenu,
  groundedFields,
  isAcknowledgement,
  missingSlots,
  nextQuestion,
  requestDetailsPrompt,
  requestFields,
  requestIntent,
  requestKind,
  requestLabel,
  requestMenu,
  requestReceipt,
  requestStatusText,
  REQUEST_CATEGORIES,
  requestHasDetails,
  type RequestCategory,
  type RequestDetail,
  type RequestFields,
  type RequestRecord,
} from "@/lib/wa-requests";

type Row = Database["public"]["Tables"]["wa_requests"]["Row"];
type Patch = Database["public"]["Tables"]["wa_requests"]["Update"];
export type RequestStore = {
  latest(session: string): Promise<Row | null>;
  /** Unsent drafts for this chat, most recently touched first (one per category). */
  drafts(session: string): Promise<Row[]>;
  find(session: string, reference: string): Promise<Row | null>;
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
  async drafts(session) {
    const { data, error } = await supabaseAdmin
      .from("wa_requests")
      .select("*")
      .eq("session_key", session)
      .eq("status", "draft")
      .order("updated_at", { ascending: false })
      .limit(4);
    if (error) throw error;
    return data ?? [];
  },
  async find(session, reference) {
    const { data, error } = await supabaseAdmin
      .from("wa_requests")
      .select("*")
      .eq("session_key", session)
      .eq("reference", reference.toUpperCase())
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
const asRecord = (row: Row | null) => row as unknown as RequestRecord | null;

export async function requestContext(
  sessionKey: string,
  reference?: string,
): Promise<RequestRecord | null> {
  if (reference) {
    if (!/^CF-[A-F0-9]{8,32}$/i.test(reference)) return null;
    return asRecord(await store.find(sessionKey, reference));
  }
  return asRecord((await store.drafts(sessionKey))[0] ?? (await store.latest(sessionKey)));
}

export type RequestOverview = {
  /** The draft the customer is currently working on. */
  draft: RequestRecord | null;
  otherDrafts: RequestRecord[];
  /** Most recent request already sent to staff and not yet resolved. */
  submitted: RequestRecord | null;
};
export async function requestOverview(
  sessionKey: string,
  db: RequestStore = store,
): Promise<RequestOverview> {
  const [drafts, latest] = await Promise.all([db.drafts(sessionKey), db.latest(sessionKey)]);
  const records = drafts.map((d) => asRecord(d)!);
  const last = asRecord(latest);
  return {
    draft: records[0] ?? null,
    otherDrafts: records.slice(1),
    submitted: last && ["open", "in_progress"].includes(last.status) ? last : null,
  };
}

/** Do not let the staged shopping rollout steal input from an existing draft.
 * Query errors propagate: uncertainty must not silently bypass request intake. */
export async function hasActiveRequestDraft(sessionKey: string): Promise<boolean> {
  return (await store.drafts(sessionKey)).length > 0;
}

export type CancelTarget = "draft" | "submitted" | "order" | "unclear";

/** Returns null only when the established sales/design flow should handle it.
 * Request intake has separate durable state: render workers cannot overwrite it.
 * Each category keeps at most one unsent draft, so starting a complaint never
 * inherits a sales draft's details or delivery requirements.
 */
export async function handleRequestInbound(
  input: {
    sessionKey: string;
    phone: string;
    waMessageId: string;
    event: InboundEvent;
    salesIntakeActive?: boolean;
    categoryOverride?: RequestCategory;
    readyToReview?: boolean;
    followUpQuestion?: string;
    /** Slots labelled by the advisor; only values grounded in this message are kept. */
    fields?: RequestFields | undefined;
    /** The customer asked to open a request of categoryOverride. */
    start?: boolean;
    /** The advisor classified this message as a cancellation request. */
    cancel?: CancelTarget;
    /** Told which draft (if any) the customer is now working on. */
    onFocus?: (reference: string | null) => void;
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
  const newQuote = quoteRequestContext(button);
  const explicitCategory = newQuote
    ? "sales"
    : /^request:[a-z]+$/.test(button)
      ? button.split(":")[1]
      : null;
  const category =
    input.categoryOverride ??
    (REQUEST_CATEGORIES.includes(explicitCategory as RequestCategory)
      ? (explicitCategory as RequestCategory)
      : requestIntent(text));
  if (button === "ask" || /^(?:help|support menu|requests|customer service menu)$/i.test(text))
    return [requestMenu()];
  if (button === "request:faq" || /^(?:faq|faqs|policies|faqs and policies)$/i.test(text))
    return [faqMenu()];
  if (button.startsWith("request:faq:"))
    return faqAnswer(button.slice("request:faq:".length)) ?? [faqMenu()];

  let latest: Row | null;
  let drafts: Row[];
  try {
    const replay = await db.replay(sessionKey, waMessageId);
    if (replay?.last_reply) return replay.last_reply as unknown as WaTurn[];
    [latest, drafts] = await Promise.all([db.latest(sessionKey), db.drafts(sessionKey)]);
  } catch (error) {
    console.error(
      "WhatsApp request lookup failed",
      error instanceof Error ? error.message : "database error",
    );
    // Do not break existing greetings/designs if a migration is unavailable.
    if (
      category ||
      input.cancel ||
      button.startsWith("request:") ||
      /^(?:submit|cancel) request$/i.test(text)
    )
      return textTurn(
        "Sorry, I couldn't open your request just now. Please try again in a moment. If you need help sooner, contact our team: https://comfortelfurniture.com/contact-us/",
      );
    const answer = input.salesIntakeActive ? null : knowledgeAnswer(text);
    return answer ? textTurn(answer) : null;
  }
  const records = drafts.map((d) => asRecord(d)!);
  const buttonRef = button.match(/:(CF-[A-Z0-9-]+)$/i)?.[1];
  const target = buttonRef ? records.find((r) => r.reference === buttonRef) : undefined;
  let record: RequestRecord | null = target ?? records[0] ?? null;
  const focus = (reference: string | null) => input.onFocus?.(reference);
  const saveReply = async (reference: string, patch: Patch, turns: WaTurn[]) => {
    await db.update(reference, sessionKey, {
      ...patch,
      last_inbound_id: waMessageId,
      last_reply: turns as unknown as Json,
      updated_at: new Date().toISOString(),
    });
    return turns;
  };
  const newReference = () =>
    `CF-${createHash("sha256").update(`${sessionKey}:${waMessageId}`).digest("hex").slice(0, 16).toUpperCase()}`;
  const createDraft = async (
    newCategory: RequestCategory,
    detail: RequestDetail | null,
    reply: (draft: RequestRecord) => WaTurn[],
    open = false,
  ) => {
    const reference = newReference();
    const draft: RequestRecord = {
      reference,
      session_key: sessionKey,
      category: newCategory,
      status: open ? "open" : "draft",
      stage: "details",
      details: detail ? [detail] : [],
    };
    const ready = !open && missingSlots(draft)?.length === 0 && requestHasDetails(draft);
    const turns = reply({ ...draft, stage: ready ? "confirm" : "details" });
    try {
      await db.create({
        ...(open ? { status: "open" as const } : {}),
        ...(ready ? { stage: "confirm" as const } : {}),
        reference,
        session_key: sessionKey,
        source_message_id: waMessageId,
        category: newCategory,
        details: detail ? ([detail] as unknown as Json) : [],
        customer_phone_enc: encryptPhone(input.phone),
        last_inbound_id: waMessageId,
        last_reply: turns as unknown as Json,
      });
    } catch (error) {
      // Until the per-category draft index is migrated, the database still
      // allows one draft per chat: say so instead of failing the message.
      const existing = records[0];
      if (!existing || (error as { code?: string } | null)?.code !== "23505") throw error;
      focus(existing.reference);
      return [
        {
          kind: "buttons" as const,
          text: `You have an unsent ${requestLabel(existing)}. Please submit or cancel it before starting a ${requestLabel(draft)}.`,
          action: {
            kind: "buttons" as const,
            buttons: [
              { id: `request:review:${existing.reference}`, title: "Continue it" },
              { id: `request:cancel:${existing.reference}`, title: "Cancel request" },
            ],
          },
        },
      ];
    }
    focus(open ? (records[0]?.reference ?? null) : reference);
    return turns;
  };
  const otherDraftsNote = (except: string) => {
    const other = records.find((r) => r.reference !== except);
    return other
      ? {
          turn: {
            kind: "buttons" as const,
            text: `You also have an unsent ${requestLabel(other)}. Would you like to continue it?`,
            action: {
              kind: "buttons" as const,
              buttons: [
                { id: `request:review:${other.reference}`, title: "Continue it" },
                { id: "nav:menu", title: "Main menu" },
              ],
            },
          },
          reference: other.reference,
        }
      : null;
  };

  if (button === "request:status" || /^(?:my requests|ticket status|request status)$/i.test(text)) {
    const current = record ?? asRecord(latest);
    return textTurn(
      current
        ? requestStatusText(current)
        : "I couldn't find a request from this chat yet. Type 'help' and I'll help you get started.",
    );
  }

  // Buttons for a request that is no longer a draft: repeated taps never act twice.
  if (buttonRef && !target) {
    const row = asRecord(await db.find(sessionKey, buttonRef));
    if (row && button.startsWith("request:withdraw:")) {
      if (!["open", "in_progress"].includes(row.status)) return textTurn(requestStatusText(row));
      if (row.details.some((d) => d.messageId.startsWith("withdraw:")))
        return textTurn(
          `You've already asked our team to cancel request ${row.reference}. It stays open until they confirm.`,
        );
      return saveReply(
        row.reference,
        {
          details: [
            ...row.details,
            {
              messageId: `withdraw:${waMessageId}`,
              text: "Customer asked in WhatsApp to cancel this request.",
            },
          ] as unknown as Json,
        },
        textTurn(
          `I've asked our team to cancel request ${row.reference}. It isn't cancelled until they confirm. Type 'request status' to check.`,
        ),
      );
    }
    if (row && /^request:submit:/.test(button) && ["open", "in_progress"].includes(row.status))
      return textTurn(
        `That ${requestLabel(row)} is already sent.\nReference: ${row.reference}\n\nIt's waiting for our team's review.`,
      );
    if (row && /^request:cancel:/.test(button) && row.status === "cancelled")
      return textTurn(
        `That ${requestLabel(row)} is already cancelled. Nothing was sent to our team.`,
      );
    if (/^request:(submit|edit|cancel|review):/.test(button))
      return textTurn(
        records.length
          ? "That button belongs to an older request. Type 'request status' to check your current request."
          : row
            ? `${requestStatusText(row)}\n\nThat review button is no longer active. Type 'help' if you need anything else.`
            : "That request is no longer available. Type 'help' and I'll help you start a new one.",
      );
  }

  const submitted = asRecord(latest);
  if (
    submitted &&
    ["open", "in_progress"].includes(submitted.status) &&
    (/^(?:add to (?:my |this )?request|(?:I )?also|another (?:issue|problem)|one more thing)\b/i.test(
      text,
    ) ||
      (submitted.category === "order" &&
        category === "order" &&
        /\b(delivery|shipping) address\b/i.test(text)))
  ) {
    const detail = detailFrom(event, waMessageId);
    if (detail && submitted.details.length < 12)
      return saveReply(
        submitted.reference,
        { details: [...submitted.details, detail] as unknown as Json },
        [
          {
            kind: "buttons",
            text: `I’ve added that to your request ${submitted.reference}. It’s available for our team to review.`,
            action: {
              kind: "buttons",
              buttons: [
                { id: "request:status", title: "Request status" },
                { id: "nav:menu", title: "Main menu" },
              ],
            },
          },
        ],
      );
  }

  // Cancellation: identify the target before touching anything. A model
  // classification is a hint; the stored records decide what is ambiguous.
  if (input.cancel || button === "request:ordercancel") {
    const sent = submitted && ["open", "in_progress"].includes(submitted.status) ? submitted : null;
    const orderCancel = records.find((r) => requestKind(r) === "cancel_order");
    if (input.cancel && orderCancel) {
      focus(orderCancel.reference);
      return saveReply(orderCancel.reference, {}, confirmationTurns(orderCancel));
    }
    if (button === "request:ordercancel" || (input.cancel === "order" && !record && !sent)) {
      const fields = {
        ...groundedFields(input.fields, "order", text),
        cancel_order: true as const,
      };
      const orderDraft = records.find((r) => r.category === "order");
      const detail =
        event.kind === "button"
          ? { messageId: waMessageId, text: "Cancel a placed order (chosen in chat)", fields }
          : detailFrom(event, waMessageId, fields);
      if (orderDraft) {
        const next = { ...orderDraft, details: [...orderDraft.details, detail!] };
        const ready = missingSlots(next)?.length === 0;
        focus(orderDraft.reference);
        return saveReply(
          orderDraft.reference,
          { stage: ready ? "confirm" : "details", details: next.details as unknown as Json },
          ready ? confirmationTurns({ ...next, stage: "confirm" }) : textTurn(nextQuestion(next)),
        );
      }
      return createDraft("order", detail, (draft) =>
        draft.stage === "confirm"
          ? confirmationTurns(draft)
          : textTurn(
              `I'll prepare an order cancellation request for our team. The order isn't cancelled until they confirm.\n\n${nextQuestion(draft)}`,
            ),
      );
    }
    if (input.cancel === "draft" && record && !sent)
      return [
        {
          kind: "buttons",
          text: `Cancel your unsent ${requestLabel(record)}? Nothing has been sent to our team yet.`,
          action: {
            kind: "buttons",
            buttons: [
              { id: `request:cancel:${record.reference}`, title: "Yes, cancel it" },
              { id: `request:review:${record.reference}`, title: "Keep it" },
            ],
          },
        },
      ];
    if (input.cancel === "submitted" && sent && !record)
      return [
        {
          kind: "buttons",
          text: `Your ${requestLabel(sent)} (reference ${sent.reference}) has already been sent. I can ask our team to cancel it; it stays open until they confirm.`,
          action: {
            kind: "buttons",
            buttons: [
              { id: `request:withdraw:${sent.reference}`, title: "Ask to cancel it" },
              { id: "nav:menu", title: "Keep it" },
            ],
          },
        },
      ];
    const options: { id: string; title: string }[] = [];
    if (record)
      options.push({ id: `request:cancel:${record.reference}`, title: "Cancel unsent draft" });
    if (sent)
      options.push({ id: `request:withdraw:${sent.reference}`, title: "Cancel sent request" });
    options.push({ id: "request:ordercancel", title: "Cancel placed order" });
    if (options.length < 3)
      options.push({
        id: record ? `request:review:${record.reference}` : "nav:menu",
        title: "Keep everything",
      });
    const lines = [
      record ? `• Your unsent ${requestLabel(record)} (not sent to our team yet)` : "",
      sent ? `• Your sent ${requestLabel(sent)}, reference ${sent.reference}` : "",
      "• An order you've already placed with us",
    ].filter(Boolean);
    return [
      {
        kind: "buttons",
        text: `Which would you like to cancel?\n${lines.join("\n")}\n\nNothing is cancelled until you choose.`,
        action: { kind: "buttons", buttons: options.slice(0, 3) },
      },
    ];
  }

  // Starting a category: never reuse a different category's draft.
  const startsCategory = Boolean(explicitCategory && category) || Boolean(input.start && category);
  if (button.startsWith("request:new:")) {
    const [, , newCategory, oldRef] = button.split(":");
    const old = records.find((r) => r.reference === oldRef);
    if (!REQUEST_CATEGORIES.includes(newCategory as RequestCategory) || !old)
      return textTurn(
        "That button belongs to an older request. Type 'request status' to check your current request.",
      );
    await db.update(old.reference, sessionKey, {
      status: "cancelled",
      updated_at: new Date().toISOString(),
    });
    records.splice(records.indexOf(old), 1);
    return createDraft(newCategory as RequestCategory, null, () =>
      textTurn(requestDetailsPrompt(newCategory as RequestCategory)),
    );
  }
  if (button.startsWith("request:review:") && target) {
    focus(target.reference);
    return saveReply(target.reference, {}, confirmationTurns(target));
  }
  if (newQuote) {
    const sales = records.find((r) => r.category === "sales");
    if (sales) {
      focus(sales.reference);
      return saveReply(
        sales.reference,
        {
          stage: "details",
          details: [{ messageId: waMessageId, text: newQuote }] as unknown as Json,
        },
        textTurn(
          "I’ve updated your unsent delivery request to this estimate and replaced the previous estimate details.\n\nWhat's the delivery postcode and country? I’ll show the updated request for review before sending it.",
        ),
      );
    }
    record = null;
  } else if (startsCategory && category && records.length) {
    const same = records.find((r) => r.category === category);
    if (same) {
      focus(same.reference);
      const summary =
        missingSlots(same)?.length || !requestHasDetails(same)
          ? "It still needs a few details."
          : "It's ready to review.";
      return saveReply(same.reference, {}, [
        {
          kind: "buttons",
          text: `You already have an unsent ${requestLabel(same)}. ${summary}\n\nContinue with it, or start a new ${requestLabel({ category, details: [] })}?`,
          action: {
            kind: "buttons",
            buttons: [
              { id: `request:review:${same.reference}`, title: "Continue it" },
              { id: `request:new:${category}:${same.reference}`, title: "Start new" },
              { id: "nav:menu", title: "Main menu" },
            ],
          },
        },
      ]);
    }
    record = null; // a new category gets its own draft below
  }

  if (record?.status === "draft") {
    // Navigation pauses a draft; it never turns navigation text into details,
    // submits it or forces an empty confirmation. The unified controller can
    // resume this durable draft explicitly later.
    if (/^(?:menu|hi|hello|help)$/i.test(text) || button === "nav:menu") return null;
    const current = record;
    if (
      button === `request:cancel:${current.reference}` ||
      /^(?:cancel request|discard request|back to shopping|start over)$/i.test(text)
    ) {
      const other = otherDraftsNote(current.reference);
      focus(other?.reference ?? null);
      return saveReply(current.reference, { status: "cancelled" }, [
        ...textTurn(
          `Okay, I've cancelled your unsent ${requestLabel(current)}. Nothing was sent to our team. Your salon plan is still here—type 'menu' whenever you're ready to continue.`,
        ),
        ...(other ? [other.turn] : []),
      ]);
    }
    if (button === `request:edit:${current.reference}`) {
      focus(current.reference);
      return saveReply(
        current.reference,
        { stage: "details" },
        textTurn(
          "Of course—send any extra details or photos you'd like to include, and I'll show you the updated request.",
        ),
      );
    }
    if (
      button === `request:submit:${current.reference}` ||
      /^(?:submit request|confirm request)$/i.test(text) ||
      (current.stage === "confirm" &&
        (/^(?:yes|yes please|confirm|submit)[.!]*$/i.test(text) || isAcknowledgement(text)))
    ) {
      if (
        current.stage !== "confirm" ||
        !requestHasDetails(current) ||
        missingSlots(current)?.length
      )
        return textTurn(
          missingSlots(current)?.length
            ? `This request isn't ready to send yet. ${nextQuestion(current)}`
            : "Please add a few details first so our team knows what you need help with. I'll then show you the request to review.",
        );
      const other = otherDraftsNote(current.reference);
      focus(other?.reference ?? null);
      return saveReply(current.reference, { status: "open" }, [
        ...textTurn(requestReceipt(current)),
        ...(other ? [other.turn] : []),
      ]);
    }
    if (
      /^(?:menu|hi|hello|help)$/i.test(text) ||
      button.startsWith("request:") ||
      event.kind === "button"
    ) {
      focus(current.reference);
      return current.stage !== "confirm" || !requestHasDetails(current)
        ? textTurn(
            `Your ${requestLabel(current)} still needs details before it can be submitted. ${missingSlots(current)?.length ? nextQuestion(current) : "Please share what you need."}`,
          )
        : [
            ...confirmationTurns(current),
            ...textTurn(
              "We haven't sent this request yet. You can submit it, add details, or type 'cancel request' to do something else.",
            ),
          ];
    }
    focus(current.reference);
    // "ok" / "please go ahead" advance the flow; they are never saved as details.
    if (event.kind === "text" && isAcknowledgement(text))
      return saveReply(
        current.reference,
        {},
        missingSlots(current)?.length
          ? textTurn(nextQuestion(current, true))
          : requestHasDetails(current)
            ? confirmationTurns(current)
            : textTurn(requestDetailsPrompt(current.category)),
      );
    const fields = groundedFields(input.fields, current.category, text);
    // A captioned photo describes the problem even without advisor labels.
    if (event.kind === "photo" && text && !fields.issue && missingSlots(current)?.includes("issue"))
      fields.issue = text;
    const detail = detailFrom(event, waMessageId, fields);
    if (!detail?.text)
      return textTurn(
        "Could you send that as text or a photo with a short description? I can't read voice messages or videos here. Keep any videos handy in case our team needs them later.",
      );
    if (current.details.length >= 12)
      return [
        ...confirmationTurns(current),
        ...textTurn(
          "That's all I can attach to one request. You can submit it now, or type 'cancel request' to start again.",
        ),
      ];
    const withDetail = { ...current, details: [...current.details, detail] };
    const missing = missingSlots(withDetail);
    // Structured drafts are ready only when every required slot is filled;
    // legacy drafts keep the advisor's readiness judgement.
    const ready = missing ? missing.length === 0 : input.readyToReview !== false;
    const next = { ...withDetail, stage: ready ? ("confirm" as const) : ("details" as const) };
    if (!requestHasDetails(next))
      return textTurn(
        "Which product or issue is this about? I need that detail before preparing your request for our team.",
      );
    if (next.stage === "details")
      return saveReply(
        current.reference,
        { stage: "details", details: next.details as unknown as Json },
        textTurn(
          missing
            ? nextQuestion(next)
            : (customerQuestion(input.followUpQuestion) ?? requestDetailsPrompt(current.category)),
        ),
      );
    return saveReply(
      current.reference,
      { stage: "confirm", details: next.details as unknown as Json },
      confirmationTurns(next),
    );
  }
  if (/^request:(submit|edit|cancel):/.test(button))
    return textTurn(
      submitted
        ? `${requestStatusText(submitted)}\n\nThat review button is no longer active. Type 'help' if you need anything else.`
        : "That request is no longer available. Type 'help' and I'll help you start a new one.",
    );
  // A bare "ok" right after sending must not open a second request.
  if (
    event.kind === "text" &&
    isAcknowledgement(text) &&
    submitted &&
    ["open", "in_progress"].includes(submitted.status) &&
    Date.now() - Date.parse(latest?.updated_at ?? "") < 30 * 60_000
  )
    return textTurn(
      `Your ${requestLabel(submitted)} is already with our team.\nReference: ${submitted.reference}\n\nType 'request status' to check progress, or 'menu' to continue browsing.`,
    );
  if (category) {
    const quoteContext = newQuote;
    const fields = groundedFields(input.fields, category, text);
    const detail = quoteContext
      ? { messageId: waMessageId, text: quoteContext }
      : detailFrom(event, waMessageId, fields);
    const urgent = /\b(hurt|injur(?:y|ed)|collapsed|electric shock|smoke|sparks)\b/i.test(text);
    const privacy = /\b(delete|erase|remove)\b.*\b(my data|chat history|personal data)\b/i.test(
      text,
    );
    const others = records.filter((r) => r.category !== category);
    const saved =
      others.length && !quoteContext
        ? `\n\nYour unsent ${requestLabel(others[0]!)} is saved separately; you can come back to it later.`
        : "";
    return createDraft(
      category,
      detail,
      (draft) => {
        const reference = draft.reference;
        if (urgent || privacy)
          return [
            {
              kind: "buttons",
              text: privacy
                ? `Your data-deletion request has been recorded for our team. Reference: ${reference}. Your data has not been deleted yet; the team needs to review and process the request.`
                : `I’m sorry this happened. Stop using the equipment if it may be unsafe. I’ve recorded your report for our team. Reference: ${reference}. If someone needs urgent medical help, contact local emergency services.`,
              action: {
                kind: "buttons",
                buttons: [
                  { id: "request:status", title: "Request status" },
                  { id: "nav:menu", title: "Main menu" },
                ],
              },
            },
          ];
        if (quoteContext)
          return textTurn(
            `Delivery request started. I've added the products and quantities from your estimate.\n\nPlease send:\n• Delivery postcode and country\n• Recipient name and street address (optional)\n• Any options you'd like checked\n\nYou'll review everything before it's sent. Type 'cancel request' to stop.`,
          );
        if (draft.stage === "confirm") return confirmationTurns(draft);
        const missing = missingSlots(draft);
        return textTurn(
          missing?.length
            ? `I'll prepare your ${requestLabel(draft)} for our team to review before anything is sent.\n\n${nextQuestion(draft)}${saved}`
            : `${requestDetailsPrompt(category)}${saved}`,
        );
      },
      urgent || privacy,
    );
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

/** Advisor prose is used only when it is a customer-facing question, never a
 * note about the customer written for staff. */
function customerQuestion(text: string | undefined): string | null {
  if (!text || !text.includes("?")) return null;
  if (
    /\b(?:the customer|customer (?:is|has|wants|asked|says)|customer's|staff should)\b/i.test(text)
  )
    return null;
  return text;
}

export { requestFields };
