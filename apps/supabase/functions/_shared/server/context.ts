// Loads everything the pure deadline engine needs for one project and maps rows to engine types.

import { z } from 'zod';

import { requiredFieldsStatus } from '../contracts/contractFieldSchema.ts';
import {
  buildCalendar,
  type CalendarSettings,
  DEFAULT_REMINDER_SCHEDULE,
  type EffectiveRule,
  type PeriodFieldLookup,
  type PeriodUnit,
  type ReminderSchedule,
} from '../deadlines/index.ts';
import type { Db } from './http.ts';

export interface ProjectContext {
  projectId: string;
  rules: EffectiveRule[];
  fields: Map<string, { value: unknown; notStated: boolean }>;
  periodField: PeriodFieldLookup;
  calendar: CalendarSettings;
  schedule: ReminderSchedule;
  /** Required fields confirmed: obligations may be created. */
  live: boolean;
  missingFields: string[];
}

// deadline_rules row -> EffectiveRule
// deno-lint-ignore no-explicit-any
export function toEffectiveRule(r: any): EffectiveRule {
  return {
    id: r.id,
    ruleKey: r.rule_key,
    groupKey: r.group_key,
    origin: r.origin,
    status: r.status,
    kind: r.kind,
    obligation: r.obligation,
    reminderLabel: r.reminder_label,
    responsibleParty: r.responsible_role,
    recipientParty: r.recipient_role,
    triggerEventType: r.trigger_event_type,
    period: r.period,
    unit: r.unit,
    periodField: r.period_field,
    defaultPeriod: r.default_period,
    includesPublicHolidays: r.includes_public_holidays,
    capDays: r.cap_days,
    capLabel: r.cap_label,
    isTimeBar: r.is_time_bar ?? false,
    consequence: r.consequence,
    closedByEventTypes: r.closed_by_event_types ?? [],
    chainsTo: r.chains_to ?? [],
    todoVerify: r.todo_verify ?? [],
    verifiedAt: r.verified_at,
  };
}

const periodValue = z.object({
  value: z.number().int().min(0),
  unit: z.enum(['calendar_days', 'working_days', 'weeks', 'months']),
});

const scheduleSchema = z
  .object({
    atCreation: z.boolean(),
    halfway: z.boolean(),
    workingDaysBefore: z.array(z.number().int().min(1).max(30)).max(5),
    timeBarWorkingDaysBefore: z.array(z.number().int().min(1).max(30)).max(5),
    onDueDate: z.boolean(),
    overdueDailyMax: z.number().int().min(0).max(30),
    sendHourSgt: z.number().int().min(0).max(23),
  })
  .partial();

export function parseSchedule(raw: unknown): ReminderSchedule {
  const parsed = scheduleSchema.safeParse(raw ?? {});
  return { ...DEFAULT_REMINDER_SCHEDULE, ...(parsed.success ? parsed.data : {}) };
}

let holidayCache: { at: number; dates: string[] } | null = null;

async function loadHolidays(db: Db): Promise<string[]> {
  if (holidayCache && Date.now() - holidayCache.at < 10 * 60_000) return holidayCache.dates;
  const { data, error } = await db.from('public_holidays').select('date');
  if (error) throw error;
  holidayCache = { at: Date.now(), dates: (data ?? []).map((h: { date: string }) => h.date) };
  return holidayCache.dates;
}

export async function loadProjectContext(db: Db, projectId: string): Promise<ProjectContext> {
  const [rulesRes, fieldsRes, settingsRes, holidays] = await Promise.all([
    db.from('deadline_rules').select('*').eq('project_id', projectId).neq('status', 'rejected'),
    db.from('project_contract_fields').select('field_key, value, not_stated').eq('project_id', projectId),
    db.from('project_deadline_settings').select('*').eq('project_id', projectId).maybeSingle(),
    loadHolidays(db),
  ]);
  if (rulesRes.error) throw rulesRes.error;
  if (fieldsRes.error) throw fieldsRes.error;
  if (settingsRes.error) throw settingsRes.error;

  const fields = new Map<string, { value: unknown; notStated: boolean }>();
  for (const f of fieldsRes.data ?? []) fields.set(f.field_key, { value: f.value, notStated: f.not_stated });

  const periodField: PeriodFieldLookup = (key) => {
    const f = fields.get(key);
    if (!f || f.notStated) return null;
    const p = periodValue.safeParse(f.value);
    return p.success ? { value: p.data.value, unit: p.data.unit as PeriodUnit } : null;
  };

  const s = settingsRes.data;
  const calendar = buildCalendar({
    holidays,
    saturdayIsWorkingDay: s?.saturday_is_working_day ?? false,
    serviceCutoff: s?.service_cutoff ? String(s.service_cutoff).slice(0, 5) : '17:00',
  });

  const status = requiredFieldsStatus(new Set(fields.keys()));
  return {
    projectId,
    rules: (rulesRes.data ?? []).map(toEffectiveRule),
    fields,
    periodField,
    calendar,
    schedule: parseSchedule(s?.reminder_schedule),
    live: status.complete,
    missingFields: status.missing,
  };
}

/** A confirmed date field ('YYYY-MM-DD'), or null. */
export function dateField(ctx: ProjectContext, key: string): string | null {
  const f = ctx.fields.get(key);
  return f && !f.notStated && typeof f.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.value) ? f.value : null;
}
