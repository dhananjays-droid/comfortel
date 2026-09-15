import { z } from "zod";
import { CATALOG_FULL, CATALOG_SLIM } from "@/lib/catalog";
import { withProductSpecifications } from "@/lib/product-specifications";
import { buildPackages, needsFor, candidates } from "@/lib/packages";

export const ProductQuery = z
  .object({
    query: z.string().max(120),
    max_price: z.number().finite().nonnegative().optional(),
    ids: z.array(z.string()).max(10).optional(),
  })
  .strict();

const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      w === "trolleys" ? "trolley" : w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w,
    )
    .filter(
      (w) =>
        ![
          "a",
          "the",
          "for",
          "me",
          "show",
          "please",
          "some",
          "need",
          "want",
          "buy",
          "product",
          "furniture",
        ].includes(w),
    );

export function productFacts(id: string) {
  const p = CATALOG_FULL[id];
  if (!p) throw new Error("Product is no longer available in the catalog");
  const full = withProductSpecifications(p);
  return {
    id,
    name: p.name,
    price: p.price,
    currency: "USD",
    available: p.in_stock,
    description: p.description?.slice(0, 700),
    specs: full.specs,
    url: p.url,
  };
}

export function recommendProducts(input: unknown) {
  const args = ProductQuery.parse(input);
  const terms = tokens(args.query);
  return CATALOG_SLIM.map((p) => {
    const words = new Set(tokens(`${p.n} ${p.c} ${p.col}`));
    const matched = terms.filter((w) => words.has(w));
    return { p, score: matched.length, exact: matched.length === terms.length };
  })
    .filter(
      ({ p, score }) =>
        (!args.ids || args.ids.includes(p.id)) &&
        (args.ids || !terms.length || score > 0) &&
        (args.max_price === undefined || (p.p !== null && p.p <= args.max_price)),
    )
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.score - a.score ||
        Number(CATALOG_FULL[b.p.id]?.in_stock) - Number(CATALOG_FULL[a.p.id]?.in_stock),
    )
    .slice(0, 10)
    .map(({ p, exact }) => ({ ...productFacts(p.id), matchesAllSearchTerms: exact }));
}

export const SalonPlanInput = z
  .object({
    stations: z.number().int().min(1).max(20),
    budget: z.number().finite().positive().max(1000000),
    currency: z.literal("USD"),
    scope: z.literal("equipment"),
    business: z.enum(["salon", "barbershop"]).default("salon"),
    finish: z.string().max(60).optional(),
  })
  .strict();

export function salonPlans(input: unknown) {
  const args = SalonPlanInput.parse(input);
  if (args.finish && /^(?:standard|default|any|none|unspecified)$/i.test(args.finish))
    delete args.finish;
  const needs = needsFor(args.stations);
  const packages = buildPackages(args.budget, needs, (role) =>
    candidates(role).filter(
      (p) =>
        p.in_stock &&
        (role !== "mirror" || !/\bdouble\b/i.test(p.name)) &&
        (role !== "styling" ||
          (args.business === "barbershop" ? /barber/i.test(p.name) : !/barber/i.test(p.name))) &&
        (!args.finish ||
          !["styling", "wash"].includes(role) ||
          p.name.toLowerCase().includes(args.finish.toLowerCase())),
    ),
  );
  return {
    requirements: args,
    assumptions:
      "Draft equipment mix: one chair, mirror and stool per station; one wash unit per three stations; one trolley per two; one reception desk and waiting seat. Quantities can be changed. Not a verified space/layout or plumbing assessment.",
    exclusions:
      "Equipment only, USD. Excludes delivery, tax, installation, building work and stock reservation.",
    options: packages.map((p) => ({
      tier: p.tier,
      total: Math.round(p.total * 100) / 100,
      missingRoles: needs.filter((n) => !p.lines.some((l) => l.role === n.role)).map((n) => n.role),
      withinBudget: p.total <= args.budget,
      reasons: p.reasons,
      lines: p.lines.map((l) => ({
        id: l.product.id,
        name: l.product.name,
        price: l.product.price,
        available: l.product.in_stock,
        role: l.role,
        qty: l.qty,
        subtotal: l.subtotal,
      })),
    })),
  };
}
