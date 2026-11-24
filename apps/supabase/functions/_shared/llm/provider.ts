// The provider-neutral LLM interface. Adapters (adapters/*.ts) implement it; the router
// (router.ts) picks one per task from ai-config.ts. Nothing outside ai-config.ts names a
// provider, model, base URL or price.

import type { z } from 'zod';

import { safeParseLenient } from './json-schema.ts';

export type Effort = 'low' | 'medium' | 'high';

export interface GenerateRequest<T> {
  model: string;
  system: string;
  /** Page text with page markers. */
  input: string;
  /** Validates the output (always, whatever the provider). */
  schema: z.ZodType<T>;
  /** JSON Schema sent to the provider. Defaults to the strict form of `schema` (json-schema.ts). */
  jsonSchema?: Record<string, unknown>;
  /** Short identifier for the schema (some APIs require a name). */
  schemaName: string;
  maxOutputTokens: number;
  /** Default 0. Ignored by providers whose entry says supports_temperature: false. */
  temperature?: number;
  /** Reasoning effort, for providers that support it. */
  effort?: Effort;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateResult<T> {
  data: T;
  usage: Usage;
  raw: unknown;
}

export interface LlmProvider {
  /** The provider key in aiConfig.providers (e.g. "anthropic", "qwen"). */
  id: string;
  generateStructured<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>>;
}

/**
 * retryable: 5xx / overloaded / network (retry, then fall back)
 * rate_limit: 429 (retry with backoff, then fall back)
 * timeout: request timed out (retry, then fall back)
 * validation: the output didn't match the schema (retry once with the error, then escalate)
 * refusal: the model declined (no retry on the same provider)
 * fatal: bad request, auth, missing key (no retry, no fallback)
 */
export type LlmErrorKind = 'retryable' | 'rate_limit' | 'timeout' | 'validation' | 'refusal' | 'fatal';

export class LlmError extends Error {
  constructor(
    public kind: LlmErrorKind,
    message: string,
    public provider: string,
    public status?: number,
    /** Usage already spent when the error happened (e.g. a response that failed validation). */
    public usage?: Usage,
    public raw?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
  }

  get retryable(): boolean {
    return this.kind === 'retryable' || this.kind === 'rate_limit' || this.kind === 'timeout';
  }
}

/** Thrown when the only providers left would send data to a region the config doesn't allow. */
export class ResidencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResidencyError';
  }
}

/** Maps an HTTP status to an error kind (shared by the fetch-based adapters). */
export function kindForStatus(status: number): LlmErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'retryable';
  return 'fatal';
}

/** Validates `data` against the request schema, or throws a validation LlmError. */
export function validateOutput<T>(
  provider: string,
  schema: z.ZodType<T>,
  data: unknown,
  usage: Usage,
  raw: unknown,
): T {
  const res = safeParseLenient(schema, data);
  if (res.success) return res.data;
  const issues = res.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  throw new LlmError('validation', `Output did not match the schema: ${issues}`, provider, undefined, usage, raw);
}

/** JSON.parse that throws a validation LlmError instead of a SyntaxError. */
export function parseJsonOutput(provider: string, text: string, usage: Usage, raw: unknown): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError('validation', 'Output was not valid JSON', provider, undefined, usage, raw);
  }
}
