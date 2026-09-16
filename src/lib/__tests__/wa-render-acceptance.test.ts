import { describe, expect, it } from "vitest";
import { quantityReview } from "@/lib/wa-render-acceptance";
import { whatsappImagePrompt } from "@/lib/wa-image-scope";

describe("WhatsApp delivery quantity gate (no provider calls)", () => {
  const expected = [{ name: "Chair", qty: 5 }, { name: "Table", qty: 5 }];
  it("bounds long mismatch captions for WhatsApp delivery", () => {
    const result = quantityReview(Array.from({ length: 20 }, (_, i) => ({ name: `${i} ${"Long product name ".repeat(10)}`, qty: 5 })), { ok: true, faults: [] });
    expect(result.message.length).toBeLessThan(900);
  });
  it.each([4, 6])("flags %i chairs when five were requested", seen => {
    const result = quantityReview(expected, { ok: true, faults: [], counts: [{ item: "Chair", seen }, { item: "Table", seen: 5 }] });
    expect(result.accepted).toBe(false);
    expect(result.message).toContain(`requested 5, counted ${seen}`);
  });
  it("requires all expected products exactly once", () => {
    for (const counts of [[], [{ item: "Chair", seen: 5 }], [{ item: "Chair", seen: 5 }, { item: "Chair", seen: 5 }, { item: "Table", seen: 5 }]])
      expect(quantityReview(expected, { ok: true, faults: [], counts }).accepted).toBe(false);
  });
  it("accepts matching counts but not unavailable inspection or edit checks", () => {
    const verdict = { ok: true, faults: [], counts: expected.map(p => ({ item: p.name, seen: p.qty })) };
    expect(quantityReview(expected, verdict).accepted).toBe(true);
    expect(quantityReview(expected, { ...verdict, inspection: "unavailable" }).accepted).toBe(false);
    expect(quantityReview([], { ...verdict, editCheck: "unavailable" } as typeof verdict).accepted).toBe(false);
  });
  it("removes refit permission to silently omit furniture without changing web prompts", () => {
    const prompt = "If the floor visible in this photograph genuinely cannot hold that many, leave the rest out.\nCheck counts — or, where the room could not take them, fewer, properly spaced, rather than crammed.";
    expect(whatsappImagePrompt(prompt, "refit_room")).not.toContain("leave the rest out");
    expect(whatsappImagePrompt(prompt, "refit_room")).toContain("Never silently reduce");
    expect(whatsappImagePrompt(prompt, "staged_room")).toBe(prompt);
  });
});
