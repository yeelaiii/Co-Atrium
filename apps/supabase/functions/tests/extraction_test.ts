// Extraction: section rules and the hard filter, the anti-invention guard, and the pipeline
// end to end against in-memory I/O with a scripted model (OCR routing and quota, validation
// retry -> escalation -> failed, escalation of low-confidence fields only, amendments and
// procedures -> draft rules, resumability).

import { assert, assertEquals, assertStringIncludes } from '@std/assert';

import { CONTRACT_FIELDS } from '../_shared/contracts/contractFieldSchema.ts';
import { checkCitation, excerptAppears } from '../_shared/extraction/guards.ts';
import {
  classifyByRules,
  headingSection,
  NEVER_EXTRACTED,
  pagesForTask,
  SECTIONS,
  TASK_SECTIONS,
} from '../_shared/extraction/sections.ts';
import { formDefaults, type LibraryPeriodRow } from '../_shared/extraction/tasks.ts';
import { splitIntoPages } from '../_shared/extraction/text.ts';
import { parseAiConfig } from '../_shared/llm/config-schema.ts';
import { LlmError } from '../_shared/llm/provider.ts';
import { type CallLog, createRouter } from '../_shared/llm/router.ts';
import { type Job, nextSgtDayStart, runJob, sgtDay } from '../_shared/server/extraction.ts';
import {
  FakeOcr,
  makePdf,
  MemoryIO,
  type ScriptedCall,
  scriptedProvider,
  type Truth,
} from './helpers/extraction-fakes.ts';

// ---------------------------------------------------------------------------------------
// pure
// ---------------------------------------------------------------------------------------

Deno.test('section rules: headings, most specific first, carried forward', () => {
  assertEquals(headingSection('PARTICULAR CONDITIONS OF CONTRACT\n1. Amendments'), 'particular_conditions');
  assertEquals(headingSection('Conditions of Contract\nClause 1'), 'general_conditions');
  assertEquals(headingSection('APPENDIX\nItem 1'), 'appendix');
  assertEquals(headingSection('Articles of Agreement'), 'articles');
  assertEquals(headingSection('BILLS OF QUANTITIES\nItem'), 'bq');
  assertEquals(headingSection('Just some text about the appendix later on'), null);
  const c = classifyByRules([
    { page_no: 1, text: 'Cover page' },
    { page_no: 2, text: 'APPENDIX\nCommencement' },
    { page_no: 3, text: 'continued values' },
    { page_no: 4, text: '' },
    { page_no: 5, text: 'Preliminaries\nRFIs' },
  ]);
  assertEquals(c.map((x) => x.section), [null, 'appendix', 'appendix', null, 'preliminaries']);
});

Deno.test('hard filter: general conditions, specifications, BQ and drawings are never sent to any task', () => {
  const pages = SECTIONS.map((s, i) => ({ page_no: i + 1, text: `text of ${s}`, section: s }));
  for (const task of Object.keys(TASK_SECTIONS) as (keyof typeof TASK_SECTIONS)[]) {
    const sent = pagesForTask(task, pages).map((p) => p.section);
    for (const s of NEVER_EXTRACTED) assert(!sent.includes(s), `${task} must not get ${s}`);
  }
  assertEquals(pagesForTask('extract_procedures', pages).map((p) => p.section), ['preliminaries']);
});

Deno.test('excerpt guard: whitespace, case, punctuation and small OCR slips pass; invented text fails', () => {
  const page =
    'Liquidated and Ascertained Damages:  S$5,000.00 per day of delay.\nDefects Liability Period: twelve (12) months';
  assert(excerptAppears('liquidated and ascertained damages: S$5000.00 per day', page));
  assert(excerptAppears('Defects Liability Period twelve (12) months', page));
  assert(excerptAppears('Liquidated and Ascertained Damages S$5,000.00 per dya of delay', page)); // OCR-ish slip
  assert(!excerptAppears('Liquidated damages of S$8,000 per day', page));
  assert(!excerptAppears('12 weeks', page));
  const pages = new Map([[3, page]]);
  assertEquals(
    checkCitation({ page_no: 3, source_excerpt: 'Defects Liability Period: twelve (12) months' }, pages),
    null,
  );
  assertEquals(checkCitation({ page_no: 4, source_excerpt: 'Defects Liability Period' }, pages), 'page_not_sent');
  assertEquals(checkCitation({ page_no: 3, source_excerpt: 'word '.repeat(26) }, pages), 'excerpt_too_long');
  assertEquals(
    checkCitation({ page_no: 3, source_excerpt: 'LDs are S$9,999 per week' }, pages),
    'excerpt_not_in_source',
  );
});

Deno.test('DOCX pagination estimate keeps paragraphs whole', () => {
  const pages = splitIntoPages(
    Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ${'x'.repeat(900)}`).join('\n\n'),
    3000,
  );
  assertEquals(pages.length, 4);
  assert(pages.every((p) => p.length <= 3000));
  assertStringIncludes(pages[0], 'Paragraph 0');
});

Deno.test('SGT day boundaries for the OCR quota', () => {
  assertEquals(sgtDay(new Date('2026-11-20T16:30:00Z')), '2026-11-21');
  assertEquals(nextSgtDayStart(new Date('2026-11-20T10:00:00Z')).toISOString(), '2026-11-20T16:01:00.000Z');
});

// ---------------------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------------------

const P = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';

const PAGES = [
  'ARTICLES OF AGREEMENT\nThis Agreement is made between Harbour Homes Pte Ltd (the Employer)\nand Lim Builders Pte Ltd (the Contractor).\nThe Contract Sum is S$1,250,000.00.',
  'APPENDIX\nDate of Commencement: 5 January 2026\nDate for Completion: 30 June 2027\nLiquidated damages: S$5,000 per day\nDefects Liability Period: 12 months',
  'GENERAL CONDITIONS OF CONTRACT\nClause 31 Payment. SECRET-GC-TEXT the employer shall respond within the period stated.',
  '', // scanned page: no text layer
  'PARTICULAR CONDITIONS\nClause 31.2 is amended: the payment response shall be served within 14 days of the payment claim.',
  'PRELIMINARIES\nThe Architect shall respond to RFIs within 7 working days of receipt.\nSite meetings are held every two weeks.',
  'BILLS OF QUANTITIES\nItem A SECRET-BQ-TEXT 100 m3 concrete',
];

const TRUTH: Truth = {
  contract_form: {
    value: 'SIA_2016_LUMP_SUM',
    page: 1,
    excerpt: 'This Agreement is made between Harbour Homes Pte Ltd',
  }, // wrong-ish but cited
  employer_name: { value: 'Harbour Homes Pte Ltd', page: 1, excerpt: 'between Harbour Homes Pte Ltd (the Employer)' },
  contract_sum: {
    value: { amount: 1250000, currency: 'SGD' },
    page: 1,
    excerpt: 'The Contract Sum is S$1,250,000.00.',
  },
  date_of_commencement: { value: '2026-01-05', page: 2, excerpt: 'Date of Commencement: 5 January 2026' },
  completion_date: { value: '2027-06-30', page: 2, excerpt: 'Date for Completion: 30 June 2027' },
  liquidated_damages_rate: {
    value: { amount: 5000, currency: 'SGD', per: 'day' },
    page: 2,
    excerpt: 'Liquidated damages: S$5,000 per day',
  },
  defects_liability_period: {
    value: { value: 12, unit: 'months' },
    page: 2,
    excerpt: 'Defects Liability Period: 12 months',
  },
  // An invented value with a made-up excerpt: must be dropped.
  retention_percent: { value: 5, page: 2, excerpt: 'Retention shall be five per cent' },
};

const AMENDMENTS = [{
  group_key: 'payment_response',
  clause: '31.2',
  summary: 'Payment response period changed to 14 days',
  period: 14,
  unit: 'calendar_days',
  page_no: 5,
  source_excerpt: 'the payment response shall be served within 14 days of the payment claim',
  confidence: 0.9,
}, {
  group_key: null,
  clause: '40',
  summary: 'Invented clause',
  period: 3,
  unit: 'calendar_days',
  page_no: 5,
  source_excerpt: 'Clause 40 requires notice within 3 days',
  confidence: 0.8,
}];

const PROCEDURES = [
  {
    kind: 'rfi_response',
    summary: 'RFI replies in 7 working days',
    period: 7,
    unit: 'working_days',
    page_no: 6,
    source_excerpt: 'The Architect shall respond to RFIs within 7 working days of receipt.',
    confidence: 0.9,
  },
  {
    kind: 'meeting_frequency',
    summary: 'Site meetings every two weeks',
    period: null,
    unit: null,
    page_no: 6,
    source_excerpt: 'Site meetings are held every two weeks.',
    confidence: 0.8,
  },
];

const RULES = [
  {
    rule_key: 'sopa.payment_response',
    group_key: 'payment_response',
    origin: 'statute',
    status: 'draft',
    obligation: 'Serve a payment response',
    trigger_event_type: 'payment_claim_served',
    period: null,
    unit: 'calendar_days',
    todo_verify: [],
    is_time_bar: false,
  },
  {
    rule_key: 'sia2016_ls.payment_response',
    group_key: 'payment_response',
    origin: 'standard_form_default',
    status: 'draft',
    obligation: 'Issue the payment certificate / response',
    reminder_label: 'payment response',
    responsible_role: 'contract_admin',
    recipient_role: 'contractor',
    trigger_event_type: 'payment_claim_served',
    period: null,
    unit: null,
    todo_verify: ['period', 'unit', 'clause_ref'],
    is_time_bar: false,
    closed_by_event_types: ['payment_response_served'],
    chains_to: [],
    kind: 'action',
  },
];

// Library rules that read contract fields. SIA sets 21 days for the payment response; its
// valuation objection period is still TODO_VERIFY; PSSCOC sets 14 days.
const LIBRARY = [
  {
    rule_key: 'sia2016_ls.payment_response',
    library_version: '2026.1',
    period: 21,
    unit: 'calendar_days',
    period_field: 'payment_response_period',
    clause_ref: '40(3)',
    todo_verify: [],
    applies_to_contract_forms: ['SIA_2016_LUMP_SUM'],
  },
  {
    rule_key: 'sia2016_ls.defects_notice',
    library_version: '2026.1',
    period: 6,
    unit: 'months',
    period_field: 'defects_liability_period',
    clause_ref: '27',
    todo_verify: [],
    applies_to_contract_forms: ['SIA_2016_LUMP_SUM'],
  },
  {
    rule_key: 'sia2016_ls.valuation_objection',
    library_version: '2026.1',
    period: null,
    unit: 'calendar_days',
    period_field: 'objection_to_valuation_period',
    clause_ref: null,
    todo_verify: ['period'],
    applies_to_contract_forms: ['SIA_2016_LUMP_SUM'],
  },
  {
    rule_key: 'psscoc_cw2020.payment_response',
    library_version: '2026.1',
    period: 14,
    unit: 'calendar_days',
    period_field: 'payment_response_period',
    clause_ref: '32.4',
    todo_verify: [],
    applies_to_contract_forms: ['PSSCOC_CW_2020'],
  },
];

function config(over: (c: any) => void = () => {}) {
  const c: any = {
    tasks: Object.fromEntries(
      ['classify', 'identify_contract', 'extract_fields', 'extract_amendments', 'extract_procedures']
        .map((t) => [t, { provider: 'primary', model: 'p-1', max_output_tokens: 4000 }]),
    ),
    escalation: {
      enabled: true,
      confidence_below: 0.7,
      on_validation_failure: true,
      target: { provider: 'escalate', model: 'e-1' },
      max_output_tokens: 4000,
    },
    fallback: null,
    retry: { max_attempts: 2, base_delay_ms: 0 },
    providers: {
      primary: { adapter: 'openai_compatible', base_url: 'https://p.test/v1', secret_name: 'P_KEY', region: 'SG' },
      escalate: { adapter: 'openai_compatible', base_url: 'https://e.test/v1', secret_name: 'E_KEY', region: 'SG' },
    },
    pricing_usd_per_mtok: {},
    ocr: {
      enabled: false,
      provider: 'paddleocr_api',
      base_url: 'https://ocr.test',
      secret_name: 'OCR_TOKEN',
      model: 'PaddleOCR-VL-1.6',
      region: 'SG',
      min_chars_per_page: 20,
      daily_page_quota: 100,
      max_pages_per_invocation: 5,
    },
    allowed_provider_regions: ['SG'],
  };
  over(c);
  return parseAiConfig(c);
}

async function setup(opts: {
  pages?: string[];
  mime?: string;
  bytes?: Uint8Array;
  truth?: Truth;
  fail?: Record<string, () => LlmError>;
  escalateFail?: Record<string, () => LlmError>;
  escalateTruth?: Truth;
  ocr?: FakeOcr | null;
  cfg?: (c: any) => void;
  declared?: string | null;
} = {}) {
  const io = new MemoryIO();
  const mime = opts.mime ?? 'application/pdf';
  io.addDocument(
    {
      id: D,
      project_id: P,
      storage_path: `${P}/doc.pdf`,
      mime,
      filename: 'contract.pdf',
      declared_form: opts.declared ?? null,
    },
    opts.bytes ?? await makePdf(opts.pages ?? PAGES),
  );
  io.rules = structuredClone(RULES) as any;
  io.library = structuredClone(LIBRARY);
  const calls: ScriptedCall[] = [];
  const logs: CallLog[] = [];
  const cfg = config(opts.cfg);
  const router = createRouter({
    config: cfg,
    secret: () => 'k',
    log: (l) => void logs.push(l),
    sleep: () => Promise.resolve(),
    makeProvider: (id) =>
      id === 'escalate'
        ? scriptedProvider(id, calls, { truth: opts.escalateTruth ?? TRUTH, fail: opts.escalateFail })
        : scriptedProvider(id, calls, {
          truth: opts.truth ?? TRUTH,
          amendments: AMENDMENTS,
          procedures: PROCEDURES,
          fail: opts.fail,
        }),
  });
  const job: Job = { document_id: D, project_id: P, step: 'text', cursor: {}, attempts: 0 };
  const run = (deadline = Date.now() + 60_000) =>
    runJob(job, { io, router, config: cfg, ocr: opts.ocr ?? null, deadline, sleep: () => Promise.resolve() });
  return { io, calls, logs, job, run };
}

const field = (io: MemoryIO, key: string) => io.results!.fields.find((f: any) => f.field_key === key);

Deno.test('pipeline: text-layer PDF end to end (OCR off)', async () => {
  const { io, calls, logs, run } = await setup();
  assertEquals(await run(), { state: 'done' });

  // Text layer: page 4 has none and is flagged; nothing else needs OCR.
  const pages = io.pageRows.get(D)!;
  assertEquals(pages.filter((p) => p.needs_ocr).map((p) => p.page_no), [4]);
  assertEquals(pages.map((p) => p.section), [
    'articles',
    'appendix',
    'general_conditions',
    'other',
    'particular_conditions',
    'preliminaries',
    'bq',
  ]);
  assertStringIncludes(io.results!.warnings.join(' '), '1 page has no text layer');

  // General conditions and BQ text never reached a model; only rule-unclassifiable pages went to classify (none here).
  for (const c of calls) {
    assert(!c.input.includes('SECRET-GC-TEXT'), `${c.schemaName} got general conditions`);
    assert(!c.input.includes('SECRET-BQ-TEXT'), `${c.schemaName} got BQ`);
  }
  assertEquals(calls.filter((c) => c.schemaName === 'page_sections').length, 0);

  // Values with citations; every field has a row; the invented value was dropped.
  assertEquals(io.results!.fields.length, CONTRACT_FIELDS.length);
  assertEquals(field(io, 'liquidated_damages_rate').value, { amount: 5000, currency: 'SGD', per: 'day' });
  assertEquals(field(io, 'date_of_commencement').page_no, 2);
  assertEquals(field(io, 'retention_percent').value, null);
  assertEquals(field(io, 'retention_percent').not_found_reason, 'excerpt_not_in_source');
  assertEquals(field(io, 'gst_treatment').not_found_reason, 'not_found');
  assert(
    io.results!.findings.some((f: any) =>
      f.kind === 'suspected_invention' && f.detail.field_key === 'retention_percent'
    ),
  );

  // Amendment -> draft 'amended' rule copied from the standard-form rule; the invented clause dropped.
  const amended = io.results!.rules.find((r: any) => r.origin === 'amended');
  assertEquals([amended.group_key, amended.period, amended.unit, amended.source_clause, amended.source_page], [
    'payment_response',
    14,
    'calendar_days',
    '31.2',
    5,
  ]);
  assertEquals(amended.trigger_event_type, 'payment_claim_served');
  assertEquals(amended.todo_verify, []);
  assertEquals(amended.cap_days, null);
  assert(!io.results!.findings.some((f: any) => f.clause === '40'));

  // Procedures: RFI -> draft project_procedure rule; meetings -> finding.
  const rfi = io.results!.rules.find((r: any) => r.origin === 'project_procedure');
  assertEquals([rfi.group_key, rfi.period, rfi.unit, rfi.trigger_event_type], [
    'procedure_rfi_response',
    7,
    'working_days',
    'rfi_submitted',
  ]);
  assert(io.results!.findings.some((f: any) => f.kind === 'procedure' && f.detail.kind === 'meeting_frequency'));

  // High-confidence values: no escalation. Every call logged with its prompt version.
  assert(!calls.some((c) => c.provider === 'escalate'));
  assert(logs.every((l) => l.outcome === 'ok' && /\.v\d+$/.test(l.promptVersion)));
});

Deno.test('OCR routing: text-layer pages never go to OCR; the scanned page does', async () => {
  const ocr = new FakeOcr('APPENDIX continued\nPerformance bond: 10% of the Contract Sum', 2);
  const { io, run } = await setup({ ocr, cfg: (c) => (c.ocr.enabled = true) });
  assertEquals(await run(), { state: 'done' });
  assertEquals(ocr.submitted.map((s) => s.filename), ['page-4.pdf']);
  assertEquals(io.ocrUsed, 1);
  const p4 = io.pageRows.get(D)!.find((p) => p.page_no === 4)!;
  assertEquals([p4.text_source, p4.needs_ocr, p4.ocr_provider], ['ocr', false, 'paddleocr_api']);
  assertStringIncludes(p4.text, 'Performance bond');
});

Deno.test("OCR routing: an image upload is OCR'd whole", async () => {
  const ocr = new FakeOcr('APPENDIX\nDefects Liability Period: 12 months', 0);
  const { io, run } = await setup({
    ocr,
    mime: 'image/png',
    bytes: new Uint8Array([1, 2, 3]),
    cfg: (c) => (c.ocr.enabled = true),
  });
  assertEquals(await run(), { state: 'done' });
  assertEquals(ocr.submitted, [{ filename: 'contract.pdf', size: 3 }]);
  assertEquals(io.pageRows.get(D)!.length, 1);
});

Deno.test('OCR quota exhausted: the job waits for the next SGT day, then resumes', async () => {
  const ocr = new FakeOcr('scanned text', 0);
  const { io, job, run } = await setup({ ocr, cfg: (c) => (c.ocr.enabled = true) });
  io.ocrQuotaLeft = 0;
  const out = await run();
  assertEquals(out.state, 'wait');
  assert(out.state === 'wait' && out.quota && out.runAfter.getTime() > Date.now());
  assertEquals(job.step, 'ocr');
  assertEquals(ocr.submitted.length, 0);

  io.ocrQuotaLeft = 10; // next day
  assertEquals(await run(), { state: 'done' });
  assertEquals(ocr.submitted.length, 1);
});

Deno.test('validation failure: retried once, escalated, then marked failed', async () => {
  const bad = () => new LlmError('validation', 'Output did not match the schema', 'x');
  const { io, calls, logs, run } = await setup({
    fail: { contract_fields: bad },
    escalateFail: { contract_fields: bad },
  });
  assertEquals(await run(), { state: 'done' });
  const fieldCalls = calls.filter((c) => c.schemaName === 'contract_fields');
  // identify + 2 field batches? one batch here: (primary, primary retry, escalate, escalate retry) per batch
  assert(fieldCalls.some((c) => c.provider === 'escalate'));
  assertEquals(logs.filter((l) => l.provider === 'primary' && l.task === 'extract_fields').length, 2); // first try + retry with the error
  assertEquals(field(io, 'liquidated_damages_rate').not_found_reason, 'extraction_failed');
  assertEquals(field(io, 'contract_form').not_found_reason, 'extraction_failed');
  assertStringIncludes(io.results!.warnings.join(' '), 'could not be extracted');
});

Deno.test('escalation re-runs only low-confidence fields, with only their pages', async () => {
  const truth: Truth = { ...TRUTH, date_of_commencement: { ...TRUTH.date_of_commencement, confidence: 0.5 } };
  const { io, calls, run } = await setup({
    truth,
    escalateTruth: { date_of_commencement: { ...TRUTH.date_of_commencement, confidence: 0.92 } },
  });
  assertEquals(await run(), { state: 'done' });
  const esc = calls.filter((c) => c.provider === 'escalate');
  assertEquals(esc.length, 1);
  assertEquals(esc[0].fieldKeys, ['date_of_commencement']);
  assertEquals([...esc[0].input.matchAll(/\[Page (\d+)/g)].map((m) => m[1]), ['2']);
  const f = field(io, 'date_of_commencement');
  assertEquals([f.confidence, f.provider], [0.92, 'escalate']);
  assertEquals(field(io, 'completion_date').provider, 'primary');
});

Deno.test('resumable: out of time mid-way, the next run continues from the cursor', async () => {
  const { io, job, run, calls } = await setup();
  assertEquals(await run(0), { state: 'yield' });
  assertEquals(job.step, 'text');
  // Run step by step with a deadline that allows one step each time.
  let guard = 0;
  let out;
  let now = Date.now();
  do {
    out = await runJob(job, {
      io,
      config: config(),
      ocr: null,
      sleep: () => Promise.resolve(),
      router: createRouter({
        config: config(),
        secret: () => 'k',
        log: () => {},
        makeProvider: (id) =>
          scriptedProvider(id, calls, { truth: TRUTH, amendments: AMENDMENTS, procedures: PROCEDURES }),
      }),
      now: () => new Date(now),
      deadline: now + 1, // one step, then yield
    });
    now += 10;
  } while (out.state === 'yield' && guard++ < 50);
  assertEquals(out, { state: 'done' });
  assertEquals(io.downloads >= 1, true);
  assertEquals(field(io, 'completion_date').value, '2027-06-30');
  assert(io.saved.length > 5);
});

// ---------------------------------------------------------------------------------------
// Declared contract form and standard-form defaults
// ---------------------------------------------------------------------------------------

Deno.test('form defaults: latest library version, TODO_VERIFY periods and conflicts left out', () => {
  const row = (o: Partial<LibraryPeriodRow>): LibraryPeriodRow => ({
    rule_key: 'f.a',
    library_version: '2026.1',
    period: 7,
    unit: 'calendar_days',
    period_field: 'payment_response_period',
    clause_ref: '1',
    todo_verify: [],
    ...o,
  });
  const out = formDefaults([
    row({}),
    row({ library_version: '2026.10', period: 9, clause_ref: '2' }), // newer than 2026.1 and 2026.2
    row({ library_version: '2026.2', period: 8 }),
    row({ rule_key: 'f.b', period_field: 'notice_of_claim_period', todo_verify: ['period'] }),
    row({ rule_key: 'f.c', period_field: 'oral_instruction_confirmation_period', period: 3 }),
    row({ rule_key: 'f.d', period_field: 'oral_instruction_confirmation_period', period: 5 }),
  ], 'Form X');
  assertEquals(out, [{
    field_key: 'payment_response_period',
    value: { value: 9, unit: 'calendar_days' },
    source: 'Form X, clause 2',
  }]);
});

Deno.test('declared form: fields the document does not state get the form default; stated ones keep the document value', async () => {
  const { io, run } = await setup({ declared: 'SIA_2016_LUMP_SUM' });
  assertEquals(await run(), { state: 'done' });
  const pay = field(io, 'payment_response_period');
  assertEquals(pay.value, { value: 21, unit: 'calendar_days' });
  assertEquals(pay.origin, 'standard_form_default');
  assertEquals(pay.default_source, 'SIA Building Contract 2016 (lump sum), clause 40(3)');
  assertEquals(pay.not_found_reason, null);
  assertEquals(pay.page_no, null);
  // Stated in the Appendix: the document wins over the form's 6 months.
  const dlp = field(io, 'defects_liability_period');
  assertEquals(dlp.value, { value: 12, unit: 'months' });
  assertEquals(dlp.origin, 'extracted');
  // TODO_VERIFY in the library: no default.
  assertEquals(field(io, 'objection_to_valuation_period').not_found_reason, 'not_found');
  // A suspected invention is not papered over by a default.
  assertEquals(field(io, 'retention_percent').not_found_reason, 'excerpt_not_in_source');
  assertEquals(field(io, 'contract_form').origin, 'extracted');
  assert(!io.results!.warnings.some((w) => w.startsWith('You chose')));
});

Deno.test('declared form differs from the one the document names: warning, defaults from the declared form', async () => {
  const { io, run } = await setup({ declared: 'PSSCOC_CW_2020' });
  assertEquals(await run(), { state: 'done' });
  assertEquals(field(io, 'contract_form').value, 'SIA_2016_LUMP_SUM');
  assertStringIncludes(
    io.results!.warnings.join(' '),
    'You chose PSSCOC Construction Works 2020, but page 1 names SIA Building Contract 2016 (lump sum)',
  );
  assertEquals(field(io, 'payment_response_period').value, { value: 14, unit: 'calendar_days' });
});

Deno.test('declared form: proposed as the contract form when the document names none', async () => {
  const { contract_form: _, ...truth } = TRUTH;
  const { io, run } = await setup({ declared: 'SIA_2016_LUMP_SUM', truth, escalateTruth: truth });
  assertEquals(await run(), { state: 'done' });
  const cf = field(io, 'contract_form');
  assertEquals(cf.value, 'SIA_2016_LUMP_SUM');
  assertEquals(cf.origin, 'declared');
  assertEquals(cf.page_no, null);
  assertEquals(field(io, 'payment_response_period').origin, 'standard_form_default');
});

Deno.test('no declared form: defaults come from the form the document names; none for an unknown form', async () => {
  const a = await setup();
  assertEquals(await a.run(), { state: 'done' });
  assertEquals(field(a.io, 'payment_response_period').value, { value: 21, unit: 'calendar_days' });

  const { contract_form: _, ...truth } = TRUTH;
  const b = await setup({ truth, escalateTruth: truth });
  assertEquals(await b.run(), { state: 'done' });
  assertEquals(field(b.io, 'contract_form').not_found_reason, 'not_found');
  assertEquals(field(b.io, 'payment_response_period').not_found_reason, 'not_found');
});
