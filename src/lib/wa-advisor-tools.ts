import { z } from "zod";
import { CATALOG_FULL, CATALOG_SLIM } from "@/lib/catalog";
import { withProductSpecifications } from "@/lib/product-specifications";
import { buildPackages, needsFor, candidates, type Need, type Role } from "@/lib/packages";
import { productFit } from "@/lib/wa-product-fit";
import { selectionProfile, selectionEvidenceFor } from "@/lib/product-selection";
import { matchesProductPurpose, productPurpose } from "@/lib/product-purpose";
import { MAX_PLAN_STATIONS } from "@/lib/planning-limits";

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
  const profile = selectionProfile(p);
  return {
    id,
    name: p.name,
    price: p.price,
    currency: "USD",
    available: p.in_stock,
    productPurpose: productPurpose(p),
    description: full.description?.slice(0, 700),
    selection_profile: {
      primaryUse: profile.primaryUse,
      mirrorLayout: profile.mirrorLayout,
      mounting: profile.mounting,
      documentedFeatures: Object.entries(profile.features)
        .filter(([, value]) => value === true)
        .map(([key]) => key),
      checks: profile.checks,
      sourceUrl: profile.sourceUrl,
      checkedAt: profile.checkedAt,
      evidenceStatus: profile.evidenceStatus,
      missingFacts: profile.missingFacts,
    },
    specs: full.specs,
    url: p.url,
    ...(p.salon_placement === "mirror_unit" ? { suitability: productFit(p) } : {}),
  };
}

/**
 * The short form of a product, for the advisor's SERVER CONTEXT.
 *
 * Every advisor call used to carry full productFacts for the whole selection
 * and every displayed product — specs, 700-char descriptions, URLs — and it
 * did so on every step of every turn. Measured with count_tokens against a
 * 4-selected / 8-displayed session: 7,616 tokens in that shape, 488 in this
 * one. The model only needs these to resolve "the second one" or "the tan
 * chair"; when it needs specifications for a claim or a comparison it is
 * already required to call find_products with the ids, so nothing is taken
 * away — it is just no longer re-sent when nothing asked for it.
 */
export function productSummaries(ids: string[]) {
  return ids.flatMap((id) => {
    const p = CATALOG_FULL[id];
    return p ? [{ id, name: p.name, price: p.price, available: p.in_stock }] : [];
  });
}

export function recommendProducts(input: unknown) {
  const args = ProductQuery.parse(input);
  const terms = tokens(args.query);
  return (
    CATALOG_SLIM.map((p) => {
      const full = CATALOG_FULL[p.id]!;
      const profile = selectionProfile(full);
      const source = selectionEvidenceFor(full);
      const words = new Set(
        tokens(
          `${p.n} ${p.c} ${p.col} ${source?.description || full.description || ""} ${source?.details?.join(" ") || ""} ${source?.features.join(" ") || ""} ${source?.intendedUses.join(" ") || ""} ${profile.primaryUse} ${Object.entries(
            profile.features,
          )
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join(" ")}`,
        ),
      );
      const matched = terms.filter((w) => words.has(w));
      const fits =
        matchesProductPurpose(full, args.query) &&
        (!terms.includes("led") || profile.features.led === true) &&
        (!terms.includes("compact") || profile.features.compact === true) &&
        (!terms.includes("reclining") || profile.features.reclining === true);
      return { p, score: matched.length, exact: matched.length === terms.length, fits };
    })
      .filter(
        ({ p, score, fits }) =>
          (args.ids || fits) &&
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
      // A keyword search hands the model a shortlist to choose 3-4 from; eight
      // candidates cover that, and the two dropped are the weakest matches. An
      // id lookup is different: the model asked for exactly those products, so
      // every one of them comes back.
      .slice(0, args.ids ? args.ids.length : 8)
      .map(({ p, exact }) => ({ ...productFacts(p.id), matchesAllSearchTerms: exact }))
  );
}

export const SalonPlanInput = z
  .object({
    stations: z.number().int().min(1).max(MAX_PLAN_STATIONS).optional(),
    objective: z.enum(["fixed_stations", "max_stations"]).default("fixed_stations"),
    max_stations: z.number().int().min(1).max(MAX_PLAN_STATIONS).optional(),
    equipment_quantities: z.object({
      wash: z.number().int().min(0).max(MAX_PLAN_STATIONS).optional(),
      trolley: z.number().int().min(0).max(MAX_PLAN_STATIONS).optional(),
      stool: z.number().int().min(0).max(MAX_PLAN_STATIONS).optional(),
      reception: z.number().int().min(0).max(5).optional(),
      waiting: z.number().int().min(0).max(10).optional(),
    }).strict().optional(),
    budget: z.number().finite().positive().max(1000000),
    currency: z.literal("USD"),
    scope: z.literal("equipment"),
    business: z.enum(["salon", "barbershop"]).default("salon"),
    finish: z.string().max(60).optional(),
    mirror_layout: z.enum(["wall", "island"]).default("wall"),
    mirror_feature: z.enum(["any", "led", "work_surface"]).default("any"),
    chair_feature: z.enum(["any", "reclining"]).default("any"),
    service_focus: z.enum(["hair_styling", "colour", "makeup_brows", "barber", "mixed"]).optional(),
    chair_priority: z.enum(["any", "compact", "easy_clean"]).default("any"),
  })
  .strict();

export function salonPlans(input: unknown) {
  const parsed = SalonPlanInput.parse(input);
  if (parsed.objective === "max_stations") {
    // Enumerate against the same service/finish/layout filters used for the
    // actual proposal. Never claim that a financial capacity is a measured fit.
    const start = parsed.service_focus === "mixed" ? 3 : 1;
    const limit = Math.min(parsed.max_stations ?? MAX_PLAN_STATIONS, parsed.stations ?? MAX_PLAN_STATIONS);
    if (limit < start) throw new Error("The station limit is too small for the requested service split.");
    let best: ReturnType<typeof fixedSalonPlans> | undefined;
    const pools = new Map<Role, (typeof CATALOG_FULL)[string][]>();
    // Descending exhaustive search stops at the first feasible count. Candidate
    // filtering is invariant across counts; cache only within this request so
    // another customer's preferences/catalog snapshot can never leak in.
    for (let stations = limit; stations >= start; stations--) {
      const result = fixedSalonPlans({ ...parsed, objective: "fixed_stations", stations }, pools);
      const chosen = result.options.find(p => p.tier === result.recommendedTier)!;
      if (chosen.withinBudget && !chosen.missingRoles.length) { best = result; break; }
    }
    const result = best ?? fixedSalonPlans({ ...parsed, objective: "fixed_stations", stations: start });
    return {
      ...result,
      requirements: { ...result.requirements, objective: "max_stations" as const },
      assumptions: `Budget-based capacity draft, searched up to ${limit} stations; NOT verified room capacity. ${result.assumptions}`,
    };
  }
  if (parsed.stations === undefined) throw new Error("Give the requested station count, or explicitly choose maximum stations within budget.");
  return fixedSalonPlans({ ...parsed, stations: parsed.stations });
}

function fixedSalonPlans(args: z.infer<typeof SalonPlanInput> & { stations: number }, pools = new Map<Role, (typeof CATALOG_FULL)[string][]>()) {
  if (args.finish && /^(?:standard|default|any|none|unspecified)$/i.test(args.finish))
    delete args.finish;
  const service =
    args.service_focus ?? (args.business === "barbershop" ? "barber" : "hair_styling");
  const needs = needsFor(args.stations).map(n => ({
    ...n,
    // Shared stools and a working trolley per stylist are editable assumptions,
    // not universal ratios. Explicit counts (including zero) always win.
    qty: n.role === "stool" ? Math.ceil(args.stations / 3)
      : n.role === "trolley" ? args.stations : n.qty,
  })).map(n => ({ ...n, qty: args.equipment_quantities?.[n.role as keyof NonNullable<typeof args.equipment_quantities>]
    ?? (service === "makeup_brows" && n.role === "wash" ? 0 : n.qty) })).filter(n => n.qty > 0);
  // Mixed service means distinct suitable chairs, not a styling chair claimed
  // to perform every service. Allocation is an explicit editable draft.
  if (service === "mixed" && args.stations < 3)
    throw new Error("A mixed hair, barber and makeup plan needs a service allocation. With fewer than three stations, ask which services should have dedicated stations.");
  const specialistChairs = service === "mixed"
    ? ["barber", "beauty_services"].map(use => candidates("styling")
        .filter(p => p.in_stock && selectionProfile(p).primaryUse === use &&
          (!args.finish || p.name.toLowerCase().includes(args.finish.toLowerCase())))
        .sort((a, b) => a.price! - b.price!)[0])
    : [];
  if (specialistChairs.some(p => !p))
    throw new Error("No matching dedicated barber or makeup chair is available. Ask whether the finish or service allocation can change.");
  if (service === "mixed") needs.find(n => n.role === "styling")!.qty -= 2;
  const matching = (role: Parameters<typeof candidates>[0]) => {
    const cached = pools.get(role);
    if (cached) return cached;
    const pool = candidates(role).filter(
      (p) =>
        p.in_stock &&
        (role !== "mirror" ||
          productFit(p).mirrorLayout ===
            (args.mirror_layout === "wall" ? "wall-assumed" : "island")) &&
        (role !== "mirror" ||
          args.mirror_layout !== "island" ||
          productFit(p).stationFaces === 2) &&
        (role !== "mirror" ||
          args.mirror_feature !== "led" ||
          selectionProfile(p).features.led === true) &&
        (role !== "mirror" ||
          args.mirror_feature !== "work_surface" ||
          productFit(p).workSurface) &&
        (role !== "styling" ||
          args.chair_feature !== "reclining" ||
          selectionProfile(p).features.reclining === true) &&
        (role !== "styling" ||
          (service === "barber"
            ? selectionProfile(p).primaryUse === "barber"
            : service === "makeup_brows"
              ? selectionProfile(p).primaryUse === "beauty_services"
              : args.chair_feature === "reclining"
                ? selectionProfile(p).primaryUse !== "barber"
                : selectionProfile(p).primaryUse === "hair_styling")) &&
        (role !== "styling" ||
          args.chair_priority !== "compact" ||
          selectionProfile(p).features.compact === true) &&
        (role !== "styling" ||
          args.chair_priority !== "easy_clean" ||
          selectionProfile(p).features.easyClean === true) &&
        (!args.finish ||
          !["styling", "wash"].includes(role) ||
          p.name.toLowerCase().includes(args.finish.toLowerCase())),
    );
    // Colour work can prefer documented daylight lighting, but not override
    // an explicit bench request or imply a certified colour-rendering score.
    if (role === "mirror" && (service === "colour" || service === "mixed") && args.mirror_feature === "any") {
      const daylight = pool.filter((p) => selectionProfile(p).features.daylightLighting);
      if (daylight.length) { pools.set(role, daylight); return daylight; }
    }
    pools.set(role, pool);
    return pool;
  };
  if (args.mirror_layout === "island") {
    // Use one consistent face count per plan rather than mixing single and
    // double-sided units while counting each as one station.
    needs.find((n) => n.role === "mirror")!.qty = Math.ceil(args.stations / 2);
  }
  const packagesFor = (budget: number, required: Need[]) => {
    const extra = specialistChairs.filter((p): p is NonNullable<typeof p> => Boolean(p));
    const reserve = extra.reduce((sum, p) => sum + p.price!, 0);
    return buildPackages(Math.max(0, budget - reserve), required, matching).map(pkg => ({
      ...pkg,
      lines: [...pkg.lines, ...extra.map(product => ({ role: "styling" as const, product, qty: 1, subtotal: product.price! }))],
      total: pkg.total + reserve,
    }));
  };
  const packages = packagesFor(args.budget, needs);
  const base = packages.find((p) => p.tier === "balanced")!;
  // Improve useful capacity, not station count. This is an optional equipment
  // scenario, not permission to add plumbing or an assertion about room fit.
  const enhancedNeeds = needs.map((n) => ({
    ...n,
    qty:
      args.equipment_quantities?.[n.role as keyof NonNullable<typeof args.equipment_quantities>] !== undefined ? n.qty : n.role === "trolley"
        ? args.stations
        : n.role === "wash"
          ? Math.ceil(args.stations / 2)
          : n.role === "waiting"
            ? Math.min(2, Math.ceil(args.stations / 3))
            : n.qty,
  }));
  const enhanced = packagesFor(args.budget, enhancedNeeds).find(
    (p) => p.tier === "balanced",
  )!;
  const useEnhanced =
    base.total < args.budget * 0.8 && enhanced.total > base.total && enhanced.total <= args.budget;
  // All tiers compare the SAME quantities. Never replace only the balanced
  // tier with a larger equipment mix while leaving "premium" smaller.
  const comparisonNeeds = useEnhanced ? enhancedNeeds : needs;
  const comparisons = useEnhanced
    ? packagesFor(args.budget, comparisonNeeds)
    : packages;
  const minimumFor = (required: Need[]) => packagesFor(0, required)[0]!;
  const minimum = minimumFor(comparisonNeeds);
  if (!comparisons.some((p) => p.total <= args.budget)) {
    comparisons[0] = { ...minimum, tier: "lean" };
  }
  const recommended =
    comparisons.find((p) => p.tier === "premium" && p.total <= args.budget &&
      base.total < args.budget * 0.8 && p.total > (comparisons.find(o => o.tier === "balanced")?.total ?? 0)) ??
    comparisons.find((p) => p.tier === "balanced" && p.total <= args.budget) ??
    comparisons.find((p) => p.total <= args.budget) ??
    comparisons[0]!;
  const shortfall = Math.max(0, recommended.total - args.budget);
  const missingRoles = comparisonNeeds
    .filter((n) => !recommended.lines.some((l) => l.role === n.role))
    .map((n) => n.role);
  const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const core = minimumFor(needs.filter((n) => n.role === "styling" || n.role === "mirror"));
  const reducedScope =
    shortfall > 0 && core.lines.length === 2 && core.total <= args.budget
      ? {
          total: core.total,
          lines: core.lines.map((l) => ({ id: l.product.id, name: l.product.name, qty: l.qty })),
          excludedRoles: needs
            .filter((n) => n.role !== "styling" && n.role !== "mirror")
            .map((n) => n.role),
        }
      : null;
  const remaining = Math.max(0, args.budget - recommended.total);
  const upgradeOptions = recommended.lines.flatMap(line => {
    const current = selectionProfile(line.product);
    const useful = line.role === "mirror" ? ["led", "daylightLighting", "workSurface"] as const
      : line.role === "wash" ? ["electric", "massage"] as const
      : line.role === "styling" ? ["compact", "easyClean", "adjustableHeight"] as const : [];
    return matching(line.role).filter(p => p.id !== line.product.id &&
      (line.role !== "styling" || selectionProfile(p).primaryUse === current.primaryUse))
      .flatMap(p => {
        const profile = selectionProfile(p);
        const features = useful.filter(key => profile.features[key] === true && current.features[key] !== true);
        const extraCost = (p.price! - line.product.price!) * line.qty;
        return features.length && extraCost > 0 && extraCost <= remaining ? [{
          replacesId: line.product.id, id: p.id, name: p.name, qty: line.qty,
          extraCost, revisedTotal: recommended.total + extraCost,
          features, requiresConfirmation: true as const,
        }] : [];
      }).sort((a,b) => a.extraCost - b.extraCost).slice(0,1);
  }).slice(0,3);
  const expansionOptions =
    !shortfall && !missingRoles.length && remaining > args.budget * 0.2
      ? Object.values(CATALOG_FULL)
          .filter(
            (p) =>
              p.in_stock &&
              !p.is_component &&
              p.price !== null &&
              p.price > 0 &&
              p.price <= remaining &&
              /retail shelves|magazine rack/i.test(p.name),
          )
          .sort((a, b) => a.price! - b.price!)
          .slice(0, 2)
          .map((p) => ({
            id: p.id,
            name: p.name,
            price: p.price!,
            qty: 1,
            requiresConfirmation: true as const,
          }))
      : [];
  const budgetNote = missingRoles.length
    ? `No matching products were found for ${missingRoles.join(", ")}. This is an incomplete estimate, not a full salon within budget.`
    : shortfall > 0
      ? `The lowest-cost complete mix matching these requirements is ${money(recommended.total)} USD, ${money(shortfall)} above your budget.${reducedScope ? ` Chairs and mirrors only could start at ${money(core.total)} USD; that excludes wash units, stools, trolleys, reception and waiting seating. Would you like to start with that smaller scope?` : " Would you like to change the equipment scope or station count?"} Your draft has not been reduced automatically.`
      : `Equipment subtotal: ${money(recommended.total)} USD; ${money(remaining)} remains.${upgradeOptions.length ? ` Optional feature upgrades (each priced separately, not yet included): ${upgradeOptions.map(p => `${p.qty} × ${p.name}, +${money(p.extraCost)}, revised total ${money(p.revisedTotal)}; documented ${p.features.join(", ")}`).join("; ")}. Tell me which you prefer before I change the selection.` : ""}${remaining > args.budget * 0.2 ? ` I have not added extra stations or unrelated products just to spend it.${expansionOptions.length ? ` If you sell retail products, optional display choices are ${expansionOptions.map((p) => `${p.name} (${money(p.price)} each)`).join(" or ")}. Would either be useful? These are alternatives, not included in your subtotal.` : " What else does the salon need—retail display, storage or another service area?"}` : ""} Delivery, tax, installation and building work are excluded.`;
  return {
    requirements: args,
    essentialsTotal: base.total,
    recommendedTier: recommended.tier,
    reducedScope,
    expansionOptions,
    upgradeOptions,
    selectionReasons: recommended.lines
      .filter((l) => l.role === "mirror" || l.role === "styling")
      .map((l) => {
        const profile = selectionProfile(l.product);
        return l.role === "mirror"
          ? `${l.product.name}: ${service === "colour" && profile.features.daylightLighting ? "Published daylight LED lighting is relevant to colour services; room lighting and electrical compatibility still need checking. " : ""}${productFit(l.product).reason}`
          : `${l.product.name}: catalog identifies ${profile.primaryUse.replaceAll("_", " ")}${profile.features.compact && args.chair_priority === "compact" ? "; manufacturer describes a compact design, but measure the complete operating footprint" : ""}${profile.features.easyClean && args.chair_priority === "easy_clean" ? "; documented cleaning/hair-trap design matches your maintenance priority" : ""}. Confirm height range, base configuration and load rating.`;
      }),
    budgetNote,
    enhancement: useEnhanced
      ? `Enhanced option: a trolley for each station${service === "makeup_brows" ? ". Wash units omitted for the dedicated makeup/brow brief; add only if you also offer hair washing." : " and up to one wash unit per two stations. Extra plumbing and floor space must be checked before purchase."}`
      : null,
    assumptions: `${service === "mixed" ? `Draft service split: ${args.stations - 2} hair/colour stations, 1 barber station and 1 makeup/brow station (${args.stations} total). This allocation can be changed; dedicated chairs are included. ` : ""}${args.mirror_layout === "wall" ? "Assumes wall-based stations" : "Assumes island stations; mirror quantities account for documented faces where consistent"}, with one chair per station. Support quantities are editable: ${comparisonNeeds.filter(n => !["styling", "mirror"].includes(n.role)).map(n => `${n.qty} ${n.role}`).join(", ")}. Zero quantities explicitly requested are omitted. A mirror without a documented work surface may need a separate bench, not included here. Catalog prices are provisional: confirm the exact chair/base/lift/footrest and wash/plumbing configuration; do not assume separately listed options are included or add historical component prices. Mounting, dimensions and plumbing need confirmation; this is not a verified floor plan.`,
    exclusions:
      "Equipment only, USD. Excludes delivery, tax, installation, building work and stock reservation.",
    options: comparisons.map((p) => {
      return {
        tier: p.tier,
        total: Math.round(p.total * 100) / 100,
        missingRoles: needs
          .filter((n) => !p.lines.some((l) => l.role === n.role))
          .map((n) => n.role),
        withinBudget: p.total <= args.budget,
        reasons: [
          `${money(p.total)} USD for the stated quantities; ${p.total > args.budget ? `${money(p.total - args.budget)} over budget` : `${money(args.budget - p.total)} remaining`}.`,
          "Price differences are not a verified quality ranking.",
        ],
        lines: p.lines.map((l) => ({
          id: l.product.id,
          name: l.product.name,
          price: l.product.price,
          available: l.product.in_stock,
          role: l.role,
          qty: l.qty,
          subtotal: l.subtotal,
        })),
      };
    }),
  };
}
