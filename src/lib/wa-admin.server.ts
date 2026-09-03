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
    return new Response(JSON.stringify({ error: "internal error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}
