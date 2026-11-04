-- =====================================================================
-- pgTAP: Realtime publication guard
-- Place under supabase/tests/database/. Run with:  supabase test db
-- =====================================================================
begin;

create extension if not exists pgtap with schema extensions;

select plan(3);

select ok(
  exists (select 1 from pg_publication_tables
          where pubname = 'supabase_realtime'
            and schemaname = 'public' and tablename = 'variation_order_comments'),
  'variation_order_comments is published to Realtime');

select ok(
  (select bool_and(c.relrowsecurity)
   from pg_publication_tables t
   join pg_class c on c.oid = format('%I.%I', t.schemaname, t.tablename)::regclass
   where t.pubname = 'supabase_realtime' and t.schemaname = 'public'),
  'every published table has RLS enabled (Realtime relies on it to filter per subscriber)');

-- Guard against accidentally exposing another table. If you publish a new table on purpose,
-- add it to this list in the same change.
select is(
  (select coalesce(array_agg(tablename::text order by tablename), '{}'::text[])
   from pg_publication_tables
   where pubname = 'supabase_realtime' and schemaname = 'public'),
  array['variation_order_comments','variation_orders'],
  'only the intended tables are published to Realtime');

select * from finish();
rollback;