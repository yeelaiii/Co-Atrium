-- pgTAP: variation orders are visible only to the people included (migration 0017).
-- Run with:  supabase test db
begin;

create extension if not exists pgtap with schema extensions;

select plan(30);

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

create function tests.upload(bkt text, path text, uid uuid, mime text) returns void
language sql security definer as $$
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values (bkt, path, uid::text, jsonb_build_object('mimetype', mime))
$$;
grant execute on function tests.upload(text, text, uuid, text) to authenticated;

create function tests.pushes(needle text) returns integer language sql security definer as $$
  select count(*)::int from net.http_request_queue
  where url = 'https://exp.host/--/api/v2/push/send' and convert_from(body, 'utf8') like '%' || needle || '%'
$$;
grant execute on function tests.pushes(text) to authenticated;

-- Can `uid` read the object? (storage policies, evaluated as that user)
create function tests.can_read_object(bkt text, path text) returns boolean language sql as $$
  select exists (select 1 from storage.objects where bucket_id = bkt and name = path)
$$;
grant execute on function tests.can_read_object(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- Fixtures: alice (owner), bob (member), frank (member), carol (guest), gina (member), dave (outsider)
-- ---------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@test.local', '{"display_name":"Alice"}'),
  ('22222222-2222-2222-2222-222222222222', 'bob@test.local',   '{"display_name":"Bob"}'),
  ('33333333-3333-3333-3333-333333333333', 'carol@test.local', '{"display_name":"Carol"}'),
  ('44444444-4444-4444-4444-444444444444', 'dave@test.local',  '{"display_name":"Dave"}'),
  ('66666666-6666-6666-6666-666666666666', 'frank@test.local', '{"display_name":"Frank"}'),
  ('77777777-7777-7777-7777-777777777777', 'gina@test.local',  '{"display_name":"Gina"}');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select set_config('t.p1', create_project('Tower A')::text, true);

reset role;
insert into project_members (project_id, user_id, role) values
  (tests.v('p1'), '22222222-2222-2222-2222-222222222222', 'member'),
  (tests.v('p1'), '66666666-6666-6666-6666-666666666666', 'member'),
  (tests.v('p1'), '77777777-7777-7777-7777-777777777777', 'member'),
  (tests.v('p1'), '33333333-3333-3333-3333-333333333333', 'guest');

select tests.upload('attachments', tests.v('p1') || '/bob-photo.jpg', '22222222-2222-2222-2222-222222222222', 'image/jpeg');
select tests.upload('audio',       tests.v('p1') || '/bob-voice.m4a', '22222222-2222-2222-2222-222222222222', 'audio/mp4');

select tests.auth_as('77777777-7777-7777-7777-777777777777');
select register_push_token('ExponentPushToken[gina-phone]', 'android');
select tests.auth_as('33333333-3333-3333-3333-333333333333');
select register_push_token('ExponentPushToken[carol-phone]', 'ios');

-- ---------------------------------------------------------------------
-- Bob sends a VO: frank approves, carol is included, alice (owner) and gina are not
-- ---------------------------------------------------------------------
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select lives_ok(format($$ select set_config('t.vo1', create_variation_order(
    %L, 'Move kitchen wall', 'Client', null, 'Shift 600mm east',
    jsonb_build_array(jsonb_build_object('kind','photo','path', %L),
                      jsonb_build_object('kind','voice','path', %L, 'duration_ms', 3000)),
    approvers => array['66666666-6666-6666-6666-666666666666']::uuid[],
    participants => array['33333333-3333-3333-3333-333333333333',
                          '22222222-2222-2222-2222-222222222222']::uuid[])::text, true) $$,
    tests.v('p1'), tests.v('p1') || '/bob-photo.jpg', tests.v('p1') || '/bob-voice.m4a'),
  'bob sends a VO to frank (approver) and carol');
select lives_ok(format($$ select post_variation_order_comment(%L, 'Checked with engineer') $$, tests.v('vo1')),
  'bob comments');

select is((select array_agg(user_id order by user_id) from variation_order_participants where variation_order_id = tests.v('vo1')),
  array['22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333',
        '66666666-6666-6666-6666-666666666666']::uuid[],
  'sender, included person and approver are participants (sender listed once)');
select is(tests.pushes('carol-phone'), 1, 'carol is told the VO was shared with her');
select ok(tests.pushes('included you in') = 1, 'the shared push says she was included');
select is(tests.pushes('gina-phone'), 0, 'gina, not included, is not notified');

-- Included people see everything.
select tests.auth_as('33333333-3333-3333-3333-333333333333');
select is((select count(*)::int from variation_orders where id = tests.v('vo1')), 1, 'carol sees the VO');
select is((select count(*)::int from variation_order_comments where variation_order_id = tests.v('vo1')), 1, 'carol sees the thread');
select is((select count(*)::int from variation_order_attachments where variation_order_id = tests.v('vo1')), 2, 'carol sees the media');
select is((select count(*)::int from transcriptions where variation_order_id = tests.v('vo1')), 1, 'carol sees the transcript');
select ok(tests.can_read_object('attachments', tests.v('p1') || '/bob-photo.jpg'), 'carol can open the photo');
select ok(tests.can_read_object('audio', tests.v('p1') || '/bob-voice.m4a'), 'carol can play the voice note');
select is((select count(*)::int from variation_order_participants where variation_order_id = tests.v('vo1')), 3,
  'carol sees who is included');

select tests.auth_as('66666666-6666-6666-6666-666666666666');
select is((select count(*)::int from variation_orders where id = tests.v('vo1')), 1, 'frank (approver) sees the VO');

-- Members who were not included see nothing, owners included.
select tests.auth_as('77777777-7777-7777-7777-777777777777');
select is((select count(*)::int from variation_orders), 0, 'gina does not see the VO');
select is((select count(*)::int from variation_order_comments), 0, 'gina does not see the thread');
select is((select count(*)::int from variation_order_attachments), 0, 'gina does not see the media');
select is((select count(*)::int from transcriptions), 0, 'gina does not see the transcript');
select ok(not tests.can_read_object('audio', tests.v('p1') || '/bob-voice.m4a'), 'gina cannot play the voice note');
select throws_ok(format($$ select post_variation_order_comment(%L, 'hi') $$, tests.v('vo1')),
  'P0002', null, 'gina cannot post in it');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select is((select count(*)::int from variation_orders), 0, 'project owners are not included automatically');
select ok(not tests.can_read_object('attachments', tests.v('p1') || '/bob-photo.jpg'), 'alice cannot open the photo');

-- ---------------------------------------------------------------------
-- Including people later
-- ---------------------------------------------------------------------
select tests.auth_as('66666666-6666-6666-6666-666666666666');
select throws_ok(format($$ select add_variation_order_participants(%L, array['77777777-7777-7777-7777-777777777777']::uuid[]) $$,
  tests.v('vo1')), '42501', null, 'a participant who did not send it cannot include people');

select tests.auth_as('22222222-2222-2222-2222-222222222222');
select throws_ok(format($$ select add_variation_order_participants(%L, array['44444444-4444-4444-4444-444444444444']::uuid[]) $$,
  tests.v('vo1')), '22023', null, 'outsiders cannot be included');
select is((select add_variation_order_participants(tests.v('vo1'),
  array['77777777-7777-7777-7777-777777777777', '33333333-3333-3333-3333-333333333333']::uuid[])), 1,
  'sender includes gina (carol is already in)');

select tests.auth_as('77777777-7777-7777-7777-777777777777');
select is((select count(*)::int from variation_order_comments where variation_order_id = tests.v('vo1')), 1,
  'gina now sees the whole thread, including earlier comments');

-- Adding an approver later includes them too.
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select add_variation_order_approvers(tests.v('vo1'), array['11111111-1111-1111-1111-111111111111']::uuid[]);
select tests.auth_as('11111111-1111-1111-1111-111111111111');
select is((select count(*)::int from variation_orders where id = tests.v('vo1')), 1, 'alice sees it once asked to approve');

-- Leaving the project removes access even though the participant row remains.
reset role;
update project_members set left_at = now()
where project_id = tests.v('p1') and user_id = '33333333-3333-3333-3333-333333333333';
select tests.auth_as('33333333-3333-3333-3333-333333333333');
select is((select count(*)::int from variation_orders), 0, 'carol loses access when she leaves the project');

-- ---------------------------------------------------------------------
-- A VO sent to nobody else is visible to its sender only
-- ---------------------------------------------------------------------
select tests.auth_as('66666666-6666-6666-6666-666666666666');
select set_config('t.vo2', create_variation_order(tests.v('p1'), 'Draft', 'Me')::text, true);
select is((select count(*)::int from variation_orders where id = tests.v('vo2')), 1, 'the sender sees their own VO');
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select is((select count(*)::int from variation_orders where id = tests.v('vo2')), 0, 'nobody else does');

select * from finish();
rollback;
