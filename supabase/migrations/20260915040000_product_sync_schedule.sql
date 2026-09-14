-- Provision PRODUCT_SYNC_SECRET in Vercel and the same value as the
-- comfortel_product_sync Vault secret before activating this schedule.
-- No credential is stored in source control or cron.job.command.
create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$
begin
  if exists (select 1 from vault.secrets where name = 'comfortel_product_sync') then
    perform cron.schedule('comfortel-product-sync', '*/5 * * * *', $job$
      select net.http_post(
        url := 'https://comfortel-new.vercel.app/api/cron/product-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                       where name = 'comfortel_product_sync')),
        body := '{}'::jsonb, timeout_milliseconds := 60000);
    $job$);
  end if;
end $$;
