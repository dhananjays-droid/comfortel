import { test, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { runInspectRender } from "@/lib/render-qa.functions";
test.skipIf(process.env.COMFORTEL_COUNT_QA !== "yes")(
  "structured count coverage",
  async () => {
    process.env.ANTHROPIC_API_KEY = parseEnv(readFileSync(".env", "utf8")).ANTHROPIC_API_KEY;
    const row = JSON.parse(readFileSync("outputs/qa-2026-09-14/images.json", "utf8")).results.find(
      (r: any) => r.id === "G01",
    );
    const originalFetch = globalThis.fetch;
    const responses: unknown[] = [];
    globalThis.fetch = async (...args) => {
      const response = await originalFetch(...args);
      responses.push(await response.clone().json());
      return response;
    };
    try {
      const expected = row.products.map((p: any) => ({ name: p.name, qty: p.qty }));
      const verdict = await runInspectRender({ imageUrl: row.imageUrl, expected });
      writeFileSync(
        "outputs/qa-2026-09-14-after/count-diagnostic.json",
        JSON.stringify({ expected, verdict, responses }, null, 2),
      );
      expect(verdict.inspection).not.toBe("unavailable");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
  60000,
);
