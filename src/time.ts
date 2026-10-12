// Wall-clock time in the business time zone, and the free slots of a day.
//
// Everything is stored as local wall-clock text in the business time zone: dates 'YYYY-MM-DD', times 'HH:MM'
// and moments 'YYYY-MM-DDTHH:MM'. For arithmetic, a wall-clock moment becomes "minutes since 1970 as if
// it were UTC": adding minutes and days is then exact, and no conversion is needed until an .ics file asks
// for real UTC (zonedToUtc). On the rare days a time zone shifts its clock, a slot near the shift may be an
// hour off; Brazil has no daylight saving time.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

/** Whether `timeZone` is an IANA name this runtime knows (e.g. 'America/Sao_Paulo'). */
export function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock moment ('YYYY-MM-DDTHH:MM') of `at` in `timeZone`. */
export function wallClock(timeZone: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '00';
  const hour = part('hour') === '24' ? '00' : part('hour');
  return `${part('year')}-${part('month')}-${part('day')}T${hour}:${part('minute')}`;
}

/** Whether `value` is a real calendar date 'YYYY-MM-DD'. */
export function isDate(value: string): boolean {
  const match = DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Whether `value` is a time 'HH:MM' (00:00..23:59), or also '24:00' when `allowMidnightEnd`. */
export function isTime(value: string, allowMidnightEnd = false): boolean {
  return TIME.test(value) && (allowMidnightEnd || value !== '24:00');
}

/** Minutes since 1970-01-01T00:00 of a wall-clock 'YYYY-MM-DDTHH:MM' (or a date, at 00:00). */
export function toMinutes(local: string): number {
  const [date = '', time = '00:00'] = local.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0) / 60_000;
}

/** The wall-clock 'YYYY-MM-DDTHH:MM' of minutes since 1970 (the inverse of toMinutes). */
export function fromMinutes(minutes: number): string {
  return new Date(minutes * 60_000).toISOString().slice(0, 16);
}

export function addDays(date: string, days: number): string {
  return fromMinutes(toMinutes(date) + days * 1440).slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekday(date: string): number {
  return new Date(toMinutes(date) * 60_000).getUTCDay();
}

/** The real instant of a wall-clock moment in `timeZone` (for calendar files). */
export function zonedToUtc(local: string, timeZone: string): Date {
  const asUtc = toMinutes(local) * 60_000;
  const offsetAt = (instant: number) => toMinutes(wallClock(timeZone, new Date(instant))) * 60_000 - instant;
  const first = asUtc - offsetAt(asUtc);
  // A second pass corrects moments near a clock change
  return new Date(asUtc - offsetAt(first));
}

export type Range = { weekday: number; start_time: string; end_time: string };
export type Busy = { start_at: string; end_at: string };

/**
 * The free start times ('HH:MM') of `date` for a service of `duration` minutes: every `step` minutes from
 * the start of each opening range while start + duration fits in the range, not before `earliest`
 * ('YYYY-MM-DDTHH:MM'), and not overlapping any `busy` booking. Days off and the booking window are checked
 * by the caller.
 */
export function freeSlots(options: {
  date: string;
  duration: number;
  step: number;
  ranges: Range[];
  busy: Busy[];
  earliest: string;
}): string[] {
  const { date, duration, step, ranges, busy, earliest } = options;
  const day = weekday(date);
  const midnight = toMinutes(date);
  const slots = new Set<string>();
  for (const range of ranges) {
    if (range.weekday !== day) continue;
    const rangeStart = toMinutes(`${date}T${range.start_time}`);
    const rangeEnd = range.end_time === '24:00' ? midnight + 1440 : toMinutes(`${date}T${range.end_time}`);
    for (let start = rangeStart; start + duration <= rangeEnd; start += step) {
      const startAt = fromMinutes(start);
      const endAt = fromMinutes(start + duration);
      if (startAt < earliest) continue;
      if (busy.some((booking) => booking.start_at < endAt && booking.end_at > startAt)) continue;
      slots.add(startAt.slice(11));
    }
  }
  return [...slots].sort();
}
