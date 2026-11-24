# Extraction eval, 2026-11-24

Synthetic fixtures (`tests/fixtures/contracts/`, fictional parties). Each run puts every extraction task on one provider/model for the run only; `ai-config.ts` is not changed.
Escalation and fallback: off (each score is the model's own). OCR: off. Allowed regions: SG, US, EU. Prompts: classify.v1, identify_contract.v2, extract_fields.v2, extract_amendments.v1, extract_procedures.v1.

## Summary

| Run | Mode | **Invented** | Caught by guard | Accuracy | Precision | Not found correct | Schema failures | Amendments | Procedures | Avg latency | Est. cost | Never-send leaks | Errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| anthropic:claude-haiku-5-5 | record | **0 (0.0%)** | 0 | 78/97 (80.4%) | 97.5% | 88/88 (100.0%) | 0.0% of 13 calls | 0/4 | 5/6 | 7625 ms | $0.0141 | 0 | 0 |

- **Invented**: a value returned where the document states none (golden answer: not found), after the excerpt guard. Lower is better; this is the number that matters most.
- **Caught by guard**: values the model returned whose excerpt was not on the cited page; the pipeline dropped them to not found and flagged them for review.
- **Accuracy**: correct values / values the document states. **Precision**: correct / values returned.
- **Schema failures**: calls whose output failed validation (each is retried once with the error).
- **Never-send leaks**: model calls containing general conditions, specification, BQ or drawing-list text (must be 0).

## Per fixture

| Run | Fixture | Correct | Wrong | Missed | Failed | Not found OK | **Invented** | Caught | Pages cited right | Amend. | Proc. | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| anthropic:claude-haiku-5-5 | psscoc-cw | 27 | 1 | 0 | 0 | 18 | **0** | 0 | 27/27 | 0/1 | 1/1 |  |
| anthropic:claude-haiku-5-5 | redas-db | 26 | 0 | 0 | 0 | 21 | **0** | 0 | 26/26 | 0/1 | 2/2 |  |
| anthropic:claude-haiku-5-5 | scanned-psscoc-lite | 0 | 0 | 16 | 0 | 29 | **0** | 0 | 0/0 | 0/1 | 0/1 | 5 pages have no text layer and could not be read: OCR is turned off. Values on those pages will show as not found. No articles of agreement or appendix pages were found, so the contract form could not be identified. No appendix, articles or particular conditions pages were found. |
| anthropic:claude-haiku-5-5 | sia-lump-sum | 25 | 1 | 1 | 0 | 20 | **0** | 0 | 25/25 | 0/1 | 2/2 |  |

## Invented values

None.

## Wrong values

| Run | Fixture | Field | Expected | Returned | Page |
|---|---|---|---|---|---|
| anthropic:claude-haiku-5-5 | psscoc-cw | gst_treatment | "Contract Sum exclusive of GST" | "Contract Sum excludes GST" | 1 |
| anthropic:claude-haiku-5-5 | sia-lump-sum | gst_treatment | "Contract Sum exclusive of GST" | "Contract sum excludes GST" | 2 |

## Per field

Correct / stated, and invented / absent, across fixtures.

| Field | anthropic:claude-haiku-5-5 |
|---|---|
| Contract form (`contract_form`) | 3/4 |
| Edition (`edition`) | 2/3 |
| With quantities (`with_quantities`) | 2/2 |
| Contract title (`contract_title`) | 2/2 |
| Employer (`employer_name`) | 3/4 |
| Contractor (`contractor_name`) | 3/4 |
| Contract administrator role (`contract_administrator_role`) | 3/4 |
| Contract administrator (`contract_administrator_name`) | 3/4 |
| Quantity surveyor (`qs_name`) | 1/1 |
| Date of contract (`date_of_contract`) | 3/4 |
| Letter of award date (`letter_of_award_date`) | 1/1 |
| Contract sum (`contract_sum`) | 3/4 |
| GST treatment (`gst_treatment`) | 1/4 |
| Retention (`retention_percent`) | 3/4 |
| Retention limit (`retention_limit`) | 3/4 |
| Performance bond (`performance_bond`) | 3/3 |
| Performance bond expiry (`performance_bond_expiry_basis`) | 2/2 |
| Advance payment (`advance_payment`) | 1/1 |
| Fluctuation (`fluctuation`) | 1/2 |
| Provisional sums total (`provisional_sums_total`) | 1/1 |
| Prime cost sums total (`prime_cost_sums_total`) | · |
| Commencement / possession of site (`date_of_commencement`) | 3/4 |
| Completion date (`completion_date`) | 2/3 |
| Contract period (`contract_period`) | 1/1 |
| Sectional completion (`sectional_completion`) | 1/1 |
| Liquidated damages rate (`liquidated_damages_rate`) | 3/4 |
| LD cap (`ld_cap`) | 1/1 |
| Defects liability period (`defects_liability_period`) | 3/4 |
| Maintenance period (`maintenance_period`) | · |
| Interim claim frequency (`interim_payment_claim_frequency`) | 3/3 |
| Interim claim day of month (`interim_payment_claim_day`) | 2/2 |
| Payment response period (`payment_response_period`) | 1/1 |
| Payment period after certificate (`payment_period_after_certificate`) | · |
| Final account submission period (`final_account_submission_period`) | 1/1 |
| Final certificate period (`final_certificate_period`) | · |
| Variation valuation basis (`variation_valuation_basis`) | 1/1 |
| Daywork rates reference (`daywork_rates_reference`) | 1/1 |
| Contractor quotation required (`contractor_quotation_required`) | · |
| Notice of claim period (`notice_of_claim_period`) | · |
| Oral instruction confirmation period (`oral_instruction_confirmation_period`) | 1/1 |
| Objection to valuation period (`objection_to_valuation_period`) | · |
| Insurance (`insurance_requirements`) | 1/1 |
| Nominated subcontractors (`nominated_subcontractors`) | 1/1 |
| Dispute resolution (`dispute_resolution`) | 2/2 |
| Option modules (`option_modules`) | 1/1 |
| Definition of "days" (`time_unit_definition`) | 1/1 |
| Site address (`site_address`) | 2/2 |
| Project name (`project_name`) | 1/2 |
| Currency (`currency`) | 1/1 |
