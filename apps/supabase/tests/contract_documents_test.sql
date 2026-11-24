-- pgTAP: contract documents, extraction pipeline RPCs and field review (migration 0024).
-- Run with:  supabase test db
begin;

create extension if not exists pgtap with schema extensions;

select plan(55);

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
grant execute on function tests.doc(text), tests.ef(text, text) to authenticated, service_role;

-- alice: owner + QS.  bob: member, no contract role.  carol: guest.  eve: not in the project.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@test.local', '{"display_name":"Alice"}'),
  ('22222222-2222-2222-2222-222222222222', 'bob@test.local',   '{"display_name":"Bob"}'),
  ('33333333-3333-3333-3333-333333333333', 'carol@test.local', '{"display_name":"Carol"}'),
  ('55555555-5555-5555-5555-555555555555', 'eve@test.local',   '{"display_name":"Eve"}');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select set_config('t.p1', create_project('Tower A')::text, true);
select tests.auth_as('55555555-5555-5555-5555-555555555555');
select set_config('t.p2', create_project('Elsewhere')::text, true);
reset role;
insert into project_members (project_id, user_id, role) values
  (tests.v('p1'), '22222222-2222-2222-2222-222222222222', 'member'),
  (tests.v('p1'), '33333333-3333-3333-3333-333333333333', 'guest');
select tests.auth_as('11111111-1111-1111-1111-111111111111');
select set_member_contract_profile(tests.v('p1'), '11111111-1111-1111-1111-111111111111', 'qs', 'contractor');
select set_contract_field(tests.v('p1'), 'completion_date', '"2027-06-30"');

-- ---------------------------------------------------------------------
-- Bucket and upload policies
-- ---------------------------------------------------------------------
reset role;
select is((select public from storage.buckets where id = 'contract-documents'), false, 'the bucket is private');
select is((select file_size_limit from storage.buckets where id = 'contract-documents'), 52428800::bigint, '50 MB per file');

select set_config('t.path1', tests.v('p1') || '/aaaaaaaa-0000-4000-8000-000000000001.pdf', true);
select set_config('t.path2', tests.v('p1') || '/aaaaaaaa-0000-4000-8000-000000000002.pdf', true);

select tests.auth_as('22222222-2222-2222-2222-222222222222');
select lives_ok($$ insert into storage.objects (bucket_id, name, owner_id, metadata)
  values ('contract-documents', current_setting('t.path1'), '22222222-2222-2222-2222-222222222222', '{"size": 120000}') $$,
  'a member uploads to the project folder');
select tests.auth_as('33333333-3333-3333-3333-333333333333');
select throws_ok($$ insert into storage.objects (bucket_id, name, owner_id)
  values ('contract-documents', tests.v('p1') || '/aaaaaaaa-0000-4000-8000-00000000000c.pdf', '33333333-3333-3333-3333-333333333333') $$,
  '42501', null, 'a guest cannot upload contract documents');
select tests.auth_as('55555555-5555-5555-5555-555555555555');
select throws_ok($$ insert into storage.objects (bucket_id, name, owner_id)
  values ('contract-documents', tests.v('p1') || '/aaaaaaaa-0000-4000-8000-00000000000e.pdf', '55555555-5555-5555-5555-555555555555') $$,
  '42501', null, 'a non-member cannot upload');
select is((select count(*)::int from storage.objects where bucket_id = 'contract-documents'), 0, 'a non-member cannot see uploads');

-- alice's upload, for "not your upload" checks.
reset role;
insert into storage.objects (bucket_id, name, owner_id, metadata)
values ('contract-documents', current_setting('t.path2'), '11111111-1111-1111-1111-111111111111', '{"size": 5000}');

-- ---------------------------------------------------------------------
-- register_contract_document
-- ---------------------------------------------------------------------
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select throws_ok($$ select register_contract_document(tests.v('p1'), current_setting('t.path2'), 'b.pdf', 'application/pdf') $$,
  'P0002', null, 'only your own upload can be registered');
select throws_ok($$ select register_contract_document(tests.v('p2'), current_setting('t.path1'), 'b.pdf', 'application/pdf') $$,
  '42501', null, 'not in another project');
select lives_ok($$ select set_config('t.d1', register_contract_document(tests.v('p1'), current_setting('t.path1'), ' Contract.pdf ', 'application/pdf')::text, true) $$,
  'a member registers their upload');
select is((tests.doc('d1')).extraction_status, 'queued', 'the document is queued');
select is((tests.doc('d1')).size_bytes, 120000::bigint, 'size comes from the stored object');
select is((tests.doc('d1')).filename, 'Contract.pdf', 'file name trimmed');
select throws_ok($$ select count(*) from extraction_jobs $$, '42501', null, 'members cannot read pipeline jobs');
select throws_ok($$ select register_contract_document(tests.v('p1'), current_setting('t.path1'), 'again.pdf', 'application/pdf') $$,
  '23505', null, 'a file is registered once');

select tests.auth_as('33333333-3333-3333-3333-333333333333');
select is((select count(*)::int from contract_documents), 0, 'guests see no contract documents');
select throws_ok($$ select register_contract_document(tests.v('p1'), current_setting('t.path1'), 'x.pdf', 'application/pdf') $$,
  '42501', null, 'guests cannot register documents');
select tests.auth_as('55555555-5555-5555-5555-555555555555');
select is((select count(*)::int from contract_documents), 0, 'non-members see nothing');

select tests.auth_as('22222222-2222-2222-2222-222222222222');
select throws_ok($$ insert into extracted_fields (project_id, document_id, field_key, not_found_reason)
  values (tests.v('p1'), tests.v('d1'), 'gst_treatment', 'not_found') $$,
  '42501', null, 'clients cannot write proposals directly');
select throws_ok($$ select claim_extraction_job() $$, '42501', null, 'clients cannot claim pipeline jobs');

-- ---------------------------------------------------------------------
-- Pipeline RPCs (service role)
-- ---------------------------------------------------------------------
select tests.as_service();
select is((select count(*)::int from claim_extraction_job(tests.v('d1'))), 1, 'the pipeline claims the job');
select is((tests.doc('d1')).extraction_status, 'processing', 'claiming marks the document processing');
select is((select count(*)::int from claim_extraction_job(tests.v('d1'))), 0, 'a leased job cannot be claimed twice');
update extraction_jobs set locked_until = now() - interval '1 second' where document_id = tests.v('d1');
select is((select count(*)::int from claim_extraction_job()), 1, 'an expired lease is reclaimed');

select is(reserve_ocr_pages('paddleocr_api', '2026-11-20', 3, 5), 3, 'OCR quota: 3 of 5 granted');
select is(reserve_ocr_pages('paddleocr_api', '2026-11-20', 3, 5), 2, 'then only what is left');
select is(reserve_ocr_pages('paddleocr_api', '2026-11-20', 1, 5), 0, 'then nothing');
select is(reserve_ocr_pages('paddleocr_api', '2026-11-21', 1, 5), 1, 'a new day has a new quota');

insert into deadline_rules (project_id, rule_key, group_key, obligation, reminder_label, responsible_role, recipient_role,
  trigger_event_type, period, unit, is_time_bar, origin, status)
values (tests.v('p1'), 'sia2016_ls.payment_response', 'payment_response', 'Respond to the payment claim', 'payment response',
  'contract_admin', 'contractor', 'payment_claim_served', null, 'calendar_days', false, 'standard_form_default', 'draft');

select lives_ok($$ select write_extraction_results(tests.v('d1'),
  '[{"field_key":"liquidated_damages_rate","value":{"amount":5000,"currency":"SGD","per":"day"},"page_no":2,"source_excerpt":"LD: S$5,000 per day","confidence":0.97,"not_found_reason":null,"provider":"p","model":"m"},
    {"field_key":"date_of_commencement","value":"2026-01-05","page_no":2,"source_excerpt":"Commencement: 5 January 2026","confidence":0.6,"not_found_reason":null,"provider":"p","model":"m"},
    {"field_key":"completion_date","value":"2027-06-30","page_no":2,"source_excerpt":"Completion: 30 June 2027","confidence":0.95,"not_found_reason":null,"provider":"p","model":"m"},
    {"field_key":"gst_treatment","value":null,"page_no":null,"source_excerpt":null,"confidence":0,"not_found_reason":"not_found","provider":"p","model":"m"},
    {"field_key":"defects_liability_period","value":{"value":12,"unit":"months"},"page_no":2,"source_excerpt":"DLP: 12 months","confidence":0.92,"not_found_reason":null,"provider":"p","model":"m"}]',
  '[{"rule_key":"amended.payment_response_aaaaaaaa","group_key":"payment_response","obligation":"Respond to the payment claim","reminder_label":"payment response",
     "responsible_role":"contract_admin","recipient_role":"contractor","trigger_event_type":"payment_claim_served","period":14,"unit":"calendar_days",
     "is_time_bar":false,"origin":"amended","source_clause":"31.2","source_page":5,"confidence":0.9,"todo_verify":[]}]',
  '[{"kind":"procedure","summary":"Site meetings every two weeks","page_no":6,"source_excerpt":"Site meetings are held every two weeks.","confidence":0.8},
    {"kind":"suspected_invention","summary":"Retention: dropped","page_no":2,"detail":{"field_key":"retention_percent"}}]') $$,
  'the pipeline writes its results in one call');

select is((tests.doc('d1')).extraction_status, 'needs_review', 'the document needs review');
select is((tests.ef('d1', 'liquidated_damages_rate')).status, 'proposed', 'a new value is proposed');
select is((tests.ef('d1', 'completion_date')).status, 'no_change', 'a value equal to the confirmed one is no_change');
select is((tests.ef('d1', 'gst_treatment')).not_found_reason, 'not_found', 'not found is stored for unconfirmed fields');
select is((select status from deadline_rules where rule_key = 'amended.payment_response_aaaaaaaa'), 'draft', 'amendments become draft rules');
select is((select source_document_id from deadline_rules where rule_key = 'amended.payment_response_aaaaaaaa'), tests.v('d1'), 'with their source document');

-- ---------------------------------------------------------------------
-- Review
-- ---------------------------------------------------------------------
select tests.auth_as('22222222-2222-2222-2222-222222222222');
select is((select count(*)::int from extracted_fields where document_id = tests.v('d1')), 5, 'members see the proposals');
select is((select count(*)::int from extraction_calls), 0, 'members without a contract role do not see call logs');
select throws_ok($$ select confirm_extracted_field((tests.ef('d1', 'liquidated_damages_rate')).id) $$,
  '42501', null, 'only contract roles confirm');

select tests.auth_as('11111111-1111-1111-1111-111111111111');
select lives_ok($$ select confirm_extracted_field((tests.ef('d1', 'liquidated_damages_rate')).id) $$, 'a QS confirms an extracted value');
select is((select origin from project_contract_fields where project_id = tests.v('p1') and field_key = 'liquidated_damages_rate'),
  'extracted', 'stored as extracted');
select is((select source_page from project_contract_fields where project_id = tests.v('p1') and field_key = 'liquidated_damages_rate'),
  2, 'with its source page');
select is((select source_document_id from project_contract_field_history where project_id = tests.v('p1') and field_key = 'liquidated_damages_rate'),
  tests.v('d1'), 'the history records the document');
select throws_ok($$ select confirm_extracted_field((tests.ef('d1', 'liquidated_damages_rate')).id) $$,
  '22023', null, 'a proposal is reviewed once');

select lives_ok($$ select confirm_extracted_field((tests.ef('d1', 'date_of_commencement')).id, '"2026-01-12"') $$, 'confirm with an edit');
select is((select value #>> '{}' from project_contract_fields where project_id = tests.v('p1') and field_key = 'date_of_commencement'),
  '2026-01-12', 'the edited value is stored');
select is((select origin from project_contract_fields where project_id = tests.v('p1') and field_key = 'date_of_commencement'),
  'user_entered', 'an edited value counts as user entered');

select throws_ok($$ select confirm_extracted_field((tests.ef('d1', 'gst_treatment')).id) $$,
  '22023', null, 'a not-found value needs a value or "not stated"');
select lives_ok($$ select confirm_extracted_field((tests.ef('d1', 'gst_treatment')).id, null, true) $$, 'confirm as not stated');
select is((select not_stated from project_contract_fields where project_id = tests.v('p1') and field_key = 'gst_treatment'), true, 'stored as not stated');

select lives_ok($$ select reject_extracted_field((tests.ef('d1', 'defects_liability_period')).id) $$, 'reject a proposal');
select is((tests.doc('d1')).extraction_status, 'needs_review', 'still needs review: a finding and a draft rule are open');
select lives_ok($$ select dismiss_extraction_finding((select id from extraction_findings where kind = 'procedure')) $$, 'dismiss a finding');
select lives_ok($$ select reject_deadline_rule((select id from deadline_rules where rule_key = 'amended.payment_response_aaaaaaaa')) $$,
  'review the draft rule');
select is((tests.doc('d1')).extraction_status, 'complete', 'everything reviewed: complete');

select is((select count(*)::int from extraction_calls), 0, 'contract roles can read call logs (none yet)');
select throws_ok($$ select retry_contract_document(tests.v('d1')) $$, '22023', null, 'only failed documents can be retried');

select * from finish();
rollback;
