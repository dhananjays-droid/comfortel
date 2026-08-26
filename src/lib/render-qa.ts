/**
 * Checking a finished render before the customer sees it.
 *
 * These models place furniture plausibly but do not model collision or mirror
 * geometry, so a render can come back with a styling chair half-buried in a wall
 * panel, or a mirror reflecting a chair that is no longer in the room. Both look
 * obviously wrong to a person and completely fine to the generator.
 *
 * So: inspect the output, and if something basic is broken, re-render once with
 * the fault named. The prompt clauses are the first line of defence — this is the
 * net under them, not a replacement for them.
 */

/**
 * The faults worth a retry.
 *
 * Deliberately short and physical. A taxonomy of taste ("the colour feels cold")
 * would fire constantly and burn a $0.03 render each time; these are the things
 * that are unambiguously broken, that a customer would notice immediately, and
 * that a re-render has a real chance of fixing.
 */
export const FAULTS = {
  intersecting: "a piece passing through a wall, counter, basin or another piece",
  floating: "a piece floating above the floor, or sunk into it",
  stale_mirror: "a mirror reflecting furniture that is not in the room",
  duplicate_mismatch: "two of the same product drawn as visibly different designs",
  leftover: "an original piece that was supposed to be replaced still present",
  deformed: "a piece with impossible geometry — melted, bent or fused",
} as const;

export type FaultKind = keyof typeof FAULTS;

export const FAULT_KINDS = Object.keys(FAULTS) as FaultKind[];

export function isFaultKind(value: string): value is FaultKind {
  return (FAULT_KINDS as string[]).includes(value);
}

/** One line of the plan, as the inspector is asked to count it. */
export type Expected = { name: string; qty: number };

/** What the inspector actually counted in the finished image. */
export type Seen = { item: string; seen: number };

export type Verdict = {
  /** True when nothing worth a re-render was found. */
  ok: boolean;
  faults: FaultKind[];
  /** Where the fault is, in the inspector's words. Used to steer the retry. */
  note?: string | undefined;
  /** How many of each piece are actually visible. Empty when not asked. */
  counts?: Seen[] | undefined;
  /**
   * Where the pieces that did not fit could go, in the inspector's words —
   * it has the photograph, so it can name a real wall or corner.
   */
  elsewhere?: string | undefined;
};

/**
 * A piece the render was asked for and did not deliver in full.
 *
 * Not a fault, and deliberately not a reason to re-render. A room that holds
 * two stations will hold two however many times we pay for the picture; the
 * useful response is to say so and say where the rest would go, which is what
 * a person standing in the room would tell you.
 */
export type Shortfall = { name: string; asked: number; seen: number };

/**
 * Read a raw inspector reply into a verdict.
 *
 * Unknown fault names are dropped rather than trusted: a model inventing a
 * category is not evidence of a real defect, and acting on it would spend a
 * render chasing something we cannot describe back to the generator.
 */
export function readVerdict(input: unknown): Verdict {
  const raw = input as
    | { ok?: unknown; faults?: unknown; note?: unknown; counts?: unknown; elsewhere?: unknown }
    | null
    | undefined;
  if (!raw || typeof raw !== "object") return { ok: true, faults: [] };

  const faults = Array.isArray(raw.faults)
    ? raw.faults.filter((f): f is string => typeof f === "string").filter(isFaultKind)
    : [];

  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : undefined;

  const counts = Array.isArray(raw.counts)
    ? raw.counts
        .map((c) => c as { item?: unknown; seen?: unknown })
        .filter((c) => typeof c?.item === "string" && Number.isFinite(Number(c?.seen)))
        .map((c) => ({
          item: String(c.item).trim(),
          seen: Math.max(0, Math.round(Number(c.seen))),
        }))
    : [];

  const elsewhere =
    typeof raw.elsewhere === "string" && raw.elsewhere.trim() ? raw.elsewhere.trim() : undefined;

  // The fault list decides, not the flag: a reply that says ok:true while naming
  // a fault is contradicting itself, and the specific claim is the more
  // considered half of it.
  return {
    ok: faults.length === 0,
    faults,
    ...(note ? { note } : {}),
    ...(counts.length ? { counts } : {}),
    ...(elsewhere ? { elsewhere } : {}),
  };
}

/**
 * Compare what was asked for against what the inspector could see.
 *
 * Matched on the product name because that is what the inspector was given to
 * count; ids mean nothing to it. A name it did not report back is treated as
 * delivered rather than missing — a silent omission is far more likely to be
 * the inspector skipping a line than the render dropping a whole product, and
 * inventing a shortfall would put a wrong sentence under a correct picture.
 */
export function shortfallFrom(expected: Expected[], verdict: Verdict): Shortfall[] {
  const counts = verdict.counts ?? [];
  if (!counts.length) return [];

  const out: Shortfall[] = [];
  for (const want of expected) {
    if (want.qty <= 1) continue;
    const found = counts.find((c) => c.item.toLowerCase() === want.name.toLowerCase());
    if (!found) continue;
    if (found.seen < want.qty) out.push({ name: want.name, asked: want.qty, seen: found.seen });
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The shortfall in the customer's terms.
 *
 * Written as a fact about the photograph rather than an apology about the
 * render, because that is what it is: their room, from this angle, holds this
 * many. Naming where the rest would go is the part that makes it useful — it
 * turns "we couldn't fit them" into "here is how your salon lays out".
 */
export function shortfallNote(short: Shortfall[], elsewhere?: string | undefined): string {
  if (!short.length) return "";

  const parts = short.map(
    (s) => `${s.asked} × ${s.name}, and this view holds ${s.seen === 0 ? "none" : s.seen}`,
  );

  const missing = short.reduce((sum, s) => sum + (s.asked - s.seen), 0);
  const where = elsewhere
    ? ` The remaining ${plural(missing, "piece")} would go ${elsewhere.replace(/^\s*(they|it)\s+(would|could|can)\s+go\s+/i, "")}.`
    : ` The remaining ${plural(missing, "piece")} sit outside this frame — they're still in your plan and your quote.`;

  return `Your plan has ${parts.join("; ")}.${where}`;
}

/**
 * The correction appended to the prompt on a retry.
 *
 * Names the fault as an observed fact about the previous attempt rather than a
 * general rule — the general rules were already in the prompt and did not
 * prevent it, so repeating them louder is not the fix.
 */
export function correctionFor(verdict: Verdict): string {
  if (verdict.ok || !verdict.faults.length) return "";

  const described = verdict.faults.map((kind) => FAULTS[kind]).join("; ");
  const where = verdict.note ? ` Specifically: ${verdict.note}` : "";

  return `The previous attempt at this render came back broken — ${described}.${where} Fix that fault in this attempt while keeping everything else about the room and the products the same.`;
}

/**
 * One retry, not more.
 *
 * Each retry is a full generation: real money and another 80-98 seconds of the
 * customer waiting. One re-roll fixes the common case of a bad sample; a second
 * usually means the room or the request is the problem, and the honest thing is
 * to show what we have rather than spend again.
 */
export const MAX_RETRIES = 1;

export function shouldRetry(verdict: Verdict, attempt: number): boolean {
  return !verdict.ok && attempt < MAX_RETRIES;
}
