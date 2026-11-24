// The extract-contract pipeline. Resumable: each step reads and writes the job's cursor, so an
// invocation can stop at any step boundary (time budget, OCR polling, OCR quota) and the next
// one continues. All I/O goes through ExtractionIO (Supabase in extraction-io.ts, in-memory in
// tests). Steps:
//   text        PDF text layer / DOCX text / image -> document_pages; pages without text -> needs_ocr
//   ocr         needs_ocr pages -> OcrProvider, one page per job, within the daily quota
//   classify    heading rules, then the `classify` task for pages the rules can't place
//   identify    contract form, edition, with quantities, option modules
//   fields      appendix / articles / supplements / particular conditions, batch by batch, then
//               one escalation call for low-confidence and invalid fields only
//   amendments  particular conditions -> draft 'amended' rules (or findings)
//   procedures  preliminaries -> draft 'project_procedure' rules (or findings)
//   write       the declared form and its defaults for fields the document doesn't state, then
//               one transaction: proposals, draft rules, findings; document -> needs_review

import {
  CONTRACT_FIELDS,
  CONTRACT_FORM_LABEL,
  type ContractForm,
  FIELD_BY_KEY,
} from '../contracts/contractFieldSchema.ts';
import { classifyByRules, pagesForTask, type Section } from '../extraction/sections.ts';
import {
  type Amendment,
  amendmentsOutput,
  applyDeclaredForm,
  applyEscalation,
  applyFormDefaults,
  batchPages,
  classifyInput,
  classifyOutput,
  defsFor,
  describeFields,
  describeRuleGroups,
  escalationPlan,
  failedProposals,
  type FieldProposal,
  fieldsForSections,
  fieldsJsonSchema,
  fieldsOutput,
  finalProposal,
  formDefaults,
  guardItems,
  IDENTIFY_KEYS,
  type LibraryPeriodRow,
  mergeProposals,
  type PageText,
  type Procedure,
  PROCEDURE_RULES,
  proceduresOutput,
  processFieldOutput,
  renderPages,
  type RuleGroupSummary,
  type SuspectedInvention,
} from '../extraction/tasks.ts';
import { docxPages, pdfPages, singlePagePdf } from '../extraction/text.ts';
import type { AiConfig, TaskName } from '../llm/config-schema.ts';
import { LlmError, ResidencyError } from '../llm/provider.ts';
import type { Router } from '../llm/router.ts';
import type { OcrProvider } from '../ocr/provider.ts';
import { loadPrompt } from '../prompts/index.ts';
import type { FieldDef } from '../contracts/contractFieldSchema.ts';

export type Step = 'text' | 'ocr' | 'classify' | 'identify' | 'fields' | 'amendments' | 'procedures' | 'write' | 'done';

export interface Cursor {
  ocr?: { submitted: Record<string, string>; failed: number[] };
  field_batch?: number;
  escalated?: boolean;
  proposals?: Record<string, FieldProposal>;
  amend_batch?: number;
  amendments?: (Amendment & { provider: string; model: string })[];
  proc_batch?: number;
  procedures?: (Procedure & { provider: string; model: string })[];
  inventions?: SuspectedInvention[];
  warnings?: string[];
}

export interface Job {
  document_id: string;
  project_id: string;
  step: Step;
  cursor: Cursor;
  attempts: number;
}

export interface DocumentInfo {
  id: string;
  project_id: string;
  storage_path: string;
  mime: string;
  filename: string;
  /** The contract form the uploader chose (null: "not sure", identify it from the document). */
  declared_form?: string | null;
}

export interface PageRow {
  page_no: number;
  text: string;
  text_source: 'pdf_text_layer' | 'ocr' | 'docx' | 'none';
  needs_ocr: boolean;
  section: Section | null;
  section_source: 'rule' | 'llm' | 'user' | null;
  ocr_provider?: string | null;
  ocr_confidence?: number | null;
}

/** A project rule as the amendment step needs it (deadline_rules row). */
// deno-lint-ignore no-explicit-any
export type RuleRow = Record<string, any> & {
  rule_key: string;
  group_key: string;
  origin: string;
  status: string;
  obligation: string;
};

export interface ExtractionIO {
  document(id: string): Promise<DocumentInfo>;
  download(path: string): Promise<Uint8Array>;
  pages(documentId: string): Promise<PageRow[]>;
  upsertPages(doc: DocumentInfo, rows: PageRow[]): Promise<void>;
  setDocument(
    id: string,
    patch: { page_count?: number; pages_estimated?: boolean; extraction_step?: string | null },
  ): Promise<void>;
  saveCursor(job: Job): Promise<void>;
  reserveOcr(provider: string, daySgt: string, wanted: number, quota: number): Promise<number>;
  projectRules(projectId: string): Promise<RuleRow[]>;
  /** The library rules of a standard form that read a contract field (for the form's default periods). */
  libraryPeriods(form: string): Promise<LibraryPeriodRow[]>;
  writeResults(
    doc: DocumentInfo,
    out: { fields: unknown[]; rules: unknown[]; findings: unknown[]; warnings: string[] },
  ): Promise<void>;
}

export interface PipelineDeps {
  io: ExtractionIO;
  router: Router;
  config: AiConfig;
  /** null when OCR is off or not allowed by the residency policy. */
  ocr: OcrProvider | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** Stop starting new work after this time (epoch ms). */
  deadline: number;
}

export type RunOutcome =
  | { state: 'done' }
  | { state: 'yield' } // out of time: run again now
  | { state: 'wait'; runAfter: Date; quota?: boolean }; // OCR polling / quota

const BATCH_CHARS = 40_000;
const CLASSIFY_PAGES = 25;
const OCR_POLL_MS = 5_000;

const STEP_ORDER: Step[] = [
  'text',
  'ocr',
  'classify',
  'identify',
  'fields',
  'amendments',
  'procedures',
  'write',
  'done',
];
const nextStep = (s: Step): Step => STEP_ORDER[STEP_ORDER.indexOf(s) + 1] ?? 'done';

export function sgtDay(d: Date): string {
  return new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 00:01 SGT tomorrow. */
export function nextSgtDayStart(d: Date): Date {
  const day = sgtDay(d);
  return new Date(new Date(`${day}T00:01:00+08:00`).getTime() + 24 * 3600_000);
}

const isImage = (mime: string) => mime.startsWith('image/');
const isDocx = (mime: string) => mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Errors that a retry won't fix: the job fails with this message. */
export function isFatal(e: unknown): boolean {
  return e instanceof ResidencyError || (e instanceof LlmError && e.kind === 'fatal') ||
    e instanceof FatalExtractionError;
}

export class FatalExtractionError extends Error {}

/** Runs steps until done, out of time, or waiting. Saves the cursor after every step. */
export async function runJob(job: Job, deps: PipelineDeps): Promise<RunOutcome> {
  const now = deps.now ?? (() => new Date());
  const doc = await deps.io.document(job.document_id);
  const ctx = new Ctx(job, doc, deps);
  while (job.step !== 'done') {
    if (now().getTime() >= deps.deadline) return { state: 'yield' };
    await deps.io.setDocument(doc.id, { extraction_step: job.step });
    const res = await STEPS[job.step](ctx);
    if (res === 'again') {
      await deps.io.saveCursor(job);
      continue;
    }
    if (res !== 'next') {
      await deps.io.saveCursor(job);
      return res;
    }
    job.step = nextStep(job.step);
    await deps.io.saveCursor(job);
  }
  return { state: 'done' };
}

type StepResult = 'next' | 'again' | { state: 'wait'; runAfter: Date; quota?: boolean } | { state: 'yield' };

class Ctx {
  private bytes: Uint8Array | null = null;
  private pageCache: PageRow[] | null = null;
  constructor(public job: Job, public doc: DocumentInfo, public deps: PipelineDeps) {}

  get c(): Cursor {
    return this.job.cursor;
  }
  get now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
  timeLeft(): number {
    return this.deps.deadline - this.now.getTime();
  }
  warn(msg: string) {
    this.c.warnings = [...new Set([...(this.c.warnings ?? []), msg])];
  }
  async file(): Promise<Uint8Array> {
    this.bytes ??= await this.deps.io.download(this.doc.storage_path);
    return this.bytes;
  }
  async pages(): Promise<PageRow[]> {
    this.pageCache ??= await this.deps.io.pages(this.doc.id);
    return this.pageCache;
  }
  async savePages(rows: PageRow[]) {
    if (!rows.length) return;
    await this.deps.io.upsertPages(this.doc, rows);
    if (this.pageCache) {
      const byNo = new Map(this.pageCache.map((p) => [p.page_no, p]));
      for (const r of rows) byNo.set(r.page_no, r);
      this.pageCache = [...byNo.values()].sort((a, b) => a.page_no - b.page_no);
    }
  }
  async text(): Promise<PageText[]> {
    return (await this.pages()).map((p) => ({ page_no: p.page_no, text: p.text, section: p.section }));
  }
}

const STEPS: Record<Exclude<Step, 'done'>, (ctx: Ctx) => Promise<StepResult>> = {
  // ---------------------------------------------------------------- text
  async text(ctx) {
    const { mime } = ctx.doc;
    const min = ctx.deps.config.ocr.min_chars_per_page;
    const bytes = await ctx.file();
    let rows: PageRow[];
    if (isImage(mime)) {
      rows = [{ page_no: 1, text: '', text_source: 'none', needs_ocr: true, section: null, section_source: null }];
    } else if (isDocx(mime)) {
      const pages = await docxPages(bytes);
      rows = pages.map((t, i) => ({
        page_no: i + 1,
        text: t.slice(0, 200_000),
        text_source: 'docx',
        needs_ocr: false,
        section: null,
        section_source: null,
      }));
      await ctx.deps.io.setDocument(ctx.doc.id, { pages_estimated: true });
    } else {
      let texts: string[];
      try {
        texts = await pdfPages(bytes);
      } catch (e) {
        throw new FatalExtractionError(
          `The PDF could not be read (${e instanceof Error ? e.message : 'unknown error'}). Is it password-protected?`,
        );
      }
      rows = texts.map((t, i) => ({
        page_no: i + 1,
        text: t.slice(0, 200_000),
        text_source: 'pdf_text_layer',
        needs_ocr: t.replace(/\s/g, '').length < min,
        section: null,
        section_source: null,
      }));
    }
    if (!rows.length) throw new FatalExtractionError('The document has no pages');
    await ctx.savePages(rows);
    await ctx.deps.io.setDocument(ctx.doc.id, { page_count: rows.length });
    return 'next';
  },

  // ---------------------------------------------------------------- ocr
  async ocr(ctx) {
    const cfg = ctx.deps.config.ocr;
    const pages = await ctx.pages();
    const need = pages.filter((p) => p.needs_ocr);
    if (!need.length) return 'next';
    if (!ctx.deps.ocr) {
      ctx.warn(
        `${need.length} page${
          need.length === 1 ? ' has' : 's have'
        } no text layer and could not be read: OCR is turned off. ` +
          'Values on those pages will show as not found.',
      );
      return 'next';
    }
    const ocr = ctx.deps.ocr;
    const st = (ctx.c.ocr ??= { submitted: {}, failed: [] });

    // Submit what the quota allows.
    const toSubmit = need.filter((p) => !(String(p.page_no) in st.submitted) && !st.failed.includes(p.page_no))
      .slice(0, cfg.max_pages_per_invocation);
    if (toSubmit.length) {
      const granted = await ctx.deps.io.reserveOcr(
        cfg.provider,
        sgtDay(ctx.now),
        toSubmit.length,
        cfg.daily_page_quota,
      );
      if (granted === 0 && Object.keys(st.submitted).length === 0) {
        return { state: 'wait', runAfter: nextSgtDayStart(ctx.now), quota: true };
      }
      const bytes = await ctx.file();
      for (const p of toSubmit.slice(0, granted)) {
        const file = isImage(ctx.doc.mime)
          ? { bytes, filename: ctx.doc.filename }
          : { bytes: await singlePagePdf(bytes, p.page_no), filename: `page-${p.page_no}.pdf` };
        st.submitted[String(p.page_no)] = await ocr.submit(file);
      }
      await ctx.deps.io.saveCursor(ctx.job);
    }

    // Poll until every submitted page is back, or time runs out.
    while (Object.keys(st.submitted).length) {
      for (const [pageNo, jobId] of Object.entries(st.submitted)) {
        const res = await ocr.poll(jobId);
        if (res.state === 'done') {
          const p = pages.find((x) => x.page_no === Number(pageNo))!;
          await ctx.savePages([{
            ...p,
            text: (res.text ?? '').slice(0, 200_000),
            text_source: 'ocr',
            needs_ocr: false,
            ocr_provider: ocr.id,
            ocr_confidence: res.confidence ?? null,
          }]);
          delete st.submitted[pageNo];
        } else if (res.state === 'failed') {
          st.failed.push(Number(pageNo));
          delete st.submitted[pageNo];
          ctx.warn(`OCR failed on page ${pageNo}: ${res.error ?? 'unknown error'}`);
        }
      }
      await ctx.deps.io.saveCursor(ctx.job);
      if (!Object.keys(st.submitted).length) break;
      if (ctx.timeLeft() < OCR_POLL_MS * 2) return { state: 'wait', runAfter: new Date(ctx.now.getTime() + 15_000) };
      await (ctx.deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(OCR_POLL_MS);
    }
    const remaining = (await ctx.pages()).filter((p) => p.needs_ocr && !st.failed.includes(p.page_no));
    return remaining.length ? 'again' : 'next';
  },

  // ---------------------------------------------------------------- classify
  async classify(ctx) {
    const pages = await ctx.pages();
    const byRule = new Map(classifyByRules(pages).map((c) => [c.page_no, c]));
    const updated: PageRow[] = pages.map((p) => {
      if (p.section_source === 'user') return p;
      const c = byRule.get(p.page_no)!;
      if (c.section) return { ...p, section: c.section, section_source: 'rule' };
      if (!p.text.trim()) return { ...p, section: 'other', section_source: 'rule' };
      return { ...p, section: null, section_source: null };
    });
    const unknown = updated.filter((p) => p.section === null);
    for (let i = 0; i < unknown.length; i += CLASSIFY_PAGES) {
      const batch = unknown.slice(i, i + CLASSIFY_PAGES);
      const sent = new Set(batch.map((p) => p.page_no));
      const labels = new Map<number, Section>();
      try {
        const { text, version } = await loadPrompt('classify');
        const res = await ctx.deps.router.run('classify', {
          system: text,
          input: classifyInput(batch),
          schema: classifyOutput,
          schemaName: 'page_sections',
          promptVersion: version,
        });
        for (const r of res.data.pages) if (sent.has(r.page_no)) labels.set(r.page_no, r.section);
      } catch (e) {
        if (!(e instanceof LlmError) || e.retryable || e.kind === 'fatal') throw e;
        ctx.warn(
          `Pages ${batch[0].page_no}-${batch[batch.length - 1].page_no} could not be classified and were skipped.`,
        );
      }
      for (const p of batch) {
        const s = labels.get(p.page_no) ?? 'other';
        Object.assign(p, { section: s, section_source: 'llm' });
      }
    }
    await ctx.savePages(updated);
    return 'next';
  },

  // ---------------------------------------------------------------- identify
  async identify(ctx) {
    const defs = defsFor(IDENTIFY_KEYS);
    const pages = pagesForTask('identify_contract', await ctx.text());
    if (!pages.length) {
      ctx.warn('No articles of agreement or appendix pages were found, so the contract form could not be identified.');
      ctx.c.proposals = mergeProposals(
        ctx.c.proposals ?? {},
        failedProposals(defs, { provider: null, model: null })
          .map((p) => ({ ...p, not_found_reason: 'not_found' as const })),
      );
      return 'next';
    }
    const batch = batchPages(pages, BATCH_CHARS)[0];
    await runFieldTask(ctx, 'identify_contract', defs, batch);
    return 'next';
  },

  // ---------------------------------------------------------------- fields (+ escalation)
  async fields(ctx) {
    const pages = pagesForTask('extract_fields', await ctx.text());
    const batches = batchPages(pages, BATCH_CHARS);
    const i = ctx.c.field_batch ?? 0;
    if (i < batches.length) {
      const batch = batches[i];
      const sections = new Set(batch.map((p) => p.section!).filter(Boolean));
      const defs = fieldsForSections(sections, IDENTIFY_KEYS);
      if (defs.length) await runFieldTask(ctx, 'extract_fields', defs, batch);
      ctx.c.field_batch = i + 1;
      return 'again';
    }
    if (!pages.length) ctx.warn('No appendix, articles or particular conditions pages were found.');
    if (!ctx.c.escalated) {
      await escalate(ctx, await ctx.text());
      ctx.c.escalated = true;
    }
    return 'next';
  },

  // ---------------------------------------------------------------- amendments
  async amendments(ctx) {
    const pages = pagesForTask('extract_amendments', await ctx.text());
    const batches = batchPages(pages, BATCH_CHARS);
    const i = ctx.c.amend_batch ?? 0;
    if (i >= batches.length) return 'next';
    const batch = batches[i];
    const groups = summariseGroups(await ctx.deps.io.projectRules(ctx.doc.project_id));
    const { text, version } = await loadPrompt('extract_amendments', { RULE_GROUPS: describeRuleGroups(groups) });
    try {
      const res = await ctx.deps.router.run('extract_amendments', {
        system: text,
        input: renderPages(batch),
        schema: amendmentsOutput,
        schemaName: 'contract_amendments',
        promptVersion: version,
      });
      const { kept, rejected } = guardItems(res.data.amendments, batch);
      ctx.c.amendments = [
        ...(ctx.c.amendments ?? []),
        ...kept.map((a) => ({ ...a, provider: res.provider, model: res.model })),
      ];
      ctx.c.inventions = [
        ...(ctx.c.inventions ?? []),
        ...rejected.map((r) => ({
          field_key: `amendment:${r.item.group_key ?? r.item.clause ?? '?'}`,
          page_no: r.item.page_no,
          failure: r.failure,
          provider: res.provider,
          model: res.model,
        })),
      ];
    } catch (e) {
      if (!(e instanceof LlmError) || e.retryable || e.kind === 'fatal') throw e;
      ctx.warn(
        `The particular conditions on pages ${batch[0].page_no}-${
          batch[batch.length - 1].page_no
        } could not be read for amendments.`,
      );
    }
    ctx.c.amend_batch = i + 1;
    return 'again';
  },

  // ---------------------------------------------------------------- procedures
  async procedures(ctx) {
    const pages = pagesForTask('extract_procedures', await ctx.text());
    const batches = batchPages(pages, BATCH_CHARS);
    const i = ctx.c.proc_batch ?? 0;
    if (i >= batches.length) return 'next';
    const batch = batches[i];
    const { text, version } = await loadPrompt('extract_procedures');
    try {
      const res = await ctx.deps.router.run('extract_procedures', {
        system: text,
        input: renderPages(batch),
        schema: proceduresOutput,
        schemaName: 'project_procedures',
        promptVersion: version,
      });
      const { kept, rejected } = guardItems(res.data.procedures, batch);
      ctx.c.procedures = [
        ...(ctx.c.procedures ?? []),
        ...kept.map((p) => ({ ...p, provider: res.provider, model: res.model })),
      ];
      ctx.c.inventions = [
        ...(ctx.c.inventions ?? []),
        ...rejected.map((r) => ({
          field_key: `procedure:${r.item.kind}`,
          page_no: r.item.page_no,
          failure: r.failure,
          provider: res.provider,
          model: res.model,
        })),
      ];
    } catch (e) {
      if (!(e instanceof LlmError) || e.retryable || e.kind === 'fatal') throw e;
      ctx.warn(
        `The preliminaries on pages ${batch[0].page_no}-${
          batch[batch.length - 1].page_no
        } could not be read for procedures.`,
      );
    }
    ctx.c.proc_batch = i + 1;
    return 'again';
  },

  // ---------------------------------------------------------------- write
  async write(ctx) {
    const proposals = { ...(ctx.c.proposals ?? {}) };
    for (const d of CONTRACT_FIELDS) {
      proposals[d.key] ??= {
        field_key: d.key,
        value: null,
        page_no: null,
        source_excerpt: null,
        confidence: 0,
        not_found_reason: 'not_found',
        provider: null,
        model: null,
      };
      if (proposals[d.key].not_found_reason === 'invalid_value') {
        proposals[d.key] = { ...proposals[d.key], not_found_reason: 'extraction_failed' };
      }
    }
    // The uploader's choice decides the form whose defaults apply; without one, the form the
    // document names (a proposal either way: nothing is used until someone accepts it).
    const declared = ctx.doc.declared_form ?? null;
    let fields = proposals;
    if (declared) {
      const res = applyDeclaredForm(fields, declared, formLabel);
      fields = res.proposals;
      if (res.warning) ctx.warn(res.warning);
    }
    const identified = fields.contract_form?.not_found_reason === null ? String(fields.contract_form.value) : null;
    const form = declared ?? identified;
    if (form && form !== 'BESPOKE' && form !== 'UNKNOWN') {
      fields = applyFormDefaults(fields, formDefaults(await ctx.deps.io.libraryPeriods(form), formLabel(form)));
    }
    const rules = await ctx.deps.io.projectRules(ctx.doc.project_id);
    const { rules: draftRules, findings } = buildRulesAndFindings(
      ctx.doc.id,
      rules,
      ctx.c.amendments ?? [],
      ctx.c.procedures ?? [],
    );
    for (const inv of ctx.c.inventions ?? []) {
      findings.push({
        kind: 'suspected_invention',
        summary: `${FIELD_BY_KEY.get(inv.field_key)?.label ?? inv.field_key}: dropped (${
          inv.failure.replaceAll('_', ' ')
        })`,
        clause: null,
        page_no: inv.page_no,
        source_excerpt: null,
        confidence: null,
        detail: inv,
      });
    }
    await ctx.deps.io.writeResults(ctx.doc, {
      fields: Object.values(fields).map(finalProposal),
      rules: draftRules,
      findings,
      warnings: ctx.c.warnings ?? [],
    });
    return 'next';
  },
};

const formLabel = (form: string) => CONTRACT_FORM_LABEL[form as ContractForm] ?? form;

/** One identify / fields call on a batch, with validation-failure escalation. Merges into the cursor. */
async function runFieldTask(ctx: Ctx, task: TaskName, defs: FieldDef[], batch: PageText[]) {
  const esc = ctx.deps.config.escalation;
  const { text, version } = await loadPrompt(task, { FIELDS: describeFields(defs) });
  const req = {
    system: text,
    input: renderPages(batch),
    schema: fieldsOutput,
    jsonSchema: fieldsJsonSchema(defs),
    schemaName: 'contract_fields',
    promptVersion: version,
  };
  const below = esc.enabled ? esc.confidence_below : -1;
  let out: { proposals: FieldProposal[]; inventions: SuspectedInvention[] };
  try {
    const res = await ctx.deps.router.run(task, req);
    out = processFieldOutput(res.data, defs, batch, res, below);
  } catch (e) {
    if (!(e instanceof LlmError) || e.retryable || e.kind === 'fatal') throw e;
    // Validation still failing after the retry (or a refusal).
    out = { proposals: failedProposals(defs, { provider: e.provider, model: null }), inventions: [] };
    if (e.kind === 'validation' && esc.enabled && esc.on_validation_failure) {
      try {
        const res = await ctx.deps.router.escalate(task, req);
        out = processFieldOutput(res.data, defs, batch, res, -1);
      } catch (e2) {
        if (e2 instanceof ResidencyError || !(e2 instanceof LlmError) || e2.kind === 'fatal') throw e2;
        ctx.warn(`Some values on pages ${batch[0].page_no}-${batch[batch.length - 1].page_no} could not be extracted.`);
      }
    } else {
      ctx.warn(`Some values on pages ${batch[0].page_no}-${batch[batch.length - 1].page_no} could not be extracted.`);
    }
  }
  ctx.c.proposals = mergeProposals(ctx.c.proposals ?? {}, out.proposals);
  ctx.c.inventions = [...(ctx.c.inventions ?? []), ...out.inventions];
}

/** Re-runs only low-confidence / invalid fields on the escalation target, with only their pages. */
async function escalate(ctx: Ctx, all: PageText[]) {
  const esc = ctx.deps.config.escalation;
  const proposals = ctx.c.proposals ?? {};
  const plan = escalationPlan(proposals);
  if (!esc.enabled || !plan.keys.length) {
    ctx.c.proposals = Object.fromEntries(Object.entries(proposals).map(([k, p]) => [k, { ...p, escalate: false }]));
    return;
  }
  const wanted = new Set(plan.pages);
  const pages = batchPages(all.filter((p) => wanted.has(p.page_no)), BATCH_CHARS)[0] ?? [];
  const defs = defsFor(plan.keys);
  const { text, version } = await loadPrompt('extract_fields', { FIELDS: describeFields(defs) });
  try {
    const res = await ctx.deps.router.escalate('extract_fields', {
      system: text,
      input: renderPages(pages),
      schema: fieldsOutput,
      jsonSchema: fieldsJsonSchema(defs),
      schemaName: 'contract_fields',
      promptVersion: version,
    });
    const out = processFieldOutput(res.data, defs, pages, res, -1);
    ctx.c.proposals = applyEscalation(proposals, out.proposals);
    ctx.c.inventions = [...(ctx.c.inventions ?? []), ...out.inventions];
  } catch (e) {
    if (e instanceof ResidencyError || !(e instanceof LlmError) || e.kind === 'fatal') throw e;
    if (e.retryable) throw e;
    // Escalation output unusable: keep the originals; invalid ones become failures.
    ctx.c.proposals = Object.fromEntries(
      Object.entries(proposals).map(([k, p]) => [k, {
        ...p,
        escalate: false,
        not_found_reason: p.not_found_reason === 'invalid_value' ? 'extraction_failed' as const : p.not_found_reason,
      }]),
    );
  }
}

// ---------------------------------------------------------------- rules from amendments / procedures

const BASE_RANK: Record<string, number> = {
  amended: 4,
  project_procedure: 3,
  user_defined: 3,
  standard_form_default: 2,
  statute: 1,
};

/** The rule an amendment changes: the best non-rejected rule of the group (verified first). */
function baseRule(rules: RuleRow[], group: string): RuleRow | null {
  const cands = rules.filter((r) => r.group_key === group && r.status !== 'rejected' && r.origin !== 'amended');
  cands.sort((a, b) =>
    Number(b.status === 'verified') - Number(a.status === 'verified') ||
    (BASE_RANK[b.origin] ?? 0) - (BASE_RANK[a.origin] ?? 0)
  );
  return cands[0] ?? null;
}

export function summariseGroups(rules: RuleRow[]): RuleGroupSummary[] {
  const groups = [
    ...new Set(
      rules.filter((r) => r.status !== 'rejected' && r.trigger_event_type !== 'chained').map((r) => r.group_key),
    ),
  ].sort();
  return groups.map((g) => {
    const r = baseRule(rules, g)!;
    return {
      group_key: g,
      obligation: r.obligation,
      period: r.period ?? null,
      unit: r.unit ?? null,
      clause: r.source_clause ?? null,
    };
  }).filter((g) => g.obligation);
}

const RULE_COPY = [
  'kind',
  'obligation',
  'reminder_label',
  'responsible_role',
  'recipient_role',
  'trigger_event_type',
  'includes_public_holidays',
  'is_time_bar',
  'consequence',
  'closed_by_event_types',
  'chains_to',
] as const;

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

export function buildRulesAndFindings(
  documentId: string,
  rules: RuleRow[],
  amendments: readonly (Amendment & { provider?: string; model?: string })[],
  procedures: readonly (Procedure & { provider?: string; model?: string })[],
): { rules: Json[]; findings: Json[] } {
  const out: Json[] = [];
  const findings: Json[] = [];
  const tag = documentId.replace(/-/g, '').slice(0, 8);
  const used = new Map<string, number>();
  const key = (prefix: string, group: string) => {
    const n = (used.get(group) ?? 0) + 1;
    used.set(group, n);
    return `${prefix}.${group}_${tag}${n > 1 ? `_${n}` : ''}`;
  };

  for (const a of amendments) {
    const base = a.group_key ? baseRule(rules, a.group_key) : null;
    if (!base || a.period === null || a.unit === null) {
      findings.push({
        kind: 'amendment',
        summary: a.summary,
        clause: a.clause,
        page_no: a.page_no,
        source_excerpt: a.source_excerpt,
        confidence: a.confidence,
        detail: { group_key: a.group_key, period: a.period, unit: a.unit },
      });
      continue;
    }
    const todo = new Set<string>(base.todo_verify ?? []);
    for (const k of ['period', 'unit', ...(a.clause ? ['clause_ref'] : [])]) todo.delete(k);
    if (base.is_time_bar === null || base.is_time_bar === undefined) todo.add('is_time_bar');
    out.push({
      ...Object.fromEntries(RULE_COPY.map((k) => [k, base[k]])),
      rule_key: key('amended', a.group_key!),
      group_key: a.group_key,
      period: a.period,
      unit: a.unit,
      period_field: null,
      default_period: null,
      cap_days: null, // statute caps in the group still apply (precedence.ts)
      cap_label: null,
      origin: 'amended',
      source_clause: a.clause,
      source_page: a.page_no,
      confidence: a.confidence,
      todo_verify: [...todo],
    });
  }

  for (const p of procedures) {
    const tpl = PROCEDURE_RULES[p.kind];
    if (!tpl || p.period === null || p.unit === null) {
      findings.push({
        kind: 'procedure',
        summary: p.summary,
        clause: null,
        page_no: p.page_no,
        source_excerpt: p.source_excerpt,
        confidence: p.confidence,
        detail: { kind: p.kind, period: p.period, unit: p.unit },
      });
      continue;
    }
    out.push({
      ...tpl,
      kind: 'action',
      rule_key: key('project_procedure', tpl.group_key),
      period: p.period,
      unit: p.unit,
      includes_public_holidays: null,
      is_time_bar: false,
      origin: 'project_procedure',
      source_clause: null,
      source_page: p.page_no,
      confidence: p.confidence,
      todo_verify: [],
      chains_to: [],
    });
  }
  return { rules: out, findings };
}
