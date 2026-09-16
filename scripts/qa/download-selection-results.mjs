import fs from "node:fs/promises";
const out = "outputs/qa-selection-customer-2026-09-16";
const report = JSON.parse(await fs.readFile(`${out}/results.json`, "utf8"));
const assets = JSON.parse(await fs.readFile("src/data/cdn-assets.json", "utf8")).assets;
for (const j of report.journeys) {
  const files = [];
  if (j.imageUrl) files.push([`${j.id}.png`, j.imageUrl]);
  for (const [i, p] of (j.expected ?? []).slice(0, 2).entries())
    files.push([`${j.id}-reference-${i}.jpg`, assets.find(a => a.source === p.image)?.cdn || p.image]);
  for (const [name, url] of files) {
    if (!/^[a-z0-9-]+\.(png|jpg)$/.test(name)) throw new Error("Unexpected file name");
    try { await fs.access(`${out}/${name}`); continue; } catch {}
    const u = new URL(url);
    if (u.protocol !== "https:" || !["tempfile.aiquickdraw.com", "web-assets.quickads.ai", "comfortelfurniture.com"].includes(u.hostname)) throw new Error("Unexpected image host");
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
    await fs.writeFile(`${out}/${name}`, Buffer.from(await response.arrayBuffer()));
    console.log(name);
  }
}
