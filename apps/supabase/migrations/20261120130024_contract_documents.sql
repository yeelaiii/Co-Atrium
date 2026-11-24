-- =====================================================================
-- Migration 0024: contract documents, extraction pipeline and field review
-- Requires: 0001, 0004, 0019, 0020, 0021, 0022
-- =====================================================================
--
-- Upload -> extract-contract Edge Function -> proposals -> a person confirms each one.
--
--   contract_documents     one row per uploaded file (private bucket 'contract-documents',
--                          path <project_id>/<uuid>.<ext>); extraction_status is shown live
--   extraction_jobs        resumable pipeline state per document (step + cursor + lease)
--   document_pages         text per page, where it came from, and its section
--   ocr_usage_daily        OCR pages used per provider per day (SGT), for the daily quota
--   extraction_calls       every LLM call: provider, model, prompt version, tokens, cost
--   extracted_fields       one row per proposed value per field; confirming copies it into
--                          project_contract_fields (0020). Never applied without a person.
--   extraction_findings    changes the pipeline found but could not turn into a value or a
--                          draft rule (e.g. an amendment matching no rule), for the reviewer
--   view llm_usage_summary usage and estimated cost per day, provider, task, model
--
-- Amendments and procedures that map onto a rule become draft deadline_rules (origin
-- 'amended' / 'project_procedure', status 'draft'): reviewed and verified on the existing
-- Rules screen, so nothing becomes live without verification.
--
-- Who can do what:
--   upload, see documents, pages, proposals, findings:  owner, member
--   confirm / edit / reject proposals:                  private.can_confirm_contract (0019)
--   see extraction_calls:                               private.can_confirm_contract
--   pipeline writes:                                    service role (Edge Function) only


-- =====================================================================
-- 1. STORAGE
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('contract-documents', 'contract-documents', false, 52428800, array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- No UPDATE/DELETE policies: uploads are immutable; names are random UUIDs.
create policy "contract documents: staff upload" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'contract-documents'
    and private.path_project_id(name) in (select private.my_projects(array['owner','member']))
  );

create policy "contract documents: staff read" on storage.objects for select to authenticated
  using (
    bucket_id = 'contract-documents'
    and private.path_project_id(name) in (select private.my_projects(array['owner','member']))
  );


-- =====================================================================
-- 2. TABLES
-- =====================================================================

create table contract_documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  storage_path text not null unique check (private.path_project_id(storage_path) = project_id),
  filename text not null check (char_length(btrim(filename)) between 1 and 200),
  mime text not null check (mime in (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg','image/png')),
  size_bytes bigint not null check (size_bytes between 1 and 52428800),
  page_count integer check (page_count >= 0),
  -- DOCX has no stored pagination: its page numbers are estimates.
  pages_estimated boolean not null default false,
  extraction_status text not null default 'queued'
    check (extraction_status in ('queued','processing','needs_review','complete','failed')),
  -- What the pipeline is doing now, for the status line ('text', 'ocr', 'classify', ...).
  extraction_step text,
  warnings text[] not null default '{}',
  error text check (error is null or char_length(error) <= 500),
  uploaded_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id)
);

create table extraction_jobs (
  document_id uuid primary key references contract_documents on delete cascade,
  project_id uuid not null references projects on delete cascade,
  step text not null default 'text'
    check (step in ('text','ocr','classify','identify','fields','amendments','procedures','write','done')),
  status text not null default 'pending'
    check (status in ('pending','running','waiting_quota','done','failed')),
  cursor jsonb not null default '{}'::jsonb
    check (jsonb_typeof(cursor) = 'object' and octet_length(cursor::text) <= 2000000),
  attempts integer not null default 0,
  run_after timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table document_pages (
  document_id uuid not null references contract_documents on delete cascade,
  project_id uuid not null references projects on delete cascade,
  page_no integer not null check (page_no > 0),
  text text not null default '' check (char_length(text) <= 200000),
  text_source text not null check (text_source in ('pdf_text_layer','ocr','docx','none')),
  -- No usable text layer: waiting for (or skipped by) OCR.
  needs_ocr boolean not null default false,
  ocr_provider text,
  ocr_confidence numeric(4,3) check (ocr_confidence between 0 and 1),
  section text check (section in ('articles','general_conditions','appendix','particular_conditions',
    'preliminaries','specifications','drawings_list','bq','supplementary_agreement','other')),
  section_source text check (section_source in ('rule','llm','user')),
  primary key (document_id, page_no)
);

create table ocr_usage_daily (
  provider text not null,
  day date not null,
  pages_used integer not null default 0 check (pages_used >= 0),
  primary key (provider, day)
);

create table extraction_calls (
  id bigint generated always as identity primary key,
  document_id uuid references contract_documents on delete set null,
  project_id uuid references projects on delete cascade,
  task text not null,
  provider text not null,
  model text not null,
  prompt_version text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  estimated_cost_usd numeric(12,6),
  latency_ms integer not null default 0,
  outcome text not null check (outcome in ('ok','fallback','escalated','validation_failed','error')),
  error text check (error is null or char_length(error) <= 500),
  created_at timestamptz not null default now()
);

create table extracted_fields (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  document_id uuid not null,
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  -- NULL = not found in the document (see not_found_reason).
  value jsonb check (value is null or octet_length(value::text) <= 20000),
  page_no integer check (page_no > 0),
  source_excerpt text check (source_excerpt is null or char_length(source_excerpt) <= 400),
  confidence numeric(3,2) not null default 0 check (confidence between 0 and 1),
  not_found_reason text check (not_found_reason in ('not_found','excerpt_not_in_source','invalid_value','extraction_failed')),
  origin text not null default 'extracted' check (origin in ('extracted','standard_form_default')),
  -- no_change: the document states the value already confirmed (shown collapsed, needs no action).
  status text not null default 'proposed' check (status in ('proposed','confirmed','rejected','superseded','no_change')),
  -- The value the reviewer confirmed when they edited it (value stays what was extracted).
  edited_value jsonb check (edited_value is null or octet_length(edited_value::text) <= 20000),
  provider text,
  model text,
  decided_by uuid references profiles(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (document_id, project_id) references contract_documents (id, project_id) on delete cascade,
  constraint extracted_value_or_reason check ((value is null) = (not_found_reason is not null)),
  constraint extracted_cites_source check (value is null or (page_no is not null and source_excerpt is not null)),
  constraint extracted_decided_stamp check ((status in ('confirmed','rejected')) = (decided_at is not null))
);

create table extraction_findings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects on delete cascade,
  document_id uuid not null,
  kind text not null check (kind in ('amendment','procedure','suspected_invention')),
  summary text not null check (char_length(summary) between 1 and 600),
  clause text check (clause is null or char_length(clause) <= 60),
  page_no integer check (page_no > 0),
  source_excerpt text check (source_excerpt is null or char_length(source_excerpt) <= 400),
  confidence numeric(3,2) check (confidence between 0 and 1),
  detail jsonb,
  status text not null default 'open' check (status in ('open','dismissed')),
  dismissed_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (document_id, project_id) references contract_documents (id, project_id) on delete cascade
);

-- The phase 1 tables referenced documents before they existed.
alter table project_contract_fields
  add constraint project_contract_fields_source_document_fk
  foreign key (source_document_id) references contract_documents(id) on delete set null;
alter table deadline_rules
  add constraint deadline_rules_source_document_fk
  foreign key (source_document_id) references contract_documents(id) on delete set null;

create index on contract_documents (project_id, created_at desc);
create index on contract_documents (uploaded_by);
create index on extraction_jobs (run_after) where status in ('pending','waiting_quota','running');
create index on extraction_jobs (project_id);
create index on document_pages (project_id);
create index on extraction_calls (document_id);
create index on extraction_calls (project_id, created_at desc);
create index on extraction_calls (created_at);
create index on extracted_fields (project_id, field_key, status);
create index on extracted_fields (document_id, project_id);
create index on extracted_fields (decided_by);
create index on extraction_findings (document_id, project_id);
create index on extraction_findings (project_id) where status = 'open';
create index on extraction_findings (dismissed_by);

create trigger contract_documents_set_updated_at before update on contract_documents
  for each row execute function set_updated_at();
create trigger extraction_jobs_set_updated_at before update on extraction_jobs
  for each row execute function set_updated_at();

create view llm_usage_summary with (security_invoker = true) as
  select (created_at at time zone 'Asia/Singapore')::date as day_sgt,
         provider, task, model,
         count(*) as calls,
         count(*) filter (where outcome in ('ok','fallback','escalated')) as succeeded,
         count(*) filter (where outcome = 'validation_failed') as validation_failures,
         count(*) filter (where outcome = 'error') as errors,
         sum(input_tokens) as input_tokens,
         sum(output_tokens) as output_tokens,
         sum(estimated_cost_usd) as estimated_cost_usd,
         round(avg(latency_ms)) as avg_latency_ms
  from public.extraction_calls
  group by 1, 2, 3, 4;


-- =====================================================================
-- 3. RLS AND GRANTS
-- =====================================================================

alter table contract_documents enable row level security;
alter table extraction_jobs enable row level security;
alter table document_pages enable row level security;
alter table ocr_usage_daily enable row level security;
alter table extraction_calls enable row level security;
alter table extracted_fields enable row level security;
alter table extraction_findings enable row level security;

revoke all on contract_documents, extraction_jobs, document_pages, ocr_usage_daily, extraction_calls,
  extracted_fields, extraction_findings, llm_usage_summary
from anon, authenticated;

create policy "staff read contract documents" on contract_documents for select to authenticated
  using (project_id in (select private.my_projects(array['owner','member'])));
create policy "staff read document pages" on document_pages for select to authenticated
  using (project_id in (select private.my_projects(array['owner','member'])));
create policy "staff read extracted fields" on extracted_fields for select to authenticated
  using (project_id in (select private.my_projects(array['owner','member'])));
create policy "staff read extraction findings" on extraction_findings for select to authenticated
  using (project_id in (select private.my_projects(array['owner','member'])));
create policy "contract roles read extraction calls" on extraction_calls for select to authenticated
  using (project_id is not null and private.can_confirm_contract(project_id));

grant select on contract_documents, document_pages, extracted_fields, extraction_findings, extraction_calls
to authenticated;

grant select, insert, update on contract_documents, extraction_jobs, document_pages, ocr_usage_daily,
  extraction_calls, extracted_fields, extraction_findings
to service_role;
grant select on llm_usage_summary to service_role;
grant insert on deadline_rules to service_role;
-- contract_documents' path check runs on every pipeline update.
grant execute on function private.path_project_id(text) to service_role;


-- =====================================================================
-- 4. PRIVATE HELPERS
-- =====================================================================

-- needs_review while anything from this document still waits for a person; else complete.
create function private.refresh_document_status(did uuid) returns void
language sql security definer set search_path = '' as $$
  update public.contract_documents d
  set extraction_status = case
        when exists (select 1 from public.extracted_fields f where f.document_id = d.id and f.status = 'proposed')
          or exists (select 1 from public.extraction_findings x
                     where x.document_id = d.id and x.status = 'open' and x.kind <> 'suspected_invention')
          or exists (select 1 from public.deadline_rules r where r.source_document_id = d.id and r.status = 'draft')
        then 'needs_review' else 'complete' end
  where d.id = did and d.extraction_status in ('needs_review','complete')
$$;

-- Starts (or resumes) the pipeline for one document, through pg_net. NULL if Vault isn't set up;
-- the cron job (below) and the app's direct call cover that.
create function private.kick_extraction(did uuid) returns bigint
language sql security definer set search_path = '' as $$
  select private.invoke_edge_function('extract-contract', jsonb_build_object('document_id', did))
$$;

revoke execute on function private.refresh_document_status(uuid), private.kick_extraction(uuid)
from public, anon, authenticated;
grant execute on function private.refresh_document_status(uuid), private.kick_extraction(uuid) to service_role;


-- =====================================================================
-- 5. RPCs FOR THE APP (caller's JWT)
-- =====================================================================

-- Registers an uploaded file and queues extraction. The object must exist in the project's
-- folder of 'contract-documents' and have been uploaded by the caller. Returns the document id.
create function register_contract_document(pid uuid, path text, fname text, file_mime text)
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

  insert into public.contract_documents (project_id, storage_path, filename, mime, size_bytes, uploaded_by)
  values (pid, path, btrim(fname), file_mime, coalesce(obj_size, 1), uid)
  returning id into did;
  insert into public.extraction_jobs (document_id, project_id) values (did, pid);
  perform private.kick_extraction(did);
  return did;
exception when unique_violation then
  raise exception 'This file is already registered' using errcode = '23505';
end $$;

-- Runs a failed document again from the start (its earlier proposals are superseded).
create function retry_contract_document(did uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  pid uuid;
begin
  select project_id into pid from public.contract_documents where id = did;
  if pid is null or not private.has_project_role(pid, array['owner','member']) then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;
  update public.contract_documents
  set extraction_status = 'queued', extraction_step = null, error = null, warnings = '{}'
  where id = did and extraction_status = 'failed';
  if not found then
    raise exception 'Only failed documents can be retried' using errcode = '22023';
  end if;
  update public.extraction_jobs
  set step = 'text', status = 'pending', cursor = '{}'::jsonb, attempts = 0, run_after = now(),
      locked_until = null, last_error = null
  where document_id = did;
  perform private.kick_extraction(did);
end $$;

-- Confirms one proposal into project_contract_fields.
--   edited:      the reviewer's corrected value (validated by the app against contractFieldSchema)
--   not_stated:  confirm that the contract doesn't state this field
create function confirm_extracted_field(fid uuid, edited jsonb default null, not_stated boolean default false)
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
          case when edited is null and not not_stated then 'extracted' else 'user_entered' end,
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

-- Confirms several proposals as extracted (no edits), e.g. "Accept all high-confidence".
-- Found values only; returns how many were confirmed.
create function confirm_extracted_fields(fids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  fid uuid;
  n integer := 0;
begin
  if cardinality(fids) > 200 then
    raise exception 'At most 200 at a time' using errcode = '22023';
  end if;
  foreach fid in array fids loop
    if exists (select 1 from public.extracted_fields
               where id = fid and status = 'proposed' and value is not null) then
      perform public.confirm_extracted_field(fid);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create function reject_extracted_field(fid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  f public.extracted_fields;
begin
  select * into f from public.extracted_fields where id = fid;
  if f.id is null or not private.can_confirm_contract(f.project_id) then
    raise exception 'Only project QS, PM or contract administrators can review contract values'
      using errcode = '42501';
  end if;
  update public.extracted_fields
  set status = 'rejected', decided_by = (select auth.uid()), decided_at = now()
  where id = fid and status = 'proposed';
  if not found then
    raise exception 'This value has already been reviewed' using errcode = '22023';
  end if;
  perform private.refresh_document_status(f.document_id);
end $$;

create function dismiss_extraction_finding(xid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  x public.extraction_findings;
begin
  select * into x from public.extraction_findings where id = xid;
  if x.id is null or not private.can_confirm_contract(x.project_id) then
    raise exception 'Finding not found or not allowed' using errcode = '42501';
  end if;
  update public.extraction_findings set status = 'dismissed', dismissed_by = (select auth.uid())
  where id = xid and status = 'open';
  perform private.refresh_document_status(x.document_id);
end $$;

-- Reviewing a document's draft rules (verify / reject on the Rules screen) can finish it.
create function deadline_rule_document_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.source_document_id is not null and new.status is distinct from old.status then
    perform private.refresh_document_status(new.source_document_id);
  end if;
  return new;
end $$;
create trigger deadline_rules_document_status after update on deadline_rules
for each row execute function deadline_rule_document_status();

grant execute on function
  register_contract_document(uuid, text, text, text),
  retry_contract_document(uuid),
  confirm_extracted_field(uuid, jsonb, boolean),
  confirm_extracted_fields(uuid[]),
  reject_extracted_field(uuid),
  dismiss_extraction_finding(uuid)
to authenticated;
revoke execute on function
  register_contract_document(uuid, text, text, text),
  retry_contract_document(uuid),
  confirm_extracted_field(uuid, jsonb, boolean),
  confirm_extracted_fields(uuid[]),
  reject_extracted_field(uuid),
  dismiss_extraction_finding(uuid)
from public, anon;
revoke execute on function public.deadline_rule_document_status() from public, anon, authenticated;


-- =====================================================================
-- 6. RPCs FOR THE PIPELINE (service role only)
-- =====================================================================

-- Claims one runnable job (a specific document, or the oldest due) with a lease, so two
-- invocations never work on the same document. Expired leases (crashed runs) are reclaimed.
create function claim_extraction_job(did uuid default null, lease_seconds integer default 170)
returns setof extraction_jobs
language plpgsql security definer set search_path = '' as $$
declare
  j public.extraction_jobs;
begin
  select * into j from public.extraction_jobs
  where (did is null or document_id = did)
    and ((status in ('pending','waiting_quota') and run_after <= now())
         or (status = 'running' and locked_until < now()))
  order by run_after
  limit 1
  for update skip locked;
  if j.document_id is null then
    return;
  end if;
  update public.extraction_jobs
  set status = 'running', locked_until = now() + make_interval(secs => lease_seconds)
  where document_id = j.document_id
  returning * into j;
  update public.contract_documents
  set extraction_status = 'processing', extraction_step = j.step
  where id = j.document_id and extraction_status in ('queued','processing');
  return next j;
end $$;

-- Atomically takes up to `wanted` OCR pages from today's quota; returns how many were granted.
create function reserve_ocr_pages(p_provider text, p_day date, wanted integer, quota integer)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  used integer;
  granted integer;
begin
  insert into public.ocr_usage_daily (provider, day, pages_used) values (p_provider, p_day, 0)
  on conflict (provider, day) do nothing;
  select pages_used into used from public.ocr_usage_daily
  where provider = p_provider and day = p_day for update;
  granted := greatest(0, least(wanted, quota - used));
  update public.ocr_usage_daily set pages_used = pages_used + granted
  where provider = p_provider and day = p_day;
  return granted;
end $$;

-- Writes a finished run in one transaction:
--   fields:   [{ field_key, value, page_no, source_excerpt, confidence, not_found_reason, provider, model }]
--   rules:    [{ deadline_rules columns ... }]  (drafts; an existing rule_key is left alone)
--   findings: [{ kind, summary, clause, page_no, source_excerpt, confidence, detail }]
-- A found value equal to the confirmed one is stored as no_change. A not-found proposal is
-- only stored when the field has no confirmed value (a supplement not restating it is no news).
-- Earlier open proposals for the same fields are superseded.
create function write_extraction_results(did uuid, fields jsonb, rules jsonb, findings jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  d public.contract_documents;
  f jsonb;
  r jsonb;
  x jsonb;
  cur public.project_contract_fields;
begin
  select * into d from public.contract_documents where id = did for update;
  if d.id is null then
    raise exception 'Document not found' using errcode = 'P0002';
  end if;

  for f in select * from jsonb_array_elements(coalesce(fields, '[]'::jsonb)) loop
    select * into cur from public.project_contract_fields
    where project_id = d.project_id and field_key = f->>'field_key';
    if f->'value' is null or f->'value' = 'null'::jsonb then
      continue when cur.field_key is not null;
    end if;
    update public.extracted_fields
    set status = 'superseded'
    where project_id = d.project_id and field_key = f->>'field_key' and status = 'proposed';
    insert into public.extracted_fields (
      project_id, document_id, field_key, value, page_no, source_excerpt, confidence, not_found_reason,
      status, provider, model)
    values (
      d.project_id, d.id, f->>'field_key', nullif(f->'value', 'null'::jsonb), (f->>'page_no')::integer,
      f->>'source_excerpt', round(coalesce((f->>'confidence')::numeric, 0), 2), f->>'not_found_reason',
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

revoke execute on function
  claim_extraction_job(uuid, integer),
  reserve_ocr_pages(text, date, integer, integer),
  write_extraction_results(uuid, jsonb, jsonb, jsonb)
from public, anon, authenticated;
grant execute on function
  claim_extraction_job(uuid, integer),
  reserve_ocr_pages(text, date, integer, integer),
  write_extraction_results(uuid, jsonb, jsonb, jsonb)
to service_role;


-- =====================================================================
-- 7. REALTIME AND CRON
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'contract_documents') then
    alter publication supabase_realtime add table public.contract_documents;
  end if;
end $$;

-- Safety net: every minute, resume jobs that are due (lost pg_net calls, OCR polling, a new
-- SGT day for jobs waiting on the OCR quota, crashed runs whose lease expired).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'extract-contract') then
      perform cron.unschedule('extract-contract');
    end if;
    perform cron.schedule('extract-contract', '* * * * *', $job$
      select private.invoke_edge_function('extract-contract')
      where exists (select 1 from public.extraction_jobs
                    where (status in ('pending','waiting_quota') and run_after <= now())
                       or (status = 'running' and locked_until < now()))
    $job$);
  end if;
end $$;
