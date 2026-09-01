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
  /\b(?:render|renders|rendering|visuali[sz]e|visuali[sz]ed|mock\s?up|mocked\s?up|preview)\b/,

  // "what would it look like", "how does that look in here"
  /\b(?:what|how)\s+(?:would|will|does|do|might)\b[\s\S]{0,40}\blook\b/,

  // placing it somewhere — only counts with a destination
  /\b(?:put|place|drop|install|fit|try)\b[\s\S]{0,30}\bin\s+(?:my|the|this|that)\b/,

  // naming the space is a request on its own
  /\bin\s+my\s+(?:room|salon|space|shop|store|studio|spa|photo|picture|place)\b/,
  /\bin\s+the\s+(?:photo|picture)\b/,

  // A room we invent is still a render, and asking for one should not be
  // treated as idle chat just because no photograph is involved.
  /\b(?:empty|blank|bare|imaginary|example|sample|generic|new|staged?)\s+(?:room|salon|space|studio|shop)\b/,
  /\b(?:build|design|lay\s?out|furnish|stage|set\s?up|mock)\b[\s\S]{0,30}\b(?:room|salon|space|studio|shop|salon)\b/,
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
  /\b(?:don'?t|do\s+not|please\s+don'?t|no\s+need\s+to|not?\s+need|without|rather\s+not|stop)\b[\s\S]{0,30}\b(?:render|generat|visuali[sz]|show|creat|mak)/,
  /\bno\s+(?:need\s+for\s+)?(?:image|images|render|renders|picture|pictures)\b/,
  /\bjust\s+(?:tell|answer|reply|say|explain)\b/,
  /\b(?:text|words)\s+only\b/,
];

/** True only when this turn is asking for a picture. */
export function wantsRender(text: string): boolean {
  if (typeof text !== "string") return false;
  const t = text.toLowerCase();
  if (!t.trim()) return false;

  if (REFUSALS.some((r) => r.test(t))) return false;
  if (ASKS.some((r) => r.test(t))) return true;
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
