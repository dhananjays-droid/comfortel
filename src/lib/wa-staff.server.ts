import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptPhone } from "@/lib/wa-phone-crypto.server";
import { waSessionKey } from "@/lib/wa-session.server";
import { sendStaffText, WaClientError } from "@/lib/wa-client.server";
import { replyWindow, type StaffMessage, type StaffReply } from "@/lib/wa-staff";

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });
const publicRequest = (status: string) => ["open", "in_progress", "resolved"].includes(status);

export async function staffHandling(sessionKey: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("wa_staff_conversations")
    .select("manual_mode")
    .eq("session_key", sessionKey)
    .maybeSingle();
  // Safe rollout before the isolated migration; all other outages fail closed.
  if (error && ["42P01", "PGRST205"].includes(error.code)) return false;
  if (error) throw new Error("Could not check staff conversation control");
  return data?.manual_mode === true;
}

async function requestByReference(reference: string) {
  const { data, error } = await supabaseAdmin
    .from("wa_requests")
    .select("reference,session_key,status,customer_phone_enc")
    .eq("reference", reference)
    .maybeSingle();
  if (error) throw new Error("Request lookup unavailable");
  return data && publicRequest(data.status) ? data : null;
}

/** Keep a customer's staff follow-up visible in the active inbox, including
 * a follow-up after staff marked the latest ticket resolved. No bot reply. */
export async function touchStaffRequest(sessionKey: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("wa_requests")
    .select("reference,status")
    .eq("session_key", sessionKey)
    .in("status", ["open", "in_progress", "resolved"])
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("Could not update staff inbox activity");
  if (!data) return;
  const update = await supabaseAdmin
    .from("wa_requests")
    .update({
      updated_at: new Date().toISOString(),
      ...(data.status === "resolved" ? { status: "open" } : {}),
    })
    .eq("reference", data.reference);
  if (update.error) throw new Error("Could not save staff inbox activity");
}

async function windowMessages(sessionKey: string): Promise<StaffMessage[]> {
  const { data, error } = await supabaseAdmin
    .from("wa_messages")
    .select("wa_message_id,direction,kind,payload,created_at")
    .eq("session_key", sessionKey)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error("Cannot verify WhatsApp reply window");
  return (data ?? []) as unknown as StaffMessage[];
}

export async function staffThread(reference: string): Promise<Response> {
  const record = await requestByReference(reference);
  if (!record) return json({ error: "Request not found" }, 404);
  const key = record.session_key;
  const [manualMode, incoming, messages, replies, statuses, identity] = await Promise.all([
    staffHandling(key),
    windowMessages(key),
    supabaseAdmin
      .from("wa_messages")
      .select("wa_message_id,direction,kind,payload,created_at")
      .eq("session_key", key)
      .order("created_at", { ascending: false })
      .limit(200),
    supabaseAdmin
      .from("wa_staff_replies")
      .select("*")
      .eq("session_key", key)
      .order("created_at", { ascending: false })
      .limit(100),
    supabaseAdmin
      .from("wa_message_statuses")
      .select("wa_message_id,status,event_at")
      .eq("session_key", key)
      .order("event_at", { ascending: false })
      .limit(500),
    supabaseAdmin.from("sessions").select("customer_name").eq("session_key", key).maybeSingle(),
  ]);
  if (messages.error || replies.error || statuses.error || identity.error)
    return json({ error: "Conversation unavailable. Check the staff inbox migration." }, 503);
  return json({
    manualMode,
    customerName: identity.data?.customer_name ?? null,
    messages: messages.data ?? [],
    replies: replies.data ?? [],
    statuses: statuses.data ?? [],
    ...replyWindow(incoming),
  });
}

export async function setStaffMode(reference: string, manualMode: boolean): Promise<Response> {
  const record = await requestByReference(reference);
  if (!record) return json({ error: "Request not found" }, 404);
  const { data, error } = await supabaseAdmin.rpc("set_wa_staff_mode", {
    p_session_key: record.session_key,
    p_manual_mode: manualMode,
  });
  return error
    ? json({ error: "Could not save conversation control" }, 503)
    : data
      ? json({ manualMode })
      : json({ error: "A reply is still sending. Wait before returning to the bot." }, 409);
}

export type ReplyDependencies = {
  request: typeof requestByReference;
  manual: typeof staffHandling;
  incoming: typeof windowMessages;
  find(id: string): Promise<StaffReply | null>;
  claim(reply: {
    id: string;
    request_reference: string;
    session_key: string;
    body: string;
  }): Promise<boolean>;
  finish(
    id: string,
    state: StaffReply["state"],
    messageId: string | null,
    error: string | null,
  ): Promise<void>;
  phone(cipher: string): string;
  key(phone: string): string;
  send(phone: string, text: string): Promise<string>;
  log(id: string, key: string, body: string, reference: string): Promise<void>;
};

const deps: ReplyDependencies = {
  request: requestByReference,
  manual: staffHandling,
  incoming: windowMessages,
  async find(id) {
    const { data, error } = await supabaseAdmin
      .from("wa_staff_replies")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error("Reply audit unavailable");
    return data as StaffReply | null;
  },
  async claim(reply) {
    const { data, error } = await supabaseAdmin.rpc("claim_wa_staff_reply", {
      p_id: reply.id,
      p_reference: reply.request_reference,
      p_session_key: reply.session_key,
      p_body: reply.body,
    });
    if (error) throw new Error("Could not record reply before sending");
    return data === true;
  },
  async finish(id, state, messageId, message) {
    const { error } = await supabaseAdmin
      .from("wa_staff_replies")
      .update({
        state,
        wa_message_id: messageId,
        error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);
    if (error) throw new Error("Reply audit update unavailable");
  },
  phone: decryptPhone,
  key: waSessionKey,
  send: sendStaffText,
  async log(id, key, body, reference) {
    const { error } = await supabaseAdmin.from("wa_messages").upsert(
      {
        wa_message_id: id,
        session_key: key,
        direction: "outbound",
        kind: "text",
        payload: { text: body, sender: "staff", requestReference: reference },
      },
      { onConflict: "wa_message_id", ignoreDuplicates: true },
    );
    if (error) console.error("Staff reply timeline mirror failed", { code: error.code });
  },
};

/** No user-provided phone/session destination. Idempotency covers double-clicks,
 * network retries and concurrent duplicate requests across server instances. */
export async function replyToRequest(
  input: { reference: string; id: string; body: string },
  db = deps,
): Promise<Response> {
  const { reference, id, body } = input;
  if (
    !/^CF-[A-F0-9]{16}$/.test(reference) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id) ||
    !body.trim() ||
    body.length > 4000
  )
    return json(
      { error: "A valid request, reply ID and message (1–4000 characters) are required" },
      400,
    );
  const record = await db.request(reference);
  if (!record) return json({ error: "Request not found" }, 404);
  const existing = await db.find(id);
  if (existing) {
    if (
      existing.request_reference !== reference ||
      existing.session_key !== record.session_key ||
      existing.body !== body
    )
      return json({ error: "Reply ID already belongs to another message" }, 409);
    return json({ reply: existing }, existing.state === "sending" ? 202 : 200);
  }
  if (!(await db.manual(record.session_key)))
    return json({ error: "Take over this conversation before replying" }, 409);
  if (!replyWindow(await db.incoming(record.session_key)).canReply)
    return json(
      {
        error:
          "Free-text reply unavailable. A new customer message or an approved WhatsApp template is required.",
      },
      409,
    );
  const phone = db.phone(record.customer_phone_enc);
  if (db.key(phone) !== record.session_key)
    return json({ error: "Customer contact could not be verified" }, 409);
  if (
    !(await db.claim({ id, request_reference: reference, session_key: record.session_key, body }))
  )
    return json(
      { error: "This reply is already being processed. Check its status before sending another." },
      409,
    );
  let messageId: string;
  try {
    messageId = await db.send(phone, body);
  } catch (error) {
    const rejected = error instanceof WaClientError && error.status >= 400 && error.status < 500;
    const state = rejected ? "failed" : "unknown";
    const detail = rejected
      ? "WhatsApp rejected this reply. Check the reply window and account configuration before trying again."
      : "Send outcome is unknown. Check WhatsApp before composing a replacement; this message will not be resent automatically.";
    await db.finish(id, state, null, detail);
    return json({ reply: { id, state, error: detail } });
  }
  // If persistence fails after Meta accepted, never resend. The durable claim
  // remains visible as sending/unknown and the response includes the Meta ID.
  try {
    await db.finish(id, "accepted", messageId, null);
  } catch {
    return json({
      reply: {
        id,
        state: "unknown",
        wa_message_id: messageId,
        error: "WhatsApp accepted the message, but the audit update failed. Do not resend.",
      },
    });
  }
  try {
    await db.log(messageId, record.session_key, body, reference);
  } catch {
    /* canonical reply is saved */
  }
  return json({ reply: { id, state: "accepted", wa_message_id: messageId } });
}
