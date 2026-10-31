/**
 * Phase 13 (Order §2/§7): provider-neutrale Routing-Grenze.
 *
 * Fachservices (Touren, Verspätungsrisiko) und Frontends sprechen AUSSCHLIESSLICH
 * mit `RoutingGateway`; der einzige Provider-Client ist
 * `GraphHopperRoutingGateway` (graphhopper.ts). Tests und Demo nutzen
 * `FakeRoutingGateway` bzw. den Mock (fake.ts, factory.ts).
 *
 * Datenminimierung (Order §4): Die Eingaben enthalten NUR Koordinaten/Adressen,
 * Zeitfenster, Servicezeiten und anonyme Stop-IDs – nie Kundenname, Telefon,
 * E-Mail, Vorgangsnummer, Preise, Schäden oder Notizen. Routing ist READ-ONLY:
 * transiente Fehler dürfen erneut berechnet werden, es gibt kein
 * Unknown-Outcome (Order §7).
 */

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface GeocodeCandidate {
  point: GeoPoint;
  /** Anzeige „Straße Hausnummer, PLZ Ort“ – nur Adressbestandteile. */
  label: string;
  street: string | null;
  housenumber: string | null;
  postcode: string | null;
  city: string | null;
  country: string | null;
  /** Stabile Provider-Referenz des Treffers (z. B. `osm:W123`), für Wiedererkennung. */
  ref: string | null;
}

export interface GeocodeRequest {
  /** Normalisierte operative Adresse (nur Adresse). */
  query: string;
  /** Maximale Kandidaten (Order §17: wenige). */
  limit: number;
  locale: 'de';
}

export interface GeocodeResult {
  candidates: GeocodeCandidate[];
}

export interface RouteRequest {
  /** Geordnete Wegpunkte (≥ 2). */
  points: GeoPoint[];
}

export interface RouteLeg {
  distanceMeters: number;
  durationSeconds: number;
}

export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
  /** Ein Eintrag je Abschnitt zwischen aufeinanderfolgenden Punkten (points.length − 1). */
  legs: RouteLeg[];
}

export interface MatrixRequest {
  /** N Punkte ⇒ N×N Matrix (Ursprünge = Ziele). */
  points: GeoPoint[];
}

export interface MatrixResult {
  /** [from][to] in Sekunden; `null` = keine Verbindung gefunden. */
  durationsSeconds: (number | null)[][];
  /** [from][to] in Metern; `null` = keine Verbindung gefunden. */
  distancesMeters: (number | null)[][];
}

export interface OptimizeTourStop {
  /** Anonyme Stop-ID (nie Vorgangs-/Kunden-Bezug). */
  id: string;
  point: GeoPoint;
  /** Servicezeit am Stopp in Sekunden (Puffer, Order §21). */
  serviceSeconds: number;
  /** Hartes Zeitfenster: exakter Termin ⇒ earliest = latest = Termin. */
  timeWindow: { earliest: Date; latest: Date } | null;
}

export interface OptimizeTourRequest {
  depot: GeoPoint;
  /** Frühester Start am Depot (Tourbeginn). */
  earliestStart: Date;
  stops: OptimizeTourStop[];
  /**
   * Reihenfolge-Relationen: Stopp-IDs, die in dieser Reihenfolge (nicht
   * notwendig direkt aufeinander) bedient werden müssen (GraphHopper
   * `in_sequence`, verifiziert 2026-10-30). Eine FESTE Position ist beim
   * Provider nicht dokumentiert – dafür nutzt die Planung den Matrix-Fallback.
   */
  sequenceRelations: string[][];
}

export interface OptimizedTourVisit {
  stopId: string;
  arrivalAt: Date;
  departureAt: Date;
  /** Kumulierte Distanz/Fahrzeit ab Depot bis zur Ankunft (Meter/Sekunden). */
  cumulativeDistanceMeters: number;
  cumulativeDrivingSeconds: number;
}

export interface OptimizeTourResult {
  visits: OptimizedTourVisit[];
  /** Stopps, die der Provider nicht einplanen konnte (z. B. Zeitfenster) – mit neutralem Grundcode. */
  unassigned: { stopId: string; reasonCode: string }[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
  returnToDepotArrivalAt: Date | null;
}

export type RoutingErrorKind =
  | 'auth_invalid'
  | 'validation'
  | 'not_found'
  | 'rate_limited'
  | 'credit_limited'
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'invalid_response'
  | 'disabled';

/**
 * Einzige Fehlerklasse der Routing-Grenze. `message` ist immer neutral (nie
 * Provider-Body, nie URL/Key); `transient` entscheidet über „erneut berechnen“.
 */
export class RoutingError extends Error {
  constructor(
    readonly kind: RoutingErrorKind,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`ROUTING_${kind.toUpperCase()}`);
    this.name = 'RoutingError';
  }

  get code(): string {
    return `ROUTING_${this.kind.toUpperCase()}`;
  }

  get transient(): boolean {
    return (
      this.kind === 'rate_limited' ||
      this.kind === 'timeout' ||
      this.kind === 'network' ||
      this.kind === 'server_error'
    );
  }
}

export interface RoutingGateway {
  readonly kind: 'graphhopper' | 'mock' | 'fake' | 'disabled';
  /** Provider-Name für `tours.route_provider` (nie Key/URL). */
  readonly providerName: string;
  geocode(request: GeocodeRequest): Promise<GeocodeResult>;
  route(request: RouteRequest): Promise<RouteResult>;
  matrix(request: MatrixRequest): Promise<MatrixResult>;
  optimizeTour(request: OptimizeTourRequest): Promise<OptimizeTourResult>;
}
