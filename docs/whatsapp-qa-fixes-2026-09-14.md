# WhatsApp customer-journey fixes — 14 September 2026

## Deployment status

Implemented and tested locally. **Not pushed, deployed, or applied to the production database.** No messages were sent to customers, and no real support requests were created during testing. The existing staged production Excel and user-authored go-live document were left untouched.

**Remaining release limitation:** repeated image-verification runs are not fully consistent. The missing-trolley example was caught in some runs and missed in another, even with two inspections. The three new images passed direct visual review, but this does not prove automatic verification is reliable for every future image. Outputs carry a customer review reminder and edits offer an Adjust image button. Exact product fidelity remains a mitigation, not a closed guarantee; staff approval would be needed for a stricter release gate.

**Apply `supabase/migrations/20260914010000_wa_contact_preferences.sql` before deploying this code.** Every outbound WhatsApp send now checks the persisted opt-out preference. If that lookup is unavailable, sends fail closed rather than bypassing consent. Deploying code before its migration would therefore stop outbound messages.

## Changes against the audit

| Audit | Change |
|---|---|
| B01 | STOP/unsubscribe is persisted separately from conversational state, and checked for bot, media, template and staff sends. Consent commands work during staff takeover. Resume requires an explicit subscription command, not merely Hi. Data deletion creates an open staff-review request without claiming deletion has happened. |
| B02 | Injury/collapse, dispute and manager/escalation wording routes into requests. Safety reports are saved immediately with appropriate safety wording, not a fictional staff notification. |
| B03–B04 | Explicit salon station counts are preserved. Typed corrections rebuild the confirmation. Two shampoo units cannot overwrite four styling stations. Package quantities and exclusions are enforced after curation and totals recomputed. |
| B05 | Quantified image requests no longer enter generic package intake. The existing persisted Start generation / Not now confirmation remains mandatory. |
| B06 | Only exact FAQ topics use canned answers. Full/compound questions reach the assistant with approved policy knowledge and conversation context. |
| B07 | FAQ, request and document turns are included in saved conversation history. Clearly related additions update an open request instead of losing the new details. Shown products and document context are persisted in the existing session flow JSON. |
| B08 | Comparisons and estimates remember their exact products and quantities. A clear quantity amendment updates only the matching item and offers an Updated PDF button. Ambiguous product categories ask for the exact model. |
| B09–B10 | Rich specifications include recent products and their descriptions. Instructions prohibit inferred mechanical, assembly and included-part claims. Comparison price and width follow-ups use deterministic catalog data for the saved comparison. Missing specifications remain unknown. |
| B11 | Link-only requests return the last shown products' canonical links without photos. |
| B12 | Full-catalog PDF requests receive an honest alternative with functioning actions, not an image-generation message. WhatsApp instructions prohibit nonexistent web controls such as a plan tray. |
| B13 | Persisted English/Spanish locale; Spanish product-action labels and render confirmation text preserve the original button IDs. This is not a claim of complete localization for every language or every service template. |
| B14–B15 | Missing/malformed count coverage is unavailable, not a pass. Count output is constrained to the expected product names and row count, with one inspection-only retry. Single missing items count too. Malformed tool fragments are not customer copy. |
| B16–B17 | WhatsApp refits replace selected furniture types within the requested zone; they do not strip every furnishing. Paired-image inspections inventory protected objects and receive selected product references. Two bounded independent audits must agree on a pass. Existing physical/count inspection remains in place. |

Customer messages distinguish a proposal, queued work, provider processing, an inspection issue and a timeout. Slow-image messages no longer claim that extra design detail explains the delay. The worker allows up to 15 minutes instead of prematurely abandoning a slow provider task at six minutes, performs one final status check before expiry, and does not automatically buy a replacement for a timeout.

The web interface and its full-room prompt are unchanged. Shared render-inspection validation and bounded provider polling are hardened and covered by the full test suite.

## Verification and evidence

- Full 100-turn customer rerun: 20 conversations, 64 successful model calls, zero execution errors, isolated persistence and delivery. This is not a 100% semantic-quality score.
- Final quote/comparison rerun after the last document changes: 10 turns, three model calls, no errors. Four chairs/four mirrors amended to six chairs/four mirrors; an updated PDF was produced. Equal-price comparison stayed equal.
- Final button journey: 11 steps through package selection, role choice, preview, Not now, Start generation and repeated tap. The four-station plan total was **$7,372 against $8,000**. Enqueue was mocked; repeated confirmation did not create another job. No live WhatsApp sends. Retests exposed over-cap curated/local tiers; the final guard selects an actually affordable package and removes stale model-generated budget explanations.
- New generations were capped at **three distinct 1K provider jobs**, no paid retries. G05 (both chairs white) and G17 (reception only) returned after approximately 86 and 106 seconds. G15 (remove one chair) exceeded the eight-minute observation window; its original job was later retrieved successfully. It was observed complete at about 12m45s, which includes the gap between status checks and is not an exact provider processing-time measurement.
- All three new images were visually inspected. Both chairs were white; the removed chair's trolley remained; reception-only changes retained the chair's chrome base and black trolley.
- The checker was tested against earlier bad images and the new good images. Early versions missed changes or falsely rejected an already-matching desk; those observations drove structured protected-object inventories and final-state rather than change-for-change's-sake checks. AI inspection remains probabilistic, not a guarantee of exact SKU fidelity.
- **783 unit tests passed, one skipped** across 44 files; typecheck, targeted lint, production build and whitespace checks passed. New positive regression tests replace the old expected-bug assertions.
- The final isolated count test returned the two expected product rows at two pieces each. An unsupported strict-schema array constraint and transient inspection timeouts were exposed during testing; the schema now uses supported constraints plus exact row coverage enforced in code. Timeouts remain explicitly unavailable, not a verified pass. See `count-diagnostic.json` for the final successful response.

Evidence folders:

- `outputs/qa-2026-09-14/`: untouched original audit/transcript/images.
- `outputs/qa-2026-09-14-after/`: rerun transcript, button journey, three new images, late-result status and inspection evidence.
- `outputs/qa-2026-09-14-final-documents/`: final document amendment/comparison rerun and PDFs.

The 100-turn snapshot predates the final deterministic comparison/quantity handler changes; use the separate final-document run for those cases. The original image run correctly failed its time-window assertion before G15 arrived; a status-only refresh recovered that same paid task. No additional generation was submitted to hide that delay.

## Rollout checklist

1. Apply the contact-preferences migration and confirm its two service-role RPCs work. Confirm anon/authenticated roles cannot access the preference table/functions.
2. Deploy the matching code. Do not roll back to code that ignores persisted opt-outs after customers have used STOP.
3. Verify one real WhatsApp conversation: greeting, product browsing, quantity correction, PDF, request submission, staff takeover, STOP and explicit resume.
4. Verify session reloads retain shown products and the last document; test duplicate confirmation taps against the real database claim.
5. Check one authorized image delivery end to end, including media delivery status. Provider generation tests here do not prove Meta delivery.

Remaining external requirements: approved privacy/deletion procedure and staff ownership, authoritative missing technical specifications/policies, and the separately parked live-price/stock feed. No unsupported business policy or product certification has been invented.
