-- pgTAP: contractual layer of variation orders (migration 0023).
-- Run with:  supabase test db
begin;

create extension if not exists pgtap with schema extensions;

select plan(52);

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
-- Reads a VO bypassing RLS (as the test owner).
create function tests.vo(k text) returns public.variation_orders language sql security definer as $$
  select * from public.variation_orders where id = current_setting('t.' || k)::uuid
$$;
grant execute on function tests.vo(text) to authenticated;

-- alice: owner, QS, contractor side.  bob: member, no confirming role.  carol: guest.  dave: member.
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
  (tests.v('p1'), '33333333-3333-3333-3333-333333333333', 'guest'),
  (tests.v('p1'), '44444444-4444-4444-4444-444444444444', 'member');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select set_member_job_role(tests.v('p1'), '11111111-1111-1111-1111-111111111111', 'quantity_surveyor'),
       set_member_contract_party(tests.v('p1'), '11111111-1111-1111-1111-111111111111', 'contractor');
select set_contract_field(tests.v('p1'), 'contract_sum', '{"amount": 1000000, "currency": "SGD"}');

-- ---------------------------------------------------------------------
-- Transition table mirrors VO_TRANSITIONS in _shared/contracts/variations.ts
-- ---------------------------------------------------------------------
reset role;
select set_eq(
  'select from_status, to_status from private.vo_status_transitions',
  $$ values
    ('identified','instructed'),('identified','quotation_submitted'),('identified','valuation_issued'),('identified','agreed'),
    ('identified','disputed'),('identified','rejected'),('identified','withdrawn'),
    ('instructed','quotation_submitted'),('instructed','valuation_issued'),('instructed','agreed'),
    ('instructed','disputed'),('instructed','rejected'),('instructed','withdrawn'),
    ('quotation_submitted','valuation_issued'),('quotation_submitted','agreed'),
    ('quotation_submitted','disputed'),('quotation_submitted','rejected'),('quotation_submitted','withdrawn'),
    ('valuation_issued','agreed'),('valuation_issued','disputed'),('valuation_issued','rejected'),('valuation_issued','withdrawn'),
    ('unconfirmed','identified'),('unconfirmed','instructed'),('unconfirmed','withdrawn'),
    ('disputed','valuation_issued'),('disputed','agreed'),('disputed','rejected'),('disputed','withdrawn') $$,
  'SQL transitions match the shared TypeScript list');

-- ---------------------------------------------------------------------
-- VO-1 (bob, shared with alice and carol): quotation -> valuation -> agreed
-- ---------------------------------------------------------------------
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select set_config('t.vo1', create_variation_order(tests.v('p1'), 'Extra slab opening', 'Client', null, null, null,
  array['11111111-1111-1111-1111-111111111111']::uuid[], array['33333333-3333-3333-3333-333333333333']::uuid[])::text, true);

select is((tests.vo('vo1')).contract_status, 'identified', 'new VOs start identified');

select throws_ok($$ update variation_orders set agreed_amount = 1 where id = tests.v('vo1') $$,
  '42501', null, 'amounts cannot be written directly');

select lives_ok($$ select update_variation_contract(tests.v('vo1'), '{"claimed_amount": 11000, "source": "client_request"}') $$,
  'a member records the claimed amount');
select is((select count(*)::int from variation_amount_history where variation_order_id = tests.v('vo1') and field = 'claimed_amount'),
  1, 'the change is in the history');
select is((select changed_by from variation_amount_history where variation_order_id = tests.v('vo1') and field = 'claimed_amount'),
  '22222222-2222-2222-2222-222222222222'::uuid, 'history records who changed it');

select throws_ok($$ select update_variation_contract(tests.v('vo1'), '{"agreed_amount": 9000}') $$,
  '42501', null, 'a member without a confirming role cannot set the agreed amount');
select throws_ok($$ select update_variation_contract(tests.v('vo1'), '{"contract_status": "agreed"}') $$,
  '42501', null, 'a member without a confirming role cannot mark it agreed');
select throws_ok($$ select update_variation_contract(tests.v('vo1'), '{"contract_status": "unconfirmed"}') $$,
  '22023', null, 'invalid transition identified -> unconfirmed is rejected');
select throws_ok($$ select update_variation_contract(tests.v('vo1'), '{"claimed_amount": -5}') $$,
  '22023', null, 'negative amounts are rejected (omissions use is_omission)');
select throws_ok($$ select update_variation_contract(tests.v('vo1'), '{"number": 99}') $$,
  '22023', null, 'unknown keys are rejected');

select set_config('t.q1', log_variation_event(tests.v('vo1'), 'variation_quotation_submitted', now() - interval '2 days',
  now() - interval '2 days', 'VQ-1', 'contractor', 'contract_admin', null, 12000, 14)::text, true);
select is((tests.vo('vo1')).contract_status, 'quotation_submitted', 'a quotation moves the VO to quotation_submitted');
select is((tests.vo('vo1')).claimed_amount, 12000.00, 'the quotation amount is the claimed amount');
select is((tests.vo('vo1')).time_impact_days_claimed, 14, 'and its time the claimed time');
select ok((tests.vo('vo1')).time_impact_claimed_at is not null, 'when the time claim was recorded is stamped');
select is((select source_event_id from variation_amount_history
           where variation_order_id = tests.v('vo1') and field = 'claimed_amount' order by id desc limit 1),
  tests.v('q1'), 'history links the change to the quotation event');
select is((select source_event_id from variation_amount_history
           where variation_order_id = tests.v('vo1') and field = 'contract_status' order by id desc limit 1),
  tests.v('q1'), 'the status change is linked to the event too');
reset role;
select ok(exists (select 1 from obligation_queue where project_id = tests.v('p1') and reason = 'recalculate' and processed_at is null),
  'a time claim queues a recalculation (EOT notice suggestion)');

-- A valuation logged as a plain event answering the quotation inherits the VO.
select tests.auth_as('11111111-1111-1111-1111-111111111111');
select set_config('t.val1', log_project_event(tests.v('p1'), 'variation_valuation_issued', now() - interval '1 day',
  now() - interval '1 day', 'VV-1', 'qs', 'contractor', tests.v('q1'))::text, true);
select is((select variation_order_id from project_events where id = tests.v('val1')), tests.v('vo1'),
  'a response inherits the VO of the event it answers');
select is((tests.vo('vo1')).contract_status, 'valuation_issued', 'and moves the VO along');
select lives_ok($$ select update_variation_contract(tests.v('vo1'), '{"assessed_amount": 10000}', tests.v('val1')) $$,
  'assessed amount recorded against the valuation');

select throws_ok($$ select update_variation_contract(tests.v('vo1'), '{"contract_status": "agreed"}') $$,
  '22023', null, 'agreed needs an agreed amount');
select lives_ok($$ select update_variation_contract(tests.v('vo1'), '{"contract_status": "agreed", "agreed_amount": 9000, "time_impact_days_agreed": 10}', null, 'Agreed at site meeting') $$,
  'a QS marks it agreed with the amount and time');
select is((select note from variation_amount_history where variation_order_id = tests.v('vo1') and field = 'agreed_amount'),
  'Agreed at site meeting', 'the note is kept in the history');
select throws_ok($$ select update_variation_contract(tests.v('vo1'), '{"contract_status": "disputed"}') $$,
  '22023', null, 'agreed is final');

-- Objection on an agreed VO leaves it agreed (the event is still logged).
select lives_ok($$ select log_variation_event(tests.v('vo1'), 'variation_objection_served', now(), now(), null) $$,
  'an objection can still be logged');
select is((tests.vo('vo1')).contract_status, 'agreed', 'but does not move a final status');

-- ---------------------------------------------------------------------
-- VO-2 omission, VO-3 pending, VO-4 private to bob, VO-5 withdrawn
-- ---------------------------------------------------------------------
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select set_config('t.vo2', create_variation_order(tests.v('p1'), 'Omit canopy', 'Client', null, null, null,
  null, array['11111111-1111-1111-1111-111111111111']::uuid[])::text, true);
select set_config('t.vo3', create_variation_order(tests.v('p1'), 'Extra sockets', 'Architect', null, null, null,
  null, array['11111111-1111-1111-1111-111111111111']::uuid[])::text, true);
select set_config('t.vo4', create_variation_order(tests.v('p1'), 'Private change', 'Client')::text, true);
select set_config('t.vo5', create_variation_order(tests.v('p1'), 'Dropped idea', 'Client', null, null, null,
  null, array['11111111-1111-1111-1111-111111111111']::uuid[])::text, true);
select update_variation_contract(tests.v('vo3'), '{"contract_status": "instructed", "claimed_amount": 500}');
select update_variation_contract(tests.v('vo4'), '{"claimed_amount": 700}');
select update_variation_contract(tests.v('vo5'), '{"claimed_amount": 99999}');

-- An obligation tied to VO-5 is waived (not deleted) when it is withdrawn.
reset role;
insert into deadline_rules (id, project_id, rule_key, group_key, obligation, reminder_label, responsible_role, recipient_role,
  trigger_event_type, period, unit, is_time_bar, origin, status, verified_at)
values ('aaaaaaaa-0000-0000-0000-000000000001', tests.v('p1'), 'user_defined.test', 'eot_notice', 'Give EOT notice', 'EOT notice',
  'contractor', 'contract_admin', 'chained', 28, 'calendar_days', true, 'user_defined', 'verified', now());
insert into obligations (project_id, rule_id, rule_key, group_key, kind, anchor, variation_order_id, obligation, reminder_label,
  responsible_party, recipient_party, due_at, due_date, explanation, period, unit, source_label, status)
values (tests.v('p1'), 'aaaaaaaa-0000-0000-0000-000000000001', 'user_defined.test', 'eot_notice', 'action', 'variation',
  tests.v('vo5'), 'Give EOT notice', 'EOT notice', 'contractor', 'contract_admin', now() + interval '20 days',
  (now() + interval '20 days')::date, 'x', 28, 'calendar_days', 'test', 'suggested');
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select update_variation_contract(tests.v('vo5'), '{"contract_status": "withdrawn"}');
reset role;
select is((select status from obligations where variation_order_id = tests.v('vo5')), 'waived',
  'withdrawing a VO waives its open deadlines');
select is((select close_note from obligations where variation_order_id = tests.v('vo5')), 'VO-5 withdrawn',
  'with a note saying why');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select lives_ok($$ select update_variation_contract(tests.v('vo2'), '{"is_omission": true, "contract_status": "agreed", "agreed_amount": 2000}') $$,
  'QS agrees an omission');

-- ---------------------------------------------------------------------
-- Contract sum
-- ---------------------------------------------------------------------
select results_eq(
  $$ select currency, original, agreed, pending, disputed, revised, revised_incl_pending, vo_count, unpriced_count
     from project_contract_sum(tests.v('p1')) $$,
  $$ values ('SGD'::text, 1000000::numeric, 7000.00::numeric, 1200.00::numeric, 0::numeric,
             1007000.00::numeric, 1008200.00::numeric, 5, 0) $$,
  'revised = 1,000,000 + 9,000 - 2,000 omission; pending counts VO-3 and the private VO-4; withdrawn left out');
select is((select count(*)::int from variation_orders where id = tests.v('vo4')), 0,
  'alice cannot see VO-4 itself, only its amount in the total');

select tests.auth_as('22222222-2222-2222-2222-222222222222');
select throws_ok($$ select * from project_contract_sum(tests.v('p1')) $$, '42501', null,
  'the contract sum needs a contract role');

-- ---------------------------------------------------------------------
-- Visibility
-- ---------------------------------------------------------------------
select tests.auth_as('33333333-3333-3333-3333-333333333333');
select ok((select count(*) from variation_amount_history where variation_order_id = tests.v('vo1')) > 0,
  'a guest included in the VO reads its history');
select throws_ok($$ select update_variation_contract(tests.v('vo1'), '{"claimed_amount": 1}') $$,
  '42501', null, 'guests cannot change it');

select tests.auth_as('44444444-4444-4444-4444-444444444444');
select is((select count(*)::int from variation_amount_history where variation_order_id = tests.v('vo1')), 0,
  'a member not included sees no history');
select throws_ok($$ select update_variation_contract(tests.v('vo1'), '{"claimed_amount": 1}') $$,
  'P0002', null, 'and cannot change it');

-- History is append-only.
reset role;
select throws_ok($$ update variation_amount_history set note = 'x' where variation_order_id = tests.v('vo1') $$,
  '42501', null, 'history cannot be edited (even by the owner role)');
select throws_ok($$ delete from variation_amount_history where variation_order_id = tests.v('vo1') $$,
  '42501', null, 'history cannot be deleted');

-- ---------------------------------------------------------------------
-- Site instruction: unconfirmed until confirmed in writing
-- ---------------------------------------------------------------------
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select set_config('t.si', record_site_instruction(tests.v('p1'), 'Move door D12', 'Client rep on site', 'employer',
  now() - interval '1 hour', 'Level 3', null, 'OI-1')->>'variation_order_id', true);
select is((tests.vo('si')).contract_status, 'unconfirmed', 'a site instruction starts unconfirmed');
select is((tests.vo('si')).instructing_party, 'employer', 'with the instructing party');
select is((select count(*)::int from variation_amount_history where variation_order_id = tests.v('si')), 0,
  'starting as unconfirmed is not logged as a change');
select set_config('t.oi', (select id::text from project_events where variation_order_id = tests.v('si')
                           and event_type = 'oral_instruction_received'), true);
select ok(tests.v('oi') is not null, 'and an oral_instruction_received event on the VO');
reset role;
select ok(exists (select 1 from obligation_queue where event_id = tests.v('oi')), 'which is queued for its confirmation deadline');

select tests.auth_as('22222222-2222-2222-2222-222222222222');
select log_project_event(tests.v('p1'), 'oral_instruction_confirmed', now(), now(), 'CVI-1', 'contractor', 'contract_admin', tests.v('oi'));
select is((tests.vo('si')).contract_status, 'instructed', 'written confirmation makes it instructed');
select is((tests.vo('si')).source, 'oral_instruction_confirmed', 'source: oral instruction, confirmed');
select is((tests.vo('si')).instruction_reference, 'CVI-1', 'the confirmation is the instruction reference');

-- ---------------------------------------------------------------------
-- From an instruction event; payment claims
-- ---------------------------------------------------------------------
select tests.auth_as('11111111-1111-1111-1111-111111111111');
select set_config('t.ai', log_project_event(tests.v('p1'), 'instruction_issued', now(), now(), 'AI-045', 'contract_admin', 'contractor')::text, true);
select set_config('t.vo6', create_variation_order(tests.v('p1'), 'AI-045 works', 'Architect')::text, true);
select link_variation_instruction(tests.v('vo6'), tests.v('ai'));
select is((tests.vo('vo6')).contract_status, 'instructed', 'linking an instruction makes the VO instructed');
select is((tests.vo('vo6')).source, 'written_instruction', 'from a written instruction');
select is((select variation_order_id from project_events where id = tests.v('ai')), tests.v('vo6'),
  'the instruction now belongs to the VO');

select set_config('t.pc', log_project_event(tests.v('p1'), 'payment_claim_served', now(), now(), 'PC-07', 'contractor', 'employer')::text, true);
select is(set_payment_claim_variations(tests.v('pc'), array[tests.v('vo1'), tests.v('vo2')]), 2,
  'agreed VOs are included in the payment claim');
select throws_ok($$ select set_payment_claim_variations(tests.v('pc'), array[tests.v('vo3')]) $$,
  '22023', null, 'VOs that are not agreed cannot be included');

select * from finish();
rollback;
