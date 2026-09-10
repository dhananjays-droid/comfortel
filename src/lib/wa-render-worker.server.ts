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
 * Claiming is compare-and-set (`update ... where status = ...`), not
 * `select ... for update skip locked` — supabase-js's REST-based client can't
 * express row locking. That was previously justified by cron invocations being
 * effectively serialized, so an overlap cost a wasted read at worst.
 *
 * That justification is gone: a tick now wakes its own successor
 * (wa-render-trigger.server.ts) and an enqueue wakes a tick immediately, so two
 * ticks running at once is ordinary rather than rare. Overlap is therefore
 * handled rather than assumed away — `claimTerminal` puts the same
 * compare-and-set in front of every send, so the tick that loses a race sends
 * nothing instead of delivering the customer a second copy of their render.
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
import { triggerRenderWorker } from "@/lib/wa-render-trigger.server";
import { decryptPhone } from "@/lib/wa-phone-crypto.server";
import { claimRenderAction } from "@/lib/wa-render-guards.server";
import {
  inspectWhatsAppEdit,
  editDeliveryNote,
  type EditVerdict,
} from "@/lib/wa-edit-check.server";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A media message is slower for Meta's own servers to fetch and process
 * than a plain interactive message — confirmed live: the image and its
 * "Add to my plan" / "Get a quote" buttons were sent in that order (image
 * first, per deliverImage below) and still arrived on the customer's
 * device with the buttons showing ABOVE the image. Our own send order
 * only controls when we handed each message to Meta's API, not when Meta
 * finishes processing and delivering either one — so this buys the image
 * a head start before the (much faster) buttons message goes out.
 */
const IMAGE_DELIVERY_HEAD_START_MS = 2500;

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
  note: string | null;
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

/**
 * Move a job to a terminal state, but only if nobody else already has.
 *
 * This is what makes delivery safe to race. `claimPendingJobs` has always
 * compare-and-set its claim, but `fetchGeneratingJobs` is a plain read: two
 * overlapping ticks see the same generating job, both poll kie, both get
 * `success`, and both send the customer the image. That was tolerable while
 * cron ticks were 60s apart and effectively serialized — the module header
 * says as much — but self-triggering makes overlap ordinary rather than rare,
 * so the assumption had to be replaced rather than leaned on harder.
 *
 * Returns false when another tick got there first, which is a normal outcome
 * and means: send nothing, this job is no longer yours.
 */
async function claimTerminal(id: string, patch: Record<string, unknown>): Promise<boolean> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("wa_render_jobs")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "generating")
      .select("id");
    if (error) {
      console.error("claimTerminal failed", error);
      return false;
    }
    return (data?.length ?? 0) > 0;
  } catch (err) {
    console.error("claimTerminal failed", err);
    return false;
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

/** A cancellation may race a Kie start/retry. Never let a late task-id write
 * move a customer-cancelled row back into active work. */
async function updateGeneratingJob(id: string, patch: Record<string, unknown>): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("wa_render_jobs")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "generating");
    if (error) console.error("updateGeneratingJob failed", error);
  } catch (err) {
    console.error("updateGeneratingJob failed", err);
  }
}

/** Logs a render-worker send to wa_messages the same way
 * wa-webhook.server.ts's own logOutbound does for a reply — without this,
 * the admin dashboard's conversation timeline had a hole exactly where a
 * generation was happening: the nudge, the final image and its buttons,
 * and a failure message all went out over WhatsApp but never appeared in
 * the log, since this worker runs on a separate cron tick from the
 * webhook and never touched wa_messages at all. Never throws — a missed
 * audit-log row is not a reason to treat an already-sent message as failed. */
async function logOutbound(
  waMessageId: string,
  sessionKey: string,
  kind: "text" | "image" | "interactive",
  payload: Record<string, string>,
): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("wa_messages").insert({
      wa_message_id: waMessageId,
      direction: "outbound",
      session_key: sessionKey,
      kind,
      payload,
    });
    if (error) console.error("logOutbound failed", error);
  } catch (err) {
    console.error("logOutbound failed", err);
  }
}

/**
 * Folds a delivered render back into the session: `lastRender`, which a
 * "make it blue" follow-up edits directly, and a transcript line, which is
 * what lets the CHAT MODEL find out a render happened at all. Without this,
 * the model's own memory has a hole exactly where rendering happens — the
 * "Building that now" confirmation gets recorded when the job is enqueued,
 * but delivery itself runs on a later, separate cron tick and previously
 * never touched the session, so a customer asking to tweak "the picture
 * you just sent" was talking to a model that had no idea one existed.
 *
 * Best-effort: a session write failing here must never turn an
 * already-delivered image into a failed job.
 */
async function recordDeliveredRender(job: RenderJobRow, resultUrl: string): Promise<void> {
  try {
    const { loadSession, saveSession } = await import("@/lib/wa-session-store.server");
    const session = await loadSession(job.session_key);
    await saveSession(job.session_key, {
      ...session,
      transcript: [
        ...session.transcript,
        {
          role: "assistant",
          content:
            "[The render finished and was delivered to the customer as an image in this chat — they cannot see this note.] If their next message asks for a specific visual change to it (a colour, a material, adding or removing one thing) rather than a new plan, that is an edit of THIS picture: emit RENDER:edit with no product ids and a note describing exactly what to change.",
        },
      ],
      lastRender: {
        resultUrl,
        mode: job.mode,
        productIds: job.product_ids,
        quantities: job.quantities ?? {},
        at: Date.now(),
      },
    });
  } catch (err) {
    console.error("recordDeliveredRender failed", err);
  }
}

async function deliverFailure(job: RenderJobRow, message: string): Promise<void> {
  // Claim before speaking, so two racing ticks can't both apologise.
  if (!(await claimTerminal(job.id, { status: "failed", error: message }))) return;
  try {
    const phone = decryptPhone(job.customer_phone_enc);
    const waMessageId = await sendText(phone, message);
    await logOutbound(waMessageId, job.session_key, "text", { text: message });
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
  // Nothing was installed — there's nothing to add to the plan or quote,
  // so the generic default (below) would be a non sequitur here.
  if (mode === "edit") return "Want anything else changed?";
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
  const note =
    job.mode === "edit"
      ? editDeliveryNote(verdict)
      : shortfallNote(shortfallFrom(expectedForJob(job), verdict), verdict.elsewhere);
  const cta = renderCta(job.mode);
  const buttons = renderCtaButtons(job.mode, job.product_ids, job.quantities);
  // The CTA moves into the follow-up buttons message when there is a real
  // action to offer; lineup has none, so it stays in the caption exactly
  // as before.
  const caption = buttons.length ? note : note ? `${note}\n\n${cta}` : cta;

  // Claim before sending, not after. Whichever tick wins this update owns the
  // delivery; the loser returns having sent nothing, which is the only thing
  // standing between a raced poll and the customer receiving their render twice.
  if (!(await claimTerminal(job.id, { status: "done", result_url: durableUrl, attempt }))) return;

  try {
    const phone = decryptPhone(job.customer_phone_enc);
    const imageMessageId = await sendImage(phone, durableUrl, caption);
    await logOutbound(imageMessageId, job.session_key, "image", {
      imageUrl: durableUrl,
      caption,
    });
    await recordDeliveredRender(job, durableUrl);
    if (buttons.length) {
      await delay(IMAGE_DELIVERY_HEAD_START_MS);
      const buttonsMessageId = await sendButtons(phone, cta, { kind: "buttons", buttons });
      await logOutbound(buttonsMessageId, job.session_key, "interactive", { text: cta });
    }
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
  let verdict: Verdict | EditVerdict;
  try {
    verdict =
      job.mode === "edit" && job.room_url
        ? await inspectWhatsAppEdit(job.room_url, imageUrl, job.note ?? "")
        : await runInspectRender(parseInspectRender({ imageUrl, expected }));
  } catch {
    verdict =
      job.mode === "edit"
        ? { ok: true, faults: [], editCheck: "unavailable" }
        : { ok: true, faults: [] };
  }

  // A shortfall only earns a retry in staged_room: that room is invented,
  // so there is no real wall it could genuinely have run out of. A refit
  // (or any mode working from the customer's actual photo) can have a real
  // physical limit, and retrying there just burns a render to relearn the
  // same constraint — or worse, pressures the model into distorting a real
  // room to force a count that never fit it.
  const shortfall = job.mode === "staged_room" ? shortfallFrom(expected, verdict) : [];

  if (shouldRetry(verdict, job.attempt, shortfall)) {
    // Concurrent pollers must not each purchase a corrective generation.
    if (!(await claimRenderAction(job.id, job.session_key, `retry:${job.attempt}`))) return;
    try {
      const roomImageBase64 = job.room_url ? await base64FromUrl(job.room_url) : "";
      const retried = await runVisualizeStart(
        parseVisualizeStart({
          productIds: job.product_ids,
          roomImageBase64,
          mode: job.mode,
          aspectRatio: "3:2",
          correction: correctionFor(verdict, shortfall),
          ...(job.scene ? { scene: job.scene } : {}),
          ...(job.note ? { note: job.note } : {}),
          ...(job.quantities && Object.keys(job.quantities).length
            ? { quantities: job.quantities }
            : {}),
          ...(roomFor(job) ? { room: roomFor(job) } : {}),
        }),
      );
      if (retried.imageUrl) {
        await finishJob({ ...job, attempt: job.attempt + 1 }, retried.imageUrl);
        return;
      }
      if (retried.taskId) {
        await updateGeneratingJob(job.id, {
          kie_task_id: retried.taskId,
          attempt: job.attempt + 1,
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
        ...(job.note ? { note: job.note } : {}),
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
    await updateGeneratingJob(job.id, { kie_task_id: started.taskId });
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
 * sent once. Time windows choose when the update is useful; a durable unique
 * claim prevents repeats across four-second polls and overlapping workers.
 */
const NUDGE_WINDOW_START_MS = 75 * 1000;
const NUDGE_WINDOW_END_MS = 135 * 1000;

/**
 * A second, later nudge. Without it, a render that's slower than usual (a
 * whole-room refit with several pieces, say) goes quiet from the first
 * nudge at ~2 minutes all the way to either the image or the 6-minute
 * timeout message — four minutes of silence that reads as abandoned rather
 * than "still working." A separate once-only claim, placed before STALE_MS so it lands
 * before the hard stop rather than racing it.
 */
const NUDGE2_WINDOW_START_MS = 4 * 60 * 1000;
const NUDGE2_WINDOW_END_MS = 5 * 60 * 1000;

async function nudgeStillWorking(job: RenderJobRow, text: string, stage: string): Promise<void> {
  try {
    if (!(await claimRenderAction(job.id, job.session_key, `progress:${stage}`))) return;
    const phone = decryptPhone(job.customer_phone_enc);
    const waMessageId = await sendText(phone, text);
    await logOutbound(waMessageId, job.session_key, "text", { text });
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
      await nudgeStillWorking(
        job,
        "Your render is still active — I’m working on the details.",
        "initial",
      );
    } else if (elapsed >= NUDGE2_WINDOW_START_MS && elapsed < NUDGE2_WINDOW_END_MS) {
      await nudgeStillWorking(
        job,
        "Still going — a fit-out with several pieces takes a bit longer to get right. Thanks for hanging in there.",
        "late",
      );
    }
    return "pending";
  } catch (err) {
    console.error("pollJob failed", err);
    return "pending"; // transient — retried on the next tick, not failed outright
  }
}

/**
 * How often to re-check kie WITHIN one tick, and how long to keep doing it.
 *
 * A tick used to poll once and return, which pinned the worst case to the cron
 * cadence: a render finishing one second after a tick waited a whole minute to
 * be noticed. Polling in place instead costs nothing but wall-clock the
 * invocation was going to spend anyway, and brings this in line with the
 * browser, which polls every 3s and is the reason the web path was ~70s faster
 * for identical work.
 *
 * The budget is what keeps the invocation inside a serverless duration limit
 * with room to spare, since a render is 70-130s and no single tick will see one
 * through. Whatever is unfinished when the budget runs out is handed to the
 * next tick — chained below, or cron.
 */
const POLL_INTERVAL_MS = 4000;
const TICK_BUDGET_MS = 40_000;

/**
 * A ceiling on how many times a tick may wake its own successor.
 *
 * At TICK_BUDGET_MS apiece this is far more than the slowest render needs, so
 * it never truncates real work — it exists so that a bug, or a job wedged
 * `generating` in a way pollJob doesn't resolve, cannot bill an unbounded chain
 * of invocations. STALE_MS retires such a job long before the cap is reached;
 * this is the backstop behind that backstop.
 */
const MAX_CHAIN_DEPTH = 30;

function readDepth(request: Request): number {
  const raw = Number(new URL(request.url).searchParams.get("depth") ?? 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export async function handleRenderWorkerTick(request: Request): Promise<Response> {
  if (!authenticated(request)) return new Response("Unauthorized", { status: 401 });

  const depth = readDepth(request);
  // The existing external scheduler calls this route every minute. Recover
  // stranded inbound messages here too, without relying on a self-fetch.
  if (depth === 0) {
    try {
      const { runInboundBatch } = await import("@/lib/wa-inbound-worker.server");
      await runInboundBatch();
    } catch (error) {
      console.error("WhatsApp inbound recovery failed", error);
    }
  }
  const startedAt = Date.now();

  const pending = await claimPendingJobs(BATCH_SIZE);
  for (const job of pending) await startJob(job);

  let done = 0;
  let failed = 0;
  let polled = 0;
  let rounds = 0;
  let outstanding = 0;

  // Re-read each round rather than polling one fixed list: a job another tick
  // has just started belongs in this loop too, and one this loop finished must
  // drop out of it.
  for (;;) {
    const generating = await fetchGeneratingJobs(BATCH_SIZE);
    outstanding = generating.length;
    if (!outstanding) break;

    rounds++;
    for (const job of generating) {
      const outcome = await pollJob(job);
      if (outcome === "done") done++;
      else if (outcome === "failed") failed++;
      else polled++;
    }

    if (Date.now() - startedAt + POLL_INTERVAL_MS >= TICK_BUDGET_MS) break;
    await delay(POLL_INTERVAL_MS);
  }

  // Hand the rest to a successor rather than to the next cron minute. Only when
  // something is genuinely still in flight — an idle tick must end the chain,
  // or the worker would run forever on an empty table.
  let chained = false;
  if (outstanding > 0 && depth < MAX_CHAIN_DEPTH) {
    chained = await triggerRenderWorker(depth + 1);
  }

  const summary = {
    depth,
    claimed: pending.length,
    rounds,
    polled,
    done,
    failed,
    outstanding,
    chained,
    ms: Date.now() - startedAt,
  };
  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
