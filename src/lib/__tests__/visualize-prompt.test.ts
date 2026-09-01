import { describe, expect, it } from "vitest";

import {
  MAX_PROMPT_CHARS,
  MAX_REFERENCE_SLOTS,
  allocateReferences,
  buildRenderRequest,
  needsRoomPhoto,
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
        images: ["https://x/hero.jpg", "https://x/chair-Front.jpeg", "https://x/chair-Side.jpeg"],
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
    const views = referenceViews(product({ images: ["https://x/hero.jpg", "https://x/hero.jpg"] }));
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
      expect(buildRenderRequest([long], mode).prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
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
    expect(views.map((v) => v.angle)).toEqual(["as the catalogue shows it", "from the back"]);
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
    expect(views.map((v) => v.angle)).toEqual(["as the catalogue shows it", "from the back"]);
  });

  it("uses classified views even when the filenames say nothing", () => {
    const { imageUrls } = buildRenderRequest(
      [
        product({
          images: ["https://x/6083_001.jpg", "https://x/6083_002.jpg"],
          views: [
            { url: "https://x/6083_001.jpg", angle: "hero" },
            { url: "https://x/6083_002.jpg", angle: "side" },
          ],
        }),
      ],
      "replace",
    );
    expect(imageUrls).toEqual(["https://x/6083_001.jpg", "https://x/6083_002.jpg"]);
  });
});

describe("single-replace stays minimal", () => {
  it("keeps one plain scope sentence, not the failed prose stack", () => {
    const { prompt } = buildRenderRequest([product()], "replace");
    expect(prompt).toContain("Change only the styling chair closest to the camera");
    // Guards against the four wordings that each produced a different wrong render.
    expect(prompt).not.toContain("TARGET:");
    expect(prompt).not.toContain("SCOPE: exactly ONE");
    expect(prompt).not.toContain("mirror scope follows floor scope");
  });

  it("still reconciles mirrors with the floor", () => {
    const { prompt } = buildRenderRequest([product()], "replace");
    expect(prompt).toContain("must agree with whatever now stands in front of it");
  });
});

describe("zone renders", () => {
  it("tells the model which part of the salon it is rendering", () => {
    const { prompt } = buildRenderRequest([product()], "refit_room", "the wash bay");
    expect(prompt).toContain("This render is of the wash bay");
    expect(prompt).toContain("do not invent pieces for other areas");
  });

  it("omits the scene clause entirely for a whole-room refit", () => {
    const { prompt } = buildRenderRequest([product()], "refit_room");
    expect(prompt).not.toContain("This render is of");
  });

  it("keeps a scened zone prompt inside the budget", () => {
    const long = product({ name: "D".repeat(150) });
    const { prompt } = buildRenderRequest([long], "refit_room", "the drying and waiting area");
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });
});

describe("quantities in a refit", () => {
  const plan = [
    product({ id: "c", name: "Panther Barbers Chair", qty: 4, images: ["https://x/chair.jpg"] }),
    product({ id: "m", name: "Villa II Mirror", qty: 4, images: ["https://x/mirror.jpg"] }),
    product({ id: "d", name: "Walker Reception Desk", images: ["https://x/desk.jpg"] }),
  ];

  const refit = (products: VisualizeProduct[]) => buildRenderRequest(products, "refit_room").prompt;

  it("says how many of each to install", () => {
    // Without this a four-chair package rendered as one chair, under a subtotal
    // that had charged for four.
    const prompt = refit(plan);
    expect(prompt).toContain("install 4 of this one");
    expect(prompt).toContain("4 × Panther Barbers Chair, 4 × Villa II Mirror");
  });

  it("counts a product with no quantity as one", () => {
    expect(refit(plan)).toContain("1 × Walker Reception Desk");
    expect(refit([product({ name: "Solo" })])).toContain("install 1 of this one");
  });

  it("lets the render come up short rather than cheat the room", () => {
    // The count must never be met by shrinking, overlapping or burying pieces —
    // that produces the exact fault the inspector is there to catch.
    const prompt = refit(plan);
    expect(prompt).toMatch(/install as many as properly fit and leave the rest out/);
    expect(prompt).toMatch(/Never shrink a piece, overlap two, sink one into a wall/);
  });

  it("does not offer that licence when nothing repeats", () => {
    // With one of each there is no number to fall short of, and the clause would
    // read as permission to skip pieces.
    expect(refit([product({ name: "Solo" })])).not.toMatch(/leave the rest out/);
  });

  it("asks for the repeats to match each other", () => {
    expect(refit(plan)).toMatch(/Keep every repeat of one product identical/);
  });

  it("checks the count before it finishes", () => {
    expect(refit(plan)).toMatch(/as many of each as the quantities above ask for/);
  });

  it("never repeats a photograph once per piece", () => {
    // Quantity is carried by the prompt, not by the image array: four copies of
    // the same photograph would spend four slots and teach the model nothing.
    const urls = buildRenderRequest(plan, "refit_room").imageUrls;
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toHaveLength(3);
  });

  it("stays inside the prompt budget with quantities and a correction", () => {
    const prompt = buildRenderRequest(
      plan,
      "refit_room",
      "the styling floor at the mirror stations",
      "The previous attempt came back broken — a piece passing through a wall.",
    ).prompt;
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });

  it("ignores a nonsense quantity", () => {
    expect(refit([product({ name: "Solo", qty: Number.NaN })])).toContain("install 1 of this one");
    expect(refit([product({ name: "Solo", qty: 0 })])).toContain("1 × Solo");
  });
});

describe("referenceViews prefers distinct angles", () => {
  const withViews = (angles: Array<"hero" | "front" | "side" | "back" | "detail">) =>
    product({
      views: angles.map((angle, i) => ({ url: `https://x/${angle}${i}.jpg`, angle })),
    });

  it("drops a duplicate angle before a distinct one", () => {
    // Harper's real set. Taking the first four in order spent a slot on the
    // second side shot and lost the back view entirely.
    const views = referenceViews(withViews(["hero", "front", "side", "side", "back"]), 4);
    expect(views.map((v) => v.angle)).toEqual([
      "as the catalogue shows it",
      "from the front",
      "from the side",
      "from the back",
    ]);
  });

  it("keeps a duplicate when there is a slot going spare", () => {
    const views = referenceViews(withViews(["hero", "side", "side"]), 4);
    expect(views).toHaveLength(3);
    expect(views.map((v) => v.url)).toEqual([
      "https://x/hero0.jpg",
      "https://x/side1.jpg",
      "https://x/side2.jpg",
    ]);
  });

  it("still leads with the hero", () => {
    expect(referenceViews(withViews(["hero", "back", "front"]), 4)[0]?.angle).toBe(
      "as the catalogue shows it",
    );
  });

  it("honours the cap", () => {
    expect(referenceViews(withViews(["hero", "front", "side", "back", "detail"]), 2)).toHaveLength(
      2,
    );
  });
});

describe("allocateReferences", () => {
  const withViews = (id: string, name: string, n: number): VisualizeProduct =>
    product({
      id,
      name,
      views: (["hero", "front", "side", "back"] as const)
        .slice(0, n)
        .map((angle) => ({ url: `https://x/${id}-${angle}.jpg`, angle })),
    });

  it("gives every product its hero before anyone gets a second view", () => {
    // A plan is unusable if a piece is missing entirely, however well
    // photographed its neighbour is.
    const blocks = allocateReferences([
      withViews("a", "Chair", 4),
      withViews("b", "Mirror", 4),
      withViews("c", "Trolley", 1),
    ]);
    expect(blocks.map((b) => b.product.id)).toEqual(["a", "b", "c"]);
    expect(blocks.every((b) => b.views[0]?.angle === "as the catalogue shows it")).toBe(true);
  });

  it("numbers the blocks contiguously, starting after the room photo", () => {
    const blocks = allocateReferences([withViews("a", "Chair", 3), withViews("b", "Mirror", 2)]);
    expect(blocks[0]?.start).toBe(2);
    expect(blocks[1]?.start).toBe(2 + (blocks[0]?.views.length ?? 0));
  });

  it("never exceeds the slots the API leaves free", () => {
    const many = Array.from({ length: 10 }, (_, i) => withViews(`p${i}`, `P${i}`, 4));
    const total = allocateReferences(many).reduce((n, b) => n + b.views.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_REFERENCE_SLOTS);
  });

  it("spreads the spare slots rather than spending them all on one product", () => {
    // Twelve slots left over must not become twelve photos of the chair.
    const blocks = allocateReferences([
      withViews("a", "Chair", 4),
      withViews("b", "Mirror", 4),
      withViews("c", "Trolley", 4),
    ]);
    const counts = blocks.map((b) => b.views.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it("does not invent views a product does not have", () => {
    const blocks = allocateReferences([withViews("a", "Chair", 1), withViews("b", "Mirror", 4)]);
    expect(blocks[0]?.views).toHaveLength(1);
  });

  it("skips a product with no usable image at all", () => {
    const blocks = allocateReferences([
      product({ id: "none", images: [] }),
      withViews("b", "M", 2),
    ]);
    expect(blocks.map((b) => b.product.id)).toEqual(["b"]);
    expect(blocks[0]?.start).toBe(2);
  });
});

describe("a refit that groups several views per product", () => {
  const rich = (id: string, name: string, qty?: number): VisualizeProduct =>
    product({
      id,
      name,
      ...(qty ? { qty } : {}),
      views: (["hero", "front", "side", "back"] as const).map((angle) => ({
        url: `https://x/${id}-${angle}.jpg`,
        angle,
      })),
    });

  const plan = [rich("a", "Panther Barbers Chair", 4), rich("b", "Villa II Mirror", 4)];

  it("sends more than one image per product now the slots exist", () => {
    const { imageUrls } = buildRenderRequest(plan, "refit_room");
    expect(imageUrls.length).toBeGreaterThan(plan.length);
    expect(imageUrls.length).toBeLessThanOrEqual(MAX_REFERENCE_SLOTS);
  });

  it("tells the model those images are ONE product, not several", () => {
    // The fault this guards: six photos of three products furnished as six.
    const { prompt } = buildRenderRequest(plan, "refit_room");
    expect(prompt).toMatch(/ALL THE SAME single product/);
    expect(prompt).toMatch(/exactly 2 DIFFERENT products in these references/);
  });

  it("names the image range each product occupies", () => {
    const { prompt } = buildRenderRequest(plan, "refit_room");
    expect(prompt).toMatch(/Images 2 to \d/);
  });

  it("keeps the prompt's image numbering in step with the array it sends", () => {
    // The bug this prevents: a prompt describing an image the request never sent.
    const { prompt, imageUrls } = buildRenderRequest(plan, "refit_room");
    const last = Math.max(
      ...[...prompt.matchAll(/Images? (?:\d+ to )?(\d+)/g)].map((m) => Number(m[1])),
    );
    expect(last).toBe(imageUrls.length + 1);
  });

  it("says nothing about grouping when every product has one photo", () => {
    const flat = [product({ id: "a", name: "Solo" }), product({ id: "b", name: "Duo" })];
    const { prompt } = buildRenderRequest(flat, "refit_room");
    expect(prompt).not.toMatch(/ALL THE SAME single product/);
    expect(prompt).toMatch(/Image 2 is a Solo/);
  });

  it("still fits the prompt budget at full width", () => {
    const wide = Array.from({ length: 8 }, (_, i) => rich(`p${i}`, `Product Number ${i}`, 4));
    expect(buildRenderRequest(wide, "refit_room").prompt.length).toBeLessThanOrEqual(
      MAX_PROMPT_CHARS,
    );
  });
});

describe("staged_room — no photograph", () => {
  const products = [
    { id: "a", name: "Harper Styling Chair", images: ["https://x/a.jpg"], qty: 4 },
    { id: "b", name: "Sienna Salon Mirror", images: ["https://x/b.jpg"], qty: 4 },
  ] as unknown as Parameters<typeof buildRenderRequest>[0];

  it("numbers the references from 1, since no room takes the first slot", () => {
    // Off by one here and every positional reference in the prompt points at
    // the wrong product, which is the exact failure the grouping prevents.
    const { prompt } = buildRenderRequest(products, "staged_room");
    expect(prompt).toContain("Image 1");
    expect(prompt).not.toMatch(/first image is a photograph/i);
  });

  it("says there is no room, so the model builds one", () => {
    const { prompt } = buildRenderRequest(products, "staged_room");
    expect(prompt).toMatch(/NO photograph of a room/i);
    expect(prompt).toMatch(/building the room/i);
  });

  it("still demands the products be copied exactly", () => {
    // The room being invented is no licence to invent the furniture.
    const { prompt } = buildRenderRequest(products, "staged_room");
    expect(prompt).toMatch(/COPY EACH PRODUCT EXACTLY/);
    expect(prompt).toMatch(/ARMRESTS/);
  });

  it("carries the quantities", () => {
    const { prompt } = buildRenderRequest(products, "staged_room");
    expect(prompt).toContain("4 × Harper Styling Chair");
    expect(prompt).toContain("4 × Sienna Salon Mirror");
  });

  it("sends no room image, only references", () => {
    const { imageUrls } = buildRenderRequest(products, "staged_room");
    expect(imageUrls).toEqual(["https://x/a.jpg", "https://x/b.jpg"]);
  });

  it("is the only mode that needs no photograph", () => {
    expect(needsRoomPhoto("staged_room")).toBe(false);
    for (const mode of ["replace", "replace_all", "add", "refit_room", "lineup"] as const) {
      expect(needsRoomPhoto(mode)).toBe(true);
    }
  });
});
