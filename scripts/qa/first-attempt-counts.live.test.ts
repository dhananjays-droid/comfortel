import { test, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { CATALOG_FULL } from "@/lib/catalog";
import { buildRenderRequest } from "@/lib/visualize-prompt";
import { whatsappImagePrompt } from "@/lib/wa-image-scope";
import { createVisualizeTask, getTaskResult } from "@/lib/kie.server";

test.skipIf(process.env.COMFORTEL_TWO_IMAGE_QA !== "yes")("two first-attempt count renders, no retries or customer sends", async () => {
  process.env.KIE_API_KEY = parseEnv(readFileSync(".env", "utf8")).KIE_API_KEY;
  const out = "outputs/qa-2026-09-17-first-attempt";
  mkdirSync(out, { recursive: true });
  const file = `${out}/results.json`;
  const rows: any[] = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const save = () => writeFileSync(file, JSON.stringify(rows, null, 2));
  const find = (name: string) => {
    const p = Object.values(CATALOG_FULL).find(p => p.name.includes(name) && !p.is_component);
    if (!p) throw new Error(`Missing fixture ${name}`);
    return { ...p, qty: 5 };
  };
  const products = [find("Chloe Tan"), find("Nero Round")];
  for (const mode of ["staged_room", "refit_room"] as const) {
    let row = rows.find(r => r.mode === mode);
    const source = mode === "refit_room" ? rows[0]?.imageUrl : null;
    if (mode === "refit_room" && !source) throw new Error("First result required; no replacement generation");
    const request = buildRenderRequest(products, mode, undefined, undefined, undefined,
      "Five styling stations: five tan chairs, five round mirrors, one chair facing each mirror. All five stations visible. No people.");
    const prompt = whatsappImagePrompt(request.prompt, mode);
    if (!row) {
      row = { mode, prompt, products: products.map(p => ({ name: p.name, qty: p.qty })), submitted: true };
      rows.push(row); save();
      // Persist before submitting: an uncertain response must never buy another task.
      row.taskId = await createVisualizeTask(source, request.imageUrls, prompt, "16:9", mode);
      save();
      console.log(`${mode}: submitted`);
    }
    if (!row.taskId) throw new Error("Uncertain submission; inspect provider before retrying");
    const deadline = Date.now() + 10 * 60_000;
    while (!row.imageUrl && Date.now() < deadline) {
      const result = await getTaskResult(row.taskId);
      if (result.done) { row.imageUrl = result.imageUrl; save(); break; }
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    expect(row.imageUrl).toBeTruthy();
    const response = await fetch(row.imageUrl);
    expect(response.ok).toBe(true);
    writeFileSync(`${out}/${mode}.png`, Buffer.from(await response.arrayBuffer()));
    console.log(`${mode}: completed; inspect ${out}/${mode}.png`);
  }
  expect(rows).toHaveLength(2);
}, 1_300_000);
