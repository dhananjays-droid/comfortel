-- Durable, per-customer FIFO processing for WhatsApp inbound messages.
--
-- Webhook deliveries can overlap. Without a queue, two invocations can load
-- the same session and the later save can erase the other message's changes.
-- One claimed row per session prevents that race while still allowing
-- different customers to be processed concurrently.
CREATE TABLE IF NOT EXISTS public.wa_inbound_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_message_id text NOT NULL UNIQUE,
  session_key text NOT NULL,
  customer_phone_enc text NOT NULL,
  event jsonb NOT NULL,
  customer_name text,
  status text NOT NULL DEFAULT 'queued', -- queued | processing | done | failed
  attempt integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wa_inbound_jobs_status_created_idx
  ON public.wa_inbound_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS wa_inbound_jobs_session_status_idx
  ON public.wa_inbound_jobs (session_key, status, created_at);

GRANT ALL ON public.wa_inbound_jobs TO service_role;
ALTER TABLE public.wa_inbound_jobs ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN public.wa_inbound_jobs.customer_phone_enc IS
  'AES-256-GCM ciphertext used only by the asynchronous reply worker';

-- Log the inbound message and enqueue it in one transaction. If Meta retries
-- the same wa_message_id, neither table receives a second row.
CREATE OR REPLACE FUNCTION public.enqueue_wa_inbound(
  p_wa_message_id text,
  p_session_key text,
  p_customer_phone_enc text,
  p_kind text,
  p_message_payload jsonb,
  p_event jsonb,
  p_customer_name text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Also serializes simultaneous enqueue transactions for one customer, so
  -- the rate count and created_at ordering see a stable per-session history.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_session_key, 0));

  INSERT INTO public.wa_messages (
    wa_message_id, direction, session_key, kind, payload
  ) VALUES (
    p_wa_message_id, 'inbound', p_session_key, p_kind, p_message_payload
  )
  ON CONFLICT (wa_message_id) DO NOTHING;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Same threshold as wa-rate-limit.server.ts. Keep the audit row, but do not
  -- enqueue or reply to a flood (which would itself incur WhatsApp cost).
  IF (
    SELECT count(*)
    FROM public.wa_messages
    WHERE session_key = p_session_key
      AND direction = 'inbound'
      AND created_at >= now() - interval '1 minute'
  ) >= 20 THEN
    RETURN false;
  END IF;

  INSERT INTO public.wa_inbound_jobs (
    wa_message_id, session_key, customer_phone_enc, event, customer_name
  ) VALUES (
    p_wa_message_id, p_session_key, p_customer_phone_enc, p_event, p_customer_name
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_wa_inbound(text, text, text, text, jsonb, jsonb, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_wa_inbound(text, text, text, text, jsonb, jsonb, text)
  TO service_role;

-- Atomically claims only the oldest queued message for any one session.
-- A processing row blocks later rows for that customer, while SKIP LOCKED
-- allows independent customers to continue in parallel.
CREATE OR REPLACE FUNCTION public.claim_wa_inbound_jobs(p_limit integer DEFAULT 5)
RETURNS SETOF public.wa_inbound_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.wa_inbound_jobs
  WHERE status IN ('done', 'failed')
    AND updated_at < now() - interval '30 days';

  -- Recover invocations that died before completing. Three failed claims are
  -- retained for diagnosis instead of retrying forever.
  UPDATE public.wa_inbound_jobs
  SET status = CASE WHEN attempt >= 3 THEN 'failed' ELSE 'queued' END,
      last_error = CASE
        WHEN attempt >= 3 THEN COALESCE(last_error, 'Processing lease expired')
        ELSE last_error
      END,
      started_at = NULL,
      completed_at = CASE WHEN attempt >= 3 THEN now() ELSE NULL END,
      updated_at = now()
  WHERE status = 'processing'
    AND started_at < now() - interval '5 minutes';

  RETURN QUERY
  WITH candidates AS (
    SELECT job.id
    FROM public.wa_inbound_jobs AS job
    WHERE job.status = 'queued'
      AND NOT EXISTS (
        SELECT 1
        FROM public.wa_inbound_jobs AS active
        WHERE active.session_key = job.session_key
          AND active.status = 'processing'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.wa_inbound_jobs AS earlier
        WHERE earlier.session_key = job.session_key
          AND earlier.status = 'queued'
          AND (earlier.created_at, earlier.id) < (job.created_at, job.id)
      )
    ORDER BY job.created_at, job.id
    LIMIT GREATEST(1, LEAST(p_limit, 20))
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.wa_inbound_jobs AS job
    SET status = 'processing',
        attempt = job.attempt + 1,
        started_at = now(),
        updated_at = now()
    FROM candidates
    WHERE job.id = candidates.id
      AND job.status = 'queued'
    RETURNING job.*
  )
  SELECT * FROM claimed ORDER BY claimed.created_at, claimed.id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_wa_inbound_jobs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_wa_inbound_jobs(integer) TO service_role;

-- Meta sends outbound lifecycle callbacks separately from inbound messages.
-- Keep every status transition even if it arrives before the matching
-- wa_messages audit row, which can happen immediately after a send.
CREATE TABLE IF NOT EXISTS public.wa_message_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_message_id text NOT NULL,
  session_key text,
  status text NOT NULL, -- sent | delivered | read | failed | deleted
  event_at timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wa_message_id, status, event_at)
);

CREATE INDEX IF NOT EXISTS wa_message_statuses_message_idx
  ON public.wa_message_statuses (wa_message_id, event_at DESC);
CREATE INDEX IF NOT EXISTS wa_message_statuses_session_idx
  ON public.wa_message_statuses (session_key, event_at DESC);

GRANT ALL ON public.wa_message_statuses TO service_role;
ALTER TABLE public.wa_message_statuses ENABLE ROW LEVEL SECURITY;
