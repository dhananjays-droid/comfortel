import { describe, it, expect, vi, afterEach } from "vitest";
import { CATALOG_FULL } from "@/lib/catalog";
import {
  withProductSpecifications,
  productEnrichment,
  productSpecificationContext,
} from "@/lib/product-specifications";
import { comparisonFieldsFor, documentLines, productSpec } from "@/lib/commerce-documents";
import { runChatTurn, parseChatInput } from "@/lib/chat.functions";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sourced product specifications", () => {
  it("enriches the Blake configuration without changing original catalog data", () => {
    const original = CATALOG_FULL["330283"]!;
    const snapshot = structuredClone(original);
    const enriched = withProductSpecifications(original);
    expect(enriched.specs?.["Base options"]).toBeTruthy();
    expect(enriched.specs?.["Lift options"]).toBeTruthy();
    expect(enriched.specs?.["Included footrest"]).toContain("Included");
    expect(enriched.price).toBe(original.price);
    expect(original).toEqual(snapshot);
    expect(productEnrichment(original)?.sourceUrl).toBe(original.url);
  });
  it("does not mistake hydraulic stroke lengths for installed seat-height ranges", () => {
    const product = withProductSpecifications(CATALOG_FULL["330283"]!);
    expect(product.specs?.["Lift options"]).toContain("125mm");
    expect(productSpec(product, ["Seat Height Range"])).toContain("Not listed");
  });
  it("shows existing finish and seat-height labels previously omitted", () => {
    const chair = Object.values(CATALOG_FULL).find((p) => p.category === "barbers/barber-chairs")!;
    expect(productSpec(chair, ["Colour", "Color", "Finish"])).not.toContain("Not listed");
    expect(comparisonFieldsFor([chair]).some(([label]) => label === "Seat height range")).toBe(
      true,
    );
  });
  it("does not ask mirror buyers for a chair load capacity", () => {
    const mirror = Object.values(CATALOG_FULL).find((p) => p.category === "salon/mirrors")!;
    expect(comparisonFieldsFor([mirror]).some(([label]) => label === "Load capacity")).toBe(false);
    expect(comparisonFieldsFor([mirror]).some(([label]) => label === "Installation")).toBe(true);
  });
  it("provides factual per-model context to WhatsApp and distinguishes options", () => {
    const context = productSpecificationContext(
      "What base options does Blake Textured Black have?",
    );
    expect(context).toContain("330283");
    expect(context).toContain("Base options");
    expect(context).toContain("not the included configuration");
    expect(context).not.toContain('"Shipping Weight"');
    expect(productSpecificationContext("Hi", [])).toBe("");
  });
  it("uses the same enriched data for comparison documents", () => {
    expect(documentLines(["330283"])[0]?.product.specs?.["Base options"]).toBeTruthy();
  });
  it("rejects an overlay if the product URL or model no longer matches", () => {
    const product = { ...CATALOG_FULL["330283"]!, url: "https://example.com/different" };
    expect(productEnrichment(product)).toBeNull();
  });
  it("adds specification context only to WhatsApp model requests", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-only");
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ content: [{ type: "text", text: "Test answer" }] })),
    );
    vi.stubGlobal("fetch", fetcher);
    const input = parseChatInput({
      messages: [{ role: "user", content: "What base options does Blake Textured Black have?" }],
      plan: [],
    });
    await runChatTurn(input, "whatsapp");
    expect(JSON.stringify(fetcher.mock.calls)).toContain(
      "PRODUCT SPECIFICATIONS FOR THIS WHATSAPP CONVERSATION",
    );
    fetcher.mockClear();
    await runChatTurn(input);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(
      "PRODUCT SPECIFICATIONS FOR THIS WHATSAPP CONVERSATION",
    );
  });
  it("records parent sources for component configuration relationships", () => {
    const product = withProductSpecifications(CATALOG_FULL["4013"]!);
    expect(product.specs?.["Listed with"]).toContain("Blake");
    expect(productEnrichment(product)?.fieldSources?.["Listed with"]?.length).toBeGreaterThan(0);
  });
});
