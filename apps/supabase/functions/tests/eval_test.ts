// Fixtures, golden-file tests and the eval harness.
//
//   * every fixture is self-consistent and its committed PDF matches pages.md;
//   * scoring: exact / keyword matching, schema defaults, invented vs not found;
//   * golden files: each baseline in tests/fixtures/eval-baselines/ is re-run (the scripted
//     reference offline; real models from their recordings, LLM_MODE=replay) and must give the
//     same per-field outcomes, so any change in precision or recall fails the test;
//   * the pipeline never sends general conditions / specs / BQ / drawings text, and the excerpt
//     guard drops a made-up citation;
//   * record -> replay round trip, recorded errors, and a replay miss when a prompt changes.

import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';

import { pdfPages } from '../_shared/extraction/text.ts';
import { aiConfig } from '../_shared/llm/ai-config.ts';
import { type GenerateRequest, LlmError, type LlmProvider } from '../_shared/llm/provider.ts';
import { fieldsOutput } from '../_shared/extraction/tasks.ts';
import {
  Clock,
  emptyCassette,
  fileStore,
  labelDir,
  memoryStore,
  recordingProvider,
  replayProvider,
} from '../eval/cassette.ts';
import { fixtureBytes, listFixtures, loadFixture, scoredFields } from '../eval/fixtures.ts';
import { oracleProvider } from '../eval/oracle.ts';
import { baselineOf } from '../eval/report.ts';
import { libraryRules, runConfig, runFixture, runLabel, type RunOptions } from '../eval/run.ts';
import { scoreFixture, summarise, valueMatches } from '../eval/score.ts';

const BASELINES = new URL('./fixtures/eval-baselines/', import.meta.url);
const ORACLE: RunOptions = { model: { provider: 'oracle', model: 'reference' }, mode: 'live' };
const noSecrets = () => undefined;

Deno.test('fixtures: valid, at least one scanned, PDFs match pages.md', async () => {
  const names = await listFixtures();
  assert(names.length >= 3 && names.length <= 5, `3-5 fixtures, got ${names.length}`);
  let scanned = 0;
  for (const n of names) {
    const fx = await loadFixture(n); // throws on an invalid golden file
    assert(fx.expected.amendments.length >= 1, `${n}: needs an amended clause`);
    assert(Object.keys(fx.expected.fields).length >= 10, `${n}: needs a known appendix`);
    assert(scoredFields(fx.expected).some((f) => f.expected === null), `${n}: needs absent fields`);
    const texts = await pdfPages(await fixtureBytes(fx));
    assertEquals(texts.length, fx.pages.length, `${n}: page count`);
    if (fx.expected.scanned) {
      scanned++;
      assert(texts.every((t) => t.replace(/\s/g, '').length < aiConfig.ocr.min_chars_per_page), `${n}: text layer`);
    } else {
      const firstLines = fx.pages.map((p) => p.split('\n')[0]);
      texts.forEach((t, i) =>
        assertStringIncludes(t, firstLines[i], `${n} page ${i + 1} (rebuild: deno task build-fixtures)`)
      );
    }
  }
  assert(scanned >= 1, 'at least one scanned fixture');
});

Deno.test('scoring: exact with schema defaults, keywords, lists as sets', async () => {
  const fx = await loadFixture('sia-lump-sum');
  const f = fx.expected.fields;
  assert(valueMatches('contract_sum', f.contract_sum, { amount: 4860000 })); // currency defaults to SGD
  assert(!valueMatches('contract_sum', f.contract_sum, { amount: 4860000, currency: 'USD' }));
  assert(valueMatches('employer_name', f.employer_name, 'Pelangi Residences Pte. Ltd.'));
  assert(!valueMatches('employer_name', f.employer_name, 'Pelangi Residences'));
  assert(valueMatches('contract_administrator_name', f.contract_administrator_name, 'Daniel Ong'));
  assert(valueMatches('dispute_resolution', f.dispute_resolution, { method: 'arbitration', seat_or_rules: 'SIAC' }));
  assert(!valueMatches('dispute_resolution', f.dispute_resolution, { method: 'litigation', seat_or_rules: null }));
  const list = { value: ['B', 'A'], page: 1, excerpt: 'x', match: 'exact' as const };
  assert(valueMatches('nominated_subcontractors', list, ['a', 'b']));

  const fields = [
    { field_key: 'employer_name', value: 'Pelangi Residences Pte Ltd', page_no: 2 },
    { field_key: 'contract_sum', value: { amount: 1, currency: 'SGD' }, page_no: 2 },
    { field_key: 'ld_cap', value: { kind: 'percent', value: 10 }, page_no: 4 }, // absent in the golden file
    { field_key: 'completion_date', value: null, not_found_reason: 'extraction_failed' },
  ];
  const s = scoreFixture(fx, { fields, rules: [], findings: [], warnings: [] }, [], ['ZZ-BQ-MARKER x']);
  const outcome = (k: string) => s.fields.find((x) => x.field_key === k)!.outcome;
  assertEquals(
    ['employer_name', 'contract_sum', 'ld_cap', 'completion_date', 'advance_payment'].map(outcome),
    ['correct', 'wrong', 'invented', 'failed', 'not_found_ok'],
  );
  assert(!s.fields.some((x) => x.field_key === 'contract_title'), 'ignored fields are not scored');
  assertEquals(s.leaked_calls, 1);
  const sum = summarise([s]);
  assertEquals(sum.counts.invented, 1);
  assertEquals(sum.invented_rate, 1 / sum.golden_absent);
});

Deno.test('golden files: every pinned baseline reproduces exactly', async () => {
  const files: string[] = [];
  for await (const e of Deno.readDir(BASELINES)) if (e.name.endsWith('.json')) files.push(e.name);
  assert(files.includes('oracle__reference.json'), 'the scripted reference baseline is committed');
  const fixtures = await Promise.all((await listFixtures()).map(loadFixture));
  for (const file of files.sort()) {
    const pinned = JSON.parse(await Deno.readTextFile(new URL(file, BASELINES)));
    const { provider, model } = pinned.options.model;
    const o: RunOptions = { ...pinned.options, mode: 'replay' }; // never live in tests; the oracle ignores the mode
    assertEquals(labelDir(runLabel(o)) + '.json', file);
    const scores = [];
    for (const fx of fixtures) {
      scores.push((await runFixture(fx, o, { base: aiConfig, store: fileStore(), secret: noSecrets })).score);
    }
    const now = baselineOf(scores);
    for (const [fixture, want] of Object.entries(pinned.fixtures)) {
      assertEquals(
        now[fixture],
        want,
        `${pinned.label} / ${fixture} changed. If intended, re-pin: deno task eval --model ${provider}:${model}` +
          `${o.mode === 'replay' && provider !== 'oracle' ? ' (LLM_MODE=replay)' : ''} --update-baseline`,
      );
    }
  }
});

Deno.test('reference run: no never-send text reaches a model; the guard drops a made-up excerpt', async () => {
  const fx = await loadFixture('sia-lump-sum');
  const { score, inputs } = await runFixture(fx, ORACLE, { base: aiConfig, store: memoryStore(), secret: noSecrets });
  assertEquals(score.error, null);
  assert(inputs.length >= 4);
  for (const i of inputs) assert(!/ZZ-(GC|SPEC|BQ|DWG)-MARKER/.test(i.input), `${i.schema} got never-send text`);
  assert(inputs.some((i) => i.schema === 'page_sections'), 'the cover page (no heading) went to the classifier');
  const f = (k: string) => score.fields.find((x) => x.field_key === k)!;
  assertEquals([f('payment_response_period').got, f('payment_response_period').not_found_reason], [
    null,
    'excerpt_not_in_source',
  ]);
  assertEquals(f('contract_period').outcome, 'invented'); // real excerpt: only the score catches it
  assertEquals(score.amendments, { expected: 1, found: 1, extra: 0 });
});

Deno.test('scanned fixture: OCR off -> nothing invented, a warning; OCR needs its region allowed', async () => {
  const fx = await loadFixture('scanned-psscoc-lite');
  const off = await runFixture(fx, ORACLE, { base: aiConfig, store: memoryStore(), secret: noSecrets });
  assertEquals([off.score.counts.correct, off.score.counts.invented], [0, 0]);
  assertStringIncludes(off.score.warnings.join(' '), 'OCR is turned off');
  assertEquals(off.inputs.length, 0);

  const ocr: RunOptions = { ...ORACLE, ocr: true };
  assertRejects(() => runFixture(fx, ocr, { base: aiConfig, store: memoryStore(), secret: noSecrets }));
  const on = await runFixture(fx, { ...ocr, allowRegions: ['CN'] }, {
    base: aiConfig,
    store: memoryStore(),
    secret: noSecrets,
  });
  assertEquals(on.score.counts.invented, 0);
  assertEquals(on.score.counts.correct, Object.keys(fx.expected.fields).length);
});

Deno.test('run config: overrides every task for the run only; residency still applies', () => {
  const before = JSON.stringify(aiConfig);
  const c = runConfig(aiConfig, { model: { provider: 'qwen', model: 'some-model' }, mode: 'live' });
  assert(Object.values(c.tasks).every((t) => t.provider === 'qwen' && t.model === 'some-model'));
  assertEquals([c.escalation.enabled, c.fallback], [false, null]);
  assertEquals(JSON.stringify(aiConfig), before);
  const sgOnly = { ...structuredClone(aiConfig), allowed_provider_regions: ['SG' as const] };
  let threw = false;
  try {
    runConfig(sgOnly as typeof aiConfig, { model: { provider: 'anthropic', model: 'x' }, mode: 'live' });
  } catch (e) {
    threw = true;
    assertStringIncludes(String(e), 'allowed_provider_regions');
  }
  assert(threw, 'a US provider is refused under an SG-only policy');
});

Deno.test('library rules for a form: TODO_VERIFY becomes null + todo_verify', async () => {
  const rules = await libraryRules('SIA_2016_LUMP_SUM');
  assert(rules.some((r) => r.origin === 'statute'), 'SOP Act rules apply to every form');
  // SIA 2016 sets no period for the QS's valuation, so this rule stays TODO_VERIFY.
  const valuation = rules.find((r) => r.group_key === 'variation_valuation' && r.origin === 'standard_form_default')!;
  assertEquals(valuation.period, null);
  assert(valuation.todo_verify.includes('period'));
  const eot = rules.find((r) => r.group_key === 'eot_notice' && r.origin === 'standard_form_default')!;
  assertEquals(eot.period, 28);
  assertEquals(eot.todo_verify, []);
});

Deno.test('cassettes: record -> replay gives the same scores; a changed prompt is a replay miss', async () => {
  const fx = await loadFixture('redas-db');
  const store = memoryStore();
  const o: RunOptions = { model: { provider: 'qwen', model: 'qwen3.8-flash' }, mode: 'record' };
  const live = (id: string): LlmProvider => ({ ...oracleProvider(fx, { ocr: false }), id });
  const rec = await runFixture(fx, o, { base: aiConfig, store, secret: noSecrets, liveProvider: live });
  assertEquals(rec.score.error, null);
  assertEquals(store.data.size, 1);

  const rep = await runFixture(fx, { ...o, mode: 'replay' }, {
    base: aiConfig,
    store,
    secret: noSecrets,
    liveProvider: () => {
      throw new Error('replay must not call a live provider');
    },
  });
  assertEquals(baselineOf([rep.score]), baselineOf([rec.score]));

  // Edit every recorded request away: the replay fails loudly instead of answering stale.
  const c = store.data.get(`${runLabel(o)}/${fx.name}`)!;
  c.llm = Object.fromEntries(Object.entries(c.llm).map(([k, v]) => [`x${k}`, v]));
  const miss = await runFixture(fx, { ...o, mode: 'replay' }, { base: aiConfig, store, secret: noSecrets });
  assertStringIncludes(miss.score.error ?? '', 'No recording');
});

Deno.test('cassettes: errors are recorded and replayed; latency comes from the recording', async () => {
  const cassette = emptyCassette('t', 'f');
  const req: GenerateRequest<unknown> = {
    model: 'm',
    system: 's',
    input: '[Page 1]\nx',
    schema: fieldsOutput,
    schemaName: 'contract_fields',
    maxOutputTokens: 100,
  };
  const failing: LlmProvider = {
    id: 'p',
    generateStructured: () =>
      Promise.reject(new LlmError('validation', 'bad shape', 'p', undefined, { inputTokens: 5, outputTokens: 2 })),
  };
  await assertRejects(() => recordingProvider(failing, cassette).generateStructured(req));
  const entry = Object.values(cassette.llm)[0];
  entry.latency_ms = 1234;
  const clock = new Clock(true);
  const err = await replayProvider('p', cassette, clock).generateStructured(req).catch((e) => e);
  assert(err instanceof LlmError && err.kind === 'validation' && err.usage?.inputTokens === 5);
  assertEquals(clock.now(), 1234);
  const other = await replayProvider('p', cassette, clock).generateStructured({ ...req, system: 's2' }).catch((e) => e);
  assert(other instanceof LlmError && other.kind === 'fatal');
});
