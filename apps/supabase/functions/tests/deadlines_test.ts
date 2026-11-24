import { assert, assertEquals, assertFalse, assertStringIncludes } from '@std/assert';

import {
  addMonths,
  buildCalendar,
  canVerify,
  closesObligation,
  computeDueDate,
  computeServedAt,
  DEFAULT_REMINDER_SCHEDULE,
  type EffectiveRule,
  effectiveCompletionDate,
  planChainedSuggestions,
  planCompletionObligations,
  planObligationsForEvent,
  planReminders,
  reminderMessage,
  resolveGroup,
  selectReminder,
  sgtInstant,
  toSgt,
} from '../_shared/deadlines/index.ts';

// Singapore 2026 public holidays incl. substitute Mondays (MOM list, see seed/public_holidays_sg.json).
const SG_2026 = [
  '2026-01-01', '2026-02-17', '2026-02-18', '2026-03-21', '2026-04-03', '2026-05-01',
  '2026-05-27', '2026-05-31', '2026-06-01', '2026-08-09', '2026-08-10', '2026-11-08',
  '2026-11-09', '2026-12-25',
];
const cal = buildCalendar({ holidays: SG_2026 });
const at = (iso: string) => new Date(iso);

let n = 0;
function rule(over: Partial<EffectiveRule>): EffectiveRule {
  n++;
  return {
    id: `r${n}`,
    ruleKey: `rule.${n}`,
    groupKey: 'g',
    origin: 'standard_form_default',
    status: 'verified',
    kind: 'action',
    obligation: 'Do the thing',
    reminderLabel: 'thing',
    responsibleParty: 'contract_admin',
    recipientParty: 'contractor',
    triggerEventType: 'payment_claim_served',
    period: null,
    unit: 'calendar_days',
    periodField: null,
    defaultPeriod: null,
    includesPublicHolidays: null,
    capDays: null,
    capLabel: null,
    isTimeBar: false,
    consequence: null,
    closedByEventTypes: [],
    chainsTo: [],
    todoVerify: [],
    verifiedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const sopa = () =>
  rule({
    ruleKey: 'sopa.payment_response',
    groupKey: 'payment_response',
    origin: 'statute',
    responsibleParty: 'employer',
    periodField: 'payment_response_period',
    defaultPeriod: 14,
    capDays: 21,
    capLabel: 'SOP Act',
  });

const period = (value: number, unit: 'calendar_days' | 'working_days' = 'calendar_days') => () => ({ value, unit });
const none = () => null;

Deno.test('SGT conversion', () => {
  assertEquals(toSgt(at('2026-03-02T16:30:00Z')), { date: '2026-03-03', minutes: 30 });
  assertEquals(sgtInstant('2026-03-03').toISOString(), '2026-03-02T16:00:00.000Z');
});

Deno.test('SOP Act: contract period 30 days is capped at 21', () => {
  const res = resolveGroup([sopa()], period(30));
  assert(res.ok);
  const due = computeDueDate({
    triggerAt: at('2026-03-03T02:00:00Z'),
    triggerLabel: 'payment claim served',
    period: res.resolved.period,
    unit: res.resolved.unit,
    cap: res.resolved.cap,
    calendar: cal,
  });
  assertEquals(due.dueDate, '2026-03-24');
  assert(due.capApplied);
  assertEquals(
    due.explanation,
    '21 calendar days after payment claim served on 3 Mar 2026 (30 calendar days capped by SOP Act)',
  );
});

Deno.test('SOP Act: contract period 10 days stays 10', () => {
  const res = resolveGroup([sopa()], period(10));
  assert(res.ok);
  assertEquals(res.resolved.period, 10);
  const due = computeDueDate({
    triggerAt: at('2026-03-03T02:00:00Z'), triggerLabel: 'x', period: 10, unit: 'calendar_days', cap: res.resolved.cap, calendar: cal,
  });
  assertEquals(due.dueDate, '2026-03-13');
  assertFalse(due.capApplied);
});

Deno.test('SOP Act: no contractual period defaults to 14', () => {
  const res = resolveGroup([sopa()], none);
  assert(res.ok);
  assertEquals(res.resolved.period, 14);
  assertEquals(res.resolved.periodSource, 'default');
});

Deno.test('SOP Act default still applies when the standard form rule waits for an unconfirmed field', () => {
  const form = rule({ groupKey: 'payment_response', periodField: 'payment_response_period' });
  const res = resolveGroup([form, sopa()], none);
  assert(res.ok);
  assertEquals(res.resolved.rule.origin, 'statute');
  assertEquals(res.resolved.period, 14);
});

Deno.test('calendar vs working days over a public holiday (Good Friday 3 Apr 2026)', () => {
  const triggerAt = at('2026-04-01T02:00:00Z'); // Wed 1 Apr, 10:00 SGT
  const calDays = computeDueDate({ triggerAt, triggerLabel: 'x', period: 5, unit: 'calendar_days', calendar: cal });
  assertEquals(calDays.dueDate, '2026-04-06'); // Mon
  // Thu 2, (Fri 3 PH), (Sat, Sun), Mon 6, Tue 7, Wed 8, Thu 9 -> 5th working day
  const wd = computeDueDate({ triggerAt, triggerLabel: 'x', period: 5, unit: 'working_days', calendar: cal });
  assertEquals(wd.dueDate, '2026-04-09');
  const calNoPH = computeDueDate({
    triggerAt, triggerLabel: 'x', period: 5, unit: 'calendar_days', includesPublicHolidays: false, calendar: cal,
  });
  assertEquals(calNoPH.dueDate, '2026-04-07');
  assertStringIncludes(calNoPH.explanation, 'public holidays excluded');
});

Deno.test('served Friday 17:30 before a public holiday Monday is served Tuesday', () => {
  // Fri 7 Aug 2026, 17:30 SGT; Mon 10 Aug is the National Day substitute holiday.
  const { servedDate, servedAt } = computeServedAt(at('2026-08-07T09:30:00Z'), cal);
  assertEquals(servedDate, '2026-08-11');
  assertEquals(servedAt.toISOString(), '2026-08-10T16:00:00.000Z');
});

Deno.test('served before cut-off on a working day is served that day', () => {
  const sent = at('2026-08-07T08:59:00Z'); // 16:59 SGT
  assertEquals(computeServedAt(sent, cal), { servedDate: '2026-08-07', servedAt: sent });
});

Deno.test('custom cut-off and Saturday working day', () => {
  const sat = buildCalendar({ holidays: SG_2026, saturdayIsWorkingDay: true, serviceCutoff: '12:00' });
  assertEquals(computeServedAt(at('2026-08-15T03:00:00Z'), sat).servedDate, '2026-08-15'); // Sat 11:00
  assertEquals(computeServedAt(at('2026-08-15T05:00:00Z'), sat).servedDate, '2026-08-17'); // Sat 13:00 -> Mon
});

Deno.test('month period from 31 Jan clamps to end of February', () => {
  assertEquals(addMonths('2026-01-31', 1), '2026-02-28');
  assertEquals(addMonths('2028-01-31', 1), '2028-02-29');
  assertEquals(addMonths('2026-01-31', 2), '2026-03-31');
  assertEquals(addMonths('2026-11-30', 3), '2027-02-28');
  const due = computeDueDate({ triggerAt: at('2026-01-31T02:00:00Z'), triggerLabel: 'x', period: 1, unit: 'months', calendar: cal });
  assertEquals(due.dueDate, '2026-02-28');
});

Deno.test('amended rule beats standard form default but respects the statute cap', () => {
  const form = rule({ groupKey: 'payment_response', origin: 'standard_form_default', period: 14 });
  const amended = rule({ groupKey: 'payment_response', origin: 'amended', period: 35 });
  const res = resolveGroup([form, amended, sopa()], none);
  assert(res.ok);
  assertEquals(res.resolved.rule.id, amended.id);
  assertEquals(res.resolved.period, 35);
  assertEquals(res.resolved.cap, { days: 21, label: 'SOP Act' });
  const due = computeDueDate({
    triggerAt: at('2026-03-03T02:00:00Z'), triggerLabel: 'x', period: 35, unit: 'calendar_days', cap: res.resolved.cap, calendar: cal,
  });
  assertEquals(due.dueDate, '2026-03-24');
});

Deno.test('precedence: project procedure beats default, amended beats procedure, drafts ignored', () => {
  const def = rule({ origin: 'standard_form_default', period: 10 });
  const proc = rule({ origin: 'project_procedure', period: 7, unit: 'working_days' });
  const amendedDraft = rule({ origin: 'amended', period: 3, status: 'draft' });
  const r1 = resolveGroup([def, proc, amendedDraft], none);
  assert(r1.ok);
  assertEquals(r1.resolved.rule.id, proc.id);
  const r2 = resolveGroup([def, proc, { ...amendedDraft, status: 'verified' }], none);
  assert(r2.ok);
  assertEquals(r2.resolved.period, 3);
  assertFalse(resolveGroup([rule({ status: 'draft', period: 5 })], none).ok);
});

Deno.test('TODO_VERIFY rules cannot be verified', () => {
  assertFalse(canVerify({ todoVerify: ['period'], period: null, unit: null, periodField: null, defaultPeriod: null }));
  assertFalse(canVerify({ todoVerify: [], period: null, unit: 'calendar_days', periodField: null, defaultPeriod: null }));
  assert(canVerify({ todoVerify: [], period: 7, unit: 'working_days', periodField: null, defaultPeriod: null }));
});

Deno.test('planner: unconfirmed contract creates nothing; verified rule creates open obligation', () => {
  const rfi = rule({
    triggerEventType: 'rfi_submitted', groupKey: 'rfi_reply', origin: 'project_procedure', period: 7, unit: 'working_days',
    closedByEventTypes: ['rfi_responded'],
  });
  const event = { id: 'e1', eventType: 'rfi_submitted', triggerAt: at('2026-03-04T02:00:00Z') };
  assertEquals(planObligationsForEvent({ event, rules: [rfi], fields: none, calendar: cal, live: false }).planned, []);
  const { planned } = planObligationsForEvent({ event, rules: [rfi], fields: none, calendar: cal, live: true });
  assertEquals(planned.length, 1);
  assertEquals(planned[0].status, 'open');
  assertEquals(planned[0].dueDate, '2026-03-13');
  assertEquals(planned[0].triggerEventId, 'e1');
  // Draft rules never create obligations, even when live.
  const draft = { ...rfi, status: 'draft' as const };
  assertEquals(planObligationsForEvent({ event, rules: [draft], fields: none, calendar: cal, live: true }).planned, []);
});

Deno.test('responses close only matching obligations', () => {
  const ob = { triggerEventId: 'e1', closedByEventTypes: ['rfi_responded'], status: 'open' as const, triggerReference: 'RFI-023' };
  assert(closesObligation(ob, { eventType: 'rfi_responded', relatedEventId: 'e1', reference: null }));
  assert(closesObligation(ob, { eventType: 'rfi_responded', relatedEventId: null, reference: 'rfi-023 ' }));
  assertFalse(closesObligation(ob, { eventType: 'rfi_responded', relatedEventId: 'e2', reference: 'RFI-023' }));
  assertFalse(closesObligation(ob, { eventType: 'rfi_responded', relatedEventId: null, reference: 'RFI-024' }));
  assertFalse(closesObligation(ob, { eventType: 'rfa_responded', relatedEventId: 'e1', reference: null }));
  assertFalse(closesObligation({ ...ob, status: 'met' }, { eventType: 'rfi_responded', relatedEventId: 'e1', reference: null }));
  assert(closesObligation({ ...ob, status: 'overdue' }, { eventType: 'rfi_responded', relatedEventId: 'e1', reference: null }));
});

Deno.test('overdue + chains_to gives suggested, not open', () => {
  const eot = rule({
    ruleKey: 'x.eot_notice', groupKey: 'eot_notice', triggerEventType: 'delay_event_occurred', period: 28, responsibleParty: 'contractor',
  });
  const { planned } = planChainedSuggestions({
    chainsTo: ['eot_notice'], anchorAt: at('2026-03-13T15:59:59Z'), anchorLabel: 'RFI-023 reply overdue',
    triggerEventId: 'e1', rules: [eot], fields: none, calendar: cal,
  });
  assertEquals(planned.length, 1);
  assertEquals(planned[0].status, 'suggested');
  assertEquals(planned[0].groupKey, 'eot_notice');
});

Deno.test('EOT granted moves completion and completion-anchored obligations', () => {
  const ld = rule({ ruleKey: 'contract.completion', groupKey: 'completion', triggerEventType: 'completion_date', period: 0, responsibleParty: 'contractor' });
  const base = effectiveCompletionDate({ completionDate: '2027-06-30', commencementDate: null, contractPeriod: null, extensions: [], calendar: cal });
  const extended = effectiveCompletionDate({
    completionDate: '2027-06-30', commencementDate: null, contractPeriod: null, extensions: [{ days: 14, label: 'EOT-1' }], calendar: cal,
  });
  assertEquals(base?.date, '2027-06-30');
  assertEquals(extended?.date, '2027-07-14');
  assertStringIncludes(extended!.explanation, '14 days EOT-1');
  const before = planCompletionObligations({ completionDate: base!.date, rules: [ld], fields: none, calendar: cal, live: true });
  const after = planCompletionObligations({ completionDate: extended!.date, rules: [ld], fields: none, calendar: cal, live: true });
  assertEquals(before.planned[0].dueDate, '2027-06-30');
  assertEquals(after.planned[0].dueDate, '2027-07-14');
  // Warns: no 2027 holiday data in this test calendar.
  assert(after.planned[0].warnings.length > 0);
});

Deno.test('completion from commencement + contract period', () => {
  const r = effectiveCompletionDate({
    completionDate: null, commencementDate: '2026-01-31', contractPeriod: { value: 13, unit: 'months' }, extensions: [], calendar: cal,
  });
  assertEquals(r?.date, '2027-02-28');
});

Deno.test('reminder schedule: created, halfway, 2 wd before, due, overdue x5; time bar adds 5 wd', () => {
  const createdAt = at('2026-03-04T02:00:00Z');
  const ob = { createdAt, triggerAt: createdAt, dueDate: '2026-03-24', dueAt: at('2026-03-24T15:59:59.999Z'), isTimeBar: false };
  const keys = planReminders(ob, DEFAULT_REMINDER_SCHEDULE, cal).map((s) => s.key);
  assertEquals(keys, ['created', 'half', 'wd-2', 'due', 'overdue-1', 'overdue-2', 'overdue-3', 'overdue-4', 'overdue-5']);
  const tb = planReminders({ ...ob, isTimeBar: true }, DEFAULT_REMINDER_SCHEDULE, cal);
  assertEquals(tb.map((s) => s.key).slice(0, 4), ['created', 'half', 'wd-5', 'wd-2']);
  assertEquals(toSgt(tb.find((s) => s.key === 'wd-2')!.fireAt), { date: '2026-03-20', minutes: 540 });
});

Deno.test('reminder selection sends only the latest missed slot, never twice', () => {
  const createdAt = at('2026-03-04T02:00:00Z');
  const plan = planReminders(
    { createdAt, triggerAt: createdAt, dueDate: '2026-03-24', dueAt: at('2026-03-24T15:59:59.999Z'), isTimeBar: false },
    DEFAULT_REMINDER_SCHEDULE,
    cal,
  );
  const r = selectReminder(plan, at('2026-03-23T02:00:00Z'), new Set(['created']));
  assertEquals(r.send?.key, 'wd-2');
  assertEquals(r.skip.map((s) => s.key), ['half']);
  assertEquals(selectReminder(plan, at('2026-03-23T02:00:00Z'), new Set(['created', 'half', 'wd-2'])).send, null);
});

Deno.test('reminder wording by audience', () => {
  const t = {
    subject: 'RFI-023', reminderLabel: 'reply', dueDate: '2026-03-13', period: 7, unit: 'working_days' as const,
    sourceLabel: 'project procedure', isTimeBar: false,
  };
  assertEquals(reminderMessage(t, 'upcoming', 'responsible').body, 'RFI-023 reply due Fri 13 Mar (7 working days, project procedure).');
  assertEquals(
    reminderMessage(t, 'overdue', 'waiting').body,
    'RFI-023 reply is overdue. If this delays the works, consider recording a delay event; an EOT notice period may be running.',
  );
  assertStringIncludes(reminderMessage({ ...t, isTimeBar: true }, 'overdue', 'responsible').body, 'Time bar');
});
