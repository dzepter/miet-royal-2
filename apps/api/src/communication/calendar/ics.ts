/**
 * iCalendar-Erzeugung (RFC 5545 / RFC 7986) für den privaten Staff-Feed
 * (Order §33/§34). Reine Formatierung ohne DB:
 * - CRLF-Zeilenenden, Faltung auf ≤ 75 Oktette (Fortsetzung = CRLF + SPACE),
 *   nie innerhalb einer UTF-8-Sequenz (RFC 5545 §3.1)
 * - TEXT-Escaping: Backslash, Komma, Semikolon, Zeilenumbruch (§3.3.11)
 * - VTIMEZONE Europe/Berlin eingebettet (§3.6.5: Pflicht je TZID), feste
 *   EU-Sommerzeitregeln (letzter Sonntag März/Oktober)
 * - UID = `<appointmentId>@miet-royal`, SEQUENCE = Terminversion − 1
 *   (RFC §3.8.7.4: Startwert 0, monoton steigend)
 * - keine VALARM, keine LOCATION, keine Kundendaten (Order §34)
 */

export const ICS_TIMEZONE = 'Europe/Berlin';
export const ICS_PRODID = '-//Miet-Royal//Staff Calendar//DE';
const MAX_LINE_OCTETS = 75;

export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/** Faltet eine logische Zeile RFC-konform (Oktette, nicht Zeichen). */
export function foldIcsLine(line: string): string[] {
  const encoder = new TextEncoder();
  const out: string[] = [];
  let current = '';
  let currentOctets = 0;
  let limit = MAX_LINE_OCTETS;
  for (const char of line) {
    const octets = encoder.encode(char).length;
    if (currentOctets + octets > limit) {
      out.push(current);
      current = ' ';
      currentOctets = 1;
      limit = MAX_LINE_OCTETS;
    }
    current += char;
    currentOctets += octets;
  }
  out.push(current);
  return out;
}

export function foldIcs(lines: readonly string[]): string {
  return lines.flatMap((line) => foldIcsLine(line)).join('\r\n') + '\r\n';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** UTC-Zeitstempel `YYYYMMDDTHHMMSSZ`. */
export function formatUtc(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** Lokale Berliner Wanduhrzeit `YYYYMMDDTHHMMSS` (für DTSTART;TZID=Europe/Berlin). */
export function formatBerlinLocal(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ICS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}T${get('hour')}${get('minute')}${get('second')}`;
}

export const BERLIN_VTIMEZONE_LINES: readonly string[] = [
  'BEGIN:VTIMEZONE',
  `TZID:${ICS_TIMEZONE}`,
  'BEGIN:STANDARD',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
];

export type IcsAppointmentKind = 'pickup' | 'delivery' | 'return';

const KIND_LABELS: Record<IcsAppointmentKind, string> = {
  pickup: 'Abholung',
  delivery: 'Lieferung',
  return: 'Rückgabe',
};

export function icsKindLabel(kind: IcsAppointmentKind): string {
  return KIND_LABELS[kind];
}

export interface IcsEventInput {
  appointmentId: string;
  kind: IcsAppointmentKind;
  processNumber: string;
  startAt: Date;
  endAt: Date | null;
  /** appointments.version (beginnt bei 1) ⇒ SEQUENCE = version − 1. */
  version: number;
  /** Staff-App-Link (absolut, wenn Basis-URL konfiguriert; sonst relativ). */
  appUrl: string;
}

export const DEFAULT_EVENT_DURATION_MS = 60 * 60_000;

export function buildIcsEventLines(event: IcsEventInput, now: Date): string[] {
  const label = icsKindLabel(event.kind);
  const end = event.endAt ?? new Date(event.startAt.getTime() + DEFAULT_EVENT_DURATION_MS);
  const summary = `Miet-Royal – ${label} ${event.processNumber}`;
  const description = `${label} ${event.processNumber}\n${event.appUrl}`;
  return [
    'BEGIN:VEVENT',
    `UID:${event.appointmentId}@miet-royal`,
    `DTSTAMP:${formatUtc(now)}`,
    `DTSTART;TZID=${ICS_TIMEZONE}:${formatBerlinLocal(event.startAt)}`,
    `DTEND;TZID=${ICS_TIMEZONE}:${formatBerlinLocal(end)}`,
    `SEQUENCE:${Math.max(0, event.version - 1)}`,
    `SUMMARY:${escapeIcsText(summary)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    // RFC 5545 §3.8.4.6: URL ist eine absolute URI – ohne konfigurierte
    // Staff-Basis-URL (relativer Link) entfällt die Property; der Link bleibt
    // in der Beschreibung.
    ...(/^https?:\/\//.test(event.appUrl) ? [`URL:${event.appUrl}`] : []),
    'END:VEVENT',
  ];
}

export interface IcsCalendarInput {
  /** Anzeigename der Mitarbeiterin/des Mitarbeiters (nur Vor-/Nachname). */
  displayName: string;
  events: readonly IcsEventInput[];
  now: Date;
}

/** Vollständiges VCALENDAR-Objekt (CRLF, gefaltet). */
export function buildIcsCalendar(input: IcsCalendarInput): string {
  const name = `Miet-Royal – ${input.displayName}`;
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${ICS_PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `NAME:${escapeIcsText(name)}`,
    `X-WR-CALNAME:${escapeIcsText(name)}`,
    `X-WR-TIMEZONE:${ICS_TIMEZONE}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...BERLIN_VTIMEZONE_LINES,
  ];
  for (const event of input.events) lines.push(...buildIcsEventLines(event, input.now));
  lines.push('END:VCALENDAR');
  return foldIcs(lines);
}

/**
 * Minimaler Parser für Tests/Selbstprüfung: entfaltet Zeilen und liefert
 * Name/Wert-Paare (Parameter bleiben Teil des Namens). Kein vollständiger
 * iCalendar-Parser – ausreichend, um Struktur und Felder zu prüfen.
 */
export function unfoldIcs(text: string): string[] {
  const raw = text.split('\r\n');
  const lines: string[] = [];
  for (const line of raw) {
    if (line === '') continue;
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}
