import { afterEach, describe, expect, it, vi } from "vitest";

import { createVisualizeTask, KIE_IMAGE_MODEL, resolutionFor } from "@/lib/kie.server";
import { VISUALIZE_MODES } from "@/lib/visualize-prompt";

const ORIGINAL_API_KEY = process.env["KIE_API_KEY"];
afterEach(() => {
  if (ORIGINAL_API_KEY === undefined) delete process.env["KIE_API_KEY"];
  else process.env["KIE_API_KEY"] = ORIGINAL_API_KEY;
  vi.restoreAllMocks();
});

describe("Kie image model", () => {
  it("sends GPT Image 2.5 Flare through Kie's existing createTask contract", async () => {
    process.env["KIE_API_KEY"] = "test-key";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 200, msg: "success", data: { taskId: "task-1" } })),
      );

    await expect(
      createVisualizeTask(null, [], "Design a salon", "3:2", "staged_room"),
    ).resolves.toBe("task-1");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "gpt-image-2-5-flare-image-to-image",
      input: {
        input_urls: [],
        prompt: "Design a salon",
        aspect_ratio: "3:2",
        resolution: "1K",
      },
    });
    expect(KIE_IMAGE_MODEL).toBe("gpt-image-2-5-flare-image-to-image");
  });
});

describe("resolutionFor", () => {
  it("uses 1K for every render mode", () => {
    for (const mode of VISUALIZE_MODES) {
      expect(resolutionFor(mode)).toBe("1K");
    }
  });
});
