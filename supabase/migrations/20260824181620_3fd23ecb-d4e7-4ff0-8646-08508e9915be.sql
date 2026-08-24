CREATE TABLE public.visualizations (
  hash text PRIMARY KEY,
  product_id text NOT NULL,
  image_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.visualizations TO service_role;

ALTER TABLE public.visualizations ENABLE ROW LEVEL SECURITY;