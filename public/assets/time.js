// Dates and times of the booking pages. The server sends wall-clock text in the business time zone
// ('YYYY-MM-DD', 'HH:MM', 'YYYY-MM-DDTHH:MM'); these helpers format it as is, never shifting it to the
// visitor's time zone (they build a UTC date and format it in UTC).
import { lang } from './ui.js';

/** A Date whose UTC fields are the wall-clock of 'YYYY-MM-DD', 'HH:MM' or 'YYYY-MM-DDTHH:MM'. */
export function wallDate(local) {
  const [date, time = '00:00'] = local.includes('-') ? local.split('T') : ['2000-01-01', local];
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
}

/** 'terça-feira, 14 de outubro' (or other Intl options), first letter in upper case. */
export function formatDay(local, options = { weekday: 'long', day: 'numeric', month: 'long' }) {
  const text = new Intl.DateTimeFormat(lang, { ...options, timeZone: 'UTC' }).format(wallDate(local));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** '09:00' (or '9:00 AM' in English). */
export function formatTime(local) {
  return new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(wallDate(local));
}

/** '30 min', '1 h', '1 h 30 min'. */
export function formatDuration(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** 'YYYY-MM-DD' plus `days`. */
export function addDays(date, days) {
  const next = wallDate(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** Short weekday names from Monday to Sunday ('seg', 'ter', ...). */
export function weekdayNames(style = 'short') {
  // 2024-01-01 was a Monday
  return Array.from({ length: 7 }, (_, index) => formatDay(addDays('2024-01-01', index), { weekday: style }));
}
