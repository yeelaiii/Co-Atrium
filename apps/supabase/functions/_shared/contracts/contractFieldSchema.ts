// Contract field definitions, shared by the Edge Functions (extraction, obligations) and the app
// (review and manual entry). Adding a field here needs no migration: values are stored as JSONB in
// extracted_fields / project_contract_fields and validated with these schemas.

import { z } from 'zod';

export const CONTRACT_FORMS = [
  'SIA_2016_LUMP_SUM',
  'SIA_2016_DB',
  'PSSCOC_CW_2020',
  'PSSCOC_DB_2020',
  'PSSCOC_LITE_CW_2025',
  'PSSCOC_LITE_DB_2025',
  'REDAS',
  'BESPOKE',
  'UNKNOWN',
] as const;
export type ContractForm = (typeof CONTRACT_FORMS)[number];

export const CONTRACT_FORM_LABEL: Record<ContractForm, string> = {
  SIA_2016_LUMP_SUM: 'SIA Building Contract 2016 (lump sum)',
  SIA_2016_DB: 'SIA Building Contract 2016 (design and build)',
  PSSCOC_CW_2020: 'PSSCOC Construction Works 2020',
  PSSCOC_DB_2020: 'PSSCOC Design and Build 2020',
  PSSCOC_LITE_CW_2025: 'PSSCOC-lite 2025 (construction works)',
  PSSCOC_LITE_DB_2025: 'PSSCOC-lite 2025 (design and build)',
  REDAS: 'REDAS',
  BESPOKE: 'Bespoke contract',
  UNKNOWN: 'Unknown',
};

const periodUnit = z.enum(['calendar_days', 'working_days', 'weeks', 'months']);
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const money = z.object({ amount: z.number().finite(), currency: z.string().length(3).default('SGD') });
const percentOrAmount = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent'), value: z.number().min(0).max(100) }),
  z.object({ kind: z.literal('amount'), value: z.number().min(0), currency: z.string().length(3).default('SGD') }),
]);
const shortText = z.string().trim().min(1).max(500);

export const valueSchemas = {
  text: shortText,
  date: localDate,
  money,
  percent: z.number().min(0).max(100),
  period: z.object({ value: z.number().int().min(0).max(3650), unit: periodUnit }),
  boolean: z.boolean(),
  percent_or_amount: percentOrAmount,
  ld_rate: z.object({ amount: z.number().min(0), currency: z.string().length(3).default('SGD'), per: z.enum(['day', 'week']) }),
  day_of_month: z.number().int().min(1).max(31),
  text_list: z.array(shortText).max(100),
} as const;

export type FieldKind = keyof typeof valueSchemas | 'enum' | 'object' | 'object_list';

export type FieldSection = 'identity' | 'money' | 'time' | 'payment' | 'variations' | 'other';

export const SECTION_LABEL: Record<FieldSection, string> = {
  identity: 'Identity',
  money: 'Money',
  time: 'Time',
  payment: 'Payment',
  variations: 'Variations',
  other: 'Other',
};

export interface FieldDef {
  key: string;
  label: string;
  section: FieldSection;
  kind: FieldKind;
  schema: z.ZodType;
  /** Plain-language hint for extraction prompts and the edit form. */
  hint?: string;
  /** Enum options (kind 'enum'). */
  options?: readonly string[];
  /** Where in the package this is normally found; extraction only reads these sections. */
  foundIn: readonly ('articles' | 'appendix' | 'particular_conditions' | 'supplementary_agreement' | 'preliminaries')[];
}

const AA = ['articles', 'appendix', 'supplementary_agreement'] as const;
const APPX = ['appendix', 'particular_conditions', 'supplementary_agreement'] as const;

function f(key: string, label: string, section: FieldSection, kind: FieldKind, schema: z.ZodType, extra: Partial<FieldDef> = {}): FieldDef {
  return { key, label, section, kind, schema, foundIn: APPX, ...extra };
}

const enumOf = <T extends readonly [string, ...string[]]>(opts: T) => ({ kind: 'enum' as const, schema: z.enum(opts), options: opts });

export const CONTRACT_FIELDS: readonly FieldDef[] = [
  // Identity
  f('contract_form', 'Contract form', 'identity', 'enum', z.enum(CONTRACT_FORMS), { options: CONTRACT_FORMS, foundIn: AA }),
  f('edition', 'Edition', 'identity', 'text', valueSchemas.text, { foundIn: AA }),
  f('with_quantities', 'With quantities', 'identity', 'boolean', valueSchemas.boolean, { foundIn: AA }),
  f('contract_title', 'Contract title', 'identity', 'text', valueSchemas.text, { foundIn: AA }),
  f('project_name', 'Project name', 'identity', 'text', valueSchemas.text, { foundIn: AA }),
  f('site_address', 'Site address', 'identity', 'text', valueSchemas.text, { foundIn: AA }),
  f('employer_name', 'Employer', 'identity', 'text', valueSchemas.text, { foundIn: AA }),
  f('contractor_name', 'Contractor', 'identity', 'text', valueSchemas.text, { foundIn: AA }),
  (() => {
    const e = enumOf(['architect', 'superintending_officer', 'employers_representative'] as const);
    return f('contract_administrator_role', 'Contract administrator role', 'identity', e.kind, e.schema, { options: e.options, foundIn: AA });
  })(),
  f('contract_administrator_name', 'Contract administrator', 'identity', 'text', valueSchemas.text, { foundIn: AA }),
  f('qs_name', 'Quantity surveyor', 'identity', 'text', valueSchemas.text, { foundIn: AA }),
  f('date_of_contract', 'Date of contract', 'identity', 'date', valueSchemas.date, { foundIn: AA }),
  f('letter_of_award_date', 'Letter of award date', 'identity', 'date', valueSchemas.date, { foundIn: AA }),

  // Money
  f('contract_sum', 'Contract sum', 'money', 'money', valueSchemas.money, { foundIn: AA }),
  f('currency', 'Currency', 'money', 'text', z.string().length(3), { hint: 'ISO code, default SGD' }),
  f('gst_treatment', 'GST treatment', 'money', 'text', valueSchemas.text, { hint: 'e.g. contract sum excludes GST' }),
  f('retention_percent', 'Retention', 'money', 'percent', valueSchemas.percent),
  f('retention_limit', 'Retention limit', 'money', 'percent_or_amount', valueSchemas.percent_or_amount),
  f('performance_bond', 'Performance bond', 'money', 'object', z.object({
    amount: percentOrAmount,
    form: z.enum(['bankers_guarantee', 'insurance_bond', 'other']).nullable(),
  })),
  f('performance_bond_expiry_basis', 'Performance bond expiry', 'money', 'text', valueSchemas.text),
  f('advance_payment', 'Advance payment', 'money', 'percent_or_amount', valueSchemas.percent_or_amount),
  f('fluctuation', 'Fluctuation', 'money', 'object', z.object({ applicable: z.boolean(), materials: z.array(shortText).max(50) })),
  f('provisional_sums_total', 'Provisional sums total', 'money', 'money', valueSchemas.money),
  f('prime_cost_sums_total', 'Prime cost sums total', 'money', 'money', valueSchemas.money),

  // Time
  f('date_of_commencement', 'Commencement / possession of site', 'time', 'date', valueSchemas.date),
  f('completion_date', 'Completion date', 'time', 'date', valueSchemas.date),
  f('contract_period', 'Contract period', 'time', 'period', valueSchemas.period),
  f('sectional_completion', 'Sectional completion', 'time', 'object_list', z.array(z.object({
    section: shortText,
    date: localDate.nullable(),
    period: valueSchemas.period.nullable(),
    ld_rate: valueSchemas.ld_rate.nullable(),
  })).max(50)),
  f('liquidated_damages_rate', 'Liquidated damages rate', 'time', 'ld_rate', valueSchemas.ld_rate),
  f('ld_cap', 'LD cap', 'time', 'percent_or_amount', valueSchemas.percent_or_amount),
  f('defects_liability_period', 'Defects liability period', 'time', 'period', valueSchemas.period),
  f('maintenance_period', 'Maintenance period', 'time', 'period', valueSchemas.period),

  // Payment
  f('interim_payment_claim_frequency', 'Interim claim frequency', 'payment', 'text', valueSchemas.text, { hint: 'e.g. monthly' }),
  f('interim_payment_claim_day', 'Interim claim day of month', 'payment', 'day_of_month', valueSchemas.day_of_month),
  f('payment_response_period', 'Payment response period', 'payment', 'period', valueSchemas.period),
  f('payment_period_after_certificate', 'Payment period after certificate', 'payment', 'period', valueSchemas.period),
  f('final_account_submission_period', 'Final account submission period', 'payment', 'period', valueSchemas.period),
  f('final_certificate_period', 'Final certificate period', 'payment', 'period', valueSchemas.period),

  // Variations
  (() => {
    const e = enumOf(['bq_rates', 'schedule_of_rates', 'agreed_lump_sum', 'other'] as const);
    return f('variation_valuation_basis', 'Variation valuation basis', 'variations', e.kind, e.schema, { options: e.options });
  })(),
  f('daywork_rates_reference', 'Daywork rates reference', 'variations', 'text', valueSchemas.text),
  f('contractor_quotation_required', 'Contractor quotation required', 'variations', 'object', z.object({
    required: z.boolean(),
    period: valueSchemas.period.nullable(),
  })),
  f('notice_of_claim_period', 'Notice of claim period', 'variations', 'period', valueSchemas.period),
  f('oral_instruction_confirmation_period', 'Oral instruction confirmation period', 'variations', 'period', valueSchemas.period),
  f('objection_to_valuation_period', 'Objection to valuation period', 'variations', 'period', valueSchemas.period),

  // Other
  f('insurance_requirements', 'Insurance', 'other', 'object_list', z.array(z.object({
    type: shortText,
    minimum_sum: valueSchemas.money.nullable(),
    period: shortText.nullable(),
  })).max(30)),
  f('nominated_subcontractors', 'Nominated subcontractors', 'other', 'text_list', valueSchemas.text_list),
  f('dispute_resolution', 'Dispute resolution', 'other', 'object', z.object({
    method: z.enum(['arbitration', 'litigation', 'mediation_first', 'other']),
    seat_or_rules: shortText.nullable(),
  })),
  f('option_modules', 'Option modules', 'other', 'text_list', valueSchemas.text_list, { foundIn: AA }),
  f('time_unit_definition', 'Definition of "days"', 'other', 'object', z.object({
    unit: z.enum(['calendar_days', 'working_days']),
    includes_public_holidays: z.boolean().nullable(),
  })),
];

export const FIELD_BY_KEY: ReadonlyMap<string, FieldDef> = new Map(CONTRACT_FIELDS.map((d) => [d.key, d]));

/** Fields that need a unit column (periods carry their unit inside the value). */
export function fieldDef(key: string): FieldDef {
  const d = FIELD_BY_KEY.get(key);
  if (!d) throw new Error(`Unknown contract field '${key}'`);
  return d;
}

/**
 * Validates a field value. `null` is allowed only together with `notStated` (the contract doesn't
 * state it), which still counts as confirmed.
 */
export function validateFieldValue(key: string, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const res = fieldDef(key).schema.safeParse(value);
  if (res.success) return { ok: true, value: res.data };
  return { ok: false, error: res.error.issues.map((i) => `${i.path.join('.') || key}: ${i.message}`).join('; ') };
}

/**
 * Required before deadlines go live: contract form, commencement, completion (date or period),
 * LD rate, DLP and payment response period. Each may be confirmed as "not stated".
 */
export const REQUIRED_FIELDS: readonly (string | readonly string[])[] = [
  'contract_form',
  'date_of_commencement',
  ['completion_date', 'contract_period'],
  'liquidated_damages_rate',
  'defects_liability_period',
  'payment_response_period',
];

export function requiredFieldsStatus(confirmed: ReadonlySet<string>): { complete: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const req of REQUIRED_FIELDS) {
    if (typeof req === 'string') {
      if (!confirmed.has(req)) missing.push(req);
    } else if (!req.some((k) => confirmed.has(k))) {
      missing.push(req.join(' or '));
    }
  }
  return { complete: missing.length === 0, missing };
}
