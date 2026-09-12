# WhatsApp image confirmation and truthful status

Scope: WhatsApp only. The web chat retains its existing render workflow.

## Customer journey

1. A text request, product preview button, image upload, edit request or zone request prepares a proposal. It does not generate an image.
2. The proposal identifies the products and quantities, room source, and edit instruction when applicable. The customer sees **Start generation** and **Not now**. Longer details are split into WhatsApp-sized text messages before the confirmation button.
3. Only **Start generation** on the current proposal can enqueue work. A typed “yes” repeats the button. **Not now** dismisses only that unstarted proposal; it does not cancel unrelated active work. Changed instructions, replacement photos, cancellation and restart invalidate the earlier confirmation. Confirmations expire after 30 minutes.
4. Confirmation uses the saved product/quantity/photo snapshot and a durable one-use claim. Replayed taps cannot enqueue the same proposal again, even when using a stale session snapshot. An uncertain claim is not retried as another generation.
5. The bot says **queued** only after a successful database enqueue. Generation and delivery still happen asynchronously; no fixed one-minute promise is made. If some zone/options fail to enqueue, the acknowledgement states that only the successfully queued subset will run.
6. `?`, `any update`, `render status`, and common progress questions in a render conversation read the actual queue, not Claude's earlier promises. Idle, queued, generating and unavailable are distinguished. A pending proposal is shown again when nothing has started.

## Photo and messaging safeguards

- Durable WhatsApp room photos and delivered-image edit references remain usable for 24 hours, instead of 15/30 minutes. This is an application reuse window, not a change to storage retention or public sharing.
- Generic preview actions choose the saved room photo when available. Example rooms are explicitly labelled. Requests to use a customer's photo cannot silently switch to a staged room when the reference is missing.
- Model render/offer output is converted into application-owned confirmation wording; its raw “rendering now” promise is not delivered or saved as fact. WhatsApp-only prompt instructions reinforce this separation.
- Read failures on the job queue fail closed. A missing saved confirmation cannot produce an apparently valid start button.

## Deployment order

Apply `supabase/migrations/20260912010000_wa_render_confirmation.sql` before deploying. It adds nullable `sessions.pending_render` JSON; it does not rewrite existing chats, plans or photos. Existing session RLS remains in effect. The one-use claim uses the existing internal message audit mechanism.

## Verification

Automated tests cover the exact screenshot request, false historic promises, a 73-minute-old photo, database save/load of a proposal, explicit taps, typed consent, duplicate/concurrent confirmation, changed instructions, replacement photos, cancellation, stale/cross-session/expired buttons, edits, zone renders, long message limits, queue/claim/persistence failures and generation enqueue failures. Provider/database calls in these tests are mocked; they do not spend generation credits or message customers.

After deployment, verify with an authorized test conversation: request an image using its saved photo, confirm no job exists before the button tap, tap once, check the queued job's exact photo/quantities, ask for status, and verify final delivery. A repeated start tap must not add a second job. Local tests do not establish live provider delivery.
