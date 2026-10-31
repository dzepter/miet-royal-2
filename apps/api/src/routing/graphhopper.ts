import { z } from '@mietroyal/validation';
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

/**
 * Phase 13 (Design §5): einziger HTTP-Client gegen die GraphHopper Directions
 * API (verifiziert 2026-10-30, docs/ROUTING_API_NOTES.md).
 *
 * - Auth NUR als Query-Parameter `key=` (offiziell dokumentiert; kein Header-
 *   Auth). Der Key steht damit in der URL ⇒ URLs erscheinen NIE in Fehlern
 *   oder Logs; `maskRoutingUrl` entfernt die Query für jede Ausgabe.
 * - fetch mit AbortController-Timeout, `redirect: 'error'` (kein Folgen auf
 *   fremde Hosts), Antworten minimal zod-validiert (nur genutzte Felder) ⇒
 *   unerwartetes Format = `invalid_response` (fail-closed).
 * - Fehlerklassifikation nach Status (Design §0): 400 validation, 401/403
 *   auth_invalid, 404 not_found, 429 rate_limited (bzw. credit_limited, wenn
 *   das Tageskontingent erschöpft ist), 5xx server_error, Abbruch timeout,
 *   Netzfehler network. Keine eigenen Retries – Aufrufer entscheiden über
 *   `RoutingError.transient`.
 * - In-process-Drossel: höchstens ein Request je `minIntervalMs` (Default 1 s,
 *   konservativ unter dem Basic-Plan) plus Pause nach 429 – kein Request-Sturm.
 *   Phase 13 (Fix F1): während der Pause scheitern Aufrufe SOFORT (fail-fast,
 *   `rate_limited`/`credit_limited`, Status 429, Rest der Pause als
 *   retryAfterMs) statt zu schlafen; Minuten-429 (Remaining > 0) pausiert
 *   höchstens 60 s, erschöpftes Tageskontingent (credit_limited) bis zum Reset.
 * - Logs nur {method, endpoint, status, outcome, durationMs, credits} –
 *   nie URL, Query, Key, Request-/Antwortkörper.
 * - Datenminimierung (Order §4): Bodies enthalten ausschließlich Koordinaten,
 *   Zeitfenster, Servicezeiten und anonyme Stop-IDs; Geocoding nur die Adresse.
 */

export interface RoutingLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface GraphHopperGatewayOptions {
  apiKey: string;
  /** z. B. https://graphhopper.com/api/1 (ohne Slash am Ende). */
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  logger?: RoutingLogger;
  /** Mindestabstand zwischen zwei Requests (Default 1000 ms). */
  minIntervalMs?: number;
  /** Pause nach 429 ohne auswertbaren Reset-Header (Default 60 s – „bis zur nächsten Minute“). */
  defaultRetryAfterMs?: number;
  /** Nur Tests: Zeit/Schlaf injizierbar. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const GRAPHHOPPER_PROFILE = 'car';
export const GRAPHHOPPER_GEOCODE_PROVIDER = 'nominatim';
export const GRAPHHOPPER_GEOCODE_LOCALE = 'de';
export const GRAPHHOPPER_MIN_INTERVAL_MS = 1000;
export const GRAPHHOPPER_DEFAULT_RETRY_AFTER_MS = 60_000;
/** Phase 13 (Fix F1): längste Pause nach einem Minuten-429 (Remaining > 0) – nie bis zum Tagesreset. */
export const GRAPHHOPPER_RATE_LIMIT_PAUSE_MAX_MS = 60_000;

/** Entfernt die Query (und damit `key=`) aus einer URL – für jede Ausgabe/Fehlermeldung. */
export function maskRoutingUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hasQuery = parsed.search !== '';
    parsed.search = '';
    parsed.hash = '';
    return hasQuery ? `${parsed.toString()}?key=***` : parsed.toString();
  } catch {
    const cut = url.split(/[?#]/)[0] ?? '';
    return cut === url ? url : `${cut}?key=***`;
  }
}

// ── Minimale Antwortschemata (nur genutzte Felder, Design §0) ──────────────

const geocodeHitSchema = z.object({
  point: z.object({ lat: z.number(), lng: z.number() }),
  osm_id: z.union([z.number(), z.string()]).optional(),
  osm_type: z.string().optional(),
  name: z.string().optional(),
  country: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  street: z.string().optional(),
  housenumber: z.string().optional(),
  postcode: z.string().optional(),
});
const geocodeResponseSchema = z.object({ hits: z.array(geocodeHitSchema) });

const routeResponseSchema = z.object({
  paths: z
    .array(z.object({ distance: z.number().nonnegative(), time: z.number().nonnegative() }))
    .min(1),
});

const matrixCell = z.union([z.number(), z.null()]);
const matrixResponseSchema = z.object({
  times: z.array(z.array(matrixCell)),
  distances: z.array(z.array(matrixCell)),
});

const vrpActivitySchema = z.object({
  type: z.string(),
  id: z.string().optional(),
  location_id: z.string().optional(),
  arr_time: z.number().optional(),
  end_time: z.number().optional(),
  waiting_time: z.number().optional(),
  distance: z.number().optional(),
  driving_time: z.number().optional(),
});
const vrpResponseSchema = z.object({
  solution: z.object({
    distance: z.number().optional(),
    transport_time: z.number().optional(),
    completion_time: z.number().optional(),
    routes: z.array(z.object({ activities: z.array(vrpActivitySchema) })),
    unassigned: z
      .object({
        services: z.array(z.string()).optional(),
        details: z
          .array(
            z.object({
              id: z.string(),
              code: z.union([z.number(), z.string()]),
              reason: z.string().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
  }),
});

type GeocodeHit = z.infer<typeof geocodeHitSchema>;

function classifyStatus(status: number): RoutingErrorKind {
  if (status === 400) return 'validation';
  if (status === 401 || status === 403) return 'auth_invalid';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'validation';
}

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

function toLonLat(point: GeoPoint): [number, number] {
  return [point.longitude, point.latitude];
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** Anzeige-Label nur aus Adressbestandteilen („Straße Nr, PLZ Ort“). */
export function geocodeHitLabel(hit: {
  street?: string | null | undefined;
  housenumber?: string | null | undefined;
  postcode?: string | null | undefined;
  city?: string | null | undefined;
  name?: string | null | undefined;
}): string {
  const streetPart = [hit.street, hit.housenumber]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ');
  const cityPart = [hit.postcode, hit.city]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ');
  const parts = [streetPart, cityPart].filter((part) => part !== '');
  if (parts.length > 0) return parts.join(', ');
  return hit.name?.trim() ?? '';
}

function hitToCandidate(hit: GeocodeHit): GeocodeCandidate {
  const ref =
    hit.osm_type !== undefined && hit.osm_id !== undefined
      ? `osm:${hit.osm_type}${String(hit.osm_id)}`
      : null;
  return {
    point: { latitude: hit.point.lat, longitude: hit.point.lng },
    label: geocodeHitLabel(hit),
    street: hit.street ?? null,
    housenumber: hit.housenumber ?? null,
    postcode: hit.postcode ?? null,
    city: hit.city ?? null,
    country: hit.country ?? null,
    ref,
  };
}

export class GraphHopperRoutingGateway implements RoutingGateway {
  readonly kind = 'graphhopper' as const;
  readonly providerName = 'graphhopper';
  private readonly fetchImpl: typeof fetch;
  private readonly minIntervalMs: number;
  private readonly defaultRetryAfterMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Frühester Zeitpunkt des nächsten Requests (1-s-Drossel). */
  private nextSlotAt = 0;
  /** Phase 13 (Fix F1): 429-Pause – bis dahin scheitern Aufrufe sofort (kein Schlafen). */
  private pausedUntil = 0;
  private pauseKind: 'rate_limited' | 'credit_limited' = 'rate_limited';
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: GraphHopperGatewayOptions) {
    if (!/^https?:\/\//.test(options.baseUrl)) {
      throw new Error('Routing baseUrl muss http(s) sein');
    }
    if (options.apiKey.trim() === '') throw new Error('Routing apiKey fehlt');
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.minIntervalMs = options.minIntervalMs ?? GRAPHHOPPER_MIN_INTERVAL_MS;
    this.defaultRetryAfterMs = options.defaultRetryAfterMs ?? GRAPHHOPPER_DEFAULT_RETRY_AFTER_MS;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // ── RoutingGateway ──────────────────────────────────────────────────────

  async geocode(request: GeocodeRequest): Promise<GeocodeResult> {
    const limit = Math.max(1, Math.min(10, Math.floor(request.limit)));
    const data = await this.request('GET', '/geocode', geocodeResponseSchema, {
      query: {
        q: request.query,
        locale: GRAPHHOPPER_GEOCODE_LOCALE,
        limit: String(limit),
        provider: GRAPHHOPPER_GEOCODE_PROVIDER,
      },
    });
    return { candidates: data.hits.slice(0, limit).map(hitToCandidate) };
  }

  /**
   * POST /route je Abschnitt (zwei Punkte = 1 Credit): die dokumentierte
   * Antwort liefert nur Gesamtwerte je Pfad, keine Abschnittswerte – deshalb
   * ein Aufruf je aufeinanderfolgendem Punktepaar (für ≥ 3 Punkte ist
   * `matrix()` meist die bessere Wahl).
   */
  async route(request: RouteRequest): Promise<RouteResult> {
    if (request.points.length < 2) throw new RoutingError('validation');
    const legs: RouteResult['legs'] = [];
    for (let index = 1; index < request.points.length; index += 1) {
      const data = await this.request('POST', '/route', routeResponseSchema, {
        body: {
          points: [toLonLat(request.points[index - 1]!), toLonLat(request.points[index]!)],
          profile: GRAPHHOPPER_PROFILE,
          points_encoded: false,
          instructions: false,
          calc_points: false,
          elevation: false,
          locale: GRAPHHOPPER_GEOCODE_LOCALE,
        },
      });
      const path = data.paths[0]!;
      legs.push({
        distanceMeters: Math.round(path.distance),
        durationSeconds: Math.round(path.time / 1000),
      });
    }
    return {
      legs,
      distanceMeters: legs.reduce((sum, leg) => sum + leg.distanceMeters, 0),
      durationSeconds: legs.reduce((sum, leg) => sum + leg.durationSeconds, 0),
    };
  }

  async matrix(request: MatrixRequest): Promise<MatrixResult> {
    const n = request.points.length;
    if (n < 2) throw new RoutingError('validation');
    const points = request.points.map(toLonLat);
    const data = await this.request('POST', '/matrix', matrixResponseSchema, {
      body: {
        // Symmetrische Matrix über `points` (≥ 3 Punkte); bei zwei Punkten explizit from/to.
        ...(n >= 3 ? { points } : { from_points: points, to_points: points }),
        profile: GRAPHHOPPER_PROFILE,
        out_arrays: ['times', 'distances'],
        fail_fast: false,
      },
    });
    const square = (rows: (number | null)[][]) =>
      rows.length === n && rows.every((row) => row.length === n);
    if (!square(data.times) || !square(data.distances)) {
      this.log('warn', 'POST', '/matrix', 200, 'invalid_response', 0, null);
      throw new RoutingError('invalid_response', 200);
    }
    return {
      durationsSeconds: data.times.map((row) =>
        row.map((v) => (v === null ? null : Math.round(v))),
      ),
      distancesMeters: data.distances.map((row) =>
        row.map((v) => (v === null ? null : Math.round(v))),
      ),
    };
  }

  /** POST /vrp synchron – nur dokumentierte Felder (Design §0/§5). */
  async optimizeTour(request: OptimizeTourRequest): Promise<OptimizeTourResult> {
    if (request.stops.length === 0) throw new RoutingError('validation');
    const body = {
      vehicles: [
        {
          vehicle_id: 'vehicle',
          type_id: 'car',
          start_address: {
            location_id: 'depot',
            lon: request.depot.longitude,
            lat: request.depot.latitude,
          },
          return_to_depot: true,
          earliest_start: unixSeconds(request.earliestStart),
        },
      ],
      vehicle_types: [{ type_id: 'car', profile: GRAPHHOPPER_PROFILE }],
      services: request.stops.map((stop) => ({
        id: stop.id,
        address: { location_id: stop.id, lon: stop.point.longitude, lat: stop.point.latitude },
        duration: Math.max(0, Math.round(stop.serviceSeconds)),
        ...(stop.timeWindow === null
          ? {}
          : {
              time_windows: [
                {
                  earliest: unixSeconds(stop.timeWindow.earliest),
                  latest: unixSeconds(stop.timeWindow.latest),
                },
              ],
            }),
      })),
      ...(request.sequenceRelations.length === 0
        ? {}
        : {
            relations: request.sequenceRelations
              .filter((ids) => ids.length >= 2)
              .map((ids) => ({ type: 'in_sequence', ids })),
          }),
      objectives: [{ type: 'min', value: 'completion_time' }],
      configuration: { routing: { calc_points: false } },
    };
    const data = await this.request('POST', '/vrp', vrpResponseSchema, { body });
    const solution = data.solution;
    const visits: OptimizeTourResult['visits'] = [];
    let returnToDepotArrivalAt: Date | null = null;
    for (const route of solution.routes) {
      for (const activity of route.activities) {
        if (activity.type === 'service' && activity.id !== undefined) {
          const arrival = activity.arr_time ?? null;
          const end = activity.end_time ?? arrival;
          if (arrival === null || end === null) {
            this.log('warn', 'POST', '/vrp', 200, 'invalid_response', 0, null);
            throw new RoutingError('invalid_response', 200);
          }
          visits.push({
            stopId: activity.id,
            arrivalAt: new Date(arrival * 1000),
            departureAt: new Date(end * 1000),
            cumulativeDistanceMeters: Math.round(activity.distance ?? 0),
            cumulativeDrivingSeconds: Math.round(activity.driving_time ?? 0),
          });
        } else if (activity.type === 'end' && activity.arr_time !== undefined) {
          returnToDepotArrivalAt = new Date(activity.arr_time * 1000);
        }
      }
    }
    const details = new Map<string, string>();
    for (const detail of solution.unassigned?.details ?? []) {
      details.set(detail.id, String(detail.code));
    }
    const unassignedIds = new Set<string>([
      ...(solution.unassigned?.services ?? []),
      ...details.keys(),
    ]);
    const unassigned = [...unassignedIds].map((stopId) => ({
      stopId,
      reasonCode: details.get(stopId) ?? 'unknown',
    }));
    return {
      visits,
      unassigned,
      totalDistanceMeters: Math.round(solution.distance ?? 0),
      totalDurationSeconds: Math.round(solution.completion_time ?? solution.transport_time ?? 0),
      returnToDepotArrivalAt,
    };
  }

  // ── Transport ───────────────────────────────────────────────────────────

  /**
   * Drossel: ein Request je minIntervalMs (kurzes Warten). Phase 13 (Fix F1):
   * Eine aktive 429-Pause lässt NIEMANDEN schlafen – jeder Aufruf scheitert
   * sofort mit `rate_limited`/`credit_limited` (Status 429, Rest der Pause als
   * retryAfterMs) und ohne Provider-Request. So hängen weder HTTP-Handler noch
   * der Worker (scan_due) bis zu einem Tagesreset; „kein Retry-Sturm“ bleibt.
   */
  private async acquireSlot(): Promise<void> {
    const ticket = this.chain.then(async () => {
      const now = this.now();
      if (this.pausedUntil > now) {
        throw new RoutingError(this.pauseKind, 429, this.pausedUntil - now);
      }
      const startAt = Math.max(now, this.nextSlotAt);
      this.nextSlotAt = startAt + this.minIntervalMs;
      if (startAt > now) await this.sleep(startAt - now);
    });
    this.chain = ticket.catch(() => undefined);
    await ticket;
  }

  /**
   * Pause nach 429 (Fix F1): Minuten-Limit (Remaining > 0 bzw. unbekannt) ⇒
   * höchstens 60 s, auch wenn X-RateLimit-Reset den Tagesreset nennt;
   * Tageskontingent erschöpft (credit_limited) ⇒ bis zum Reset – beides fail-fast.
   */
  private pauseFor(kind: 'rate_limited' | 'credit_limited', ms: number): number {
    const pauseMs =
      kind === 'credit_limited' ? ms : Math.min(ms, GRAPHHOPPER_RATE_LIMIT_PAUSE_MAX_MS);
    const until = this.now() + pauseMs;
    if (until > this.pausedUntil) {
      this.pausedUntil = until;
      this.pauseKind = kind;
    }
    return pauseMs;
  }

  private buildUrl(endpoint: string, query: Record<string, string> | undefined): URL {
    const url = new URL(`${this.options.baseUrl.replace(/\/+$/, '')}${endpoint}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    // Auth ausschließlich als Query-Parameter `key` (offiziell dokumentiert).
    url.searchParams.set('key', this.options.apiKey);
    return url;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    endpoint: '/geocode' | '/route' | '/matrix' | '/vrp',
    schema: z.ZodType<T>,
    input: { query?: Record<string, string>; body?: unknown },
  ): Promise<T> {
    try {
      await this.acquireSlot();
    } catch (error) {
      // Fix F1: aktive 429-Pause ⇒ sofort scheitern, kein Request (Log: status null = nicht gesendet).
      if (error instanceof RoutingError)
        this.log('warn', method, endpoint, null, error.kind, 0, null);
      throw error;
    }
    const url = this.buildUrl(endpoint, input.query);
    const startedAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      const kind: RoutingErrorKind = controller.signal.aborted ? 'timeout' : 'network';
      this.log('warn', method, endpoint, null, kind, startedAt, null);
      throw new RoutingError(kind);
    }
    clearTimeout(timer);
    const credits = headerNumber(response.headers, 'x-ratelimit-credits');

    if (!response.ok) {
      // Body nie lesen/weitergeben (Provider-Fehlertexte bleiben beim Provider).
      await response.body?.cancel().catch(() => undefined);
      let kind = classifyStatus(response.status);
      let retryAfterMs: number | null = null;
      if (response.status === 429) {
        const resetSeconds = headerNumber(response.headers, 'x-ratelimit-reset');
        const remaining = headerNumber(response.headers, 'x-ratelimit-remaining');
        const resetMs =
          resetSeconds !== null && resetSeconds >= 0
            ? Math.round(resetSeconds * 1000)
            : this.defaultRetryAfterMs;
        if (remaining !== null && remaining <= 0 && resetMs > 60_000) kind = 'credit_limited';
        // Fix F1: retryAfterMs = tatsächliche Pause dieses Clients (Minuten-Limit ≤ 60 s).
        retryAfterMs = this.pauseFor(
          kind === 'credit_limited' ? 'credit_limited' : 'rate_limited',
          resetMs,
        );
      }
      this.log('warn', method, endpoint, response.status, kind, startedAt, credits);
      throw new RoutingError(kind, response.status, retryAfterMs);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      this.log('warn', method, endpoint, response.status, 'invalid_response', startedAt, credits);
      throw new RoutingError('invalid_response', response.status);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      this.log('warn', method, endpoint, response.status, 'invalid_response', startedAt, credits);
      throw new RoutingError('invalid_response', response.status);
    }
    this.log('info', method, endpoint, response.status, 'ok', startedAt, credits);
    return parsed.data;
  }

  private log(
    level: 'info' | 'warn',
    method: string,
    endpoint: string,
    status: number | null,
    outcome: string,
    startedAt: number,
    credits: number | null,
  ): void {
    this.options.logger?.[level](
      {
        routing: {
          provider: 'graphhopper',
          method,
          endpoint,
          status,
          outcome,
          durationMs: startedAt === 0 ? 0 : Math.max(0, this.now() - startedAt),
          ...(credits === null ? {} : { credits }),
        },
      },
      'Routing-Request',
    );
  }
}
