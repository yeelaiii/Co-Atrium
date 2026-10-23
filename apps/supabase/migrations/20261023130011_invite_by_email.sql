-- =====================================================================
-- Migration 0011: invite people to a project by email
-- Requires: 0002, 0003, 0005, 0006
-- =====================================================================

-- An invite targets either an existing user (invited_user_id) or an email that has
-- no confirmed account yet (invited_email). Email invites are attached to the user
-- once an account with that confirmed email exists.
alter table project_invites
  alter column invited_user_id drop not null,
  add column invited_email text,
  add constraint invite_has_one_target
    check (num_nonnulls(invited_user_id, invited_email) = 1),
  add constraint invited_email_valid
    check (invited_email is null
           or (invited_email = lower(invited_email)
               and char_length(invited_email) between 3 and 254
               and invited_email ~ '^[^@[:space:][:cntrl:]<>]+@[^@[:space:][:cntrl:]<>]+\.[^@[:space:][:cntrl:]<>]+$'));

create unique index one_pending_invite_per_email
  on project_invites (project_id, invited_email) where status = 'pending' and invited_email is not null;
create index on project_invites (invited_email) where status = 'pending' and invited_email is not null;


-- Attach pending email invites to a user whose email is confirmed.
create function private.claim_email_invites(uid uuid, user_email text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if user_email is null then return; end if;

  -- Drop invites that would collide with one the user already holds for the same project.
  update public.project_invites e
  set status = 'revoked', responded_at = now()
  where e.invited_email = lower(user_email) and e.status = 'pending'
    and exists (select 1 from public.project_invites u
                where u.project_id = e.project_id and u.invited_user_id = uid
                  and u.status = 'pending');

  update public.project_invites
  set invited_user_id = uid, invited_email = null
  where invited_email = lower(user_email) and status = 'pending';
end $$;
revoke execute on function private.claim_email_invites(uuid, text) from public, anon, authenticated;

-- Social-login users arrive confirmed; password users are confirmed by a later update.
-- Claiming only for confirmed emails stops someone signing up with an address they
-- do not own and collecting its invites.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  dn text;
begin
  dn := left(
    nullif(btrim(regexp_replace(
      coalesce(new.raw_user_meta_data->>'display_name', ''),
      '[[:cntrl:]<>]', '', 'g')), ''),
    80);
  insert into public.profiles (id, display_name) values (new.id, dn);
  if new.email_confirmed_at is not null then
    perform private.claim_email_invites(new.id, new.email);
  end if;
  return new;
end $$;

create function handle_user_confirmed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.claim_email_invites(new.id, new.email);
  return new;
end $$;
create trigger on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function handle_user_confirmed();


-- Owner-only. Behaves the same whether or not the address belongs to an account, so it
-- can't be used to probe which emails are registered.
create function invite_project_member_by_email(pid uuid, invitee_email text, member_role text default 'member')
returns void
language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := (select auth.uid());
  addr text := lower(btrim(invitee_email));
  uid uuid;
begin
  if not private.is_project_owner(pid) then
    raise exception 'Only project owners can invite members' using errcode = '42501';
  end if;
  if member_role not in ('member','guest','viewer') then
    raise exception 'Invalid invite role (promote to owner after joining)' using errcode = '22023';
  end if;
  if addr is null or char_length(addr) > 254
     or addr !~ '^[^@[:space:][:cntrl:]<>]+@[^@[:space:][:cntrl:]<>]+\.[^@[:space:][:cntrl:]<>]+$' then
    raise exception 'Enter a valid email address' using errcode = '22023';
  end if;

  select id into uid from auth.users
  where lower(email) = addr and email_confirmed_at is not null
  limit 1;

  if uid is not null then
    -- A recent decline is silently honoured so the response doesn't reveal the account.
    if exists (select 1 from public.project_invites
               where project_id = pid and invited_user_id = uid
                 and status = 'declined' and responded_at > now() - interval '30 days') then
      return;
    end if;
    perform public.invite_project_member(pid, uid, member_role);
    return;
  end if;

  if (select count(*) from public.project_invites
      where invited_by = caller and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Invite limit reached: 30 per hour' using errcode = '54000';
  end if;
  if (select count(*) from public.project_members
      where project_id = pid and left_at is null)
   + (select count(*) from public.project_invites
      where project_id = pid and status = 'pending' and expires_at > now()) >= 200 then
    raise exception 'Member limit reached: 200 per project' using errcode = '54000';
  end if;

  update public.project_invites
  set status = 'revoked', responded_at = now()
  where project_id = pid and invited_email = addr
    and status = 'pending' and expires_at <= now();

  insert into public.project_invites (project_id, invited_email, invited_by, role)
  values (pid, addr, caller, member_role)
  on conflict (project_id, invited_email) where status = 'pending' and invited_email is not null
  do update set role = excluded.role;       -- re-inviting a pending address just updates the role
end $$;


-- Owners can't read profiles of people who haven't joined, so give them the pending list directly.
create function project_pending_invites(pid uuid)
returns table (invite_id uuid, email text, role text, expires_at timestamptz)
language plpgsql security definer stable set search_path = '' as $$
begin
  if not private.is_project_owner(pid) then
    raise exception 'Only project owners can view invites' using errcode = '42501';
  end if;
  return query
    select i.id, coalesce(i.invited_email, u.email::text), i.role, i.expires_at
    from public.project_invites i
    left join auth.users u on u.id = i.invited_user_id
    where i.project_id = pid and i.status = 'pending' and i.expires_at > now()
    order by i.created_at desc;
end $$;

grant execute on function
  invite_project_member_by_email(uuid, text, text),
  project_pending_invites(uuid)
to authenticated;

revoke execute on function
  invite_project_member_by_email(uuid, text, text),
  project_pending_invites(uuid)
from public, anon;
