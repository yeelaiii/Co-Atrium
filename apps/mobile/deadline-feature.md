# Task: Contract upload, field extraction, deadline reminders and variation orders

## Stack
- **Client:** Expo (React Native, TypeScript), on iOS and Android.
- **Backend:** Supabase. That means Postgres with Row Level Security, Storage, Edge Functions (Deno/TypeScript), Auth, and `pg_cron` for scheduled jobs.
- **Push notifications:** Expo Push Notifications, sent from Edge Functions.
- **OCR:** the hosted PaddleOCR API (PaddleOCR-VL document parsing), used only for pages without a text layer. Call it behind an `OcrProvider` interface so it can be swapped later.
- **LLM extraction:** **provider-agnostic.** The provider and model for each extraction task are set in a single config file in the codebase (see A5). Switching providers means editing that file and redeploying. There is no in-app setting. Call it **only from Edge Functions**. All API keys are stored in Supabase secrets and never shipped to the client.

## Before you write code
1. Inspect the repository: folder structure, existing Supabase migrations, auth/roles, navigation, state management and UI component conventions. Reuse what exists.
2. Write `docs/contracts-plan.md` covering: the schema (tables, enums, RLS policies), Edge Functions, the extraction pipeline, the screens, the job schedule and the test plan. List your assumptions and open questions.
3. **Stop and wait for confirmation** before implementing.

## Domain primer (just enough to implement correctly)
- Singapore construction projects use standard form contracts: **SIA Building Contract 2016** (private sector, lump sum or D&B), **PSSCOC Construction Works 2020**, **PSSCOC Design & Build 2020**, **PSSCOC-lite (2025)** (public sector), and **REDAS** (developers). A contract package is made up of articles of agreement, the general conditions (the standard form), an **appendix** (project-specific values), **particular/special conditions** (amendments), and specifications/preliminaries.
- Most deadlines are **relative**: a period plus a trigger event ("within 21 days after the payment claim is served"). So the system has two halves: **rules** (period plus trigger) and **events** (timestamped occurrences). Combining a rule with an event gives an **obligation** with a due date.
- Contract administrators issue written instructions: an **AI** (Architect's Instruction) under SIA, an **SOI** (Superintending Officer's Instruction) under PSSCOC, and the Employer's Representative's instruction under REDAS. Many instructions are **variations** that change scope, contract sum or time.
- The **Security of Payment (SOP) Act** applies to every project and overrides the contract on payment response timing.

---

## Part A: Document upload and field extraction

### A1. Upload flow (client)
- The user picks one or more files with `expo-document-picker`: PDF, DOCX or images. Allow up to 50 MB per file, and show upload progress.
- Files go to a private Storage bucket `contract-documents/{project_id}/{uuid}.{ext}`. Each file gets a row in `contract_documents` (project_id, storage_path, filename, mime, page_count, uploaded_by, `extraction_status`: `queued | processing | needs_review | complete | failed`, error).
- The user can add documents later, such as a supplementary agreement or a revised appendix. Each new document re-runs extraction and produces *proposed changes*, never silent overwrites.
- The app shows extraction status live (Supabase Realtime or polling).

### A2. Extraction pipeline (Edge Function `extract-contract`)
This is triggered when an upload completes. It must be idempotent and resumable, and it records progress so a long document can't time out the whole job. Split large documents into page batches, and if needed use a job table and multiple invocations.

Steps:
1. **Get text, cheapest method first.**
   - PDFs with a text layer: extract the text per page with a JS PDF library. No OCR or LLM cost.
   - A page with little or no extractable text (below a configurable character threshold) or image uploads: send it to the `OcrProvider`. The default is the PaddleOCR hosted API. Check the current PaddleOCR documentation for the endpoint, auth and request format. Don't guess them. Store the endpoint and token in Supabase secrets. Respect the API's daily page quota: track pages used per day in a table, and queue jobs when the quota runs out. Keep page boundaries: OCR page by page, or split the multi-page output reliably, because every extracted value must cite a page.
   - DOCX: convert to text and estimate the page breaks.
   - Store the per-page text in `document_pages` (document_id, page_no, text, `text_source`: `pdf_text_layer | ocr | docx`, ocr_provider, ocr_confidence if available).
2. **Classify sections, rules first.** Label page ranges as `articles`, `general_conditions`, `appendix`, `particular_conditions`, `preliminaries`, `specifications`, `drawings_list`, `bq`, `supplementary_agreement` or `other`. Use heading and keyword rules first (e.g. "Appendix", "Particular Conditions", "Special Conditions", "Preliminaries", "Articles of Agreement"). Only send pages that the rules can't classify to the `classify` LLM task, and send only short page excerpts.
   - **Never send `general_conditions`, `specifications`, `bq` or `drawings_list` pages to the LLM for field extraction.** The general conditions are already encoded as rule data. Only the preliminaries are scanned for project procedures (step 6).
3. **Identify the contract.** Determine `contract_form` (enum: `SIA_2016_LUMP_SUM`, `SIA_2016_DB`, `PSSCOC_CW_2020`, `PSSCOC_DB_2020`, `PSSCOC_LITE_CW_2025`, `PSSCOC_LITE_DB_2025`, `REDAS`, `BESPOKE`, `UNKNOWN`), the edition, and `with_quantities` (bool). Also pick out the PSSCOC option modules that were selected.
4. **Extract appendix and articles fields** using the field schema in A3.
5. **Extract amendments.** In particular/special conditions, find every clause that changes a time period, a payment mechanism, a variation procedure, a notice requirement or the dispute process. Output each as a proposed rule override (see Part B).
6. **Extract project procedures.** From the preliminaries and specs, pull out RFI/RFA response times, shop drawing review periods, submittal procedures, meeting frequency, and the notice and communication channels the contract requires ("all notices in writing to…").
7. **Write results** to `extracted_fields` and `draft_rules`, then set the status to `needs_review`.

LLM call requirements (all calls go through the provider layer in A5):
- Use structured JSON output with a strict schema. The adapter picks the provider's best mechanism (JSON-schema response format, tool/function calling, or JSON mode). **Always validate with zod regardless of provider.** If validation fails, retry once with the validation error included in the prompt, then escalate (see A5) or mark the field `failed`.
- Every extracted value **must** include `source_document_id`, `page_no`, a `source_excerpt` of 25 words or fewer, and `confidence` (0–1). If the value isn't stated in the document, return `null` with the reason `not_found`. **The model must never infer or guess values.**
- Keep prompts in versioned files (`supabase/functions/_shared/prompts/*.md`). They must be provider-neutral: no provider-specific syntax in prompt text. Record `prompt_version`, `provider`, `model`, `task`, input/output tokens and `estimated_cost_usd` for each LLM call in `extraction_calls`.

### A5. Configurable LLM provider layer

**Interface** (`supabase/functions/_shared/llm/`):
```ts
interface LlmProvider {
  id: string; // e.g. "anthropic", "openai", "google", "qwen", "mistral", "deepseek", "openrouter"
  generateStructured<T>(req: {
    model: string;
    system: string;
    input: string;           // page text with page markers
    schema: ZodSchema<T>;    // converted to JSON Schema by the adapter
    maxOutputTokens: number;
    temperature?: number;    // default 0
  }): Promise<{ data: T; usage: { inputTokens: number; outputTokens: number }; raw: unknown }>;
}
```

**Adapters to build:**
- `anthropic`: native Messages API, using tool use for structured output.
- `openai`: native, using a JSON-schema response format.
- `google`: Gemini API, using a response schema.
- `openai_compatible`: one generic adapter configured by `base_url` + key + model. This covers Qwen (Alibaba Cloud Model Studio, **Singapore/international endpoint**), DeepSeek, Mistral and OpenRouter, provided their APIs are OpenAI-compatible. Check each provider's current docs for base URLs and which structured-output features they support. Where JSON-schema mode isn't supported, fall back to JSON mode plus zod validation.
- Use plain `fetch` in Deno, or provider SDKs only if they run cleanly in Supabase Edge Functions.

**Config: one typed file in the codebase, changed by a code change and redeploy:**
- Put it in `supabase/functions/_shared/llm/ai-config.ts`. It exports a single `aiConfig` object that is validated against a zod schema when the module loads. An invalid config must fail loudly at deploy or startup and in CI, not at request time.
- **This is the only place** that names providers, models, base URLs, prices and OCR settings. All other code reads from `aiConfig`.
- Don't create a database table, admin screen, remote config or runtime override for it. Secrets (API keys) stay in Supabase secrets and are referenced by name from the config.
- Shape (shown as JSON; write it as a typed TS object):
```json
{
  "tasks": {
    "classify":           { "provider": "google",    "model": "gemini-2.5-flash-lite" },
    "identify_contract":  { "provider": "anthropic", "model": "claude-haiku-5-5" },
    "extract_fields":     { "provider": "anthropic", "model": "claude-haiku-5-5" },
    "extract_amendments": { "provider": "anthropic", "model": "claude-haiku-5-5" },
    "extract_procedures": { "provider": "anthropic", "model": "claude-haiku-5-5" }
  },
  "escalation": {
    "enabled": true,
    "confidence_below": 0.7,
    "on_validation_failure": true,
    "target": { "provider": "openai", "model": "gpt-5.4-mini" }
  },
  "fallback": { "provider": "qwen", "model": "qwen3.8-flash" },
  "providers": {
    "qwen":     { "adapter": "openai_compatible", "base_url": "TODO_FROM_DOCS", "secret_name": "QWEN_API_KEY", "region": "SG" },
    "deepseek": { "adapter": "openai_compatible", "base_url": "TODO_FROM_DOCS", "secret_name": "DEEPSEEK_API_KEY", "region": "CN" }
  },
  "pricing_usd_per_mtok": {
    "claude-haiku-5-5": { "input": 0.10, "output": 0.50 }
  },
  "ocr": { "provider": "paddleocr_api", "region": "TODO_FROM_DOCS", "min_chars_per_page": 50, "daily_page_quota": 20000 },
  "allowed_provider_regions": ["SG", "US", "EU"]
}
```
  The model IDs and prices above are examples. The pricing table is only used to estimate cost.
- Add a comment block at the top of the file explaining how to switch a task's provider or model, add a provider, and what to redeploy (`supabase functions deploy …`).
- **Escalation:** re-run only the fields that failed or scored low confidence on the escalation target, not the whole document.
- **Fallback:** if the primary provider returns 5xx, times out or rate-limits after retries (exponential backoff, max 3), use the fallback provider. Record which provider produced each value.
- **Data-residency policy:** each provider entry has a `region`. `allowed_provider_regions` in the config blocks any provider outside those regions. This covers primary, fallback and escalation calls, and also applies to OCR. Also validate at load time: if a configured task, fallback or escalation target uses a region that isn't allowed, the config is invalid. At request time, if no allowed provider is available, fail with a clear error instead of sending the data elsewhere.
- **Usage logging:** keep writing every call to `extraction_calls` (provider, model, task, tokens, estimated cost). Add a SQL view summarising usage and cost per provider and task, so it can be queried in the Supabase dashboard. Don't build a UI for it.

### A6. Provider comparison harness
Write a CLI script (`scripts/eval-extraction.ts`, run with Deno or Node) that:
- runs the extraction pipeline on every fixture in `tests/fixtures/contracts/` against a list of provider/model pairs passed as CLI arguments. These override `aiConfig` for the run only, and never change the committed config.
- scores each one against the golden expected fields: exact-match accuracy per field, rate of `not_found` correctly returned, **rate of invented values** (a value returned where the golden answer is `not_found`), schema validation failure rate, average latency, and total estimated cost
- writes a markdown and CSV report to `reports/extraction-eval-<date>.*`

Invented values are the most important metric. A model that makes up an LD rate is worse than one that returns `not_found`.

### A3. Field schema (`extracted_fields` → confirmed into `project_contract`)
Define these fields as a typed config (`contractFieldSchema.ts`), shared by the Edge Functions and the client, so adding a field doesn't need a migration. Use a JSONB `values` column with a typed wrapper, or columns if you strongly prefer. Explain the choice in the plan.

**Identity:** contract_form, edition, with_quantities, contract_title, project_name, site_address, employer_name, contractor_name, contract_administrator_role (`architect | superintending_officer | employers_representative`), contract_administrator_name, qs_name, date_of_contract, letter_of_award_date.

**Money:** contract_sum, currency (default SGD), gst_treatment, retention_percent, retention_limit (percent or amount), performance_bond (percent or amount, plus form: banker's guarantee / insurance bond), performance_bond_expiry_basis, advance_payment (if any), fluctuation_applicable plus the materials covered, provisional_sums_total, prime_cost_sums_total.

**Time:** date_of_commencement / possession_of_site, completion_date **or** contract_period (plus unit), sectional_completion (list: section, date or period, LD rate), liquidated_damages_rate (plus unit: per day / per week), ld_cap (if any), defects_liability_period (plus unit), maintenance_period (if separate).

**Payment:** interim_payment_claim_frequency and day of month, payment_response_period, payment_period_after_certificate, final_account_submission_period, final_certificate_period.

**Variations:** variation_valuation_basis (BQ rates / schedule of rates / agreed lump sum), daywork_rates_reference, contractor_quotation_required (bool) plus period, notice_of_claim_period, oral_instruction_confirmation_period, objection_to_valuation_period. Many of these come from the general conditions defaults (Part B) unless the contract amends them.

**Other:** insurance requirements (type, minimum sum, period), nominated_subcontractors (list), dispute_resolution (arbitration / litigation / mediation first, plus seat or rules), option_modules (list), time_unit_definition (calendar days / working days, plus whether public holidays are included).

Each field stores: value, unit, source_document_id, page_no, source_excerpt, confidence, `origin` (`extracted | standard_form_default | user_entered`), status (`proposed | confirmed | rejected`), confirmed_by, confirmed_at.

### A4. Review screen (client)
- Fields are grouped by the sections above. Each one shows its value, a confidence badge and a "View source" button that opens the PDF at that page with the excerpt highlighted. Use a PDF viewer that works in Expo (e.g. `react-native-pdf` with a dev client, or a WebView with pdf.js). Explain the choice in the plan.
- The user can accept, edit or reject each field, or "Accept all high-confidence" (threshold configurable, default 0.9). Low-confidence and `not_found` fields are listed first.
- Required fields (contract_form, commencement, completion, LD rate, DLP, payment response period) must be confirmed before deadlines go live.
- When a newly uploaded document proposes a changed value, show a side-by-side diff (current vs proposed, with sources).
- Only users with role `qs`, `pm` or `contract_admin` can confirm. Enforce this in RLS, not just the UI.

---

## Part B: Rules, events, obligations and reminders

### B1. Rule library
- A `rule_library` table, seeded from versioned files `supabase/seed/rules/*.json`, one file per form plus `sopa.json`.
- `deadline_rules` holds the project-level effective rules: they're copied from the library on contract confirmation, then overridden by confirmed amendments and procedures.

Rule fields: rule_key (stable, e.g. `sopa.payment_response`), obligation (text), responsible_role, recipient_role (`employer | contract_admin | contractor | subcontractor | qs | consultant`), trigger_event_type, period, unit (`calendar_days | working_days | weeks | months`), includes_public_holidays, cap_days, is_time_bar, consequence, `origin` (`statute | standard_form_default | amended | project_procedure | user_defined`), source_document_id/clause/page, confidence, status (`draft | verified | rejected`), verified_by, verified_at, chains_to (rule_keys), applies_to_contract_forms.

**Precedence** (a pure, tested function): statute caps always apply. Then `amended` > `project_procedure` = `user_defined` > `standard_form_default`.

**Seed data:**
- **SOP Act** (period values are known):
  - `sopa.payment_response`: payment response within the contract's period, capped at 21 days from service of the payment claim. Defaults to 14 days if the contract sets no period.
  - `sopa.dispute_settlement_period`: 7 days.
  - `sopa.adjudication_application`: within 7 days after the dispute settlement period ends. Time bar.
- **Standard forms** (SIA 2016 lump sum first, then the others): placeholder rules for the payment response to interim claims, EOT notice of a delaying event, the contract administrator's EOT decision, confirmation of oral instructions, objection to an instruction or its valuation, contractor's notice of claim for a variation, contract administrator's valuation of a variation, final account submission, and the defects rectification notice.
  **Set every period and clause reference to `TODO_VERIFY` and the status to `draft`.** Don't invent clause numbers or periods, and don't copy contract text. Store structured facts only. Rules with a `TODO_VERIFY` value can't become `verified` until a user enters the value.

### B2. Events
A `project_events` table holds: project_id, event_type, reference (e.g. `RFI-023`, `VO-012`), raised_by_party, addressed_to_party, sent_at, served_at, related_variation_id, related_event_id (e.g. a response pointing to its request), attachments (Storage paths), notes and created_by.

Event types: `rfi_submitted`, `rfi_responded`, `rfa_submitted`, `rfa_responded`, `shop_drawing_submitted`, `shop_drawing_reviewed`, `payment_claim_served`, `payment_response_served`, `payment_certificate_issued`, `instruction_issued`, `oral_instruction_received`, `oral_instruction_confirmed`, `variation_quotation_submitted`, `variation_valuation_issued`, `variation_objection_served`, `delay_event_occurred`, `eot_notice_served`, `eot_decision_issued`, `completion_certified`, `defect_notified`, `defect_rectified`.

**Service:** deadlines run from `served_at`. By default, a document sent on a working day before 17:00 SGT is served that day; otherwise it's served the next working day. This is configurable per project.

Logging an event should be quick on mobile: a form with a type picker, reference, date (defaulting to now), a counterparty picker, and an option to attach a photo, screenshot or file.

### B3. Deadline calculator (shared TypeScript, pure)
Put this in `supabase/functions/_shared/deadlines/` so the Edge Functions and the client can both import it (if the repo layout makes sharing awkward, mirror it into the client with a single source of truth).
- Time zone Asia/Singapore. Calendar days vs working days. Working days are Mon–Fri excluding Singapore public holidays unless configured otherwise. Public holidays live in a `public_holidays` table seeded from a file with a source URL comment, and must be easy to update every year.
- Caps use `min(period, cap)`. Month periods follow the corresponding-date rule, clamped to the end of the month.
- Returns `{ due_at, explanation }`, where the explanation reads like "21 calendar days after payment claim served on 3 Mar 2026 (capped by SOP Act s11)".

### B4. Obligations
`obligations` holds: project_id, rule_id, trigger_event_id, responsible_party, due_at, status (`open | met | overdue | waived | suggested`), closed_by_event_id and explanation.
- A Postgres trigger or an Edge Function creates obligations when an event is inserted and a **verified** rule matches.
- A response event closes the matching open obligation, matched by `related_event_id` or by reference.
- Chaining: when an obligation becomes overdue, or a variation records a time impact, create the `chains_to` follow-ons with status `suggested`. A user must confirm them before they become `open`.
- If the completion date changes (EOT granted, or a VO with an agreed time impact), recalculate any obligations that depend on it, such as LD exposure, DLP end and final account dates.

### B5. Reminders
- A `pg_cron` job runs every 15 minutes and calls the `send-reminders` Edge Function.
- Default schedule (configurable per project): at creation, 50% of the period, 2 working days before, on the due date, then daily while overdue (max 5). Time-bar obligations get an extra reminder at 5 working days before and are visually flagged.
- Channels: Expo push (store tokens in `push_tokens`, and handle `DeviceNotRegistered` by deleting the token), plus an in-app notifications table. Write delivery behind an interface so email can be added later.
- Messages depend on role:
  - Responsible party: "RFI-023 reply due Fri 14 Mar (7 working days, project procedure)."
  - Waiting party when overdue: "RFI-023 reply is overdue. If this delays the works, consider recording a delay event; an EOT notice period may be running."
- The `reminders_sent` table enforces idempotency, so the same reminder is never sent twice.
- **Never send formal contractual notices automatically.** The app may generate a draft notice (text or PDF) for a person to review and send through the official channel.

---

## Part C: Variation orders

### C1. Data model
`variations` holds: project_id, vo_number (auto-increments per project, editable), title, description, `source` (`written_instruction | oral_instruction_confirmed | contractor_proposal | client_request`), instructing_party, instruction_event_id, instruction_reference (e.g. AI-045 / SOI-12), status, amounts, time_impact_days_claimed, time_impact_days_agreed, eot_event_id, attachments, created_by and timestamps.

Status flow (enforce valid transitions in the database or service layer):
`identified → instructed → quotation_submitted → valuation_issued → agreed` with branches to `disputed`, `rejected`, `withdrawn`. `disputed` can go back to `agreed`. For `oral_instruction_received`, the VO starts at `unconfirmed` until a written confirmation or instruction event is logged.

Amounts: `claimed_amount`, `assessed_amount`, `agreed_amount`, `omission` (bool, or signed amounts). Keep a `variation_amount_history` table so every change is audited (who changed what, when, from which document).

### C2. VO deadlines
VO events feed the same rules engine. Examples, all expressed as rules with `TODO_VERIFY` periods unless extracted or entered:
- `oral_instruction_received` → the contractor must confirm in writing within N days, or risk the instruction not counting.
- `instruction_issued` (variation) → the contractor's quotation or notice of claim is due, if the contract requires one. The contractor's objection window starts.
- `variation_quotation_submitted` → the contract administrator's response or valuation is due.
- `variation_valuation_issued` → the contractor's objection window starts.
- A VO with `time_impact_days_claimed > 0` → a **suggested** EOT notice obligation.

### C3. Contract sum and payment link
- Revised contract sum = original contract_sum + Σ agreed VO amounts (additions minus omissions). Also show "contract sum incl. pending VOs" using assessed or claimed values, clearly labelled.
- When a payment claim is logged, show which agreed VOs are included or outstanding.
- For scope captured from site (e.g. a client verbally instructing workers), provide a "Record site instruction" action. It creates an `oral_instruction_received` event plus an `unconfirmed` VO, and immediately starts the confirmation reminder.

### C4. VO screens
- **VO register:** a list with filters (status, party, has-time-impact) and totals (agreed, pending, disputed), with export to CSV/PDF.
- **VO detail:** a timeline of related events, amounts with history, linked documents, open obligations, and actions (log quotation, log valuation, mark agreed/disputed, attach file).
- **Create VO:** from scratch, from an instruction event, or from a site instruction.

---

## Security and data rules
- RLS on every table: users only see projects they belong to. Confirmation and verification actions require the roles stated above.
- The Storage bucket is private. The client gets access through short-lived signed URLs.
- Edge Functions use the service role only where needed, and check the caller's project membership.
- Show this disclaimer in the app: deadlines and extracted values are an aid only. Users must check them against their contract, and this isn't legal advice.

## Testing
**Unit tests (calculator and rules):**
- SOP Act: contract 30 days → 21. Contract 10 → 10. No contractual period → 14.
- A calendar-day vs working-day period over a Singapore public holiday.
- Served Friday 17:30 before a public holiday Monday → served Tuesday.
- A month period from 31 Jan.
- An `amended` rule beats `standard_form_default` but still respects the statute cap.
- Responses close matching obligations only. Overdue plus `chains_to` gives `suggested`, not `open`.
- VO status transitions: valid ones succeed, invalid ones are rejected. The revised contract sum is correct when omissions are included.
- An EOT granted → completion-dependent obligations are recalculated.

**Extraction tests:**
- Build a fixture set of 3–5 synthetic contract packages in `tests/fixtures/contracts/`, with text-based PDFs plus at least one scanned PDF. Each has a known appendix and one amended clause. **Write the fixtures yourself and don't use real contract text.**
- Golden-file tests compare the extracted fields with expected values and flag any change in precision or recall. The LLM calls run behind a flag so CI can use recorded responses.
- Schema validation failure → retry → escalation → `failed` status.
- Provider layer: each adapter is tested with mocked HTTP responses, covering structured output, JSON-mode fallback, usage parsing and error mapping.
- Config: an invalid `aiConfig` fails schema validation, and a CI check runs it. A task, fallback or escalation target whose region isn't allowed is rejected. Changing a task's provider in `ai-config.ts` routes that task's calls to the new adapter, tested with mocks.
- Escalation re-runs only low-confidence fields. Fallback triggers on 5xx or timeout.
- Data residency: with `allowed_provider_regions: ["SG"]`, no call goes to a provider outside SG. This includes fallback, escalation and OCR. If no allowed provider exists, it errors.
- OCR routing: pages with a text layer never call OCR. Image-only pages do. Running out of quota queues the job.

**Integration (against a local Supabase via `supabase start`):** upload → extraction → review → confirm → event → obligation → reminder → response → reminder cancelled. Also: VO created from a site instruction → confirmation reminder → instruction logged → valuation → agreed → contract sum updated.

## Deliverables
1. `docs/contracts-plan.md`, written first, and then wait for confirmation.
2. Supabase migrations (schema, enums, RLS, triggers, cron), seed files, Edge Functions (`extract-contract`, `create-obligations` if not done by trigger, `send-reminders`, `recalculate-deadlines`), and the shared calculator.
3. Expo screens: Upload & status, Field review, Rule review, Deadlines dashboard, Log event, VO register, VO detail, Create VO, plus navigation wiring and push notification registration.
4. Tests as listed above.
5. `docs/contracts-rules.md`: how to add a new standard form or field, how prompts are versioned, and a list of every `TODO_VERIFY` item for a contracts professional to check.
6. `docs/ai-providers.md`: how to add a provider or adapter, how to switch models by editing `ai-config.ts` and redeploying, the required secrets per provider, the data-residency setting, and how to run `scripts/eval-extraction.ts`.
6. A final summary of what was built, what's stubbed, and known limitations.

## Guardrails
- Don't hard-code contract periods in logic. They live in rule data or confirmed fields.
- Unverified rules and unconfirmed fields never generate live obligations.
- Never let the LLM's output become authoritative without user confirmation. Every extracted value has a source citation.
- Never name a provider, model ID, base URL or price outside `ai-config.ts`. Never send document text to a provider in a region the config doesn't allow.
- Don't fabricate clause numbers, periods or legal text. Use `TODO_VERIFY`.
- Keep the calculator deterministic and free of side effects.