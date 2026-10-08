-- =====================================================================
-- Migration 0006: RLS policies and table grants
-- Requires: 0002, 0004
-- =====================================================================

-- =====================================================================
-- 7. ROW LEVEL SECURITY
-- =====================================================================


-- UPDATE policies omit WITH CHECK where it would equal USING (Postgres reuses USING).

-- profiles
create policy "read own or visible profiles" on profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_project_with(id));
create policy "update own profile" on profiles for update to authenticated
  using (id = (select auth.uid()));

-- projects (insert/delete only via RPCs)
create policy "members read projects" on projects for select to authenticated
  using (id in (select private.my_projects()));
create policy "owners rename project" on projects for update to authenticated
  using (private.is_project_owner(id));

-- project_members (writes only via RPCs)
-- owner/member see the whole roster; guest/viewer see only their own row.
create policy "read membership" on project_members for select to authenticated
  using (
    project_id in (select private.my_projects(array['owner','member']))
    or (user_id = (select auth.uid())
        and project_id in (select private.my_projects()))
  );

create policy "owners read membership events" on membership_events for select to authenticated
  using (project_id in (select private.my_projects(array['owner'])));

create policy "read invites" on project_invites for select to authenticated
  using (
    invited_user_id = (select auth.uid())
    or project_id in (select private.my_projects(array['owner']))
  );

-- messages: owner/member see all history; guest/viewer only since they joined.
-- Only owner/member/guest may post. Edits don't exist; deletes go through delete_message().
create policy "read messages" on messages for select to authenticated
  using (
    project_id in (select private.my_projects(array['owner','member']))
    or (
      project_id in (select private.my_projects(array['guest','viewer']))
      and exists (
        select 1 from public.project_members g
        where g.project_id = messages.project_id
          and g.user_id = (select auth.uid())
          and g.left_at is null
          and g.joined_at <= messages.created_at
      )
    )
  );
-- The sender_id check is redundant with the column grant but kept deliberately:
-- it's cheap, and it stops impersonation if sender_id is ever added to the grant.
create policy "writers send messages" on messages for insert to authenticated
  with check (private.has_project_role(project_id, array['owner','member','guest'])
              and sender_id = (select auth.uid()));

-- documents: internal only (owner/member). Add 'guest','viewer' to open up.
-- Updates and deletes only via update_document / delete_document / restore_document.
create policy "staff read docs" on documents for select to authenticated
  using (deleted_at is null
         and project_id in (select private.my_projects(array['owner','member'])));
create policy "staff create docs" on documents for insert to authenticated
  with check (private.has_project_role(project_id, array['owner','member'])
              and created_by = (select auth.uid()));

-- transcriptions: staff only (transcripts are as sensitive as the docs).
-- Requesting costs money, so guests can't trigger it.
-- No update policy: only the service role sets status/transcript/error.
create policy "staff read transcripts" on transcriptions for select to authenticated
  using (project_id in (select private.my_projects(array['owner','member'])));
create policy "staff request transcripts" on transcriptions for insert to authenticated
  with check (private.has_project_role(project_id, array['owner','member'])
              and user_id = (select auth.uid()));


-- =====================================================================
-- 8. TABLE GRANTS (least privilege: start from nothing)
-- =====================================================================


grant select on profiles, projects, project_members, membership_events,
                project_invites, messages, documents, transcriptions
  to authenticated;

grant update (display_name) on profiles to authenticated;
grant update (name)         on projects to authenticated;

grant insert (id, project_id, body, attachment_path) on messages       to authenticated;
grant insert (id, project_id, title, content)        on documents      to authenticated;
grant insert (id, project_id, audio_path)            on transcriptions to authenticated;


