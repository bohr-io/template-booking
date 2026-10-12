-- Booking: services, weekly hours, days off, bookings, settings and the request limiter.
-- Times are wall-clock strings in the business time zone (setting `timezone`): dates 'YYYY-MM-DD',
-- times 'HH:MM', moments 'YYYY-MM-DDTHH:MM'. They sort as text, so overlaps are plain string comparisons.

CREATE TABLE services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  duration INTEGER NOT NULL,              -- minutes, 5..480
  price INTEGER NOT NULL DEFAULT 0,       -- cents; 0 = free
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Opening hours: several ranges per weekday (0 = Sunday ... 6 = Saturday). `end_time` may be '24:00'.
CREATE TABLE availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL
);
CREATE INDEX availability_weekday ON availability (weekday, start_time);

-- Specific dates the business is closed.
CREATE TABLE days_off (
  date TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT ''
);

-- One resource (one person or chair): non-cancelled bookings never overlap. The service's name, duration,
-- price and currency are copied, so editing or deleting a service does not change past bookings.
CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  service_id INTEGER REFERENCES services (id) ON DELETE SET NULL,
  service_name TEXT NOT NULL,
  duration INTEGER NOT NULL,
  price INTEGER NOT NULL,
  currency TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX bookings_start_at ON bookings (start_at);

-- What the owner edits in the admin; an empty business name or description shows the page's default text.
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('business_name', ''),
  ('description', ''),
  ('timezone', 'America/Sao_Paulo'),
  ('currency', 'BRL'),
  ('slot_step', '30'),
  ('min_notice_hours', '2'),
  ('days_ahead', '30'),
  ('auto_confirm', '0');

INSERT INTO services (name, description, duration, price, active, sort_order) VALUES
  ('Consulta', 'Atendimento individual para entender o que você precisa e indicar o melhor caminho.', 30, 12000, 1, 1),
  ('Sessão completa', 'Uma hora inteira de atendimento, com tempo para tudo com calma.', 60, 25000, 1, 2),
  ('Avaliação gratuita', 'Uma conversa rápida para nos conhecermos. Sem compromisso.', 15, 0, 1, 3);

-- Monday to Friday, 09:00-12:00 and 13:00-18:00
INSERT INTO availability (weekday, start_time, end_time) VALUES
  (1, '09:00', '12:00'), (1, '13:00', '18:00'),
  (2, '09:00', '12:00'), (2, '13:00', '18:00'),
  (3, '09:00', '12:00'), (3, '13:00', '18:00'),
  (4, '09:00', '12:00'), (4, '13:00', '18:00'),
  (5, '09:00', '12:00'), (5, '13:00', '18:00');

CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
