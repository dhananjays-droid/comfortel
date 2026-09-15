/**
 * The WhatsApp Cloud API webhook receiver.
 *
 * Called from src/server.ts's fetch() intercept, NOT a TanStack route file —
 * the installed @tanstack/react-start (1.168.32) has no raw-route convention
 * (no createServerFileRoute/createAPIFileRoute), only createServerFn RPCs,
 * which can't express a GET verification handshake with query-string
 * parameters or a POST that must be signature-checked before its body is
 * even parsed as JSON.
 *
 * Every reply here is a free-form send (sendText/sendButtons/sendList) rather
 * than a template — always safe, since a reply to an inbound message is by
 * definition inside the 24-hour service window. sendTemplate is only for the
 * render-worker's proactive fallback, which isn't replying to anything.
 *
 * An image message resolves synchronously, in this same request, to a
 * durable URL via wa-media.server.ts — Meta's own media download URL is only
 * valid for a few minutes, so deferring that resolution to a later worker
 * tick is the one sequencing mistake that would silently lose the photo.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import type { Json } from "@/integrations/supabase/types";
import { enqueueInboundJob, triggerInboundWorker } from "@/lib/wa-inbound-queue.server";
import { tooManyInboundMessages } from "@/lib/wa-rate-limit.server";
import { receiveRoomPhoto } from "@/lib/wa-media.server";
import {
  markReadAndType,
  sendButtons,
  sendImage,
  sendList,
  sendText,
  sendDocument,
  sendCatalog,
} from "@/lib/wa-client.server";
import { toWhatsAppMarkdown } from "@/lib/wa-markdown";
import { handleInboundMessage, type InboundEvent, type WaTurn } from "@/lib/wa-runtime";
import { loadSession, saveSession } from "@/lib/wa-session-store.server";
import { handleRequestInbound } from "@/lib/wa-requests.server";
import { handleDocumentInbound } from "@/lib/wa-documents.server";
import { waSessionKey } from "@/lib/wa-session.server";
import { staffHandling, touchStaffRequest } from "@/lib/wa-staff.server";
import { customerTimestamp } from "@/lib/wa-staff";
import { cartSchema, type CatalogCart } from "@/lib/product-management";

type InboundMessage = {
  waMessageId: string;
  from: string;
  kind: "text" | "interactive" | "image" | "order" | "unsupported";
  cart?: CatalogCart;
  text?: string;
  replyTo?: string;
  referredProductId?: string;
  buttonReplyId?: string;
  /** The button/list row's own display text — what the customer actually
   * saw and tapped. Logged alongside buttonReplyId so a developer reading
   * the log sees "Plan my salon", not the internal id "build". */
  buttonReplyTitle?: string;
  imageId?: string;
  imageCaption?: string;
  customerSentAt?: string | null;
};

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function verifySignature(rawBody: string, header: string | null): boolean {
  const secret = process.env["WHATSAPP_APP_SECRET"];
  if (!secret || !header) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return timingSafeEqualStrings(expected, header);
}

function handleVerify(url: URL): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = process.env["WHATSAPP_VERIFY_TOKEN"];

  if (mode === "subscribe" && expected && token === expected && challenge) {
    return new Response(challenge, { status: 200 });
  }
  return new Response("Forbidden", { status: 403 });
}

/**
 * Meta's webhook envelope, narrowed to what this app reads. contacts[].profile.name
 * is read (for the admin dashboard only, see wa-session.ts's customerName) —
 * it is the display name the customer set in their own WhatsApp app, not
 * something Comfortel asked for or that conversation logic depends on.
 */
type WebhookEnvelope = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        statuses?: Array<{
          id?: string;
          status?: string;
          timestamp?: string;
          recipient_id?: string;
          conversation?: Record<string, unknown>;
          pricing?: Record<string, unknown>;
          errors?: Array<Record<string, unknown>>;
        }>;
        messages?: Array<{
          timestamp?: string;
          id?: string;
          from?: string;
          type?: string;
          order?: unknown;
          text?: { body?: string };
          context?: { id?: string; referred_product?: { product_retailer_id?: string } };
          interactive?: {
            button_reply?: { id?: string; title?: string };
            list_reply?: { id?: string; title?: string };
          };
          image?: { id?: string; caption?: string };
        }>;
      };
    }>;
  }>;
};

export type DeliveryStatusEvent = {
  waMessageId: string;
  status: string;
  eventAt: string;
  recipientId?: string;
  details: Record<string, unknown>;
};

/** Extracted separately because status-only callbacks have no messages array. */
export function extractDeliveryStatuses(envelope: WebhookEnvelope): DeliveryStatusEvent[] {
  const statuses: DeliveryStatusEvent[] = [];
  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const status of change.value?.statuses ?? []) {
        if (!status.id || !status.status || !status.timestamp) continue;
        const seconds = Number(status.timestamp);
        const eventAt = Number.isFinite(seconds)
          ? new Date(seconds * 1000).toISOString()
          : new Date().toISOString();
        statuses.push({
          waMessageId: status.id,
          status: status.status,
          eventAt,
          ...(status.recipient_id ? { recipientId: status.recipient_id } : {}),
          details: {
            ...(status.conversation ? { conversation: status.conversation } : {}),
            ...(status.pricing ? { pricing: status.pricing } : {}),
            ...(status.errors ? { errors: status.errors } : {}),
          },
        });
      }
    }
  }
  return statuses;
}

function extractMessages(envelope: WebhookEnvelope): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        if (!m.id || !m.from) continue;
        const base = {
          waMessageId: m.id,
          from: m.from,
          customerSentAt: customerTimestamp(m.timestamp),
        };
        if (m.type === "text" && m.text?.body) {
          out.push({
            ...base,
            kind: "text",
            text: m.text.body,
            ...(m.context?.id ? { replyTo: m.context.id } : {}),
            ...(m.context?.referred_product?.product_retailer_id
              ? { referredProductId: m.context.referred_product.product_retailer_id }
              : {}),
          });
        } else if (m.type === "interactive") {
          const reply = m.interactive?.button_reply ?? m.interactive?.list_reply;
          if (reply?.id) {
            out.push({
              ...base,
              kind: "interactive",
              buttonReplyId: reply.id,
              ...(reply.title ? { buttonReplyTitle: reply.title } : {}),
            });
          } else out.push({ ...base, kind: "unsupported" });
        } else if (m.type === "order") {
          const parsed = cartSchema.safeParse(m.order);
          out.push(
            parsed.success
              ? { ...base, kind: "order", cart: parsed.data }
              : { ...base, kind: "unsupported" },
          );
        } else if (m.type === "image" && m.image?.id) {
          out.push({
            ...base,
            kind: "image",
            imageId: m.image.id,
            ...(m.image.caption ? { imageCaption: m.image.caption } : {}),
          });
        } else {
          out.push({ ...base, kind: "unsupported" });
        }
      }
    }
  }
  return out;
}

/** wa_id → the customer's own WhatsApp display name, for every contact
 * named anywhere in this delivery. Meta includes this on essentially every
 * message, but treating it as occasionally absent (rather than assuming
 * it) costs nothing and avoids overwriting a known name with nothing. */
function extractContactNames(envelope: WebhookEnvelope): Map<string, string> {
  const names = new Map<string, string>();
  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const c of change.value?.contacts ?? []) {
        if (c.wa_id && c.profile?.name) names.set(c.wa_id, c.profile.name);
      }
    }
  }
  return names;
}

/**
 * Insert-if-new against wa_messages' unique wa_message_id — Meta redelivers,
 * so a second delivery of the same id must be a silent no-op, not a second
 * reply. Returns true only for a message this call is the first to see.
 *
 * Never throws: a session-store outage here degrades to "process everything,
 * possibly twice" rather than dropping inbound traffic — the same resilience
 * stance wa-session-store.server.ts takes for load/save.
 */
async function recordInboundIfNew(
  message: InboundMessage,
  sessionKey: string,
  event?: InboundEvent,
): Promise<boolean> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("wa_messages").insert({
      wa_message_id: message.waMessageId,
      direction: "inbound",
      session_key: sessionKey,
      kind: message.kind,
      payload: {
        text:
          message.kind === "order"
            ? `Catalog cart: ${message.cart?.product_items.length ?? 0} product lines`
            : (message.text ?? null),
        cart: message.cart ? JSON.parse(JSON.stringify(message.cart)) : null,
        buttonReplyId: message.buttonReplyId ?? null,
        buttonReplyTitle: message.buttonReplyTitle ?? null,
        imageId: message.imageId ?? null,
        imageCaption: message.imageCaption ?? null,
        imageUrl: event?.kind === "photo" ? event.url : null,
        customerSentAt: message.customerSentAt ?? null,
      },
    });
    if (!error) return true;
    // Postgres unique_violation — Meta redelivered an id we've already logged.
    if (error.code === "23505") return false;
    console.error("recordInboundIfNew failed", error);
    return true;
  } catch (err) {
    console.error("recordInboundIfNew failed", err);
    return true;
  }
}

/** Delivery callbacks are observational only: they never mutate a session or
 * trigger a reply. The unique key makes Meta retries harmless. */
async function recordDeliveryStatuses(envelope: WebhookEnvelope): Promise<void> {
  const statuses = extractDeliveryStatuses(envelope);
  if (!statuses.length) return;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("wa_message_statuses").upsert(
      statuses.map((status) => ({
        wa_message_id: status.waMessageId,
        session_key: status.recipientId ? waSessionKey(status.recipientId) : null,
        status: status.status,
        event_at: status.eventAt,
        details: status.details as Json,
      })),
      { onConflict: "wa_message_id,status,event_at", ignoreDuplicates: true },
    );
    if (error) console.error("recordDeliveryStatuses failed", error);
  } catch (error) {
    // A status-audit outage must not make Meta retry the whole webhook and
    // delay unrelated inbound customer messages in the same envelope.
    console.error("recordDeliveryStatuses failed", error);
  }
}

async function toInboundEvent(message: InboundMessage): Promise<InboundEvent> {
  if (message.kind === "order" && message.cart) return { kind: "order", cart: message.cart };
  if (message.kind === "text" && message.text)
    return {
      kind: "text",
      text: message.text,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.referredProductId ? { referredProductId: message.referredProductId } : {}),
    };
  if (message.kind === "interactive" && message.buttonReplyId) {
    return { kind: "button", id: message.buttonReplyId };
  }
  if (message.kind === "image" && message.imageId) {
    const url = await receiveRoomPhoto(message.imageId);
    if (!url) return { kind: "photo_error" };
    return { kind: "photo", url, caption: message.imageCaption };
  }
  return { kind: "unsupported" };
}

/** Logs an outbound send the same way recordInboundIfNew logs an inbound
 * one — never throws, since a missed audit-log row is not a reason to have
 * failed the send that already went out. */
async function logOutbound(waMessageId: string, sessionKey: string, turn: WaTurn): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("wa_messages").insert({
      wa_message_id: waMessageId,
      direction: "outbound",
      session_key: sessionKey,
      kind:
        turn.kind === "document"
          ? "document"
          : turn.kind === "text"
            ? "text"
            : turn.kind === "product"
              ? "image"
              : "interactive",
      payload:
        turn.kind === "document"
          ? { filename: turn.filename, caption: turn.caption, reference: turn.reference }
          : turn.kind === "product"
            ? { imageUrl: turn.imageUrl, caption: turn.caption }
            : {
                text: turn.text,
                ...(turn.kind === "buttons" && turn.imageUrl ? { imageUrl: turn.imageUrl } : {}),
              },
    });
    if (error) console.error("logOutbound failed", error);
  } catch (err) {
    console.error("logOutbound failed", err);
  }
}

/** How recent counts as "just sent this" — long enough to catch a genuine
 * double-dispatch (confirmed live: the same confirmation text sent as two
 * separate WhatsApp messages roughly a second apart, from a single inbound
 * message with no webhook redelivery visible in the log — the exact
 * mechanism wasn't pinned down by tracing the code, so this guards the one
 * place that actually matters regardless of cause), short enough to never
 * block a customer legitimately asking for the same thing again minutes
 * later. */
const DUPLICATE_SEND_WINDOW_MS = 15 * 1000;

/** True when the exact same outbound content was already logged for this
 * session within the last few seconds — checked against wa_messages
 * itself, the same source of truth recordInboundIfNew already trusts for
 * inbound idempotency, rather than trying to reason about why a second
 * send might happen. Fails open (never blocks a real send) on any error,
 * matching this codebase's resilience stance everywhere else. */
async function wasJustSent(sessionKey: string, turn: WaTurn): Promise<boolean> {
  if (turn.kind !== "text" && turn.kind !== "buttons") return false;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("wa_messages")
      .select("kind, payload, created_at")
      .eq("session_key", sessionKey)
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return false;

    const last = data as { kind: string; payload: { text?: unknown }; created_at: string };
    const expectedKind = turn.kind === "buttons" ? "interactive" : "text";
    if (last.kind !== expectedKind || last.payload?.text !== turn.text) return false;

    const elapsed = Date.now() - new Date(last.created_at).getTime();
    return elapsed >= 0 && elapsed < DUPLICATE_SEND_WINDOW_MS;
  } catch (err) {
    console.error("wasJustSent failed", err);
    return false;
  }
}

async function deliver(to: string, sessionKey: string, turns: WaTurn[]): Promise<void> {
  for (const turn of turns) {
    try {
      if (await wasJustSent(sessionKey, turn)) {
        console.warn("deliver: skipping a duplicate send", { sessionKey, kind: turn.kind });
        continue;
      }
      const waMessageId =
        turn.kind === "catalog"
          ? await sendCatalog(to, turn.text)
          : turn.kind === "document"
            ? await sendDocument(to, turn.bytes, turn.filename, turn.caption)
            : turn.kind === "buttons"
              ? await sendButtons(to, toWhatsAppMarkdown(turn.text), turn.action, turn.imageUrl)
              : turn.kind === "list"
                ? await sendList(to, toWhatsAppMarkdown(turn.text), turn.action)
                : turn.kind === "product"
                  ? await sendImage(to, turn.imageUrl, toWhatsAppMarkdown(turn.caption))
                  : await sendText(to, toWhatsAppMarkdown(turn.text));
      await logOutbound(waMessageId, sessionKey, turn);
    } catch (err) {
      // One turn failing to send (e.g. a rejected token) shouldn't stop the
      // rest of the reply, and must never bubble up into a non-200 ack.
      console.error("WhatsApp outbound send failed", err);
      if (turn.kind === "catalog") {
        try {
          await sendText(
            to,
            "I couldn’t open the catalog just now. Tell me what you’re looking for and I’ll show you the products here.",
          );
        } catch {
          /* Provider outage is recorded above. */
        }
        break;
      }
      if (turn.kind === "document") {
        try {
          await sendText(
            to,
            "Sorry, the PDF couldn't be delivered. Please ask for it again in a moment. Your plan is unchanged.",
          );
        } catch {
          /* Existing delivery-status monitoring handles provider outages. */
        }
        break; // Do not send a success/follow-up CTA after a failed attachment.
      }
      if (turn.kind === "buttons" && turn.imageUrl) {
        try {
          await sendText(
            to,
            "I couldn’t display the saved photo, so I haven’t asked you to start. Please send the room photo again.",
          );
        } catch {
          /* Existing delivery-status monitoring handles provider outages. */
        }
        break; // The photo and Start button are one atomic interactive message.
      }
    }
  }
}

async function handleReceive(request: Request): Promise<Response> {
  const rawBody = await request.text();

  const signature = request.headers.get("x-hub-signature-256");
  if (!verifySignature(rawBody, signature)) {
    console.error("WhatsApp webhook: signature mismatch, rejecting");
    return new Response("Unauthorized", { status: 401 });
  }

  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody) as WebhookEnvelope;
  } catch {
    // Signature verified but body isn't JSON — ack anyway so Meta doesn't
    // treat this as a delivery failure and retry forever.
    return new Response("OK", { status: 200 });
  }

  const contactNames = extractContactNames(envelope);
  await recordDeliveryStatuses(envelope);

  for (const message of extractMessages(envelope)) {
    const sessionKey = waSessionKey(message.from);
    // Best effort and deliberately before media resolution/queueing: show
    // acknowledgement as soon as the signed event has been accepted.
    try {
      await markReadAndType(message.waMessageId, !(await staffHandling(sessionKey)));
    } catch (err) {
      console.error("WhatsApp read/typing update failed", err);
    }

    const event = await toInboundEvent(message);
    try {
      const customerName = contactNames.get(message.from);
      const enqueued = await enqueueInboundJob({
        waMessageId: message.waMessageId,
        sessionKey,
        phone: message.from,
        event,
        audit: {
          kind: message.kind,
          payload: {
            text:
              message.kind === "order"
                ? `Catalog cart: ${message.cart?.product_items.length ?? 0} product lines`
                : (message.text ?? null),
            cart: message.cart ? JSON.parse(JSON.stringify(message.cart)) : null,
            buttonReplyId: message.buttonReplyId ?? null,
            buttonReplyTitle: message.buttonReplyTitle ?? null,
            imageId: message.imageId ?? null,
            imageCaption: message.imageCaption ?? null,
            imageUrl: event.kind === "photo" ? event.url : null,
            customerSentAt: message.customerSentAt ?? null,
          },
        },
        ...(customerName ? { customerName } : {}),
      });
      if (!enqueued) continue;

      // Usually wakes a separate invocation and returns quickly. Local or
      // temporarily unconfigured environments drain inline to preserve the
      // pre-queue behavior instead of leaving the customer waiting forever.
      if (!(await triggerInboundWorker())) {
        const { runInboundBatch } = await import("@/lib/wa-inbound-worker.server");
        await runInboundBatch();
      }
    } catch (error) {
      // Migration/env compatibility fallback. The atomic RPC cannot partially
      // commit, so the old idempotency insert is safe to use after it fails.
      console.error("WhatsApp inbound enqueue failed; processing inline", error);
      if (!(await recordInboundIfNew(message, sessionKey, event))) {
        // The RPC may have committed even if its response was lost. Wake the
        // queue once more before treating this as an ordinary Meta retry.
        await triggerInboundWorker();
        continue;
      }
      if (await tooManyInboundMessages(sessionKey)) continue;
      const customerName = contactNames.get(message.from);
      await processQueuedInbound({
        sessionKey,
        phone: message.from,
        waMessageId: message.waMessageId,
        event,
        ...(customerName ? { customerName } : {}),
      });
    }
  }

  return new Response("OK", { status: 200 });
}

/** The existing conversation behavior, now called by the FIFO worker. */
export async function processQueuedInbound(input: {
  sessionKey: string;
  phone: string;
  waMessageId: string;
  event: InboundEvent;
  customerName?: string;
}): Promise<void> {
  // Consent commands take precedence even during staff takeover.
  if (input.event.kind === "text") {
    const { contactPreference, setContactPreference } =
      await import("@/lib/wa-contact-preferences.server");
    const preference = contactPreference(input.event.text);
    if (preference !== null) {
      await setContactPreference(input.sessionKey, preference);
      if (!preference)
        await deliver(input.phone, input.sessionKey, [
          {
            kind: "text",
            text: "WhatsApp messages are enabled again. Type menu to continue. You can type STOP at any time.",
          },
        ]);
      return;
    }
  }
  // Inbound messages are already durably logged. Staff mode leaves the salon
  // plan untouched and keeps all follow-ups visible in the shared timeline.
  if (input.event.kind === "order") {
    const { receiveCatalogCart } = await import("@/lib/wa-catalog.server");
    const session = await loadSession(input.sessionKey);
    await saveSession(input.sessionKey, {
      ...session,
      customerName: input.customerName ?? session.customerName,
      phoneLast4: input.phone.replace(/\D/g, "").slice(-4),
    });
    await deliver(
      input.phone,
      input.sessionKey,
      await receiveCatalogCart({ ...input, cart: input.event.cart }),
    );
    return;
  }
  if (await staffHandling(input.sessionKey)) {
    await touchStaffRequest(input.sessionKey);
    return;
  }
  const { withManagedCatalog } = await import("@/lib/managed-catalog.server");
  return withManagedCatalog(() => processCatalogInbound(input));
}

async function processCatalogInbound(input: {
  sessionKey: string;
  phone: string;
  waMessageId: string;
  event: InboundEvent;
  customerName?: string;
}): Promise<void> {
  if (input.event.kind === "photo_error") {
    await deliver(input.phone, input.sessionKey, [
      { kind: "text", text: "I couldn't quite read that photo. Could you try sending it again?" },
    ]);
    return;
  }

  if (
    (input.event.kind === "button" && input.event.id === "nav:catalog") ||
    (input.event.kind === "text" &&
      /^(?:catalog|catalogue|browse catalog|browse catalogue|shop products)$/i.test(
        input.event.text.trim(),
      ))
  ) {
    const { catalogTurn } = await import("@/lib/wa-catalog.server");
    await deliver(input.phone, input.sessionKey, [await catalogTurn()]);
    return;
  }

  const session = await loadSession(
    input.sessionKey,
    process.env["WA_SHOPPING_AGENT_ENABLED"] === "true",
  );
  try {
    if (process.env["WA_SHOPPING_AGENT_ENABLED"] === "true") {
      const { handleConversation } = await import("@/lib/wa-conversation.server");
      const result = await handleConversation(input, session);
      await saveSession(
        input.sessionKey,
        {
          ...result.session,
          customerName: input.customerName ?? result.session.customerName,
          phoneLast4: input.phone.replace(/\D/g, "").slice(-4),
        },
        true,
      );
      if (!(await staffHandling(input.sessionKey)))
        await deliver(input.phone, input.sessionKey, result.turns);
      return;
    }
    // Rollback path only. Enabled conversations have one controller above.
    const documentTurns = await handleDocumentInbound(session, input.event, input.waMessageId);
    const requestTurns =
      documentTurns ??
      (await handleRequestInbound({
        ...input,
        salesIntakeActive: Boolean(
          session.flow.awaiting || session.pendingQuote || session.rolePicker,
        ),
      }));
    // Legacy handoffs silently stopped the bot without assigning a human.
    // The new request inbox is explicit, persisted and never freezes shopping.
    const activeSession = { ...session, handoff: false };
    const result = requestTurns
      ? { session: activeSession, turns: requestTurns }
      : await handleInboundMessage(activeSession, input.sessionKey, input.phone, input.event);
    if (
      result.turns.some((t) => t.kind === "buttons" && t.action.buttons.some((b) => b.id === "ask"))
    ) {
      const { catalogTurn } = await import("@/lib/wa-catalog.server");
      if ((await catalogTurn()).kind === "catalog") {
        for (const turn of result.turns)
          if (turn.kind === "buttons")
            turn.action.buttons = turn.action.buttons.map((b) =>
              b.id === "ask" ? { id: "nav:catalog", title: "Browse catalog" } : b,
            );
      }
    }
    if (requestTurns) {
      const userText =
        input.event.kind === "text"
          ? input.event.text
          : input.event.kind === "button"
            ? input.event.id
            : "Customer supplied a photo";
      const replyText = requestTurns
        .map((turn) => ("text" in turn ? turn.text : "caption" in turn ? turn.caption : ""))
        .filter(Boolean)
        .join("\n");
      result.session = {
        ...result.session,
        transcript: [
          ...result.session.transcript,
          { role: "user" as const, content: userText },
          { role: "assistant" as const, content: replyText },
        ].slice(-24),
      };
    }
    const digits = input.phone.replace(/\D/g, "");
    await saveSession(input.sessionKey, {
      ...result.session,
      customerName: input.customerName ?? result.session.customerName,
      phoneLast4: digits ? digits.slice(-4) : result.session.phoneLast4,
    });
    if (!(await staffHandling(input.sessionKey)))
      await deliver(input.phone, input.sessionKey, result.turns);
  } catch (error) {
    console.error("wa-runtime dispatch failed", error);
    if (await staffHandling(input.sessionKey)) return;
    await deliver(input.phone, input.sessionKey, [
      { kind: "text", text: "Sorry, something went wrong on our end. Try that again?" },
    ]);
  }
}

export async function handleWhatsAppWebhook(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") return handleVerify(url);
  if (request.method === "POST") return handleReceive(request);
  return new Response("Method Not Allowed", { status: 405 });
}
