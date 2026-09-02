# Comfortel on WhatsApp — Implementation Plan

## Context

Comfortel's web chatbot (salon/barber/spa furniture product discovery — chat, product
cards, room renders, quote requests) should become reachable as a real WhatsApp
Business number, so a customer can do the entire flow inside WhatsApp instead of
the browser. A detailed spec (`whatsapp-integration-spec.md`) already lays out the
intended design: reuse every existing server function untouched
(`chat.functions.ts`, `curate.functions.ts`, `visualize.functions.ts`, `kie.server.ts`,
`render-qa.functions.ts`, `enquiry.functions.ts`), port the client-side state machine in
`src/routes/index.tsx` to a server-side session-keyed runtime, and add a webhook +
outbound client + async render worker as the only genuinely new infrastructure.

This plan was produced by verifying that spec against the actual repo (three parallel
explorations covering the UI state machine, the server function layer, and the platform
conventions) rather than trusting it blindly. The good news: the repo is *more* ready
for this than the spec assumed — we're already on branch `feat/whatsappMigration`,
sitting at the exact base commit (`c044409`) the spec targets, and `main` is at the same
commit. The spec's picture of `wa-flow.ts`/`whatsapp.ts`/the server functions is
accurate in substance, with a handful of naming/location corrections (below). But **one
architectural assumption in the spec is wrong for this repo**: there is no raw API-route
convention (`createServerFileRoute`/`createAPIFileRoute` don't exist in the installed
`@tanstack/react-start@1.168.32`), and there's no existing Supabase Storage usage to
"reuse." Both need a genuinely new approach, corrected below. Decisions locked in:
render-job polling runs on **Vercel Cron** (not an always-on loop or Lovable's scheduled-
function scaffold), the plan covers **full Meta/WABA setup from scratch**, and **all
five phases** (including App Review and abuse rate-limiting) are planned in equal depth
rather than deferring Phase 5.

Outcome of this work: a customer messages the Comfortel WhatsApp number, gets the same
greeting-with-three-buttons the web app opens with, can plan a salon in free text, ask
questions, get product cards, and get a room render delivered back as a WhatsApp image
— all driven by the same AI/catalogue/pricing/render logic the web app already uses,
called from a new channel adapter instead of the browser.

---

## Corrections to the spec (verified against the repo, not assumed)

| Spec said | Actually | Where |
|---|---|---|
| Webhook lives at a route like the existing `api/**` convention | **No such convention exists.** `@tanstack/react-start@1.168.32` has no `./api` export, no `createServerFileRoute`/`createAPIFileRoute` anywhere in `node_modules`. All server logic today is `createServerFn` RPCs, not raw HTTP routes. The only real request entry is `src/server.ts`'s exported `fetch(request, env, ctx)` (wired via `vite.config.ts`'s `tanstackStart.server.entry: "server"`). | `src/server.ts`, `vite.config.ts` |
| Render worker is "an always-on loop (or short-interval Supabase Edge Function/cron)" | No `supabase/functions/` exists, and the app deploys to Vercel — no long-running process to host a loop. Decision: use **Vercel Cron** instead. There's also an unused, auto-generated `authenticateCronRequest` scaffold (`src/integrations/supabase/cron-auth.ts`) hinting at a Lovable-cron path, but it has zero call sites and we're using Vercel Cron, so it stays unused. | `src/integrations/supabase/cron-auth.ts` (ignore), `vercel.json` (new) |
| "Reuse the existing Storage bucket" (implied by media bridge design) | **No Supabase Storage bucket exists anywhere in this codebase.** Every image URL today is a third-party kie.ai/redpandaai URL string stored in Postgres; nothing is ever uploaded to Supabase Storage. A bucket must be created as new infrastructure. | grep confirmed zero `supabase.storage` call sites |
| `curate(...)` | Function is exported as **`curatePackages`** from `curate.functions.ts` (there's also a separate `curate.ts` helper module `curate.functions.ts` imports from — different file, same base name). | `src/lib/curate.functions.ts`, `src/lib/curate.ts` |
| `wantsZoneSplit` lives in `wa-flow.ts` | Lives in **`src/lib/render-intent.ts:134`**, imported into `index.tsx` from there, not from `wa-flow.ts`. | `src/lib/render-intent.ts` |
| `describeIntake()` in `brief.ts` | **Doesn't exist.** `brief.ts` exports `readBrief`, `readIntake`, `readWall`, `readRoomPair` only. Port the porting-table row using those names. | `src/lib/brief.ts` |
| One-retry-on-fault lives inside `inspectRender()` (`render-qa.functions.ts`) | The retry decision (`shouldRetry`, `correctionFor`, `MAX_RETRIES = 1`) is a **separate pure module**, `src/lib/render-qa.ts`, orchestrated today by `index.tsx`'s `finish()` callback — `inspectRender()` itself just returns a verdict. `wa-render-worker.ts` needs to import from *both* files. | `src/lib/render-qa.ts` vs `src/lib/render-qa.functions.ts` |
| `MAX_QTY` in `chat.functions.ts` | `MAX_QTY = 20` lives in **`visualize.functions.ts`** (caps render quantities; already enforced there — no need to duplicate). Chat's own plan-quantity clamp is inline (`Math.min(99, Math.max(1, ...))`, `chat.functions.ts`), no named constant. `wa-session.ts`'s `sanitizePlan` should clamp `1..99` to match `chat.functions.ts`, not `1..20`. | `src/lib/chat.functions.ts:209`, `src/lib/visualize.functions.ts:60` |
| `toWaItems()` is a reusable WA-message-shaping helper in `whatsapp.ts`/`wa-flow.ts` | It's defined in **`src/routes/index.tsx:301`** and shapes messages into `WaItem` for the **React preview UI** (`WhatsAppView.tsx`), not into Graph API payloads. `wa-runtime.ts` needs its own, new outbound-composition logic that calls `wa-client.server.ts`'s `sendText`/`sendButtons`/etc. — same *idea* as `toWaItems`, but new code, since the target shape is different. | `src/routes/index.tsx:301`, `src/components/WhatsAppView.tsx` |
| SYSTEM_INSTRUCTIONS has an obvious insertion point before "What the catalog is" | Confirmed true, but there's no existing blank paragraph there — insert the new compliance paragraph between the one-sentence brand framing and the `What the catalog is` header. | `src/lib/chat.functions.ts:46-48` |

Everything else in the spec — the porting table's behavior descriptions, the session
schema, the compliance/scope-guard design, the cost model, the WABA setup steps —
checked out against the code and is sound. Build on it as written except where this
table overrides it.

---

## 1. Architecture (corrected)

```
Customer's phone
      │ WhatsApp
      ▼
Meta Cloud API ──webhook (POST)──▶ src/server.ts fetch()  (intercepts path,
      ▲                                    │                 NEW — no route-file
      │ Graph API sends                    ▼                 convention exists)
      │                          src/lib/wa-webhook.server.ts  (NEW — verify + ack)
      │                                    │
      │                                    ▼
      │                             wa-runtime.ts             (NEW — conversation
      │                                    │                    engine, server port
      │                                    ▼                    of index.tsx)
      │                             sessions table (NEW, Postgres via supabaseAdmin)
      │                     ┌──────────────┼───────────────────┐
      │                     ▼              ▼                   ▼
      │              wa-flow.ts      chat.functions.ts   curate.functions.ts
      │            (existing, as-is)  (existing, as-is)   (curatePackages, as-is)
      │                     ▼              ▼                   ▼
      │          render request      Anthropic API        Anthropic API
      │                │            (Claude Haiku)        (Claude Sonnet)
      │                ▼
      │      wa_render_jobs table (NEW)
      │                │
      │   Vercel Cron ──▶ src/server.ts fetch() intercept ──▶ wa-render-worker.server.ts (NEW)
      │                │        (GET /api/cron/wa-render-worker, bearer-checked)
      │                ▼
      │      visualize.functions.ts + kie.server.ts   (existing, as-is)
      │                │
      │             kie.ai (GPT Image 2)
      │                │
      │      render-qa.functions.ts + render-qa.ts retry helpers (existing, as-is)
      │                │
      └────────── media bridge (NEW) — re-host to a new Supabase Storage bucket
                       │
              wa-client.server.ts (NEW) ──▶ Meta Cloud API
```

Two properties of the current codebase make this an adapter, not a rewrite (confirmed):
`wa-flow.ts`'s `WaAction`/`MENU_BUTTONS`/`whatsapp.ts`'s `WA` limits are already correct
for the real Cloud API (3 buttons, 10 list rows, 20-char labels) — the in-app "WhatsApp
Mode" preview (`WHATSAPP_MODE_ENABLED`, currently hardcoded `false`) proves the shape
already works, it's just rendered as chat bubbles today instead of real messages. And the
catalogue never reaches the model beyond the slim index — every product id is validated
against `CATALOG_FULL` server-side already, channel-blind.

---

## 2. Porting table (index.tsx → wa-runtime.ts)

Port function-by-function, reading `src/routes/index.tsx` on the current branch as the
source of truth for edge cases (not this document). Exact current signatures/locations:

| Client (`index.tsx`) | Server equivalent (`wa-runtime.ts`) | What changes |
|---|---|---|
| `advance(flow, text)` — imported from `wa-flow.ts`, called at line 1295 | same call, unchanged | Pure, channel-agnostic already. |
| `sendTurn(raw, tapped)` (lines 1280-1381) | `handleInboundMessage(session, message)` | Same dispatch order (package-tap shortcut → `advance()` → `flow.awaiting` handling ("build"/"visualize") → `wantsZoneSplit(text)` **from `render-intent.ts`** → fallback to chat), reads/writes a `sessions` DB row instead of `useState`. |
| `offerPackages(text)` (lines 917-980) | `offerPackages(session, text)` | `readIntake` → local `buildPackages` fallback → `curatePackages()` best-effort (correct function name) → persist `offered` to the session row instead of `useState`, since the next message may arrive minutes later against a cold request. |
| `acceptPackage(result)` (lines 1219-1265) | `acceptPackage(session, result)` | Sets `session.plan` instead of `setPlanIds`/`setPlanQty`. |
| `acceptOffer(offer)` (lines 990-999) | `acceptOffer(session, offer)` | Same `photo \|\| staged` guard, reads `session.room` instead of `roomPhotoRef.current`. |
| `startRender(products, mode, photo, quantities)` (lines 1030-1073) | `startRender(session, products, mode, quantities)` | Instead of `runRender()` polling `visualizeStatus()` from the browser every 3s, **enqueues a row in `wa_render_jobs`** and returns immediately — the webhook must ack Meta in seconds. Vercel Cron ticks drive the polling (§6). |
| `renderPlanByZone()` / `renderPlanStaged()` (lines 1140-1178, 1206-1209) | same split | Identical logic; only delivery (enqueue vs. `useState`) differs. |
| `runChat(history, hasPhoto)` (lines 775-849) | `runChat(session, history, hasPhoto)` | Calls `chat.functions.ts`'s `chat()` exactly as today; last-12-message window, same offer/render gating via `wantsRender()` in `render-intent.ts`. The `offer` field becomes a WhatsApp button instead of a `<Button>`. |
| `roomSpecRef`/`roomPhotoRef` (lines 471, 549) | `session.room` (DB column) | New concept: 15-min TTL (`ROOM_TTL_MS`) — doesn't exist on `main` today, only ever existed on the abandoned `feat/whatsapp_shift` branch. Port the *idea*, write fresh code. |
| `messages` state (line 423) | `session.transcript` (DB column) | Same `ChatMessageInput[]` shape `chat.functions.ts` expects, same 12-message/4000-char truncation it already does — persisted instead of held in the tab. |

---

## 3. New files

**Status: all built.** Phases 1-4 (§14) are implemented and merged into this
tree — migration written (not yet applied to the live DB), full conversation
engine, media bridge, and render worker all wired end-to-end. What's left is
infrastructure the code can't do for itself: applying the migration, real
`WHATSAPP_*`/`CRON_SECRET`/`WHATSAPP_PHONE_ENC_KEY` credentials, and Phase 5
(App Review, production number).

```
src/lib/wa-webhook.server.ts        Signature verify, idempotency, dispatch to wa-runtime.ts
                                     (called from src/server.ts's fetch() intercept, NOT a route file)
src/lib/wa-runtime.ts               Ported conversation engine (§2)
src/lib/wa-session.ts               Session type + pure sanitizers (mirrors plan.ts's
                                     "rebuild, never trust the client" pattern)
src/lib/wa-session.server.ts        waSessionKey() — HMAC phone → session key
src/lib/wa-session-store.server.ts  loadSession / saveSession — plain async functions, NOT
                                     createServerFn (a client-callable RPC that trusts
                                     whatever sessionKey it's given would let anyone who
                                     learns/brute-forces a key read or overwrite a
                                     stranger's session; these are only ever called from
                                     other server-only code). Via supabaseAdmin, dynamically
                                     imported inside each function, matching
                                     src/integrations/supabase/client.server.ts's own convention.
src/lib/wa-client.server.ts         Outbound Graph API client (sendText, sendImage,
                                     sendButtons, sendList, sendTemplate)
src/lib/wa-render-jobs.server.ts    enqueueRenderJob() — inserts a wa_render_jobs row,
                                     called from wa-runtime.ts's startRenderTurn/
                                     renderPlanByZoneTurn.
src/lib/wa-render-worker.server.ts  Claims wa_render_jobs, drives visualize.functions.ts +
                                     render-qa.functions.ts/render-qa.ts, delivers via
                                     wa-client.server.ts. Invoked by Vercel Cron via
                                     src/server.ts's fetch() intercept.
src/lib/wa-media.server.ts          Inbound photo download (Meta Media API) + outbound
                                     durable re-host (new Supabase Storage bucket, 'wa-media')
src/lib/wa-phone-crypto.server.ts   encryptPhone/decryptPhone (AES-256-GCM) — NEW, not in the
                                     original spec; see §4's correction on wa_render_jobs.
src/lib/wa-rate-limit.server.ts     tooManyInboundMessages/tooManyRenderRequests (build-order
                                     item 14) — windowed counts against wa_messages/
                                     wa_render_jobs directly, no new table.
src/lib/wa-markdown.ts              Claude's **bold**/lists → WhatsApp's *bold*/_italic_
supabase/migrations/20260902000000_wa_platform.sql   sessions, wa_messages, wa_render_jobs,
                                     the 'wa-media' storage bucket
vercel.json                         Cron schedule for the render-worker tick
src/lib/__tests__/wa-session.test.ts
src/lib/__tests__/wa-runtime.test.ts
src/lib/__tests__/wa-markdown.test.ts
src/lib/__tests__/wa-phone-crypto.test.ts
src/lib/__tests__/wa-rate-limit.test.ts
src/lib/__tests__/wa-render-worker.test.ts   (auth-guard only — see §14/§15 on why the
                                     claim/start/poll/finish orchestration itself isn't
                                     unit-tested, matching visualize.functions.ts/
                                     kie.server.ts's own lack of coverage in this repo)
```

**Zero changes** to `chat.functions.ts` (except the one additive §7 paragraph),
`curate.functions.ts`, `curate.ts`, `visualize.functions.ts`, `kie.server.ts`,
`visualize-prompt.ts`, `render-qa.functions.ts`, `render-qa.ts`, `render-intent.ts`,
`packages.ts`, `brief.ts`, `plan.ts`, `catalog.ts`, `wa-flow.ts`, `whatsapp.ts`,
`resize-image.ts`, `enquiry.functions.ts`.

`src/server.ts` gets one small, additive change: before calling `getServerEntry()`,
check `request.url`'s pathname against the two new raw paths (webhook, cron tick) and
dispatch to the new handler modules; everything else falls through to the existing
TanStack handler unchanged. This is the single place a "route convention" gets invented
for this repo, since none exists — keep it minimal, mirroring the existing
try/catch-and-wrap style already in that file.

---

## 4. Session store

Migration (new file `supabase/migrations/<ts>_wa_platform.sql`), following the exact
`GRANT ALL ... TO service_role; ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` (no policy)
pattern already used by `enquiries` and `shared_designs`:

```sql
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  -- 'wa:' + HMAC-SHA256(WHATSAPP_SESSION_SECRET, digits-only phone number) — never
  -- store the phone number itself; a keyed HMAC because the space of real phone
  -- numbers is small enough to brute-force an unkeyed hash in minutes.
  session_key   text not null unique,
  channel       text not null default 'whatsapp',
  transcript    jsonb not null default '[]'::jsonb,   -- ChatMessageInput[]
  plan          jsonb not null default '{"ids":[],"qty":{}}'::jsonb,
  flow          jsonb not null default '{}'::jsonb,   -- FlowState from wa-flow.ts
  room_url      text,
  room_at       timestamptz,
  room_wall_cm  integer,
  room_depth_cm integer,
  offered       jsonb,                                 -- { packages, choice, at } | null
  handoff       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  expires_at    timestamptz not null default (now() + interval '30 days')
);
create index if not exists sessions_session_key_idx on public.sessions (session_key);
create index if not exists sessions_expires_at_idx on public.sessions (expires_at);
grant all on public.sessions to service_role;
alter table public.sessions enable row level security;

create table if not exists public.wa_messages (
  id uuid primary key default gen_random_uuid(),
  wa_message_id text not null unique,   -- Meta's message.id — dedupe key
  direction     text not null,          -- 'inbound' | 'outbound'
  session_key   text not null,
  kind          text not null,          -- 'text' | 'image' | 'interactive' | 'template'
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists wa_messages_wa_message_id_idx on public.wa_messages (wa_message_id);
create index if not exists wa_messages_session_key_idx on public.wa_messages (session_key, created_at desc);
grant all on public.wa_messages to service_role;
alter table public.wa_messages enable row level security;

create table if not exists public.wa_render_jobs (
  id uuid primary key default gen_random_uuid(),
  session_key   text not null,
  -- CORRECTION, not in the original spec: AES-256-GCM ciphertext of the
  -- customer's phone number, keyed by WHATSAPP_PHONE_ENC_KEY (a separate
  -- secret from WHATSAPP_SESSION_SECRET). wa-render-worker.server.ts runs on
  -- a LATER Vercel Cron tick with no access to the original webhook request,
  -- and session_key's HMAC is one-way by design — there is no other way to
  -- know where to deliver a render that finishes minutes after the request
  -- that asked for it. The one deliberate exception to "never store the
  -- phone number," scoped to this short-lived job row rather than the
  -- 30-day sessions table. See wa-phone-crypto.server.ts.
  customer_phone_enc text not null,
  status        text not null default 'pending',  -- pending | generating | done | failed
  mode          text not null,
  product_ids   text[] not null,
  quantities    jsonb not null default '{}'::jsonb,
  room_url      text,
  room_wall_cm  integer,
  room_depth_cm integer,
  scene         text,
  kie_task_id   text,
  attempt       integer not null default 0,        -- render-qa.ts's MAX_RETRIES = 1
  result_url    text,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists wa_render_jobs_status_idx on public.wa_render_jobs (status, created_at);
grant all on public.wa_render_jobs to service_role;
alter table public.wa_render_jobs enable row level security;

-- Storage: a room photo re-hosted durably enough for a later cron tick to
-- fetch it, and a finished render re-hosted durably enough to survive both
-- Meta's own fetch and the customer reopening the chat weeks later. Public,
-- like the kie.ai/redpandaai render URLs this app already treats as
-- shareable — object keys are random, nothing is enumerable without already
-- having the URL, same stance as shared_designs.share_code.
insert into storage.buckets (id, name, public)
values ('wa-media', 'wa-media', true)
on conflict (id) do nothing;
```

`src/lib/wa-session.server.ts`:

```ts
import { createHmac } from "node:crypto";

export function waSessionKey(phone: string): string {
  const secret = process.env["WHATSAPP_SESSION_SECRET"];
  if (!secret) throw new Error("WHATSAPP_SESSION_SECRET is not configured");
  const normalised = phone.replace(/\D/g, "");
  if (!normalised) throw new Error("phone required");
  return `wa:${createHmac("sha256", secret).update(normalised).digest("hex")}`;
}
```

`src/lib/wa-session.ts` — pure types + sanitizers, same "rebuild, never trust a stored
blob" pattern as `plan.ts`/`chat.functions.ts`'s own validators: re-validate product ids
against `CATALOG_FULL`, re-clamp plan quantities `1..99` (matching `chat.functions.ts`'s
inline clamp, not `visualize.functions.ts`'s `MAX_QTY=20` — that's a render-quantity cap
enforced separately by `visualizeStart` itself), re-trim transcript to the same
12-message/4000-char window `chat.functions.ts` uses.

```ts
export const ROOM_TTL_MS = 15 * 60 * 1000;
export const MAX_TRANSCRIPT = 24;
export const OFFER_TTL_MS = 30 * 60 * 1000;

export type SessionState = {
  transcript: ChatMessageInput[];
  plan: { ids: string[]; qty: Record<string, number> };
  flow: FlowState;                 // from wa-flow.ts — Await = "visualize" | "build" | "wall" | "photo"
  room: { url: string; at: number; wallCm?: number; depthCm?: number } | null;
  offered: { packages: Package[]; choice: {...}; at: number } | null;
  handoff: boolean;
};

export function liveRoom(room: SessionState["room"], now = Date.now()): SessionState["room"] {
  if (!room) return null;
  return now - room.at > ROOM_TTL_MS ? null : room;
}
```

`src/lib/wa-session.functions.ts` — `loadSession`/`saveSession`, each dynamically
importing `supabaseAdmin` from `src/integrations/supabase/client.server.ts` *inside* the
handler (matching that module's own documented convention — never a static top-level
import, since `.functions.ts` files ship to the client bundle otherwise). Wrap in
try/catch degrading to an empty in-memory session on failure — same resilience stance as
`visualizeStart`'s cache read/write: a session-store outage degrades the conversation to
stateless, it doesn't break it.

---

## 5. Webhook receiver (corrected: no route file — intercept in `src/server.ts`)

Since this TanStack Start version has no raw-route file convention, add the interception
directly in `src/server.ts`'s exported `fetch`, before `getServerEntry()` is called:

```ts
// src/server.ts, inside the existing fetch(request, env, ctx) handler, before
// `const handler = await getServerEntry();`
const url = new URL(request.url);
if (url.pathname === "/api/webhooks/whatsapp") {
  const { handleWhatsAppWebhook } = await import("./lib/wa-webhook.server");
  return handleWhatsAppWebhook(request);
}
if (url.pathname === "/api/cron/wa-render-worker") {
  const { handleRenderWorkerTick } = await import("./lib/wa-render-worker.server");
  return handleRenderWorkerTick(request);
}
```

`src/lib/wa-webhook.server.ts` — `handleWhatsAppWebhook(request: Request): Promise<Response>`:

1. **`GET`** — Meta's subscription handshake: read `hub.mode`, `hub.verify_token`,
   `hub.challenge` from the query string; if `hub.verify_token === process.env["WHATSAPP_VERIFY_TOKEN"]`,
   respond `200` with the raw `hub.challenge` string (not JSON); else `403`.
2. **`POST`**:
   - Read the **raw body** first (needed for signature verification before any JSON parsing).
   - Verify `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(raw body, `WHATSAPP_APP_SECRET`),
     timing-safe compare (`node:crypto`'s `timingSafeEqual`, same primitive already used
     by `cron-auth.ts`). Reject `401` on mismatch before touching the parsed body.
   - Respond `200` immediately after signature verification. Since Vercel serverless
     functions don't support true fire-and-forget background work reliably, do the
     actual handling **synchronously within the same request** but keep it fast: insert
     into `wa_messages` (idempotency-checked on `message.id`) and call
     `handleInboundMessage()` (§2) directly — no Claude/kie call in this path ever
     blocks more than one `chat()`/`curatePackages()` round trip, and renders are
     enqueued (not awaited) via `wa_render_jobs`. This differs from the spec's more
     abstract "waitUntil-style fire-and-forget" language, because Vercel's serverless
     runtime doesn't guarantee post-response execution the way a dedicated server would
     — doing the (already-fast) work inline before responding is simpler and correct here.
   - Parse `entry[].changes[].value.messages[]`. Per message: dedupe on `wa_messages.wa_message_id`
     (Meta redelivers), then dispatch by type — `text` → `body.text`; `interactive` with
     `button_reply`/`list_reply` → the tapped id (matches `sendTurn("", id)`'s shape
     today); `image` → media bridge (§7). Anything else gets one polite fallback reply.

---

## 6. Render job queue + worker (corrected: Vercel Cron, not an always-on loop)

`src/lib/wa-render-worker.server.ts` — `handleRenderWorkerTick(request: Request): Promise<Response>`,
invoked by Vercel Cron hitting `/api/cron/wa-render-worker`:

1. Authenticate the tick: Vercel Cron requests carry `Authorization: Bearer $CRON_SECRET`
   automatically when a `CRON_SECRET` env var is set — verify that header (timing-safe
   compare), reject `401` otherwise. (This replaces the spec's Lovable-flavored
   `authenticateCronRequest`/`LOVABLE_CRON_SECRET`, since we chose Vercel Cron and
   that scaffold has no call sites and isn't the mechanism in use here.)
2. Claim a small batch of `pending` rows: `update wa_render_jobs set status = 'generating' where id in (select id from wa_render_jobs where status = 'pending' order by created_at limit N for update skip locked) returning *` — avoids double-claiming without needing a persistent worker process.
3. For each claimed job with no `kie_task_id` yet: call `visualizeStart()` exactly as
   `index.tsx` calls it today (`productIds`, `mode`, `roomImageBase64` — fetched from
   `room_url` and base64-encoded if present, empty string for `staged_room`,
   `quantities`, `room` wall/depth, `scene`). Store the returned `taskId`.
4. For each `generating` job with a `kie_task_id`: call `visualizeStatus({ taskId })`
   once. If `done`, run `inspectRender()` (`render-qa.functions.ts`) plus the retry
   decision from `render-qa.ts` (`shouldRetry`, `correctionFor`, `MAX_RETRIES = 1`) —
   the same two-file split `index.tsx`'s `finish()` uses today. On a retriable fault,
   bump `attempt` and re-call `visualizeStart` with the correction text (fresh
   `kie_task_id`) rather than duplicating QA logic.
5. On final success: media bridge (§7) re-hosts the kie.ai URL to Supabase Storage, then
   `wa-client.server.ts` sends the image, then mark `done`.
6. On failure after the retry: mark `failed`, send "that render didn't come out right —
   want me to try again?" rather than nothing.
7. Respond `200` with a small summary (`{ claimed, done, failed }`) for Vercel Cron's log.

**Cadence — decided: Hobby plan, external pinger.** Vercel Cron's minimum interval is
once every 60 seconds, but *per-minute* schedules require Pro or higher — Hobby is
capped at once/day. The project is on Hobby for now (Pro is a later decision if it
turns out to be needed), so `vercel.json`'s own cron entry is set to a **once-daily
fallback safety net** (`"0 0 * * *"`, midnight UTC — the only thing Hobby allows) rather
than the real driver:

```json
{ "crons": [{ "path": "/api/cron/wa-render-worker", "schedule": "0 0 * * *" }] }
```

The actual near-real-time polling comes from an **external pinger** — a free service
(e.g. [cron-job.org](https://cron-job.org)) configured to hit
`https://<deployed-url>/api/cron/wa-render-worker` every 1-2 minutes with header
`Authorization: Bearer $CRON_SECRET`. The endpoint doesn't care who calls it, only that
the header matches — `handleRenderWorkerTick`'s own auth check is identical either way,
so nothing in the code changes based on which scheduler is used. If the project later
moves to Pro, the `vercel.json` schedule can simply change to `"* * * * *"` and the
external pinger becomes redundant (harmless to also switch off at that point).

---

## 7. Media bridge

`src/lib/wa-media.server.ts`:

- **Inbound:** Meta's media URLs expire in minutes. In the webhook handler (§5), for an
  `image` message: `GET /<media-id>` on the Graph API for a temporary download URL, then
  download the bytes **synchronously in that same request** — queuing the bare media id
  for later fetch is the one sequencing mistake that silently loses the photo.
- **Deviation, flagged rather than shipped silently: no server-side resize.**
  `resize-image.ts` (1024px longest edge, JPEG q0.85) is browser-only —
  FileReader/Image/canvas don't exist server-side, and adding a native image
  library (e.g. `sharp`) risked breaking whatever edge/serverless runtime this
  ends up deployed to (this repo's Nitro build defaults to a Cloudflare
  preset — see §1's corrections). Inbound photos are size-capped
  (`MAX_PHOTO_BYTES`, matching index.tsx's own 10MB client-side check) and
  re-hosted unresized instead. WhatsApp's own client already compresses
  photos before upload in practice, and `visualizeStart` still enforces its
  own `MAX_BASE64_CHARS` ceiling downstream regardless, so an oversized image
  is rejected there with a clear error rather than silently misbehaving — but
  the bandwidth/base64 savings resize-image.ts buys the web app aren't
  currently realized on this channel. Revisit if oversized photos turn out to
  be common in practice.
- **New infrastructure — a Supabase Storage bucket.** Created by the migration
  itself (`insert into storage.buckets ...`, §4) rather than a manual
  dashboard step — `wa-media`, public (see §4's comment on why public is the
  right call here), scoped to service-role write access.
- **Outbound:** kie.ai serves results from an expiring tempfile CDN (the web app gets
  away with this because the browser fetches immediately). Download the finished render
  and upload it to the `wa-media` bucket before sending through the outbound client, so
  the URL survives Meta's own fetch and the customer reopening the chat later.
- **Not yet implemented: discarding the room photo after use.** The original intent
  ("consistent with `shared_designs`' stance of never persisting the original room
  photo") isn't wired up — `rooms/*` objects in the bucket currently persist
  indefinitely once uploaded. Low storage cost at this scale, but a real gap
  against the stated privacy stance; a cheap follow-up is a scheduled cleanup
  (Vercel Cron, same mechanism as the render worker) deleting `rooms/*` objects
  older than `ROOM_TTL_MS`.

---

## 8. Compliance: the scope guard

Meta bans general-purpose AI chatbots on WhatsApp Business Platform (enforcement dates
shift — verify against Meta's current Business Help Center before launch, not against
this document). Task-specific business bots remain allowed with: an ancillary role,
stated business purpose, human escalation path, verified business number. Comfortel's
bot is already scoped by construction (`SYSTEM_INSTRUCTIONS` in `chat.functions.ts` is
salon/barber/spa-specific) — add an explicit refusal clause and a handoff trigger:

1. In `chat.functions.ts`, insert a short paragraph between the existing one-sentence
   brand framing and the `What the catalog is` header (currently lines 46-48, no blank
   paragraph there today): the assistant only discusses Comfortel products, salon fit-outs,
   and order/quote requests; anything else gets a one-line redirect plus an offer to talk
   to a person — never an attempt to answer out-of-scope questions.
2. In `wa-runtime.ts` (not `wa-flow.ts` — keep that file pure/untouched), recognize
   "talk to a person"/"agent"/"human" the same way `wa-flow.ts`'s `isGreeting()` matches
   greetings, and on match: set `session.handoff = true`, send a fixed acknowledgement,
   and stop auto-replying on that session until a human clears the flag. A manual
   `update sessions set handoff = false where session_key = ...` plus a Slack/email
   notification is a legitimate v1; an admin view is a fast-follow.
3. Small, additive change only — don't restructure `SYSTEM_INSTRUCTIONS` or `wa-flow.ts`'s
   menu logic to do this.

---

## 9. Outbound WhatsApp client

`src/lib/wa-client.server.ts` — thin wrapper over
`POST https://graph.facebook.com/v<version>/<phone-number-id>/messages`, isolating the
Graph API the way `kie.server.ts` isolates kie.ai:

```ts
sendText(to: string, body: string): Promise<string>
sendImage(to: string, imageUrl: string, caption?: string): Promise<string>
sendButtons(to: string, body: string, buttons: WaAction & { kind: "buttons" }): Promise<string>
sendList(to: string, body: string, action: WaAction & { kind: "list" }): Promise<string>
sendTemplate(to: string, name: string, params: string[]): Promise<string>
```

Every send is logged to `wa_messages` (`direction: 'outbound'`) for audit and the
24-hour-window check (§10). Text goes through `wa-markdown.ts` first (Claude's
`**bold**`/bullet lists → WhatsApp's `*bold*`/`_italic_`/plain dashes, headings stripped
— WhatsApp has no richer markdown than that).

---

## 10. Pricing and the 24-hour window

WhatsApp's free service window is being replaced by per-country billing for service and
utility messages from **October 1, 2026** — confirm the exact current rate against
Meta's Business Help Center at implementation time, not against a number written today.
Every reply inside 24h of the customer's last message is a free-form send (§9), now
billed per-conversation rather than free. Outside that window — a render that finishes
after the customer went quiet — requires a pre-approved message template
(`sendTemplate`). Get at least one generic template ("Your Comfortel render is ready —
reply to see it") approved during setup (§12) as the render-worker's fallback.

---

## 11. Cost model

| Item | Rate | Notes |
|---|---|---|
| Claude Haiku 4.5 (`chat.functions.ts`) | existing web-app rate | Same model/prompt cache. |
| Claude Sonnet 5 (`curatePackages`) | existing, unchanged | Once or twice a session. |
| kie.ai render, 1K | $0.03 (6 credits) | Single-product modes (`add`, `replace_all`, `replace`). |
| kie.ai render, 2K | $0.05 (10 credits) | Multi-reference modes (`lineup`, `refit_room`, `staged_room`). |
| Claude Haiku vision QA (`render-qa.functions.ts`) | existing, unchanged | One retry max, same as web. |
| WhatsApp conversation (service/utility) | per-country, billed from Oct 1 2026 | Confirm at implementation time. |
| WhatsApp template send (outside 24h) | per-country, higher | Render-worker fallback only. |
| Supabase Storage (new bucket) | new usage on existing plan | Every finished render + retained room photo until QA completes (§7). |
| Vercel Cron invocations | included on Pro+/usage-based on some tiers | Confirm plan tier per §6. |

`render-intent.ts`'s `wantsRender()` gating (already the single biggest cost control on
the web app) ports unchanged and is what keeps WhatsApp from reintroducing the "half of
an ordinary conversation about a photo gets billed" bug it was built to fix.

---

## 12. Meta / WABA setup (full, from scratch)

1. Meta Business Suite → Business Settings → create/confirm the Business Portfolio (88
   Ventures US, LLC).
2. developers.facebook.com → Create App → type **Business** → add the **WhatsApp** product.
3. WhatsApp → API Setup: note the **test phone number** and a **temporary token** for
   development. For production, create a **System User** under Business Settings with
   `whatsapp_business_messaging` + `whatsapp_business_management` permissions and
   generate a **permanent token** — this becomes `WHATSAPP_ACCESS_TOKEN`.
4. Add and verify the real business phone number (WhatsApp → API Setup → "Add phone
   number"), complete Meta's display-name review.
5. WhatsApp → Configuration → Webhook: callback URL = the deployed
   `/api/webhooks/whatsapp` path, verify token = `WHATSAPP_VERIFY_TOKEN`, subscribe to
   the `messages` field.
6. Note the App Secret (App Settings → Basic) → `WHATSAPP_APP_SECRET`, used for
   `X-Hub-Signature-256`.
7. Request **Advanced Access**/**App Review** for `whatsapp_business_messaging` before
   sending to real customers outside a small test-number allowlist.
8. Submit at least one **message template** for approval (§10), and check the current
   AI-chatbot policy conditions (§8) against the approved use-case description before
   submitting — a bot described as a general assistant is exactly what this design
   avoids being.

Verify every step above against `developers.facebook.com/docs/whatsapp/cloud-api` at
execution time — this is vendor-console detail that drifts.

---

## 13. Environment variables

| Name | Used by | Missing behavior |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | `wa-client.server.ts` | outbound sends fail |
| `WHATSAPP_PHONE_NUMBER_ID` | `wa-client.server.ts` | outbound sends have nowhere to send from |
| `WHATSAPP_APP_SECRET` | `wa-webhook.server.ts` | can't validate `X-Hub-Signature-256` — reject all inbound traffic |
| `WHATSAPP_VERIFY_TOKEN` | `wa-webhook.server.ts` | Meta's subscription handshake fails at setup |
| `WHATSAPP_SESSION_SECRET` | `wa-session.server.ts` | session keys can't be derived |
| `WHATSAPP_PHONE_ENC_KEY` | `wa-phone-crypto.server.ts` | **NEW, not in the original spec** — a render job can't be encrypted with a phone number to deliver to; `enqueueRenderJob` throws, no renders ever complete. Deliberately a separate secret from `WHATSAPP_SESSION_SECRET` (see §4's correction). |
| `CRON_SECRET` | `wa-render-worker.server.ts` (Vercel Cron's own convention) | can't authenticate cron ticks |
| `ANTHROPIC_API_KEY`, `KIE_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | already required | unchanged — new tables/bucket reuse them |

Match the existing style: direct `process.env["X"]` access at point of use (no central
`env.ts` in this repo), server-side only, never committed, never reach the client bundle.

---

## 14. Build order

**Phases 1-4 below are built** (code written, unit-tested, `tsc`/`eslint`/`vitest`/`npm run
build` all green). What's actually still outstanding in each is called out inline —
mainly: applying the migration to the live DB, and everything that needs real
`WHATSAPP_*`/`CRON_SECRET`/`WHATSAPP_PHONE_ENC_KEY` credentials and Meta's test number,
neither of which a coding session can do on its own.

**Phase 1 — data + session, no WhatsApp traffic yet**
1. ~~Write~~ **and run** the migration (§4) — written, **not yet applied** to the live
   Supabase project (no CLI/DB credentials available in-session; apply via the dashboard
   SQL editor or `supabase db push`).
2. `wa-session.ts`, `wa-session.server.ts`, `wa-session-store.server.ts` +
   `wa-session.test.ts` — done, 31 tests: mint a key, TTL expiry (`liveRoom`/`liveOffered`),
   sanitizers reject a hostile payload.

**Phase 2 — outbound + webhook skeleton**
3. `wa-client.server.ts` — done. **Not yet manually verified against Meta's test number**
   (§12 step 3) — needs real `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID`.
4. `src/server.ts` path interception + `wa-webhook.server.ts`: `GET` verify, `POST`
   signature check + `200` ack + `wa_messages` dedupe insert — done. **Not yet manually
   verified** against Meta's webhook test tool (needs a deployed URL + `WHATSAPP_APP_SECRET`/
   `WHATSAPP_VERIFY_TOKEN`).

**Phase 3 — the conversation engine**
5. `wa-runtime.ts` — done: greeting + 3-button menu, `build`/`visualize`/`ask` intake,
   free-text fallthrough to `chat.functions.ts`, package selection, zone-split renders,
   render-offer buttons. 13 tests in `wa-runtime.test.ts` drive the full scripted flow
   (greeting → menu tap → intake → package tap → render request) — two real bugs were
   caught and fixed while writing these (transcript ordering, a missing transcript append
   in the scripted-menu branch).
6. `wa-markdown.ts` + test — done, 8 tests. Verified against hand-written samples matching
   `SYSTEM_INSTRUCTIONS`'s own style guidance, **not yet against a real Claude transcript**
   (no live `ANTHROPIC_API_KEY` in the build environment) — re-check once the assistant is live.
7. Compliance scope guard (§8) — done: additive `SYSTEM_INSTRUCTIONS` paragraph +
   `wantsHandoff()` trigger in `wa-runtime.ts`, tested.

**Phase 4 — rendering**
8. `wa-media.server.ts` inbound path — done, **without the resize step** (§7's flagged
   deviation — no server-side image library; size-capped and re-hosted unresized instead).
   **Not yet manually verified** against a real photo from Meta's test number.
9. `wa_render_jobs` + `wa-render-worker.server.ts` + `vercel.json` cron — done: enqueues
   from `wa-runtime.ts`'s `startRenderTurn`/`renderPlanByZoneTurn`, claims on cron ticks,
   runs `inspectRender()` + `render-qa.ts`'s retry helpers with the same `MAX_RETRIES = 1`
   `index.tsx`'s `finish()` uses. **One real design gap found and fixed while building
   this**: the original spec never explained how a job running on a later, unrelated cron
   tick would know which phone number to deliver to, since `session_key`'s HMAC is
   one-way — fixed by encrypting the phone onto the job row alone (§4's correction,
   `wa-phone-crypto.server.ts`). Cron cadence and claim-locking still need the
   confirmations §6 already calls out (Vercel plan tier; the non-atomic claim is a
   deliberate, documented simplification, not an oversight).
10. `wa-media.server.ts` outbound path — done: the `wa-media` bucket is created by the
    migration itself, finished renders are re-hosted before sending.
11. **End-to-end against the test number — not yet run.** This needs the applied
    migration, all `WHATSAPP_*` credentials, `CRON_SECRET`, `WHATSAPP_PHONE_ENC_KEY`, and
    Meta's test number (§12) — none of which exist yet. This is the next real milestone:
    "Plan my salon" → free-text intake → package buttons → "see it in my space" → photo
    → rendered image back, for real.

**Phase 5 — production readiness**
12. **Blocked on §12 setup** — App Review/Advanced Access (§12 step 7), template
    approval (§12 step 8, §10). Can't start until the Meta app exists and a working
    test-number integration is demonstrable — Meta's review process requires showing
    the bot actually working.
13. **Blocked on §12/13** — load the real business number, re-run the Phase 4
    end-to-end test against it.
14. **Done.** Rate-limit/abuse guard: `wa-rate-limit.server.ts` — `tooManyInboundMessages()`
    (20 inbound messages / 60s per `session_key`, checked in `wa-webhook.server.ts`
    before any dispatch, over-limit messages dropped silently since replying also
    bills a conversation) and `tooManyRenderRequests()` (5 renders / 5 min per
    `session_key`, checked at the top of `wa-runtime.ts`'s `startRenderTurn` and
    `renderPlanByZoneTurn`, over-limit gets an explanation rather than silence — a
    real customer can legitimately hit this one). No new table: both windowed counts
    query `wa_messages`/`wa_render_jobs` directly, since they already log exactly
    what's needed (`session_key` + `created_at`) for audit purposes. Fails open on
    any DB error, same resilience stance as every other store in this channel —
    logged loudly either way. Thresholds are a starting point, explicitly not sized
    against real traffic yet (unknown at build time) — revisit once there's launch
    volume to look at. 2 tests verify the fail-open behavior (the actual
    over-threshold behavior needs a real database, same testing-boundary stance as
    `wa-render-worker.test.ts`).

---

## 15. Testing plan

- **Unit** (`vitest`, matching `src/lib/__tests__/*.test.ts` convention, e.g.
  `resolution.test.ts`'s style — plain `describe/it/expect`, direct `process.env[...]`
  mutation/restore in `afterEach`, no mocking framework): `wa-session.test.ts`,
  `wa-markdown.test.ts`, `wa-runtime.test.ts` driving `handleInboundMessage()` through a
  scripted transcript the way `wa-flow.test.ts` already does — greeting → menu tap →
  intake → package tap → render request — asserting on session state after each turn.
- **Signature/webhook**: a test posting a tampered body confirms `401`; a duplicate
  `message.id` confirms a no-op second time.
- **Manual, against Meta's test number**: every message type (text, buttons, list, image
  in, image out), the full guided-intake flow, a render with and without a photo
  (`staged_room`), an out-of-scope question (confirm the scope guard redirects), "talk
  to a person" (confirm handoff + silence).
- **Regression**: `npx vitest run` stays green throughout — nothing here touches
  `chat.functions.ts`'s core logic, `visualize.functions.ts`, `kie.server.ts`,
  `wa-flow.ts`, `render-intent.ts`, or `brief.ts` beyond the one additive scope-guard
  paragraph.
- Before pushing at any phase: `npx tsc --noEmit && npx eslint . && npm run build`
  (matches this repo's own documented pre-push check in `README.md`).

---

## 16. Explicit non-goals / open questions (carried from the spec, still open)

- **Not a BSP** — direct Meta Cloud API, per the original decision.
- **Multi-number/multi-tenant** is out of scope — one WABA, one phone number.
- **Admin view for `handoff`** — a manual DB toggle ships at launch; a proper internal
  tool is a fast-follow.
- **Exact Meta AI-chatbot policy enforcement dates and per-country WhatsApp pricing**
  should be re-confirmed against Meta's current Business Help Center at build time —
  both are the kind of external fact most likely to have moved between planning and execution.
- **Vercel plan tier for sub-daily cron** (§6) needs confirming before relying on a
  1-minute schedule — this is new, not carried from the spec (the spec assumed a
  different, non-Vercel worker shape).
