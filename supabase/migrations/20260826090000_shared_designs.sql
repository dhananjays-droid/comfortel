-- A design the customer chose to share: the products they picked and the
-- renders they generated, behind an unguessable code.
--
-- Backend-only, same as enquiries: written and read by server functions through
-- the service role. RLS is enabled with no policy on purpose, so an anon client
-- can never enumerate other customers' designs.
--
-- The customer's ORIGINAL room photo is deliberately not stored. Nothing
-- displays it — the renders already show their salon — so keeping the raw upload
-- would be holding personal data with no use for it. Sharing is opt-in per
-- design, and the code is random rather than sequential so a link cannot be
-- guessed from another one.
CREATE TABLE IF NOT EXISTS public.shared_designs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- URL-safe random string, generated in the server function.
  share_code text NOT NULL UNIQUE,
  product_ids text[] NOT NULL,
  -- [{ imageUrl, label }] — the renders as they appeared in the chat.
  renders jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Snapshotted at share time. Catalogue prices change; a shared link should
  -- keep showing the total the customer actually saw.
  subtotal_cents integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shared_designs_share_code_idx ON public.shared_designs (share_code);
CREATE INDEX IF NOT EXISTS shared_designs_created_at_idx ON public.shared_designs (created_at DESC);

GRANT ALL ON public.shared_designs TO service_role;

ALTER TABLE public.shared_designs ENABLE ROW LEVEL SECURITY;
