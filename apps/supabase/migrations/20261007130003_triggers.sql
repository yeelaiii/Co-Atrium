-- =====================================================================
-- Migration 0003: trigger functions and triggers
-- Requires: 0002
-- =====================================================================

-- =====================================================================
-- 4. TRIGGER FUNCTIONS AND TRIGGERS
-- =====================================================================

-- Profile is seeded from client-controlled metadata: sanitise and cap it.
create function handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  dn text;
begin
  dn := left(
    nullif(btrim(regexp_replace(
      coalesce(new.raw_user_meta_data->>'display_name', ''),
      '[[:cntrl:]<>]', '', 'g')), ''),
    80);
  insert into public.profiles (id, display_name) values (new.id, dn);
  return new;
end $$;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();

create function add_creator_as_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.created_by is not null then
    insert into public.project_members (project_id, user_id, role)
    values (new.id, new.created_by, 'owner');
  end if;
  return new;
end $$;
create trigger on_project_created
  after insert on projects for each row execute function add_creator_as_owner();

-- Only ACTIVE owners count; setting left_at counts as losing ownership;
-- left_at is stamped server-side and immutable once set.
-- Cascades are allowed when the project is hard-deleted or soft-deleted
-- (so account deletion is not blocked by already-deleted projects).
create function prevent_last_owner_loss() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE'
     and not exists (select 1 from public.projects
                     where id = old.project_id and deleted_at is null) then
    return old;
  end if;

  if tg_op = 'UPDATE' then
    if new.left_at is not null and old.left_at is null then
      new.left_at := now();
    elsif new.left_at is not null and old.left_at is not null then
      new.left_at := old.left_at;
    end if;
  end if;

  if old.role = 'owner' and old.left_at is null
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.left_at is not null)
  then
    perform 1
    from public.project_members
    where project_id = old.project_id and role = 'owner' and left_at is null
    order by user_id
    for update;

    if not exists (
      select 1 from public.project_members
      where project_id = old.project_id
        and role = 'owner'
        and left_at is null
        and user_id <> old.user_id
    ) then
      raise exception 'A project must keep at least one owner'
        using hint = 'Use transfer_ownership() or delete_project() first.';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger keep_one_owner
before update or delete on project_members
for each row execute function prevent_last_owner_loss();

create function log_membership_event() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  ev text;
begin
  if tg_op = 'INSERT' then
    ev := 'joined';
  elsif old.left_at is not null and new.left_at is null then
    ev := 'rejoined';
  elsif old.left_at is null and new.left_at is not null then
    ev := 'left';
  elsif old.role is distinct from new.role then
    ev := 'role_changed';
  end if;

  if ev is not null then
    insert into public.membership_events (project_id, user_id, actor_id, event, role)
    values (new.project_id, new.user_id, (select auth.uid()), ev, new.role);
  end if;
  return null;
end $$;
create trigger membership_audit
after insert or update on project_members
for each row execute function log_membership_event();

create function set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger transcriptions_set_updated_at
before update on transcriptions
for each row execute function set_updated_at();

create function documents_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  return new;
end $$;
create trigger documents_bump
before update on documents
for each row execute function documents_before_update();

-- Soft limit (no lock): 60/minute and 1000/hour per sender.
create function limit_message_rate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.messages
      where sender_id = new.sender_id
        and created_at > now() - interval '1 minute') >= 60 then
    raise exception 'Message rate limit reached: 60 per minute' using errcode = '54000';
  end if;
  if (select count(*) from public.messages
      where sender_id = new.sender_id
        and created_at > now() - interval '1 hour') >= 1000 then
    raise exception 'Message rate limit reached: 1000 per hour' using errcode = '54000';
  end if;
  return new;
end $$;
create trigger messages_rate_limit
before insert on messages
for each row execute function limit_message_rate();

create function limit_documents_per_project() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('doc-project:' || new.project_id::text, 0));
  if (select count(*) from public.documents
      where project_id = new.project_id and deleted_at is null) >= 2000 then
    raise exception 'Document limit reached: 2000 per project' using errcode = '54000';
  end if;
  return new;
end $$;
create trigger documents_limit
before insert on documents
for each row execute function limit_documents_per_project();

-- 30/user/hour, 50/user/project/day, 200/project/day.
-- The per-user-per-project cap stops one member burning the whole project quota.
create function limit_transcription_requests() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('tr-user:'    || new.user_id::text,    0));
  perform pg_advisory_xact_lock(hashtextextended('tr-project:' || new.project_id::text, 0));

  if (select count(*) from public.transcriptions
      where user_id = new.user_id
        and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Transcription limit reached: 30 per hour' using errcode = '54000';
  end if;

  if (select count(*) from public.transcriptions
      where user_id = new.user_id and project_id = new.project_id
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
create trigger transcriptions_rate_limit
before insert on transcriptions
for each row execute function limit_transcription_requests();



-- Trigger functions are never called directly: no EXECUTE grants (default privileges deny).
