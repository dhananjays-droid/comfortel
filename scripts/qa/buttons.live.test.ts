import { test, vi, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
const mock = vi.hoisted(() => ({ jobs: [] as unknown[] }));
vi.mock("@/lib/wa-rate-limit.server", () => ({ tooManyRenderRequests: async () => false }));
vi.mock("@/lib/wa-render-guards.server", () => ({ claimRenderAction: async () => true }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get() {
        throw new Error("QA: no production DB");
      },
    },
  ),
}));
vi.mock("@/lib/wa-client.server", () => ({ sendText: async () => "qa-no-send" }));
vi.mock("@/lib/wa-render-jobs.server", () => ({
  getActiveRenderState: async () => ({
    count: 0,
    pending: 0,
    generating: 0,
    oldestCreatedAt: null,
  }),
  enqueueRenderJob: async (...args: unknown[]) => {
    mock.jobs.push(args);
    return true;
  },
  cancelActiveRenderJobs: async () => 0,
}));
import { handleInboundMessage, type InboundEvent } from "@/lib/wa-runtime";
import { EMPTY_SESSION, sanitizeSession } from "@/lib/wa-session";
import { CATALOG_FULL } from "@/lib/catalog";
test.skipIf(process.env.COMFORTEL_BUTTON_QA !== "yes")(
  "adaptive budget journey using actual buttons and real curation",
  async () => {
    const env = parseEnv(readFileSync(".env", "utf8"));
    process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    let session = structuredClone(EMPTY_SESSION);
    const outputs: unknown[] = [];
    const calls: unknown[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!url.startsWith("https://api.anthropic.com/"))
        throw new Error("QA network destination blocked");
      const response = await realFetch(input, { ...init, signal: AbortSignal.timeout(60000) });
      const body = await response.clone().json();
      calls.push({ status: response.status, usage: body.usage, error: body.error });
      return response;
    };
    async function send(event: InboundEvent) {
      const r = await handleInboundMessage(session, "qa:buttons", "15550000000", event);
      session = sanitizeSession(JSON.parse(JSON.stringify(r.session)));
      outputs.push({ event, turns: r.turns, plan: session.plan });
      writeFileSync(
        "outputs/qa-2026-09-14-after/buttons.json",
        JSON.stringify({ outputs, calls }, null, 2),
      );
      return r;
    }
    await send({ kind: "text", text: "I need 4 styling stations with an $8000 budget" });
    const offered = await send({ kind: "button", id: "build:confirm" });
    const packages = session.offered?.packages ?? [];
    if (!packages.length) throw new Error(`No packages: ${JSON.stringify(offered.turns)}`);
    const selected = packages.find((p) => p.tier === "balanced") ?? packages[0]!;
    let r = await send({ kind: "button", id: `pkg:${selected.tier}` });
    for (let guard = 0; guard < 10; guard++) {
      const options = r.turns.flatMap((t) => (t.kind === "buttons" ? t.action.buttons : []));
      const next = options.find((b) => b.id.startsWith("role:"));
      if (!next) break;
      r = await send({ kind: "button", id: next.id });
    }
    const total = session.plan.ids.reduce(
      (sum, id) => sum + (CATALOG_FULL[id]?.price ?? 0) * (session.plan.qty[id] ?? 1),
      0,
    );
    const anchor = JSON.parse(
      readFileSync("outputs/qa-2026-09-14/images.json", "utf8"),
    ).results.find((r: any) => r.id === "G01")?.imageUrl;
    if (anchor) session.room = { url: anchor, at: Date.now() };
    const preview = await send({ kind: "button", id: `offer:auto:${session.plan.ids.join(",")}` });
    expect(session.pendingRender).toBeTruthy();
    const pending = session.pendingRender!;
    await send({ kind: "button", id: `render:dismiss:${pending.id}` });
    expect(session.pendingRender).toBeNull();
    expect(mock.jobs).toHaveLength(0);
    expect(total).toBeLessThanOrEqual(8000);
    await send({ kind: "button", id: `offer:auto:${session.plan.ids.join(",")}` });
    const confirmationId = `render:confirm:${session.pendingRender!.id}`;
    await send({ kind: "button", id: confirmationId });
    expect(mock.jobs.length).toBeGreaterThan(0);
    const queuedCount = mock.jobs.length;
    await send({ kind: "button", id: confirmationId });
    expect(mock.jobs).toHaveLength(queuedCount);
    writeFileSync(
      "outputs/qa-2026-09-14-after/buttons.json",
      JSON.stringify(
        {
          outputs,
          calls,
          total,
          stationCount: 4,
          budget: 8000,
          previewMode: pending.mode,
          queuedJobs: mock.jobs.length,
          confirmation: preview.turns,
        },
        null,
        2,
      ),
    );
    globalThis.fetch = realFetch;
  },
  180000,
);
