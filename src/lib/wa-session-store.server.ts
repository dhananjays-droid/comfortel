/**
 * Session persistence, keyed by `waSessionKey()`'s HMAC — never by the phone
 * number itself.
 *
 * Deliberately NOT a `createServerFn`: those are client-callable RPC
 * endpoints, and a session load/save that trusts whatever `sessionKey` the
 * caller supplies has no business being reachable from the browser — that
 * would let anyone who learns or brute-forces a session key read or overwrite
 * a stranger's conversation. This module is called only from other
 * server-only code (`wa-runtime.ts`, `wa-webhook.server.ts`,
 * `wa-render-worker.server.ts`), which itself is only ever reached from
 * `src/server.ts`'s `fetch()`, never from a client-invokable route.
 *
 * Same dynamic-import-inside-the-function convention as
 * `visualize.functions.ts`/`design.functions.ts` use for `supabaseAdmin`.
 */

import { EMPTY_SESSION, sanitizeSession, type SessionState } from "@/lib/wa-session";

type SessionRow = {
  transcript: unknown;
  plan: unknown;
  flow: unknown;
  room_url: string | null;
  room_at: string | null;
  room_spec_wall_cm: number | null;
  room_spec_depth_cm: number | null;
  offered: unknown;
  pending_zone_render: boolean;
  pending_quote: unknown;
  handoff: boolean;
  customer_name: string | null;
  phone_last4: string | null;
};

/** Transient Supabase blips shouldn't cost a customer their whole
 * conversation history — retried a couple of times, with a short backoff,
 * matching enqueueRenderJob's pattern, before this falls open to a fresh
 * session. A real production incident: a missing column (a migration that
 * hadn't been applied yet) made every single load fail and silently reset
 * every active conversation to brand-new, mid-chat, on every turn — that
 * specific case a retry can't fix, but an ordinary one-off network or
 * rate-limit blip is exactly what this guards against. */
const MAX_LOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Never throws. A session-store outage degrades the conversation to
 * stateless — same resilience stance as `visualizeStart`'s cache read/write —
 * it must never be the reason a reply doesn't go out. That fallback is only
 * ever correct for a genuinely new customer (no row exists yet); for an
 * existing session it means real history — the plan, the room photo,
 * everything — gets silently wiped, so an actual query error is retried
 * before this gives up and treats the customer as brand new.
 */
export async function loadSession(sessionKey: string): Promise<SessionState> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_LOAD_ATTEMPTS; attempt++) {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data, error } = await supabaseAdmin
        .from("sessions")
        .select(
          "transcript, plan, flow, room_url, room_at, room_spec_wall_cm, room_spec_depth_cm, offered, pending_zone_render, pending_quote, handoff, customer_name, phone_last4",
        )
        .eq("session_key", sessionKey)
        .maybeSingle();
      if (error) throw error;
      if (!data) return { ...EMPTY_SESSION }; // genuinely a new customer — no retry needed
      return sessionFromRow(data as SessionRow);
    } catch (err) {
      lastError = err;
      console.error(`loadSession: attempt ${attempt}/${MAX_LOAD_ATTEMPTS} failed`, err);
      if (attempt < MAX_LOAD_ATTEMPTS) await delay(RETRY_DELAY_MS * attempt);
    }
  }
  console.error("loadSession: all attempts failed, falling back to a fresh session", lastError);
  return { ...EMPTY_SESSION };
}

function sessionFromRow(row: SessionRow): SessionState {
  const room = row.room_url
    ? { url: row.room_url, at: row.room_at ? new Date(row.room_at).getTime() : Date.now() }
    : null;
  const roomSpec = row.room_spec_wall_cm
    ? { wallCm: row.room_spec_wall_cm, depthCm: row.room_spec_depth_cm ?? undefined }
    : null;

  return sanitizeSession({
    transcript: row.transcript,
    plan: row.plan,
    flow: row.flow,
    roomSpec,
    room,
    offered: row.offered,
    pendingZoneRender: row.pending_zone_render,
    pendingQuote: row.pending_quote,
    handoff: row.handoff,
    customerName: row.customer_name,
    phoneLast4: row.phone_last4,
  });
}

/** Never throws, for the same reason `loadSession` never throws. */
export async function saveSession(sessionKey: string, session: SessionState): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const clean = sanitizeSession(session);
    const { error } = await supabaseAdmin.from("sessions").upsert(
      {
        session_key: sessionKey,
        transcript: clean.transcript,
        plan: clean.plan,
        flow: clean.flow,
        room_url: clean.room?.url ?? null,
        room_at: clean.room ? new Date(clean.room.at).toISOString() : null,
        room_spec_wall_cm: clean.roomSpec?.wallCm ?? null,
        room_spec_depth_cm: clean.roomSpec?.depthCm ?? null,
        offered: clean.offered,
        pending_zone_render: clean.pendingZoneRender,
        pending_quote: clean.pendingQuote,
        handoff: clean.handoff,
        customer_name: clean.customerName,
        phone_last4: clean.phoneLast4,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_key" },
    );
    if (error) console.error("saveSession failed", error);
  } catch (err) {
    console.error("saveSession failed", err);
  }
}
