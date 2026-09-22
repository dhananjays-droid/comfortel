-- A complaint or support request must not inherit an unsent sales/delivery
-- draft. Allow one unsent draft per request category instead of one per chat.
-- Existing rows already satisfy the stricter old index, so this cannot fail.
DROP INDEX IF EXISTS public.wa_requests_one_draft_idx;
CREATE UNIQUE INDEX IF NOT EXISTS wa_requests_one_draft_per_category_idx
  ON public.wa_requests(session_key, category) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS wa_requests_session_drafts_idx
  ON public.wa_requests(session_key, updated_at DESC) WHERE status = 'draft';
