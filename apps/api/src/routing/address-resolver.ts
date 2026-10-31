import { createHash } from 'node:crypto';
import type { Appointment, DatabaseExecutor } from '@mietroyal/database';
import { getPickupExactAddress } from '../crm/settings-service.ts';
import { normalizeAddressText } from './address-parse.ts';
import type { OperativeAddress } from './geocoding-types.ts';

/**
 * Phase 13 (Order §13–§15, Design §3): zentrale Adressautorität für die
 * operative Adresse eines Termins – die EINZIGE Quelle, aus der Touren und
 * Routing eine Adresse beziehen.
 *
 * - locationKind 'customer' (Lieferung/Rückholung): ausschließlich der beim
 *   Termin eingefrorene Buchungs-Snapshot `locationSnapshot` {street,
 *   postalCode, city} – NIE der aktuelle Kundenstamm, nie aus Name/Telefon
 *   abgeleitet. Fehlt die Straße oder fehlen PLZ UND Ort ⇒ `missing`
 *   („Adresse fehlt – Route nicht berechenbar.“), der Termin bleibt bestehen.
 * - locationKind 'base' (Selbstabholung/Rückgabe am Standort): die bestätigte
 *   exakte Abholadresse `pickup_exact_address` (dieselbe Funktion wie das
 *   Depot) – leer ⇒ `missing` („Depotadresse ist noch nicht vollständig
 *   hinterlegt.“). Kein Test-Default in production.
 *
 * Normalisierung (nur Suchkontext, kein Fachdatum): trim, Mehrfach-Whitespace
 * zu einem Leerzeichen. Kleinschreibung nur für den Cache-Hash; das Suffix
 * „, Deutschland“ ergänzt der GeocodingService für die Provider-Anfrage
 * (Land steht nicht im Snapshot; Betrieb ist Deutschland).
 */

export const DEPOT_ADDRESS_MISSING_CODE = 'DEPOT_ADDRESS_MISSING';
export const ADDRESS_MISSING_CODE = 'ADDRESS_MISSING';
export const DEPOT_ADDRESS_MISSING_MESSAGE = 'Depotadresse ist noch nicht vollständig hinterlegt.';
export const ADDRESS_MISSING_MESSAGE = 'Adresse fehlt – Route nicht berechenbar.';

/** Suffix für die Provider-Anfrage (Suchkontext, siehe Kopfkommentar). */
export const GEOCODING_COUNTRY_SUFFIX = ', Deutschland';

// Phase 13 (Fix F6): Normalisierung lebt in der reinen Datei address-parse.ts (Mock/Fake nutzen sie mit).
export { normalizeAddressText };

/** Vollständige Provider-Anfrage aus der normalisierten Adresse. */
export function geocodeQueryFor(normalizedText: string): string {
  return `${normalizeAddressText(normalizedText)}${GEOCODING_COUNTRY_SUFFIX}`;
}

/** SHA-256 der Provider-Anfrage in Kleinschreibung (Schlüssel von geocoding_cache). */
export function addressHashFor(normalizedText: string): string {
  return createHash('sha256').update(geocodeQueryFor(normalizedText).toLowerCase()).digest('hex');
}

function cleanPart(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = normalizeAddressText(value);
  return normalized === '' ? null : normalized;
}

/** Freitext-Adresse (z. B. „Robert-Koch-Straße 1, 55129 Mainz“) in Anzeigezeilen zerlegen. */
export function addressLinesFor(text: string): string[] {
  return text
    .split(/\s*(?:\n|,)\s*/)
    .map((line) => normalizeAddressText(line))
    .filter((line) => line !== '');
}

function missingAddress(kind: OperativeAddress['kind']): OperativeAddress {
  return { kind, text: null, lines: [], status: 'missing' };
}

/** Depot = bestätigte exakte Abholadresse (Setting pickup_exact_address); leer ⇒ missing. */
export async function getDepotAddress(db: DatabaseExecutor): Promise<OperativeAddress> {
  const raw = await getPickupExactAddress(db);
  const text = raw === null ? null : normalizeAddressText(raw);
  if (text === null || text === '') return missingAddress('depot');
  return { kind: 'depot', text, lines: addressLinesFor(text), status: 'ok' };
}

/** Kundenadresse aus dem eingefrorenen Termin-Snapshot – nie aus dem Kundenstamm. */
export function customerAddressFromSnapshot(snapshot: unknown): OperativeAddress {
  if (snapshot === null || typeof snapshot !== 'object') return missingAddress('customer');
  const record = snapshot as Record<string, unknown>;
  const street = cleanPart(record.street);
  const postalCode = cleanPart(record.postalCode);
  const city = cleanPart(record.city);
  if (street === null || (postalCode === null && city === null)) return missingAddress('customer');
  const cityLine = [postalCode, city].filter((part): part is string => part !== null).join(' ');
  return {
    kind: 'customer',
    text: `${street}, ${cityLine}`,
    lines: [street, cityLine],
    status: 'ok',
  };
}

/**
 * Operative Adresse eines Termins (Adressautorität). Liest für 'base' die
 * Depot-Einstellung zur Laufzeit; für 'customer' ausschließlich den Snapshot.
 */
export async function resolveOperativeAddress(
  db: DatabaseExecutor,
  appointment: Pick<Appointment, 'locationKind' | 'locationSnapshot'>,
): Promise<OperativeAddress> {
  if (appointment.locationKind === 'base') return getDepotAddress(db);
  return customerAddressFromSnapshot(appointment.locationSnapshot);
}
