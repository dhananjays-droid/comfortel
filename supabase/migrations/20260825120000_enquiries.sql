-- Buy / quote requests raised from a product card in the chat.
-- Backend-only: written by server functions through the service role. RLS is
-- enabled with no policy on purpose, so an anon or authenticated client can
-- never read another customer's contact details.
CREATE TABLE IF NOT EXISTS public.enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  product_id text NOT NULL,
  product_name text NOT NULL,
  product_url text,
  quantity integer NOT NULL DEFAULT 1,
  full_name text NOT NULL,
  email text NOT NULL,
  phone text,
  business_name text,
  notes text,
  -- If the customer rendered the piece into their own salon before enquiring,
  -- the render travels with the enquiry so the team sees what they pictured.
  visualization_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS enquiries_created_at_idx ON public.enquiries (created_at DESC);
CREATE INDEX IF NOT EXISTS enquiries_product_id_idx ON public.enquiries (product_id);

GRANT ALL ON public.enquiries TO service_role;

ALTER TABLE public.enquiries ENABLE ROW LEVEL SECURITY;
