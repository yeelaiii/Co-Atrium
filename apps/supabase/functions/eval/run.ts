// Runs the real extraction pipeline (server/extraction.ts) on a fixture with in-memory I/O and
// scores the result. Each run uses a config derived from ai-config.ts for that run only (the
// committed config file is never changed), validated by the same schema, so the residency
// policy still applies to every provider the run would call.

import { type AiConfig, type ModelRef, parseAiConfig, type Region, TASKS } from '../_shared/llm/config-schema.ts';
import type { LlmProvider } from '../_shared/llm/provider.ts';
import { adapterFor, type CallLog, createRouter } from '../_shared/llm/router.ts';
import { paddleOcrProvider } from '../_shared/ocr/paddleocr.ts';
import type { OcrProvider } from '../_shared/ocr/provider.ts';
import { type Job, type RuleRow, runJob } from '../_shared/server/extraction.ts';
import { ruleFileSchema, TODO, todoAttributes } from '../_shared/contracts/ruleSchema.ts';
import { MemoryIO } from '../tests/helpers/extraction-fakes.ts';
import {
  type CassetteStore,
  Clock,
  emptyCassette,
  recordingOcr,
  recordingProvider,
  replayOcr,
  replayProvider,
} from './cassette.ts';
import { type Fixture, fixtureBytes } from './fixtures.ts';
import { ORACLE_PROVIDER, oracleOcr, oracleProvider } from './oracle.ts';
import { type FixtureScore, scoreFixture } from './score.ts';

export type Mode = 'live' | 'record' | 'replay';

export interface RunOptions {
  /** Every task runs on this provider/model. `oracle:reference` = the scripted offline reference. */
  model: ModelRef;
  mode: Mode;
  /** Keep ai-config's escalation and fallback (default off, so each score is the model's own). */
  keepEscalation?: boolean;
  /** Turn OCR on for this run (its region must be allowed, see allowRegions). */
  ocr?: boolean;
  /** Extra regions allowed for this run only (e.g. CN to try the PaddleOCR API). */
  allowRegions?: Region[];
}

export const isOracle = (m: ModelRef) => m.provider === ORACLE_PROVIDER;

export function runLabel(o: RunOptions): string {
  return `${o.model.provider}:${o.model.model}${o.keepEscalation ? '+escalation' : ''}${o.ocr ? '+ocr' : ''}`;
}

/** The run's config: ai-config with every task on `model`, re-validated. Throws if not allowed. */
export function runConfig(base: AiConfig, o: RunOptions): AiConfig {
  // deno-lint-ignore no-explicit-any
  const c: any = structuredClone(base);
  if (isOracle(o.model)) {
    // Offline only: nothing is sent anywhere. Labelled SG so it passes any residency policy.
    c.providers[ORACLE_PROVIDER] = {
      adapter: 'openai_compatible',
      base_url: 'https://oracle.invalid',
      secret_name: 'ORACLE_UNUSED',
      region: 'SG',
    };
    if (!c.allowed_provider_regions.includes('SG')) c.allowed_provider_regions.push('SG');
  }
  for (const t of TASKS) c.tasks[t] = { ...c.tasks[t], provider: o.model.provider, model: o.model.model };
  if (!o.keepEscalation) {
    c.escalation.enabled = false;
    c.fallback = null;
  }
  c.ocr.enabled = !!o.ocr;
  for (const r of o.allowRegions ?? []) if (!c.allowed_provider_regions.includes(r)) c.allowed_provider_regions.push(r);
  return parseAiConfig(c);
}

const SEED_RULES = new URL('../../seed/rules/', import.meta.url);

/** The rules a project on `form` starts with (as private.initialise_project_rules copies them). */
export async function libraryRules(form: string): Promise<RuleRow[]> {
  const best = new Map<string, { version: number[]; row: RuleRow }>();
  for await (const e of Deno.readDir(SEED_RULES)) {
    if (!e.name.endsWith('.json')) continue;
    const file = ruleFileSchema.parse(JSON.parse(await Deno.readTextFile(new URL(e.name, SEED_RULES))));
    const version = file.library_version.split('.').map(Number);
    for (const r of file.rules) {
      if (!(r.applies_to_contract_forms as readonly string[]).includes(form)) continue;
      const prev = best.get(r.rule_key);
      if (prev && (prev.version[0] > version[0] || (prev.version[0] === version[0] && prev.version[1] >= version[1]))) {
        continue;
      }
      const v = <T>(x: T | typeof TODO) => (x === TODO ? null : x);
      best.set(r.rule_key, {
        version,
        row: {
          ...r,
          period: v(r.period),
          unit: v(r.unit),
          includes_public_holidays: v(r.includes_public_holidays),
          is_time_bar: v(r.is_time_bar),
          source_clause: v(r.clause_ref),
          todo_verify: todoAttributes(r),
          status: 'draft',
        },
      });
    }
  }
  return [...best.values()].map((b) => b.row).sort((a, b) => a.rule_key.localeCompare(b.rule_key));
}

export interface RunDeps {
  base: AiConfig;
  store: CassetteStore;
  secret: (name: string) => string | undefined;
  fetch?: typeof fetch;
  /** Test hook: stands in for the live adapter in live / record mode. */
  liveProvider?: (id: string) => LlmProvider;
}

export interface FixtureRun {
  score: FixtureScore;
  logs: CallLog[];
  /** Every input sent to a model (for the never-send checks). */
  inputs: { provider: string; schema: string; input: string }[];
}

const P = '00000000-0000-4000-8000-0000000000e0';
const D = '00000000-0000-4000-8000-0000000000d0';

export async function runFixture(fx: Fixture, o: RunOptions, deps: RunDeps): Promise<FixtureRun> {
  const config = runConfig(deps.base, o);
  const label = runLabel(o);
  const oracle = isOracle(o.model);
  const clock = new Clock(oracle || o.mode === 'replay');
  const logs: CallLog[] = [];
  const inputs: FixtureRun['inputs'] = [];

  let cassette = emptyCassette(label, fx.name);
  if (!oracle && o.mode === 'replay') {
    const c = await deps.store.load(label, fx.name);
    if (!c) {
      const score = scoreFixture(fx, null, [], [], `No recordings for ${label} / ${fx.name}. Record them first.`);
      return { score, logs, inputs };
    }
    cassette = c;
  }

  const spy = (p: LlmProvider): LlmProvider => ({
    id: p.id,
    generateStructured(req) {
      inputs.push({ provider: p.id, schema: req.schemaName, input: req.input });
      return p.generateStructured(req);
    },
  });
  const makeProvider = (id: string): LlmProvider => {
    if (id === ORACLE_PROVIDER) return spy(oracleProvider(fx, { ocr: !!o.ocr }));
    if (o.mode === 'replay') return spy(replayProvider(id, cassette, clock));
    const live = deps.liveProvider?.(id) ?? adapterFor(id, config.providers[id], deps.secret, deps.fetch);
    return spy(o.mode === 'record' ? recordingProvider(live, cassette) : live);
  };

  let ocr: OcrProvider | null = null;
  if (o.ocr) {
    if (oracle) ocr = oracleOcr(fx);
    else if (o.mode === 'replay') ocr = replayOcr(config.ocr.provider, cassette);
    else {
      const token = deps.secret(config.ocr.secret_name);
      if (!token) throw new Error(`Secret ${config.ocr.secret_name} is not set (needed for --ocr)`);
      const live = paddleOcrProvider(config.ocr, token, deps.fetch);
      ocr = o.mode === 'record' ? recordingOcr(live, cassette) : live;
    }
  }

  const offline = oracle || o.mode === 'replay';
  const sleep = offline ? () => Promise.resolve() : (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const router = createRouter({
    config,
    secret: deps.secret,
    log: (l) => void logs.push(l),
    sleep,
    now: clock.now,
    makeProvider,
  });

  const io = new MemoryIO();
  io.addDocument(
    {
      id: D,
      project_id: P,
      storage_path: `${P}/${fx.expected.document}`,
      mime: fx.expected.mime,
      filename: fx.expected.document,
    },
    await fixtureBytes(fx),
  );
  io.rules = await libraryRules(fx.form);
  const job: Job = { document_id: D, project_id: P, step: 'text', cursor: {}, attempts: 0 };

  let error: string | null = null;
  try {
    for (let i = 0;; i++) {
      if (i > 200) throw new Error('The pipeline did not finish after 200 invocations');
      const out = await runJob(job, { io, router, config, ocr, sleep, deadline: Date.now() + 10 * 60_000 });
      if (out.state === 'done') break;
      if (out.state === 'wait') {
        if (out.quota) throw new Error('OCR daily quota reached');
        if (!offline) await sleep(Math.max(0, out.runAfter.getTime() - Date.now()));
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (o.mode === 'record' && !oracle) await deps.store.save(cassette);
  const score = scoreFixture(fx, io.results, logs, inputs.map((i) => i.input), error);
  return { score, logs, inputs };
}
