# WhatsApp conversation controller — 16 September 2026

## Scope and ownership

WhatsApp only. `WA_SHOPPING_AGENT_ENABLED=true` selects one conversation controller in `wa-conversation.server.ts`. Free text no longer falls through independent shopping, document and request interceptors. The existing runtime is called explicitly for legacy buttons, navigation, real job status and guarded generation confirmation. Consent, FIFO processing, staff takeover and native cart handling remain outside the conversational model.

The existing catalog/admin UI, render provider, PDF builder and web-chat interface are retained. The optional candidate-filter argument added to the shared package builder leaves its existing callers unchanged.

## Durable data

| Data | Location |
| --- | --- |
| Project/task memory, suspended task, clarification, category requirements, shortlist version | `sessions.flow.conversation` JSON |
| Selected product IDs and per-product quantities | `sessions.plan` |
| Recent dialogue | `sessions.transcript` |
| Photo, last render and pending confirmation | Existing `sessions` fields |
| Staff requests and review details | `wa_requests` |
| Authoritative products/prices | Existing managed catalog context from `managed_products` |
| Inbound ordering, jobs and delivery evidence | Existing WhatsApp queue/job/message tables |

No database schema migration is required. Missing conversation memory is initialized on old sessions. Failed reads in the enabled dispatcher do not overwrite an existing customer with an empty session.

## Decisions versus actions

- `plan_salon` computes an equipment proposal with real catalog prices and persists the resulting draft in the same successful turn. It does not generate, place an order or reserve stock.
- Salon and barbershop candidates are separated; unavailable products and requested finishes are filtered. Missing roles and over-budget proposals are disclosed. Equipment quantities are assumptions, not an approved floor plan.
- Product lookup ranks relevant terms and marks partial matches. Product IDs and quantities are validated before changes.
- Request details are original customer text, not invented model summaries. The model marks whether essential information is present; vague quantity-only/empty requests cannot be confirmed. Submission remains an explicit customer action.
- A policy/product detour cannot automatically append text to a staff request. Menu pauses intake without displaying an empty submission form.
- Render actions call a proposal-only capability. Existing durable, expiring confirmation and duplicate guards still own job creation. Status reads actual jobs.
- Shortlist buttons are bound to the displayed message version; replaced shortlists reject old selection buttons.
- Quoted outbound messages are fetched only within the same session; catalog enquiry references are carried into context.
- Tool failures return repairable errors within a bounded loop. Repeated searches are blocked and the final call is instructed to finish. Logs record action/tool/validation paths and aggregate usage, not customer text or credentials.

## Model and cost

Default free-text advisor: `claude-sonnet-5`, overridable with `WA_ADVISOR_MODEL`. The earlier Haiku model failed the expanded live planning/shortlist contract checks; Sonnet 4.6 passed the initial full live journeys and was then replaced by Sonnet 5 on 16 September 2026 (list price $2/$10 per MTok against $3/$15). Note that Sonnet 5's tokenizer counts about 1.4× more tokens for the same text, so the model change alone is worth roughly 9%, not 33%. Deterministic buttons/navigation do not call the advisor model. Planning is one validated tool call, rather than separate searches for each equipment category.

Measured per-turn cost (count_tokens on the real request bodies, list prices, cache hit): a browse turn (find_products + finish) was $0.056 on Sonnet 4.6 with full product facts in the server context; it is $0.021 on Sonnet 5 with product summaries in the context and eight keyword-search results. A single-call answer went from $0.023 to $0.006. The server context change is the larger of the two savings: full facts for the selection and displayed products measured 7,616 tokens per call, summaries 488. Specifications are fetched by `find_products` with ids when a claim needs them, which the instructions already required.

## Verification

Model allocation: the existing general/legacy chat stays on Haiku 4.5. The complex WhatsApp advisor, package curation, render inspection, edit verification and offline product-photo classifier use Sonnet 5. No Sonnet 4.5 or Sonnet 4.6 call sites remain in application/scripts.

Cost routing: exact support/sales/order/complaint commands, thanks and selected-plan PDF commands bypass the advisor. Standalone allow-listed policy/contact/hours questions use Haiku 4.5; active request drafts, quoted replies, mixed intents and ambiguous follow-ups retain Sonnet. Haiku is permitted only a read-only answer with no memory/project mutations. Any other output is discarded and escalated once to Sonnet. There is no paid classification call and no automatic retry of provider billing failures. The remaining free text still uses Sonnet; this is deliberately a narrow optimization, not universal Haiku routing.

The shared policy/instruction prefix has a five-minute ephemeral cache breakpoint; changing customer state stays after it. Provider minimum token thresholds and cache hits determine savings; a cold cache write costs more than ordinary input, so savings are not guaranteed for isolated calls. Usage logs now include the model together with provider token/cache counts, without customer text. The routing and request payloads were checked offline with mocked provider responses, not paid live tests. Actual Haiku reply quality and production cache hit rates remain to be checked with an agreed test budget.

- `npx tsc --noEmit`
- `npx vitest run`
- `npm run build`
- Opt-in narrow live journey: `RUN_ADVISOR_LIVE=true npx vitest run src/lib/__tests__/wa-conversation-live.test.ts`
- Expanded synthetic suite: `RUN_ADVISOR_JOURNEYS=true ADVISOR_JOURNEY_COUNT=100 npx vitest run --config scripts/qa/qa.config.ts scripts/qa/advisor-journeys.live.test.ts`

The expanded suite is **100 parameterized multi-turn journeys across five families**, not 100 independently designed customer intents. It checks planning/corrections, shopping/PDFs, support interruptions/resume, comparisons/unknown specifications and render confirmation/dismissal. Generated transcripts are in `outputs/advisor-qa-2026-09-16/journeys.json` (local artifact; synthetic data only).

These tests use real Anthropic replies, isolated request/session stores and mocked PDF bytes. They forbid production database access and generation. They do not prove Meta transport or image quality; those are separate production smoke checks. Existing PDF/render/queue tests remain in the local suite.

### Current release gate (16 September 2026)

The first 10 expanded live journeys passed. The subsequent 100-journey run finished with 77 passed and 23 failed (IDs 71, 73, 78 and 80–99). These failures returned the generic fallback, so this is **not a passing release gate**. A minimal provider diagnostic immediately afterward returned HTTP 400 / `invalid_request_error`: "Your credit balance is too low to access the Anthropic API." The individual causes of the first three intermittent failures remain unconfirmed; do not attribute every failed case to billing without retesting.

The recommended gate was to restore Anthropic API credits and retest failed scenarios before deployment. The user subsequently explicitly requested deployment to main without further testing and will perform WhatsApp testing themselves. Proceed under that direction, retaining the unresolved live-test failures above. The last offline checks passed (971 tests, type-check and production build). No production WhatsApp smoke test has been completed for this refactor. Local test artifacts are not evidence of deployed behavior.

### Live re-verification after Sonnet 5 and the compact context (16 September 2026)

`RUN_ADVISOR_LIVE=true npx vitest run src/lib/__tests__/wa-conversation-live.test.ts` passed twice on the changed code: 12 customer turns covering planning with a currency clarification, a warranty detour that left the plan untouched, a quantity correction that preserved the other lines, a PDF estimate, a render proposal, a mirror shortlist with reasons, and a staff request paused by a policy question and a menu visit, then resumed to confirmation.

Billed usage from the second run, read from the `wa-shopping-usage` log lines: 14 Sonnet 5 calls for 12 turns (2 `plan_salon`, 2 `find_products`, 10 `finish`), 21,638 uncached input tokens, 84,560 cache-read tokens, 2,342 output tokens, **$0.0836 for the run, $0.0070 per customer turn**. Output averaged 167 tokens per call, well under the 350 assumed in the estimate above, which is why the billed figure sits below the estimated $0.021 browse / $0.006 simple turns. Median latency per turn was 2.4s, p90 5.9s, max 8.2s; the Sonnet 4.6 100-journey run logged a 3.6s median and 12.3s p90.

Two caveats on reading that number. The prefix cache hit rate was 100% because the calls were seconds apart; on WhatsApp a customer who pauses more than five minutes triggers a fresh 6,128-token cache write (about $0.015 on Sonnet 5), so real conversations will land between the hit and cold figures. And this is the narrow live gate, not the 100-journey suite, which has not been re-run on Sonnet 5.

## Release and rollback

Push only the verified commit to `main`, triggering production. Do not push this work to a preview branch or run a preview deployment. Keep the user's staged catalog workbook and earlier QA outputs out of the release commit.

Before declaring success, verify Vercel's production commit and readiness, then test the actual Comfortel WhatsApp conversation and button flow. Do not claim a paid image generation was tested unless one was actually executed and checked.

For an emergency rollback, use a new revert commit or the feature flag; never rewrite published history. The disabled flag returns to the legacy behavior, including its previously documented limitations.

## Remaining boundaries

This is not a guarantee against all model mistakes. Product specifications remain bounded by available data. Native order status/refunds/appointments are staff requests, not direct ERP/payment/calendar actions. The suite is a reproducible regression gate, not a statistical estimate of all production conversations. Continue adding genuinely new customer failures as held-out cases, and monitor provider errors, action validation and delivery failures after release.
