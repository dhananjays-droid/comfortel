import { test, expect, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: new Proxy({}, { get() { throw new Error("Production DB forbidden"); } }) }));
import { salonPlans } from "@/lib/wa-advisor-tools";
import { CATALOG_FULL, SLIM_BY_ID } from "@/lib/catalog";
import { resolveDims } from "@/lib/dims";
import { viewsFor } from "@/lib/product-views";
import { buildRenderRequest } from "@/lib/visualize-prompt";
import { whatsappImagePrompt } from "@/lib/wa-image-scope";
import { createVisualizeTask, getTaskResult } from "@/lib/kie.server";

test.skipIf(process.env.TARGETED_PLAN_QA !== "yes")("three plans and at most two paid renders, no retries", async () => {
  const out = "outputs/qa-plan-quality-2026-09-16";
  mkdirSync(out, { recursive: true });
  const plans = [4000, 12000, 25000].map(budget => {
    const result = salonPlans({ stations: 3, budget, currency: "USD", scope: "equipment" });
    const selected = result.options.find(p => p.tier === "balanced")!;
    expect(selected.lines.find(l => l.role === "styling")?.qty).toBe(3);
    expect(selected.lines.find(l => l.role === "mirror")?.qty).toBe(3);
    expect(selected.total).toBe(selected.lines.reduce((s, l) => s + l.price! * l.qty, 0));
    console.log(JSON.stringify({ budget, total: selected.total, withinBudget: selected.withinBudget, lines: selected.lines, note: result.budgetNote }));
    return { budget, ...result };
  });
  writeFileSync(`${out}/plans.json`, JSON.stringify(plans, null, 2));
  if (process.env.TARGETED_PLAN_IMAGES !== "yes") return;
  process.env.KIE_API_KEY = parseEnv(readFileSync(".env", "utf8")).KIE_API_KEY;
  const path = `${out}/images-network-enabled.json`;
  const results: any[] = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
  const save = () => writeFileSync(path, JSON.stringify(results, null, 2));
  for (const stations of [3, 5]) {
    let r = results.find(r => r.stations === stations);
    if (r?.imageUrl || r?.error || (r?.submitted && !r?.taskId)) continue;
    const p = salonPlans({ stations, budget: 25000, currency: "USD", scope: "equipment" }).options.find(p => p.tier === "balanced")!;
    const products = p.lines.map(l => { const product = CATALOG_FULL[l.id]!; return { ...product, qty: l.qty, col: SLIM_BY_ID[l.id]?.col ?? null, dims_cm: resolveDims(product), views: viewsFor(l.id).filter(v => product.images.includes(v.url)) }; });
    const request = buildRenderRequest(products, "staged_room");
    request.prompt = whatsappImagePrompt(request.prompt, "staged_room");
    if (!r) { r = { stations, products: products.map(p => ({ id: p.id, name: p.name, qty: p.qty, image: p.images[0] })), prompt: request.prompt, references: request.imageUrls }; results.push(r); save(); }
    try {
      if (!r.taskId) { r.submitted = true; save(); r.taskId = await createVisualizeTask(null, request.imageUrls, request.prompt, "16:9", "staged_room"); save(); console.log(`Submitted ${stations} stations with ${request.imageUrls.length} references`); }
      const deadline = Date.now() + 8 * 60 * 1000;
      while (Date.now() < deadline) {
        const status = await getTaskResult(r.taskId);
        if (status.done) { r.imageUrl = status.imageUrl; save(); console.log(`Completed ${stations}: ${status.imageUrl}`); break; }
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
      if (!r.imageUrl) console.log(`Pending ${stations}; no resubmission`);
    } catch (e) { r.error = String(e); save(); console.log(r.error); }
  }
});
