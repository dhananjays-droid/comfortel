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
