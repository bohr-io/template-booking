import { Hono } from 'hono';
import type { AppEnv } from './env';
import { icsEvent } from './ics';
import { auth, requireAdmin } from './lib/auth';
import { apiGuard, csvResponse, fail, onError, rateLimit, readJson, serveAssets } from './lib/http';
import { boolean, email, id, integer, oneOf, text } from './lib/validate';
import {
  addDays,
  type Busy,
  freeSlots,
  fromMinutes,
  isDate,
  isTime,
  type Range,
  toMinutes,
  validTimeZone,
  wallClock,
  zonedToUtc,
} from './time';

// Appointments for a small business with one resource (one person or one chair): customers pick a service,
// a day and a free time; bookings never overlap, whatever the service. See time.ts for how times are kept.

type Settings = {
  business_name: string;
  description: string;
  timezone: string;
  currency: string;
  slot_step: number;
  min_notice_hours: number;
  days_ahead: number;
  auto_confirm: boolean;
};
type Service = { id: number; name: string; description: string; duration: number; price: number };
type Status = 'pending' | 'confirmed' | 'cancelled';
type Booking = {
  id: number;
  code: string;
  service_id: number | null;
  service_name: string;
  duration: number;
  price: number;
  currency: string;
  start_at: string;
  end_at: string;
  name: string;
  email: string;
  phone: string;
  note: string;
  status: Status;
  created_at: string;
};

const STATUSES = ['pending', 'confirmed', 'cancelled'] as const;
const SLOT_STEPS = [15, 30, 60];
const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

async function loadSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  const map = new Map(results.map((row) => [row.key, row.value]));
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(map.get(key));
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  };
  const timezone = map.get('timezone') ?? '';
  const currency = map.get('currency') ?? '';
  const step = number('slot_step', 30, 1, 1440);
  return {
    business_name: map.get('business_name') ?? '',
    description: map.get('description') ?? '',
    timezone: timezone !== '' && validTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : 'BRL',
    slot_step: SLOT_STEPS.includes(step) ? step : 30,
    min_notice_hours: number('min_notice_hours', 2, 0, 720),
    days_ahead: number('days_ahead', 30, 1, 365),
    auto_confirm: map.get('auto_confirm') === '1',
  };
}

/** "Now" in the business time zone, the earliest bookable moment and the bookable dates (today..lastDate). */
function bookingWindow(settings: Settings) {
  const now = wallClock(settings.timezone);
  const today = now.slice(0, 10);
  return {
    now,
    today,
    lastDate: addDays(today, settings.days_ahead - 1),
    earliest: fromMinutes(toMinutes(now) + settings.min_notice_hours * 60),
  };
}
type Window = ReturnType<typeof bookingWindow>;

/** Opening hours, days off and the non-cancelled bookings touching the dates `from`..`to`. */
async function loadSchedule(db: D1Database, from: string, to: string) {
  const [ranges, daysOff, busy] = await Promise.all([
    db.prepare('SELECT weekday, start_time, end_time FROM availability ORDER BY weekday, start_time').all<Range>(),
    db.prepare('SELECT date FROM days_off WHERE date BETWEEN ? AND ?').bind(from, to).all<{ date: string }>(),
    db
      .prepare("SELECT start_at, end_at FROM bookings WHERE status != 'cancelled' AND start_at < ? AND end_at > ?")
      .bind(`${addDays(to, 1)}T00:00`, `${from}T00:00`)
      .all<Busy>(),
  ]);
  return { ranges: ranges.results, daysOff: new Set(daysOff.results.map((row) => row.date)), busy: busy.results };
}
type Schedule = Awaited<ReturnType<typeof loadSchedule>>;

/** The free start times of `date` for `service` (empty outside the booking window and on days off). */
function slotsFor(date: string, service: Service, settings: Settings, window: Window, schedule: Schedule): string[] {
  if (date < window.today || date > window.lastDate || schedule.daysOff.has(date)) return [];
  return freeSlots({
    date,
    duration: service.duration,
    step: settings.slot_step,
    ranges: schedule.ranges,
    busy: schedule.busy,
    earliest: window.earliest,
  });
}

/** An active service by id, or 404 `service_unavailable`. */
async function activeService(db: D1Database, value: unknown): Promise<Service> {
  const serviceId = integer(value, 'service', 1, 1e12);
  const service = await db
    .prepare('SELECT id, name, description, duration, price FROM services WHERE id = ? AND active = 1')
    .bind(serviceId)
    .first<Service>();
  if (!service) fail(404, 'service_unavailable');
  return service;
}

function dateInput(value: unknown, field = 'date'): string {
  const date = text(value, field, { max: 10 });
  if (!isDate(date)) fail(400, `invalid_${field}`);
  return date;
}

// Booking codes: 8 symbols from 32 (no I, L, O, U), about 10^12 combinations, so they can't be guessed.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function bookingCode(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => CODE_ALPHABET.charAt(byte % 32)).join('');
}

/** What the customer may see of a booking (no contact details). */
function publicBooking(booking: Booking, settings: Settings) {
  const { code, service_name, duration, price, currency, start_at, end_at, status } = booking;
  return { code, service_name, duration, price, currency, start_at, end_at, status, timezone: settings.timezone };
}

const app = new Hono<AppEnv>();
app.onError(onError);
app.use('/api/*', apiGuard);
app.route('/api/auth', auth);
app.use('/api/admin/*', requireAdmin);

// Public: business texts, active services and the booking window
app.get('/api/page', async (c) => {
  const settings = await loadSettings(c.env.DB);
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, description, duration, price FROM services WHERE active = 1 ORDER BY sort_order, id',
  ).all<Service>();
  const window = bookingWindow(settings);
  return c.json({
    business_name: settings.business_name,
    description: settings.description,
    timezone: settings.timezone,
    currency: settings.currency,
    today: window.today,
    lastDate: window.lastDate,
    services: results,
  });
});

// Public: how many free times each bookable day has for a service
app.get('/api/days', async (c) => {
  const settings = await loadSettings(c.env.DB);
  const service = await activeService(c.env.DB, c.req.query('service'));
  const window = bookingWindow(settings);
  const schedule = await loadSchedule(c.env.DB, window.today, window.lastDate);
  const days: { date: string; slots: number }[] = [];
  for (let date = window.today; date <= window.lastDate; date = addDays(date, 1)) {
    days.push({ date, slots: slotsFor(date, service, settings, window, schedule).length });
  }
  return c.json({ days });
});

// Public: the free start times of one day for a service
app.get('/api/slots', async (c) => {
  const settings = await loadSettings(c.env.DB);
  const service = await activeService(c.env.DB, c.req.query('service'));
  const date = dateInput(c.req.query('date'));
  const window = bookingWindow(settings);
  const schedule = await loadSchedule(c.env.DB, date, date);
  return c.json({ date, slots: slotsFor(date, service, settings, window, schedule) });
});

// Public: book a time. Everything is checked again here; the insert itself refuses an overlapping booking,
// so two people choosing the same time at the same moment can't both get it (409 `slot_taken`).
app.post('/api/bookings', async (c) => {
  const body = await readJson(c, 8192);
  // Bots fill the hidden "website" field: they get a success and nothing is stored
  if (typeof body.website === 'string' && body.website !== '') return c.json({ booking: null }, 201);
  await rateLimit(c, 'booking', 20, 60 * 60);
  const date = dateInput(body.date);
  const time = text(body.time, 'time', { max: 5 });
  if (!isTime(time)) fail(400, 'invalid_time');
  const customer = {
    name: text(body.name, 'name', { max: 100, min: 2 }),
    email: email(body.email),
    phone: text(body.phone, 'phone', { max: 30, optional: true }),
    note: text(body.note, 'note', { max: 1000, optional: true, multiline: true }),
  };
  if (customer.phone !== '' && !/^[0-9+()\-.\s]{6,30}$/.test(customer.phone)) fail(400, 'invalid_phone');

  const settings = await loadSettings(c.env.DB);
  const service = await activeService(c.env.DB, body.service);
  const window = bookingWindow(settings);
  if (date < window.today || date > window.lastDate) fail(400, 'invalid_date');
  const schedule = await loadSchedule(c.env.DB, date, date);
  if (!slotsFor(date, service, settings, window, schedule).includes(time)) fail(409, 'slot_taken');

  const startAt = `${date}T${time}`;
  const endAt = fromMinutes(toMinutes(startAt) + service.duration);
  const status: Status = settings.auto_confirm ? 'confirmed' : 'pending';
  const insert = c.env.DB.prepare(
    `INSERT INTO bookings (code, service_id, service_name, duration, price, currency, start_at, end_at,
       name, email, phone, note, status)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
     WHERE NOT EXISTS (SELECT 1 FROM bookings WHERE status != 'cancelled' AND start_at < ?8 AND end_at > ?7)
     RETURNING *`,
  );
  let booking: Booking | null = null;
  for (let attempt = 1; ; attempt++) {
    try {
      booking = await insert
        .bind(
          bookingCode(),
          service.id,
          service.name,
          service.duration,
          service.price,
          settings.currency,
          startAt,
          endAt,
          customer.name,
          customer.email,
          customer.phone,
          customer.note,
          status,
        )
        .first<Booking>();
      break;
    } catch (error) {
      // A repeated code (astronomically rare): try another one
      if (attempt < 3 && String(error).includes('UNIQUE')) continue;
      throw error;
    }
  }
  if (booking === null) fail(409, 'slot_taken');
  return c.json({ booking: publicBooking(booking, settings) }, 201);
});

// Public: a booking by its code (GET /api/bookings/ABCD1234), or its calendar file (.../ABCD1234.ics)
app.get('/api/bookings/:code', async (c) => {
  const raw = c.req.param('code');
  const calendar = raw.endsWith('.ics');
  const code = (calendar ? raw.slice(0, -4) : raw).toUpperCase();
  if (!/^[0-9A-Z]{8}$/.test(code)) fail(404, 'not_found');
  await rateLimit(c, 'lookup', 120, 10 * 60);
  const booking = await c.env.DB.prepare('SELECT * FROM bookings WHERE code = ?').bind(code).first<Booking>();
  if (!booking) fail(404, 'not_found');
  const settings = await loadSettings(c.env.DB);
  if (!calendar) return c.json({ booking: publicBooking(booking, settings) });

  const origin = new URL(c.req.url).origin;
  const ics = icsEvent({
    uid: `${booking.code}@${new URL(c.req.url).hostname}`,
    start: zonedToUtc(booking.start_at, settings.timezone),
    end: zonedToUtc(booking.end_at, settings.timezone),
    summary: settings.business_name ? `${booking.service_name} · ${settings.business_name}` : booking.service_name,
    description: `#${booking.code}\n${origin}/?code=${booking.code}`,
    status: booking.status,
  });
  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="booking-${booking.code}.ics"`,
      'Cache-Control': 'no-store',
    },
  });
});

// Admin: today, the next 7 days and pending requests
app.get('/api/admin/stats', async (c) => {
  const window = bookingWindow(await loadSettings(c.env.DB));
  const row = await c.env.DB.prepare(
    `SELECT
       COALESCE(SUM(status != 'cancelled' AND substr(start_at, 1, 10) = ?1), 0) AS today,
       COALESCE(SUM(status != 'cancelled' AND start_at >= ?2 AND start_at < ?3), 0) AS week,
       COALESCE(SUM(status = 'pending' AND start_at >= ?2), 0) AS pending
     FROM bookings`,
  )
    .bind(window.today, window.now, fromMinutes(toMinutes(window.now) + 7 * 1440))
    .first<{ today: number; week: number; pending: number }>();
  return c.json(row ?? { today: 0, week: 0, pending: 0 });
});

// Admin: bookings from today on (or from 90 days ago with past=1), by start time
app.get('/api/admin/bookings', async (c) => {
  const status = oneOf(c.req.query('status') ?? 'all', 'status', ['all', ...STATUSES]);
  const past = c.req.query('past') === '1';
  const window = bookingWindow(await loadSettings(c.env.DB));
  const from = `${past ? addDays(window.today, -90) : window.today}T00:00`;
  const statement =
    status === 'all'
      ? c.env.DB.prepare('SELECT * FROM bookings WHERE start_at >= ? ORDER BY start_at LIMIT 500').bind(from)
      : c.env.DB.prepare('SELECT * FROM bookings WHERE start_at >= ? AND status = ? ORDER BY start_at LIMIT 500').bind(
          from,
          status,
        );
  const { results } = await statement.all<Booking>();
  return c.json({ items: results, today: window.today, now: window.now });
});

// Admin: confirm, cancel or restore a booking. A booking comes back from "cancelled" only if its time is free.
app.patch('/api/admin/bookings/:id', async (c) => {
  const bookingId = id(c.req.param('id'));
  const body = await readJson(c, 1024);
  const status = oneOf(body.status, 'status', STATUSES);
  const result = await c.env.DB.prepare(
    `UPDATE bookings SET status = ?1 WHERE id = ?2 AND (?1 = 'cancelled' OR status != 'cancelled' OR NOT EXISTS (
       SELECT 1 FROM bookings AS other WHERE other.id != bookings.id AND other.status != 'cancelled'
         AND other.start_at < bookings.end_at AND other.end_at > bookings.start_at))`,
  )
    .bind(status, bookingId)
    .run();
  const booking = await c.env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(bookingId).first<Booking>();
  if (!booking) fail(404, 'not_found');
  if (result.meta.changes === 0) fail(409, 'slot_taken');
  return c.json(booking);
});

app.get('/api/admin/bookings.csv', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM bookings ORDER BY start_at').all<Booking>();
  const columns = ['code', 'start_at', 'end_at', 'service', 'duration', 'price', 'currency', 'status', 'name', 'email', 'phone', 'note', 'created_at'];
  return csvResponse(
    'bookings.csv',
    columns,
    results.map((row) => [
      row.code,
      row.start_at,
      row.end_at,
      row.service_name,
      row.duration,
      (row.price / 100).toFixed(2),
      row.currency,
      row.status,
      row.name,
      row.email,
      row.phone,
      row.note,
      row.created_at,
    ]),
  );
});

// Admin: services
function serviceInput(body: Record<string, unknown>) {
  return {
    name: text(body.name, 'service_name', { max: 80 }),
    description: text(body.description, 'description', { max: 500, optional: true, multiline: true }),
    duration: integer(body.duration, 'duration', 5, 480),
    price: integer(body.price, 'price', 0, 100_000_000),
    active: boolean(body.active, 'active') ? 1 : 0,
  };
}

app.get('/api/admin/services', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM services ORDER BY sort_order, id').all();
  return c.json({ items: results });
});

app.post('/api/admin/services', async (c) => {
  const service = serviceInput(await readJson(c));
  const created = await c.env.DB.prepare(
    `INSERT INTO services (name, description, duration, price, active, sort_order)
     VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM services)) RETURNING *`,
  )
    .bind(service.name, service.description, service.duration, service.price, service.active)
    .first();
  return c.json(created, 201);
});

// The new order, as the list of service ids from first to last
app.put('/api/admin/services/order', async (c) => {
  const body = await readJson(c);
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 500) fail(400, 'invalid_ids');
  const ids = body.ids.map((value) => integer(value, 'ids', 1, 1e12));
  if (new Set(ids).size !== ids.length) fail(400, 'invalid_ids');
  await c.env.DB.batch(
    ids.map((serviceId, index) => c.env.DB.prepare('UPDATE services SET sort_order = ? WHERE id = ?').bind(index + 1, serviceId)),
  );
  return c.json({ ok: true });
});

app.put('/api/admin/services/:id', async (c) => {
  const serviceId = id(c.req.param('id'));
  const service = serviceInput(await readJson(c));
  const updated = await c.env.DB.prepare(
    'UPDATE services SET name = ?, description = ?, duration = ?, price = ?, active = ? WHERE id = ? RETURNING *',
  )
    .bind(service.name, service.description, service.duration, service.price, service.active, serviceId)
    .first();
  if (!updated) fail(404, 'not_found');
  return c.json(updated);
});

// Bookings keep their copy of the service's name, duration and price
app.delete('/api/admin/services/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM services WHERE id = ?').bind(id(c.req.param('id'))).run();
  if (result.meta.changes === 0) fail(404, 'not_found');
  return c.json({ ok: true });
});

// Admin: weekly opening hours and days off
app.get('/api/admin/availability', async (c) => {
  const window = bookingWindow(await loadSettings(c.env.DB));
  const [ranges, daysOff] = await Promise.all([
    c.env.DB.prepare('SELECT weekday, start_time, end_time FROM availability ORDER BY weekday, start_time').all<Range>(),
    c.env.DB.prepare('SELECT date, note FROM days_off WHERE date >= ? ORDER BY date').bind(window.today).all(),
  ]);
  return c.json({ ranges: ranges.results, days_off: daysOff.results });
});

// Replaces all the weekly ranges. An end of '00:00' means midnight at the end of the day ('24:00').
app.put('/api/admin/availability', async (c) => {
  const body = await readJson(c);
  if (!Array.isArray(body.ranges) || body.ranges.length > 100) fail(400, 'invalid_range');
  const ranges: Range[] = body.ranges.map((value: unknown) => {
    const item = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
    const start = text(item.start_time, 'range', { max: 5 });
    let end = text(item.end_time, 'range', { max: 5 });
    if (end === '00:00') end = '24:00';
    if (!isTime(start) || !isTime(end, true) || start >= end) fail(400, 'invalid_range');
    return { weekday: integer(item.weekday, 'range', 0, 6), start_time: start, end_time: end };
  });
  ranges.sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time));
  ranges.forEach((range, index) => {
    const previous = ranges[index - 1];
    if (previous && previous.weekday === range.weekday && previous.end_time > range.start_time) {
      fail(400, 'overlapping_ranges');
    }
  });
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM availability'),
    ...ranges.map((range) =>
      c.env.DB.prepare('INSERT INTO availability (weekday, start_time, end_time) VALUES (?, ?, ?)').bind(
        range.weekday,
        range.start_time,
        range.end_time,
      ),
    ),
  ]);
  return c.json({ ranges });
});

app.post('/api/admin/days-off', async (c) => {
  const body = await readJson(c);
  const date = dateInput(body.date);
  const note = text(body.note, 'day_off_note', { max: 100, optional: true });
  await c.env.DB.prepare('INSERT INTO days_off (date, note) VALUES (?, ?) ON CONFLICT (date) DO UPDATE SET note = excluded.note')
    .bind(date, note)
    .run();
  return c.json({ date, note }, 201);
});

app.delete('/api/admin/days-off/:date', async (c) => {
  const date = c.req.param('date');
  if (!isDate(date)) fail(404, 'not_found');
  const result = await c.env.DB.prepare('DELETE FROM days_off WHERE date = ?').bind(date).run();
  if (result.meta.changes === 0) fail(404, 'not_found');
  return c.json({ ok: true });
});

// Admin: settings
app.get('/api/admin/settings', async (c) => c.json(await loadSettings(c.env.DB)));

app.put('/api/admin/settings', async (c) => {
  const body = await readJson(c);
  const timezone = text(body.timezone, 'timezone', { max: 64 });
  if (!validTimeZone(timezone)) fail(400, 'invalid_timezone');
  const currency = text(body.currency, 'currency', { max: 3 }).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail(400, 'invalid_currency');
  const step = integer(body.slot_step, 'slot_step', 1, 1440);
  if (!SLOT_STEPS.includes(step)) fail(400, 'invalid_slot_step');
  const values: Record<keyof Settings, string> = {
    business_name: text(body.business_name, 'business_name', { max: 80, optional: true }),
    description: text(body.description, 'description', { max: 600, optional: true, multiline: true }),
    timezone,
    currency,
    slot_step: String(step),
    min_notice_hours: String(integer(body.min_notice_hours, 'min_notice_hours', 0, 720)),
    days_ahead: String(integer(body.days_ahead, 'days_ahead', 1, 365)),
    auto_confirm: boolean(body.auto_confirm, 'auto_confirm') ? '1' : '0',
  };
  await c.env.DB.batch(
    Object.entries(values).map(([key, value]) =>
      c.env.DB.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      ).bind(key, value),
    ),
  );
  return c.json(await loadSettings(c.env.DB));
});

app.all('/api/*', () => fail(404, 'not_found'));
app.all('*', serveAssets);

export default app;
