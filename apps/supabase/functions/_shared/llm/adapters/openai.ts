// OpenAI Responses API with plain fetch. Structured output: text.format json_schema, strict.

import type { ProviderEntry } from '../config-schema.ts';
import { toStrictJsonSchema } from '../json-schema.ts';
import {
  type GenerateRequest,
  type GenerateResult,
  LlmError,
  type LlmProvider,
  parseJsonOutput,
  type Usage,
  validateOutput,
} from '../provider.ts';
import type { AdapterDeps } from './anthropic.ts';
import { postJson } from './http.ts';

// deno-lint-ignore no-explicit-any
type Any = any;

export function openaiAdapter(id: string, entry: ProviderEntry, deps: AdapterDeps): LlmProvider {
  return {
    id,
    async generateStructured<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
      const body = {
        model: req.model,
        instructions: req.system,
        input: req.input,
        max_output_tokens: req.maxOutputTokens,
        store: false,
        text: {
          format: {
            type: 'json_schema',
            name: req.schemaName,
            strict: true,
            schema: req.jsonSchema ?? toStrictJsonSchema(req.schema),
          },
        },
        ...(entry.supports_temperature ? { temperature: req.temperature ?? 0 } : {}),
      };
      const res: Any = await postJson(id, `${entry.base_url.replace(/\/+$/, '')}/responses`, body, {
        headers: { Authorization: `Bearer ${deps.apiKey}` },
        timeoutMs: entry.timeout_ms,
        fetch: deps.fetch,
      });

      const usage: Usage = { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 };
      if (res.status === 'incomplete') {
        throw new LlmError(
          'validation',
          `Output incomplete: ${res.incomplete_details?.reason ?? 'unknown'}`,
          id,
          undefined,
          usage,
          res,
        );
      }
      if (res.error) {
        throw new LlmError('retryable', `OpenAI error: ${res.error.message ?? 'unknown'}`, id, undefined, usage, res);
      }
      const parts: Any[] = (res.output ?? []).filter((o: Any) => o.type === 'message').flatMap((o: Any) =>
        o.content ?? []
      );
      if (parts.some((p) => p.type === 'refusal')) {
        throw new LlmError('refusal', 'The model declined the request', id, undefined, usage, res);
      }
      const text = parts.filter((p) => p.type === 'output_text').map((p) => p.text).join('');
      const data = validateOutput(id, req.schema, parseJsonOutput(id, text, usage, res), usage, res);
      return { data, usage, raw: res };
    },
  };
}
