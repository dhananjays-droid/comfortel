/** Public US product pages only. No AI, prices, stock or database writes.
 * node scripts/enrich-product-selection.mjs [--limit 5]
 * Output is identity-checked evidence, not an invented "best product" rating.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProductPage, plain } from "./scrape-product-specs.mjs";

export function selectionEvidence(html, product) {
  const parsed = parseProductPage(html, product);
  const normalize = s => plain(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalize(parsed.title) !== normalize(product.name)) throw new Error("Product title changed; review required");
  const start = html.indexOf("<h1");
  const intro = html.slice(start, start + 15000);
  const description = plain(intro.match(/<div class="mb-3 rich-content">([\s\S]*?)<\/div>/i)?.[1] ?? "");
  const subtitle = plain(intro.match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i)?.[1] ?? "");
  const useBlock = html.match(/<h[1-6]\b[^>]*>\s*(?:perfect|ideal|suitable) for\s*<\/h[1-6]>([\s\S]*?)(?=<\/div>|<h[1-6])/i)?.[1] ?? "";
  const intendedUses = plain(useBlock).split(/[\n·•]+/).map(s => s.trim()).filter(Boolean).slice(0, 12);
  const primary = html.slice(start).split(/#instasalon|#InstaSalon|Need more Help\?|Related products/)[0];
  const details = [...primary.matchAll(/<div class="[^\"]*\brich-content\b[^\"]*">([\s\S]*?)<\/div>/gi)]
    .map(m => plain(m[1])).filter(s => s.length > 15).slice(0, 12).map(s => s.slice(0, 2500));
  return {
    name: product.name, sourceUrl: product.url, checkedAt: new Date().toISOString(),
    baselineDescription: product.description, baselineCategory: product.category,
    description: description.slice(0, 5000), subtitle: subtitle.slice(0, 300),
    features: parsed.features, intendedUses, details, specs: parsed.specs,
    options: parsed.options, manualUrl: parsed.manualUrl,
  };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const catalog = JSON.parse(await fs.readFile(path.join(root, "src/data/catalog-full.json"), "utf8"));
  const output = path.join(root, "src/data/product-selection-evidence.json");
  const records = JSON.parse(await fs.readFile(output, "utf8").catch(() => "{}"));
  const idx = process.argv.indexOf("--limit");
  const targets = Object.values(catalog).filter(p => p.id !== "347812").slice(0, idx < 0 ? undefined : Number(process.argv[idx + 1]));
  const cache = path.join(root, "tmp/selection-evidence");
  await fs.mkdir(cache, { recursive: true });
  const audit = []; let cursor = 0;
  const save = async () => fs.writeFile(output, JSON.stringify(records, null, 2) + "\n");
  async function worker() {
    while (cursor < targets.length) {
      const p = targets[cursor++];
      try {
        const u = new URL(p.url);
        if (u.protocol !== "https:" || u.hostname !== "comfortelfurniture.com") throw new Error("Unexpected source host");
        const cachePath = path.join(cache, `${p.id}.html`);
        let html;
        try {
          const stat = await fs.stat(cachePath);
          if (Date.now() - stat.mtimeMs > 86400000) throw new Error("Expired cache");
          html = await fs.readFile(cachePath, "utf8");
        } catch {
          const response = await fetch(p.url, { redirect: "error", signal: AbortSignal.timeout(20000), headers: { "user-agent": "Comfortel-product-selection-audit/1.0" } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          html = await response.text();
          if (html.length > 5000000) throw new Error("Page too large");
          await fs.writeFile(cachePath, html);
          await new Promise(resolve => setTimeout(resolve, 350));
        }
        records[p.id] = selectionEvidence(html, p);
        audit.push({ id: p.id, name: p.name, sourceUrl: p.url, status: "checked", description: Boolean(records[p.id].description), features: records[p.id].features.length });
      } catch (e) {
        audit.push({ id: p.id, name: p.name, sourceUrl: p.url, status: "needs_review", error: e.message });
      }
      if (audit.length % 25 === 0) console.log(`Checked ${audit.length}/${targets.length}`);
    }
  }
  await Promise.all([worker(), worker()]);
  await save();
  await fs.writeFile(path.join(root, "docs/product-selection-audit.json"), JSON.stringify({ checkedAt: new Date().toISOString(), results: audit }, null, 2) + "\n");
  console.log(JSON.stringify({ checked: audit.filter(x => x.status === "checked").length, needsReview: audit.filter(x => x.status !== "checked") }, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
