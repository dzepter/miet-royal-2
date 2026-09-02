/**
 * Phase 4: reine Termin-Fachlogik (Order §§3/6/12/18/23/25) – Zeitmodell,
 * Wochenend-Vorschlag, effektive Zuständigkeit (Vertretung), Überlappungs-
 * und Überfälligkeitsregeln. Alles DST-fest in Europe/Berlin, keine DB.
 */

export const BUSINESS_TIMEZONE = 'Europe/Berlin';

/** Wochenend-Standard (MASTER_SPEC §8): Freitag 18:00 / Sonntag 11:00. */
export const WEEKEND_PICKUP_HOUR = 18;
export const WEEKEND_RETURN_HOUR = 11;

export const DEFAULT_APPOINTMENT_REMINDER_MINUTES = 60;

function berlinParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const text = formatter.format(date); // "2026-09-02, 17:30"
  const match = /(\d{4})-(\d{2})-(\d{2}),?\s+(\d{2}):(\d{2})/.exec(text);
  if (match === null) throw new Error(`Unerwartetes Datumsformat: ${text}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
}

/** Kalendertag (yyyy-mm-dd) eines Zeitpunkts in Europe/Berlin. */
export function berlinDateOf(date: Date): string {
  const parts = berlinParts(date);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Zwei Zeitpunkte am selben Berliner Kalendertag? (Order §11) */
export function isSameBerlinDay(a: Date, b: Date): boolean {
  return berlinDateOf(a) === berlinDateOf(b);
}

/**
 * Exakter UTC-Zeitpunkt für "Datum + Uhrzeit in Europe/Berlin" – DST-fest:
 * beide möglichen Offsets werden geprüft und per Intl verifiziert (keine
 * stillen UTC-/DST-Verschiebungen, Order §3).
 */
export function berlinDateTimeToUtc(dateIso: string, hour: number, minute = 0): Date {
  const pad = (value: number) => String(value).padStart(2, '0');
  for (const offset of ['+01:00', '+02:00']) {
    const candidate = new Date(`${dateIso}T${pad(hour)}:${pad(minute)}:00${offset}`);
    const parts = berlinParts(candidate);
    if (berlinDateOf(candidate) === dateIso && parts.hour === hour && parts.minute === minute) {
      return candidate;
    }
  }
  // Nicht existierende lokale Zeit (Sommerzeit-Sprunglücke): +01:00-Lesart.
  return new Date(`${dateIso}T${pad(hour)}:${pad(minute)}:00+01:00`);
}

/** Berliner Mitternacht (Tagesbeginn) eines ISO-Datums als UTC-Zeitpunkt. */
export function berlinStartOfDay(dateIso: string): Date {
  return berlinDateTimeToUtc(dateIso, 0, 0);
}

function isoDayShift(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const shifted = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

/** Wochentag (0=So … 6=Sa) eines ISO-Datums (kalendarisch, TZ-unabhängig). */
function isoWeekday(dateIso: string): number {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

export interface WeekendSuggestionInput {
  /** Eventdatum (yyyy-mm-dd, Berliner Kalendertag). */
  eventDate: string;
  /** Optionale exakte Eventzeiten (ISO). */
  eventStart?: string | null;
  eventEnd?: string | null;
}

export type WeekendSuggestion =
  { ok: true; pickupAt: Date; returnAt: Date } | { ok: false; reason: string };

/**
 * Wochenend-Standard (Order §6): Freitag 18:00 vor dem Event, Sonntag
 * 11:00 nach dem Event – NUR wenn das für den konkreten Eventzeitraum
 * fachlich passt (Abholung vor dem Event, Rückgabe danach, kein negativer
 * Zeitraum). Sonst KEINE automatische Übernahme: der Mitarbeiter legt die
 * Zeiten fest. Ohne exakte Eventzeiten gelten die Berliner Tagesgrenzen
 * des Eventdatums als Vergleichsbasis.
 */
export function weekendStandardSuggestion(input: WeekendSuggestionInput): WeekendSuggestion {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.eventDate)) {
    return { ok: false, reason: 'Für den Wochenend-Standard wird ein Eventdatum benötigt.' };
  }
  // Letzter Freitag am oder vor dem Eventtag / erster Sonntag am oder danach.
  const weekday = isoWeekday(input.eventDate);
  const daysSinceFriday = (weekday - 5 + 7) % 7;
  const fridayIso = isoDayShift(input.eventDate, -daysSinceFriday);
  const daysUntilSunday = (7 - weekday) % 7;
  const sundayIso = isoDayShift(input.eventDate, daysUntilSunday);

  const pickupAt = berlinDateTimeToUtc(fridayIso, WEEKEND_PICKUP_HOUR, 0);
  const returnAt = berlinDateTimeToUtc(sundayIso, WEEKEND_RETURN_HOUR, 0);

  const eventStart =
    input.eventStart !== null && input.eventStart !== undefined && input.eventStart !== ''
      ? new Date(input.eventStart)
      : berlinStartOfDay(input.eventDate);
  const eventEnd =
    input.eventEnd !== null && input.eventEnd !== undefined && input.eventEnd !== ''
      ? new Date(input.eventEnd)
      : berlinStartOfDay(isoDayShift(input.eventDate, 1));

  if (Number.isNaN(eventStart.getTime()) || Number.isNaN(eventEnd.getTime())) {
    return { ok: false, reason: 'Die Eventzeiten sind ungültig.' };
  }
  if (!(pickupAt.getTime() < eventStart.getTime())) {
    return {
      ok: false,
      reason:
        'Der Wochenend-Standard passt nicht: Freitag 18:00 Uhr läge nicht vor dem Event. Bitte Zeiten manuell festlegen.',
    };
  }
  if (!(returnAt.getTime() > eventEnd.getTime())) {
    return {
      ok: false,
      reason:
        'Der Wochenend-Standard passt nicht: Sonntag 11:00 Uhr läge nicht nach dem Event. Bitte Zeiten manuell festlegen.',
    };
  }
  if (!(pickupAt.getTime() < returnAt.getTime())) {
    return { ok: false, reason: 'Der Wochenend-Standard ergäbe einen negativen Zeitraum.' };
  }
  return { ok: true, pickupAt, returnAt };
}

// ── Zeitfenster-Validierung (Order §3) ─────────────────────────────────────

export class SchedulingRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulingRuleError';
  }
}

/**
 * Zeitposition prüfen: exakter Termin (nur start), Zeitfenster
 * (start+end, end > start) oder ungeplant (beides null). Ein Ende ohne
 * Beginn ist fachlich unmöglich.
 */
export function assertValidTimePosition(startAt: Date | null, endAt: Date | null): void {
  if (endAt !== null && startAt === null) {
    throw new SchedulingRuleError('Ein Zeitfenster-Ende ohne Beginn ist nicht möglich.');
  }
  if (startAt !== null && Number.isNaN(startAt.getTime())) {
    throw new SchedulingRuleError('Der Beginn ist keine gültige Zeit.');
  }
  if (endAt !== null && Number.isNaN(endAt.getTime())) {
    throw new SchedulingRuleError('Das Ende ist keine gültige Zeit.');
  }
  if (startAt !== null && endAt !== null && endAt.getTime() <= startAt.getTime()) {
    throw new SchedulingRuleError('Das Ende des Zeitfensters muss nach dem Beginn liegen.');
  }
}

// ── Effektive Zuständigkeit inkl. Vertretung (Order §12) ───────────────────

export interface SubstitutionLike {
  originalUserId: string;
  substituteUserId: string;
  startsAt: Date;
  endsAt: Date;
  endedEarlyAt?: Date | null;
}

/** Wirksames Ende: reguläres Ende oder vorzeitiger Abbruch. */
export function substitutionEffectiveEnd(sub: SubstitutionLike): Date {
  if (
    sub.endedEarlyAt !== null &&
    sub.endedEarlyAt !== undefined &&
    sub.endedEarlyAt.getTime() < sub.endsAt.getTime()
  ) {
    return sub.endedEarlyAt;
  }
  return sub.endsAt;
}

export function isSubstitutionActiveAt(sub: SubstitutionLike, at: Date): boolean {
  return (
    sub.startsAt.getTime() <= at.getTime() && at.getTime() < substitutionEffectiveEnd(sub).getTime()
  );
}

/**
 * Zentrale Auflösung der effektiven Zuständigkeit: Während einer aktiven
 * Vertretung geht die Zuständigkeit an die Vertretung (EIN Sprung, keine
 * Kettenauflösung – dokumentierte Entscheidung); danach fällt sie
 * automatisch an den ursprünglichen Mitarbeiter zurück (rein zeitabhängig,
 * kein Hintergrundjob). Historische Zuweisungen werden nie umgeschrieben.
 */
export function resolveEffectiveAssigneeId(
  assignedUserId: string | null,
  at: Date,
  substitutions: readonly SubstitutionLike[],
): string | null {
  if (assignedUserId === null) return null;
  const active = substitutions.find(
    (sub) => sub.originalUserId === assignedUserId && isSubstitutionActiveAt(sub, at),
  );
  return active !== undefined ? active.substituteUserId : assignedUserId;
}

/** Überschneiden sich zwei Vertretungszeiträume (wirksame Enden)? */
export function substitutionRangesOverlap(a: SubstitutionLike, b: SubstitutionLike): boolean {
  return (
    a.startsAt.getTime() < substitutionEffectiveEnd(b).getTime() &&
    b.startsAt.getTime() < substitutionEffectiveEnd(a).getTime()
  );
}

// ── Überlappung / Konflikte (Order §18) ────────────────────────────────────

export interface TimePositionLike {
  startAt: Date | null;
  endAt: Date | null;
}

/**
 * Fachliche Überlappung zweier Termine: Fenster überlappen bei echtem
 * Schnitt (halboffen – aneinandergrenzende Fenster kollidieren NICHT);
 * ein exakter Termin kollidiert, wenn er strikt in einem Fenster liegt
 * oder zwei Termine denselben Beginn haben (zwei Orte gleichzeitig).
 */
export function appointmentsOverlap(a: TimePositionLike, b: TimePositionLike): boolean {
  if (a.startAt === null || b.startAt === null) return false;
  const aStart = a.startAt.getTime();
  const bStart = b.startAt.getTime();
  if (aStart === bStart) return true;
  const aEnd = (a.endAt ?? a.startAt).getTime();
  const bEnd = (b.endAt ?? b.startAt).getTime();
  return aStart < bEnd && bStart < aEnd;
}

// ── Überfälligkeit & Reminder (Order §§23–25) ──────────────────────────────

/** Fällige Endzeit: Fenster-Ende bzw. exakter Zeitpunkt; null = ungeplant. */
export function appointmentDueEnd(position: TimePositionLike): Date | null {
  if (position.startAt === null) return null;
  return position.endAt ?? position.startAt;
}

export interface OverdueCheckInput extends TimePositionLike {
  kind: 'pickup' | 'return' | 'delivery';
  status: 'scheduled' | 'completed' | 'cancelled';
}

/** Rückgabe überfällig: geplante Zeit überschritten und nicht abgeschlossen. */
export function isReturnOverdue(appointment: OverdueCheckInput, now: Date): boolean {
  if (appointment.kind !== 'return') return false;
  if (appointment.status !== 'scheduled') return false;
  const dueEnd = appointmentDueEnd(appointment);
  return dueEnd !== null && dueEnd.getTime() < now.getTime();
}

/**
 * 1h-Reminder (Order §25): fällig ab (Beginn − reminderMinutes) bis zum
 * Beginn, solange nicht gesendet. Der Empfänger ist IMMER der effektive
 * Mitarbeiter inkl. aktiver Vertretung zum Terminbeginn.
 */
export function isReminderDue(
  appointment: { startAt: Date | null; status: string; reminderSentAt: Date | null },
  reminderMinutes: number,
  now: Date,
): boolean {
  if (appointment.status !== 'scheduled') return false;
  if (appointment.startAt === null) return false;
  if (appointment.reminderSentAt !== null) return false;
  const dueFrom = appointment.startAt.getTime() - reminderMinutes * 60_000;
  return now.getTime() >= dueFrom && now.getTime() < appointment.startAt.getTime();
}
