import { test } from "vitest";
import { writeFileSync } from "node:fs";
import { CATALOG_FULL } from "@/lib/catalog";
import { selectionProfile } from "@/lib/product-selection";
import { salonPlans } from "@/lib/wa-advisor-tools";

test.skipIf(process.env.SELECTION_REPORT !== "yes")("export local product profiles and representative plans without provider calls", () => {
  const products = Object.values(CATALOG_FULL).map(p => ({ id: p.id, name: p.name, selection_profile: selectionProfile(p) }));
  const cases = [{ name: "Hair styling" }, { name: "Colour services", service_focus: "colour" }, { name: "Makeup and brows", service_focus: "makeup_brows" }, { name: "Compact styling", chair_priority: "compact" }, { name: "Barber", service_focus: "barber" }];
  const plans = cases.map(({ name, ...preferences }) => {
    const p = salonPlans({ stations: 3, budget: 25000, currency: "USD", scope: "equipment", ...preferences });
    return { name, preferences, selected: p.options.find(o => o.tier === p.recommendedTier), explanation: p.selectionReasons, budgetNote: p.budgetNote };
  });
  writeFileSync("docs/product-selection-profiles.json", JSON.stringify({ generatedAt: new Date().toISOString(), products, plans }, null, 2) + "\n");
  const esc = (s: string) => s.replaceAll("|", "/").replaceAll("\n", " ");
  const rows = ["# Product selection review sheet", "", "Generated from the local sourced profiles; not client-approved or deployed. Null features mean unknown. See product-selection-guide.md for evidence rules and limitations.", "", "| Product | Primary use | Documented features | Evidence status |", "| --- | --- | --- | --- |", ...products.map(p => `| [${esc(p.name)}](${p.selection_profile.sourceUrl}) (${p.id}) | ${p.selection_profile.primaryUse} | ${Object.entries(p.selection_profile.features).filter(([,v]) => v === true).map(([k]) => k).join(", ") || "Needs review"} | ${p.selection_profile.evidenceStatus} |`), "", "## Example plans: 3 stations, $25,000 equipment budget", "", ...plans.flatMap(p => [`### ${p.name}`, "", ...(p.selected?.lines.map(l => `- ${l.qty} × ${l.name}: $${l.subtotal}`) ?? []), "", `Subtotal: $${p.selected?.total}. ${p.budgetNote}`, ""] )];
  writeFileSync("docs/product-selection-review.md", rows.join("\n"));
});
