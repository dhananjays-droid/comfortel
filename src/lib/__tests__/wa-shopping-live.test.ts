import { expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { handleShoppingInbound } from "@/lib/wa-shopping.server";
import { EMPTY_SESSION, sanitizeSession } from "@/lib/wa-session";

// Opt-in, synthetic conversations only. No WhatsApp sends, customer DB writes
// or image generation. PDF transport is mocked; ordinary PDF tests cover it.
vi.mock("@/lib/commerce-pdf.server", () => ({
  buildCommercePdf: async () => new Uint8Array([37, 80, 68, 70]),
}));
it.skipIf(process.env["RUN_SHOPPING_LIVE"] !== "true")(
  "live synthetic shopping journey",
  async () => {
    const env = loadEnv("development", process.cwd(), "");
    process.env["ANTHROPIC_API_KEY"] ||= env["ANTHROPIC_API_KEY"];
    let s = structuredClone(EMPTY_SESSION);
    async function turn(message: string) {
      const start = Date.now();
      const turns = await handleShoppingInbound(
        s,
        { kind: "text", text: message },
        `synthetic-${start}`,
      );
      const reply =
        turns?.map((t) => ("text" in t ? t.text : "caption" in t ? t.caption : "")).join("\n") ??
        "DELEGATED";
      console.log(
        JSON.stringify({
          customer: message,
          reply,
          milliseconds: Date.now() - start,
          plan: s.plan,
          preferences: s.shoppingMemory,
        }),
      );
      s.transcript.push({ role: "user", content: message }, { role: "assistant", content: reply });
      s = sanitizeSession(s);
      return turns;
    }
    await turn("I want five");
    expect(s.plan.ids).toEqual([]);
    expect(s.shoppingMemory?.quantity).toBe(5);
    await turn("Chloe Tan styling chairs please");
    // Depending on confidence the assistant may show before selecting; the next
    // explicit instruction removes that ambiguity without supplying an ID.
    await turn("Yes, select five Chloe Tan styling chairs for my estimate");
    expect(s.plan.qty["330334"]).toBe(5);
    await turn("Before that, what is the warranty?");
    expect(s.plan.qty["330334"]).toBe(5);
    await turn("Actually make that three, not five");
    expect(s.plan.qty["330334"]).toBe(3);
    const pdf = await turn("Send me the PDF estimate for those please");
    expect(pdf?.[0]?.kind).toBe("document");
    expect(s.lastDocument?.qty["330334"]).toBe(3);
    expect(await turn("Now generate an image of them in my salon photo")).toBeNull();
  },
  180000,
);
