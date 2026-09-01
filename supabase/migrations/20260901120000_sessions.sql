-- The conversation, held by the server instead of by the browser.
--
-- Everything the assistant needs to answer a turn is small: the transcript the
-- model reads, the plan the customer has built, and where the scripted menu is
-- up to. That set is channel-agnostic on purpose — the web client and a
-- WhatsApp webhook can drive the same row, which is the whole point. The rich
-- UI message tree (render entries, cards, before/after state) stays in the
-- browser, because it is a web affordance and WhatsApp has no use for it.
--
-- Backend-only, same as enquiries and shared_designs: written and read by
-- server functions through the service role. RLS is enabled with no policy on
-- purpose, so an anon client can never read another customer's conversation.
CREATE TABLE IF NOT EXISTS public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Opaque. For the web this is a random string the browser keeps; for
  -- WhatsApp it is 'wa:' + an HMAC of the phone number. Never the number
  -- itself: the webhook hands us the number on every message, so storing it
  -- would be keeping an identifier we do not need in order to reply.
  session_key text NOT NULL UNIQUE,
  channel text NOT NULL DEFAULT 'web',

  -- [{ role, content }] — exactly what chat.functions sends to the model.
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- { ids: string[], qty: Record<string, number> } — ids only, because the
  -- catalogue already lives in the app.
  plan jsonb NOT NULL DEFAULT '{"ids":[],"qty":{}}'::jsonb,
  -- Where the scripted WhatsApp menu is up to. Empty for a web session.
  flow jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The customer's room photo, as a URL on the render host rather than bytes.
  -- The original upload is never stored, matching shared_designs: the renders
  -- already show their salon, so holding the raw photo would be keeping
  -- personal data with no use for it.
  room_url text,
  room_aspect text,
  room_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Swept rather than kept forever. A plan is worth surviving a reload and a
  -- few days of thinking about it; it is not worth holding indefinitely.
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
);

CREATE INDEX IF NOT EXISTS sessions_session_key_idx ON public.sessions (session_key);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON public.sessions (expires_at);

GRANT ALL ON public.sessions TO service_role;

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
