-- pgTAP: roles and parties, contract fields, deadline rules, events and obligations (migrations 0019, 0020, 0026).
-- Due dates are computed by the Edge Functions; here obligations are inserted directly to test
-- the SQL side: permissions, RLS, verification guards and closing on responses.
-- Run with:  supabase test db
begin;

create extension if not exists pgtap with schema extensions;

select plan(56);

create schema tests;
grant usage on schema tests to authenticated;
create function tests.v(k text) returns uuid language sql stable as $$ select current_setting('t.' || k)::uuid $$;
grant execute on function tests.v(text) to authenticated;
create function tests.auth_as(uid uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uid::text, true);
  set local role authenticated;
end $$;
create function tests.rule_id(k text) returns uuid language sql security definer as $$
  select id from public.deadline_rules where project_id = current_setting('t.p1')::uuid and rule_key = k
$$;
grant execute on function tests.rule_id(text) to authenticated;

-- alice: owner + QS (contractor side). bob: member, no confirming role (contract administrator side).
-- carol: guest. dave: outsider.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@test.local', '{"display_name":"Alice"}'),
  ('22222222-2222-2222-2222-222222222222', 'bob@test.local',   '{"display_name":"Bob"}'),
  ('33333333-3333-3333-3333-333333333333', 'carol@test.local', '{"display_name":"Carol"}'),
  ('44444444-4444-4444-4444-444444444444', 'dave@test.local',  '{"display_name":"Dave"}');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select set_config('t.p1', create_project('Tower A')::text, true);
reset role;
insert into project_members (project_id, user_id, role) values
  (tests.v('p1'), '22222222-2222-2222-2222-222222222222', 'member'),
  (tests.v('p1'), '33333333-3333-3333-3333-333333333333', 'guest');

-- ---------------------------------------------------------------------
-- Roles and parties (0019, 0026)
-- ---------------------------------------------------------------------
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select throws_ok(format($$ select set_member_job_role(%L, %L, 'quantity_surveyor') $$,
  tests.v('p1'), '22222222-2222-2222-2222-222222222222'), '42501', null, 'members cannot set roles');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select lives_ok(format($$ select set_member_job_role(%L, %2$L, 'quantity_surveyor'), set_member_contract_party(%1$L, %2$L, 'contractor') $$,
  tests.v('p1'), '11111111-1111-1111-1111-111111111111'), 'owner sets own role and party');
select lives_ok(format($$ select set_member_contract_party(%L, %L, 'contract_admin') $$,
  tests.v('p1'), '22222222-2222-2222-2222-222222222222'), 'owner sets a member''s party');
select lives_ok(format($$ select set_member_job_role(%L, %2$L, 'project_manager'), set_member_contract_party(%1$L, %2$L, 'subcontractor') $$,
  tests.v('p1'), '33333333-3333-3333-3333-333333333333'), 'owner gives the guest a confirming role');
select throws_ok(format($$ select set_member_job_role(%L, %L, 'boss') $$,
  tests.v('p1'), '22222222-2222-2222-2222-222222222222'), '22023', null, 'invalid role rejected');

-- ---------------------------------------------------------------------
-- Contract fields
-- ---------------------------------------------------------------------
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select throws_ok(format($$ select set_contract_field(%L, 'contract_form', '"SIA_2016_LUMP_SUM"') $$, tests.v('p1')),
  '42501', null, 'member without a confirming role cannot confirm fields');

select tests.auth_as('33333333-3333-3333-3333-333333333333');
select throws_ok(format($$ select set_contract_field(%L, 'contract_form', '"SIA_2016_LUMP_SUM"') $$, tests.v('p1')),
  '42501', null, 'a guest with a confirming role still cannot confirm (access must be owner/member)');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select lives_ok(format($$ select set_contract_field(%L, 'contract_form', '"SIA_2016_LUMP_SUM"') $$, tests.v('p1')),
  'QS confirms the contract form');
select ok((select count(*) from deadline_rules where project_id = tests.v('p1')) >= 12,
  'confirming the form copies the library rules');
select is((select count(*)::int from deadline_rules where project_id = tests.v('p1') and status <> 'draft'), 0,
  'copied rules start as draft');
select ok(tests.rule_id('sopa.payment_response') is not null and tests.rule_id('sia2016_ls.eot_notice') is not null
          and tests.rule_id('contract.completion') is not null, 'statute, form and common rules are copied');
select is((select todo_verify from deadline_rules where id = tests.rule_id('sia2016_ls.variation_valuation')),
  array['period','unit','includes_public_holidays','is_time_bar','clause_ref'], 'form rules carry their TODO_VERIFY list');

select throws_ok(format($$ select set_contract_field(%L, 'contract_form', null, true) $$, tests.v('p1')),
  '22023', null, 'contract form cannot be "not stated"');
select lives_ok(format($$ select set_contract_field(%L, 'payment_response_period', null, true) $$, tests.v('p1')),
  'a field can be confirmed as not stated');
select lives_ok(format($$ select set_contract_field(%L, 'payment_response_period', '{"value":30,"unit":"calendar_days"}') $$, tests.v('p1')),
  'then given a value');
select is((select count(*)::int from project_contract_field_history
           where project_id = tests.v('p1') and field_key = 'payment_response_period'), 2, 'field changes are audited');
reset role;
select ok(exists (select 1 from obligation_queue where project_id = tests.v('p1') and reason = 'recalculate' and processed_at is null),
  'confirming fields queues a recalculation');
select tests.auth_as('11111111-1111-1111-1111-111111111111');

-- ---------------------------------------------------------------------
-- Rules
-- ---------------------------------------------------------------------
select throws_ok(format($$ select verify_deadline_rule(%L) $$, tests.rule_id('sia2016_ls.variation_valuation')),
  '22023', null, 'a rule with TODO_VERIFY values cannot be verified');
select lives_ok(format($$ select verify_deadline_rule(%L) $$, tests.rule_id('sopa.payment_response')),
  'the complete SOP Act rule can be verified');

select lives_ok(format($$ select update_deadline_rule(%L, '{"period":28,"unit":"calendar_days","includes_public_holidays":true,"is_time_bar":true,"source_clause":"TBC by QS"}') $$,
  tests.rule_id('sia2016_ls.eot_notice')), 'QS fills in the TODO_VERIFY values');
select is((select todo_verify from deadline_rules where id = tests.rule_id('sia2016_ls.eot_notice')), '{}'::text[],
  'filled values clear TODO_VERIFY');
select lives_ok(format($$ select verify_deadline_rule(%L) $$, tests.rule_id('sia2016_ls.eot_notice')), 'then it verifies');
select lives_ok(format($$ select update_deadline_rule(%L, '{"period":21}') $$, tests.rule_id('sia2016_ls.eot_notice')),
  'editing the period of a verified rule');
select is((select status from deadline_rules where id = tests.rule_id('sia2016_ls.eot_notice')), 'draft',
  'puts it back to draft');
select throws_ok(format($$ select update_deadline_rule(%L, '{"status":"verified"}') $$, tests.rule_id('sia2016_ls.eot_notice')),
  '22023', null, 'status cannot be patched directly');

select lives_ok(format($$ select set_config('t.rfi_rule', create_deadline_rule(%L, '{"origin":"project_procedure","group_key":"rfi_reply","obligation":"Reply to the RFI","reminder_label":"reply","responsible_role":"contract_admin","recipient_role":"contractor","trigger_event_type":"rfi_submitted","period":7,"unit":"working_days","closed_by_event_types":["rfi_responded"],"chains_to":["eot_notice"]}')::text, true) $$,
  tests.v('p1')), 'QS adds a project procedure rule');
select lives_ok(format($$ select verify_deadline_rule(%L) $$, tests.v('rfi_rule')), 'and verifies it');

select tests.auth_as('22222222-2222-2222-2222-222222222222');
select throws_ok(format($$ select verify_deadline_rule(%L) $$, tests.rule_id('contract.completion')),
  '42501', null, 'members without a confirming role cannot verify rules');
select throws_ok(format($$ update deadline_rules set status = 'verified' where id = %L $$, tests.rule_id('contract.completion')),
  '42501', null, 'and cannot write the table directly');

-- ---------------------------------------------------------------------
-- Events and obligations
-- ---------------------------------------------------------------------
select tests.auth_as('33333333-3333-3333-3333-333333333333');
select throws_ok(format($$ select log_project_event(%L, 'rfi_submitted', now()) $$, tests.v('p1')),
  '42501', null, 'guests cannot log events');

select tests.auth_as('22222222-2222-2222-2222-222222222222');
select lives_ok(format($$ select set_config('t.e1', log_project_event(%L, 'rfi_submitted', now() - interval '2 days',
  ev_reference => 'RFI-023', ev_raised_by => 'contractor', ev_addressed_to => 'contract_admin')::text, true) $$, tests.v('p1')),
  'member logs an RFI');
select lives_ok(format($$ select set_config('t.e2', log_project_event(%L, 'rfi_submitted', now() - interval '1 day',
  ev_reference => 'RFI-024')::text, true) $$, tests.v('p1')), 'and another');
reset role;
select ok(exists (select 1 from obligation_queue where event_id = tests.v('e1') and reason = 'event'),
  'logging an event queues obligation creation');
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select throws_ok(format($$ select log_project_event(%L, 'rfi_submitted', now() + interval '3 days') $$, tests.v('p1')),
  '22023', null, 'future dates are rejected');

-- What create-obligations would write (service role).
reset role;
insert into obligations (project_id, rule_id, rule_key, group_key, kind, anchor, trigger_event_id, obligation,
  reminder_label, subject, responsible_party, recipient_party, due_at, due_date, explanation, period, unit,
  source_label, closed_by_event_types)
select tests.v('p1'), tests.v('rfi_rule'), r.rule_key, r.group_key, 'action', 'event', e.id, r.obligation,
  r.reminder_label, e.reference, 'contract_admin', 'contractor', now() + interval '5 days', current_date + 5,
  '7 working days after RFI submitted', 7, 'working_days', 'project procedure', array['rfi_responded']
from deadline_rules r, project_events e
where r.id = tests.v('rfi_rule') and e.id in (tests.v('e1'), tests.v('e2'));

select throws_ok(format($$ insert into obligations (project_id, rule_id, rule_key, group_key, kind, anchor, trigger_event_id,
  obligation, reminder_label, responsible_party, recipient_party, due_at, due_date, explanation, period, unit, source_label)
  values (%L, %L, 'x', 'rfi_reply', 'action', 'event', %L, 'x', 'x', 'contractor', 'employer', now(), current_date, 'x', 1,
  'calendar_days', 'x') $$, tests.v('p1'), tests.v('rfi_rule'), tests.v('e1')),
  '23505', null, 'one obligation per rule group per event (idempotent)');

select tests.auth_as('22222222-2222-2222-2222-222222222222');
select lives_ok(format($$ select log_project_event(%L, 'rfa_responded', now(), ev_related_event => %L) $$,
  tests.v('p1'), tests.v('e1')), 'an unrelated response type');
select is((select status from obligations where trigger_event_id = tests.v('e1')), 'open', 'does not close the RFI obligation');
select lives_ok(format($$ select log_project_event(%L, 'rfi_responded', now(), ev_reference => ' rfi-023') $$, tests.v('p1')),
  'RFI response by reference');
select is((select status from obligations where trigger_event_id = tests.v('e1')), 'met', 'closes the matching obligation');
select is((select status from obligations where trigger_event_id = tests.v('e2')), 'open', 'and only that one');

select is((select count(*)::int from obligations where project_id = tests.v('p1')), 2, 'members read obligations');
select tests.auth_as('33333333-3333-3333-3333-333333333333');
select is((select count(*)::int from obligations), 0, 'guests read no obligations');
select is((select count(*)::int from project_contract_fields), 0, 'or contract values');
select tests.auth_as('44444444-4444-4444-4444-444444444444');
select is((select count(*)::int from project_events), 0, 'outsiders read no events');

-- VO-linked obligations are for that VO's participants only.
select tests.auth_as('11111111-1111-1111-1111-111111111111');
select set_config('t.vo', create_variation_order(tests.v('p1'), 'Private VO', 'Client', participants => '{}'::uuid[])::text, true);
select set_config('t.e3', log_project_event(tests.v('p1'), 'instruction_issued', now(), ev_variation_order => tests.v('vo'))::text, true);
reset role;
update obligations set variation_order_id = tests.v('vo') where trigger_event_id = tests.v('e2');
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select is((select count(*)::int from obligations where variation_order_id is not null), 0,
  'members outside a private VO do not see its obligations');
select is((select count(*)::int from project_events where id = tests.v('e3')), 0, 'or its events');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select throws_ok(format($$ select waive_obligation(%L, '  ') $$,
  (select id from obligations where trigger_event_id = tests.v('e2'))), '22023', null, 'waiving needs a reason');

select lives_ok(format($$ select waive_obligation(%L, 'Superseded by revised RFI') $$,
  (select id from obligations where trigger_event_id = tests.v('e2'))), 'QS waives with a reason');

-- Suggested follow-ons need a person to confirm them.
reset role;
insert into obligations (project_id, rule_id, rule_key, group_key, kind, anchor, trigger_event_id, parent_obligation_id,
  obligation, reminder_label, responsible_party, recipient_party, due_at, due_date, explanation, period, unit, source_label, status)
select tests.v('p1'), tests.rule_id('sia2016_ls.eot_notice'), 'sia2016_ls.eot_notice', 'eot_notice', 'action', 'chained',
  tests.v('e1'), o.id, 'Give notice', 'EOT notice', 'contractor', 'contract_admin', now() + interval '20 days',
  current_date + 20, 'x', 21, 'calendar_days', 'standard form default', 'suggested'
from obligations o where o.trigger_event_id = tests.v('e1');
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select lives_ok(format($$ select confirm_suggested_obligation(%L) $$,
  (select id from obligations where anchor = 'chained')), 'a member confirms a suggested follow-on');
select is((select status from obligations where anchor = 'chained'), 'open', 'which becomes open');
select lives_ok(format($$ select mark_obligation_met(%L, 'Sent by email') $$,
  (select id from obligations where anchor = 'chained')), 'and marks it met by hand');
select is((select close_note from obligations where anchor = 'chained'), 'Sent by email', 'with the note');

-- Changing the contract form swaps the standard-form rules.
select tests.auth_as('11111111-1111-1111-1111-111111111111');
select lives_ok(format($$ select set_contract_field(%L, 'contract_form', '"PSSCOC_CW_2020"') $$, tests.v('p1')),
  'QS changes the contract form');
select is((select status from deadline_rules where id = tests.rule_id('sia2016_ls.eot_notice')), 'rejected',
  'rules of the old form are rejected');
select ok(tests.rule_id('psscoc_cw2020.eot_notice') is not null, 'rules of the new form are added');
select is((select status from deadline_rules where id = tests.rule_id('sopa.payment_response')), 'verified',
  'statute rules are kept as they were');

select * from finish();
rollback;
