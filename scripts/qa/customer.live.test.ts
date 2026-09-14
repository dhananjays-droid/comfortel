import { test, vi, expect } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { journeys } from "./questions";

const m = vi.hoisted(() => ({ jobs: [] as unknown[], claims: new Set<string>() }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: new Proxy(
    {},
    {
      get() {
        throw new Error("QA: production DB access forbidden");
      },
    },
  ),
}));
vi.mock("@/lib/wa-client.server", () => ({ sendText: async () => "qa-no-delivery" }));
vi.mock("@/lib/wa-rate-limit.server", () => ({ tooManyRenderRequests: async () => false }));
vi.mock("@/lib/wa-render-guards.server", () => ({
  claimRenderAction: async (id: string) => {
    if (m.claims.has(id)) return false;
    m.claims.add(id);
    return true;
  },
}));
vi.mock("@/lib/wa-render-jobs.server", () => ({
  getActiveRenderState: async () => ({
    count: 0,
    pending: 0,
    generating: 0,
    oldestCreatedAt: null,
  }),
  enqueueRenderJob: async (...args: unknown[]) => {
    m.jobs.push(args);
    return true;
  },
  cancelActiveRenderJobs: async () => 0,
}));
vi.mock("@/lib/enquiry.functions", () => ({
  parseEnquiryInput: (x: unknown) => x,
  runSubmitEnquiry: async () => {
    throw new Error("QA: real enquiry forbidden");
  },
}));

import { handleInboundMessage, type WaTurn } from "@/lib/wa-runtime";
import { EMPTY_SESSION, sanitizeSession } from "@/lib/wa-session";
import { handleDocumentInbound } from "@/lib/wa-documents.server";
import { handleRequestInbound, type RequestStore } from "@/lib/wa-requests.server";

test.skipIf(process.env.COMFORTEL_LIVE_QA !== "yes")(
  "100 customer questions using real model and isolated stores",
  async () => {
    const env = parseEnv(readFileSync(".env", "utf8"));
    process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
    process.env.WHATSAPP_PHONE_ENC_KEY = "qa-only-not-a-customer";
    const originalFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      if (
        !["api.anthropic.com", "comfortelfurniture.com"].includes(url.hostname) &&
        !url.hostname.endsWith(".supabase.co")
      )
        throw new Error(`QA blocked external host ${url.hostname}`);
      if (
        url.hostname.endsWith(".supabase.co") &&
        !url.pathname.startsWith("/storage/v1/object/public/")
      )
        throw new Error("QA blocked database request");
      const started = Date.now();
      const response = await originalFetch(input, { ...init, signal: AbortSignal.timeout(60000) });
      if (url.hostname === "api.anthropic.com") {
        const body = await response.clone().json();
        calls.push({
          status: response.status,
          ms: Date.now() - started,
          usage: body.usage,
          error: body.error?.type,
          detail: body.error?.message,
        });
      }
      return response;
    };
    const targeted = process.env.COMFORTEL_QA_TARGETED === "yes";
    const out = targeted ? "outputs/qa-2026-09-14-final-documents" : "outputs/qa-2026-09-14-after";
    mkdirSync(out, { recursive: true });
    const results: unknown[] = [];
    let serial = 0;
    for (const [journey, ...questions] of journeys) {
      if (targeted && !["quotes", "comparison"].includes(journey)) {
        serial += questions.length;
        continue;
      }
      let session = structuredClone(EMPTY_SESSION);
      const rows: any[] = [];
      const store: RequestStore = {
        latest: async () => rows.at(-1) ?? null,
        replay: async (_s, id) => rows.find((r) => r.last_inbound_id === id) ?? null,
        create: async (r) => {
          rows.push({ status: "draft", stage: "details", details: [], ...r });
        },
        update: async (ref, _s, patch) => {
          Object.assign(
            rows.find((r) => r.reference === ref),
            patch,
          );
        },
      };
      for (const question of questions) {
        const id = `Q${String(++serial).padStart(3, "0")}`;
        const event = { kind: "text" as const, text: question };
        const start = Date.now();
        let turns: WaTurn[] = [];
        let route = "runtime";
        let error: string | undefined;
        try {
          const docs = await handleDocumentInbound(session, event, id);
          const requests =
            docs ??
            (await handleRequestInbound(
              {
                sessionKey: `qa:${journey}`,
                phone: "15550000000",
                waMessageId: id,
                event,
                salesIntakeActive: Boolean(
                  session.flow.awaiting || session.pendingQuote || session.rolePicker,
                ),
              },
              store,
            ));
          if (requests) {
            turns = requests;
            session.transcript = [
              ...session.transcript,
              { role: "user", content: question },
              {
                role: "assistant",
                content: turns
                  .map((turn) =>
                    "text" in turn ? turn.text : "caption" in turn ? turn.caption : "",
                  )
                  .join("\n"),
              },
            ].slice(-24);
            route = docs ? "document" : "request/FAQ";
          } else {
            const result = await handleInboundMessage(
              { ...session, handoff: false },
              `qa:${journey}`,
              "15550000000",
              event,
            );
            session = result.session;
            turns = result.turns;
          }
          session = sanitizeSession(JSON.parse(JSON.stringify(session)));
        } catch (e) {
          error = String(e);
        }
        for (const turn of turns)
          if (turn.kind === "document") writeFileSync(`${out}/${id}-${turn.filename}`, turn.bytes);
        results.push({
          id,
          journey,
          question,
          route,
          ms: Date.now() - start,
          error,
          turns: turns.map((t) =>
            t.kind === "document" ? { ...t, bytes: `${t.bytes.length} bytes` } : t,
          ),
          state: {
            plan: session.plan,
            pendingRender: session.pendingRender,
            request: rows.at(-1)
              ? {
                  category: rows.at(-1).category,
                  status: rows.at(-1).status,
                  details: rows.at(-1).details,
                }
              : null,
            transcript: session.transcript,
          },
        });
        writeFileSync(
          `${out}/questions.json`,
          JSON.stringify(
            {
              baselineCommit: "fc8efda",
              testedWorkingTree: true,
              results,
              calls,
              queuedJobs: m.jobs,
            },
            null,
            2,
          ),
        );
        console.log(
          `${id} ${journey}: ${route}, ${Date.now() - start}ms, ${turns.length} replies${error ? " ERROR" : ""}`,
        );
        if (
          calls.some(
            (c: any) =>
              c.status === 401 ||
              c.status === 403 ||
              (c.status === 400 && /credit|balance/i.test(c.detail ?? "")),
          )
        )
          throw new Error(
            "Provider authentication/billing blocked. Stopping to avoid repeated requests.",
          );
      }
    }
    globalThis.fetch = originalFetch;
    expect(results).toHaveLength(targeted ? 10 : 100);
    expect(results.filter((result) => result.error)).toEqual([]);
    // A sandbox/network failure may produce valid fallback messages. It must
    // never be mistaken for successful live-model coverage.
    expect(calls.length).toBeGreaterThan(0);
    expect(m.jobs).toHaveLength(0);
  },
  1_800_000,
);
