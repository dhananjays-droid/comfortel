create table if not exists public.wa_contact_preferences (
  session_key text primary key,
  opted_out boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.wa_contact_preferences enable row level security;
revoke all on public.wa_contact_preferences from anon, authenticated;
grant select, insert, update on public.wa_contact_preferences to service_role;
create or replace function public.wa_contact_opted_out(p_session_key text)
returns boolean language sql security invoker set search_path = public as $$
  select coalesce((select opted_out from wa_contact_preferences where session_key = p_session_key), false);
$$;
create or replace function public.wa_set_contact_opt_out(p_session_key text, p_opted_out boolean)
returns void language sql security invoker set search_path = public as $$
  insert into wa_contact_preferences(session_key, opted_out) values(p_session_key,p_opted_out)
  on conflict(session_key) do update set opted_out = excluded.opted_out, updated_at = now();
$$;
revoke all on function public.wa_contact_opted_out(text) from public, anon, authenticated;
revoke all on function public.wa_set_contact_opt_out(text, boolean) from public, anon, authenticated;
grant execute on function public.wa_contact_opted_out(text) to service_role;
grant execute on function public.wa_set_contact_opt_out(text, boolean) to service_role;
