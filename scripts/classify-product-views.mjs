/**
 * One-off: classify each product's photos into usable reference views.
 *
 * Filenames cannot do this. Of 102 products with unused extra photos, 12 were
 * lifestyle or retail shots, 30 were unclassifiable by name, and some "extra"
 * photos are a different colourway or base variant of the product. A wrong
 * "another angle" is worse than no extra angle — it shows the image model a
 * different chair and calls it the same one — so a vision model decides.
 *
 * Run:  node --env-file=.env scripts/classify-product-views.mjs
 *       node --env-file=.env scripts/classify-product-views.mjs --limit 5
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "src/data/product-views.json");
const MODEL = "claude-sonnet-5";
const MAX_IMAGES = 6;
const CONCURRENCY = 4;

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error("ANTHROPIC_API_KEY missing. Run with: node --env-file=.env scripts/...");
  process.exit(1);
}

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/catalog-full.json"), "utf8"));

const SYSTEM = `You classify product photographs for a salon furniture catalogue.

You are given several photographs from ONE catalogue listing. They are NOT
guaranteed to show the same physical item. Listings routinely mix in a different
colourway or base variant, a photo of a whole salon, a group shot of several
units, or a generic photo shared across several listings in the same range.

IMAGE 1 IS THE ANCHOR. Every other image is judged against it: does it show the
SAME physical unit as image 1 — same upholstery colour, same base design, same
frame finish, same armrest shape?

Labels:
- "hero"   image 1, if it is a studio shot of ONE single unit on a plain
           background. If image 1 is a group shot, a lifestyle photo, or shows
           several units, label it "reject" and label everything else "reject"
           too — the listing has no usable reference set.
- "front"  the same physical unit as image 1, seen from the front
- "side"   the same physical unit as image 1, seen from the side
- "back"   the same physical unit as image 1, seen from the back
- "reject" everything else

Label "reject" for any of these, without exception:
- a different colourway, a different base, or any visible spec difference from image 1
- more than one unit in the frame, or any other product visible alongside it
- a lifestyle, interior, in-situ or styled room photograph
- a swatch, a dimensioned drawing, a logo, or a packaging shot
- a close-up that does not show enough of the unit to identify its silhouette
- anything you cannot positively verify is the same unit as image 1

BE STRICT AND PREFER "reject". These images are the reference an image model
redraws the product from. A photo of a DIFFERENT variant labelled as another
angle is far worse than having no extra angle at all — it makes the model draw
the wrong chair. When you are even slightly unsure, the answer is "reject".

There is deliberately no "detail" label. A close-up cannot establish the
silhouette, the armrest profile or the base, which is the only reason extra
views are wanted.

The product name is given to you. If the name specifies a variant (for example
"with Aluminium Base") and an image does not show that variant, it is "reject".

Call submit_labels with exactly one label per image, in the order given.`;

async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const type = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4_500_000) return null;
  return { type, data: buf.toString("base64") };
}

async function classify(id, product) {
  const urls = (product.images ?? []).slice(0, MAX_IMAGES);
  if (urls.length < 2) return null;

  const fetched = [];
  for (const url of urls) {
    const img = await fetchImage(url);
    if (img) fetched.push({ url, ...img });
  }
  if (fetched.length < 2) return null;

  const content = [];
  fetched.forEach((img, i) => {
    content.push({ type: "text", text: `Image ${i + 1}:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.type, data: img.data },
    });
  });
  content.push({
    type: "text",
    text: `Product name: ${product.name}. Classify all ${fetched.length} images.`,
  });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1000,
      system: SYSTEM,
      messages: [{ role: "user", content }],
      // Forced tool use instead of free text. Sonnet 5 rejects assistant
      // prefill ("This model does not support assistant message prefill"), and
      // without a constraint it spent the whole budget reasoning and returned
      // stop_reason=max_tokens with no JSON. A forced tool call is validated by
      // the API, so there is nothing left to parse or repair.
      tools: [
        {
          name: "submit_labels",
          description: "Submit one label per image, in the order given.",
          input_schema: {
            type: "object",
            properties: {
              labels: {
                type: "array",
                items: { type: "string", enum: ["hero", "front", "side", "back", "reject"] },
              },
            },
            required: ["labels"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "submit_labels" },
    }),
  });

  if (!res.ok) {
    console.error(`  ${id} API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }

  const json = await res.json();
  const call = json.content?.find((b) => b.type === "tool_use");
  const labels = call?.input?.labels;

  if (!Array.isArray(labels) || labels.length !== fetched.length) {
    console.error(`  ${id} expected ${fetched.length} labels, got ${labels?.length}`);
    return null;
  }

  const ORDER = { hero: 0, front: 1, side: 2, back: 3 };
  const views = fetched
    .map((img, i) => ({ url: img.url, angle: labels[i] }))
    .filter((v) => v.angle in ORDER)
    .sort((a, b) => ORDER[a.angle] - ORDER[b.angle]);

  // A set with no hero is not usable: the prompt leads with the hero shot.
  if (!views.some((v) => v.angle === "hero")) return null;
  // The hero must be image 1. Anything else means the model contradicted the
  // anchor rule, and the whole set is untrustworthy.
  if (views[0].url !== fetched[0].url) {
    console.error(`  ${id} hero was not image 1 - discarding set`);
    return null;
  }
  return views.length > 1 ? views : null;
}

const ids = Object.keys(catalog).filter((id) => (catalog[id].images ?? []).length > 1);
const todo = ids.slice(0, LIMIT);
console.log(`classifying ${todo.length} products with >1 photo (of ${ids.length})`);

const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
let done = 0;
let kept = 0;

async function worker(queue) {
  while (queue.length) {
    const id = queue.shift();
    try {
      const views = await classify(id, catalog[id]);
      if (views) {
        out[id] = views;
        kept++;
      }
    } catch (err) {
      console.error(`  ${id} failed: ${err.message}`);
    }
    if (++done % 10 === 0) console.log(`  ${done}/${todo.length} (${kept} usable)`);
  }
}

const queue = [...todo];
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

fs.writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
console.log(`\nwrote ${OUT}`);
console.log(`products with a usable multi-view set: ${Object.keys(out).length}`);
