/** Read-only storefront audit; writes a separate, sourced WhatsApp data overlay.
 * Never changes prices, stock, catalog dimensions or the customer webapp.
 * node scripts/scrape-product-specs.mjs --audit
 * node scripts/scrape-product-specs.mjs [--limit 5]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const decode = (s) =>
  s.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|nbsp|times|lt|gt);/gi, (_, e) => {
    if (e[0] === "#")
      return String.fromCodePoint(
        parseInt(e.slice(e[1].toLowerCase() === "x" ? 2 : 1), e[1].toLowerCase() === "x" ? 16 : 10),
      );
    return (
      { amp: "&", quot: '"', apos: "'", nbsp: " ", times: "×", lt: "<", gt: ">" }[
        e.toLowerCase()
      ] ?? _
    );
  });
export const plain = (s) =>
  decode(s.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, " "))
    .replace(/[ \t\r]+/g, " ")
    .trim();

export function auditProduct(p) {
  const specs = Object.fromEntries(
    Object.entries(p.specs ?? {}).filter(([k, v]) => v && !/^(shipping|carton)/i.test(k)),
  );
  const keys = Object.keys(specs).join("|");
  const missing = [];
  if (!Object.keys(specs).length) missing.push("product specifications");
  if (!/width|size|diameter/i.test(keys)) missing.push("width / size");
  if (!/height|length|size/i.test(keys)) missing.push("height / length");
  if (!/material|upholstery|finish|colour|color|frame/i.test(keys))
    missing.push("material / finish");
  if (/chair|stool|treatment-table/.test(p.category ?? "")) {
    if (!/height.*range|seat height/i.test(keys)) missing.push("height adjustment range");
    if (!/capacity|maximum.*load/i.test(keys)) missing.push("load capacity");
  }
  if (/mirrors/.test(p.category ?? "") && !/installation|mount/i.test(keys))
    missing.push("installation / mounting");
  if (p.is_component && !/compatib|suitable/i.test(keys)) missing.push("model compatibility");
  // Missing functional descriptions can be recovered from the page's feature block.
  if (!p.description || p.description.length < 160 || p.description.trim().endsWith(":"))
    missing.push("features / configuration");
  return {
    id: p.id,
    name: p.name,
    category: p.category,
    url: p.url,
    missing,
    priority: !Object.keys(specs).length ? "high" : missing.length ? "medium" : "low",
  };
}

export function parseProductPage(html, product) {
  // Require the primary WordPress product id, not a related-product link.
  const body = html.match(/<body\b[^>]*>/i)?.[0] ?? "";
  if (!new RegExp(`\\bpostid-${product.id}\\b`).test(body))
    throw new Error("Product identity not verified");
  const title = plain(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  if (!title) throw new Error("Product title missing");
  const specs = {};
  const section =
    html.match(
      /Dimensions\s*(?:&amp;|&)\s*Specifications[\s\S]*?(?=<h5[^>]*>\s*Shipping Details)/i,
    )?.[0] ?? "";
  for (const match of section.matchAll(
    /<div class="text-sm text-gray-700">([\s\S]*?)<\/div>[\s\S]*?<div class="text-sm font-hairline text-gray-600">([\s\S]*?)<\/div>/g,
  )) {
    const label = plain(match[1]),
      value = plain(match[2]);
    if (label && value && !/^(shipping|carton|sku)/i.test(label)) specs[label] = value;
  }
  const options = {},
    optionProducts = [];
  const groups = [...html.matchAll(/<div id="component_\d+"[^>]*data-nav_title="([^"]+)"[^>]*>/g)];
  for (let i = 0; i < groups.length; i++) {
    const label = decode(groups[i][1]);
    const block = html.slice(
      groups[i].index,
      groups[i + 1]?.index ?? html.indexOf("dimensions & product details", groups[i].index),
    );
    const raw = block.match(/data-options_data="([^"]*)"/)?.[1];
    if (!raw) continue;
    try {
      const entries = JSON.parse(decode(raw));
      for (const option of entries)
        if (option.option_id && option.option_title)
          optionProducts.push({
            id: String(option.option_id),
            name: String(option.option_title),
            group: label,
          });
      const names = [
        ...new Set(
          entries
            .map((o) => o.option_title)
            .filter((n) => typeof n === "string" && n.trim() && !/^none$/i.test(n)),
        ),
      ];
      if (names.length) options[label] = names;
    } catch {
      /* No guessed option choices when JSON is unavailable. */
    }
  }
  const intro = html.slice(html.indexOf("<h1"), html.indexOf("<form", html.indexOf("<h1")));
  const included = [...intro.matchAll(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi)]
    .map((m) => plain(m[1]))
    .find((t) => /footrest included/i.test(t));
  if (included) specs["Included footrest"] = included;
  for (const [label, names] of Object.entries(options)) {
    if (/base option/i.test(label)) specs["Base options"] = names.join("; ");
    if (/lift option/i.test(label)) specs["Lift options"] = names.join("; ");
    if (/footrest/i.test(label)) specs["Footrest options"] = names.join("; ");
  }
  const featureBlock =
    html.match(
      /<h[1-6]\b[^>]*>\s*(?:<[^>]+>\s*)*features\s*(?:<\/[^>]+>\s*)*<\/h[1-6]>([\s\S]*?)(?=<\/div>|<h[1-6])/i,
    )?.[1] ?? "";
  const features = plain(featureBlock.replace(/<\/(?:li|p)>/gi, "\n"))
    .split(/[\n·•]+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length > 8 && s.length < 300 && !/salon credits|@[a-z]|instagram|photo credit/i.test(s),
    )
    .slice(0, 8);
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .filter((m) => /PRODUCT HELP.*DOWNLOAD MANUALS/i.test(plain(m[2])))
    .map((m) => decode(m[1]));
  return { title, specs, features, options, optionProducts, manualUrl: links[0] ?? null };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const catalog = JSON.parse(
    await fs.readFile(path.join(root, "src/data/catalog-full.json"), "utf8"),
  );
  const products = Object.values(catalog).filter((p) => p.id !== "347812");
  const audit = products.map(auditProduct);
  console.log(
    JSON.stringify(
      {
        products: products.length,
        needReview: audit.filter((p) => p.missing.length).length,
        noProductSpecs: audit.filter((p) => p.priority === "high").length,
        byCategory: Object.fromEntries(
          [...new Set(audit.map((p) => p.category))].map((c) => [
            c,
            audit.filter((p) => p.category === c && p.missing.length).length,
          ]),
        ),
      },
      null,
      2,
    ),
  );
  if (process.argv.includes("--audit")) return;
  const cache = path.join(root, "tmp/product-specs");
  await fs.mkdir(cache, { recursive: true });
  const limitArg = process.argv.indexOf("--limit");
  const targets = audit
    .filter((p) => p.missing.length)
    .slice(0, limitArg < 0 ? undefined : Number(process.argv[limitArg + 1]));
  const checkedAt = new Date().toISOString().slice(0, 10),
    records = {},
    results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const target = targets[cursor++],
        product = catalog[target.id];
      try {
        let html;
        const cachePath = path.join(cache, `${target.id}.html`);
        try {
          const stat = await fs.stat(cachePath);
          if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) throw new Error("Refresh old cache");
          html = await fs.readFile(cachePath, "utf8");
        } catch {
          const response = await fetch(target.url, {
            headers: { "user-agent": "Comfortel-product-spec-audit/1.0" },
            redirect: "error",
            signal: AbortSignal.timeout(20000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          html = await response.text();
          if (html.length > 5_000_000) throw new Error("Page too large");
          await fs.writeFile(cachePath, html);
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        const found = parseProductPage(html, product);
        const additions = {},
          conflicts = {};
        const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
        for (const [label, value] of Object.entries(found.specs)) {
          const old = Object.entries(product.specs ?? {}).find(
            ([k]) => k.toLowerCase() === label.toLowerCase(),
          );
          if (!old) additions[label] = value;
          else if (normalize(old[1]) !== normalize(value))
            conflicts[label] = { saved: old[1], website: value };
        }
        records[target.id] = {
          name: product.name,
          sourceUrl: target.url,
          checkedAt,
          specs: additions,
          features: found.features,
          options: found.options,
          optionProducts: found.optionProducts,
          manualUrl: found.manualUrl,
        };
        results.push({
          ...target,
          status: "checked",
          addedFields: Object.keys(additions),
          featureCount: found.features.length,
          conflicts,
          remaining: auditProduct({
            ...product,
            specs: { ...product.specs, ...additions },
            description: found.features.length
              ? "Verified product features available on source page. ".repeat(4)
              : product.description,
          }).missing,
        });
      } catch (error) {
        results.push({ ...target, status: "unavailable", reason: error.message });
      }
      if (results.length % 20 === 0 || results.length === targets.length)
        console.log(`Checked ${results.length}/${targets.length}`);
    }
  }
  await Promise.all([worker(), worker()]);
  // Recover component relationships from the exact US parent's option ids.
  // This is a published configuration listing, not a universal compatibility guarantee.
  for (const [id, record] of Object.entries(records)) {
    if (!catalog[id].is_component) continue;
    const parents = Object.values(records).filter((parent) =>
      parent.optionProducts.some((option) => option.id === id && option.name === record.name),
    );
    if (!parents.length) continue;
    record.specs["Listed with"] = parents.map((parent) => parent.name).join("; ");
    record.fieldSources = { "Listed with": parents.map((parent) => parent.sourceUrl) };
    const result = results.find((row) => row.id === id);
    result.addedFields.push("Listed with");
    result.remaining = result.remaining.filter(
      (field) => field !== "model compatibility" && field !== "product specifications",
    );
  }
  const sorted = Object.fromEntries(
    Object.entries(records).sort(([a], [b]) => Number(a) - Number(b)),
  );
  await fs.writeFile(
    path.join(root, "src/data/product-spec-enrichment.json"),
    JSON.stringify(sorted, null, 2) + "\n",
  );
  await fs.writeFile(
    path.join(root, "docs/product-spec-audit.json"),
    JSON.stringify(
      { checkedAt, baseline: audit, results: results.sort((a, b) => Number(a.id) - Number(b.id)) },
      null,
      2,
    ) + "\n",
  );
  const esc = (s) =>
    String(s ?? "")
      .replace(/\|/g, "/")
      .replace(/\n/g, " ");
  const report = [
    "# Comfortel product specification audit",
    "",
    `Checked ${checkedAt}. Audited ${products.length} products; ${targets.length} were flagged for website review using category-specific gap checks. ${audit.filter((p) => p.priority === "high").length} originally had no buyer-facing specifications beyond shipping data.`,
    "",
    `Recovered ${results.reduce((n, r) => n + (r.addedFields?.length ?? 0), 0)} structured fields across ${results.filter((r) => r.addedFields?.length).length} products, plus published feature lists for ${results.filter((r) => r.featureCount).length} products. All ${results.filter((r) => r.status === "checked").length} targeted pages passed primary product-ID checks. Conflicting existing values were not overwritten.`,
    "",
    "## What changed",
    "",
    "- WhatsApp answers and comparison PDFs use a separate sourced overlay; prices, stock, rendering dimensions and the original webapp catalog are unchanged.",
    "- Every addition has a source in src/data/product-spec-enrichment.json. Component relationships come from exact component IDs on US parent-product configuration lists; fieldSources records those parent pages. A listed relationship is not a universal compatibility guarantee.",
    "- Existing upholstery, finishes, seat-height ranges, mirror/bench dimensions and electrical fields are now available in comparisons. Missing fields are selected by product category.",
    "- Selectable options are not described as the included configuration. Hydraulic stroke is not seat height; shipping measurements/weight are not product measurements/load capacity.",
    "- Product-specific manual links were saved for staff, but unverified overseas specifications were not imported.",
    "",
    "## Manual findings requiring staff confirmation",
    "",
    "The US Blake page links to a [Blake drawing, part 3001.01](https://help.comfortel.com.au/wp-content/uploads/3001.01-BLAKE.pdf). It shows 630 mm overall width and different height ranges for Capital/Omega bases and 125/165 mm hydraulics. The US Textured Black listing uses SKU 4115-TBUS and 620 mm width. Model/configuration mapping needs confirmation before importing those missing height/depth values.",
    "",
    "The linked [safe-working-load document](https://help.comfortel.com.au/wp-content/uploads/Certificate-Comfortel-Safe-Working-Load-Salon-Styling-Chairs-1.pdf) describes a salon styling chair TOP, not an unconditional rating for every assembled US chair/base/pump combination. Its rating was deliberately not populated as a complete-chair load capacity.",
    "",
    "## Products checked and outstanding gaps",
    "",
    "Rows without recoverable fields still matter: the website was checked but did not provide safe replacements for every missing measurement. Features/configuration are counted separately from numeric specifications. This checklist does not certify unflagged products as having every conceivable specification.",
    "",
    "| Product / source | Category | Originally missing | Recovered | Still needs confirmation |",
    "| --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| [${esc(r.name)}](${r.url}) (${r.id}) | ${esc(r.category)} | ${esc(r.missing.join(", "))} | ${esc([...(r.addedFields ?? []), ...(r.featureCount ? [`${r.featureCount} features`] : [])].join(", ") || "No additional fields")} | ${esc(r.remaining?.join(", ") || r.reason || "No flagged gaps remain")} |`,
    ),
    "",
    "## Not flagged by the initial checks",
    "",
    ...audit.filter((p) => !p.missing.length).map((p) => `- [${p.name}](${p.url}) (${p.id})`),
    "",
    "## Maintenance",
    "",
    "Run node scripts/scrape-product-specs.mjs --audit for the read-only baseline, or node scripts/scrape-product-specs.mjs to refresh the overlay/report. HTML is cached locally for 24 hours. Review fields and model identity before deployment. No prices, orders or stock are updated.",
    "",
  ];
  await fs.writeFile(path.join(root, "docs/product-spec-audit.md"), report.join("\n"));
  console.log(
    JSON.stringify(
      {
        checked: results.filter((r) => r.status === "checked").length,
        unavailable: results.filter((r) => r.status !== "checked").length,
        productsWithAdditions: results.filter((r) => r.addedFields?.length).length,
        newFields: results.reduce((n, r) => n + (r.addedFields?.length ?? 0), 0),
        productsWithFeatures: results.filter((r) => r.featureCount).length,
        conflicts: results.filter((r) => Object.keys(r.conflicts ?? {}).length).length,
      },
      null,
      2,
    ),
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
