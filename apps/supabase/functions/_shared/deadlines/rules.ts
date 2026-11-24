// Rule precedence and period resolution. Pure.
//
// Rules that describe the same obligation share a `groupKey` (e.g. the SOP Act payment
// response rule and a standard form's interim payment response rule are both 'payment_response').
// For each group:
//   1. only `verified` rules count;
//   2. the winner is the highest-ranked non-statute rule:
//        amended  >  project_procedure = user_defined  >  standard_form_default
//      (ties: most recently verified). If the group has only statute rules, the statute rule wins;
//   3. statute caps in the group ALWAYS apply on top of the winner: min(period, cap).

import type { PeriodUnit } from './calculator.ts';

export type RuleOrigin = 'statute' | 'standard_form_default' | 'amended' | 'project_procedure' | 'user_defined';
export type RuleStatus = 'draft' | 'verified' | 'rejected';
export type Party = 'employer' | 'contract_admin' | 'contractor' | 'subcontractor' | 'qs' | 'consultant';

export const PARTIES: readonly Party[] = ['employer', 'contract_admin', 'contractor', 'subcontractor', 'qs', 'consultant'];

export const ORIGIN_RANK: Record<Exclude<RuleOrigin, 'statute'>, number> = {
  amended: 3,
  project_procedure: 2,
  user_defined: 2,
  standard_form_default: 1,
};

export const ORIGIN_LABEL: Record<RuleOrigin, string> = {
  statute: 'statute',
  standard_form_default: 'standard form default',
  amended: 'amended by contract',
  project_procedure: 'project procedure',
  user_defined: 'entered by user',
};

export interface EffectiveRule {
  id: string;
  ruleKey: string;
  groupKey: string;
  origin: RuleOrigin;
  status: RuleStatus;
  /** 'action': someone must do something (overdue if missed). 'milestone': a period that ends (met when it passes). */
  kind: 'action' | 'milestone';
  obligation: string;
  /** Short noun for messages: "reply", "payment response", "EOT notice". */
  reminderLabel: string;
  responsibleParty: Party;
  recipientParty: Party;
  /**
   * An event type, 'completion_date' for rules anchored on the (extended) completion date, or
   * 'chained' for rules only reached through another rule's chainsTo.
   */
  triggerEventType: string;
  period: number | null;
  unit: PeriodUnit | null;
  /** Contract field that supplies the period when `period` is null (e.g. 'payment_response_period'). */
  periodField: string | null;
  /** Used when neither `period` nor the field is available (SOP Act: 14 days). */
  defaultPeriod: number | null;
  includesPublicHolidays: boolean | null;
  /** Cap in calendar days from the same trigger. */
  capDays: number | null;
  capLabel: string | null;
  isTimeBar: boolean;
  consequence: string | null;
  closedByEventTypes: string[];
  chainsTo: string[];
  /** Attributes still marked TODO_VERIFY. */
  todoVerify: string[];
  verifiedAt: string | null;
}

export interface PeriodValue {
  value: number;
  unit: PeriodUnit;
}

/** Returns a confirmed period-type contract field, or null. */
export type PeriodFieldLookup = (fieldKey: string) => PeriodValue | null;

export interface ResolvedRule {
  rule: EffectiveRule;
  period: number;
  unit: PeriodUnit;
  includesPublicHolidays: boolean | undefined;
  periodSource: 'rule' | 'contract_field' | 'default';
  cap: { days: number; label: string } | null;
  /** Words for the explanation and reminders: "project procedure", "contract appendix", ... */
  sourceLabel: string;
}

export type ResolveResult = { ok: true; resolved: ResolvedRule } | { ok: false; reason: string };

/** Can this rule be marked verified? Mirrors the deadline_rules_verify_complete check in SQL. */
export function canVerify(rule: Pick<EffectiveRule, 'todoVerify' | 'period' | 'unit' | 'periodField' | 'defaultPeriod'>): boolean {
  if (rule.todoVerify.length > 0) return false;
  if (rule.unit === null) return false;
  return rule.period !== null || rule.periodField !== null || rule.defaultPeriod !== null;
}

function pickWinner(rules: EffectiveRule[]): EffectiveRule | null {
  const nonStatute = rules.filter((r) => r.origin !== 'statute');
  const pool = nonStatute.length ? nonStatute : rules;
  let best: EffectiveRule | null = null;
  for (const r of pool) {
    if (!best) {
      best = r;
      continue;
    }
    const rank = r.origin === 'statute' ? 0 : ORIGIN_RANK[r.origin];
    const bestRank = best.origin === 'statute' ? 0 : ORIGIN_RANK[best.origin];
    if (rank > bestRank || (rank === bestRank && (r.verifiedAt ?? '') > (best.verifiedAt ?? ''))) best = r;
  }
  return best;
}

function resolvePeriod(
  rule: EffectiveRule,
  fields: PeriodFieldLookup,
): { period: number; unit: PeriodUnit; periodSource: ResolvedRule['periodSource'] } | null {
  if (rule.period !== null && rule.unit) return { period: rule.period, unit: rule.unit, periodSource: 'rule' };
  const field = rule.periodField ? fields(rule.periodField) : null;
  if (field) return { period: field.value, unit: field.unit, periodSource: 'contract_field' };
  if (rule.defaultPeriod !== null && rule.unit) return { period: rule.defaultPeriod, unit: rule.unit, periodSource: 'default' };
  return null;
}

/** Resolves one group of rules (same groupKey) into the rule, period and cap that apply. */
export function resolveGroup(group: EffectiveRule[], fields: PeriodFieldLookup): ResolveResult {
  const verified = group.filter((r) => r.status === 'verified');
  if (!verified.length) return { ok: false, reason: 'No verified rule' };

  // The winner, or, if the winner has no usable period (e.g. the contract field isn't confirmed),
  // the statute rule's own period or default (SOP Act: 14 days when the contract sets none).
  const preferred = pickWinner(verified)!;
  const candidates = [preferred, ...verified.filter((r) => r.origin === 'statute' && r !== preferred)];
  let winner: EffectiveRule | null = null;
  let p: ReturnType<typeof resolvePeriod> = null;
  for (const c of candidates) {
    p = resolvePeriod(c, fields);
    if (p) {
      winner = c;
      break;
    }
  }
  if (!winner || !p) {
    return {
      ok: false,
      reason: preferred.periodField
        ? `Waiting for contract field '${preferred.periodField}' to be confirmed`
        : 'Rule has no period',
    };
  }
  const { period, unit, periodSource } = p;

  // Statute caps always apply, plus the winner's own cap if it has one.
  let cap: ResolvedRule['cap'] = null;
  for (const r of [winner, ...verified.filter((x) => x.origin === 'statute' && x !== winner)]) {
    if (r.capDays !== null && (!cap || r.capDays < cap.days)) {
      cap = { days: r.capDays, label: r.capLabel ?? ORIGIN_LABEL[r.origin] };
    }
  }

  const sourceLabel =
    periodSource === 'contract_field'
      ? `contract period, ${ORIGIN_LABEL[winner.origin]}`
      : periodSource === 'default'
        ? `default under ${winner.capLabel ?? ORIGIN_LABEL[winner.origin]}`
        : ORIGIN_LABEL[winner.origin];

  return {
    ok: true,
    resolved: {
      rule: winner,
      period,
      unit,
      includesPublicHolidays: winner.includesPublicHolidays ?? undefined,
      periodSource,
      cap,
      sourceLabel,
    },
  };
}

/** Groups rules by groupKey. */
export function groupRules(rules: EffectiveRule[]): Map<string, EffectiveRule[]> {
  const out = new Map<string, EffectiveRule[]>();
  for (const r of rules) {
    if (r.status === 'rejected') continue;
    const list = out.get(r.groupKey) ?? [];
    list.push(r);
    out.set(r.groupKey, list);
  }
  return out;
}
