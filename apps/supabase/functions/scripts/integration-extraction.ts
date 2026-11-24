// Integration run of upload -> extraction -> review against a LOCAL Supabase stack
// (`supabase start`), with the real database, storage and RPCs and a scripted model (no LLM
// keys, no network calls to providers). Refuses to run against anything but localhost.
//
//   cd apps/supabase/functions
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SECRET_KEY=<from supabase status> \
//   SUPABASE_PUBLISHABLE_KEY=<from supabase status> \
//   deno run --allow-env --allow-net=127.0.0.1 --allow-read scripts/integration-extraction.ts
//
// Creates two throwaway users and a project, and leaves them in the local database.

import { createClient } from '@supabase/supabase-js';

import { createRouter } from '../_shared/llm/router.ts';
import { aiConfig } from '../_shared/llm/ai-config.ts';
import { runJob, type Job } from '../_shared/server/extraction.ts';
import { supabaseExtractionIO } from '../_shared/server/extraction-io.ts';
import { makePdf, scriptedProvider, type ScriptedCall } from '../tests/helpers/extraction-fakes.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
  console.error('SUPABASE_URL must be a local stack (http://127.0.0.1:54321)');
  Deno.exit(2);
}
const secret = Deno.env.get('SUPABASE_SECRET_KEY')!;
const publishable = Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!;
const admin = createClient(url, secret, { auth: { persistSession: false } });

function ok(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    Deno.exit(1);
  }
  console.log(`ok - ${msg}`);
}
// deno-lint-ignore no-explicit-any
function must<T>(res: { data: T; error: any }, what: string): NonNullable<T> {
  if (res.error) {
    console.error(`FAIL: ${what}:`, res.error);
    Deno.exit(1);
  }
  return res.data as NonNullable<T>;
}

async function user(name: string) {
  const email = `${name}-${crypto.randomUUID().slice(0, 8)}@integration.local`;
  const password = crypto.randomUUID();
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: name } });
  if (created.error || !created.data.user) throw created.error ?? new Error('create user failed');
  const client = createClient(url, publishable, { auth: { persistSession: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw signedIn.error;
  return { id: created.data.user.id, client };
}

const qs = await user('qs');
const member = await user('member');
const pid = must(await qs.client.rpc('create_project', { project_name: `Integration ${new Date().toISOString()}` }), 'create project') as string;
must(await admin.from('project_members').insert({ project_id: pid, user_id: member.id, role: 'member' }), 'add member');
must(await qs.client.rpc('set_member_contract_profile', { pid, uid: qs.id, new_contract_role: 'qs', new_contract_party: 'contractor' }), 'set contract role');

// 1. Upload (as the member) and register.
const pdf = await makePdf([
  'ARTICLES OF AGREEMENT\nThis Agreement is made between Harbour Homes Pte Ltd (the Employer)\nand Lim Builders Pte Ltd.',
  'APPENDIX\nDate of Commencement: 5 January 2026\nDate for Completion: 30 June 2027\nLiquidated damages: S$5,000 per day\nDefects Liability Period: 12 months\nPayment response: 21 days',
  'GENERAL CONDITIONS OF CONTRACT\nSECRET-GC-TEXT',
  '',
  'PRELIMINARIES\nThe Architect shall respond to RFIs within 7 working days of receipt.',
]);
const path = `${pid}/${crypto.randomUUID()}.pdf`;
must(await member.client.storage.from('contract-documents').upload(path, pdf, { contentType: 'application/pdf' }), 'upload');
const did = must(await member.client.rpc('register_contract_document', { pid, path, fname: 'Contract.pdf', file_mime: 'application/pdf' }), 'register') as string;
ok(did, 'document registered');

// 2. Run the pipeline with the real Supabase I/O and a scripted model.
const calls: ScriptedCall[] = [];
const truth = {
  contract_form: { value: 'SIA_2016_LUMP_SUM', page: 1, excerpt: 'This Agreement is made between Harbour Homes Pte Ltd' },
  employer_name: { value: 'Harbour Homes Pte Ltd', page: 1, excerpt: 'between Harbour Homes Pte Ltd (the Employer)' },
  date_of_commencement: { value: '2026-01-05', page: 2, excerpt: 'Date of Commencement: 5 January 2026' },
  completion_date: { value: '2027-06-30', page: 2, excerpt: 'Date for Completion: 30 June 2027' },
  liquidated_damages_rate: { value: { amount: 5000, currency: 'SGD', per: 'day' }, page: 2, excerpt: 'Liquidated damages: S$5,000 per day' },
  defects_liability_period: { value: { value: 12, unit: 'months' }, page: 2, excerpt: 'Defects Liability Period: 12 months' },
  payment_response_period: { value: { value: 21, unit: 'calendar_days' }, page: 2, excerpt: 'Payment response: 21 days', confidence: 0.85 },
};
const procedures = [{ kind: 'rfi_response', summary: 'RFI replies in 7 working days', period: 7, unit: 'working_days', page_no: 5, source_excerpt: 'The Architect shall respond to RFIs within 7 working days of receipt.', confidence: 0.9 }];
const config = { ...aiConfig, ocr: { ...aiConfig.ocr, enabled: false } };
const router = createRouter({
  config,
  secret: () => 'unused',
  makeProvider: (id) => scriptedProvider(id, calls, { truth, procedures }),
  log: async (c) => {
    must(await admin.from('extraction_calls').insert({
      document_id: did, project_id: pid, task: c.task, provider: c.provider, model: c.model, prompt_version: c.promptVersion,
      input_tokens: c.inputTokens, output_tokens: c.outputTokens, estimated_cost_usd: c.estimatedCostUsd, latency_ms: c.latencyMs, outcome: c.outcome,
    }), 'log call');
  },
});
const claimed = must(await admin.rpc('claim_extraction_job', { did }), 'claim') as any[];
ok(claimed.length === 1, 'job claimed');
const row = claimed[0];
const job: Job = { document_id: did, project_id: pid, step: row.step, cursor: row.cursor, attempts: row.attempts };
const out = await runJob(job, { io: supabaseExtractionIO(admin), router, config, ocr: null, deadline: Date.now() + 60_000 });
ok(out.state === 'done', 'pipeline finished');
must(await admin.from('extraction_jobs').update({ status: 'done', step: 'done', locked_until: null }).eq('document_id', did), 'finish job');
ok(calls.every((c) => !c.input.includes('SECRET-GC-TEXT')), 'general conditions never sent to the model');

// 3. Review.
const doc = must(await member.client.from('contract_documents').select('*').eq('id', did).single(), 'read doc') as any;
ok(doc.extraction_status === 'needs_review', `document needs review (${doc.extraction_status})`);
ok(doc.page_count === 5, 'page count recorded');
ok(doc.warnings.some((w: string) => w.includes('no text layer')), 'scanned page warned about');
const pages = must(await member.client.from('document_pages').select('page_no, section, needs_ocr').eq('document_id', did).order('page_no'), 'pages') as any[];
ok(pages.map((p) => p.section).join() === 'articles,appendix,general_conditions,other,preliminaries', 'sections stored');

const proposals = must(await member.client.from('extracted_fields').select('id, field_key, value, confidence, status').eq('document_id', did), 'proposals') as any[];
ok(proposals.length > 40, `${proposals.length} proposals stored (one per field)`);
const denied = await member.client.rpc('confirm_extracted_field', { fid: proposals[0].id });
ok(denied.error?.code === '42501', 'a member without a contract role cannot confirm');

const high = proposals.filter((p) => p.value !== null && p.confidence >= 0.9).map((p) => p.id);
const n = must(await qs.client.rpc('confirm_extracted_fields', { fids: high }), 'accept all high-confidence') as number;
ok(n === high.length && n === 6, `accepted ${n} high-confidence values`);
const prp = proposals.find((p) => p.field_key === 'payment_response_period');
must(await qs.client.rpc('confirm_extracted_field', { fid: prp.id }), 'confirm the 0.85 one individually');

const fields = must(await qs.client.from('project_contract_fields').select('field_key, origin, source_document_id').eq('project_id', pid), 'fields') as any[];
ok(fields.length === 7 && fields.every((f) => f.origin === 'extracted' && f.source_document_id === did), 'confirmed values carry their source');
const rules = must(await qs.client.from('deadline_rules').select('rule_key, origin, status').eq('project_id', pid), 'rules') as any[];
ok(rules.some((r) => r.rule_key.startsWith('sia2016_ls.')), 'confirming the contract form loaded the standard-form rules');
ok(rules.some((r) => r.origin === 'project_procedure' && r.status === 'draft'), 'the RFI procedure is a draft rule');
const calls2 = must(await qs.client.from('extraction_calls').select('id').eq('document_id', did), 'calls') as any[];
ok(calls2.length === calls.length, 'every model call is logged and readable by the QS');

console.log('\nIntegration run passed.');
