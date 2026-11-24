-- =====================================================================
-- Migration 0026: one per-project "role" replaces profession and contract role
-- Requires: 0018, 0019
-- =====================================================================
--
-- Before: three owner-set attributes per member.
--   job_role        profession, reference only (0018)
--   contract_role   qs | pm | contract_admin: lets the member confirm contract values (0019)
--   contract_party  which side of the contract they act for (0019)
--
-- After: two.
--   job_role        the member's role on the project (codes below). A fixed subset of roles can
--                   confirm contract values and verify deadline rules (private.can_confirm_contract),
--                   still only while the member's access (project_members.role) is owner or member.
--   contract_party  unchanged: decides who gets which deadline reminders. Grants nothing.
--
-- project_members.role (owner | member | guest | viewer) is unchanged and still decides what a
-- member can see.
--
-- Roles that can confirm: contract_admin, project_director, project_manager, quantity_surveyor.
-- Keep in sync with private.is_confirming_role() below and CONFIRMING_ROLES in
-- apps/mobile/src/lib/projects.ts.
--
-- Existing data (nothing is in production): a contract role becomes the matching confirming role
-- (so nobody loses confirm permission); otherwise the profession maps across. A member whose
-- profession was Project Manager / Quantity Surveyor / Project Director gains confirm permission.
-- Builder / Sub Contractor also fill an empty contract_party (contractor / subcontractor).

-- 1. New values for job_role.
alter table project_members drop constraint job_role_valid;

update project_members
set contract_party = coalesce(contract_party, case job_role
                                                when 'Builder' then 'contractor'
                                                when 'Sub Contractor' then 'subcontractor'
                                              end),
    job_role = coalesce(
      case contract_role
        when 'qs' then 'quantity_surveyor'
        when 'pm' then 'project_manager'
        when 'contract_admin' then 'contract_admin'
      end,
      case job_role
        when 'Administrator' then 'administrator'
        when 'Project Director' then 'project_director'
        when 'Project Manager' then 'project_manager'
        when 'Quantity Surveyor' then 'quantity_surveyor'
        when 'Builder' then 'trades'
        when 'Sub Contractor' then 'trades'
      end);

alter table project_members
  add constraint job_role_valid
    check (job_role is null
           or job_role in ('contract_admin','project_director','project_manager','quantity_surveyor',
                           'site_supervisor','engineer','trades','administrator'));


-- 2. Permission now comes from the role.
create function private.is_confirming_role(r text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(r in ('contract_admin','project_director','project_manager','quantity_surveyor'), false)
$$;

revoke execute on function private.is_confirming_role(text) from public, anon;
grant execute on function private.is_confirming_role(text) to authenticated, service_role;

create or replace function private.can_confirm_contract(pid uuid) returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (
    select 1
    from public.project_members m
    join public.projects p on p.id = m.project_id
    where m.project_id = pid
      and m.user_id = (select auth.uid())
      and m.left_at is null
      and p.deleted_at is null
      and m.role in ('owner','member')
      and private.is_confirming_role(m.job_role)
  )
$$;


-- 3. Owner-only setters. NULL clears the value.
create or replace function set_member_job_role(pid uuid, uid uuid, new_job_role text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_project_owner(pid) then
    raise exception 'Only project owners can change roles' using errcode = '42501';
  end if;
  if new_job_role is not null
     and new_job_role not in ('contract_admin','project_director','project_manager','quantity_surveyor',
                              'site_supervisor','engineer','trades','administrator') then
    raise exception 'Invalid role' using errcode = '22023';
  end if;

  update public.project_members
  set job_role = new_job_role
  where project_id = pid and user_id = uid and left_at is null;

  if not found then
    raise exception 'User is not an active member' using errcode = 'P0002';
  end if;
end $$;

drop function set_member_contract_profile(uuid, uuid, text, text);

create function set_member_contract_party(pid uuid, uid uuid, new_contract_party text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_project_owner(pid) then
    raise exception 'Only project owners can change contract parties' using errcode = '42501';
  end if;
  if new_contract_party is not null
     and new_contract_party not in ('employer','contract_admin','contractor','subcontractor','qs','consultant') then
    raise exception 'Invalid contract party' using errcode = '22023';
  end if;

  update public.project_members
  set contract_party = new_contract_party
  where project_id = pid and user_id = uid and left_at is null;

  if not found then
    raise exception 'User is not an active member' using errcode = 'P0002';
  end if;
end $$;

revoke execute on function set_member_contract_party(uuid, uuid, text) from public, anon;
grant execute on function set_member_contract_party(uuid, uuid, text) to authenticated;


-- 4. The old contract role is gone.
alter table project_members
  drop constraint contract_role_valid,
  drop column contract_role;
