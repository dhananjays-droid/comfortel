-- A stale staff revision is a business conflict, not a transient serialization
-- failure. PostgREST 14 retries 40001 repeatedly; PT409 returns immediately.
-- https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b
do $$
declare definition text;
begin
 definition:=pg_get_functiondef('public.save_managed_product(jsonb,bigint)'::regprocedure);
 execute replace(definition,'''40001''','''PT409''');
end $$;
