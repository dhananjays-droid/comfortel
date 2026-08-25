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
