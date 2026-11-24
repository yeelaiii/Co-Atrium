// Deadline engine I/O against the in-memory FakeDb: event -> obligation -> reminders ->
// overdue + suggested follow-on -> response closes it -> reminders stop; EOT moves completion.

import { assert, assertEquals, assertStringIncludes } from '@std/assert';

import { markDue, processQueue, recalculateProject, sendReminders } from '../_shared/server/engine.ts';
import type { Db } from '../_shared/server/http.ts';
import { expoPushChannel, inAppChannel } from '../_shared/server/notify.ts';
import { FakeDb } from './helpers/fake-db.ts';

const P = 'project-1';
const CA = 'user-ca'; // contract administrator side
const CON = 'user-con'; // contractor side (logs events)

const HOLIDAYS_2026 = ['2026-01-01', '2026-02-17', '2026-02-18', '2026-03-21', '2026-04-03', '2026-05-01', '2026-05-27',
  '2026-05-31', '2026-06-01', '2026-08-09', '2026-08-10', '2026-11-08', '2026-11-09', '2026-12-25'];

function rule(over: Record<string, unknown>) {
  return {
    project_id: P, kind: 'action', status: 'verified', verified_at: '2026-01-01T00:00:00Z', origin: 'standard_form_default',
    period: null, unit: 'calendar_days', period_field: null, default_period: null, includes_public_holidays: null,
    cap_days: null, cap_label: null, is_time_bar: false, consequence: null, closed_by_event_types: [], chains_to: [],
    todo_verify: [], responsible_role: 'contract_admin', recipient_role: 'contractor', ...over,
  };
}

function setup(opts: { allFields?: boolean } = {}) {
  const db = new FakeDb();
  let clock = new Date('2026-03-04T02:00:00Z');
  db.now = () => clock;
  const setClock = (iso: string) => (clock = new Date(iso));

  db.seed('public_holidays', HOLIDAYS_2026.map((date) => ({ id: date, date })));
  db.seed('project_members', [
    { project_id: P, user_id: CA, role: 'member', contract_party: 'contract_admin', left_at: null },
    { project_id: P, user_id: CON, role: 'owner', contract_party: 'contractor', left_at: null },
  ]);
  const fields: [string, unknown][] = [
    ['contract_form', 'SIA_2016_LUMP_SUM'],
    ['date_of_commencement', '2026-01-05'],
    ['completion_date', '2027-06-30'],
    ['liquidated_damages_rate', { amount: 5000, currency: 'SGD', per: 'day' }],
    ['defects_liability_period', { value: 12, unit: 'months' }],
    ['payment_response_period', { value: 30, unit: 'calendar_days' }],
  ];
  db.seed('project_contract_fields', (opts.allFields === false ? fields.slice(0, 3) : fields)
    .map(([field_key, value]) => ({ project_id: P, field_key, value, not_stated: false })));
  db.seed('deadline_rules', [
    rule({ id: 'r-sopa', rule_key: 'sopa.payment_response', group_key: 'payment_response', origin: 'statute', trigger_event_type: 'payment_claim_served',
      responsible_role: 'employer', period_field: 'payment_response_period', default_period: 14, cap_days: 21, cap_label: 'SOP Act',
      obligation: 'Serve a payment response', reminder_label: 'payment response', closed_by_event_types: ['payment_response_served'] }),
    rule({ id: 'r-rfi', rule_key: 'project_procedure.rfi', group_key: 'rfi_reply', origin: 'project_procedure', trigger_event_type: 'rfi_submitted',
      period: 7, unit: 'working_days', obligation: 'Reply to the RFI', reminder_label: 'reply', closed_by_event_types: ['rfi_responded'],
      chains_to: ['eot_notice'] }),
    rule({ id: 'r-eot', rule_key: 'sia2016_ls.eot_notice', group_key: 'eot_notice', trigger_event_type: 'delay_event_occurred', period: 28,
      responsible_role: 'contractor', recipient_role: 'contract_admin', is_time_bar: true, obligation: 'Give EOT notice', reminder_label: 'EOT notice' }),
    rule({ id: 'r-comp', rule_key: 'contract.completion', group_key: 'contract_completion', kind: 'milestone', trigger_event_type: 'completion_date',
      period: 0, responsible_role: 'contractor', recipient_role: 'employer', obligation: 'Complete the works', reminder_label: 'completion date' }),
    rule({ id: 'r-draft', rule_key: 'sia2016_ls.defects', group_key: 'defects', status: 'draft', verified_at: null, trigger_event_type: 'rfi_submitted',
      todo_verify: ['period'], obligation: 'Draft rule', reminder_label: 'x' }),
  ]);
  db.seed('push_tokens', [{ token: 'ExpoPushToken[ca]', user_id: CA }, { token: 'ExpoPushToken[gone]', user_id: CON }]);
  // Events logged by the contractor. served_at empty: the engine computes it.
  db.seed('project_events', [
    { id: 'e-rfi', project_id: P, event_type: 'rfi_submitted', reference: 'RFI-023', sent_at: '2026-03-04T02:00:00Z', created_by: CON },
    { id: 'e-pc', project_id: P, event_type: 'payment_claim_served', reference: 'PC-07', sent_at: '2026-03-03T02:00:00Z', created_by: CON },
  ]);
  db.seed('obligation_queue', [{ project_id: P, event_id: 'e-rfi', reason: 'event' }, { project_id: P, event_id: 'e-pc', reason: 'event' }]);

  const pushed: { to: string; body: string }[] = [];
  const fakeFetch = ((_url: string, init: RequestInit) => {
    const msgs = JSON.parse(String(init.body)) as { to: string; body: string }[];
    pushed.push(...msgs);
    const data = msgs.map((m) =>
      m.to === 'ExpoPushToken[gone]' ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: 'x' }
    );
    return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
  }) as typeof fetch;
  const channels = [inAppChannel, expoPushChannel(fakeFetch)];
  return { db, fake: db as unknown as Db, setClock, pushed, channels };
}

const obligation = (db: FakeDb, group: string) => db.table('obligations').find((o) => o.group_key === group);

Deno.test('required fields missing: nothing is created, the queue still drains', async () => {
  const { db, fake } = setup({ allFields: false });
  const res = await processQueue(fake);
  assertEquals(res.processed, 2);
  assertEquals(db.table('obligations').length, 0);
  assert(db.table('obligation_queue').every((q) => q.processed_at));
});

Deno.test('full flow: obligation, reminders, overdue, suggestion, response, EOT', async () => {
  const { db, fake, setClock, pushed, channels } = setup();

  await processQueue(fake, { now: new Date('2026-03-04T02:05:00Z') });
  const rfi = obligation(db, 'rfi_reply')!;
  const pay = obligation(db, 'payment_response')!;
  assertEquals(rfi.due_date, '2026-03-13');
  assertEquals(rfi.subject, 'RFI-023');
  assertEquals(pay.due_date, '2026-03-24');
  assertStringIncludes(pay.explanation, 'capped by SOP Act');
  assertEquals(obligation(db, 'defects'), undefined, 'draft rules never create obligations');
  assertEquals(obligation(db, 'contract_completion')!.due_date, '2027-06-30');
  assert(db.table('project_events').every((e) => e.served_at), 'served_at is filled in');

  // Idempotent: processing again changes nothing.
  db.seed('obligation_queue', [{ project_id: P, reason: 'recalculate' }]);
  await processQueue(fake);
  assertEquals(db.table('obligations').filter((o) => o.group_key === 'rfi_reply').length, 1);

  // Creation reminder to the responsible party (contract administrator).
  setClock('2026-03-04T02:15:00Z');
  await sendReminders(fake, new Date('2026-03-04T02:15:00Z'), channels);
  const caNotes = () => db.table('notifications').filter((n) => n.user_id === CA && n.obligation_id === rfi.id);
  assertEquals(caNotes().length, 1);
  assertEquals(caNotes()[0].body, 'RFI-023 reply due Fri 13 Mar (7 working days, project procedure).');
  assert(pushed.some((p) => p.to === 'ExpoPushToken[ca]'));

  // Same run again: nothing is sent twice.
  const before = db.table('notifications').length;
  await sendReminders(fake, new Date('2026-03-04T02:20:00Z'), channels);
  assertEquals(db.table('notifications').length, before);

  // 2 working days before (Wed 11 Mar 09:00); the halfway one was missed and is skipped, not sent late.
  await sendReminders(fake, new Date('2026-03-11T01:05:00Z'), channels);
  assertEquals(caNotes().length, 2);
  assert(db.table('reminders_sent').some((r) => r.obligation_id === rfi.id && r.reminder_key === 'half' && r.channel === 'skipped'));

  // Past due: overdue, and the chained EOT notice is suggested (not open).
  await markDue(fake, new Date('2026-03-13T16:30:00Z'));
  assertEquals(obligation(db, 'rfi_reply')!.status, 'overdue');
  const eot = obligation(db, 'eot_notice')!;
  assertEquals(eot.status, 'suggested');
  assertEquals(eot.parent_obligation_id, rfi.id);

  // Overdue reminders: responsible party and the waiting party (contractor).
  await sendReminders(fake, new Date('2026-03-14T01:05:00Z'), channels);
  const conNote = db.table('notifications').find((n) => n.user_id === CON && n.obligation_id === rfi.id);
  assertEquals(conNote?.body, 'RFI-023 reply is overdue. If this delays the works, consider recording a delay event; an EOT notice period may be running.');
  assertEquals(db.table('push_tokens').some((t) => t.token === 'ExpoPushToken[gone]'), false, 'DeviceNotRegistered token deleted');

  // The response closes it; no more reminders for it.
  db.seed('project_events', [{ project_id: P, event_type: 'rfi_responded', reference: 'rfi-023', sent_at: '2026-03-14T03:00:00Z', created_by: CA }]);
  assertEquals(obligation(db, 'rfi_reply')!.status, 'met');
  const count = db.table('notifications').filter((n) => n.obligation_id === rfi.id).length;
  await sendReminders(fake, new Date('2026-03-15T01:05:00Z'), channels);
  assertEquals(db.table('notifications').filter((n) => n.obligation_id === rfi.id).length, count);

  // EOT granted: completion-dependent obligation moves.
  db.seed('project_events', [{ project_id: P, event_type: 'eot_decision_issued', reference: 'EOT-1', sent_at: '2026-04-01T02:00:00Z', time_extension_days: 14, created_by: CA }]);
  await recalculateProject(fake, P);
  const comp = obligation(db, 'contract_completion')!;
  assertEquals(comp.due_date, '2027-07-14');
  assertStringIncludes(comp.explanation, '14 days EOT EOT-1');
  assertEquals(db.table('obligations').filter((o) => o.group_key === 'contract_completion').length, 1);
});

Deno.test('a newly verified amended rule updates the open obligation instead of adding one', async () => {
  const { db, fake } = setup();
  await processQueue(fake, { now: new Date('2026-03-04T02:05:00Z') });
  db.seed('deadline_rules', [rule({
    id: 'r-amend', rule_key: 'amended.payment_response', group_key: 'payment_response', origin: 'amended', period: 10,
    trigger_event_type: 'payment_claim_served', obligation: 'Serve a payment response', reminder_label: 'payment response',
    verified_at: '2026-03-05T00:00:00Z',
  })]);
  await recalculateProject(fake, P, new Date('2026-03-05T02:00:00Z'));
  const pays = db.table('obligations').filter((o) => o.group_key === 'payment_response');
  assertEquals(pays.length, 1);
  assertEquals(pays[0].rule_id, 'r-amend');
  assertEquals(pays[0].due_date, '2026-03-13');
});

Deno.test('a response logged before the rule existed: recalculation inserts the obligation as met', async () => {
  const { db, fake } = setup();
  db.seed('project_events', [{ project_id: P, event_type: 'rfi_responded', related_event_id: 'e-rfi', sent_at: '2026-03-05T02:00:00Z', created_by: CA }]);
  await processQueue(fake, { now: new Date('2026-03-06T02:00:00Z') });
  assertEquals(obligation(db, 'rfi_reply')!.status, 'met');
});

Deno.test('a VO with a claimed time impact gets a suggested EOT notice, once', async () => {
  const { db, fake } = setup();
  db.seed('variation_orders', [
    { id: 'vo-1', project_id: P, number: 12, contract_status: 'quotation_submitted', time_impact_days_claimed: 14,
      time_impact_claimed_at: '2026-03-04T02:00:00Z', time_impact_days_agreed: null, eot_event_id: null },
    { id: 'vo-2', project_id: P, number: 13, contract_status: 'withdrawn', time_impact_days_claimed: 5,
      time_impact_claimed_at: '2026-03-04T02:00:00Z', time_impact_days_agreed: null, eot_event_id: null },
    { id: 'vo-3', project_id: P, number: 14, contract_status: 'instructed', time_impact_days_claimed: null,
      time_impact_claimed_at: null, time_impact_days_agreed: null, eot_event_id: null },
  ]);
  await recalculateProject(fake, P, new Date('2026-03-04T03:00:00Z'));
  const eots = db.table('obligations').filter((o) => o.group_key === 'eot_notice');
  assertEquals(eots.length, 1, 'withdrawn VOs and VOs without time claimed get nothing');
  assertEquals(eots[0].status, 'suggested', 'suggested, never open');
  assertEquals(eots[0].anchor, 'variation');
  assertEquals(eots[0].variation_order_id, 'vo-1');
  assertEquals(eots[0].subject, 'VO-12');
  assertEquals(eots[0].due_date, '2026-04-01');
  assertStringIncludes(eots[0].explanation, 'VO-12 time impact (14 days) recorded');

  await recalculateProject(fake, P, new Date('2026-03-05T03:00:00Z'));
  assertEquals(db.table('obligations').filter((o) => o.group_key === 'eot_notice').length, 1, 'idempotent');
});

Deno.test('agreed VO time moves the completion date; one carried by an EOT decision counts once', async () => {
  const { db, fake } = setup();
  db.seed('project_events', [{ id: 'e-eot', project_id: P, event_type: 'eot_decision_issued', reference: 'EOT-2',
    sent_at: '2026-04-01T02:00:00Z', time_extension_days: 7, created_by: 'user-ca', variation_order_id: 'vo-b' }]);
  db.seed('variation_orders', [
    { id: 'vo-a', project_id: P, number: 3, contract_status: 'agreed', time_impact_days_claimed: 10,
      time_impact_claimed_at: '2026-03-01T00:00:00Z', time_impact_days_agreed: 10, eot_event_id: null },
    { id: 'vo-b', project_id: P, number: 4, contract_status: 'agreed', time_impact_days_claimed: 7,
      time_impact_claimed_at: '2026-03-01T00:00:00Z', time_impact_days_agreed: 7, eot_event_id: 'e-eot' },
  ]);
  await recalculateProject(fake, P, new Date('2026-04-02T00:00:00Z'));
  const comp = obligation(db, 'contract_completion')!;
  assertEquals(comp.due_date, '2027-07-17', '30 Jun 2027 + 7 (EOT-2) + 10 (VO-3)');
  assertStringIncludes(comp.explanation, '10 days VO-3');
});
