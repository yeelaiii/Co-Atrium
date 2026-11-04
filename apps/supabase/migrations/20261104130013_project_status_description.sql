-- =====================================================================
-- Migration 0013: project status (ongoing / closed) and description
-- Requires: 0002, 0006, 0012
-- =====================================================================

-- Every existing project starts as ongoing.
alter table projects
  add column status text not null default 'ongoing',
  add column description text;

alter table projects
  add constraint project_status_valid
    check (status in ('ongoing','closed')),
  -- Multi-line text is fine; other control characters and angle brackets are not.
  add constraint project_description_valid
    check (description is null
           or (char_length(description) between 1 and 2000
               and description !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F<>]'));

-- Owners can close / reopen a project and edit its description
-- (the "owners rename project" update policy already limits updates to owners).
grant update (status, description) on projects to authenticated;

-- New signature, so the four-argument version must go (overloads would make
-- create_project('x') ambiguous). Existing callers keep working through the defaults.
drop function create_project(text, text, text, text);

create function create_project(
  project_name text,
  project_location text default null,
  type_of_project text default null,
  client text default null,
  project_description text default null
) returns uuid
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

  insert into public.projects (name, created_by, location, project_type, client_name, description)
  values (project_name,
          uid,
          nullif(btrim(project_location), ''),
          nullif(btrim(type_of_project), ''),
          nullif(btrim(client), ''),
          nullif(btrim(project_description), ''))
  returning id into new_id;

  return new_id;
end $$;

grant execute on function create_project(text, text, text, text, text) to authenticated;
revoke execute on function create_project(text, text, text, text, text) from public, anon;
