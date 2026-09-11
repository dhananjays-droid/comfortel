import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { PDFDocument, PDFName } from "pdf-lib";
import { CATALOG_FULL } from "@/lib/catalog";
import {
  documentLines,
  documentTotals,
  productSpec,
  comparisonSummary,
  resolveDocumentSelection,
  quoteRequestContext,
} from "@/lib/commerce-documents";
import { buildCommercePdf, loadProductImage } from "@/lib/commerce-pdf.server";

describe("quote data and matching", () => {
  it("calculates quantities and money in integer cents", () => {
    expect(documentTotals(documentLines(["330334", "330283"], { 330334: 4, 330283: 2 }))).toEqual({
      pricedSubtotal: 299400,
      pieces: 6,
      unknownPrices: 0,
    });
  });
  it("marks missing prices, never invents a complete total", () => {
    const lines = documentLines(["330334"]);
    lines[0]!.unitCents = null;
    expect(documentTotals(lines)).toEqual({ pricedSubtotal: 0, pieces: 1, unknownPrices: 1 });
  });
  it.each([0, 100, -1, 1.5, NaN])("rejects invalid quantity %s", (qty) => {
    expect(() => documentLines(["330334"], { 330334: qty })).toThrow();
  });
  it("rejects unknown IDs and oversized selections", () => {
    expect(() => documentLines(["unknown"])).toThrow();
    expect(() => documentLines(Array(11).fill("330334"))).toThrow();
  });
  it("resolves finishes without accidentally adding the plain black variant", () => {
    expect(resolveDocumentSelection("Compare Chloe Tan and Blake Textured Black").ids).toEqual([
      "330334",
      "330283",
    ]);
    expect(resolveDocumentSelection("Compare Blake Black vs Blake Textured Black").ids).toEqual([
      "330276",
      "330283",
    ]);
    expect(resolveDocumentSelection("Can you compare 4364-US and 4115-TBUS?").ids).toEqual([
      "330334",
      "330283",
    ]);
  });
  it("accepts explicit quantities without modifying a plan", () => {
    expect(
      resolveDocumentSelection("PDF quote for 4 Chloe Tan and two Blake Textured Black"),
    ).toEqual({ ids: ["330334", "330283"], quantities: { 330334: 4, 330283: 2 } });
    expect(resolveDocumentSelection("PDF quote for 2x 330334")).toEqual({
      ids: ["330334"],
      quantities: { 330334: 2 },
    });
  });
  it.each([
    "PDF quote for 0 Chloe Tan",
    "PDF quote for 1000 Chloe Tan",
    "PDF quote for 1.5 Chloe Tan",
    "PDF quote for Chloe Tan x 4",
    "Compare Chloe Tan and Unknown chair",
    "Compare 330334 and 999999",
    "Compare Chloe Tan White and Blake Black",
    "Compare Blake and Chloe",
  ])("does not silently guess or omit: %s", (input) => {
    expect(resolveDocumentSelection(input).ids).toEqual([]);
  });
  it("does not treat shipping weight or carton dimensions as installed specs", () => {
    const product = {
      ...CATALOG_FULL["330334"]!,
      specs: { "Shipping Weight": "999 kg", "Carton Width": "9 cm" },
    };
    expect(productSpec(product, ["Weight Capacity"])).toContain("Not listed");
    expect(productSpec(product, ["Width"])).toContain("Not listed");
  });
  it("explains comparable prices and differing product categories", () => {
    expect(comparisonSummary(documentLines(["330334", "330283"]))).toContain(
      "same listed unit price",
    );
    const lines = documentLines(["330334", "330283"]);
    lines[1]!.product = { ...lines[1]!.product, category: "other" };
    expect(comparisonSummary(lines)).toContain("different functions");
  });
  it("carries the estimate snapshot into a staff request, not a new price promise", () => {
    const context = quoteRequestContext("request:sales:quote:330334,330283:4,2:CQ-ABCDEF1234");
    expect(context).toContain("4 x Chloe");
    expect(context).toContain("2 x Blake");
    expect(context).toContain("CQ-ABCDEF1234");
    expect(quoteRequestContext("request:sales:quote:330334:0:CQ-ABCDEF1234")).toBeNull();
  });
});

describe("PDF generation", () => {
  it("creates a linked PDF even when product images are unavailable", async () => {
    const bytes = await buildCommercePdf(
      {
        kind: "quote",
        reference: "CQ-TEST",
        issuedAt: "2026-09-11",
        lines: documentLines(["330334"], { 330334: 4 }),
      },
      async () => null,
    );
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getTitle()).toContain("estimate");
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPages()[0]!.node.get(PDFName.of("Annots"))).toBeTruthy();
  });
  it("paginates 10 quote lines without requiring network images", async () => {
    const bytes = await buildCommercePdf(
      {
        kind: "quote",
        reference: "CQ-LARGE",
        issuedAt: "2026-09-11",
        lines: documentLines(Object.keys(CATALOG_FULL).slice(0, 10)),
      },
      async () => null,
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  });
  it("never fetches arbitrary hosts or non-product URLs", async () => {
    expect(await loadProductImage("http://127.0.0.1/private")).toBeNull();
    expect(await loadProductImage("https://comfortelfurniture.com/contact-us/")).toBeNull();
  });
  it.skipIf(process.env["PDF_SAMPLES"] !== "1")(
    "writes real-catalog samples for rendered visual QA",
    async () => {
      await mkdir("output/pdf", { recursive: true });
      for (const kind of ["quote", "comparison"] as const) {
        const bytes = await buildCommercePdf({
          kind,
          reference: `${kind === "quote" ? "CQ" : "CC"}-SAMPLE`,
          issuedAt: "2026-09-11",
          lines: documentLines(
            ["330334", "330283", "330276"],
            kind === "quote" ? { 330334: 4, 330283: 2, 330276: 2 } : {},
          ),
        });
        await writeFile(`output/pdf/comfortel-sample-${kind}.pdf`, bytes);
      }
    },
    30000,
  );
});
