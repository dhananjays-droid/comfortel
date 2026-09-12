-- Persist the exact WhatsApp render proposal awaiting a customer button tap.
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS pending_render jsonb;
