-- Tracks the most recently delivered render per session, so a follow-up
-- like "make the chairs blue" can anchor on the actual picture the
-- customer was shown instead of starting a new composition from scratch.
-- Stored as one JSONB blob (resultUrl/mode/productIds/quantities/at),
-- matching how `offered` and `pending_quote` are already stored here.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS last_render jsonb;
