-- =====================================================================
-- Migration 0012: project location, type and client
-- Requires: 0002, 0005
-- =====================================================================

-- All optional: only the name is needed to start a project.
alter table projects
  add column location text,
  add column project_type text,
  add column client_name text;

alter table projects
  add constraint project_location_valid
    check (location is null
           or (char_length(location) between 1 and 160 and location !~ '[[:cntrl:]<>]')),
  add constraint project_client_valid
    check (client_name is null
           or (char_length(client_name) between 1 and 120 and client_name !~ '[[:cntrl:]<>]')),
  add constraint project_type_valid
    check (project_type is null
           or project_type in ('Residential','Commercial','Industrial','Institutional',
                               'Infrastructure','Mixed-use','Fit-out / Renovation','Other'));

-- New signature, so the one-argument version must go (two overloads would make
-- create_project('x') ambiguous). Existing callers keep working through the defaults.
drop function create_project(text);

create function create_project(
  project_name text,
  project_location text default null,
  type_of_project text default null,
  client text default null
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

  insert into public.projects (name, created_by, location, project_type, client_name)
  values (project_name,
          uid,
          nullif(btrim(project_location), ''),
          nullif(btrim(type_of_project), ''),
          nullif(btrim(client), ''))
  returning id into new_id;

  return new_id;
end $$;

grant execute on function create_project(text, text, text, text) to authenticated;
revoke execute on function create_project(text, text, text, text) from public, anon;
