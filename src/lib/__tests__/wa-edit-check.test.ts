import { afterEach, describe, expect, it, vi } from "vitest";
import { editDeliveryNote, inspectWhatsAppEdit, readEditVerdict } from "@/lib/wa-edit-check.server";
import { shouldRetry } from "@/lib/render-qa";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("WhatsApp edit verification", () => {
  it("rejects a partial two-chair change and permits only one correction", () => {
    const verdict = readEditVerdict({
      complete: false,
      issue: "The second barber chair is still black; change it to white too.",
    });
    expect(verdict.editCheck).toBe("failed");
    expect(shouldRetry(verdict, 0)).toBe(true);
    expect(shouldRetry(verdict, 1)).toBe(false);
    expect(editDeliveryNote(verdict)).toContain("hasn’t fully matched");
  });
  it("does not label missing or malformed checks as verified", () => {
    for (const raw of [null, {}, { complete: "true" }, { complete: false }]) {
      const verdict = readEditVerdict(raw);
      expect(verdict.editCheck).toBe("unavailable");
      expect(editDeliveryNote(verdict)).toContain("couldn’t automatically verify");
      expect(shouldRetry(verdict, 0)).toBe(false);
    }
    expect(
      editDeliveryNote(
        readEditVerdict({ complete: true, issue: "", targets: [{ satisfied: true }] }),
      ),
    ).toBe("");
    expect(readEditVerdict({ complete: true, issue: "" }).editCheck).toBe("unavailable");
    expect(
      readEditVerdict({
        complete: true,
        targets: [{ position: "second chair", after: "still black", satisfied: false }],
      }).editCheck,
    ).toBe("failed");
  });
  it("sends the original, result, and exact customer instruction to the checker", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        content: [
          {
            type: "tool_use",
            name: "record_edit_check",
            input: { complete: false, issue: "One chair remains black" },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await inspectWhatsAppEdit(
      "https://example.com/before.png",
      "https://example.com/after.png",
      "Change both black chairs to white",
    );
    expect(result.editCheck).toBe("failed");
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(
      body.messages[0].content.map(
        (x: { source?: { url: string }; text?: string }) => x.source?.url ?? x.text,
      ),
    ).toEqual([
      "https://example.com/before.png",
      "https://example.com/after.png",
      "Requested edit: Change both black chairs to white",
    ]);
  });
  it("degrades honestly on an inspector outage without throwing or retrying blindly", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 })));
    expect((await inspectWhatsAppEdit("before", "after", "change both chairs")).editCheck).toBe(
      "unavailable",
    );
  });
});
