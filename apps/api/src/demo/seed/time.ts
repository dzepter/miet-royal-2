import { berlinDateOf, berlinDateTimeToUtc } from '@mietroyal/domain';

/**
 * Phase 14 (Order §12): Alle zeitabhängigen Demo-Szenarien liegen RELATIV zu
 * einem injizierbaren `now` in Europe/Berlin – nie ein hartcodiertes Datum.
 * Die Helfer bauen auf den Domain-Funktionen (DST-fest) auf.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** ISO-Tag (yyyy-mm-dd) um `days` Kalendertage verschoben (kalendarisch, DST-unabhängig). */
export function berlinDayShift(dateIso: string, days: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

export interface DemoClock {
  readonly now: Date;
  /** Heutiger Berliner Kalendertag. */
  readonly todayIso: string;
  /** Berliner Kalendertag relativ zu heute (−1 = gestern, +1 = morgen). */
  dayIso(offsetDays: number): string;
  /** Zeitpunkt „HH:MM Berlin“ an einem Tag relativ zu heute. */
  at(offsetDays: number, hour: number, minute?: number): Date;
  /** `now` minus Minuten. */
  minutesAgo(minutes: number): Date;
  /** `now` minus Stunden. */
  hoursAgo(hours: number): Date;
  /**
   * Zeitpunkt HEUTE, der sicher noch in der Zukunft liegt: „heute HH:00 Berlin“,
   * mindestens jedoch `now + minHoursAhead`, und immer noch am heutigen Berliner
   * Tag (spätestens 23:59). Für „Rückgabe fällig heute“ – nie überfällig.
   */
  laterToday(hour: number, minHoursAhead?: number): Date;
}

export function createDemoClock(now: Date): DemoClock {
  const todayIso = berlinDateOf(now);
  const dayIso = (offsetDays: number): string => berlinDayShift(todayIso, offsetDays);
  const at = (offsetDays: number, hour: number, minute = 0): Date =>
    berlinDateTimeToUtc(dayIso(offsetDays), hour, minute);
  return {
    now,
    todayIso,
    dayIso,
    at,
    minutesAgo: (minutes) => new Date(now.getTime() - minutes * MINUTE_MS),
    hoursAgo: (hours) => new Date(now.getTime() - hours * HOUR_MS),
    laterToday: (hour, minHoursAhead = 1) => {
      const earliest = new Date(now.getTime() + minHoursAhead * HOUR_MS);
      let candidate = at(0, hour, 0);
      if (candidate.getTime() < earliest.getTime()) candidate = earliest;
      const endOfToday = at(0, 23, 59);
      if (candidate.getTime() > endOfToday.getTime()) candidate = endOfToday;
      return candidate;
    },
  };
}

/** Hilfsfunktion für Tests/Berichte: Berliner Tag eines Zeitpunkts. */
export { berlinDateOf as berlinDayOf };
