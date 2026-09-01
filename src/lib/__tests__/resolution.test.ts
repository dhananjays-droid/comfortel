import { afterEach, describe, expect, it } from "vitest";

import { resolutionFor } from "@/lib/kie.server";
import { VISUALIZE_MODES, isMultiReferenceMode } from "@/lib/visualize-prompt";

const ORIGINAL = process.env["KIE_IMAGE_RESOLUTION"];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env["KIE_IMAGE_RESOLUTION"];
  else process.env["KIE_IMAGE_RESOLUTION"] = ORIGINAL;
});

describe("resolutionFor", () => {
  it("spends 2K only where several different products share a frame", () => {
    // 2K is four times the pixels for two-thirds more money, and what it buys
    // is each product's share of them. One product has one identity to get
    // right and is read in a chat bubble, so it gains almost nothing.
    delete process.env["KIE_IMAGE_RESOLUTION"];
    expect(resolutionFor("refit_room")).toBe("2K");
    expect(resolutionFor("lineup")).toBe("2K");
    expect(resolutionFor("staged_room")).toBe("2K");

    expect(resolutionFor("replace")).toBe("1K");
    expect(resolutionFor("replace_all")).toBe("1K");
    expect(resolutionFor("add")).toBe("1K");
  });

  it("keeps the tier tied to crowding, not to a hand-kept list", () => {
    delete process.env["KIE_IMAGE_RESOLUTION"];
    for (const mode of VISUALIZE_MODES) {
      expect(resolutionFor(mode)).toBe(isMultiReferenceMode(mode) ? "2K" : "1K");
    }
  });

  it("lets the env override force a whole run to one tier", () => {
    process.env["KIE_IMAGE_RESOLUTION"] = "4K";
    expect(resolutionFor("add")).toBe("4K");
    expect(resolutionFor("refit_room")).toBe("4K");
  });

  it("ignores a junk override rather than sending it upstream", () => {
    process.env["KIE_IMAGE_RESOLUTION"] = "8K";
    expect(resolutionFor("add")).toBe("1K");
    expect(resolutionFor("refit_room")).toBe("2K");
  });
});
