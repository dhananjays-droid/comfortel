import { describe, expect, it } from "vitest";

import { ANGLE_PHRASE, viewsFor } from "@/lib/product-views";
import { referenceViews } from "@/lib/visualize-prompt";

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
});
