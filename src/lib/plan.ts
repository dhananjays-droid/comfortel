/**
 * The plan, as one shared description.
 *
 * The plan is the customer's actual intent — these pieces, this many — and it
 * changes constantly as they add and remove things. Three consumers need to
 * agree about it: the tray they look at, the model they talk to, and the prompt
 * that renders it. They did not, and every one of the disagreements was
 * visible: a message promising a package the customer had since edited, a chat
 * reply recommending a chair they had just removed, and a render showing one of
 * a piece they had four of.
 *
 * So the plan gets described in exactly one place, and everyone reads from it.
 */

export type PlanLine = {
  id: string;
  name: string;
  /** How many of this piece. Always at least 1. */
  qty: number;
  /** Unit price in dollars, or null when the catalogue has none. */
  price: number | null;
};

export type PlanSource = { id: string; name: string; price?: number | null };

/**
 * Pair the plan's products with their quantities.
 *
 * The plan stays a list of ids because a render needs one reference image per
 * product, not one per piece; the quantities ride alongside. A missing entry
 * means one, which is what an ad-hoc plan built by tapping cards is.
 */
export function linesFrom(
  products: PlanSource[],
  quantities?: Record<string, number> | undefined,
): PlanLine[] {
  return products.map((p) => ({
    id: p.id,
    name: p.name,
    qty: Math.max(1, Math.round(quantities?.[p.id] ?? 1)),
    price: p.price ?? null,
  }));
}

/** What the whole plan costs, quantities included. */
export function planTotal(lines: PlanLine[]): number {
  return lines.reduce((sum, l) => sum + (l.price ?? 0) * l.qty, 0);
}

/** How many individual pieces, as opposed to how many distinct products. */
export function planPieces(lines: PlanLine[]): number {
  return lines.reduce((sum, l) => sum + l.qty, 0);
}

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

/**
 * The plan as the model should read it.
 *
 * Sent on every turn and treated as authoritative, because the transcript is
 * not: a package proposed twenty messages ago is still sitting in the history
 * in full, and the model had no way to know the customer had since taken two
 * pieces out of it. Stating the current plan every turn is the only thing that
 * keeps a long conversation honest about what is actually in the basket.
 */
export function describePlan(lines: PlanLine[]): string {
  if (!lines.length) {
    return `THE CUSTOMER'S PLAN IS EMPTY. They have not added any pieces yet. Suggest pieces as normal; there is nothing to render.`;
  }

  const rows = lines
    .map((l) => {
      const price = l.price ? ` — ${money(l.price)}${l.qty > 1 ? " each" : ""}` : "";
      return `- ${l.qty} × ${l.name} (id ${l.id}${price})`;
    })
    .join("\n");

  const pieces = planPieces(lines);
  const total = planTotal(lines);

  return `THE CUSTOMER'S PLAN RIGHT NOW — ${pieces} ${pieces === 1 ? "piece" : "pieces"}, ${money(total)}:
${rows}

This list is live and it is the truth. The customer edits it directly, so it changes between turns.
- It OVERRIDES anything earlier in this conversation. If you proposed a package and a piece is no longer on this list, they removed it: do not bring it back, do not keep quoting the old total, and do not count it in anything you say.
- "these", "my plan", "the ones I picked", "what I've got" all mean exactly this list.
- The quantities are theirs. Use them when you talk about the plan.
- If they ask to see the plan in their room, put exactly these ids on the RENDER line, in this order, with mode refit_room.`;
}

/**
 * The quantities that apply to a render, or nothing at all.
 *
 * Only refit_room installs a stated number of each piece. On replace_all the
 * count is whatever the room already holds, and on a lineup every position gets
 * a different product by definition — attaching quantities to either would put
 * a number in the prompt that contradicts the mode, and then have the inspector
 * report a shortfall against it.
 */
/**
 * Modes that furnish a room and therefore care how many of each piece.
 *
 * `lineup` is deliberately absent: it stands one of each product side by side
 * for comparison, so a count would be meaningless there. This was the string
 * "refit_room" compared inline, which silently dropped every quantity the
 * moment a second furnishing mode existed — a seven-product, twenty-four-piece
 * plan rendered as one of each, because the prompt was told to install one.
 */
export const QUANTITY_MODES = ["refit_room", "staged_room"] as const;

export function quantitiesFor(
  mode: string,
  productIds: string[],
  quantities: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!(QUANTITY_MODES as readonly string[]).includes(mode) || !quantities) return undefined;
  const out: Record<string, number> = {};
  for (const id of productIds) {
    const qty = quantities[id];
    if (qty && qty > 1) out[id] = qty;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * What a finished image should be counted against.
 *
 * Only the repeated pieces. Counting a single reception desk would invite a
 * shortfall note over a desk that is simply behind the camera, which is noise
 * on almost every render — the number a customer actually checks against their
 * quote is the one with a ×4 next to it.
 */
export function expectedFrom(lines: PlanLine[]): Array<{ name: string; qty: number }> {
  return lines.filter((l) => l.qty > 1 && l.name).map((l) => ({ name: l.name, qty: l.qty }));
}
