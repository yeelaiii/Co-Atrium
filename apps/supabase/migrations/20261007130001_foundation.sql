-- =====================================================================
-- Migration 0001: foundation (schemas, default privileges, path validator)
-- Requires: nothing
-- =====================================================================

-- =====================================================================
-- 0. SCHEMAS AND DEFAULT PRIVILEGES
-- =====================================================================

-- `private` is not exposed by PostgREST: RLS helpers live here, not on /rest/v1/rpc.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- Future functions are non-executable until explicitly granted.
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges in schema private
  revoke execute on functions from public, anon, authenticated;

-- Future tables/sequences: nothing for anon, no unused privileges for authenticated.
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public
  revoke truncate, references, trigger on tables from authenticated;


-- =====================================================================
-- 1. PATH VALIDATION (no table dependencies, used by CHECK constraints)
-- =====================================================================

-- Returns the project uuid if `p` is exactly '<uuid>/<filename>', else NULL.
-- Rejects: bare uuid, empty or dot-leading filenames, extra '/' segments,
-- control characters, and anything over 512 chars.
create function private.path_project_id(p text) returns uuid
language sql immutable parallel safe set search_path = '' as $$
  select case
    when p is not null
     and char_length(p) <= 512
     and p ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/.][^/]*$'
     and p !~ '[[:cntrl:]]'
    then split_part(p, '/', 1)::uuid
  end
$$;


