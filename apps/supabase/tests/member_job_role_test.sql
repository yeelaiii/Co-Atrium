-- pgTAP: per-project profession, project_members.job_role (migration 0018).
-- Run with:  supabase test db
begin;

create extension if not exists pgtap with schema extensions;

select plan(11);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'bob@test.local');

select hasnt_column('public', 'profiles', 'job_role', 'profession is no longer on profiles');

-- alice owns the project; bob is a member.
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
do $$ begin perform create_project('Tower A'); end $$;
reset role;
insert into project_members (project_id, user_id, role)
  select id, '22222222-2222-2222-2222-222222222222', 'member' from projects where name = 'Tower A';

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select is((select job_role from project_members where user_id = '22222222-2222-2222-2222-222222222222'), null,
  'job_role starts NULL');

select lives_ok(
  $$ select set_member_job_role((select id from projects where name = 'Tower A'),
                                '22222222-2222-2222-2222-222222222222', 'Quantity Surveyor') $$,
  'owner can set a member''s profession');
select is((select job_role from project_members where user_id = '22222222-2222-2222-2222-222222222222'),
  'Quantity Surveyor', 'profession is saved');
select is((select role from project_members where user_id = '22222222-2222-2222-2222-222222222222'),
  'member', 'setting a profession leaves the permission role alone');

select lives_ok(
  $$ select set_member_job_role((select id from projects where name = 'Tower A'),
                                '11111111-1111-1111-1111-111111111111', 'Project Director') $$,
  'owner can set their own profession');

select throws_ok(
  $$ select set_member_job_role((select id from projects where name = 'Tower A'),
                                '22222222-2222-2222-2222-222222222222', 'Emperor') $$,
  '22023', null, 'unknown profession is rejected');

select lives_ok(
  $$ select set_member_job_role((select id from projects where name = 'Tower A'),
                                '22222222-2222-2222-2222-222222222222', null) $$,
  'owner can clear a profession');
select is((select job_role from project_members where user_id = '22222222-2222-2222-2222-222222222222'), null,
  'profession is cleared');

select throws_ok(
  $$ update project_members set job_role = 'Builder' $$,
  '42501', null, 'no direct writes to project_members');

-- bob is a member, not an owner.
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select throws_ok(
  $$ select set_member_job_role((select id from projects where name = 'Tower A'),
                                '22222222-2222-2222-2222-222222222222', 'Builder') $$,
  '42501', null, 'non-owners cannot set professions, not even their own');

select * from finish();
rollback;
