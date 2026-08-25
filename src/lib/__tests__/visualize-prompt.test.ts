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
