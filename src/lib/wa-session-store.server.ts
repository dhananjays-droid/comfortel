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
  handoff: boolean;
};

/**
 * Never throws. A session-store outage degrades the conversation to
 * stateless — same resilience stance as `visualizeStart`'s cache read/write —
 * it must never be the reason a reply doesn't go out.
 */
export async function loadSession(sessionKey: string): Promise<SessionState> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("sessions")
      .select(
        "transcript, plan, flow, room_url, room_at, room_spec_wall_cm, room_spec_depth_cm, offered, pending_zone_render, handoff",
      )
      .eq("session_key", sessionKey)
      .maybeSingle();
    if (error || !data) return { ...EMPTY_SESSION };

    const row = data as SessionRow;
    const room = row.room_url
      ? { url: row.room_url, at: row.room_at ? new Date(row.room_at).getTime() : Date.now() }
      : null;
    const roomSpec = row.room_spec_wall_cm
      ? {
          wallCm: row.room_spec_wall_cm,
          depthCm: row.room_spec_depth_cm ?? undefined,
        }
      : null;

    return sanitizeSession({
      transcript: row.transcript,
      plan: row.plan,
      flow: row.flow,
      roomSpec,
      room,
      offered: row.offered,
      pendingZoneRender: row.pending_zone_render,
      handoff: row.handoff,
    });
  } catch (err) {
    console.error("loadSession failed", err);
    return { ...EMPTY_SESSION };
  }
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
        handoff: clean.handoff,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_key" },
    );
    if (error) console.error("saveSession failed", error);
  } catch (err) {
    console.error("saveSession failed", err);
  }
}
