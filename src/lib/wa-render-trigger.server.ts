/**
 * Wakes the render worker immediately instead of waiting for the next cron tick.
 *
 * The worker only advances a job when a tick runs, and cron-job.org drives it
 * about once a minute. A job therefore needs two ticks — one to hand it to
 * kie.ai, another to notice kie finished — and waits an average of ~30s for
 * each. Measured against the real history in wa_render_jobs, that was ~70s of
 * the 164s median, against a web path (which polls every 3s) that finished the
 * same render in ~93s. It is dead air, not work.
 *
 * Two callers close those two gaps: enqueueRenderJob fires one as soon as a job
 * lands, and a tick fires one at the end of itself while jobs are still
 * generating.
 *
 * WHY THE DISPATCH IS AWAITED. On a serverless platform a promise nobody awaits
 * can be frozen with the invocation before the request is actually flushed to
 * the network, so a plain fire-and-forget `fetch()` is not reliably a request at
 * all. We await only long enough to be sure it left — not for the tick to
 * finish, which would nest every chained invocation inside its parent and blow
 * the function's duration limit.
 *
 * The abort that follows cancels OUR wait, not the worker: the tick is a
 * separate invocation and runs to completion on its own. If that ever stopped
 * being true, the consequence is bounded — the job simply waits for the next
 * cron tick, exactly as it does today.
 */

/** Long enough for the request to leave, far short of a tick. */
const DISPATCH_WAIT_MS = 1500;

/**
 * Where to call ourselves. An explicit override wins so a non-Vercel host (or a
 * local run) can point this somewhere real; VERCEL_URL is the deployment's own
 * hostname, which is what we want — a chained tick should stay on the same
 * deployment that started the job, not jump to production from a preview.
 */
function baseUrl(): string | null {
  const explicit = (process.env["PUBLIC_BASE_URL"] ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const vercel = (process.env["VERCEL_URL"] ?? "").trim();
  return vercel ? `https://${vercel}` : null;
}

/**
 * Ask the worker to run now. Resolves true when the request was dispatched.
 *
 * Never throws and never blocks a caller for long: every caller is on a path a
 * customer is waiting on, and a missed trigger costs latency, not correctness.
 */
export async function triggerRenderWorker(depth = 0): Promise<boolean> {
  const base = baseUrl();
  const secret = process.env["CRON_SECRET"];
  // Unconfigured is a normal state (tests, local dev), not an error worth
  // logging on every enqueue — cron remains the backstop either way.
  if (!base || !secret) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_WAIT_MS);

  try {
    await fetch(`${base}/api/cron/wa-render-worker?depth=${depth}`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    return true;
  } catch (err) {
    // An abort here is the expected path, not a failure: the request went out
    // and we deliberately stopped waiting for the tick to finish.
    if (err instanceof Error && err.name === "AbortError") return true;
    console.error("triggerRenderWorker failed", err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
