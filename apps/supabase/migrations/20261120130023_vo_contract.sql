-- =====================================================================
-- Migration 0023: the contractual layer of variation orders
-- Requires: 0014, 0016, 0017, 0019, 0020
-- =====================================================================
--
-- variation_orders keeps its internal sign-off (`status` pending | approved, 0016) and gains a
-- separate contractual lifecycle, amounts and time impact:
--
--   contract_status   unconfirmed | identified | instructed | quotation_submitted |
--                     valuation_issued | agreed | disputed | rejected | withdrawn
--                     Main line identified -> instructed -> quotation_submitted -> valuation_issued
--                     -> agreed (forward skips allowed), any of those -> disputed | rejected |
--                     withdrawn, disputed -> valuation_issued | agreed | rejected | withdrawn,
--                     unconfirmed -> identified | instructed | withdrawn. agreed, rejected and
--                     withdrawn are final. Enforced by a trigger against private.vo_status_transitions
--                     (same list as _shared/contracts/variations.ts).
--   amounts           claimed / assessed / agreed (>= 0) + is_omission (counts negative)
--   time impact       days claimed / agreed. Claimed > 0 suggests an EOT notice (Edge Function);
--                     agreed days on an agreed VO extend the completion date, unless the VO is
--                     tied to an EOT decision event (then that event counts, not the VO).
--
--   variation_amount_history    every change to status, amounts or time, with who, when and
--                               from which event (append-only, undeletable)
--   variation_payment_claims    agreed VOs included in a payment claim event
--
-- Logging an event against a VO moves it along (instruction -> instructed, quotation ->
-- quotation_submitted, valuation -> valuation_issued, objection -> disputed) when that move is
-- allowed. An event that answers another (related_event_id) inherits that event's VO.
--
-- Who can do what:
--   read contract columns / history:     the VO's participants (as for the rest of the VO, 0017)
--   change status, amounts, time:        owner/member who can see the VO
--   mark agreed, set agreed amount/time: also needs a contract role (private.can_confirm_contract),
--                                        because it moves the contract sum and completion date
--   project contract sum (all VOs):      contract roles only, totals only (no VO titles)
--
-- Status / amount columns have no column grant, so only these RPCs change them.


-- =====================================================================
-- 1. COLUMNS
-- =====================================================================

alter table variation_orders
  add column contract_status text not null default 'identified',
  add column contract_status_at timestamptz not null default now(),
  add column source text,
  add column instructing_party text,
  add column instruction_event_id uuid,
  add column instruction_reference text,
  add column claimed_amount numeric(14,2),
  add column assessed_amount numeric(14,2),
  add column agreed_amount numeric(14,2),
  add column is_omission boolean not null default false,
  add column time_impact_days_claimed integer,
  add column time_impact_days_agreed integer,
  add column time_impact_claimed_at timestamptz,
  add column eot_event_id uuid,

  add constraint vo_contract_status_valid check (contract_status in (
    'unconfirmed','identified','instructed','quotation_submitted','valuation_issued',
    'agreed','disputed','rejected','withdrawn')),
  add constraint vo_source_valid check (source is null or source in (
    'written_instruction','oral_instruction_confirmed','contractor_proposal','client_request')),
  add constraint vo_instructing_party_valid check (instructing_party is null or instructing_party in (
    'employer','contract_admin','contractor','subcontractor','qs','consultant')),
  add constraint vo_instruction_reference_valid check (instruction_reference is null
    or (char_length(btrim(instruction_reference)) between 1 and 60 and instruction_reference !~ '[[:cntrl:]<>]')),
  add constraint vo_amounts_valid check (
    coalesce(claimed_amount, 0) >= 0 and coalesce(assessed_amount, 0) >= 0 and coalesce(agreed_amount, 0) >= 0),
  add constraint vo_time_impact_valid check (
    coalesce(time_impact_days_claimed, 0) between 0 and 3650 and coalesce(time_impact_days_agreed, 0) between 0 and 3650),
  -- An agreed VO has an agreed amount (0 is fine, e.g. a time-only variation).
  add constraint vo_agreed_has_amount check (contract_status <> 'agreed' or agreed_amount is not null),
  add constraint vo_instruction_event_fk foreign key (instruction_event_id, project_id)
    references project_events (id, project_id),
  add constraint vo_eot_event_fk foreign key (eot_event_id, project_id)
    references project_events (id, project_id);

create index on variation_orders (project_id, contract_status);
create index on variation_orders (instruction_event_id) where instruction_event_id is not null;
create index on variation_orders (eot_event_id) where eot_event_id is not null;

-- Obligations suggested by a VO's time impact hang off the VO itself.
alter table obligations drop constraint obligations_anchor_check;
alter table obligations add constraint obligations_anchor_check
  check (anchor in ('event','completion_date','chained','variation'));
alter table obligations drop constraint obligation_anchor_valid;
alter table obligations add constraint obligation_anchor_valid check (
     (anchor = 'event' and trigger_event_id is not null and parent_obligation_id is null)
  or (anchor = 'completion_date' and trigger_event_id is null and parent_obligation_id is null)
  or (anchor = 'chained' and parent_obligation_id is not null)
  or (anchor = 'variation' and variation_order_id is not null and trigger_event_id is null and parent_obligation_id is null));
create unique index obligations_one_per_variation on obligations (group_key, variation_order_id) where anchor = 'variation';


-- =====================================================================
-- 2. TABLES
-- =====================================================================

-- Allowed contract_status moves. Same list as VO_TRANSITIONS in _shared/contracts/variations.ts.
create table private.vo_status_transitions (
  from_status text not null,
  to_status text not null,
  primary key (from_status, to_status)
);
revoke all on private.vo_status_transitions from public, anon, authenticated;

insert into private.vo_status_transitions (from_status, to_status)
select m.s, t.s
from (values (1,'identified'),(2,'instructed'),(3,'quotation_submitted'),(4,'valuation_issued')) m(i, s)
cross join lateral (
  select s from (values (2,'instructed'),(3,'quotation_submitted'),(4,'valuation_issued'),(5,'agreed')) x(i, s) where x.i > m.i
  union all select unnest(array['disputed','rejected','withdrawn'])
) t
union all select 'unconfirmed', unnest(array['identified','instructed','withdrawn'])
union all select 'disputed', unnest(array['valuation_issued','agreed','rejected','withdrawn']);

create table variation_amount_history (
  id bigint generated always as identity primary key,
  variation_order_id uuid not null,
  project_id uuid not null,
  field text not null check (field in (
    'contract_status','claimed_amount','assessed_amount','agreed_amount','is_omission',
    'time_impact_days_claimed','time_impact_days_agreed')),
  old_value jsonb,
  new_value jsonb,
  source_event_id uuid,
  source_document_id uuid,                     -- FK added with contract_documents (phase 3)
  note text check (note is null or char_length(note) <= 500),
  changed_by uuid references profiles(id) on delete set null,
  changed_at timestamptz not null default now(),

  foreign key (variation_order_id, project_id) references variation_orders (id, project_id) on delete cascade,
  foreign key (source_event_id, project_id) references project_events (id, project_id)
);
create index on variation_amount_history (variation_order_id, changed_at);
create index on variation_amount_history (source_event_id) where source_event_id is not null;
create index on variation_amount_history (changed_by);

create table variation_payment_claims (
  variation_order_id uuid not null,
  event_id uuid not null,
  project_id uuid not null,
  added_by uuid default auth.uid() references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (variation_order_id, event_id),
  foreign key (variation_order_id, project_id) references variation_orders (id, project_id) on delete cascade,
  foreign key (event_id, project_id) references project_events (id, project_id) on delete cascade
);
create index on variation_payment_claims (event_id);
create index on variation_payment_claims (project_id);
create index on variation_payment_claims (added_by);


-- =====================================================================
-- 3. TRIGGERS
-- =====================================================================

-- Transaction-local context for the history trigger: which event (and note) caused this change.
create function private.set_vo_change_context(source_event uuid, change_note text) returns void
language sql set search_path = '' as $$
  select set_config('co_atrium.vo_source_event', coalesce(source_event::text, ''), true),
         set_config('co_atrium.vo_change_note', coalesce(change_note, ''), true)
$$;

-- Valid moves only; stamps when the status / time claim changed.
create function vo_contract_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.contract_status is distinct from old.contract_status then
    -- record_site_instruction() starts a new VO as unconfirmed in the same transaction.
    if current_setting('co_atrium.vo_initialising', true) is distinct from old.id::text
       and not exists (select 1 from private.vo_status_transitions t
                       where t.from_status = old.contract_status and t.to_status = new.contract_status) then
      raise exception 'VO-% cannot go from % to %', old.number,
        replace(old.contract_status, '_', ' '), replace(new.contract_status, '_', ' ')
        using errcode = '22023';
    end if;
    new.contract_status_at := now();
  end if;
  if coalesce(new.time_impact_days_claimed, 0) > 0 and coalesce(old.time_impact_days_claimed, 0) = 0 then
    new.time_impact_claimed_at := now();
  end if;
  return new;
end $$;
create trigger variation_orders_contract_guard before update on variation_orders
for each row execute function vo_contract_guard();

-- Audit + follow-ups: history rows, recalculation (time, agreed), waive on withdrawal.
create function vo_contract_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  f text;
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  src uuid := nullif(current_setting('co_atrium.vo_source_event', true), '')::uuid;
  note text := nullif(current_setting('co_atrium.vo_change_note', true), '');
begin
  -- record_site_instruction() setting the starting status is not a change.
  if current_setting('co_atrium.vo_initialising', true) = new.id::text then
    return new;
  end if;
  foreach f in array array['contract_status','claimed_amount','assessed_amount','agreed_amount','is_omission',
                           'time_impact_days_claimed','time_impact_days_agreed'] loop
    if o->f is distinct from n->f then
      insert into public.variation_amount_history
        (variation_order_id, project_id, field, old_value, new_value, source_event_id, note, changed_by)
      values (new.id, new.project_id, f, o->f, n->f, src, note, (select auth.uid()));
    end if;
  end loop;

  -- Time claimed (EOT notice suggestion), agreed time or agreed status (completion date).
  if new.time_impact_days_claimed is distinct from old.time_impact_days_claimed
     or new.time_impact_days_agreed is distinct from old.time_impact_days_agreed
     or new.eot_event_id is distinct from old.eot_event_id
     or ((new.contract_status = 'agreed') is distinct from (old.contract_status = 'agreed')) then
    perform private.enqueue_recalculation(new.project_id);
  end if;

  -- A withdrawn VO's deadlines no longer apply. Waived, not deleted, so the record stays.
  if new.contract_status = 'withdrawn' and old.contract_status <> 'withdrawn' then
    update public.obligations
    set status = 'waived', closed_by = (select auth.uid()), closed_at = now(),
        close_note = 'VO-' || new.number || ' withdrawn'
    where variation_order_id = new.id and status in ('open','overdue','suggested');
  end if;
  return new;
end $$;
create trigger variation_orders_contract_after_update after update on variation_orders
for each row execute function vo_contract_after_update();

-- Permanent record.
create function prevent_history_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'History cannot be changed' using errcode = '42501';
end $$;
create trigger vo_amount_history_no_update before update on variation_amount_history
for each row execute function prevent_history_update();
create trigger vo_amount_history_no_delete before delete on variation_amount_history
for each row execute function prevent_vo_record_delete();

-- A response inherits the VO of the request it answers (e.g. a valuation answering a quotation).
create function project_event_inherit_vo() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.variation_order_id is null and new.related_event_id is not null then
    select e.variation_order_id into new.variation_order_id
    from public.project_events e where e.id = new.related_event_id and e.project_id = new.project_id;
  end if;
  return new;
end $$;
create trigger project_events_inherit_vo before insert on project_events
for each row execute function project_event_inherit_vo();

-- Moves the VO along for an event logged against it. Mirrors statusAfterEvent() in variations.ts.
create function private.apply_vo_event(e public.project_events) returns void
language plpgsql security definer set search_path = '' as $$
declare
  vo public.variation_orders;
  target text;
begin
  if e.variation_order_id is null or e.voided_at is not null then
    return;
  end if;
  select * into vo from public.variation_orders where id = e.variation_order_id for update;
  if vo.id is null then
    return;
  end if;

  target := case e.event_type
    when 'instruction_issued' then 'instructed'
    when 'oral_instruction_confirmed' then 'instructed'
    when 'variation_quotation_submitted' then 'quotation_submitted'
    when 'variation_valuation_issued' then 'valuation_issued'
    when 'variation_objection_served' then 'disputed'
  end;
  if target is not null and not exists (select 1 from private.vo_status_transitions t
                                        where t.from_status = vo.contract_status and t.to_status = target) then
    target := null;
  end if;

  perform private.set_vo_change_context(e.id, null);
  update public.variation_orders set
    contract_status = coalesce(target, contract_status),
    instruction_event_id = case when e.event_type in ('instruction_issued','oral_instruction_confirmed')
                                then coalesce(instruction_event_id, e.id) else instruction_event_id end,
    instruction_reference = case when e.event_type in ('instruction_issued','oral_instruction_confirmed')
                                 then coalesce(instruction_reference, e.reference) else instruction_reference end,
    instructing_party = case when e.event_type in ('instruction_issued','oral_instruction_received')
                             then coalesce(instructing_party, e.raised_by_party) else instructing_party end,
    source = case
      when source is not null then source
      when e.event_type = 'oral_instruction_confirmed' then 'oral_instruction_confirmed'
      when e.event_type = 'instruction_issued' and vo.contract_status = 'unconfirmed' then 'oral_instruction_confirmed'
      when e.event_type = 'instruction_issued' then 'written_instruction'
      else source end,
    eot_event_id = case when e.event_type = 'eot_decision_issued' then e.id else eot_event_id end
  where id = vo.id;
  perform private.set_vo_change_context(null, null);
end $$;

create function project_event_apply_vo() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.apply_vo_event(new);
  return new;
end $$;
create trigger project_events_apply_vo after insert on project_events
for each row when (new.variation_order_id is not null)
execute function project_event_apply_vo();


-- =====================================================================
-- 4. RLS
-- =====================================================================

alter table variation_amount_history enable row level security;
alter table variation_payment_claims enable row level security;
revoke all on variation_amount_history, variation_payment_claims from anon, authenticated;

create policy "participants read vo history" on variation_amount_history for select to authenticated
  using (variation_order_id in (select private.my_variation_orders()));

-- Payment claims are contract events: owners/members, and only for VOs they can see.
create policy "staff read vo payment claims" on variation_payment_claims for select to authenticated
  using (project_id in (select private.my_projects(array['owner','member']))
         and variation_order_id in (select private.my_variation_orders()));

grant select on variation_amount_history, variation_payment_claims to authenticated;
grant select on variation_orders, variation_amount_history, variation_payment_claims to service_role;


-- =====================================================================
-- 5. RPCs (caller's JWT)
-- =====================================================================

-- Changes a VO's contractual status, amounts or time impact. `patch` keys: contract_status,
-- source, instructing_party, instruction_reference, claimed_amount, assessed_amount,
-- agreed_amount, is_omission, time_impact_days_claimed, time_impact_days_agreed (null clears).
-- `source_event` / `note` are recorded in the history.
create function update_variation_contract(vid uuid, patch jsonb, source_event uuid default null, note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  vo public.variation_orders;
  k text;
  allowed text[] := array['contract_status','source','instructing_party','instruction_reference','claimed_amount',
                          'assessed_amount','agreed_amount','is_omission','time_impact_days_claimed','time_impact_days_agreed'];
  num text;
begin
  select * into vo from public.variation_orders where id = vid for update;
  if vo.id is null or not private.can_see_vo(vid) then
    raise exception 'Variation order not found' using errcode = 'P0002';
  end if;
  if not private.has_project_role(vo.project_id, array['owner','member']) then
    raise exception 'Only project owners and members can update variation orders' using errcode = '42501';
  end if;
  if patch is null or jsonb_typeof(patch) <> 'object' then
    raise exception 'patch must be a JSON object' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(patch) loop
    if not k = any(allowed) then
      raise exception 'Cannot change %', k using errcode = '22023';
    end if;
  end loop;

  if (patch ? 'agreed_amount' or patch ? 'time_impact_days_agreed' or patch->>'contract_status' = 'agreed'
      or (vo.contract_status = 'agreed' and patch ? 'is_omission'))
     and not private.can_confirm_contract(vo.project_id) then
    raise exception 'Only project QS, PM or contract administrators can record an agreed variation'
      using errcode = '42501';
  end if;

  foreach num in array array['claimed_amount','assessed_amount','agreed_amount','time_impact_days_claimed','time_impact_days_agreed'] loop
    if patch ? num and jsonb_typeof(patch->num) not in ('number','null') then
      raise exception '% must be a number', replace(num, '_', ' ') using errcode = '22023';
    end if;
  end loop;
  if patch ? 'is_omission' and jsonb_typeof(patch->'is_omission') <> 'boolean' then
    raise exception 'is_omission must be true or false' using errcode = '22023';
  end if;
  if source_event is not null and not exists (
       select 1 from public.project_events e
       where e.id = source_event and e.project_id = vo.project_id
         and (e.variation_order_id is null or e.variation_order_id = vid)) then
    raise exception 'Source event not found' using errcode = 'P0002';
  end if;

  perform private.set_vo_change_context(source_event, nullif(btrim(note), ''));
  begin
    update public.variation_orders set
      contract_status = case when patch ? 'contract_status' then patch->>'contract_status' else contract_status end,
      source = case when patch ? 'source' then patch->>'source' else source end,
      instructing_party = case when patch ? 'instructing_party' then patch->>'instructing_party' else instructing_party end,
      instruction_reference = case when patch ? 'instruction_reference'
                                   then nullif(btrim(patch->>'instruction_reference'), '') else instruction_reference end,
      claimed_amount = case when patch ? 'claimed_amount' then (patch->>'claimed_amount')::numeric else claimed_amount end,
      assessed_amount = case when patch ? 'assessed_amount' then (patch->>'assessed_amount')::numeric else assessed_amount end,
      agreed_amount = case when patch ? 'agreed_amount' then (patch->>'agreed_amount')::numeric else agreed_amount end,
      is_omission = case when patch ? 'is_omission' then (patch->>'is_omission')::boolean else is_omission end,
      time_impact_days_claimed = case when patch ? 'time_impact_days_claimed'
                                      then (patch->>'time_impact_days_claimed')::integer else time_impact_days_claimed end,
      time_impact_days_agreed = case when patch ? 'time_impact_days_agreed'
                                     then (patch->>'time_impact_days_agreed')::integer else time_impact_days_agreed end
    where id = vid;
  exception
    when check_violation then
      if sqlerrm like '%vo_agreed_has_amount%' then
        raise exception 'Enter the agreed amount (0 for a time-only variation)' using errcode = '22023';
      end if;
      raise exception 'Amounts must be 0 or more, days between 0 and 3650, and parties and sources valid'
        using errcode = '22023';
    when numeric_value_out_of_range or invalid_text_representation then
      raise exception 'Amounts must be under 1 trillion with at most 2 decimals, days whole numbers'
        using errcode = '22023';
  end;
  perform private.set_vo_change_context(null, null);
end $$;

-- Logs an event against a VO (quotation, valuation, instruction, objection...) and, in the same
-- transaction, records the amount it carries: a quotation's amount is the claimed amount (and
-- `time_days` the claimed time), a valuation's the assessed amount. The VO's status moves with
-- the event (trigger above). Returns the event id.
create function log_variation_event(
  vid uuid,
  ev_type text,
  ev_sent_at timestamptz,
  ev_served_at timestamptz default null,
  ev_reference text default null,
  ev_raised_by text default null,
  ev_addressed_to text default null,
  ev_related_event uuid default null,
  amount numeric default null,
  time_days integer default null,
  ev_attachments text[] default '{}',
  ev_notes text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  vo public.variation_orders;
  eid uuid;
  patch jsonb := '{}'::jsonb;
begin
  select * into vo from public.variation_orders where id = vid;
  if vo.id is null or not private.can_see_vo(vid) then
    raise exception 'Variation order not found' using errcode = 'P0002';
  end if;
  if (amount is not null or time_days is not null)
     and ev_type not in ('variation_quotation_submitted','variation_valuation_issued') then
    raise exception 'Only quotations and valuations carry an amount' using errcode = '22023';
  end if;

  eid := public.log_project_event(vo.project_id, ev_type, ev_sent_at, ev_served_at, ev_reference, ev_raised_by,
                                  ev_addressed_to, ev_related_event, vid, null, ev_attachments, ev_notes);

  if ev_type = 'variation_quotation_submitted' then
    if amount is not null then patch := patch || jsonb_build_object('claimed_amount', amount); end if;
    if time_days is not null then patch := patch || jsonb_build_object('time_impact_days_claimed', time_days); end if;
  elsif ev_type = 'variation_valuation_issued' then
    if amount is not null then patch := patch || jsonb_build_object('assessed_amount', amount); end if;
  end if;
  if patch <> '{}'::jsonb then
    perform public.update_variation_contract(vid, patch, eid, null);
  end if;
  return eid;
end $$;

-- "Record site instruction": someone on site told the team to do extra work. Creates the VO as
-- `unconfirmed` and the oral_instruction_received event in one go, so the confirmation deadline
-- starts at once. Returns {"variation_order_id", "event_id"}.
create function record_site_instruction(
  pid uuid,
  vo_name text,
  vo_requested_by text,
  instructing_party text,
  received_at timestamptz,
  vo_location text default null,
  vo_description text default null,
  ev_reference text default null,
  attachments jsonb default null,
  approvers uuid[] default null,
  participants uuid[] default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  vid uuid;
  eid uuid;
  my_party text;
begin
  if instructing_party is not null
     and instructing_party not in ('employer','contract_admin','contractor','subcontractor','qs','consultant') then
    raise exception 'Invalid party' using errcode = '22023';
  end if;

  vid := public.create_variation_order(pid, vo_name, vo_requested_by, vo_location, vo_description,
                                       attachments, approvers, participants);

  perform set_config('co_atrium.vo_initialising', vid::text, true);
  update public.variation_orders
  set contract_status = 'unconfirmed', instructing_party = record_site_instruction.instructing_party
  where id = vid;
  perform set_config('co_atrium.vo_initialising', '', true);

  select contract_party into my_party from public.project_members
  where project_id = pid and user_id = (select auth.uid()) and left_at is null;

  eid := public.log_project_event(pid, 'oral_instruction_received', received_at, received_at, ev_reference,
                                  instructing_party, my_party, null, vid, null, '{}', null);
  return jsonb_build_object('variation_order_id', vid, 'event_id', eid);
end $$;

-- Ties an existing instruction (or written confirmation) event to a VO: "create VO from an
-- instruction". The event and its obligations become part of the VO (and so visible only to its
-- participants), and the VO moves to instructed.
create function link_variation_instruction(vid uuid, eid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  vo public.variation_orders;
  e public.project_events;
begin
  select * into vo from public.variation_orders where id = vid;
  if vo.id is null or not private.can_see_vo(vid) then
    raise exception 'Variation order not found' using errcode = 'P0002';
  end if;
  if not private.has_project_role(vo.project_id, array['owner','member']) then
    raise exception 'Only project owners and members can update variation orders' using errcode = '42501';
  end if;
  select * into e from public.project_events where id = eid for update;
  if e.id is null or e.project_id <> vo.project_id or e.voided_at is not null
     or (e.variation_order_id is not null and not private.can_see_vo(e.variation_order_id)) then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  if e.event_type not in ('instruction_issued','oral_instruction_received','oral_instruction_confirmed') then
    raise exception 'Only instructions can start a variation order' using errcode = '22023';
  end if;
  if e.variation_order_id is not null and e.variation_order_id <> vid then
    raise exception 'That instruction already belongs to another variation order' using errcode = '22023';
  end if;

  update public.project_events set variation_order_id = vid where id = eid;
  update public.obligations set variation_order_id = vid where trigger_event_id = eid and variation_order_id is null;
  e.variation_order_id := vid;
  perform private.apply_vo_event(e);
end $$;

-- Agreed VOs included in a payment claim (replaces the set of VOs the caller can see).
create function set_payment_claim_variations(eid uuid, vids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  e public.project_events;
  n integer;
begin
  select * into e from public.project_events where id = eid;
  if e.id is null or not private.has_project_role(e.project_id, array['owner','member'])
     or (e.variation_order_id is not null and not private.can_see_vo(e.variation_order_id)) then
    raise exception 'Event not found' using errcode = 'P0002';
  end if;
  if e.event_type <> 'payment_claim_served' then
    raise exception 'Only payment claims include variation orders' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(coalesce(vids, '{}')) as x(id)
             where not exists (select 1 from public.variation_orders v
                               where v.id = x.id and v.project_id = e.project_id
                                 and v.contract_status = 'agreed' and private.can_see_vo(v.id))) then
    raise exception 'Only agreed variation orders in this project can be included' using errcode = '22023';
  end if;

  delete from public.variation_payment_claims
  where event_id = eid and private.can_see_vo(variation_order_id)
    and not (variation_order_id = any(coalesce(vids, '{}')));
  insert into public.variation_payment_claims (variation_order_id, event_id, project_id, added_by)
  select distinct x.id, eid, e.project_id, (select auth.uid()) from unnest(coalesce(vids, '{}')) as x(id)
  on conflict do nothing;
  select count(*) into n from public.variation_payment_claims where event_id = eid;
  return n;
end $$;

-- Original and revised contract sum over ALL the project's VOs (including ones the caller is not
-- included in), as totals only. Contract roles only. Mirrors contractSum() in variations.ts:
--   agreed   Σ agreed_amount of agreed VOs, omissions negative
--   pending  Σ coalesce(assessed, claimed) of VOs still in progress (unconfirmed .. valuation_issued)
--   disputed Σ coalesce(assessed, claimed) of disputed VOs
--   unpriced in-progress or disputed VOs without any amount
create function project_contract_sum(pid uuid)
returns table (currency text, original numeric, agreed numeric, pending numeric, disputed numeric,
               revised numeric, revised_incl_pending numeric, vo_count integer, unpriced_count integer)
language plpgsql security definer stable set search_path = '' as $$
declare
  cs jsonb;
begin
  if not private.can_confirm_contract(pid) then
    raise exception 'Only project QS, PM or contract administrators can see the contract sum' using errcode = '42501';
  end if;
  select value into cs from public.project_contract_fields where project_id = pid and field_key = 'contract_sum';

  return query
  with v as (
    select vo.contract_status s, case when vo.is_omission then -1 else 1 end sg,
           vo.agreed_amount ag, coalesce(vo.assessed_amount, vo.claimed_amount) est
    from public.variation_orders vo where vo.project_id = pid
  ), t as (
    select coalesce(sum(sg * coalesce(ag, 0)) filter (where s = 'agreed'), 0) a,
           coalesce(sum(sg * est) filter (where s in ('unconfirmed','identified','instructed',
                                                      'quotation_submitted','valuation_issued')), 0) p,
           coalesce(sum(sg * est) filter (where s = 'disputed'), 0) d,
           count(*)::integer c,
           (count(*) filter (where est is null and s not in ('agreed','rejected','withdrawn')))::integer u
    from v
  )
  select coalesce(cs->>'currency', 'SGD'),
         (cs->>'amount')::numeric,
         t.a, t.p, t.d,
         (cs->>'amount')::numeric + t.a,
         (cs->>'amount')::numeric + t.a + t.p,
         t.c, t.u
  from t;
end $$;

grant execute on function
  update_variation_contract(uuid, jsonb, uuid, text),
  log_variation_event(uuid, text, timestamptz, timestamptz, text, text, text, uuid, numeric, integer, text[], text),
  record_site_instruction(uuid, text, text, text, timestamptz, text, text, text, jsonb, uuid[], uuid[]),
  link_variation_instruction(uuid, uuid),
  set_payment_claim_variations(uuid, uuid[]),
  project_contract_sum(uuid)
to authenticated;

revoke execute on function
  update_variation_contract(uuid, jsonb, uuid, text),
  log_variation_event(uuid, text, timestamptz, timestamptz, text, text, text, uuid, numeric, integer, text[], text),
  record_site_instruction(uuid, text, text, text, timestamptz, text, text, text, jsonb, uuid[], uuid[]),
  link_variation_instruction(uuid, uuid),
  set_payment_claim_variations(uuid, uuid[]),
  project_contract_sum(uuid)
from public, anon;

revoke execute on function
  private.set_vo_change_context(uuid, text),
  private.apply_vo_event(public.project_events),
  public.vo_contract_guard(),
  public.vo_contract_after_update(),
  public.prevent_history_update(),
  public.project_event_inherit_vo(),
  public.project_event_apply_vo()
from public, anon, authenticated;
