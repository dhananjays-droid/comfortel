# Phase 0a — Product View Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every product an explicit, verified list of usable reference views so renders stop inventing armrests and bases — and stop the reference selector guessing angles from filenames.

**Architecture:** A one-off vision classifier reads each product's photos and writes `src/data/product-views.json` (id → ordered views with angles). `visualize.functions.ts` attaches that list to the product it passes into the prompt builder, the same way it already attaches `col`. `referenceViews()` becomes a pure function over supplied data with a safe fallback, so `visualize-prompt.ts` stays client-safe and imports no JSON.

**Tech Stack:** TypeScript, Vitest (new), Anthropic Messages API with vision (`claude-sonnet-5`), Node 22 type stripping for scripts.

## Global Constraints

- `exactOptionalPropertyTypes: true` — every optional property needs `| undefined` in its type.
- `visualize-prompt.ts` is reachable from the client bundle. It must not import JSON data and must not touch `process.env`.
- Reference order is the prompt contract: hero first, then other angles. `buildRenderRequest()` returns prompt and image array from one call; never split them.
- Lifestyle, interior and collection shots are never usable views — a photo of the product in someone else's salon competes with "the first image is the salon".
- GPT Image 2 accepts 16 input images; `MAX_VIEWS = 4` stays the per-product cap.
- Never write to `.env`. Never delete it.
- `noUncheckedIndexedAccess: true` — index a record with a literal-union key type, never `string`, or every lookup is `T | undefined`.
- Node's type stripping cannot resolve the `@` alias. Verification scripts must `require` JSON directly instead of importing `src/lib/*.ts` modules that use it.
- Cost discipline: the classifier runs offline and is committed as data. It must not run at request time.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `vitest.config.ts` (create) | Test runner config, node environment |
| `package.json` (modify) | `test` / `test:run` scripts, vitest devDependency |
| `src/data/product-views.json` (create, generated) | id → `[{ url, angle }]`, committed data |
| `src/lib/product-views.ts` (create) | Typed loader + lookup over the JSON. Server-only. |
| `src/lib/visualize-prompt.ts` (modify) | `referenceViews()` reads supplied views; filename fallback retained |
| `src/lib/visualize.functions.ts` (modify) | Attaches `views` to each product before building the request |
| `scripts/classify-product-views.mjs` (create) | One-off vision classifier that writes the JSON |
| `src/lib/__tests__/visualize-prompt.test.ts` (create) | Tests for view selection and prompt budget |
| `src/lib/__tests__/product-views.test.ts` (create) | Tests for the loader and its fallback |

---

## Task 1: Test tooling

The repo has no test runner at all. Everything below depends on this.

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`
- Create: `src/lib/__tests__/smoke.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `npm test` (watch) and `npm run test:run` (single pass) work from the repo root; tests live in `src/**/__tests__/*.test.ts`

- [ ] **Step 1: Install vitest**

```bash
npm install -D vitest@^2
```

- [ ] **Step 2: Create the config**

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
```

The `@` alias must be repeated here — vitest does not read `tsconfig.json` paths.

- [ ] **Step 3: Add the scripts**

In `package.json` `"scripts"`, add:

```json
"test": "vitest",
"test:run": "vitest run"
```

- [ ] **Step 4: Write a smoke test that proves the alias works**

`src/lib/__tests__/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { isVisualizeMode, MAX_VIEWS } from "@/lib/visualize-prompt";

describe("test harness", () => {
  it("resolves the @ alias", () => {
    expect(isVisualizeMode("replace")).toBe(true);
    expect(isVisualizeMode("nonsense")).toBe(false);
  });

  it("exposes the view cap", () => {
    expect(MAX_VIEWS).toBe(4);
  });
});
```

- [ ] **Step 5: Run it**

Run: `npm run test:run`
Expected: 2 passing tests. If the alias fails it errors with "Failed to resolve import @/lib/visualize-prompt".

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts package.json package-lock.json src/lib/__tests__/smoke.test.ts
git commit -m "Add vitest and a smoke test for the @ alias"
```

---

## Task 2: Lock current selector behaviour in tests

Before changing `referenceViews()`, pin what it does now. These tests must keep passing after Task 3 for the products that already worked.

**Files:**
- Create: `src/lib/__tests__/visualize-prompt.test.ts`

**Interfaces:**
- Consumes: `referenceViews`, `buildRenderRequest`, `MAX_PROMPT_CHARS` from `@/lib/visualize-prompt`
- Produces: the regression suite every later task runs

- [ ] **Step 1: Write the tests**

`src/lib/__tests__/visualize-prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildRenderRequest,
  MAX_PROMPT_CHARS,
  referenceViews,
  type VisualizeProduct,
} from "@/lib/visualize-prompt";

function product(over: Partial<VisualizeProduct> = {}): VisualizeProduct {
  return {
    id: "1",
    name: "Test Styling Chair",
    images: ["https://x/hero.jpg"],
    replaces: "styling chair",
    ...over,
  };
}

describe("referenceViews", () => {
  it("always includes the hero shot first", () => {
    const views = referenceViews(product());
    expect(views).toHaveLength(1);
    expect(views[0]?.url).toBe("https://x/hero.jpg");
  });

  it("picks up front/side/back photos from the filename", () => {
    const views = referenceViews(
      product({
        images: [
          "https://x/hero.jpg",
          "https://x/chair-Front.jpeg",
          "https://x/chair-Side.jpeg",
        ],
      }),
    );
    expect(views.map((v) => v.angle)).toEqual([
      "as the catalogue shows it",
      "from the front",
      "from the side",
    ]);
  });

  it("never returns more than the cap", () => {
    const images = ["h.jpg", "a-front.jpg", "b-side.jpg", "c-back.jpg", "d-front.jpg"].map(
      (f) => `https://x/${f}`,
    );
    expect(referenceViews(product({ images }), 2)).toHaveLength(2);
  });

  it("skips lifestyle shots", () => {
    const views = referenceViews(
      product({ images: ["https://x/hero.jpg", "https://x/lifestyle-front.jpg"] }),
    );
    expect(views).toHaveLength(1);
  });

  it("de-duplicates repeated urls", () => {
    const views = referenceViews(
      product({ images: ["https://x/hero.jpg", "https://x/hero.jpg"] }),
    );
    expect(views).toHaveLength(1);
  });
});

describe("buildRenderRequest", () => {
  it("keeps the room-first contract by returning refs only", () => {
    const { imageUrls } = buildRenderRequest([product()], "replace");
    expect(imageUrls).toEqual(["https://x/hero.jpg"]);
  });

  it("stays inside the prompt budget for a long product name", () => {
    const long = product({ name: "A".repeat(120) });
    for (const mode of ["replace", "replace_all", "add"] as const) {
      expect(buildRenderRequest([long], mode).prompt.length).toBeLessThanOrEqual(
        MAX_PROMPT_CHARS,
      );
    }
  });

  it("tells the model to replace reflections, not erase them", () => {
    const { prompt } = buildRenderRequest([product()], "replace_all");
    expect(prompt).toContain("ANOTHER ONE TO REPLACE");
  });

  it("requires every placed copy to match the others", () => {
    const { prompt } = buildRenderRequest([product()], "replace_all");
    expect(prompt).toContain("identical to the others");
  });
});
```

- [ ] **Step 2: Run them**

Run: `npm run test:run`
Expected: all pass against the current implementation. Any failure here is a real bug in today's code — fix it before continuing.

- [ ] **Step 3: Commit**

```bash
git add src/lib/__tests__/visualize-prompt.test.ts
git commit -m "Pin current reference-view and prompt behaviour in tests"
```

---

## Task 3: Data-driven views with a filename fallback

**Files:**
- Create: `src/lib/product-views.ts`
- Create: `src/lib/__tests__/product-views.test.ts`
- Modify: `src/lib/visualize-prompt.ts`
- Create: `src/data/product-views.json` (empty object for now — Task 5 fills it)

**Interfaces:**
- Consumes: `VisualizeProduct` from `@/lib/visualize-prompt`
- Produces:
  - `type ProductView = { url: string; angle: ViewAngle }`
  - `type ViewAngle = "hero" | "front" | "side" | "back" | "detail"`
  - `viewsFor(id: string): ProductView[]` in `@/lib/product-views` (server-only)
  - `VisualizeProduct` gains `views?: ProductView[] | undefined`
  - `referenceViews(product, max)` prefers `product.views`, else falls back to today's filename matching

- [ ] **Step 1: Create the empty data file**

`src/data/product-views.json`:

```json
{}
```

- [ ] **Step 2: Write the failing loader test**

`src/lib/__tests__/product-views.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { ANGLE_PHRASE, viewsFor } from "@/lib/product-views";

describe("viewsFor", () => {
  it("returns an empty list for an unknown product", () => {
    expect(viewsFor("no-such-id")).toEqual([]);
  });
});

describe("ANGLE_PHRASE", () => {
  it("phrases every angle for the prompt", () => {
    expect(ANGLE_PHRASE.hero).toBe("as the catalogue shows it");
    expect(ANGLE_PHRASE.front).toBe("from the front");
    expect(ANGLE_PHRASE.side).toBe("from the side");
    expect(ANGLE_PHRASE.back).toBe("from the back");
    expect(ANGLE_PHRASE.detail).toBe("in close-up detail");
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm run test:run src/lib/__tests__/product-views.test.ts`
Expected: FAIL — "Failed to resolve import @/lib/product-views".

- [ ] **Step 4: Write the loader**

`src/lib/product-views.ts`:

```ts
import raw from "@/data/product-views.json";

/**
 * Angles a reference photo can show. Written by scripts/classify-product-views.mjs,
 * which asks a vision model which of a product's photos show the SAME physical
 * product and from what side.
 *
 * Filenames cannot answer that. Of the 102 products whose extra photos were
 * unused, 12 were lifestyle or collection shots, 30 were unclassifiable from the
 * name, and some "extra" photos are a different variant of the product entirely.
 * Feeding one of those in as another angle is worse than sending nothing — it
 * shows the model a different chair and calls it the same one.
 */
export type ViewAngle = "hero" | "front" | "side" | "back" | "detail";

export type ProductView = { url: string; angle: ViewAngle };

/** How each angle is described to the image model. */
export const ANGLE_PHRASE: Record<ViewAngle, string> = {
  hero: "as the catalogue shows it",
  front: "from the front",
  side: "from the side",
  back: "from the back",
  detail: "in close-up detail",
};

const VIEWS = raw as Record<string, ProductView[]>;

/** Verified views for one product, hero first. Empty when unclassified. */
export function viewsFor(id: string): ProductView[] {
  return VIEWS[id] ?? [];
}
```

- [ ] **Step 5: Run the test**

Run: `npm run test:run src/lib/__tests__/product-views.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing test for data-driven selection**

Append to `src/lib/__tests__/visualize-prompt.test.ts`:

```ts
describe("referenceViews with classified data", () => {
  it("prefers supplied views over filename guessing", () => {
    const views = referenceViews(
      product({
        images: ["https://x/hero.jpg", "https://x/IMG_2231.jpg"],
        views: [
          { url: "https://x/hero.jpg", angle: "hero" },
          { url: "https://x/IMG_2231.jpg", angle: "back" },
        ],
      }),
    );
    expect(views.map((v) => v.angle)).toEqual([
      "as the catalogue shows it",
      "from the back",
    ]);
  });

  it("honours the cap on supplied views", () => {
    const views = referenceViews(
      product({
        images: [],
        views: [
          { url: "a", angle: "hero" },
          { url: "b", angle: "front" },
          { url: "c", angle: "side" },
        ],
      }),
      2,
    );
    expect(views).toHaveLength(2);
  });

  it("falls back to filenames when no views are supplied", () => {
    const views = referenceViews(
      product({ images: ["https://x/hero.jpg", "https://x/chair-Back.jpg"] }),
    );
    expect(views.map((v) => v.angle)).toEqual([
      "as the catalogue shows it",
      "from the back",
    ]);
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npm run test:run src/lib/__tests__/visualize-prompt.test.ts`
Expected: FAIL — `views` is not a property of `VisualizeProduct`, and supplied views are ignored.

- [ ] **Step 8: Add `views` to the product type**

In `src/lib/visualize-prompt.ts`, inside `VisualizeProduct`, add:

```ts
  /**
   * Verified reference views, attached by the caller from product-views.json.
   * Optional so this module stays free of data imports — it is reachable from
   * the client bundle.
   */
  views?: Array<{ url: string; angle: ViewAngleName }> | undefined;
```

- [ ] **Step 9: Make `referenceViews` prefer the data**

In `src/lib/visualize-prompt.ts`, replace the body of `referenceViews` with:

```ts
export function referenceViews(
  product: VisualizeProduct,
  max = MAX_VIEWS,
): Array<{ url: string; angle: string }> {
  // Classified data wins: it knows which photos are the same physical product,
  // which the filename cannot. Order is already hero-first from the classifier.
  if (product.views?.length) {
    return product.views.slice(0, max).map((v) => ({
      url: v.url,
      angle: ANGLE_PHRASES[v.angle],
    }));
  }

  const images = product.images ?? [];
  const out: Array<{ url: string; angle: string }> = [];
  const seen = new Set<string>();

  const push = (url: string | undefined, angle: string) => {
    if (!url || seen.has(url) || out.length >= max) return;
    seen.add(url);
    out.push({ url, angle });
  };

  push(images[0], "as the catalogue shows it");
  for (const [pattern, angle] of VIEW_ORDER) {
    push(
      images.find((u) => pattern.test(u) && !/salon-chair-\d|lifestyle|interior/i.test(u)),
      angle,
    );
  }
  return out;
}
```

Add above it, next to `VIEW_ORDER`:

```ts
/**
 * Duplicated from product-views.ts on purpose: that module imports JSON, and
 * this one must stay importable from the client bundle. The test in
 * product-views.test.ts asserts the two stay in step.
 *
 * Typed as Record<ViewAngle, string>, not Record<string, string>: this repo has
 * noUncheckedIndexedAccess, so a string-keyed record would make every lookup
 * `string | undefined` and fail to satisfy `angle: string`.
 */
type ViewAngleName = "hero" | "front" | "side" | "back" | "detail";

const ANGLE_PHRASES: Record<ViewAngleName, string> = {
  hero: "as the catalogue shows it",
  front: "from the front",
  side: "from the side",
  back: "from the back",
  detail: "in close-up detail",
};
```

- [ ] **Step 10: Add the drift guard test**

Append to `src/lib/__tests__/product-views.test.ts`:

```ts
import { referenceViews } from "@/lib/visualize-prompt";

it("phrases angles identically in both modules", () => {
  for (const angle of ["hero", "front", "side", "back", "detail"] as const) {
    const [view] = referenceViews({
      id: "x",
      name: "x",
      images: [],
      views: [{ url: "u", angle }],
    });
    expect(view?.angle).toBe(ANGLE_PHRASE[angle]);
  }
});
```

- [ ] **Step 11: Run everything**

Run: `npm run test:run && npx tsc --noEmit && npx eslint src`
Expected: all tests pass, no type errors, no lint errors.

- [ ] **Step 12: Commit**

```bash
git add src/lib/product-views.ts src/lib/visualize-prompt.ts src/data/product-views.json src/lib/__tests__
git commit -m "Select reference views from classified data, keep filename fallback"
```

---

## Task 4: Attach views on the render path

**Files:**
- Modify: `src/lib/visualize.functions.ts`

**Interfaces:**
- Consumes: `viewsFor` from `@/lib/product-views`
- Produces: every product handed to `buildRenderRequest()` carries its `views`

- [ ] **Step 1: Attach the views next to `col`**

In `src/lib/visualize.functions.ts`, add the import:

```ts
import { viewsFor } from "@/lib/product-views";
```

and change the product mapping in the `visualizeStart` handler from:

```ts
      const products = data.productIds.map((id) => {
        const product = catalog[id];
        if (!product) throw new Error("PRODUCT_NOT_FOUND");
        if (!product.images?.[0]) throw new Error("PRODUCT_HAS_NO_IMAGE");
        return { ...product, col: slim.find((p) => p.id === id)?.col || null };
      });
```

to:

```ts
      const products = data.productIds.map((id) => {
        const product = catalog[id];
        if (!product) throw new Error("PRODUCT_NOT_FOUND");
        if (!product.images?.[0]) throw new Error("PRODUCT_HAS_NO_IMAGE");
        const views = viewsFor(id);
        return {
          ...product,
          col: slim.find((p) => p.id === id)?.col || null,
          ...(views.length ? { views } : {}),
        };
      });
```

The spread is conditional because `exactOptionalPropertyTypes` rejects an
explicit `undefined` for an optional property.

- [ ] **Step 2: Verify the build still separates client and server**

Run: `npx tsc --noEmit && npm run build`
Expected: build succeeds. `product-views.json` must appear only under
`.output/server/`, never in a client chunk. Check with:

```bash
grep -rl "product-views" .output/public 2>/dev/null || echo "not in client bundle - correct"
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/visualize.functions.ts
git commit -m "Attach classified views to products on the render path"
```

---

## Task 5: The vision classifier

**Files:**
- Create: `scripts/classify-product-views.mjs`

**Interfaces:**
- Consumes: `ANTHROPIC_API_KEY` from `.env`, `src/data/catalog-full.json`
- Produces: `src/data/product-views.json` — `{ [id]: [{ url, angle }] }`

- [ ] **Step 1: Write the script**

`scripts/classify-product-views.mjs`:

```js
/**
 * One-off: classify each product's photos into usable reference views.
 *
 * Filenames cannot do this. Of 102 products with unused extra photos, 12 were
 * lifestyle shots, 30 were unclassifiable by name, and some extras are a
 * different variant of the product. A wrong "another angle" is worse than no
 * extra angle, so a vision model decides.
 *
 * Run:  node --env-file=.env scripts/classify-product-views.mjs
 *       node --env-file=.env scripts/classify-product-views.mjs --limit 5   (smoke test)
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "src/data/product-views.json");
const MODEL = "claude-sonnet-5";
const MAX_IMAGES = 6; // per product, per request
const CONCURRENCY = 4;

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error("ANTHROPIC_API_KEY missing. Run with: node --env-file=.env scripts/...");
  process.exit(1);
}

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;

const catalog = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src/data/catalog-full.json"), "utf8"),
);

const SYSTEM = `You classify product photographs for a salon furniture catalogue.

You are given several photographs from ONE catalogue listing. They are NOT
guaranteed to show the same physical item: some listings mix in a different
colourway or base variant, a lifestyle photo of a whole salon, or a photo of a
different product in the same range.

For each image, decide:
- "hero"   the main studio shot of the product, on a plain background
- "front"  the same physical product seen from the front
- "side"   the same physical product seen from the side
- "back"   the same physical product seen from the back
- "detail" a close-up of part of the same physical product
- "reject" anything else: a different variant (different colour, different base),
           a different product, a lifestyle or interior shot, a group shot, a
           swatch, a dimensioned drawing, or a photo too unclear to use

Be strict. These images are used as the reference for redrawing the product, so
a photo of a DIFFERENT variant labelled as another angle is worse than no photo
at all. If the upholstery colour or the base design differs from image 1, it is
"reject", not another angle.

Reply with JSON only: {"labels":["hero","side","reject", ...]} — exactly one
label per image, in the order given.`;

async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const type = res.headers.get("content-type") || "image/jpeg";
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4_500_000) return null; // API per-image ceiling
  return { type, data: buf.toString("base64") };
}

async function classify(id, product) {
  const urls = (product.images ?? []).slice(0, MAX_IMAGES);
  if (urls.length < 2) return null; // single photo needs no classifying

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
      max_tokens: 300,
      system: SYSTEM,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    console.error(`  ${id} API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }

  const json = await res.json();
  const text = json.content?.map((b) => b.text ?? "").join("") ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error(`  ${id} unparseable reply: ${text.slice(0, 120)}`);
    return null;
  }

  let labels;
  try {
    labels = JSON.parse(match[0]).labels;
  } catch {
    console.error(`  ${id} bad JSON: ${match[0].slice(0, 120)}`);
    return null;
  }
  if (!Array.isArray(labels) || labels.length !== fetched.length) {
    console.error(`  ${id} expected ${fetched.length} labels, got ${labels?.length}`);
    return null;
  }

  const VALID = new Set(["hero", "front", "side", "back", "detail"]);
  const views = fetched
    .map((img, i) => ({ url: img.url, angle: labels[i] }))
    .filter((v) => VALID.has(v.angle));

  // Hero first — the prompt says "the first image is the product reference".
  const order = { hero: 0, front: 1, side: 2, back: 3, detail: 4 };
  views.sort((a, b) => order[a.angle] - order[b.angle]);

  // A view list with no hero is not usable as a reference set.
  if (!views.some((v) => v.angle === "hero")) return null;
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
```

- [ ] **Step 2: Smoke test on five products**

Run: `node --env-file=.env scripts/classify-product-views.mjs --limit 5`
Expected: prints progress, writes `src/data/product-views.json` with at most 5
entries. Open the file and eyeball one entry against the product page — the
angles must be plausible and no lifestyle URL may appear.

- [ ] **Step 3: Verify the strictness actually bites**

Pick `Black Salon Stool` (id with hero `3900-Black-Salon-Stool-Black-Base.jpg`
and extra `Black-Salon-Stool.jpg`, which is a different base variant). Confirm it
is either absent from the output or has the variant rejected. If the classifier
accepted it as another angle, the system prompt is too lenient — tighten and
re-run before the full pass.

- [ ] **Step 4: Full run**

Run: `node --env-file=.env scripts/classify-product-views.mjs`
Expected: 136 products attempted, a report of how many produced a usable set.

- [ ] **Step 5: Commit the script and the data**

```bash
git add scripts/classify-product-views.mjs src/data/product-views.json
git commit -m "Classify product reference views with a vision pass"
```

---

## Task 6: Prove it changed the render

**Files:**
- None modified — this is verification.

**Interfaces:**
- Consumes: everything above

- [ ] **Step 1: Count the improvement**

Run:

```bash
node --experimental-strip-types --no-warnings -e "
const m = await import('./src/lib/visualize-prompt.ts');
const { createRequire } = await import('node:module');
const rq = createRequire(process.cwd() + '/x.js');
const c = rq('./src/data/catalog-full.json');
// Read the JSON directly rather than importing product-views.ts: that module
// imports via the @ alias, which node's type stripping cannot resolve.
const views = rq('./src/data/product-views.json');
let before = 0, after = 0;
for (const id of Object.keys(c)) {
  if (m.referenceViews(c[id], 4).length > 1) before++;
  const v = views[id] ?? [];
  if (m.referenceViews({ ...c[id], ...(v.length ? { views: v } : {}) }, 4).length > 1) after++;
}
console.log('multi-view products before:', before, '-> after:', after);
"
```

Expected: `after` is materially greater than 34. Record the number.

- [ ] **Step 2: Live render a product that gained views**

Pick one product that had exactly one usable view before and more than one now.
Render it in `replace` mode against a salon photo and compare against a render of
the same product from before this phase. Confirm the armrest profile and base are
closer to the reference.

This is a judgement call, not an assertion — record the two images and say plainly
whether it improved, got worse, or is indistinguishable. "Indistinguishable" is a
legitimate outcome worth recording.

- [ ] **Step 3: Full check and commit**

```bash
npm run test:run && npx tsc --noEmit && npx eslint src && npm run build
git commit --allow-empty -m "Verify Phase 0a: product view classification"
```

---

## Out of scope — Phase 0b

Blocked on a decision, not on code: backfilling `dims_cm` W×D×H for the 130
products missing depth or height, and reclassifying the 83 products whose
placement is generic `floor`. Both need product data from
`comfortelfurniture.com`, so they need sign-off on scraping and should use the
QuickAds proxy conventions. Phases 2–5 depend on that data; Phase 1 does not.
