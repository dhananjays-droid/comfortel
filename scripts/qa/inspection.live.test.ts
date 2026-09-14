import { test, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { inspectWhatsAppEdit } from "@/lib/wa-edit-check.server";
import { runInspectRender } from "@/lib/render-qa.functions";
import { CATALOG_FULL } from "@/lib/catalog";
test.skipIf(process.env.COMFORTEL_INSPECTION_QA !== "yes")(
  "rechecks existing known-bad images without new generations",
  async () => {
    process.env.ANTHROPIC_API_KEY = parseEnv(readFileSync(".env", "utf8")).ANTHROPIC_API_KEY;
    const rows = JSON.parse(readFileSync("outputs/qa-2026-09-14/images.json", "utf8")).results;
    const results = [];
    for (const id of ["G12", "G15", "G17", "G13"]) {
      const row = rows.find((row: any) => row.id === id);
      const references = row.products
        .map((p: any) => CATALOG_FULL[p.id])
        .filter(Boolean)
        .map((p: any) => ({ name: p.name, url: p.images[0] }));
      const verdict = await inspectWhatsAppEdit(
        row.anchor,
        row.imageUrl,
        `${row.note}. Preserve all unselected furniture, colours and hardware. Requested products: ${JSON.stringify(row.products)}`,
        references,
      );
      results.push({ id, verdict });
      writeFileSync(
        "outputs/qa-2026-09-14-after/inspection.json",
        JSON.stringify(results, null, 2),
      );
    }
    const base = rows.find((row: any) => row.id === "G01");
    const counts = await runInspectRender({
      imageUrl: base.imageUrl,
      expected: base.products.map((p: any) => ({ name: p.name, qty: p.qty })),
    });
    results.push({ id: "G01-count-coverage", verdict: counts });
    writeFileSync("outputs/qa-2026-09-14-after/inspection.json", JSON.stringify(results, null, 2));
    expect(results.slice(0, 3).every((row) => row.verdict.ok === false)).toBe(true);
  },
  240000,
);
