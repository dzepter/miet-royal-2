/**
 * Phase 16 (REVIEWS, Order §18/§21/§25/§28, Design §1.5/§4/§11.2.6/§11.3):
 * `GET /public/reviews` hinter der ReviewGateway-Grenze – mit API + Datenbank, Google nur als
 * lokaler Contract-Fake (kein echter Google-Aufruf).
 *
 * disabled ⇒ 404 + `reviews.mode: 'disabled'`; demo fake ⇒ DEMO-Attribution, nie „Google“;
 * production/staging fake bzw. demo google ⇒ Startfehler; Provider-Ausfall/Timeout/429 ⇒ 503
 * neutral, Website bleibt verfügbar; Google-DTO mit Pflicht-Attribution; kein Cache (zwei
 * Abrufe ⇒ zwei Requests); nichts in der DB; Tagesgrenze GLOBAL über zwei „Prozesse“; Key nie
 * im Log; Cross-Site ⇒ 403; 10/min je IP; keine CORS-Header. Namen „RV<n>.“.
 */
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { createDb, createPool, type Database } from '@mietroyal/database';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GOOGLE_REVIEWS_RATE_LIMIT_PROVIDER, ReviewRequestBudget } from '../src/reviews/budget.ts';
import { FakeReviewGateway } from '../src/reviews/fake.ts';
import { GoogleReviewGateway } from '../src/reviews/google.ts';
import {
  defaultPlacesFakeBody,
  PLACES_FAKE_DEFAULT_PLACE_ID,
  startPlacesFakeServer,
  type PlacesFakeServer,
} from '../src/reviews/testing/fake-places-server.ts';
import type { ReviewGateway } from '../src/reviews/types.ts';
import {
  createTestContext,
  destroyTestContext,
  TEST_DATABASE_URL,
  type TestContext,
} from './auth-helpers.ts';
import { buildEnvApp, createEnvApp } from './env-app-helpers.ts';

const SYNTH_KEY = 'SYNTH-places-integration-key-0123456789-never-real';
const GOOGLE_ENV = {
  REVIEWS_PROVIDER: 'google',
  GOOGLE_PLACES_API_KEY: SYNTH_KEY,
  GOOGLE_PLACE_ID: PLACES_FAKE_DEFAULT_PLACE_ID,
  GOOGLE_REVIEWS_TERMS_CONFIRMED: 'true',
};

let fake: PlacesFakeServer;
let ctx: TestContext; // development, Default-Konfiguration (disabled)
let googleCtx: TestContext; // development, Google-Konfiguration + Gateway gegen den Fake
let googleLog = '';
let gatewayPool: pg.Pool | undefined;

function googleGateway(db: Database, options: { limit?: number; timeoutMs?: number } = {}) {
  return new GoogleReviewGateway({
    apiKey: SYNTH_KEY,
    placeId: PLACES_FAKE_DEFAULT_PLACE_ID,
    budget: ReviewRequestBudget.forDatabase(db, 'development', options.limit ?? 1000),
    baseUrl: fake.baseUrl,
    timeoutMs: options.timeoutMs ?? 400,
  });
}

async function resetLimiterRow(pool: pg.Pool): Promise<void> {
  await pool.query('DELETE FROM integration_rate_limits WHERE provider = $1', [
    GOOGLE_REVIEWS_RATE_LIMIT_PROVIDER,
  ]);
}

async function getReviews(target: TestContext, headers: Record<string, string> = {}) {
  return target.app.inject({ method: 'GET', url: '/public/reviews', headers });
}

/** Alle Tabellen, in deren Zeilen (als Text) `needle` vorkommt. */
async function tablesContaining(pool: pg.Pool, needle: string): Promise<string[]> {
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const hits: string[] = [];
  for (const { table_name: table } of tables.rows) {
    const result = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${table}" t WHERE t::text ILIKE $1`,
      [`%${needle}%`],
    );
    if ((result.rows[0]?.n ?? 0) > 0) hits.push(table);
  }
  return hits;
}

beforeAll(async () => {
  fake = await startPlacesFakeServer({ apiKey: SYNTH_KEY });
  ctx = await createTestContext();
  const sink = new PassThrough();
  sink.on('data', (chunk: Buffer) => {
    googleLog += chunk.toString('utf8');
  });
  // Gateway braucht die DB des Kontexts ⇒ eigener Pool auf dieselbe Test-DB.
  gatewayPool = createPool(TEST_DATABASE_URL, { max: 2 });
  googleCtx = await createTestContext({
    env: GOOGLE_ENV,
    logDestination: sink,
    logLevel: 'debug',
    reviewGateway: googleGateway(createDb(gatewayPool)),
  });
});

afterAll(async () => {
  if (googleCtx !== undefined) await destroyTestContext(googleCtx);
  if (ctx !== undefined) await destroyTestContext(ctx);
  await gatewayPool?.end();
  await fake.stop();
});

beforeEach(async () => {
  fake.state.reset();
  await resetLimiterRow(ctx.pool);
});

describe('Phase 16: GET /public/reviews', () => {
  it('RV1. disabled (Default) ⇒ 404 REVIEWS_DISABLED, no-store, Gateway-Modus disabled in /public/site/settings', async () => {
    const response = await getReviews(ctx);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('REVIEWS_DISABLED');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    const site = await ctx.app.inject({ method: 'GET', url: '/public/site/settings' });
    expect(site.statusCode).toBe(200);
    expect(site.json().reviews).toEqual({ mode: 'disabled' });
    // production ohne Provider: ebenso aus (nie Fake auf Live).
    const production = await createEnvApp(ctx, 'production');
    try {
      const live = await production.inject({ method: 'GET', url: '/public/reviews' });
      expect(live.statusCode).toBe(404);
      const liveSite = await production.inject({ method: 'GET', url: '/public/site/settings' });
      expect(liveSite.json().reviews).toEqual({ mode: 'disabled' });
    } finally {
      await production.close();
    }
  });

  it('RV2. demo + fake ⇒ synthetische Bewertungen mit DEMO-Attribution, nie „Google“, keine Fotos/Links', async () => {
    const demo = await createTestContext({ appEnv: 'demo', env: { REVIEWS_PROVIDER: 'fake' } });
    try {
      const response = await getReviews(demo);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.json();
      expect(body.mode).toBe('demo');
      expect(body.attribution).toBe('DEMO – synthetische Beispielbewertungen');
      expect(response.body.toLowerCase()).not.toContain('google');
      expect(body.reviews.length).toBeGreaterThan(0);
      for (const review of body.reviews) {
        expect(review.text).toMatch(/^DEMO-Beispieltext: /);
        expect(review).toMatchObject({
          authorUri: null,
          authorPhotoUri: null,
          reviewUri: null,
          flagUri: null,
        });
      }
      const site = await demo.app.inject({ method: 'GET', url: '/public/site/settings' });
      expect(site.json().reviews).toEqual({ mode: 'demo' });
    } finally {
      await destroyTestContext(demo);
    }
  });

  it('RV3. Startfehler: production/staging mit Fake-Gateway, demo mit Google-Gateway (Laufzeitsperre auch für Injektion)', async () => {
    for (const appEnv of ['production', 'staging'] as const) {
      const app = buildEnvApp(ctx, appEnv, { app: { reviewGateway: new FakeReviewGateway() } });
      try {
        await expect(app.ready()).rejects.toThrow(/Fake-Bewertungs-Gateway .* nicht zulässig/);
      } finally {
        await app.close().catch(() => undefined);
      }
    }
    const google: ReviewGateway = googleGateway(ctx.db);
    const demo = buildEnvApp(ctx, 'demo', { app: { reviewGateway: google } });
    try {
      await expect(demo.ready()).rejects.toThrow(/demo nicht zulässig/);
    } finally {
      await demo.close().catch(() => undefined);
    }
    expect(fake.state.requests).toHaveLength(0);
  });

  it('RV4. google (lokaler Fake): DTO mit „Google Maps“, Pflicht-Attribution non-null, Hinweise; unvollständige/fremde Bewertungen entfallen', async () => {
    const body = defaultPlacesFakeBody() as { reviews: Array<Record<string, unknown>> };
    body.reviews.push(
      {
        ...body.reviews[0],
        authorAttribution: { displayName: 'Ohne Foto', uri: 'https://www.google.com/x' },
      },
      { ...body.reviews[0], googleMapsUri: 'https://evil.example/review' },
    );
    fake.state.body = body;
    const response = await getReviews(googleCtx, { 'sec-fetch-site': 'same-origin' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    const dto = response.json();
    expect(dto).toMatchObject({
      mode: 'google',
      rating: 4.8,
      total: 42,
      placeUri: 'https://maps.google.com/?cid=1234567890',
      attribution: 'Google Maps',
      translationNote: 'Von Google übersetzt',
      policyUri: 'https://support.google.com/contributionpolicy/answer/7422880',
    });
    expect(dto.sortNote).toMatch(/Relevanz/);
    expect(dto.reviews.map((r: { authorName: string }) => r.authorName)).toEqual([
      'Test Person 1',
      'Test Person 2',
      'Test Person 3',
    ]);
    for (const review of dto.reviews) {
      expect(review.authorUri).toMatch(/^https:\/\//);
      expect(review.authorPhotoUri).toMatch(/^https:\/\/lh3\.googleusercontent\.com\//);
      expect(review.reviewUri).toMatch(/^https:\/\/www\.google\.com\//);
    }
    expect(dto.reviews[1]).toMatchObject({
      translated: true,
      originalText: 'Synthetic test text 2.',
    });
    expect(fake.state.requests).toHaveLength(1);
    expect(fake.state.requests[0]).toMatchObject({
      keyValid: true,
      fieldMask: 'id,rating,userRatingCount,googleMapsUri,reviews',
      query: { languageCode: 'de', regionCode: 'DE' },
    });
  });

  it('RV5. kein Cache: zwei Abrufe ⇒ zwei Google-Requests; nichts davon in der Datenbank (nur die Limiter-Zeile ohne Inhalte)', async () => {
    const marker = `Marker-${randomUUID()}`;
    const author = `Autor-${randomUUID()}`;
    const body = defaultPlacesFakeBody() as { reviews: Array<Record<string, unknown>> };
    body.reviews[0] = {
      ...body.reviews[0],
      text: { text: marker, languageCode: 'de' },
      originalText: { text: marker, languageCode: 'de' },
      authorAttribution: {
        displayName: author,
        uri: 'https://www.google.com/maps/contrib/m',
        photoUri: 'https://lh3.googleusercontent.com/a-/m',
      },
    };
    fake.state.body = body;
    const first = await getReviews(googleCtx);
    const second = await getReviews(googleCtx);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json().reviews[0].text).toBe(marker);
    expect(fake.state.requests).toHaveLength(2);
    for (const needle of [marker, author, SYNTH_KEY, 'lh3.googleusercontent.com/a-/m']) {
      expect(await tablesContaining(ctx.pool, needle), needle).toEqual([]);
    }
    const rows = await ctx.pool.query('SELECT * FROM integration_rate_limits WHERE provider = $1', [
      GOOGLE_REVIEWS_RATE_LIMIT_PROVIDER,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(Object.keys(rows.rows[0]).sort()).toEqual([
      'environment',
      'next_slot_at',
      'pause_kind',
      'paused_until',
      'provider',
      'updated_at',
    ]);
  });

  it('RV6. Provider-Ausfall (5xx, Timeout, 429) ⇒ 503 neutral; Website (Site-Settings, Katalog, Health) bleibt verfügbar', async () => {
    const scenarios: Array<() => void> = [
      () => fake.state.failures.push({ times: 1, status: 500 }),
      () => fake.state.failures.push({ times: 1, status: 503 }),
      () => fake.state.failures.push({ times: 1, mode: 'delay', delayMs: 2000 }),
      () => fake.state.failures.push({ times: 1, mode: 'invalid_json' }),
      () => fake.state.failures.push({ times: 1, status: 429 }),
    ];
    for (const arrange of scenarios) {
      fake.state.reset();
      await resetLimiterRow(ctx.pool);
      arrange();
      const response = await getReviews(googleCtx);
      expect(response.statusCode).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      const error = response.json().error;
      expect(Object.keys(error).sort()).toEqual(['code', 'correlationId', 'message']);
      expect(error).toMatchObject({
        code: 'REVIEWS_UNAVAILABLE',
        message: 'Bewertungen sind gerade nicht verfügbar.',
      });
      expect(fake.state.requests).toHaveLength(1); // keine Wiederholung
      for (const url of ['/public/site/settings', '/public/configurator/catalog', '/health']) {
        const other = await googleCtx.app.inject({ method: 'GET', url });
        expect(other.statusCode, url).toBe(200);
      }
    }
    // Nach 429: globale Pause ⇒ nächster Abruf 503 OHNE Google-Request.
    const paused = await getReviews(googleCtx);
    expect(paused.statusCode).toBe(503);
    expect(fake.state.requests).toHaveLength(1);
    const row = await ctx.pool.query<{ pause_kind: string | null }>(
      'SELECT pause_kind FROM integration_rate_limits WHERE provider = $1',
      [GOOGLE_REVIEWS_RATE_LIMIT_PROVIDER],
    );
    expect(row.rows[0]?.pause_kind).toBe('rate_limited');
    // Ein werfendes Gateway (Fake-Ausfall) legt ebenfalls nur die Sektion lahm.
    const failing = await createTestContext({
      reviewGateway: new FakeReviewGateway({ fail: true }),
    });
    try {
      expect((await getReviews(failing)).statusCode).toBe(503);
      expect(
        (await failing.app.inject({ method: 'GET', url: '/public/site/settings' })).statusCode,
      ).toBe(200);
    } finally {
      await destroyTestContext(failing);
    }
  });

  it('RV7. Tagesgrenze GLOBAL: zwei Prozesse (eigene Pools/Gateways) teilen sich das Kontingent – danach 503 ohne Google-Request', async () => {
    const poolA = createPool(TEST_DATABASE_URL, { max: 1 });
    const poolB = createPool(TEST_DATABASE_URL, { max: 1 });
    try {
      // Limit 8 ⇒ Burst 2 – je Prozess allein wären 2 + 2 möglich, global nur 2.
      const gatewayA = googleGateway(createDb(poolA), { limit: 8 });
      const gatewayB = googleGateway(createDb(poolB), { limit: 8 });
      await expect(gatewayA.fetchPlaceReviews()).resolves.toMatchObject({ mode: 'google' });
      await expect(gatewayB.fetchPlaceReviews()).resolves.toMatchObject({ mode: 'google' });
      await expect(gatewayA.fetchPlaceReviews()).rejects.toMatchObject({
        code: 'REVIEWS_LIMIT_REACHED',
        reason: 'budget_exhausted',
      });
      await expect(gatewayB.fetchPlaceReviews()).rejects.toMatchObject({
        code: 'REVIEWS_LIMIT_REACHED',
      });
      expect(fake.state.requests).toHaveLength(2);
      const row = await ctx.pool.query<{ pause_kind: string | null; paused_until: Date | null }>(
        'SELECT pause_kind, paused_until FROM integration_rate_limits WHERE provider = $1',
        [GOOGLE_REVIEWS_RATE_LIMIT_PROVIDER],
      );
      expect(row.rows[0]?.pause_kind).toBe('credit_limited');
      expect(row.rows[0]?.paused_until?.getTime() ?? 0).toBeGreaterThan(Date.now());
    } finally {
      await poolA.end();
      await poolB.end();
      await resetLimiterRow(ctx.pool);
    }
  });

  it('RV8. Key, Review-Texte und Autorennamen nie im Log; Log nennt nur Provider/Ergebnis/Grund/Status/Dauer/Anzahl', async () => {
    const author = `Logautor-${randomUUID()}`;
    const body = defaultPlacesFakeBody() as { reviews: Array<Record<string, unknown>> };
    body.reviews[0] = {
      ...body.reviews[0],
      authorAttribution: {
        displayName: author,
        uri: 'https://www.google.com/maps/contrib/l',
        photoUri: 'https://lh3.googleusercontent.com/a-/l',
      },
    };
    fake.state.body = body;
    expect((await getReviews(googleCtx)).statusCode).toBe(200);
    fake.state.failures.push({ times: 1, status: 500 });
    expect((await getReviews(googleCtx)).statusCode).toBe(503);
    fake.state.apiKey = 'SYNTH-rotated-key';
    expect((await getReviews(googleCtx)).statusCode).toBe(503);
    fake.state.apiKey = SYNTH_KEY;
    // Auch eine versehentlich geloggte Konfiguration bleibt geschwärzt (app.ts-Redaktion).
    expect(googleCtx.config.reviews.google.apiKey).toBe(SYNTH_KEY);
    googleCtx.app.log.info({ config: googleCtx.config }, 'Konfiguration');
    googleCtx.app.log.info({ reviews: googleCtx.config.reviews }, 'Reviews-Konfiguration');
    await new Promise((resolve) => setImmediate(resolve));
    expect(googleLog).toContain('"provider":"google"');
    expect(googleLog).toContain('"outcome":"ok"');
    expect(googleLog).toContain('"reason":"server_error"');
    expect(googleLog).toContain('"reason":"permission_denied"');
    expect(googleLog).toContain('[REDACTED]');
    for (const secret of [SYNTH_KEY, author, 'Synthetischer Testtext', 'lh3.googleusercontent']) {
      expect(googleLog, secret).not.toContain(secret);
    }
  });

  it('RV9. Sec-Fetch-Site cross-site/same-site ⇒ 403 ohne Google-Request; same-origin/none/ohne Header erlaubt', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const response = await getReviews(googleCtx, {
        'sec-fetch-site': site,
        origin: 'https://evil.example',
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('CSRF_REJECTED');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect(fake.state.requests).toHaveLength(0);
    for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}]) {
      expect((await getReviews(googleCtx, headers)).statusCode).toBe(200);
    }
    expect(fake.state.requests).toHaveLength(3);
    // Auch disabled: Cross-Site zuerst abgelehnt.
    expect((await getReviews(ctx, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
  });

  it('RV10. 10 Abrufe je Minute und IP, danach 429 (Gateway wird nicht mehr aufgerufen)', async () => {
    const gateway = new FakeReviewGateway();
    const limited = await createTestContext({ rateLimitEnabled: true, reviewGateway: gateway });
    try {
      for (let i = 0; i < 10; i += 1) {
        expect((await getReviews(limited)).statusCode).toBe(200);
      }
      const blocked = await getReviews(limited);
      expect(blocked.statusCode).toBe(429);
      expect(gateway.calls).toBe(10);
    } finally {
      await destroyTestContext(limited);
    }
  });
});
