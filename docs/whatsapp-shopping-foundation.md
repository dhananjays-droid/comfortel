# WhatsApp conversation foundation — first milestone

## Status

Implemented locally, not deployed or enabled in production. The web chatbot is unchanged. The existing user-maintained go-live document and staged catalog workbook were not edited.

This is a shopping-to-estimate vertical slice, not a replacement of every existing workflow. Support/ticket intake, image generation, staff takeover, native catalog carts and existing forms remain with their current handlers.

## What changed

- An opt-in conversation controller uses bounded, schema-validated product lookup and final-decision tools, rather than parsing action markers from prose.
- Current product facts are fetched from the existing request-scoped catalog. Only relevant product records are sent, not the entire catalog.
- Customer quantity, category, finish, per-unit budget and goal are stored in `sessions.flow.shoppingMemory`. Existing `sessions.plan` remains the selected product/quantity source of truth. No migration or new product database is required.
- Policy interruptions preserve the selection; natural quantity corrections can update it; the existing PDF builder receives exact saved quantities.
- Shortlists with a known quantity have selection buttons. Replayed selection buttons set the same quantity rather than increment it. Stale product/quantity choices are rejected.
- Provider tools cannot create image jobs, submit requests, place orders, reserve stock or confirm delivery. Existing render confirmation stays authoritative.
- A handled shopping reply requires a successful session save before delivery. Provider errors and malformed/unknown tool calls return a recoverable failure without applying partial changes.
- Each conversational turn is limited to three model calls, each with a 15-second timeout and 900 output-token cap. Selection/clear/PDF buttons need no model call.

## Verification

Before changes: 818 existing tests passed, one skipped.

After implementation: 854 tests passed, two skipped in the regular suite (the additional skipped test is the explicitly opt-in live test). Type checking, production build and diff whitespace checks passed.

Separately, the approved live synthetic seven-message Anthropic test passed. It exercised:

1. “I want five” — asks which product, stores quantity without inventing a selection.
2. Product identification — retrieves Chloe Tan from the catalog.
3. Explicit selection — saves five chairs.
4. Warranty interruption — answers while retaining the selection.
5. “Actually make that three” — changes the saved quantity.
6. PDF request — passes three chairs to the existing document path.
7. Image request — returns control to the established render workflow.

The live test uses actual AI responses and synthetic history. PDF bytes are mocked there; existing document tests exercise the PDF pathway separately. It does not send WhatsApp messages, write customer database records or generate images. The passing test took about 15 seconds overall; this is not a production latency benchmark.

Live testing found and corrected an omitted quantity-memory update and a failure to delegate image requests. This small sample is not a statistically meaningful improvement percentage, nor an old-versus-new production A/B test.

## Rollout

Set `WA_SHOPPING_AGENT_ENABLED=true` only in the intended test/preview environment first. Unset/false retains the established pipeline without a shopping-model call or additional request-draft lookup.

Local regression command: `npm run test:run`.

Explicitly authorized synthetic provider test: `RUN_SHOPPING_LIVE=true npx vitest run src/lib/__tests__/wa-shopping-live.test.ts`. It reads the existing Anthropic key from the environment/local environment file without printing it. Do not enable this in routine CI or attach real customer transcripts.

Before production enablement: verify a real WhatsApp shortlist/selection/PDF journey in the intended deployment, check current managed catalog data, and record per-task token usage and latency. The provider adapter logs aggregate token usage without customer text. No measured cost increase/decrease is claimed yet.

Rollback: disable the flag. Saved plans remain compatible with the old workflow. Do not promise that previously sent experimental `shop:*` buttons continue working after disabling the flag; direct customers to type their request instead.

## Remaining boundaries

- Active legacy request drafts and existing form flows deliberately bypass this controller. Their broader conversation-repair migration is not completed by this milestone.
- The preferences are structured memory, not a complete long-term conversation summarizer or historical-chat retrieval system.
- Model wording/factual accuracy still requires broader held-out conversation evaluation. Schema validation prevents invalid actions, not every possible unsupported sentence.
- Exact stock reservations, order tracking and confirmed delivery require authoritative business integrations, not richer prompts.
- No model upgrade, new paid platform, production deployment or image generation was performed.
