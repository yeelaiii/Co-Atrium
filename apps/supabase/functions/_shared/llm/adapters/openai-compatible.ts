// Generic OpenAI-compatible Chat Completions adapter (Qwen on Model Studio, and any provider
// whose API follows /chat/completions). Configured entirely by the provider entry:
//   structured_output 'json_schema': response_format { type: 'json_schema', json_schema: { strict } }
//   structured_output 'json_object': JSON mode; the schema goes into the system prompt instead.
// Output is always validated with zod.

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

export function openaiCompatibleAdapter(id: string, entry: ProviderEntry, deps: AdapterDeps): LlmProvider {
  return {
    id,
    async generateStructured<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
      const schema = req.jsonSchema ?? toStrictJsonSchema(req.schema);
      const jsonMode = entry.structured_output === 'json_object';
      const system = jsonMode
        ? `${req.system}\n\nReply with one JSON object only, matching this JSON Schema:\n${JSON.stringify(schema)}`
        : req.system;
      const body = {
        model: req.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: req.input },
        ],
        max_tokens: req.maxOutputTokens,
        response_format: jsonMode
          ? { type: 'json_object' }
          : { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema } },
        ...(entry.supports_temperature ? { temperature: req.temperature ?? 0 } : {}),
      };
      const res: Any = await postJson(id, `${entry.base_url.replace(/\/+$/, '')}/chat/completions`, body, {
        headers: { Authorization: `Bearer ${deps.apiKey}` },
        timeoutMs: entry.timeout_ms,
        fetch: deps.fetch,
      });

      const usage: Usage = {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };
      const choice = res.choices?.[0];
      if (!choice) throw new LlmError('retryable', 'Response had no choices', id, undefined, usage, res);
      if (choice.message?.refusal) {
        throw new LlmError('refusal', 'The model declined the request', id, undefined, usage, res);
      }
      if (choice.finish_reason === 'length') {
        throw new LlmError('validation', 'Output was cut off at max_tokens', id, undefined, usage, res);
      }
      const text = typeof choice.message?.content === 'string' ? choice.message.content : '';
      const data = validateOutput(id, req.schema, parseJsonOutput(id, stripFences(text), usage, res), usage, res);
      return { data, usage, raw: res };
    },
  };
}

/** JSON mode sometimes wraps the object in a ``` fence. */
function stripFences(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : text;
}
