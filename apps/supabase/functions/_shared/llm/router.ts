// Routes each extraction task to the provider/model named in ai-config.ts.
//
//   * retries retryable failures (5xx, overloaded, timeout, 429) with exponential backoff,
//     up to retry.max_attempts per provider, then moves to the fallback provider;
//   * a schema-validation failure is retried once with the validation error in the prompt,
//     then thrown (the pipeline decides whether to escalate or mark the fields failed);
//   * escalate() runs a request on escalation.target (the pipeline sends only the fields and
//     pages that need it);
//   * every provider (task, fallback, escalation target) is checked against
//     allowed_provider_regions before any data is sent: if none is allowed, ResidencyError;
//   * every attempt, successful or not, is passed to `log` (-> extraction_calls).

import type { AiConfig, ModelRef, ProviderEntry, TaskName } from './config-schema.ts';
import { estimateCostUsd } from './config-schema.ts';
import { anthropicAdapter } from './adapters/anthropic.ts';
import { openaiAdapter } from './adapters/openai.ts';
import { openaiCompatibleAdapter } from './adapters/openai-compatible.ts';
import { type Effort, LlmError, type LlmProvider, ResidencyError, type Usage } from './provider.ts';
import type { z } from 'zod';

export type CallOutcome = 'ok' | 'fallback' | 'escalated' | 'validation_failed' | 'error';

export interface CallLog {
  task: TaskName;
  provider: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number | null;
  latencyMs: number;
  outcome: CallOutcome;
  error?: string;
}

export interface RouterDeps {
  config: AiConfig;
  /** Reads a secret (Deno.env.get in functions). */
  secret: (name: string) => string | undefined;
  log: (entry: CallLog) => void | Promise<void>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test hook: build providers directly. */
  makeProvider?: (id: string) => LlmProvider;
}

export interface TaskRequest<T> {
  system: string;
  input: string;
  schema: z.ZodType<T>;
  jsonSchema?: Record<string, unknown>;
  schemaName: string;
  promptVersion: string;
}

export interface TaskResult<T> {
  data: T;
  provider: string;
  model: string;
  usage: Usage;
}

const VALIDATION_RETRY_NOTE = (err: string) =>
  `\n\n---\nYour previous answer to this request was rejected: ${err}\n` +
  'Answer again. Follow the JSON schema exactly and use null where a value is not stated.';

/** The adapter for a provider entry, with its API key from `secret`. Throws a fatal LlmError if the key is missing. */
export function adapterFor(
  id: string,
  entry: ProviderEntry,
  secret: (name: string) => string | undefined,
  f?: typeof fetch,
): LlmProvider {
  const apiKey = secret(entry.secret_name);
  if (!apiKey) throw new LlmError('fatal', `Secret ${entry.secret_name} is not set`, id);
  const adapterDeps = { apiKey, fetch: f };
  return entry.adapter === 'anthropic'
    ? anthropicAdapter(id, entry, adapterDeps)
    : entry.adapter === 'openai'
    ? openaiAdapter(id, entry, adapterDeps)
    : openaiCompatibleAdapter(id, entry, adapterDeps);
}

export function createRouter(deps: RouterDeps) {
  const { config } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const allowed = new Set(config.allowed_provider_regions);
  const cache = new Map<string, LlmProvider>();

  function isAllowed(ref: ModelRef): boolean {
    const p = config.providers[ref.provider];
    return !!p && allowed.has(p.region);
  }

  function provider(id: string): LlmProvider {
    const hit = cache.get(id);
    if (hit) return hit;
    const entry = config.providers[id];
    if (!entry) throw new LlmError('fatal', `Unknown provider '${id}'`, id);
    if (!allowed.has(entry.region)) {
      throw new ResidencyError(`Provider '${id}' (${entry.region}) is not in allowed_provider_regions`);
    }
    let p: LlmProvider;
    if (deps.makeProvider) {
      p = deps.makeProvider(id);
    } else {
      p = adapterFor(id, entry, deps.secret, deps.fetch);
    }
    cache.set(id, p);
    return p;
  }

  async function logCall(
    task: TaskName,
    ref: ModelRef,
    req: TaskRequest<unknown>,
    started: number,
    outcome: CallOutcome,
    usage?: Usage,
    error?: string,
  ) {
    const u = usage ?? { inputTokens: 0, outputTokens: 0 };
    await deps.log({
      task,
      provider: ref.provider,
      model: ref.model,
      promptVersion: req.promptVersion,
      inputTokens: Math.round(u.inputTokens),
      outputTokens: Math.round(u.outputTokens),
      estimatedCostUsd: estimateCostUsd(config, ref.model, u.inputTokens, u.outputTokens),
      latencyMs: Math.max(0, now() - started),
      outcome,
      ...(error ? { error: error.slice(0, 500) } : {}),
    });
  }

  /**
   * Runs one request on one provider: retries retryable errors with backoff and a validation
   * failure once (with the error in the prompt). Throws the last LlmError.
   */
  async function runOn<T>(
    task: TaskName,
    ref: ModelRef,
    req: TaskRequest<T>,
    opts: { maxOutputTokens: number; effort?: Effort; outcome: CallOutcome },
  ): Promise<TaskResult<T>> {
    const p = provider(ref.provider);
    let input = req.input;
    let validationRetried = false;
    for (let attempt = 1;; attempt++) {
      const started = now();
      try {
        const res = await p.generateStructured({
          model: ref.model,
          system: req.system,
          input,
          schema: req.schema,
          jsonSchema: req.jsonSchema,
          schemaName: req.schemaName,
          maxOutputTokens: opts.maxOutputTokens,
          temperature: 0,
          effort: opts.effort,
        });
        await logCall(task, ref, req, started, opts.outcome, res.usage);
        return { data: res.data, provider: ref.provider, model: ref.model, usage: res.usage };
      } catch (e) {
        const err = e instanceof LlmError
          ? e
          : new LlmError('fatal', e instanceof Error ? e.message : String(e), ref.provider);
        await logCall(
          task,
          ref,
          req,
          started,
          err.kind === 'validation' ? 'validation_failed' : 'error',
          err.usage,
          `${err.kind}: ${err.message}`,
        );
        if (err.kind === 'validation' && !validationRetried) {
          validationRetried = true;
          input = req.input + VALIDATION_RETRY_NOTE(err.message);
          continue;
        }
        if (err.retryable && attempt < config.retry.max_attempts) {
          await sleep(config.retry.base_delay_ms * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }
    }
  }

  return {
    /** Runs a task on its configured provider, falling back on 5xx / timeout / rate limit. */
    async run<T>(task: TaskName, req: TaskRequest<T>): Promise<TaskResult<T>> {
      const t = config.tasks[task];
      const candidates: { ref: ModelRef; outcome: CallOutcome }[] = [{ ref: t, outcome: 'ok' }];
      if (config.fallback) candidates.push({ ref: config.fallback, outcome: 'fallback' });
      const usable = candidates.filter((c) => isAllowed(c.ref));
      if (usable.length === 0) {
        throw new ResidencyError(
          `No provider for '${task}' is in an allowed region (${config.allowed_provider_regions.join(', ')})`,
        );
      }
      let last: unknown;
      for (const c of usable) {
        try {
          return await runOn(task, c.ref, req, {
            maxOutputTokens: t.max_output_tokens,
            effort: t.effort,
            outcome: c.outcome,
          });
        } catch (e) {
          last = e;
          // Only availability problems move on to the fallback provider.
          if (!(e instanceof LlmError) || !e.retryable) throw e;
        }
      }
      throw last;
    },

    /** Re-runs a (narrowed) request on the escalation target. */
    async escalate<T>(task: TaskName, req: TaskRequest<T>): Promise<TaskResult<T>> {
      const esc = config.escalation;
      if (!esc.enabled) throw new LlmError('fatal', 'Escalation is disabled', esc.target.provider);
      if (!isAllowed(esc.target)) {
        throw new ResidencyError(`Escalation target '${esc.target.provider}' is not in an allowed region`);
      }
      return await runOn(task, esc.target, req, { maxOutputTokens: esc.max_output_tokens, outcome: 'escalated' });
    },

    get escalation() {
      return config.escalation;
    },
  };
}

export type Router = ReturnType<typeof createRouter>;
