/**
 * The WhatsApp session, as one shared, trust-nothing shape.
 *
 * A webhook has no browser and no React state — every piece of state
 * `src/routes/index.tsx` holds in `useState`/`useRef` (messages, plan, flow,
 * room photo, offered packages) has to live in a DB row instead, keyed by
 * session rather than by component. This file is the pure type plus the
 * sanitizers that rebuild a session from a stored JSON blob the same way
 * `plan.ts`/`chat.functions.ts`'s own validators rebuild a plan from the
 * browser: never trust a stored id, price or total — re-resolve every id
 * against `CATALOG_FULL` and recompute anything derived.
 */

import type { ChatMessageInput } from "@/lib/chat.functions";
import { CATALOG_FULL } from "@/lib/catalog";
import type { Package, Role } from "@/lib/packages";
import type { Await, FlowState } from "@/lib/wa-flow";

/** Matches kie's own tempfile expiry — see visualize.functions.ts / GUIDE.md. */
export const ROOM_TTL_MS = 15 * 60 * 1000;
/** The session keeps a slightly wider window than any single chat() call sends. */
export const MAX_TRANSCRIPT = 24;
/** A package offer older than this is re-curated rather than accepted stale. */
export const OFFER_TTL_MS = 30 * 60 * 1000;
/** Matches chat.functions.ts's own MAX_PLAN_LINES. */
const MAX_PLAN_LINES = 10;
/** Matches chat.functions.ts's own plan-quantity clamp (1..99) — distinct from
 * visualize.functions.ts's MAX_QTY=20, which caps render quantities and is
 * enforced separately, downstream, by visualizeStart itself. */
const MIN_QTY = 1;
const MAX_QTY = 99;
/** Matches visualize.functions.ts's room-dimension clamp. */
const MIN_ROOM_CM = 100;
const MAX_ROOM_CM = 3000;
const AWAIT_VALUES: readonly Await[] = ["visualize", "build", "wall", "photo", "quote"];

export type SessionPlan = { ids: string[]; qty: Record<string, number> };

/**
 * The room's dimensions, mentioned in text — independent of whether a photo
 * has ever been sent, and with no TTL, matching `roomSpecRef` in index.tsx:
 * "12 by 20 ft" said before any photo still applies to a staged render, and
 * still applies to a refit_room render of a photo sent an hour later.
 */
export type SessionRoomSpec = { wallCm: number; depthCm?: number };

/**
 * The room *photo* — matches `roomPhotoRef`/`hasRoomPhoto`. TTL'd, unlike
 * the dimensions: a stale reference image shouldn't get reused silently.
 */
export type SessionRoomPhoto = { url: string; at: number };

export type SessionOfferedChoice = {
  stations: number;
  budget: number;
  note: string;
  byZone: boolean;
};

export type SessionOffered = {
  packages: Package[];
  choice: SessionOfferedChoice;
  at: number;
};

/** Which products a tapped "Get a quote" button was for — held while
 * flow.awaiting is "quote" and the customer's name and email are collected,
 * since submitEnquiry needs both per product and neither travels with a
 * button tap. */
export type SessionPendingQuote = { productIds: string[] };

export type SessionState = {
  transcript: ChatMessageInput[];
  plan: SessionPlan;
  flow: FlowState;
  roomSpec: SessionRoomSpec | null;
  room: SessionRoomPhoto | null;
  offered: SessionOffered | null;
  /** A dimensions run promised zone renders and is only waiting on a photo —
   * matches index.tsx's `pendingZoneRender` state. */
  pendingZoneRender: boolean;
  pendingQuote: SessionPendingQuote | null;
  handoff: boolean;
  /** WhatsApp's own contacts[].profile.name for this number — the display
   * name the customer set in their own app, not something Comfortel asked
   * for. For the admin dashboard only; never used in conversation logic. */
  customerName: string | null;
  /** Last 4 digits of the phone number, so a developer can recognise a
   * customer without the full number ever being stored anywhere outside
   * wa_render_jobs' encrypted column. */
  phoneLast4: string | null;
};

export const EMPTY_SESSION: SessionState = {
  transcript: [],
  plan: { ids: [], qty: {} },
  flow: {},
  roomSpec: null,
  room: null,
  offered: null,
  pendingZoneRender: false,
  pendingQuote: null,
  handoff: false,
  customerName: null,
  phoneLast4: null,
};

/** A room photo older than ROOM_TTL_MS is treated as gone — the customer has
 * to send a fresh one rather than get a render against a stale reference. */
export function liveRoom(room: SessionRoomPhoto | null, now = Date.now()): SessionRoomPhoto | null {
  if (!room) return null;
  return now - room.at > ROOM_TTL_MS ? null : room;
}

/** A package offer older than OFFER_TTL_MS is treated as gone — a tap on a
 * stale "pkg:balanced" id gets re-curated rather than silently accepted. */
export function liveOffered(
  offered: SessionOffered | null,
  now = Date.now(),
): SessionOffered | null {
  if (!offered) return null;
  return now - offered.at > OFFER_TTL_MS ? null : offered;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function sanitizeTranscript(input: unknown): ChatMessageInput[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (m): m is ChatMessageInput =>
        !!m &&
        typeof m === "object" &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0,
    )
    .slice(-MAX_TRANSCRIPT)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

export function sanitizePlan(input: unknown): SessionPlan {
  const raw = input as { ids?: unknown; qty?: unknown } | null | undefined;
  const idsIn = Array.isArray(raw?.ids) ? raw.ids : [];
  const qtyIn = raw?.qty && typeof raw.qty === "object" ? (raw.qty as Record<string, unknown>) : {};

  const ids: string[] = [];
  const qty: Record<string, number> = {};
  for (const id of idsIn) {
    if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(CATALOG_FULL, id)) continue;
    if (ids.includes(id)) continue;
    ids.push(id);
    qty[id] = clampInt(qtyIn[id], MIN_QTY, MAX_QTY, 1);
    if (ids.length >= MAX_PLAN_LINES) break;
  }
  return { ids, qty };
}

export function sanitizeFlow(input: unknown): FlowState {
  const raw = input as { awaiting?: unknown } | null | undefined;
  const awaiting = AWAIT_VALUES.includes(raw?.awaiting as Await)
    ? (raw!.awaiting as Await)
    : undefined;
  return awaiting ? { awaiting } : {};
}

export function sanitizeRoom(input: unknown): SessionRoomPhoto | null {
  const raw = input as { url?: unknown; at?: unknown } | null | undefined;
  if (!raw || !isNonEmptyString(raw.url)) return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at)) return null;
  return { url: raw.url, at };
}

export function sanitizeRoomSpec(input: unknown): SessionRoomSpec | null {
  const raw = input as { wallCm?: unknown; depthCm?: unknown } | null | undefined;
  const wallCm = clampInt(raw?.wallCm, MIN_ROOM_CM, MAX_ROOM_CM, 0);
  if (!wallCm) return null;
  const depthCm =
    raw?.depthCm !== undefined ? clampInt(raw.depthCm, MIN_ROOM_CM, MAX_ROOM_CM, 0) : 0;
  return depthCm ? { wallCm, depthCm } : { wallCm };
}

const ROLES: readonly Role[] = [
  "styling",
  "wash",
  "mirror",
  "stool",
  "trolley",
  "reception",
  "waiting",
];
const TIERS = ["lean", "balanced", "premium"] as const;

/**
 * Rebuild a Package the way chat.functions.ts rebuilds a plan line: only the
 * product id is trusted from storage, everything derived (name, price,
 * subtotal, the package total) is recomputed against CATALOG_FULL rather than
 * read back from the blob.
 */
function sanitizePackage(input: unknown): Package | null {
  const raw = input as { tier?: unknown; lines?: unknown; reasons?: unknown } | null | undefined;
  if (!raw) return null;
  const tier = TIERS.includes(raw.tier as (typeof TIERS)[number])
    ? (raw.tier as Package["tier"])
    : null;
  if (!tier || !Array.isArray(raw.lines)) return null;

  const lines: Package["lines"] = [];
  let total = 0;
  for (const lineIn of raw.lines) {
    const l = lineIn as { role?: unknown; product?: { id?: unknown }; qty?: unknown } | null;
    if (!l) continue;
    const role = ROLES.includes(l.role as Role) ? (l.role as Role) : null;
    const id = typeof l.product?.id === "string" ? l.product.id : "";
    if (!role || !Object.prototype.hasOwnProperty.call(CATALOG_FULL, id)) continue;
    const product = CATALOG_FULL[id]!;
    const qty = clampInt(l.qty, MIN_QTY, MAX_QTY, 1);
    const subtotal = (product.price ?? 0) * qty;
    total += subtotal;
    lines.push({ role, product, qty, subtotal });
  }
  if (!lines.length) return null;

  const reasons = Array.isArray(raw.reasons)
    ? raw.reasons.filter((r): r is string => typeof r === "string").slice(0, 6)
    : [];

  return { tier, lines, total, reasons };
}

export function sanitizeOffered(input: unknown): SessionOffered | null {
  const raw = input as { packages?: unknown; choice?: unknown; at?: unknown } | null | undefined;
  if (!raw || !Array.isArray(raw.packages)) return null;

  const packages = raw.packages
    .map(sanitizePackage)
    .filter((p): p is Package => p !== null)
    .slice(0, 3);
  if (!packages.length) return null;

  const choiceIn = raw.choice as
    { stations?: unknown; budget?: unknown; note?: unknown; byZone?: unknown } | null | undefined;
  const choice: SessionOfferedChoice = {
    stations: clampInt(choiceIn?.stations, 1, 20, 4),
    budget: Math.max(500, Number(choiceIn?.budget) || 15000),
    note: typeof choiceIn?.note === "string" ? choiceIn.note.slice(0, 800) : "",
    byZone: choiceIn?.byZone === true,
  };

  const at = Number(raw.at);
  return { packages, choice, at: Number.isFinite(at) ? at : Date.now() };
}

export function sanitizePendingQuote(input: unknown): SessionPendingQuote | null {
  const raw = input as { productIds?: unknown } | null | undefined;
  if (!raw || !Array.isArray(raw.productIds)) return null;
  const productIds = raw.productIds
    .filter(
      (id): id is string =>
        typeof id === "string" && Object.prototype.hasOwnProperty.call(CATALOG_FULL, id),
    )
    .slice(0, MAX_PLAN_LINES);
  return productIds.length ? { productIds } : null;
}

function sanitizeShortString(input: unknown, max: number): string | null {
  return typeof input === "string" && input.trim() ? input.trim().slice(0, max) : null;
}

export function sanitizeSession(input: unknown): SessionState {
  const raw = input as Partial<Record<keyof SessionState, unknown>> | null | undefined;
  return {
    transcript: sanitizeTranscript(raw?.transcript),
    plan: sanitizePlan(raw?.plan),
    flow: sanitizeFlow(raw?.flow),
    roomSpec: sanitizeRoomSpec(raw?.roomSpec),
    room: sanitizeRoom(raw?.room),
    offered: sanitizeOffered(raw?.offered),
    pendingZoneRender: raw?.pendingZoneRender === true,
    pendingQuote: sanitizePendingQuote(raw?.pendingQuote),
    handoff: raw?.handoff === true,
    customerName: sanitizeShortString(raw?.customerName, 120),
    phoneLast4: sanitizeShortString(raw?.phoneLast4, 4),
  };
}
