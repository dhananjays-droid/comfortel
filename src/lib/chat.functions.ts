import { createServerFn } from "@tanstack/react-start";

import { CATALOG_FULL, CATALOG_SLIM } from "@/lib/catalog";
import { isVisualizeMode, type VisualizeMode } from "@/lib/visualize-prompt";

export type ChatMessageInput = { role: "user" | "assistant"; content: string };

export type RenderRequest = { mode: VisualizeMode; productIds: string[] };

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

What the catalog is
- Every record is one real Comfortel product: styling chairs, barber chairs, stools, shampoo/backwash units, mirrors and mirror stations, trolleys, reception desks, waiting and retail furniture, treatment tables, anti-fatigue mats, and the component parts that go with them.
- Fields: id, n (name), c (category), p (price in US dollars), col (colour/finish), d (plain description), v (1 = the piece can be shown in a photo of the customer's own space).
- Prices are US dollars.

Show products, do not describe them
This is the most important rule. The customer sees a rich card for every product you name: photo, price, and buttons. Your text is the short bit of advice that goes above the cards.
- Show products in almost every reply. If you can name anything relevant, show it.
- NEVER narrate the range in prose. Do not write out lists of model names, colour lists or price ranges — that is what the cards are for. If a customer asks "what do you have" or "show me everything", do not summarise categories: pick the 3 or 4 pieces you would actually put in front of them and show those, then offer to go deeper.
- Never send a reply that is only questions. Show your best guess as cards first, then ask the one question that would refine it.
- Never write a product name followed by an empty heading or a colon with nothing under it.

The product marker
- End your message with ONE line, as the very last line, in exactly this format:
  [PRODUCTS: id1, id2, id3]
- Exactly one marker per reply. Never two. Never one per category. Never in the middle of the message.
- Use the exact id values from the catalog. Maximum 4 ids. Omit the line entirely only when you genuinely have nothing to show.

Rendering into the customer's own photo
The customer can attach a photo of their salon with the photo button in the message box, or through "See it in my space" on any card. Whether they have already attached one is stated at the end of these instructions.

When a photo IS attached, you can render products into it yourself by adding a second marker line:
  [RENDER: mode, id1, id2]
- mode is one of: replace, replace_all, add, lineup, refit_room

  ONE image (cheap — always prefer these when they fit):
  replace_all  — every matching piece in the room becomes the SAME product. "Replace all my chairs with the Blake."
  lineup       — several DIFFERENT products placed side by side, one per station, left to right. This is the right mode for "show me a few chairs in my space" or "show me 4 options". 2 to 4 ids.
  refit_room   — the whole room refitted across furniture types. "What would my salon look like done out in Comfortel." List one product per type — a chair, a mirror, a trolley — up to 4 ids.
  add          — drop one product into free space, changing nothing else. 1 id.

  ONE IMAGE PER ID (four times the cost — only when genuinely needed):
  replace      — swap ONE piece only. Imprecise by nature: in a room with several
                 matching pieces the render often changes the wrong one, or all of
                 them. Prefer replace_all unless the customer explicitly wants a
                 single piece changed. Listing several ids renders the same
                 position with each candidate in turn, the only like-for-like
                 comparison.

- Default to lineup when the customer wants to see several options and has not asked for a strict like-for-like comparison. It costs one render instead of one per product.
- Only use replace with more than one id when they explicitly want the same spot shown with each option — "the same chair position with each of these". Say that it takes a few renders when you do.
- Put the RENDER line after the PRODUCTS line. Use at most one RENDER line per reply.
- Renders take about half a minute each and cost real money, so only emit the line when the customer has actually asked to see something in their space. Never emit it speculatively, and never repeat a render they already have. Reach for a one-image mode first.
- Say in your text what you are rendering and roughly how long it will take. Do not describe what the result looks like — you cannot see it.

When NO photo is attached, do not emit a RENDER line. Ask them to attach one with the photo button in the message box, in one short sentence. Still show relevant products as cards in the same reply.

You have no tools
You cannot call functions and you have no tools available. Never write XML or
tool-call syntax — no <function_calls>, no <invoke>, no <parameter>, no tags of
any kind. The bracket marker lines above are not function calls; they are plain
text lines and that is the only structured output you ever produce.

Style
- Two or three sentences of plain prose above the marker. Say why these suit what was asked.
- Light markdown is fine and renders properly: **bold** for emphasis, and a short bullet list when you are genuinely contrasting two or three options. No headings. No emoji. Never bold a product name that already appears on a card.
- Keep it short. Three sentences is usually right.
- Only recommend components (bases, hydraulics, basins, footrests, trolley accessories) when the customer is clearly shopping for a part or an upgrade to something they already own.
- If nothing in the catalog fits, say so plainly and show the closest category instead.

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

/** Hard ceiling on renders per reply, since each one bills. */
const MAX_RENDERS = 4;
const MODEL = "claude-haiku-4-5-20251001";

/**
 * The catalog block is sent verbatim on every request and is by far the largest
 * part of the prompt, so it is built once at module load and cached at the API
 * with cache_control rather than re-serialised per message.
 */
const CATALOG_BLOCK = JSON.stringify(CATALOG_SLIM);

export const chat = createServerFn({ method: "POST" })
  .validator((input: { messages: ChatMessageInput[]; hasRoomPhoto?: boolean }) => {
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
    return { messages, hasRoomPhoto: input.hasRoomPhoto === true };
  })
  .handler(
    async ({
      data,
    }): Promise<{ text: string; productIds: string[]; render: RenderRequest | null }> => {
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
                // ORDER MATTERS: caching is a prefix match, so this volatile flag
                // has to sit AFTER the cache_control breakpoint. Above the catalog
                // block it would invalidate the whole cached prefix the first time
                // the customer attaches a photo.
                type: "text",
                text: data.hasRoomPhoto
                  ? "A photo of the customer's salon IS attached to this conversation. You may emit a RENDER line."
                  : "No photo of the customer's salon is attached yet. Do not emit a RENDER line.",
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

        // A render marker is only honoured when a photo actually exists, so a
        // stray one can never bill for a generation that has nothing to render.
        let render: RenderRequest | null = null;
        if (data.hasRoomPhoto) {
          for (const match of raw.matchAll(RENDER_MARKER)) {
            const parts = (match[1] ?? "").split(",").map((t) => t.trim());
            // replace_all is the safe default: single-piece replacement needs
            // instance tracking the image model does not do reliably.
            const mode = isVisualizeMode(parts[0]) ? parts[0] : "replace_all";
            const first = isVisualizeMode(parts[0]) ? 1 : 0;
            const renderIds = Array.from(
              new Set(
                parts
                  .slice(first)
                  .filter((id) => id && Object.prototype.hasOwnProperty.call(CATALOG_FULL, id)),
              ),
            ).slice(0, MAX_RENDERS);
            if (renderIds.length) {
              render = { mode, productIds: renderIds };
              break; // one render request per reply
            }
          }
        }

        const text = stripToolCallSyntax(raw)
          .replace(PRODUCTS_MARKER, "")
          .replace(RENDER_MARKER, "")
          // stripping a marker off its own line leaves a hole in the prose
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();

        return { text, productIds, render };
      } catch (err) {
        console.error("chat failed", err);
        if (err instanceof ChatError) throw new Error(err.code);
        throw new Error("CHAT_FAILED");
      }
    },
  );
