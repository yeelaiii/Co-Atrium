// Plans obligations from events and rules. Pure: callers load data and write the result.

import { COMPLETION_TRIGGER, triggerLabel } from '../contracts/eventTypes.ts';
import { addPeriod, computeDueDate, type PeriodUnit } from './calculator.ts';
import { type CalendarSettings, formatDate, type LocalDate, sgtInstant } from './calendar.ts';
import { type EffectiveRule, groupRules, type Party, type PeriodFieldLookup, resolveGroup } from './rules.ts';

export type ObligationStatus = 'open' | 'met' | 'overdue' | 'waived' | 'suggested';

export interface PlannedObligation {
  ruleId: string;
  ruleKey: string;
  groupKey: string;
  kind: 'action' | 'milestone';
  triggerEventId: string | null;
  responsibleParty: Party;
  recipientParty: Party;
  dueAt: Date;
  dueDate: LocalDate;
  explanation: string;
  isTimeBar: boolean;
  closedByEventTypes: string[];
  status: ObligationStatus;
  /** Period actually used, for reminders: "(7 working days, project procedure)". */
  period: number;
  unit: PeriodUnit;
  sourceLabel: string;
  warnings: string[];
}

export interface SkippedRule {
  groupKey: string;
  reason: string;
}

export interface PlanResult {
  planned: PlannedObligation[];
  skipped: SkippedRule[];
}

function planForTrigger(
  rules: EffectiveRule[],
  triggerType: string,
  trigger: { at: Date; label: string; eventId: string | null },
  fields: PeriodFieldLookup,
  calendar: CalendarSettings,
  status: ObligationStatus,
  onlyGroups?: ReadonlySet<string>,
): PlanResult {
  const planned: PlannedObligation[] = [];
  const skipped: SkippedRule[] = [];
  const matching = rules.filter((r) => r.triggerEventType === triggerType && (!onlyGroups || onlyGroups.has(r.groupKey)));
  for (const [groupKey, group] of groupRules(matching)) {
    const res = resolveGroup(group, fields);
    if (!res.ok) {
      skipped.push({ groupKey, reason: res.reason });
      continue;
    }
    const { rule, period, unit, includesPublicHolidays, cap, sourceLabel } = res.resolved;
    const due = computeDueDate({
      triggerAt: trigger.at,
      triggerLabel: trigger.label,
      period,
      unit,
      includesPublicHolidays,
      cap,
      sourceLabel,
      calendar,
    });
    planned.push({
      ruleId: rule.id,
      ruleKey: rule.ruleKey,
      groupKey,
      kind: rule.kind,
      triggerEventId: trigger.eventId,
      responsibleParty: rule.responsibleParty,
      recipientParty: rule.recipientParty,
      dueAt: due.dueAt,
      dueDate: due.dueDate,
      explanation: due.explanation,
      isTimeBar: rule.isTimeBar,
      closedByEventTypes: rule.closedByEventTypes,
      status,
      period: due.capApplied && cap ? cap.days : period,
      unit: due.capApplied ? 'calendar_days' : unit,
      sourceLabel: due.capApplied && cap ? cap.label : sourceLabel,
      warnings: due.warnings,
    });
  }
  return { planned, skipped };
}

export interface EventForPlanning {
  id: string;
  eventType: string;
  /** served_at for documents, else sent_at. */
  triggerAt: Date;
}

/**
 * Obligations created when `event` is logged. `live` is false until the required contract
 * fields are confirmed: then nothing is planned (unconfirmed fields never create obligations).
 */
export function planObligationsForEvent(input: {
  event: EventForPlanning;
  rules: EffectiveRule[];
  fields: PeriodFieldLookup;
  calendar: CalendarSettings;
  live: boolean;
}): PlanResult {
  if (!input.live) return { planned: [], skipped: [{ groupKey: '*', reason: 'Required contract fields not confirmed' }] };
  return planForTrigger(
    input.rules,
    input.event.eventType,
    { at: input.event.triggerAt, label: triggerLabel(input.event.eventType), eventId: input.event.id },
    input.fields,
    input.calendar,
    'open',
  );
}

/** Obligations anchored on the completion date (LD exposure, milestones). Recalculated on EOT. */
export function planCompletionObligations(input: {
  completionDate: LocalDate;
  rules: EffectiveRule[];
  fields: PeriodFieldLookup;
  calendar: CalendarSettings;
  live: boolean;
}): PlanResult {
  if (!input.live) return { planned: [], skipped: [{ groupKey: '*', reason: 'Required contract fields not confirmed' }] };
  return planForTrigger(
    input.rules,
    COMPLETION_TRIGGER,
    { at: sgtInstant(input.completionDate), label: triggerLabel(COMPLETION_TRIGGER), eventId: null },
    input.fields,
    input.calendar,
    'open',
  );
}

/**
 * Follow-on obligations for `chainsTo` groups, anchored at `anchorAt` (the overdue obligation's
 * due date, or the date a VO recorded a time impact). Always `suggested`: a user must confirm.
 * Chained rules are matched by groupKey regardless of their own trigger type.
 */
export function planChainedSuggestions(input: {
  chainsTo: string[];
  anchorAt: Date;
  anchorLabel: string;
  triggerEventId: string | null;
  rules: EffectiveRule[];
  fields: PeriodFieldLookup;
  calendar: CalendarSettings;
}): PlanResult {
  if (!input.chainsTo.length) return { planned: [], skipped: [] };
  const groups = new Set(input.chainsTo);
  const planned: PlannedObligation[] = [];
  const skipped: SkippedRule[] = [];
  const byTrigger = new Map<string, EffectiveRule[]>();
  for (const r of input.rules.filter((x) => groups.has(x.groupKey))) {
    byTrigger.set(r.triggerEventType, [...(byTrigger.get(r.triggerEventType) ?? []), r]);
  }
  for (const [triggerType, list] of byTrigger) {
    const res = planForTrigger(
      list,
      triggerType,
      { at: input.anchorAt, label: input.anchorLabel, eventId: input.triggerEventId },
      input.fields,
      input.calendar,
      'suggested',
      groups,
    );
    planned.push(...res.planned);
    skipped.push(...res.skipped);
  }
  return { planned, skipped };
}

/** Extensions that move the completion date. */
export interface CompletionExtension {
  days: number;
  /** "EOT-003", "VO-12" */
  label: string;
}

/**
 * Completion date = confirmed completion_date, or commencement + contract_period,
 * plus every granted extension (calendar days).
 */
export function effectiveCompletionDate(input: {
  completionDate: LocalDate | null;
  commencementDate: LocalDate | null;
  contractPeriod: { value: number; unit: PeriodUnit } | null;
  extensions: CompletionExtension[];
  calendar: CalendarSettings;
}): { date: LocalDate; explanation: string } | null {
  let base: LocalDate;
  let explanation: string;
  if (input.completionDate) {
    base = input.completionDate;
    explanation = `Completion date ${formatDate(base)}`;
  } else if (input.commencementDate && input.contractPeriod) {
    const { value, unit } = input.contractPeriod;
    base = addPeriod(input.commencementDate, value, unit, input.calendar, true);
    explanation = `Commencement ${formatDate(input.commencementDate)} + ${value} ${unit.replace('_', ' ')}`;
  } else {
    return null;
  }
  const total = input.extensions.reduce((s, e) => s + e.days, 0);
  if (total === 0) return { date: base, explanation };
  const date = addPeriod(base, total, 'calendar_days', input.calendar, true);
  const parts = input.extensions.filter((e) => e.days !== 0).map((e) => `${e.days} days ${e.label}`);
  return { date, explanation: `${explanation} + ${parts.join(' + ')} = ${formatDate(date)}` };
}

/** Does `response` close `obligation`? Same rule set as the close_obligations_on_response SQL trigger. */
export function closesObligation(
  obligation: { triggerEventId: string | null; closedByEventTypes: string[]; status: ObligationStatus; triggerReference: string | null },
  response: { eventType: string; relatedEventId: string | null; reference: string | null },
): boolean {
  if (obligation.status !== 'open' && obligation.status !== 'overdue') return false;
  if (!obligation.closedByEventTypes.includes(response.eventType)) return false;
  if (response.relatedEventId) return response.relatedEventId === obligation.triggerEventId;
  return (
    !!response.reference &&
    !!obligation.triggerReference &&
    response.reference.trim().toUpperCase() === obligation.triggerReference.trim().toUpperCase()
  );
}
