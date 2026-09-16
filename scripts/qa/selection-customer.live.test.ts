import { test, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
const state = vi.hoisted(() => ({ jobs: [] as any[], claims: new Set<string>() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: new Proxy({}, { get() { throw new Error("Production DB forbidden"); } }) }));
vi.mock("@/lib/wa-rate-limit.server", () => ({ tooManyRenderRequests: async () => false }));
vi.mock("@/lib/wa-render-guards.server", () => ({ claimRenderAction: async (id: string) => { if (state.claims.has(id)) return false; state.claims.add(id); return true; } }));
vi.mock("@/lib/wa-render-jobs.server", () => ({ getActiveRenderState: async () => ({ count: 0, pending: 0, generating: 0, oldestCreatedAt: null }), enqueueRenderJob: async (_s: string, _p: string, job: any) => { state.jobs.push(job); return true; } }));
import { handleConversation } from "@/lib/wa-conversation.server";
import { EMPTY_SESSION, sanitizeSession } from "@/lib/wa-session";
import { handleInboundMessage, prepareAdvisorRender, type InboundEvent } from "@/lib/wa-runtime";
import { CATALOG_FULL, SLIM_BY_ID } from "@/lib/catalog";
import { buildRenderRequest } from "@/lib/visualize-prompt";
import { resolveDims } from "@/lib/dims";
import { viewsFor } from "@/lib/product-views";
import { whatsappImagePrompt } from "@/lib/wa-image-scope";
import { createVisualizeTask, getTaskResult } from "@/lib/kie.server";

test.skipIf(process.env.SELECTION_CUSTOMER_LIVE !== "yes")("four bounded synthetic customer journeys and up to four images", async () => {
  const out = "outputs/qa-selection-customer-2026-09-16";
  mkdirSync(out, { recursive: true });
  const path = `${out}/results.json`;
  const report: any = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { calls: [], journeys: [] };
  const save = () => writeFileSync(path, JSON.stringify(report, null, 2));
  const env = parseEnv(readFileSync(".env", "utf8"));
  process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  process.env.KIE_API_KEY = env.KIE_API_KEY;
  const fetcher = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.anthropic.com/")) {
      if (report.calls.length >= 12) throw new Error("QA Anthropic call cap reached");
      const body = JSON.parse(String(init?.body));
      if (String(init?.body).length > 200000 || body.max_tokens > 1800) throw new Error("QA request size cap");
      const row: any = { model: body.model, startedAt: new Date().toISOString() }; report.calls.push(row); save();
      try { const res = await fetcher(input, init); const result = await res.clone().json(); row.status = res.status; row.usage = result.usage; row.error = result.error; save(); return res; }
      catch (e) { row.error = String(e); save(); throw e; }
    }
    if (/supabase\.(co|com)/.test(url)) throw new Error("QA production network blocked");
    return fetcher(input, init);
  };
  try {
    const cases = [
      { id: "compact", brief: "Hi, I need a 3-station hair cutting and styling salon. My equipment-only budget is 12000 USD. Wall stations please. Compact chairs are important; no makeup services. Please suggest a complete equipment plan." },
      { id: "colour", brief: "Plan a 5-station hair-colour salon with wall mirrors and useful lighting for colour work. Budget 25000 USD for equipment only. We do cutting and colouring, not makeup. Please recommend the equipment." },
      { id: "beauty", brief: "I am opening a dedicated 2-station makeup and eyebrow studio, no hair washing or hair cutting. Wall mirrors and reclining chairs please. Equipment budget is 10000 USD. Please make a plan." },
      { id: "barber", brief: "I need a 4-station barbershop with central double-sided island mirrors. We do haircuts and beard work. Equipment budget is 20000 USD. Please make an equipment plan; keep all 4 barber chairs." },
    ];
    for (const c of cases) {
      if (report.journeys.some((r: any) => r.id === c.id)) continue;
      const r: any = { id: c.id, turns: [] }; report.journeys.push(r); save();
      let session = structuredClone(EMPTY_SESSION); let serial = 0;
      const send = async (event: InboundEvent) => {
        const result = await handleConversation({ sessionKey: `synthetic-selection-${c.id}`, phone: "15550000000", waMessageId: `${c.id}-${++serial}`, event }, session, {
          requestContext: async () => null,
          request: async () => { throw new Error("Unexpected request creation in shopping QA"); },
          document: async () => { throw new Error("Unexpected document in shopping QA"); },
          runtime: handleInboundMessage, render: prepareAdvisorRender,
        });
        session = sanitizeSession(result.session);
        r.turns.push({ input: event, output: result.turns, plan: structuredClone(session.plan), pendingRender: structuredClone(session.pendingRender) }); save();
        return result;
      };
      try {
        await send({ kind: "text", text: c.brief });
        if (!session.plan.ids.length) { await send({ kind: "text", text: "Yes, please proceed with the equipment plan using the requirements I gave. This is USD and equipment only." }); }
        if (!session.plan.ids.length) throw new Error("No saved plan after two customer turns");
        const before = state.jobs.length;
        const confirmation = await send({ kind: "text", text: "Show me this exact selection in an example room. Keep the selected quantities and show all stations clearly." });
        if (state.jobs.length !== before) throw new Error("Generation enqueued before confirmation");
        const button = confirmation.turns.flatMap(t => t.kind === "buttons" ? t.action.buttons : []).find(b => b.id.startsWith("render:confirm:"));
        if (!button) throw new Error("No clickable generation confirmation");
        await send({ kind: "button", id: button.id });
        if (state.jobs.length !== before + 1) throw new Error("Confirmation did not enqueue exactly one job");
        r.job = state.jobs.at(-1);
        await send({ kind: "button", id: button.id });
        if (state.jobs.length !== before + 1) throw new Error("Repeated button created duplicate job");
        r.chatComplete = true; save();
      } catch (e) { r.error = String(e); save(); }
    }
    if (process.env.SELECTION_CUSTOMER_IMAGES !== "yes") return;
    // These are the exact captured, customer-confirmed job inputs. No substitute
    // plans and no model-generated QA/retry loop. At most two tasks in flight.
    const ready = report.journeys.filter((r: any) => r.chatComplete && r.job).slice(0, 4);
    let cursor = 0;
    const worker = async () => {
      while (cursor < ready.length) {
        const r = ready[cursor++];
        if (r.imageUrl || r.imageError || (r.submitted && !r.taskId)) continue;
        try {
          const j = r.job;
          const products = j.productIds.map((id: string) => { const p = CATALOG_FULL[id]!; return { ...p, qty: j.quantities?.[id] ?? 1, col: SLIM_BY_ID[id]?.col ?? null, dims_cm: resolveDims(p), views: viewsFor(id).filter(v => p.images.includes(v.url)) }; });
          const request = buildRenderRequest(products, j.mode, undefined, undefined, j.roomWallCm ? { wallCm: j.roomWallCm, ...(j.roomDepthCm ? { depthCm: j.roomDepthCm } : {}) } : undefined, j.note);
          request.prompt = whatsappImagePrompt(request.prompt, j.mode);
          r.expected = products.map((p: any) => ({ id: p.id, name: p.name, qty: p.qty, image: p.images[0] })); r.request = request;
          if (!r.taskId) { r.submitted = true; save(); r.taskId = await createVisualizeTask(j.roomUrl ?? null, request.imageUrls, request.prompt, "16:9", j.mode); save(); }
          const deadline = Date.now() + 8 * 60 * 1000;
          while (Date.now() < deadline) {
            const status = await getTaskResult(r.taskId);
            if (status.done) { r.imageUrl = status.imageUrl; save(); break; }
            await new Promise(resolve => setTimeout(resolve, 10000));
          }
          if (!r.imageUrl) r.pending = true;
          save();
        } catch (e) { r.imageError = String(e); save(); }
      }
    };
    await Promise.all([worker(), worker()]);
  } finally { globalThis.fetch = fetcher; save(); }
});
