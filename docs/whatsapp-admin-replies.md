# WhatsApp admin replies

## Workflow

Open `/admin/logs` → **Requests inbox** using the existing admin login. Search or filter requests, open a conversation, and choose **Take over**. Write a text reply and send it directly to the customer's WhatsApp. The timeline distinguishes customer, assistant and team messages and shows available delivery/read updates. The inbox refreshes every 15 seconds; the selected conversation refreshes every 5 seconds.

During takeover, new customer messages are recorded without invoking the assistant. They update the latest submitted request and reopen it if resolved. **Return to bot** explicitly resumes automated handling. Resolving a request does not resume the bot or notify the customer. Already-running renders may still finish and deliver. Unsent drafts and pending-send identifiers survive switching requests within the mounted inbox, but not reloading or leaving the page.

## Safety and limits

- Replies are text only (up to 4,000 characters); customer photos can be viewed. Staff attachment sending is not included.
- Free-text replies require a customer message within the previous 24 hours. The server checks Meta's inbound timestamp with a 30-second safety margin. Older logs without that timestamp require a new customer message. Approved-template sending outside the window is not included. [WhatsApp messaging-window reference](https://www.twilio.com/docs/whatsapp/key-concepts).
- Each send has a durable operation ID. Rechecking an unconfirmed send reuses that ID instead of sending again. Network timeouts are marked unconfirmed, not automatically retried. Check the conversation before deliberately starting a replacement reply. Meta acceptance is not proof of delivery.
- Takeover and reply claims are serialized in the database. Returning to the bot is blocked while a recently claimed reply is being sent. Provider calls time out after 15 seconds; the mode-change guard lasts two minutes.
- The destination comes from the stored request, decrypted server-side and checked against its session. Clients cannot supply an arbitrary phone number. The new tables are restricted to the service role.
- Existing shared admin authentication remains in place. There is no named staff assignment, per-agent audit identity, email/push notification, or SLA timer in this release. Staff must monitor the panel. Conversation history is limited to the latest 200 messages and 100 staff replies.
- This does not confirm bookings, modify orders, issue refunds, change the customer web chat, or add spreadsheet/catalog synchronization.

## Rollout

1. Apply `supabase/migrations/20260911190000_wa_staff_inbox.sql` after the existing WhatsApp requests migration. It adds isolated control/reply tables and two restricted functions; it does not rewrite sessions or plans.
2. Deploy the application. The existing WhatsApp sender credentials and admin gate are reused.
3. With an authorized test number, send a fresh customer message, open its submitted request, take over, reply, and verify delivery. Send another customer message and confirm it appears without an assistant response. Return to the bot and verify normal behavior resumes.
4. Verify an expired conversation cannot send free text and that a retried send operation does not produce a second message.

Local verification includes mocked provider failures, concurrent duplicate sends, takeover behavior, the existing regression suite, and desktop/mobile UI checks using synthetic data. The migration and a real WhatsApp exchange still need deployment-environment verification; local tests are not production proof.
