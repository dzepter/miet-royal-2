/**
 * Geldumrechnung Miet-Royal (Integer-Cent) ↔ Lexware (Dezimalbeträge),
 * Order §15: exakte Dezimaldarstellung ohne Float-Rundung. Lexware liefert
 * Beträge als JSON-Zahl (z. B. 1337.5) oder – laut Doku-Beispielen – auch als
 * String ("1337.00"); beide Formen werden ohne Float-Arithmetik geparst.
 */

export class MoneyConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyConversionError';
  }
}

/** 12345 → "123.45"; -5 → "-0.05". Reine String-Arithmetik. */
export function centsToDecimalString(cents: number): string {
  if (!Number.isInteger(cents) || !Number.isSafeInteger(cents)) {
    throw new MoneyConversionError('Betrag muss ein Integer-Cent-Wert sein.');
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const fraction = abs % 100;
  return `${sign}${whole}.${String(fraction).padStart(2, '0')}`;
}

/**
 * Für den JSON-Payload: Lexware erwartet JSON-Zahlen. Ein Dezimalwert mit
 * höchstens zwei Nachkommastellen ist als IEEE-754-Double exakt genug, um
 * verlustfrei serialisiert zu werden (JSON.stringify(123.45) === "123.45");
 * gerechnet wird damit NIE – nur serialisiert.
 */
export function centsToLexwareAmount(cents: number): number {
  const decimal = centsToDecimalString(cents);
  const value = Number(decimal);
  if (centsToDecimalString(decimalToCents(String(value))) !== decimal) {
    throw new MoneyConversionError(
      `Betrag ${decimal} ist nicht verlustfrei als JSON-Zahl darstellbar.`,
    );
  }
  return value;
}

/** "123.45" | "1337" | "-0.5" | 123.45 → Cent; mehr als zwei Nachkommastellen ⇒ Fehler (nie runden). */
export function decimalToCents(value: string | number): number {
  const text = typeof value === 'number' ? numberToDecimalText(value) : value.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (match === null) {
    throw new MoneyConversionError(
      `Dezimalbetrag "${text}" hat kein gültiges Format (max. 2 Nachkommastellen).`,
    );
  }
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents))
    throw new MoneyConversionError('Betrag außerhalb des sicheren Bereichs.');
  return sign * cents;
}

function numberToDecimalText(value: number): string {
  if (!Number.isFinite(value)) throw new MoneyConversionError('Betrag ist keine endliche Zahl.');
  // toFixed(2) ist für Beträge mit ≤ 2 Nachkommastellen exakt; mehr Stellen
  // werden über den Vergleich mit der Rohdarstellung erkannt und abgelehnt.
  const fixed = value.toFixed(2);
  if (Number(fixed) !== value) {
    throw new MoneyConversionError(`Betrag ${String(value)} hat mehr als zwei Nachkommastellen.`);
  }
  return fixed;
}

/** Steuersatz in Basispunkten (1900) → Lexware taxRatePercentage (19) bzw. 1950 → 19.5. */
export function basisPointsToPercentage(bp: number): number {
  if (!Number.isInteger(bp) || bp < 0 || bp > 10_000) {
    throw new MoneyConversionError('Steuersatz muss in Basispunkten (0–10000) vorliegen.');
  }
  return Number(centsToDecimalString(bp));
}

/** Netto-Cent × Satz (bp) → Brutto-Cent, kaufmännisch gerundet (Integer-Arithmetik). */
export function grossFromNetCents(netCents: number, taxRateBp: number): number {
  if (!Number.isInteger(netCents) || !Number.isInteger(taxRateBp)) {
    throw new MoneyConversionError('Netto-Betrag und Steuersatz müssen ganzzahlig sein.');
  }
  const scaled = netCents * (10_000 + taxRateBp);
  const sign = scaled < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(scaled) + 5_000) / 10_000);
}
