-- =====================================================================
-- Migration 0021: scheduled jobs for deadlines (pg_cron -> Edge Functions via pg_net)
-- Requires: 0016 (pg_net), 0020
-- =====================================================================
--
-- Every 15 minutes pg_cron calls the send-reminders Edge Function, which drains the obligation
-- queue, marks overdue obligations and sends reminders.
--
-- The function URL and service-role key are read from Supabase Vault, never stored in SQL.
-- Create them once per environment (Dashboard > Project Settings > Vault, or SQL):
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<service role key>', 'service_role_key');
--
-- Locally (supabase start) use 'http://host.docker.internal:54321' as project_url
-- and the service_role key printed by `supabase status`.
-- Until both secrets exist the job logs a warning and does nothing.

create extension if not exists pg_cron;

-- Calls an Edge Function with the service role. Returns the pg_net request id, or NULL when the
-- Vault secrets aren't set up yet.
create function private.invoke_edge_function(fn text, payload jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  base text;
  key text;
begin
  if fn !~ '^[a-z0-9-]{1,64}$' then
    raise exception 'Invalid function name' using errcode = '22023';
  end if;
  select decrypted_secret into base from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into key from vault.decrypted_secrets where name = 'service_role_key';
  if base is null or key is null then
    raise warning 'invoke_edge_function(%): Vault secrets project_url / service_role_key are not set', fn;
    return null;
  end if;
  return net.http_post(
    url := rtrim(base, '/') || '/functions/v1/' || fn,
    body := payload,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || key),
    timeout_milliseconds := 60000);
end $$;

revoke execute on function private.invoke_edge_function(text, jsonb) from public, anon, authenticated;
grant execute on function private.invoke_edge_function(text, jsonb) to service_role;

-- Schedule (re-runnable: unschedule first if it exists).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'send-reminders') then
      perform cron.unschedule('send-reminders');
    end if;
    perform cron.schedule('send-reminders', '*/15 * * * *',
      $job$ select private.invoke_edge_function('send-reminders') $job$);
  end if;
end $$;
