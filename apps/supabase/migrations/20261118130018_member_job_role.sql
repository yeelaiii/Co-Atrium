-- =====================================================================
-- Migration 0018: profession (job_role) is per project, set by project owners
-- Requires: 0002, 0004, 0005, 0010
-- =====================================================================
--
-- Until now job_role lived on profiles: one profession per person, app-wide, picked by
-- the person at onboarding. A person can hold different jobs on different projects
-- (Project Manager on one, Quantity Surveyor on another), so it now lives on
-- project_members and the project's owners choose it.
--
-- job_role is for reference only. No policy, RPC or check reads it; permissions still come
-- from project_members.role alone.
--
-- Who can do what:
--   read:    anyone who can read the membership row (owner/member: whole roster,
--            guest/viewer: their own row), via the existing "read membership" policy.
--   set:     project owners, for any active member including themselves and other owners,
--            via set_member_job_role(). Writes to project_members stay RPC-only.
--
-- Existing data: each active and former membership starts with the profession the person
-- had picked on their profile, so nothing shown today disappears. Owners can change it.
-- A former member who rejoins keeps the profession they had on that project.

alter table project_members
  add column job_role text;

-- Same list as the old profiles.job_role_valid check (migration 0010).
alter table project_members
  add constraint job_role_valid
    check (job_role is null
           or job_role in ('Administrator','Project Director','Project Manager',
                           'Quantity Surveyor','Builder','Sub Contractor'));

-- The update doesn't change role or left_at, so the membership audit trigger logs nothing.
update project_members m
set job_role = p.job_role
from profiles p
where p.id = m.user_id
  and p.job_role is not null;

alter table profiles
  drop constraint job_role_valid,
  drop column job_role;   -- also drops its column-level update grant


-- Owner-only. new_job_role = null clears it.
create function set_member_job_role(pid uuid, uid uuid, new_job_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_project_owner(pid) then
    raise exception 'Only project owners can change professions' using errcode = '42501';
  end if;
  if new_job_role is not null
     and new_job_role not in ('Administrator','Project Director','Project Manager',
                              'Quantity Surveyor','Builder','Sub Contractor') then
    raise exception 'Invalid profession' using errcode = '22023';
  end if;

  update public.project_members
  set job_role = new_job_role
  where project_id = pid and user_id = uid and left_at is null;

  if not found then
    raise exception 'User is not an active member' using errcode = 'P0002';
  end if;
end $$;

revoke execute on function set_member_job_role(uuid, uuid, text) from public, anon;
grant execute on function set_member_job_role(uuid, uuid, text) to authenticated;
