import { describe, expect, it } from "vitest";
import { buildRenderRequest, MAX_PROMPT_CHARS, type VisualizeProduct } from "@/lib/visualize-prompt";
import { whatsappImagePrompt } from "@/lib/wa-image-scope";

const product = (id: string, name: string, qty: number): VisualizeProduct => ({
  id, name, qty, images: [`https://example.com/${id}.jpg`], replaces: name,
});

describe("WhatsApp first-attempt composition", () => {
  it.each([1, 3, 5, 10])("preserves %i-unit inventory and reference mapping", qty => {
    const products = [product("chair", "Tan Styling Chair", qty), product("mirror", "Wall Mirror", qty), product("desk", "Reception Desk", 1)];
    const request = buildRenderRequest(products, "staged_room");
    const prompt = whatsappImagePrompt(request.prompt, "staged_room");
    expect(prompt).toContain(`${qty} × Tan Styling Chair`);
    expect(prompt).toContain(`${qty} × Wall Mirror`);
    expect(prompt).toContain("1 × Reception Desk");
    expect(prompt).toContain("separate visible floor or wall position");
    expect(prompt).toContain("no fewer and no extra copies");
    expect(prompt).not.toContain("beyond what a room like this genuinely needs");
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
    expect(request.imageUrls).toEqual(buildRenderRequest(products, "staged_room").imageUrls);
  });
  it("does not repeat a single requested item across the whole photo", () => {
    const request = buildRenderRequest([product("chair", "Chair", 1)], "refit_room");
    const prompt = whatsappImagePrompt(request.prompt, "refit_room");
    expect(prompt).not.toContain("repeat the matching Comfortel piece across all");
    expect(prompt).not.toContain("none of the salon's original furniture");
    expect(prompt).toContain("Preserve furniture outside the requested change");
    expect(prompt).toContain("QUANTITIES");
    expect(prompt).toContain("1 × Chair");
    expect(prompt).toContain("Reproduce each product exactly");
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });
  it("retains the inventory and fidelity clauses for a five-chair refit", () => {
    const request = buildRenderRequest([product("chair", "Chair", 5)], "refit_room");
    const prompt = whatsappImagePrompt(request.prompt, "refit_room");
    expect(prompt).toContain("5 × Chair");
    expect(prompt).toContain("Reproduce each product exactly");
    expect(prompt).not.toContain("leave the rest out");
    expect(prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });
  it("leaves targeted edit and replacement prompts untouched", () => {
    for (const mode of ["edit", "replace", "replace_all", "lineup", "add"] as const) {
      const request = buildRenderRequest([product("chair", "Chair", 1)], mode);
      expect(whatsappImagePrompt(request.prompt, mode)).toBe(request.prompt);
    }
  });
});
