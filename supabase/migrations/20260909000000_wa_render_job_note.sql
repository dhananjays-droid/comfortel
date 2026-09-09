-- Carries the customer's own words about the setting or style they asked
-- for (the triggering message, length-capped) through to the render worker.
-- Stored rather than passed in memory for the same reason scene and
-- quantities already are: the job is enqueued now and a later cron tick
-- picks it up, so anything not persisted here is lost by the time the
-- render actually runs.
ALTER TABLE public.wa_render_jobs
  ADD COLUMN IF NOT EXISTS note text;
