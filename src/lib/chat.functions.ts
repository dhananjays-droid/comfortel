import { createServerFn } from "@tanstack/react-start";

import catalogFull from "@/data/catalog-full.json";
import catalogSlim from "@/data/catalog-slim.json";

export type ChatMessageInput = { role: "user" | "assistant"; content: string };

const SYSTEM_INSTRUCTIONS = `You are a friendly, knowledgeable shopping assistant for a home furnishing brand. You help customers find products from the catalog provided below.

Rules:
- Only ever recommend products that appear in the catalog. Never invent a product, a price, or an id.
- Recommend 2 to 4 products at a time. Never more than 4.
- When you recommend products, end your message with a line in exactly this format, on its own line, as the very last line:
  [PRODUCTS: id1, id2, id3]
  Use the exact id values from the catalog. If you are not recommending anything specific, omit this line entirely.
- Do not describe the products in list form in your text — the customer sees rich cards. Write 2-3 conversational sentences about why these suit what they asked for, then the marker line.
- Ask a clarifying question when the request is too vague to search on, e.g. no room, no style, no budget signal.
- Keep replies short. Three sentences is usually right.
- If nothing in the catalog fits, say so plainly and suggest the closest alternative category.`;

const PRODUCTS_LINE = /^\s*\[PRODUCTS:\s*([^\]]*)\]\s*$/im;

export const chat = createServerFn({ method: "POST" })
  .inputValidator((input: { messages: ChatMessageInput[] }) => {
    if (!input || !Array.isArray(input.messages)) throw new Error("messages required");
    return {
      messages: input.messages
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content })),
    };
  })
  .handler(async ({ data }): Promise<{ text: string; productIds: string[] }> => {
    try {
      const apiKey = process.env["ANTHROPIC_API_KEY"];
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: [
            { type: "text", text: SYSTEM_INSTRUCTIONS },
            {
              type: "text",
              text: JSON.stringify(catalogSlim),
              cache_control: { type: "ephemeral" },
            },
          ],
          messages: data.messages,
        }),
      });

      if (!res.ok) {
        console.error("Anthropic error", res.status, await res.text());
        throw new Error(`Assistant unavailable (${res.status})`);
      }

      const json = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };

      const raw = (json.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");

      // 1. parse the marker line, 2. strip it from the text
      const match = raw.match(PRODUCTS_LINE);
      const text = raw.replace(PRODUCTS_LINE, "").trim();

      let productIds: string[] = [];
      if (match?.[1]) {
        const catalog = catalogFull as unknown as Record<string, unknown>;
        productIds = match[1]
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
          // 3. hallucination guard: id must exist in the full catalog
          .filter((id) => Object.prototype.hasOwnProperty.call(catalog, id))
          // 4. cap at 4
          .slice(0, 4);
        productIds = Array.from(new Set(productIds));
      }

      return { text, productIds };
    } catch (err) {
      console.error("chat failed", err);
      throw new Error("CHAT_FAILED");
    }
  });
