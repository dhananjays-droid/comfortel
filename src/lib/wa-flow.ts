import { WA, truncate } from "@/lib/whatsapp";

/**
 * The deterministic front half of a WhatsApp bot.
 *
 * Real business numbers do not send every "Hi" to a language model. They answer
 * instantly from a scripted menu, and only fall through to something smarter
 * when the customer types a sentence the menu cannot serve. That is cheaper, it
 * survives an API outage, and it is what Meta's own guidance pushes towards.
 *
 * Menus are tappable rather than "reply 1 for styling chairs": numbered text
 * menus are the 2026 legacy pattern and interactive buttons measurably beat
 * them. Typed digits are still accepted, because plenty of people type anyway.
 *
 * Pure: no network, no clock, no catalogue lookups beyond the ids it names. The
 * route decides what to do with the reply.
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
};

export type Await = "wall" | "photo";

export type FlowState = { awaiting?: Await | undefined };

export const INITIAL: FlowState = {};

/** Greetings that should open the menu rather than reach the model. */
const GREETING =
  /^\s*(hi+|hey+|hello+|yo|hiya|good\s+(morning|afternoon|evening)|start|menu|hi there)[\s!.?]*$/i;

export function isGreeting(text: string): boolean {
  return GREETING.test(text);
}

const MENU_BUTTONS = [
  { id: "browse", title: "Browse the range" },
  { id: "plan", title: "Plan my space" },
  { id: "human", title: "Talk to a person" },
] as const;

/**
 * The rows of the browse list. Ten is the hard cap for a list message, so this
 * is the whole budget — every entry has to earn its place, which is why
 * components and footrests are absent despite being large categories.
 */
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

export function welcome(): WaReply {
  return {
    // Kept short on purpose: a welcome that scrolls is a welcome nobody reads.
    text: "Hi — Comfortel here. We fit out salons, barbershops and spas, and we can show you any piece rendered into a photo of your own room.\n\nWhat would you like to do?",
    action: { kind: "buttons", buttons: MENU_BUTTONS.map((b) => ({ ...b })) },
  };
}

function browseMenu(): WaReply {
  return {
    text: "Here is the range. Pick a category and I'll show you what's in it.",
    action: {
      kind: "list",
      button: "Browse range",
      rows: BROWSE_ROWS.slice(0, WA.listRows).map((row) => ({
        id: row.id,
        title: truncate(row.title, WA.listRowTitle),
        description: truncate(row.description, WA.listRowDescription),
      })),
    },
  };
}

/** Digit shortcuts, because people type "1" at a menu whatever you show them. */
function byNumber(text: string): string | null {
  const n = Number.parseInt(text.trim(), 10);
  if (!Number.isInteger(n) || n < 1) return null;
  const button = MENU_BUTTONS[n - 1];
  return button ? button.id : null;
}

/**
 * Advance the scripted flow.
 *
 * Returns null when the menu has nothing to say — that is the signal to hand the
 * turn to the model, which is what should happen for "do you have anything in
 * oxblood" and anything else a fixed menu cannot answer.
 */
export function advance(
  state: FlowState,
  raw: string,
): { reply: WaReply; state: FlowState } | null {
  const text = raw.trim();
  if (!text) return null;

  // A room measurement, given because the bot just asked for one.
  if (state.awaiting === "wall") {
    const metres = parseWall(text);
    if (metres === null) {
      return {
        reply: {
          text: "I didn't catch a length there. How long is the wall your styling chairs run along — in feet or metres?",
          awaiting: "wall",
        },
        state: { awaiting: "wall" },
      };
    }
    // Handing the measurement back as free text lets the route run it through
    // layout.ts and the model, which is where the real answer comes from.
    return null;
  }

  const id = text.toLowerCase().startsWith("wa:")
    ? text.slice(3)
    : (byNumber(text) ?? matchButton(text));

  if (id === "browse") return { reply: browseMenu(), state: {} };

  if (id === "plan") {
    return {
      reply: {
        text: "I can work out how many stations your room takes.\n\nHow long is the wall your styling chairs will run along? Feet or metres, whichever you have.",
        awaiting: "wall",
      },
      state: { awaiting: "wall" },
    };
  }

  if (id === "human") {
    return {
      reply: {
        text: "Of course. A Comfortel specialist will pick this up here shortly — usually within one business day. Anything you add now goes to them with the thread.",
        handoff: true,
      },
      state: {},
    };
  }

  if (id && BROWSE_ROWS.some((row) => row.id === id)) {
    return { reply: { text: "", category: id }, state: {} };
  }

  if (isGreeting(text)) return { reply: welcome(), state: {} };

  return null;
}

/** Loose match so "browse" and "Browse the range" both land. */
function matchButton(text: string): string | null {
  const lowered = text.toLowerCase();
  const hit = MENU_BUTTONS.find((b) => b.title.toLowerCase() === lowered || lowered === b.id);
  return hit ? hit.id : null;
}

/**
 * A wall length out of a sentence like "about 16 ft" or "4.5m".
 *
 * Returns metres, or null when there is no number to find. Bare numbers are
 * read as feet, because this is a US catalogue and someone answering "16" to a
 * question about a wall means feet far more often than metres.
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
