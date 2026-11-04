-- pgTAP: variation orders and their threads (migration 0014).
-- The fixture VOs include everyone in the project (migration 0017 made inclusion explicit);
-- private VOs are covered in vo_participants_test.sql.
-- Run with:  supabase test db
begin;

create extension if not exists pgtap with schema extensions;

select plan(66);

-- ---------------------------------------------------------------------
-- Helpers (schema `tests`, dropped by the rollback)
-- ---------------------------------------------------------------------
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

-- Stands in for a client upload: creates the storage object as `uid`.
create function tests.upload(bkt text, path text, uid uuid, mime text) returns void
language sql security definer as $$
  insert into storage.objects (bucket_id, name, owner_id, metadata)
  values (bkt, path, uid::text, jsonb_build_object('mimetype', mime))
$$;
grant execute on function tests.upload(text, text, uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- Fixtures: alice (owner), bob (member), carol (guest), erin (viewer), dave (outsider)
-- ---------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@test.local', '{"display_name":"Alice"}'),
  ('22222222-2222-2222-2222-222222222222', 'bob@test.local',   '{"display_name":"Bob"}'),
  ('33333333-3333-3333-3333-333333333333', 'carol@test.local', '{"display_name":"Carol"}'),
  ('44444444-4444-4444-4444-444444444444', 'dave@test.local',  '{"display_name":"Dave"}'),
  ('55555555-5555-5555-5555-555555555555', 'erin@test.local',  '{"display_name":"Erin"}');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select set_config('t.p1', create_project('Tower A')::text, true);
select set_config('t.p2', create_project('Other job')::text, true);

reset role;
insert into project_members (project_id, user_id, role) values
  (tests.v('p1'), '22222222-2222-2222-2222-222222222222', 'member'),
  (tests.v('p1'), '33333333-3333-3333-3333-333333333333', 'guest'),
  (tests.v('p1'), '55555555-5555-5555-5555-555555555555', 'viewer');

select tests.upload('attachments', tests.v('p1') || '/bob-photo-1.jpg', '22222222-2222-2222-2222-222222222222', 'image/jpeg');
select tests.upload('audio',       tests.v('p1') || '/bob-voice-1.m4a', '22222222-2222-2222-2222-222222222222', 'audio/mp4');
select tests.upload('attachments', tests.v('p1') || '/alice-photo.jpg', '11111111-1111-1111-1111-111111111111', 'image/jpeg');
select tests.upload('attachments', tests.v('p1') || '/bob-notes.pdf',   '22222222-2222-2222-2222-222222222222', 'application/pdf');
select tests.upload('attachments', tests.v('p2') || '/bob-elsewhere.jpg','22222222-2222-2222-2222-222222222222', 'image/jpeg');
select tests.upload('attachments', tests.v('p1') || '/alice-site.jpg',  '11111111-1111-1111-1111-111111111111', 'image/jpeg');
select tests.upload('audio',       tests.v('p1') || '/alice-voice.m4a', '11111111-1111-1111-1111-111111111111', 'audio/mp4');
select tests.upload('attachments', tests.v('p1') || '/carol-photo.jpg', '33333333-3333-3333-3333-333333333333', 'image/jpeg');

-- ---------------------------------------------------------------------
-- Creating a variation order
-- ---------------------------------------------------------------------
select tests.auth_as('22222222-2222-2222-2222-222222222222');   -- bob, member

select lives_ok(
  format($$ select set_config('t.vo1', create_variation_order(
    %L, '  Move kitchen wall  ', 'Client (J. Tan)', 'Level 2, Unit 4', E'Shift 600mm east.\nKeep services.',
    jsonb_build_array(
      jsonb_build_object('kind','photo','path', %L),
      jsonb_build_object('kind','voice','path', %L, 'duration_ms', 12500)),
    participants => array['11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555']::uuid[])::text, true) $$,
    tests.v('p1'), tests.v('p1') || '/bob-photo-1.jpg', tests.v('p1') || '/bob-voice-1.m4a'),
  'member creates a VO with a photo and a voice note');

select is((select name from variation_orders where id = tests.v('vo1')), 'Move kitchen wall', 'name is trimmed');
select is((select number from variation_orders where id = tests.v('vo1')), 1, 'first VO is number 1');
select is((select sent_by from variation_orders where id = tests.v('vo1')),
  '22222222-2222-2222-2222-222222222222'::uuid, 'sent_by is the caller');
select is((select sent_at from variation_orders where id = tests.v('vo1')), now(), 'sent_at is set by the server');
select is((select description from variation_orders where id = tests.v('vo1')), E'Shift 600mm east.\nKeep services.',
  'multi-line description is kept');

select is((select count(*)::int from variation_order_attachments
           where variation_order_id = tests.v('vo1') and comment_id is null), 2,
  'both attachments belong to the VO itself');
select is((select array_agg(distinct uploaded_by) from variation_order_attachments
           where variation_order_id = tests.v('vo1')),
  array['22222222-2222-2222-2222-222222222222'::uuid], 'attachments record who uploaded them');
select is((select mime_type from variation_order_attachments
           where variation_order_id = tests.v('vo1') and kind = 'photo'), 'image/jpeg', 'MIME type comes from storage');
select is((select duration_ms from variation_order_attachments
           where variation_order_id = tests.v('vo1') and kind = 'voice'), 12500, 'voice duration is stored');
select is((select t.status from variation_order_attachments a join transcriptions t on t.attachment_id = a.id
           where a.variation_order_id = tests.v('vo1') and a.kind = 'voice'), 'pending',
  'voice note queues a transcription');
select ok((select t.variation_order_id = tests.v('vo1')
                  and t.requested_by = '22222222-2222-2222-2222-222222222222'
                  and t.audio_path = tests.v('p1') || '/bob-voice-1.m4a'
           from transcriptions t join variation_order_attachments a on a.id = t.attachment_id
           where a.variation_order_id = tests.v('vo1')),
  'the transcription belongs to the voice note and its VO');

select lives_ok(format($$ select set_config('t.vo2',
    create_variation_order(%L, 'Add skylight', 'Architect',
      participants => array['11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555']::uuid[])::text, true) $$, tests.v('p1')),
  'VO without attachments, location or description');
select is((select number from variation_orders where id = tests.v('vo2')), 2, 'numbers increase per project');

select throws_ok(format($$ select create_variation_order(%L, 'x', 'y', null, null,
    jsonb_build_array(jsonb_build_object('kind','photo','path', %L))) $$,
    tests.v('p1'), tests.v('p1') || '/alice-photo.jpg'),
  'P0002', null, 'cannot attach somebody else''s upload');
select throws_ok(format($$ select create_variation_order(%L, 'x', 'y', null, null,
    jsonb_build_array(jsonb_build_object('kind','photo','path', %L))) $$,
    tests.v('p1'), tests.v('p2') || '/bob-elsewhere.jpg'),
  '22023', null, 'cannot attach a file from another project');
select throws_ok(format($$ select create_variation_order(%L, 'x', 'y', null, null,
    jsonb_build_array(jsonb_build_object('kind','photo','path', %L))) $$,
    tests.v('p1'), tests.v('p1') || '/bob-notes.pdf'),
  '22023', null, 'photos must be images');
select throws_ok(format($$ select create_variation_order(%L, 'x', 'y', null, null,
    jsonb_build_array(jsonb_build_object('kind','photo','path', %L))) $$,
    tests.v('p1'), tests.v('p1') || '/bob-photo-1.jpg'),
  '23505', null, 'an upload can only be attached once');
select throws_ok(format($$ select create_variation_order(%L, 'x', 'y', null, null,
    '[{"kind":"video","path":"a"}]') $$, tests.v('p1')),
  '22023', null, 'unknown attachment kind is rejected');
select throws_ok(format($$ select create_variation_order(%L, '   ', 'y') $$, tests.v('p1')),
  '23514', null, 'blank name is rejected');
select throws_ok(format($$ select create_variation_order(%L, 'x', '<b>') $$, tests.v('p1')),
  '23514', null, 'angle brackets in requested_by are rejected');
select is((select max(number) from variation_orders where project_id = tests.v('p1')), 2,
  'failed calls leave no VO behind');

select tests.auth_as('33333333-3333-3333-3333-333333333333');   -- carol, guest
select throws_ok(format($$ select create_variation_order(%L, 'x', 'y') $$, tests.v('p1')),
  '42501', null, 'guests cannot create VOs');
select tests.auth_as('44444444-4444-4444-4444-444444444444');   -- dave, outsider
select throws_ok(format($$ select create_variation_order(%L, 'x', 'y') $$, tests.v('p1')),
  '42501', null, 'outsiders cannot create VOs');

-- ---------------------------------------------------------------------
-- The thread: comments with text, photos and voice notes
-- ---------------------------------------------------------------------
select tests.auth_as('11111111-1111-1111-1111-111111111111');   -- alice, owner
select lives_ok(format($$ select set_config('t.c1', post_variation_order_comment(%L,
    'Site photo attached, see voice note',
    jsonb_build_array(jsonb_build_object('kind','photo','path', %L),
                      jsonb_build_object('kind','voice','path', %L)))::text, true) $$,
    tests.v('vo1'), tests.v('p1') || '/alice-site.jpg', tests.v('p1') || '/alice-voice.m4a'),
  'owner comments with a photo and a voice note');
select is((select count(*)::int from variation_order_attachments
           where comment_id = tests.v('c1') and uploaded_by = '11111111-1111-1111-1111-111111111111'), 2,
  'comment attachments are tied to the comment and the uploader');
select throws_ok(format($$ select post_variation_order_comment(%L, '   ') $$, tests.v('vo1')),
  '22023', null, 'empty comment is rejected');

select tests.auth_as('22222222-2222-2222-2222-222222222222');   -- bob, member
select lives_ok(format($$ select set_config('t.c2', post_variation_order_comment(%L, 'Text only')::text, true) $$,
  tests.v('vo1')), 'member posts a text-only comment');

select tests.auth_as('33333333-3333-3333-3333-333333333333');   -- carol, guest
select throws_ok(format($$ select post_variation_order_comment(%L, 'hi') $$, tests.v('vo1')),
  '42501', null, 'guests cannot comment');
select throws_ok(format($$ select post_variation_order_comment(%L, null,
    jsonb_build_array(jsonb_build_object('kind','photo','path', %L))) $$,
    tests.v('vo1'), tests.v('p1') || '/carol-photo.jpg'),
  '42501', null, 'guests cannot add photos');
select is((select count(*)::int from transcriptions where variation_order_id = tests.v('vo1')), 2,
  'guest can read all transcriptions in the thread');
select is((select count(*)::int from storage.objects
           where bucket_id = 'audio' and name = tests.v('p1') || '/bob-voice-1.m4a'), 1,
  'guest can play voice notes in the thread');
select is((select display_name from profiles where id = '22222222-2222-2222-2222-222222222222'), 'Bob',
  'guest can see the name of the VO sender');

select tests.auth_as('55555555-5555-5555-5555-555555555555');   -- erin, viewer
select is((select count(*)::int from variation_orders where project_id = tests.v('p1')), 2, 'viewer reads VOs');
select is((select count(*)::int from variation_order_comments where variation_order_id = tests.v('vo1')), 2,
  'viewer reads the thread');
select is((select count(*)::int from storage.objects
           where bucket_id = 'attachments' and name = tests.v('p1') || '/alice-site.jpg'), 1,
  'viewer can read thread photos');
select throws_ok(format($$ select post_variation_order_comment(%L, 'hi') $$, tests.v('vo1')),
  '42501', null, 'viewers cannot comment');

select tests.auth_as('44444444-4444-4444-4444-444444444444');   -- dave, outsider
select is((select count(*)::int from variation_orders), 0, 'outsider sees no VOs');
select is((select count(*)::int from variation_order_attachments), 0, 'outsider sees no attachments');
select is((select count(*)::int from storage.objects where bucket_id = 'audio'), 0, 'outsider reads no voice notes');
select is((select count(*)::int from transcriptions), 0, 'outsider reads no transcriptions');

-- ---------------------------------------------------------------------
-- Editing and deleting
-- ---------------------------------------------------------------------
select tests.auth_as('11111111-1111-1111-1111-111111111111');   -- alice, owner (not the sender)
update variation_orders set location = 'Level 3' where id = tests.v('vo1');
select is((select location from variation_orders where id = tests.v('vo1')), 'Level 3', 'owner edits VO details');

select tests.auth_as('22222222-2222-2222-2222-222222222222');   -- bob, sender
select throws_ok(format($$ update variation_orders set sent_by = null where id = %L $$, tests.v('vo1')),
  '42501', null, 'sent_by cannot be changed');

select tests.auth_as('33333333-3333-3333-3333-333333333333');   -- carol
update variation_orders set name = 'hacked' where id = tests.v('vo1');
select is((select name from variation_orders where id = tests.v('vo1')), 'Move kitchen wall',
  'guests cannot edit VO details');

-- ---------------------------------------------------------------------
-- Nothing in a thread can be deleted
-- ---------------------------------------------------------------------
reset role;
select hasnt_function('public', 'delete_variation_order', 'no RPC deletes a VO');
select hasnt_function('public', 'delete_variation_order_comment', 'no RPC deletes a comment');
select hasnt_function('public', 'delete_variation_order_attachment', 'no RPC deletes an attachment');

select tests.auth_as('11111111-1111-1111-1111-111111111111');   -- alice, owner
select throws_ok(format($$ delete from variation_order_comments where id = %L $$, tests.v('c1')),
  '42501', null, 'even project owners cannot delete comments directly');

reset role;                                                      -- superuser, bypasses RLS like the service role
select throws_ok(format($$ delete from variation_order_attachments where comment_id = %L $$, tests.v('c1')),
  '42501', 'Variation order records cannot be deleted', 'privileged roles cannot delete attachments');
select throws_ok(format($$ delete from variation_orders where id = %L $$, tests.v('vo1')),
  '42501', 'Variation order records cannot be deleted', 'privileged roles cannot delete VOs');
select throws_ok(format($$ delete from transcriptions where variation_order_id = %L $$, tests.v('vo1')),
  '42501', 'Variation order records cannot be deleted', 'privileged roles cannot delete transcripts');

-- ---------------------------------------------------------------------
-- Deleting an account keeps everything that person put in threads
-- ---------------------------------------------------------------------
delete from auth.users where id = '22222222-2222-2222-2222-222222222222';   -- bob
select is((select count(*)::int from transcriptions where variation_order_id = tests.v('vo1')), 2,
  'transcripts survive account deletion');
select ok((select sent_by is null from variation_orders where id = tests.v('vo1')),
  'sent_by becomes NULL');
select is((select count(*)::int from variation_order_attachments
           where variation_order_id = tests.v('vo1') and comment_id is null and uploaded_by is null), 2,
  'the sender''s attachments survive, uploader NULL');
select ok((select bool_and(requested_by is null) from transcriptions
           where audio_path = tests.v('p1') || '/bob-voice-1.m4a'),
  'requested_by becomes NULL');

-- ---------------------------------------------------------------------
-- Transcription limits (30/user/hour, 50/user/project/day, 200/project/day) and the reaper
-- ---------------------------------------------------------------------
-- Creates n voice notes with transcripts in vid, requested by uid, `age` ago.
create function tests.fake_voice(vid uuid, uid uuid, n int, age interval, tag text) returns void
language sql as $$
  with a as (
    insert into public.variation_order_attachments
      (variation_order_id, project_id, uploaded_by, kind, storage_path, created_at)
    select vid, v.project_id, uid, 'voice', v.project_id || '/' || tag || g || '.m4a', now() - age
    from public.variation_orders v, generate_series(1, n) g
    where v.id = vid
    returning id, variation_order_id, project_id, storage_path)
  insert into public.transcriptions
    (project_id, variation_order_id, attachment_id, requested_by, audio_path, created_at)
  select project_id, variation_order_id, id, uid, storage_path, now() - age from a
$$;

-- alice already has 1 transcribed voice note this hour (her comment above): 28 more makes 29.
select tests.fake_voice(tests.v('vo1'), '11111111-1111-1111-1111-111111111111', 28, '0 minutes', 'h');
select tests.upload('audio', tests.v('p1') || '/alice-30.m4a', '11111111-1111-1111-1111-111111111111', 'audio/mp4');
select tests.upload('audio', tests.v('p1') || '/alice-31.m4a', '11111111-1111-1111-1111-111111111111', 'audio/mp4');
select tests.auth_as('11111111-1111-1111-1111-111111111111');
select lives_ok(format($$ select set_config('t.c30', post_variation_order_comment(%L, null,
    jsonb_build_array(jsonb_build_object('kind','voice','path', %L)))::text, true) $$,
    tests.v('vo1'), tests.v('p1') || '/alice-30.m4a'), '30th voice note this hour');
select lives_ok(format($$ select set_config('t.c31', post_variation_order_comment(%L, null,
    jsonb_build_array(jsonb_build_object('kind','voice','path', %L)))::text, true) $$,
    tests.v('vo1'), tests.v('p1') || '/alice-31.m4a'), 'voice note over the hourly limit is still posted');
reset role;
select is((select count(*)::int from transcriptions t join variation_order_attachments a on a.id = t.attachment_id
           where a.comment_id = tests.v('c30')), 1, 'the 30th voice note is transcribed');
select is((select count(*)::int from transcriptions t join variation_order_attachments a on a.id = t.attachment_id
           where a.comment_id = tests.v('c31')), 0, 'the 31st voice note is saved without a transcript');

select tests.fake_voice(tests.v('vo2'), '33333333-3333-3333-3333-333333333333', 50, '2 hours', 'd');
select throws_ok(format($$ select tests.fake_voice(%L, '33333333-3333-3333-3333-333333333333', 1, '0 minutes', 'd-over') $$,
    tests.v('vo2')),
  '54000', 'Transcription limit reached: 50 per user per project per day',
  'per-user-per-project daily cap trips at 50');

-- Fill the project to 200 with rows whose requester has deleted their account
-- (requested_by NULL never matches the per-user caps).
select tests.fake_voice(tests.v('vo2'), null, 200 - (select count(*)::int from transcriptions
  where project_id = tests.v('p1') and created_at > now() - interval '1 day'), '2 hours', 'f');
select throws_ok(format($$ select tests.fake_voice(%L, '44444444-4444-4444-4444-444444444444', 1, '0 minutes', 'p-over') $$,
    tests.v('vo2')),
  '54000', 'Transcription limit reached: 200 per project per day',
  'per-project daily cap trips at 200');

alter table transcriptions disable trigger transcriptions_set_updated_at;   -- it would reset updated_at
update transcriptions set status = 'processing', updated_at = now() - interval '1 hour'
where audio_path = tests.v('p1') || '/h1.m4a';
alter table transcriptions enable trigger transcriptions_set_updated_at;
update transcriptions set status = 'processing'
where audio_path = tests.v('p1') || '/h2.m4a';
select is((select private.reap_stuck_transcriptions()), 1, 'reaper fails exactly the stale job');
select is((select status || ': ' || error from transcriptions where audio_path = tests.v('p1') || '/h1.m4a'),
  'failed: Timed out while processing', 'stale job is marked failed with the timeout error');
select is((select status from transcriptions where audio_path = tests.v('p1') || '/h2.m4a'), 'processing',
  'fresh job is untouched');

-- Hard-deleting the whole project (the 30-day purge) still removes its threads.
select lives_ok(format($$ delete from projects where id = %L $$, tests.v('p1')),
  'purging a project cascades through its VOs');
select is((select count(*)::int from variation_orders where project_id = tests.v('p1')), 0,
  'the project''s VOs are gone with it');

select * from finish();
rollback;
