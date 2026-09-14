import { test, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { inspectWhatsAppEdit } from "@/lib/wa-edit-check.server";
import { runInspectRender } from "@/lib/render-qa.functions";
import { CATALOG_FULL } from "@/lib/catalog";
test.skipIf(process.env.COMFORTEL_FINAL_VISION_QA !== "yes")(
  "final checker catches known collateral damage and accepts correct images",
  async () => {
    process.env.ANTHROPIC_API_KEY = parseEnv(readFileSync(".env", "utf8")).ANTHROPIC_API_KEY;
    const before = JSON.parse(readFileSync("outputs/qa-2026-09-14/images.json", "utf8")).results;
    const after = JSON.parse(
      readFileSync("outputs/qa-2026-09-14-after/images.json", "utf8"),
    ).results;
    const results = [];
    for (const [label, rows, id] of [
      ["known-bad", before, "G12"],
      ["known-bad", before, "G15"],
      ["known-bad", before, "G17"],
      ["new-good", after, "G05"],
      ["new-good", after, "G17"],
    ] as const) {
      const row = rows.find((row: any) => row.id === id);
      const references = row.products
        .map((p: any) => CATALOG_FULL[p.id])
        .filter(Boolean)
        .map((p: any) => ({ name: p.name, url: p.images[0] }));
      const verdict = await inspectWhatsAppEdit(
        row.anchor,
        row.imageUrl,
        `${row.note}. Requested products: ${JSON.stringify(row.products)}`,
        references,
      );
      results.push({ label, id, verdict });
      writeFileSync(
        "outputs/qa-2026-09-14-after/final-vision.json",
        JSON.stringify(results, null, 2),
      );
    }
    const base = before.find((row: any) => row.id === "G01");
    const counts = await runInspectRender({
      imageUrl: base.imageUrl,
      expected: base.products.map((p: any) => ({ name: p.name, qty: p.qty })),
    });
    results.push({ label: "counts", id: "G01", verdict: counts });
    writeFileSync(
      "outputs/qa-2026-09-14-after/final-vision.json",
      JSON.stringify(results, null, 2),
    );
    expect(
      results.filter((row) => row.label === "known-bad").every((row) => row.verdict.ok === false),
    ).toBe(true);
    expect(
      results.filter((row) => row.label === "new-good").every((row) => row.verdict.ok === true),
    ).toBe(true);
    expect(counts.inspection).not.toBe("unavailable");
  },
  300000,
);
