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
  /** Lower end when the customer gave a range or a comfortable/stretch pair. */
  budgetMin?: number | undefined;
  /** Upper end, or the single stated budget. This is the cap used for planning. */
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

/**
 * Station counts read from "four chairs", "4-chair", "6 stations" — and,
 * just as often, the reversed order the guided prompts themselves invite:
 * someone answering "How many styling stations - 5" line by line writes the
 * keyword first and the number after it, which the number-first pattern
 * alone never matched. Confirmed live: that exact phrasing parsed a budget
 * and a wall length out of the same message but silently missed the station
 * count, and the flow fell back to whatever a 10ft wall physically fits (3)
 * with no sign the customer's own "5" was ever seen. Mirrors readBudget's
 * own "keyword ... number" contextual fallback below.
 */
function readStations(text: string): number | undefined {
  const words = Object.keys(WORD_NUMBER).join("|");
  const numberFirst = new RegExp(`(\\d{1,2}|${words})[\\s-]*(?:chair|station|seat|styling)`, "i");
  const keywordFirst = new RegExp(
    `(?:chair|station|seat|styling)[^\\n\\d]{0,20}(\\d{1,2}|${words})\\b`,
    "i",
  );
  const match = text.match(numberFirst) ?? text.match(keywordFirst);
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

type BudgetRead = { budget: number; budgetMin?: number };

const NUMBER_WORD =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
const MONEY_TOKEN = "(?:\\$\\s*|usd\\s*)?[\\d,]+(?:\\.\\d+)?\\s*(?:k\\b|grand\\b|thousand\\b)?";

const MONEY_WORD: Record<string, number> = {
  ...WORD_NUMBER,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function parseMoneyToken(raw: string): number | undefined {
  const normalized = raw.toLowerCase().trim();
  const wordMatch = normalized.match(
    new RegExp(`\\b(${NUMBER_WORD})(?:[-\\s]+(${NUMBER_WORD}))?\\s+(?:thousand|grand)\\b`, "i"),
  );
  if (wordMatch?.[1]) {
    const first = MONEY_WORD[wordMatch[1].toLowerCase()] ?? 0;
    const second = wordMatch[2] ? (MONEY_WORD[wordMatch[2].toLowerCase()] ?? 0) : 0;
    const value = (first + second) * 1000;
    return value >= MIN_BUDGET ? value : undefined;
  }

  const match = normalized.match(/([\d,]+(?:\.\d+)?)\s*(k|grand|thousand)?/i);
  if (!match?.[1]) return undefined;
  const multiplier = match[2] ? 1000 : 1;
  const value = Number.parseFloat(match[1].replace(/,/g, "")) * multiplier;
  return Number.isFinite(value) && value >= MIN_BUDGET ? Math.round(value) : undefined;
}

function readBudget(text: string): BudgetRead | undefined {
  // Keep both ends of an explicit range. Planning uses the upper end as the
  // cap, while the confirmation makes the range visible to the customer.
  const range = text.match(
    new RegExp(`(${MONEY_TOKEN})\\s*(?:-|–|—|to|and)\\s*(${MONEY_TOKEN})`, "i"),
  );
  if (range?.[1] && range[2]) {
    const a = parseMoneyToken(range[1]);
    const b = parseMoneyToken(range[2]);
    if (a && b) return { budget: Math.max(a, b), budgetMin: Math.min(a, b) };
  }

  // "15k but can stretch to 18k" is also a range, even though ordinary
  // words sit between the two values.
  const stretch = text.match(
    new RegExp(`(${MONEY_TOKEN})[^.\\n]{0,50}?stretch(?:ing)?(?:\\s+to)?\\s*(${MONEY_TOKEN})`, "i"),
  );
  if (stretch?.[1] && stretch[2]) {
    const a = parseMoneyToken(stretch[1]);
    const b = parseMoneyToken(stretch[2]);
    if (a && b) return { budget: Math.max(a, b), budgetMin: Math.min(a, b) };
  }

  // $15k / USD 15,000 / 15 grand / 15k — a marker makes it unambiguous.
  const marked = text.match(
    /(?:\$\s*|usd\s*)[\d,]+(?:\.\d+)?\s*(?:k\b|grand\b|thousand\b)?|\b[\d,]+(?:\.\d+)?\s*(?:k|grand|thousand)\b/i,
  );
  if (marked?.[0]) {
    const budget = parseMoneyToken(marked[0]);
    if (budget) return { budget };
  }

  // Word amounts are common in voice-note transcripts and casual messages.
  const words = text.match(
    new RegExp(`\\b(?:${NUMBER_WORD})(?:[-\\s]+(?:${NUMBER_WORD}))?\\s+(?:thousand|grand)\\b`, "i"),
  );
  if (words?.[0]) {
    const budget = parseMoneyToken(words[0]);
    if (budget) return { budget };
  }

  // Otherwise only a number that follows budget language counts.
  const contextual = text.match(
    /(?:budget|spend|spending|around|about|up to|under|roughly|cap)\D{0,12}([\d,]{3,})/i,
  );
  if (contextual?.[1]) {
    const value = Number.parseFloat(contextual[1].replace(/,/g, ""));
    if (Number.isFinite(value) && value >= MIN_BUDGET) return { budget: Math.round(value) };
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
  const budgetRead = readBudget(text);
  return {
    ...(stations === undefined ? {} : { stations }),
    ...(budgetRead?.budgetMin === undefined ? {} : { budgetMin: budgetRead.budgetMin }),
    ...(budgetRead?.budget === undefined ? {} : { budget: budgetRead.budget }),
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
