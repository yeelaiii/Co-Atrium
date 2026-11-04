-- =====================================================================
-- Migration 0017: variation orders are private to the people included in them
-- Requires: 0004, 0014, 0015, 0016
-- =====================================================================
--
-- Until now every active project member could read every VO thread. Now the sender
-- chooses who is included:
--   variation_order_participants   who can see a VO: the sender, the people they include,
--                                  and everyone asked to approve (approvers are always included)
--
-- Who can do what:
--   read a VO and its thread:   participants who are still active members of the project.
--                               Project owners are NOT included automatically.
--   include more people:        the sender (still owner/member) or a project owner who is a participant
--   post / approve:             as before (owner/member, approver), and only on VOs they can see
--   be included:                any active member (guests and viewers read only, as before)
--
-- VOs that existed before this migration were visible to the whole project, so their current
-- members are included, and nobody loses access to a thread they could already read.
-- VO numbers stay per project, so people may see gaps (VO-1, VO-3) for VOs not shared with them.


-- =====================================================================
-- 1. TABLE
-- =====================================================================

create table variation_order_participants (
  id uuid primary key default gen_random_uuid(),
  variation_order_id uuid not null,
  project_id uuid not null,
  user_id uuid not null references profiles(id) on delete cascade,
  added_by uuid default auth.uid() references profiles(id) on delete set null,
  created_at timestamptz not null default now(),

  foreign key (variation_order_id, project_id)
    references variation_orders (id, project_id) on delete cascade,
  unique (variation_order_id, user_id)
);

create index on variation_order_participants (user_id, variation_order_id);   -- RLS helper
create index on variation_order_participants (project_id);                     -- realtime filter
create index on variation_order_participants (added_by);                       -- FK

-- Backfill: existing VOs stay visible to everyone who could see them, plus their sender.
insert into variation_order_participants (variation_order_id, project_id, user_id, added_by, created_at)
select vo.id, vo.project_id, m.user_id, vo.sent_by, vo.sent_at
from variation_orders vo
join project_members m on m.project_id = vo.project_id and m.left_at is null
on conflict (variation_order_id, user_id) do nothing;

insert into variation_order_participants (variation_order_id, project_id, user_id, added_by, created_at)
select vo.id, vo.project_id, vo.sent_by, vo.sent_by, vo.sent_at
from variation_orders vo
where vo.sent_by is not null
on conflict (variation_order_id, user_id) do nothing;

insert into variation_order_participants (variation_order_id, project_id, user_id, added_by, created_at)
select a.variation_order_id, a.project_id, a.user_id, a.added_by, a.created_at
from variation_order_approvers a
where a.user_id is not null
on conflict (variation_order_id, user_id) do nothing;


-- =====================================================================
-- 2. RLS HELPER
-- =====================================================================

-- VOs the caller can see: they are a participant AND still an active member of the
-- (not deleted) project. Set-returning so policies evaluate it once per query.
create function private.my_variation_orders() returns setof uuid
language sql security definer stable set search_path = '' as $$
  select p.variation_order_id
  from public.variation_order_participants p
  where p.user_id = (select auth.uid())
    and p.project_id in (select private.my_projects())
$$;

create function private.can_see_vo(vid uuid) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(vid in (select private.my_variation_orders()), false)
$$;

revoke execute on function private.my_variation_orders(), private.can_see_vo(uuid)
from public, anon;
grant execute on function private.my_variation_orders(), private.can_see_vo(uuid)
to authenticated;


-- =====================================================================
-- 3. POLICIES: project membership -> VO participation
-- =====================================================================

alter table variation_order_participants enable row level security;
revoke all on variation_order_participants from anon, authenticated;
grant select on variation_order_participants to authenticated;

create policy "participants read vo participants" on variation_order_participants
  for select to authenticated
  using (variation_order_id in (select private.my_variation_orders()));

drop policy "members read variation orders" on variation_orders;
create policy "participants read variation orders" on variation_orders for select to authenticated
  using (id in (select private.my_variation_orders()));

-- Same rule as before (sender while owner/member, or a project owner), but only on VOs they can see.
drop policy "sender or owner edits variation order" on variation_orders;
create policy "sender or owner edits variation order" on variation_orders for update to authenticated
  using (id in (select private.my_variation_orders())
         and (project_id in (select private.my_projects(array['owner']))
              or (sent_by = (select auth.uid())
                  and project_id in (select private.my_projects(array['owner','member'])))));

drop policy "members read vo comments" on variation_order_comments;
create policy "participants read vo comments" on variation_order_comments for select to authenticated
  using (variation_order_id in (select private.my_variation_orders()));

drop policy "members read vo attachments" on variation_order_attachments;
create policy "participants read vo attachments" on variation_order_attachments for select to authenticated
  using (variation_order_id in (select private.my_variation_orders()));

drop policy "members read vo approvers" on variation_order_approvers;
create policy "participants read vo approvers" on variation_order_approvers for select to authenticated
  using (variation_order_id in (select private.my_variation_orders()));

drop policy "members read transcripts" on transcriptions;
create policy "participants read transcripts" on transcriptions for select to authenticated
  using (variation_order_id in (select private.my_variation_orders()));

-- Storage: a VO's photos and voice notes are readable by that VO's participants only.
drop policy "attachments: read vo photos" on storage.objects;
create policy "attachments: read vo photos" on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and exists (select 1 from public.variation_order_attachments a
                where a.kind = 'photo' and a.storage_path = name
                  and a.variation_order_id in (select private.my_variation_orders()))
  );

-- 0007 let every owner/member read every audio file in the project, which would expose
-- voice notes from VOs they are not in. Like photos (0015), uploaders can still read their
-- own upload (e.g. to replay it before posting); everything else goes through the VO rule.
drop policy "audio: staff read" on storage.objects;
create policy "audio: uploader reads own" on storage.objects for select to authenticated
  using (
    bucket_id = 'audio'
    and owner_id = (select auth.uid())::text
    and private.path_project_id(name) in (select private.my_projects(array['owner','member']))
  );

drop policy "audio: read vo voice notes" on storage.objects;
create policy "audio: read vo voice notes" on storage.objects for select to authenticated
  using (
    bucket_id = 'audio'
    and exists (select 1 from public.variation_order_attachments a
                where a.kind = 'voice' and a.storage_path = name
                  and a.variation_order_id in (select private.my_variation_orders()))
  );


-- =====================================================================
-- 4. PROFILE VISIBILITY
-- =====================================================================
-- Guests/viewers also need the names of the other people included in their VOs.

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
                           and a.uploaded_by = uid)
              or exists (select 1 from public.variation_order_approvers ap
                         where ap.project_id = mine.project_id
                           and ap.user_id = uid)
              or exists (select 1 from public.variation_order_participants vp
                         where vp.project_id = mine.project_id
                           and vp.user_id = uid)))
      )
  )
$$;


-- =====================================================================
-- 5. PRIVATE HELPERS
-- =====================================================================

-- Includes people in a VO. Each must be an active member of the project (any role).
-- Returns the user ids that were newly added. With `notify`, they get a push saying the
-- VO was shared with them (approvers get the approval push from add_vo_approvers instead).
create function private.add_vo_participants(vid uuid, pid uuid, uids uuid[], notify boolean)
returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  vo record;
  added uuid[];
  adder_name text;
begin
  if uids is null or cardinality(uids) = 0 then
    return '{}';
  end if;
  if cardinality(uids) > 200 then
    raise exception 'Participant limit reached: 200 per variation order' using errcode = '54000';
  end if;

  if exists (
    select 1 from unnest(uids) as u(id)
    where u.id is null
       or not exists (select 1 from public.project_members m
                      where m.project_id = pid and m.user_id = u.id and m.left_at is null)
  ) then
    raise exception 'Everyone included must be a member of this project' using errcode = '22023';
  end if;

  with ins as (
    insert into public.variation_order_participants (variation_order_id, project_id, user_id, added_by)
    select vid, pid, u.id, uid from (select distinct id from unnest(uids) as x(id)) u
    on conflict (variation_order_id, user_id) do nothing
    returning user_id
  )
  select coalesce(array_agg(user_id), '{}') into added from ins;

  if notify and cardinality(added) > 0 then
    select number, name into vo from public.variation_orders where id = vid;
    select display_name into adder_name from public.profiles where id = uid;
    perform private.push_to_users(
      added,
      'VO-' || vo.number || ' shared with you',
      coalesce(adder_name, 'Someone') || ' included you in "' || vo.name || '".',
      jsonb_build_object('type', 'vo_shared', 'projectId', pid, 'variationOrderId', vid));
  end if;

  return added;
end $$;

-- 0016's version, now also including every approver in the VO.
create or replace function private.add_vo_approvers(vid uuid, pid uuid, uids uuid[])
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  vo record;
  added uuid[];
  sender_name text;
begin
  if uids is null or cardinality(uids) = 0 then
    return 0;
  end if;
  if cardinality(uids) > 50 then
    raise exception 'Approver limit reached: 50 per variation order' using errcode = '54000';
  end if;

  select number, name, sent_by into vo from public.variation_orders where id = vid;

  if vo.sent_by = any(uids) then
    raise exception 'The sender cannot approve their own variation order' using errcode = '22023';
  end if;

  if exists (
    select 1 from unnest(uids) as u(id)
    where u.id is null
       or not exists (select 1 from public.project_members m
                      where m.project_id = pid and m.user_id = u.id
                        and m.left_at is null and m.role in ('owner','member'))
  ) then
    raise exception 'Approvers must be owners or members of this project' using errcode = '22023';
  end if;

  -- An approver must be able to see what they approve.
  perform private.add_vo_participants(vid, pid, uids, false);

  with ins as (
    insert into public.variation_order_approvers (variation_order_id, project_id, user_id, added_by)
    select vid, pid, u.id, uid from (select distinct id from unnest(uids) as x(id)) u
    on conflict (variation_order_id, user_id) do nothing
    returning user_id
  )
  select coalesce(array_agg(user_id), '{}') into added from ins;

  if cardinality(added) > 0 then
    select display_name into sender_name from public.profiles where id = uid;
    perform private.push_to_users(
      added,
      'Approval needed: VO-' || vo.number,
      coalesce(sender_name, 'Someone') || ' sent "' || vo.name || '" for your approval.',
      jsonb_build_object('type', 'vo_approval_request', 'projectId', pid, 'variationOrderId', vid));
  end if;

  return cardinality(added);
end $$;

revoke execute on function private.add_vo_participants(uuid, uuid, uuid[], boolean)
from public, anon, authenticated;


-- =====================================================================
-- 6. RPCs (replacing 0014/0016 versions where noted)
-- =====================================================================

-- Same as 0016 plus `participants`: who else can see the VO. The sender is always included;
-- approvers are included automatically, so they need not be repeated in `participants`.
drop function create_variation_order(uuid, text, text, text, text, jsonb, uuid[]);

create function create_variation_order(
  pid uuid,
  vo_name text,
  vo_requested_by text,
  vo_location text default null,
  vo_description text default null,
  attachments jsonb default null,
  approvers uuid[] default null,
  participants uuid[] default null
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

  insert into public.variation_order_participants (variation_order_id, project_id, user_id, added_by)
  values (vid, pid, uid, uid);

  perform private.attach_vo_media(vid, pid, null, attachments);
  -- Approvers first (their push asks for approval); everyone else gets a "shared with you" push.
  perform private.add_vo_approvers(vid, pid, approvers);
  perform private.add_vo_participants(
    vid, pid,
    array(select x from unnest(participants) as x
          where x is distinct from uid and not (x = any(coalesce(approvers, '{}')))),
    true);
  return vid;
end $$;

-- Includes more people in a VO. Sender (still owner/member) or a project owner who can see it.
create function add_variation_order_participants(vid uuid, participants uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  vo record;
begin
  select project_id, sent_by into vo from public.variation_orders where id = vid for update;
  if vo.project_id is null or not private.can_see_vo(vid) then
    raise exception 'Variation order not found' using errcode = 'P0002';
  end if;
  if not (private.is_project_owner(vo.project_id)
          or (vo.sent_by = uid and private.has_project_role(vo.project_id, array['owner','member']))) then
    raise exception 'Only the sender or a project owner can include people' using errcode = '42501';
  end if;

  return cardinality(private.add_vo_participants(vid, vo.project_id, participants, true));
end $$;

-- 0016's version, with the visibility check now on the VO instead of the project.
create or replace function add_variation_order_approvers(vid uuid, approvers uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  vo record;
begin
  select project_id, sent_by, status into vo
  from public.variation_orders where id = vid for update;
  if vo.project_id is null or not private.can_see_vo(vid) then
    raise exception 'Variation order not found' using errcode = 'P0002';
  end if;
  if not (private.is_project_owner(vo.project_id)
          or (vo.sent_by = uid and private.has_project_role(vo.project_id, array['owner','member']))) then
    raise exception 'Only the sender or a project owner can add approvers' using errcode = '42501';
  end if;
  if vo.status <> 'pending' then
    raise exception 'This variation order is already approved' using errcode = '22023';
  end if;

  return private.add_vo_approvers(vid, vo.project_id, approvers);
end $$;

-- 0014's version, with the visibility check now on the VO instead of the project.
create or replace function post_variation_order_comment(
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
  if pid is null or not private.can_see_vo(vid) then
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

-- 0016's version, with the visibility check now on the VO instead of the project.
create or replace function approve_variation_order(vid uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  vo record;
  approver_name text;
  completed boolean;
begin
  select project_id, number, name, sent_by into vo
  from public.variation_orders where id = vid for update;
  if vo.project_id is null or not private.can_see_vo(vid) then
    raise exception 'Variation order not found' using errcode = 'P0002';
  end if;
  if not private.has_project_role(vo.project_id, array['owner','member']) then
    raise exception 'Only project owners and members can approve variation orders'
      using errcode = '42501';
  end if;

  update public.variation_order_approvers
  set approved_at = now()
  where variation_order_id = vid and user_id = uid and approved_at is null;

  if not found then
    if exists (select 1 from public.variation_order_approvers
               where variation_order_id = vid and user_id = uid) then
      raise exception 'You have already approved this variation order' using errcode = '23505';
    end if;
    raise exception 'You are not an approver of this variation order' using errcode = '42501';
  end if;

  insert into public.variation_order_comments (variation_order_id, project_id, author_id, kind)
  values (vid, vo.project_id, uid, 'approval');

  completed := not exists (select 1 from public.variation_order_approvers
                           where variation_order_id = vid and approved_at is null);

  select display_name into approver_name from public.profiles where id = uid;
  if completed then
    update public.variation_orders set status = 'approved', approved_at = now() where id = vid;
  end if;

  if vo.sent_by is not null and vo.sent_by <> uid then
    perform private.push_to_users(
      array[vo.sent_by],
      case when completed then 'VO-' || vo.number || ' approved' else 'VO-' || vo.number || ': new approval' end,
      coalesce(approver_name, 'Someone') || ' approved "' || vo.name || '"'
        || case when completed then '. Every approver has now approved.' else '.' end,
      jsonb_build_object('type', 'vo_approved', 'projectId', vo.project_id, 'variationOrderId', vid));
  end if;

  return completed;
end $$;

grant execute on function
  create_variation_order(uuid, text, text, text, text, jsonb, uuid[], uuid[]),
  add_variation_order_participants(uuid, uuid[])
to authenticated;

revoke execute on function
  create_variation_order(uuid, text, text, text, text, jsonb, uuid[], uuid[]),
  add_variation_order_participants(uuid, uuid[])
from public, anon;


-- =====================================================================
-- 7. REALTIME
-- =====================================================================
-- Being included in a VO makes it appear in that person's list without a refresh.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'variation_order_participants'
  ) then
    alter publication supabase_realtime add table public.variation_order_participants;
  end if;
end $$;
