-- =====================================================================
-- pgTAP suite #2: coverage for limits, invite lifecycle, soft-delete windows,
-- storage READ policies, maintenance functions and function privileges.
-- Self-contained (own helpers, own fixtures), rolled back at the end.
-- Run with:  supabase test db
--
-- Likely to expose real gaps if not already fixed:
--   * "authenticated cannot call private maintenance functions" (private.purge_soft_deleted
--     and private.reap_stuck_transcriptions must not be executable by authenticated/anon).
-- =====================================================================
begin;

create extension if not exists pgtap with schema extensions;

select plan(57);

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create schema tests;
grant usage on schema tests to anon, authenticated, service_role;

create function tests.alice() returns uuid language sql immutable as $$ select '11111111-1111-1111-1111-111111111111'::uuid $$;
create function tests.bob()   returns uuid language sql immutable as $$ select '22222222-2222-2222-2222-222222222222'::uuid $$;
create function tests.carol() returns uuid language sql immutable as $$ select '33333333-3333-3333-3333-333333333333'::uuid $$;
create function tests.dave()  returns uuid language sql immutable as $$ select '44444444-4444-4444-4444-444444444444'::uuid $$;
create function tests.erin()  returns uuid language sql immutable as $$ select '55555555-5555-5555-5555-555555555555'::uuid $$;
-- bulk filler users: deterministic uuids
create function tests.bulk(n int) returns uuid language sql immutable as
  $$ select ('aaaaaaaa-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;

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

create function tests.service() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role service_role;
end $$;

create function tests.clear() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end $$;

-- ---------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------
insert into auth.users (id, email) values
  (tests.alice(), 'alice@test.local'),
  (tests.bob(),   'bob@test.local'),
  (tests.carol(), 'carol@test.local'),
  (tests.dave(),  'dave@test.local'),
  (tests.erin(),  'erin@test.local');

insert into auth.users (id, email)
select tests.bulk(g), 'bulk' || g || '@test.local' from generate_series(1, 200) g;

-- =====================================================================
-- A. Base project p1: alice owner, bob member, carol guest, erin viewer
-- =====================================================================
select tests.auth_as(tests.alice());
select lives_ok($$select set_config('t.p1', public.create_project('Alpha')::text, true)$$,
  'setup: alice creates p1');
select lives_ok($$select set_config('t.inv_bob',
  public.invite_project_member(tests.v('p1'), tests.bob(), 'member')::text, true)$$, 'setup: invite bob');
select lives_ok($$select set_config('t.inv_carol',
  public.invite_project_member(tests.v('p1'), tests.carol(), 'guest')::text, true)$$, 'setup: invite carol');
select lives_ok($$select set_config('t.inv_erin',
  public.invite_project_member(tests.v('p1'), tests.erin(), 'viewer')::text, true)$$, 'setup: invite erin');
select tests.auth_as(tests.bob());
select lives_ok($$select public.accept_invite(tests.v('inv_bob'))$$, 'setup: bob accepts');
select tests.auth_as(tests.carol());
select lives_ok($$select public.accept_invite(tests.v('inv_carol'))$$, 'setup: carol accepts');
select tests.auth_as(tests.erin());
select lives_ok($$select public.accept_invite(tests.v('inv_erin'))$$, 'setup: erin accepts');

-- =====================================================================
-- B. Role management edge cases
-- =====================================================================
select tests.auth_as(tests.alice());
select throws_ok($$select public.set_member_role(tests.v('p1'), tests.bob(), 'bogus')$$,
  '22023', null, 'invalid role rejected');
select throws_ok($$select public.transfer_ownership(tests.v('p1'), tests.alice())$$,
  '22023', null, 'cannot transfer ownership to yourself');
select throws_ok($$select public.transfer_ownership(tests.v('p1'), tests.dave())$$,
  'P0002', null, 'cannot transfer ownership to a non-member');
select throws_ok($$select public.set_member_role(tests.v('p1'), tests.dave(), 'member')$$,
  'P0002', null, 'cannot set the role of a non-member');
select lives_ok($$select public.set_member_role(tests.v('p1'), tests.bob(), 'owner')$$,
  'owner can promote a member to co-owner');
select lives_ok($$select public.set_member_role(tests.v('p1'), tests.bob(), 'member')$$,
  'a co-owner can be demoted while another owner remains');
select tests.clear();
select ok(exists (select 1 from public.membership_events
                  where project_id = tests.v('p1') and user_id = tests.bob()
                    and event = 'role_changed'),
  'audit trail has a "role_changed" event');

-- =====================================================================
-- C. Invite expiry and revocation
-- =====================================================================
with i as (
  insert into public.project_invites (project_id, invited_user_id, invited_by, role, expires_at)
  values (tests.v('p1'), tests.dave(), tests.alice(), 'member', now() - interval '1 hour')
  returning id)
select set_config('t.inv_exp', id::text, true) from i;

select tests.auth_as(tests.dave());
select is((select count(*)::int from public.my_pending_invites()), 0,
  'expired invite is not listed as pending');
select throws_ok($$select public.accept_invite(tests.v('inv_exp'))$$, 'P0002',
  'Invite has expired', 'expired invite cannot be accepted');

select tests.auth_as(tests.alice());
select lives_ok($$select set_config('t.inv_dave2',
  public.invite_project_member(tests.v('p1'), tests.dave(), 'member')::text, true)$$,
  're-inviting clears the expired pending invite');
select tests.clear();
select is((select status from public.project_invites where id = tests.v('inv_exp')), 'revoked',
  'the expired invite was marked revoked');

select tests.auth_as(tests.dave());
select throws_ok($$select public.revoke_invite(tests.v('inv_dave2'))$$, 'P0002', null,
  'non-owner cannot revoke an invite');
select tests.auth_as(tests.alice());
select lives_ok($$select public.revoke_invite(tests.v('inv_dave2'))$$, 'owner revokes the invite');
select tests.clear();
select is((select status from public.project_invites where id = tests.v('inv_dave2')), 'revoked',
  'invite status is revoked');
select tests.auth_as(tests.dave());
select throws_ok($$select public.accept_invite(tests.v('inv_dave2'))$$, 'P0002', null,
  'revoked invite cannot be accepted');

-- =====================================================================
-- D. Soft-deleted project behaviour and the restore window (project p4, owned by bob)
-- =====================================================================
select tests.auth_as(tests.bob());
select lives_ok($$select set_config('t.p4', public.create_project('Delta')::text, true)$$,
  'bob creates p4');
select lives_ok($$select set_config('t.inv_dave4',
  public.invite_project_member(tests.v('p4'), tests.dave(), 'member')::text, true)$$,
  'bob invites dave to p4');
select lives_ok($$select public.delete_project(tests.v('p4'))$$, 'bob soft-deletes p4');
select is((select count(*)::int from public.projects where id = tests.v('p4')), 0,
  'a soft-deleted project is hidden');

select tests.auth_as(tests.dave());
select throws_ok($$select public.accept_invite(tests.v('inv_dave4'))$$, 'P0002',
  'Project is no longer available', 'cannot accept an invite to a soft-deleted project');
select is((select count(*)::int from public.my_pending_invites()), 0,
  'invites to soft-deleted projects are not listed');

select tests.auth_as(tests.bob());
select lives_ok($$select public.restore_project(tests.v('p4'))$$, 'bob restores p4 within the window');
select is((select count(*)::int from public.projects where id = tests.v('p4')), 1,
  'the project is visible again after restore');

select tests.clear();
update public.projects set deleted_at = now() - interval '31 days' where id = tests.v('p4');
select tests.auth_as(tests.bob());
select throws_ok($$select public.restore_project(tests.v('p4'))$$, 'P0002',
  'Project is not restorable', 'cannot restore a project past the 30-day window');

-- =====================================================================
-- E. Document restore window (purge is checked in section J)
-- =====================================================================
select tests.auth_as(tests.alice());
select lives_ok($$with d as (
    insert into public.documents (project_id, title) values (tests.v('p1'), 'old doc') returning id)
  select set_config('t.d_old', id::text, true) from d$$, 'alice creates d_old');
select lives_ok($$with d as (
    insert into public.documents (project_id, title) values (tests.v('p1'), 'recent doc') returning id)
  select set_config('t.d_recent', id::text, true) from d$$, 'alice creates d_recent');
select tests.clear();
update public.documents set deleted_at = now() - interval '31 days' where id = tests.v('d_old');
update public.documents set deleted_at = now() - interval '29 days' where id = tests.v('d_recent');
select tests.auth_as(tests.alice());
select throws_ok($$select public.restore_document(tests.v('d_old'))$$, 'P0002', null,
  'cannot restore a document past the 30-day window');

-- =====================================================================
-- G. Member cap (project p3, owned by alice)
-- =====================================================================
select tests.auth_as(tests.alice());
select lives_ok($$select set_config('t.p3', public.create_project('Gamma')::text, true)$$,
  'alice creates p3');

select tests.clear();
insert into public.project_invites (project_id, invited_user_id, role)
select tests.v('p3'), tests.bulk(g), 'member' from generate_series(1, 199) g;
select tests.auth_as(tests.alice());
select throws_ok($$select public.invite_project_member(tests.v('p3'), tests.dave(), 'member')$$,
  '54000', 'Member limit reached: 200 per project',
  'members + pending invites are capped at 200');

-- =====================================================================
-- H. Invite hourly cap (alice, p1) and project cap (50 per user)
-- =====================================================================
select tests.clear();
insert into public.project_invites (project_id, invited_user_id, invited_by, role)
select tests.v('p1'), tests.bulk(g), tests.alice(), 'member' from generate_series(1, 30) g;
select tests.auth_as(tests.alice());
select throws_ok($$select public.invite_project_member(tests.v('p1'), tests.dave(), 'member')$$,
  '54000', 'Invite limit reached: 30 per hour', 'invite hourly cap trips');

-- alice owns p1 and p3 so far: 48 more reaches 50 active projects
select lives_ok($$select public.create_project('Bulk ' || g) from generate_series(1, 48) g$$,
  'alice can create up to 50 active projects');
select throws_ok($$select public.create_project('one too many')$$,
  '54000', 'Project limit reached: 50 per user', 'project cap trips at 50');

-- =====================================================================
-- I. Storage READ policies (thread photos/voice are covered in variation_orders_test)
-- =====================================================================
select tests.clear();
insert into storage.objects (bucket_id, name, owner_id) values
  ('audio', tests.v('p1')::text || '/rec.m4a', tests.bob()::text);

select tests.auth_as(tests.bob());
select lives_ok($$insert into storage.objects (bucket_id, name, owner_id)
                  values ('attachments', tests.v('p1')::text || '/pending.png', tests.bob()::text)$$,
  'member uploads a pending attachment (not posted yet)');
select is((select count(*)::int from storage.objects
           where name = tests.v('p1')::text || '/pending.png'), 1,
  'uploader can read their own pending upload');
select tests.auth_as(tests.alice());
select is((select count(*)::int from storage.objects
           where name = tests.v('p1')::text || '/pending.png'), 0,
  'even the owner cannot read someone else''s unposted upload');
select tests.auth_as(tests.carol());
select is((select count(*)::int from storage.objects
           where name = tests.v('p1')::text || '/pending.png'), 0,
  'others cannot read someone else''s pending upload');
select tests.auth_as(tests.dave());
select is((select count(*)::int from storage.objects where bucket_id = 'attachments'), 0,
  'outsider reads no attachments');

select tests.auth_as(tests.bob());
select is((select count(*)::int from storage.objects where bucket_id = 'audio'), 1,
  'member can read audio');
select tests.auth_as(tests.carol());
select is((select count(*)::int from storage.objects where bucket_id = 'audio'), 0,
  'guest cannot read audio that is not in a thread');
select tests.auth_as(tests.erin());
select is((select count(*)::int from storage.objects where bucket_id = 'audio'), 0,
  'viewer cannot read audio that is not in a thread');

-- =====================================================================
-- J. Maintenance functions: privileges, reaper, purge
-- =====================================================================
select tests.auth_as(tests.bob());
select throws_ok($$select private.reap_stuck_transcriptions()$$, '42501', null,
  'authenticated cannot run the transcription reaper');
select throws_ok($$select private.purge_soft_deleted()$$, '42501', null,
  'authenticated cannot run the purge');
select tests.anon();
select throws_ok($$select private.purge_soft_deleted()$$, '42501', null,
  'anon cannot run the purge');

select tests.service();
select lives_ok($$select private.purge_soft_deleted()$$, 'service role can run the purge');
select tests.clear();
select is((select count(*)::int from public.documents where id = tests.v('d_old')), 0,
  'purge removes documents deleted more than 30 days ago');
select is((select count(*)::int from public.documents where id = tests.v('d_recent')), 1,
  'purge keeps documents inside the restore window');
select is((select count(*)::int from public.projects where id = tests.v('p4')), 0,
  'purge removes projects deleted more than 30 days ago');

select tests.auth_as(tests.alice());
select lives_ok($$select public.restore_document(tests.v('d_recent'))$$,
  'document inside the window is still restorable after purge');
select is((select count(*)::int from public.documents where id = tests.v('d_recent')), 1,
  'restored document is visible');

-- =====================================================================
-- K. Document cap (kept last: inserts 2000 rows)
-- =====================================================================
select tests.clear();
insert into public.documents (project_id, title, created_by)
select tests.v('p3'), 'doc ' || g, tests.alice() from generate_series(1, 2000) g;
select tests.auth_as(tests.alice());
select throws_ok($$insert into public.documents (project_id, title)
                   values (tests.v('p3'), 'one too many')$$,
  '54000', 'Document limit reached: 2000 per project', 'document cap trips at 2000');

select * from finish();
rollback;