// Markdown and CSV reports for an eval run. Pure (returns strings).

import { FIELD_BY_KEY } from '../_shared/contracts/contractFieldSchema.ts';
import type { FixtureScore, Summary } from './score.ts';

export interface ModelResult {
  label: string;
  mode: string;
  oracle: boolean;
  fixtures: FixtureScore[];
  summary: Summary;
}

export interface ReportMeta {
  date: string;
  allowedRegions: string[];
  escalation: boolean;
  ocr: boolean;
  promptVersions: Record<string, string>;
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const cost = (s: Summary) =>
  s.cost_unknown_calls === s.calls && s.calls > 0
    ? 'unknown'
    : `$${s.cost_usd.toFixed(4)}${s.cost_unknown_calls ? ` (+${s.cost_unknown_calls} unpriced calls)` : ''}`;
const ms = (x: number | null) => (x === null ? 'n/a' : `${x} ms`);
const show = (v: unknown) => (v === null || v === undefined ? '—' : JSON.stringify(v));
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function markdownReport(results: readonly ModelResult[], meta: ReportMeta): string {
  const L: string[] = [];
  L.push(`# Extraction eval, ${meta.date}`, '');
  L.push(
    'Synthetic fixtures (`tests/fixtures/contracts/`, fictional parties). Each run puts every extraction task on one ' +
      'provider/model for the run only; `ai-config.ts` is not changed.',
  );
  L.push(
    `Escalation and fallback: ${meta.escalation ? 'as in ai-config' : "off (each score is the model's own)"}. ` +
      `OCR: ${meta.ocr ? 'on' : 'off'}. Allowed regions: ${meta.allowedRegions.join(', ')}. ` +
      `Prompts: ${Object.entries(meta.promptVersions).map(([t, v]) => `${t}.${v}`).join(', ')}.`,
  );
  if (results.some((r) => r.oracle)) {
    L.push(
      '',
      '> `oracle:reference` is a scripted stand-in that answers from the golden files with deliberate mistakes. ' +
        'It is not a model; its row only shows that the harness and the guards work.',
    );
  }
  L.push('', '## Summary', '');
  L.push(
    '| Run | Mode | **Invented** | Caught by guard | Accuracy | Precision | Not found correct | Schema failures | Amendments | Procedures | Avg latency | Est. cost | Never-send leaks | Errors |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of results) {
    const s = r.summary;
    L.push(
      `| ${r.label} | ${r.mode} | **${s.counts.invented} (${pct(s.invented_rate)})** | ${s.caught_by_guard} | ` +
        `${s.counts.correct}/${s.golden_values} (${pct(s.accuracy)}) | ${pct(s.precision)} | ` +
        `${s.counts.not_found_ok}/${s.golden_absent} (${pct(s.not_found_rate)}) | ${
          pct(s.validation_failure_rate)
        } of ${s.calls} calls | ` +
        `${s.amendments.found}/${s.amendments.expected}${
          s.amendments.extra ? ` (+${s.amendments.extra} extra)` : ''
        } | ` +
        `${s.procedures.found}/${s.procedures.expected}${
          s.procedures.extra ? ` (+${s.procedures.extra} extra)` : ''
        } | ` +
        `${r.oracle ? 'n/a' : ms(s.avg_latency_ms)} | ${cost(s)} | ${s.leaked_calls} | ${s.errors} |`,
    );
  }
  L.push(
    '',
    '- **Invented**: a value returned where the document states none (golden answer: not found), after the ' +
      'excerpt guard. Lower is better; this is the number that matters most.',
    '- **Caught by guard**: values the model returned whose excerpt was not on the cited page; the pipeline ' +
      'dropped them to not found and flagged them for review.',
    '- **Accuracy**: correct values / values the document states. **Precision**: correct / values returned.',
    '- **Schema failures**: calls whose output failed validation (each is retried once with the error).',
    '- **Never-send leaks**: model calls containing general conditions, specification, BQ or drawing-list text (must be 0).',
  );

  L.push('', '## Per fixture', '');
  L.push(
    '| Run | Fixture | Correct | Wrong | Missed | Failed | Not found OK | **Invented** | Caught | Pages cited right | Amend. | Proc. | Notes |',
  );
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    for (const f of r.fixtures) {
      const c = f.counts;
      const notes = [f.error ? `ERROR: ${f.error}` : '', ...f.warnings].filter(Boolean).join(' ');
      L.push(
        `| ${r.label} | ${f.fixture} | ${c.correct} | ${c.wrong} | ${c.missed} | ${c.failed} | ${c.not_found_ok} | ` +
          `**${c.invented}** | ${f.caught_by_guard} | ${f.page_ok}/${c.correct} | ${f.amendments.found}/${f.amendments.expected} | ` +
          `${f.procedures.found}/${f.procedures.expected} | ${cell(notes)} |`,
      );
    }
  }

  const inventions = results.flatMap((r) =>
    r.fixtures.flatMap((f) => f.fields.filter((x) => x.outcome === 'invented').map((x) => ({ r, f, x })))
  );
  L.push('', '## Invented values', '');
  if (!inventions.length) L.push('None.');
  else {
    L.push('| Run | Fixture | Field | Value returned | Page | Excerpt | Confidence |', '|---|---|---|---|---|---|---|');
    for (const { r, f, x } of inventions) {
      L.push(
        `| ${r.label} | ${f.fixture} | ${x.field_key} | ${cell(show(x.got))} | ${x.got_page ?? '—'} | ${
          cell(x.source_excerpt ?? '—')
        } | ${x.confidence ?? '—'} |`,
      );
    }
  }

  const wrong = results.flatMap((r) =>
    r.fixtures.flatMap((f) => f.fields.filter((x) => x.outcome === 'wrong').map((x) => ({ r, f, x })))
  );
  L.push('', '## Wrong values', '');
  if (!wrong.length) L.push('None.');
  else {
    L.push('| Run | Fixture | Field | Expected | Returned | Page |', '|---|---|---|---|---|---|');
    for (const { r, f, x } of wrong) {
      L.push(
        `| ${r.label} | ${f.fixture} | ${x.field_key} | ${cell(show(x.expected))} | ${cell(show(x.got))} | ${
          x.got_page ?? '—'
        } |`,
      );
    }
  }

  // Field x run accuracy (fields with a golden value in at least one fixture).
  const keys = [...new Set(results.flatMap((r) => r.fixtures.flatMap((f) => f.fields.map((x) => x.field_key))))];
  L.push('', '## Per field', '', 'Correct / stated, and invented / absent, across fixtures.', '');
  L.push(`| Field | ${results.map((r) => r.label).join(' | ')} |`, `|---|${results.map(() => '---').join('|')}|`);
  for (const k of keys) {
    const cells = results.map((r) => {
      const xs = r.fixtures.flatMap((f) => f.fields.filter((x) => x.field_key === k));
      const stated = xs.filter((x) => x.expected !== null);
      const absent = xs.filter((x) => x.expected === null);
      const parts = [];
      if (stated.length) parts.push(`${stated.filter((x) => x.outcome === 'correct').length}/${stated.length}`);
      const inv = absent.filter((x) => x.outcome === 'invented').length;
      if (inv) parts.push(`**${inv} invented**`);
      return parts.join(', ') || '·';
    });
    L.push(`| ${FIELD_BY_KEY.get(k)?.label ?? k} (\`${k}\`) | ${cells.join(' | ')} |`);
  }
  L.push('');
  return L.join('\n');
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function csvReport(results: readonly ModelResult[]): string {
  const head = [
    'run',
    'mode',
    'fixture',
    'field',
    'outcome',
    'expected',
    'returned',
    'expected_page',
    'returned_page',
    'confidence',
    'not_found_reason',
    'provider',
    'model',
    'source_excerpt',
  ];
  const rows = [head.join(',')];
  for (const r of results) {
    for (const f of r.fixtures) {
      for (const x of f.fields) {
        rows.push(
          [
            r.label,
            r.mode,
            f.fixture,
            x.field_key,
            x.outcome,
            x.expected,
            x.got,
            x.expected_page,
            x.got_page,
            x.confidence,
            x.not_found_reason,
            x.provider,
            x.model,
            x.source_excerpt,
          ].map(csvCell).join(','),
        );
      }
    }
  }
  return rows.join('\n') + '\n';
}

/** The numbers a golden baseline pins (per fixture), so any change in precision or recall shows. */
export function baselineOf(fixtures: readonly FixtureScore[]) {
  return Object.fromEntries(fixtures.map((f) => [f.fixture, {
    error: f.error,
    counts: f.counts,
    caught_by_guard: f.caught_by_guard,
    page_ok: f.page_ok,
    amendments: f.amendments,
    procedures: f.procedures,
    leaked_calls: f.leaked_calls,
    outcomes: Object.fromEntries(
      f.fields.filter((x) => x.outcome !== 'not_found_ok').map((x) => [x.field_key, x.outcome]),
    ),
  }]));
}
