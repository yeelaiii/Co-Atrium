-- pgTAP: the contract form declared at upload and standard-form default proposals (migration 0025).
-- Run with:  supabase test db
begin;

create extension if not exists pgtap with schema extensions;

select plan(34);

create schema tests;
grant usage on schema tests to authenticated, service_role;
create function tests.v(k text) returns uuid language sql stable as $$ select current_setting('t.' || k)::uuid $$;
grant execute on function tests.v(text) to authenticated, service_role;
create function tests.auth_as(uid uuid) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uid::text, true);
  set local role authenticated;
end $$;
create function tests.as_service() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  set local role service_role;
end $$;
-- Rows bypassing RLS (as the test owner).
create function tests.doc(k text) returns public.contract_documents language sql security definer as $$
  select * from public.contract_documents where id = current_setting('t.' || k)::uuid
$$;
create function tests.ef(did text, fkey text) returns public.extracted_fields language sql security definer as $$
  select * from public.extracted_fields where document_id = current_setting('t.' || did)::uuid and field_key = fkey
  order by created_at desc limit 1
$$;
create function tests.pcf(fkey text) returns public.project_contract_fields language sql security definer as $$
  select * from public.project_contract_fields where project_id = current_setting('t.p1')::uuid and field_key = fkey
$$;
grant execute on function tests.doc(text), tests.ef(text, text), tests.pcf(text) to authenticated, service_role;

-- alice: owner + QS.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@test.local', '{"display_name":"Alice"}');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select set_config('t.p1', create_project('Tower A')::text, true);
select set_member_job_role(tests.v('p1'), '11111111-1111-1111-1111-111111111111', 'quantity_surveyor'),
       set_member_contract_party(tests.v('p1'), '11111111-1111-1111-1111-111111111111', 'contractor');
-- Already confirmed: a default must not reopen it.
select set_contract_field(tests.v('p1'), 'notice_of_claim_period', '{"value":28,"unit":"calendar_days"}');

-- A library rule only this test's form uses, to see confirming the declared form copy it.
reset role;
insert into rule_library (library_version, rule_key, group_key, obligation, reminder_label, responsible_role,
  recipient_role, trigger_event_type, period, unit, period_field, origin, clause_ref, applies_to_contract_forms)
values ('9999.1', 'test_redas.payment_response', 'payment_response', 'Respond to the payment claim', 'payment response',
  'contract_admin', 'contractor', 'payment_claim_served', 21, 'calendar_days', 'payment_response_period',
  'standard_form_default', '7.3', array['REDAS']);

insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('contract-documents', tests.v('p1') || '/bbbbbbbb-0000-4000-8000-000000000001.pdf', '11111111-1111-1111-1111-111111111111', '{"size": 1000}'),
  ('contract-documents', tests.v('p1') || '/bbbbbbbb-0000-4000-8000-000000000002.pdf', '11111111-1111-1111-1111-111111111111', '{"size": 1000}'),
  ('contract-documents', tests.v('p1') || '/bbbbbbbb-0000-4000-8000-000000000003.pdf', '11111111-1111-1111-1111-111111111111', '{"size": 1000}');

-- ---------------------------------------------------------------------
-- register_contract_document with a declared form
-- ---------------------------------------------------------------------
select tests.auth_as('11111111-1111-1111-1111-111111111111');
select lives_ok($$ select set_config('t.d1', register_contract_document(tests.v('p1'),
  tests.v('p1') || '/bbbbbbbb-0000-4000-8000-000000000001.pdf', 'sia.pdf', 'application/pdf', 'SIA_2016_LUMP_SUM')::text, true) $$,
  'register with a declared form');
select is((tests.doc('d1')).declared_form, 'SIA_2016_LUMP_SUM', 'the declared form is stored');

select lives_ok($$ select set_config('t.d2', register_contract_document(tests.v('p1'),
  tests.v('p1') || '/bbbbbbbb-0000-4000-8000-000000000002.pdf', 'unsure.pdf', 'application/pdf')::text, true) $$,
  'the four-argument call still works ("not sure")');
select is((tests.doc('d2')).declared_form, null, 'no declared form');

select throws_ok($$ select register_contract_document(tests.v('p1'),
  tests.v('p1') || '/bbbbbbbb-0000-4000-8000-000000000003.pdf', 'x.pdf', 'application/pdf', 'UNKNOWN') $$,
  '22023', 'Unknown contract form', 'UNKNOWN cannot be declared');
select throws_ok($$ select register_contract_document(tests.v('p1'),
  tests.v('p1') || '/bbbbbbbb-0000-4000-8000-000000000003.pdf', 'x.pdf', 'application/pdf', 'FIDIC_1999') $$,
  '22023', 'Unknown contract form', 'an unlisted form is rejected');
select lives_ok($$ select set_config('t.d3', register_contract_document(tests.v('p1'),
  tests.v('p1') || '/bbbbbbbb-0000-4000-8000-000000000003.pdf', 'redas.pdf', 'application/pdf', 'REDAS')::text, true) $$,
  'the rejected calls registered nothing');

-- ---------------------------------------------------------------------
-- Table constraints (service role, as the pipeline)
-- ---------------------------------------------------------------------
select tests.as_service();
select throws_ok($$ update contract_documents set declared_form = 'UNKNOWN' where id = tests.v('d1') $$,
  '23514', null, 'the column only takes declarable forms');
select lives_ok($$ select count(*) from rule_library $$, 'the pipeline can read the rule library');

select throws_ok($$ insert into extracted_fields (project_id, document_id, field_key, value, origin, confidence)
  values (tests.v('p1'), tests.v('d1'), 'payment_response_period', '{"value":21,"unit":"calendar_days"}', 'standard_form_default', 0) $$,
  '23514', null, 'a form default must name its source');
select throws_ok($$ insert into extracted_fields (project_id, document_id, field_key, value, origin, confidence)
  values (tests.v('p1'), tests.v('d1'), 'contract_sum', '{"amount":1,"currency":"SGD"}', 'declared', 0) $$,
  '23514', null, 'only the contract form can be declared');
select throws_ok($$ insert into extracted_fields (project_id, document_id, field_key, value, origin, confidence)
  values (tests.v('p1'), tests.v('d1'), 'contract_sum', '{"amount":1,"currency":"SGD"}', 'extracted', 0) $$,
  '23514', null, 'an extracted value still needs a page and an excerpt');
select throws_ok($$ insert into extracted_fields (project_id, document_id, field_key, value, origin, default_source, confidence)
  values (tests.v('p1'), tests.v('d1'), 'payment_response_period', '{"value":21,"unit":"calendar_days"}', 'guessed', 'x', 0) $$,
  '23514', null, 'origin is one of the listed values');

-- ---------------------------------------------------------------------
-- write_extraction_results
-- ---------------------------------------------------------------------
select lives_ok($$ select write_extraction_results(tests.v('d1'),
  '[{"field_key":"contract_sum","value":{"amount":1250000,"currency":"SGD"},"page_no":1,"source_excerpt":"The Contract Sum is S$1,250,000.00","confidence":0.95,"not_found_reason":null,"provider":"p","model":"m"},
    {"field_key":"payment_response_period","value":{"value":21,"unit":"calendar_days"},"page_no":null,"source_excerpt":null,"confidence":0,"not_found_reason":null,"provider":null,"model":null,"origin":"standard_form_default","default_source":"SIA Building Contract 2016 (lump sum), clause 40(3)"},
    {"field_key":"oral_instruction_confirmation_period","value":{"value":7,"unit":"calendar_days"},"page_no":null,"source_excerpt":null,"confidence":0,"not_found_reason":null,"provider":null,"model":null,"origin":"standard_form_default","default_source":"SIA Building Contract 2016 (lump sum), clause 1(3)"},
    {"field_key":"notice_of_claim_period","value":{"value":7,"unit":"calendar_days"},"page_no":null,"source_excerpt":null,"confidence":0,"not_found_reason":null,"provider":null,"model":null,"origin":"standard_form_default","default_source":"SIA Building Contract 2016 (lump sum), clause 23(1)"}]',
  '[]', '[]') $$,
  'the pipeline writes extracted values and form defaults together');

select is((tests.ef('d1', 'contract_sum')).origin, 'extracted', 'no origin in the payload means extracted');
select is((tests.ef('d1', 'payment_response_period')).origin, 'standard_form_default', 'a default is stored as such');
select is((tests.ef('d1', 'payment_response_period')).default_source,
  'SIA Building Contract 2016 (lump sum), clause 40(3)', 'with the clause it comes from');
select is((tests.ef('d1', 'payment_response_period')).status, 'proposed', 'a default is only a proposal');
select is((tests.ef('d1', 'payment_response_period')).page_no, null, 'and cites no page');
select is((tests.ef('d1', 'notice_of_claim_period')).id, null, 'a default never reopens a confirmed field');
select is((tests.pcf('notice_of_claim_period')).value, '{"value":28,"unit":"calendar_days"}'::jsonb, 'the confirmed value stands');

-- The document names no form: the declared one is proposed, without a citation.
select lives_ok($$ select write_extraction_results(tests.v('d3'),
  '[{"field_key":"contract_form","value":"REDAS","page_no":null,"source_excerpt":null,"confidence":0,"not_found_reason":null,"provider":null,"model":null,"origin":"declared","default_source":null}]',
  '[]', '[]') $$,
  'the declared form is written as a proposal');
select is((tests.ef('d3', 'contract_form')).origin, 'declared', 'stored as declared');

-- ---------------------------------------------------------------------
-- Confirming
-- ---------------------------------------------------------------------
select tests.auth_as('11111111-1111-1111-1111-111111111111');
select lives_ok($$ select confirm_extracted_field((tests.ef('d1', 'payment_response_period')).id) $$, 'accept a form default');
select is((tests.pcf('payment_response_period')).origin, 'standard_form_default', 'confirmed as a standard form default');
select is((tests.pcf('payment_response_period')).source_page, null, 'with no page of the document');
select is((tests.pcf('payment_response_period')).value, '{"value":21,"unit":"calendar_days"}'::jsonb, 'the default value');

select lives_ok($$ select confirm_extracted_field((tests.ef('d1', 'oral_instruction_confirmation_period')).id,
  '{"value":3,"unit":"working_days"}') $$, 'accept a default with an edit');
select is((tests.pcf('oral_instruction_confirmation_period')).origin, 'user_entered', 'an edited default is user entered');

select lives_ok($$ select confirm_extracted_field((tests.ef('d1', 'contract_sum')).id) $$, 'accept an extracted value');
select is((tests.pcf('contract_sum')).origin, 'extracted', 'extracted values are unchanged');

select lives_ok($$ select confirm_extracted_field((tests.ef('d3', 'contract_form')).id) $$, 'accept the declared form');
select is((tests.pcf('contract_form')).origin, 'user_entered', 'the declared form counts as user entered');
select is((select count(*)::int from deadline_rules where project_id = tests.v('p1') and rule_key = 'test_redas.payment_response'),
  1, 'confirming it copies that form''s library rules');

select * from finish();
rollback;
