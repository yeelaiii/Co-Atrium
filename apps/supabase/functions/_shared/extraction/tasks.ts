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

// Wire format: what the model returns. Constrained-decoding APIs cap schema complexity per
// request, so the schema is small and fixed whatever the number of fields:
//   * no nullable or union-typed properties (Anthropic allows 16 per request; a typed,
//     nullable value per field needed ~3 each, 155 in total);
//   * one array of identical items, not one object per field (45 per-field objects still
//     compiled to a grammar Anthropic rejected as too large). The field is named by `key`.
// "Not found" is `found: false`; the value travels as JSON text and is checked against its
// field schema afterwards (validateFieldValue), exactly as a typed value was.
const wireItem = {
  found: z.boolean(),
  value_json: z.string(),
  page_no: z.number().int().min(0),
  source_excerpt: z.string(),
  confidence: z.number().min(0).max(1),
};
const wireField = z.object({ key: z.string(), ...wireItem });
export type WireField = z.infer<typeof wireField>;

/** Strict JSON Schema sent to the provider: `fields` is an array of one fixed item; `key` is an enum of the asked fields. */
export function fieldsJsonSchema(defs: readonly FieldDef[]): Record<string, unknown> {
  const keys = defs.map((d) => d.key) as [string, ...string[]];
  return toStrictJsonSchema(z.object({ fields: z.array(z.object({ key: z.enum(keys), ...wireItem })) }));
}

/** The field keys a fields request asks for (read back from its JSON Schema; used by scripted providers). */
export function fieldKeysOf(jsonSchema: unknown): string[] {
  // deno-lint-ignore no-explicit-any
  return [...((jsonSchema as any)?.properties?.fields?.items?.properties?.key?.enum ?? [])];
}

/** A field's answer in wire format (used by scripted providers: test fakes and the eval oracle). */
export function encodeField(
  key: string,
  a: { value: unknown; page_no: number | null; source_excerpt: string | null; confidence: number },
): WireField {
  const found = a.value !== null && a.value !== undefined;
  return {
    key,
    found,
    value_json: found ? JSON.stringify(a.value) : 'null',
    page_no: found ? a.page_no ?? 0 : 0,
    source_excerpt: found ? a.source_excerpt ?? '' : '',
    confidence: a.confidence,
  };
}

/** Wire value -> value. Text that isn't JSON is kept as a string (a bare `Acme Pte Ltd`); the field schema decides. */
function decodeValue(f: WireField): unknown {
  if (!f.found) return null;
  try {
    return JSON.parse(f.value_json);
  } catch {
    return f.value_json.trim() || null;
  }
}

const decodedField = z.object({
  value: z.unknown(),
  page_no: z.number().int().positive().nullable(),
  source_excerpt: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
const decodedFields = z.object({ fields: z.record(z.string(), decodedField) });
export type FieldsOutput = z.infer<typeof decodedFields>;

const wireFields = z.object({ fields: z.array(wireField) }).transform((o): FieldsOutput => {
  const fields: FieldsOutput['fields'] = {};
  for (const f of o.fields) {
    const key = f.key.trim().toLowerCase(); // enum casing is not guaranteed
    const value = decodeValue(f);
    const found = value !== null;
    const item = {
      value,
      page_no: found && f.page_no > 0 ? f.page_no : null,
      source_excerpt: found && f.source_excerpt.trim() ? f.source_excerpt : null,
      confidence: f.confidence,
    };
    // A key listed twice: a found value beats not found, then the higher confidence.
    const have = fields[key];
    const haveFound = have !== undefined && have.value !== null;
    if (!have || (found && !haveFound) || (found === haveFound && item.confidence > have.confidence)) {
      fields[key] = item;
    }
  }
  return { fields };
});

/**
 * Validates the wire format and turns it into one { value, page_no, source_excerpt, confidence }
 * per field. Already-decoded output passes through unchanged, so parsing is idempotent (eval
 * recordings store decoded data and replay re-parses it). Values are checked per field later.
 */
export const fieldsOutput = z.union([wireFields, decodedFields]);

/** Fields that may be found in the given sections (fieldDef.foundIn), minus `exclude`. */
export function fieldsForSections(sections: ReadonlySet<Section>, exclude: readonly string[] = []): FieldDef[] {
  return CONTRACT_FIELDS.filter((d) => !exclude.includes(d.key) && d.foundIn.some((s) => sections.has(s)));
}

/** Field list for the prompt: key, label, hint, and the expected value shape. */
export function describeFields(defs: readonly FieldDef[]): string {
  return defs.map((d) => {
    const extra = [d.hint, d.options ? `one of: ${d.options.join(', ')}` : null].filter(Boolean).join('; ');
    return `- ${d.key}: ${d.label}${extra ? ` (${extra})` : ''}\n  value_json: ${valueShape(d)}`;
  }).join('\n');
}

/** Compact JSON shape of a field's value for the prompt, e.g. {"amount": number, "currency": string|null}. */
export function valueShape(d: FieldDef): string {
  // deno-lint-ignore no-explicit-any
  const root = toStrictJsonSchema(z.object({ v: d.schema })) as any;
  return shape(root.properties.v);
}

// deno-lint-ignore no-explicit-any
function shape(s: any): string {
  if (!s || typeof s !== 'object') return 'any';
  if (Array.isArray(s.anyOf)) return s.anyOf.map(shape).join(' | ');
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((e: unknown) => JSON.stringify(e)).join('|');
  const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
  return types.map((t) => {
    if (t === 'object') {
      const props = Object.entries(s.properties ?? {}).map(([k, v]) => `${JSON.stringify(k)}: ${shape(v)}`);
      return `{${props.join(', ')}}`;
    }
    if (t === 'array') return `[${shape(s.items)}, ...]`;
    return t ?? 'any';
  }).join('|');
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
  /**
   * extracted: read from the document (cited). declared: the contract form the uploader chose.
   * standard_form_default: a period the standard form sets, cited by `default_source`.
   */
  origin?: 'extracted' | 'declared' | 'standard_form_default';
  default_source?: string | null;
}

// ---------------------------------------------------------------------------------------
// The uploader's declared contract form, and the defaults its standard form sets
// ---------------------------------------------------------------------------------------

/** A rule_library row as the defaults need it. */
export interface LibraryPeriodRow {
  rule_key: string;
  library_version: string;
  period: number | null;
  unit: string | null;
  period_field: string | null;
  clause_ref: string | null;
  todo_verify: string[];
}

export interface FormDefault {
  field_key: string;
  value: { value: number; unit: string };
  /** e.g. "SIA Building Contract 2016 (lump sum), clause 40(3)" */
  source: string;
}

function newerVersion(a: string, b: string): boolean {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * Field defaults a standard form sets: the period of each of its library rules that reads a
 * contract field (period_field), latest library version per rule. Periods still marked
 * TODO_VERIFY are left out, and a field two rules disagree on gets no default.
 */
export function formDefaults(rows: readonly LibraryPeriodRow[], formLabel: string): FormDefault[] {
  const latest = new Map<string, LibraryPeriodRow>();
  for (const r of rows) {
    const have = latest.get(r.rule_key);
    if (!have || newerVersion(r.library_version, have.library_version)) latest.set(r.rule_key, r);
  }
  const byField = new Map<string, FormDefault | null>();
  for (const r of latest.values()) {
    if (!r.period_field || r.period === null || !r.unit) continue;
    if (r.todo_verify.includes('period') || r.todo_verify.includes('unit')) continue;
    const value = { value: r.period, unit: r.unit };
    if (!validateFieldValue(r.period_field, value).ok) continue;
    const have = byField.get(r.period_field);
    if (have === null) continue; // already conflicting
    if (have) {
      if (have.value.value !== value.value || have.value.unit !== value.unit) byField.set(r.period_field, null);
      continue;
    }
    byField.set(r.period_field, {
      field_key: r.period_field,
      value,
      source: `${formLabel}${r.clause_ref ? `, clause ${r.clause_ref}` : ''}`.slice(0, 200),
    });
  }
  return [...byField.values()].filter((d): d is FormDefault => d !== null)
    .sort((a, b) => a.field_key.localeCompare(b.field_key));
}

/**
 * Fills fields the document doesn't state (or that could not be extracted) with the form's
 * defaults. Found values, and values dropped as suspected inventions, are left alone.
 */
export function applyFormDefaults(
  proposals: Record<string, FieldProposal>,
  defaults: readonly FormDefault[],
): Record<string, FieldProposal> {
  const out = { ...proposals };
  for (const d of defaults) {
    const p = out[d.field_key];
    if (p && p.not_found_reason !== 'not_found' && p.not_found_reason !== 'extraction_failed') continue;
    out[d.field_key] = {
      field_key: d.field_key,
      value: d.value,
      page_no: null,
      source_excerpt: null,
      confidence: 0,
      not_found_reason: null,
      provider: null,
      model: null,
      origin: 'standard_form_default',
      default_source: d.source,
    };
  }
  return out;
}

/**
 * The contract form proposal given the uploader's choice: the document's own (cited) answer
 * when it names one, else the declared form. Returns a warning when the two disagree.
 */
export function applyDeclaredForm(
  proposals: Record<string, FieldProposal>,
  declared: string,
  label: (form: string) => string,
): { proposals: Record<string, FieldProposal>; warning: string | null } {
  const p = proposals.contract_form;
  if (p && p.not_found_reason === null) {
    if (p.value === declared) return { proposals, warning: null };
    return {
      proposals,
      warning: `You chose ${label(declared)}, but page ${p.page_no} names ${label(String(p.value))}. ` +
        `Defaults were taken from ${label(declared)}: check the contract form before accepting them.`,
    };
  }
  return {
    proposals: {
      ...proposals,
      contract_form: {
        field_key: 'contract_form',
        value: declared,
        page_no: null,
        source_excerpt: null,
        confidence: 0,
        not_found_reason: null,
        provider: null,
        model: null,
        origin: 'declared',
      },
    },
    warning: null,
  };
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
  return { ...rest, origin: rest.origin ?? 'extracted', default_source: rest.default_source ?? null };
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
