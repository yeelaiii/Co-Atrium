-- pgTAP: profiles.company_name (migration 0010). job_role moved to project_members in 0018.
-- Run with:  supabase test db
begin;

create extension if not exists pgtap with schema extensions;

select plan(5);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'bob@test.local');

select is((select company_name from public.profiles where id = '11111111-1111-1111-1111-111111111111'), null,
  'company_name starts NULL');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select lives_ok(
  $$ update public.profiles set company_name = 'Atrium Architects'
     where id = '11111111-1111-1111-1111-111111111111' $$,
  'user can set own company_name');
select throws_ok(
  $$ update public.profiles set company_name = '<script>' where id = '11111111-1111-1111-1111-111111111111' $$,
  '23514', null, 'company_name with angle brackets is rejected');
select throws_ok(
  $$ update public.profiles set company_name = repeat('x', 81) where id = '11111111-1111-1111-1111-111111111111' $$,
  '23514', null, 'company_name over 80 chars is rejected');

-- No row policy lets alice see bob (no shared project), so the update touches nothing.
select is_empty(
  $$ update public.profiles set company_name = 'Hijacked' where id = '22222222-2222-2222-2222-222222222222' returning 1 $$,
  'user cannot edit another profile');

select * from finish();
rollback;
