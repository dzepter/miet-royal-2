/**
 * Phase 13 (Order §15–§18): Schnittstelle der Geokodierung für die Tourenplanung.
 * Implementierung: geocoding-service.ts (Cache + Review); Adressautorität:
 * address-resolver.ts. Die Tourenplanung programmiert NUR gegen diese Typen.
 */
import type { GeoPoint } from './types.ts';

export type GeocodingStatus = 'resolved' | 'review_required' | 'no_result' | 'unavailable';

export interface GeocodingCandidateView {
  /** Stabile Referenz des Kandidaten (Provider-Ref), für die Bestätigung durch Mitarbeiter. */
  ref: string;
  label: string;
  point: GeoPoint;
}

export interface GeocodingResolution {
  status: GeocodingStatus;
  /** Nur bei resolved. */
  point: GeoPoint | null;
  /** Anzeige-Label des aufgelösten Treffers (nur Adressbestandteile). */
  label: string | null;
  /** Nur bei review_required (≤ 5). */
  candidates: GeocodingCandidateView[];
  /** geocoding_cache.id, wenn ein Cache-Eintrag existiert (für die Bestätigung). */
  cacheId: string | null;
}

export interface GeocodingResolver {
  /** Löst eine operative Adresse (nur Adresse, kein Kundenbezug) konservativ auf. Wirft nie RoutingError. */
  resolve(addressText: string, options: { now: Date }): Promise<GeocodingResolution>;
}

/** Operative Adresse eines Termins (Order §13/§14) – Ergebnis der Adressautorität. */
export interface OperativeAddress {
  kind: 'customer' | 'depot';
  /** Normalisierter Anfragetext für das Geocoding (null, wenn unvollständig). */
  text: string | null;
  /** Anzeige-Zeilen (z. B. „Lieferweg 12“, „55129 Mainz“). */
  lines: string[];
  status: 'ok' | 'missing';
}
