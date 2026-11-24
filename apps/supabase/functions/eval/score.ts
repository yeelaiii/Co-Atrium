// Scores one extraction run against a fixture's golden answers. Pure.
//
// Per field (fields in `ignore` are skipped):
//   golden value  -> correct | wrong | missed (null returned) | failed (extraction_failed)
//   golden absent -> not_found_ok (null returned) | invented (a value returned)
// Invented values are the headline: a model that makes up an LD rate is worse than one that
// says "not found".

import { FIELD_BY_KEY, validateFieldValue } from '../_shared/contracts/contractFieldSchema.ts';
import { normalizeForMatch } from '../_shared/extraction/guards.ts';
import { PROCEDURE_RULES } from '../_shared/extraction/tasks.ts';
import type { CallLog } from '../_shared/llm/router.ts';
import { type ExpectedField, type Fixture, scoredFields } from './fixtures.ts';

export type FieldOutcome = 'correct' | 'wrong' | 'missed' | 'failed' | 'not_found_ok' | 'invented';

export interface FieldScore {
  field_key: string;
  outcome: FieldOutcome;
  expected: unknown;
  got: unknown;
  expected_page: number | null;
  got_page: number | null;
  confidence: number | null;
  not_found_reason: string | null;
  provider: string | null;
  model: string | null;
  source_excerpt: string | null;
}

export interface PipelineOutput {
  // deno-lint-ignore no-explicit-any
  fields: any[];
  // deno-lint-ignore no-explicit-any
  rules: any[];
  // deno-lint-ignore no-explicit-any
  findings: any[];
  warnings: string[];
}

export interface FixtureScore {
  fixture: string;
  /** Set when the run did not finish (the job would be `failed`). */
  error: string | null;
  fields: FieldScore[];
  counts: Record<FieldOutcome, number>;
  /** Values dropped by the excerpt guard (suspected inventions caught before review). */
  caught_by_guard: number;
  /** Correct values whose cited page is the golden page. */
  page_ok: number;
  amendments: { expected: number; found: number; extra: number };
  procedures: { expected: number; found: number; extra: number };
  calls: number;
  validation_failed_calls: number;
  error_calls: number;
  latency_ms_total: number;
  input_tokens: number;
  output_tokens: number;
  /** Sum of known estimates; calls without a price are counted in cost_unknown_calls. */
  cost_usd: number;
  cost_unknown_calls: number;
  /** Model calls whose input contained text from a section that must never be sent. */
  leaked_calls: number;
  warnings: string[];
}

const LEAK = /ZZ-(GC|SPEC|BQ|DWG)-MARKER/;

/** Flattens a value to normalised text (for keyword matching). */
function flat(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).map(flat).join(' ');
  return normalizeForMatch(String(v));
}

function norm(v: unknown): unknown {
  if (typeof v === 'string') return normalizeForMatch(v);
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).map(([k, x]) => [k, norm(x)]),
    );
  }
  return v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return deepEqual(ka, kb) && ka.every((k) => deepEqual((a as never)[k], (b as never)[k]));
  }
  return false;
}

/** Schema defaults applied (e.g. currency SGD), then normalised; lists of text compared as sets. */
function canonical(key: string, v: unknown): unknown {
  const parsed = validateFieldValue(key, v);
  const value = norm(parsed.ok ? parsed.value : v);
  if (FIELD_BY_KEY.get(key)?.kind === 'text_list' && Array.isArray(value)) return [...value].sort();
  return value;
}

export function valueMatches(key: string, exp: ExpectedField, got: unknown): boolean {
  if (got === null || got === undefined) return false;
  if (exp.match === 'keywords') {
    const text = flat(got);
    return (exp.keywords ?? []).every((k) => text.includes(normalizeForMatch(k)));
  }
  const g = canonical(key, got);
  return [exp.value, ...(exp.accept ?? [])].some((e) => deepEqual(canonical(key, e), g));
}

const emptyCounts = (): Record<FieldOutcome, number> => ({
  correct: 0,
  wrong: 0,
  missed: 0,
  failed: 0,
  not_found_ok: 0,
  invented: 0,
});

export function scoreFixture(
  fx: Fixture,
  out: PipelineOutput | null,
  logs: readonly CallLog[],
  inputs: readonly string[],
  error: string | null = null,
): FixtureScore {
  const byKey = new Map((out?.fields ?? []).map((f) => [f.field_key, f]));
  const fields: FieldScore[] = [];
  const counts = emptyCounts();
  let pageOk = 0;
  for (const { key, expected } of scoredFields(fx.expected)) {
    const got = byKey.get(key);
    const value = got?.value ?? null;
    let outcome: FieldOutcome;
    if (expected) {
      if (value === null) outcome = got?.not_found_reason === 'extraction_failed' ? 'failed' : 'missed';
      else outcome = valueMatches(key, expected, value) ? 'correct' : 'wrong';
    } else {
      outcome = value === null ? 'not_found_ok' : 'invented';
    }
    counts[outcome]++;
    if (outcome === 'correct' && got?.page_no === expected?.page) pageOk++;
    fields.push({
      field_key: key,
      outcome,
      expected: expected ? expected.value : null,
      got: value,
      expected_page: expected?.page ?? null,
      got_page: got?.page_no ?? null,
      confidence: got?.confidence ?? null,
      not_found_reason: got?.not_found_reason ?? null,
      provider: got?.provider ?? null,
      model: got?.model ?? null,
      source_excerpt: got?.source_excerpt ?? null,
    });
  }

  const rules = out?.rules ?? [];
  const amended = rules.filter((r) => r.origin === 'amended');
  const procs = rules.filter((r) => r.origin === 'project_procedure');
  const found = (want: { group: string; period: number; unit: string }[], have: typeof rules) => {
    const left = [...have];
    let n = 0;
    for (const w of want) {
      const i = left.findIndex((r) => r.group_key === w.group && r.period === w.period && r.unit === w.unit);
      if (i >= 0) {
        n++;
        left.splice(i, 1);
      }
    }
    return { expected: want.length, found: n, extra: left.length };
  };
  const wantAmend = fx.expected.amendments.map((a) => ({ group: a.group_key, period: a.period, unit: a.unit }));
  const wantProc = fx.expected.procedures
    .filter((p) => PROCEDURE_RULES[p.kind] && p.period !== null && p.unit !== null)
    .map((p) => ({ group: PROCEDURE_RULES[p.kind]!.group_key, period: p.period!, unit: p.unit! }));

  return {
    fixture: fx.name,
    error,
    fields,
    counts,
    caught_by_guard: (out?.findings ?? []).filter((f) => f.kind === 'suspected_invention').length,
    page_ok: pageOk,
    amendments: found(wantAmend, amended),
    procedures: found(wantProc, procs),
    calls: logs.length,
    validation_failed_calls: logs.filter((l) => l.outcome === 'validation_failed').length,
    error_calls: logs.filter((l) => l.outcome === 'error').length,
    latency_ms_total: logs.reduce((s, l) => s + l.latencyMs, 0),
    input_tokens: logs.reduce((s, l) => s + l.inputTokens, 0),
    output_tokens: logs.reduce((s, l) => s + l.outputTokens, 0),
    cost_usd: logs.reduce((s, l) => s + (l.estimatedCostUsd ?? 0), 0),
    cost_unknown_calls: logs.filter((l) => l.estimatedCostUsd === null).length,
    leaked_calls: inputs.filter((i) => LEAK.test(i)).length,
    warnings: out?.warnings ?? [],
  };
}

export interface Summary {
  fixtures: number;
  errors: number;
  scored: number;
  golden_values: number;
  golden_absent: number;
  counts: Record<FieldOutcome, number>;
  /** correct / golden values (recall). */
  accuracy: number | null;
  /** correct / values returned. */
  precision: number | null;
  /** not_found_ok / golden absent. */
  not_found_rate: number | null;
  /** invented / golden absent. THE headline number. */
  invented_rate: number | null;
  caught_by_guard: number;
  page_accuracy: number | null;
  amendments: { expected: number; found: number; extra: number };
  procedures: { expected: number; found: number; extra: number };
  calls: number;
  validation_failure_rate: number | null;
  avg_latency_ms: number | null;
  cost_usd: number;
  cost_unknown_calls: number;
  leaked_calls: number;
}

const ratio = (a: number, b: number) => (b ? a / b : null);

export function summarise(scores: readonly FixtureScore[]): Summary {
  const counts = emptyCounts();
  const add = (a: { expected: number; found: number; extra: number }, b: typeof a) => {
    a.expected += b.expected;
    a.found += b.found;
    a.extra += b.extra;
  };
  const amendments = { expected: 0, found: 0, extra: 0 };
  const procedures = { expected: 0, found: 0, extra: 0 };
  let caught = 0, pageOk = 0, calls = 0, vf = 0, latency = 0, cost = 0, costUnknown = 0, leaked = 0;
  for (const s of scores) {
    for (const k of Object.keys(counts) as FieldOutcome[]) counts[k] += s.counts[k];
    caught += s.caught_by_guard;
    pageOk += s.page_ok;
    calls += s.calls;
    vf += s.validation_failed_calls;
    latency += s.latency_ms_total;
    cost += s.cost_usd;
    costUnknown += s.cost_unknown_calls;
    leaked += s.leaked_calls;
    add(amendments, s.amendments);
    add(procedures, s.procedures);
  }
  const golden = counts.correct + counts.wrong + counts.missed + counts.failed;
  const absent = counts.not_found_ok + counts.invented;
  const returned = counts.correct + counts.wrong + counts.invented;
  return {
    fixtures: scores.length,
    errors: scores.filter((s) => s.error).length,
    scored: golden + absent,
    golden_values: golden,
    golden_absent: absent,
    counts,
    accuracy: ratio(counts.correct, golden),
    precision: ratio(counts.correct, returned),
    not_found_rate: ratio(counts.not_found_ok, absent),
    invented_rate: ratio(counts.invented, absent),
    caught_by_guard: caught,
    page_accuracy: ratio(pageOk, counts.correct),
    amendments,
    procedures,
    calls,
    validation_failure_rate: ratio(vf, calls),
    avg_latency_ms: calls ? Math.round(latency / calls) : null,
    cost_usd: Math.round(cost * 1e6) / 1e6,
    cost_unknown_calls: costUnknown,
    leaked_calls: leaked,
  };
}
