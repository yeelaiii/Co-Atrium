# Contract rules, fields and prompts

How the deadline rules, the contract fields and the extraction prompts are organised, how to add to them, and the checklist of `TODO_VERIFY` items a contracts professional must check.

Deadlines and extracted values are an aid only. Users must check them against their contract; nothing here is legal advice.

## Where things live

| What | File | Notes |
|---|---|---|
| Contract forms | `apps/supabase/functions/_shared/contracts/contractFieldSchema.ts` (`CONTRACT_FORMS`, `CONTRACT_FORM_LABEL`) | The only list of forms. The app imports it through `@shared/…`. |
| Contract fields | same file (`CONTRACT_FIELDS`, `REQUIRED_FIELDS`) | Shared by extraction, the review screen, manual entry and the deadline engine. Stored as JSONB, so a new field needs no migration. |
| Rule library | `apps/supabase/seed/rules/*.json` (one file per form, plus `sopa.json` and `common.json`) | Validated by `_shared/contracts/ruleSchema.ts`; compiled to `seed/deadlines.sql` by `deno task build-seed`. |
| Event types | `_shared/contracts/eventTypes.ts` | Triggers and closing events a rule may name. |
| Precedence and caps | `_shared/deadlines/rules.ts` | amended > project procedure = user defined > standard form default; statute caps applied last. |
| Prompts | `_shared/prompts/<task>.<version>.md`, versions in `_shared/prompts/index.ts` | Provider-neutral plain text. |

All commands below run from `apps/supabase/functions` (Deno is not on the PATH in every environment; use your Deno 2.x binary).

## How a rule becomes a deadline

1. A project confirms its `contract_form`. `private.initialise_project_rules()` copies every library rule whose `applies_to_contract_forms` includes that form into `deadline_rules` as **draft**.
2. A contract role (QS, PM or contract administrator) verifies each rule on the Rules screen. A rule with any `TODO_VERIFY` attribute **cannot** be verified (database check constraint) until someone enters the value.
3. Uploaded documents may add **draft** `amended` rules (from particular conditions) and `project_procedure` rules (RFI, RFA, shop drawings from the preliminaries). They also need verifying.
4. Only verified rules and confirmed fields generate live obligations. Per rule group the highest-precedence verified rule wins; a statute cap (SOP Act) still applies on top.

A rule's period comes from, in order: its own `period`; the confirmed contract field named in `period_field` (for example `payment_response_period`); its `default_period` (used only by the SOP Act "no period stated" case). Periods are never hard-coded in logic.

## Add a standard form

1. Add the enum value to `CONTRACT_FORMS` and a label to `CONTRACT_FORM_LABEL` in `contractFieldSchema.ts`. Nothing in the database constrains the list, so no migration is needed.
2. Copy the closest `seed/rules/<form>.json` to a new file. For each rule set `rule_key` (`<form_prefix>.<group_key>`), keep `group_key` the same as the equivalent rule in other forms (that is how amendments and precedence find it), and set `applies_to_contract_forms` to the new form only.
3. Write `"TODO_VERIFY"` for every period, unit, public-holiday flag, time-bar flag and clause reference you have not checked against the form itself. **Do not guess.** The seed builder turns each one into `null` plus an entry in `todo_verify`.
4. If the SOP Act or the milestone rules apply (they do for every Singapore form), add the new form to `applies_to_contract_forms` in `sopa.json` and `common.json`.
5. `deno task build-seed` (validates every file, checks `chains_to` targets, writes `seed/deadlines.sql`), then apply it: `supabase db reset` locally, or `psql "$DATABASE_URL" -f apps/supabase/seed/deadlines.sql` on a hosted project (idempotent upserts).
6. If extraction should recognise the form, mention it in `identify_contract` (new prompt version, see below) and add a fixture for it in `tests/fixtures/contracts/`.
7. Re-run `deno task list-todo-verify` and paste the output into the checklist below.

To change a rule that has shipped, bump `library_version` (e.g. `2026.1` → `2026.2`) rather than editing it in place: projects keep the copy they were initialised with, and new projects get the newest version per `rule_key`.

## Add a contract field

1. Add an entry to `CONTRACT_FIELDS` with `f(key, label, section, kind, schema, { hint?, options?, foundIn? })`:
   - `kind` decides the edit form and display. Reusing an existing kind (`text`, `date`, `money`, `percent`, `period`, `boolean`, `percent_or_amount`, `ld_rate`, `day_of_month`, `text_list`, `enum`, `object`, `object_list`) needs no app change. A new kind needs an editor in `mobile/src/app/(app)/project/[id]/contract/field/[key].tsx` and formatting in `mobile/src/lib/contract-fields.ts`.
   - `foundIn` lists the package sections where the value normally appears. Extraction only asks for a field when a page from one of those sections is in the batch. General conditions, specifications, BQ and drawings can never be listed (they are never sent to a model).
   - `hint` is shown in the prompt's field list and the edit form. Keep it short and factual.
2. If deadlines depend on it, add it to `REQUIRED_FIELDS` and/or reference it from a rule's `period_field`.
3. If its enum values need friendly names, add them to `ENUM_LABEL` in `mobile/src/lib/contract-fields.ts`.
4. Add it to at least one fixture's `expected.json` (or leave it out deliberately so the eval checks it comes back not found), run `deno task build-fixtures --check` and `deno task test`. The golden test will fail if the field changes any pinned outcome; re-pin with `deno task eval --model oracle:reference --update-baseline` once you have checked the new numbers.

No migration and no prompt change are needed: the field list in the prompt (`{{FIELDS}}`) and the JSON schema sent to the model are generated from `CONTRACT_FIELDS`.

## How prompts are versioned

- Each task has one file per version: `_shared/prompts/<task>.<version>.md` (`classify`, `identify_contract`, `extract_fields`, `extract_amendments`, `extract_procedures`). Placeholders such as `{{FIELDS}}` and `{{RULE_GROUPS}}` are filled at run time; an unfilled placeholder throws.
- To change a prompt, **add** `<task>.v2.md` (never edit a released version in place) and change `PROMPT_VERSIONS` in `_shared/prompts/index.ts`. Every `extraction_calls` row records the version used (`extract_fields.v2`), so results stay traceable.
- Prompts are provider-neutral plain text: no provider-specific tags or syntax. Structured output is the adapter's job.
- Before switching versions, compare them: run the eval on recorded or live calls with each version (`deno task eval --model …`) and look at invented values first. A new prompt changes the request hash, so existing recordings become replay misses: re-record (`LLM_MODE=record`) and re-pin the baselines.
- Old prompt files stay in the repo so earlier `extraction_calls` rows can be read against the exact text.

## TODO_VERIFY checklist

Every item below must be checked against the published form by someone qualified, and the value entered in the seed file (then rebuild the seed) or per project on the Rules screen. Until then the rule stays draft and generates no deadline.

Also check, although not marked `TODO_VERIFY`:
- `seed/rules/sopa.json`: the SOP Act periods (payment response 14 days default, 21-day cap; dispute settlement period 7 days; adjudication application 7 days) come from the product brief, and the section references are deliberately empty. Confirm both against the current Act and add the references.
- `seed/public_holidays_sg.json`: refresh each year from the Ministry of Manpower list (the calculator warns when a date falls in a year with no holiday data).
- `seed/rules/common.json` (completion and defects liability milestones) takes its periods from the confirmed contract fields, so it has nothing to verify.

Values for PSSCOC CW 2020, PSSCOC D&B 2020, PSSCOC-lite CW and D&B 2025 and SIA 2016 lump sum were taken from the forms in `docs/contracts/` on 2026-11-24 (each file's `source`, each rule's `notes` gives the clause). They still need checking by a contracts professional before rules are verified. Note: PSSCOC "working days" exclude only Sundays and public holidays, so PSSCOC projects should count Saturdays as working days. No REDAS or SIA 2016 design-and-build form was available, so those files are untouched.

Generated by `deno task list-todo-verify`:

148 TODO_VERIFY attributes in 9 rule files.

#### `seed/rules/psscoc_cw_2020.json`: PSSCOC Construction Works 2020 (library 2026.1)

| Rule key | Obligation | To check | Reviewer note |
|---|---|---|---|
| `psscoc_cw2020.variation_claim_notice` | Give notice of claim or a quotation for the variation | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Not found in PSSCOC Construction Works 2020: quotations are submitted only when the SO asks (19.3, no period) and notice of claims under 23.1 excludes Clause 20 variations. Consider rejecting this rule for this form. |
| `psscoc_cw2020.variation_valuation` | Value the variation | `period` | Trigger mismatch: PSSCOC Construction Works 2020 cl 20.2(2)(d) gives the SO 60 days from his certification that the variation works are substantially complete, not from a quotation. Period left TODO_VERIFY until the trigger is decided. |

#### `seed/rules/psscoc_db_2020.json`: PSSCOC Design and Build 2020 (library 2026.1)

| Rule key | Obligation | To check | Reviewer note |
|---|---|---|---|
| `psscoc_db2020.variation_claim_notice` | Give notice of claim or a quotation for the variation | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Not found in PSSCOC Design and Build 2020: quotations are submitted only when the SO asks (19.3, no period) and notice of claims under 23.1 excludes Clause 20 variations. Consider rejecting this rule for this form. |
| `psscoc_db2020.variation_valuation` | Value the variation | `period` | Trigger mismatch: PSSCOC Design and Build 2020 cl 20.2(2)(d) gives the SO 60 days from his certification that the variation works are substantially complete, not from a quotation. Period left TODO_VERIFY until the trigger is decided. |

#### `seed/rules/psscoc_lite_cw_2025.json`: PSSCOC-lite 2025 (construction works) (library 2026.1)

| Rule key | Obligation | To check | Reviewer note |
|---|---|---|---|
| `psscoc_lite_cw2025.variation_claim_notice` | Give notice of claim or a quotation for the variation | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Not found in PSSCOC-lite Construction Works 2025: 19.3 (quotations) is intentionally left blank and the Contractor submits his valuation only on completion of the varied works (20.2(2)(b), no period). Consider rejecting this rule for this form. |
| `psscoc_lite_cw2025.valuation_objection` | Object to the valuation of the variation, if you dispute it | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Not found in PSSCOC-lite Construction Works 2025: 20.2(2)(d) says a disagreement is referred to the SO under 35.1, with no time limit. Consider rejecting this rule for this form. |
| `psscoc_lite_cw2025.final_account_submission` | Submit the final account | `period` | Trigger mismatch: PSSCOC-lite Construction Works 2025 cl 32.4(1): Final Payment Claim within 30 days of the expiry of the Defects Liability Period or the Date of Substantial Completion, whichever is later, not from the completion certificate. Period left TODO_VERIFY. |

#### `seed/rules/psscoc_lite_db_2025.json`: PSSCOC-lite 2025 (design and build) (library 2026.1)

| Rule key | Obligation | To check | Reviewer note |
|---|---|---|---|
| `psscoc_lite_db2025.variation_claim_notice` | Give notice of claim or a quotation for the variation | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Not found in PSSCOC-lite Design and Build 2025: 19.3 (quotations) is intentionally left blank and the Contractor submits his valuation only on completion of the varied works (20.2(2)(b), no period). Consider rejecting this rule for this form. |
| `psscoc_lite_db2025.valuation_objection` | Object to the valuation of the variation, if you dispute it | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Not found in PSSCOC-lite Design and Build 2025: 20.2(2)(d) says a disagreement is referred to the SO under 35.1, with no time limit. Consider rejecting this rule for this form. |
| `psscoc_lite_db2025.final_account_submission` | Submit the final account | `period` | Trigger mismatch: PSSCOC-lite Design and Build 2025 cl 32.4(1): Final Payment Claim within 30 days of the expiry of the Defects Liability Period or the Date of Substantial Completion, whichever is later, not from the completion certificate. Period left TODO_VERIFY. |

#### `seed/rules/redas.json`: REDAS (library 2026.1)

| Rule key | Obligation | To check | Reviewer note |
|---|---|---|---|
| `redas.payment_response` | Respond to the interim payment claim (payment response or certificate) | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | SOP Act cap applies on top (sopa.payment_response). Check who must respond under this form and whether the appendix sets the period. |
| `redas.eot_notice` | Give notice of a delaying event and claim an extension of time | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Check whether late notice bars the claim (time bar). |
| `redas.eot_decision` | Decide on the extension of time claim | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` |  |
| `redas.oral_instruction_confirmation` | Confirm the oral instruction in writing | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` |  |
| `redas.instruction_objection` | Object to the instruction, if you dispute it | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` |  |
| `redas.variation_claim_notice` | Give notice of claim or a quotation for the variation | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Only where the form or appendix requires a quotation or notice of claim. |
| `redas.variation_valuation` | Value the variation | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` |  |
| `redas.valuation_objection` | Object to the valuation of the variation, if you dispute it | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` |  |
| `redas.final_account_submission` | Submit the final account | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Also verify the trigger: the period may run from a later certificate (e.g. end of defects liability). |
| `redas.defects_rectification` | Rectify the notified defect | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` |  |

#### `seed/rules/sia_2016_db.json`: SIA Building Contract 2016 (design and build) (library 2026.1)

| Rule key | Obligation | To check | Reviewer note |
|---|---|---|---|
| `sia2016_db.payment_response` | Respond to the interim payment claim (payment response or certificate) | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | SOP Act cap applies on top (sopa.payment_response). Check who must respond under this form and whether the appendix sets the period. |
| `sia2016_db.eot_notice` | Give notice of a delaying event and claim an extension of time | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Check whether late notice bars the claim (time bar). |
| `sia2016_db.eot_decision` | Decide on the extension of time claim | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` |  |
| `sia2016_db.oral_instruction_confirmation` | Confirm the oral instruction in writing | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` |  |
| `sia2016_db.instruction_objection` | Object to the instruction, if you dispute it | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` |  |
| `sia2016_db.variation_claim_notice` | Give notice of claim or a quotation for the variation | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Only where the form or appendix requires a quotation or notice of claim. |
| `sia2016_db.variation_valuation` | Value the variation | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` |  |
| `sia2016_db.valuation_objection` | Object to the valuation of the variation, if you dispute it | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` |  |
| `sia2016_db.final_account_submission` | Submit the final account | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Also verify the trigger: the period may run from a later certificate (e.g. end of defects liability). |
| `sia2016_db.defects_rectification` | Rectify the notified defect | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` |  |

#### `seed/rules/sia_2016_lump_sum.json`: SIA Building Contract 2016 (lump sum) (library 2026.1)

| Rule key | Obligation | To check | Reviewer note |
|---|---|---|---|
| `sia2016_ls.eot_decision` | Decide on the extension of time claim | `period` | Trigger mismatch: SIA Building Contract 2016 (Without Quantities, 1st Ed EA) cl 23(3)(d): Architect says whether the event entitles an EOT on receipt of the notice, and within 28 days of a Contractor request citing this clause. No fixed period from the notice itself. |
| `sia2016_ls.variation_valuation` | Value the variation | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Not found in SIA Building Contract 2016 (Without Quantities, 1st Ed EA): the QS values variations in Interim Certificates under cl 31; cl 12 sets no period for the valuation. |
| `sia2016_ls.valuation_objection` | Object to the valuation of the variation, if you dispute it | `period`, `unit`, `includes_public_holidays`, `is_time_bar`, `clause_ref` | Not found in SIA Building Contract 2016 (Without Quantities, 1st Ed EA): cl 12 sets no period to object to a valuation. Consider rejecting this rule for this form. |
| `sia2016_ls.final_account_submission` | Submit the final account | `period`, `unit`, `includes_public_holidays` | No fixed period: SIA Building Contract 2016 (Without Quantities, 1st Ed EA) cl 31(9)(a): Final Account Claim after completion and the last statutory instrument, or before the end of the Maintenance Period, whichever is later. 31(9)(d): not submitting it waives rights. |

