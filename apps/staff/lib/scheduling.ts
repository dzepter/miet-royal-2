'use client';

/** Gemeinsame Typen/Helfer des Termin-/Kalenderbereichs (nur Darstellung). */

export const KIND_LABELS: Record<string, string> = {
  pickup: 'Abholung / Ausgabe',
  return: 'Rückgabe',
  delivery: 'Lieferung',
};

export const KIND_BADGE_CLASS: Record<string, string> = {
  pickup: 'chip-pickup',
  return: 'chip-return',
  delivery: 'chip-delivery',
};

export interface CalendarConflictInfo {
  type: string;
  severity: 'warning' | 'strong';
  reason: string;
  appointmentIds: string[];
}

export interface CalendarEntry {
  id: string;
  processId: string;
  processNumber: string;
  bookingId: string;
  kind: 'pickup' | 'return' | 'delivery';
  status: 'scheduled' | 'completed' | 'cancelled';
  startAt: string | null;
  endAt: string | null;
  timezone: string;
  locationKind: 'base' | 'customer';
  locationLabel: string;
  customerName: string;
  customerPhone: string | null;
  machineName: string | null;
  assignedUserId: string | null;
  assignedName: string | null;
  effectiveAssigneeId: string | null;
  effectiveAssigneeName: string | null;
  substituted: boolean;
  overdue: boolean;
  overdueIncident: {
    id: string;
    missedAt: string;
    customerContactedAt: string | null;
  } | null;
  customerInfoRequiredAt: string | null;
  acknowledgementPending: boolean;
  acknowledgementRequestedFor: string | null;
  completedAt: string | null;
  version: number;
  conflicts: CalendarConflictInfo[];
}

/** Berliner Kalendertag (yyyy-mm-dd) eines ISO-Zeitpunkts. */
export function berlinDayOf(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

export function berlinTime(iso: string | null): string {
  if (iso === null) return '–';
  return new Date(iso).toLocaleTimeString('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Uhrzeit bzw. Zeitfenster eines Termins (Europe/Berlin). */
export function timeLabel(entry: Pick<CalendarEntry, 'startAt' | 'endAt'>): string {
  if (entry.startAt === null) return 'Zeit festlegen';
  if (entry.endAt === null) return `${berlinTime(entry.startAt)} Uhr`;
  return `${berlinTime(entry.startAt)}–${berlinTime(entry.endAt)} Uhr`;
}

/**
 * Zeit MIT Datum, wenn der Termin nicht am heutigen Berliner Tag liegt –
 * für „Heute“-Listen mit überfälligen/kommenden Terminen (Order §22/§23).
 */
export function dayTimeLabel(entry: Pick<CalendarEntry, 'startAt' | 'endAt'>): string {
  if (entry.startAt === null) return 'Zeit festlegen';
  const day = berlinDayOf(entry.startAt);
  if (day === todayBerlinIso()) return timeLabel(entry);
  return `${berlinDateLabel(day)}, ${timeLabel(entry)}`;
}

export function berlinDateLabel(dayIso: string): string {
  const [y, m, d] = dayIso.split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).toLocaleDateString('de-DE', {
    timeZone: 'UTC',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });
}

export function isoDayShift(dayIso: string, days: number): string {
  const [y, m, d] = dayIso.split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

export function todayBerlinIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Montag der Woche eines ISO-Tags (kalendarisch). */
export function mondayOf(dayIso: string): string {
  const [y, m, d] = dayIso.split('-').map(Number);
  const date = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  const weekday = (date.getUTCDay() + 6) % 7; // 0 = Montag
  return isoDayShift(dayIso, -weekday);
}

export function firstOfMonth(dayIso: string): string {
  return `${dayIso.slice(0, 7)}-01`;
}

/** Berliner Wanduhrzeit eines Zeitpunkts (z. B. für DnD-Erhalt der Uhrzeit). */
export function berlinWallTime(iso: string): { hour: number; minute: number } {
  const text = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
  const [hour, minute] = text.split(':').map(Number);
  return { hour: hour ?? 0, minute: minute ?? 0 };
}

/** DST-feste Konstruktion "Berliner Tag + Uhrzeit" als ISO-Zeitpunkt. */
export function berlinWallTimeToIso(dayIso: string, hour: number, minute: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  for (const offset of ['+01:00', '+02:00']) {
    const candidate = new Date(`${dayIso}T${pad(hour)}:${pad(minute)}:00${offset}`);
    const check = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Berlin',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(candidate);
    if (check.startsWith(dayIso) && check.endsWith(`${pad(hour)}:${pad(minute)}`)) {
      return candidate.toISOString();
    }
  }
  return new Date(`${dayIso}T${pad(hour)}:${pad(minute)}:00+01:00`).toISOString();
}

/**
 * datetime-local ↔ ISO – IMMER als Europe-Berlin-Wanduhrzeit interpretiert
 * (Order §3: keine stillen Verschiebungen, egal in welcher Zeitzone das
 * Gerät des Mitarbeiters steht).
 */
export function toBerlinInput(iso: string | null): string {
  if (iso === null) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  const wall = berlinWallTime(iso);
  return `${berlinDayOf(iso)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

export function fromBerlinInput(value: string): string | null {
  if (value === '') return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (match === null) return null;
  return berlinWallTimeToIso(match[1]!, Number(match[2]), Number(match[3]));
}
