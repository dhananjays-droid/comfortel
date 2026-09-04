-- The admin dashboard's session-summary query (wa-admin.server.ts's
-- handleAdminSessions) scans the most recent rows across ALL sessions to
-- group them, not one session's history — the existing
-- wa_messages_session_key_idx (session_key, created_at desc) and
-- wa_render_jobs_status_idx (status, created_at) don't serve that access
-- pattern well, since neither leads with created_at alone. Without a plain
-- created_at index, that scan degenerates into a full table sort as the
-- tables grow past what fits comfortably in memory — exactly the kind of
-- thing that should be sized for before it is needed, not after a
-- dashboard starts timing out under real traffic.
CREATE INDEX IF NOT EXISTS wa_messages_created_at_idx ON public.wa_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS wa_render_jobs_created_at_idx ON public.wa_render_jobs (created_at DESC);
