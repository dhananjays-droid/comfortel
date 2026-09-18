import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { salonPlans } from "@/lib/wa-advisor-tools";
import { productFit } from "@/lib/wa-product-fit";
import { CATALOG_FULL } from "@/lib/catalog";
import { conversationMemory } from "@/lib/wa-conversation-state";
import { readIntake } from "@/lib/brief";

const cases = [
  { name: "$18k / 8-station starter", budget: 18000, stations: 8 },
  { name: "$25k / 12 stations, 4 washes, 12 trolleys, 3 stools", budget: 25000, stations: 12, equipment_quantities: { wash: 4, trolley: 12, stool: 3 } },
  { name: "$35k / 20 stations, double mirrors, 5 washes", budget: 35000, stations: 20, mirror_layout: "island", equipment_quantities: { wash: 5, trolley: 20, stool: 5 } },
  { name: "$45k / 29 stations, 17 washes", budget: 45000, stations: 29, mirror_layout: "island", equipment_quantities: { wash: 17, trolley: 29, stool: 8 } },
  { name: "$45k / maximum stations", budget: 45000, objective: "max_stations" },
  { name: "$65k / maximum stations", budget: 65000, objective: "max_stations" },
  { name: "$65k / maximum island stations, limit 30", budget: 65000, objective: "max_stations", max_stations: 30, mirror_layout: "island" },
  { name: "$65k / fixed 5 stations (do not waste balance)", budget: 65000, stations: 5 },
  { name: "$65k / 24-station colour salon with LED mirrors", budget: 65000, stations: 24, service_focus: "colour", mirror_feature: "led", equipment_quantities: { wash: 8, trolley: 24, stool: 6 } },
  { name: "$65k / 30-station expansion, existing wash/reception/waiting", budget: 65000, stations: 30, equipment_quantities: { wash: 0, reception: 0, waiting: 0, trolley: 10, stool: 5 } },
];

const results: Array<{
  name: string;
  input: Record<string, unknown> & { budget: number };
  stations: number;
  subtotal: number;
  remaining: number;
  plan: ReturnType<typeof salonPlans>["options"][number];
  assumptions: string;
}> = [];
describe("ten historical-order-informed equipment planning scenarios (offline)", () => {
  it.each(cases)("$name", ({ name, ...input }) => {
    const result = salonPlans({ currency: "USD", scope: "equipment", ...input });
    const plan = result.options.find(p => p.tier === result.recommendedTier)!;
    // This historical wash-heavy basket also requests 29 trolleys here. The
    // present snapshot cannot fit it in $45k; an honest shortfall is required.
    const expectedShortfall = input.stations === 29;
    expect(plan.withinBudget, result.budgetNote).toBe(!expectedShortfall);
    expect(plan.missingRoles).toEqual([]);
    if (expectedShortfall) {
      expect(plan.total).toBeGreaterThan(input.budget);
      expect(result.budgetNote).toContain("above your budget");
      expect(result.budgetNote).toContain("not been reduced automatically");
    } else expect(plan.total).toBeLessThanOrEqual(input.budget);
    expect(plan.total).toBeCloseTo(plan.lines.reduce((s,l) => s + l.price! * l.qty, 0), 2);
    const count = (role: string) => plan.lines.filter(l => l.role === role).reduce((s,l) => s + l.qty, 0);
    expect(count("styling")).toBe(input.stations ?? result.requirements.stations);
    if (input.max_stations) expect(count("styling")).toBeLessThanOrEqual(input.max_stations);
    if (input.objective === "max_stations") expect(count("styling")).toBeGreaterThan(20);
    for (const [role, qty] of Object.entries(input.equipment_quantities ?? {})) expect(count(role)).toBe(qty);
    for (const l of plan.lines) {
      expect(l.qty).toBeGreaterThan(0);
      expect(l.available).toBe(true);
      expect(CATALOG_FULL[l.id]!.is_component).toBe(false);
      expect(l.name).not.toMatch(/joiner frame|shelf only|hose|comfortneck/i);
    }
    const mirror = plan.lines.find(l => l.role === "mirror")!;
    const faces = input.mirror_layout === "island" ? productFit(CATALOG_FULL[mirror.id]!).stationFaces : 1;
    expect(mirror.qty * (faces ?? 0)).toBeGreaterThanOrEqual(count("styling"));
    if (input.mirror_layout === "island") expect(mirror.qty).toBe(Math.ceil(count("styling") / 2));
    if (input.mirror_feature === "led") expect(mirror.name).toMatch(/LED/i);
    if (input.stations === 5) expect(input.budget - plan.total).toBeGreaterThan(30000);
    expect(result.assumptions).toContain("Catalog prices are provisional");
    expect(result.exclusions).toContain("delivery, tax");
    expect(conversationMemory({ stations: count("styling"), budget: input.budget }).stations).toBe(count("styling"));
    results.push({ name, input, stations: count("styling"), subtotal: plan.total, remaining: input.budget - plan.total, plan, assumptions: result.assumptions });
    console.log(JSON.stringify({ name, stations: count("styling"), total: plan.total, remaining: input.budget - plan.total, quantities: Object.fromEntries(plan.lines.map(l => [l.role, l.qty])) }));
  });
});

it("parses larger explicit counts without treating them as budgets", () => {
  expect(readIntake("30 stations, budget 65000 USD").stations).toBe(30);
  expect(readIntake("60 stations").stations).toBe(60);
  expect(readIntake("61 stations").stations).toBeUndefined();
});

it("fails honestly on impossible budgets, missing products and missing fixed counts", () => {
  expect(() => salonPlans({ budget: 65000, currency: "USD", scope: "equipment" })).toThrow(/station count/);
  for (const extra of [{ budget: 100 }, { budget: 65000, finish: "nonexistent-finish" }]) {
    const result = salonPlans({ objective: "max_stations", max_stations: 3, currency: "USD", scope: "equipment", ...extra });
    const chosen = result.options.find(p => p.tier === result.recommendedTier)!;
    expect(!chosen.withinBudget || chosen.missingRoles.length > 0).toBe(true);
  }
});

afterAll(() => {
  if (process.env["WRITE_PLAN_REPORT"] !== "1") return;
  const out = "outputs/high-budget-plans";
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/results.json`, JSON.stringify({ method: "Offline deterministic planner; checked-in catalog snapshot, no paid APIs or images. Prices/configurations provisional; no live inventory or floor-fit verification.", results }, null, 2));
  const money = (n: number) => `$${n.toLocaleString("en-US")}`;
  const summary = results.map((r, i) => `| ${i + 1} | ${r.name.replaceAll("|", "/")} | ${r.stations} | ${money(r.subtotal)} | ${r.remaining < 0 ? `${money(-r.remaining)} shortfall` : money(r.remaining)} |`).join("\n");
  const details = results.map((r, i) => `## ${i + 1}. ${r.name}\n\nRequested inputs:\n\n\`\`\`json\n${JSON.stringify(r.input, null, 2)}\n\`\`\`\n\n| Equipment | Qty | Catalog unit price | Subtotal |\n|---|---:|---:|---:|\n${r.plan.lines.map(l => `| ${l.name} | ${l.qty} | ${money(l.price!)} | ${money(l.subtotal)} |`).join("\n")}\n\n**Catalog equipment subtotal: ${money(r.subtotal)}. ${r.remaining < 0 ? `Over budget by ${money(-r.remaining)}; quantities preserved, not presented as affordable.` : `Remaining: ${money(r.remaining)}.`}**\n\n${r.assumptions}\n`).join("\n");
  writeFileSync(`${out}/REPORT.md`, `# High-budget salon planning — 10 offline scenarios\n\nBranch: codex/high-budget-salon-plans, based on origin/main e569b7a. No deployment, paid model calls, image generations or production writes.\n\nThese are deterministic planner/adapter tests using the checked-in catalog, not live WhatsApp/LLM tests. Catalog prices and availability have not been refreshed. Exact base/lift/footrest/plumbing configurations require verification; excluded accessories can increase the final price. Delivery, tax, installation and building work are excluded. Maximum stations means financial capacity under these assumptions, not proof that the room can fit them.\n\nNine scenarios fit their budgets; the deliberately demanding wash-heavy case reports a shortfall. Historical orders informed the scenarios, but historical prices, coupons, returns and test payments were not imported.\n\n| Case | Request | Stations | Equipment subtotal | Remaining / shortfall |\n|---|---|---:|---:|---:|\n${summary}\n\n${details}`);
});
