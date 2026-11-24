-- =====================================================================
-- Migration 0020: contract fields, deadline rules, events, obligations, reminders
-- Requires: 0001, 0002, 0004, 0014, 0016, 0017, 0019
-- =====================================================================
--
-- Rules (period + trigger) combined with events (timestamped occurrences) give obligations
-- (who must do what by when). Due dates are computed by the shared TypeScript calculator
-- (functions/_shared/deadlines) in the create-obligations / recalculate-deadlines Edge Functions,
-- never in SQL, so there is one implementation. SQL only does what needs no date maths:
-- closing obligations when a response is logged, and permissions.
--
--   public_holidays               Singapore public holidays (seed/public_holidays_sg.json)
--   project_deadline_settings     service cut-off, Saturday working day, reminder schedule
--   project_contract_fields       confirmed contract values, one row per field (JSONB value)
--   project_contract_field_history  every change to the above (append-only)
--   rule_library                  versioned standard-form and statute rules (seed/rules/*.json)
--   deadline_rules                the project's effective rules: copied from the library when the
--                                 contract form is confirmed, plus amended / procedure / user rules
--   project_events                RFIs, payment claims, instructions, delay events ...
--   obligations                   rule x event = due date; open | met | overdue | waived | suggested
--   obligation_queue              work for create-obligations / recalculate-deadlines
--   notifications                 in-app notifications
--   reminders_sent                idempotency: one row per (obligation, user, reminder, channel)
--
-- Who can do what:
--   read contract data, rules, events, obligations:  owner, member (guests and viewers: nothing)
--                                                    VO-linked events/obligations: VO participants only
--   log events, mark obligations met, confirm suggestions: owner, member
--   set contract fields, edit / verify rules, waive:  private.can_confirm_contract (0019)
--   deadline settings:                                owner, or can_confirm_contract
--
-- Guardrails enforced here:
--   * a rule with any TODO_VERIFY attribute (or no period source) can't be 'verified' (check);
--   * editing a verified rule's timing puts it back to 'draft';
--   * only verified rules create obligations, and only once the required fields are confirmed
--     (checked by the Edge Function with the shared contractFieldSchema).


-- =====================================================================
-- 1. REFERENCE DATA
-- =====================================================================

create table public_holidays (
  date date primary key,
  name text not null check (char_length(name) between 1 and 80),
  source_url text
);

create table rule_library (
  id uuid primary key default gen_random_uuid(),
  library_version text not null check (library_version ~ '^\d{4}\.\d+$'),
  rule_key text not null check (rule_key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'),
  group_key text not null check (group_key ~ '^[a-z0-9_]+$'),
  kind text not null default 'action' check (kind in ('action','milestone')),
  obligation text not null,
  reminder_label text not null,
  responsible_role text not null,
  recipient_role text not null,
  trigger_event_type text not null,
  period integer check (period between 0 and 3650),
  unit text check (unit in ('calendar_days','working_days','weeks','months')),
  period_field text,
  default_period integer check (default_period between 0 and 3650),
  includes_public_holidays boolean,
  cap_days integer check (cap_days between 0 and 3650),
  cap_label text,
  is_time_bar boolean,
  consequence text,
  origin text not null check (origin in ('statute','standard_form_default')),
  clause_ref text,
  todo_verify text[] not null default '{}',
  closed_by_event_types text[] not null default '{}',
  chains_to text[] not null default '{}',
  applies_to_contract_forms text[] not null,
  notes text,
  unique (rule_key, library_version)
);


-- =====================================================================
-- 2. PROJECT SETTINGS AND CONTRACT FIELDS
-- =====================================================================

create table project_deadline_settings (
  project_id uuid primary key references projects on delete cascade,
  service_cutoff time not null default '17:00',
  saturday_is_working_day boolean not null default false,
  reminder_schedule jsonb,                    -- NULL = DEFAULT_REMINDER_SCHEDULE in reminders.ts
  high_confidence_threshold numeric(3,2) not null default 0.90
    check (high_confidence_threshold between 0.5 and 1),
  updated_by uuid references profiles(id) on delete set null,
  updated_at timestamptz not null default now(),

  constraint reminder_schedule_object
    check (reminder_schedule is null
           or (jsonb_typeof(reminder_schedule) = 'object' and octet_length(reminder_schedule::text) <= 2000))
);

-- Confirmed values. The value's shape is validated against contractFieldSchema.ts by the caller
-- (app / Edge Function); here only key format and size. value NULL + not_stated = "the contract
-- doesn't state this", which still counts as confirmed.
create table project_contract_fields (
  project_id uuid not null references projects on delete cascade,
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  value jsonb,
  not_stated boolean not null default false,
  origin text not null check (origin in ('extracted','standard_form_default','user_entered')),
  source_document_id uuid,                    -- FK added with contract_documents (phase 3)
  source_page integer check (source_page > 0),
  source_excerpt text check (source_excerpt is null or char_length(source_excerpt) <= 400),
  confirmed_by uuid references profiles(id) on delete set null,
  confirmed_at timestamptz not null default now(),
  primary key (project_id, field_key),

  constraint contract_field_value_xor_not_stated check ((value is null) = not_stated),
  constraint contract_field_value_size check (value is null or octet_length(value::text) <= 20000)
);

create table project_contract_field_history (
  id bigint generated always as identity primary key,
  project_id uuid not null references projects on delete cascade,
  field_key text not null,
  old_value jsonb,
  new_value jsonb,
  old_not_stated boolean,
  new_not_stated boolean,
  origin text not null,
  source_document_id uuid,
  changed_by uuid references profiles(id) on delete set null,
  changed_at timestamptz not null default now()
);


-- =====================================================================
-- 3. PROJECT RULES
-- =====================================================================

create table deadline_rules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  library_rule_id uuid references rule_library on delete set null,
  rule_key text not null check (rule_key ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'),
  group_key text not null check (group_key ~ '^[a-z0-9_]+$'),
  kind text not null default 'action' check (kind in ('action','milestone')),
  obligation text not null check (char_length(btrim(obligation)) between 3 and 300),
  reminder_label text not null check (char_length(btrim(reminder_label)) between 2 and 60),
  responsible_role text not null
    check (responsible_role in ('employer','contract_admin','contractor','subcontractor','qs','consultant')),
  recipient_role text not null
    check (recipient_role in ('employer','contract_admin','contractor','subcontractor','qs','consultant')),
  trigger_event_type text not null check (trigger_event_type in (
    'rfi_submitted','rfi_responded','rfa_submitted','rfa_responded',
    'shop_drawing_submitted','shop_drawing_reviewed',
    'payment_claim_served','payment_response_served','payment_certificate_issued',
    'instruction_issued','oral_instruction_received','oral_instruction_confirmed',
    'variation_quotation_submitted','variation_valuation_issued','variation_objection_served',
    'delay_event_occurred','eot_notice_served','eot_decision_issued',
    'completion_certified','defect_notified','defect_rectified',
    'completion_date','chained')),
  period integer check (period between 0 and 3650),
  unit text check (unit in ('calendar_days','working_days','weeks','months')),
  period_field text check (period_field is null or period_field ~ '^[a-z][a-z0-9_]{1,63}$'),
  default_period integer check (default_period between 0 and 3650),
  includes_public_holidays boolean,
  cap_days integer check (cap_days between 0 and 3650),
  cap_label text check (cap_label is null or char_length(cap_label) <= 80),
  is_time_bar boolean,
  consequence text check (consequence is null or char_length(consequence) <= 500),
  origin text not null
    check (origin in ('statute','standard_form_default','amended','project_procedure','user_defined')),
  source_document_id uuid,
  source_clause text check (source_clause is null or char_length(source_clause) <= 60),
  source_page integer check (source_page > 0),
  confidence numeric(3,2) check (confidence between 0 and 1),
  todo_verify text[] not null default '{}',
  closed_by_event_types text[] not null default '{}',
  chains_to text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft','verified','rejected')),
  verified_by uuid references profiles(id) on delete set null,
  verified_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (project_id, rule_key),
  unique (id, project_id),

  -- A rule can only be verified once nothing is TODO_VERIFY and it has a period source.
  constraint deadline_rules_verify_complete check (
    status <> 'verified'
    or (cardinality(todo_verify) = 0
        and unit is not null
        and is_time_bar is not null
        and (period is not null or period_field is not null or default_period is not null))
  ),
  constraint deadline_rules_verified_stamp check ((status = 'verified') = (verified_at is not null))
);


-- =====================================================================
-- 4. EVENTS AND OBLIGATIONS
-- =====================================================================

create table project_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  event_type text not null check (event_type in (
    'rfi_submitted','rfi_responded','rfa_submitted','rfa_responded',
    'shop_drawing_submitted','shop_drawing_reviewed',
    'payment_claim_served','payment_response_served','payment_certificate_issued',
    'instruction_issued','oral_instruction_received','oral_instruction_confirmed',
    'variation_quotation_submitted','variation_valuation_issued','variation_objection_served',
    'delay_event_occurred','eot_notice_served','eot_decision_issued',
    'completion_certified','defect_notified','defect_rectified')),
  reference text check (reference is null
                        or (char_length(btrim(reference)) between 1 and 60 and reference !~ '[[:cntrl:]<>]')),
  raised_by_party text
    check (raised_by_party in ('employer','contract_admin','contractor','subcontractor','qs','consultant')),
  addressed_to_party text
    check (addressed_to_party in ('employer','contract_admin','contractor','subcontractor','qs','consultant')),
  sent_at timestamptz not null,
  served_at timestamptz,                      -- NULL until computed (create-obligations fills it)
  time_extension_days integer check (time_extension_days between 0 and 3650),   -- eot_decision_issued
  variation_order_id uuid,
  related_event_id uuid,
  attachments text[] not null default '{}',
  notes text check (notes is null or (char_length(notes) <= 2000 and notes !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F<>]')),
  created_by uuid default auth.uid() references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by uuid references profiles(id) on delete set null,

  unique (id, project_id),
  foreign key (variation_order_id, project_id) references variation_orders (id, project_id) on delete cascade,
  foreign key (related_event_id, project_id) references project_events (id, project_id),

  constraint event_served_after_sent check (served_at is null or served_at >= sent_at - interval '1 minute'),
  constraint event_extension_only_eot check (time_extension_days is null or event_type = 'eot_decision_issued'),
  constraint event_attachments_limit check (cardinality(attachments) <= 20)
);

create table obligations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  rule_id uuid not null,
  rule_key text not null,
  group_key text not null,
  kind text not null check (kind in ('action','milestone')),
  anchor text not null check (anchor in ('event','completion_date','chained')),
  trigger_event_id uuid,
  parent_obligation_id uuid references obligations on delete cascade,
  variation_order_id uuid,
  obligation text not null,
  reminder_label text not null,
  subject text,                               -- "RFI-023": the trigger event's reference
  responsible_party text not null,
  recipient_party text not null,
  due_at timestamptz not null,
  due_date date not null,
  explanation text not null,
  period integer not null,
  unit text not null,
  source_label text not null,
  is_time_bar boolean not null default false,
  closed_by_event_types text[] not null default '{}',
  status text not null default 'open' check (status in ('open','met','overdue','waived','suggested')),
  closed_by_event_id uuid,
  closed_by uuid references profiles(id) on delete set null,
  closed_at timestamptz,
  close_note text check (close_note is null or char_length(close_note) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (rule_id, project_id) references deadline_rules (id, project_id) on delete cascade,
  foreign key (trigger_event_id, project_id) references project_events (id, project_id) on delete cascade,
  foreign key (closed_by_event_id, project_id) references project_events (id, project_id),
  foreign key (variation_order_id, project_id) references variation_orders (id, project_id) on delete cascade,

  constraint obligation_anchor_valid check (
       (anchor = 'event' and trigger_event_id is not null and parent_obligation_id is null)
    or (anchor = 'completion_date' and trigger_event_id is null and parent_obligation_id is null)
    or (anchor = 'chained' and parent_obligation_id is not null))
);

-- Idempotency: one obligation per rule group per trigger. Keyed on group_key, not rule_id, so
-- when a higher-precedence rule is verified later (e.g. an amendment) recalculation updates the
-- existing obligation instead of adding a second one.
create unique index obligations_one_per_event on obligations (project_id, group_key, trigger_event_id) where anchor = 'event';
create unique index obligations_one_per_completion on obligations (project_id, group_key) where anchor = 'completion_date';
create unique index obligations_one_per_chain on obligations (group_key, parent_obligation_id) where anchor = 'chained';

create table obligation_queue (
  id bigint generated always as identity primary key,
  project_id uuid not null references projects on delete cascade,
  event_id uuid references project_events on delete cascade,
  reason text not null check (reason in ('event','recalculate')),
  created_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  processed_at timestamptz
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  project_id uuid not null references projects on delete cascade,
  obligation_id uuid references obligations on delete cascade,
  kind text not null check (kind in ('obligation_reminder','obligation_suggested')),
  title text not null check (char_length(title) <= 200),
  body text not null check (char_length(body) <= 1000),
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create table reminders_sent (
  obligation_id uuid not null references obligations on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  reminder_key text not null check (reminder_key ~ '^[a-z0-9-]{1,20}$'),
  channel text not null check (channel in ('push','in_app','skipped')),
  sent_at timestamptz not null default now(),
  primary key (obligation_id, user_id, reminder_key, channel)
);


-- =====================================================================
-- 5. INDEXES
-- =====================================================================

create index on project_contract_field_history (project_id, field_key, changed_at desc);
create index on project_contract_fields (confirmed_by);
create index on deadline_rules (project_id, trigger_event_type) where status = 'verified';
create index on deadline_rules (library_rule_id);
create index on project_events (project_id, sent_at desc);
create index on project_events (project_id, event_type, upper(btrim(reference)));
create index on project_events (related_event_id) where related_event_id is not null;
create index on project_events (variation_order_id) where variation_order_id is not null;
create index on project_events (created_by);
create index on obligations (project_id, status, due_at);
create index on obligations (status, due_at) where status in ('open','overdue');       -- send-reminders
create index on obligations (trigger_event_id);
create index on obligations (rule_id);
create index on obligations (variation_order_id) where variation_order_id is not null;
create index on obligation_queue (created_at) where processed_at is null;
create index on notifications (user_id, created_at desc);
create index on notifications (user_id) where read_at is null;
create index on notifications (obligation_id);


-- =====================================================================
-- 6. TRIGGERS
-- =====================================================================

create trigger deadline_rules_set_updated_at before update on deadline_rules
for each row execute function set_updated_at();
create trigger obligations_set_updated_at before update on obligations
for each row execute function set_updated_at();

-- Changing what a verified rule computes puts it back to draft for re-verification.
create function deadline_rule_reverify() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.status = 'verified' and new.status = 'verified' and (
       new.period is distinct from old.period
    or new.unit is distinct from old.unit
    or new.period_field is distinct from old.period_field
    or new.default_period is distinct from old.default_period
    or new.includes_public_holidays is distinct from old.includes_public_holidays
    or new.cap_days is distinct from old.cap_days
    or new.is_time_bar is distinct from old.is_time_bar
    or new.trigger_event_type is distinct from old.trigger_event_type
    or new.responsible_role is distinct from old.responsible_role
    or new.closed_by_event_types is distinct from old.closed_by_event_types) then
    new.status := 'draft';
    new.verified_by := null;
    new.verified_at := null;
  end if;
  return new;
end $$;
create trigger deadline_rules_reverify before update on deadline_rules
for each row execute function deadline_rule_reverify();

-- Audit every contract field change.
create function log_contract_field_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.project_contract_field_history
    (project_id, field_key, old_value, new_value, old_not_stated, new_not_stated, origin, source_document_id, changed_by)
  values (new.project_id, new.field_key,
          case when tg_op = 'UPDATE' then old.value end, new.value,
          case when tg_op = 'UPDATE' then old.not_stated end, new.not_stated,
          new.origin, new.source_document_id, new.confirmed_by);
  return new;
end $$;
create trigger contract_fields_history after insert or update on project_contract_fields
for each row execute function log_contract_field_change();

-- A response event closes the matching open/overdue obligations: those whose rule lists this
-- event type in closed_by_event_types AND whose trigger event is `related_event_id`, or (when no
-- related event is given) has the same reference. Mirrors closesObligation() in obligations.ts.
create function close_obligations_on_response() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.obligations o
  set status = 'met', closed_by_event_id = new.id, closed_by = new.created_by, closed_at = now()
  where o.project_id = new.project_id
    and o.status in ('open','overdue')
    and new.event_type = any(o.closed_by_event_types)
    and o.trigger_event_id is not null
    and (
      (new.related_event_id is not null and o.trigger_event_id = new.related_event_id)
      or (new.related_event_id is null
          and new.reference is not null
          and exists (select 1 from public.project_events e
                      where e.id = o.trigger_event_id
                        and upper(btrim(e.reference)) = upper(btrim(new.reference))))
    );
  return new;
end $$;
create trigger project_events_close_obligations after insert on project_events
for each row execute function close_obligations_on_response();


-- =====================================================================
-- 7. RLS
-- =====================================================================

alter table public_holidays                enable row level security;
alter table rule_library                   enable row level security;
alter table project_deadline_settings      enable row level security;
alter table project_contract_fields        enable row level security;
alter table project_contract_field_history enable row level security;
alter table deadline_rules                 enable row level security;
alter table project_events                 enable row level security;
alter table obligations                    enable row level security;
alter table obligation_queue               enable row level security;
alter table notifications                  enable row level security;
alter table reminders_sent                 enable row level security;

revoke all on public_holidays, rule_library, project_deadline_settings, project_contract_fields,
  project_contract_field_history, deadline_rules, project_events, obligations, obligation_queue,
  notifications, reminders_sent
from anon, authenticated;

create policy "anyone signed in reads holidays" on public_holidays for select to authenticated using (true);
create policy "anyone signed in reads rule library" on rule_library for select to authenticated using (true);

create policy "staff read deadline settings" on project_deadline_settings for select to authenticated
  using (project_id in (select private.my_projects(array['owner','member'])));
create policy "staff read contract fields" on project_contract_fields for select to authenticated
  using (project_id in (select private.my_projects(array['owner','member'])));
create policy "staff read contract field history" on project_contract_field_history for select to authenticated
  using (project_id in (select private.my_projects(array['owner','member'])));
create policy "staff read deadline rules" on deadline_rules for select to authenticated
  using (project_id in (select private.my_projects(array['owner','member'])));

-- VO-linked rows only for that VO's participants (0017).
create policy "staff read events" on project_events for select to authenticated
  using (project_id in (select private.my_projects(array['owner','member']))
         and (variation_order_id is null or variation_order_id in (select private.my_variation_orders())));
create policy "staff read obligations" on obligations for select to authenticated
  using (project_id in (select private.my_projects(array['owner','member']))
         and (variation_order_id is null or variation_order_id in (select private.my_variation_orders())));

create policy "read own notifications" on notifications for select to authenticated
  using (user_id = (select auth.uid()));

-- Event attachments live in the 'attachments' bucket (upload policy from 0007). Anyone who can
-- read the event (policy above, evaluated as the caller) can read its files.
create policy "attachments: read event files" on storage.objects for select to authenticated
  using (
    bucket_id = 'attachments'
    and exists (select 1 from public.project_events e
                where e.project_id = private.path_project_id(name)
                  and name = any(e.attachments))
  );

grant select on public_holidays, rule_library, project_deadline_settings, project_contract_fields,
  project_contract_field_history, deadline_rules, project_events, obligations, notifications
to authenticated;


-- =====================================================================
-- 8. PRIVATE HELPERS
-- =====================================================================

-- Copies the library rules for the project's contract form (latest library_version per
-- rule_key, plus statute and common rules), keeping rules already present. Standard-form
-- rules that don't apply to the new form are rejected. Returns the number of rules added.
create function private.initialise_project_rules(pid uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  form text;
  n integer;
begin
  select value #>> '{}' into form
  from public.project_contract_fields where project_id = pid and field_key = 'contract_form';
  if form is null then
    return 0;
  end if;

  insert into public.deadline_rules (
    project_id, library_rule_id, rule_key, group_key, kind, obligation, reminder_label,
    responsible_role, recipient_role, trigger_event_type, period, unit, period_field, default_period,
    includes_public_holidays, cap_days, cap_label, is_time_bar, consequence, origin, source_clause,
    todo_verify, closed_by_event_types, chains_to, status, created_by)
  select pid, l.id, l.rule_key, l.group_key, l.kind, l.obligation, l.reminder_label,
         l.responsible_role, l.recipient_role, l.trigger_event_type, l.period, l.unit, l.period_field,
         l.default_period, l.includes_public_holidays, l.cap_days, l.cap_label, l.is_time_bar,
         l.consequence, l.origin, l.clause_ref, l.todo_verify, l.closed_by_event_types, l.chains_to,
         'draft', (select auth.uid())
  from (
    select distinct on (rule_key) *
    from public.rule_library
    where form = any(applies_to_contract_forms)
    order by rule_key, string_to_array(library_version, '.')::int[] desc
  ) l
  on conflict (project_id, rule_key) do nothing;
  get diagnostics n = row_count;

  -- A changed form: library rules that no longer apply are rejected (never deleted: obligations
  -- may reference them).
  update public.deadline_rules r
  set status = 'rejected', verified_by = null, verified_at = null
  where r.project_id = pid
    and r.origin = 'standard_form_default'
    and r.library_rule_id is not null
    and r.status <> 'rejected'
    and not exists (select 1 from public.rule_library l
                    where l.id = r.library_rule_id and form = any(l.applies_to_contract_forms));
  return n;
end $$;

create function private.enqueue_recalculation(pid uuid) returns void
language sql security definer set search_path = '' as $$
  insert into public.obligation_queue (project_id, reason)
  select pid, 'recalculate'
  where not exists (select 1 from public.obligation_queue q
                    where q.project_id = pid and q.reason = 'recalculate' and q.processed_at is null)
$$;

revoke execute on function private.initialise_project_rules(uuid), private.enqueue_recalculation(uuid)
from public, anon, authenticated;
grant execute on function private.initialise_project_rules(uuid), private.enqueue_recalculation(uuid)
to service_role;


-- =====================================================================
-- 9. RPCs (caller's JWT)
-- =====================================================================

-- Sets (confirms) one contract field as user_entered. `not_stated` records that the contract
-- doesn't state it. Confirming contract_form copies the library rules.
create function set_contract_field(pid uuid, fkey text, new_value jsonb, is_not_stated boolean default false)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_confirm_contract(pid) then
    raise exception 'Only project QS, PM or contract administrators can confirm contract values'
      using errcode = '42501';
  end if;
  if fkey !~ '^[a-z][a-z0-9_]{1,63}$' then
    raise exception 'Invalid field key' using errcode = '22023';
  end if;
  if fkey = 'contract_form' and (is_not_stated or jsonb_typeof(new_value) <> 'string') then
    raise exception 'contract_form must be a form code' using errcode = '22023';
  end if;
  if is_not_stated then
    new_value := null;
  elsif new_value is null or new_value = 'null'::jsonb then
    raise exception 'Enter a value, or mark it as not stated in the contract' using errcode = '22023';
  end if;

  insert into public.project_contract_fields
    (project_id, field_key, value, not_stated, origin, confirmed_by, confirmed_at)
  values (pid, fkey, new_value, is_not_stated, 'user_entered', (select auth.uid()), now())
  on conflict (project_id, field_key) do update
    set value = excluded.value, not_stated = excluded.not_stated, origin = 'user_entered',
        source_document_id = null, source_page = null, source_excerpt = null,
        confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at;

  if fkey = 'contract_form' then
    perform private.initialise_project_rules(pid);
  end if;
  perform private.enqueue_recalculation(pid);
end $$;

-- Edits a rule's timing or wording. Supplying an attribute clears its TODO_VERIFY entry.
-- Editable: period, unit, period_field, includes_public_holidays, is_time_bar, source_clause,
-- trigger_event_type, closed_by_event_types, chains_to, responsible_role, recipient_role,
-- obligation, reminder_label, consequence.
create function update_deadline_rule(rid uuid, patch jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.deadline_rules;
  k text;
  allowed text[] := array['period','unit','period_field','includes_public_holidays','is_time_bar',
                          'source_clause','trigger_event_type','closed_by_event_types','chains_to',
                          'responsible_role','recipient_role','obligation','reminder_label','consequence'];
  todo text[];
begin
  select * into r from public.deadline_rules where id = rid;
  if r.id is null or not private.can_confirm_contract(r.project_id) then
    raise exception 'Rule not found or not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(patch) <> 'object' then
    raise exception 'patch must be a JSON object' using errcode = '22023';
  end if;
  for k in select jsonb_object_keys(patch) loop
    if not k = any(allowed) then
      raise exception 'Cannot edit %', k using errcode = '22023';
    end if;
  end loop;

  todo := r.todo_verify;
  -- clause_ref in the library is source_clause here.
  for k in select jsonb_object_keys(patch) loop
    todo := array_remove(todo, case k when 'source_clause' then 'clause_ref' else k end);
  end loop;
  -- Setting period_field (or explicitly null period when the rule has one) settles the period.
  if patch ? 'period_field' or (patch ? 'period' and coalesce(patch->>'period_field', r.period_field) is not null) then
    todo := array_remove(todo, 'period');
  end if;

  update public.deadline_rules set
    period = case when patch ? 'period' then (patch->>'period')::integer else period end,
    unit = case when patch ? 'unit' then patch->>'unit' else unit end,
    period_field = case when patch ? 'period_field' then patch->>'period_field' else period_field end,
    includes_public_holidays = case when patch ? 'includes_public_holidays'
                                    then (patch->>'includes_public_holidays')::boolean else includes_public_holidays end,
    is_time_bar = case when patch ? 'is_time_bar' then (patch->>'is_time_bar')::boolean else is_time_bar end,
    source_clause = case when patch ? 'source_clause' then nullif(btrim(patch->>'source_clause'), '') else source_clause end,
    trigger_event_type = case when patch ? 'trigger_event_type' then patch->>'trigger_event_type' else trigger_event_type end,
    closed_by_event_types = case when patch ? 'closed_by_event_types'
                                 then array(select jsonb_array_elements_text(patch->'closed_by_event_types'))
                                 else closed_by_event_types end,
    chains_to = case when patch ? 'chains_to'
                     then array(select jsonb_array_elements_text(patch->'chains_to')) else chains_to end,
    responsible_role = case when patch ? 'responsible_role' then patch->>'responsible_role' else responsible_role end,
    recipient_role = case when patch ? 'recipient_role' then patch->>'recipient_role' else recipient_role end,
    obligation = case when patch ? 'obligation' then btrim(patch->>'obligation') else obligation end,
    reminder_label = case when patch ? 'reminder_label' then btrim(patch->>'reminder_label') else reminder_label end,
    consequence = case when patch ? 'consequence' then nullif(btrim(patch->>'consequence'), '') else consequence end,
    todo_verify = todo
  where id = rid;
end $$;

create function verify_deadline_rule(rid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  pid uuid;
begin
  select project_id into pid from public.deadline_rules where id = rid;
  if pid is null or not private.can_confirm_contract(pid) then
    raise exception 'Rule not found or not allowed' using errcode = '42501';
  end if;
  -- The deadline_rules_verify_complete check rejects rules that still have TODO_VERIFY values.
  update public.deadline_rules
  set status = 'verified', verified_by = (select auth.uid()), verified_at = now()
  where id = rid;
  perform private.enqueue_recalculation(pid);
exception when check_violation then
  raise exception 'Fill in every TODO_VERIFY value (period, unit, time bar, clause) before verifying'
    using errcode = '22023';
end $$;

create function reject_deadline_rule(rid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  pid uuid;
begin
  select project_id into pid from public.deadline_rules where id = rid;
  if pid is null or not private.can_confirm_contract(pid) then
    raise exception 'Rule not found or not allowed' using errcode = '42501';
  end if;
  update public.deadline_rules set status = 'rejected', verified_by = null, verified_at = null where id = rid;
end $$;

-- Adds a project procedure or user-defined rule (e.g. "RFI replies within 7 working days").
-- It starts as draft; verify it separately.
create function create_deadline_rule(pid uuid, rule jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  rid uuid;
  o text := coalesce(rule->>'origin', 'user_defined');
  gk text;
begin
  if not private.can_confirm_contract(pid) then
    raise exception 'Only project QS, PM or contract administrators can add rules' using errcode = '42501';
  end if;
  if o not in ('project_procedure','user_defined') then
    raise exception 'origin must be project_procedure or user_defined' using errcode = '22023';
  end if;
  gk := coalesce(nullif(rule->>'group_key', ''),
                 'user_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

  insert into public.deadline_rules (
    project_id, rule_key, group_key, kind, obligation, reminder_label, responsible_role, recipient_role,
    trigger_event_type, period, unit, includes_public_holidays, is_time_bar, consequence, origin,
    source_clause, closed_by_event_types, chains_to, status, created_by)
  values (
    pid, o || '.' || gk || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6), gk,
    coalesce(rule->>'kind', 'action'), btrim(rule->>'obligation'), btrim(rule->>'reminder_label'),
    rule->>'responsible_role', rule->>'recipient_role', rule->>'trigger_event_type',
    (rule->>'period')::integer, rule->>'unit', (rule->>'includes_public_holidays')::boolean,
    coalesce((rule->>'is_time_bar')::boolean, false), nullif(btrim(rule->>'consequence'), ''), o,
    nullif(btrim(rule->>'source_clause'), ''),
    coalesce(array(select jsonb_array_elements_text(rule->'closed_by_event_types')), '{}'),
    coalesce(array(select jsonb_array_elements_text(rule->'chains_to')), '{}'),
    'draft', (select auth.uid()))
  returning id into rid;
  return rid;
end $$;

-- Logs an event. Attachments must be objects the caller uploaded to the project's
-- 'attachments' bucket. served_at is computed by the app with the shared calculator; if
-- omitted, create-obligations computes it. Returns the event id.
create function log_project_event(
  pid uuid,
  ev_type text,
  ev_sent_at timestamptz,
  ev_served_at timestamptz default null,
  ev_reference text default null,
  ev_raised_by text default null,
  ev_addressed_to text default null,
  ev_related_event uuid default null,
  ev_variation_order uuid default null,
  ev_time_extension_days integer default null,
  ev_attachments text[] default '{}',
  ev_notes text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  eid uuid;
  p text;
begin
  if not private.has_project_role(pid, array['owner','member']) then
    raise exception 'Only project owners and members can log events' using errcode = '42501';
  end if;
  if ev_variation_order is not null and not private.can_see_vo(ev_variation_order) then
    raise exception 'Variation order not found' using errcode = 'P0002';
  end if;
  if ev_related_event is not null and not exists (
       select 1 from public.project_events e
       where e.id = ev_related_event and e.project_id = pid and e.voided_at is null
         and (e.variation_order_id is null or private.can_see_vo(e.variation_order_id))) then
    raise exception 'Related event not found' using errcode = 'P0002';
  end if;
  if ev_sent_at > now() + interval '1 day' then
    raise exception 'The date cannot be in the future' using errcode = '22023';
  end if;
  if (select count(*) from public.project_events
      where created_by = uid and created_at > now() - interval '1 hour') >= 120 then
    raise exception 'Event limit reached: 120 per hour' using errcode = '54000';
  end if;

  foreach p in array coalesce(ev_attachments, '{}') loop
    if private.path_project_id(p) is distinct from pid
       or not exists (select 1 from storage.objects o
                      where o.bucket_id = 'attachments' and o.name = p and o.owner_id = uid::text) then
      raise exception 'Upload not found: %', p using errcode = 'P0002';
    end if;
  end loop;

  insert into public.project_events (
    project_id, event_type, reference, raised_by_party, addressed_to_party, sent_at, served_at,
    time_extension_days, variation_order_id, related_event_id, attachments, notes, created_by)
  values (
    pid, ev_type, nullif(btrim(ev_reference), ''), ev_raised_by, ev_addressed_to, ev_sent_at, ev_served_at,
    ev_time_extension_days, ev_variation_order, ev_related_event, coalesce(ev_attachments, '{}'),
    nullif(btrim(ev_notes), ''), uid)
  returning id into eid;

  insert into public.obligation_queue (project_id, event_id, reason) values (pid, eid, 'event');
  if ev_type in ('eot_decision_issued','completion_certified') then
    perform private.enqueue_recalculation(pid);
  end if;
  return eid;
end $$;

-- Voids a mistaken event: its open obligations are waived. Creator or contract role.
create function void_project_event(eid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.project_events;
begin
  select * into e from public.project_events where id = eid;
  if e.id is null
     or not (private.can_confirm_contract(e.project_id)
             or (e.created_by = (select auth.uid()) and private.has_project_role(e.project_id, array['owner','member']))) then
    raise exception 'Event not found or not allowed' using errcode = '42501';
  end if;
  update public.project_events set voided_at = now(), voided_by = (select auth.uid())
  where id = eid and voided_at is null;
  update public.obligations
  set status = 'waived', closed_by = (select auth.uid()), closed_at = now(), close_note = 'Trigger event voided'
  where trigger_event_id = eid and status in ('open','overdue','suggested');
  perform private.enqueue_recalculation(e.project_id);
end $$;

-- open | overdue -> met (manually, e.g. the response was sent outside the app).
create function mark_obligation_met(oid uuid, note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.obligations;
begin
  select * into o from public.obligations where id = oid;
  if o.id is null or not private.has_project_role(o.project_id, array['owner','member'])
     or (o.variation_order_id is not null and not private.can_see_vo(o.variation_order_id)) then
    raise exception 'Obligation not found' using errcode = 'P0002';
  end if;
  update public.obligations
  set status = 'met', closed_by = (select auth.uid()), closed_at = now(), close_note = nullif(btrim(note), '')
  where id = oid and status in ('open','overdue');
end $$;

-- suggested -> open (a person confirms a chained follow-on applies).
create function confirm_suggested_obligation(oid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.obligations;
begin
  select * into o from public.obligations where id = oid;
  if o.id is null or not private.has_project_role(o.project_id, array['owner','member'])
     or (o.variation_order_id is not null and not private.can_see_vo(o.variation_order_id)) then
    raise exception 'Obligation not found' using errcode = 'P0002';
  end if;
  update public.obligations set status = case when due_at < now() then 'overdue' else 'open' end
  where id = oid and status = 'suggested';
end $$;

-- open | overdue | suggested -> waived. Contract role only.
create function waive_obligation(oid uuid, note text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o public.obligations;
begin
  select * into o from public.obligations where id = oid;
  if o.id is null or not private.can_confirm_contract(o.project_id)
     or (o.variation_order_id is not null and not private.can_see_vo(o.variation_order_id)) then
    raise exception 'Obligation not found or not allowed' using errcode = '42501';
  end if;
  if nullif(btrim(note), '') is null then
    raise exception 'Say why this obligation is waived' using errcode = '22023';
  end if;
  update public.obligations
  set status = 'waived', closed_by = (select auth.uid()), closed_at = now(), close_note = btrim(note)
  where id = oid and status in ('open','overdue','suggested');
end $$;

create function update_deadline_settings(
  pid uuid, cutoff time, saturday_working boolean, schedule jsonb default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_project_owner(pid) or private.can_confirm_contract(pid)) then
    raise exception 'Only owners or contract roles can change deadline settings' using errcode = '42501';
  end if;
  insert into public.project_deadline_settings
    (project_id, service_cutoff, saturday_is_working_day, reminder_schedule, updated_by, updated_at)
  values (pid, cutoff, saturday_working, schedule, (select auth.uid()), now())
  on conflict (project_id) do update
    set service_cutoff = excluded.service_cutoff, saturday_is_working_day = excluded.saturday_is_working_day,
        reminder_schedule = excluded.reminder_schedule, updated_by = excluded.updated_by, updated_at = now();
  perform private.enqueue_recalculation(pid);
end $$;

create function mark_notifications_read(ids uuid[]) returns void
language sql security definer set search_path = '' as $$
  update public.notifications set read_at = now()
  where id = any(ids) and user_id = (select auth.uid()) and read_at is null
$$;

grant execute on function
  set_contract_field(uuid, text, jsonb, boolean),
  update_deadline_rule(uuid, jsonb),
  verify_deadline_rule(uuid),
  reject_deadline_rule(uuid),
  create_deadline_rule(uuid, jsonb),
  log_project_event(uuid, text, timestamptz, timestamptz, text, text, text, uuid, uuid, integer, text[], text),
  void_project_event(uuid),
  mark_obligation_met(uuid, text),
  confirm_suggested_obligation(uuid),
  waive_obligation(uuid, text),
  update_deadline_settings(uuid, time, boolean, jsonb),
  mark_notifications_read(uuid[])
to authenticated;

revoke execute on function
  set_contract_field(uuid, text, jsonb, boolean),
  update_deadline_rule(uuid, jsonb),
  verify_deadline_rule(uuid),
  reject_deadline_rule(uuid),
  create_deadline_rule(uuid, jsonb),
  log_project_event(uuid, text, timestamptz, timestamptz, text, text, text, uuid, uuid, integer, text[], text),
  void_project_event(uuid),
  mark_obligation_met(uuid, text),
  confirm_suggested_obligation(uuid),
  waive_obligation(uuid, text),
  update_deadline_settings(uuid, time, boolean, jsonb),
  mark_notifications_read(uuid[])
from public, anon;

revoke execute on function
  public.deadline_rule_reverify(),
  public.log_contract_field_change(),
  public.close_obligations_on_response()
from public, anon, authenticated;

-- The service role (Edge Functions) reads and writes everything; RLS doesn't apply to it.
grant select, insert, update on obligations, obligation_queue, notifications, reminders_sent,
  project_events, deadline_rules
to service_role;


-- =====================================================================
-- 10. REALTIME
-- =====================================================================
do $$
declare
  t text;
begin
  foreach t in array array['obligations','notifications'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
