-- =====================================================================
-- Migration 0007: storage buckets and policies
-- Requires: 0004
-- =====================================================================

-- =====================================================================
-- 10. STORAGE
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  -- mime types left open here: tighten to what your app actually accepts, and
  -- serve downloads with Content-Disposition: attachment (no inline HTML/SVG).
  ('attachments', 'attachments', false, 26214400, null),
  ('audio', 'audio', false, 52428800,
     array['audio/mpeg','audio/mp4','audio/x-m4a','audio/wav','audio/webm','audio/ogg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- No UPDATE/DELETE policies: clients can't overwrite or delete objects, so use unique
-- file names. Orphan cleanup and purge on delete_message()/project purge is done with
-- the service role.
--
-- Reads of attachments mirror message visibility exactly (including the guest
-- "since joined" rule); uploaders can read their own pending upload while still members.
-- Signed URLs outlive membership: issue them with short expiry (e.g. 60s) per request.

create policy "attachments: read visible" on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and (
      (owner_id = (select auth.uid())::text
       and private.path_project_id(name) in (select private.my_projects()))
      or exists (select 1 from public.messages m where m.attachment_path = name)
    )
  );

create policy "attachments: writers upload" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and private.path_project_id(name)
        in (select private.my_projects(array['owner','member','guest']))
  );

create policy "audio: staff read" on storage.objects for select to authenticated
  using (
    bucket_id = 'audio'
    and private.path_project_id(name) in (select private.my_projects(array['owner','member']))
  );

create policy "audio: staff upload" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'audio'
    and private.path_project_id(name) in (select private.my_projects(array['owner','member']))
  );