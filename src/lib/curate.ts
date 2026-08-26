import { CATALOG_FULL, type FullProduct } from "@/lib/catalog";
import {
  ROLE_LABEL,
  candidates,
  type Line,
  type Package,
  type Role,
  type Tier,
} from "@/lib/packages";

/**
 * The model-curated half of package building.
 *
 * The deterministic packer in `packages.ts` allocates by invented budget shares
 * and picks "the dearest that fits", which is a poor proxy for the right piece:
 * it will put a barber chair in a salon and a £1,477 mirror next to the cheapest
 * chair, because price order knows nothing about whether things belong together.
 * The catalogue carries `style_collections` on 98 products and the old packer
 * ignored all of it.
 *
 * So the split here is: the model chooses WHICH pieces and HOW MANY, code does
 * every number. The model never sees a total and never writes a price — a
 * hallucinated price on a quote is the worst bug this app could ship. Everything
 * in this file is pure, so the selection contract is testable without a network.
 */

/** What the model is shown for one product. Compact — this is prompt budget. */
export type Candidate = {
  id: string;
  name: string;
  price: number;
  collection?: string | undefined;
};

/**
 * Candidates for a role, sampled across the price range rather than truncated.
 *
 * Mirrors alone run to 30-odd entries clustered at the cheap end, and sending
 * the first N would show the model a wall of near-identical budget mirrors and
 * hide the ones worth choosing. Always keeps the cheapest and dearest so the
 * model can see the real span it is choosing within.
 */
export function sampleCandidates(role: Role, limit = 12): Candidate[] {
  const pool = candidates(role);
  if (!pool.length) return [];

  const picked: FullProduct[] =
    pool.length <= limit
      ? pool
      : Array.from({ length: limit }, (_, i) => {
          const at = Math.round((i * (pool.length - 1)) / (limit - 1));
          return pool[at];
        }).filter((p): p is FullProduct => Boolean(p));

  // The even spread can land on the same product twice at small limits.
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const product of picked) {
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    out.push({
      id: product.id,
      name: product.name,
      price: product.price ?? 0,
      ...(collectionOf(product) ? { collection: collectionOf(product) } : {}),
    });
  }
  return out;
}

/** `style_collections` arrives as a string or a list depending on the product. */
export function collectionOf(product: FullProduct): string | undefined {
  const raw = (product as { style_collections?: unknown }).style_collections;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (Array.isArray(raw)) {
    const first = raw.find((v): v is string => typeof v === "string" && v.trim().length > 0);
    return first?.trim();
  }
  return undefined;
}

/** One line as the model proposes it: a role, a real id, and a count. */
export type ProposedLine = { role: string; productId: string; qty: number };

export type ProposedPackage = {
  tier: string;
  lines: ProposedLine[];
  /** The model's reasoning about fit and look. Never about price. */
  rationale?: string | undefined;
};

const ROLES: Role[] = ["styling", "wash", "mirror", "stool", "trolley", "reception", "waiting"];

const isRole = (value: string): value is Role => (ROLES as string[]).includes(value);
const isTier = (value: string): value is Tier =>
  value === "lean" || value === "balanced" || value === "premium";

export type CurationIssue =
  | { kind: "unknown-product"; productId: string }
  | { kind: "wrong-role"; productId: string; role: string }
  | { kind: "unknown-role"; role: string }
  | { kind: "bad-qty"; productId: string; qty: number }
  | { kind: "duplicate-role"; role: string }
  | { kind: "unknown-tier"; tier: string };

/**
 * Turn a proposal into a real package, or reject it.
 *
 * This is the verify half of "model proposes, code verifies". A product that
 * does not exist, or that is not a candidate for the role it was picked for, is
 * a rejection rather than something to paper over — silently dropping a line
 * would hand the customer a salon with no backwash and a total to match.
 */
export function adopt(
  proposed: ProposedPackage,
  maxQty = 20,
): { package: Package; issues: CurationIssue[] } | { package: null; issues: CurationIssue[] } {
  const issues: CurationIssue[] = [];

  if (!isTier(proposed.tier)) {
    issues.push({ kind: "unknown-tier", tier: proposed.tier });
    return { package: null, issues };
  }

  const lines: Line[] = [];
  const usedRoles = new Set<string>();

  for (const line of proposed.lines) {
    if (!isRole(line.role)) {
      issues.push({ kind: "unknown-role", role: line.role });
      continue;
    }
    if (usedRoles.has(line.role)) {
      issues.push({ kind: "duplicate-role", role: line.role });
      continue;
    }

    const product = CATALOG_FULL[line.productId];
    if (!product) {
      issues.push({ kind: "unknown-product", productId: line.productId });
      continue;
    }

    // The pool is the source of truth for what may fill a role. Without this a
    // shower hose could be proposed as a backwash unit.
    if (!candidates(line.role).some((p) => p.id === product.id)) {
      issues.push({ kind: "wrong-role", productId: line.productId, role: line.role });
      continue;
    }

    const qty = Math.round(line.qty);
    if (!Number.isFinite(qty) || qty < 1 || qty > maxQty) {
      issues.push({ kind: "bad-qty", productId: line.productId, qty: line.qty });
      continue;
    }

    usedRoles.add(line.role);
    lines.push({
      role: line.role,
      product,
      qty,
      subtotal: (product.price ?? 0) * qty,
    });
  }

  // A package with no chairs is not a salon, whatever else it contains.
  if (!lines.some((l) => l.role === "styling")) return { package: null, issues };

  return {
    package: {
      tier: proposed.tier,
      lines,
      total: lines.reduce((sum, line) => sum + line.subtotal, 0),
      reasons: [],
    },
    issues,
  };
}

const money = (amount: number) => `$${Math.round(amount).toLocaleString("en-US")}`;

/**
 * The reason lines: money from code, taste from the model.
 *
 * Splitting them this way means the sentence containing a number is always true,
 * because nothing generated it. The model's contribution is the part it is
 * actually better at — why these pieces sit together.
 */
export function reasonsFor(pkg: Package, budget: number, rationale?: string): string[] {
  const gap = pkg.total - budget;
  const reasons: string[] = [];

  if (gap > 0) reasons.push(`${money(gap)} over your ${money(budget)} budget.`);
  else if (gap < 0) reasons.push(`${money(-gap)} under your ${money(budget)} budget.`);
  else reasons.push(`Exactly on your ${money(budget)} budget.`);

  const trimmed = rationale?.trim();
  if (trimmed) reasons.push(trimmed);

  const stations = pkg.lines.find((l) => l.role === "styling")?.qty ?? 0;
  const missing = ROLES.filter((role) => !pkg.lines.some((l) => l.role === role));
  reasons.push(
    `${stations} station${stations === 1 ? "" : "s"}, ${pkg.lines.reduce((n, l) => n + l.qty, 0)} pieces.`,
  );
  if (missing.length) {
    reasons.push(`Leaves out the ${missing.map((r) => ROLE_LABEL[r]).join(" and ")}.`);
  }

  return reasons;
}

/**
 * Nudge an adopted package towards a target total.
 *
 * The model chooses the composition and the look; it is not asked to land a
 * total, because that is arithmetic over seven roles and quantities and it is
 * unreliable at exactly that. Told to aim for 95-100% of budget with unit prices
 * in front of it, it still came back at a third of the number — and a tier
 * labelled "Stretch" costing half the budget is a label that lies.
 *
 * So: the model's roles, quantities and style stay untouched. Only the specific
 * product within each role moves, and it prefers pieces sharing the package's
 * dominant collection so the coherence the model built is not traded away for
 * arithmetic.
 */
export function fitToBand(pkg: Package, target: number): Package {
  if (target <= 0 || !pkg.lines.length) return pkg;

  const dominant = dominantCollection(pkg);
  const lines = pkg.lines.map((line) => ({ ...line }));
  const total = () => lines.reduce((sum, l) => sum + l.subtotal, 0);

  // Only ever climbs: a package under target is the observed failure, and
  // trimming a model's choice downward would undo the judgement we paid for.
  for (let guard = 0; guard < 60; guard++) {
    if (total() >= target * 0.95) break;

    let best: { index: number; product: FullProduct; cost: number } | null = null;

    lines.forEach((line, index) => {
      const pool = candidates(line.role);
      const current = pool.findIndex((p) => p.id === line.product.id);
      if (current < 0) return;

      for (let i = current + 1; i < pool.length; i++) {
        const next = pool[i];
        if (!next) continue;
        const cost = ((next.price ?? 0) - (line.product.price ?? 0)) * line.qty;
        if (cost <= 0) continue;
        if (total() + cost > target) break;

        // Same-collection upgrades win ties, so the look survives the climb.
        const onTheme = dominant && collectionOf(next) === dominant;
        const score = onTheme ? cost * 0.5 : cost;
        if (!best || score < (best.cost ?? Infinity)) {
          best = { index, product: next, cost: score };
        }
        break;
      }
    });

    if (!best) break;
    const pick = best as { index: number; product: FullProduct; cost: number };
    const line = lines[pick.index];
    if (!line) break;
    line.product = pick.product;
    line.subtotal = (pick.product.price ?? 0) * line.qty;
  }

  return { ...pkg, lines, total: total() };
}

/** The collection most of the package already belongs to, if there is one. */
export function dominantCollection(pkg: Package): string | undefined {
  const counts = new Map<string, number>();
  for (const line of pkg.lines) {
    const collection = collectionOf(line.product);
    if (collection) counts.set(collection, (counts.get(collection) ?? 0) + 1);
  }
  let best: { name: string; n: number } | null = null;
  for (const [name, n] of counts) if (!best || n > best.n) best = { name, n };
  return best && best.n > 1 ? best.name : undefined;
}
