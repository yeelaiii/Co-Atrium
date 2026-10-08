-- =====================================================================
-- Migration 0009: Realtime
-- Requires: 0002, 0006
-- =====================================================================

-- Broadcast new messages to subscribed clients.
-- Realtime evaluates RLS per subscriber, so guests and viewers only receive what the
-- "read messages" policy lets them read. Never publish a table that has no RLS.
--
-- transcriptions is deliberately NOT published yet (no worker processes it). When that feature
-- ships, add it in a NEW migration and update the "only these tables are published" test.
--
-- Written as a DO block so re-running it does not fail with "already member of publication".
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;