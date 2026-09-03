import { encryptPhone } from "@/lib/wa-phone-crypto.server";
import type { VisualizeMode } from "@/lib/visualize-prompt";

export type RenderJobInput = {
  mode: VisualizeMode;
  productIds: string[];
  quantities?: Record<string, number> | undefined;
  /** Omitted for staged_room, which builds the room instead of using one. */
  roomUrl?: string | undefined;
  roomWallCm?: number | undefined;
  roomDepthCm?: number | undefined;
  /** Which part of the salon this render covers, on a zone render. */
  scene?: string | undefined;
};

/** Transient Supabase/network blips shouldn't cost a customer their render —
 * retried a couple of times, with a short backoff, before giving up. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 300;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertRow(
  sessionKey: string,
  phone: string,
  job: RenderJobInput,
  status: "pending" | "failed",
  error?: string,
): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error: insertError } = await supabaseAdmin.from("wa_render_jobs").insert({
    session_key: sessionKey,
    customer_phone_enc: encryptPhone(phone),
    status,
    mode: job.mode,
    product_ids: job.productIds,
    quantities: job.quantities ?? {},
    room_url: job.roomUrl ?? null,
    room_wall_cm: job.roomWallCm ?? null,
    room_depth_cm: job.roomDepthCm ?? null,
    scene: job.scene ?? null,
    ...(error ? { error } : {}),
  });
  return !insertError;
}

/**
 * Enqueues a row for wa-render-worker.server.ts to pick up on the next
 * Vercel Cron tick. Retries transient failures up to MAX_ATTEMPTS times
 * before giving up, and DOES report back whether a row actually landed, via
 * the return value, rather than only logging it.
 *
 * That return value matters: a caller that ignores it and tells the customer
 * "rendering now" regardless is capable of lying to them about a render that
 * was never actually queued — a real bug found in production (confirmed via
 * wa-admin.server.ts: confirmation texts were sent for renders that have no
 * corresponding row in this table at all). wa-runtime.ts checks this and
 * sends an honest failure message instead when the enqueue doesn't land.
 *
 * If every attempt fails, one last best-effort write records a `failed` row
 * with the actual error message — a data-specific failure (e.g. a bad
 * payload) can still succeed at writing *that* row even though the original
 * insert didn't, and it's the difference between "we don't know why this
 * customer's render never arrived" and being able to see the reason via
 * GET /api/admin/wa-status. This last write is itself allowed to fail
 * silently — it must never be a second way to break the reply.
 *
 * `phone` (the raw, digits-only WhatsApp number) is encrypted before it's
 * stored — see wa-phone-crypto.server.ts for why a render job is the one
 * table allowed to carry it at all.
 */
export async function enqueueRenderJob(
  sessionKey: string,
  phone: string,
  job: RenderJobInput,
): Promise<boolean> {
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (await insertRow(sessionKey, phone, job, "pending")) return true;
      lastError = "insert returned an error";
    } catch (err) {
      lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    console.error(`enqueueRenderJob: attempt ${attempt}/${MAX_ATTEMPTS} failed`, lastError);
    if (attempt < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS * attempt);
  }

  try {
    await insertRow(sessionKey, phone, job, "failed", `enqueue failed: ${lastError}`);
  } catch (err) {
    console.error("enqueueRenderJob: even the failure record didn't write", err);
  }

  return false;
}
