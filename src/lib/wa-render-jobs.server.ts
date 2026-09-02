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

/**
 * Enqueues a row for wa-render-worker.server.ts to pick up on the next
 * Vercel Cron tick. Never throws — same resilience stance as
 * wa-session-store.server.ts. A failed enqueue means the customer's render
 * silently never arrives rather than the whole webhook request failing;
 * wa-runtime.ts still sends its "here is X rendered" confirmation regardless.
 *
 * `phone` (the raw, digits-only WhatsApp number) is encrypted before it's
 * stored — see wa-phone-crypto.server.ts for why a render job is the one
 * table allowed to carry it at all.
 */
export async function enqueueRenderJob(
  sessionKey: string,
  phone: string,
  job: RenderJobInput,
): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("wa_render_jobs").insert({
      session_key: sessionKey,
      customer_phone_enc: encryptPhone(phone),
      status: "pending",
      mode: job.mode,
      product_ids: job.productIds,
      quantities: job.quantities ?? {},
      room_url: job.roomUrl ?? null,
      room_wall_cm: job.roomWallCm ?? null,
      room_depth_cm: job.roomDepthCm ?? null,
      scene: job.scene ?? null,
    });
    if (error) console.error("enqueueRenderJob failed", error);
  } catch (err) {
    console.error("enqueueRenderJob failed", err);
  }
}
