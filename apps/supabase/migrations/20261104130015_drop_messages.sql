-- =====================================================================
-- Migration 0015: remove project chat (messages)
-- Requires: 0002, 0003, 0004, 0005, 0006, 0007, 0009, 0014
-- =====================================================================
--
-- Conversation now happens in variation order threads, so the project-wide
-- `messages` table and everything built on it goes.
--
-- WARNING: this permanently deletes every chat message. Files that were attached to
-- messages stay in the 'attachments' bucket (SQL cannot remove storage objects) and are
-- only readable by whoever uploaded them; purge them with the service role if unwanted.


-- ---- storage: the attachment read rule looked up messages ----
drop policy "attachments: read visible" on storage.objects;

-- Uploaders can still read their own upload (e.g. to preview it before posting).
-- Photos in threads are readable through "attachments: read vo photos" (0014).
create policy "attachments: uploader reads own" on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and owner_id = (select auth.uid())::text
    and private.path_project_id(name) in (select private.my_projects())
  );

-- Guests could upload only so they could attach files to chat messages. They can't post
-- in threads, so uploads are owner/member only, matching the 'audio' bucket.
drop policy "attachments: writers upload" on storage.objects;
create policy "attachments: staff upload" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and private.path_project_id(name) in (select private.my_projects(array['owner','member']))
  );


-- ---- profile visibility: drop the message-author rule ----
create or replace function private.shares_project_with(uid uuid) returns boolean
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
         and (exists (select 1 from public.variation_orders vo
                      where vo.project_id = mine.project_id
                        and vo.sent_by = uid)
              or exists (select 1 from public.variation_order_comments c
                         where c.project_id = mine.project_id
                           and c.author_id = uid)
              or exists (select 1 from public.variation_order_attachments a
                         where a.project_id = mine.project_id
                           and a.uploaded_by = uid)))
      )
  )
$$;


-- ---- the table and its functions ----
-- Dropping the table also removes its policies, indexes, rate-limit trigger and its
-- entry in the supabase_realtime publication.
drop function delete_message(uuid);
drop table messages;
drop function limit_message_rate();
