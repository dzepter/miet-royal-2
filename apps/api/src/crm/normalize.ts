/**
 * Technische Normalisierung von Kontaktdaten (Phase-2-Vorgabe Nr. 1):
 * für Suche und Dublettenprüfung – die lesbare Darstellung bleibt erhalten
 * (Telefon wird zusätzlich roh gespeichert).
 */

export function normalizeEmailAddress(email: string | null | undefined): string | null {
  const trimmed = (email ?? '').trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * Telefonnummer → reine Ziffernform für Vergleich/Suche.
 * Heuristik für deutsche Nummern: "+49"/"0049" → "49…", führende "0" → "49…".
 * Bewusst einfach und nachvollziehbar – keine vollständige E.164-Validierung.
 */
export function normalizePhoneNumber(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits === '') return null;
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return `49${digits.slice(1)}`;
  return digits;
}

/** Sucheingabe, die wie eine Telefonnummer aussieht? → Ziffernform. */
export function phoneSearchTerm(query: string): string | null {
  const digits = query.replace(/[\s\-/().+]/g, '');
  if (!/^\d{4,}$/.test(digits)) return null;
  return normalizePhoneNumber(digits);
}

/** Existiert der Kalendertag wirklich (kein 31.02.)? */
export function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** ISO-Datum (yyyy-mm-dd) auf Format UND Kalender-Gültigkeit prüfen. */
export function isValidIsoDate(value: string): boolean {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso === null) return false;
  return isRealCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
}

/**
 * Sucheingabe als Eventdatum interpretieren: "31.12.2026", "31.12.26"
 * oder "2026-12-31" → ISO-Datum (yyyy-mm-dd), sonst null. Unmögliche
 * Kalenderdaten (31.02.) werden verworfen, damit sie nie als ungültiges
 * Datum bei PostgreSQL ankommen.
 */
export function dateSearchTerm(query: string): string | null {
  const trimmed = query.trim();
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(trimmed);
  if (german !== null) {
    const day = Number(german[1]);
    const month = Number(german[2]);
    let year = Number(german[3]);
    if (year < 100) year += 2000;
    if (!isRealCalendarDate(year, month, day)) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return isValidIsoDate(trimmed) ? trimmed : null;
}

/** Jahr in Europe/Berlin – Basis der Vorgangsnummer (CLAUDE.md Datum/Zeit). */
export function berlinYear(date: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', year: 'numeric' }).format(date),
  );
}
