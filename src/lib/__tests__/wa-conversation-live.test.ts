import { expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { handleConversation, type ConversationServices } from "@/lib/wa-conversation.server";
import { EMPTY_SESSION, sanitizeSession } from "@/lib/wa-session";
import { handleRequestInbound, requestOverview } from "@/lib/wa-requests.server";
import { memoryRequestStore } from "./helpers/request-store";
import { handleDocumentInbound } from "@/lib/wa-documents.server";
import type { RequestRecord } from "@/lib/wa-requests";
import { callShoppingModel } from "@/lib/wa-shopping.server";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get() {
        throw new Error("Synthetic QA cannot access production DB");
      },
    },
  ),
}));
vi.mock("@/lib/commerce-pdf.server", () => ({
  buildCommercePdf: async () => new Uint8Array([37, 80, 68, 70]),
}));

it.skipIf(process.env["RUN_ADVISOR_LIVE"] !== "true")(
  "live multi-turn advisor journeys, isolated state and no delivery/generation",
  async () => {
    const env = loadEnv("development", process.cwd(), "");
    process.env["ANTHROPIC_API_KEY"] ||= env["ANTHROPIC_API_KEY"];
    process.env["WHATSAPP_PHONE_ENC_KEY"] = "synthetic-only";
    const db = memoryRequestStore();
    const rows = db.rows;
    const services: ConversationServices = {
      model: async (messages, context) => {
        const blocks = await callShoppingModel(messages, context);
        console.log("synthetic-decision", JSON.stringify(blocks));
        return blocks;
      },
      requestContext: async () => (rows.at(-1) as unknown as RequestRecord) ?? null,
      overview: (key) => requestOverview(key, db),
      request: (input) => handleRequestInbound(input, db),
      document: handleDocumentInbound,
      runtime: async (s) => ({ session: s, turns: [{ kind: "text", text: "Main menu" }] }),
      render: async (s) => ({
        session: s,
        turns: [
          { kind: "text", text: "Image proposal awaiting your confirmation. Nothing generated." },
        ],
      }),
    };
    let session = structuredClone(EMPTY_SESSION);
    let serial = 0;
    const turn = async (text: string) => {
      const start = Date.now();
      const out = await handleConversation(
        {
          sessionKey: "synthetic-advisor",
          phone: "15550000000",
          waMessageId: `synthetic-${++serial}`,
          event: { kind: "text", text },
        },
        session,
        services,
      );
      session = sanitizeSession(out.session);
      const reply = out.turns
        .map((t) => ("text" in t ? t.text : "caption" in t ? t.caption : "[document]"))
        .join("\n");
      console.log(
        JSON.stringify({
          customer: text,
          reply,
          plan: session.plan,
          project: session.conversation,
          request: rows.at(-1)?.status,
          milliseconds: Date.now() - start,
        }),
      );
      expect(reply).not.toMatch(
        /couldn’t complete that step|something went wrong|Which products should the PDF include/,
      );
      return out;
    };
    await turn(
      "I have a budget of 20k$ and need build a salon of 3 stations. Suggest me plan with equipments",
    );
    expect(session.conversation).toMatchObject({ stations: 3, budget: 20000 });
    await turn("USD, for furniture and equipment only. Please suggest a complete plan.");
    expect(session.plan.ids.length).toBeGreaterThan(2);
    expect(session.conversation).toMatchObject({ currency: "USD", budgetScope: "equipment" });
    const before = structuredClone(session.plan);
    await turn("Before that what is the warranty?");
    expect(session.plan).toEqual(before);
    await turn("Actually make the styling chairs four, keep all other quantities unchanged");
    expect(Object.values(session.plan.qty)).toContain(4);
    const pdf = await turn("Send me the PDF estimate for this selection");
    expect(pdf.turns[0]?.kind).toBe("document");
    await turn("Show them in my salon photo");
    expect(session.plan.ids).toEqual(before.ids);

    session = structuredClone(EMPTY_SESSION);
    rows.splice(0);
    await turn(
      "I want to buy mirror. can you suggest me which mirrors i must use for 3 stations and why?",
    );
    expect(session.shownProductIds?.length).toBeGreaterThan(0);
    await turn("I want our team to call me about a showroom visit");
    expect(rows.at(-1)?.status).toBe("draft");
    const details = structuredClone(rows.at(-1)?.details);
    await turn("Before that can you explain the returns policy?");
    expect(rows.at(-1)?.details).toEqual(details);
    await turn("Menu");
    expect(rows.at(-1)?.status).toBe("draft");
    await turn("Continue my showroom visit request");
    await turn(
      "I am in New York and would like a call Friday afternoon Eastern time about 3 styling chairs",
    );
    expect(rows.at(-1)?.stage).toBe("confirm");
    expect(rows.at(-1)?.status).toBe("draft");
  },
  300000,
);
