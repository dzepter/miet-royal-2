/**
 * Phase-13-Pflichttests 11–16 (Order §72) am Contract-Fake der GraphHopper
 * Directions API: Auth nur als Query `key` (nie in Logs/Fehlern),
 * Fehlerklassifikation je Status, 429 mit X-RateLimit-Reset, Timeout,
 * invalides JSON fail-closed, Provider-Ausfall ohne Retry-Sturm,
 * Datenminimierung der Request-Bodies, Drossel, Fabrik.
 */
import { loadConfig } from '@mietroyal/config';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryIntegrationRateLimiter } from '../src/integrations/rate-limiter.ts';
import { createRoutingGateway } from '../src/routing/factory.ts';
import {
  GraphHopperRoutingGateway,
  maskRoutingUrl,
  type GraphHopperGatewayOptions,
} from '../src/routing/graphhopper.ts';
import {
  FAKE_HITS,
  startGraphHopperFakeServer,
  type GraphHopperFakeHit,
  type GraphHopperFakeServer,
} from '../src/routing/testing/fake-server.ts';
import { RoutingError } from '../src/routing/types.ts';

const SYNTH_KEY = 'SYNTH-graphhopper-key-0123456789-never-real';
const DEPOT = { latitude: 49.9545, longitude: 8.2735 };
const CUSTOMER = { latitude: 49.9742, longitude: 8.2566 };
const THIRD = { latitude: 50.0011, longitude: 8.2588 };

let fake: GraphHopperFakeServer;
const logs: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
const logger = {
  info: (obj: Record<string, unknown>, msg: string) => logs.push({ level: 'info', obj, msg }),
  warn: (obj: Record<string, unknown>, msg: string) => logs.push({ level: 'warn', obj, msg }),
};
const sleeps: number[] = [];

/**
 * Phase 13 Final (§1): Unit-Tests ohne DB nutzen den In-Memory-Limiter mit
 * derselben Schnittstelle wie der Postgres-Limiter (Uhr/Schlaf teilbar).
 */
function limiterFor(
  overrides: {
    minIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): InMemoryIntegrationRateLimiter {
  return new InMemoryIntegrationRateLimiter({
    provider: 'graphhopper',
    intervalMs: overrides.minIntervalMs ?? 0,
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
  });
}

function gatewayFor(
  overrides: Partial<GraphHopperGatewayOptions> & {
    minIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): GraphHopperRoutingGateway {
  const { minIntervalMs, sleep, ...options } = overrides;
  return new GraphHopperRoutingGateway({
    apiKey: SYNTH_KEY,
    baseUrl: fake.baseUrl,
    timeoutMs: 2000,
    logger,
    limiter: limiterFor({
      ...(minIntervalMs === undefined ? {} : { minIntervalMs }),
      ...(overrides.now === undefined ? {} : { now: overrides.now }),
      ...(sleep === undefined ? {} : { sleep }),
    }),
    ...options,
  });
}

async function expectRoutingError(promise: Promise<unknown>): Promise<RoutingError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RoutingError);
    return error as RoutingError;
  }
  throw new Error('RoutingError erwartet');
}

beforeAll(async () => {
  fake = await startGraphHopperFakeServer({ apiKey: SYNTH_KEY });
});
afterAll(async () => {
  await fake.stop();
});
afterEach(() => {
  fake.state.reset();
  logs.length = 0;
  sleeps.length = 0;
});

describe('GraphHopper-Client (Contract-Fake)', () => {
  it('T11. Auth korrekt: Key nur als Query `key`, kein Header; falscher Key ⇒ 401 ⇒ auth_invalid (permanent); Key nie in Logs/Fehlern', async () => {
    const gateway = gatewayFor();
    const result = await gateway.geocode({
      query: 'Lieferweg 12, 55129 Mainz, Deutschland',
      limit: 5,
      locale: 'de',
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      point: { latitude: 49.9742, longitude: 8.2566 },
      label: 'Lieferweg 12, 55129 Mainz',
      street: 'Lieferweg',
      housenumber: '12',
      postcode: '55129',
      city: 'Mainz',
      ref: 'osm:W100002',
    });
    const request = fake.state.requests[0]!;
    expect(request.method).toBe('GET');
    expect(request.path).toBe('/api/1/geocode');
    expect(request.keyPresent).toBe(true);
    expect(request.keyValid).toBe(true);
    expect(request.query).toEqual({
      q: 'Lieferweg 12, 55129 Mainz, Deutschland',
      locale: 'de',
      limit: '5',
      provider: 'nominatim',
    });

    const wrong = gatewayFor({ apiKey: 'SYNTH-wrong-key' });
    const error = await expectRoutingError(wrong.route({ points: [DEPOT, CUSTOMER] }));
    expect(error.kind).toBe('auth_invalid');
    expect(error.status).toBe(401);
    expect(error.transient).toBe(false);
    expect(error.code).toBe('ROUTING_AUTH_INVALID');
    // Ohne Key ⇒ ebenfalls 401 (Fake verlangt den Key wie der echte Dienst).
    const anonymous = await fetch(`${fake.baseUrl}/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        points: [
          [8.27, 49.95],
          [8.25, 49.97],
        ],
        profile: 'car',
      }),
    });
    expect(anonymous.status).toBe(401);

    // T8/T16-Teil: Logs enthalten nur neutrale Felder – nie Key, URL, Query oder Bodies.
    expect(logs.length).toBeGreaterThanOrEqual(2);
    for (const entry of logs) {
      const text = JSON.stringify(entry);
      expect(text).not.toContain(SYNTH_KEY);
      expect(text).not.toContain('SYNTH-wrong-key');
      expect(text).not.toContain('key=');
      expect(text).not.toContain(fake.baseUrl);
      expect(text).not.toContain('Lieferweg');
      const routing = entry.obj.routing as Record<string, unknown>;
      expect(Object.keys(routing).sort()).toEqual(
        ['credits', 'durationMs', 'endpoint', 'method', 'outcome', 'provider', 'status'].filter(
          (key) => key !== 'credits' || 'credits' in routing,
        ),
      );
    }
    expect(logs[0]!.obj).toMatchObject({
      routing: { endpoint: '/geocode', status: 200, outcome: 'ok', credits: 0.9 },
    });
    expect(String(error)).not.toContain('SYNTH');
    expect(error.message).toBe('ROUTING_AUTH_INVALID');
    expect(maskRoutingUrl(`${fake.baseUrl}/geocode?q=Lieferweg&key=${SYNTH_KEY}`)).toBe(
      `${fake.baseUrl}/geocode?key=***`,
    );
    expect(maskRoutingUrl(`${fake.baseUrl}/route`)).toBe(`${fake.baseUrl}/route`);
    expect(maskRoutingUrl(`not a url?key=${SYNTH_KEY}`)).toBe('not a url?key=***');
  });

  it('T12. 429 ⇒ rate_limited (transient) mit retryAfter aus X-RateLimit-Reset; Tageskontingent 0 + Reset > 60 s ⇒ credit_limited (permanent); Pause ⇒ Folge-Requests scheitern sofort (fail-fast, Fix F1)', async () => {
    let clock = 1_000_000;
    const gateway = gatewayFor({ now: () => clock, sleep: async (ms) => void sleeps.push(ms) });
    fake.state.failures.push({
      endpoint: 'route',
      times: 1,
      status: 429,
      headers: {
        'X-RateLimit-Limit': '5000',
        'X-RateLimit-Remaining': '120',
        'X-RateLimit-Reset': '30',
        'X-RateLimit-Credits': '0',
      },
      body: { message: 'API limit violated', hints: [{ message: 'per-minute limit' }] },
    });
    const limited = await expectRoutingError(gateway.route({ points: [DEPOT, CUSTOMER] }));
    expect(limited.kind).toBe('rate_limited');
    expect(limited.status).toBe(429);
    expect(limited.retryAfterMs).toBe(30_000);
    expect(limited.transient).toBe(true);
    expect(fake.state.requests).toHaveLength(1);
    // Fix F1: während der Pause scheitert der nächste Aufruf SOFORT (kein Schlafen,
    // kein Provider-Request); retryAfterMs = Rest der Pause, Status 429.
    clock += 5_000;
    const paused = await expectRoutingError(gateway.route({ points: [DEPOT, CUSTOMER] }));
    expect(paused.kind).toBe('rate_limited');
    expect(paused.status).toBe(429);
    expect(paused.retryAfterMs).toBe(25_000);
    expect(sleeps.some((ms) => ms >= 1_000)).toBe(false);
    expect(fake.state.requests).toHaveLength(1);
    expect(logs.at(-1)!.obj).toMatchObject({
      routing: { endpoint: '/route', outcome: 'rate_limited', status: null },
    });
    // Nach Ablauf der Pause geht es ohne Wartezeit weiter (kein Sturm: ein Request).
    clock += 25_001;
    await gateway.route({ points: [DEPOT, CUSTOMER] });
    expect(fake.state.requests).toHaveLength(2);

    fake.state.failures.push({
      endpoint: 'matrix',
      times: 1,
      status: 429,
      headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '7200' },
    });
    const credits = await expectRoutingError(
      gatewayFor().matrix({ points: [DEPOT, CUSTOMER, THIRD] }),
    );
    expect(credits.kind).toBe('credit_limited');
    expect(credits.retryAfterMs).toBe(7_200_000);
    expect(credits.transient).toBe(false);

    // 429 ohne auswertbaren Header ⇒ konservative Pause (60 s), weiterhin rate_limited.
    fake.state.failures.push({ endpoint: 'geocode', times: 1, status: 429 });
    const noHeader = await expectRoutingError(
      gatewayFor().geocode({ query: 'x, Deutschland', limit: 5, locale: 'de' }),
    );
    expect(noHeader.kind).toBe('rate_limited');
    // Fake sendet X-RateLimit-Reset=3600 (Tagesreset) als Standard – ein Minuten-429
    // (Remaining > 0) pausiert trotzdem höchstens 60 s (Fix F1); ohne Header ebenfalls 60 s.
    expect(noHeader.retryAfterMs).toBe(60_000);
    expect(
      logs
        .filter((entry) => entry.level === 'warn')
        .every((entry) => entry.obj.routing !== undefined),
    ).toBe(true);
    for (const entry of logs) expect(JSON.stringify(entry)).not.toContain(SYNTH_KEY);
  });

  it('F1. 429-Pause blockiert niemanden: Minuten-429 mit Tagesreset ⇒ Pause ≤ 60 s, Folge-Aufrufe sofort rate_limited; Kontingent erschöpft ⇒ credit_limited bis Reset, ebenfalls fail-fast; 429 ohne Header ⇒ 60 s', async () => {
    let clock = 5_000_000;
    const minuteSleeps: number[] = [];
    const gateway = gatewayFor({
      now: () => clock,
      sleep: async (ms) => {
        minuteSleeps.push(ms);
        clock += ms;
      },
    });
    // Minuten-Limit: Remaining > 0, Reset nennt den Tagesreset (10 h).
    fake.state.failures.push({
      endpoint: 'geocode',
      times: 1,
      status: 429,
      headers: { 'X-RateLimit-Remaining': '400', 'X-RateLimit-Reset': '36000' },
    });
    const query = {
      query: 'Lieferweg 12, 55129 Mainz, Deutschland',
      limit: 5,
      locale: 'de' as const,
    };
    const minute = await expectRoutingError(gateway.geocode(query));
    expect(minute.kind).toBe('rate_limited');
    expect(minute.retryAfterMs).toBe(60_000);
    // Parallel wartende Aufrufer scheitern sofort – kein Schlafen bis zum Tagesreset.
    const startedAt = Date.now();
    const results = await Promise.all([
      gateway.geocode(query).catch((error: unknown) => error),
      gateway.matrix({ points: [DEPOT, CUSTOMER, THIRD] }).catch((error: unknown) => error),
    ]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    for (const result of results) {
      expect(result).toBeInstanceOf(RoutingError);
      expect((result as RoutingError).kind).toBe('rate_limited');
      expect((result as RoutingError).status).toBe(429);
      expect((result as RoutingError).retryAfterMs).toBe(60_000);
    }
    expect(minuteSleeps).toEqual([]);
    expect(fake.state.requests).toHaveLength(1);
    // Nach 60 s (nicht nach 10 h) läuft es weiter.
    clock += 60_001;
    await gateway.geocode(query);
    expect(fake.state.requests).toHaveLength(2);

    // Tageskontingent erschöpft ⇒ credit_limited bis zum Reset, Folge-Aufrufe sofort credit_limited.
    fake.state.failures.push({
      endpoint: 'route',
      times: 1,
      status: 429,
      headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '7200' },
    });
    const credits = await expectRoutingError(gateway.route({ points: [DEPOT, CUSTOMER] }));
    expect(credits.kind).toBe('credit_limited');
    expect(credits.retryAfterMs).toBe(7_200_000);
    clock += 3_600_000;
    const stillPaused = await expectRoutingError(gateway.route({ points: [DEPOT, CUSTOMER] }));
    expect(stillPaused.kind).toBe('credit_limited');
    expect(stillPaused.transient).toBe(false);
    expect(stillPaused.retryAfterMs).toBe(3_600_000);
    expect(minuteSleeps).toEqual([]);
    expect(fake.state.requests).toHaveLength(3);
    clock += 3_600_001;
    await gateway.route({ points: [DEPOT, CUSTOMER] });
    expect(fake.state.requests).toHaveLength(4);

    // 429 ohne jeden Rate-Limit-Header ⇒ konservative Pause 60 s (Default), fail-fast.
    const bare = new GraphHopperRoutingGateway({
      apiKey: SYNTH_KEY,
      baseUrl: 'http://127.0.0.1:1/api/1',
      timeoutMs: 1000,
      limiter: limiterFor({ now: () => clock, sleep: async (ms) => void minuteSleeps.push(ms) }),
      now: () => clock,
      fetchImpl: async () => new Response('{"message":"limit"}', { status: 429 }),
    });
    const noHeader = await expectRoutingError(bare.route({ points: [DEPOT, CUSTOMER] }));
    expect(noHeader.kind).toBe('rate_limited');
    expect(noHeader.retryAfterMs).toBe(60_000);
    clock += 30_000;
    const noHeaderAgain = await expectRoutingError(bare.route({ points: [DEPOT, CUSTOMER] }));
    expect(noHeaderAgain.retryAfterMs).toBe(30_000);
    expect(minuteSleeps).toEqual([]);
    for (const entry of logs) expect(JSON.stringify(entry)).not.toContain(SYNTH_KEY);
  });

  it('T13. Timeout ⇒ RoutingError timeout (transient), genau ein Request, kein eigener Retry', async () => {
    const gateway = gatewayFor({ timeoutMs: 150 });
    fake.state.failures.push({ endpoint: 'route', times: 1, mode: 'delay', delayMs: 600 });
    const startedAt = Date.now();
    const error = await expectRoutingError(gateway.route({ points: [DEPOT, CUSTOMER] }));
    expect(error.kind).toBe('timeout');
    expect(error.transient).toBe(true);
    expect(error.status).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(600);
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(fake.state.requests).toHaveLength(1);
    expect(logs.at(-1)!.obj).toMatchObject({
      routing: { endpoint: '/route', outcome: 'timeout', status: null },
    });

    // Netzwerkfehler (Port geschlossen) ⇒ network, transient.
    const closed = new GraphHopperRoutingGateway({
      apiKey: SYNTH_KEY,
      baseUrl: 'http://127.0.0.1:9/api/1',
      timeoutMs: 1000,
      limiter: limiterFor(),
      logger,
    });
    const network = await expectRoutingError(closed.route({ points: [DEPOT, CUSTOMER] }));
    expect(network.kind).toBe('network');
    expect(network.transient).toBe(true);
    expect(String(network)).not.toContain('127.0.0.1:9');
  });

  it('N1. Limiter wirft selbst (DB-Fehler) ⇒ RoutingError network (transient), kein Provider-Request, Log neutral ohne Key/URL/Fehlertext', async () => {
    const failing = {
      provider: 'graphhopper',
      reserveSlot: async () => {
        throw new Error('connect ECONNREFUSED postgresql://db:5432/mietroyal SECRET-DB-PW');
      },
      acquire: async () => {
        throw new Error('connect ECONNREFUSED postgresql://db:5432/mietroyal SECRET-DB-PW');
      },
      pause: async () => undefined,
    };
    const gateway = new GraphHopperRoutingGateway({
      apiKey: SYNTH_KEY,
      baseUrl: fake.baseUrl,
      timeoutMs: 1000,
      logger,
      limiter: failing,
    });
    const error = await expectRoutingError(gateway.route({ points: [DEPOT, CUSTOMER] }));
    expect(error.kind).toBe('network');
    expect(error.code).toBe('ROUTING_NETWORK');
    expect(error.transient).toBe(true);
    expect(error.status).toBeNull();
    expect(String(error)).not.toContain('SECRET-DB-PW');
    expect(fake.state.requests).toHaveLength(0);
    expect(logs.some((entry) => /Drossel/.test(entry.msg))).toBe(true);
    expect(logs.at(-1)!.obj).toMatchObject({
      routing: { endpoint: '/route', outcome: 'network', status: null },
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(SYNTH_KEY);
    expect(serialized).not.toContain('SECRET-DB-PW');
    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain(fake.baseUrl);
    // Ein RoutingError des Limiters (z. B. Pause) bleibt unverändert.
    const pausing = {
      ...failing,
      acquire: async () => {
        throw new RoutingError('credit_limited', 429, 1000);
      },
    };
    const paused = await expectRoutingError(
      new GraphHopperRoutingGateway({
        apiKey: SYNTH_KEY,
        baseUrl: fake.baseUrl,
        timeoutMs: 1000,
        logger,
        limiter: pausing,
      }).route({ points: [DEPOT, CUSTOMER] }),
    );
    expect(paused.kind).toBe('credit_limited');
    expect(fake.state.requests).toHaveLength(0);
  });

  it('T14. Malformed/unerwartete Antwort ⇒ invalid_response (fail-closed, permanent); kein Ergebnis wird erraten', async () => {
    const gateway = gatewayFor();
    fake.state.failures.push({ endpoint: 'geocode', times: 1, mode: 'invalid_json' });
    const broken = await expectRoutingError(
      gateway.geocode({ query: 'Lieferweg 12, 55129 Mainz, Deutschland', limit: 5, locale: 'de' }),
    );
    expect(broken.kind).toBe('invalid_response');
    expect(broken.transient).toBe(false);
    expect(broken.status).toBe(200);

    // Gültiges JSON, aber Pflichtfeld (point) fehlt ⇒ invalid_response.
    fake.state.geocode = () => [{ name: 'ohne point' } as unknown as GraphHopperFakeHit];
    const schema = await expectRoutingError(
      gateway.geocode({ query: 'Irgendwo 1, 55116 Mainz, Deutschland', limit: 5, locale: 'de' }),
    );
    expect(schema.kind).toBe('invalid_response');

    // Matrix mit falscher Dimension ⇒ invalid_response (keine halbe Matrix).
    fake.state.failures.push({
      endpoint: 'matrix',
      times: 1,
      status: 200,
      body: { times: [[0, 1]], distances: [[0, 1]] },
    });
    const matrix = await expectRoutingError(gateway.matrix({ points: [DEPOT, CUSTOMER, THIRD] }));
    expect(matrix.kind).toBe('invalid_response');
    expect(logs.filter((entry) => entry.obj.routing !== undefined).at(-1)!.obj).toMatchObject({
      routing: { endpoint: '/matrix', outcome: 'invalid_response' },
    });
  });

  it('T15. Provider down (5xx) ⇒ server_error transient mit genau EINEM Request (kein Retry-Sturm); 400 ⇒ validation, 404 ⇒ not_found (permanent)', async () => {
    const gateway = gatewayFor();
    fake.state.failures.push({ endpoint: 'all', times: 1, status: 500 });
    const down = await expectRoutingError(gateway.route({ points: [DEPOT, CUSTOMER] }));
    expect(down.kind).toBe('server_error');
    expect(down.transient).toBe(true);
    expect(fake.state.requests).toHaveLength(1);
    fake.state.failures.push({ endpoint: 'route', times: 1, status: 503 });
    expect((await expectRoutingError(gateway.route({ points: [DEPOT, CUSTOMER] }))).kind).toBe(
      'server_error',
    );
    // Nach der Störung funktioniert derselbe Client ohne Neustart weiter.
    const ok = await gateway.route({ points: [DEPOT, CUSTOMER] });
    expect(ok.distanceMeters).toBeGreaterThan(0);
    expect(ok.legs).toHaveLength(1);

    fake.state.failures.push({
      endpoint: 'route',
      times: 1,
      status: 400,
      body: { message: 'Cannot find point 0: 49.9,8.2', hints: [{ message: 'point 0' }] },
    });
    const validation = await expectRoutingError(gateway.route({ points: [DEPOT, CUSTOMER] }));
    expect(validation.kind).toBe('validation');
    expect(validation.transient).toBe(false);
    expect(String(validation)).not.toContain('Cannot find point');

    fake.state.failures.push({ endpoint: 'vrp', times: 1, status: 404 });
    const notFound = await expectRoutingError(
      gateway.optimizeTour({
        depot: DEPOT,
        earliestStart: new Date('2026-11-02T07:00:00Z'),
        stops: [{ id: 'stop-a', point: CUSTOMER, serviceSeconds: 900, timeWindow: null }],
        sequenceRelations: [],
      }),
    );
    expect(notFound.kind).toBe('not_found');
    expect(notFound.transient).toBe(false);
    expect(fake.state.requests.map((request) => request.status)).toEqual([500, 503, 200, 400, 404]);
  });

  it('T16. Datenminimierung: Request-Bodies enthalten nur Koordinaten, Zeitfenster, Dauern und anonyme IDs; Geocoding nur die Adresse; VRP nur dokumentierte Felder', async () => {
    const gateway = gatewayFor();
    const earliest = new Date('2026-11-02T07:00:00Z');
    const stopA = '11111111-1111-4111-8111-111111111111';
    const stopB = '22222222-2222-4222-8222-222222222222';
    await gateway.route({ points: [DEPOT, CUSTOMER, THIRD] });
    await gateway.matrix({ points: [DEPOT, CUSTOMER, THIRD] });
    await gateway.matrix({ points: [DEPOT, CUSTOMER] });
    const optimized = await gateway.optimizeTour({
      depot: DEPOT,
      earliestStart: earliest,
      stops: [
        {
          id: stopA,
          point: CUSTOMER,
          serviceSeconds: 900,
          timeWindow: {
            earliest: new Date('2026-11-02T08:00:00Z'),
            latest: new Date('2026-11-02T09:00:00Z'),
          },
        },
        { id: stopB, point: THIRD, serviceSeconds: 600, timeWindow: null },
      ],
      sequenceRelations: [[stopA, stopB]],
    });
    expect(optimized.visits.map((visit) => visit.stopId)).toEqual([stopA, stopB]);
    expect(optimized.unassigned).toEqual([]);
    expect(optimized.returnToDepotArrivalAt).not.toBeNull();
    expect(optimized.visits[0]!.arrivalAt.getTime()).toBeGreaterThanOrEqual(
      new Date('2026-11-02T08:00:00Z').getTime(),
    );

    // Route: ein POST je Abschnitt (2 Punkte = 1 Credit), nur dokumentierte Felder.
    const routeRequests = fake.state.requests.filter((request) => request.endpoint === 'route');
    expect(routeRequests).toHaveLength(2);
    for (const request of routeRequests) {
      expect(request.body).toEqual({
        points: expect.any(Array),
        profile: 'car',
        points_encoded: false,
        instructions: false,
        calc_points: false,
        elevation: false,
        locale: 'de',
      });
      expect((request.body as { points: [number, number][] }).points).toHaveLength(2);
    }
    expect((routeRequests[0]!.body as { points: [number, number][] }).points[0]).toEqual([
      DEPOT.longitude,
      DEPOT.latitude,
    ]);
    const [matrix3, matrix2] = fake.state.requests.filter(
      (request) => request.endpoint === 'matrix',
    );
    expect(matrix3!.body).toEqual({
      points: [
        [DEPOT.longitude, DEPOT.latitude],
        [CUSTOMER.longitude, CUSTOMER.latitude],
        [THIRD.longitude, THIRD.latitude],
      ],
      profile: 'car',
      out_arrays: ['times', 'distances'],
      fail_fast: false,
    });
    expect(Object.keys(matrix2!.body as object).sort()).toEqual([
      'fail_fast',
      'from_points',
      'out_arrays',
      'profile',
      'to_points',
    ]);
    const vrp = fake.state.requests.find((request) => request.endpoint === 'vrp')!;
    expect(vrp.body).toEqual({
      vehicles: [
        {
          vehicle_id: 'vehicle',
          type_id: 'car',
          start_address: { location_id: 'depot', lon: DEPOT.longitude, lat: DEPOT.latitude },
          return_to_depot: true,
          earliest_start: Math.floor(earliest.getTime() / 1000),
        },
      ],
      vehicle_types: [{ type_id: 'car', profile: 'car' }],
      services: [
        {
          id: stopA,
          address: { location_id: stopA, lon: CUSTOMER.longitude, lat: CUSTOMER.latitude },
          duration: 900,
          time_windows: [
            {
              earliest: Math.floor(new Date('2026-11-02T08:00:00Z').getTime() / 1000),
              latest: Math.floor(new Date('2026-11-02T09:00:00Z').getTime() / 1000),
            },
          ],
        },
        {
          id: stopB,
          address: { location_id: stopB, lon: THIRD.longitude, lat: THIRD.latitude },
          duration: 600,
        },
      ],
      relations: [{ type: 'in_sequence', ids: [stopA, stopB] }],
      objectives: [{ type: 'min', value: 'completion_time' }],
      configuration: { routing: { calc_points: false } },
    });
    // Keine Namen/Telefon/Vorgangsnummern/Preise in irgendeinem Request (Order §4/§20).
    const everything = JSON.stringify(fake.state.requests);
    for (const forbidden of ['Klara', 'Kommerz', '@', 'MR-20', 'Cents', 'name', 'phone', 'note']) {
      expect(everything).not.toContain(forbidden);
    }
    expect(everything).not.toContain(SYNTH_KEY);
  });

  it('Matrix: unerreichbare Paare bleiben null (fail_fast=false); VRP: Zeitfenster nicht einhaltbar ⇒ unassigned mit Code 2', async () => {
    const gateway = gatewayFor();
    fake.state.unreachablePairs.add('0,2');
    const matrix = await gateway.matrix({ points: [DEPOT, CUSTOMER, THIRD] });
    expect(matrix.durationsSeconds[0]![2]).toBeNull();
    expect(matrix.distancesMeters[0]![2]).toBeNull();
    expect(matrix.durationsSeconds[0]![0]).toBe(0);
    expect(matrix.durationsSeconds[0]![1]).toBeGreaterThan(0);
    expect(matrix.durationsSeconds).toHaveLength(3);

    const optimized = await gateway.optimizeTour({
      depot: DEPOT,
      earliestStart: new Date('2026-11-02T07:00:00Z'),
      stops: [
        {
          id: 'late',
          point: THIRD,
          serviceSeconds: 900,
          timeWindow: {
            earliest: new Date('2026-11-02T06:00:00Z'),
            latest: new Date('2026-11-02T06:01:00Z'),
          },
        },
        { id: 'free', point: CUSTOMER, serviceSeconds: 900, timeWindow: null },
      ],
      sequenceRelations: [],
    });
    expect(optimized.unassigned).toEqual([{ stopId: 'late', reasonCode: '2' }]);
    expect(optimized.visits.map((visit) => visit.stopId)).toEqual(['free']);
    expect(optimized.totalDistanceMeters).toBeGreaterThan(0);
  });

  it('Drossel: höchstens ein Request je Intervall – parallele Aufrufe werden serialisiert, kein Request-Sturm', async () => {
    const gateway = gatewayFor({ minIntervalMs: 150 });
    await Promise.all([
      gateway.route({ points: [DEPOT, CUSTOMER] }),
      gateway.route({ points: [DEPOT, THIRD] }),
      gateway.geocode({ query: 'Lieferweg 12, 55129 Mainz, Deutschland', limit: 5, locale: 'de' }),
    ]);
    const stamps = fake.state.requests.map((request) => request.at);
    expect(stamps).toHaveLength(3);
    for (let index = 1; index < stamps.length; index += 1) {
      expect(stamps[index]! - stamps[index - 1]!).toBeGreaterThanOrEqual(140);
    }
  });

  it('Fabrik: graphhopper nur mit Key und globaler Drossel (db|limiter), mock nie in production, disabled sonst; Start-Log nennt nur den Provider', async () => {
    const base = {
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_prod',
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: '/var/lib/mietroyal/prod',
      AUTH_SECRET_KEY: 'prod-auth-secret-key-0123456789abcdef',
      COMMUNICATION_PAYLOAD_KEY: 'prod-communication-payload-key-0123456789',
      // Phase 13 Final (§5, Agent OC): production + GraphHopper nur mit bestätigter Vertragsprüfung.
      ROUTING_PROVIDER_TERMS_CONFIRMED: 'true',
    };
    const disabled = createRoutingGateway(loadConfig(base), logger);
    expect(disabled.kind).toBe('disabled');
    await expect(disabled.route({ points: [DEPOT, CUSTOMER] })).rejects.toMatchObject({
      kind: 'disabled',
    });
    expect(logs.map((entry) => entry.msg)).toEqual([
      expect.stringContaining('Routing nicht konfiguriert'),
      'Routing: provider=disabled',
    ]);
    logs.length = 0;
    // Phase 13 Final (§1): ohne db/limiter verweigert die Fabrik den echten Provider
    // (nie eine nur prozesslokale Drossel im Betrieb).
    expect(() =>
      createRoutingGateway(loadConfig({ ...base, GRAPHHOPPER_API_KEY: SYNTH_KEY }), logger),
    ).toThrow(/globale Drossel/);
    logs.length = 0;
    const live = createRoutingGateway(
      loadConfig({ ...base, GRAPHHOPPER_API_KEY: SYNTH_KEY }),
      logger,
      { limiter: limiterFor() },
    );
    expect(live.kind).toBe('graphhopper');
    expect(live.providerName).toBe('graphhopper');
    expect(logs).toEqual([
      {
        level: 'info',
        obj: { routing: { provider: 'graphhopper' } },
        msg: 'Routing: provider=graphhopper',
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(SYNTH_KEY);
    // Mock in production: Konfiguration lehnt ab – und die Fabrik ebenfalls (zweite Sperre).
    expect(() =>
      createRoutingGateway(
        { appEnv: 'production', routing: loadConfig({ APP_ENV: 'development' }).routing },
        logger,
      ),
    ).toThrow(/production/);
    expect(createRoutingGateway(loadConfig({ APP_ENV: 'development' })).kind).toBe('mock');
    // development mit Opt-in gegen den Fake-Server ⇒ echter Client, Requests laufen gegen den Fake.
    const dev = createRoutingGateway(
      loadConfig({
        APP_ENV: 'development',
        ROUTING_ENABLED: 'true',
        ROUTING_PROVIDER: 'graphhopper',
        GRAPHHOPPER_API_KEY: SYNTH_KEY,
        GRAPHHOPPER_BASE_URL: fake.baseUrl,
      }),
      undefined,
      { limiter: limiterFor() },
    );
    expect(dev.kind).toBe('graphhopper');
    const hits = await dev.geocode({
      query: 'Robert-Koch-Straße 1, 55129 Mainz, Deutschland',
      limit: 5,
      locale: 'de',
    });
    expect(hits.candidates[0]!.ref).toBe(
      `osm:${FAKE_HITS.depot.osm_type}${FAKE_HITS.depot.osm_id}`,
    );
    expect(fake.state.requests.at(-1)!.keyValid).toBe(true);
  });
});
