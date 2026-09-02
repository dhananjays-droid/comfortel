import { afterEach, describe, expect, it } from "vitest";

import { handleRenderWorkerTick } from "@/lib/wa-render-worker.server";

/**
 * Only the cron-secret auth guard is unit-tested here — it's the one thing
 * in this file that's both security-relevant and exercisable without a live
 * kie.ai/Anthropic/Supabase call. The claim/start/poll/finish orchestration
 * wraps visualizeStart/visualizeStatus/inspectRender directly (same as
 * index.tsx's runRender/finish()), which this repo doesn't unit-test
 * anywhere else either (visualize.functions.ts and kie.server.ts have zero
 * automated coverage) — that path is verified manually against Meta's test
 * number per the implementation plan's testing section instead.
 */

const ORIGINAL_SECRET = process.env["CRON_SECRET"];
afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env["CRON_SECRET"];
  else process.env["CRON_SECRET"] = ORIGINAL_SECRET;
});

function request(authorization?: string): Request {
  return new Request("https://example.com/api/cron/wa-render-worker", {
    headers: authorization ? { authorization } : {},
  });
}

describe("handleRenderWorkerTick auth guard", () => {
  it("rejects a request with no CRON_SECRET configured at all", async () => {
    delete process.env["CRON_SECRET"];
    const res = await handleRenderWorkerTick(request("Bearer anything"));
    expect(res.status).toBe(401);
  });

  it("rejects a request missing the Authorization header", async () => {
    process.env["CRON_SECRET"] = "test-secret";
    const res = await handleRenderWorkerTick(request());
    expect(res.status).toBe(401);
  });

  it("rejects a request bearing the wrong secret", async () => {
    process.env["CRON_SECRET"] = "test-secret";
    const res = await handleRenderWorkerTick(request("Bearer wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("rejects a request with the right secret but the wrong scheme", async () => {
    process.env["CRON_SECRET"] = "test-secret";
    const res = await handleRenderWorkerTick(request("test-secret"));
    expect(res.status).toBe(401);
  });

  it("passes the guard and reports an empty tick when no Supabase credentials are configured", async () => {
    process.env["CRON_SECRET"] = "test-secret";
    const res = await handleRenderWorkerTick(request("Bearer test-secret"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claimed: number; generating: number };
    // No SUPABASE_SERVICE_ROLE_KEY in this test environment, so
    // claimPendingJobs/fetchGeneratingJobs fail closed to an empty list
    // (the same resilience stance every other *.server.ts store takes)
    // rather than throwing past the auth guard.
    expect(body.claimed).toBe(0);
    expect(body.generating).toBe(0);
  });
});
