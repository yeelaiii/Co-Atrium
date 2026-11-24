-- =====================================================================
-- Migration 0022: call Edge Functions from pg_cron with the new secret API key
-- Requires: 0021
-- =====================================================================
--
-- Supabase is retiring the legacy anon / service_role JWT keys by the end of 2026. This replaces
-- private.invoke_edge_function so it uses a secret key (sb_secret_..., Dashboard > Settings >
-- API Keys, the key named "default") instead of the service_role key.
--
-- Create the Vault secret once per environment (project_url from 0021 stays as it is):
--
--   select vault.create_secret('<sb_secret_... key named "default">', 'secret_key');
--
-- Locally (supabase start) use the secret key printed by `supabase status`.
-- Until both secrets exist the job logs a warning and does nothing.
--
-- The new keys are not JWTs, so they go in the `apikey` header (an `Authorization: Bearer` header
-- would be rejected as an invalid JWT). The called functions run with verify_jwt = false and
-- check the key themselves (functions/_shared/server/http.ts).
-- Note: pg_net keeps the request (with the key) in net.http_request_queue until it is sent.
--
-- The old 'service_role_key' Vault secret is no longer read; delete it once this is deployed:
--   delete from vault.secrets where name = 'service_role_key';

-- Calls an Edge Function with the project's secret API key. Returns the pg_net request id, or
-- NULL when the Vault secrets aren't set up yet.
create or replace function private.invoke_edge_function(fn text, payload jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  base text;
  key text;
begin
  if fn !~ '^[a-z0-9-]{1,64}$' then
    raise exception 'Invalid function name' using errcode = '22023';
  end if;
  select decrypted_secret into base from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into key from vault.decrypted_secrets where name = 'secret_key';
  if base is null or key is null then
    raise warning 'invoke_edge_function(%): Vault secrets project_url / secret_key are not set', fn;
    return null;
  end if;
  return net.http_post(
    url := rtrim(base, '/') || '/functions/v1/' || fn,
    body := payload,
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', key),
    timeout_milliseconds := 60000);
end $$;

-- create or replace keeps existing grants; restated so the intent is explicit.
revoke execute on function private.invoke_edge_function(text, jsonb) from public, anon, authenticated;
grant execute on function private.invoke_edge_function(text, jsonb) to service_role;
