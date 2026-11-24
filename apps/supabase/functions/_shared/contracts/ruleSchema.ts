// Schema of the versioned rule library files (apps/supabase/seed/rules/*.json).
// Values a contracts professional must still check are written as the literal "TODO_VERIFY";
// the seed builder turns them into NULL + an entry in `todo_verify`.

import { z } from 'zod';

import { CONTRACT_FORMS } from './contractFieldSchema.ts';
import { EVENT_TYPES, TRIGGER_TYPES } from './eventTypes.ts';

export const TODO = 'TODO_VERIFY' as const;
const todo = z.literal(TODO);

export const PARTY = z.enum(['employer', 'contract_admin', 'contractor', 'subcontractor', 'qs', 'consultant']);
export const PERIOD_UNIT = z.enum(['calendar_days', 'working_days', 'weeks', 'months']);
export const LIBRARY_ORIGIN = z.enum(['statute', 'standard_form_default']);

const key = z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/, 'lower_snake segments separated by dots');

export const ruleSeedSchema = z
  .object({
    rule_key: key,
    group_key: z.string().regex(/^[a-z0-9_]+$/),
    kind: z.enum(['action', 'milestone']).default('action'),
    obligation: z.string().min(3).max(300),
    reminder_label: z.string().min(2).max(60),
    responsible_role: PARTY,
    recipient_role: PARTY,
    trigger_event_type: z.enum(TRIGGER_TYPES),
    period: z.union([z.number().int().min(0).max(3650), todo, z.null()]),
    unit: z.union([PERIOD_UNIT, todo]),
    period_field: z.string().nullable().default(null),
    default_period: z.number().int().min(0).max(3650).nullable().default(null),
    includes_public_holidays: z.union([z.boolean(), todo, z.null()]).default(null),
    cap_days: z.number().int().min(0).max(3650).nullable().default(null),
    cap_label: z.string().max(80).nullable().default(null),
    is_time_bar: z.union([z.boolean(), todo]),
    consequence: z.string().max(500).nullable().default(null),
    origin: LIBRARY_ORIGIN,
    clause_ref: z.union([z.string().max(60), todo, z.null()]),
    closed_by_event_types: z.array(z.enum(EVENT_TYPES)).default([]),
    chains_to: z.array(z.string()).default([]),
    applies_to_contract_forms: z.array(z.enum(CONTRACT_FORMS)).min(1),
    /** Notes for the reviewer (not shown to end users). */
    notes: z.string().max(500).optional(),
  })
  .strict();

export const ruleFileSchema = z
  .object({
    library_version: z.string().regex(/^\d{4}\.\d+$/),
    description: z.string(),
    source: z.string().optional(),
    rules: z.array(ruleSeedSchema).min(1),
  })
  .strict();

export type RuleSeed = z.infer<typeof ruleSeedSchema>;
export type RuleFile = z.infer<typeof ruleFileSchema>;

/** Attributes still marked TODO_VERIFY. */
export function todoAttributes(r: RuleSeed): string[] {
  const out: string[] = [];
  if (r.period === TODO) out.push('period');
  if (r.unit === TODO) out.push('unit');
  if (r.includes_public_holidays === TODO) out.push('includes_public_holidays');
  if (r.is_time_bar === TODO) out.push('is_time_bar');
  if (r.clause_ref === TODO) out.push('clause_ref');
  return out;
}
