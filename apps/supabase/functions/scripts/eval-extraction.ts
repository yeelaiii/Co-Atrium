// Provider comparison harness: runs the extraction pipeline on every fixture in
// tests/fixtures/contracts/ for each --model and scores it against the golden answers.
// Writes reports/extraction-eval-<date>.md and .csv (under apps/supabase/functions).
//
//   cd apps/supabase/functions
//   deno task eval --model oracle:reference                       # offline, no keys (scripted)
//   deno task eval --model anthropic:claude-haiku-5-5 --model openai:gpt-6.1-terra   # live calls
//   LLM_MODE=record deno task eval --model anthropic:claude-haiku-5-5                # live + save
//   LLM_MODE=replay deno task eval --model anthropic:claude-haiku-5-5                # from recordings
//
// Options
//   --model <provider>:<model>   repeatable. The provider must exist in ai-config.ts `providers`
//                                and be in an allowed region; the model is any model ID it serves.
//   --fixture <name>             repeatable; default all.
//   --mode live|record|replay    default $LLM_MODE, else live. record = live + save responses to
//                                tests/fixtures/llm-recordings/<run>/; replay = no network.
//   --keep-escalation            keep ai-config's escalation target and fallback (default off).
//   --ocr                        turn OCR on for this run. Live OCR needs its region allowed:
//   --allow-region <R>           repeatable; allows a region for this run only (e.g. CN for the
//                                PaddleOCR API). This is a data-residency decision: the fixtures
//                                are synthetic, real contracts are not.
//   --update-baseline            write tests/fixtures/eval-baselines/<run>.json from this run
//                                (the golden test fails when a later run differs).
//   --out <dir>                  report directory (default reports).
//
// Keys come from the environment (ANTHROPIC_API_KEY, ...). Export them first, or run deno
// directly with an env file: deno run --env-file=.env -A scripts/eval-extraction.ts --model ...
// The overrides live in memory for the run only; ai-config.ts is never written.

import { aiConfig } from '../_shared/llm/ai-config.ts';
import { type ModelRef, type Region, REGIONS } from '../_shared/llm/config-schema.ts';
import { PROMPT_VERSIONS } from '../_shared/prompts/index.ts';
import { fileStore, labelDir } from '../eval/cassette.ts';
import { listFixtures, loadFixture } from '../eval/fixtures.ts';
import { baselineOf, csvReport, markdownReport, type ModelResult } from '../eval/report.ts';
import { isOracle, type Mode, runConfig, runFixture, runLabel, type RunOptions } from '../eval/run.ts';
import { summarise } from '../eval/score.ts';

export const BASELINES_DIR = new URL('../tests/fixtures/eval-baselines/', import.meta.url);

function usage(msg: string): never {
  console.error(
    `${msg}\nUsage: deno task eval --model <provider>:<model> [--model ...] [--fixture <name>] ` +
      '[--mode live|record|replay] [--keep-escalation] [--ocr] [--allow-region <R>] [--update-baseline] [--out <dir>]',
  );
  Deno.exit(2);
}

const args = [...Deno.args];
const models: ModelRef[] = [];
const fixtures: string[] = [];
const allowRegions: Region[] = [];
let mode = (Deno.env.get('LLM_MODE') ?? 'live') as Mode;
let keepEscalation = false;
let ocr = false;
let updateBaseline = false;
let outDir = 'reports';
while (args.length) {
  const a = args.shift()!;
  const val = () => args.shift() ?? usage(`${a} needs a value`);
  if (a === '--model') {
    const v = val();
    const i = v.indexOf(':');
    if (i < 1 || i === v.length - 1) usage(`--model must be provider:model, got "${v}"`);
    models.push({ provider: v.slice(0, i), model: v.slice(i + 1) });
  } else if (a === '--fixture') fixtures.push(val());
  else if (a === '--mode') mode = val() as Mode;
  else if (a === '--keep-escalation') keepEscalation = true;
  else if (a === '--ocr') ocr = true;
  else if (a === '--allow-region') {
    const r = val().toUpperCase() as Region;
    if (!REGIONS.includes(r)) usage(`Unknown region ${r} (one of ${REGIONS.join(', ')})`);
    allowRegions.push(r);
  } else if (a === '--update-baseline') updateBaseline = true;
  else if (a === '--out') outDir = val();
  else usage(`Unknown option ${a}`);
}
if (!models.length) usage('Give at least one --model');
if (!['live', 'record', 'replay'].includes(mode)) usage(`--mode must be live, record or replay`);

const names = fixtures.length ? fixtures : await listFixtures();
const loaded = await Promise.all(names.map(loadFixture));
const store = fileStore();
const results: ModelResult[] = [];
let allowed: string[] = aiConfig.allowed_provider_regions;

for (const model of models) {
  const o: RunOptions = { model, mode, keepEscalation, ocr, allowRegions };
  const label = runLabel(o);
  try {
    allowed = runConfig(aiConfig, o).allowed_provider_regions; // validates (residency) before any call
  } catch (e) {
    console.error(`${label}: ${e instanceof Error ? e.message : e}`);
    Deno.exit(2);
  }
  const shownMode = isOracle(model) ? 'scripted' : mode;
  console.log(`\n${label} (${shownMode})`);
  const scores = [];
  for (const fx of loaded) {
    const { score } = await runFixture(fx, o, { base: aiConfig, store, secret: (n) => Deno.env.get(n) });
    const c = score.counts;
    console.log(
      `  ${fx.name.padEnd(22)} correct ${c.correct}, wrong ${c.wrong}, missed ${c.missed + c.failed}, ` +
        `invented ${c.invented}, caught ${score.caught_by_guard}${score.error ? `  ERROR: ${score.error}` : ''}`,
    );
    scores.push(score);
  }
  results.push({ label, mode: shownMode, oracle: isOracle(model), fixtures: scores, summary: summarise(scores) });
  if (updateBaseline) {
    await Deno.mkdir(BASELINES_DIR, { recursive: true });
    const file = new URL(`${labelDir(label)}.json`, BASELINES_DIR);
    const pinned = {
      label,
      mode: isOracle(model) ? 'scripted' : 'replay',
      options: { model, keepEscalation, ocr, allowRegions },
      fixtures: baselineOf(scores),
    };
    await Deno.writeTextFile(file, JSON.stringify(pinned, null, 2) + '\n');
    console.log(`  baseline written: ${file.pathname}`);
  }
}

const date = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10); // SGT
await Deno.mkdir(outDir, { recursive: true });
const base = `${outDir}/extraction-eval-${date}`;
await Deno.writeTextFile(
  `${base}.md`,
  markdownReport(results, {
    date,
    allowedRegions: allowed,
    escalation: keepEscalation,
    ocr,
    promptVersions: PROMPT_VERSIONS,
  }),
);
await Deno.writeTextFile(`${base}.csv`, csvReport(results));
console.log(`\nReport: ${base}.md, ${base}.csv`);
for (const r of results) {
  const s = r.summary;
  console.log(
    `  ${r.label}: invented ${s.counts.invented}/${s.golden_absent}, accuracy ${s.counts.correct}/${s.golden_values}, ` +
      `leaks ${s.leaked_calls}, errors ${s.errors}`,
  );
}
