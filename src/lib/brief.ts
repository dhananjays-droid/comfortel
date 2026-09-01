/**
 * Reading a salon description for the two numbers that decide everything.
 *
 * "A four-chair salon, modern and warm, budget around $15k" contains a station
 * count and a budget, and those two drive the whole package. Pulling them out
 * here means the guided flow can show what it understood and let someone correct
 * it, rather than asking three questions in a row or silently guessing.
 *
 * Deliberately narrow: it extracts numbers, it does not interpret taste. The
 * prose still goes to the model, which is better at "modern and warm" than any
 * regular expression.
 */

const WORD_NUMBER: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

export type Brief = {
  stations?: number | undefined;
  budget?: number | undefined;
};

/**
 * Everything one free-text reply can yield.
 *
 * The guided form is gone: the assistant now asks for what it needs in a single
 * message and the customer answers however they like, because that is the only
 * shape that survives the move to WhatsApp — there is no dialog to open there,
 * and a five-question interrogation is how a business number gets muted.
 * Whatever is missing is assumed, and the assumption is said out loud.
 */
export type Intake = Brief & {
  /** Styling wall length in centimetres, when they gave one with a unit. */
  wallCm?: number | undefined;
  /** The other dimension, when they gave the room as "12 by 20 ft". */
  depthCm?: number | undefined;
};

/** Station counts read from "four chairs", "4-chair", "6 stations". */
function readStations(text: string): number | undefined {
  const words = Object.keys(WORD_NUMBER).join("|");
  const re = new RegExp(`(\\d{1,2}|${words})[\\s-]*(?:chair|station|seat|styling)`, "i");
  const match = text.match(re);
  if (!match?.[1]) return undefined;

  const raw = match[1].toLowerCase();
  const value = WORD_NUMBER[raw] ?? Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 20) return undefined;
  return value;
}

/**
 * Budgets read from "$15,000", "15k", "budget 20000".
 *
 * A bare number is only taken as a budget when it is big enough to be one —
 * otherwise "4 chairs" would set a $4 budget. The floor is deliberately well
 * above any station count.
 */
const MIN_BUDGET = 500;

function readBudget(text: string): number | undefined {
  // $15k / $15,000 / 15k — the dollar sign or the k makes it unambiguous.
  const marked = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k\b)?|\b([\d,]+(?:\.\d+)?)\s*k\b/i);
  if (marked) {
    const digits = marked[1] ?? marked[3];
    const isK = Boolean(marked[2]) || Boolean(marked[3]);
    if (digits) {
      const value = Number.parseFloat(digits.replace(/,/g, "")) * (isK ? 1000 : 1);
      if (Number.isFinite(value) && value >= MIN_BUDGET) return Math.round(value);
    }
  }

  // Otherwise only a number that follows budget language counts.
  const contextual = text.match(
    /(?:budget|spend|spending|around|about|up to|under|roughly)\D{0,12}([\d,]{3,})/i,
  );
  if (contextual?.[1]) {
    const value = Number.parseFloat(contextual[1].replace(/,/g, ""));
    if (Number.isFinite(value) && value >= MIN_BUDGET) return Math.round(value);
  }

  return undefined;
}

/**
 * A wall length, in centimetres.
 *
 * Requires an explicit unit, unlike the standalone wall question in the
 * scripted menu. There, "16" answers a question that was just asked and can
 * only be a length. Here it sits in a sentence beside a station count and a
 * budget, so a bare number is genuinely ambiguous and is left alone rather than
 * guessed at.
 */
const FEET_TO_CM = 30.48;
const METRE_TO_CM = 100;

export function readWall(text: string): number | undefined {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(m\b|metres?|meters?|ft\b|foot|feet|'|")/i);
  if (!match?.[1]) return undefined;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;

  const unit = (match[2] ?? "").toLowerCase();
  const cm = unit.startsWith("m") ? value * METRE_TO_CM : value * FEET_TO_CM;
  // A salon wall outside this range is a typo, not a room.
  return cm >= 100 && cm <= 3000 ? Math.round(cm) : undefined;
}

/**
 * A room given as two dimensions — "12 by 20 ft", "12x20", "12 ft x 20 ft".
 *
 * People state a room as an area far more often than as one wall, and readWall
 * only ever sees the number a unit happens to be stuck to: given "12 by 20 ft"
 * it returned 20ft and silently dropped the 12. The longer side is taken as the
 * styling wall, which is where the chairs go in almost every real salon.
 */
export function readRoomPair(text: string): { wallCm: number; depthCm: number } | undefined {
  const match = text.match(
    /(\d+(?:\.\d+)?)\s*(m\b|metres?|meters?|ft\b|foot|feet|'|")?\s*(?:x|×|by)\s*(\d+(?:\.\d+)?)\s*(m\b|metres?|meters?|ft\b|foot|feet|'|")?/i,
  );
  if (!match?.[1] || !match?.[3]) return undefined;

  // The unit is usually written once, after the second number.
  const unit = (match[4] || match[2] || "ft").toLowerCase();
  const scale = unit.startsWith("m") ? METRE_TO_CM : FEET_TO_CM;
  const a = Number.parseFloat(match[1]) * scale;
  const b = Number.parseFloat(match[3]) * scale;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;

  const wallCm = Math.round(Math.max(a, b));
  const depthCm = Math.round(Math.min(a, b));
  if (wallCm < 100 || wallCm > 3000 || depthCm < 100) return undefined;
  return { wallCm, depthCm };
}

/** Read one reply for everything it happens to contain. */
export function readIntake(text: string): Intake {
  const brief = readBrief(text);
  // A stated area wins over a single length: "12 by 20 ft" is a whole room and
  // readWall would see only the number the unit is attached to.
  const pair = readRoomPair(text);
  if (pair) return { ...brief, wallCm: pair.wallCm, depthCm: pair.depthCm };
  const wallCm = readWall(text);
  return { ...brief, ...(wallCm === undefined ? {} : { wallCm }) };
}

export function readBrief(text: string): Brief {
  const stations = readStations(text);
  const budget = readBudget(text);
  return {
    ...(stations === undefined ? {} : { stations }),
    ...(budget === undefined ? {} : { budget }),
  };
}

/**
 * The placeholder is a worked example, not a hint.
 *
 * People type far more when shown the shape of a good answer, and this one is
 * built to demonstrate every field the parser looks for — count, budget, and the
 * taste language the model handles.
 */
export const BRIEF_PLACEHOLDER =
  "e.g. A four-chair salon in a converted shopfront. Warm and modern, lots of timber. Budget around $15,000, and the chairs matter most.";

/** Shown under the field so nobody has to guess what is useful to say. */
export const BRIEF_PROMPTS = [
  "How many styling stations?",
  "Roughly what budget?",
  "The look you're after",
  "What matters most",
];
