// The zod schema for ai-config.ts, including the data-residency policy. parseAiConfig() runs
// when ai-config.ts is imported, so an invalid config fails at function boot, in `deno task
// test` and in `deno task check-config`, never at request time.

import { z } from 'zod';

export const REGIONS = ['SG', 'US', 'EU', 'CN', 'GLOBAL'] as const;
export type Region = (typeof REGIONS)[number];

export const TASKS = [
  'classify',
  'identify_contract',
  'extract_fields',
  'extract_amendments',
  'extract_procedures',
] as const;
export type TaskName = (typeof TASKS)[number];

/** Adapters that exist (adapters/*.ts). There is deliberately no Google / Gemini adapter. */
export const ADAPTERS = ['anthropic', 'openai', 'openai_compatible'] as const;
export type AdapterName = (typeof ADAPTERS)[number];

const secretName = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/, 'Secret names are UPPER_SNAKE_CASE');

const providerEntry = z.object({
  adapter: z.enum(ADAPTERS),
  base_url: z.url({ protocol: /^https$/ }),
  secret_name: secretName,
  /** Where the provider processes the data. Checked against allowed_provider_regions. */
  region: z.enum(REGIONS),
  /** openai_compatible only: 'json_schema' (strict) or 'json_object' (JSON mode + zod). */
  structured_output: z.enum(['json_schema', 'json_object']).default('json_schema'),
  /** false: the adapter never sends temperature (some models reject non-default sampling). */
  supports_temperature: z.boolean().default(true),
  /** anthropic only: pins where inference runs (sent as inference_geo), so `region` is accurate. */
  inference_geo: z.string().min(2).max(16).optional(),
  timeout_ms: z.number().int().min(5_000).max(300_000).default(120_000),
}).strict();
export type ProviderEntry = z.infer<typeof providerEntry>;

const modelRef = z.object({
  provider: z.string().min(1),
  model: z.string().min(1).max(100),
}).strict();
export type ModelRef = z.infer<typeof modelRef>;

const taskEntry = modelRef.extend({
  max_output_tokens: z.number().int().min(256).max(64_000),
  effort: z.enum(['low', 'medium', 'high']).optional(),
}).strict();
export type TaskEntry = z.infer<typeof taskEntry>;

const price = z.object({ input: z.number().min(0), output: z.number().min(0) }).strict();

const ocrEntry = z.object({
  /** false: pages without a text layer are kept but not read (the user sees a warning). */
  enabled: z.boolean(),
  provider: z.literal('paddleocr_api'),
  base_url: z.url({ protocol: /^https$/ }),
  secret_name: secretName,
  /** Document-parsing model name sent to the API. */
  model: z.string().min(1).max(60),
  region: z.enum(REGIONS),
  /** A PDF page with fewer extractable characters than this is sent to OCR. */
  min_chars_per_page: z.number().int().min(0).max(5_000),
  /** Pages per day (SGT) across all projects; jobs wait for the next day when it runs out. */
  daily_page_quota: z.number().int().min(1),
  /** OCR jobs submitted per pipeline invocation. */
  max_pages_per_invocation: z.number().int().min(1).max(200),
}).strict();
export type OcrEntry = z.infer<typeof ocrEntry>;

const rawConfig = z.object({
  tasks: z.object(Object.fromEntries(TASKS.map((t) => [t, taskEntry])) as Record<TaskName, typeof taskEntry>).strict(),
  escalation: z.object({
    enabled: z.boolean(),
    /** Fields below this confidence are re-run on the target (only those fields, only their pages). */
    confidence_below: z.number().min(0).max(1),
    on_validation_failure: z.boolean(),
    target: modelRef,
    max_output_tokens: z.number().int().min(256).max(64_000),
  }).strict(),
  /** Used when the task's provider still fails after retries (5xx, timeout, rate limit). null = none. */
  fallback: modelRef.nullable(),
  retry: z.object({
    max_attempts: z.number().int().min(1).max(5),
    base_delay_ms: z.number().int().min(0).max(30_000),
  }).strict(),
  providers: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,31}$/), providerEntry),
  /** USD per million tokens, keyed by model ID. Only used for cost estimates; null = unknown. */
  pricing_usd_per_mtok: z.record(z.string(), price.nullable()),
  ocr: ocrEntry,
  allowed_provider_regions: z.array(z.enum(REGIONS)).min(1),
}).strict();

export type AiConfig = z.infer<typeof rawConfig>;

export const aiConfigSchema = rawConfig.superRefine((c, ctx) => {
  const allowed = new Set<Region>(c.allowed_provider_regions);
  const checkRef = (ref: ModelRef, path: (string | number)[]) => {
    const p = c.providers[ref.provider];
    if (!p) {
      ctx.addIssue({ code: 'custom', path, message: `Unknown provider '${ref.provider}' (add it under providers)` });
    } else if (!allowed.has(p.region)) {
      ctx.addIssue({
        code: 'custom',
        path,
        message: `Provider '${ref.provider}' is in region ${p.region}, which allowed_provider_regions does not allow`,
      });
    }
  };
  for (const t of TASKS) checkRef(c.tasks[t], ['tasks', t]);
  if (c.escalation.enabled) checkRef(c.escalation.target, ['escalation', 'target']);
  if (c.fallback) checkRef(c.fallback, ['fallback']);
  if (c.ocr.enabled && !allowed.has(c.ocr.region)) {
    ctx.addIssue({
      code: 'custom',
      path: ['ocr', 'region'],
      message: `OCR is enabled but its region ${c.ocr.region} is not in allowed_provider_regions`,
    });
  }
  for (const [id, p] of Object.entries(c.providers)) {
    if (p.inference_geo && p.adapter !== 'anthropic') {
      ctx.addIssue({
        code: 'custom',
        path: ['providers', id, 'inference_geo'],
        message: 'inference_geo is for the anthropic adapter only',
      });
    }
    if (p.adapter !== 'openai_compatible' && p.structured_output !== 'json_schema') {
      ctx.addIssue({
        code: 'custom',
        path: ['providers', id, 'structured_output'],
        message: 'Only openai_compatible providers can use json_object',
      });
    }
  }
});

/** Parses and validates a config; throws with every problem listed. */
export function parseAiConfig(input: z.input<typeof aiConfigSchema>): AiConfig {
  const res = aiConfigSchema.safeParse(input);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid ai-config:\n${lines.join('\n')}`);
  }
  return res.data;
}

/** Estimated cost of one call in USD, or null when the model has no price entry. */
export function estimateCostUsd(
  config: AiConfig,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const p = config.pricing_usd_per_mtok[model];
  if (!p) return null;
  return Math.round(((inputTokens * p.input + outputTokens * p.output) / 1_000_000) * 1e6) / 1e6;
}
