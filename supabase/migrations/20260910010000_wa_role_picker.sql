-- Tracks progress through the role-by-role product picker shown after a
-- budget tier is accepted (one WhatsApp list message per role: styling
-- chair, mirror, wash unit, ...), so an in-progress pick survives between
-- messages the same way `offered` and `last_render` already do.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS role_picker jsonb;
