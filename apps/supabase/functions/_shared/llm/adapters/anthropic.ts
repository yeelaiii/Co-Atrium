// Anthropic Messages API through the official SDK. Structured output: output_config.format
// (json_schema); the result is still validated with zod. The SDK's own retries are off: the
// router owns retries and fallback so every attempt is logged.

import Anthropic from '@anthropic-ai/sdk';

import type { ProviderEntry } from '../config-schema.ts';
import { toStrictJsonSchema } from '../json-schema.ts';
import {
  type GenerateRequest,
  type GenerateResult,
  kindForStatus,
  LlmError,
  type LlmProvider,
  parseJsonOutput,
  type Usage,
  validateOutput,
} from '../provider.ts';

export interface AdapterDeps {
  apiKey: string;
  fetch?: typeof fetch;
}

export function anthropicAdapter(id: string, entry: ProviderEntry, deps: AdapterDeps): LlmProvider {
  const client = new Anthropic({
    apiKey: deps.apiKey,
    // Only the key named in ai-config: never ambient credentials (ANTHROPIC_AUTH_TOKEN, profiles).
    authToken: null,
    baseURL: entry.base_url,
    maxRetries: 0,
    timeout: entry.timeout_ms,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });

  return {
    id,
    async generateStructured<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
      let msg: Anthropic.Message;
      try {
        msg = await client.messages.create({
          model: req.model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: [{ role: 'user', content: req.input }],
          output_config: {
            format: { type: 'json_schema', schema: req.jsonSchema ?? toStrictJsonSchema(req.schema) },
            ...(req.effort ? { effort: req.effort } : {}),
          },
          ...(entry.inference_geo ? { inference_geo: entry.inference_geo } : {}),
          ...(entry.supports_temperature ? { temperature: req.temperature ?? 0 } : {}),
        });
      } catch (e) {
        throw mapError(id, e);
      }

      const usage: Usage = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
      if (msg.stop_reason === 'refusal') {
        throw new LlmError('refusal', 'The model declined the request', id, undefined, usage, msg);
      }
      if (msg.stop_reason === 'max_tokens') {
        throw new LlmError('validation', 'Output was cut off at max_tokens', id, undefined, usage, msg);
      }
      const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const data = validateOutput(id, req.schema, parseJsonOutput(id, text, usage, msg), usage, msg);
      return { data, usage, raw: msg };
    },
  };
}

function mapError(id: string, e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new LlmError('timeout', 'Request timed out', id);
  if (e instanceof Anthropic.APIConnectionError) {
    return new LlmError('retryable', `Connection failed: ${e.message}`, id);
  }
  if (e instanceof Anthropic.APIError && typeof e.status === 'number') {
    // 529 overloaded and every 5xx are retryable; 429 is a rate limit.
    return new LlmError(kindForStatus(e.status), `Anthropic API error ${e.status}: ${e.message}`, id, e.status);
  }
  return new LlmError('fatal', e instanceof Error ? e.message : String(e), id);
}
