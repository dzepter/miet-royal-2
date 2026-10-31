/**
 * Phase 13 (Touren): Abhängigkeiten der Tourenplanung auf Schnittstellen –
 * Adressautorität (routing/address-resolver.ts) und Geokodierung
 * (routing/geocoding-service.ts) werden injiziert; die Touren programmieren
 * NUR gegen diese Typen (Design §1/§3/§4).
 */
import type { Appointment, DatabaseExecutor } from '@mietroyal/database';
import type {
  GeocodingResolution,
  GeocodingResolver,
  OperativeAddress,
} from '../routing/geocoding-types.ts';

/**
 * Adressautorität je Termin (Order §13/§14): Kunden-Snapshot des Termins
 * bzw. Depot = pickup_exact_address. Implementierung: Routing-Agent.
 */
export interface OperativeAddressResolver {
  resolveOperativeAddress(
    db: DatabaseExecutor,
    appointment: Appointment,
  ): Promise<OperativeAddress>;
  getDepotAddress(db: DatabaseExecutor): Promise<OperativeAddress>;
}

/**
 * Geokodierung für die Tourenplanung. `resolve` darf den Provider rufen
 * (nur wenn Routing es braucht); die optionalen Erweiterungen sind additiv:
 * - `peekCached`: Cache-Stand OHNE Provider-Aufruf (Anzeige des Adress-Status
 *   in der Tour-View; fehlt sie, zeigt die View nur ok/missing).
 * - `confirmCandidate`: bewusste Staff-Auswahl eines Kandidaten (Design §4);
 *   fehlt sie, ist die Bestätigung über die Tour-Route nicht verfügbar.
 */
export interface TourGeocodingResolver extends GeocodingResolver {
  peekCached?(addressText: string, options: { now: Date }): Promise<GeocodingResolution | null>;
  confirmCandidate?(
    cacheId: string,
    candidateRef: string,
    actorId: string,
  ): Promise<GeocodingResolution>;
}
