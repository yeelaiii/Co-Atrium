-- =====================================================================
-- Migration 0019: contract role and contract party per project member
-- Requires: 0002, 0004, 0018
-- =====================================================================
--
-- Two per-project attributes for the contracts and deadlines feature, both set by project owners:
--
--   contract_role    qs | pm | contract_admin | NULL
--                    Grants permission to confirm extracted contract values and verify deadline
--                    rules (private.can_confirm_contract). Only counts while the member's role is
--                    owner or member: a guest or viewer with a contract_role still can't confirm.
--   contract_party   employer | contract_admin | contractor | subcontractor | qs | consultant | NULL
--                    Which side of the contract this person acts for. Reminders for an obligation
--                    go to members of the responsible party; "waiting on them" messages go to
--                    members of the recipient party. Grants nothing.
--
-- job_role (0018) stays reference only.

alter table project_members
  add column contract_role text,
  add column contract_party text,
  add constraint contract_role_valid
    check (contract_role is null or contract_role in ('qs','pm','contract_admin')),
  add constraint contract_party_valid
    check (contract_party is null
           or contract_party in ('employer','contract_admin','contractor','subcontractor','qs','consultant'));


-- Can the caller confirm contract fields / verify rules on this project?
create function private.can_confirm_contract(pid uuid) returns boolean
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
      and m.contract_role is not null
  )
$$;

revoke execute on function private.can_confirm_contract(uuid) from public, anon;
grant execute on function private.can_confirm_contract(uuid) to authenticated, service_role;


-- Owner-only. NULL clears the value.
create function set_member_contract_profile(
  pid uuid, uid uuid, new_contract_role text, new_contract_party text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_project_owner(pid) then
    raise exception 'Only project owners can change contract roles' using errcode = '42501';
  end if;
  if new_contract_role is not null and new_contract_role not in ('qs','pm','contract_admin') then
    raise exception 'Invalid contract role' using errcode = '22023';
  end if;
  if new_contract_party is not null
     and new_contract_party not in ('employer','contract_admin','contractor','subcontractor','qs','consultant') then
    raise exception 'Invalid contract party' using errcode = '22023';
  end if;

  update public.project_members
  set contract_role = new_contract_role, contract_party = new_contract_party
  where project_id = pid and user_id = uid and left_at is null;

  if not found then
    raise exception 'User is not an active member' using errcode = 'P0002';
  end if;
end $$;

revoke execute on function set_member_contract_profile(uuid, uuid, text, text) from public, anon;
grant execute on function set_member_contract_profile(uuid, uuid, text, text) to authenticated;
