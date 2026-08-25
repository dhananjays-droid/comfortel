ALTER TABLE public.visualizations
  ADD COLUMN IF NOT EXISTS task_id text,
  ADD COLUMN IF NOT EXISTS mode text;

ALTER TABLE public.visualizations ALTER COLUMN image_url DROP NOT NULL;

CREATE INDEX IF NOT EXISTS visualizations_task_id_idx ON public.visualizations (task_id);