-- The uploader says which standard form a contract document uses before uploading it.
--
--   * contract_documents.declared_form: the uploader's choice (NULL = "not sure": the pipeline
--     identifies the form from the document, as before).
--   * extracted_fields.origin gains 'declared' (the contract form the uploader chose, proposed
--     when the document doesn't name one). 'standard_form_default' proposals (a period the
--     standard form sets, proposed when the document doesn't state it) are now written: they
--     cite the form's clause in default_source instead of a page of the document.
--   * register_contract_document takes the declared form.
--   * write_extraction_results stores origin / default_source; a default never challenges a
--     value that is already confirmed.
--   * confirm_extracted_field records a confirmed default as 'standard_form_default' and a
--     confirmed declared form as 'user_entered'.

alter table contract_documents
  add column declared_form text check (declared_form in (
    'SIA_2016_LUMP_SUM','SIA_2016_DB','PSSCOC_CW_2020','PSSCOC_DB_2020',
    'PSSCOC_LITE_CW_2025','PSSCOC_LITE_DB_2025','REDAS','BESPOKE'));

alter table extracted_fields drop constraint extracted_fields_origin_check;
alter table extracted_fields add constraint extracted_fields_origin_check
  check (origin in ('extracted','standard_form_default','declared'));
alter table extracted_fields
  add column default_source text check (default_source is null or char_length(default_source) <= 200);
alter table extracted_fields drop constraint extracted_cites_source;
alter table extracted_fields add constraint extracted_cites_source check (
  value is null
  or (origin = 'extracted' and page_no is not null and source_excerpt is not null)
  or (origin = 'standard_form_default' and default_source is not null)
  or (origin = 'declared' and field_key = 'contract_form'));

-- The pipeline reads the library for the form's default periods.
grant select on rule_library to service_role;


-- ---------------------------------------------------------------------- register

drop function register_contract_document(uuid, text, text, text);

create function register_contract_document(pid uuid, path text, fname text, file_mime text, form text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  obj_size bigint;
  did uuid;
begin
  if not private.has_project_role(pid, array['owner','member']) then
    raise exception 'Only project owners and members can upload contract documents' using errcode = '42501';
  end if;
  if form is not null and form not in ('SIA_2016_LUMP_SUM','SIA_2016_DB','PSSCOC_CW_2020','PSSCOC_DB_2020',
      'PSSCOC_LITE_CW_2025','PSSCOC_LITE_DB_2025','REDAS','BESPOKE') then
    raise exception 'Unknown contract form' using errcode = '22023';
  end if;
  if private.path_project_id(path) is distinct from pid then
    raise exception 'Upload not found' using errcode = 'P0002';
  end if;
  select (o.metadata->>'size')::bigint into obj_size
  from storage.objects o
  where o.bucket_id = 'contract-documents' and o.name = path and o.owner_id = uid::text;
  if not found then
    raise exception 'Upload not found' using errcode = 'P0002';
  end if;
  if (select count(*) from public.contract_documents
      where uploaded_by = uid and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Upload limit reached: 30 documents per hour' using errcode = '54000';
  end if;

  insert into public.contract_documents
    (project_id, storage_path, filename, mime, size_bytes, uploaded_by, declared_form)
  values (pid, path, btrim(fname), file_mime, coalesce(obj_size, 1), uid, form)
  returning id into did;
  insert into public.extraction_jobs (document_id, project_id) values (did, pid);
  perform private.kick_extraction(did);
  return did;
exception when unique_violation then
  raise exception 'This file is already registered' using errcode = '23505';
end $$;

revoke execute on function register_contract_document(uuid, text, text, text, text) from public, anon;
grant execute on function register_contract_document(uuid, text, text, text, text) to authenticated;


-- ---------------------------------------------------------------------- write results

create or replace function write_extraction_results(did uuid, fields jsonb, rules jsonb, findings jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  d public.contract_documents;
  f jsonb;
  r jsonb;
  x jsonb;
  cur public.project_contract_fields;
  f_origin text;
begin
  select * into d from public.contract_documents where id = did for update;
  if d.id is null then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;

  for f in select * from jsonb_array_elements(coalesce(fields, '[]'::jsonb)) loop
    f_origin := coalesce(f->>'origin', 'extracted');
    select * into cur from public.project_contract_fields
    where project_id = d.project_id and field_key = f->>'field_key';
    if f->'value' is null or f->'value' = 'null'::jsonb then
      continue when cur.field_key is not null;
    end if;
    -- A form default is only a fallback: it never reopens a confirmed field.
    continue when f_origin = 'standard_form_default' and cur.field_key is not null;
    update public.extracted_fields
    set status = 'superseded'
    where project_id = d.project_id and field_key = f->>'field_key' and status = 'proposed';
    insert into public.extracted_fields (
      project_id, document_id, field_key, value, page_no, source_excerpt, confidence, not_found_reason,
      origin, default_source, status, provider, model)
    values (
      d.project_id, d.id, f->>'field_key', nullif(f->'value', 'null'::jsonb), (f->>'page_no')::integer,
      f->>'source_excerpt', round(coalesce((f->>'confidence')::numeric, 0), 2), f->>'not_found_reason',
      f_origin, left(f->>'default_source', 200),
      case when cur.field_key is not null and not cur.not_stated and cur.value = f->'value'
           then 'no_change' else 'proposed' end,
      f->>'provider', f->>'model');
  end loop;

  for r in select * from jsonb_array_elements(coalesce(rules, '[]'::jsonb)) loop
    insert into public.deadline_rules (
      project_id, rule_key, group_key, kind, obligation, reminder_label, responsible_role, recipient_role,
      trigger_event_type, period, unit, period_field, default_period, includes_public_holidays, cap_days, cap_label,
      is_time_bar, consequence, origin, source_document_id, source_clause, source_page, confidence, todo_verify,
      closed_by_event_types, chains_to, status)
    values (
      d.project_id, r->>'rule_key', r->>'group_key', coalesce(r->>'kind', 'action'), r->>'obligation',
      r->>'reminder_label', r->>'responsible_role', r->>'recipient_role', r->>'trigger_event_type',
      (r->>'period')::integer, r->>'unit', r->>'period_field', (r->>'default_period')::integer,
      (r->>'includes_public_holidays')::boolean, (r->>'cap_days')::integer, r->>'cap_label',
      (r->>'is_time_bar')::boolean, r->>'consequence', r->>'origin', d.id, r->>'source_clause',
      (r->>'source_page')::integer, round((r->>'confidence')::numeric, 2),
      coalesce(array(select jsonb_array_elements_text(r->'todo_verify')), '{}'),
      coalesce(array(select jsonb_array_elements_text(r->'closed_by_event_types')), '{}'),
      coalesce(array(select jsonb_array_elements_text(r->'chains_to')), '{}'),
      'draft')
    on conflict (project_id, rule_key) do nothing;
  end loop;

  for x in select * from jsonb_array_elements(coalesce(findings, '[]'::jsonb)) loop
    insert into public.extraction_findings
      (project_id, document_id, kind, summary, clause, page_no, source_excerpt, confidence, detail)
    values (d.project_id, d.id, x->>'kind', left(x->>'summary', 600), left(x->>'clause', 60),
            (x->>'page_no')::integer, left(x->>'source_excerpt', 400),
            round((x->>'confidence')::numeric, 2), x->'detail');
  end loop;

  update public.contract_documents
  set extraction_status = 'needs_review', extraction_step = null, error = null
  where id = did;
  perform private.refresh_document_status(did);
end $$;


-- ---------------------------------------------------------------------- confirm

-- As in 0024, except the confirmed origin: a form default stays 'standard_form_default', the
-- uploader's declared form is 'user_entered'.
create or replace function confirm_extracted_field(fid uuid, edited jsonb default null, not_stated boolean default false)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  f public.extracted_fields;
  v jsonb;
begin
  select * into f from public.extracted_fields where id = fid for update;
  if f.id is null or not private.can_confirm_contract(f.project_id) then
    raise exception 'Only project QS, PM or contract administrators can confirm contract values'
      using errcode = '42501';
  end if;
  if f.status <> 'proposed' then
    raise exception 'This value has already been reviewed' using errcode = '22023';
  end if;
  if edited = 'null'::jsonb then
    edited := null;
  end if;
  v := case when not_stated then null else coalesce(edited, f.value) end;
  if not not_stated and v is null then
    raise exception 'Enter a value, or mark it as not stated in the contract' using errcode = '22023';
  end if;
  if f.field_key = 'contract_form' and (v is null or jsonb_typeof(v) <> 'string') then
    raise exception 'contract_form must be a form code' using errcode = '22023';
  end if;
  if v is not null and octet_length(v::text) > 20000 then
    raise exception 'Value too large' using errcode = '22023';
  end if;

  insert into public.project_contract_fields
    (project_id, field_key, value, not_stated, origin, source_document_id, source_page, source_excerpt,
     confirmed_by, confirmed_at)
  values (f.project_id, f.field_key, v, not_stated,
          case when edited is not null or not_stated or f.origin = 'declared' then 'user_entered'
               when f.origin = 'standard_form_default' then 'standard_form_default'
               else 'extracted' end,
          f.document_id, f.page_no, f.source_excerpt, (select auth.uid()), now())
  on conflict (project_id, field_key) do update
    set value = excluded.value, not_stated = excluded.not_stated, origin = excluded.origin,
        source_document_id = excluded.source_document_id, source_page = excluded.source_page,
        source_excerpt = excluded.source_excerpt, confirmed_by = excluded.confirmed_by,
        confirmed_at = excluded.confirmed_at;

  update public.extracted_fields
  set status = 'confirmed', edited_value = case when not_stated then null else edited end,
      decided_by = (select auth.uid()), decided_at = now()
  where id = fid;
  -- Older open proposals for the same field are answered by this decision.
  update public.extracted_fields
  set status = 'superseded'
  where project_id = f.project_id and field_key = f.field_key and status = 'proposed' and id <> fid;

  if f.field_key = 'contract_form' then
    perform private.initialise_project_rules(f.project_id);
  end if;
  perform private.enqueue_recalculation(f.project_id);
  perform private.refresh_document_status(d.id)
  from public.contract_documents d
  where d.project_id = f.project_id
    and d.id in (select document_id from public.extracted_fields where project_id = f.project_id and field_key = f.field_key);
end $$;
