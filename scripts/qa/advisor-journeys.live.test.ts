import { test, expect, vi } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get() {
        throw new Error("QA production DB access forbidden");
      },
    },
  ),
}));
vi.mock("@/lib/commerce-pdf.server", () => ({
  buildCommercePdf: async () => new Uint8Array([37, 80, 68, 70]),
}));
vi.mock("@/lib/wa-render-jobs.server", () => ({
  getActiveRenderState: async () => ({
    count: 0,
    pending: 0,
    generating: 0,
    oldestCreatedAt: null,
  }),
  enqueueRenderJob: async () => {
    throw new Error("QA generation forbidden");
  },
}));
import { handleConversation, type ConversationServices } from "@/lib/wa-conversation.server";
import { EMPTY_SESSION, sanitizeSession } from "@/lib/wa-session";
import { handleRequestInbound, type RequestStore } from "@/lib/wa-requests.server";
import { handleDocumentInbound } from "@/lib/wa-documents.server";
import { handleInboundMessage, prepareAdvisorRender, type InboundEvent } from "@/lib/wa-runtime";
import { CATALOG_FULL } from "@/lib/catalog";
import type { RequestRecord } from "@/lib/wa-requests";
import type { Database } from "@/integrations/supabase/types";
import { scriptedAdvisor } from "./scripted-advisor";

// ADVISOR_SCRIPTED_MODEL=true drives every journey with scripts/qa/scripted-advisor.ts
// instead of the provider: no API spend, and the key is deliberately invalid so an
// accidental real call fails the journey instead of billing anyone.
const SCRIPTED = process.env["ADVISOR_SCRIPTED_MODEL"] === "true";

test.skipIf(process.env["RUN_ADVISOR_JOURNEYS"] !== "true")(
  "100 parameterized multi-turn journeys with real model and isolated action stores",
  async () => {
    const env = parseEnv(readFileSync(".env", "utf8"));
    process.env["ANTHROPIC_API_KEY"] = SCRIPTED
      ? "scripted-run-no-provider-calls"
      : process.env["ANTHROPIC_API_KEY"] || env["ANTHROPIC_API_KEY"];
    process.env["WHATSAPP_PHONE_ENC_KEY"] = "synthetic-qa-only";
    const limit = Number(process.env["ADVISOR_JOURNEY_COUNT"] || 100);
    const results: {
      id: number;
      family: string;
      passed: boolean;
      error?: string;
      turns: unknown[];
      milliseconds: number;
    }[] = [];
    const families = ["planning", "shopping", "support", "comparison", "render-confirmation"];
    let cursor = 0;
    async function journey(i: number) {
      const family = families[i % families.length]!;
      const start = Date.now();
      const trace: unknown[] = [];
      let session = structuredClone(EMPTY_SESSION);
      type Row = Database["public"]["Tables"]["wa_requests"]["Row"];
      const rows: Row[] = [];
      const db: RequestStore = {
        latest: async () => rows.at(-1) ?? null,
        replay: async (_s, id) => rows.find((r) => r.last_inbound_id === id) ?? null,
        create: async (r) => {
          rows.push({
            status: "draft",
            stage: "details",
            details: [],
            last_inbound_id: null,
            last_reply: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...r,
          });
        },
        update: async (ref, _s, patch) => {
          const r = rows.find((r) => r.reference === ref);
          if (!r) throw new Error("Missing request");
          Object.assign(r, patch);
        },
      };
      const services: ConversationServices = {
        requestContext: async () => (rows.at(-1) as unknown as RequestRecord) ?? null,
        request: (input) => handleRequestInbound(input, db),
        document: handleDocumentInbound,
        runtime: handleInboundMessage,
        render: prepareAdvisorRender,
        ...(SCRIPTED ? { model: scriptedAdvisor } : {}),
      };
      let serial = 0;
      async function send(input: string | InboundEvent) {
        const event = typeof input === "string" ? { kind: "text" as const, text: input } : input;
        const out = await handleConversation(
          {
            sessionKey: `synthetic-journey-${i}`,
            phone: "15550000000",
            waMessageId: `synthetic-${i}-${++serial}`,
            event,
          },
          session,
          services,
        );
        session = sanitizeSession(out.session);
        const reply = out.turns
          .map((t) => ("text" in t ? t.text : "caption" in t ? t.caption : "[PDF]"))
          .join("\n");
        trace.push({
          input: event,
          reply,
          plan: session.plan,
          project: session.conversation,
          request: rows.at(-1)?.status,
          pendingRender: Boolean(session.pendingRender),
        });
        expect(reply).not.toMatch(
          /couldn’t complete that step|something went wrong|temporarily unavailable/i,
        );
        for (const t of out.turns)
          if (t.kind === "buttons") {
            expect(t.action.buttons.length).toBeLessThanOrEqual(3);
            expect(t.action.buttons.every((b) => b.title.length <= 20 && b.id.length <= 256)).toBe(
              true,
            );
          }
        return out;
      }
      try {
        const qty = 2 + (Math.floor(i / 5) % 5);
        if (family === "planning") {
          await send(
            `Please make an equipment-only salon plan for ${qty} stations with a budget of ${12000 + i * 100} USD.`,
          );
          expect(session.plan.ids.length).toBeGreaterThanOrEqual(5);
          const chair = session.plan.ids.find((id) => /chair/i.test(CATALOG_FULL[id]!.name));
          expect(chair).toBeTruthy();
          expect(session.plan.qty[chair!]).toBe(qty);
          const plan = structuredClone(session.plan);
          await send("Before we continue, what is your warranty policy?");
          expect(session.plan).toEqual(plan);
          await send(
            `Change ONLY the styling chair quantity to ${qty + 1}, keep the other items unchanged.`,
          );
          expect(session.plan.qty[chair!]).toBe(qty + 1);
          for (const id of plan.ids.filter((id) => id !== chair))
            expect(session.plan.qty[id]).toBe(plan.qty[id]);
        } else if (family === "shopping") {
          await send(`I want ${qty}`);
          expect(session.plan.ids).toEqual([]);
          await send(`Select ${qty} Chloe Tan styling chairs for my estimate.`);
          expect(session.plan.qty["330334"]).toBe(qty);
          await send(`Actually ${qty + 1} instead, same chair please.`);
          expect(session.plan.qty["330334"]).toBe(qty + 1);
          const quote = await send("Send the PDF estimate for my saved selection");
          expect(quote.turns.some((t) => t.kind === "document")).toBe(true);
        } else if (family === "support") {
          await send({ kind: "button", id: "request:support" });
          await send(
            `My Chloe Tan styling chair leaks oil from the pump. Order QA${1000 + i}. Please ask support to help.`,
          );
          const details = structuredClone(rows.at(-1)?.details);
          await send("Before that, what is the returns policy?");
          expect(rows.at(-1)?.details).toEqual(details);
          await send("menu");
          expect(rows.at(-1)?.status).toBe("draft");
          const resumed = await send("Continue my saved support request");
          expect(
            resumed.turns.some(
              (t) =>
                t.kind === "buttons" &&
                t.action.buttons.some((b) => b.id.startsWith("request:submit:")),
            ),
          ).toBe(true);
          expect(rows.at(-1)?.status).toBe("draft");
        } else if (family === "comparison") {
          await send(
            `Show me ${qty} salon mirrors for stations, explain which model you recommend and why. Budget is 500 USD per mirror.`,
          );
          expect(session.shownProductIds?.length).toBeGreaterThan(0);
          await send("Compare Chloe Tan and Blake Textured Black styling chairs in a PDF please.");
          expect(session.lastDocument?.kind).toBe("comparison");
          const plan = structuredClone(session.plan);
          await send(
            "Do either have a confirmed weight capacity? Don't guess if it isn't in your product specifications.",
          );
          expect(session.plan).toEqual(plan);
        } else {
          session.plan = { ids: ["330334"], qty: { "330334": qty } };
          session.room = { url: "https://example.com/synthetic-salon.jpg", at: Date.now() };
          await send("Show the chairs I selected in my salon photo");
          expect(session.pendingRender?.productIds).toEqual(["330334"]);
          const confirmation = session.pendingRender!.id;
          await send("Before that, what is the warranty?");
          expect(session.plan.qty["330334"]).toBe(qty);
          await send({ kind: "button", id: `render:dismiss:${confirmation}` });
          expect(session.pendingRender).toBeNull();
        }
        results.push({
          id: i,
          family,
          passed: true,
          turns: trace,
          milliseconds: Date.now() - start,
        });
      } catch (e) {
        results.push({
          id: i,
          family,
          passed: false,
          error: String(e),
          turns: trace,
          milliseconds: Date.now() - start,
        });
      }
      mkdirSync("outputs/advisor-qa-2026-09-16", { recursive: true });
      writeFileSync(
        `outputs/advisor-qa-2026-09-16/journeys${SCRIPTED ? "-scripted" : ""}.json`,
        JSON.stringify(
          results.sort((a, b) => a.id - b.id),
          null,
          2,
        ),
      );
      console.log("JOURNEY", i, family, results.find((r) => r.id === i)?.passed ? "PASS" : "FAIL");
    }
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        while (cursor < limit) {
          const i = cursor++;
          await journey(i);
        }
      }),
    );
    const failed = results.filter((r) => !r.passed);
    console.log(
      "SUMMARY",
      JSON.stringify({
        completed: results.length,
        passed: results.length - failed.length,
        failed: failed.map((r) => ({ id: r.id, family: r.family, error: r.error })),
      }),
    );
    expect(failed).toEqual([]);
  },
  1800000,
);
