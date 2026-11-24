// Reminder schedule and wording. Pure: send-reminders decides what to send with these.

import { type PeriodUnit, unitLabel } from './calculator.ts';
import {
  addDays,
  type CalendarSettings,
  formatShortDate,
  type LocalDate,
  sgtInstant,
  subtractWorkingDays,
  toSgt,
} from './calendar.ts';

export interface ReminderSchedule {
  atCreation: boolean;
  halfway: boolean;
  /** Working days before the due date, e.g. [2]. */
  workingDaysBefore: number[];
  /** Extra working-day reminders for time-bar obligations, e.g. [5]. */
  timeBarWorkingDaysBefore: number[];
  onDueDate: boolean;
  /** Daily reminders while overdue, at most this many. */
  overdueDailyMax: number;
  /** Hour (SGT) at which dated reminders fire. */
  sendHourSgt: number;
}

export const DEFAULT_REMINDER_SCHEDULE: ReminderSchedule = {
  atCreation: true,
  halfway: true,
  workingDaysBefore: [2],
  timeBarWorkingDaysBefore: [5],
  onDueDate: true,
  overdueDailyMax: 5,
  sendHourSgt: 9,
};

export type ReminderKind = 'created' | 'upcoming' | 'due' | 'overdue';

export interface ReminderSlot {
  /** Stable key stored in reminders_sent: 'created', 'half', 'wd-2', 'due', 'overdue-1' ... */
  key: string;
  kind: ReminderKind;
  fireAt: Date;
}

export interface ObligationForReminders {
  createdAt: Date;
  triggerAt: Date;
  dueDate: LocalDate;
  dueAt: Date;
  isTimeBar: boolean;
}

/** Every reminder this obligation will get, in time order. Slots before creation are dropped. */
export function planReminders(ob: ObligationForReminders, schedule: ReminderSchedule, cal: CalendarSettings): ReminderSlot[] {
  const at = (d: LocalDate) => sgtInstant(d, schedule.sendHourSgt * 60);
  const slots: ReminderSlot[] = [];
  if (schedule.atCreation) slots.push({ key: 'created', kind: 'created', fireAt: ob.createdAt });

  if (schedule.halfway) {
    const mid = new Date((ob.triggerAt.getTime() + ob.dueAt.getTime()) / 2);
    slots.push({ key: 'half', kind: 'upcoming', fireAt: at(toSgt(mid).date) });
  }
  const before = new Set(schedule.workingDaysBefore);
  if (ob.isTimeBar) schedule.timeBarWorkingDaysBefore.forEach((n) => before.add(n));
  for (const n of before) {
    slots.push({ key: `wd-${n}`, kind: 'upcoming', fireAt: at(subtractWorkingDays(ob.dueDate, n, cal)) });
  }
  if (schedule.onDueDate) slots.push({ key: 'due', kind: 'due', fireAt: at(ob.dueDate) });
  for (let k = 1; k <= schedule.overdueDailyMax; k++) {
    slots.push({ key: `overdue-${k}`, kind: 'overdue', fireAt: at(addDays(ob.dueDate, k)) });
  }

  // Drop slots that fall before creation (except 'created' itself) or duplicate a time.
  const seen = new Set<number>();
  return slots
    .filter((s) => s.kind === 'created' || s.fireAt.getTime() > ob.createdAt.getTime())
    .filter((s) => s.kind === 'overdue' || s.kind === 'created' || s.fireAt.getTime() <= ob.dueAt.getTime())
    .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
    .filter((s) => {
      const t = s.fireAt.getTime();
      if (s.kind !== 'created' && seen.has(t)) return false;
      seen.add(t);
      return true;
    });
}

/**
 * What to do at `now`: send the most recent slot that has fired and wasn't sent; record any
 * earlier unsent slots as skipped, so a missed cron run never sends a burst of stale reminders.
 */
export function selectReminder(
  plan: ReminderSlot[],
  now: Date,
  alreadyHandled: ReadonlySet<string>,
): { send: ReminderSlot | null; skip: ReminderSlot[] } {
  const fired = plan.filter((s) => s.fireAt.getTime() <= now.getTime() && !alreadyHandled.has(s.key));
  if (!fired.length) return { send: null, skip: [] };
  return { send: fired[fired.length - 1], skip: fired.slice(0, -1) };
}

export interface ReminderText {
  /** "RFI-023", or the obligation text when there is no reference. */
  subject: string;
  /** "reply", "payment response" */
  reminderLabel: string;
  dueDate: LocalDate;
  period: number;
  unit: PeriodUnit;
  sourceLabel: string;
  isTimeBar: boolean;
}

export type Audience = 'responsible' | 'waiting';

/** Title and body for a reminder, worded for who receives it. */
export function reminderMessage(t: ReminderText, kind: ReminderKind, audience: Audience): { title: string; body: string } {
  const what = `${t.subject} ${t.reminderLabel}`;
  const due = formatShortDate(t.dueDate);
  const detail = `${t.period} ${unitLabel(t.unit, t.period)}, ${t.sourceLabel}`;
  const bar = t.isTimeBar ? 'Time bar: ' : '';

  if (audience === 'waiting') {
    return {
      title: `${what} overdue`,
      body:
        `${what} is overdue. If this delays the works, consider recording a delay event; ` +
        `an EOT notice period may be running.`,
    };
  }
  switch (kind) {
    case 'overdue':
      return {
        title: `${bar}${what} overdue`,
        body: `${bar}${what} was due ${due} (${detail}) and is overdue.` +
          (t.isTimeBar ? ' A late notice may lose the entitlement. Check the contract now.' : ''),
      };
    case 'due':
      return { title: `${bar}${what} due today`, body: `${bar}${what} due today, ${due} (${detail}).` };
    default:
      return { title: `${bar}${what} due ${due}`, body: `${bar}${what} due ${due} (${detail}).` };
  }
}
