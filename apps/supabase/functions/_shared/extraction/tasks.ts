// Output schemas, inputs and post-processing for the extraction tasks. Pure: no I/O, no
// provider names. The pipeline (server/extraction.ts) calls the router with these.

import { z } from 'zod';

import { CONTRACT_FIELDS, FIELD_BY_KEY, type FieldDef, validateFieldValue } from '../contracts/contractFieldSchema.ts';
import { stripNulls, toStrictJsonSchema } from '../llm/json-schema.ts';
import { checkCitation, type GuardFailure } from './guards.ts';
import { pageExcerpt, type Section, SECTIONS } from './sections.ts';

export interface PageText {
  page_no: number;
  text: string;
  section: Section | null;
}

/** Pages as the model sees them: a marker line per page, then its text. */
export function renderPages(pages: readonly PageText[]): string {
  return pages.map((p) => `[Page ${p.page_no}${p.section ? ` | ${p.section}` : ''}]\n${p.text.trim()}`).join('\n\n');
}

/** Splits pages (in order) into batches of at most `maxChars` characters (a page is never split). */
export function batchPages<P extends { text: string }>(pages: readonly P[], maxChars: number, maxPages = 30): P[][] {
  const out: P[][] = [];
  let cur: P[] = [];
  let size = 0;
  for (const p of pages) {
    const len = p.text.length + 40;
    if (cur.length && (size + len > maxChars || cur.length >= maxPages)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------------------

export const classifyOutput = z.object({
  pages: z.array(z.object({ page_no: z.number().int().positive(), section: z.enum(SECTIONS) })),
});

export function classifyInput(pages: readonly { page_no: number; text: string }[]): string {
  return pages.map((p) => `[Page ${p.page_no}]\n${pageExcerpt(p.text)}`).join('\n\n');
}

// ---------------------------------------------------------------------------------------
// identify_contract and extract_fields: one item per field
// ---------------------------------------------------------------------------------------

export const IDENTIFY_KEYS = ['contract_form', 'edition', 'with_quantities', 'option_modules'] as const;

const citation = {
  page_no: z.number().int().positive().nullable(),
  source_excerpt: z.string().nullable(),
  confidence: z.number().min(0).max(1),
};

/** Strict JSON Schema sent to the provider: typed `value` per field. */
export function fieldsJsonSchema(defs: readonly FieldDef[]): Record<string, unknown> {
  const shape = Object.fromEntries(defs.map((d) => [d.key, z.object({ value: d.schema.nullable(), ...citation })]));
  return toStrictJsonSchema(z.object({ fields: z.object(shape) }));
}

/** Loose validation schema: structure only; values are validated per field (fieldDef.schema). */
export const fieldsOutput = z.object({
  fields: z.record(z.string(), z.object({ value: z.unknown(), ...citation })),
});
export type FieldsOutput = z.infer<typeof fieldsOutput>;

/** Fields that may be found in the given sections (fieldDef.foundIn), minus `exclude`. */
export function fieldsForSections(sections: ReadonlySet<Section>, exclude: readonly string[] = []): FieldDef[] {
  return CONTRACT_FIELDS.filter((d) => !exclude.includes(d.key) && d.foundIn.some((s) => sections.has(s)));
}

/** Field list for the prompt: key, label, hint, and the expected value shape. */
export function describeFields(defs: readonly FieldDef[]): string {
  return defs.map((d) => {
    const extra = [d.hint, d.options ? `one of: ${d.options.join(', ')}` : null].filter(Boolean).join('; ');
    return `- ${d.key}: ${d.label}${extra ? ` (${extra})` : ''}`;
  }).join('\n');
}

export type NotFoundReason = 'not_found' | 'excerpt_not_in_source' | 'invalid_value' | 'extraction_failed';

export interface FieldProposal {
  field_key: string;
  value: unknown | null;
  page_no: number | null;
  source_excerpt: string | null;
  confidence: number;
  not_found_reason: NotFoundReason | null;
  provider: string | null;
  model: string | null;
  /** Set during processing: low confidence or invalid, re-run on the escalation target. */
  escalate?: boolean;
  /** Pages this proposal came from (for a narrowed escalation). */
  batch_pages?: number[];
}

export interface SuspectedInvention {
  field_key: string;
  page_no: number | null;
  failure: GuardFailure;
  provider: string;
  model: string;
}

/**
 * Turns one batch's output into proposals: validates each value against its field schema and
 * each citation against the pages sent. Fields the model left out count as not found.
 */
export function processFieldOutput(
  out: FieldsOutput,
  defs: readonly FieldDef[],
  pages: readonly PageText[],
  by: { provider: string; model: string },
  escalateBelow: number,
): { proposals: FieldProposal[]; inventions: SuspectedInvention[] } {
  const pageMap = new Map(pages.map((p) => [p.page_no, p.text]));
  const batchPagesNos = pages.map((p) => p.page_no);
  const proposals: FieldProposal[] = [];
  const inventions: SuspectedInvention[] = [];
  for (const d of defs) {
    const item = out.fields[d.key];
    const base = { field_key: d.key, provider: by.provider, model: by.model, batch_pages: batchPagesNos };
    if (!item || item.value === null || item.value === undefined) {
      proposals.push({
        ...base,
        value: null,
        page_no: null,
        source_excerpt: null,
        confidence: item?.confidence ?? 0,
        not_found_reason: 'not_found',
      });
      continue;
    }
    const v = validateFieldValue(d.key, item.value);
    const valid = v.ok ? v : validateFieldValue(d.key, stripNulls(item.value));
    if (!valid.ok) {
      proposals.push({
        ...base,
        value: null,
        page_no: item.page_no,
        source_excerpt: null,
        confidence: 0,
        not_found_reason: 'invalid_value',
        escalate: true,
      });
      continue;
    }
    const fail = checkCitation(item, pageMap);
    if (fail === 'excerpt_too_long') {
      proposals.push({
        ...base,
        value: null,
        page_no: item.page_no,
        source_excerpt: null,
        confidence: 0,
        not_found_reason: 'invalid_value',
        escalate: true,
      });
      continue;
    }
    if (fail) {
      inventions.push({ field_key: d.key, page_no: item.page_no, failure: fail, ...by });
      proposals.push({
        ...base,
        value: null,
        page_no: null,
        source_excerpt: null,
        confidence: 0,
        not_found_reason: 'excerpt_not_in_source',
      });
      continue;
    }
    proposals.push({
      ...base,
      value: valid.value,
      page_no: item.page_no,
      source_excerpt: item.source_excerpt!.trim(),
      confidence: item.confidence,
      not_found_reason: null,
      escalate: item.confidence < escalateBelow,
    });
  }
  return { proposals, inventions };
}

/** Rank: found beats not found; then higher confidence; then earlier batch (stable). */
function better(a: FieldProposal, b: FieldProposal): boolean {
  const af = a.not_found_reason === null;
  const bf = b.not_found_reason === null;
  if (af !== bf) return af;
  if (!af && !bf) {
    // Prefer the more informative reason: invalid / suspected invention over plain not found.
    const rank = (r: NotFoundReason | null) => (r === 'not_found' ? 0 : 1);
    if (rank(a.not_found_reason) !== rank(b.not_found_reason)) {
      return rank(a.not_found_reason) > rank(b.not_found_reason);
    }
  }
  return a.confidence > b.confidence;
}

/** Keeps the best proposal per field across batches. */
export function mergeProposals(
  current: Record<string, FieldProposal>,
  incoming: readonly FieldProposal[],
): Record<string, FieldProposal> {
  const out = { ...current };
  for (const p of incoming) {
    const have = out[p.field_key];
    if (!have || better(p, have)) out[p.field_key] = p;
  }
  return out;
}

/** Fields to escalate and the pages to send for each (the cited page, else the batch's pages). */
export function escalationPlan(proposals: Record<string, FieldProposal>): { keys: string[]; pages: number[] } {
  const keys: string[] = [];
  const pages = new Set<number>();
  for (const p of Object.values(proposals)) {
    if (!p.escalate) continue;
    keys.push(p.field_key);
    if (p.page_no !== null && p.not_found_reason === null) pages.add(p.page_no);
    else for (const n of p.batch_pages ?? []) pages.add(n);
  }
  return { keys: keys.sort(), pages: [...pages].sort((a, b) => a - b) };
}

/** Applies escalated proposals: an escalated value replaces the original only if it is found and passes the checks. */
export function applyEscalation(
  current: Record<string, FieldProposal>,
  escalated: readonly FieldProposal[],
): Record<string, FieldProposal> {
  const out = { ...current };
  for (const e of escalated) {
    const have = out[e.field_key];
    if (!have) continue;
    if (e.not_found_reason === null && (have.not_found_reason !== null || e.confidence >= have.confidence)) {
      out[e.field_key] = { ...e, escalate: false };
    } else if (have.not_found_reason === 'invalid_value') {
      // Still unusable after escalation: the field failed.
      out[e.field_key] = { ...have, not_found_reason: 'extraction_failed', escalate: false };
    } else {
      out[e.field_key] = { ...have, escalate: false };
    }
  }
  return out;
}

/** Fields whose whole batch failed (validation after retry + escalation, or a refusal). */
export function failedProposals(
  defs: readonly FieldDef[],
  by: { provider: string | null; model: string | null },
): FieldProposal[] {
  return defs.map((d) => ({
    field_key: d.key,
    value: null,
    page_no: null,
    source_excerpt: null,
    confidence: 0,
    not_found_reason: 'extraction_failed',
    provider: by.provider,
    model: by.model,
  }));
}

/** For a proposal ready to store: drops the working attributes. */
export function finalProposal(p: FieldProposal): Omit<FieldProposal, 'escalate' | 'batch_pages'> {
  const { escalate: _e, batch_pages: _b, ...rest } = p;
  return rest;
}

export function defsFor(keys: readonly string[]): FieldDef[] {
  return keys.map((k) => FIELD_BY_KEY.get(k)).filter((d): d is FieldDef => !!d);
}

// ---------------------------------------------------------------------------------------
// extract_amendments: changes to the project's existing rules
// ---------------------------------------------------------------------------------------

const unit = z.enum(['calendar_days', 'working_days', 'weeks', 'months']);

export const amendmentsOutput = z.object({
  amendments: z.array(z.object({
    /** One of the rule groups listed in the prompt, or null when the change matches none. */
    group_key: z.string().nullable(),
    clause: z.string().max(60).nullable(),
    summary: z.string().min(3).max(400),
    period: z.number().int().min(0).max(3650).nullable(),
    unit: unit.nullable(),
    page_no: z.number().int().positive(),
    source_excerpt: z.string(),
    confidence: z.number().min(0).max(1),
  })).max(60),
});
export type Amendment = z.infer<typeof amendmentsOutput>['amendments'][number];

export interface RuleGroupSummary {
  group_key: string;
  obligation: string;
  period: number | null;
  unit: string | null;
  clause: string | null;
}

export function describeRuleGroups(groups: readonly RuleGroupSummary[]): string {
  if (!groups.length) return '(none)';
  return groups.map((g) =>
    `- ${g.group_key}: ${g.obligation}${
      g.period !== null && g.unit ? ` (currently ${g.period} ${g.unit.replace('_', ' ')})` : ''
    }${g.clause ? `, clause ${g.clause}` : ''}`
  ).join('\n');
}

// ---------------------------------------------------------------------------------------
// extract_procedures: project procedures from the preliminaries
// ---------------------------------------------------------------------------------------

export const PROCEDURE_KINDS = [
  'rfi_response',
  'rfa_response',
  'shop_drawing_review',
  'submittal_procedure',
  'meeting_frequency',
  'notice_channel',
  'other',
] as const;
export type ProcedureKind = (typeof PROCEDURE_KINDS)[number];

export const proceduresOutput = z.object({
  procedures: z.array(z.object({
    kind: z.enum(PROCEDURE_KINDS),
    summary: z.string().min(3).max(400),
    period: z.number().int().min(0).max(3650).nullable(),
    unit: unit.nullable(),
    page_no: z.number().int().positive(),
    source_excerpt: z.string(),
    confidence: z.number().min(0).max(1),
  })).max(60),
});
export type Procedure = z.infer<typeof proceduresOutput>['procedures'][number];

/**
 * Procedures that become draft deadline rules (rule data, not periods: the period always comes
 * from the document). Anything else is kept as a finding for the reviewer.
 */
export const PROCEDURE_RULES: Partial<
  Record<ProcedureKind, {
    group_key: string;
    obligation: string;
    reminder_label: string;
    trigger_event_type: string;
    closed_by_event_types: string[];
    responsible_role: string;
    recipient_role: string;
  }>
> = {
  rfi_response: {
    group_key: 'procedure_rfi_response',
    obligation: 'Reply to the request for information',
    reminder_label: 'RFI reply',
    trigger_event_type: 'rfi_submitted',
    closed_by_event_types: ['rfi_responded'],
    responsible_role: 'contract_admin',
    recipient_role: 'contractor',
  },
  rfa_response: {
    group_key: 'procedure_rfa_response',
    obligation: 'Reply to the request for approval',
    reminder_label: 'RFA reply',
    trigger_event_type: 'rfa_submitted',
    closed_by_event_types: ['rfa_responded'],
    responsible_role: 'contract_admin',
    recipient_role: 'contractor',
  },
  shop_drawing_review: {
    group_key: 'procedure_shop_drawing_review',
    obligation: 'Review the shop drawing submission',
    reminder_label: 'shop drawing review',
    trigger_event_type: 'shop_drawing_submitted',
    closed_by_event_types: ['shop_drawing_reviewed'],
    responsible_role: 'contract_admin',
    recipient_role: 'contractor',
  },
};

/** Drops items whose citation fails the guards; returns the kept ones and the rejects. */
export function guardItems<T extends { page_no: number; source_excerpt: string }>(
  items: readonly T[],
  pages: readonly PageText[],
): { kept: T[]; rejected: { item: T; failure: GuardFailure }[] } {
  const pageMap = new Map(pages.map((p) => [p.page_no, p.text]));
  const kept: T[] = [];
  const rejected: { item: T; failure: GuardFailure }[] = [];
  for (const it of items) {
    const f = checkCitation(it, pageMap);
    if (f) rejected.push({ item: it, failure: f });
    else kept.push({ ...it, source_excerpt: it.source_excerpt.trim() });
  }
  return { kept, rejected };
}
