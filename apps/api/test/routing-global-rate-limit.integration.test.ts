/**
 * Phase 13 Final (§1, Tests G1–G12): globale, prozessübergreifende
 * GraphHopper-Drossel in `integration_rate_limits` (provider 'graphhopper').
 * Zwei Gateway-Instanzen mit eigenem Limiter-Objekt (und eigenem Pool =
 * „zwei Prozesse“) auf derselben Datenbank gegen den Contract-Fake; Zeitmessung
 * über die vom Fake aufgezeichneten Request-Zeitpunkte (`state.requests[].at`)
 * bzw. den instrumentierten Sleep-Hook. Kein echter Provider.
 */
import { createDb, createPool, type Database } from '@mietroyal/database';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PostgresIntegrationRateLimiter,
  type IntegrationRateLimiter,
} from '../src/integrations/rate-limiter.ts';
import { createRoutingGateway, GRAPHHOPPER_RATE_LIMIT_PROVIDER } from '../src/routing/factory.ts';
import {
  GRAPHHOPPER_MIN_INTERVAL_MS,
  GraphHopperRoutingGateway,
  type GraphHopperGatewayOptions,
} from '../src/routing/graphhopper.ts';
import {
  startGraphHopperFakeServer,
  type GraphHopperFakeServer,
} from '../src/routing/testing/fake-server.ts';
import { RoutingError } from '../src/routing/types.ts';
import {
  createTestContext,
  destroyTestContext,
  TEST_DATABASE_URL,
  type TestContext,
} from './auth-helpers.ts';

const SYNTH_KEY = 'SYNTH-graphhopper-global-key-0123456789-never-real';
const DEPOT = { latitude: 49.9545, longitude: 8.2735 };
const CUSTOMER = { latitude: 49.9742, longitude: 8.2566 };
const THIRD = { latitude: 50.0011, longitude: 8.2588 };
/** Toleranz für Timer-/Commit-Latenz (Slots werden mit der DB-Uhr berechnet, Requests mit Date.now gemessen). */
const TOL_MS = 60;

/**
 * G6 braucht eine ZWEITE Datenbank („andere Umgebung“ – jede Umgebung hat ihre
 * eigene DB). Default: mietroyal_test7 neben der Test-DB; per
 * TEST_DATABASE_URL_SECOND übersteuerbar. Dort wird ausschließlich die Zeile
 * provider 'graphhopper' angefasst und wieder entfernt.
 */
const SECOND_DATABASE_URL =
  process.env.TEST_DATABASE_URL_SECOND ??
  TEST_DATABASE_URL.replace(/\/[^/?]+(\?.*)?$/, '/mietroyal_test7$1');

async function probeSecondDatabase(): Promise<boolean> {
  if (SECOND_DATABASE_URL === TEST_DATABASE_URL) return false;
  const pool = new pg.Pool({ connectionString: SECOND_DATABASE_URL, max: 1 });
  try {
    const result = await pool.query<{ t: string | null }>(
      `SELECT to_regclass('integration_rate_limits')::text AS t`,
    );
    return result.rows[0]?.t !== null;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

const secondDatabaseAvailable = await probeSecondDatabase();

let ctx: TestContext;
let fake: GraphHopperFakeServer;
/** „Zweiter Prozess“: eigener Pool auf derselben Datenbank. */
let poolB: pg.Pool;
let dbB: Database;
const logs: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
const logger = {
  info: (obj: Record<string, unknown>, msg: string) => logs.push({ level: 'info', obj, msg }),
  warn: (obj: Record<string, unknown>, msg: string) => logs.push({ level: 'warn', obj, msg }),
};

function limiterOn(
  db: Database,
  overrides: {
    intervalMs?: number;
    environment?: string;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): PostgresIntegrationRateLimiter {
  return new PostgresIntegrationRateLimiter(db, {
    provider: GRAPHHOPPER_RATE_LIMIT_PROVIDER,
    environment: overrides.environment ?? ctx.config.appEnv,
    intervalMs: overrides.intervalMs ?? 300,
    ...(overrides.sleep === undefined ? {} : { sleep: overrides.sleep }),
  });
}

function gatewayWith(
  limiter: IntegrationRateLimiter,
  overrides: Partial<GraphHopperGatewayOptions> = {},
): GraphHopperRoutingGateway {
  return new GraphHopperRoutingGateway({
    apiKey: SYNTH_KEY,
    baseUrl: fake.baseUrl,
    timeoutMs: 2000,
    logger,
    limiter,
    ...overrides,
  });
}

const route = (gateway: GraphHopperRoutingGateway) => gateway.route({ points: [DEPOT, CUSTOMER] });
const GEOCODE = {
  query: 'Lieferweg 12, 55129 Mainz, Deutschland',
  limit: 5,
  locale: 'de' as const,
};

async function expectRoutingError(promise: Promise<unknown>): Promise<RoutingError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RoutingError);
    return error as RoutingError;
  }
  throw new Error('RoutingError erwartet');
}

/** Zeitabstände der aufgezeichneten Provider-Requests (sortiert). */
function requestGaps(): number[] {
  const stamps = fake.state.requests.map((request) => request.at).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let index = 1; index < stamps.length; index += 1)
    gaps.push(stamps[index]! - stamps[index - 1]!);
  return gaps;
}

interface LimiterRow {
  provider: string;
  environment: string;
  next_slot_ms: string;
  paused_until_ms: string | null;
  pause_kind: string | null;
}

async function limiterRow(pool: pg.Pool = ctx.pool): Promise<LimiterRow | null> {
  const result = await pool.query<LimiterRow>(
    `SELECT provider, environment,
            (EXTRACT(EPOCH FROM next_slot_at) * 1000)::bigint::text AS next_slot_ms,
            (EXTRACT(EPOCH FROM paused_until) * 1000)::bigint::text AS paused_until_ms,
            pause_kind
       FROM integration_rate_limits WHERE provider = $1`,
    [GRAPHHOPPER_RATE_LIMIT_PROVIDER],
  );
  return result.rows[0] ?? null;
}

/** Beweis „keine DB-Sperre“: keine Sitzung ‚idle in transaction‘ und die Zeile ist sofort sperrbar. */
async function assertNoOpenTransaction(pool: pg.Pool = ctx.pool): Promise<void> {
  const idle = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'idle in transaction'`,
  );
  expect(idle.rows[0]!.n).toBe(0);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      `SELECT provider FROM integration_rate_limits WHERE provider = $1 FOR UPDATE NOWAIT`,
      [GRAPHHOPPER_RATE_LIMIT_PROVIDER],
    );
    expect(locked.rowCount).toBe(1);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  fake = await startGraphHopperFakeServer({ apiKey: SYNTH_KEY });
  ctx = await createTestContext({
    env: {
      ROUTING_ENABLED: 'true',
      ROUTING_PROVIDER: 'graphhopper',
      GRAPHHOPPER_API_KEY: SYNTH_KEY,
      GRAPHHOPPER_BASE_URL: fake.baseUrl,
      ROUTING_REQUEST_TIMEOUT_MS: '2000',
    },
  });
  poolB = createPool(ctx.config.databaseUrl, { max: 2 });
  dbB = createDb(poolB);
});
afterAll(async () => {
  await poolB.end();
  await destroyTestContext(ctx);
  await fake.stop();
});
beforeEach(async () => {
  await ctx.pool.query(`DELETE FROM integration_rate_limits WHERE provider = $1`, [
    GRAPHHOPPER_RATE_LIMIT_PROVIDER,
  ]);
  fake.state.reset();
  logs.length = 0;
});

describe('Globale GraphHopper-Drossel (Phase 13 Final §1)', () => {
  it('G1. Zwei parallele Gateway-Instanzen (eigene Limiter-Objekte, dieselbe DB) teilen denselben globalen Slot', async () => {
    const intervalMs = 400;
    const a = gatewayWith(limiterOn(ctx.db, { intervalMs }));
    const b = gatewayWith(limiterOn(ctx.db, { intervalMs }));
    const started = Date.now();
    const results = await Promise.all([route(a), route(b), route(a), route(b)]);
    for (const result of results) expect(result.legs).toHaveLength(1);
    expect(fake.state.requests).toHaveLength(4);
    for (const gap of requestGaps()) expect(gap).toBeGreaterThanOrEqual(intervalMs - TOL_MS);
    const last = Math.max(...fake.state.requests.map((request) => request.at));
    expect(last).toBeGreaterThanOrEqual(started + 3 * intervalMs - TOL_MS);
    const row = await limiterRow();
    expect(row).not.toBeNull();
    expect(Number(row!.next_slot_ms)).toBeGreaterThanOrEqual(started + 4 * intervalMs - TOL_MS);
    expect(row!.paused_until_ms).toBeNull();
    expect(row!.pause_kind).toBeNull();
    expect(row!.environment).toBe(ctx.config.appEnv);
  });

  it('G2. API + Worker gleichzeitig (Fabrik, zwei Pools) ⇒ global nie mehr als 1 Request/s je Umgebung', async () => {
    expect(GRAPHHOPPER_MIN_INTERVAL_MS).toBe(1000);
    const api = createRoutingGateway(ctx.config, logger, { db: ctx.db });
    const worker = createRoutingGateway(ctx.config, logger, { db: dbB });
    expect(api.kind).toBe('graphhopper');
    expect(worker.kind).toBe('graphhopper');
    const started = Date.now();
    await Promise.all([
      api.route({ points: [DEPOT, CUSTOMER] }),
      worker.geocode(GEOCODE),
      api.matrix({ points: [DEPOT, CUSTOMER, THIRD] }),
      worker.route({ points: [DEPOT, THIRD] }),
    ]);
    expect(fake.state.requests).toHaveLength(4);
    // In keinem gleitenden 1-s-Fenster mehr als ein Request – prozessübergreifend.
    for (const gap of requestGaps())
      expect(gap).toBeGreaterThanOrEqual(GRAPHHOPPER_MIN_INTERVAL_MS - TOL_MS);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3 * GRAPHHOPPER_MIN_INTERVAL_MS - TOL_MS);
    const row = await limiterRow();
    expect(row!.environment).toBe(ctx.config.appEnv);
  }, 20_000);

  it('G3. Zwei API-Instanzen (getrennte Pools) werden global serialisiert – jede sieht die Reservierung der anderen', async () => {
    const intervalMs = 300;
    const limiterA = limiterOn(ctx.db, { intervalMs });
    const limiterB = limiterOn(dbB, { intervalMs });
    const first = await limiterA.reserveSlot();
    const second = await limiterB.reserveSlot();
    const third = await limiterA.reserveSlot();
    expect(first).toEqual({ waitMs: 0, paused: null });
    expect(second.waitMs).toBeGreaterThanOrEqual(intervalMs - TOL_MS);
    expect(second.waitMs).toBeLessThanOrEqual(intervalMs);
    expect(third.waitMs).toBeGreaterThanOrEqual(2 * intervalMs - TOL_MS);
    // Parallel aus beiden „Prozessen“: alle Wartezeiten paarweise ≥ Intervall auseinander.
    const waits = await Promise.all([
      limiterA.reserveSlot(),
      limiterB.reserveSlot(),
      limiterA.reserveSlot(),
      limiterB.reserveSlot(),
    ]);
    const startedAt = Date.now();
    const sorted = waits
      .map((wait) => wait.waitMs)
      .filter((wait): wait is number => wait !== null)
      .sort((x, y) => x - y);
    expect(sorted).toHaveLength(4);
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index]! - sorted[index - 1]!).toBeGreaterThanOrEqual(
        intervalMs - (Date.now() - startedAt) - TOL_MS,
      );
    }
    // Und über die Gateways: Requests beider Instanzen bleiben global im Abstand.
    await ctx.pool.query(`DELETE FROM integration_rate_limits WHERE provider = $1`, [
      GRAPHHOPPER_RATE_LIMIT_PROVIDER,
    ]);
    const a = gatewayWith(limiterA);
    const b = gatewayWith(limiterB);
    await Promise.all([route(a), route(b), a.geocode(GEOCODE), b.geocode(GEOCODE)]);
    expect(fake.state.requests).toHaveLength(4);
    for (const gap of requestGaps()) expect(gap).toBeGreaterThanOrEqual(intervalMs - TOL_MS);
  });

  it('G4. 429 in Instanz A ⇒ Instanz B (eigener Limiter, eigener Pool) sieht die Pause sofort – fail-fast ohne Provider-Request; Pause wird nur verlängert, nie verkürzt', async () => {
    const a = gatewayWith(limiterOn(ctx.db));
    fake.state.failures.push({
      endpoint: 'route',
      times: 1,
      status: 429,
      headers: { 'X-RateLimit-Remaining': '120', 'X-RateLimit-Reset': '30' },
    });
    const limited = await expectRoutingError(route(a));
    expect(limited.kind).toBe('rate_limited');
    expect(limited.retryAfterMs).toBe(30_000);
    expect(fake.state.requests).toHaveLength(1);
    const row = await limiterRow();
    expect(row!.pause_kind).toBe('rate_limited');
    expect(Number(row!.paused_until_ms)).toBeGreaterThanOrEqual(Date.now() + 30_000 - 1_000);

    const sleepsB: number[] = [];
    const limiterB = limiterOn(dbB, { sleep: async (ms) => void sleepsB.push(ms) });
    const b = gatewayWith(limiterB);
    const startedAt = Date.now();
    const paused = await expectRoutingError(route(b));
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(paused.kind).toBe('rate_limited');
    expect(paused.status).toBe(429);
    expect(paused.transient).toBe(true);
    expect(paused.retryAfterMs).toBeGreaterThan(28_000);
    expect(paused.retryAfterMs).toBeLessThanOrEqual(30_000);
    expect(sleepsB).toEqual([]);
    expect(fake.state.requests).toHaveLength(1);
    expect(logs.at(-1)!.obj).toMatchObject({
      routing: { endpoint: '/route', outcome: 'rate_limited', status: null },
    });
    // Auch das Geocoding/Matrix der anderen Instanz scheitert sofort (kein Warten bis zum Reset).
    expect((await expectRoutingError(b.geocode(GEOCODE))).kind).toBe('rate_limited');
    expect(fake.state.requests).toHaveLength(1);

    // Nur verlängern: eine kürzere Pause ändert die Zeile nicht …
    await limiterB.pause(new Date(Date.now() + 5_000), 'rate_limited');
    expect((await limiterRow())!.paused_until_ms).toBe(row!.paused_until_ms);
    // … eine längere (credit_limited) ersetzt sie samt Art.
    await limiterB.pause(new Date(Date.now() + 3_600_000), 'credit_limited');
    const extended = await limiterRow();
    expect(extended!.pause_kind).toBe('credit_limited');
    expect(Number(extended!.paused_until_ms)).toBeGreaterThan(Number(row!.paused_until_ms));
    const reserved = await limiterB.reserveSlot();
    expect(reserved.paused?.kind).toBe('credit_limited');
  });

  it('G5. credit_limited in der API ⇒ Worker (Fabrik, eigener Pool) scheitert sofort credit_limited – kein Warten bis zum Tagesreset', async () => {
    const api = createRoutingGateway(ctx.config, logger, { db: ctx.db });
    fake.state.failures.push({
      endpoint: 'matrix',
      times: 1,
      status: 429,
      headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '7200' },
    });
    const exhausted = await expectRoutingError(api.matrix({ points: [DEPOT, CUSTOMER, THIRD] }));
    expect(exhausted.kind).toBe('credit_limited');
    expect(exhausted.retryAfterMs).toBe(7_200_000);
    expect(exhausted.transient).toBe(false);

    const worker = createRoutingGateway(ctx.config, logger, { db: dbB });
    const startedAt = Date.now();
    const failFast = await expectRoutingError(worker.matrix({ points: [DEPOT, CUSTOMER, THIRD] }));
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(failFast.kind).toBe('credit_limited');
    expect(failFast.status).toBe(429);
    expect(failFast.transient).toBe(false);
    expect(failFast.retryAfterMs).toBeGreaterThan(7_190_000);
    expect(failFast.retryAfterMs).toBeLessThanOrEqual(7_200_000);
    expect(fake.state.requests).toHaveLength(1);
    const row = await limiterRow();
    expect(row!.pause_kind).toBe('credit_limited');
    expect(Number(row!.paused_until_ms)).toBeGreaterThanOrEqual(Date.now() + 7_190_000);
  });

  it.skipIf(!secondDatabaseAvailable)(
    'G6. Unterschiedliche Umgebungen (eigene Datenbanken) beeinflussen sich nicht – weder Slots noch Pausen',
    async () => {
      const pool2 = new pg.Pool({ connectionString: SECOND_DATABASE_URL, max: 2 });
      const clean = () =>
        pool2.query(`DELETE FROM integration_rate_limits WHERE provider = $1`, [
          GRAPHHOPPER_RATE_LIMIT_PROVIDER,
        ]);
      try {
        await clean();
        const intervalMs = 500;
        const limiterOne = limiterOn(ctx.db, { intervalMs, environment: 'development' });
        const limiterTwo = limiterOn(createDb(pool2), { intervalMs, environment: 'staging' });
        expect((await limiterOne.reserveSlot()).waitMs).toBe(0);
        expect((await limiterOne.reserveSlot()).waitMs).toBeGreaterThanOrEqual(intervalMs - TOL_MS);
        expect((await limiterOne.reserveSlot()).waitMs).toBeGreaterThanOrEqual(
          2 * intervalMs - TOL_MS,
        );
        // Die andere Umgebung ist unbelastet.
        expect((await limiterTwo.reserveSlot()).waitMs).toBe(0);
        // Pause in Umgebung 1 ⇒ Umgebung 2 läuft weiter.
        await limiterOne.pause(new Date(Date.now() + 3_600_000), 'credit_limited');
        expect((await limiterOne.reserveSlot()).paused?.kind).toBe('credit_limited');
        const two = await limiterTwo.reserveSlot();
        expect(two.paused).toBeNull();
        const gatewayOne = gatewayWith(limiterOne);
        const gatewayTwo = gatewayWith(limiterTwo);
        expect((await expectRoutingError(route(gatewayOne))).kind).toBe('credit_limited');
        expect((await route(gatewayTwo)).legs).toHaveLength(1);
        expect(fake.state.requests).toHaveLength(1);
        expect((await limiterRow())!.environment).toBe('development');
        expect((await limiterRow(pool2))!.environment).toBe('staging');
        expect((await limiterRow(pool2))!.pause_kind).toBeNull();
      } finally {
        await clean().catch(() => undefined);
        await pool2.end();
      }
    },
  );

  it('G7. Die Reservierungs-Transaktion ist VOR dem Warten geschlossen (keine „idle in transaction“, Zeile sperrbar, Slot bereits committed)', async () => {
    const single = createPool(ctx.config.databaseUrl, { max: 1 });
    try {
      const intervalMs = 400;
      const probes: { committedSlotMs: number; sleptMs: number }[] = [];
      const limiter = limiterOn(createDb(single), {
        intervalMs,
        sleep: async (ms) => {
          // Während des Wartens: keine offene Transaktion, Zeile frei, Reservierung sichtbar.
          await assertNoOpenTransaction();
          const row = await limiterRow();
          probes.push({ committedSlotMs: Number(row!.next_slot_ms), sleptMs: ms });
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
      });
      const gateway = gatewayWith(limiter);
      const started = Date.now();
      await route(gateway); // Slot 1 sofort
      await route(gateway); // Slot 2: wartet ≈ Intervall
      expect(probes).toHaveLength(1);
      expect(probes[0]!.sleptMs).toBeGreaterThanOrEqual(intervalMs - TOL_MS);
      // Der Slot war beim Warten bereits committed (≥ 2 Intervalle nach Start reserviert).
      expect(probes[0]!.committedSlotMs).toBeGreaterThanOrEqual(started + 2 * intervalMs - TOL_MS);
      expect(fake.state.requests).toHaveLength(2);
      expect(requestGaps()[0]).toBeGreaterThanOrEqual(intervalMs - TOL_MS);
    } finally {
      await single.end();
    }
  });

  it('G8. Die Transaktion ist VOR dem HTTP-Request geschlossen – während eines langsamen Provider-Responses hält niemand Zeile oder Verbindung', async () => {
    const single = createPool(ctx.config.databaseUrl, { max: 1 });
    try {
      const gateway = gatewayWith(limiterOn(createDb(single), { intervalMs: 0 }));
      fake.state.failures.push({ endpoint: 'route', times: 1, mode: 'delay', delayMs: 500 });
      const pending = route(gateway);
      // Warten, bis der Request beim Fake liegt (Antwort steht noch aus).
      const deadline = Date.now() + 1_000;
      while (fake.state.requests.length === 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fake.state.requests).toHaveLength(1);
      expect(fake.state.requests[0]!.status).toBe(0);
      await assertNoOpenTransaction();
      // Die EINZIGE Verbindung des Limiter-Pools ist frei (sonst hinge diese Abfrage bis zur Antwort).
      const probeStart = Date.now();
      await single.query('SELECT 1');
      expect(Date.now() - probeStart).toBeLessThan(200);
      const result = await pending;
      expect(result.legs).toHaveLength(1);
      expect(fake.state.requests[0]!.status).toBe(200);
    } finally {
      await single.end();
    }
  });

  it('G9. Providerfehler (5xx, Timeout) geben den Slot nicht rückwirkend frei – der nächste Request wartet das volle Intervall', async () => {
    const intervalMs = 400;
    const a = gatewayWith(limiterOn(ctx.db, { intervalMs }));
    const b = gatewayWith(limiterOn(dbB, { intervalMs }));
    fake.state.failures.push({ endpoint: 'route', times: 1, status: 500 });
    const failed = await expectRoutingError(route(a));
    expect(failed.kind).toBe('server_error');
    const failedAt = fake.state.requests[0]!.at;
    const rowAfterFailure = await limiterRow();
    expect(Number(rowAfterFailure!.next_slot_ms)).toBeGreaterThanOrEqual(
      failedAt + intervalMs - TOL_MS,
    );
    // Der nächste Request (anderer Prozess) wartet trotz Fehler das volle Intervall.
    await route(b);
    expect(fake.state.requests[1]!.at - failedAt).toBeGreaterThanOrEqual(intervalMs - TOL_MS);

    // Timeout: Request wurde gesendet ⇒ Slot bleibt verbraucht.
    const slow = gatewayWith(limiterOn(ctx.db, { intervalMs }), { timeoutMs: 150 });
    fake.state.failures.push({ endpoint: 'route', times: 1, mode: 'delay', delayMs: 600 });
    expect((await expectRoutingError(route(slow))).kind).toBe('timeout');
    const timedOutAt = fake.state.requests[2]!.at;
    await Promise.all([route(a), route(b)]);
    const stamps = fake.state.requests.slice(3).map((request) => request.at);
    expect(stamps).toHaveLength(2);
    expect(Math.min(...stamps) - timedOutAt).toBeGreaterThanOrEqual(intervalMs - TOL_MS);
    for (const gap of requestGaps()) expect(gap).toBeGreaterThanOrEqual(intervalMs - TOL_MS);
    await new Promise((resolve) => setTimeout(resolve, 500)); // verzögerte Fake-Antwort abwarten
  });

  it('G10. Neustart verliert den Pausezustand nicht – ein neues Limiter-Objekt (neuer Pool) sieht die persistierte Pause; abgelaufene Pausen werden beim Reservieren gelöscht', async () => {
    const a = gatewayWith(limiterOn(ctx.db));
    fake.state.failures.push({
      endpoint: 'geocode',
      times: 1,
      status: 429,
      headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '7200' },
    });
    expect((await expectRoutingError(a.geocode(GEOCODE))).kind).toBe('credit_limited');

    // „Neustart“: neuer Pool, neues Limiter-Objekt, kein Prozessgedächtnis.
    const restarted = createPool(ctx.config.databaseUrl, { max: 1 });
    try {
      const limiter = limiterOn(createDb(restarted));
      const reserved = await limiter.reserveSlot();
      expect(reserved.waitMs).toBeNull();
      expect(reserved.paused?.kind).toBe('credit_limited');
      expect(reserved.paused!.remainingMs).toBeGreaterThan(7_190_000);
      expect(reserved.paused!.until.getTime()).toBeGreaterThanOrEqual(Date.now() + 7_190_000);
      const gateway = gatewayWith(limiter);
      const failFast = await expectRoutingError(route(gateway));
      expect(failFast.kind).toBe('credit_limited');
      expect(failFast.status).toBe(429);
      expect(fake.state.requests).toHaveLength(1);

      // Pause abgelaufen (Reset erreicht) ⇒ nächste Reservierung räumt sie auf und läuft normal.
      await ctx.pool.query(
        `UPDATE integration_rate_limits SET paused_until = now() - interval '1 second' WHERE provider = $1`,
        [GRAPHHOPPER_RATE_LIMIT_PROVIDER],
      );
      const after = await limiter.reserveSlot();
      expect(after.paused).toBeNull();
      // Der Slot des 429-Requests bleibt reserviert (G9) – höchstens ein Intervall Wartezeit.
      expect(after.waitMs).toBeLessThanOrEqual(300);
      const row = await limiterRow();
      expect(row!.paused_until_ms).toBeNull();
      expect(row!.pause_kind).toBeNull();
      await route(gateway);
      expect(fake.state.requests).toHaveLength(2);
    } finally {
      await restarted.end();
    }
  });

  it('G11. Kein Key, keine URL, kein Request-Inhalt im Limiter – weder in der Zeile noch im Limiter-Objekt noch in Logs', async () => {
    const limiter = limiterOn(ctx.db, { intervalMs: 0 });
    const gateway = gatewayWith(limiter);
    await gateway.geocode(GEOCODE);
    fake.state.failures.push({
      endpoint: 'route',
      times: 1,
      status: 429,
      headers: { 'X-RateLimit-Remaining': '10', 'X-RateLimit-Reset': '20' },
    });
    await expectRoutingError(route(gateway));
    const row = await ctx.pool.query<{ json: string }>(
      `SELECT row_to_json(r)::text AS json FROM integration_rate_limits r WHERE provider = $1`,
      [GRAPHHOPPER_RATE_LIMIT_PROVIDER],
    );
    const text = row.rows[0]!.json;
    for (const forbidden of [SYNTH_KEY, fake.baseUrl, 'key=', 'http', 'Lieferweg', GEOCODE.query])
      expect(text).not.toContain(forbidden);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      'environment',
      'next_slot_at',
      'pause_kind',
      'paused_until',
      'provider',
      'updated_at',
    ]);
    // Das Limiter-Objekt kennt nur Provider/Umgebung/Intervall – keinen Key, keine URL.
    const ownState = JSON.stringify(
      Object.fromEntries(Object.entries(limiter).filter(([name]) => name !== 'db')),
    );
    expect(ownState).not.toContain(SYNTH_KEY);
    expect(ownState).not.toContain(fake.baseUrl);
    expect(limiter.provider).toBe('graphhopper');
    for (const entry of logs) {
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(SYNTH_KEY);
      expect(serialized).not.toContain(fake.baseUrl);
      expect(serialized).not.toContain('key=');
    }
  });

  it('G12. Bestehende Contract-Flows laufen mit der globalen Drossel unverändert (Geocode/Route/Matrix/VRP, 401, invalid_response)', async () => {
    const gateway = gatewayWith(limiterOn(ctx.db, { intervalMs: 0 }));
    const geocoded = await gateway.geocode(GEOCODE);
    expect(geocoded.candidates).toHaveLength(1);
    expect(geocoded.candidates[0]).toMatchObject({ ref: 'osm:W100002', postcode: '55129' });
    const routed = await gateway.route({ points: [DEPOT, CUSTOMER, THIRD] });
    expect(routed.legs).toHaveLength(2);
    expect(routed.distanceMeters).toBeGreaterThan(0);
    const matrix = await gateway.matrix({ points: [DEPOT, CUSTOMER, THIRD] });
    expect(matrix.durationsSeconds).toHaveLength(3);
    expect(matrix.durationsSeconds[0]![1]).toBeGreaterThan(0);
    const optimized = await gateway.optimizeTour({
      depot: DEPOT,
      earliestStart: new Date('2026-11-02T07:00:00Z'),
      stops: [
        { id: 'stop-a', point: CUSTOMER, serviceSeconds: 900, timeWindow: null },
        { id: 'stop-b', point: THIRD, serviceSeconds: 600, timeWindow: null },
      ],
      sequenceRelations: [],
    });
    expect(optimized.visits.map((visit) => visit.stopId).sort()).toEqual(['stop-a', 'stop-b']);
    expect(optimized.unassigned).toEqual([]);
    const wrongKey = gatewayWith(limiterOn(dbB, { intervalMs: 0 }), { apiKey: 'SYNTH-wrong' });
    const auth = await expectRoutingError(route(wrongKey));
    expect(auth.kind).toBe('auth_invalid');
    expect(auth.status).toBe(401);
    fake.state.failures.push({ endpoint: 'geocode', times: 1, mode: 'invalid_json' });
    expect((await expectRoutingError(gateway.geocode(GEOCODE))).kind).toBe('invalid_response');
    // Requests tragen den Key nur als Query – und nie in Logs.
    expect(fake.state.requests.every((request) => request.keyPresent)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(SYNTH_KEY);
    expect(JSON.stringify(fake.state.requests)).not.toContain(SYNTH_KEY);
  });
});
