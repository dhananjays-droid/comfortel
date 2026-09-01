import type { ChatMessageInput } from "@/lib/chat.functions";
import type { FlowState } from "@/lib/wa-flow";

/**
 * The conversation state that does not belong to any one channel.
 *
 * Today it lives in React and `sessionStorage`, which works because the browser
 * is the only client. WhatsApp has no client: every message arrives as an
 * isolated webhook with nothing but a phone number, so the state has to be
 * somewhere the server can find it. That is this module.
 *
 * Deliberately small. `chat.functions` needs `{ messages, plan, hasRoomPhoto }`
 * and nothing else, so that — plus where the scripted menu is up to — is the
 * whole of it. The rich UI message tree stays in the browser: render entries,
 * before/after state and product cards are web affordances, and serialising
 * them here would be storing a view for a channel that cannot show it.
 */

/** The plan as it survives storage: ids and counts, never the catalogue. */
export type StoredPlan = { ids: string[]; qty: Record<string, number> };

/** The room photo, as a reference rather than as bytes. */
export type StoredRoom = { url: string; aspect: string; at: string };

export type SessionState = {
  transcript: ChatMessageInput[];
  plan: StoredPlan;
  flow: FlowState;
  room?: StoredRoom | undefined;
};

export const EMPTY_SESSION: SessionState = {
  transcript: [],
  plan: { ids: [], qty: {} },
  flow: {},
};

/**
 * How much transcript to keep.
 *
 * `chat.functions` sends the last 12 turns to the model, so storing much more
 * buys nothing the model will read. Double it so a client that trims
 * differently, or a future window change, has headroom without a migration.
 */
export const MAX_TRANSCRIPT = 24;
/** Matches the tray and the prompt — a plan cannot exceed what either shows. */
export const MAX_PLAN_IDS = 10;
export const MAX_QTY = 99;
/** Same cap chat.functions applies, so nothing is stored that it would truncate. */
export const MAX_CONTENT = 4000;

/**
 * kie serves room photos from expiring tempfile storage, so a stored URL is a
 * lead rather than a guarantee. Past this it is treated as gone and the
 * customer is asked for the photo again — which is the honest outcome, and far
 * better than sending the render host a dead URL and failing the task.
 */
export const ROOM_TTL_MS = 15 * 60 * 1000;

/** Characters that survive a URL, a QR code and being read down a phone line. */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const KEY_LENGTH = 24;

/**
 * A web session key.
 *
 * Random rather than sequential, and long enough not to be guessed: the key is
 * the only thing between a browser and someone else's conversation, exactly as
 * the share code is for a shared design.
 */
export function newSessionKey(): string {
  const bytes = new Uint8Array(KEY_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Shape-check a key arriving from a client, before it reaches the database. */
export function isSessionKey(value: unknown): value is string {
  return typeof value === "string" && /^(wa:[a-f0-9]{64}|[a-z2-9]{16,48})$/.test(value);
}

/**
 * Keep only ids the catalogue still resolves.
 *
 * A stored id that no longer exists would sit in the plan as an invisible line:
 * counted in the subtotal and described to the model, with no card to remove it
 * by. `resolves` is passed in so this module stays free of data imports.
 */
export function sanitizePlan(raw: unknown, resolves: (id: string) => boolean): StoredPlan {
  const source = (raw ?? {}) as { ids?: unknown; qty?: unknown };
  const ids = (Array.isArray(source.ids) ? source.ids : [])
    .filter((id): id is string => typeof id === "string" && resolves(id))
    .slice(0, MAX_PLAN_IDS);

  const qty: Record<string, number> = {};
  const rawQty = source.qty;
  if (rawQty && typeof rawQty === "object") {
    for (const [id, value] of Object.entries(rawQty as Record<string, unknown>)) {
      if (!ids.includes(id)) continue;
      const n = Number(value);
      // Only counts above one are stored: one of a thing is the default, and
      // writing it down invites the tray and the prompt to disagree about
      // whether an absent entry means one or means none.
      if (Number.isFinite(n) && n > 1) qty[id] = Math.min(MAX_QTY, Math.round(n));
    }
  }
  return { ids, qty };
}

/** Keep only turns the model would accept, newest last. */
export function sanitizeTranscript(raw: unknown): ChatMessageInput[] {
  return (Array.isArray(raw) ? raw : [])
    .filter(
      (m): m is ChatMessageInput =>
        (m?.role === "user" || m?.role === "assistant") &&
        typeof m?.content === "string" &&
        m.content.trim().length > 0,
    )
    .slice(-MAX_TRANSCRIPT)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CONTENT) }));
}

/** The scripted menu only ever waits for one of two things. */
export function sanitizeFlow(raw: unknown): FlowState {
  const awaiting = (raw as { awaiting?: unknown } | null)?.awaiting;
  return awaiting === "wall" || awaiting === "photo" ? { awaiting } : {};
}

/**
 * A stored room reference, if it is still worth trying.
 *
 * Returns undefined for an expired one so callers cannot accidentally treat a
 * dead tempfile URL as an attached photo — `hasRoomPhoto` is what decides
 * whether the model may emit a render line, and a stale true there bills for a
 * task that cannot fetch its input.
 */
export function liveRoom(raw: unknown, now = Date.now()): StoredRoom | undefined {
  const room = raw as { url?: unknown; aspect?: unknown; at?: unknown } | null;
  if (!room || typeof room.url !== "string" || !room.url) return undefined;
  const at = typeof room.at === "string" ? Date.parse(room.at) : NaN;
  if (!Number.isFinite(at) || now - at > ROOM_TTL_MS) return undefined;
  return {
    url: room.url,
    aspect: typeof room.aspect === "string" ? room.aspect : "1:1",
    at: new Date(at).toISOString(),
  };
}

/** Append a turn, holding the window without rewriting the caller's array. */
export function appendTurn(
  transcript: ChatMessageInput[],
  role: ChatMessageInput["role"],
  content: string,
): ChatMessageInput[] {
  const trimmed = content.trim();
  if (!trimmed) return transcript;
  return [...transcript, { role, content: trimmed.slice(0, MAX_CONTENT) }].slice(-MAX_TRANSCRIPT);
}
