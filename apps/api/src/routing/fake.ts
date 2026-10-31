import {
  RoutingError,
  type GeocodeCandidate,
  type GeocodeRequest,
  type GeocodeResult,
  type GeoPoint,
  type MatrixRequest,
  type MatrixResult,
  type OptimizeTourRequest,
  type OptimizeTourResult,
  type RouteRequest,
  type RouteResult,
  type RoutingErrorKind,
  type RoutingGateway,
} from './types.ts';
import { parseGeocodeQuery } from './address-parse.ts';

/**
 * Phase 13: deterministisches Routing ohne Provider.
 *
 * - `MockRoutingGateway` (demo/development ohne Opt-in): Luftlinie × 1.3 bei
 *   40 km/h; Geocoding über eine feste Tabelle bekannter Testadressen, sonst
 *   deterministische Koordinate aus dem Adress-Hash (nie „kein Treffer“ für
 *   leere Eingaben – die Adressautorität prüft Vollständigkeit vorher).
 *   Kennzeichnung in der UI: `providerName = 'mock'` (Order §82 O).
 * - `FakeRoutingGateway` (nur Tests, Order §70): zusätzlich skriptbare
 *   Antworten/Fehler je Aufruf und Aufzeichnung aller Anfragen (Beleg, dass
 *   nie Kundendaten mitgesendet werden). `buildApp` lehnt den Fake in
 *   production hart ab (factory.ts).
 */

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Luftlinie × Umwegfaktor 1.3, 40 km/h ⇒ deterministische Fahrzeit (nur Mock/Fake). */
export function mockLeg(
  a: GeoPoint,
  b: GeoPoint,
): { distanceMeters: number; durationSeconds: number } {
  const distanceMeters = Math.round(haversineMeters(a, b) * 1.3);
  const durationSeconds = Math.round((distanceMeters / 40_000) * 3600);
  return { distanceMeters, durationSeconds };
}

/** Bekannte Testpunkte (E2E/Integration): Mainz-Hechtsheim/Robert-Koch als Depot, Lieferweg als Kundenadresse. */
export const MOCK_DEPOT_POINT: GeoPoint = { latitude: 49.9545, longitude: 8.2735 };
export const MOCK_CUSTOMER_POINT: GeoPoint = { latitude: 49.9742, longitude: 8.2566 };
const KNOWN_POINTS: { match: RegExp; point: GeoPoint; ref: string }[] = [
  { match: /hechtsheim|robert-koch/i, point: MOCK_DEPOT_POINT, ref: 'mock:depot' },
  { match: /lieferweg/i, point: MOCK_CUSTOMER_POINT, ref: 'mock:lieferweg-12' },
];

/**
 * Phase 13 (Fix F6): Mock-Kandidaten werden aus der ANFRAGE abgeleitet (Straße,
 * Hausnummer, PLZ, Ort via `parseGeocodeQuery`), damit die konservative Regel
 * `decideGeocoding` vollständige Adressen (Straße + Hausnummer + PLZ/Ort) als
 * `resolved` erkennt. Koordinaten bleiben deterministisch: bekannte Adressen ⇒
 * Depot-/Kundenpunkt, sonst Hash der Anfrage. Ohne Hausnummer liefert der Mock
 * – wie ein echter Provider – zwei Straßenabschnitte ⇒ `review_required`.
 */
export function mockGeocodeCandidates(query: string): GeocodeCandidate[] {
  const input = parseGeocodeQuery(query);
  const known = KNOWN_POINTS.find((entry) => entry.match.test(query));
  const point = known?.point ?? hashToPoint(query.toLowerCase());
  const street = input.streetName;
  const cityPart = [input.postcode, input.city].filter((p): p is string => p !== null).join(' ');
  const base = {
    street,
    postcode: input.postcode,
    city: input.city,
    country: 'Deutschland',
  };
  if (street !== null && input.housenumber !== null) {
    return [
      {
        ...base,
        point,
        housenumber: input.housenumber,
        label: [`${street} ${input.housenumber}`, cityPart].filter((p) => p !== '').join(', '),
        ref: known?.ref ?? `mock:${point.latitude},${point.longitude}`,
      },
    ];
  }
  // Ohne Hausnummer: zwei Straßenabschnitte (keine stille Straßenmitte, Design §4).
  const second = hashToPoint(`${query.toLowerCase()}#2`);
  return [
    {
      ...base,
      point,
      housenumber: null,
      label: [street ?? query, cityPart].filter((p) => p !== '').join(', '),
      ref: `mock:${point.latitude},${point.longitude}`,
    },
    {
      ...base,
      point: second,
      housenumber: null,
      label: [street ?? query, cityPart].filter((p) => p !== '').join(', '),
      ref: `mock:${second.latitude},${second.longitude}`,
    },
  ];
}

function hashToPoint(query: string): GeoPoint {
  let h = 2166136261;
  for (const ch of query) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Raum Mainz/Wiesbaden (±0.15°), deterministisch je Adresse.
  const lat = 49.95 + ((h % 3000) / 3000 - 0.5) * 0.3;
  const lon = 8.25 + (((h >>> 12) % 3000) / 3000 - 0.5) * 0.3;
  return { latitude: Number(lat.toFixed(5)), longitude: Number(lon.toFixed(5)) };
}

export class MockRoutingGateway implements RoutingGateway {
  readonly kind: 'mock' | 'fake' = 'mock';
  readonly providerName: string = 'mock';

  async geocode(request: GeocodeRequest): Promise<GeocodeResult> {
    return { candidates: mockGeocodeCandidates(request.query) };
  }

  async route(request: RouteRequest): Promise<RouteResult> {
    if (request.points.length < 2) throw new RoutingError('validation');
    const legs = request.points
      .slice(1)
      .map((point, index) => mockLeg(request.points[index]!, point));
    return {
      legs,
      distanceMeters: legs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
      durationSeconds: legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
    };
  }

  async matrix(request: MatrixRequest): Promise<MatrixResult> {
    const n = request.points.length;
    if (n < 2) throw new RoutingError('validation');
    const durationsSeconds: (number | null)[][] = [];
    const distancesMeters: (number | null)[][] = [];
    for (let i = 0; i < n; i += 1) {
      durationsSeconds.push([]);
      distancesMeters.push([]);
      for (let j = 0; j < n; j += 1) {
        const leg =
          i === j
            ? { distanceMeters: 0, durationSeconds: 0 }
            : mockLeg(request.points[i]!, request.points[j]!);
        durationsSeconds[i]!.push(leg.durationSeconds);
        distancesMeters[i]!.push(leg.distanceMeters);
      }
    }
    return { durationsSeconds, distancesMeters };
  }

  /** Mock-Optimierung: nächster-Nachbar ab Depot unter Beachtung der Reihenfolge-Relationen; harte Zeitfenster ⇒ unassigned (Code 2 wie GraphHopper). */
  async optimizeTour(request: OptimizeTourRequest): Promise<OptimizeTourResult> {
    const remaining = new Map(request.stops.map((stop) => [stop.id, stop]));
    const mustFollow = new Map<string, Set<string>>();
    for (const chain of request.sequenceRelations) {
      for (let i = 1; i < chain.length; i += 1) {
        const later = chain[i]!;
        const set = mustFollow.get(later) ?? new Set<string>();
        set.add(chain[i - 1]!);
        mustFollow.set(later, set);
      }
    }
    const visits: OptimizeTourResult['visits'] = [];
    const unassigned: OptimizeTourResult['unassigned'] = [];
    let current = request.depot;
    let clock = request.earliestStart.getTime();
    let cumDistance = 0;
    let cumDriving = 0;
    const done = new Set<string>();
    while (remaining.size > 0) {
      let best: { id: string; leg: { distanceMeters: number; durationSeconds: number } } | null =
        null;
      for (const [id, stop] of remaining) {
        const predecessors = mustFollow.get(id);
        if (predecessors !== undefined && [...predecessors].some((p) => remaining.has(p))) continue;
        const leg = mockLeg(current, stop.point);
        if (best === null || leg.durationSeconds < best.leg.durationSeconds) best = { id, leg };
      }
      if (best === null) break;
      const stop = remaining.get(best.id)!;
      remaining.delete(best.id);
      let arrival = clock + best.leg.durationSeconds * 1000;
      if (stop.timeWindow !== null) {
        if (arrival < stop.timeWindow.earliest.getTime())
          arrival = stop.timeWindow.earliest.getTime();
        if (arrival > stop.timeWindow.latest.getTime()) {
          unassigned.push({ stopId: stop.id, reasonCode: '2' });
          continue;
        }
      }
      cumDistance += best.leg.distanceMeters;
      cumDriving += best.leg.durationSeconds;
      const departure = arrival + stop.serviceSeconds * 1000;
      visits.push({
        stopId: stop.id,
        arrivalAt: new Date(arrival),
        departureAt: new Date(departure),
        cumulativeDistanceMeters: cumDistance,
        cumulativeDrivingSeconds: cumDriving,
      });
      done.add(stop.id);
      current = stop.point;
      clock = departure;
    }
    for (const [id] of remaining) unassigned.push({ stopId: id, reasonCode: '21' });
    const back = mockLeg(current, request.depot);
    return {
      visits,
      unassigned,
      totalDistanceMeters: cumDistance + back.distanceMeters,
      totalDurationSeconds: Math.round(
        (clock + back.durationSeconds * 1000 - request.earliestStart.getTime()) / 1000,
      ),
      returnToDepotArrivalAt: new Date(clock + back.durationSeconds * 1000),
    };
  }
}

export type FakeRoutingCall =
  | { method: 'geocode'; request: GeocodeRequest }
  | { method: 'route'; request: RouteRequest }
  | { method: 'matrix'; request: MatrixRequest }
  | { method: 'optimizeTour'; request: OptimizeTourRequest };

type FakeMethod = FakeRoutingCall['method'];

/** Skriptbare Antwort: Fehlerart (einmalig/dauerhaft) oder feste Ergebnisse. */
export interface FakeRoutingScript {
  failNext?: Partial<
    Record<
      FakeMethod | 'all',
      { kind: RoutingErrorKind; times: number | null; status?: number; retryAfterMs?: number }
    >
  >;
  geocode?: (request: GeocodeRequest) => GeocodeResult;
  route?: (request: RouteRequest) => RouteResult;
  matrix?: (request: MatrixRequest) => MatrixResult;
  optimizeTour?: (request: OptimizeTourRequest) => OptimizeTourResult;
  /** Künstliche Verzögerung je Aufruf (Race-Tests: „Tourversion ändert sich während der Berechnung“). */
  delayMs?: number;
  /** Hook vor der Antwort (Race-Tests). */
  beforeRespond?: (call: FakeRoutingCall) => Promise<void>;
}

export class FakeRoutingGateway extends MockRoutingGateway implements RoutingGateway {
  override readonly kind = 'fake' as const;
  override readonly providerName: string = 'fake';
  readonly calls: FakeRoutingCall[] = [];
  private script: FakeRoutingScript = {};

  configure(script: FakeRoutingScript): void {
    this.script = {
      ...this.script,
      ...script,
      failNext: { ...this.script.failNext, ...script.failNext },
    };
  }

  reset(): void {
    this.calls.length = 0;
    this.script = {};
  }

  /** Alle aufgezeichneten Anfragen als JSON (Order §20: nie Kundendaten darin). */
  serializedCalls(): string {
    return JSON.stringify(this.calls);
  }

  private async intercept<T>(call: FakeRoutingCall, compute: () => Promise<T>): Promise<T> {
    this.calls.push(call);
    const rule = this.script.failNext?.[call.method] ?? this.script.failNext?.all;
    if (rule !== undefined && (rule.times === null || rule.times > 0)) {
      if (rule.times !== null) rule.times -= 1;
      throw new RoutingError(rule.kind, rule.status ?? null, rule.retryAfterMs ?? null);
    }
    if (this.script.delayMs !== undefined)
      await new Promise((r) => setTimeout(r, this.script.delayMs));
    await this.script.beforeRespond?.(call);
    return compute();
  }

  override geocode(request: GeocodeRequest): Promise<GeocodeResult> {
    return this.intercept({ method: 'geocode', request }, async () =>
      this.script.geocode !== undefined ? this.script.geocode(request) : super.geocode(request),
    );
  }

  override route(request: RouteRequest): Promise<RouteResult> {
    return this.intercept({ method: 'route', request }, async () =>
      this.script.route !== undefined ? this.script.route(request) : super.route(request),
    );
  }

  override matrix(request: MatrixRequest): Promise<MatrixResult> {
    return this.intercept({ method: 'matrix', request }, async () =>
      this.script.matrix !== undefined ? this.script.matrix(request) : super.matrix(request),
    );
  }

  override optimizeTour(request: OptimizeTourRequest): Promise<OptimizeTourResult> {
    return this.intercept({ method: 'optimizeTour', request }, async () =>
      this.script.optimizeTour !== undefined
        ? this.script.optimizeTour(request)
        : super.optimizeTour(request),
    );
  }
}

/** Routing nicht konfiguriert (production ohne Key, staging ohne Opt-in): jede Anfrage ⇒ ROUTING_DISABLED. */
export class DisabledRoutingGateway implements RoutingGateway {
  readonly kind = 'disabled' as const;
  readonly providerName = 'disabled';
  async geocode(): Promise<GeocodeResult> {
    throw new RoutingError('disabled');
  }
  async route(): Promise<RouteResult> {
    throw new RoutingError('disabled');
  }
  async matrix(): Promise<MatrixResult> {
    throw new RoutingError('disabled');
  }
  async optimizeTour(): Promise<OptimizeTourResult> {
    throw new RoutingError('disabled');
  }
}
