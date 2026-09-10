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
import { isVisualizeMode, type VisualizeMode } from "@/lib/visualize-prompt";
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

/** How long a delivered render stays editable via "make it blue"-style
 * follow-ups. Wider than ROOM_TTL_MS — a customer looking at a finished
 * picture and deciding what to tweak takes longer than uploading a photo,
 * but this still shouldn't outlive the conversation that produced it. */
export const LAST_RENDER_TTL_MS = 30 * 60 * 1000;

/**
 * The most recently delivered render — what a "make the chairs blue"
 * follow-up actually edits.
 *
 * `resultUrl` is the durable, re-hosted image (never kie's own expiring
 * tempfile URL — see rehostRender), which becomes the "room" input for an
 * edit render the same way a customer's own photo does for every other
 * mode. `mode`/`productIds`/`quantities` are kept only so a render-worker
 * failure path or a future feature has the original request on hand; an
 * edit itself needs none of them.
 */
export type SessionLastRender = {
  resultUrl: string;
  mode: VisualizeMode;
  productIds: string[];
  quantities: Record<string, number>;
  at: number;
};

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

/** One line accepted so far in the role-by-role picker below. */
export type SessionRolePick = { productId: string; qty: number };

/**
 * Mid-way through picking a product for every role in a chosen tier —
 * "Pick your styling chair", then mirror, then wash unit, one WhatsApp
 * list message at a time, rather than the tier's own defaults going
 * straight into the plan unseen. Confirmed live: a customer accepting a
 * tier got one specific chair/mirror/trolley chosen entirely by the
 * system, with no chance to see or choose an alternative.
 *
 * `remainingRoles` is the queue still to ask about, in ROLE_ORDER;
 * `picks` accumulates as each list reply comes in, seeded with the
 * chosen package's own defaults so an abandoned picker (a customer who
 * stops responding mid-flow) still has a complete, sensible plan sitting
 * in `picks` rather than a partial one.
 */
export type SessionRolePicker = {
  choice: SessionOfferedChoice;
  remainingRoles: Role[];
  picks: Record<string, SessionRolePick>;
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
  lastRender: SessionLastRender | null;
  offered: SessionOffered | null;
  rolePicker: SessionRolePicker | null;
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
  lastRender: null,
  offered: null,
  rolePicker: null,
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

/** A render older than LAST_RENDER_TTL_MS is treated as gone — "make it
 * blue" against a picture from an hour ago re-starts the conversation
 * instead of editing something the customer may not even remember. */
export function liveLastRender(
  render: SessionLastRender | null,
  now = Date.now(),
): SessionLastRender | null {
  if (!render) return null;
  return now - render.at > LAST_RENDER_TTL_MS ? null : render;
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

/** Same TTL and reasoning as liveOffered — a role-picker list reply
 * arriving half an hour after the tier was accepted answers a question
 * the customer probably forgot asking. */
export function liveRolePicker(
  picker: SessionRolePicker | null,
  now = Date.now(),
): SessionRolePicker | null {
  if (!picker) return null;
  return now - picker.at > OFFER_TTL_MS ? null : picker;
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

export function sanitizeLastRender(input: unknown): SessionLastRender | null {
  const raw = input as
    | {
        resultUrl?: unknown;
        mode?: unknown;
        productIds?: unknown;
        quantities?: unknown;
        at?: unknown;
      }
    | null
    | undefined;
  if (!raw || !isNonEmptyString(raw.resultUrl)) return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at)) return null;
  const mode: VisualizeMode = isVisualizeMode(raw.mode) ? raw.mode : "edit";

  const idsIn = Array.isArray(raw.productIds) ? raw.productIds : [];
  const productIds = idsIn.filter(
    (id): id is string =>
      typeof id === "string" && Object.prototype.hasOwnProperty.call(CATALOG_FULL, id),
  );

  const qtyIn =
    raw.quantities && typeof raw.quantities === "object"
      ? (raw.quantities as Record<string, unknown>)
      : {};
  const quantities: Record<string, number> = {};
  for (const id of productIds) {
    if (qtyIn[id] === undefined) continue;
    quantities[id] = clampInt(qtyIn[id], MIN_QTY, MAX_QTY, 1);
  }

  return { resultUrl: raw.resultUrl, mode, productIds, quantities, at };
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

function sanitizeOfferedChoice(input: unknown): SessionOfferedChoice {
  const raw = input as
    { stations?: unknown; budget?: unknown; note?: unknown; byZone?: unknown } | null | undefined;
  return {
    stations: clampInt(raw?.stations, 1, 20, 4),
    budget: Math.max(500, Number(raw?.budget) || 15000),
    note: typeof raw?.note === "string" ? raw.note.slice(0, 800) : "",
    byZone: raw?.byZone === true,
  };
}

export function sanitizeOffered(input: unknown): SessionOffered | null {
  const raw = input as { packages?: unknown; choice?: unknown; at?: unknown } | null | undefined;
  if (!raw || !Array.isArray(raw.packages)) return null;

  const packages = raw.packages
    .map(sanitizePackage)
    .filter((p): p is Package => p !== null)
    .slice(0, 3);
  if (!packages.length) return null;

  const at = Number(raw.at);
  return {
    packages,
    choice: sanitizeOfferedChoice(raw.choice),
    at: Number.isFinite(at) ? at : Date.now(),
  };
}

const ROLE_VALUES: readonly Role[] = [
  "styling",
  "wash",
  "mirror",
  "stool",
  "trolley",
  "reception",
  "waiting",
];

export function sanitizeRolePicker(input: unknown): SessionRolePicker | null {
  const raw = input as
    | { choice?: unknown; remainingRoles?: unknown; picks?: unknown; at?: unknown }
    | null
    | undefined;
  if (!raw) return null;

  const remainingRoles = (Array.isArray(raw.remainingRoles) ? raw.remainingRoles : []).filter(
    (r): r is Role => ROLE_VALUES.includes(r as Role),
  );
  // Nothing left to ask about is not a picker in progress — it is done.
  if (!remainingRoles.length) return null;

  const picksIn =
    raw.picks && typeof raw.picks === "object" ? (raw.picks as Record<string, unknown>) : {};
  const picks: Record<string, SessionRolePick> = {};
  for (const [role, value] of Object.entries(picksIn)) {
    if (!ROLE_VALUES.includes(role as Role)) continue;
    const v = value as { productId?: unknown; qty?: unknown } | null | undefined;
    if (!v || typeof v.productId !== "string") continue;
    if (!Object.prototype.hasOwnProperty.call(CATALOG_FULL, v.productId)) continue;
    picks[role] = { productId: v.productId, qty: clampInt(v.qty, MIN_QTY, MAX_QTY, 1) };
  }

  const at = Number(raw.at);
  return {
    choice: sanitizeOfferedChoice(raw.choice),
    remainingRoles,
    picks,
    at: Number.isFinite(at) ? at : Date.now(),
  };
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
    lastRender: sanitizeLastRender(raw?.lastRender),
    offered: sanitizeOffered(raw?.offered),
    rolePicker: sanitizeRolePicker(raw?.rolePicker),
    pendingZoneRender: raw?.pendingZoneRender === true,
    pendingQuote: sanitizePendingQuote(raw?.pendingQuote),
    handoff: raw?.handoff === true,
    customerName: sanitizeShortString(raw?.customerName, 120),
    phoneLast4: sanitizeShortString(raw?.phoneLast4, 4),
  };
}
