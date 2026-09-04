-- Lets the admin dashboard show who a session actually is, without ever
-- storing the phone number itself (still HMAC-only via session_key).
-- customer_name comes from WhatsApp's own contacts[].profile.name on the
-- webhook payload — the display name the customer set in their own
-- WhatsApp app, not something Comfortel asked for. phone_last4 is exactly
-- what it says: four digits, one-way in the sense that it cannot be
-- expanded back to a full number, the same "last 4" pattern a receipt or
-- a card-on-file shows.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS customer_name text,
  ADD COLUMN IF NOT EXISTS phone_last4 text;
