-- =====================================================================
-- Migration 0004: RLS helper functions (private schema)
-- Requires: 0001, 0002
-- =====================================================================

-- =====================================================================
-- 5. RLS HELPERS (private schema, not exposed over the API)
-- =====================================================================

-- Single source of truth for "active member, project not deleted".
-- Set-returning so policies can use `project_id in (select private.my_projects())`,
-- which Postgres evaluates once per query instead of once per row.
create function private.my_projects(
  roles text[] default array['owner','member','guest','viewer']
) returns setof uuid
language sql security definer stable set search_path = '' as $$
  select m.project_id
  from public.project_members m
  join public.projects p on p.id = m.project_id
  where m.user_id = (select auth.uid())
    and m.role = any(roles)
    and m.left_at is null
    and p.deleted_at is null
$$;

-- Single-row checks (INSERT WITH CHECK, RPCs).
create function private.has_project_role(pid uuid, roles text[]) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(pid in (select private.my_projects(roles)), false)
$$;

create function private.is_project_member(pid uuid) returns boolean
language sql stable set search_path = '' as $$
  select private.has_project_role(pid, array['owner','member','guest','viewer'])
$$;

create function private.is_project_owner(pid uuid) returns boolean
language sql stable set search_path = '' as $$
  select private.has_project_role(pid, array['owner'])
$$;

-- Profile visibility:
--   * owner/member: any current or former member of a shared project
--     (so ex-members' names still resolve on old messages);
--   * guest/viewer: only authors of messages they are allowed to see.
create function private.shares_project_with(uid uuid) returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (
    select 1
    from public.project_members mine
    join public.projects p on p.id = mine.project_id
    where mine.user_id = (select auth.uid())
      and mine.left_at is null
      and p.deleted_at is null
      and (
        (mine.role in ('owner','member')
         and exists (select 1 from public.project_members theirs
                     where theirs.project_id = mine.project_id
                       and theirs.user_id = uid))
        or
        (mine.role in ('guest','viewer')
         and exists (select 1 from public.messages msg
                     where msg.project_id = mine.project_id
                       and msg.sender_id = uid
                       and msg.created_at >= mine.joined_at))
      )
  )
$$;



-- Helpers are used inside RLS policies evaluated as `authenticated`.
grant execute on function
  private.path_project_id(text),
  private.my_projects(text[]),
  private.has_project_role(uuid, text[]),
  private.is_project_member(uuid),
  private.is_project_owner(uuid),
  private.shares_project_with(uuid)
to authenticated;
