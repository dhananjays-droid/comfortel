-- Customer-facing status/cancel checks filter active render work by session.
-- Status remains text so `cancelled` can be a terminal state alongside the
-- original pending/generating/done/failed values.
CREATE INDEX IF NOT EXISTS wa_render_jobs_session_status_idx
  ON public.wa_render_jobs (session_key, status, created_at);

COMMENT ON COLUMN public.wa_render_jobs.status IS
  'pending | generating | done | failed | cancelled';
