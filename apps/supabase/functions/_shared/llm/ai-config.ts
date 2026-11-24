// =====================================================================================
// AI CONFIG: the only file that names LLM / OCR providers, models, base URLs and prices.
// =====================================================================================
//
// It is validated when it is imported (config-schema.ts). A mistake here fails loudly at
// function boot, in `deno task test` and in `deno task check-config` (run from
// apps/supabase/functions), never at request time.
//
// Switch a task's provider or model
//   Edit tasks.<task>.provider / .model below. The provider must exist under `providers` and
//   its region must be in allowed_provider_regions. Add a price for a new model under
//   pricing_usd_per_mtok (null = unknown; cost then shows as unknown in extraction_calls).
//
// Add a provider
//   1. Add an entry under `providers`: adapter (anthropic | openai | openai_compatible),
//      base_url, secret_name, region. For openai_compatible, check the provider's docs and set
//      structured_output to 'json_schema' only if it supports strict JSON-schema output;
//      otherwise 'json_object' (JSON mode, still validated with zod).
//   2. Store the key: supabase secrets set <SECRET_NAME>=...  (locally: functions/.env)
//   A new kind of API (not OpenAI-compatible) needs a new adapter in adapters/ (see
//   docs/ai-providers.md once written). There is no Google / Gemini adapter by design.
//
// Data residency
//   allowed_provider_regions blocks every provider (task, fallback, escalation, OCR) whose
//   region isn't listed, both here at load time and again in the router at request time.
//
// Redeploy after any change
//   supabase functions deploy extract-contract
//
// There is no database table, admin screen or runtime override for any of this.

import { parseAiConfig } from './config-schema.ts';

export const aiConfig = parseAiConfig({
  tasks: {
    classify: { provider: 'anthropic', model: 'claude-haiku-5-5', max_output_tokens: 2_000, effort: 'low' },
    identify_contract: { provider: 'anthropic', model: 'claude-haiku-5-5', max_output_tokens: 2_000, effort: 'low' },
    extract_fields: { provider: 'anthropic', model: 'claude-haiku-5-5', max_output_tokens: 16_000, effort: 'medium' },
    extract_amendments: {
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      max_output_tokens: 8_000,
      effort: 'medium',
    },
    extract_procedures: { provider: 'anthropic', model: 'claude-haiku-5-5', max_output_tokens: 8_000, effort: 'low' },
  },

  escalation: {
    enabled: true,
    confidence_below: 0.7,
    on_validation_failure: true,
    target: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
    max_output_tokens: 8_000,
  },

  fallback: { provider: 'qwen', model: 'qwen3.8-flash' },

  retry: { max_attempts: 3, base_delay_ms: 1_000 },

  providers: {
    // Native Messages API (structured output via output_config.format). inference_geo 'us'
    // keeps inference in the US so the 'US' label holds.
    anthropic: {
      adapter: 'anthropic',
      base_url: 'https://api.anthropic.com',
      secret_name: 'ANTHROPIC_API_KEY',
      region: 'US',
      supports_temperature: false,
      inference_geo: 'us',
    },
    // Native Responses API (text.format json_schema, strict). No regional agreement assumed: US.
    openai: {
      adapter: 'openai',
      base_url: 'https://api.openai.com/v1',
      secret_name: 'OPENAI_API_KEY',
      region: 'US',
      supports_temperature: false,
    },
    // Alibaba Cloud Model Studio, Singapore (international) OpenAI-compatible endpoint.
    // json_schema support is documented for the Qwen3.8 series; re-check when changing model.
    qwen: {
      adapter: 'openai_compatible',
      base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      secret_name: 'QWEN_API_KEY',
      region: 'SG',
      structured_output: 'json_schema',
    },
    // GroqCloud OpenAI-compatible endpoint (console.groq.com/docs/openai, checked 2026-11-24).
    // Strict json_schema (constrained decoding) only on some models: openai/gpt-oss-20b and
    // openai/gpt-oss-120b in production; other models need structured_output 'json_object'.
    // Region GLOBAL: Groq says retained data sits in US GCP buckets, but documents no inference
    // region and no regional endpoint. Using it needs 'GLOBAL' in allowed_provider_regions (a
    // data-residency decision), so no task points here yet.
    groq: {
      adapter: 'openai_compatible',
      base_url: 'https://api.groq.com/openai/v1',
      secret_name: 'GROQ_API_KEY',
      region: 'GLOBAL',
      structured_output: 'json_schema',
    },
  },

  // Estimates only. Prices from each provider's pricing page on 2026-11-20.
  pricing_usd_per_mtok: {
    'claude-haiku-5-5': { input: 0.1, output: 0.5 }, // prompts up to 100K tokens
    'gpt-6.1-terra': { input: 1, output: 5 },
    'qwen3.8-flash': null, // not confirmed: Model Studio's public model list shows no price
    'openai/gpt-oss-20b': { input: 0.075, output: 0.3 }, // Groq models page, 2026-11-24
    'openai/gpt-oss-120b': { input: 0.15, output: 0.6 }, // Groq models page, 2026-11-24
  },

  // PaddleOCR official API (AI Studio). Endpoint and request format from the official SDK
  // (@paddleocr/api-sdk 0.2.3): POST /api/v2/ocr/jobs, Bearer token, async job + JSONL result.
  // Region: AI Studio is Baidu's platform; I could not confirm a non-China hosting region,
  // so it is labelled CN, which allowed_provider_regions doesn't allow. OCR is therefore off:
  // scanned pages are stored but not read. To turn it on, add 'CN' to
  // allowed_provider_regions (a data-residency decision) and set enabled: true.
  // daily_page_quota: second-hand sources quote 3,000 pages per model per day; check the
  // AI Studio quota page for your account.
  ocr: {
    enabled: false,
    provider: 'paddleocr_api',
    base_url: 'https://paddleocr.aistudio-app.com',
    secret_name: 'PADDLEOCR_ACCESS_TOKEN',
    model: 'PaddleOCR-VL-1.6',
    region: 'CN',
    min_chars_per_page: 50,
    daily_page_quota: 3_000,
    max_pages_per_invocation: 20,
  },

  allowed_provider_regions: ['SG', 'US', 'EU'],
});
