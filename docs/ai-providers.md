# AI providers: extraction models, OCR, data residency and evals

Contract extraction calls an LLM (and optionally an OCR service) **only from the `extract-contract` Edge Function**. Which provider and model each task uses is set in one file, `apps/supabase/functions/_shared/llm/ai-config.ts`. There is no in-app setting, no database table and no runtime override. Changing provider means editing that file and redeploying.

Commands below run from `apps/supabase/functions`.

## The pieces

| File | Role |
|---|---|
| `_shared/llm/ai-config.ts` | **The only place** that names providers, models, base URLs, secret names, prices and the OCR service. Validated when imported. |
| `_shared/llm/config-schema.ts` | Zod schema for the config, including the data-residency checks. |
| `_shared/llm/provider.ts` | The `LlmProvider` interface and error kinds (`retryable`, `rate_limit`, `timeout`, `validation`, `refusal`, `fatal`). |
| `_shared/llm/adapters/` | `anthropic.ts` (Messages API via the official SDK), `openai.ts` (Responses API, strict JSON schema), `openai-compatible.ts` (any `/chat/completions` API: JSON schema or JSON mode). There is deliberately no Google / Gemini adapter. |
| `_shared/llm/router.ts` | Picks the provider per task, retries with backoff, falls back, escalates, enforces residency at request time, logs every call to `extraction_calls`. |
| `_shared/ocr/` | `OcrProvider` interface and the PaddleOCR API client. |
| `_shared/prompts/` | Versioned, provider-neutral prompts (see `docs/contracts-rules.md`). |

Every call's provider, model, prompt version, tokens, latency, outcome and estimated cost goes to `extraction_calls`; the view `llm_usage_summary` totals them per provider, task, model and day for the Supabase dashboard.

## Switch a task's model or provider

1. Edit `tasks.<task>` in `ai-config.ts` (`classify`, `identify_contract`, `extract_fields`, `extract_amendments`, `extract_procedures`): `provider` must be a key under `providers`, `model` is the provider's model ID. `max_output_tokens` and `effort` stay per task.
2. Add the model's price under `pricing_usd_per_mtok` (USD per million input / output tokens, from the provider's pricing page). `null` means unknown: calls still run, the cost estimate is left empty.
3. Check it: `deno task check-config` prints every task's provider, model and region, and fails listing every problem (unknown provider, region not allowed, …). `deno task test` also loads the config.
4. Optional but recommended: compare the old and new model on the fixtures first (see [Evaluate models](#evaluate-models)).
5. Deploy: `supabase functions deploy extract-contract`. Documents already extracted keep their values; new uploads use the new model.

Escalation (`escalation.target`, re-runs only low-confidence or invalid fields on a stronger model, with only their pages) and fallback (`fallback`, used when the task's provider still fails with 5xx / timeout / 429 after `retry.max_attempts`) are switched the same way.

## Add a provider

**If it has an OpenAI-compatible `/chat/completions` API** (most hosted model APIs do), no code is needed:

1. Add an entry under `providers` in `ai-config.ts`:
   ```ts
   mistral_eu: {
     adapter: 'openai_compatible',
     base_url: 'https://…/v1',             // from the provider's API docs
     secret_name: 'MISTRAL_API_KEY',
     region: 'EU',                          // where it processes the data, see below
     structured_output: 'json_schema',      // only if it supports strict JSON-schema output; else 'json_object'
   },
   ```
   Check the provider's current docs for the base URL and whether it supports strict `json_schema` response formats. With `json_object` the schema is put into the system prompt and the reply is still validated with zod.
2. Store the key: `supabase secrets set MISTRAL_API_KEY=…` (locally: `apps/supabase/functions/.env`, which is git-ignored).
3. Point a task, the fallback or the escalation target at it, run `deno task check-config`, deploy.

**If it needs its own API**, write an adapter:

1. `_shared/llm/adapters/<name>.ts` exporting `(<id>, entry, { apiKey, fetch }) => LlmProvider`. It must send the JSON schema with the provider's strongest structured-output mechanism, map HTTP failures to `LlmError` kinds (use `postJson` from `adapters/http.ts`, or `kindForStatus`), return token usage, and pass the parsed output through `validateOutput` (zod) whatever the provider claims.
2. Add the name to `ADAPTERS` in `config-schema.ts` and a branch in `adapterFor()` in `router.ts`.
3. Test it in `tests/llm_test.ts` with mocked `fetch`: structured output, usage parsing, each error kind, and that a reply that doesn't match the schema becomes a `validation` error.

Provider names, model IDs, base URLs and prices must not appear anywhere except `ai-config.ts` (adapters are named after API styles, not vendors' models).

### Keep output schemas simple

Constrained-decoding APIs cap schema complexity per request. Anthropic, for example, allows at most 16 union-typed properties (`anyOf` or `"type": [..., "null"]`) and 24 optional properties, and also rejects grammars that compile too large. So `extract_fields` and `identify_contract` don't send a typed, nullable value per field, or even one object per field. They send `fields` as an array of one fixed, union-free item: `key` (an enum of the fields asked for), `found`, `value_json` (the value as JSON text), `page_no` (0 = none), `source_excerpt` ("" = none) and `confidence`. The schema stays the same size whatever the number of fields. Each value is then checked against its own field schema, and the prompt lists the expected shape per field. `tests/field_wire_test.ts` fails if any task schema goes over the documented limits.

## Secrets

Set with `supabase secrets set NAME=value`; locally put them in `apps/supabase/functions/.env`. Keys never reach the app.

| Secret | Needed when | Used by |
|---|---|---|
| `ANTHROPIC_API_KEY` | any task, fallback or escalation uses the `anthropic` provider entry (today: every task) | `adapters/anthropic.ts` |
| `OPENAI_API_KEY` | the `openai` entry is used (today: escalation target) | `adapters/openai.ts` |
| `QWEN_API_KEY` | the `qwen` entry is used (today: fallback) | `adapters/openai-compatible.ts` |
| `GROQ_API_KEY` | the `groq` entry is used (today: nothing; its region is `GLOBAL`, so `allowed_provider_regions` must allow `GLOBAL` first) | `adapters/openai-compatible.ts` |
| `PADDLEOCR_ACCESS_TOKEN` | only if `ocr.enabled` is true | `_shared/ocr/paddleocr.ts` |

The secret name for each provider is its `secret_name` in `ai-config.ts`; a missing key fails that provider's calls with a clear "Secret … is not set" error (the job is marked failed with a user-safe message), never a silent skip. The Supabase keys the functions use themselves (`SUPABASE_SECRET_KEYS` / `SUPABASE_PUBLISHABLE_KEYS`) are provided by the platform.

## Data residency

Each provider entry, and the OCR entry, has a `region` (`SG`, `US`, `EU`, `CN`, `GLOBAL`): where that service processes the data, as far as its documentation or your agreement with it says. `allowed_provider_regions` lists the regions contract text may be sent to.

- **At load time** the config is invalid if any task, the fallback, the escalation target, or enabled OCR uses a region that isn't allowed. The function then fails at boot (and `check-config` / the tests fail), never at request time.
- **At request time** the router checks again before sending anything; if no allowed provider is left for a task it throws a `ResidencyError` and the job fails. It never sends the data somewhere else instead.
- Label a provider honestly. A global API with no region pinning is `GLOBAL`, not `US`. Where a provider offers pinning (for example a request parameter or a regional endpoint), set it in the entry and label the region it pins to; `ai-config.ts` comments say how each current entry's label was justified.
- **OCR is off by default**: the configured OCR service's hosting region could not be confirmed outside `CN`, which isn't allowed. Scanned pages are stored and flagged, and their values come back "not found". Turning OCR on is a data-residency decision for the project owner: add the region to `allowed_provider_regions`, set `ocr.enabled: true`, set the token secret, redeploy.

To restrict to Singapore only, set `allowed_provider_regions: ['SG']` and make sure every task, the fallback and the escalation target use SG providers (or disable escalation / set `fallback: null`); `check-config` tells you which ones don't.

## Evaluate models

`scripts/eval-extraction.ts` runs the real extraction pipeline on the synthetic contract packages in `tests/fixtures/contracts/` and scores the results against each package's golden answers (`expected.json`).

```sh
deno task eval --model anthropic:claude-haiku-5-5 --model openai:gpt-6.1-terra   # live calls (keys in the environment)
LLM_MODE=record deno task eval --model qwen:qwen3.8-flash                       # live, and save every response
LLM_MODE=replay deno task eval --model qwen:qwen3.8-flash                       # from the recordings, no network
deno task eval --model oracle:reference                                         # offline scripted reference, no keys
```

- Each `--model provider:model` puts **every** task on that model for the run only. `ai-config.ts` is never written. The provider must exist under `providers` and be in an allowed region (the run's config is validated with the same schema, so residency still applies); the model can be any ID the provider serves.
- Escalation and fallback are off by default so each score is the model's own; `--keep-escalation` keeps them as configured.
- `--ocr` turns OCR on for the scanned fixture. Its region must be allowed: `--allow-region CN` allows it for this run only. The fixtures are synthetic, so this sends no real contract data, but say so in the report if you use it.
- `--fixture <name>` limits the run; `--out <dir>` changes the report folder (default `reports/`, which is not git-ignored: don't commit reports unless you mean to).
- Keys are read from the environment. Export them, or run Deno directly: `deno run --env-file=.env -A scripts/eval-extraction.ts --model …`.

Output: `reports/extraction-eval-<date>.md` (summary per model, per fixture, every invented and wrong value, per-field accuracy) and `.csv` (one row per model × fixture × field).

How to read it:

| Metric | Meaning |
|---|---|
| **Invented** | A value returned where the document states none (golden: not found), after the excerpt guard. **The most important number.** A model that makes up an LD rate is worse than one that says "not found". |
| Caught by guard | Values the model returned whose excerpt was not on the cited page; the pipeline dropped them and flagged them for review. High numbers mean the model is citing loosely. |
| Accuracy / precision | Correct ÷ values stated in the document; correct ÷ values returned. |
| Not found correct | Absent fields correctly returned as not found. |
| Schema failures | Calls whose output failed zod validation (each is retried once with the error). |
| Never-send leaks | Calls containing general conditions, specification, BQ or drawing-list text. Must be 0. |
| Latency, cost | Average per call; estimated from `pricing_usd_per_mtok` ("unknown" without a price). |

`oracle:reference` is not a model: it answers from the golden files with a few scripted mistakes, to check the harness and the guards. Its numbers say nothing about any provider.

### Fixtures, recordings and golden tests

- `tests/fixtures/contracts/<name>/`: `pages.md` (source text, fictional), `contract.pdf` (built by `deno task build-fixtures`; the scanned one is rasterised with `scripts/rasterise-fixture.py`, which needs Python and Pillow), `expected.json` (golden values with page and excerpt; any field not listed is expected to be not found), `oracle.json` (the reference run's scripted mistakes). `deno task build-fixtures --check` checks every golden excerpt against the text the pipeline really extracts.
- `tests/fixtures/llm-recordings/<run>/<fixture>.json`: recorded responses (`LLM_MODE=record`). A request is matched by a hash of provider, model, prompt, page text and schema, so a changed prompt or fixture is a replay miss ("re-record"), never a stale answer.
- `tests/fixtures/eval-baselines/<run>.json`: pinned per-field outcomes. `deno task test` replays every pinned run (the reference offline, real models from their recordings) and fails if any outcome changes, i.e. any change in precision or recall. After an intended change, re-pin with `--update-baseline` on the same command.

To pin a real model for the tests: `LLM_MODE=record deno task eval --model <p>:<m>` (needs its key), then `LLM_MODE=replay deno task eval --model <p>:<m> --update-baseline`, and commit the recording and the baseline. No real-model recordings are committed yet (none could be made without API keys).
