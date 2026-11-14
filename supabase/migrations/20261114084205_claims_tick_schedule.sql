-- Scheduler for the claim timers (docs/plans/C-claims.md C7, ARCHITECTURE §6).
--
-- pg_cron calls private.claims_tick() every hour, which POSTs to the app's /api/claims/tick
-- through pg_net:
--
--   POST <retren_tick_url>
--   Authorization: Bearer <retren_tick_secret>        (TICK_SECRET in Vercel)
--   x-vercel-protection-bypass: <retren_vercel_bypass> (only if that secret exists)
--   Content-Type: application/json
--   {}
--
-- The URL and the secrets live in Supabase Vault, never in this public repo. They are created
-- by hand in each environment that should really call the app (DEV, once C7 is deployed):
--
--   select vault.create_secret('https://<DEV_ALIAS>/api/claims/tick', 'retren_tick_url');
--   select vault.create_secret('<TICK_SECRET>', 'retren_tick_secret');
--   select vault.create_secret('<bypass secret>', 'retren_vercel_bypass');
--
-- Without retren_tick_url and retren_tick_secret the function does nothing, so local Supabase,
-- CI and a DEV database without those secrets never send a request.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Not an exposed schema (supabase/config.toml api.schemas), so PostgREST can't reach it.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.claims_tick()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_bypass text;
  v_headers jsonb;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'retren_tick_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'retren_tick_secret';
  select decrypted_secret into v_bypass from vault.decrypted_secrets where name = 'retren_vercel_bypass';

  if v_url is null or v_secret is null then
    return null; -- not configured here: nothing to call
  end if;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'Authorization', 'Bearer ' || v_secret
  );
  if v_bypass is not null then
    v_headers := v_headers || jsonb_build_object('x-vercel-protection-bypass', v_bypass);
  end if;

  -- Returns the pg_net request id; the response lands in net._http_response.
  return net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := v_headers,
    timeout_milliseconds := 30000
  );
end;
$$;

revoke all on function private.claims_tick() from public, anon, authenticated;

comment on function private.claims_tick() is
  'Hourly trigger for /api/claims/tick (C7). Reads URL and secrets from Vault; no-op without them.';

-- Timers count in days, so hourly is plenty. cron.schedule with a name replaces an existing job
-- of the same name, so re-running this is safe.
select cron.schedule('retren-claims-tick', '0 * * * *', 'select private.claims_tick()');
