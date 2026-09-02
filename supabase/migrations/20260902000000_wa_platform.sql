-- WhatsApp channel adapter: session state, inbound/outbound audit log, and
-- async render jobs.
--
-- Backend-only, same stance as enquiries/shared_designs: written and read by
-- server functions through the service role. RLS is enabled with no policy on
-- purpose, so an anon client can never enumerate a session by guessing a key.
--
-- The customer's phone number is never stored. `session_key` is 'wa:' plus an
-- HMAC-SHA256 of the digits-only phone number, keyed by WHATSAPP_SESSION_SECRET
-- (see wa-session.server.ts) rather than a plain hash — the space of real phone
-- numbers is small enough to brute-force an unkeyed hash in minutes.
CREATE TABLE IF NOT EXISTS public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key   text NOT NULL UNIQUE,
  channel       text NOT NULL DEFAULT 'whatsapp',
  -- ChatMessageInput[], same shape chat.functions.ts already expects.
  transcript    jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan          jsonb NOT NULL DEFAULT '{"ids":[],"qty":{}}'::jsonb,
  -- FlowState from wa-flow.ts.
  flow          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Durable (Supabase Storage) URL of the last uploaded room photo, and when
  -- it was uploaded — expired after ROOM_TTL_MS by wa-session.ts's liveRoom().
  room_url      text,
  room_at       timestamptz,
  -- The room's dimensions, mentioned in text — independent of room_url/room_at
  -- and with no TTL: "12 by 20 ft" said before any photo still applies to a
  -- staged render, and still applies to a photo sent an hour later.
  room_spec_wall_cm  integer,
  room_spec_depth_cm integer,
  -- { packages, choice, at } | null — the last set of packages offered, so a
  -- package tap arriving in a later message can still be resolved.
  offered       jsonb,
  -- A dimensions run promised one image per zone and is only waiting on a
  -- photo — matches index.tsx's pendingZoneRender state.
  pending_zone_render boolean NOT NULL DEFAULT false,
  -- True once escalated to a human; the runtime stops auto-replying until a
  -- person clears this.
  handoff       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE INDEX IF NOT EXISTS sessions_session_key_idx ON public.sessions (session_key);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON public.sessions (expires_at);

GRANT ALL ON public.sessions TO service_role;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

-- Idempotency + audit for inbound webhook events and outbound sends. Meta
-- redelivers webhook events, so wa_message_id is the dedupe key, not an
-- incidental unique constraint.
CREATE TABLE IF NOT EXISTS public.wa_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_message_id text NOT NULL UNIQUE,
  direction     text NOT NULL, -- 'inbound' | 'outbound'
  session_key   text NOT NULL,
  kind          text NOT NULL, -- 'text' | 'image' | 'interactive' | 'template'
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wa_messages_wa_message_id_idx ON public.wa_messages (wa_message_id);
CREATE INDEX IF NOT EXISTS wa_messages_session_key_idx ON public.wa_messages (session_key, created_at DESC);

GRANT ALL ON public.wa_messages TO service_role;
ALTER TABLE public.wa_messages ENABLE ROW LEVEL SECURITY;

-- Async render jobs — the one piece with no equivalent in the web app, which
-- deliberately never polls server-side (the browser does, every ~3s, from
-- visualizeStart/visualizeStatus in visualize.functions.ts). A WhatsApp send
-- can't block a webhook request for the 30-90s a render takes, so the job is
-- enqueued here and driven forward by Vercel Cron ticks instead
-- (wa-render-worker.server.ts).
CREATE TABLE IF NOT EXISTS public.wa_render_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key   text NOT NULL,
  -- AES-256-GCM ciphertext of the customer's phone number (see
  -- wa-phone-crypto.server.ts), keyed by WHATSAPP_PHONE_ENC_KEY — a SEPARATE
  -- secret from WHATSAPP_SESSION_SECRET. This is the one deliberate exception
  -- to "never store the phone number": the render-worker runs on a later,
  -- unrelated Vercel Cron tick with no access to the original webhook
  -- request, and session_key's HMAC is one-way by design, so there is no
  -- other way to know where to deliver a render that finishes minutes after
  -- the request that asked for it. Encrypted rather than plain, and scoped to
  -- this short-lived job row rather than the 30-day sessions table.
  customer_phone_enc text NOT NULL,
  status        text NOT NULL DEFAULT 'pending', -- pending | generating | done | failed
  mode          text NOT NULL,
  product_ids   text[] NOT NULL,
  quantities    jsonb NOT NULL DEFAULT '{}'::jsonb,
  room_url      text, -- null for staged_room
  room_wall_cm  integer,
  room_depth_cm integer,
  scene         text,
  kie_task_id   text,
  -- render-qa.ts's MAX_RETRIES = 1 — one retry on a real fault, same as the
  -- web app's finish() callback.
  attempt       integer NOT NULL DEFAULT 0,
  result_url    text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wa_render_jobs_status_idx ON public.wa_render_jobs (status, created_at);

GRANT ALL ON public.wa_render_jobs TO service_role;
ALTER TABLE public.wa_render_jobs ENABLE ROW LEVEL SECURITY;

-- Storage for this channel: a room photo re-hosted durably enough for a later
-- cron tick to fetch it (Meta's own inbound media URL expires in minutes),
-- and a finished render re-hosted durably enough to survive both Meta's own
-- fetch and the customer reopening the chat weeks later (kie.ai's result URL
-- is an expiring tempfile CDN — see kie.server.ts). Public, like the existing
-- kie.ai/redpandaai render URLs this app already treats as shareable: object
-- keys are random, so nothing is enumerable without already having the URL,
-- the same stance shared_designs.share_code takes.
INSERT INTO storage.buckets (id, name, public)
VALUES ('wa-media', 'wa-media', true)
ON CONFLICT (id) DO NOTHING;
