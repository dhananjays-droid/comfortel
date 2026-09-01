import { createServerFn } from "@tanstack/react-start";

import { CATALOG_FULL } from "@/lib/catalog";
import {
  EMPTY_SESSION,
  isSessionKey,
  liveRoom,
  sanitizeFlow,
  sanitizePlan,
  sanitizeTranscript,
  type SessionState,
  type StoredRoom,
} from "@/lib/session";

/**
 * Load and save the conversation, server-side.
 *
 * The browser holds a key, not the state. That is the change that makes a
 * WhatsApp build possible: a webhook arrives with a phone number and nothing
 * else, derives the same kind of key, and reads the same row. Until this
 * existed, "the conversation" was a React tree that only the page that built it
 * could see.
 *
 * Failure is soft everywhere. A session store that is down should cost the
 * customer their history, not their ability to talk to the assistant — so both
 * functions degrade to an empty session rather than throwing into the UI.
 */

const resolves = (id: string) => Object.prototype.hasOwnProperty.call(CATALOG_FULL, id);

/** Rows are swept lazily: an expired one reads as absent and is overwritten. */
function isExpired(expiresAt: unknown, now = Date.now()): boolean {
  const t = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(t) && t < now;
}

export const loadSession = createServerFn({ method: "POST" })
  .validator((input: { key: string }) => {
    if (!isSessionKey(input?.key)) throw new Error("SESSION_KEY_INVALID");
    return { key: input.key };
  })
  .handler(async ({ data }): Promise<SessionState> => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: row, error } = await supabaseAdmin
        .from("sessions")
        .select("transcript, plan, flow, room_url, room_aspect, room_at, expires_at")
        .eq("session_key", data.key)
        .maybeSingle();

      if (error || !row || isExpired(row.expires_at)) return EMPTY_SESSION;

      const room = liveRoom({ url: row.room_url, aspect: row.room_aspect, at: row.room_at });
      return {
        transcript: sanitizeTranscript(row.transcript),
        plan: sanitizePlan(row.plan, resolves),
        flow: sanitizeFlow(row.flow),
        ...(room ? { room } : {}),
      };
    } catch (err) {
      // A missing table or an unconfigured Supabase should not take the chat
      // down with it — the customer gets a fresh session and can still talk.
      console.error("loadSession failed", err);
      return EMPTY_SESSION;
    }
  });

export const saveSession = createServerFn({ method: "POST" })
  .validator(
    (input: {
      key: string;
      channel?: string;
      transcript?: unknown;
      plan?: unknown;
      flow?: unknown;
      room?: unknown;
    }) => {
      if (!isSessionKey(input?.key)) throw new Error("SESSION_KEY_INVALID");
      // Everything is rebuilt rather than trusted. The payload comes from a
      // browser, so a plan line naming a product that does not exist, or a
      // transcript of ten thousand turns, has to be impossible to store.
      const room = liveRoom(input.room);
      return {
        key: input.key,
        channel: input.channel === "whatsapp" ? "whatsapp" : "web",
        transcript: sanitizeTranscript(input.transcript),
        plan: sanitizePlan(input.plan, resolves),
        flow: sanitizeFlow(input.flow),
        room,
      };
    },
  )
  .handler(async ({ data }): Promise<{ saved: boolean }> => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error } = await supabaseAdmin.from("sessions").upsert(
        {
          session_key: data.key,
          channel: data.channel,
          transcript: data.transcript,
          plan: data.plan,
          flow: data.flow,
          room_url: data.room?.url ?? null,
          room_aspect: data.room?.aspect ?? null,
          room_at: data.room?.at ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "session_key" },
      );
      if (error) {
        console.error("saveSession failed", error);
        return { saved: false };
      }
      return { saved: true };
    } catch (err) {
      console.error("saveSession failed", err);
      return { saved: false };
    }
  });

export type { SessionState, StoredRoom };
