-- =====================================================================
-- Migration 0005: public RPCs
-- Requires: 0002, 0003, 0004
-- =====================================================================

-- =====================================================================
-- 6. RPCs (the only write paths for these actions)
--    Must be called with the CALLER's JWT, never the service role.
-- =====================================================================

-- ---- projects ----

create function create_project(project_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('proj-create:' || uid::text, 0));
  if (select count(*) from public.projects
      where created_by = uid and deleted_at is null) >= 50 then
    raise exception 'Project limit reached: 50 per user' using errcode = '54000';
  end if;

  insert into public.projects (name, created_by)
  values (project_name, uid)
  returning id into new_id;

  return new_id;
end $$;

create function delete_project(pid uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_project_owner(pid) then
    raise exception 'Only project owners can delete a project' using errcode = '42501';
  end if;
  update public.projects set deleted_at = now()
  where id = pid and deleted_at is null;
end $$;

-- Restore window: 30 days (matches private.purge_soft_deleted default).
-- Checks membership directly because the helpers hide deleted projects.
create function restore_project(pid uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.project_members
    where project_id = pid
      and user_id = (select auth.uid())
      and role = 'owner'
      and left_at is null
  ) then
    raise exception 'Only project owners can restore a project' using errcode = '42501';
  end if;

  update public.projects set deleted_at = null
  where id = pid
    and deleted_at is not null
    and deleted_at > now() - interval '30 days';

  if not found then
    raise exception 'Project is not restorable' using errcode = 'P0002';
  end if;
end $$;

-- ---- membership: invite / accept / manage ----

create function invite_project_member(pid uuid, uid uuid, member_role text default 'member')
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  inv_id uuid;
begin
  if not private.is_project_owner(pid) then
    raise exception 'Only project owners can invite members' using errcode = '42501';
  end if;
  if member_role not in ('member','guest','viewer') then
    raise exception 'Invalid invite role (promote to owner after joining)' using errcode = '22023';
  end if;

  if exists (select 1 from public.project_members
             where project_id = pid and user_id = uid and left_at is null) then
    raise exception 'User is already an active member' using errcode = '23505';
  end if;

  -- anti-spam
  if (select count(*) from public.project_invites
      where invited_by = caller and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Invite limit reached: 30 per hour' using errcode = '54000';
  end if;
  if exists (select 1 from public.project_invites
             where project_id = pid and invited_user_id = uid
               and status = 'declined' and responded_at > now() - interval '30 days') then
    raise exception 'This user recently declined an invite to this project'
      using errcode = '54000';
  end if;
  if (select count(*) from public.project_members
      where project_id = pid and left_at is null)
   + (select count(*) from public.project_invites
      where project_id = pid and status = 'pending' and expires_at > now()) >= 200 then
    raise exception 'Member limit reached: 200 per project' using errcode = '54000';
  end if;

  -- clear an expired pending invite so the unique index doesn't block a fresh one
  update public.project_invites
  set status = 'revoked', responded_at = now()
  where project_id = pid and invited_user_id = uid
    and status = 'pending' and expires_at <= now();

  insert into public.project_invites (project_id, invited_user_id, invited_by, role)
  values (pid, uid, caller, member_role)
  returning id into inv_id;

  return inv_id;
end $$;

create function revoke_invite(invite_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  pid uuid;
begin
  select project_id into pid from public.project_invites where id = invite_id;
  if pid is null or not private.is_project_owner(pid) then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;
  update public.project_invites
  set status = 'revoked', responded_at = now()
  where id = invite_id and status = 'pending';
end $$;

create function accept_invite(invite_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  inv public.project_invites;
begin
  select * into inv
  from public.project_invites
  where id = invite_id
    and invited_user_id = (select auth.uid())
    and status = 'pending'
  for update;

  if not found then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;
  if inv.expires_at <= now() then
    raise exception 'Invite has expired' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.projects
                 where id = inv.project_id and deleted_at is null) then
    raise exception 'Project is no longer available' using errcode = 'P0002';
  end if;

  insert into public.project_members (project_id, user_id, role)
  values (inv.project_id, inv.invited_user_id, inv.role)
  on conflict (project_id, user_id) do update      -- re-joining a former member
    set role = excluded.role, left_at = null, joined_at = now()
    where public.project_members.left_at is not null;

  if not found then
    raise exception 'User is already an active member' using errcode = '23505';
  end if;

  update public.project_invites
  set status = 'accepted', responded_at = now()
  where id = invite_id;
end $$;

create function decline_invite(invite_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.project_invites
  set status = 'declined', responded_at = now()
  where id = invite_id
    and invited_user_id = (select auth.uid())
    and status = 'pending';
  if not found then
    raise exception 'Invite not found' using errcode = 'P0002';
  end if;
end $$;

-- Invitees are not members yet, so they can't read the project directly.
create function my_pending_invites()
returns table (invite_id uuid, project_id uuid, project_name text,
               role text, invited_by_name text, expires_at timestamptz)
language sql security definer stable set search_path = '' as $$
  select i.id, i.project_id, p.name, i.role, pr.display_name, i.expires_at
  from public.project_invites i
  join public.projects p on p.id = i.project_id and p.deleted_at is null
  left join public.profiles pr on pr.id = i.invited_by
  where i.invited_user_id = (select auth.uid())
    and i.status = 'pending'
    and i.expires_at > now()
$$;

create function set_member_role(pid uuid, uid uuid, new_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_project_owner(pid) then
    raise exception 'Only project owners can change roles' using errcode = '42501';
  end if;
  if new_role not in ('owner','member','guest','viewer') then
    raise exception 'Invalid role' using errcode = '22023';
  end if;

  update public.project_members
  set role = new_role
  where project_id = pid and user_id = uid and left_at is null;   -- keep_one_owner guards demotion

  if not found then
    raise exception 'User is not an active member' using errcode = 'P0002';
  end if;
end $$;

create function remove_member(pid uuid, uid uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_project_owner(pid) then
    raise exception 'Only project owners can remove members' using errcode = '42501';
  end if;

  update public.project_members
  set left_at = now()
  where project_id = pid and user_id = uid and left_at is null;   -- keep_one_owner guards last owner

  if not found then
    raise exception 'User is not an active member' using errcode = 'P0002';
  end if;
end $$;

create function leave_project(pid uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.project_members m
  set left_at = now()
  from public.projects p
  where m.project_id = pid
    and m.user_id = (select auth.uid())
    and m.left_at is null
    and p.id = m.project_id
    and p.deleted_at is null;                 -- keep_one_owner blocks the last owner

  if not found then
    raise exception 'You are not an active member of this project' using errcode = 'P0002';
  end if;
end $$;

-- Promote the new owner first, then demote the caller (never zero owners).
create function transfer_ownership(pid uuid, new_owner uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
begin
  if not private.is_project_owner(pid) then
    raise exception 'Only project owners can transfer ownership' using errcode = '42501';
  end if;
  if new_owner = caller then
    raise exception 'Choose a different user' using errcode = '22023';
  end if;

  update public.project_members
  set role = 'owner'
  where project_id = pid and user_id = new_owner and left_at is null;
  if not found then
    raise exception 'New owner must be an active member' using errcode = 'P0002';
  end if;

  update public.project_members
  set role = 'member'
  where project_id = pid and user_id = caller and left_at is null;
end $$;

-- ---- messages ----

-- Tombstones the message (sender or project owner). Returns the attachment path
-- that was removed so the caller's Edge Function can purge the storage object.
create function delete_message(mid uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  msg public.messages;
  uid uuid := (select auth.uid());
begin
  select * into msg from public.messages where id = mid for update;

  if not found or msg.deleted_at is not null then
    raise exception 'Message not found' using errcode = 'P0002';
  end if;

  if not (
       (msg.sender_id = uid
        and private.has_project_role(msg.project_id, array['owner','member','guest']))
       or private.is_project_owner(msg.project_id)
     ) then
    raise exception 'Not allowed to delete this message' using errcode = '42501';
  end if;

  update public.messages
  set body = null, attachment_path = null, deleted_at = now()
  where id = mid;

  return msg.attachment_path;
end $$;

-- ---- documents ----

-- Optimistic concurrency: caller passes the version it loaded; a stale write fails.
create function update_document(
  did uuid, expected_version integer,
  new_title text default null, new_content jsonb default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  pid uuid;
  v integer;
begin
  select project_id into pid from public.documents where id = did and deleted_at is null;
  if pid is null or not private.has_project_role(pid, array['owner','member']) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;

  update public.documents
  set title = coalesce(new_title, title),
      content = coalesce(new_content, content),
      updated_by = (select auth.uid())
  where id = did and version = expected_version and deleted_at is null
  returning version into v;

  if not found then
    raise exception 'Document was modified by someone else; reload and retry'
      using errcode = '40001';
  end if;
  return v;
end $$;

create function delete_document(did uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  pid uuid;
begin
  select project_id into pid from public.documents where id = did and deleted_at is null;
  if pid is null or not private.is_project_owner(pid) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  update public.documents set deleted_at = now() where id = did;
end $$;

create function restore_document(did uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  pid uuid;
begin
  select project_id into pid from public.documents
  where id = did and deleted_at is not null and deleted_at > now() - interval '30 days';
  if pid is null or not private.is_project_owner(pid) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  update public.documents set deleted_at = null where id = did;
end $$;



-- RPCs: signed-in users only
grant execute on function
  create_project(text),
  delete_project(uuid),
  restore_project(uuid),
  invite_project_member(uuid, uuid, text),
  revoke_invite(uuid),
  accept_invite(uuid),
  decline_invite(uuid),
  my_pending_invites(),
  set_member_role(uuid, uuid, text),
  remove_member(uuid, uuid),
  leave_project(uuid),
  transfer_ownership(uuid, uuid),
  delete_message(uuid),
  update_document(uuid, integer, text, jsonb),
  delete_document(uuid),
  restore_document(uuid)
to authenticated;


revoke execute on function
  create_project(text), delete_project(uuid), restore_project(uuid),
  invite_project_member(uuid, uuid, text), revoke_invite(uuid),
  accept_invite(uuid), decline_invite(uuid), my_pending_invites(),
  set_member_role(uuid, uuid, text), remove_member(uuid, uuid),
  leave_project(uuid), transfer_ownership(uuid, uuid), delete_message(uuid),
  update_document(uuid, integer, text, jsonb), delete_document(uuid),
  restore_document(uuid)
from public, anon;