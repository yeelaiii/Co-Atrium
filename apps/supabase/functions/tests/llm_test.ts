// Provider layer: config validation and residency, strict JSON schema, each adapter against
// mocked HTTP (structured output, JSON-mode fallback, usage, error mapping), and the router
// (task switch, retries, fallback, validation retry, escalation, residency at request time).

import { assert, assertEquals, assertRejects, assertStringIncludes, assertThrows } from '@std/assert';
import { z } from 'zod';

import { anthropicAdapter } from '../_shared/llm/adapters/anthropic.ts';
import { openaiCompatibleAdapter } from '../_shared/llm/adapters/openai-compatible.ts';
import { openaiAdapter } from '../_shared/llm/adapters/openai.ts';
import { aiConfig } from '../_shared/llm/ai-config.ts';
import { type AiConfig, estimateCostUsd, parseAiConfig, type ProviderEntry } from '../_shared/llm/config-schema.ts';
import { toStrictJsonSchema } from '../_shared/llm/json-schema.ts';
import { LlmError, ResidencyError } from '../_shared/llm/provider.ts';
import { type CallLog, createRouter } from '../_shared/llm/router.ts';

// ---------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------

type Call = { url: string; body: any; headers: Headers };

function mockFetch(...responses: (Response | (() => Response) | Error)[]) {
  const calls: Call[] = [];
  let i = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const text = await req.clone().text();
    calls.push({ url: req.url, body: text ? JSON.parse(text) : null, headers: req.headers });
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r() : r.clone();
  }) as typeof fetch;
  return { f, calls };
}

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
  });

const schema = z.object({ answer: z.string(), score: z.number().min(0).max(1), note: z.string().optional() });
const req = { model: 'm-1', system: 'sys', input: 'text', schema, schemaName: 'answer', maxOutputTokens: 1000 };

const entry = (over: Partial<ProviderEntry> = {}): ProviderEntry => ({
  adapter: 'openai_compatible',
  base_url: 'https://example.test/v1',
  secret_name: 'TEST_KEY',
  region: 'SG',
  structured_output: 'json_schema',
  supports_temperature: true,
  timeout_ms: 30_000,
  ...over,
});

function baseConfig(over: Partial<Record<string, unknown>> = {}): any {
  return {
    tasks: {
      classify: { provider: 'alpha', model: 'a-small', max_output_tokens: 1000 },
      identify_contract: { provider: 'alpha', model: 'a-small', max_output_tokens: 1000 },
      extract_fields: { provider: 'alpha', model: 'a-small', max_output_tokens: 1000 },
      extract_amendments: { provider: 'alpha', model: 'a-small', max_output_tokens: 1000 },
      extract_procedures: { provider: 'alpha', model: 'a-small', max_output_tokens: 1000 },
    },
    escalation: {
      enabled: true,
      confidence_below: 0.7,
      on_validation_failure: true,
      target: { provider: 'beta', model: 'b-big' },
      max_output_tokens: 2000,
    },
    fallback: { provider: 'gamma', model: 'g-1' },
    retry: { max_attempts: 3, base_delay_ms: 10 },
    providers: {
      alpha: {
        adapter: 'openai_compatible',
        base_url: 'https://alpha.test/v1',
        secret_name: 'ALPHA_KEY',
        region: 'US',
      },
      beta: { adapter: 'openai_compatible', base_url: 'https://beta.test/v1', secret_name: 'BETA_KEY', region: 'US' },
      gamma: {
        adapter: 'openai_compatible',
        base_url: 'https://gamma.test/v1',
        secret_name: 'GAMMA_KEY',
        region: 'SG',
      },
    },
    pricing_usd_per_mtok: { 'a-small': { input: 1, output: 2 } },
    ocr: {
      enabled: false,
      provider: 'paddleocr_api',
      base_url: 'https://ocr.test',
      secret_name: 'OCR_TOKEN',
      model: 'X',
      region: 'CN',
      min_chars_per_page: 50,
      daily_page_quota: 100,
      max_pages_per_invocation: 5,
    },
    allowed_provider_regions: ['SG', 'US', 'EU'],
    ...over,
  };
}

const chat = (content: string, usage = { prompt_tokens: 11, completion_tokens: 7 }) =>
  jsonRes({ choices: [{ message: { content }, finish_reason: 'stop' }], usage });

// ---------------------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------------------

Deno.test('the committed ai-config is valid and has no Google provider', () => {
  assert(aiConfig.tasks.extract_fields.model);
  for (const p of Object.values(aiConfig.providers)) assert(!/google|gemini/i.test(p.base_url));
  assert(!Object.keys(aiConfig.providers).some((k) => /google|gemini/i.test(k)));
});

Deno.test('config: invalid shapes fail with every problem listed', () => {
  const c = baseConfig();
  c.tasks.classify.provider = 'nope';
  c.retry.max_attempts = 0;
  const err = assertThrows(() => parseAiConfig(c), Error);
  assertStringIncludes(err.message, "Unknown provider 'nope'");
  assertStringIncludes(err.message, 'retry.max_attempts');
});

Deno.test('config: a google adapter is not accepted', () => {
  const c = baseConfig();
  c.providers.alpha.adapter = 'google';
  assertThrows(() => parseAiConfig(c), Error, 'adapter');
});

Deno.test('config: task, fallback, escalation target or OCR in a disallowed region is invalid', () => {
  const regionCases: [string, (c: any) => void][] = [
    ['tasks.extract_fields', (c) => (c.providers.alpha.region = 'CN')],
    ['fallback', (c) => (c.providers.gamma.region = 'CN')],
    ['escalation.target', (c) => (c.providers.beta.region = 'GLOBAL')],
    ['ocr.region', (c) => (c.ocr.enabled = true)],
  ];
  for (const [path, mutate] of regionCases) {
    const c = baseConfig();
    mutate(c);
    const err = assertThrows(() => parseAiConfig(c), Error);
    assertStringIncludes(err.message, path);
  }
  // SG-only: the US task providers are rejected, the SG fallback is fine.
  const sg = baseConfig({ allowed_provider_regions: ['SG'] });
  const err = assertThrows(() => parseAiConfig(sg), Error);
  assertStringIncludes(err.message, 'tasks.classify');
  assert(!err.message.includes('fallback'));
});

Deno.test('config: unused providers in other regions are allowed; cost estimates', () => {
  const c = baseConfig();
  c.providers.unused = {
    adapter: 'openai_compatible',
    base_url: 'https://cn.test/v1',
    secret_name: 'CN_KEY',
    region: 'CN',
  };
  const cfg = parseAiConfig(c);
  assertEquals(estimateCostUsd(cfg, 'a-small', 1_000_000, 500_000), 2);
  assertEquals(estimateCostUsd(cfg, 'unknown-model', 10, 10), null);
});

// ---------------------------------------------------------------------------------------
// strict JSON schema
// ---------------------------------------------------------------------------------------

Deno.test('toStrictJsonSchema: closed objects, all required, optional -> nullable, constraints dropped', () => {
  const s = toStrictJsonSchema(z.object({
    a: z.string().min(3).max(9),
    b: z.number().int().min(0).optional(),
    c: z.object({ d: z.enum(['x', 'y']).nullable(), cur: z.string().length(3).default('SGD') }),
    u: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('p'), v: z.number() }),
      z.object({ kind: z.literal('a'), v: z.number() }),
    ]),
  })) as any;
  assertEquals(s.additionalProperties, false);
  assertEquals(s.required, ['a', 'b', 'c', 'u']);
  assertEquals(s.properties.a, { type: 'string' });
  assertEquals(s.properties.b.type, ['integer', 'null']);
  assertEquals(s.properties.c.additionalProperties, false);
  assertEquals(s.properties.c.required, ['d', 'cur']);
  assert(!JSON.stringify(s).match(/minLength|maxLength|minimum|maximum|"default"|"pattern"|oneOf/));
  assert(Array.isArray(s.properties.u.anyOf));
  for (const branch of s.properties.u.anyOf) assertEquals(branch.additionalProperties, false);
});

// ---------------------------------------------------------------------------------------
// adapters
// ---------------------------------------------------------------------------------------

Deno.test('anthropic: structured output request, inference_geo, no temperature, usage', async () => {
  const { f, calls } = mockFetch(jsonRes({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'm-1',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text: '{"answer":"yes","score":0.9,"note":null}' }],
    usage: { input_tokens: 120, output_tokens: 30 },
  }));
  const p = anthropicAdapter(
    'anthropic',
    entry({
      adapter: 'anthropic',
      base_url: 'https://anthropic.test',
      supports_temperature: false,
      inference_geo: 'us',
    }),
    { apiKey: 'k', fetch: f },
  );
  const res = await p.generateStructured({ ...req, effort: 'low' });
  assertEquals(res.data, { answer: 'yes', score: 0.9 });
  assertEquals(res.usage, { inputTokens: 120, outputTokens: 30 });
  const body = calls[0].body;
  assertEquals(calls[0].url, 'https://anthropic.test/v1/messages');
  assertEquals(body.output_config.format.type, 'json_schema');
  assertEquals(body.output_config.format.schema.additionalProperties, false);
  assertEquals(body.output_config.effort, 'low');
  assertEquals(body.inference_geo, 'us');
  assertEquals(body.temperature, undefined);
  // SDK 1.x sends the key as a bearer token; only the configured key, never ambient credentials.
  assertEquals(calls[0].headers.get('authorization'), 'Bearer k');
});

Deno.test('anthropic: error mapping (529 / 429 / 400 / refusal / bad output)', async () => {
  const cases: [Response, string][] = [
    [jsonRes({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529), 'retryable'],
    [jsonRes({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429), 'rate_limit'],
    [jsonRes({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 400), 'fatal'],
    [
      jsonRes({
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'm',
        stop_reason: 'refusal',
        content: [],
        usage: { input_tokens: 5, output_tokens: 0 },
      }),
      'refusal',
    ],
    [
      jsonRes({
        id: 'm',
        type: 'message',
        role: 'assistant',
        model: 'm',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"answer":1}' }],
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
      'validation',
    ],
  ];
  for (const [res, kind] of cases) {
    const { f } = mockFetch(res);
    const p = anthropicAdapter('anthropic', entry({ adapter: 'anthropic', base_url: 'https://anthropic.test' }), {
      apiKey: 'k',
      fetch: f,
    });
    const err = await assertRejects(() => p.generateStructured(req), LlmError);
    assertEquals(err.kind, kind);
  }
});

Deno.test('openai: Responses API json_schema request, usage, refusal', async () => {
  const { f, calls } = mockFetch(
    jsonRes({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"answer":"a","score":0.5}' }] }],
      usage: { input_tokens: 40, output_tokens: 9 },
    }),
    jsonRes({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
      usage: { input_tokens: 4, output_tokens: 1 },
    }),
  );
  const p = openaiAdapter(
    'openai',
    entry({ adapter: 'openai', base_url: 'https://openai.test/v1', supports_temperature: false }),
    { apiKey: 'k', fetch: f },
  );
  const res = await p.generateStructured(req);
  assertEquals(res.usage, { inputTokens: 40, outputTokens: 9 });
  assertEquals(calls[0].url, 'https://openai.test/v1/responses');
  assertEquals(calls[0].body.text.format.type, 'json_schema');
  assertEquals(calls[0].body.text.format.strict, true);
  assertEquals(calls[0].body.temperature, undefined);
  assertEquals(calls[0].headers.get('authorization'), 'Bearer k');
  assertEquals((await assertRejects(() => p.generateStructured(req), LlmError)).kind, 'refusal');
});

Deno.test('openai_compatible: json_schema mode, then JSON-mode fallback with the schema in the prompt', async () => {
  const strict = mockFetch(chat('{"answer":"a","score":1}'));
  const p1 = openaiCompatibleAdapter('qwen', entry(), { apiKey: 'k', fetch: strict.f });
  const r1 = await p1.generateStructured(req);
  assertEquals(r1.usage, { inputTokens: 11, outputTokens: 7 });
  assertEquals(strict.calls[0].url, 'https://example.test/v1/chat/completions');
  assertEquals(strict.calls[0].body.response_format.type, 'json_schema');
  assertEquals(strict.calls[0].body.response_format.json_schema.strict, true);
  assertEquals(strict.calls[0].body.temperature, 0);

  const loose = mockFetch(chat('```json\n{"answer":"b","score":0.2}\n```'));
  const p2 = openaiCompatibleAdapter('other', entry({ structured_output: 'json_object' }), {
    apiKey: 'k',
    fetch: loose.f,
  });
  const r2 = await p2.generateStructured(req);
  assertEquals(r2.data.answer, 'b');
  assertEquals(loose.calls[0].body.response_format, { type: 'json_object' });
  assertStringIncludes(loose.calls[0].body.messages[0].content, '"additionalProperties":false');
});

Deno.test('groq: committed entry sends strict json_schema to GroqCloud and is not routable outside GLOBAL', async () => {
  const groq = aiConfig.providers.groq;
  assertEquals(groq.adapter, 'openai_compatible');
  assertEquals(groq.region, 'GLOBAL');
  const { f, calls } = mockFetch(chat('{"answer":"a","score":0.9}'));
  const p = openaiCompatibleAdapter('groq', groq, { apiKey: 'gk', fetch: f });
  const r = await p.generateStructured({ ...req, model: 'openai/gpt-oss-120b' });
  assertEquals(r.data.answer, 'a');
  assertEquals(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assertEquals(calls[0].headers.get('authorization'), 'Bearer gk');
  assertEquals(calls[0].body.model, 'openai/gpt-oss-120b');
  assertEquals(calls[0].body.response_format.json_schema.strict, true);
  assertEquals(estimateCostUsd(aiConfig, 'openai/gpt-oss-120b', 1_000_000, 1_000_000), 0.75);
  // Pointing a task at it without allowing GLOBAL fails validation.
  const c = baseConfig();
  c.providers.groq = groq;
  c.tasks.classify = { provider: 'groq', model: 'openai/gpt-oss-20b', max_output_tokens: 1000 };
  assertThrows(() => parseAiConfig(c), Error, 'region GLOBAL');
});

Deno.test('openai_compatible: error mapping (503 / 429 / 401 / timeout / network / truncated)', async () => {
  const cases: [Response | Error, string][] = [
    [jsonRes({ error: { message: 'busy' } }, 503), 'retryable'],
    [jsonRes({ error: { message: 'rate' } }, 429), 'rate_limit'],
    [jsonRes({ error: { message: 'auth' } }, 401), 'fatal'],
    [new DOMException('timed out', 'TimeoutError'), 'timeout'],
    [new TypeError('connection reset'), 'retryable'],
    [jsonRes({ choices: [{ message: { content: '{"ans' }, finish_reason: 'length' }], usage: {} }), 'validation'],
  ];
  for (const [res, kind] of cases) {
    const { f } = mockFetch(res);
    const err = await assertRejects(
      () => openaiCompatibleAdapter('x', entry(), { apiKey: 'k', fetch: f }).generateStructured(req),
      LlmError,
    );
    assertEquals(err.kind, kind, `${kind}`);
  }
});

// ---------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------

function routerWith(config: AiConfig, f: typeof fetch) {
  const logs: CallLog[] = [];
  const sleeps: number[] = [];
  const router = createRouter({
    config,
    secret: (n) => `key-${n}`,
    fetch: f,
    log: (l) => void logs.push(l),
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
  });
  return { router, logs, sleeps };
}

const taskReq = { system: 's', input: 'pages', schema, schemaName: 'answer', promptVersion: 'classify.v1' };

Deno.test('router: changing a task provider in the config routes its calls to that provider', async () => {
  const c = baseConfig();
  c.tasks.classify = { provider: 'gamma', model: 'g-1', max_output_tokens: 500 };
  const { f, calls } = mockFetch(chat('{"answer":"a","score":1}'));
  const { router, logs } = routerWith(parseAiConfig(c), f);
  const res = await router.run('classify', taskReq);
  assertEquals(res.provider, 'gamma');
  assertEquals(calls[0].url, 'https://gamma.test/v1/chat/completions');
  assertEquals(calls[0].headers.get('authorization'), 'Bearer key-GAMMA_KEY');
  assertEquals(logs[0], {
    ...logs[0],
    task: 'classify',
    provider: 'gamma',
    model: 'g-1',
    outcome: 'ok',
    promptVersion: 'classify.v1',
  });
});

Deno.test('router: 5xx retried with exponential backoff, then the fallback provider', async () => {
  const { f, calls } = mockFetch(
    jsonRes({}, 502),
    jsonRes({}, 503),
    jsonRes({}, 500),
    chat('{"answer":"fb","score":1}'),
  );
  const { router, logs, sleeps } = routerWith(parseAiConfig(baseConfig()), f);
  const res = await router.run('extract_fields', taskReq);
  assertEquals(res.provider, 'gamma');
  assertEquals(calls.map((c) => new URL(c.url).host), ['alpha.test', 'alpha.test', 'alpha.test', 'gamma.test']);
  assertEquals(sleeps, [10, 20]);
  assertEquals(logs.map((l) => l.outcome), ['error', 'error', 'error', 'fallback']);
  assertEquals(logs[3].estimatedCostUsd, null); // g-1 has no price
});

Deno.test('router: timeout falls back too; a fatal error does not', async () => {
  const t = mockFetch(
    new DOMException('t', 'TimeoutError'),
    new DOMException('t', 'TimeoutError'),
    new DOMException('t', 'TimeoutError'),
    chat('{"answer":"x","score":0}'),
  );
  assertEquals((await routerWith(parseAiConfig(baseConfig()), t.f).router.run('classify', taskReq)).provider, 'gamma');

  const bad = mockFetch(jsonRes({ error: { message: 'bad request' } }, 400));
  const r = routerWith(parseAiConfig(baseConfig()), bad.f);
  assertEquals((await assertRejects(() => r.router.run('classify', taskReq), LlmError)).kind, 'fatal');
  assertEquals(bad.calls.length, 1);
});

Deno.test('router: validation failure is retried once with the error, then thrown (no fallback)', async () => {
  const { f, calls } = mockFetch(chat('{"answer":5}'), chat('{"answer":6}'));
  const { router, logs } = routerWith(parseAiConfig(baseConfig()), f);
  const err = await assertRejects(() => router.run('extract_fields', taskReq), LlmError);
  assertEquals(err.kind, 'validation');
  assertEquals(calls.length, 2);
  assertStringIncludes(calls[1].body.messages[1].content, 'Your previous answer to this request was rejected');
  assertEquals(logs.map((l) => l.outcome), ['validation_failed', 'validation_failed']);
  assertEquals(logs[0].inputTokens, 11); // tokens of failed calls are still recorded
});

Deno.test('router: escalate() uses the escalation target', async () => {
  const { f, calls } = mockFetch(chat('{"answer":"big","score":1}'));
  const { router, logs } = routerWith(parseAiConfig(baseConfig()), f);
  const res = await router.escalate('extract_fields', taskReq);
  assertEquals([res.provider, res.model], ['beta', 'b-big']);
  assertEquals(new URL(calls[0].url).host, 'beta.test');
  assertEquals(calls[0].body.max_tokens, 2000);
  assertEquals(logs[0].outcome, 'escalated');
});

Deno.test('residency ["SG"]: nothing goes outside SG, including fallback and escalation', async () => {
  // Config that is valid for SG: tasks on the SG provider, fallback and escalation outside SG
  // (load-time validation would reject those, so the request-time gate is tested directly).
  const cfg = parseAiConfig(baseConfig());
  const sgOnly: AiConfig = {
    ...cfg,
    allowed_provider_regions: ['SG'],
    tasks: { ...cfg.tasks, classify: { ...cfg.tasks.classify, provider: 'gamma', model: 'g-1' } },
  };

  // Primary SG provider fails with 5xx: the US fallback must not be called... the fallback here is SG
  // (gamma), so point the fallback at a US provider for this check.
  const usFallback: AiConfig = { ...sgOnly, fallback: { provider: 'alpha', model: 'a-small' } };
  const down = mockFetch(jsonRes({}, 503));
  const r1 = routerWith(usFallback, down.f);
  await assertRejects(() => r1.router.run('classify', taskReq), LlmError);
  assert(down.calls.every((c) => new URL(c.url).host === 'gamma.test'));

  // A task whose only providers are outside SG: clear error, no request at all.
  const none = mockFetch(chat('{}'));
  const r2 = routerWith({ ...usFallback }, none.f);
  await assertRejects(() => r2.router.run('extract_fields', taskReq), ResidencyError);
  await assertRejects(() => r2.router.escalate('extract_fields', taskReq), ResidencyError);
  assertEquals(none.calls.length, 0);
});
