-- pgTAP: project status and description (migration 0013).
-- Run with:  supabase test db
begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'bob@test.local');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select lives_ok(
  $$ select create_project('Tower A', null, null, null, E'  Two towers.\nPodium retail.  ') $$,
  'create_project accepts a description');
select is((select description from projects where name = 'Tower A'), E'Two towers.\nPodium retail.',
  'description is saved and trimmed, newlines kept');
select is((select status from projects where name = 'Tower A'), 'ongoing', 'new projects are ongoing');

select lives_ok($$ select create_project('Blank', null, null, null, '   ') $$, 'blank description is accepted');
select is((select description from projects where name = 'Blank'), null, 'blank description is NULL');

select throws_ok($$ select create_project('Bad', null, null, null, '<script>') $$, '23514', null,
  'angle brackets in description are rejected');

update projects set status = 'closed' where name = 'Tower A';
select is((select status from projects where name = 'Tower A'), 'closed', 'owner can close a project');

select throws_ok($$ update projects set status = 'archived' where name = 'Tower A' $$, '23514', null,
  'unknown status is rejected');

-- Bob is not a member, so RLS hides the row and the update touches nothing.
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
update projects set status = 'ongoing' where name = 'Tower A';
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is((select status from projects where name = 'Tower A'), 'closed', 'non-members cannot change status');

select * from finish();
rollback;
