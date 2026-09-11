import { test } from "node:test";
import assert from "node:assert/strict";
import { auditProduct, parseProductPage } from "./scrape-product-specs.mjs";

test("ignores shipping tables and related-product metadata", () => {
  const html =
    '<body class="single-product postid-123"><h1>Test chair</h1><h5>Dimensions &amp; Specifications</h5><div class="text-sm text-gray-700">Seat Width</div><div class="text-sm font-hairline text-gray-600">46cm</div><h5>Shipping Details</h5><div class="text-sm text-gray-700">Weight</div><div class="text-sm font-hairline text-gray-600">99kg</div><h2>Related products</h2><div data-product_id="999"></div>';
  assert.deepEqual(parseProductPage(html, { id: "123" }).specs, { "Seat Width": "46cm" });
  assert.throws(() => parseProductPage(html, { id: "999" }), /identity/);
});
test("keeps selectable configurations separate from included items", () => {
  const encoded = JSON.stringify([
    { option_title: "Round base", option_product_data: { price: "999" } },
    { option_title: "Square base" },
  ]).replaceAll('"', "&quot;");
  const html = `<body class="postid-123"><h1>Chair</h1><h6>Chrome Footrest Included with the Chair</h6><form><div id="component_123" data-nav_title="Choose Base Option"><div data-options_data="${encoded}"></div>dimensions & product details`;
  const p = parseProductPage(html, { id: "123" });
  assert.equal(p.specs["Base options"], "Round base; Square base");
  assert.equal(p.specs["Included footrest"], "Chrome Footrest Included with the Chair");
  assert.equal(p.specs.Base, undefined);
  assert.ok(!JSON.stringify(p).includes("999"));
});
test("audits capacity for seating, not mirrors", () => {
  assert.ok(
    auditProduct({
      id: "x",
      category: "salon/styling-chairs",
      specs: { Width: "60cm" },
    }).missing.includes("load capacity"),
  );
  assert.ok(
    !auditProduct({
      id: "x",
      category: "salon/mirrors",
      specs: { Width: "60cm" },
    }).missing.includes("load capacity"),
  );
});
