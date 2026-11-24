// Deadline calculator. Pure and deterministic: no clock, no I/O.

import {
  addCalendarDays,
  addDays,
  addMonths,
  addWorkingDays,
  type CalendarSettings,
  endOfDaySgt,
  formatDate,
  isWorkingDay,
  type LocalDate,
  nextWorkingDay,
  parseTimeOfDay,
  sgtInstant,
  toSgt,
  yearOf,
} from './calendar.ts';

export type PeriodUnit = 'calendar_days' | 'working_days' | 'weeks' | 'months';
export const PERIOD_UNITS: readonly PeriodUnit[] = ['calendar_days', 'working_days', 'weeks', 'months'];

export function unitLabel(unit: PeriodUnit, n: number): string {
  const one = n === 1;
  switch (unit) {
    case 'calendar_days':
      return one ? 'calendar day' : 'calendar days';
    case 'working_days':
      return one ? 'working day' : 'working days';
    case 'weeks':
      return one ? 'week' : 'weeks';
    case 'months':
      return one ? 'month' : 'months';
  }
}

/**
 * When a document sent at `sentAt` counts as served: the same day if sent on a working day
 * before the project's cut-off (default 17:00 SGT), otherwise the next working day.
 * Returns the served date and the instant to store (sentAt itself, or 00:00 SGT on the later day).
 */
export function computeServedAt(sentAt: Date, cal: CalendarSettings): { servedDate: LocalDate; servedAt: Date } {
  const { date, minutes } = toSgt(sentAt);
  if (isWorkingDay(date, cal) && minutes < parseTimeOfDay(cal.serviceCutoff)) {
    return { servedDate: date, servedAt: sentAt };
  }
  const next = nextWorkingDay(date, cal);
  return { servedDate: next, servedAt: sgtInstant(next) };
}

/** Adds a period to a date. The trigger day itself is never counted. */
export function addPeriod(
  from: LocalDate,
  period: number,
  unit: PeriodUnit,
  cal: CalendarSettings,
  includesPublicHolidays: boolean,
): LocalDate {
  if (!Number.isInteger(period) || period < 0) throw new Error(`Period must be a whole number ≥ 0, got ${period}`);
  switch (unit) {
    case 'calendar_days':
      return addCalendarDays(from, period, cal, !includesPublicHolidays);
    case 'working_days':
      return addWorkingDays(from, period, cal, includesPublicHolidays);
    case 'weeks':
      return addDays(from, period * 7);
    case 'months':
      return addMonths(from, period);
  }
}

export interface DueDateInput {
  /** When the trigger happened (served_at for documents). */
  triggerAt: Date;
  /** Words for the trigger, e.g. "payment claim served". */
  triggerLabel: string;
  period: number;
  unit: PeriodUnit;
  /**
   * calendar_days: whether public holidays count (default true).
   * working_days: whether public holidays count as working days (default false).
   */
  includesPublicHolidays?: boolean;
  /** Statutory or contractual cap, always in calendar days from the same trigger. */
  cap?: { days: number; label: string } | null;
  /** Where the period came from, appended to the explanation (e.g. "project procedure"). */
  sourceLabel?: string | null;
  calendar: CalendarSettings;
}

export interface DueDateResult {
  dueDate: LocalDate;
  /** End of the due day, SGT. */
  dueAt: Date;
  explanation: string;
  capApplied: boolean;
  warnings: string[];
}

/**
 * Due date for "within `period` `unit` after `trigger`".
 * With a cap the result is the earlier of the two dates, i.e. min(period, cap).
 */
export function computeDueDate(input: DueDateInput): DueDateResult {
  const cal = input.calendar;
  const includesPH = input.includesPublicHolidays ?? input.unit !== 'working_days';
  const triggerDate = toSgt(input.triggerAt).date;

  let dueDate = addPeriod(triggerDate, input.period, input.unit, cal, includesPH);
  let capApplied = false;
  if (input.cap) {
    const capDate = addCalendarDays(triggerDate, input.cap.days, cal, false);
    if (capDate < dueDate) {
      dueDate = capDate;
      capApplied = true;
    }
  }

  const warnings: string[] = [];
  for (const y of new Set([yearOf(triggerDate), yearOf(dueDate)])) {
    if (!cal.holidayYears.has(y)) warnings.push(`No public holiday data for ${y}; working days may be off.`);
  }

  const shown = capApplied && input.cap ? input.cap.days : input.period;
  const shownUnit: PeriodUnit = capApplied ? 'calendar_days' : input.unit;
  const notes: string[] = [];
  if (input.unit === 'calendar_days' && !includesPH) notes.push('public holidays excluded');
  if (input.unit === 'working_days' && includesPH) notes.push('public holidays counted as working days');
  if (capApplied && input.cap) {
    notes.push(`${input.period} ${unitLabel(input.unit, input.period)} capped by ${input.cap.label}`);
  } else if (input.sourceLabel) {
    notes.push(input.sourceLabel);
  }
  const explanation =
    `${shown} ${unitLabel(shownUnit, shown)} after ${input.triggerLabel} on ${formatDate(triggerDate)}` +
    (notes.length ? ` (${notes.join('; ')})` : '');

  return { dueDate, dueAt: endOfDaySgt(dueDate), explanation, capApplied, warnings };
}
