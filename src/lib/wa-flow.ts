import { readIntake, type Intake } from "@/lib/brief";
import { WA, truncate } from "@/lib/whatsapp";

/**
 * The conversation's spine, on every channel.
 *
 * This was a WhatsApp-only preview sitting behind a flag while the web had its
 * own landing screen and a modal planning form. Two flows meant two products,
 * and only one of them could ever ship to a business number — WhatsApp has no
 * hero section and no dialog to open.
 *
 * So there is one flow now, and it is this one: a greeting, three things you
 * can tap, and free text for everything else. The web renders it with its own
 * type and spacing; WhatsApp renders it as reply buttons. Neither can express
 * anything the other cannot.
 *
 * Pure — no network, no clock, no catalogue lookups beyond the ids it names.
 * The route decides what to do with the reply.
 */

export type WaAction =
  | { kind: "buttons"; buttons: Array<{ id: string; title: string }> }
  | {
      kind: "list";
      button: string;
      rows: Array<{ id: string; title: string; description?: string | undefined }>;
    };

export type WaReply = {
  text: string;
  action?: WaAction | undefined;
  /** A category slug whose products the route should list. */
  category?: string | undefined;
  /** What the bot is now waiting for, so free text is read in context. */
  awaiting?: Await | undefined;
  /** True when the customer should be handed to a person. */
  handoff?: boolean | undefined;
  /** Set when this turn asked for a room photo, so the composer can prompt. */
  wantsPhoto?: boolean | undefined;
};

/**
 * What a free-text turn will be read as.
 *
 * `visualize` and `build` both collect in one message rather than one question
 * at a time. Five questions in a row is how a business number gets muted, and
 * on WhatsApp there is no form to fall back on.
 */
export type Await = "visualize" | "build" | "wall" | "photo" | "quote";

export type FlowState = { awaiting?: Await | undefined };

export const INITIAL: FlowState = {};

/** Greetings that should open the menu rather than reach the model. */
const GREETING =
  /^\s*(hi+|hey+|hello+|yo|hiya|good\s+(morning|afternoon|evening)|start|menu|hi there)[\s!.?]*$/i;

export function isGreeting(text: string): boolean {
  return GREETING.test(text);
}

/**
 * Three, because WhatsApp caps reply buttons at three and a fourth would force
 * the heavier list primitive on the very first message.
 *
 * They are verbs, not categories: what you want to do, not what section of a
 * catalogue you are in. "Ask" is the honest third option — most people arrive
 * with a question rather than a project, and without it they have to pick a
 * lane before they are allowed to speak.
 */
const MENU_BUTTONS = [
  { id: "visualize", title: "See it in my salon" },
  { id: "build", title: "Plan my salon" },
  { id: "ask", title: "Ask a question" },
] as const;

export function welcome(): WaReply {
  return {
    // Kept short on purpose: a welcome that scrolls is a welcome nobody reads.
    // One emoji, once, on the very first hello — the rest of the
    // conversation leaves that warmth to the model's own judgment call
    // rather than baking a fixed emoji into a template sent every time.
    text: "Hi 👋, Comfortel here. We fit out salons, barbershops and spas, and we can show you any piece standing in a photo of your own room.\n\nWhat would you like to do?",
    action: { kind: "buttons", buttons: MENU_BUTTONS.map((b) => ({ ...b })) },
  };
}

/**
 * One message, everything asked at once.
 *
 * The form this replaces had a description box, a stations field, a budget
 * field, a unit toggle and two dimension fields. None of that exists on
 * WhatsApp, and it turned out none of it was needed here either: the parser
 * reads the numbers out of ordinary prose, and whatever is missing is assumed
 * out loud rather than demanded up front.
 */
function buildIntake(): WaReply {
  return {
    text: [
      "Tell me what you can, in your own words:",
      "",
      "• How many styling stations?",
      "• Roughly what budget?",
      "• The look you're after",
      "• The wall length, if you have it",
      "",
      "Anything you skip I'll assume, and I'll say what I assumed. A photo of the room helps too.",
    ].join("\n"),
    awaiting: "build",
    wantsPhoto: true,
  };
}

function visualizeIntake(): WaReply {
  return {
    text: [
      "Send me a photo of the room (one wide shot is plenty) and tell me what you'd like to see in it.",
      "",
      'Anything from "a black styling chair" to "four stations with mirrors and a trolley". If you\'re not sure, just send the photo and I\'ll suggest something.',
    ].join("\n"),
    awaiting: "visualize",
    wantsPhoto: true,
  };
}

function askIntake(): WaReply {
  return {
    text: "Ask away: the range, prices, dimensions, finishes, lead times. If it's about fitting out a salon, I can probably help.",
  };
}

/** Digit shortcuts, because people type "1" at a menu whatever you show them. */
function byNumber(text: string): string | null {
  const n = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(n) || n < 1) return null;
  const button = MENU_BUTTONS[n - 1];
  return button ? button.id : null;
}

/** Loose match so "plan my salon" and the button id both land. */
function matchButton(text: string): string | null {
  const lowered = text.toLowerCase().trim();
  const hit = MENU_BUTTONS.find((b) => b.title.toLowerCase() === lowered || lowered === b.id);
  return hit ? hit.id : null;
}

/**
 * What we understood, and what we are assuming instead.
 *
 * Said out loud because the alternative is a silent guess that shapes a whole
 * package — and the customer discovering it only when the total is wrong.
 */
export function describeIntake(intake: Intake): string {
  const read: string[] = [];
  if (intake.stations) read.push(`${intake.stations} stations`);
  if (intake.budget) read.push(`$${intake.budget.toLocaleString("en-US")} budget`);
  if (intake.wallCm) read.push(`${Math.round(intake.wallCm / 30.48)}ft wall`);

  const missing: string[] = [];
  if (!intake.stations && !intake.wallCm) missing.push("station count");
  if (!intake.budget) missing.push("budget");

  const parts = [read.length ? `Read from that: ${read.join(", ")}.` : ""];
  if (missing.length)
    parts.push(`Not given: ${missing.join(", ")}, so I'll assume a sensible default.`);
  return parts.filter(Boolean).join(" ");
}

/**
 * Advance the scripted flow.
 *
 * Returns null when the menu has nothing to say — that is the signal to call
 * the model, which is what should happen for "do you have anything in oxblood"
 * and anything else a fixed menu cannot answer.
 */
export function advance(
  state: FlowState,
  raw: string,
): { reply: WaReply; state: FlowState } | null {
  const text = raw.trim();
  if (!text) return null;

  // A turn that answers a question we just asked belongs to the model, with
  // what we parsed attached. Returning null hands it over; the route reads
  // `state.awaiting` to know how to frame it.
  if (state.awaiting) return null;

  const id = text.toLowerCase().startsWith("wa:")
    ? text.slice(3)
    : (byNumber(text) ?? matchButton(text));

  if (id === "visualize") return { reply: visualizeIntake(), state: { awaiting: "visualize" } };
  if (id === "build") return { reply: buildIntake(), state: { awaiting: "build" } };
  if (id === "ask") return { reply: askIntake(), state: {} };

  if (isGreeting(text)) return { reply: welcome(), state: {} };

  return null;
}

/** Re-exported so the route reads one reply with one call. */
export { readIntake };
export type { Intake };

/**
 * A wall length out of a sentence like "about 16 ft" or "4.5m".
 *
 * Returns metres, and unlike the intake parser it accepts a bare number,
 * because it only ever reads a reply to a question that just asked for a
 * length. Bare numbers are read as feet — this is a US catalogue, and someone
 * answering "16" about a wall means feet far more often than metres.
 */
export function parseWall(text: string): number | null {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(m\b|metre|meter|ft|foot|feet|'|")?/i);
  if (!match?.[1]) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = (match[2] ?? "").toLowerCase();
  const isMetres = unit.startsWith("m");
  return isMetres ? value : value * 0.3048;
}

/** Kept for the list primitive, which the catalogue browser still uses. */
export function categoryRows(): Array<{ id: string; title: string; description: string }> {
  return BROWSE_ROWS.slice(0, WA.listRows).map((row) => ({
    id: row.id,
    title: truncate(row.title, WA.listRowTitle),
    description: truncate(row.description, WA.listRowDescription),
  }));
}

const BROWSE_ROWS: Array<{ id: string; title: string; description: string }> = [
  { id: "salon/styling-chairs", title: "Styling chairs", description: "The centre of the salon" },
  { id: "salon/shampoo-area", title: "Shampoo & backwash", description: "Basins and wash lounges" },
  { id: "salon/mirrors", title: "Mirrors", description: "Wall and station mirrors" },
  { id: "salon/stools", title: "Stools", description: "Stylist and client seating" },
  { id: "salon/trolleys", title: "Trolleys", description: "Colour and tool storage" },
  { id: "salon/reception-desks", title: "Reception desks", description: "Front of house" },
  { id: "salon/waiting-retail", title: "Waiting & retail", description: "Seating and display" },
  { id: "barbers/barber-chairs", title: "Barber chairs", description: "Barbering stations" },
  { id: "spa/treatment-tables", title: "Treatment tables", description: "Spa and beauty rooms" },
  { id: "salon/mats", title: "Anti-fatigue mats", description: "Standing comfort" },
];
