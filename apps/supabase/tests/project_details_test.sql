-- pgTAP: project location / type / client (migration 0012).
-- Run with:  supabase test db
begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'alice@test.local');

set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);

select lives_ok(
  $$ select create_project('Tower A', ' 12 Main St, Singapore ', 'Commercial', 'Acme Pte Ltd') $$,
  'create_project accepts location, type and client');
select is(
  (select location || '|' || project_type || '|' || client_name from projects where name = 'Tower A'),
  '12 Main St, Singapore|Commercial|Acme Pte Ltd', 'details are saved and trimmed');

select lives_ok($$ select create_project('Bare') $$, 'name alone still works');
select is((select location from projects where name = 'Bare'), null, 'omitted details are NULL');

select throws_ok($$ select create_project('Bad type', null, 'Spaceport', null) $$, '23514', null,
  'unknown project type is rejected');
select lives_ok($$ select create_project('Blank', '   ', '', '  ') $$, 'blank optional fields are treated as empty');

select * from finish();
rollback;
