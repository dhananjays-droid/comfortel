-- Ingest and inspect Meta products before exposing the native catalog to customers.
alter table public.catalog_settings
  add column if not exists sync_enabled boolean not null default false;
comment on column public.catalog_settings.sync_enabled is
  'Controls backend product ingestion independently of customer catalog visibility';
