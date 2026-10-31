import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseGeocodeQuery } from '../address-parse.ts';
import { MockRoutingGateway, MOCK_CUSTOMER_POINT, MOCK_DEPOT_POINT, mockLeg } from '../fake.ts';
import type { GeoPoint } from '../types.ts';

/**
 * Phase 13 (Order §70): Contract-Fake der GraphHopper Directions API
 * (Pfade /api/1/geocode, /api/1/route, /api/1/matrix, /api/1/vrp) mit den
 * verifizierten Antwortformen (docs/ROUTING_API_NOTES.md, 2026-10-30):
 * - Auth nur über Query `key=`; fehlender/falscher Key ⇒ 401 GHError.
 * - X-RateLimit-Limit/-Remaining/-Reset/-Credits auf jeder Antwort.
 * - skriptbare Szenarien (`state.failures`): 400 mit hints, 401, 429 mit
 *   Rate-Limit-Headern, 500, Timeout (Antwort verzögern), invalides JSON.
 * - zeichnet jede Anfrage auf (Pfad, Query OHNE Key, Body) – Tests prüfen
 *   damit, dass nur Koordinaten/Adressen/Zeitfenster/IDs gesendet werden.
 * - Der Key wird NIE geloggt oder in Aufzeichnungen abgelegt.
 * Zwei Nutzungsarten: `startGraphHopperFakeServer()` (eigener node:http-Server,
 * Integrationstests) oder `createGraphHopperFakeHandler(state)` zum Einhängen
 * in den E2E-HTTPS-Dispatcher (tests/e2e/fakes, Port 4567).
 */

export interface GraphHopperFakeHit {
  point: { lat: number; lng: number };
  osm_id?: number | string;
  osm_type?: string;
  name?: string;
  country?: string;
  city?: string;
  state?: string;
  street?: string;
  housenumber?: string;
  postcode?: string;
}

export type GraphHopperFakeEndpoint = 'geocode' | 'route' | 'matrix' | 'vrp';

export interface GraphHopperFakeFailure {
  /** Endpunkt oder 'all'. */
  endpoint: GraphHopperFakeEndpoint | 'all';
  /** Wie oft die Störung greift (danach entfernt). */
  times: number;
  /** 'status' (Default): Statuscode + Body; 'delay': Antwort um delayMs verzögern; 'invalid_json': 200 mit kaputtem JSON. */
  mode?: 'status' | 'delay' | 'invalid_json';
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface GraphHopperFakeRequest {
  method: string;
  /** Pfad ohne Query. */
  path: string;
  endpoint: GraphHopperFakeEndpoint | null;
  /** Query ohne `key` (nur Anwesenheit wird vermerkt). */
  query: Record<string, string>;
  keyPresent: boolean;
  keyValid: boolean;
  body: unknown;
  at: number;
  status: number;
}

export interface GraphHopperFakeState {
  apiKey: string;
  pathPrefix: string;
  requests: GraphHopperFakeRequest[];
  failures: GraphHopperFakeFailure[];
  rateLimit: { limit: number; remaining: number; reset: number };
  /** Geocoding-Treffer je Anfrage (skriptbar; Default: bekannte Testadressen). */
  geocode: (query: string) => GraphHopperFakeHit[];
  /** Matrix: Paare, die unerreichbar sind (null) – Indizes "i,j". */
  unreachablePairs: Set<string>;
  reset(): void;
}

/** Bekannte Testadressen (gleiche Koordinaten wie MockRoutingGateway). */
export const FAKE_HITS = {
  depot: {
    point: { lat: 49.9545, lng: 8.2735 },
    osm_id: 100001,
    osm_type: 'W',
    name: 'Robert-Koch-Straße 1',
    country: 'Deutschland',
    city: 'Mainz',
    state: 'Rheinland-Pfalz',
    street: 'Robert-Koch-Straße',
    housenumber: '1',
    postcode: '55129',
  },
  lieferweg12: {
    point: { lat: 49.9742, lng: 8.2566 },
    osm_id: 100002,
    osm_type: 'W',
    name: 'Lieferweg 12',
    country: 'Deutschland',
    city: 'Mainz',
    state: 'Rheinland-Pfalz',
    street: 'Lieferweg',
    housenumber: '12',
    postcode: '55129',
  },
  amMarktA: {
    point: { lat: 49.9997, lng: 8.2733 },
    osm_id: 100003,
    osm_type: 'W',
    name: 'Am Markt',
    country: 'Deutschland',
    city: 'Mainz',
    street: 'Am Markt',
    postcode: '55116',
  },
  amMarktB: {
    point: { lat: 50.0021, lng: 8.2691 },
    osm_id: 100004,
    osm_type: 'W',
    name: 'Am Markt',
    country: 'Deutschland',
    city: 'Mainz',
    street: 'Am Markt',
    postcode: '55116',
  },
} satisfies Record<string, GraphHopperFakeHit>;

/** Deterministische Koordinate je Anfrage (Raum Mainz/Wiesbaden), stabile osm_id aus demselben Hash. */
function fakeHashPoint(query: string): { point: { lat: number; lng: number }; id: number } {
  let h = 2166136261;
  for (const ch of query.toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const lat = 49.95 + ((h % 3000) / 3000 - 0.5) * 0.3;
  const lon = 8.25 + (((h >>> 12) % 3000) / 3000 - 0.5) * 0.3;
  return {
    point: { lat: Number(lat.toFixed(5)), lng: Number(lon.toFixed(5)) },
    id: 500000 + (h % 400000),
  };
}

/**
 * Phase 13 (Fix F6): Treffer werden aus der ANFRAGE abgeleitet (Straße,
 * Hausnummer, PLZ, Ort), damit vollständige Adressen in `decideGeocoding`
 * als `resolved` gelten – wie beim echten Provider für eindeutige Adressen.
 * Bewusst feste Szenarien: „Am Markt“ (55116) bleibt mehrdeutig (zwei
 * Straßenabschnitte ohne Hausnummer, Review-Dialog), bekannte Adressen
 * (Hechtsheim/Robert-Koch ⇒ Depotpunkt, Lieferweg 12 ⇒ Kundenpunkt) behalten
 * ihre stabilen osm_ids/Koordinaten, Eingaben ohne Hausnummer liefern zwei
 * Abschnitte (⇒ review_required), Adressen außerhalb des Rhein-Main-PLZ-Raums
 * (PLZ nicht 55…/65…) oder ohne PLZ/Ort liefern keinen Treffer (⇒ no_result).
 */
export function defaultFakeGeocode(query: string): GraphHopperFakeHit[] {
  if (/am markt/i.test(query)) return [FAKE_HITS.amMarktA, FAKE_HITS.amMarktB];
  const input = parseGeocodeQuery(query);
  if (input.streetName === null || (input.postcode === null && input.city === null)) return [];
  if (input.postcode !== null && !/^(55|65)\d{3}$/.test(input.postcode)) return [];
  const known = /robert-koch|hechtsheim/i.test(query)
    ? { point: MOCK_DEPOT_POINT, id: FAKE_HITS.depot.osm_id }
    : /lieferweg\s*12\b/i.test(query)
      ? { point: MOCK_CUSTOMER_POINT, id: FAKE_HITS.lieferweg12.osm_id }
      : null;
  const hashed = fakeHashPoint(query);
  const base = {
    osm_type: 'W',
    country: 'Deutschland',
    city: input.city ?? 'Mainz',
    state: 'Rheinland-Pfalz',
    street: input.streetName,
    ...(input.postcode === null ? {} : { postcode: input.postcode }),
  };
  if (input.housenumber !== null) {
    return [
      {
        ...base,
        point:
          known === null ? hashed.point : { lat: known.point.latitude, lng: known.point.longitude },
        osm_id: known?.id ?? hashed.id,
        name: `${input.streetName} ${input.housenumber}`,
        housenumber: input.housenumber,
      },
    ];
  }
  const second = fakeHashPoint(`${query}#2`);
  return [
    { ...base, point: hashed.point, osm_id: hashed.id, name: input.streetName },
    { ...base, point: second.point, osm_id: second.id, name: input.streetName },
  ];
}

export function createGraphHopperFakeState(
  options: { apiKey?: string; pathPrefix?: string } = {},
): GraphHopperFakeState {
  const state: GraphHopperFakeState = {
    apiKey: options.apiKey ?? 'fake-graphhopper-key-only-for-tests',
    pathPrefix: options.pathPrefix ?? '/api/1',
    requests: [],
    failures: [],
    rateLimit: { limit: 500, remaining: 480, reset: 3600 },
    geocode: defaultFakeGeocode,
    unreachablePairs: new Set<string>(),
    reset() {
      state.requests.length = 0;
      state.failures.length = 0;
      state.rateLimit = { limit: 500, remaining: 480, reset: 3600 };
      state.geocode = defaultFakeGeocode;
      state.unreachablePairs.clear();
    },
  };
  return state;
}

const ENDPOINTS: Record<string, GraphHopperFakeEndpoint> = {
  '/geocode': 'geocode',
  '/route': 'route',
  '/matrix': 'matrix',
  '/vrp': 'vrp',
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function ghError(message: string, hints: string[] = []): unknown {
  return { message, hints: hints.map((hint) => ({ message: hint })) };
}

function isLonLat(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    typeof value[1] === 'number' &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function toPoint(lonLat: [number, number]): GeoPoint {
  return { longitude: lonLat[0], latitude: lonLat[1] };
}

function keysWithin(record: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(record).filter((key) => !allowed.includes(key));
}

interface FakeResponse {
  status: number;
  body: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  credits: number;
}

function handleGeocode(state: GraphHopperFakeState, query: Record<string, string>): FakeResponse {
  const q = query.q;
  if (q === undefined || q.trim() === '') {
    return { status: 400, body: ghError('Parameter q is required'), credits: 0 };
  }
  const limit = Math.max(1, Math.min(10, Number(query.limit ?? '5') || 5));
  const hits = state.geocode(q).slice(0, limit);
  const credits = query.provider === 'nominatim' || query.provider === 'opencagedata' ? 0.9 : 0.3;
  return { status: 200, body: { hits, locale: query.locale ?? 'en' }, credits };
}

function handleRoute(body: unknown): FakeResponse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: ghError('Invalid JSON body'), credits: 0 };
  }
  const record = body as Record<string, unknown>;
  const unknown = keysWithin(record, [
    'points',
    'profile',
    'points_encoded',
    'instructions',
    'calc_points',
    'elevation',
    'locale',
  ]);
  if (unknown.length > 0) {
    return {
      status: 400,
      body: ghError(
        'Unknown parameter',
        unknown.map((key) => `parameter ${key} is not supported`),
      ),
      credits: 0,
    };
  }
  const points = record.points;
  if (!Array.isArray(points) || points.length < 2 || !points.every(isLonLat)) {
    return {
      status: 400,
      body: ghError('At least 2 points have to be specified, but was:0', ['points']),
      credits: 0,
    };
  }
  let distance = 0;
  let time = 0;
  for (let index = 1; index < points.length; index += 1) {
    const leg = mockLeg(toPoint(points[index - 1]!), toPoint(points[index]!));
    distance += leg.distanceMeters;
    time += leg.durationSeconds * 1000;
  }
  const lons = points.map((p) => p[0]);
  const lats = points.map((p) => p[1]);
  return {
    status: 200,
    body: {
      paths: [
        {
          distance,
          time,
          bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
        },
      ],
      info: { copyrights: ['GraphHopper', 'OpenStreetMap contributors'], took: 3 },
    },
    credits: 1,
  };
}

function handleMatrix(state: GraphHopperFakeState, body: unknown): FakeResponse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: ghError('Invalid JSON body'), credits: 0 };
  }
  const record = body as Record<string, unknown>;
  const unknown = keysWithin(record, [
    'points',
    'from_points',
    'to_points',
    'profile',
    'out_arrays',
    'fail_fast',
  ]);
  if (unknown.length > 0) {
    return {
      status: 400,
      body: ghError(
        'Unknown parameter',
        unknown.map((key) => `parameter ${key} is not supported`),
      ),
      credits: 0,
    };
  }
  const from = (record.points ?? record.from_points) as unknown;
  const to = (record.points ?? record.to_points) as unknown;
  if (!Array.isArray(from) || !Array.isArray(to) || !from.every(isLonLat) || !to.every(isLonLat)) {
    return { status: 400, body: ghError('Cannot find from_points: 1'), credits: 0 };
  }
  const outArrays = Array.isArray(record.out_arrays) ? record.out_arrays : ['times'];
  const times: (number | null)[][] = [];
  const distances: (number | null)[][] = [];
  from.forEach((a, i) => {
    times.push([]);
    distances.push([]);
    to.forEach((b, j) => {
      if (state.unreachablePairs.has(`${i},${j}`)) {
        times[i]!.push(null);
        distances[i]!.push(null);
        return;
      }
      const leg =
        a[0] === b[0] && a[1] === b[1]
          ? { distanceMeters: 0, durationSeconds: 0 }
          : mockLeg(toPoint(a), toPoint(b));
      times[i]!.push(leg.durationSeconds);
      distances[i]!.push(leg.distanceMeters);
    });
  });
  const hasNull = state.unreachablePairs.size > 0;
  const n = Math.max(from.length, to.length);
  return {
    status: 200,
    body: {
      ...(outArrays.includes('times') ? { times } : {}),
      ...(outArrays.includes('distances') ? { distances } : {}),
      info: { copyrights: ['GraphHopper', 'OpenStreetMap contributors'], took: 5 },
      ...(hasNull
        ? {
            hints: [
              {
                message: 'There are 1 invalid points',
                details: 'com.graphhopper.util.exceptions.PointNotFoundException',
              },
            ],
          }
        : {}),
    },
    credits: Math.max(1, Math.min((from.length * to.length) / 2, n * 10)),
  };
}

const VRP_TOP_KEYS = [
  'vehicles',
  'vehicle_types',
  'services',
  'relations',
  'objectives',
  'configuration',
] as const;
const VRP_VEHICLE_KEYS = [
  'vehicle_id',
  'type_id',
  'start_address',
  'end_address',
  'return_to_depot',
  'earliest_start',
  'latest_end',
] as const;
const VRP_SERVICE_KEYS = ['id', 'address', 'duration', 'time_windows'] as const;
const VRP_ADDRESS_KEYS = ['location_id', 'lon', 'lat'] as const;

async function handleVrp(body: unknown): Promise<FakeResponse> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: ghError('Invalid JSON body'), credits: 0 };
  }
  const record = body as Record<string, unknown>;
  const hints: string[] = keysWithin(record, VRP_TOP_KEYS).map(
    (key) => `Unrecognized field "${key}"`,
  );
  const vehicles = Array.isArray(record.vehicles) ? record.vehicles : [];
  const services = Array.isArray(record.services) ? record.services : [];
  for (const vehicle of vehicles) {
    if (vehicle === null || typeof vehicle !== 'object') continue;
    hints.push(
      ...keysWithin(vehicle as Record<string, unknown>, VRP_VEHICLE_KEYS).map(
        (key) => `Unrecognized field "${key}" in vehicle`,
      ),
    );
    const start = (vehicle as Record<string, unknown>).start_address;
    if (start !== null && typeof start === 'object') {
      hints.push(
        ...keysWithin(start as Record<string, unknown>, VRP_ADDRESS_KEYS).map(
          (key) => `Unrecognized field "${key}" in address`,
        ),
      );
    }
  }
  for (const service of services) {
    if (service === null || typeof service !== 'object') continue;
    hints.push(
      ...keysWithin(service as Record<string, unknown>, VRP_SERVICE_KEYS).map(
        (key) => `Unrecognized field "${key}" in service`,
      ),
    );
    const address = (service as Record<string, unknown>).address;
    if (address !== null && typeof address === 'object') {
      hints.push(
        ...keysWithin(address as Record<string, unknown>, VRP_ADDRESS_KEYS).map(
          (key) => `Unrecognized field "${key}" in address`,
        ),
      );
    }
  }
  if (hints.length > 0) return { status: 400, body: ghError('Invalid request', hints), credits: 0 };
  const vehicle = vehicles[0] as Record<string, unknown> | undefined;
  const start = vehicle?.start_address as Record<string, unknown> | undefined;
  if (
    vehicle === undefined ||
    start === undefined ||
    typeof start.lon !== 'number' ||
    typeof start.lat !== 'number' ||
    services.length === 0
  ) {
    return {
      status: 400,
      body: ghError('Invalid request', ['vehicles[0].start_address and services are required']),
      credits: 0,
    };
  }
  const earliestStart =
    typeof vehicle.earliest_start === 'number'
      ? vehicle.earliest_start
      : Math.floor(Date.now() / 1000);
  const depot: GeoPoint = { longitude: start.lon, latitude: start.lat };
  const stops = services.map((raw) => {
    const service = raw as Record<string, unknown>;
    const address = service.address as Record<string, unknown>;
    const windows = Array.isArray(service.time_windows) ? service.time_windows : [];
    const window = windows[0] as Record<string, unknown> | undefined;
    return {
      id: String(service.id),
      point: { longitude: Number(address.lon), latitude: Number(address.lat) },
      serviceSeconds: typeof service.duration === 'number' ? service.duration : 0,
      timeWindow:
        window !== undefined &&
        typeof window.earliest === 'number' &&
        typeof window.latest === 'number'
          ? { earliest: new Date(window.earliest * 1000), latest: new Date(window.latest * 1000) }
          : null,
    };
  });
  const relations = Array.isArray(record.relations) ? record.relations : [];
  const sequenceRelations = relations
    .map((relation) => (relation as Record<string, unknown>).ids)
    .filter((ids): ids is string[] => Array.isArray(ids))
    .map((ids) => ids.filter((id) => id !== 'start' && id !== 'end'));
  const solver = new MockRoutingGateway();
  const result = await solver.optimizeTour({
    depot,
    earliestStart: new Date(earliestStart * 1000),
    stops,
    sequenceRelations,
  });
  const activities: Record<string, unknown>[] = [
    { type: 'start', location_id: String(start.location_id ?? 'depot'), end_time: earliestStart },
  ];
  for (const visit of result.visits) {
    activities.push({
      type: 'service',
      id: visit.stopId,
      location_id: visit.stopId,
      arr_time: Math.floor(visit.arrivalAt.getTime() / 1000),
      end_time: Math.floor(visit.departureAt.getTime() / 1000),
      waiting_time: 0,
      distance: visit.cumulativeDistanceMeters,
      driving_time: visit.cumulativeDrivingSeconds,
    });
  }
  if (result.returnToDepotArrivalAt !== null) {
    activities.push({
      type: 'end',
      location_id: String(start.location_id ?? 'depot'),
      arr_time: Math.floor(result.returnToDepotArrivalAt.getTime() / 1000),
      distance: result.totalDistanceMeters,
      driving_time: result.totalDurationSeconds,
    });
  }
  return {
    status: 200,
    body: {
      job_id: 'fake-sync',
      status: 'finished',
      solution: {
        costs: result.totalDurationSeconds,
        distance: result.totalDistanceMeters,
        time: result.totalDurationSeconds,
        transport_time: result.totalDurationSeconds,
        completion_time: result.totalDurationSeconds,
        max_operation_time: result.totalDurationSeconds,
        waiting_time: 0,
        service_duration: stops.reduce((sum, stop) => sum + stop.serviceSeconds, 0),
        no_vehicles: 1,
        no_unassigned: result.unassigned.length,
        routes: [{ vehicle_id: String(vehicle.vehicle_id ?? 'vehicle'), activities }],
        unassigned: {
          services: result.unassigned.map((entry) => entry.stopId),
          shipments: [],
          breaks: [],
          details: result.unassigned.map((entry) => ({
            id: entry.stopId,
            code: Number(entry.reasonCode),
            reason:
              entry.reasonCode === '2'
                ? 'cannot be visited within time window'
                : 'relation constraint not satisfied',
          })),
        },
      },
    },
    credits: Math.max(10, vehicles.length * (stops.length + 1)),
  };
}

/**
 * Handler für node:http bzw. den E2E-HTTPS-Dispatcher. Gibt `false` zurück,
 * wenn der Pfad nicht zum Fake gehört (Dispatcher kann weiterreichen).
 * `rawBody` optional – wenn der Dispatcher den Body schon gelesen hat.
 */
export function createGraphHopperFakeHandler(
  state: GraphHopperFakeState,
): (req: IncomingMessage, res: ServerResponse, rawBody?: string) => Promise<boolean> {
  return async (req, res, rawBody) => {
    const url = new URL(req.url ?? '/', 'http://fake.local');
    if (!url.pathname.startsWith(`${state.pathPrefix}/`)) return false;
    const path = url.pathname.slice(state.pathPrefix.length);
    const endpoint = ENDPOINTS[path] ?? null;
    const query: Record<string, string> = {};
    let keyPresent = false;
    let keyValid = false;
    for (const [name, value] of url.searchParams) {
      if (name === 'key') {
        keyPresent = true;
        keyValid = value === state.apiKey;
        continue;
      }
      query[name] = value;
    }
    const raw = rawBody ?? (await readBody(req));
    let body: unknown = null;
    let bodyInvalid = false;
    if (raw !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        bodyInvalid = true;
      }
    }
    const record: GraphHopperFakeRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      endpoint,
      query,
      keyPresent,
      keyValid,
      body,
      at: Date.now(),
      status: 0,
    };
    state.requests.push(record);

    const send = (response: FakeResponse) => {
      record.status = response.status;
      const remaining = Math.max(0, state.rateLimit.remaining - response.credits);
      state.rateLimit.remaining = remaining;
      res.statusCode = response.status;
      res.setHeader('content-type', 'application/json');
      res.setHeader('X-RateLimit-Limit', String(state.rateLimit.limit));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(state.rateLimit.reset));
      res.setHeader('X-RateLimit-Credits', String(response.credits));
      for (const [name, value] of Object.entries(response.headers ?? {}))
        res.setHeader(name, value);
      res.end(response.rawBody ?? JSON.stringify(response.body));
    };

    if (endpoint === null) {
      send({ status: 404, body: ghError('Not found'), credits: 0 });
      return true;
    }
    if (!keyPresent || !keyValid) {
      send({
        status: 401,
        body: ghError('Wrong credentials', ['API key is missing or invalid']),
        credits: 0,
      });
      return true;
    }
    const failureIndex = state.failures.findIndex(
      (failure) =>
        failure.times > 0 && (failure.endpoint === 'all' || failure.endpoint === endpoint),
    );
    if (failureIndex >= 0) {
      const failure = state.failures[failureIndex]!;
      failure.times -= 1;
      if (failure.times <= 0) state.failures.splice(failureIndex, 1);
      const mode = failure.mode ?? 'status';
      if (mode === 'invalid_json') {
        send({ status: 200, body: null, rawBody: '{"hits": [', credits: 0.3 });
        return true;
      }
      if (mode === 'delay') {
        await new Promise((resolve) => setTimeout(resolve, failure.delayMs ?? 1000));
        // Phase 13 Final (RL): nur die Antwortseite prüfen – `req.destroyed` ist nach
        // vollständig gelesenem POST-Body immer true (autoDestroy) und würde die
        // verzögerte Antwort fälschlich unterdrücken.
        if (res.destroyed || res.writableEnded) {
          record.status = 499;
          return true;
        }
      } else {
        send({
          status: failure.status ?? 500,
          body: failure.body ?? ghError(failure.status === 429 ? 'API limit violated' : 'Error'),
          credits: 0,
          ...(failure.headers === undefined ? {} : { headers: failure.headers }),
        });
        return true;
      }
    }
    if (bodyInvalid) {
      send({ status: 400, body: ghError('Invalid JSON body'), credits: 0 });
      return true;
    }
    if (endpoint === 'geocode') {
      send(req.method === 'GET' ? handleGeocode(state, query) : methodNotAllowed());
      return true;
    }
    if (req.method !== 'POST') {
      send(methodNotAllowed());
      return true;
    }
    if (endpoint === 'route') send(handleRoute(body));
    else if (endpoint === 'matrix') send(handleMatrix(state, body));
    else send(await handleVrp(body));
    return true;
  };
}

function methodNotAllowed(): FakeResponse {
  return { status: 405, body: ghError('Method not allowed'), credits: 0 };
}

export interface GraphHopperFakeServer {
  /** z. B. http://127.0.0.1:PORT/api/1 – direkt als GRAPHHOPPER_BASE_URL nutzbar. */
  baseUrl: string;
  origin: string;
  state: GraphHopperFakeState;
  stop(): Promise<void>;
}

export async function startGraphHopperFakeServer(
  options: { apiKey?: string; port?: number; pathPrefix?: string } = {},
): Promise<GraphHopperFakeServer> {
  const state = createGraphHopperFakeState({
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.pathPrefix === undefined ? {} : { pathPrefix: options.pathPrefix }),
  });
  const handler = createGraphHopperFakeHandler(state);
  const server: Server = createServer((req, res) => {
    void handler(req, res)
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end(JSON.stringify(ghError('Not found')));
        }
      })
      .catch(() => {
        res.statusCode = 500;
        res.end(JSON.stringify(ghError('fake crashed')));
      });
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve()),
  );
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl: `${origin}${state.pathPrefix}`,
    origin,
    state,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
