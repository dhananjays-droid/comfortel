import { afterEach, describe, expect, it } from "vitest";

import { handleRenderWorkerTick, renderCta, renderCtaButtons } from "@/lib/wa-render-worker.server";
import { VISUALIZE_MODES } from "@/lib/visualize-prompt";

/**
 * Only the cron-secret auth guard and the pure renderCta() helper are
 * unit-tested here. The claim/start/poll/finish orchestration wraps
 * visualizeStart/visualizeStatus/inspectRender directly (same as
 * index.tsx's runRender/finish()), which this repo doesn't unit-test
 * anywhere else either (visualize.functions.ts and kie.server.ts have zero
 * automated coverage) — that path is verified manually against Meta's test
 * number per the implementation plan's testing section instead.
 */

describe("renderCta", () => {
  it("returns a non-empty, mode-appropriate line for every real mode", () => {
    for (const mode of VISUALIZE_MODES) {
      const cta = renderCta(mode);
      expect(cta.length).toBeGreaterThan(0);
    }
  });

  it("suggests a plan/quote next step for whole-room modes", () => {
    expect(renderCta("staged_room")).toContain("plan");
    expect(renderCta("refit_room")).toContain("plan");
  });

  it("asks which option for a lineup, since several are shown at once", () => {
    expect(renderCta("lineup").toLowerCase()).toContain("which");
  });

  it("gives placement modes a shorter, single-product nudge", () => {
    expect(renderCta("add")).toBe(renderCta("replace"));
    expect(renderCta("add")).toBe(renderCta("replace_all"));
  });
});

describe("renderCtaButtons", () => {
  it("offers add-to-plan and get-a-quote for a whole-room render", () => {
    const buttons = renderCtaButtons("staged_room", ["a", "b"], { a: 3 });
    expect(buttons).toEqual([
      { id: "plan:add:a:3,b:1", title: "Add to my plan" },
      { id: "quote:a,b", title: "Get a quote" },
    ]);
  });

  it("defaults an unlisted product's quantity to 1", () => {
    const buttons = renderCtaButtons("refit_room", ["a"], null);
    expect(buttons[0]?.id).toBe("plan:add:a:1");
  });

  it("offers nothing for a lineup — no single button maps to 'which one'", () => {
    expect(renderCtaButtons("lineup", ["a", "b"], null)).toEqual([]);
  });

  it("offers nothing with no products", () => {
    expect(renderCtaButtons("staged_room", [], null)).toEqual([]);
  });

  it("every button title fits WhatsApp's 20-character cap", () => {
    for (const mode of VISUALIZE_MODES) {
      for (const button of renderCtaButtons(mode, ["a"], null)) {
        expect(button.title.length).toBeLessThanOrEqual(20);
      }
    }
  });
});

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
