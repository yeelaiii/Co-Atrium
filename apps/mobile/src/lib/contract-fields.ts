import { CONTRACT_FORM_LABEL, type ContractForm, type FieldDef, FIELD_BY_KEY } from '@shared/contracts/contractFieldSchema.ts';
import { formatDate } from '@shared/deadlines/calendar.ts';
import { type PeriodUnit, unitLabel } from '@shared/deadlines/calculator.ts';

const money = (v: { amount: number; currency?: string }) =>
  `${v.currency ?? 'SGD'} ${v.amount.toLocaleString('en-SG', { maximumFractionDigits: 2 })}`;

const ENUM_LABEL: Record<string, string> = {
  architect: 'Architect',
  superintending_officer: 'Superintending Officer',
  employers_representative: "Employer's Representative",
  bq_rates: 'Bills of quantities rates',
  schedule_of_rates: 'Schedule of rates',
  agreed_lump_sum: 'Agreed lump sum',
  other: 'Other',
  bankers_guarantee: "Banker's guarantee",
  insurance_bond: 'Insurance bond',
  arbitration: 'Arbitration',
  litigation: 'Litigation',
  mediation_first: 'Mediation first',
  ...CONTRACT_FORM_LABEL,
};

export const enumLabel = (v: string) => ENUM_LABEL[v] ?? v;

export const fieldLabel = (key: string) => FIELD_BY_KEY.get(key)?.label ?? key.replaceAll('_', ' ');

// deno-lint-ignore no-explicit-any
type Any = any;

/** One-line display of a confirmed value. */
export function formatFieldValue(def: FieldDef, value: unknown): string {
  if (value === null || value === undefined) return '';
  const v = value as Any;
  switch (def.kind) {
    case 'enum':
      return def.key === 'contract_form' ? CONTRACT_FORM_LABEL[v as ContractForm] ?? String(v) : enumLabel(String(v));
    case 'date':
      return formatDate(String(v));
    case 'money':
      return money(v);
    case 'percent':
      return `${v}%`;
    case 'period':
      return `${v.value} ${unitLabel(v.unit as PeriodUnit, v.value)}`;
    case 'boolean':
      return v ? 'Yes' : 'No';
    case 'percent_or_amount':
      return v.kind === 'percent' ? `${v.value}%` : money({ amount: v.value, currency: v.currency });
    case 'ld_rate':
      return `${money(v)} per ${v.per}`;
    case 'day_of_month':
      return `Day ${v} of the month`;
    case 'text_list':
      return (v as string[]).join(', ');
    case 'text':
      return String(v);
    default:
      if (def.key === 'performance_bond') {
        const a = v.amount?.kind === 'percent' ? `${v.amount.value}%` : v.amount ? money({ amount: v.amount.value, currency: v.amount.currency }) : '';
        return [a, v.form ? enumLabel(v.form) : null].filter(Boolean).join(', ');
      }
      if (def.key === 'fluctuation') return v.applicable ? `Applies${v.materials?.length ? `: ${v.materials.join(', ')}` : ''}` : 'Does not apply';
      if (def.key === 'contractor_quotation_required') {
        return v.required ? `Required${v.period ? `, within ${v.period.value} ${unitLabel(v.period.unit, v.period.value)}` : ''}` : 'Not required';
      }
      if (def.key === 'dispute_resolution') return [enumLabel(v.method), v.seat_or_rules].filter(Boolean).join(', ');
      if (def.key === 'time_unit_definition') {
        return `${unitLabel(v.unit, 2)}${v.includes_public_holidays === false ? ', excluding public holidays' : ''}`;
      }
      if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
      return JSON.stringify(v);
  }
}
