-- pgTAP: per-project role and contract party on project_members (migrations 0018, 0019, 0026).
-- Run with:  supabase test db
begin;

create extension if not exists pgtap with schema extensions;

select plan(20);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'alice@test.local'),
  ('22222222-2222-2222-2222-222222222222', 'bob@test.local');

select hasnt_column('public', 'profiles', 'job_role', 'role is not on profiles');
select hasnt_column('public', 'project_members', 'contract_role', 'contract_role was merged into job_role');
select hasnt_function('public', 'set_member_contract_profile', 'old contract profile RPC is gone');

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
                                '22222222-2222-2222-2222-222222222222', 'quantity_surveyor') $$,
  'owner can set a member''s role');
select is((select job_role from project_members where user_id = '22222222-2222-2222-2222-222222222222'),
  'quantity_surveyor', 'role is saved');
select is((select role from project_members where user_id = '22222222-2222-2222-2222-222222222222'),
  'member', 'setting a role leaves access alone');

select lives_ok(
  $$ select set_member_job_role((select id from projects where name = 'Tower A'),
                                '11111111-1111-1111-1111-111111111111', 'project_director') $$,
  'owner can set their own role');

select throws_ok(
  $$ select set_member_job_role((select id from projects where name = 'Tower A'),
                                '22222222-2222-2222-2222-222222222222', 'Quantity Surveyor') $$,
  '22023', null, 'old display values are rejected');

select lives_ok(
  $$ select set_member_contract_party((select id from projects where name = 'Tower A'),
                                      '22222222-2222-2222-2222-222222222222', 'contractor') $$,
  'owner can set a member''s contract party');
select is((select contract_party from project_members where user_id = '22222222-2222-2222-2222-222222222222'),
  'contractor', 'party is saved');
select throws_ok(
  $$ select set_member_contract_party((select id from projects where name = 'Tower A'),
                                      '22222222-2222-2222-2222-222222222222', 'landlord') $$,
  '22023', null, 'unknown party is rejected');

-- Which roles confirm.
select ok(private.is_confirming_role('contract_admin')
          and private.is_confirming_role('project_director')
          and private.is_confirming_role('project_manager')
          and private.is_confirming_role('quantity_surveyor'), 'CA, PD, PM and QS confirm');
select ok(not (private.is_confirming_role('site_supervisor') or private.is_confirming_role('engineer')
               or private.is_confirming_role('trades') or private.is_confirming_role('administrator')
               or private.is_confirming_role(null)), 'other roles and no role do not confirm');

-- bob (member, quantity surveyor) can confirm; with no role he can't.
select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select ok(private.can_confirm_contract((select id from projects where name = 'Tower A')),
  'member with a confirming role can confirm');

select set_config('request.jwt.claims',
  '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok(
  $$ select set_member_job_role((select id from projects where name = 'Tower A'),
                                '22222222-2222-2222-2222-222222222222', null) $$,
  'owner can clear a role');
select is((select job_role from project_members where user_id = '22222222-2222-2222-2222-222222222222'), null,
  'role is cleared');

select set_config('request.jwt.claims',
  '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select ok(not private.can_confirm_contract((select id from projects where name = 'Tower A')),
  'member without a role cannot confirm');

select throws_ok(
  $$ update project_members set job_role = 'trades' $$,
  '42501', null, 'no direct writes to project_members');

-- bob is a member, not an owner.
select throws_ok(
  $$ select set_member_job_role((select id from projects where name = 'Tower A'),
                                '22222222-2222-2222-2222-222222222222', 'trades') $$,
  '42501', null, 'non-owners cannot set roles, not even their own');

select * from finish();
rollback;
