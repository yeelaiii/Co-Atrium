-- pgTAP: variation order approvals and push tokens (migration 0016).
-- Run with:  supabase test db
begin;

create extension if not exists pgtap with schema extensions;

select plan(39);

create schema tests;
grant usage on schema tests to authenticated;

create function tests.v(k text) returns uuid language sql stable as $$ select current_setting('t.' || k)::uuid $$;
grant execute on function tests.v(text) to authenticated;

create function tests.auth_as(uid uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uid::text, true);
  set local role authenticated;
end $$;

-- Pushes queued so far that mention `needle` in their body.
create function tests.pushes(needle text) returns integer language sql security definer as $$
  select count(*)::int from net.http_request_queue
  where url = 'https://exp.host/--/api/v2/push/send' and convert_from(body, 'utf8') like '%' || needle || '%'
$$;
grant execute on function tests.pushes(text) to authenticated;

-- ---------------------------------------------------------------------
-- Fixtures: alice (owner), bob (member), frank (member), carol (guest), dave (outsider)
-- ---------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@test.local', '{"display_name":"Alice"}'),
  ('22222222-2222-2222-2222-222222222222', 'bob@test.local',   '{"display_name":"Bob"}'),
  ('33333333-3333-3333-3333-333333333333', 'carol@test.local', '{"display_name":"Carol"}'),
  ('44444444-4444-4444-4444-444444444444', 'dave@test.local',  '{"display_name":"Dave"}'),
  ('66666666-6666-6666-6666-666666666666', 'frank@test.local', '{"display_name":"Frank"}');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select set_config('t.p1', create_project('Tower A')::text, true);

reset role;
insert into project_members (project_id, user_id, role) values
  (tests.v('p1'), '22222222-2222-2222-2222-222222222222', 'member'),
  (tests.v('p1'), '66666666-6666-6666-6666-666666666666', 'member'),
  (tests.v('p1'), '33333333-3333-3333-3333-333333333333', 'guest');

-- ---------------------------------------------------------------------
-- Push tokens
-- ---------------------------------------------------------------------
select tests.auth_as('11111111-1111-1111-1111-111111111111');
select lives_ok($$ select register_push_token('ExponentPushToken[alice-phone]', 'ios') $$, 'register a token');
select throws_ok($$ select register_push_token('not a token', 'ios') $$, '23514', null, 'malformed token rejected');
select throws_ok($$ select register_push_token('ExponentPushToken[x]', 'web') $$, '23514', null, 'unknown platform rejected');
select throws_ok($$ select * from push_tokens $$, '42501', null, 'clients cannot read tokens');

select tests.auth_as('66666666-6666-6666-6666-666666666666');
select lives_ok($$ select register_push_token('ExponentPushToken[frank-phone]', 'android') $$, 'frank registers');
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select lives_ok($$ select register_push_token('ExponentPushToken[bob-phone]', 'ios') $$, 'bob registers');

-- ---------------------------------------------------------------------
-- Creating a VO with approvers
-- ---------------------------------------------------------------------
select lives_ok(format($$ select set_config('t.vo1', create_variation_order(
    %L, 'Move kitchen wall', 'Client', approvers => array[
      '11111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666666']::uuid[],
      participants => array['33333333-3333-3333-3333-333333333333']::uuid[])::text, true) $$,
    tests.v('p1')),
  'bob sends a VO to alice and frank, and includes carol');

select is((select status from variation_orders where id = tests.v('vo1')), 'pending', 'new VO is pending');
select is((select array_agg(user_id order by user_id) from variation_order_approvers where variation_order_id = tests.v('vo1')),
  array['11111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666666']::uuid[],
  'both approvers are recorded');
select ok((select bool_and(approved_at is null and added_by = '22222222-2222-2222-2222-222222222222')
           from variation_order_approvers where variation_order_id = tests.v('vo1')),
  'approvers start pending, added by the sender');
select is(tests.pushes('alice-phone'), 1, 'alice is notified');
select is(tests.pushes('frank-phone'), 1, 'frank is notified');
select is(tests.pushes('bob-phone'), 0, 'the sender is not notified');
select ok(tests.pushes('for your approval') >= 1, 'notification says it needs approval');

select throws_ok(format($$ select create_variation_order(%L, 'x', 'y', approvers =>
    array['22222222-2222-2222-2222-222222222222']::uuid[]) $$, tests.v('p1')),
  '22023', null, 'sender cannot be their own approver');
select throws_ok(format($$ select create_variation_order(%L, 'x', 'y', approvers =>
    array['33333333-3333-3333-3333-333333333333']::uuid[]) $$, tests.v('p1')),
  '22023', null, 'guests cannot be approvers');
select throws_ok(format($$ select create_variation_order(%L, 'x', 'y', approvers =>
    array['44444444-4444-4444-4444-444444444444']::uuid[]) $$, tests.v('p1')),
  '22023', null, 'outsiders cannot be approvers');

-- Clients cannot write approvals or status directly.
select throws_ok(format($$ insert into variation_order_approvers (variation_order_id, project_id, user_id)
    values (%L, %L, '22222222-2222-2222-2222-222222222222') $$, tests.v('vo1'), tests.v('p1')),
  '42501', null, 'no direct insert of approvers');
select throws_ok(format($$ update variation_orders set status = 'approved', approved_at = now() where id = %L $$, tests.v('vo1')),
  '42501', null, 'no direct status change');

-- ---------------------------------------------------------------------
-- Visibility
-- ---------------------------------------------------------------------
select tests.auth_as('33333333-3333-3333-3333-333333333333');
select is((select count(*)::int from variation_order_approvers where variation_order_id = tests.v('vo1')), 2,
  'guests see who was asked to approve');
select is((select display_name from profiles where id = '66666666-6666-6666-6666-666666666666'), 'Frank',
  'guests can read approver names');
select tests.auth_as('44444444-4444-4444-4444-444444444444');
select is((select count(*)::int from variation_order_approvers), 0, 'outsiders see no approvers');

-- ---------------------------------------------------------------------
-- Approving
-- ---------------------------------------------------------------------
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select throws_ok(format($$ select approve_variation_order(%L) $$, tests.v('vo1')),
  '42501', null, 'non-approver cannot approve');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select is((select approve_variation_order(tests.v('vo1'))), false, 'alice approves; VO not yet complete');
select is((select count(*)::int from variation_order_comments
           where variation_order_id = tests.v('vo1') and kind = 'approval'
             and author_id = '11111111-1111-1111-1111-111111111111' and body is null), 1,
  'an approval log is added to the thread');
select is((select status from variation_orders where id = tests.v('vo1')), 'pending', 'still pending on frank');
select is(tests.pushes('Alice approved'), 1, 'sender is told about the approval');
select throws_ok(format($$ select approve_variation_order(%L) $$, tests.v('vo1')),
  '23505', null, 'cannot approve twice');

select tests.auth_as('66666666-6666-6666-6666-666666666666');
select is((select approve_variation_order(tests.v('vo1'))), true, 'frank''s approval completes the VO');
select ok((select status = 'approved' and approved_at is not null from variation_orders where id = tests.v('vo1')),
  'VO is approved');
select ok(tests.pushes('Every approver has now approved') = 1, 'sender is told the VO is complete');
select throws_ok(format($$ insert into variation_order_comments (variation_order_id, project_id, kind)
    values (%L, %L, 'approval') $$, tests.v('vo1'), tests.v('p1')),
  '42501', null, 'clients cannot fake an approval log');

-- ---------------------------------------------------------------------
-- Adding approvers later
-- ---------------------------------------------------------------------
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select set_config('t.vo2', create_variation_order(tests.v('p1'), 'Add skylight', 'Architect')::text, true);
select is((select count(*)::int from variation_order_approvers where variation_order_id = tests.v('vo2')), 0,
  'a VO can be created without approvers');
select is((select add_variation_order_approvers(tests.v('vo2'),
  array['66666666-6666-6666-6666-666666666666', '66666666-6666-6666-6666-666666666666']::uuid[])), 1,
  'sender adds an approver (duplicates collapse)');
select is((select add_variation_order_approvers(tests.v('vo2'), array['66666666-6666-6666-6666-666666666666']::uuid[])), 0,
  'adding an existing approver is a no-op');

select tests.auth_as('66666666-6666-6666-6666-666666666666');
select throws_ok(format($$ select add_variation_order_approvers(%L, array['11111111-1111-1111-1111-111111111111']::uuid[]) $$,
  tests.v('vo2')), '42501', null, 'a plain member who did not send it cannot add approvers');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select throws_ok(format($$ select add_variation_order_approvers(%L, array['11111111-1111-1111-1111-111111111111']::uuid[]) $$,
  tests.v('vo2')), 'P0002', null, 'a project owner who was not included cannot see the VO, so cannot add approvers');
select throws_ok(format($$ select add_variation_order_approvers(%L, array['66666666-6666-6666-6666-666666666666']::uuid[]) $$,
  tests.v('vo1')), '22023', null, 'cannot add approvers to an approved VO');

-- Approvals are permanent.
reset role;
select throws_ok(format($$ delete from variation_order_approvers where variation_order_id = %L $$, tests.v('vo1')),
  '42501', null, 'approvals cannot be deleted, even by the service role');

select * from finish();
rollback;
