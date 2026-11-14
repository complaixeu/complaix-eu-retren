-- The hourly scheduler for /api/claims/tick (migration *_claims_tick_schedule.sql).
begin;
select plan(9);

select has_extension('pg_cron', 'pg_cron is installed');
select has_extension('pg_net', 'pg_net is installed');

select is(
  (select schedule from cron.job where jobname = 'retren-claims-tick'),
  '0 * * * *',
  'the tick job runs every hour'
);
select is(
  (select command from cron.job where jobname = 'retren-claims-tick'),
  'select private.claims_tick()',
  'the tick job calls private.claims_tick()'
);

-- Only the database itself may fire the tick: never the API roles.
select ok(
  not has_function_privilege('anon', 'private.claims_tick()', 'execute'),
  'anon cannot execute private.claims_tick()'
);
select ok(
  not has_function_privilege('authenticated', 'private.claims_tick()', 'execute'),
  'authenticated cannot execute private.claims_tick()'
);
select ok(
  not has_schema_privilege('anon', 'private', 'usage'),
  'anon has no usage on schema private'
);

-- Without the Vault secrets (local, CI) it sends nothing.
select is(private.claims_tick(), null::bigint, 'no Vault secrets: no request is made');

-- With them, it queues exactly one request to the configured URL (rolled back, never sent).
select vault.create_secret('http://127.0.0.1:9/api/claims/tick', 'retren_tick_url');
select vault.create_secret('test-only-tick-secret', 'retren_tick_secret');
select private.claims_tick();
select is(
  (select count(*) from net.http_request_queue where url = 'http://127.0.0.1:9/api/claims/tick'),
  1::bigint,
  'with the Vault secrets: one request to the tick URL is queued'
);

select * from finish();
rollback;
