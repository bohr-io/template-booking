// A calendar file (.ics, RFC 5545) with one event, so the customer can add the booking to their calendar.

const encoder = new TextEncoder();

/** Escapes text values (backslash, semicolon, comma and new lines). */
function escapeText(text: string): string {
  return text.replace(/[\\;,]/g, (char) => `\\${char}`).replace(/\r?\n/g, '\\n');
}

/** Folds a line at 75 octets, never inside a UTF-8 character. */
function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    if (size + bytes > 75) {
      out.push(current);
      current = ' ';
      size = 1;
    }
    current += char;
    size += bytes;
  }
  out.push(current);
  return out.join('\r\n');
}

/** '20261014T120000Z' */
function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function icsEvent(event: {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description: string;
  status: 'pending' | 'confirmed' | 'cancelled';
}): string {
  const status = { pending: 'TENTATIVE', confirmed: 'CONFIRMED', cancelled: 'CANCELLED' }[event.status];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//bohr//booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeText(event.uid)}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(event.start)}`,
    `DTEND:${stamp(event.end)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    `DESCRIPTION:${escapeText(event.description)}`,
    `STATUS:${status}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
