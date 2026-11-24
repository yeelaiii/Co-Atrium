# Contract default rules: status

Where the standard-form deadline rules (`apps/supabase/seed/rules/*.json`) stand after filling the `TODO_VERIFY` values from the forms in `docs/contracts/` on 2026-11-24.

Deadlines are an aid only. Every value below still needs checking against the form by a contracts professional before a rule is verified. Each rule's `notes` cites the clause it came from, and each file's `source` names the document used.

## Summary

- 202 of the 350 `TODO_VERIFY` values were filled in, leaving 148.
- 100 of the 148 belong to REDAS and SIA 2016 design and build, which have no source document in `docs/contracts/`.
- The other 48 belong to rules that the form has nothing for, or where the form starts the clock from a different event than the app's trigger.
- The seed was rebuilt (`deno task build-seed`) and applied to the local database. Deno tests (73) and database tests (492) pass.

## Sources used

| Rule file | Document(s) |
|---|---|
| `psscoc_cw_2020.json` | `1-psscoc-for-construction-works-2020.pdf` (8th Ed Jul 2020, with later amendments), `3-list-of-amendments-…`, `2-supplement-…` (Appendix) |
| `psscoc_db_2020.json` | `8-psscoc-for-design-build-2020.pdf` (7th Ed Jul 2020, with later amendments), `10-list-of-amendments-…`, `9-supplement-…` (Appendix) |
| `psscoc_lite_cw_2025.json` | `6-1_psscoc-lite_constnwks.pdf` (March 2025), `7-supplement-…` (Appendix) |
| `psscoc_lite_db_2025.json` | `13-4_psscoc-lite_db.pdf` (March 2025), `14-supplement-…` (Appendix) |
| `sia_2016_lump_sum.json` | `SIA_Building_Contract_2016_Without_Quantities_Domestic_1st_ED_EA.pdf` (1st Ed Nov 2016, EA Jul 2017) |

The amendment lists and supplements were checked: none of them changes a clause these rules rely on. The supplements only cover Appendix items (security deposit, defects liability period, advance payment and similar).

## What was filled in

"Days" are calendar days with public holidays counted. The clause each value comes from is in the rule's `clause_ref`.

| Rule | PSSCOC 2020 (construction works and design and build) | PSSCOC-lite 2025 (both) | SIA 2016 lump sum |
|---|---|---|---|
| Payment response | 14 days (32.2(1)) | 14 days (32.2(1)) | 21 days (40(3)) |
| EOT notice | 60 days, time bar (14.3(1)) | 60 days, time bar (14.3(1)) | 28 days, time bar (23(3)(a)) |
| EOT decision | 60 days (14.3(1)) | 60 days (14.3(1)) | not filled ① (23(3)(d)) |
| Oral instruction confirmation | 3 working days (2.5) | 3 working days (2.5) | 7 days, time bar (1(2)(b)) |
| Instruction objection | 14 days (19.2) | 14 days (19.2) | 28 days, time bar (1(4)(b)) |
| Variation claim notice | not in form | not in form | 7 days (12(5)(b)) |
| Variation valuation | not filled ① (20.2(2)(d)) | 30 days (20.2(2)(c)) | not in form |
| Valuation objection | 30 days, time bar (20.2(2)(e)) | not in form | not in form |
| Final account submission | 90 days, time bar (32.4(1)) | not filled ① (32.4(1)) | not filled ② (31(9)) |
| Defects rectification | 14 days (2.6) | 14 days (2.6) | 7 days (27(3)(c)(i), 1(6)(a)) |

① **Trigger mismatch.** The form starts the clock from a different event than the app's trigger, so a period here would give the wrong date. The other fields are filled; only `period` is still `TODO_VERIFY`.
- PSSCOC 2020 variation valuation: the SO has 60 days from *his certification that the variation works are substantially complete*, not from a quotation.
- PSSCOC-lite final account: 30 days from the *later of the end of the defects liability period or the Date of Substantial Completion*, not from the completion certificate.
- SIA EOT decision: the Architect answers on receipt of the notice, and within 28 days of a *contractor request that cites clause 23(3)(d)*. There is no fixed period from the notice itself.

② **No fixed period.** SIA 31(9)(a): the Final Account Claim is due after completion and the last statutory approval, or before the end of the Maintenance Period, whichever is later. Not submitting it waives the right (31(9)(d)), so `is_time_bar` and `clause_ref` are filled; `period`, `unit` and `includes_public_holidays` are not.

**Not in form**: the form has no matching obligation or no time limit for it. All five values stay `TODO_VERIFY` and the note explains why:
- PSSCOC 2020 variation claim notice: quotations are only submitted when the SO asks (19.3, no period), and the notice of claims in 23.1 excludes Clause 20 variations.
- PSSCOC-lite variation claim notice: 19.3 is intentionally left blank; the contractor submits a valuation only on completion of the varied works (20.2(2)(b), no period).
- PSSCOC-lite valuation objection: a disagreement is referred to the SO under 35.1, with no time limit (20.2(2)(d)).
- SIA variation valuation: the QS values variations in Interim Certificates under clause 31; clause 12 sets no period.
- SIA valuation objection: clause 12 sets no period to object.

## Judgement calls to review

- **SIA mapping.** The only SIA building contract in the folder is the *Without Quantities* edition. It was treated as the lump sum form (`sia_2016_lump_sum.json`).
- **PSSCOC working days.** PSSCOC defines working days as excluding only Sundays and public holidays, so Saturdays count. The app's calendar excludes Saturdays by default (`saturdayIsWorkingDay: false`). Unless a PSSCOC project turns that setting on, the 3-working-day oral instruction deadline comes out later than the contract allows.
- **Defects rectification.** Neither form sets a direct period for remedying a notified defect.
  - PSSCOC: 18.1(b) has no period, so clause 2.6 was used: the Employer may bring in others if an instruction isn't complied with within 14 days (or the period stated in the instruction).
  - SIA: defects are made good "forthwith". Clauses 27(3)(c)(i) and 1(6)(a) let the Employer bring in others 7 days after the Architect's written notice requiring compliance.
- **PSSCOC 2020 final account as a time bar.** Claims not substantiated in the Final Payment Claim are barred (32.4(2)), so it is marked as a time bar. Late submission by itself does not lose the right: the SO issues the Interim Final Account anyway (32.5(2)).
- **PSSCOC instruction objection.** Clause 19.2 (notify within 14 days that an instruction is a variation) was treated as the objection. It is not stated as a condition precedent, so `is_time_bar` is false.
- **PSSCOC 2020 final account start date.** The 90 days run from the Date of Substantial Completion stated in the certificate, which can be earlier than the date the certificate is issued.
- **SIA payment response party.** Under SIA 40(3) the Employer serves the payment response, but the rule assigns it to the contract administrator.

## Other changes made

- `docs/contracts-rules.md`: the TODO_VERIFY checklist was regenerated (`deno task list-todo-verify`), with a note on where the values came from.
- `apps/supabase/functions/tests/eval_test.ts` and `apps/supabase/tests/deadlines_test.sql`: these assumed SIA lump sum `eot_notice` was still unfilled. They now use `sia2016_ls.variation_valuation`, which is still fully `TODO_VERIFY`.
- `apps/supabase/seed/deadlines.sql`: rebuilt, and applied to the local database. No local project had a copy of these rules, so none were left on the old values.
- `library_version` stays `2026.1` (edited in place, on the assumption that the rules have not shipped).

## What's left to do

1. **Professional review.** A contracts professional checks every filled value against the form, especially the judgement calls above.
2. **REDAS and SIA 2016 design and build.** Get copies of both forms, then fill `redas.json` and `sia_2016_db.json` (100 values).
3. **Trigger mismatches (①).** For each, either change the rule's trigger (for example a new event such as "variation works certified complete", or anchor the PSSCOC-lite final account on the end of the defects liability period) and then enter the period, or reject the rule for that form.
4. **SIA final account (②).** Decide how to model "the later of completion plus last statutory approval, or the end of the Maintenance Period", or leave it as a manual reminder.
5. **"Not in form" rules.** Reject them on the Rules screen per project, or remove them from that form's seed file.
6. **PSSCOC calendar.** Make PSSCOC projects count Saturdays as working days, for example by defaulting `saturdayIsWorkingDay` to true when the contract form is a PSSCOC form.
7. **Also not yet checked** (from `docs/contracts-rules.md`):
   - `sopa.json`: the SOP Act periods and the empty section references need confirming against the current Act.
   - `public_holidays_sg.json`: refresh from the Ministry of Manpower list each year.
8. **Hosted database.** Apply the seed with `psql "$DATABASE_URL" -f apps/supabase/seed/deadlines.sql`. Projects that already confirmed a contract form keep their old draft copies of the rules (`initialise_project_rules` does not overwrite them), so update those on the Rules screen.
9. **After any further edits** to the rule files, run `deno task build-seed`, re-run `deno task list-todo-verify` into `docs/contracts-rules.md`, and run `deno task test` and `supabase test db`.
