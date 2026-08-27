/**
 * Recover product photographs the catalogue never captured.
 *
 * 46 of the 126 renderable products send the image model a single photograph,
 * so it invents the armrest profile and the base — the two things a buyer
 * recognises a chair by. Some of those listings do have more photos on the
 * vendor's site than our catalogue holds; this finds them.
 *
 * It reads the WooCommerce product gallery ONLY. The pages carry ~70 image URLs
 * each, almost all of it site chrome — nav thumbnails, related products, the
 * logo — and a naive "every uploads URL" sweep pulls in other people's chairs,
 * which is worse than no extra photo at all.
 *
 * Run:  node scripts/scrape-product-images.mjs --dry
 *       node scripts/scrape-product-images.mjs
 *       node scripts/scrape-product-images.mjs --only 4115-MUS
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CATALOG = path.join(ROOT, "src/data/catalog-full.json");
const OUT = path.join(ROOT, "src/data/scraped-images.json");

const DRY = process.argv.includes("--dry");
const onlyArg = process.argv.indexOf("--only");
const ONLY = onlyArg > -1 ? process.argv[onlyArg + 1] : null;

/**
 * The proxy is optional here on purpose.
 *
 * This is the vendor whose furniture we resell, and the whole job is a few
 * dozen requests against their own catalogue — a residential proxy would be
 * pointless cost and an odd way to treat a partner's site. Credentials are
 * still read from the environment and never written down, so switching it on
 * is a matter of setting them.
 */
function proxyAgent() {
  const server = process.env.QUICKADS_PROXY_SERVER;
  if (!server) return undefined;
  const user = process.env.QUICKADS_PROXY_USERNAME;
  const pass = process.env.QUICKADS_PROXY_PASSWORD;
  const auth = user && pass ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
  const url = server.replace(/^https?:\/\//, "");
  return { proxy: `http://${auth}${url}` };
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Randomised, not fixed — a metronome is the easiest bot signature there is. */
const politeDelay = () => sleep(700 + Math.random() * 900);

async function fetchPage(url, attempt = 0) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html" },
      signal: AbortSignal.timeout(30_000),
      ...proxyAgent(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt >= 2) throw err;
    await sleep(1500 * 2 ** attempt);
    return fetchPage(url, attempt + 1);
  }
}

/** WordPress serves the same original at many sizes; -800x800 is not a new photo. */
const original = (url) => url.replace(/-\d+x\d+(?=\.\w+$)/, "");

/**
 * Pull the gallery, and only the gallery.
 *
 * `data-large_image` is what WooCommerce puts on each gallery figure, and
 * `wvg-gallery-thumbnail-image` is the variation-gallery plugin this store uses.
 * Both are scoped to the product; nothing else on the page is.
 */
function galleryImages(html) {
  const found = [];
  const push = (u) => {
    const clean = original(u.replace(/&amp;/g, "&").trim());
    if (/\.(jpe?g|png|webp)$/i.test(clean) && !found.includes(clean)) found.push(clean);
  };

  for (const m of html.matchAll(/data-large_image=["']([^"']+)["']/gi)) push(m[1]);
  for (const m of html.matchAll(/data-large-image=["']([^"']+)["']/gi)) push(m[1]);

  // The gallery list, sliced out before matching so related-product rails and
  // the mega-menu cannot contribute.
  const start = html.search(/class=["'][^"']*(woocommerce-product-gallery|wvg-gallery)[^"']*["']/i);
  if (start > -1) {
    const block = html.slice(start, start + 30_000);
    for (const m of block.matchAll(/(?:data-src|data-thumb|src)=["']([^"']+uploads\/[^"']+)["']/gi)) {
      push(m[1]);
    }
  }
  return found;
}

const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const targets = Object.entries(catalog)
  .filter(([, p]) => p.url && (p.images ?? []).length >= 1)
  .filter(([id]) => !ONLY || id.includes(ONLY));

console.log(`checking ${targets.length} product pages${DRY ? " (dry run)" : ""}\n`);

const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
let gained = 0;
let checked = 0;

for (const [id, product] of targets) {
  checked++;
  let html;
  try {
    html = await fetchPage(product.url);
  } catch (err) {
    console.log(`  !! ${product.name}: ${err.message}`);
    await politeDelay();
    continue;
  }
  if (!html) {
    console.log(`  404 ${product.name}`);
    await politeDelay();
    continue;
  }

  const known = new Set((product.images ?? []).map(original));
  const gallery = galleryImages(html);
  const fresh = gallery.filter((u) => !known.has(u));

  if (fresh.length) {
    out[id] = { name: product.name, had: product.images.length, found: gallery, fresh };
    gained += fresh.length;
    console.log(`  +${fresh.length}  ${product.name}  (had ${product.images.length}, page has ${gallery.length})`);
  }

  if (checked % 25 === 0) console.log(`  ... ${checked}/${targets.length}`);
  await politeDelay();
}

console.log(`\n${gained} new photographs across ${Object.keys(out).length} products`);
if (!DRY) {
  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`wrote ${OUT}`);
}
