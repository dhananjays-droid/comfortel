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

export type Verdict = {
  /** True when nothing worth a re-render was found. */
  ok: boolean;
  faults: FaultKind[];
  /** Where the fault is, in the inspector's words. Used to steer the retry. */
  note?: string | undefined;
};

/**
 * Read a raw inspector reply into a verdict.
 *
 * Unknown fault names are dropped rather than trusted: a model inventing a
 * category is not evidence of a real defect, and acting on it would spend a
 * render chasing something we cannot describe back to the generator.
 */
export function readVerdict(input: unknown): Verdict {
  const raw = input as { ok?: unknown; faults?: unknown; note?: unknown } | null | undefined;
  if (!raw || typeof raw !== "object") return { ok: true, faults: [] };

  const faults = Array.isArray(raw.faults)
    ? raw.faults.filter((f): f is string => typeof f === "string").filter(isFaultKind)
    : [];

  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : undefined;

  // The fault list decides, not the flag: a reply that says ok:true while naming
  // a fault is contradicting itself, and the specific claim is the more
  // considered half of it.
  return {
    ok: faults.length === 0,
    faults,
    ...(note ? { note } : {}),
  };
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
