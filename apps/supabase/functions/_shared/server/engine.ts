// Deadline engine I/O: turns queue rows, events and rules into obligations, marks overdue,
// creates suggested follow-ons, and sends reminders. All date maths is in ../deadlines (pure).

import {
  closesObligation,
  computeServedAt,
  effectiveCompletionDate,
  type PlannedObligation,
  planChainedSuggestions,
  planCompletionObligations,
  planObligationsForEvent,
  planReminders,
  type ReminderKind,
  reminderMessage,
  selectReminder,
  toSgt,
} from '../deadlines/index.ts';
import { EVENT_TYPE_INFO, type EventType } from '../contracts/eventTypes.ts';
import { VO_CLOSED_STATUSES, VO_TIME_IMPACT_CHAINS, voCompletionExtensions, type VoContractStatus } from '../contracts/variations.ts';
import { dateField, loadProjectContext, type ProjectContext } from './context.ts';
import type { Db } from './http.ts';
import { type Delivery, expoPushChannel, inAppChannel, type ReminderChannel } from './notify.ts';

// deno-lint-ignore no-explicit-any
type Row = any;

const OPEN_STATES = ['open', 'overdue', 'suggested'];

/** Throws on error; list queries come back as [] instead of null. */
function check<T>(res: { data: T; error: unknown }): NonNullable<T> {
  if (res.error) throw res.error;
  return (res.data ?? []) as NonNullable<T>;
}

function triggerAtOf(e: Row): Date {
  return new Date(e.served_at ?? e.sent_at);
}

/** Fills served_at for events logged without it (documents only; others are served when sent). */
async function ensureServedAt(db: Db, ctx: ProjectContext, events: Row[]): Promise<void> {
  for (const e of events) {
    if (e.served_at) continue;
    const info = EVENT_TYPE_INFO[e.event_type as EventType];
    const servedAt = info?.served ? computeServedAt(new Date(e.sent_at), ctx.calendar).servedAt : new Date(e.sent_at);
    check(await db.from('project_events').update({ served_at: servedAt.toISOString() }).eq('id', e.id));
    e.served_at = servedAt.toISOString();
  }
}

function obligationRow(ctx: ProjectContext, p: PlannedObligation, extra: Record<string, unknown>) {
  const rule = ctx.rules.find((r) => r.id === p.ruleId)!;
  return {
    project_id: ctx.projectId,
    rule_id: p.ruleId,
    rule_key: p.ruleKey,
    group_key: p.groupKey,
    kind: p.kind,
    obligation: rule.obligation,
    reminder_label: rule.reminderLabel,
    responsible_party: p.responsibleParty,
    recipient_party: p.recipientParty,
    due_at: p.dueAt.toISOString(),
    due_date: p.dueDate,
    explanation: p.explanation,
    period: p.period,
    unit: p.unit,
    source_label: p.sourceLabel,
    is_time_bar: p.isTimeBar,
    closed_by_event_types: p.closedByEventTypes,
    ...extra,
  };
}

/**
 * Writes planned obligations: updates still-open ones in place (new due date, new winning rule),
 * inserts missing ones, and leaves met/waived ones alone. New obligations whose response was
 * already logged are inserted as met; past-due ones as overdue (actions) or met (milestones).
 */
async function writePlanned(
  db: Db,
  ctx: ProjectContext,
  planned: PlannedObligation[],
  anchor: 'event' | 'completion_date',
  existing: Row[],
  events: Row[],
  now: Date,
): Promise<number> {
  let changed = 0;
  for (const p of planned) {
    const trigger = p.triggerEventId ? events.find((e) => e.id === p.triggerEventId) : null;
    const prev = existing.find((o) =>
      o.anchor === anchor && o.group_key === p.groupKey && (anchor === 'completion_date' || o.trigger_event_id === p.triggerEventId)
    );
    if (prev) {
      if (!OPEN_STATES.includes(prev.status)) continue;
      const same = prev.rule_id === p.ruleId && new Date(prev.due_at).getTime() === p.dueAt.getTime() &&
        prev.explanation === p.explanation;
      if (same) continue;
      const status = prev.status === 'suggested'
        ? 'suggested'
        : p.dueAt < now ? (p.kind === 'milestone' ? 'met' : 'overdue') : 'open';
      check(await db.from('obligations').update({ ...obligationRow(ctx, p, {}), status }).eq('id', prev.id));
      changed++;
      continue;
    }

    const response = trigger
      ? events.find((r) =>
        r.voided_at === null && r.id !== trigger.id &&
        closesObligation(
          { triggerEventId: trigger.id, closedByEventTypes: p.closedByEventTypes, status: 'open', triggerReference: trigger.reference },
          { eventType: r.event_type, relatedEventId: r.related_event_id, reference: r.reference },
        )
      )
      : null;
    const status = response ? 'met' : p.dueAt < now ? (p.kind === 'milestone' ? 'met' : 'overdue') : 'open';
    const res = await db.from('obligations').insert(obligationRow(ctx, p, {
      anchor,
      trigger_event_id: p.triggerEventId,
      variation_order_id: trigger?.variation_order_id ?? null,
      subject: trigger?.reference ?? null,
      status,
      closed_by_event_id: response?.id ?? null,
      closed_at: response ? now.toISOString() : null,
    }));
    // 23505: another invocation inserted it first (unique per group + trigger). Fine.
    if (res.error && (res.error as { code?: string }).code !== '23505') throw res.error;
    if (!res.error) changed++;
  }
  return changed;
}

/** Full recalculation of one project: event obligations and completion-anchored ones. */
export async function recalculateProject(db: Db, projectId: string, now = new Date()): Promise<{ changed: number; live: boolean; missing: string[] }> {
  const ctx = await loadProjectContext(db, projectId);
  if (!ctx.live) return { changed: 0, live: false, missing: ctx.missingFields };

  const events: Row[] = check(await db.from('project_events').select('*').eq('project_id', projectId).is('voided_at', null).order('sent_at'));
  const existing: Row[] = check(await db.from('obligations').select('*').eq('project_id', projectId));
  await ensureServedAt(db, ctx, events);

  let changed = 0;
  for (const e of events) {
    const plan = planObligationsForEvent({
      event: { id: e.id, eventType: e.event_type, triggerAt: triggerAtOf(e) },
      rules: ctx.rules,
      fields: ctx.periodField,
      calendar: ctx.calendar,
      live: true,
    });
    changed += await writePlanned(db, ctx, plan.planned, 'event', existing, events, now);
  }

  const vos: Row[] = check(
    await db.from('variation_orders')
      .select('id, number, contract_status, time_impact_days_claimed, time_impact_claimed_at, time_impact_days_agreed, eot_event_id')
      .eq('project_id', projectId),
  );
  changed += await suggestForVariations(db, ctx, vos, existing);

  const completion = effectiveCompletion(ctx, events, vos);
  if (completion) {
    const plan = planCompletionObligations({
      completionDate: completion.date,
      rules: ctx.rules,
      fields: ctx.periodField,
      calendar: ctx.calendar,
      live: true,
    });
    for (const p of plan.planned) p.explanation = `${p.explanation}. ${completion.explanation}`;
    changed += await writePlanned(db, ctx, plan.planned, 'completion_date', existing, events, now);
  }
  return { changed, live: true, missing: [] };
}

/**
 * A VO that records a claimed time impact gets the VO_TIME_IMPACT_CHAINS follow-ons (EOT notice)
 * as `suggested`, anchored on when the time impact was recorded. Once per VO and rule group.
 */
async function suggestForVariations(db: Db, ctx: ProjectContext, vos: Row[], existing: Row[]): Promise<number> {
  let changed = 0;
  for (const vo of vos) {
    if (!(vo.time_impact_days_claimed > 0) || !vo.time_impact_claimed_at) continue;
    if (VO_CLOSED_STATUSES.includes(vo.contract_status as VoContractStatus)) continue;
    const missing = VO_TIME_IMPACT_CHAINS.filter((g) =>
      !existing.some((o) => o.anchor === 'variation' && o.variation_order_id === vo.id && o.group_key === g)
    );
    if (!missing.length) continue;
    const subject = `VO-${vo.number}`;
    const plan = planChainedSuggestions({
      chainsTo: missing,
      anchorAt: new Date(vo.time_impact_claimed_at),
      anchorLabel: `${subject} time impact (${vo.time_impact_days_claimed} days) recorded`,
      triggerEventId: null,
      rules: ctx.rules,
      fields: ctx.periodField,
      calendar: ctx.calendar,
    });
    for (const p of plan.planned) {
      const res = await db.from('obligations').insert(obligationRow(ctx, p, {
        anchor: 'variation',
        trigger_event_id: null,
        variation_order_id: vo.id,
        subject,
        status: 'suggested',
      }));
      if (res.error && (res.error as { code?: string }).code !== '23505') throw res.error;
      if (!res.error) changed++;
    }
  }
  return changed;
}

/** Completion date from confirmed fields, plus granted EOTs and agreed VO time impacts. */
export function effectiveCompletion(ctx: ProjectContext, events: Row[], vos: Row[] = []) {
  const period = ctx.fields.get('contract_period');
  const contractPeriod = period && !period.notStated ? (period.value as { value: number; unit: 'months' }) : null;
  return effectiveCompletionDate({
    completionDate: dateField(ctx, 'completion_date'),
    commencementDate: dateField(ctx, 'date_of_commencement'),
    contractPeriod,
    extensions: events
      .filter((e) => e.event_type === 'eot_decision_issued' && e.time_extension_days > 0)
      .map((e) => ({ days: e.time_extension_days, label: `EOT ${e.reference ?? ''}`.trim() }))
      .concat(voCompletionExtensions(vos.map((v) => ({
        number: v.number,
        status: v.contract_status,
        timeImpactDaysAgreed: v.time_impact_days_agreed,
        eotEventId: v.eot_event_id,
      })))),
    calendar: ctx.calendar,
  });
}

/** Processes pending obligation_queue rows (optionally for one project). Idempotent. */
export async function processQueue(db: Db, opts: { projectId?: string; limit?: number; now?: Date } = {}) {
  let q = db.from('obligation_queue').select('*').is('processed_at', null).order('created_at').limit(opts.limit ?? 50);
  if (opts.projectId) q = q.eq('project_id', opts.projectId);
  const rows: Row[] = check(await q);
  // Every row for a project is satisfied by one recalculation, which is idempotent.
  const projects = [...new Set(rows.map((r) => r.project_id as string))];
  const results: Record<string, unknown> = {};
  for (const pid of projects) {
    const ids = rows.filter((r) => r.project_id === pid).map((r) => r.id);
    try {
      results[pid] = await recalculateProject(db, pid, opts.now);
      check(await db.from('obligation_queue').update({ processed_at: new Date().toISOString() }).in('id', ids));
    } catch (e) {
      console.error(`recalculate ${pid} failed`, e);
      for (const r of rows.filter((x) => x.project_id === pid)) {
        await db.from('obligation_queue').update({ attempts: r.attempts + 1, last_error: String(e).slice(0, 500) }).eq('id', r.id);
      }
      results[pid] = { error: 'failed' };
    }
  }
  return { processed: rows.length, projects: results };
}

/**
 * open -> overdue (actions) or met (milestones) once the due date has passed, and creates the
 * rule's chains_to follow-ons as `suggested`.
 */
export async function markDue(db: Db, now = new Date()): Promise<number> {
  const due: Row[] = check(
    await db.from('obligations').select('*').eq('status', 'open').lt('due_at', now.toISOString()).limit(500),
  );
  const ctxs = new Map<string, ProjectContext>();
  for (const o of due) {
    const status = o.kind === 'milestone' ? 'met' : 'overdue';
    check(await db.from('obligations').update({ status, ...(status === 'met' ? { closed_at: now.toISOString(), close_note: 'Period ended' } : {}) }).eq('id', o.id).eq('status', 'open'));

    let ctx = ctxs.get(o.project_id);
    if (!ctx) {
      ctx = await loadProjectContext(db, o.project_id);
      ctxs.set(o.project_id, ctx);
    }
    const rule = ctx.rules.find((r) => r.id === o.rule_id);
    if (!rule?.chainsTo.length) continue;
    const plan = planChainedSuggestions({
      chainsTo: rule.chainsTo,
      anchorAt: new Date(o.due_at),
      anchorLabel: `${o.subject ?? o.obligation} ${status === 'met' ? 'period ended' : 'deadline passed'}`,
      triggerEventId: o.trigger_event_id,
      rules: ctx.rules,
      fields: ctx.periodField,
      calendar: ctx.calendar,
    });
    for (const p of plan.planned) {
      const res = await db.from('obligations').insert(obligationRow(ctx, p, {
        anchor: 'chained',
        trigger_event_id: o.trigger_event_id,
        parent_obligation_id: o.id,
        variation_order_id: o.variation_order_id,
        subject: o.subject,
        status: 'suggested',
      }));
      if (res.error && (res.error as { code?: string }).code !== '23505') throw res.error;
    }
  }
  return due.length;
}

interface Recipient {
  userId: string;
  audience: 'responsible' | 'waiting';
}

/** Sends due reminders. reminders_sent makes every (obligation, user, reminder, channel) send at most once. */
export async function sendReminders(
  db: Db,
  now = new Date(),
  channels: ReminderChannel[] = [inAppChannel, expoPushChannel()],
): Promise<{ sent: number }> {
  const horizon = new Date(now.getTime() - 40 * 86_400_000).toISOString();
  const obligations: Row[] = check(
    await db.from('obligations').select('*').in('status', ['open', 'overdue']).gt('due_at', horizon).limit(2000),
  );
  if (!obligations.length) return { sent: 0 };

  const projectIds = [...new Set(obligations.map((o) => o.project_id as string))];
  const members: Row[] = check(
    await db.from('project_members').select('project_id, user_id, contract_party')
      .in('project_id', projectIds).is('left_at', null).in('role', ['owner', 'member']),
  );
  const events: Row[] = check(
    await db.from('project_events').select('id, created_by, sent_at, served_at').in('id', obligations.map((o) => o.trigger_event_id).filter(Boolean)),
  );
  const voIds = [...new Set(obligations.map((o) => o.variation_order_id).filter(Boolean))];
  const participants: Row[] = voIds.length
    ? check(await db.from('variation_order_participants').select('variation_order_id, user_id').in('variation_order_id', voIds))
    : [];
  const handled: Row[] = check(
    await db.from('reminders_sent').select('obligation_id, user_id, reminder_key').in('obligation_id', obligations.map((o) => o.id)),
  );
  const handledKey = (o: string, u: string) => `${o}:${u}`;
  const handledMap = new Map<string, Set<string>>();
  for (const h of handled) {
    const k = handledKey(h.obligation_id, h.user_id);
    handledMap.set(k, (handledMap.get(k) ?? new Set()).add(h.reminder_key));
  }

  const ctxs = new Map<string, ProjectContext>();
  const deliveries: { channel: ReminderChannel['id']; delivery: Delivery; key: string }[] = [];
  const skipped: Row[] = [];

  for (const o of obligations) {
    let ctx = ctxs.get(o.project_id);
    if (!ctx) {
      ctx = await loadProjectContext(db, o.project_id);
      ctxs.set(o.project_id, ctx);
    }
    const schedule = o.kind === 'milestone' ? { ...ctx.schedule, overdueDailyMax: 0 } : ctx.schedule;
    const trigger = events.find((e) => e.id === o.trigger_event_id);
    const plan = planReminders(
      {
        createdAt: new Date(o.created_at),
        triggerAt: trigger ? triggerAtOf(trigger) : new Date(o.created_at),
        dueDate: o.due_date,
        dueAt: new Date(o.due_at),
        isTimeBar: o.is_time_bar,
      },
      schedule,
      ctx.calendar,
    );

    const inVo = (uid: string) =>
      !o.variation_order_id || participants.some((p) => p.variation_order_id === o.variation_order_id && p.user_id === uid);
    const projectMembers = members.filter((m) => m.project_id === o.project_id && inVo(m.user_id));
    const recipients: Recipient[] = projectMembers
      .filter((m) => m.contract_party === o.responsible_party)
      .map((m) => ({ userId: m.user_id, audience: 'responsible' as const }));
    if (o.status === 'overdue') {
      projectMembers
        .filter((m) => m.contract_party === o.recipient_party)
        .forEach((m) => recipients.push({ userId: m.user_id, audience: 'waiting' }));
    }
    // Nobody mapped to the responsible party: whoever logged the trigger event keeps track of it.
    if (!recipients.some((r) => r.audience === 'responsible') && trigger?.created_by && inVo(trigger.created_by)
        && projectMembers.some((m) => m.user_id === trigger.created_by)
        && !recipients.some((r) => r.userId === trigger.created_by)) {
      recipients.push({ userId: trigger.created_by, audience: 'responsible' });
    }

    for (const r of recipients) {
      const done = handledMap.get(handledKey(o.id, r.userId)) ?? new Set<string>();
      // The waiting party only hears about overdue obligations.
      const slots = r.audience === 'waiting' ? plan.filter((s) => s.kind === 'overdue') : plan;
      const { send, skip } = selectReminder(slots, now, done);
      for (const s of skip) skipped.push({ obligation_id: o.id, user_id: r.userId, reminder_key: s.key, channel: 'skipped' });
      if (!send) continue;
      const msg = reminderMessage(
        {
          subject: o.subject ?? o.obligation,
          reminderLabel: o.subject ? o.reminder_label : '',
          dueDate: o.due_date,
          period: o.period,
          unit: o.unit,
          sourceLabel: o.source_label,
          isTimeBar: o.is_time_bar,
        },
        send.kind as ReminderKind,
        r.audience,
      );
      const delivery: Delivery = {
        userId: r.userId,
        projectId: o.project_id,
        obligationId: o.id,
        title: msg.title.replace(/\s+/g, ' ').trim(),
        body: msg.body.replace(/\s+/g, ' ').trim(),
        data: { type: 'obligation_reminder', projectId: o.project_id, obligationId: o.id },
      };
      for (const c of channels) deliveries.push({ channel: c.id, delivery, key: send.key });
    }
  }

  if (skipped.length) {
    check(await db.from('reminders_sent').upsert(skipped, { onConflict: 'obligation_id,user_id,reminder_key,channel', ignoreDuplicates: true }));
  }

  // Claim first, deliver second: only rows this run actually inserted are sent.
  let sent = 0;
  for (const c of channels) {
    const mine = deliveries.filter((d) => d.channel === c.id);
    if (!mine.length) continue;
    const claimed: Row[] = check(
      await db.from('reminders_sent').upsert(
        mine.map((d) => ({ obligation_id: d.delivery.obligationId, user_id: d.delivery.userId, reminder_key: d.key, channel: c.id })),
        { onConflict: 'obligation_id,user_id,reminder_key,channel', ignoreDuplicates: true },
      ).select('obligation_id, user_id, reminder_key'),
    );
    const ok = new Set(claimed.map((r) => `${r.obligation_id}:${r.user_id}:${r.reminder_key}`));
    const toSend = mine.filter((d) => ok.has(`${d.delivery.obligationId}:${d.delivery.userId}:${d.key}`)).map((d) => d.delivery);
    await c.deliver(db, toSend);
    sent += toSend.length;
  }
  return { sent };
}

/** For logs: "2026-03-04 10:00 SGT". */
export function sgtStamp(d: Date): string {
  const { date, minutes } = toSgt(d);
  return `${date} ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')} SGT`;
}
