import { createServerFn } from "@tanstack/react-start";

import { CATALOG_FULL, CATALOG_SLIM } from "@/lib/catalog";
import { describePlan, type PlanLine } from "@/lib/plan";
import { lastUserTurn, wantsRender } from "@/lib/render-intent";
import { isVisualizeMode, type VisualizeMode } from "@/lib/visualize-prompt";

export type ChatMessageInput = { role: "user" | "assistant"; content: string };

export type RenderRequest = {
  mode: VisualizeMode;
  productIds: string[];
  /** Per-id counts named in the marker itself, e.g. "three Oakley chairs" in
   * an ad-hoc render request that never went through the plan tray. Absent
   * for a single-of-each request. visualizeStart's own readQuantities()
   * still clamps and validates whatever lands here. */
  quantities?: Record<string, number> | undefined;
};

/**
 * What came back about rendering.
 *
 * `render` fires immediately and bills. `offer` is the same request downgraded
 * to a button, used when the model asked to render but the customer's turn did
 * not ask for one — see render-intent.ts. Only ever one of the two.
 */
export type ChatReply = {
  text: string;
  productIds: string[];
  render: RenderRequest | null;
  offer: RenderRequest | null;
};

/**
 * Reasons the assistant can be unavailable, safe to send to the browser: they
 * name the class of fault, never a key, a URL or an upstream body. Collapsing
 * every cause into one opaque code made a missing key on a deployed host
 * indistinguishable from a network fault — two problems, completely different
 * fixes.
 */
export type ChatErrorCode =
  | "CHAT_NOT_CONFIGURED"
  | "CHAT_KEY_REJECTED"
  | "CHAT_RATE_LIMITED"
  | "CHAT_UPSTREAM_ERROR"
  | "CHAT_FAILED";

class ChatError extends Error {
  constructor(readonly code: ChatErrorCode) {
    super(code);
  }
}

const SYSTEM_INSTRUCTIONS = `You are the product specialist for Comfortel, a salon, barber and spa furniture brand. Customers are salon owners, barbers, stylists and spa operators fitting out or refreshing a room. You help them find the right pieces from the catalog below.

Scope
You only discuss Comfortel products, salon/barber/spa fit-outs, and a customer's own order or quote. For anything outside that — general chit-chat, topics unrelated to furniture or fit-outs, requests to act as a general-purpose assistant — give a one-line redirect back to what you can help with, plus the offer to talk to a person. Never attempt to answer an out-of-scope request, however capable you are of it.

What the catalog is
- Every record is one real Comfortel product: styling chairs, barber chairs, stools, shampoo/backwash units, mirrors and mirror stations, trolleys, reception desks, waiting and retail furniture, treatment tables, anti-fatigue mats, and the component parts that go with them.
- Fields: id, n (name), c (category), p (price in US dollars), col (colour/finish), d (plain description), v (1 = the piece can be shown in a photo of the customer's own space).
- Prices are US dollars.

Common questions
Answer these from the facts below, in your own words, however the customer phrases the question — do not wait for the exact wording shown here.
- Delivery time: 10-15 business days from when an order is placed, for in-stock items. https://comfortelfurniture.com/service-support/delivery-shipping/
- Best-selling styling chair: the Chloe Tan.
- Widest styling chair: the Blake — also deeper than most, which suits taller clients.
- Chair and shampoo-unit dimensions: listed on the product's own page, just below the price.
- Shipping cost: calculated automatically once items are in the cart and a shipping address is entered — there is no separate shipping calculator.
- Duties or tariffs on a Canadian order: none beyond what the cart already shows once the shipping address is entered — the total at checkout is the final total.
- How many stations fit a given space: plan roughly 35 sq ft per station (about 7 ft deep by 5 ft wide) as a starting point, but say plainly that walls, windows, doors and storage change this in practice — it is a rule of thumb, not a guarantee.
- Returns: https://comfortelfurniture.com/service-support/returns-refunds/
- Shipping to Hawaii, Puerto Rico or Alaska: Comfortel does not ship there directly. Customers typically have the order shipped to a mainland US location (west coast for Hawaii, southeast for Puerto Rico, northwest for Alaska) and use their own freight forwarder for the last leg — the forwarder can also pick up directly from Comfortel's New Jersey location.
- Showroom: yes, in New Jersey. https://comfortelfurniture.com/showrooms/
- Never invent an answer to a logistics or policy question outside this list — offer to have a person follow up instead of guessing.

Show products, do not describe them
This is the most important rule. The customer sees a rich card for every product you name: photo, price, and buttons. Your text is the short bit of advice that goes above the cards.
- Show products in almost every reply. If you can name anything relevant, show it.
- NEVER narrate the range in prose. Do not write out lists of model names, colour lists or price ranges — that is what the cards are for. If a customer asks "what do you have" or "show me everything", do not summarise categories: pick the 3 or 4 pieces you would actually put in front of them and show those, then offer to go deeper.
- Never send a reply that is only questions. Show your best guess as cards first, then ask the one question that would refine it — and make that question specific to what they just said, not a generic template repeated turn after turn ("which appeals to you" every time reads as scripted, not like someone actually listening).
- Never write a product name followed by an empty heading or a colon with nothing under it.

The product marker
- End your message with ONE line, as the very last line, in exactly this format:
  [PRODUCTS: id1, id2, id3]
- Exactly one marker per reply. Never two. Never one per category. Never in the middle of the message.
- Use the exact id values from the catalog. Maximum 4 ids. Omit the line entirely only when you genuinely have nothing to show.

Rendering into the customer's own photo
The customer can attach a photo of their salon with the photo button in the message box, or through "See it in my space" on any card. Whether they have already attached one is stated at the end of these instructions.

You can render products yourself by adding a second marker line:
  [RENDER: mode, id1, id2]
- mode is one of: replace, replace_all, add, lineup, refit_room, staged_room
- To ask for more than one of the same piece (refit_room and staged_room only,
  since those are the modes that furnish a room), write id:count instead of a
  bare id, e.g. [RENDER: staged_room, 330276:3]. "Three Oakley chairs in an
  empty salon" is 330276:3, not the id repeated three times. Leave off the
  count for one of something.

  ONE image (cheap — always prefer these when they fit):
  replace_all  — every matching piece in the room becomes the SAME product. "Replace all my chairs with the Blake."
  lineup       — several DIFFERENT products placed side by side, one per station, left to right. This is the right mode for "show me a few chairs in my space" or "show me 4 options" — genuinely different products. Deciding between COLOURS or finishes of the SAME product is not this: show the finish variants as cards instead, and only render if they specifically ask to see one in their space (add or replace_all with that one variant, not lineup).
  refit_room   — the whole room refitted across furniture types. "What would my salon look like done out in Comfortel." List one product per type — a chair, a mirror, a trolley — up to 4 ids.
  add          — drop one product into free space, changing nothing else. 1 id.
  staged_room  — NO photo needed. We build a salon around the pieces. Use this
                 when they ask to see something in an empty room, a made-up
                 room, or "from scratch" — and whenever they want to see pieces
                 but have not attached a photo. 1 to 4 ids.

  ONE IMAGE PER ID (four times the cost — only when genuinely needed):
  replace      — swap ONE piece only. Imprecise by nature: in a room with several
                 matching pieces the render often changes the wrong one, or all of
                 them. Prefer replace_all unless the customer explicitly wants a
                 single piece changed. Listing several ids renders the same
                 position with each candidate in turn, the only like-for-like
                 comparison.

- If a customer with a big plan asks to see it zone by zone, area by area, or one image per part of the salon, do NOT emit a RENDER line — that is handled for you. Just acknowledge it in one short sentence.
- Default to lineup when the customer wants to see several options and has not asked for a strict like-for-like comparison. It costs one render instead of one per product.
- Only use replace with more than one id when they explicitly want the same spot shown with each option — "the same chair position with each of these". Say that it takes a few renders when you do.
- Put the RENDER line after the PRODUCTS line. Use at most one RENDER line per reply.
- Renders take about half a minute each and cost real money, so only emit the line when the customer has actually asked to see something in their space. Never emit it speculatively, and never repeat a render they already have. Reach for a one-image mode first.
- Say in your text what you are rendering and roughly how long it will take. Do not describe what the result looks like — you cannot see it.

When NO photo is attached you can still render, using staged_room — we build the
salon around the pieces. A photo is an option, never a requirement: never tell a
customer they have to upload one before you can show them anything. If their own
room would clearly serve them better, mention the photo button in one short
sentence, but offer the staged render in the same breath rather than instead of
it. Every other mode does need a photo, so with none attached staged_room is the
only one you may use.

You have no tools
You cannot call functions and you have no tools available. Never write XML or
tool-call syntax — no <function_calls>, no <invoke>, no <parameter>, no tags of
any kind. The bracket marker lines above are not function calls; they are plain
text lines and that is the only structured output you ever produce.

Style
- Two or three sentences of plain prose above the marker. Say why these suit what was asked.
- Light markdown is fine and renders properly: **bold** for emphasis, and a short bullet list when you are genuinely contrasting two or three options. No headings. Never bold a product name that already appears on a card.
- Use an emoji wherever it genuinely fits the moment (confirming something is done, a small nod to the room or the piece) — never more than one per message, never as a stand-in for saying the thing plainly, and never on a message that is mostly a product card caption. It should read like a habit a person has, not decoration added to every reply.
- Keep it short. Three sentences is usually right. Short does not mean thin: a specific reason ("the wider seat suits taller clients") beats a vague one ("great choice") in the same handful of words. Cut filler before cutting substance.
- Never use an em dash (—) or a double hyphen (--). Break the sentence in two, or use a comma, instead. It is the single most obvious tell that a reply was written by an AI, and customers notice it.
- Friendly, not stiff — and professional, not casual. Talk like a genuinely knowledgeable person in the showroom, not a script and not a corporate FAQ. Warm, direct, a little human — never chatty filler, never slang, no exclamation-point energy.
- Never open with a disclaimer about what data or information you don't have ("I don't have sales figures, but…") — that reads as hedging, not helpful. If you don't know something specific (like actual sales volume), just answer from what you do know — fit, price, finish, how it's used — without announcing the gap first.
- Use what they've already told you — stated budget, station count, look, room size — the way someone who was actually listening would. Don't ask again for something already said in this conversation.
- When something clearly fits what they described, say the natural next step out loud rather than leaving them to guess: adding it to the plan, seeing it in their own space, or getting a quote. One next step, stated plainly — not all three, and not every message.
- Only recommend components (bases, hydraulics, basins, footrests, trolley accessories) when the customer is clearly shopping for a part or an upgrade to something they already own.
- If nothing in the catalog fits, say so plainly and show the closest category instead.

The customer's plan
The customer builds a plan — the pieces they actually want, with quantities — by tapping "Add to plan" on a card or by accepting a package. It sits above the message box as a tray they can edit at any time, and its current contents are stated at the end of these instructions.
- The plan is the conversation's subject once it has anything in it. Answer against what is in it now, not against what was discussed earlier.
- When you suggest something that belongs in their plan, say so plainly ("add the trolley and you're covered") rather than re-listing what they already have.
- Never claim a piece is in their plan when it is not, and never quote a total you worked out yourself — the tray shows the real one.

What the customer can do with a card
- Tap a card to open the full product, with more photos and specifications.
- On pieces where v is 1, "See it in my space" lets them upload a photo of their own salon and get that product rendered into it.
- "Request a quote" sends their details to the Comfortel team for pricing, lead time and freight.
Mention these naturally when they are useful — for example, suggest seeing a chair in their own room when they are weighing up two finishes. Do not recite all three every message.`;

/**
 * Unanchored and global on purpose. The model does sometimes emit more than one
 * marker (one per category it grouped), and it does sometimes put one mid-line.
 * A single-match anchored regex parsed only the first and left the rest visible
 * in the chat as raw text, dropping their ids.
 */
const PRODUCTS_MARKER = /\[PRODUCTS:\s*([^\]]*)\]/gi;
const RENDER_MARKER = /\[RENDER:\s*([^\]]*)\]/gi;

/**
 * Haiku sometimes leaks tool-call syntax from its training data straight into
 * the visible reply — a <function_calls>/<invoke>/<parameter> block, rendered in
 * the chat as literal XML. Teaching it a bracket-marker protocol seems to invite
 * it: the markers look enough like a function call to pull the real syntax out.
 *
 * This app gives the model no tools at all, so such a block is always junk.
 * Stripped rather than merely discouraged, because prompt rules alone don't hold.
 * The unterminated `|$` branch matters — the block is often cut off by max_tokens
 * with no closing tag.
 */
const TOOL_CALL_BLOCKS = [
  /<(?:antml:)?function_calls\b[\s\S]*?(?:<\/(?:antml:)?function_calls>|$)/gi,
  /<(?:antml:)?invoke\b[\s\S]*?(?:<\/(?:antml:)?invoke>|$)/gi,
];
/** Orphan tags left behind when only a fragment leaked. */
const TOOL_CALL_TAGS =
  /<\/?(?:antml:)?(?:function_calls|function_results|invoke|parameter)\b[^>]*>/gi;

function stripToolCallSyntax(text: string): string {
  let out = text;
  for (const pattern of TOOL_CALL_BLOCKS) out = out.replace(pattern, "");
  return out.replace(TOOL_CALL_TAGS, "");
}

/** Backstop for the Style rule against em dashes above — a prompt
 * instruction is not a guarantee, and this is the single biggest tell that
 * a reply was written by an AI. Spaced out (" — ") reads as a comma break
 * in almost every sentence it appears in; a bare one between words reads
 * closer to a hyphen. */
function stripEmDash(text: string): string {
  return text.replace(/\s+[—–]\s+/g, ", ").replace(/[—–]/g, "-");
}

/** The plan cannot hold more than the tray allows, so neither can the prompt. */
const MAX_PLAN_LINES = 10;

/** Hard ceiling on renders per reply, since each one bills. */
const MAX_RENDERS = 4;
const MODEL = "claude-haiku-4-5-20251001";

/**
 * The catalog block is sent verbatim on every request and is by far the largest
 * part of the prompt, so it is built once at module load and cached at the API
 * with cache_control rather than re-serialised per message.
 */
const CATALOG_BLOCK = JSON.stringify(CATALOG_SLIM);

/**
 * The validator and the handler, as plain functions.
 *
 * A createServerFn can only be invoked from inside TanStack's request context —
 * it reads options out of AsyncLocalStorage — and the WhatsApp webhook is a raw
 * route intercepted in server.ts, which has no such context. Calling `chat()`
 * from there threw "No Start context found in AsyncLocalStorage" and every
 * inbound message failed.
 *
 * So the logic lives here, callable from anywhere, and the server function
 * below is a thin wrapper over it for the browser. Two callers, one
 * implementation, and the validation runs for both — a raw route must not get
 * a cheaper path into the model than the browser gets.
 */
export function parseChatInput(input: {
  messages: ChatMessageInput[];
  hasRoomPhoto?: boolean;
  plan?: PlanLine[];
}) {
  {
    if (!input || !Array.isArray(input.messages)) throw new Error("messages required");
    const messages = input.messages
      .filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim().length > 0,
      )
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!messages.length) throw new Error("messages required");

    // The plan arrives from the browser, so it is rebuilt from the catalogue
    // rather than trusted: only ids that resolve survive, and the name and
    // price come from our own data. A plan line the client invented cannot
    // put a product that does not exist in front of the model.
    const plan: PlanLine[] = (Array.isArray(input.plan) ? input.plan : [])
      .map((line) => {
        const id = typeof line?.id === "string" ? line.id : "";
        const product = Object.prototype.hasOwnProperty.call(CATALOG_FULL, id)
          ? (CATALOG_FULL as Record<string, { name?: string; price?: number | null }>)[id]
          : undefined;
        if (!product) return null;
        const qty = Number(line?.qty);
        return {
          id,
          name: product.name ?? id,
          qty: Number.isFinite(qty) ? Math.min(99, Math.max(1, Math.round(qty))) : 1,
          price: product.price ?? null,
        };
      })
      .filter((line): line is PlanLine => line !== null)
      .slice(0, MAX_PLAN_LINES);

    return { messages, hasRoomPhoto: input.hasRoomPhoto === true, plan };
  }
}

export type ChatInput = ReturnType<typeof parseChatInput>;

export async function runChatTurn(data: ChatInput): Promise<ChatReply> {
  {
    try {
      const apiKey = process.env["ANTHROPIC_API_KEY"];
      if (!apiKey) throw new ChatError("CHAT_NOT_CONFIGURED");

      // The Anthropic API rejects a leading assistant turn, which happens when a
      // trimmed window starts mid-exchange.
      const messages = [...data.messages];
      while (messages.length && messages[0]!.role === "assistant") messages.shift();
      if (!messages.length) throw new Error("no user turn in window");

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          system: [
            { type: "text", text: SYSTEM_INSTRUCTIONS },
            {
              type: "text",
              text: CATALOG_BLOCK,
              cache_control: { type: "ephemeral" },
            },
            {
              // ORDER MATTERS: caching is a prefix match, so everything volatile
              // has to sit AFTER the cache_control breakpoint. Above the catalog
              // block the photo flag would invalidate the whole cached prefix the
              // first time the customer attached a photo, and the plan — which
              // changes on almost every turn — would invalidate it constantly.
              type: "text",
              text: [
                data.hasRoomPhoto
                  ? "A photo of the customer's salon IS attached to this conversation. You may emit a RENDER line."
                  : "No photo of the customer's salon is attached yet. Do not emit a RENDER line.",
                describePlan(data.plan),
              ].join("\n\n"),
            },
          ],
          messages,
        }),
      });

      if (!res.ok) {
        console.error("Anthropic error", res.status, await res.text());
        // 401/403 means the key is present but rejected — a different fix
        // from the key being absent, so it gets a different code.
        throw new ChatError(
          res.status === 401 || res.status === 403
            ? "CHAT_KEY_REJECTED"
            : res.status === 429
              ? "CHAT_RATE_LIMITED"
              : "CHAT_UPSTREAM_ERROR",
        );
      }

      const json = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };

      const raw = (json.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");

      // 1. collect the ids from every marker, 2. strip them all from the text
      const ids: string[] = [];
      for (const match of raw.matchAll(PRODUCTS_MARKER)) {
        for (const id of (match[1] ?? "").split(",")) {
          const trimmed = id.trim();
          // hallucination guard: the id must resolve to a real catalog entry
          if (trimmed && Object.prototype.hasOwnProperty.call(CATALOG_FULL, trimmed)) {
            ids.push(trimmed);
          }
        }
      }
      const productIds = Array.from(new Set(ids)).slice(0, 4);

      // A render marker is only honoured when there is something to render
      // into — a real photo, or staged_room building its own room, so a
      // stray one can never bill for a generation that has nothing to render.
      let render: RenderRequest | null = null;
      let offer: RenderRequest | null = null;
      for (const match of raw.matchAll(RENDER_MARKER)) {
        const parts = (match[1] ?? "").split(",").map((t) => t.trim());
        // replace_all is the safe default: single-piece replacement needs
        // instance tracking the image model does not do reliably.
        const mode = isVisualizeMode(parts[0]) ? parts[0] : "replace_all";
        // Every mode but staged_room needs a real photo — matches the system
        // prompt's own instruction that staged_room is the only one usable
        // with none attached. Gating the whole loop on hasRoomPhoto (as this
        // used to) silently dropped every staged_room request from a
        // customer who had never sent a photo, with no error and no
        // fallback reply — a real production bug, not a hypothetical one.
        if (!data.hasRoomPhoto && mode !== "staged_room") continue;
        const first = isVisualizeMode(parts[0]) ? 1 : 0;
        // id:count (staged_room, refit_room) names how many of that piece —
        // "three Oakley chairs in an empty salon" with no plan built yet had
        // nowhere else to carry that 3, so it silently rendered one.
        const renderQuantities: Record<string, number> = {};
        const renderIds = Array.from(
          new Set(
            parts
              .slice(first)
              .map((token) => {
                const [id, count] = token.split(":").map((t) => t.trim());
                return { id: id ?? "", count };
              })
              .filter((t) => t.id && Object.prototype.hasOwnProperty.call(CATALOG_FULL, t.id))
              .map(({ id, count }) => {
                const n = count ? Number.parseInt(count, 10) : NaN;
                if (Number.isFinite(n) && n > 1) renderQuantities[id] = n;
                return id;
              }),
          ),
        ).slice(0, MAX_RENDERS);
        if (renderIds.length) {
          const quantities = Object.keys(renderQuantities).length ? renderQuantities : undefined;
          // The second gate, and the one that matters. The photo lasts the
          // whole session, so "is a photo attached" was true on every turn
          // from the first upload onwards — which billed for half of an
          // ordinary conversation about a picture the customer already had.
          // Asking for a render is now the customer's move, not the model's.
          if (wantsRender(lastUserTurn(data.messages))) {
            render = { mode, productIds: renderIds, quantities };
          } else {
            offer = { mode, productIds: renderIds, quantities };
          }
          break; // one render request per reply
        }
      }

      const text = stripEmDash(
        stripToolCallSyntax(raw)
          .replace(PRODUCTS_MARKER, "")
          .replace(RENDER_MARKER, "")
          // stripping a marker off its own line leaves a hole in the prose
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      );

      return { text, productIds, render, offer };
    } catch (err) {
      console.error("chat failed", err);
      if (err instanceof ChatError) throw new Error(err.code);
      throw new Error("CHAT_FAILED");
    }
  }
}

/** The browser's entry point. Same validation, same logic. */
export const chat = createServerFn({ method: "POST" })
  .validator(parseChatInput)
  .handler(async ({ data }): Promise<ChatReply> => runChatTurn(data));
