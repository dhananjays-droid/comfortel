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

import { tooManyInboundMessages } from "@/lib/wa-rate-limit.server";
import { receiveRoomPhoto } from "@/lib/wa-media.server";
import { sendButtons, sendImage, sendList, sendText } from "@/lib/wa-client.server";
import { toWhatsAppMarkdown } from "@/lib/wa-markdown";
import { handleInboundMessage, type InboundEvent, type WaTurn } from "@/lib/wa-runtime";
import { loadSession, saveSession } from "@/lib/wa-session-store.server";
import { waSessionKey } from "@/lib/wa-session.server";

type InboundMessage = {
  waMessageId: string;
  from: string;
  kind: "text" | "interactive" | "image" | "unsupported";
  text?: string;
  buttonReplyId?: string;
  imageId?: string;
  imageCaption?: string;
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
 * Meta's webhook envelope, narrowed to what this app reads. Fields not named
 * here (statuses, contacts.profile, etc.) are ignored rather than typed.
 */
type WebhookEnvelope = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id?: string;
          from?: string;
          type?: string;
          text?: { body?: string };
          interactive?: {
            button_reply?: { id?: string };
            list_reply?: { id?: string };
          };
          image?: { id?: string; caption?: string };
        }>;
      };
    }>;
  }>;
};

function extractMessages(envelope: WebhookEnvelope): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        if (!m.id || !m.from) continue;
        const base = { waMessageId: m.id, from: m.from };
        if (m.type === "text" && m.text?.body) {
          out.push({ ...base, kind: "text", text: m.text.body });
        } else if (m.type === "interactive") {
          const id = m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id;
          if (id) out.push({ ...base, kind: "interactive", buttonReplyId: id });
          else out.push({ ...base, kind: "unsupported" });
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

/**
 * Insert-if-new against wa_messages' unique wa_message_id — Meta redelivers,
 * so a second delivery of the same id must be a silent no-op, not a second
 * reply. Returns true only for a message this call is the first to see.
 *
 * Never throws: a session-store outage here degrades to "process everything,
 * possibly twice" rather than dropping inbound traffic — the same resilience
 * stance wa-session-store.server.ts takes for load/save.
 */
async function recordInboundIfNew(message: InboundMessage, sessionKey: string): Promise<boolean> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("wa_messages").insert({
      wa_message_id: message.waMessageId,
      direction: "inbound",
      session_key: sessionKey,
      kind: message.kind,
      payload: {
        text: message.text ?? null,
        buttonReplyId: message.buttonReplyId ?? null,
        imageId: message.imageId ?? null,
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

/** Returns null only when an image genuinely couldn't be resolved (Meta's
 * media API rejected it, or it was over the size cap) — a real failure, not
 * "not implemented yet" — so the caller can tell the customer plainly. */
async function toInboundEvent(message: InboundMessage): Promise<InboundEvent | null> {
  if (message.kind === "text" && message.text) return { kind: "text", text: message.text };
  if (message.kind === "interactive" && message.buttonReplyId) {
    return { kind: "button", id: message.buttonReplyId };
  }
  if (message.kind === "image" && message.imageId) {
    const url = await receiveRoomPhoto(message.imageId);
    if (!url) return null;
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
      kind: turn.kind === "text" ? "text" : turn.kind === "product" ? "image" : "interactive",
      payload:
        turn.kind === "product"
          ? { imageUrl: turn.imageUrl, caption: turn.caption }
          : { text: turn.text },
    });
    if (error) console.error("logOutbound failed", error);
  } catch (err) {
    console.error("logOutbound failed", err);
  }
}

async function deliver(to: string, sessionKey: string, turns: WaTurn[]): Promise<void> {
  for (const turn of turns) {
    try {
      const waMessageId =
        turn.kind === "buttons"
          ? await sendButtons(to, toWhatsAppMarkdown(turn.text), turn.action)
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

  for (const message of extractMessages(envelope)) {
    const sessionKey = waSessionKey(message.from);
    const isNew = await recordInboundIfNew(message, sessionKey);
    if (!isNew) continue;

    // Checked before doing any real work (including resolving a photo,
    // which is its own Graph API round trip) — a flood gets dropped
    // silently rather than answered, since replying to it also bills a
    // conversation under WhatsApp's per-message pricing (plan §10).
    if (await tooManyInboundMessages(sessionKey)) {
      console.warn("WhatsApp rate limit: too many inbound messages", { sessionKey });
      continue;
    }

    const event = await toInboundEvent(message);
    if (!event) {
      await deliver(message.from, sessionKey, [
        {
          kind: "text",
          text: "I couldn't quite read that photo — could you try sending it again?",
        },
      ]);
      continue;
    }

    try {
      const session = await loadSession(sessionKey);
      const result = await handleInboundMessage(session, sessionKey, message.from, event);
      await saveSession(sessionKey, result.session);
      await deliver(message.from, sessionKey, result.turns);
    } catch (err) {
      console.error("wa-runtime dispatch failed", err);
      await deliver(message.from, sessionKey, [
        { kind: "text", text: "Sorry — something went wrong on our end. Try that again?" },
      ]);
    }
  }

  return new Response("OK", { status: 200 });
}

export async function handleWhatsAppWebhook(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") return handleVerify(url);
  if (request.method === "POST") return handleReceive(request);
  return new Response("Method Not Allowed", { status: 405 });
}
