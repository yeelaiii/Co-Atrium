-- pgTAP: invite by email (migration 0011).
-- Run with:  supabase test db
begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

insert into auth.users (id, email, email_confirmed_at) values
  ('11111111-1111-1111-1111-111111111111', 'owner@test.local', now()),
  ('22222222-2222-2222-2222-222222222222', 'bob@test.local', now()),
  ('33333333-3333-3333-3333-333333333333', 'mallory@test.local', now());

select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;

select create_project('Tower A') as pid \gset

-- existing user: becomes a normal pending invite
select lives_ok(
  format($$ select invite_project_member_by_email(%L, ' Bob@Test.Local ', 'member') $$, :'pid'),
  'owner can invite an existing user by email (case/space insensitive)');
select is(
  (select count(*)::int from project_invites where project_id = :'pid' and invited_user_id = '22222222-2222-2222-2222-222222222222'),
  1, 'existing user gets a user-targeted invite');

-- unknown address: email-targeted invite, no error
select lives_ok(
  format($$ select invite_project_member_by_email(%L, 'newbie@test.local', 'guest') $$, :'pid'),
  'inviting an unregistered address succeeds');
select is(
  (select count(*)::int from project_invites where project_id = :'pid' and invited_email = 'newbie@test.local'),
  1, 'unregistered address is stored as an email invite');

-- re-invite updates role, doesn't duplicate
select invite_project_member_by_email(:'pid', 'newbie@test.local', 'viewer');
select is(
  (select role from project_invites where project_id = :'pid' and invited_email = 'newbie@test.local'),
  'viewer', 're-inviting a pending address updates the role');

select throws_ok(
  format($$ select invite_project_member_by_email(%L, 'not-an-email', 'member') $$, :'pid'),
  '22023', null, 'malformed email is rejected');

select is(
  (select count(*)::int from project_pending_invites(:'pid')),
  2, 'owner sees both pending invites');

-- non-owner cannot invite
select set_config('request.jwt.claims',
  '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
select throws_ok(
  format($$ select invite_project_member_by_email(%L, 'x@test.local', 'member') $$, :'pid'),
  '42501', null, 'non-owner cannot invite by email');
select throws_ok(
  format($$ select * from project_pending_invites(%L) $$, :'pid'),
  '42501', null, 'non-owner cannot list pending invites');

-- claim on confirmation: an unconfirmed signup gets nothing until confirmed
reset role;
insert into auth.users (id, email) values ('44444444-4444-4444-4444-444444444444', 'newbie@test.local');
select is(
  (select count(*)::int from project_invites where invited_user_id = '44444444-4444-4444-4444-444444444444'),
  0, 'unconfirmed signup does not claim the invite');

update auth.users set email_confirmed_at = now() where id = '44444444-4444-4444-4444-444444444444';
select is(
  (select count(*)::int from project_invites
   where invited_user_id = '44444444-4444-4444-4444-444444444444' and invited_email is null and status = 'pending'),
  1, 'confirming the email claims the invite');

-- confirmed signup claims immediately
select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;
select invite_project_member_by_email(:'pid', 'late@test.local', 'member');
reset role;
insert into auth.users (id, email, email_confirmed_at)
values ('55555555-5555-5555-5555-555555555555', 'late@test.local', now());
select is(
  (select count(*)::int from project_invites where invited_user_id = '55555555-5555-5555-5555-555555555555'),
  1, 'confirmed signup (e.g. Google) claims the invite immediately');

select * from finish();
rollback;
