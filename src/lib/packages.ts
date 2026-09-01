import { CATALOG_FULL, type FullProduct } from "@/lib/catalog";

/**
 * Turning "a four-chair salon for $15,000" into an actual list of products.
 *
 * All three guided flows converge here — describe a salon, name a budget, or
 * give dimensions — because they are the same question underneath: which pieces,
 * how many, at what total. Doing it in code rather than asking the model means
 * the prices are real, the arithmetic is right, and the same request always
 * returns the same package.
 */

export type Role = "styling" | "wash" | "mirror" | "stool" | "trolley" | "reception" | "waiting";

export const ROLE_LABEL: Record<Role, string> = {
  styling: "styling chair",
  wash: "backwash unit",
  mirror: "mirror",
  stool: "stylist stool",
  trolley: "trolley",
  reception: "reception desk",
  waiting: "waiting seating",
};

/**
 * Where each role's candidates come from, and the price below which an entry is
 * an accessory rather than the thing itself.
 *
 * The floors are doing real work: `shampoo_unit` also holds a $12 shower hose
 * and a $15 neck rest, `mirror_unit` holds a $59 joiner shelf, and `trolley`
 * holds $35 tint-bowl holders. Without a floor a "salon package" would happily
 * be built out of hoses. They are judgement calls, deliberately in one place.
 *
 * A floor alone is not enough, though: `mirror_unit` also holds a $749 "Joiner
 * Frame with Metal Shelf & Wheels Option", which outprices most real mirrors.
 * The catalogue groups a mirror with its mounting hardware, so the accessory
 * pattern below carries the rest of the weight.
 */
const SOURCE: Record<Role, { placement?: string; category?: string; minPrice: number }> = {
  styling: { placement: "styling_chair", minPrice: 250 },
  wash: { placement: "shampoo_unit", minPrice: 250 },
  mirror: { placement: "mirror_unit", minPrice: 150 },
  trolley: { placement: "trolley", minPrice: 120 },
  reception: { placement: "reception", minPrice: 300 },
  stool: { category: "salon/stools", minPrice: 100 },
  waiting: { category: "salon/waiting-retail", minPrice: 150 },
};

/**
 * Mounting hardware, spare parts and split cartons — never the piece itself.
 * `bench` is here because the double benches are waiting seating filed under
 * mirrors, so they are real furniture in the wrong role rather than junk.
 */
const ACCESSORY =
  /\b(joiner|wheel option|shelf only|box \d|accessory|holder|hose|bench|comfortneck)\b/i;

export type Need = { role: Role; qty: number };

/**
 * A believable fit-out for a given number of styling stations.
 *
 * One backwash serves roughly three chairs, which is the trade rule of thumb;
 * everything else is either per-station or one per salon. Stated here rather
 * than buried in the UI so it can be argued with.
 */
export function needsFor(stations: number): Need[] {
  const n = Math.max(1, Math.min(20, Math.round(stations)));
  return [
    { role: "styling", qty: n },
    { role: "mirror", qty: n },
    { role: "stool", qty: n },
    { role: "wash", qty: Math.max(1, Math.ceil(n / 3)) },
    { role: "trolley", qty: Math.max(1, Math.ceil(n / 2)) },
    { role: "reception", qty: 1 },
    { role: "waiting", qty: 1 },
  ];
}

export function candidates(role: Role): FullProduct[] {
  const source = SOURCE[role];
  return Object.values(CATALOG_FULL)
    .filter((p) => {
      if (!p.price || p.price < source.minPrice) return false;
      if (ACCESSORY.test(p.name)) return false;
      if (source.placement) return p.salon_placement === source.placement;
      return p.category === source.category;
    })
    .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));
}

export type Line = { role: Role; product: FullProduct; qty: number; subtotal: number };

export type Tier = "lean" | "balanced" | "premium";

export type Package = {
  tier: Tier;
  lines: Line[];
  total: number;
  /** Plain-language justification, derived from real differences. */
  reasons: string[];
};

const TIER_TARGET: Record<Tier, number> = { lean: 0.85, balanced: 1.0, premium: 1.25 };

export const TIER_LABEL: Record<Tier, string> = {
  lean: "Under budget",
  balanced: "On budget",
  premium: "Stretch",
};

/**
 * Roughly how a fit-out budget divides in practice.
 *
 * This exists because the obvious algorithm — start cheap, keep applying the
 * smallest affordable upgrade — produces nonsense. Upgrading a $159 stool is
 * cheap, so stools, trolleys and mirrors climb to the top of their ranges long
 * before the chairs move, and you end up recommending $5,908 of mirrors against
 * $2,396 of chairs. Allocating by share keeps the money where a salon owner
 * would actually put it.
 *
 * Shares are a judgement call, not a measurement. They are here, named, so they
 * can be argued with.
 */
const SHARE: Record<Role, number> = {
  styling: 0.35,
  wash: 0.22,
  mirror: 0.16,
  reception: 0.1,
  waiting: 0.06,
  trolley: 0.06,
  stool: 0.05,
};

/** How far past its share a single role may be pushed by leftover money. */
const OVERRUN = 2.0;

/** Where a leftover dollar goes first: the pieces the room is judged on. */
const PRIORITY: Role[] = ["styling", "wash", "mirror", "reception", "waiting", "trolley", "stool"];

/**
 * The best package buildable for a given spend.
 *
 * Two passes. First each role gets its share of the target and takes the dearest
 * piece that fits its per-unit allowance — that sets the balance. Then anything
 * left over is spent one upgrade at a time in priority order, so the total lands
 * near the target instead of well under it.
 *
 * Every tier is genuinely the most you can get at its number. None of them is a
 * decoy built to flatter another, which is the failure mode of tiered pricing.
 */
function packFor(target: number, needs: Need[]): { lines: Line[]; total: number } {
  const pools = new Map<Role, FullProduct[]>();
  const index = new Map<Role, number>();

  for (const need of needs) {
    const pool = candidates(need.role);
    if (!pool.length) continue;
    pools.set(need.role, pool);

    // Dearest piece within this role's share, or the cheapest if none fits.
    const allowance = (target * SHARE[need.role]) / Math.max(1, need.qty);
    let pick = 0;
    for (let i = 0; i < pool.length; i++) {
      if ((pool[i]?.price ?? 0) <= allowance) pick = i;
      else break;
    }
    index.set(need.role, pick);
  }

  const totalOf = () =>
    needs.reduce((sum, need) => {
      const pool = pools.get(need.role);
      const at = index.get(need.role);
      if (!pool || at === undefined) return sum;
      return sum + (pool[at]?.price ?? 0) * need.qty;
    }, 0);

  // Spend what the shares left on the table, best pieces first.
  for (let guard = 0; guard < 200; guard++) {
    let moved = false;
    for (const role of PRIORITY) {
      const need = needs.find((n) => n.role === role);
      const pool = pools.get(role);
      const at = index.get(role);
      if (!need || !pool || at === undefined) continue;

      const next = pool[at + 1];
      const current = pool[at];
      if (!next || !current) continue;

      const cost = ((next.price ?? 0) - (current.price ?? 0)) * need.qty;
      if (totalOf() + cost > target) continue;
      // Without a ceiling the leftover pass funnels everything into whichever
      // role still has headroom, and you get $5,908 of mirrors above $4,360 of
      // chairs. A role may overrun its share, but not run away with the budget.
      if ((next.price ?? 0) * need.qty > target * SHARE[role] * OVERRUN) continue;
      index.set(role, at + 1);
      moved = true;
    }
    if (!moved) break;
  }

  const lines: Line[] = [];
  for (const need of needs) {
    const pool = pools.get(need.role);
    const at = index.get(need.role);
    if (!pool || at === undefined) continue;
    const product = pool[at];
    if (!product) continue;
    lines.push({
      role: need.role,
      product,
      qty: need.qty,
      subtotal: (product.price ?? 0) * need.qty,
    });
  }

  return { lines, total: lines.reduce((sum, line) => sum + line.subtotal, 0) };
}

const money = (amount: number) => `$${Math.round(amount).toLocaleString("en-US")}`;

/**
 * Why this package rather than the one next to it.
 *
 * Comparative on purpose: people judge options against each other far better
 * than in isolation, so a reason that names the actual difference — this chair
 * instead of that one — beats any amount of adjective. Every line here is
 * derived from the packages themselves; none of it is copy.
 */
function explain(pkg: Package, balanced: Package, budget: number): string[] {
  const reasons: string[] = [];
  const gap = pkg.total - budget;

  // Describe the gap that exists, not the one the tier's name implies: the
  // catalogue does not always have anything left to sell at the stretch target,
  // and "over budget" on a package that costs less would be a plain lie.
  if (pkg.tier === "balanced") {
    reasons.push(
      gap <= 0
        ? `Uses ${money(pkg.total)} of your ${money(budget)}.`
        : `${money(gap)} over, the closest fit to your number.`,
    );
  } else if (gap > 0) {
    reasons.push(`${money(gap)} over budget.`);
  } else if (gap < 0) {
    reasons.push(`${money(-gap)} under your budget.`);
  } else {
    reasons.push(`Exactly on your budget.`);
  }

  // Name the roles that actually differ from the middle option.
  const changed = pkg.lines.filter((line) => {
    const other = balanced.lines.find((l) => l.role === line.role);
    return other && other.product.id !== line.product.id;
  });

  if (pkg.tier !== "balanced" && changed.length) {
    // Name the single biggest difference. Listing every changed role produces a
    // sentence nobody finishes reading, and the largest swing is the one that
    // explains the price gap anyway.
    const biggest = [...changed].sort((a, b) => {
      const otherA = balanced.lines.find((l) => l.role === a.role)?.subtotal ?? 0;
      const otherB = balanced.lines.find((l) => l.role === b.role)?.subtotal ?? 0;
      return Math.abs(b.subtotal - otherB) - Math.abs(a.subtotal - otherA);
    })[0];

    if (biggest) {
      const other = balanced.lines.find((l) => l.role === biggest.role);
      const verb = pkg.tier === "lean" ? "Saved on" : "Spent on";
      reasons.push(
        `${verb} the ${ROLE_LABEL[biggest.role]}s: ${biggest.product.name} rather than ${other?.product.name}.`,
      );
    }

    const rest = changed.length - 1;
    if (rest > 0) {
      reasons.push(`${rest} other ${rest === 1 ? "piece differs" : "pieces differ"} too.`);
    }
  }

  // The part that does not change is the reassuring part.
  const same = pkg.lines.filter((line) => {
    const other = balanced.lines.find((l) => l.role === line.role);
    return other && other.product.id === line.product.id;
  });
  if (pkg.tier !== "balanced" && same.length) {
    reasons.push(`Same station count and layout either way.`);
  }
  if (pkg.tier === "balanced") {
    reasons.push(`Every piece matched to the middle of the range.`);
  }

  return reasons;
}

/**
 * Three packages around a budget: a little under, on it, a little over.
 *
 * Ordered lean → balanced → premium so the middle option sits in the middle,
 * which is where most people land and where it should be honest rather than
 * engineered.
 */
export function buildPackages(budget: number, needs: Need[]): Package[] {
  const raw = (["lean", "balanced", "premium"] as const).map((tier) => {
    const { lines, total } = packFor(budget * TIER_TARGET[tier], needs);
    return { tier, lines, total, reasons: [] as string[] };
  });

  const balanced = raw[1] as Package;
  return raw.map((pkg) => ({ ...pkg, reasons: explain(pkg, balanced, budget) }));
}

/** The product ids in a package, expanded so the plan and renders can use them. */
export function idsOf(pkg: Package): string[] {
  return pkg.lines.map((line) => line.product.id);
}
