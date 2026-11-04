-- =====================================================================
-- Migration 0014: variation orders (one thread per variation order)
-- Requires: 0002, 0003, 0004, 0006, 0007, 0008, 0009, 0013
-- =====================================================================
--
-- A variation order (VO) belongs to a project and opens a thread:
--   variation_orders              the VO itself (name, location, requested by, sent by, time sent, description)
--   variation_order_comments      text messages posted in the thread
--   variation_order_attachments   photos and voice notes, each tied to the person who uploaded it.
--                                 comment_id NULL = attached to the VO when it was sent;
--                                 otherwise attached to that comment.
-- Voice notes get a row in `transcriptions` (existing pipeline). Transcriptions now belong to the
-- voice-note attachment and its VO, not to a user, so they survive account deletion.
--
-- Who can do what:
--   read the thread (VO, comments, photos, voice, transcripts):  owner, member, guest, viewer
--   create a VO:                                                  owner, member
--   comment / add photos and voice notes:                         owner, member  (guests and viewers read only)
--   edit VO details:                                              the sender (owner/member) or a project owner
--   delete anything:                                              nobody
--
-- Threads are a permanent record: VOs, comments, attachments and transcripts cannot be deleted, by
-- clients or by the service role. They only go when their whole project is hard-deleted.
--
-- All writes go through the RPCs below (they check uploads, number VOs and queue transcriptions
-- atomically). The only direct write is editing VO details, limited by column grant + policy.


-- =====================================================================
-- 1. TABLES
-- =====================================================================

create table variation_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  number integer not null,                   -- VO-1, VO-2 ... per project
  name text not null,
  location text,
  requested_by text not null,                -- free text: often the client or consultant, not an app user
  description text,
  sent_by uuid default auth.uid() references profiles(id) on delete set null,
  sent_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (project_id, number),
  unique (id, project_id),                   -- target for the composite FKs below

  constraint vo_number_positive check (number > 0),
  constraint vo_name_valid
    check (char_length(btrim(name)) between 1 and 160 and name !~ '[[:cntrl:]<>]'),
  constraint vo_location_valid
    check (location is null
           or (char_length(btrim(location)) between 1 and 160 and location !~ '[[:cntrl:]<>]')),
  constraint vo_requested_by_valid
    check (char_length(btrim(requested_by)) between 1 and 120 and requested_by !~ '[[:cntrl:]<>]'),
  -- Multi-line text is fine; other control characters and angle brackets are not.
  constraint vo_description_valid
    check (description is null
           or (char_length(description) between 1 and 4000
               and description !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F<>]'))
);

create table variation_order_comments (
  id uuid primary key default gen_random_uuid(),
  variation_order_id uuid not null,
  project_id uuid not null,
  author_id uuid default auth.uid() references profiles(id) on delete set null,
  body text,                                 -- NULL when the comment is only photos / voice notes
  created_at timestamptz not null default now(),

  foreign key (variation_order_id, project_id)
    references variation_orders (id, project_id) on delete cascade,
  unique (id, variation_order_id),

  constraint vo_comment_body_valid
    check (body is null
           or (char_length(btrim(body)) between 1 and 4000
               and body !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'))
);

create table variation_order_attachments (
  id uuid primary key default gen_random_uuid(),
  variation_order_id uuid not null,
  project_id uuid not null,
  comment_id uuid,
  uploaded_by uuid references profiles(id) on delete set null,
  kind text not null check (kind in ('photo','voice')),
  storage_path text not null,                -- 'attachments' bucket for photos, 'audio' for voice
  mime_type text,
  duration_ms integer,
  created_at timestamptz not null default now(),

  foreign key (variation_order_id, project_id)
    references variation_orders (id, project_id) on delete cascade,
  foreign key (comment_id, variation_order_id)
    references variation_order_comments (id, variation_order_id) on delete cascade,
  unique (id, variation_order_id),           -- target for transcriptions' FK

  constraint vo_attachment_path_valid
    check (private.path_project_id(storage_path) = project_id),
  constraint vo_attachment_voice_only
    check (kind = 'voice' or duration_ms is null),
  constraint vo_attachment_duration_valid
    check (duration_ms is null or duration_ms between 0 and 3600000),
  constraint vo_attachment_mime_valid
    check (mime_type is null or (char_length(mime_type) <= 100 and mime_type !~ '[[:cntrl:]<>]'))
);


-- ---- transcriptions: owned by a VO voice note instead of a user ----
-- Until now each row belonged to the requesting user (user_id, ON DELETE CASCADE), so
-- deleting an account deleted its transcripts. Rows now hang off the voice-note attachment
-- and its VO. requested_by is kept only for rate limits and is NULLed on account deletion.
-- No client or worker created transcriptions before this migration, so the table should be
-- empty; stop rather than guess what to do with rows that have no VO.
do $$
begin
  if exists (select 1 from public.transcriptions) then
    raise exception 'transcriptions has rows not tied to a variation order; move or remove them before applying 0014';
  end if;
end $$;

-- Clients no longer insert directly (only create_variation_order / post_variation_order_comment).
drop policy "staff read transcripts" on transcriptions;
drop policy "staff request transcripts" on transcriptions;
revoke insert (id, project_id, audio_path) on transcriptions from authenticated;
revoke insert on transcriptions from authenticated;

alter table transcriptions
  drop column user_id,
  add column variation_order_id uuid not null,
  add column attachment_id uuid not null,
  add column requested_by uuid references profiles(id) on delete set null,
  add constraint transcription_one_per_attachment unique (attachment_id),
  add constraint transcription_vo_fk
    foreign key (variation_order_id, project_id)
    references variation_orders (id, project_id) on delete cascade,
  add constraint transcription_attachment_fk
    foreign key (attachment_id, variation_order_id)
    references variation_order_attachments (id, variation_order_id) on delete cascade;

-- Same limits as before (30/user/hour, 50/user/project/day, 200/project/day),
-- now keyed on requested_by.
create or replace function limit_transcription_requests() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.requested_by is not null then
    perform pg_advisory_xact_lock(hashtextextended('tr-user:' || new.requested_by::text, 0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tr-project:' || new.project_id::text, 0));

  if (select count(*) from public.transcriptions
      where requested_by = new.requested_by
        and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Transcription limit reached: 30 per hour' using errcode = '54000';
  end if;

  if (select count(*) from public.transcriptions
      where requested_by = new.requested_by and project_id = new.project_id
        and created_at > now() - interval '1 day') >= 50 then
    raise exception 'Transcription limit reached: 50 per user per project per day'
      using errcode = '54000';
  end if;

  if (select count(*) from public.transcriptions
      where project_id = new.project_id
        and created_at > now() - interval '1 day') >= 200 then
    raise exception 'Transcription limit reached: 200 per project per day'
      using errcode = '54000';
  end if;

  return new;
end $$;


-- =====================================================================
-- 2. INDEXES
-- =====================================================================

create index on variation_orders (project_id, sent_at desc);
create index on variation_orders (sent_by, sent_at desc);                      -- FK, rate limit, profile lookup

create index on variation_order_comments (variation_order_id, created_at);
create index on variation_order_comments (project_id);                          -- realtime filter by project
create index on variation_order_comments (author_id, created_at desc);          -- FK, rate limit, profile lookup

create index on variation_order_attachments (variation_order_id, created_at);
create index on variation_order_attachments (comment_id) where comment_id is not null;
create index on variation_order_attachments (uploaded_by);                      -- FK, profile lookup
-- One attachment per stored object; also serves the storage read policies.
create unique index vo_attachment_object_unique
  on variation_order_attachments (kind, storage_path);

create index on transcriptions (variation_order_id, created_at);
create index on transcriptions (requested_by, created_at desc);                 -- FK, rate limit


-- =====================================================================
-- 3. TRIGGERS
-- =====================================================================

create trigger variation_orders_set_updated_at
before update on variation_orders
for each row execute function set_updated_at();

-- Soft limit (no lock), same as messages: 60/minute and 1000/hour per author.
create function limit_vo_comment_rate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.variation_order_comments
      where author_id = new.author_id
        and created_at > now() - interval '1 minute') >= 60 then
    raise exception 'Comment rate limit reached: 60 per minute' using errcode = '54000';
  end if;
  if (select count(*) from public.variation_order_comments
      where author_id = new.author_id
        and created_at > now() - interval '1 hour') >= 1000 then
    raise exception 'Comment rate limit reached: 1000 per hour' using errcode = '54000';
  end if;
  return new;
end $$;
create trigger vo_comments_rate_limit
before insert on variation_order_comments
for each row execute function limit_vo_comment_rate();

-- Permanent record: block every direct DELETE (service role included). Rows may only go
-- through the ON DELETE CASCADE from their project being hard-deleted (or from a parent
-- VO / comment in that same cascade). A cascade runs inside the FK trigger, so
-- pg_trigger_depth() > 1; a direct DELETE runs at depth 1.
create function prevent_vo_record_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  if pg_trigger_depth() <= 1 then
    raise exception 'Variation order records cannot be deleted' using errcode = '42501';
  end if;
  return old;
end $$;
create trigger variation_orders_no_delete
before delete on variation_orders
for each row execute function prevent_vo_record_delete();
create trigger vo_comments_no_delete
before delete on variation_order_comments
for each row execute function prevent_vo_record_delete();
create trigger vo_attachments_no_delete
before delete on variation_order_attachments
for each row execute function prevent_vo_record_delete();
create trigger transcriptions_no_delete
before delete on transcriptions
for each row execute function prevent_vo_record_delete();


-- =====================================================================
-- 4. RLS
-- =====================================================================

alter table variation_orders            enable row level security;
alter table variation_order_comments    enable row level security;
alter table variation_order_attachments enable row level security;

revoke all on variation_orders, variation_order_comments, variation_order_attachments
  from anon, authenticated;

-- Every active member of the project can read the whole thread.
create policy "members read variation orders" on variation_orders for select to authenticated
  using (project_id in (select private.my_projects()));

-- Sender (while still owner/member) or a project owner edits the details.
create policy "sender or owner edits variation order" on variation_orders for update to authenticated
  using ((project_id in (select private.my_projects(array['owner']))
              or (sent_by = (select auth.uid())
                  and project_id in (select private.my_projects(array['owner','member'])))));

create policy "members read vo comments" on variation_order_comments for select to authenticated
  using (project_id in (select private.my_projects()));

create policy "members read vo attachments" on variation_order_attachments for select to authenticated
  using (project_id in (select private.my_projects()));

-- Transcripts are part of the thread: every active member can read them.
-- No insert/update/delete for clients; only the service role (worker) updates status/transcript.
create policy "members read transcripts" on transcriptions for select to authenticated
  using (project_id in (select private.my_projects()));

grant select on variation_orders, variation_order_comments, variation_order_attachments
  to authenticated;
grant update (name, location, requested_by, description) on variation_orders to authenticated;


-- =====================================================================
-- 5. STORAGE
-- =====================================================================
-- Paths stay '<project id>/<file name>' (enforced by private.path_project_id); the
-- attachment row is what ties an object to a VO. Upload first, then call the RPC.

-- Photos: anyone who can see the attachment row can read the object.
create policy "attachments: read vo photos" on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and exists (select 1 from public.variation_order_attachments a
                where a.kind = 'photo' and a.storage_path = name)
  );

-- Voice: same, so guests and viewers can play voice notes in a thread.
-- Uploading audio stays staff only (policy from 0007).
create policy "audio: read vo voice notes" on storage.objects for select to authenticated
  using (
    bucket_id = 'audio'
    and exists (select 1 from public.variation_order_attachments a
                where a.kind = 'voice' and a.storage_path = name)
  );


-- =====================================================================
-- 6. PROFILE VISIBILITY
-- =====================================================================
-- Guests/viewers could only see profiles of message authors. They can now read whole
-- VO threads, so they also need the names of people who sent, commented or uploaded there.

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
         and (exists (select 1 from public.messages msg
                      where msg.project_id = mine.project_id
                        and msg.sender_id = uid
                        and msg.created_at >= mine.joined_at)
              or exists (select 1 from public.variation_orders vo
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


-- =====================================================================
-- 7. PRIVATE HELPERS (called only from the RPCs below)
-- =====================================================================

-- Attaches already-uploaded photos / voice notes to a VO (cid NULL) or to a comment.
-- `items` is a JSON array of {"kind":"photo"|"voice", "path":"<project id>/<file>", "duration_ms":1234?}.
-- Each object must exist in the right bucket and have been uploaded by the caller,
-- so nobody can claim another person's upload. The MIME type is taken from storage.
-- Voice notes queue a transcription; if the transcription quota is used up the voice
-- note is still saved, just without a transcript.
create function private.attach_vo_media(vid uuid, pid uuid, cid uuid, items jsonb)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  item jsonb;
  k text;
  p text;
  bkt text;
  mime text;
  dur integer;
  aid uuid;
  n integer := 0;
begin
  if items is null or items = 'null'::jsonb then
    return 0;
  end if;
  if jsonb_typeof(items) <> 'array' then
    raise exception 'attachments must be a JSON array' using errcode = '22023';
  end if;
  if jsonb_array_length(items) > 20 then
    raise exception 'Attachment limit reached: 20 per post' using errcode = '54000';
  end if;

  for item in select value from jsonb_array_elements(items) loop
    if jsonb_typeof(item) <> 'object' then
      raise exception 'Each attachment must be a JSON object' using errcode = '22023';
    end if;

    k := item->>'kind';
    p := item->>'path';
    if k = 'photo' then
      bkt := 'attachments';
    elsif k = 'voice' then
      bkt := 'audio';
    else
      raise exception 'Attachment kind must be photo or voice' using errcode = '22023';
    end if;

    if p is null or private.path_project_id(p) is distinct from pid then
      raise exception 'Attachment path must be <project id>/<file name> in this project'
        using errcode = '22023';
    end if;

    select o.metadata->>'mimetype' into mime
    from storage.objects o
    where o.bucket_id = bkt and o.name = p and o.owner_id = uid::text;
    if not found then
      raise exception 'Upload not found: %', p using errcode = 'P0002';
    end if;
    if k = 'photo' and (mime is null or mime not like 'image/%') then
      raise exception 'Photos must be image files' using errcode = '22023';
    end if;

    dur := null;
    if k = 'voice' and item ? 'duration_ms' and jsonb_typeof(item->'duration_ms') <> 'null' then
      if jsonb_typeof(item->'duration_ms') <> 'number' then
        raise exception 'duration_ms must be a number' using errcode = '22023';
      end if;
      dur := round((item->>'duration_ms')::numeric);     -- range checked by the table constraint
    end if;

    insert into public.variation_order_attachments
      (variation_order_id, project_id, comment_id, uploaded_by, kind,
       storage_path, mime_type, duration_ms)
    values (vid, pid, cid, uid, k, p, left(mime, 100), dur)
    returning id into aid;

    if k = 'voice' then
      begin
        insert into public.transcriptions
          (project_id, variation_order_id, attachment_id, requested_by, audio_path)
        values (pid, vid, aid, uid, p);
      exception when sqlstate '54000' then
        null;                                  -- over quota: keep the voice note, no transcript
      end;
    end if;

    n := n + 1;
  end loop;

  return n;
end $$;

revoke execute on function private.attach_vo_media(uuid, uuid, uuid, jsonb)
from public, anon, authenticated;


-- =====================================================================
-- 8. RPCs
--    Must be called with the CALLER's JWT, never the service role.
-- =====================================================================

-- Creates a VO (sent by the caller, now) with its photos and voice notes. Returns the VO id.
create function create_variation_order(
  pid uuid,
  vo_name text,
  vo_requested_by text,
  vo_location text default null,
  vo_description text default null,
  attachments jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  next_number integer;
  vid uuid;
begin
  if not private.has_project_role(pid, array['owner','member']) then
    raise exception 'Only project owners and members can create variation orders'
      using errcode = '42501';
  end if;

  if (select count(*) from public.variation_orders
      where sent_by = uid and sent_at > now() - interval '1 hour') >= 30 then
    raise exception 'Variation order limit reached: 30 per hour' using errcode = '54000';
  end if;

  -- Serialise numbering per project.
  perform pg_advisory_xact_lock(hashtextextended('vo-number:' || pid::text, 0));
  select coalesce(max(number), 0) + 1 into next_number
  from public.variation_orders where project_id = pid;

  insert into public.variation_orders
    (project_id, number, name, location, requested_by, description, sent_by)
  values (pid,
          next_number,
          btrim(vo_name),
          nullif(btrim(vo_location), ''),
          btrim(vo_requested_by),
          nullif(btrim(vo_description), ''),
          uid)
  returning id into vid;

  perform private.attach_vo_media(vid, pid, null, attachments);
  return vid;
end $$;

-- Posts to a VO thread: text, photos and/or voice notes (at least one). Returns the comment id.
create function post_variation_order_comment(
  vid uuid,
  comment_body text default null,
  attachments jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  pid uuid;
  b text := nullif(btrim(comment_body), '');
  cid uuid;
begin
  select project_id into pid from public.variation_orders where id = vid;
  if pid is null or not private.is_project_member(pid) then
    raise exception 'Variation order not found' using errcode = 'P0002';
  end if;
  if not private.has_project_role(pid, array['owner','member']) then
    raise exception 'Only project owners and members can post in variation orders'
      using errcode = '42501';
  end if;

  if b is null and not coalesce(jsonb_typeof(attachments) = 'array'
                                and jsonb_array_length(attachments) > 0, false) then
    raise exception 'Write a comment or add a photo or voice note' using errcode = '22023';
  end if;

  insert into public.variation_order_comments (variation_order_id, project_id, author_id, body)
  values (vid, pid, uid, b)
  returning id into cid;

  perform private.attach_vo_media(vid, pid, cid, attachments);
  return cid;
end $$;

grant execute on function
  create_variation_order(uuid, text, text, text, text, jsonb),
  post_variation_order_comment(uuid, text, jsonb)
to authenticated;

revoke execute on function
  create_variation_order(uuid, text, text, text, text, jsonb),
  post_variation_order_comment(uuid, text, jsonb)
from public, anon;

revoke execute on function
  public.limit_vo_comment_rate(),
  public.prevent_vo_record_delete()
from public, anon, authenticated;


-- =====================================================================
-- 9. REALTIME
-- =====================================================================
-- Threads update live. RLS filters per subscriber (both tables have it).
-- variation_order_attachments is deliberately NOT published: every attachment is written in
-- the same transaction as its comment (or its VO), so clients fetch attachments when that
-- row arrives. transcriptions is still not published either, so a transcript appearing
-- later needs a refetch.
do $$
declare
  t text;
begin
  foreach t in array array['variation_orders','variation_order_comments'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
