// Recorded provider responses ("cassettes"), so evals and golden tests can run without API keys
// or network: LLM_MODE=record saves every LLM and OCR response of a live run; LLM_MODE=replay
// serves them back. A request is matched by a hash of everything that shapes the answer
// (provider, model, prompt text, page text, JSON schema, limits), so a changed prompt or fixture
// is a replay miss (re-record), never a silently stale answer.
//
// Layout: tests/fixtures/llm-recordings/<run label>/<fixture>.json

import type { GenerateRequest, GenerateResult, LlmErrorKind, LlmProvider, Usage } from '../_shared/llm/provider.ts';
import { LlmError } from '../_shared/llm/provider.ts';
import type { OcrJobStatus, OcrProvider } from '../_shared/ocr/provider.ts';

export const RECORDINGS_DIR = new URL('../tests/fixtures/llm-recordings/', import.meta.url);

export interface LlmEntry {
  provider: string;
  model: string;
  schema: string;
  latency_ms: number;
  result: { data: unknown; usage: Usage } | null;
  error: { kind: LlmErrorKind; message: string; status?: number; usage?: Usage } | null;
}

export interface Cassette {
  version: 1;
  label: string;
  fixture: string;
  recorded_at: string;
  llm: Record<string, LlmEntry>;
  ocr: Record<string, { text: string; confidence: number | null }>;
}

export interface CassetteStore {
  load(label: string, fixture: string): Promise<Cassette | null>;
  save(c: Cassette): Promise<void>;
}

/** Run label -> safe directory name ("anthropic:claude-haiku-5-5" -> "anthropic__claude-haiku-5-5"). */
export function labelDir(label: string): string {
  return label.replace(/:/g, '__').replace(/[^A-Za-z0-9._+-]/g, '_');
}

export function fileStore(root: URL = RECORDINGS_DIR): CassetteStore {
  const url = (label: string, fixture: string) => new URL(`${labelDir(label)}/${fixture}.json`, root);
  return {
    async load(label, fixture) {
      try {
        return JSON.parse(await Deno.readTextFile(url(label, fixture))) as Cassette;
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return null;
        throw e;
      }
    },
    async save(c) {
      const u = url(c.label, c.fixture);
      await Deno.mkdir(new URL('./', u), { recursive: true });
      // Stable key order keeps diffs readable.
      const llm = Object.fromEntries(Object.entries(c.llm).sort(([a], [b]) => a.localeCompare(b)));
      const ocr = Object.fromEntries(Object.entries(c.ocr).sort(([a], [b]) => a.localeCompare(b)));
      await Deno.writeTextFile(u, JSON.stringify({ ...c, llm, ocr }, null, 2) + '\n');
    },
  };
}

export function memoryStore(): CassetteStore & { data: Map<string, Cassette> } {
  const data = new Map<string, Cassette>();
  return {
    data,
    load: (label, fixture) => Promise.resolve(structuredClone(data.get(`${label}/${fixture}`) ?? null)),
    save: (c) => {
      data.set(`${c.label}/${c.fixture}`, structuredClone(c));
      return Promise.resolve();
    },
  };
}

export function emptyCassette(label: string, fixture: string): Cassette {
  return { version: 1, label, fixture, recorded_at: new Date().toISOString(), llm: {}, ocr: {} };
}

async function sha256(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function requestKey(provider: string, req: GenerateRequest<unknown>): Promise<string> {
  return sha256(JSON.stringify({
    provider,
    model: req.model,
    schemaName: req.schemaName,
    system: req.system,
    input: req.input,
    jsonSchema: req.jsonSchema ?? null,
    maxOutputTokens: req.maxOutputTokens,
    effort: req.effort ?? null,
  }));
}

/** A clock the router reads latency from; replay advances it by the recorded latency. */
export class Clock {
  private virtual: number | null;
  constructor(virtualTime: boolean) {
    this.virtual = virtualTime ? 0 : null;
  }
  now = (): number => this.virtual ?? Date.now();
  advance(ms: number) {
    if (this.virtual !== null) this.virtual += ms;
  }
}

/** Wraps a live provider and records every response (and error) into the cassette. */
export function recordingProvider(inner: LlmProvider, cassette: Cassette): LlmProvider {
  return {
    id: inner.id,
    async generateStructured<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
      const key = await requestKey(inner.id, req as GenerateRequest<unknown>);
      const started = performance.now();
      const base = { provider: inner.id, model: req.model, schema: req.schemaName };
      try {
        const res = await inner.generateStructured(req);
        cassette.llm[key] = {
          ...base,
          latency_ms: Math.round(performance.now() - started),
          result: { data: res.data, usage: res.usage },
          error: null,
        };
        return res;
      } catch (e) {
        if (e instanceof LlmError) {
          cassette.llm[key] = {
            ...base,
            latency_ms: Math.round(performance.now() - started),
            result: null,
            error: { kind: e.kind, message: e.message, status: e.status, usage: e.usage },
          };
        }
        throw e;
      }
    },
  };
}

/** Serves recorded responses. A request that wasn't recorded is a fatal error (re-record). */
export function replayProvider(id: string, cassette: Cassette, clock: Clock): LlmProvider {
  return {
    id,
    async generateStructured<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
      const key = await requestKey(id, req as GenerateRequest<unknown>);
      const hit = cassette.llm[key];
      if (!hit) {
        throw new LlmError(
          'fatal',
          `No recording for this ${req.schemaName} request on ${id}:${req.model} in ${cassette.label}/${cassette.fixture} ` +
            '(prompt, fixture or config changed?). Re-record with LLM_MODE=record.',
          id,
        );
      }
      clock.advance(hit.latency_ms);
      if (hit.error) {
        throw new LlmError(hit.error.kind, hit.error.message, id, hit.error.status, hit.error.usage);
      }
      const parsed = req.schema.safeParse(hit.result!.data);
      if (!parsed.success) throw new LlmError('validation', parsed.error.message, id, undefined, hit.result!.usage);
      return { data: parsed.data, usage: hit.result!.usage, raw: hit.result!.data };
    },
  };
}

/**
 * OCR jobs keyed by the page file name ("page-4.pdf"; the upload's name for an image). A
 * cassette belongs to one fixture, so that is unique; the bytes aren't hashed because pdf-lib
 * stamps a creation date into every single-page PDF.
 */
export function recordingOcr(inner: OcrProvider, cassette: Cassette): OcrProvider {
  const keys = new Map<string, string>();
  return {
    id: inner.id,
    async submit(file) {
      const job = await inner.submit(file);
      keys.set(job, file.filename);
      return job;
    },
    async poll(jobId) {
      const res = await inner.poll(jobId);
      const key = keys.get(jobId);
      if (res.state === 'done' && key) cassette.ocr[key] = { text: res.text ?? '', confidence: res.confidence ?? null };
      return res;
    },
  };
}

export function replayOcr(id: string, cassette: Cassette): OcrProvider {
  return {
    id,
    submit(file) {
      return Promise.resolve(file.filename);
    },
    poll(key): Promise<OcrJobStatus> {
      const hit = cassette.ocr[key];
      return Promise.resolve(
        hit
          ? { state: 'done', text: hit.text, confidence: hit.confidence }
          : { state: 'failed', error: 'No OCR recording for this page (re-record with LLM_MODE=record)' },
      );
    },
  };
}
