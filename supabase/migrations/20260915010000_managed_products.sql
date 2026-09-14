-- Product source of truth. All writes go through the authenticated server.
create table public.managed_products (
 id text primary key, product jsonb not null,
 revision bigint not null default 1, updated_at timestamptz not null default now(),
 constraint product_identity check (product->>'id'=id)
);
create table public.product_changes (
 id bigint generated always as identity primary key, product_id text not null,
 revision bigint not null, before_product jsonb, after_product jsonb not null,
 created_at timestamptz not null default now()
);
create table public.product_meta_sync (
 product_id text primary key references public.managed_products(id),
 desired_revision bigint not null, synced_revision bigint,
 state text not null default 'pending' check(state in ('pending','processing','synced','failed')),
 attempts integer not null default 0, lease_id uuid, lease_until timestamptz,
 next_attempt_at timestamptz not null default now(), last_error text, meta_id text,
 updated_at timestamptz not null default now()
);
create table public.catalog_settings (
 id boolean primary key default true check(id), catalog_id text,
 enabled boolean not null default false
);
insert into public.catalog_settings(id) values(true);
alter table public.managed_products enable row level security;
alter table public.product_changes enable row level security;
alter table public.product_meta_sync enable row level security;
alter table public.catalog_settings enable row level security;
revoke all on public.managed_products,public.product_changes,public.product_meta_sync,public.catalog_settings from anon,authenticated;
grant select,insert,update on public.managed_products,public.product_meta_sync,public.catalog_settings to service_role;
grant select,insert on public.product_changes to service_role;
grant usage,select on sequence public.product_changes_id_seq to service_role;

create function public.save_managed_product(p_product jsonb,p_expected_revision bigint)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare previous public.managed_products; saved public.managed_products;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_product->>'id',0));
 select * into previous from managed_products where id=p_product->>'id' for update;
 if coalesce(previous.revision,0) <> p_expected_revision then
   raise exception 'Product changed. Reload before saving.' using errcode='40001';
 end if;
 insert into managed_products(id,product,revision) values(p_product->>'id',p_product,p_expected_revision+1)
 on conflict(id) do update set product=excluded.product,revision=excluded.revision,updated_at=now()
 returning * into saved;
 insert into product_changes(product_id,revision,before_product,after_product)
 values(saved.id,saved.revision,previous.product,saved.product);
 insert into product_meta_sync(product_id,desired_revision) values(saved.id,saved.revision)
 on conflict(product_id) do update set desired_revision=excluded.desired_revision,
 state=case when product_meta_sync.lease_until>now() then 'processing' else 'pending' end,
 next_attempt_at=now(),last_error=null,updated_at=now();
 return to_jsonb(saved);
end; $$;

create function public.claim_product_sync(p_limit integer default 10)
returns setof public.product_meta_sync language sql security invoker set search_path=public as $$
 with eligible as (
 select product_id from product_meta_sync where
 (state in ('pending','failed') and next_attempt_at<=now()) or
 (state='processing' and lease_until<now())
 order by updated_at for update skip locked limit least(greatest(p_limit,1),20)
 ) update product_meta_sync s set state='processing',lease_id=gen_random_uuid(),lease_until=now()+interval '5 minutes',
 attempts=attempts+1,updated_at=now() from eligible e where s.product_id=e.product_id returning s.*;
$$;
create function public.finish_product_sync(p_id text,p_lease uuid,p_revision bigint,p_meta_id text,p_error text)
returns void language sql security invoker set search_path=public as $$
 update product_meta_sync set
 synced_revision=case when p_error is null then p_revision else synced_revision end,
 state=case when desired_revision<>p_revision then 'pending' when p_error is null then 'synced' else 'failed' end,
 meta_id=coalesce(p_meta_id,meta_id), last_error=left(p_error,500),lease_id=null,lease_until=null,
 next_attempt_at=case when desired_revision<>p_revision then now() else now()+interval '5 minutes' end,updated_at=now()
 where product_id=p_id and lease_id=p_lease;
$$;
revoke all on function public.save_managed_product(jsonb,bigint),public.claim_product_sync(integer),public.finish_product_sync(text,uuid,bigint,text,text) from public,anon,authenticated;
grant execute on function public.save_managed_product(jsonb,bigint),public.claim_product_sync(integer),public.finish_product_sync(text,uuid,bigint,text,text) to service_role;
