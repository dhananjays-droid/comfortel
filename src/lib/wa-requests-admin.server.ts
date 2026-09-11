import { authenticated } from "@/lib/wa-admin.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { decryptPhone } from "@/lib/wa-phone-crypto.server";
import { replyToRequest, setStaffMode, staffThread } from "@/lib/wa-staff.server";

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } });

export async function handleAdminRequests(request: Request): Promise<Response> {
  if (!authenticated(request)) return json({ error: "Unauthorized" }, 401);
  try {
    return await handleAuthenticated(request);
  } catch {
    return json(
      { error: "Request service unavailable. Refresh before retrying an uncertain send." },
      503,
    );
  }
}

async function handleAuthenticated(request: Request): Promise<Response> {
  if (request.method === "GET") {
    const url = new URL(request.url);
    const reference = url.searchParams.get("reference");
    if (reference && !/^CF-[A-F0-9]{16}$/.test(reference))
      return json({ error: "Invalid request reference" }, 400);
    if (reference && url.searchParams.get("thread") === "1") return staffThread(reference);
    // Phone is revealed only after an explicit staff action for one request.
    if (reference && url.searchParams.get("contact") === "1") {
      const { data, error } = await supabaseAdmin
        .from("wa_requests")
        .select("customer_phone_enc,status")
        .eq("reference", reference)
        .single();
      if (error || !data || data.status === "draft" || data.status === "cancelled")
        return json({ error: "Request not available" }, 404);
      return json({ phone: decryptPhone(data.customer_phone_enc) });
    }
    const { data, error } = await supabaseAdmin
      .from("wa_requests")
      .select("reference,session_key,category,status,stage,details,created_at,updated_at")
      .neq("status", "draft")
      .neq("status", "cancelled")
      .order("updated_at", { ascending: false })
      .limit(200);
    return error ? json({ error: "Could not load requests" }, 503) : json({ requests: data });
  }
  if (request.method === "POST") {
    const raw = await request.text();
    if (raw.length > 30000) return json({ error: "Reply is too large" }, 400);
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (
      !body ||
      typeof body.reference !== "string" ||
      typeof body.id !== "string" ||
      typeof body.body !== "string"
    )
      return json({ error: "Invalid reply" }, 400);
    return replyToRequest(body);
  }
  if (request.method === "PATCH") {
    let body: { reference?: unknown; status?: unknown; manualMode?: unknown };
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    if (!body) return json({ error: "Invalid update" }, 400);
    if (
      typeof body.reference === "string" &&
      /^CF-[A-F0-9]{16}$/.test(body.reference) &&
      typeof body.manualMode === "boolean" &&
      body.status === undefined
    )
      return setStaffMode(body.reference, body.manualMode);
    if (
      typeof body.reference !== "string" ||
      !/^CF-[A-F0-9]{16}$/.test(body.reference) ||
      !["open", "in_progress", "resolved"].includes(String(body.status))
    )
      return json({ error: "Invalid request update" }, 400);
    const { data, error } = await supabaseAdmin
      .from("wa_requests")
      .update({ status: String(body.status), updated_at: new Date().toISOString() })
      .eq("reference", body.reference)
      .in("status", ["open", "in_progress", "resolved"])
      .select("reference,status")
      .maybeSingle();
    if (error) return json({ error: "Could not update request" }, 503);
    return data ? json(data) : json({ error: "Request not found" }, 404);
  }
  return json({ error: "Method Not Allowed" }, 405);
}
