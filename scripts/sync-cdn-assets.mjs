/**
 * Mirror every product photograph onto quickads-cloud, once and for good.
 *
 * GPT Image 2 will not fetch comfortelfurniture.com URLs — it fails the whole
 * task with "Image fetch failed. Check access settings or use our File Upload
 * API instead." kie.server.ts worked around that by downloading each photo and
 * re-uploading it to kie's own storage on every render, which measured at
 * ~16.7s of dead time before generation even started, repeated per render
 * because the cache is an in-memory Map that Vercel wipes on every cold start.
 *
 * Serving the same bytes from web-assets.quickads.ai removes that entirely —
 * verified by running a createTask against a CDN URL, which reached `generating`
 * in 0.4s instead of failing. Same bytes in, so the render is unchanged.
 *
 * Source URLs are KEPT in the catalogue and recorded next to every entry here,
 * together with a sha256 of the bytes. That is what makes a re-scrape cheap:
 * hash the freshly scraped file, compare, and only re-upload what actually
 * changed. Nothing here is thrown away on a re-run.
 *
 * Run:  node scripts/sync-cdn-assets.mjs --dry
 *       node scripts/sync-cdn-assets.mjs
 *       node scripts/sync-cdn-assets.mjs --recheck   (re-hash sources, re-upload changed)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CATALOG = path.join(ROOT, "src/data/catalog-full.json");
const VIEWS = path.join(ROOT, "src/data/product-views.json");
const OUT = path.join(ROOT, "src/data/cdn-assets.json");

const API = "https://dev-quickads.brandbooster.ai/api/v1/public-assets";
const DRY = process.argv.includes("--dry");
const RECHECK = process.argv.includes("--recheck");
const CONCURRENCY = 8;

const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

const headers = {
  "content-type": "application/json",
  origin: "https://dev-app.quickads.ai",
  referer: "https://dev-app.quickads.ai/",
  accept: "*/*",
};

async function api(route, body) {
  const res = await fetch(`${API}/${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${route} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Upload one image and return its permanent CDN URL.
 *
 * The part URL from step 1 is signed for application/octet-stream, NOT for the
 * content_type declared alongside it — sending the real type is a 403
 * SignatureDoesNotMatch. The declared type is what step 3 stamps on the object,
 * which is why the CDN still serves it as image/jpeg.
 */
async function upload(sourceUrl, bytes, contentType) {
  const filename = sourceUrl.split("/").pop().split("?")[0];
  const { files } = await api("generate-presigned-url-multi-part", {
    files: [{ filename, content_type: contentType, total_parts: 1 }],
  });
  const file = files[0];

  const put = await fetch(file.parts[0].url, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  if (!put.ok) throw new Error(`part PUT ${put.status}`);
  const etag = (put.headers.get("etag") || "").replaceAll('"', "");

  await api("complete-multipart-upload", {
    files: [
      {
        file_key: file.file_key,
        upload_id: file.upload_id,
        content_type: contentType,
        parts: [{ part_number: 1, etag }],
      },
    ],
  });
  return file.public_url;
}

async function fetchBytes(url) {
  const res = await fetch(url, { headers: { "user-agent": "comfortel-asset-sync" } });
  if (!res.ok) throw new Error(`source ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function mirrorOne(sourceUrl, existing) {
  const ext = sourceUrl.split(".").pop().split("?")[0].toLowerCase();
  const contentType = TYPES[ext] ?? "image/jpeg";
  const bytes = await fetchBytes(sourceUrl);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

  // The point of storing the hash: an unchanged photo costs one GET, not an upload.
  if (existing && existing.sha256 === sha256) return { ...existing, unchanged: true };

  const cdn = await upload(sourceUrl, bytes, contentType);
  return {
    source: sourceUrl,
    cdn,
    sha256,
    bytes: bytes.length,
    content_type: contentType,
    uploaded_at: new Date().toISOString(),
  };
}

/** Every distinct photograph the renderer can reach for. */
function sourceUrls() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
  const views = JSON.parse(fs.readFileSync(VIEWS, "utf8"));
  const urls = new Set();
  for (const product of Object.values(catalog)) for (const u of product.images ?? []) urls.add(u);
  for (const list of Object.values(views)) for (const v of list) urls.add(v.url);
  return [...urls];
}

async function main() {
  const previous = fs.existsSync(OUT)
    ? new Map(JSON.parse(fs.readFileSync(OUT, "utf8")).assets.map((a) => [a.source, a]))
    : new Map();

  const all = sourceUrls();
  const todo = RECHECK ? all : all.filter((u) => !previous.has(u));
  console.log(`${all.length} photographs, ${previous.size} already mirrored, ${todo.length} to do`);
  if (DRY || !todo.length) return;

  const done = new Map(previous);
  const failures = [];
  let index = 0;
  let finished = 0;
  let skipped = 0;

  async function worker() {
    while (index < todo.length) {
      const url = todo[index++];
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const record = await mirrorOne(url, previous.get(url));
          if (record.unchanged) skipped++;
          delete record.unchanged;
          done.set(url, record);
          break;
        } catch (err) {
          if (attempt === 3) failures.push({ source: url, error: String(err).slice(0, 160) });
          else await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      if (++finished % 50 === 0) console.log(`  ${finished}/${todo.length}`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const assets = [...done.values()].sort((a, b) => a.source.localeCompare(b.source));
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        note: "Source URLs and sha256 are kept so a re-scrape can skip anything unchanged. Do not drop the source field.",
        generated_at: new Date().toISOString(),
        assets,
      },
      null,
      1,
    ) + "\n",
  );

  console.log(`wrote ${path.relative(ROOT, OUT)}: ${assets.length} assets`);
  if (skipped) console.log(`  ${skipped} unchanged, not re-uploaded`);
  if (failures.length) {
    console.log(`  ${failures.length} FAILED:`);
    for (const f of failures.slice(0, 10)) console.log(`   ${f.source} — ${f.error}`);
  }
}

main();
