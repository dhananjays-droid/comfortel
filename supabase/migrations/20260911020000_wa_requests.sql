-- Independent of salon/render session state: support intake must not reset a design.
CREATE TABLE IF NOT EXISTS public.wa_requests (
  reference text PRIMARY KEY,
  session_key text NOT NULL,
  source_message_id text NOT NULL UNIQUE,
  category text NOT NULL CHECK (category IN ('sales','support','order','complaint')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','in_progress','resolved','cancelled')),
  stage text NOT NULL DEFAULT 'details' CHECK (stage IN ('details','confirm')),
  details jsonb NOT NULL DEFAULT '[]'::jsonb,
  customer_phone_enc text NOT NULL,
  last_inbound_id text,
  last_reply jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wa_requests_session_idx ON public.wa_requests(session_key, created_at DESC);
CREATE INDEX IF NOT EXISTS wa_requests_inbox_idx ON public.wa_requests(status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS wa_requests_one_draft_idx ON public.wa_requests(session_key) WHERE status = 'draft';
ALTER TABLE public.wa_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wa_requests FROM anon, authenticated;
GRANT ALL ON public.wa_requests TO service_role;
COMMENT ON TABLE public.wa_requests IS 'WhatsApp request intake and internal staff inbox. Not an order or appointment system. Phone encrypted, admin auth required. No automatic external notifications.';
