/** Durable FIFO inbox for WhatsApp messages.
 *
 * Each session can have at most one processing row. Different customers may
 * run concurrently, but two messages from the same customer can never load
 * and overwrite the same session snapshot at once.
 */

import type { Json } from "@/integrations/supabase/types";
import type { InboundEvent } from "@/lib/wa-runtime";
import { encryptPhone } from "@/lib/wa-phone-crypto.server";

const DISPATCH_WAIT_MS = 1500;

export type QueuedInboundJob = {
  id: string;
  wa_message_id: string;
  session_key: string;
  customer_phone_enc: string;
  event: InboundEvent;
  customer_name: string | null;
  status: "queued" | "processing" | "done" | "failed";
  attempt: number;
  created_at: string;
};

export type InboundAudit = {
  kind: "text" | "interactive" | "image" | "unsupported";
  payload: Record<string, Json | undefined>;
};

export async function enqueueInboundJob(input: {
  waMessageId: string;
  sessionKey: string;
  phone: string;
  event: InboundEvent;
  audit: InboundAudit;
  customerName?: string;
}): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("enqueue_wa_inbound", {
    p_wa_message_id: input.waMessageId,
    p_session_key: input.sessionKey,
    p_customer_phone_enc: encryptPhone(input.phone),
    p_kind: input.audit.kind,
    p_message_payload: input.audit.payload,
    p_event: input.event as unknown as Json,
    p_customer_name: input.customerName ?? null,
  });
  if (error) throw error;
  return data === true;
}

export async function claimInboundJobs(limit = 5): Promise<QueuedInboundJob[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("claim_wa_inbound_jobs", { p_limit: limit });
  if (error) throw error;
  return (data ?? []) as unknown as QueuedInboundJob[];
}

export async function completeInboundJob(id: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("wa_inbound_jobs")
    .update({
      status: "done",
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", id)
    .eq("status", "processing");
  if (error) throw error;
}

export async function retryOrFailInboundJob(job: QueuedInboundJob, error: unknown): Promise<void> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const terminal = job.attempt >= 3;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error: updateError } = await supabaseAdmin
    .from("wa_inbound_jobs")
    .update({
      status: terminal ? "failed" : "queued",
      started_at: null,
      completed_at: terminal ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
      last_error: message.slice(0, 2000),
    })
    .eq("id", job.id)
    .eq("status", "processing");
  if (updateError) throw updateError;
}

function workerBaseUrl(): string | null {
  const explicit = (process.env["PUBLIC_BASE_URL"] ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const production = (process.env["VERCEL_PROJECT_PRODUCTION_URL"] ?? "").trim();
  if (process.env["VERCEL_ENV"] === "production" && production) return `https://${production}`;
  const vercel = (process.env["VERCEL_URL"] ?? "").trim();
  return vercel ? `https://${vercel}` : null;
}

/** Wakes a separate serverless invocation; cron remains the recovery path. */
export async function triggerInboundWorker(): Promise<boolean> {
  const base = workerBaseUrl();
  const secret = process.env["CRON_SECRET"];
  if (!base || !secret) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_WAIT_MS);
  try {
    const response = await fetch(`${base}/api/cron/wa-inbound-worker`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result?.worker === "wa-inbound" && Number.isInteger(result.claimed);
  } catch (error) {
    // A timeout proves nothing about acceptance. The webhook must try the
    // database-backed fallback; atomic claims prevent double processing.
    if (error instanceof Error && error.name === "AbortError") return false;
    console.error("triggerInboundWorker failed", error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
