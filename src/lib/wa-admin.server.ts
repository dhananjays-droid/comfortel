/**
 * A developer-facing status endpoint: recent render job history and recent
 * message flow, so a real production issue ("the render never arrived") can
 * be diagnosed by looking at what actually happened, not by guessing at
 * Vercel logs or re-testing blind.
 *
 * Same bearer-token convention as the render worker — reuses CRON_SECRET
 * rather than adding a new secret, since both are "only the developer should
 * be able to call this."
 *
 * Never exposes the customer's phone number: wa_render_jobs.customer_phone_enc
 * is deliberately omitted from the response (see wa-phone-crypto.server.ts) —
 * this is a diagnostic tool, not a reason to widen where PII is readable.
 */

import { timingSafeEqual } from "node:crypto";

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function authenticated(request: Request): boolean {
  const secret = process.env["CRON_SECRET"];
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return timingSafeEqualStrings(header, `Bearer ${secret}`);
}

export type WaMessageRow = {
  wa_message_id: string;
  direction: "inbound" | "outbound";
  session_key: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
};

type WaJobRow = {
  session_key: string;
  status: string;
  mode: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type LatestJob = {
  status: string;
  mode: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type SessionSummary = {
  sessionKey: string;
  lastActivity: string;
  messageCount: number;
  lastMessagePreview: string;
  hasError: boolean;
  latestJob: LatestJob | null;
};

/** A one-line, human-readable gist of a message row — the raw payload shape
 * differs by kind, and a developer scanning a feed of hundreds of these
 * needs to recognise what happened at a glance, not parse JSON. */
export function previewOf(m: WaMessageRow): string {
  const arrow = m.direction === "inbound" ? "→" : "←"; // → customer said / ← bot said
  if (m.kind === "text") {
    const text = typeof m.payload["text"] === "string" ? (m.payload["text"] as string) : "";
    return `${arrow} ${text.slice(0, 100)}`;
  }
  if (m.kind === "image") {
    const caption =
      typeof m.payload["caption"] === "string" ? (m.payload["caption"] as string) : "";
    return `${arrow} [image] ${caption.split("\n")[0]?.slice(0, 70) ?? ""}`;
  }
  if (m.kind === "interactive") {
    const buttonReplyId =
      typeof m.payload["buttonReplyId"] === "string"
        ? (m.payload["buttonReplyId"] as string)
        : null;
    const text = typeof m.payload["text"] === "string" ? (m.payload["text"] as string) : "";
    return buttonReplyId ? `${arrow} [tapped: ${buttonReplyId}]` : `${arrow} ${text.slice(0, 100)}`;
  }
  return `${arrow} [${m.kind}]`;
}

/**
 * One row per customer conversation instead of one row per event — with
 * 100+ concurrent customers, a raw event feed makes finding "which one hit
 * an error" a manual scan. This groups by session_key, carries the latest
 * render job's status alongside the latest message, and flags any session
 * whose latest job is failed or carries an error so it sorts to the top
 * and is visually obvious in the dashboard, without ever exposing the
 * customer's phone number (never selected here, same stance as
 * handleAdminStatus).
 */
export async function handleAdminSessions(request: Request): Promise<Response> {
  if (!authenticated(request)) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  const errorsOnly = url.searchParams.get("errors") === "1";

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Scanned over a wider recent window than the number of sessions
    // returned, since a busy session can otherwise crowd a quiet one's
    // single message out of a small limit before grouping ever happens.
    const [{ data: messages, error: messagesError }, { data: jobs, error: jobsError }] =
      await Promise.all([
        supabaseAdmin
          .from("wa_messages")
          .select("wa_message_id, direction, session_key, kind, payload, created_at")
          .order("created_at", { ascending: false })
          .limit(1000),
        supabaseAdmin
          .from("wa_render_jobs")
          .select("session_key, status, mode, error, created_at, updated_at")
          .order("created_at", { ascending: false })
          .limit(500),
      ]);

    if (messagesError || jobsError) {
      return new Response(
        JSON.stringify({ error: (messagesError ?? jobsError)?.message ?? "query failed" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    const bySession = new Map<string, SessionSummary>();
    // Newest first, so the first row seen per session is already its latest.
    for (const m of (messages ?? []) as WaMessageRow[]) {
      const existing = bySession.get(m.session_key);
      if (existing) {
        existing.messageCount++;
        continue;
      }
      bySession.set(m.session_key, {
        sessionKey: m.session_key,
        lastActivity: m.created_at,
        messageCount: 1,
        lastMessagePreview: previewOf(m),
        hasError: false,
        latestJob: null,
      });
    }

    for (const j of (jobs ?? []) as WaJobRow[]) {
      const failed = j.status === "failed" || Boolean(j.error);
      const existing = bySession.get(j.session_key);
      if (!existing) {
        bySession.set(j.session_key, {
          sessionKey: j.session_key,
          lastActivity: j.updated_at,
          messageCount: 0,
          lastMessagePreview: "",
          hasError: failed,
          latestJob: {
            status: j.status,
            mode: j.mode,
            error: j.error,
            createdAt: j.created_at,
            updatedAt: j.updated_at,
          },
        });
        continue;
      }
      if (failed) existing.hasError = true;
      if (j.updated_at > existing.lastActivity) existing.lastActivity = j.updated_at;
      // Newest-first order means the first job row seen per session is
      // already its most recent — no comparison needed to keep it that way.
      existing.latestJob ??= {
        status: j.status,
        mode: j.mode,
        error: j.error,
        createdAt: j.created_at,
        updatedAt: j.updated_at,
      };
    }

    let sessions = Array.from(bySession.values()).sort((a, b) =>
      a.lastActivity < b.lastActivity ? 1 : -1,
    );
    if (errorsOnly) sessions = sessions.filter((s) => s.hasError);

    return new Response(JSON.stringify({ sessions: sessions.slice(0, limit) }, null, 2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("handleAdminSessions failed", err);
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

export async function handleAdminStatus(request: Request): Promise<Response> {
  if (!authenticated(request)) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));
  const sessionKey = url.searchParams.get("session_key");

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let jobsQuery = supabaseAdmin
      .from("wa_render_jobs")
      .select(
        "id, session_key, status, mode, product_ids, attempt, kie_task_id, result_url, error, created_at, updated_at",
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    if (sessionKey) jobsQuery = jobsQuery.eq("session_key", sessionKey);
    const { data: jobs, error: jobsError } = await jobsQuery;

    let messagesQuery = supabaseAdmin
      .from("wa_messages")
      .select("wa_message_id, direction, session_key, kind, payload, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (sessionKey) messagesQuery = messagesQuery.eq("session_key", sessionKey);
    const { data: messages, error: messagesError } = await messagesQuery;

    if (jobsError || messagesError) {
      return new Response(
        JSON.stringify({ error: (jobsError ?? messagesError)?.message ?? "query failed" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ jobs, messages }, null, 2), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error("handleAdminStatus failed", err);
    // Safe to expose here — this endpoint is already bearer-protected and
    // developer-only, and a vague "internal error" is exactly what makes a
    // diagnostic tool useless when it's the one thing failing.
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
