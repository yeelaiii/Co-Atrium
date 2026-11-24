# Contracts, deadlines and variations: implementation plan

Status: **confirmed 2026-11-20; phases 1–4 built (see §10, §11).** Source brief: `apps/mobile/deadline-feature.md`.

### Decisions (answers to §2)
1. Q1: `project_members.contract_role` (`qs | pm | contract_admin`), owner-set. `job_role` stays reference-only.
2. Q2: extend `variation_orders`; add only the columns that are actually needed.
3. Q3: contract sum via a `security definer` totals function; VO-linked obligations visible to VO participants only.
4. Q4: `project_members.contract_party`, owner-set.
5. Q5: phases 1 → 4 as proposed.
6. Q6: WebView + bundled pdf.js.
7. Q7: **no Gemini / Google provider at all.** No `google` adapter; `classify` uses a non-Google provider.
8. Q8: seed MOM holidays (2026, plus 2027 if published).
9. Q9: cut-off time + Saturday flag per project.
10. **No GitHub Actions CI and no changes to anything git/GitHub related.** The ai-config check is a local script (`deno task check-config`) instead.

---

## 0. What exists today (and how this plan reuses it)

| Area | Today | Consequence for this work |
|---|---|---|
| Supabase project | `apps/supabase/` (migrations 0001–0018, pgTAP tests in `tests/`, CLI 2.122.1) | Every `supabase/...` path in the brief maps to `apps/supabase/...`. New migrations start at **0019**. |
| Edge Functions | None yet (`edge_runtime` enabled in `config.toml`) | We create `apps/supabase/functions/` with a `deno.json` import map. |
| Schemas / helpers | `private` schema for RLS helpers (`private.my_projects(roles)`, `has_project_role`, `is_project_owner`), `private.path_project_id()` path validator, default-deny privileges, writes through `security definer` RPCs | Same conventions: RLS helpers in `private`, column-level grants, writes through RPCs, `set search_path = ''`. |
| Project roles | `project_members.role` ∈ `owner | member | guest | viewer`. `project_members.job_role` (per project, owner-set, **explicitly "reference only, grants nothing"** in 0018) ∈ `Administrator, Project Director, Project Manager, Quantity Surveyor, Builder, Sub Contractor` | The brief's `qs | pm | contract_admin` don't exist. See **Q1**. |
| Variation orders | `variation_orders` (+ comments, attachments, voice notes, transcriptions, approvers, participants). `status` ∈ `pending | approved` (internal sign-off). **VOs are private to their participants** (0017). Records are undeletable. Push sent straight from Postgres via `pg_net` (`private.push_to_users`). | The brief's `variations` table would duplicate this. Plan extends `variation_orders` instead. See **Q2**. |
| Push | `push_tokens` table + `register_push_token` RPC; client registration in `src/lib/push.ts` and tap routing in `src/app/(app)/_layout.tsx` | Reused. `send-reminders` reads `push_tokens`, adds `DeviceNotRegistered` cleanup. Tap routing gets new notification types. |
| Storage | Private buckets `attachments` (25 MB) and `audio` (50 MB); global limit 50 MiB; paths `<project_id>/<file>` | New private bucket `contract-documents`, 50 MB, path `<project_id>/<uuid>.<ext>` (already matches `path_project_id`). |
| Cron | `pg_cron` not enabled; maintenance functions exist but nothing schedules them | Migration enables `pg_cron` for this feature's jobs only (the existing unscheduled reaper is left alone). |
| Mobile app | Expo SDK **58**, Expo Router (`src/app/`), NativeWind with semantic tokens (`bg-background dark:bg-background-dark`, `text-accent`, …), Manrope, hooks in `src/hooks`, data access in `src/lib/*.ts`, no state library (hooks + `useFocusEffect` + Realtime), `expo-dev-client` already present | Same patterns. No new state library. Dev client means native modules are acceptable. |
| Tests | pgTAP only (`supabase test db`). No JS test runner in `apps/mobile`. No CI workflows (`.github/workflows/.gitkeep`). | Shared TS + Edge Functions tested with `deno test`. Add a CI workflow (see §9). |
| Docs | Root `docs/` was deleted in the working tree (`D docs/.gitkeep`) | This plan recreates `docs/` at the repo root. |

---

## 1. Assumptions

1. A Co-Atrium project = one construction contract (one main contract per project). Subcontracts are out of scope for v1 (`subcontractor` exists as a party for obligations only).
2. Each project member acts for one **contract party** on that project (employer, contract administrator, contractor, subcontractor, QS, consultant). Reminders for an obligation go to members of the responsible party; "waiting party" messages go to members of the recipient party.
3. The app's users are mostly on the **contractor** side, but the model must work if the employer/consultant side uses it too.
4. "Deadlines go live" = obligations are created only when (a) the six required fields are confirmed and (b) the matching rule is `verified`. Until then the dashboard shows what *would* be due, clearly marked "not live".
5. Supabase hosted region is Singapore (`ap-southeast-1`); data-residency rules only govern outbound calls to LLM/OCR providers.
6. English-language contracts only.
7. LLM and OCR keys come from Supabase secrets; locally from `apps/supabase/functions/.env` (git-ignored).
8. Model IDs and prices in the brief's config are **placeholders**; real values are taken from each provider's docs at implementation time, and I'll say which ones I could not confirm.

---

## 2. Open questions (please answer before I start)

**Q1. Who may confirm fields and verify rules?** The brief says "role `qs`, `pm` or `contract_admin`, enforced in RLS". Options:
- **(a) Recommended:** add `project_members.contract_role` (`qs | pm | contract_admin | null`), set by project owners through an RPC like `set_member_job_role`, *and* require `role in ('owner','member')`. `job_role` stays reference-only as 0018 promises.
- (b) Derive from `job_role` (`Quantity Surveyor`→qs, `Project Manager`/`Project Director`→pm, new `Contract Administrator`→contract_admin). Fewer moving parts, but it reverses the 0018 design note that `job_role` grants nothing.

**Q2. Extend `variation_orders` or add a new `variations` table?** Recommended: **extend `variation_orders`**. Keep the existing `status` (`pending | approved`, internal sign-off) and add a separate `contract_status` for the contractual lifecycle (`unconfirmed | identified | instructed | quotation_submitted | valuation_issued | agreed | disputed | rejected | withdrawn`). VO numbering, threads, photos, voice notes and approvals all keep working. The alternative (separate table) means two VO concepts in one app.

**Q3. Private VOs vs contract sum.** VOs are visible only to their participants (0017). The revised contract sum must count *all* agreed VOs. Recommended: a `security definer` function `project_contract_sum(pid)` returns the totals (agreed / pending / disputed) to anyone with a contract role, without revealing VO titles they can't see. VO-linked obligations and reminders are visible only to VO participants. OK?

**Q4. Mapping members to contract parties.** Recommended: `project_members.contract_party` (`employer | contract_admin | contractor | subcontractor | qs | consultant | null`), set by owners. Parties with no members in the app (often the employer) still exist on obligations; nobody is pushed for them, but the contractor side still sees the "waiting on employer" deadline. OK?

**Q5. Build order.** This is a large brief (~25 tables/views, 4–5 Edge Functions, 7 adapters/providers, 8 screens). I propose building in phases, each one reviewable and shippable on its own:
1. **Deadlines core** (no AI): rule library + seed, events, calculator, obligations, reminders, Log event, Rule review, Deadlines dashboard, with manual entry of contract fields.
2. **VO contractual layer**: extend `variation_orders`, amount history, contract sum, site instruction, register/detail/create additions.
3. **Upload + extraction**: storage, text/OCR, classification, LLM provider layer, review screen, PDF viewer.
4. **Eval harness, fixtures, docs** (`contracts-rules.md`, `ai-providers.md`), final summary.
Phase 1 gives value before any LLM work and pins down the data model extraction writes into. OK, or would you prefer extraction first?

**Q6. PDF viewer.** Recommended: `react-native-webview` + a **bundled** pdf.js (works offline on site, supports jumping to a page and highlighting the excerpt via pdf.js's find controller). `react-native-pdf` jumps to pages but cannot highlight text. Adds one native module (dev client already in use). OK?

**Q7. Gemini region label.** The Gemini API (AI Studio) has no region pinning; Vertex AI does (Singapore region available). With `allowed_provider_regions: ["SG","US","EU"]` a plain Gemini API entry would need a `GLOBAL` label, which the policy would reject. Options: use Vertex AI (needs a GCP service account, more setup), label it `US` (inaccurate), or move `classify` to another provider. I'd mark it `GLOBAL` and move `classify` to the Anthropic/OpenAI small model until you decide. Same question, smaller, for Anthropic and OpenAI: I'll label them `US` unless you have a regional agreement.

**Q8. Public holidays.** I'll seed 2026 and 2027 Singapore public holidays from the Ministry of Manpower list (source URL in the file), including the observed Monday when a holiday falls on Sunday. If 2027 isn't published yet, I'll seed 2026 only and the calculator will warn when a date falls in a year with no holiday data. OK?

**Q9. Service cut-off.** Default "served the same day if sent on a working day before 17:00 SGT, else next working day" applies to every channel, including email? Per-project override = cut-off time + whether Saturdays count. Enough?

---

## 3. Schema

All tables: RLS on, default deny, `project_id` first, reads via `project_id in (select private.my_projects())`, writes via RPCs unless noted. Enums are Postgres `text` + `check` (repo convention, easier to extend than `create type`).

### 3.1 Membership additions (migration 0019)
- `project_members.contract_role text null check in ('qs','pm','contract_admin')` (Q1a)
- `project_members.contract_party text null check in (party list)` (Q4)
- RPC `set_member_contract_profile(pid, uid, contract_role, contract_party)`: owner only.
- Helper `private.can_confirm_contract(pid)`: active `owner|member` with non-null `contract_role`.

### 3.2 Documents and extraction (migration 0020)
| Table | Key columns | Notes |
|---|---|---|
| `contract_documents` | id, project_id, storage_path, filename, mime, size_bytes, page_count, uploaded_by, `extraction_status` (`queued|processing|needs_review|complete|failed`), error, supersedes_document_id, created_at | Realtime-published so status updates live. Insert via `register_contract_document()` RPC (checks the object exists and was uploaded by caller, like `attach_vo_media`). |
| `extraction_jobs` | id, document_id, step (`text|classify|identify|fields|amendments|procedures|write`), status (`pending|running|done|failed|waiting_quota`), cursor jsonb (next page batch), attempts, locked_until, last_error | Makes the pipeline resumable: each invocation claims one step/batch with `for update skip locked` and a lease. |
| `document_pages` | document_id, page_no, text, `text_source` (`pdf_text_layer|ocr|docx`), ocr_provider, ocr_confidence, section, section_source (`rule|llm|user`) | PK (document_id, page_no). |
| `ocr_usage_daily` | provider, day (SGT), pages_used | Quota check + increment in one statement. |
| `extraction_calls` | id, document_id, job_id, task, provider, model, prompt_version, input_tokens, output_tokens, estimated_cost_usd, latency_ms, outcome (`ok|validation_failed|error|escalated|fallback`), error, created_at | Service role writes; contract-role members read. |
| `extracted_fields` | id, project_id, document_id, field_key, value jsonb, unit, page_no, source_excerpt (≤25 words, checked), confidence, not_found_reason, `origin` (`extracted|standard_form_default|user_entered`), status (`proposed|confirmed|rejected|superseded`), provider, model, confirmed_by, confirmed_at | **One row per proposal per field.** |
| `project_contract_fields` | project_id, field_key, value jsonb, unit, source_field_id → `extracted_fields`, confirmed_by, confirmed_at | One row per confirmed field: the authoritative current value. |
| `draft_rules` | as `deadline_rules` below + document_id | Proposed overrides from amendments/procedures, reviewed in Rule review. |
| view `llm_usage_summary` | provider, task, model, day, calls, tokens, cost | For the Supabase dashboard; no UI. |

**Why row-per-field JSONB rather than columns or one JSONB blob:** the field list lives in `contractFieldSchema.ts` (adding a field = no migration); each field needs its own status, source, confidence, confirmer and history; a new document's value becomes a *new proposed row*, which makes the side-by-side diff trivial (current `project_contract_fields` row vs proposed `extracted_fields` row). `value` is validated against the field's zod schema in the RPC caller (Edge Function / client) and its shape is documented by the typed wrapper.

Confirm/reject/edit go through `confirm_contract_field(field_id, edited_value?)` etc., which check `private.can_confirm_contract()` (RLS-level enforcement, Q1).

### 3.3 Rules (migration 0021)
- `rule_library`: global, read-only for clients. Columns per brief: rule_key (unique with form + library_version), obligation, responsible_role, recipient_role, trigger_event_type, period (int **nullable**), unit, includes_public_holidays, cap_days, cap_rule_key, is_time_bar, consequence, origin, clause_ref (nullable), `todo_verify text[]` (which attributes are still `TODO_VERIFY`), chains_to text[], applies_to_contract_forms text[], library_version.
- `deadline_rules`: project-level effective rules, same shape + project_id, source_document_id/clause/page, confidence, status (`draft|verified|rejected`), verified_by/at, overrides_rule_id.
  - Check constraint: `status <> 'verified' or (period is not null and cardinality(todo_verify) = 0)` → a `TODO_VERIFY` rule **cannot** be verified until a user enters the value.
  - `verify_rule()` / `edit_rule()` RPCs require `can_confirm_contract`.
- `TODO_VERIFY` is represented as `null` + an entry in `todo_verify`, not as a magic string in an integer column; seed JSON uses the literal `"TODO_VERIFY"` and the seed loader converts it.
- Seeding: `apps/supabase/seed/rules/sopa.json`, `sia_2016_lump_sum.json`, then the other forms. A Deno script `scripts/build-rule-seed.ts` validates the JSON against the zod rule schema and generates `apps/supabase/seed/rules.sql` (wired into `config.toml` `[db.seed] sql_paths`). For hosted projects the same SQL is applied by a migration-safe `upsert` keyed on (rule_key, library_version).
- **Precedence** is a pure TS function (`_shared/deadlines/precedence.ts`): pick the highest-origin verified rule per rule_key (`amended` > `project_procedure` = `user_defined` > `standard_form_default`; ties → latest verified), then apply statute caps (`min(period, cap)`) from any `statute` rule linked via `cap_rule_key`.

### 3.4 Events, obligations, reminders (migration 0022)
- `public_holidays` (date PK, name, source_url) seeded from `apps/supabase/seed/public_holidays_sg.json`.
- `project_deadline_settings`: project_id, service_cutoff_time (default 17:00), saturday_is_working_day (default false), reminder_schedule jsonb (defaults below), high_confidence_threshold (default 0.9).
- `project_events`: per brief, plus `served_at` computed by the client/edge from `sent_at` using the shared calculator (stored, user-editable), `variation_order_id` (instead of related_variation_id), attachments text[] of storage paths. Insert via `log_project_event()` RPC (owner/member).
- `obligations`: per brief + `rule_key`, `responsible_party`, `recipient_party`, `is_time_bar`, `depends_on` (`event|completion_date`), `variation_order_id`. Status `open|met|overdue|waived|suggested`. Unique (rule_id, trigger_event_id) for idempotency.
- `notifications` (in-app): user_id, project_id, obligation_id, kind, title, body, data, read_at.
- `reminders_sent`: obligation_id, user_id, reminder_key (`created`, `half`, `wd-2`, `wd-5`, `due`, `overdue-1`…`overdue-5`), channel, sent_at. **PK (obligation_id, user_id, reminder_key, channel)** → idempotent.

**Where date maths happens.** Due dates must come from the shared TS calculator (single source of truth), so obligations are created by the `create-obligations` Edge Function, not plpgsql:
- `log_project_event()` inserts the event and a row in `obligation_queue`; an `after insert` trigger fires `net.http_post` to `create-obligations` (fast path). The 15-minute cron also drains `obligation_queue` (safety net if the HTTP call is lost).
- **Closing** obligations needs no date maths, so it's a plpgsql trigger: a response event (`rfi_responded`, `payment_response_served`, …) closes open obligations whose trigger event is `related_event_id`, or same `reference` + matching request type. Mapping of request→response types lives in a small SQL table seeded from the same TS constant.
- Chaining: when `send-reminders` marks an obligation `overdue`, or a VO gets `time_impact_days_claimed > 0`, follow-on obligations from `chains_to` are inserted with status `suggested`; `confirm_suggested_obligation()` RPC turns them `open`.
- Completion-date changes (confirmed field edit, EOT decision, VO with agreed time impact) enqueue `recalculate-deadlines` for that project.

### 3.5 Variation orders (migration 0023), assuming Q2 = extend
Add to `variation_orders`: `contract_status`, `source` (`written_instruction|oral_instruction_confirmed|contractor_proposal|client_request`), instructing_party, instruction_event_id, instruction_reference, claimed_amount, assessed_amount, agreed_amount, is_omission, time_impact_days_claimed, time_impact_days_agreed, eot_event_id.
- Valid transitions enforced by a `before update` trigger with a transition table (`identified→instructed→quotation_submitted→valuation_issued→agreed`, any of these → `disputed|rejected|withdrawn`, `disputed→agreed`, `unconfirmed→instructed|identified|withdrawn`).
- `variation_amount_history`: vo_id, field, old_value, new_value, changed_by, changed_at, source_document_id/event_id. Written by trigger; append-only, undeletable (same `prevent_vo_record_delete` pattern).
- `record_site_instruction()` RPC: creates `oral_instruction_received` event + VO with `contract_status = 'unconfirmed'` in one transaction and enqueues obligations.
- `project_contract_sum(pid)` (Q3): original sum + Σ agreed (omissions negative), plus "incl. pending" using assessed, else claimed.

### 3.6 Cron (migration 0024)
- `create extension pg_cron`; a Supabase **secret API key** (`sb_secret_…`, not the legacy `service_role` JWT, which Supabase retires by end of 2026) + function URL stored in Vault (`vault.create_secret`), read by a `private.invoke_edge_function(name)` helper using `pg_net`, sent in the `apikey` header.
- `*/15 * * * *` → `send-reminders` (also drains `obligation_queue`, marks overdue).
- `*/5 * * * *` → `extract-contract` resume (picks up `pending`/expired-lease jobs and `waiting_quota` jobs after SGT midnight).

---

## 4. Edge Functions and shared code

```
apps/supabase/functions/
  deno.json                         import map: zod, @supabase/supabase-js, unpdf, pdf-lib, mammoth
  _shared/
    deadlines/                      PURE, no Deno APIs, imports with .ts extensions
      calendar.ts  served.ts  calculator.ts  precedence.ts  explain.ts  index.ts
    contracts/
      contractFieldSchema.ts        field defs + zod value schemas + section grouping + required list
      ruleSchema.ts  eventTypes.ts  voTransitions.ts
    llm/
      ai-config.ts                  THE ONLY place naming providers/models/URLs/prices/OCR
      config-schema.ts              zod schema + residency validation at module load
      provider.ts                   LlmProvider interface, error types (Retryable, Timeout, RateLimit, Validation)
      adapters/anthropic.ts  openai.ts  google.ts  openai-compatible.ts
      router.ts                     task → provider, retries (exp. backoff ×3), fallback, escalation, residency gate, call logging
    ocr/  provider.ts  paddleocr.ts  quota.ts
    prompts/  classify.v1.md  identify_contract.v1.md  extract_fields.v1.md  extract_amendments.v1.md  extract_procedures.v1.md
    auth.ts                         caller JWT → membership check
  extract-contract/index.ts
  create-obligations/index.ts
  send-reminders/index.ts
  recalculate-deadlines/index.ts
```

- **Client sharing:** `apps/mobile/metro.config.js` adds `watchFolders: ['../supabase/functions/_shared']`; `tsconfig.json` adds `"@shared/*": ["../supabase/functions/_shared/*"]` and `allowImportingTsExtensions`. Shared files import only `zod` (bare specifier resolved by the Deno import map and by the app's node_modules). One source of truth, no mirroring. If Metro resolution proves awkward with NativeWind's wrapper, fallback is a `bun run sync-shared` copy step with a CI diff check.
- **Auth:** user-triggered functions use the caller's JWT to verify membership, then a service-role client only for writes RLS can't express. Cron-triggered functions require the secret key in the `apikey` header. Functions use the new publishable/secret keys (`SUPABASE_PUBLISHABLE_KEYS` / `SUPABASE_SECRET_KEYS`), never the legacy `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`, and run with `verify_jwt = false`, authorising in code.

### 4.1 Extraction pipeline (`extract-contract`)
Triggered by `register_contract_document()` (pg_net) and by the 5-minute cron. Each invocation claims one job step, does at most a time-boxed batch (≈20 pages, or ~100 s), writes the cursor, and re-invokes itself if work remains.

1. **Text:** PDF → `unpdf` per-page text. Pages below `aiConfig.ocr.min_chars_per_page` → split to single-page PDFs with `pdf-lib` → `OcrProvider`. Images → OCR directly. DOCX → `mammoth` raw text, page breaks from explicit `w:br type="page"` else estimated at ~3,000 chars/page (flagged as estimated in the UI). OCR quota checked/incremented atomically; exhausted → job `waiting_quota`. **PaddleOCR endpoint, auth and request format will be taken from the current docs during implementation, not guessed.**
2. **Classify:** heading/keyword rules per page (with carry-forward until the next heading); only unknown pages go to the `classify` task with a ≤600-char excerpt.
3. **Hard filter:** `general_conditions`, `specifications`, `bq`, `drawings_list` pages are never sent for field extraction (enforced in code with a unit test; preliminaries go only to `extract_procedures`).
4. **Identify contract** → `contract_form`, edition, with_quantities, option modules.
5. **Fields** from articles + appendix (+ supplementary agreements) using the zod schema generated from `contractFieldSchema.ts`.
6. **Amendments** from particular/special conditions → `draft_rules` with origin `amended`, citing clause/page.
7. **Procedures** from preliminaries → `draft_rules` with origin `project_procedure`.
8. **Write** `extracted_fields` (new proposals; same value as current confirmed → auto-marked as "no change", different → shown as diff), set `needs_review`.

Every LLM output item: `{ value | null, not_found_reason?, page_no, source_excerpt, confidence }`. Post-validation in code: `page_no` must be within the batch sent; `source_excerpt` ≤25 words **and must appear (fuzzy, whitespace-normalised) in that page's text**, otherwise the value is dropped to `not_found` and logged as a suspected invention. This is the main anti-hallucination guard beyond the prompt.

### 4.2 Provider layer
Per the brief's A5. Specifics:
- `ai-config.ts` exports `aiConfig = parseAiConfig({...})`; parse runs at import so a bad config throws on function boot, in `deno test`, and in a CI step (`deno run scripts/check-ai-config.ts`).
- Residency validated twice: load time (every task, fallback, escalation target, OCR) and request time (router refuses with `ResidencyError` if no allowed provider remains).
- Escalation re-runs only fields with `confidence < confidence_below` or that failed validation, sending just their page(s).
- Structured output: Anthropic tool use with forced `tool_choice`; OpenAI `response_format: json_schema` strict; Gemini `responseSchema`; OpenAI-compatible tries `json_schema`, falls back to `json_object` per a `structured_output` capability flag in the provider entry. Zod validation always.
- Base URLs, capability flags and model IDs looked up in each provider's current docs at implementation time.

### 4.3 `send-reminders`
Every 15 min: drain `obligation_queue`; mark due-passed `open` → `overdue` (+ suggested chains); compute due reminder keys per obligation from the project schedule (default: created, 50 %, 2 working days before, due date, daily overdue ×5; time-bar: + 5 working days before); insert into `reminders_sent` **first** (`on conflict do nothing` → only winners send); deliver through `ReminderChannel` interface (`expoPush`, `inApp`; `email` stub). Expo receipts with `DeviceNotRegistered` delete the token. Messages per brief, role-dependent, never sending a contractual notice; a "Draft notice" button produces editable text only.

---

## 5. Deadline calculator (pure TS)
- `computeServedAt(sentAt, settings, holidays)`: SGT; working day & before cut-off → same day, else next working day.
- `computeDueDate({ trigger, period, unit, includesPublicHolidays, capDays, holidays, settings })` → `{ due_at, explanation, warnings }`.
  - calendar days: add N days; working days: count Mon–Fri (opt. Sat) skipping holidays; weeks = 7×N calendar days; months: corresponding date, clamped to month end (31 Jan + 1 month → 28/29 Feb).
  - cap: `min(period, cap)` in the same unit as the cap (statute caps are calendar days); explanation names the cap source from rule data (e.g. "capped by SOP Act s11" comes from the rule's `cap_label`, not hard-coded).
  - due time: end of day 23:59:59 SGT on the due date (stated in explanation).
  - warning if any date in the span falls in a year with no holiday data.
- Deterministic: no `Date.now()`, no I/O; holidays and settings are arguments.

---

## 6. Screens (Expo Router, under `src/app/(app)/project/[id]/`)

The project screen gains a **Contract** tab (next to VOs / Details / Members) as the hub, with an overdue/time-bar count badge.

| Route | Screen |
|---|---|
| `contract/index.tsx` | Contract hub: required-fields progress, live/not-live banner, disclaimer, links below |
| `contract/documents.tsx` | Upload & status (document picker, per-file progress, live status via Realtime) |
| `contract/review.tsx` | Field review: grouped sections, low-confidence/not_found first, accept/edit/reject, "Accept all ≥ 0.9", diff cards |
| `contract/source.tsx` | PDF viewer modal (WebView + pdf.js, page + highlight) |
| `contract/rules.tsx` | Rule review: TODO_VERIFY first, enter period, verify, see overrides and their source |
| `deadlines/index.tsx` | Deadlines dashboard: overdue, due this week, later, suggested; time-bar flag (icon + label, not colour only) |
| `deadlines/log-event.tsx` | Log event: type picker (bottom sheet via existing `OptionSheet`), reference, date (default now), counterparty, attach photo/file |
| `vo/register.tsx` | VO register: filters, totals (agreed / pending / disputed), CSV export (share sheet) and PDF export (`expo-print`) |
| `vo/[voId].tsx` (extended) | Adds contractual timeline, amounts + history, open obligations, actions |
| `vo/new.tsx` (extended) | From scratch / from instruction event / "Record site instruction" |

New dependencies (installed with `npx expo install`, versions resolved for SDK 58, docs checked per AGENTS.md): `expo-document-picker`, `react-native-webview`, `expo-print`, `expo-sharing`, `zod`. Upload progress: Supabase Storage TUS resumable upload or signed upload URL + `expo-file-system` upload task, whichever SDK 58 docs support with progress events.

Push tap routing in `(app)/_layout.tsx` gets `obligation_reminder` → deadlines dashboard focused on that obligation.

---

## 7. Fixtures and eval
- `tests/fixtures/contracts/<name>/` × 4: synthetic packages I write (fictional parties, no real contract text): SIA-style lump sum, PSSCOC-style CW, REDAS-style, and one **scanned** (rasterised) PDF. Each has a known appendix, one amended clause, and some deliberately absent fields so `not_found` and invented-value rates are measurable. `expected.json` golden file each. PDFs generated by a script (`pdf-lib`) so they're reproducible.
- `scripts/eval-extraction.ts`: per spec A6; CLI pairs like `--model anthropic:claude-haiku-… --model openai:…`; override is in-memory only. Reports to `reports/extraction-eval-<date>.md|csv`. Invented-value rate is the headline column.
- CI uses recorded responses (`LLM_MODE=replay`, cassettes in `tests/fixtures/llm-recordings/`).

---

## 8. Test plan

| Layer | Tool | Covers |
|---|---|---|
| Calculator & rules | `deno test` | All calculator cases in the brief (SOPA 30→21, 10→10, none→14; calendar vs working over a PH; Fri 17:30 before PH Monday → Tue; 31 Jan + 1 month; amended beats default but capped) |
| Obligation logic | `deno test` (pure parts) + pgTAP | response closes only matching obligation; overdue + chains_to → `suggested`; EOT → completion-dependent recalculation |
| VO | pgTAP | valid/invalid transitions, amount history, contract sum with omissions, site instruction RPC |
| RLS | pgTAP | non-members see nothing; only contract roles confirm/verify; guests/viewers read only; private VO obligations hidden from non-participants |
| Extraction | `deno test` + replay | golden files, retry → escalation → `failed`, GC/spec/BQ pages never sent, excerpt-must-appear guard |
| Provider layer | `deno test` with mocked `fetch` | each adapter: structured output, JSON-mode fallback, usage parsing, error mapping; config invalid → throws; disallowed region rejected; task switch routes to new adapter; escalation only low-confidence fields; fallback on 5xx/timeout; residency `["SG"]` incl. fallback, escalation, OCR |
| OCR routing | `deno test` | text-layer pages never call OCR; image pages do; quota exhausted → `waiting_quota` |
| Integration | Deno script vs `supabase start` | upload → extraction (replay) → review → confirm → event → obligation → reminder → response → reminder cancelled; site instruction → reminder → instruction → valuation → agreed → contract sum |
| App | `npx expo lint`, `npx tsc --noEmit` | per AGENTS.md |

CI: add `.github/workflows/backend.yml` (deno fmt/lint/test, ai-config check, `supabase start` + `supabase test db`) and `mobile.yml` (lint + typecheck). Say if you don't want CI added.

---

## 9. Out of scope / known limits (v1)
- No email channel (interface only). No automatic sending of contractual notices, ever.
- Standard-form rule periods and clause refs ship as `TODO_VERIFY`; a contracts professional must fill them (listed in `docs/contracts-rules.md`).
- DOCX page numbers are estimates when the file has no explicit page breaks.
- Drawings and BQ are stored and classified but not analysed.
- Subcontract packages, multi-contract projects and non-English contracts.

---

## 10. Progress

### Phase 1: deadlines core — built 2026-11-20

| Piece | Where |
|---|---|
| Contract role + party per member | `apps/supabase/migrations/20261120130019_contract_roles.sql` |
| Fields, rules, events, obligations, reminders, RLS, RPCs, closing trigger | `…/20261120130020_deadlines.sql` |
| pg_cron → `send-reminders` every 15 min (Vault secrets) | `…/20261120130021_deadline_cron.sql` |
| Cron calls use the new secret API key (`apikey` header, Vault `secret_key`) | `…/20261120130022_cron_secret_key.sql` |
| Rule library (SOP Act, 7 standard forms as `TODO_VERIFY` placeholders, completion/DLP milestones) and MOM 2026–27 holidays | `apps/supabase/seed/rules/*.json`, `seed/public_holidays_sg.json` → `seed/deadlines.sql` (`deno task build-seed`) |
| Pure engine (calendar, calculator, precedence, planner, reminders) | `apps/supabase/functions/_shared/deadlines/` |
| Field schema, event types, rule file schema | `apps/supabase/functions/_shared/contracts/` |
| Edge Functions | `create-obligations`, `recalculate-deadlines`, `send-reminders` (+ `_shared/server/`) |
| App | Deadlines tab, Log event, deadline detail (incl. draft notice), Contract values + field editor, service settings, Rules list + rule editor/new rule, Members contract role/party, push tap routing |

Decisions made while building:
- Cron → Edge Function auth uses the new `sb_secret_` key in the `apikey` header (Vault secret `secret_key`); functions have `verify_jwt = false` and check the key or the caller's session themselves. No legacy `anon`/`service_role` keys anywhere (deprecated by end of 2026).
- `kind` on rules: `action` (missed → overdue) or `milestone` (a period that ends → met). Needed for the SOP Act dispute settlement period and the DLP end.
- Pseudo-triggers `completion_date` (anchored on confirmed completion + granted EOTs) and `chained` (only reached via `chains_to`, e.g. the SOP Act adjudication application).
- Obligations are unique per (project, rule group, trigger), so verifying a higher-precedence rule later updates the open obligation rather than duplicating it.
- SOP Act rules ship complete but as `draft`: a contract role verifies them with one tap. Nothing becomes live without a person verifying it.
- Contract data, events and obligations are visible to owners/members only (not guests/viewers); VO-linked ones to VO participants only.
- If no member is mapped to the responsible party, reminders go to whoever logged the trigger event.

Tests: `deno task test` (25: calculator cases from the brief, precedence, planner, reminders, and the engine flow against an in-memory DB). `apps/supabase/tests/deadlines_test.sql` (56 pgTAP assertions) passed in a PGlite run with Supabase stand-ins; **not yet run on `supabase test db`** (no Docker in the build environment).

Deploy:
1. `supabase db push`, then `psql "$DATABASE_URL" -f apps/supabase/seed/deadlines.sql` (idempotent; `supabase db reset` loads it locally).
2. Vault: `select vault.create_secret('<project url>', 'project_url'); select vault.create_secret('<sb_secret_… key named default>', 'secret_key');` (Dashboard > Settings > API Keys; not the legacy `service_role` key).
3. `supabase functions deploy create-obligations recalculate-deadlines send-reminders`
4. App: dev build needed only if not already on one (no new native modules besides `expo-document-picker`, which requires a rebuild).

Known limitations (phase 1):
- Expo push receipts are not polled; only `DeviceNotRegistered` on the immediate ticket deletes a token.
- The Android date/time dialogs use the device time zone; shown times are SGT. Fine for devices set to Singapore.
- Structured fields (performance bond, insurance, sectional completion…) are edited as JSON until extraction (phase 3) fills them.
- Rules whose verification is withdrawn leave their existing obligations in place (deadlines never vanish silently).
- No in-app notifications list yet; reminders open the deadline directly and are marked read there.

### Phase 2: VO contractual layer — built 2026-11-20

| Piece | Where |
|---|---|
| Contract status, amounts, time impact on `variation_orders`; transition table + guard trigger; `variation_amount_history` (append-only); `variation_payment_claims`; events move VOs along; RPCs `update_variation_contract`, `log_variation_event`, `record_site_instruction`, `link_variation_instruction`, `set_payment_claim_variations`, `project_contract_sum` | `apps/supabase/migrations/20261120130023_vo_contract.sql` |
| Lifecycle, transitions, contract-sum maths, VO completion extensions (pure, shared with the app) | `apps/supabase/functions/_shared/contracts/variations.ts` |
| Engine: VO time claim → suggested EOT notice (`anchor = 'variation'`); agreed VO time extends completion | `_shared/server/engine.ts` |
| App | VO register (filters, totals, whole-project contract sum for contract roles, CSV/PDF export), VO contract screen (amounts, next step, deadlines, timeline, documents, payment claims), contract update form, Create VO from scratch / from an instruction / site instruction, payment claim VO checklist in Log event, contract row in the VO thread, VO link on deadlines |

Decisions made while building:
- `contract_status` is separate from the internal sign-off `status` (pending/approved). Forward skips on the main line are allowed (e.g. instructed → valuation issued when no quotation is required); `disputed` can go back to `valuation_issued` (re-valuation) as well as to `agreed`. `agreed`, `rejected` and `withdrawn` are final. The SQL table and the TS list are checked against each other in pgTAP.
- Amounts are non-negative with an `is_omission` flag (omissions count negative in every total).
- Recording or changing anything agreed (status `agreed`, agreed amount, agreed time) needs a contract role; everything else needs owner/member and VO participation.
- VO amounts and history are visible to the VO's participants (including guests the sender chose to include), like the rest of the VO. Events, deadlines and payment-claim links stay owner/member only, as in phase 1.
- Withdrawing a VO waives its open deadlines (kept, with a note). Rejecting does not: an objection period may still be running.
- Agreed VO time extends the completion date unless the VO is tied to an EOT decision event (`eot_event_id`), which then carries it, so days are never counted twice.
- Creating a VO from an instruction moves that event (and its deadlines) into the VO, so it becomes private to the VO's participants.
- VO numbers stay auto-assigned (not editable) to keep the existing per-project numbering safe.
- The site-instruction and from-instruction flows don't require an approver (scratch VOs still do, as before).

Tests: `deno task test` (35: + transitions, contract sum with omissions, VO time → suggested EOT notice, agreed VO time → completion). `apps/supabase/tests/vo_contract_test.sql` (52). Full `supabase test db` run on the local stack: 14 files, 437 assertions, all pass (the phase 1 suite included, now run for real). The brief's integration scenario (site instruction → confirmation deadline → written confirmation closes it → quotation with time → suggested EOT notice → valuation → agreed → completion date and contract sum updated) was run against the local stack with the real engine.

Deploy:
1. `supabase db push` (migration 0023).
2. `supabase functions deploy create-obligations recalculate-deadlines send-reminders` (engine changes).
3. App: new native modules `expo-print`, `expo-sharing` → a new dev/production build is needed.

Known limitations (phase 2):
- Files can't be attached from the quick VO actions (quotation, valuation…); use "Log another event or attach a file" on the VO.
- The register's totals cover only VOs shared with you; the whole-project contract sum is for contract roles (totals only, no titles).
- Payment claims link agreed VOs only; there is no per-claim amount (cumulative claims usually repeat agreed VOs).
- No migration of existing VOs beyond `contract_status = 'identified'`.

### Phase 3: upload and extraction — built 2026-11-20

| Piece | Where |
|---|---|
| Private bucket `contract-documents` (50 MB; PDF, DOCX, JPEG, PNG), `contract_documents`, `extraction_jobs`, `document_pages`, `ocr_usage_daily`, `extraction_calls`, `extracted_fields`, `extraction_findings`, view `llm_usage_summary`, RLS, review RPCs, pipeline RPCs (claim with lease, OCR quota, one-transaction write), 1-minute cron, Realtime | `apps/supabase/migrations/20261120130024_contract_documents.sql` |
| Provider layer: `ai-config.ts` (the only file naming providers/models/URLs/prices/OCR), zod config schema with residency checks, adapters `anthropic` (official SDK, `output_config.format`), `openai` (Responses API, strict `json_schema`), `openai_compatible` (`json_schema` or JSON mode), router (retries with backoff, fallback, validation retry, escalation, request-time residency gate, call logging) | `apps/supabase/functions/_shared/llm/` |
| OCR interface + PaddleOCR official API client (one page per job) | `_shared/ocr/` |
| Section rules + hard filter, anti-invention guard, task schemas, merging/escalation planning, PDF/DOCX text | `_shared/extraction/` |
| Versioned, provider-neutral prompts (`*.v1.md`) | `_shared/prompts/` |
| Resumable pipeline (text → OCR → classify → identify → fields + escalation → amendments → procedures → write) and its Supabase I/O | `_shared/server/extraction.ts`, `extraction-io.ts`, `extract-contract/index.ts` |
| Config check | `deno task check-config` |
| App | Contract documents (multi-file picker, real upload progress, live status, warnings, retry), Review extracted values (check-first ordering, confidence badges, diff against the confirmed value, accept / edit / reject / not stated, accept all ≥ threshold, findings, link to draft rules), Source viewer (bundled pdf.js in a WebView at the cited page with the excerpt highlighted; page text with the excerpt marked for DOCX and images), field editor edits a proposal before confirming |

Decisions made while building:
- **Providers and residency.** Tasks run on Anthropic `claude-haiku-5-5` with `inference_geo: 'us'` (so the `US` label is accurate); escalation on OpenAI `gpt-6.1-terra` (`US`); fallback on Qwen `qwen3.8-flash` via the Model Studio Singapore endpoint (`SG`). No Google provider and no Google adapter (Q7). Allowed regions: SG, US, EU. Model IDs and prices were taken from the providers' pages on 2026-11-20; the Qwen price could not be confirmed, so its cost estimate is empty.
- **OCR is off by default.** The PaddleOCR official API is AI Studio (Baidu). I could not confirm a hosting region outside China, so it is labelled `CN`, which the residency policy rejects. Scanned pages are stored and flagged; the document shows a warning and values on those pages come back as not found. Turning OCR on is a data-residency decision: add `'CN'` to `allowed_provider_regions` and set `ocr.enabled: true`. The wire format came from the official SDK's source (`@paddleocr/api-sdk` 0.2.3), not guessed. Its daily quota (3,000 pages per model per day) is second-hand; check the AI Studio quota page.
- **Amendments and procedures become draft `deadline_rules`**, not a separate `draft_rules` table: an amendment that maps onto an existing rule group is copied from that group's contract rule with the new period (`origin 'amended'`, statute caps still apply through precedence); RFI / RFA / shop-drawing periods become `project_procedure` drafts. Both are reviewed and verified on the existing Rules screen. Anything that can't be mapped is kept as a finding for the reviewer (with "Add a rule" / "Dismiss").
- **Procedures are read from the preliminaries only** (not specifications), per the hard filter.
- A found value equal to the confirmed one is stored as `no_change` and needs no action; a "not found" from a later document is not stored when the field is already confirmed (a supplement not restating it is no news). Older open proposals for the same field are superseded.
- Confirming an unedited proposal keeps origin `extracted` with its document, page and excerpt; an edited value is stored as `user_entered` (the extracted value stays on the proposal for audit).
- pdf.js is bundled from its **legacy** build: the modern build needs `Uint8Array.prototype.toHex`, which older iOS / Android WebViews lack (found while testing the viewer).
- Pinned Edge Function dependencies to releases at least a few days old (`@anthropic-ai/sdk` 1.6.0, `unpdf` 2.1.0, `pdf-lib` 1.17.1, `mammoth` 1.13.0).

Tests: `deno task test` (64: + config validation and residency, strict JSON schema, each adapter against mocked HTTP incl. JSON-mode fallback and error mapping, router task switch / backoff / fallback / validation retry / escalation / SG-only, section rules and the hard filter, excerpt guard, and the pipeline end to end with in-memory I/O: OCR routing, quota wait and resume, validation → retry → escalation → failed, escalation of low-confidence fields only with only their pages, amendments and procedures → draft rules, resumability). `apps/supabase/tests/contract_documents_test.sql` (55). Full `supabase test db`: 15 files, 492 assertions, all pass. `scripts/integration-extraction.ts` ran upload → register → pipeline (real database and storage, scripted model) → review → accept-all → contract form loads the rules, against the local stack. `extract-contract` was also served in the local Edge Runtime: it read a 5-page PDF, classified it by rules, loaded the bundled prompts and, with no API key set, failed the job with a user-safe message. The source viewer was checked in headless Chromium (renders the cited page, highlights the excerpt). `npx tsc --noEmit` and `npx expo lint` pass.

Not tested: any call to a real LLM or OCR provider (no keys in this environment), and the app on a device.

Deploy:
1. `supabase db push` (migration 0024).
2. Secrets: `supabase secrets set ANTHROPIC_API_KEY=… OPENAI_API_KEY=… QWEN_API_KEY=…` (and `PADDLEOCR_ACCESS_TOKEN=…` only if OCR is turned on). Vault secrets from phase 1 are reused by the pg_net kick and the cron job.
3. `deno task check-config`, then `supabase functions deploy extract-contract`.
4. App: new native module `react-native-webview` → a new dev/production build. After changing the viewer template or upgrading pdfjs-dist: `npm run build:pdf-viewer`.

Known limitations (phase 3):
- OCR off by default (see above), so scanned contracts give mostly "not found" until it is turned on.
- DOCX page numbers are estimates (~3,000 characters per page); the viewer says so.
- One extraction batch is ~40,000 characters of pages; a very long appendix is split across batches and the best-cited value per field wins.
- The PDF viewer shows one page at a time (pinch to zoom, previous / next); text search across the document isn't offered.
- Extracted structured values (insurance list, sectional completion) can be edited only as JSON, as in phase 1.
- Eval harness, fixtures, `docs/contracts-rules.md` and `docs/ai-providers.md` are phase 4.

### Phase 4: eval harness, fixtures, docs — built 2026-11-23

| Piece | Where |
|---|---|
| 4 synthetic contract packages (fictional parties, my own wording): SIA 2016 lump sum, PSSCOC CW 2020, REDAS D&B, and a **scanned** PSSCOC-lite 2025 (image-only PDF). Each has a known appendix, one amended clause, timed procedures, never-send pages (GC / specs / BQ / drawings, each with a marker string) and deliberately absent fields | `apps/supabase/functions/tests/fixtures/contracts/<name>/` (`pages.md` → `contract.pdf`, `expected.json`, `oracle.json`) |
| Fixture builder: reproducible PDFs (fixed metadata), scan rasterised with Pillow, every golden excerpt checked against the text the pipeline really extracts | `scripts/build-fixtures.ts`, `scripts/rasterise-fixture.py` (`deno task build-fixtures [--check]`) |
| Eval harness: per-run config override (validated, residency still enforced, `ai-config.ts` never written), real pipeline with in-memory I/O, scoring, markdown + CSV reports | `scripts/eval-extraction.ts` (`deno task eval`), `eval/` |
| Record / replay of LLM and OCR responses (`LLM_MODE=record|replay`), hashed on provider, model, prompt, page text and schema | `eval/cassette.ts`, `tests/fixtures/llm-recordings/` |
| Golden baselines: per-field outcomes pinned per run; `deno task test` re-runs each and fails on any change | `tests/fixtures/eval-baselines/`, `tests/eval_test.ts` |
| `TODO_VERIFY` checklist generator | `scripts/list-todo-verify.ts` (`deno task list-todo-verify`) |
| Docs | `docs/contracts-rules.md`, `docs/ai-providers.md` |

Decisions made while building:
- **Scoring.** Every contract field is scored per fixture: a golden value → correct / wrong / missed / failed; not in the golden file → not found (correct) or **invented**. Fields the document is genuinely ambiguous about are listed in `ignore`. Free-text and list fields use keyword matching (`"match": "keywords"`); everything else is exact after the field's own zod schema (defaults such as currency SGD) and text normalisation. Invented values are the headline column, with every one listed in the report. "Caught by guard" counts the values the excerpt guard dropped, so a model that cites loosely is visible even when the guard saves it.
- **Each `--model` runs every task on that model with escalation and fallback off**, so the score is the model's own; `--keep-escalation` measures the configured chain instead.
- **No real-model recordings exist yet.** There are no API keys in this environment, so nothing was recorded from a real provider. The committed baseline is `oracle:reference`, a **scripted** stand-in that answers from the golden files with deliberate mistakes (an invention with a real excerpt, one with a made-up excerpt, a wrong value, an incomplete list, a computed completion date). It proves the harness, scoring, guard and hard filter end to end; it says nothing about any model. Pinning a real model is two commands (`docs/ai-providers.md`).
- **OCR in evals follows the residency policy too**: `--ocr` is refused unless `--allow-region CN` is also given, even for the scripted run.
- Amendments in the eval run against the rules a project on the golden form would have (copied from the seed files the same way `initialise_project_rules` does), i.e. as if the form had been confirmed before upload.
- `router.ts` now exports `adapterFor()` (same behaviour) so the harness can wrap real adapters for recording.
- Reports go to `apps/supabase/functions/reports/` (not git-ignored; nothing git-related was changed).

Tests: `deno task test` 73 (+9: fixtures valid and PDFs match their source, scoring rules, golden baselines reproduce, no never-send text reaches a model, the guard drops a made-up excerpt, scanned fixture with OCR off gives nothing invented and a warning, OCR needs its region allowed, run config never mutates `ai-config`, an SG-only policy refuses a US model, library rules for a form, record → replay round trip, recorded errors and latency, replay miss on a changed request). A mutation check (guard disabled) made the golden and guard tests fail as intended. `deno task check`, `deno lint`, `deno task check-config`, `deno task build-fixtures --check`, `npx tsc --noEmit` and `npx expo lint` pass. No migration or SQL changed, so pgTAP was not re-run.

Reference run (`deno task eval --model oracle:reference --ocr --allow-region CN`): accuracy 95/97, invented 2/88 (both scripted), caught by guard 2, amendments 4/4, procedures 6/6, never-send leaks 0. With OCR off (the default) the scanned fixture returns 0 values and 0 inventions, with the "OCR is turned off" warning.

---

## 11. Final summary

**Built (phases 1–4)**
- Deadlines: rule library (SOP Act complete; 7 standard forms as `TODO_VERIFY` placeholders; completion and DLP milestones), MOM 2026–27 holidays, pure calculator (calendar / working days, months, cut-off, statute caps, precedence), events, obligations with idempotent creation, closing by response events, chaining to suggested obligations, completion-date recalculation, reminders by push and in-app with idempotent delivery, pg_cron with Vault-held secret key.
- Variation orders: contractual status lifecycle beside the existing sign-off, enforced transitions, append-only amount history, site instructions, VO time → suggested EOT notice and agreed time → completion date, project contract sum for contract roles, payment-claim links, register with CSV / PDF export.
- Upload and extraction: private bucket, resumable job pipeline (text layer → OCR → rule-first classification → identify → fields with escalation → amendments → procedures → write), hard filter on never-send sections, excerpt guard against invented values, provider layer with three adapters, retries, fallback, escalation, residency at load and request time, call logging and a usage view; review screen with diffs, confidence, accept-all-above-threshold; source viewer (bundled pdf.js) jumping to the cited page with the excerpt highlighted.
- Eval: four synthetic fixtures (one scanned), golden files, harness with reports, record/replay, pinned baselines in the test suite, docs.

**Stubbed or off by default**
- Email reminder channel: interface only.
- OCR: implemented and tested with fakes, **off** because the service's region can't be confirmed outside CN.
- Standard-form rule periods, units and clause references: `TODO_VERIFY` until a contracts professional fills them (350 attributes, listed in `docs/contracts-rules.md`); SOP Act section references empty.
- Real-model eval numbers and recordings: none yet (no keys here).

**Known limitations** (details in each phase above)
- Not tested against any real LLM or OCR provider, and not run on a device.
- Expo push receipts not polled; Android date pickers use the device time zone.
- Structured values (insurance, sectional completion, …) are edited as JSON.
- DOCX page numbers are estimates; one-page-at-a-time PDF viewer without search.
- The register's totals cover only VOs shared with the viewer (the whole-project sum is for contract roles); payment claims link agreed VOs without per-claim amounts.
- Subcontracts, multi-contract projects and non-English contracts are out of scope.
