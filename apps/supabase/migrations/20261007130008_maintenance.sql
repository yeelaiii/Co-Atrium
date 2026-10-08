-- =====================================================================
-- Migration 0008: maintenance functions (service role / pg_cron)
-- Requires: 0002
-- =====================================================================

-- =====================================================================
-- 11. MAINTENANCE (service role / pg_cron only)
-- =====================================================================

-- Fails jobs stuck in 'processing'. Schedule every few minutes.
create function private.reap_stuck_transcriptions(max_age interval default interval '15 minutes')
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  update public.transcriptions
  set status = 'failed', error = 'Timed out while processing'
  where status = 'processing' and updated_at < now() - max_age;
  get diagnostics n = row_count;
  return n;
end $$;

-- Hard-deletes soft-deleted projects/documents past the restore window.
-- Storage objects are NOT removed by SQL: purge them from an Edge Function first.
create function private.purge_soft_deleted(retention interval default interval '30 days')
returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.projects  where deleted_at < now() - retention;
  delete from public.documents where deleted_at < now() - retention;
end $$;

revoke execute on function
  private.reap_stuck_transcriptions(interval),
  private.purge_soft_deleted(interval)
from public, anon, authenticated;

grant execute on function
  private.reap_stuck_transcriptions(interval),
  private.purge_soft_deleted(interval)
to service_role;

-- Remove the implicit PUBLIC execute that every new function gets.
revoke execute on all functions in schema public  from public, anon;
revoke execute on all functions in schema private from public, anon;

-- Trigger functions: nobody calls these directly.
revoke execute on function
  public.handle_new_user(), public.add_creator_as_owner(),
  public.prevent_last_owner_loss(), public.log_membership_event(),
  public.set_updated_at(), public.documents_before_update(),
  public.limit_message_rate(), public.limit_documents_per_project(),
  public.limit_transcription_requests()
from authenticated;

-- Edge Function (service role) reminders for transcription jobs:
--   * re-check membership role and projects.deleted_at before processing (RLS is bypassed);
--   * set status='processing' and attempts = attempts + 1 when claiming a row;
--   * write error text on failure.


