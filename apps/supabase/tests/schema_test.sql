-- =====================================================================
-- pgTAP suite for the projects / messages / documents / transcriptions schema
-- Run with:  supabase test db        (place under supabase/tests/database/)
-- Everything runs in one transaction and is rolled back at the end.
--
-- NOTE: now() is constant inside a transaction, so "older" messages are
-- created by back-dating created_at as the superuser.
-- =====================================================================
begin;

create extension if not exists pgtap with schema extensions;

select plan(118);

-- ---------------------------------------------------------------------
-- Helpers (schema `tests`, dropped by the rollback)
-- ---------------------------------------------------------------------
create schema tests;
grant usage on schema tests to anon, authenticated;

create function tests.alice() returns uuid language sql immutable as $$ select '11111111-1111-1111-1111-111111111111'::uuid $$;
create function tests.bob()   returns uuid language sql immutable as $$ select '22222222-2222-2222-2222-222222222222'::uuid $$;
create function tests.carol() returns uuid language sql immutable as $$ select '33333333-3333-3333-3333-333333333333'::uuid $$;
create function tests.dave()  returns uuid language sql immutable as $$ select '44444444-4444-4444-4444-444444444444'::uuid $$;
create function tests.erin()  returns uuid language sql immutable as $$ select '55555555-5555-5555-5555-555555555555'::uuid $$;

-- Values captured during the run (project ids, invite ids, ...), stored as txn-local settings.
create function tests.v(k text) returns uuid language sql stable as $$ select current_setting('t.' || k)::uuid $$;

create function tests.auth_as(uid uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uid::text, true);
  set local role authenticated;
end $$;

create function tests.anon() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role anon;
end $$;

create function tests.clear() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- ---------------------------------------------------------------------
-- Fixtures: alice (owner), bob (member), carol (guest), erin (viewer), dave (outsider)
-- ---------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  (tests.alice(), 'alice@test.local', '{"display_name":"<Alice>"}'),
  (tests.bob(),   'bob@test.local',   json_build_object('display_name', repeat('x', 200))::jsonb),
  (tests.carol(), 'carol@test.local', '{}'),
  (tests.dave(),  'dave@test.local',  '{}'),
  (tests.erin(),  'erin@test.local',  '{}');

-- =====================================================================
-- 1. PROFILES: handle_new_user sanitises client-controlled metadata
-- =====================================================================
select is((select display_name from public.profiles where id = tests.alice()), 'Alice',
  'angle brackets are stripped from display_name');
select is((select char_length(display_name) from public.profiles where id = tests.bob()), 80,
  'display_name is capped at 80 chars');
select is((select display_name from public.profiles where id = tests.carol()), null,
  'missing display_name becomes NULL');

-- =====================================================================
-- 2. ANON is locked out
-- =====================================================================
select tests.anon();
select throws_ok($$select * from public.projects$$, '42501', null,
  'anon cannot read projects');
select throws_ok($$select public.create_project('x')$$, '42501', null,
  'anon cannot execute RPCs');

-- =====================================================================
-- 3. PROJECTS
-- =====================================================================
select tests.auth_as(tests.alice());
select lives_ok($$select set_config('t.p1', public.create_project('Alpha')::text, true)$$,
  'create_project works for a signed-in user');
select is((select role from public.project_members
           where project_id = tests.v('p1') and user_id = tests.alice()), 'owner',
  'creator is auto-added as owner');
select throws_ok($$select public.create_project('   ')$$, '23514', null,
  'blank project name rejected');
select throws_ok($$insert into public.projects (name) values ('direct')$$, '42501', null,
  'direct INSERT on projects is denied');
select lives_ok($$update public.projects set name = 'Alpha-2' where id = tests.v('p1')$$,
  'owner can rename (update runs)');
select is((select name from public.projects where id = tests.v('p1')), 'Alpha-2',
  'owner rename took effect');

-- A message that pre-dates every guest/viewer join
select lives_ok($$insert into public.messages (project_id, body)
                  values (tests.v('p1'), 'old message')$$,
  'owner can post a message');
select tests.clear();
update public.messages set created_at = now() - interval '1 day'
where project_id = tests.v('p1');

-- =====================================================================
-- 4. INVITES (consensual membership)
-- =====================================================================
select tests.auth_as(tests.alice());
select lives_ok($$select set_config('t.inv_bob',
  public.invite_project_member(tests.v('p1'), tests.bob(), 'member')::text, true)$$,
  'owner invites a member');
select lives_ok($$select set_config('t.inv_carol',
  public.invite_project_member(tests.v('p1'), tests.carol(), 'guest')::text, true)$$,
  'owner invites a guest');
select lives_ok($$select set_config('t.inv_erin',
  public.invite_project_member(tests.v('p1'), tests.erin(), 'viewer')::text, true)$$,
  'owner invites a viewer');
select throws_ok($$select public.invite_project_member(tests.v('p1'), tests.dave(), 'owner')$$,
  '22023', null, 'cannot invite directly as owner');

select tests.auth_as(tests.bob());
select is((select count(*)::int from public.my_pending_invites()), 1,
  'invitee sees exactly their pending invite');
select throws_ok($$select public.accept_invite(tests.v('inv_carol'))$$, 'P0002', null,
  'cannot accept someone else''s invite');
select lives_ok($$select public.accept_invite(tests.v('inv_bob'))$$, 'bob accepts');

select tests.auth_as(tests.carol());
select lives_ok($$select public.accept_invite(tests.v('inv_carol'))$$, 'carol accepts');
select tests.auth_as(tests.erin());
select lives_ok($$select public.accept_invite(tests.v('inv_erin'))$$, 'erin accepts');

select tests.auth_as(tests.bob());
select throws_ok($$select public.invite_project_member(tests.v('p1'), tests.dave(), 'member')$$,
  '42501', null, 'non-owner cannot invite');

select tests.auth_as(tests.alice());
select throws_ok($$select public.invite_project_member(tests.v('p1'), tests.bob(), 'member')$$,
  '23505', null, 'cannot invite an already-active member');
select is((select count(*)::int from public.project_members where project_id = tests.v('p1')), 4,
  'owner sees full roster (4 members)');

select tests.auth_as(tests.carol());
select is((select count(*)::int from public.project_members), 1,
  'guest only sees their own membership row');

select tests.auth_as(tests.dave());
select is((select count(*)::int from public.projects), 0,
  'outsider sees no projects');
select is((select count(*)::int from public.profiles where id = tests.alice()), 0,
  'outsider cannot see other profiles');

-- =====================================================================
-- 5. MESSAGES
-- =====================================================================
select tests.auth_as(tests.bob());
select lives_ok($$with m as (
    insert into public.messages (project_id, body)
    values (tests.v('p1'), 'hello from bob') returning id)
  select set_config('t.m_bob', id::text, true) from m$$,
  'member can post');

select tests.auth_as(tests.carol());
select lives_ok($$with m as (
    insert into public.messages (project_id, body)
    values (tests.v('p1'), 'hello from guest') returning id)
  select set_config('t.m_carol', id::text, true) from m$$,
  'guest can post');

select tests.auth_as(tests.erin());
select throws_ok($$insert into public.messages (project_id, body)
                   values (tests.v('p1'), 'viewer post')$$, '42501', null,
  'viewer cannot post');

select tests.auth_as(tests.dave());
select throws_ok($$insert into public.messages (project_id, body)
                   values (tests.v('p1'), 'outsider post')$$, '42501', null,
  'outsider cannot post');

select tests.auth_as(tests.alice());
select throws_ok($$insert into public.messages (project_id, sender_id, body)
                   values (tests.v('p1'), tests.bob(), 'spoof')$$, '42501', null,
  'sender_id cannot be spoofed');
select throws_ok($$insert into public.messages (project_id, body)
                   values (tests.v('p1'), '   ')$$, '23514', null,
  'empty message rejected');
select throws_ok($$insert into public.messages (project_id, body)
                   values (tests.v('p1'), repeat('a', 4001))$$, '23514', null,
  'body over 4000 chars rejected');
select throws_ok($$insert into public.messages (project_id, attachment_path)
                   values (tests.v('p1'), '00000000-0000-0000-0000-000000000000/x.png')$$,
  '23514', null, 'attachment path must belong to the same project');

select is((select count(*)::int from public.messages where project_id = tests.v('p1')), 3,
  'owner sees full history');
select tests.auth_as(tests.bob());
select is((select count(*)::int from public.messages where project_id = tests.v('p1')), 3,
  'member sees full history');
select tests.auth_as(tests.carol());
select is((select count(*)::int from public.messages where project_id = tests.v('p1')), 2,
  'guest only sees messages since joining');
select tests.auth_as(tests.erin());
select is((select count(*)::int from public.messages where project_id = tests.v('p1')), 2,
  'viewer only sees messages since joining');
select tests.auth_as(tests.dave());
select is((select count(*)::int from public.messages where project_id = tests.v('p1')), 0,
  'outsider sees no messages');

select tests.auth_as(tests.carol());
select is((select count(*)::int from public.profiles where id = tests.bob()), 1,
  'guest can see profile of a visible message author');
select is((select count(*)::int from public.profiles where id = tests.alice()), 0,
  'guest cannot see profile of an author whose messages pre-date them');

-- =====================================================================
-- 6. DOCUMENTS (staff only, optimistic concurrency)
-- =====================================================================
select tests.auth_as(tests.bob());
select lives_ok($$with d as (
    insert into public.documents (project_id, title, content)
    values (tests.v('p1'), 'Spec', '{"a":1}') returning id)
  select set_config('t.d1', id::text, true) from d$$,
  'member can create a document');
select throws_ok($$insert into public.documents (project_id, title)
                   values (tests.v('p1'), '   ')$$, '23514', null,
  'blank document title rejected');
select is((select public.update_document(tests.v('d1'), 1, 'Spec v2')), 2,
  'update_document bumps the version');
select throws_ok($$select public.update_document(tests.v('d1'), 1, 'stale')$$, '40001', null,
  'stale version raises 40001');
select throws_ok($$update public.documents set title = 'x' where id = tests.v('d1')$$,
  '42501', null, 'direct UPDATE on documents denied');

select tests.auth_as(tests.carol());
select is((select count(*)::int from public.documents where project_id = tests.v('p1')), 0,
  'guest cannot read documents');
select throws_ok($$insert into public.documents (project_id, title)
                   values (tests.v('p1'), 'guest doc')$$, '42501', null,
  'guest cannot create documents');

select tests.auth_as(tests.bob());
select throws_ok($$select public.delete_document(tests.v('d1'))$$, 'P0002', null,
  'member cannot delete a document');

select tests.auth_as(tests.alice());
select lives_ok($$select public.delete_document(tests.v('d1'))$$, 'owner soft-deletes a document');
select is((select count(*)::int from public.documents where id = tests.v('d1')), 0,
  'soft-deleted document is hidden');
select lives_ok($$select public.restore_document(tests.v('d1'))$$, 'owner restores the document');
select is((select count(*)::int from public.documents where id = tests.v('d1')), 1,
  'restored document is visible again');

-- =====================================================================
-- 7. TRANSCRIPTIONS (staff only, rate limited)
-- =====================================================================
select tests.auth_as(tests.bob());
select lives_ok($$insert into public.transcriptions (project_id, audio_path)
                  values (tests.v('p1'), tests.v('p1')::text || '/a.m4a')$$,
  'member can request a transcription');
select throws_ok($$insert into public.transcriptions (project_id, audio_path)
                   values (tests.v('p1'), '00000000-0000-0000-0000-000000000000/a.m4a')$$,
  '23514', null, 'audio path must belong to the project');
select throws_ok($$update public.transcriptions set status = 'done'$$, '42501', null,
  'clients cannot set transcription status');

select tests.auth_as(tests.carol());
select throws_ok($$insert into public.transcriptions (project_id, audio_path)
                   values (tests.v('p1'), tests.v('p1')::text || '/g.m4a')$$, '42501', null,
  'guest cannot request transcriptions');
select is((select count(*)::int from public.transcriptions), 0,
  'guest cannot read transcriptions');

select tests.clear();
insert into public.transcriptions (project_id, user_id, audio_path)
select tests.v('p1'), tests.bob(), tests.v('p1')::text || '/bulk' || g || '.m4a'
from generate_series(1, 29) g;
select tests.auth_as(tests.bob());
select throws_ok($$insert into public.transcriptions (project_id, audio_path)
                   values (tests.v('p1'), tests.v('p1')::text || '/over.m4a')$$,
  '54000', 'Transcription limit reached: 30 per hour',
  'transcription hourly rate limit trips at 30');

-- =====================================================================
-- 8. LAST-OWNER PROTECTION
-- =====================================================================
select tests.auth_as(tests.alice());
select throws_ok($$select public.leave_project(tests.v('p1'))$$, 'P0001',
  'A project must keep at least one owner', 'last owner cannot leave');
select throws_ok($$select public.remove_member(tests.v('p1'), tests.alice())$$, 'P0001',
  'A project must keep at least one owner', 'last owner cannot be removed');
select throws_ok($$select public.set_member_role(tests.v('p1'), tests.alice(), 'member')$$, 'P0001',
  'A project must keep at least one owner', 'last owner cannot be demoted');

select tests.auth_as(tests.bob());
select throws_ok($$select public.remove_member(tests.v('p1'), tests.carol())$$, '42501', null,
  'non-owner cannot remove members');

-- =====================================================================
-- 9. DECLINED INVITES
-- =====================================================================
select tests.auth_as(tests.alice());
select lives_ok($$select set_config('t.inv_dave',
  public.invite_project_member(tests.v('p1'), tests.dave(), 'member')::text, true)$$,
  'owner invites dave');
select tests.auth_as(tests.dave());
select lives_ok($$select public.decline_invite(tests.v('inv_dave'))$$, 'dave declines');
select tests.auth_as(tests.alice());
select throws_ok($$select public.invite_project_member(tests.v('p1'), tests.dave(), 'member')$$,
  '54000', 'This user recently declined an invite to this project',
  'cannot re-invite someone who recently declined');

-- =====================================================================
-- 10. OWNERSHIP TRANSFER + LEAVE / REJOIN + AUDIT TRAIL
-- =====================================================================
select lives_ok($$select public.transfer_ownership(tests.v('p1'), tests.bob())$$,
  'owner transfers ownership');
select tests.clear();
select is((select role from public.project_members
           where project_id = tests.v('p1') and user_id = tests.alice()), 'member',
  'old owner is demoted');
select is((select role from public.project_members
           where project_id = tests.v('p1') and user_id = tests.bob()), 'owner',
  'new owner is promoted');

select tests.auth_as(tests.alice());
select lives_ok($$select public.leave_project(tests.v('p1'))$$, 'ex-owner can now leave');
select tests.auth_as(tests.bob());
select lives_ok($$select set_config('t.inv_alice',
  public.invite_project_member(tests.v('p1'), tests.alice(), 'member')::text, true)$$,
  'new owner re-invites alice');
select tests.auth_as(tests.alice());
select lives_ok($$select public.accept_invite(tests.v('inv_alice'))$$, 'alice rejoins');

select tests.clear();
select ok(exists (select 1 from public.membership_events
                  where project_id = tests.v('p1') and user_id = tests.alice() and event = 'left'),
  'audit trail has a "left" event');
select ok(exists (select 1 from public.membership_events
                  where project_id = tests.v('p1') and user_id = tests.alice() and event = 'rejoined'),
  'audit trail has a "rejoined" event');

-- =====================================================================
-- 11. GUEST RE-JOIN ONLY SEES NEW MESSAGES
-- =====================================================================
select tests.auth_as(tests.bob());
select lives_ok($$select public.remove_member(tests.v('p1'), tests.carol())$$,
  'owner removes the guest');
select tests.auth_as(tests.carol());
select is((select count(*)::int from public.messages where project_id = tests.v('p1')), 0,
  'removed guest sees nothing');

select tests.clear();
update public.messages set created_at = now() - interval '1 hour'
where project_id = tests.v('p1');

select tests.auth_as(tests.bob());
select lives_ok($$select set_config('t.inv_carol2',
  public.invite_project_member(tests.v('p1'), tests.carol(), 'guest')::text, true)$$,
  'owner re-invites the guest');
select tests.auth_as(tests.carol());
select lives_ok($$select public.accept_invite(tests.v('inv_carol2'))$$, 'guest rejoins');
select is((select count(*)::int from public.messages where project_id = tests.v('p1')), 0,
  'rejoined guest does not see pre-rejoin history');
select lives_ok($$insert into public.messages (project_id, body)
                  values (tests.v('p1'), 'back again')$$, 'rejoined guest can post');
select is((select count(*)::int from public.messages where project_id = tests.v('p1')), 1,
  'rejoined guest sees only the new message');

-- =====================================================================
-- 12. delete_message (tombstone)
-- =====================================================================
select tests.auth_as(tests.erin());
select throws_ok($$select public.delete_message(tests.v('m_bob'))$$, '42501', null,
  'viewer cannot delete messages');
select tests.auth_as(tests.alice());
select throws_ok($$select public.delete_message(tests.v('m_bob'))$$, '42501', null,
  'non-sender non-owner cannot delete');
select tests.auth_as(tests.bob());
select lives_ok($$select public.delete_message(tests.v('m_bob'))$$, 'sender deletes own message');
select tests.clear();
select ok((select body is null and attachment_path is null and deleted_at is not null
           from public.messages where id = tests.v('m_bob')),
  'message is tombstoned and scrubbed');
select tests.auth_as(tests.bob());
select throws_ok($$select public.delete_message(tests.v('m_bob'))$$, 'P0002', null,
  'deleting twice raises not-found');
select lives_ok($$select public.delete_message(tests.v('m_carol'))$$,
  'owner can delete another member''s message');

-- =====================================================================
-- 13. DIRECT WRITES ARE DENIED
-- =====================================================================
select throws_ok($$delete from public.messages$$, '42501', null,
  'DELETE on messages denied');
select throws_ok($$update public.project_members set role = 'owner'
                   where user_id = tests.carol()$$, '42501', null,
  'direct UPDATE on project_members denied');
select throws_ok($$insert into public.project_members (project_id, user_id, role)
                   values (tests.v('p1'), tests.dave(), 'member')$$, '42501', null,
  'direct INSERT on project_members denied');

-- =====================================================================
-- 14. MESSAGE RATE LIMIT (kept late: pollutes the message table)
-- =====================================================================
select tests.clear();
insert into public.messages (project_id, sender_id, body)
select tests.v('p1'), tests.alice(), 'bulk ' || g from generate_series(1, 60) g;
select tests.auth_as(tests.alice());
select throws_ok($$insert into public.messages (project_id, body)
                   values (tests.v('p1'), 'one too many')$$,
  '54000', 'Message rate limit reached: 60 per minute',
  'message rate limit trips at 60/minute');

-- =====================================================================
-- 15. SOFT DELETE, RESTORE, ACCOUNT DELETION, PURGE
-- =====================================================================
select tests.auth_as(tests.dave());
select lives_ok($$select set_config('t.p2', public.create_project('Beta')::text, true)$$,
  'dave creates a second project');
select tests.auth_as(tests.alice());
select throws_ok($$select public.delete_project(tests.v('p2'))$$, '42501', null,
  'non-owner cannot delete a project');
select tests.auth_as(tests.dave());
select lives_ok($$select public.delete_project(tests.v('p2'))$$, 'owner soft-deletes project');
select is((select count(*)::int from public.projects where id = tests.v('p2')), 0,
  'soft-deleted project is hidden');
select lives_ok($$select public.restore_project(tests.v('p2'))$$, 'owner restores project');
select is((select count(*)::int from public.projects where id = tests.v('p2')), 1,
  'restored project is visible');

select tests.clear();
select throws_ok($$delete from auth.users where id = tests.dave()$$, 'P0001',
  'A project must keep at least one owner',
  'deleting the sole owner of an active project is blocked');
select tests.auth_as(tests.dave());
select lives_ok($$select public.delete_project(tests.v('p2'))$$, 'dave soft-deletes the project');
select tests.clear();
select lives_ok($$delete from auth.users where id = tests.dave()$$,
  'account deletion succeeds once the project is soft-deleted');
select ok((select created_by is null from public.projects where id = tests.v('p2')),
  'created_by is anonymised to NULL');

update public.projects set deleted_at = now() - interval '31 days' where id = tests.v('p2');
select private.purge_soft_deleted();
select is((select count(*)::int from public.projects where id = tests.v('p2')), 0,
  'purge hard-deletes projects past the retention window');

-- =====================================================================
-- 16. PATH VALIDATOR
-- =====================================================================
select is(private.path_project_id(tests.v('p1')::text || '/a.png'), tests.v('p1'),
  'valid path returns the project uuid');
select ok(private.path_project_id(tests.v('p1')::text) is null, 'bare uuid rejected');
select ok(private.path_project_id(tests.v('p1')::text || '/../x') is null, 'path traversal rejected');
select ok(private.path_project_id(tests.v('p1')::text || '/.hidden') is null, 'dot-leading filename rejected');
select ok(private.path_project_id(tests.v('p1')::text || '/a/b') is null, 'extra segments rejected');
select ok(private.path_project_id(tests.v('p1')::text || '/a' || chr(9) || 'b') is null,
  'control characters rejected');
select ok(private.path_project_id(tests.v('p1')::text || '/' || repeat('a', 600)) is null,
  'over-long path rejected');

-- =====================================================================
-- 17. STORAGE POLICIES (insert policies; depends on your Storage version's columns)
-- =====================================================================
select tests.auth_as(tests.bob());
select lives_ok($$insert into storage.objects (bucket_id, name, owner_id)
                  values ('attachments', tests.v('p1')::text || '/x1.png', tests.bob()::text)$$,
  'member can upload an attachment to their project');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id)
                   values ('attachments', '00000000-0000-0000-0000-000000000000/x.png',
                           tests.bob()::text)$$, '42501', null,
  'cannot upload into another project''s folder');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id)
                   values ('attachments', tests.v('p1')::text, tests.bob()::text)$$, '42501', null,
  'bare uuid path denied');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id)
                   values ('attachments', tests.v('p1')::text || '/../x', tests.bob()::text)$$,
  '42501', null, 'path traversal denied');
select lives_ok($$insert into storage.objects (bucket_id, name, owner_id)
                  values ('audio', tests.v('p1')::text || '/a1.m4a', tests.bob()::text)$$,
  'staff can upload audio');

select tests.auth_as(tests.erin());
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id)
                   values ('attachments', tests.v('p1')::text || '/v.png', tests.erin()::text)$$,
  '42501', null, 'viewer cannot upload attachments');

select tests.auth_as(tests.carol());
select lives_ok($$insert into storage.objects (bucket_id, name, owner_id)
                  values ('attachments', tests.v('p1')::text || '/g.png', tests.carol()::text)$$,
  'guest can upload attachments');
select throws_ok($$insert into storage.objects (bucket_id, name, owner_id)
                   values ('audio', tests.v('p1')::text || '/g.m4a', tests.carol()::text)$$,
  '42501', null, 'guest cannot upload audio');

select * from finish();
rollback;