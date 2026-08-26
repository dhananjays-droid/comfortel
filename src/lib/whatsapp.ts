/**
 * WhatsApp Business Platform limits, and what they do to this conversation.
 *
 * WhatsApp Mode is not a skin. The point is to answer "does this product survive
 * being a WhatsApp bot?", and that question is decided almost entirely by these
 * numbers: three buttons, ten list rows, twenty characters of button label. A
 * preview that quietly renders four buttons would answer the question wrongly.
 *
 * Figures from Meta's Cloud API docs, August 2026. See GUIDE.md for the sources
 * and for the policy constraints, which are not encodable here.
 */

export const WA = {
  /** Interactive reply buttons per message. Hard cap. */
  buttons: 3,
  /** Characters in a reply-button label. */
  buttonTitle: 20,
  /** Rows in a list message, summed across every section. */
  listRows: 10,
  listRowTitle: 24,
  listRowDescription: 72,
  sectionTitle: 24,
  /** Body text of an interactive message. */
  body: 1024,
  footer: 60,
  headerText: 60,
  /** Products in a multi-product message, from a synced Meta catalogue. */
  catalogProducts: 30,
} as const;

/**
 * Cut to a limit the way WhatsApp does — it rejects the message rather than
 * trimming, so anything over the limit is a bug we want visible in the preview.
 * The ellipsis marks where the real API would have refused.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export type Fit<T> = {
  /** What WhatsApp would actually deliver. */
  kept: T[];
  /** What it would drop, so the preview can say so out loud. */
  dropped: T[];
};

/** Split a list at a WhatsApp cap, keeping the overflow for reporting. */
export function fit<T>(items: T[], max: number): Fit<T> {
  return { kept: items.slice(0, max), dropped: items.slice(max) };
}

/**
 * How a set of products has to be sent.
 *
 * Under the button cap they can be quick replies; past it they need a list;
 * past the list cap they need the product catalogue. Choosing wrongly is the
 * most common way a WhatsApp flow becomes unusable, so it is computed rather
 * than assumed.
 */
export type Carrier = "buttons" | "list" | "catalog" | "too-many";

export function carrierFor(count: number): Carrier {
  if (count <= WA.buttons) return "buttons";
  if (count <= WA.listRows) return "list";
  if (count <= WA.catalogProducts) return "catalog";
  return "too-many";
}

export const CARRIER_LABEL: Record<Carrier, string> = {
  buttons: "Reply buttons",
  list: "List message",
  catalog: "Multi-product message",
  "too-many": "Over catalogue limit",
};

/** Delivery state, purely cosmetic — it drives which ticks a bubble shows. */
export type Delivery = "sent" | "delivered" | "read";

/**
 * The time a message was created, recovered from its id.
 *
 * Ids are `m` + base36(Date.now()) + base36(seq), so the epoch is the eight
 * characters after the prefix. Parsing it beats adding a timestamp field to
 * every message and migrating what is already in sessionStorage — and if the
 * format ever changes, the sanity check below falls back to now rather than
 * rendering a bubble stamped 1974.
 */
const ID_EPOCH_CHARS = 8;
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

export function timeOf(id: string, now: number = Date.now()): number {
  const parsed = Number.parseInt(id.slice(1, 1 + ID_EPOCH_CHARS), 36);
  if (!Number.isFinite(parsed)) return now;
  if (Math.abs(parsed - now) > TEN_YEARS_MS) return now;
  return parsed;
}

/** WhatsApp shows a bare 24h-agnostic clock on each bubble, nothing more. */
export function clock(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
