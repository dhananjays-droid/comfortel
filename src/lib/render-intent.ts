/**
 * Did the customer actually ask to see something rendered?
 *
 * The render marker used to be gated on one thing: whether a photo was
 * attached. But the photo is held for the whole session, so from the first
 * upload onwards every single turn told the model it could spend $0.03, and the
 * only thing standing in the way was an instruction in the prompt asking it not
 * to. That does not hold. Replaying a realistic thread — photo uploaded, one
 * render already delivered — against eight ordinary reactions to that render
 * produced four unasked-for renders:
 *
 *     "the chairs look a bit too big in that"   -> [RENDER: lineup, x3]
 *     "hmm the colour looks off"                -> [RENDER: lineup, x3]
 *     "nice, but can the mirrors be bigger"     -> [RENDER: lineup, x3]
 *     "what do you think of it?"                -> [RENDER: lineup, x4]
 *
 * Half of a plain conversation about a picture, billed. This module is the
 * structural answer, in the same spirit as validating every product id rather
 * than asking the model not to invent one: the model may still *offer* a
 * render, but it cannot *spend* on one unless the customer asked.
 *
 * Deliberately conservative. A false negative costs one tap on an offer the
 * reply already shows; a false positive costs real money and is exactly the
 * complaint this fixes.
 */

/** Turns of phrase that mean "put this in front of me as a picture". */
const ASKS = [
  // the verbs that only ever mean an image
  /\b(?:render|renders|rendering|visuali[sz]e|visuali[sz]ed|visual|mock\s?up|mocked\s?up|preview|regenerate[sd]?|regenerating|redo(?:ne|ing)?|generate[sd]?|generating|create[sd]?|creating|draw(?:s|ing)?)\b/,

  // "make" is too generic to trust bare ("make it cheaper", "what's this made
  // of" are not render requests), so it only counts paired with the thing
  // being made.
  /\bmake[sd]?\b[\s\S]{0,20}\b(?:image|picture|photo|render|mock\s?up|visual)\b/,

  // "what would it look like", "how does that look in here"
  /\b(?:what|how)\s+(?:would|will|does|do|might)\b[\s\S]{0,40}\blook\b/,

  // placing it somewhere — only counts with a destination
  /\b(?:put|place|drop|install|fit|try)\b[\s\S]{0,30}\bin\s+(?:my|the|this|that)\b/,

  // naming the space is a request on its own
  /\bin\s+my\s+(?:room|salon|space|shop|store|studio|spa|photo|picture|place)\b/,
  /\bin\s+the\s+(?:photo|picture)\b/,

  // A room we invent is still a render, and asking for one should not be
  // treated as idle chat just because no photograph is involved. Comfortel
  // serves salon, barber and spa customers alike (see chat.functions.ts's
  // own opening line), so all three belong in every noun list here, not
  // just the "in my ___" pattern above.
  /\b(?:empty|blank|bare|imaginary|example|sample|generic|new|staged?)\s+(?:room|salon|space|studio|shop|spa|barbershop)\b/,
  /\b(?:build|design|lay\s?out|furnish|stage|set\s?up|mock)\b[\s\S]{0,30}\b(?:room|salon|space|studio|shop|spa|barbershop)\b/,
  /\bfrom\s+scratch\b/,
];

/**
 * "Show me" and "see it" need something to point at.
 *
 * On their own they are how people ask to be shown a *product* — "show me some
 * styling chairs" is a browse request that the cards already answer, and
 * rendering it spends $0.03 nobody asked for. Paired with a pronoun it points
 * at something already on screen, and with a room it names the destination;
 * either way it is asking for a picture. Without one it becomes an offer, which
 * costs a tap rather than three cents.
 */
const SHOW = /\b(?:show|showing|see|seeing)\b/;
const POINTS_AT = /\b(?:it|them|this|that|these|those)\b/;

/**
 * Phrases that cancel a request, checked first.
 *
 * "don't render that" contains "render". Without this the negation reads as the
 * strongest possible ask, which is the worst way to get it wrong.
 */
const REFUSALS = [
  /\b(?:don'?t|do\s+not|please\s+don'?t|no\s+need\s+to|not?\s+need|without|rather\s+not|stop)\b[\s\S]{0,30}\b(?:render|generat|visual|show|creat|mak|draw|redo|regenerat)/,
  /\bno\s+(?:need\s+for\s+)?(?:image|images|render|renders|picture|pictures)\b/,
  /\bjust\s+(?:tell|answer|reply|say|explain)\b/,
  /\b(?:text|words)\s+only\b/,
];

/**
 * Turns of phrase that ask to change something about a render already
 * delivered — "make the chairs blue", "can you make it bigger", "the
 * mirror should be round instead". These are exactly the reactions this
 * module's own docstring names as false positives to guard against
 * ("the chairs look a bit too big in that") — they were never meant to
 * fire a brand-new render, and still shouldn't. What changed is there is
 * now a cheap, surgical edit mode for precisely this shape of request, so
 * a live one deserves a tap-free "yes, on it" rather than either silence
 * or an expensive full rebuild.
 *
 * Checked ONLY when hasRecentRender is true (see wantsRender below) —
 * outside that context these same words are ordinary conversation ("make
 * it cheaper", "add the trolley to my plan") and must not spend on
 * anything. Confining the blast radius to sessions with something to edit
 * is the actual safeguard here, not the wording of the patterns.
 */
/** How the current picture is described as being wrong — shared between the
 * "too/so ___" pattern and the "looks ___" pattern below, since both are
 * really the same complaint said two different ways. */
const APPEARANCE_ADJ =
  "big|small|large|tall|short|dark|light|bright|busy|plain|crowded|bare|empty|off|wrong|odd|strange|dull|cramped|tight|narrow|wide";

const EDIT_ASKS = [
  // make/turn/change/swap + a pointer to something already in the picture
  /\b(?:make|turn|change|swap)\b[\s\S]{0,25}\b(?:it|them|this|that|these|those|the\s+\S+)\b/,
  // adding, removing or repositioning something already in the picture
  /\b(?:add|remove|take\s+out|get\s+rid\s+of|move|shift)\b/,
  // "too big", "so dark", "a bit off" — an intensifier plus what's wrong,
  // matching regardless of what comes before it ("the chairs look a bit
  // too big in that" still hits on "too big").
  new RegExp(`\\b(?:too|so|kind\\s+of|kinda)\\s+(?:${APPEARANCE_ADJ})\\b`),
  // "can the mirrors be bigger" — a comparative on its own already implies
  // a direction to change in, no intensifier needed.
  /\b(?:bigger|smaller|larger|taller|shorter|darker|lighter|brighter|wider|narrower)\b/,
  // "the trolley is in the wrong place"
  /\bwrong\s+(?:place|position|spot|colou?r|size|angle)\b/,
  // "the mirror should be round instead"
  /\binstead\s+of\b/,
  // "the colour looks off", "why does it look so dark" — "so dark" is
  // already covered above; "looks off"/"look wrong" needs its own pattern
  // since APPEARANCE_ADJ's other words read oddly after "looks".
  /\blooks?\s+(?:off|wrong|odd|strange|dull)\b/,
];

/**
 * "Make it cheaper" and "add the trolley to my plan" both match EDIT_ASKS's
 * make/add patterns, but neither is asking to change the picture — they're
 * price talk and a plan action respectively, exactly the kind of ordinary
 * follow-up a customer has after seeing a render. The model still decides
 * whether to actually emit [RENDER: edit] regardless of this function's
 * answer, so a false positive here isn't independently billable — but
 * excluding the clearest cases costs nothing and matches the same instinct
 * that keeps ASKS's own "make" pattern from firing bare.
 */
const EDIT_REFUSALS =
  /\b(?:cheap|cheaper|cheapest|price|priced|pricing|cost|costly|expensive|budget|afford|(?:my|the|a|another)\s+plan|to\s+(?:the\s+)?plan|quote)\b/;

/**
 * True only when this turn is asking for a picture.
 *
 * `hasRecentRender` widens what counts, for one turn only: a customer
 * reacting to a picture they were just shown ("make the chairs blue") is
 * asking for an edit exactly as clearly as "render this in my space" asks
 * for a first render, even though the words themselves look nothing alike
 * — see EDIT_ASKS above for why this is scoped to that context only.
 */
export function wantsRender(text: string, hasRecentRender = false): boolean {
  if (typeof text !== "string") return false;
  const t = text.toLowerCase();
  if (!t.trim()) return false;

  if (REFUSALS.some((r) => r.test(t))) return false;
  if (ASKS.some((r) => r.test(t))) return true;
  if (hasRecentRender && !EDIT_REFUSALS.test(t) && EDIT_ASKS.some((r) => r.test(t))) return true;
  return SHOW.test(t) && POINTS_AT.test(t);
}

/**
 * The turn intent is read from: the customer's most recent message.
 *
 * Earlier turns are not consulted. "Show me the Harper in my room" two messages
 * ago was satisfied by the render it produced; letting it license a second one
 * is the repeat-render half of the same fault.
 */
export function lastUserTurn(messages: Array<{ role: string; content: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user") return m.content;
  }
  return "";
}

/**
 * Did they ask for the plan split across several images?
 *
 * This was a button in the tray, which put a costing decision — one render or
 * three — next to the main action as if the two were equals. A big plan in one
 * frame gives each piece a fraction of the pixels and divides the model's
 * attention across every product in it, so splitting is often the better
 * answer; it is just not a thing to offer permanently. Asked for, it happens.
 *
 * Checked only when a plan exists and has more than one zone in it, so a stray
 * "show me each one" cannot conjure a three-image bill out of a single chair.
 */
const ZONE_ASKS = [
  /\b(?:zone|zones|area|areas|section|sections)\b/,
  /\b(?:separate|separately|individual|individually|one\s+by\s+one|each\s+on\s+its\s+own)\b/,
  /\b(?:split|break)\s+(?:it|them|this|that|the\s+\w+)?\s*(?:up|out|down|into)\b/,
  /\bone\s+(?:image|photo|picture|render|shot)\s+(?:per|for\s+each)\b/,
  /\bdifferent\s+(?:views|angles|shots|images)\b/,
];

/**
 * Its own refusal list, extending the shared one.
 *
 * "don't split it" declines the split, not the render — so these cannot go in
 * REFUSALS, where they would also cancel a perfectly good request for one
 * picture.
 */
const ZONE_REFUSALS = [
  /\b(?:don'?t|do\s+not|no\s+need\s+to|not?\s+need|without|rather\s+not)\b[\s\S]{0,30}\b(?:split|separat|break|zone|area|divid)/,
  /\b(?:all|everything)\s+in\s+(?:one|a\s+single)\b/,
  /\bjust\s+one\s+(?:image|photo|picture|render|shot)\b/,
];

export function wantsZoneSplit(text: string): boolean {
  if (typeof text !== "string") return false;
  const t = text.toLowerCase();
  if (!t.trim()) return false;
  if (REFUSALS.some((r) => r.test(t))) return false;
  if (ZONE_REFUSALS.some((r) => r.test(t))) return false;
  return ZONE_ASKS.some((r) => r.test(t));
}
