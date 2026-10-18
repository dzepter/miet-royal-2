/**
 * Wiedermieter-Gutschein (Phase 11, Order §§1–2, 16, 24–25, 36, 40).
 *
 * Es gibt in Version 1 genau EINE Gutscheinart: 20 % auf die Summe aller
 * Maschinenmietpositionen eines neuen Angebots, einmalig, kundengebunden,
 * 12 Kalendermonate gültig (Europe/Berlin), nicht kombinierbar. Alle Beträge
 * sind Integer-Cent; Rundung kaufmännisch (half-up) – eine Implementierung
 * für Server, Angebots-PDF und Abrechnung.
 */

export const VOUCHER_TYPE_RETURNING_CUSTOMER = 'returning_customer_20' as const;
export type VoucherType = typeof VOUCHER_TYPE_RETURNING_CUSTOMER;

/** Serverseitig konstant – nie aus Client-Eingaben (Order §9). */
export const VOUCHER_DISCOUNT_PERCENT = 20 as const;
export const VOUCHER_VALIDITY_MONTHS = 12 as const;
export const VOUCHER_TIME_ZONE = 'Europe/Berlin';

export const VOUCHER_LABEL = '20-%-Wiedermieter-Gutschein';
/** Neutrale Fehlermeldung – nie Besitzer/Existenz/Status verraten (Order §19/§55). */
export const VOUCHER_INVALID_MESSAGE = 'Gutschein ist ungültig oder nicht verwendbar.';
export const VOUCHER_NOT_COMBINABLE_MESSAGE =
  'Gutschein kann nicht mit einem weiteren Rabatt oder Sonderpreis kombiniert werden.';

/**
 * 20 % der Maschinenmiet-Zwischensumme, kaufmännisch auf Cent gerundet
 * (half-up), ausschließlich Integer-Arithmetik (Order §24/§25).
 */
export function voucherDiscountCents(machineSubtotalCents: number): number {
  if (!Number.isInteger(machineSubtotalCents) || machineSubtotalCents < 0) {
    throw new RangeError(
      'Maschinenmiet-Zwischensumme muss ein nicht-negativer Integer-Centbetrag sein.',
    );
  }
  // floor((x * 20 + 50) / 100) == half-up von x * 0.2
  return Math.floor((machineSubtotalCents * VOUCHER_DISCOUNT_PERCENT + 50) / 100);
}

interface BerlinParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const BERLIN_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: VOUCHER_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function berlinParts(date: Date): BerlinParts {
  const parts: Record<string, number> = {};
  for (const part of BERLIN_FORMATTER.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts['year'] ?? 0,
    month: parts['month'] ?? 1,
    day: parts['day'] ?? 1,
    hour: parts['hour'] ?? 0,
    minute: parts['minute'] ?? 0,
    second: parts['second'] ?? 0,
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Berlin-Wanduhrzeit → Instant. Bei nicht existierender Zeit (Frühjahrs-
 * Zeitumstellung) wird die nächste gültige Zeit genommen, bei doppelter
 * Zeit (Herbst) die erste (Sommerzeit-)Variante – deterministisch.
 */
function berlinWallClockToInstant(parts: BerlinParts): Date {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // Zwei Kandidaten (UTC+1 / UTC+2); der passende reproduziert die Wanduhrzeit.
  for (const offsetHours of [2, 1]) {
    const candidate = new Date(naive - offsetHours * 3_600_000);
    const back = berlinParts(candidate);
    if (
      back.year === parts.year &&
      back.month === parts.month &&
      back.day === parts.day &&
      back.hour === parts.hour &&
      back.minute === parts.minute
    ) {
      return candidate;
    }
  }
  // Nicht existierende Wanduhrzeit (Lücke): eine Stunde später, Normalzeit-Offset.
  return new Date(naive - 1 * 3_600_000);
}

/**
 * `months` Kalendermonate später bei derselben Berliner Wanduhrzeit
 * (Order §16): 31.03. 10:00 + 12 Monate = 31.03. 10:00 des Folgejahres, auch
 * über Zeitumstellungen hinweg; Tag wird auf den Monatsletzten gekappt
 * (29.02. → 28.02.). Keine 365-Tage-Abkürzung.
 */
export function addBerlinCalendarMonths(date: Date, months: number): Date {
  const parts = berlinParts(date);
  const totalMonths = parts.month - 1 + months;
  const year = parts.year + Math.floor(totalMonths / 12);
  const month = (((totalMonths % 12) + 12) % 12) + 1;
  const day = Math.min(parts.day, daysInMonth(year, month));
  return berlinWallClockToInstant({ ...parts, year, month, day });
}

/** Ablaufzeitpunkt eines neu erzeugten Gutscheins. */
export function voucherExpiresAt(activatedAt: Date): Date {
  return addBerlinCalendarMonths(activatedAt, VOUCHER_VALIDITY_MONTHS);
}

/** Gültig bis exklusive `expiresAt` (Order §36: „exakt nach Ablauf nicht verwendbar“). */
export function isVoucherExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

/**
 * Restgültigkeit im Moment der Einlösung (Order §36) als exakte Dauer in
 * Sekunden (Integer, > 0). Die Reservierungszeit wird nicht zurückgegeben.
 */
export function remainingValiditySeconds(expiresAt: Date, redeemedAt: Date): number {
  const seconds = Math.floor((expiresAt.getTime() - redeemedAt.getTime()) / 1000);
  if (seconds <= 0) {
    throw new RangeError('Gutschein ist zum Einlösezeitpunkt bereits abgelaufen.');
  }
  return seconds;
}

/** Neues Ablaufdatum nach kostenlosem Storno: Stornozeit + gespeicherte Restdauer (Order §40). */
export function reactivatedExpiresAt(cancelledAt: Date, remainingSeconds: number): Date {
  if (!Number.isInteger(remainingSeconds) || remainingSeconds <= 0) {
    throw new RangeError('Restgültigkeit muss eine positive Integer-Dauer in Sekunden sein.');
  }
  return new Date(cancelledAt.getTime() + remainingSeconds * 1000);
}

export type VoucherStoredStatus = 'active' | 'reserved' | 'redeemed';
export type VoucherEffectiveStatus = VoucherStoredStatus | 'expired';

/**
 * Effektiver Status (Order §17): abgelaufen wird lazy aus `expiresAt`
 * ermittelt; ein eingelöster Gutschein ist nie „abgelaufen“, sondern
 * eingelöst. Die Freigabe einer Reservierung (Angebot abgelaufen/abgelehnt)
 * entscheidet der Service anhand des Angebotszustands – nicht diese Funktion.
 */
export function voucherEffectiveStatus(
  status: VoucherStoredStatus,
  expiresAt: Date,
  now: Date,
): VoucherEffectiveStatus {
  if (status === 'redeemed') return 'redeemed';
  if (isVoucherExpired(expiresAt, now)) return 'expired';
  return status;
}

export const VOUCHER_STATUS_LABELS: Record<VoucherEffectiveStatus, string> = {
  active: 'Aktiv',
  reserved: 'Für Angebot reserviert',
  redeemed: 'Eingelöst',
  expired: 'Abgelaufen',
};

export type VoucherDeliveryStatus = 'pending' | 'sent';
export const VOUCHER_DELIVERY_LABELS: Record<VoucherDeliveryStatus, string> = {
  pending: 'Versand ausstehend',
  sent: 'Versendet',
};

/** Gutscheincode-Format (Order §11): MR20-XXXX-XXXX-XXXX, verwechslungsarmes Alphabet. */
export const VOUCHER_CODE_PREFIX = 'MR20';
export const VOUCHER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const VOUCHER_CODE_BODY_LENGTH = 12;
const VOUCHER_CODE_PATTERN = new RegExp(
  `^${VOUCHER_CODE_PREFIX}[${VOUCHER_CODE_ALPHABET}]{${VOUCHER_CODE_BODY_LENGTH}}$`,
);

/**
 * Eingabe normalisieren (Order §11): Groß-/Kleinschreibung egal, Bindestriche
 * und Leerzeichen erlaubt. Liefert die kompakte Form `MR20XXXXXXXXXXXX` oder
 * null, wenn die Form ungültig ist (Validierung bleibt streng).
 */
export function normalizeVoucherCode(input: string): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const compact = input.replace(/[\s-]/g, '').toUpperCase();
  return VOUCHER_CODE_PATTERN.test(compact) ? compact : null;
}

/** Anzeigeform mit Bindestrichen aus der kompakten Form. */
export function formatVoucherCode(compact: string): string {
  const body = compact.slice(VOUCHER_CODE_PREFIX.length);
  return [VOUCHER_CODE_PREFIX, body.slice(0, 4), body.slice(4, 8), body.slice(8, 12)].join('-');
}

/** Maskierte Darstellung für Mitarbeitende (Order §14): MR20-••••-••••-T2RW. */
export function maskVoucherCode(suffix: string): string {
  return `${VOUCHER_CODE_PREFIX}-••••-••••-${suffix}`;
}
