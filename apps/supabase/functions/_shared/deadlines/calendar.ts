// Calendar maths in Singapore time (Asia/Singapore, UTC+8, no daylight saving since 1982).
// Pure: no clock, no I/O. Holidays and settings are always passed in.
//
// A LocalDate is a calendar date in SGT written 'YYYY-MM-DD'.

export type LocalDate = string;

export const SGT_OFFSET_MINUTES = 8 * 60;
const DAY_MS = 86_400_000;

export interface CalendarSettings {
  /** Singapore public holidays (including substitute Mondays) as LocalDates. */
  holidays: ReadonlySet<LocalDate>;
  /** Years the holiday list covers. Dates outside these years produce a warning. */
  holidayYears: ReadonlySet<number>;
  /** Saturdays count as working days (default false: Mon–Fri). */
  saturdayIsWorkingDay: boolean;
  /** Documents sent on a working day before this time (HH:MM, SGT) are served that day. */
  serviceCutoff: string;
}

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(d: LocalDate): [number, number, number] {
  const m = LOCAL_DATE_RE.exec(d);
  if (!m) throw new Error(`Invalid date '${d}', expected YYYY-MM-DD`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function fromUtcMidnight(ms: number): LocalDate {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcMidnight(d: LocalDate): number {
  const [y, m, day] = parts(d);
  return Date.UTC(y, m - 1, day);
}

/** The SGT calendar date and minutes past midnight of an instant. */
export function toSgt(at: Date): { date: LocalDate; minutes: number } {
  const shifted = at.getTime() + SGT_OFFSET_MINUTES * 60_000;
  const date = fromUtcMidnight(Math.floor(shifted / DAY_MS) * DAY_MS);
  const minutes = Math.floor((shifted % DAY_MS) / 60_000);
  return { date, minutes };
}

/** The instant at `minutes` past midnight SGT on a date. */
export function sgtInstant(d: LocalDate, minutes = 0): Date {
  return new Date(utcMidnight(d) - SGT_OFFSET_MINUTES * 60_000 + minutes * 60_000);
}

/** 23:59:59.999 SGT on a date: deadlines run to the end of their due day. */
export function endOfDaySgt(d: LocalDate): Date {
  return new Date(sgtInstant(d).getTime() + DAY_MS - 1);
}

export function addDays(d: LocalDate, n: number): LocalDate {
  return fromUtcMidnight(utcMidnight(d) + n * DAY_MS);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round((utcMidnight(b) - utcMidnight(a)) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekday(d: LocalDate): number {
  return new Date(utcMidnight(d)).getUTCDay();
}

export function yearOf(d: LocalDate): number {
  return parts(d)[0];
}

export function isPublicHoliday(d: LocalDate, cal: CalendarSettings): boolean {
  return cal.holidays.has(d);
}

export function isWorkingDay(d: LocalDate, cal: CalendarSettings): boolean {
  const wd = weekday(d);
  if (wd === 0) return false;
  if (wd === 6 && !cal.saturdayIsWorkingDay) return false;
  return !isPublicHoliday(d, cal);
}

export function nextWorkingDay(d: LocalDate, cal: CalendarSettings): LocalDate {
  let cur = addDays(d, 1);
  while (!isWorkingDay(cur, cal)) cur = addDays(cur, 1);
  return cur;
}

/**
 * N working days after d (d itself not counted). Weekends are always skipped;
 * public holidays are skipped unless `includePublicHolidays`.
 */
export function addWorkingDays(d: LocalDate, n: number, cal: CalendarSettings, includePublicHolidays = false): LocalDate {
  const counts = (x: LocalDate) => {
    const wd = weekday(x);
    if (wd === 0 || (wd === 6 && !cal.saturdayIsWorkingDay)) return false;
    return includePublicHolidays || !isPublicHoliday(x, cal);
  };
  let cur = d;
  let left = n;
  while (left > 0) {
    cur = addDays(cur, 1);
    if (counts(cur)) left--;
  }
  return cur;
}

/** N working days before d (d itself not counted). Public holidays are skipped. */
export function subtractWorkingDays(d: LocalDate, n: number, cal: CalendarSettings): LocalDate {
  let cur = d;
  let left = n;
  while (left > 0) {
    cur = addDays(cur, -1);
    if (isWorkingDay(cur, cal)) left--;
  }
  return cur;
}

/** N calendar days after d, skipping public holidays when `excludePublicHolidays`. */
export function addCalendarDays(d: LocalDate, n: number, cal: CalendarSettings, excludePublicHolidays = false): LocalDate {
  if (!excludePublicHolidays) return addDays(d, n);
  let cur = d;
  let left = n;
  while (left > 0) {
    cur = addDays(cur, 1);
    if (!isPublicHoliday(cur, cal)) left--;
  }
  return cur;
}

/** Corresponding date N months later, clamped to the end of a shorter month (31 Jan + 1 = 28/29 Feb). */
export function addMonths(d: LocalDate, n: number): LocalDate {
  const [y, m, day] = parts(d);
  const targetMonthIndex = m - 1 + n;
  const ty = y + Math.floor(targetMonthIndex / 12);
  const tm = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return fromUtcMidnight(Date.UTC(ty, tm, Math.min(day, lastDay)));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3 Mar 2026" */
export function formatDate(d: LocalDate): string {
  const [y, m, day] = parts(d);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}

/** "Fri 14 Mar" (with the year when `withYear`). */
export function formatShortDate(d: LocalDate, withYear = false): string {
  const [y, m, day] = parts(d);
  return `${WEEKDAYS[weekday(d)]} ${day} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

/** Parses 'HH:MM' into minutes past midnight. */
export function parseTimeOfDay(t: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  if (!m) throw new Error(`Invalid time '${t}', expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function buildCalendar(input: {
  holidays: Iterable<LocalDate>;
  saturdayIsWorkingDay?: boolean;
  serviceCutoff?: string;
}): CalendarSettings {
  const holidays = new Set(input.holidays);
  const holidayYears = new Set([...holidays].map(yearOf));
  const serviceCutoff = input.serviceCutoff ?? '17:00';
  parseTimeOfDay(serviceCutoff);
  return { holidays, holidayYears, saturdayIsWorkingDay: input.saturdayIsWorkingDay ?? false, serviceCutoff };
}
