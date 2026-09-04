/**
 * The render job worker — driven by Vercel Cron ticks (src/server.ts
 * intercepts `GET /api/cron/wa-render-worker`), not an always-on loop:
 * renders take 30-90s, and there is no persistent process to host a loop on
 * this deployment target (see the implementation plan's note on this repo's
 * Nitro build defaulting to a Cloudflare preset — no long-running server).
 *
 * Same steps `index.tsx`'s `runRender`/`finish()` do from the browser —
 * `visualizeStart`, poll `visualizeStatus`, run `inspectRender` plus the
 * one-retry logic from `render-qa.ts` — just driven one tick at a time
 * server-side, since a WhatsApp send can't block a cron invocation for the
 * full render duration the way the browser blocks on its own `await`.
 *
 * Claiming is a plain `update ... where status = 'pending'`, not
 * `select ... for update skip locked` — Vercel Cron invocations for one
 * schedule are effectively serialized in practice, and supabase-js's
 * REST-based client can't express row locking anyway. A genuine overlap
 * between two ticks is a wasted read at worst (see the guards below), not a
 * duplicate render — sized against this channel's actual traffic rather than
 * engineered for a concurrency level it won't see.
 */

import { timingSafeEqual } from "node:crypto";

import { getProduct, type FullProduct } from "@/lib/catalog";
import { expectedFrom, linesFrom } from "@/lib/plan";
import {
  correctionFor,
  shortfallFrom,
  shortfallNote,
  shouldRetry,
  type Verdict,
} from "@/lib/render-qa";
import { parseInspectRender, runInspectRender } from "@/lib/render-qa.functions";
import {
  parseVisualizeStart,
  parseVisualizeStatus,
  runVisualizeStart,
  runVisualizeStatus,
} from "@/lib/visualize.functions";
import type { VisualizeMode } from "@/lib/visualize-prompt";
import { sendButtons, sendImage, sendText } from "@/lib/wa-client.server";
import { rehostRender } from "@/lib/wa-media.server";
import { decryptPhone } from "@/lib/wa-phone-crypto.server";

const BATCH_SIZE = 5;
/** Roughly matches index.tsx's own ~5-minute ceiling (100 polls x 3s),
 * rounded up for cron-tick granularity rather than a tight poll loop. */
const STALE_MS = 6 * 60 * 1000;

type RenderJobRow = {
  id: string;
  session_key: string;
  customer_phone_enc: string;
  mode: VisualizeMode;
  product_ids: string[];
  quantities: Record<string, number> | null;
  room_url: string | null;
  room_wall_cm: number | null;
  room_depth_cm: number | null;
  scene: string | null;
  kie_task_id: string | null;
  attempt: number;
  created_at: string;
  updated_at: string;
};

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when
 * a CRON_SECRET env var is set on the project — that's the convention this
 * checks against, not a bespoke header. */
function authenticated(request: Request): boolean {
  const secret = process.env["CRON_SECRET"];
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return timingSafeEqualStrings(header, `Bearer ${secret}`);
}

async function base64FromUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  const bytes = await res.arrayBuffer();
  return Buffer.from(bytes).toString("base64");
}

function expectedForJob(job: RenderJobRow) {
  const products = job.product_ids
    .map((id) => getProduct(id))
    .filter((p): p is FullProduct => Boolean(p));
  return expectedFrom(linesFrom(products, job.quantities ?? undefined));
}

function roomFor(job: RenderJobRow): { wallCm: number; depthCm?: number } | undefined {
  if (!job.room_wall_cm) return undefined;
  return job.room_depth_cm
    ? { wallCm: job.room_wall_cm, depthCm: job.room_depth_cm }
    : { wallCm: job.room_wall_cm };
}

async function claimPendingJobs(limit: number): Promise<RenderJobRow[]> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: pending } = await supabaseAdmin
      .from("wa_render_jobs")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(limit);
    if (!pending?.length) return [];

    const ids = pending.map((j) => j.id);
    const { data: claimed, error } = await supabaseAdmin
      .from("wa_render_jobs")
      .update({ status: "generating", updated_at: new Date().toISOString() })
      .in("id", ids)
      .eq("status", "pending")
      .select("*");
    if (error) {
      console.error("claimPendingJobs failed", error);
      return [];
    }
    return (claimed ?? []) as unknown as RenderJobRow[];
  } catch (err) {
    console.error("claimPendingJobs failed", err);
    return [];
  }
}

async function fetchGeneratingJobs(limit: number): Promise<RenderJobRow[]> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("wa_render_jobs")
      .select("*")
      .eq("status", "generating")
      .order("updated_at", { ascending: true })
      .limit(limit);
    if (error) {
      console.error("fetchGeneratingJobs failed", error);
      return [];
    }
    return (data ?? []) as unknown as RenderJobRow[];
  } catch (err) {
    console.error("fetchGeneratingJobs failed", err);
    return [];
  }
}

async function updateJob(id: string, patch: Record<string, unknown>): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("wa_render_jobs")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) console.error("updateJob failed", error);
  } catch (err) {
    console.error("updateJob failed", err);
  }
}

async function deliverFailure(job: RenderJobRow, message: string): Promise<void> {
  await updateJob(job.id, { status: "failed", error: message });
  try {
    const phone = decryptPhone(job.customer_phone_enc);
    await sendText(phone, message);
  } catch (err) {
    console.error("deliverFailure: send failed", err);
  }
}

/**
 * The one place a finished render actually reaches the customer — and, on
 * WhatsApp, the chat model never gets a turn at delivery time to suggest
 * anything, since this send happens later, asynchronously, from the render
 * worker rather than from the reply that requested it. Without this, "here's
 * your render" was a dead end: no invitation to act while they're actually
 * looking at the result, which is the single highest-intent moment in the
 * whole conversation. Short and mode-appropriate rather than one reused
 * line, so a multi-image delivery (a zone split, a lineup) doesn't read as
 * the same canned sentence copy-pasted under every photo.
 */
export function renderCta(mode: VisualizeMode): string {
  if (mode === "staged_room" || mode === "refit_room") {
    return "Like the direction? I can add these to your plan or get you a quote.";
  }
  if (mode === "lineup") {
    return "See one you like? Tell me which and I'll add it to your plan.";
  }
  return "Want this added to your plan?";
}

/**
 * The real actions behind renderCta()'s text, sent as a follow-up buttons
 * message since WhatsApp cannot attach interactive buttons to an image
 * itself — a customer looking at their finished render is the highest-
 * intent moment in the conversation, and typing "add these to my plan"
 * correctly is not something to require of them. Button ids match
 * wa-runtime.ts's `plan:add:id:qty,...` / `quote:id,...` conventions.
 *
 * Omitted for lineup: several DIFFERENT products are shown at once, and
 * "which one" has no single-button mapping the way "add these" does for a
 * whole-room render — it keeps its existing text-only CTA.
 */
export function renderCtaButtons(
  mode: VisualizeMode,
  productIds: string[],
  quantities: Record<string, number> | null,
): Array<{ id: string; title: string }> {
  if (mode === "lineup" || !productIds.length) return [];
  const idQty = productIds.map((id) => `${id}:${quantities?.[id] ?? 1}`).join(",");
  return [
    { id: `plan:add:${idQty}`, title: "Add to my plan" },
    { id: `quote:${productIds.join(",")}`, title: "Get a quote" },
  ];
}

async function deliverImage(
  job: RenderJobRow,
  imageUrl: string,
  verdict: Verdict,
  attempt: number,
): Promise<void> {
  // Falls back to the tempfile URL rather than losing the render entirely if
  // the re-host fails — kie's own CDN survives long enough for one delivery.
  const durableUrl = (await rehostRender(imageUrl)) ?? imageUrl;
  const note = shortfallNote(shortfallFrom(expectedForJob(job), verdict), verdict.elsewhere);
  const cta = renderCta(job.mode);
  const buttons = renderCtaButtons(job.mode, job.product_ids, job.quantities);
  // The CTA moves into the follow-up buttons message when there is a real
  // action to offer; lineup has none, so it stays in the caption exactly
  // as before.
  const caption = buttons.length ? note : note ? `${note}\n\n${cta}` : cta;

  await updateJob(job.id, { status: "done", result_url: durableUrl, attempt });

  try {
    const phone = decryptPhone(job.customer_phone_enc);
    await sendImage(phone, durableUrl, caption);
    if (buttons.length) await sendButtons(phone, cta, { kind: "buttons", buttons });
  } catch (err) {
    console.error("deliverImage: send failed", err);
    await updateJob(job.id, { status: "failed", error: "send failed" });
  }
}

/**
 * Check a finished render, and re-run it once if something basic is broken —
 * the server-side twin of index.tsx's `finish()`.
 */
async function finishJob(job: RenderJobRow, imageUrl: string): Promise<void> {
  const expected = expectedForJob(job);
  let verdict: Verdict;
  try {
    verdict = await runInspectRender(parseInspectRender({ imageUrl, expected }));
  } catch {
    verdict = { ok: true, faults: [] };
  }

  if (shouldRetry(verdict, job.attempt)) {
    try {
      const roomImageBase64 = job.room_url ? await base64FromUrl(job.room_url) : "";
      const retried = await runVisualizeStart(
        parseVisualizeStart({
          productIds: job.product_ids,
          roomImageBase64,
          mode: job.mode,
          aspectRatio: "3:2",
          correction: correctionFor(verdict),
          ...(job.scene ? { scene: job.scene } : {}),
          ...(job.quantities && Object.keys(job.quantities).length
            ? { quantities: job.quantities }
            : {}),
          ...(roomFor(job) ? { room: roomFor(job) } : {}),
        }),
      );
      if (retried.imageUrl) {
        await deliverImage(job, retried.imageUrl, verdict, job.attempt + 1);
        return;
      }
      if (retried.taskId) {
        await updateJob(job.id, {
          kie_task_id: retried.taskId,
          attempt: job.attempt + 1,
          status: "generating",
        });
        return;
      }
    } catch (err) {
      console.error("finishJob: retry failed", err);
      // Falls through to deliver what we already have — a failed retry
      // attempt must never lose the (working) image the customer is waiting on.
    }
  }

  await deliverImage(job, imageUrl, verdict, job.attempt);
}

async function startJob(job: RenderJobRow): Promise<void> {
  try {
    const roomImageBase64 = job.room_url ? await base64FromUrl(job.room_url) : "";
    const started = await runVisualizeStart(
      parseVisualizeStart({
        productIds: job.product_ids,
        roomImageBase64,
        mode: job.mode,
        aspectRatio: "3:2",
        ...(job.scene ? { scene: job.scene } : {}),
        ...(job.quantities && Object.keys(job.quantities).length
          ? { quantities: job.quantities }
          : {}),
        ...(roomFor(job) ? { room: roomFor(job) } : {}),
      }),
    );

    if (started.imageUrl) {
      await finishJob(job, started.imageUrl);
      return;
    }
    if (!started.taskId) throw new Error("visualizeStart returned neither imageUrl nor taskId");
    await updateJob(job.id, { kie_task_id: started.taskId });
  } catch (err) {
    console.error("startJob failed", err);
    await deliverFailure(job, "We couldn't start that render just now. Want me to try again?");
  }
}

/**
 * A render genuinely takes 30-90s once kie.ai accepts the task (GUIDE.md:
 * measured 80-98s), on top of however long it sat waiting for a cron tick to
 * claim it — long enough that a customer who was told "about half a minute"
 * can reasonably start wondering if anything is happening. One reassurance,
 * sent once. There's no "already nudged" column (avoids a schema change for
 * this), so it's a time window instead: wide enough that one ~60s-cadence
 * tick almost always lands inside it, narrow enough that a second tick
 * usually doesn't. Not a hard guarantee against a rare double-send — a
 * second gentle nudge is a far better failure mode than silence.
 */
const NUDGE_WINDOW_START_MS = 75 * 1000;
const NUDGE_WINDOW_END_MS = 135 * 1000;

async function nudgeStillWorking(job: RenderJobRow): Promise<void> {
  try {
    const phone = decryptPhone(job.customer_phone_enc);
    await sendText(phone, "Still working on it, almost there.");
  } catch (err) {
    console.error("nudgeStillWorking failed", err);
  }
}

async function pollJob(job: RenderJobRow): Promise<"done" | "failed" | "pending"> {
  if (Date.now() - new Date(job.updated_at).getTime() > STALE_MS) {
    await deliverFailure(job, "That render is taking longer than expected. Want me to try again?");
    return "failed";
  }
  // A job read as "generating" before startJob's own kie_task_id write has
  // landed yet — a harmless artifact of running claim and fetch as two
  // separate reads rather than one locked transaction. Nothing to poll yet.
  if (!job.kie_task_id) return "pending";

  try {
    const res = await runVisualizeStatus(parseVisualizeStatus({ taskId: job.kie_task_id }));
    if (res.done && res.imageUrl) {
      await finishJob(job, res.imageUrl);
      return "done";
    }
    const elapsed = Date.now() - new Date(job.created_at).getTime();
    if (elapsed >= NUDGE_WINDOW_START_MS && elapsed < NUDGE_WINDOW_END_MS) {
      await nudgeStillWorking(job);
    }
    return "pending";
  } catch (err) {
    console.error("pollJob failed", err);
    return "pending"; // transient — retried on the next tick, not failed outright
  }
}

export async function handleRenderWorkerTick(request: Request): Promise<Response> {
  if (!authenticated(request)) return new Response("Unauthorized", { status: 401 });

  const pending = await claimPendingJobs(BATCH_SIZE);
  for (const job of pending) await startJob(job);

  const generating = await fetchGeneratingJobs(BATCH_SIZE);
  let done = 0;
  let failed = 0;
  let polled = 0;
  for (const job of generating) {
    const outcome = await pollJob(job);
    if (outcome === "done") done++;
    else if (outcome === "failed") failed++;
    else polled++;
  }

  const summary = { claimed: pending.length, generating: generating.length, polled, done, failed };
  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
