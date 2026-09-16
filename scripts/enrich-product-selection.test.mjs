import { test } from "node:test";
import assert from "node:assert/strict";
import { selectionEvidence } from "./enrich-product-selection.mjs";
const p = { id: "123", name: "Test Chair", url: "https://comfortelfurniture.com/shop/test", description: null, category: "chairs" };
test("checks exact product identity and excludes unrelated page text", () => {
  const html = '<body class="postid-123"><h1>Test Chair</h1><h4>Styling Chair</h4><div class="mb-3 rich-content"><p>Compact chair.</p></div><h2>perfect for</h2><p>Make Up<br>Brows</p></div>#instasalon<div class="rich-content">An unrelated LED mirror.</div>';
  const r = selectionEvidence(html, p);
  assert.equal(r.description, "Compact chair.");
  assert.deepEqual(r.intendedUses, ["Make Up", "Brows"]);
  assert.ok(!r.details.join(" ").includes("unrelated"));
  assert.throws(() => selectionEvidence(html, { ...p, id: "999" }), /identity/);
  assert.throws(() => selectionEvidence(html, { ...p, name: "Another Chair" }), /title/);
});
