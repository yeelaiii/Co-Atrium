-- =====================================================================
-- Migration 0016: variation order approvals and push notifications
-- Requires: 0002, 0004, 0014, 0015
-- =====================================================================
--
-- A VO is sent to one or more project members for approval:
--   variation_order_approvers   one row per person asked to approve (approved_at NULL = still pending)
--   variation_orders.status     'pending' until every approver has approved, then 'approved'
--   variation_order_comments    gains `kind`: 'comment' (as before) or 'approval', a log line
--                               "<author> approved this VO" written by approve_variation_order()
--   push_tokens                 Expo push tokens per device, so approvers get a notification
--
-- Who can do what:
--   be an approver:            active owner or member (guests and viewers can't write in threads)
--   ask people to approve:     the sender when creating the VO; later the sender or a project owner
--   approve:                   the approver themselves, while still owner/member
--   withdraw / un-approve:     nobody (approvals are part of the permanent record)
--
-- Push goes straight from Postgres to Expo's push service through pg_net, so no worker is
-- needed. Requests are queued and only sent when the transaction commits.


create extension if not exists pg_net;


-- =====================================================================
-- 1. TABLES
-- =====================================================================

alter table variation_orders
  add column status text not null default 'pending',
  add column approved_at timestamptz,
  add constraint vo_status_valid check (status in ('pending','approved')),
  add constraint vo_approved_at_matches_status
    check ((status = 'approved') = (approved_at is not null));

create table variation_order_approvers (
  id uuid primary key default gen_random_uuid(),
  variation_order_id uuid not null,
  project_id uuid not null,
  user_id uuid references profiles(id) on delete set null,
  added_by uuid default auth.uid() references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  approved_at timestamptz,

  foreign key (variation_order_id, project_id)
    references variation_orders (id, project_id) on delete cascade,
  unique (variation_order_id, user_id)
);

alter table variation_order_comments
  add column kind text not null default 'comment',
  add constraint vo_comment_kind_valid check (kind in ('comment','approval')),
  -- An approval line is the event itself: no text of its own.
  add constraint vo_comment_approval_no_body check (kind = 'comment' or body is null);

create table push_tokens (
  token text primary key,
  user_id uuid not null references profiles(id) on delete cascade,
  platform text not null check (platform in ('ios','android')),
  updated_at timestamptz not null default now(),

  constraint push_token_valid
    check (char_length(token) <= 200 and token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$')
);


-- =====================================================================
-- 2. INDEXES
-- =====================================================================

create index on variation_order_approvers (user_id) where approved_at is null;  -- "pending your approval"
create index on variation_order_approvers (project_id);                          -- realtime filter by project
create index on variation_order_approvers (added_by);                            -- FK
create index on push_tokens (user_id);


-- =====================================================================
-- 3. TRIGGERS
-- =====================================================================

-- Approvals are part of the permanent record, like the rest of the thread.
create trigger vo_approvers_no_delete
before delete on variation_order_approvers
for each row execute function prevent_vo_record_delete();


-- =====================================================================
-- 4. RLS
-- =====================================================================

alter table variation_order_approvers enable row level security;
alter table push_tokens               enable row level security;

revoke all on variation_order_approvers, push_tokens from anon, authenticated;

create policy "members read vo approvers" on variation_order_approvers for select to authenticated
  using (project_id in (select private.my_projects()));
grant select on variation_order_approvers to authenticated;

-- Tokens are never readable by clients; register/unregister go through the RPCs below.

-- status / approved_at are not in the column grant from 0014, so only the RPCs change them.


-- =====================================================================
-- 5. PROFILE VISIBILITY
-- =====================================================================
-- Guests/viewers also need the names of people a VO was sent to for approval.

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
                           and ap.user_id = uid)))
      )
  )
$$;


-- =====================================================================
-- 6. PRIVATE HELPERS
-- =====================================================================

-- Sends one push notification to every registered device of `uids` via Expo's push API.
-- Expo accepts up to 100 messages per request. Never raises: a failed push must not undo
-- the VO or approval that triggered it.
create function private.push_to_users(uids uuid[], title text, body text, data jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  batch jsonb;
begin
  for batch in
    select jsonb_agg(jsonb_build_object(
             'to', t.token, 'title', title, 'body', body, 'data', data,
             'sound', 'default', 'channelId', 'default', 'priority', 'high'))
    from (select token, (row_number() over (order by token) - 1) / 100 as chunk
          from public.push_tokens
          where user_id = any(uids)) t
    group by t.chunk
  loop
    begin
      perform net.http_post(
        url := 'https://exp.host/--/api/v2/push/send',
        body := batch,
        headers := '{"Content-Type":"application/json","Accept":"application/json"}'::jsonb);
    exception when others then
      raise warning 'push_to_users: could not queue push: %', sqlerrm;
    end;
  end loop;
end $$;

-- Adds approvers to a VO and notifies them. Each must be an active owner/member of the
-- project and not the VO's sender. People already on the list are skipped. Returns the
-- number added.
create function private.add_vo_approvers(vid uuid, pid uuid, uids uuid[])
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

revoke execute on function
  private.push_to_users(uuid[], text, text, jsonb),
  private.add_vo_approvers(uuid, uuid, uuid[])
from public, anon, authenticated;


-- =====================================================================
-- 7. RPCs
--    Must be called with the CALLER's JWT, never the service role.
-- =====================================================================

-- Replaces 0014's version: same arguments plus `approvers` (user ids to ask for approval).
drop function create_variation_order(uuid, text, text, text, text, jsonb);

create function create_variation_order(
  pid uuid,
  vo_name text,
  vo_requested_by text,
  vo_location text default null,
  vo_description text default null,
  attachments jsonb default null,
  approvers uuid[] default null
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
  perform private.add_vo_approvers(vid, pid, approvers);
  return vid;
end $$;

-- Asks more people to approve a pending VO. Sender (still owner/member) or a project owner.
create function add_variation_order_approvers(vid uuid, approvers uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  vo record;
begin
  select project_id, sent_by, status into vo
  from public.variation_orders where id = vid for update;
  if vo.project_id is null or not private.is_project_member(vo.project_id) then
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

-- The caller approves a VO they were asked to approve. Logs "<caller> approved" in the
-- thread and, once nobody is left, marks the VO approved and tells the sender.
-- Returns true when this approval completed the VO.
create function approve_variation_order(vid uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  vo record;
  approver_name text;
  completed boolean;
begin
  -- Row lock: two last approvals at once must not both miss (or both send) completion.
  select project_id, number, name, sent_by into vo
  from public.variation_orders where id = vid for update;
  if vo.project_id is null or not private.is_project_member(vo.project_id) then
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

-- Ties this device's Expo push token to the caller (moving it from any previous account).
create function register_push_token(push_token text, device_platform text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if (select count(*) from public.push_tokens where user_id = uid) >= 20 then
    delete from public.push_tokens
    where token = (select token from public.push_tokens where user_id = uid
                   order by updated_at limit 1);
  end if;
  insert into public.push_tokens (token, user_id, platform)
  values (push_token, uid, device_platform)
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform, updated_at = now();
end $$;

-- Stops pushes to this device (on sign-out). Only removes the caller's own token.
create function unregister_push_token(push_token text) returns void
language sql security definer set search_path = '' as $$
  delete from public.push_tokens where token = push_token and user_id = (select auth.uid())
$$;

grant execute on function
  create_variation_order(uuid, text, text, text, text, jsonb, uuid[]),
  add_variation_order_approvers(uuid, uuid[]),
  approve_variation_order(uuid),
  register_push_token(text, text),
  unregister_push_token(text)
to authenticated;

revoke execute on function
  create_variation_order(uuid, text, text, text, text, jsonb, uuid[]),
  add_variation_order_approvers(uuid, uuid[]),
  approve_variation_order(uuid),
  register_push_token(text, text),
  unregister_push_token(text)
from public, anon;


-- =====================================================================
-- 8. REALTIME
-- =====================================================================
-- Approver rows change when someone approves, so lists and the triage view update live.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'variation_order_approvers'
  ) then
    alter publication supabase_realtime add table public.variation_order_approvers;
  end if;
end $$;
