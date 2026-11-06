/**
 * Phase 16 (REVIEWS, Order §18/§21/§25, Design §4/§11.2.6/§11.3): Fabrik und Laufzeitsperren
 * der Bewertungs-Grenze (production/staging nie Fake, demo nie Google, Google nur mit
 * globaler Grenze), FakeReviewGateway eindeutig DEMO, öffentliches DTO (Demo nie „Google“,
 * Google nur mit Pflicht-Attribution), Log-Redaktion des Places-Keys. Namen „RF<n>.“.
 */
import { PassThrough } from 'node:stream';
import { loadConfig, type AppConfig } from '@mietroyal/config';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ReviewRequestBudget } from '../src/reviews/budget.ts';
import {
  assertReviewGatewayAllowed,
  createReviewGateway,
  DisabledReviewGateway,
  REVIEWS_LOG_REDACT_PATHS,
} from '../src/reviews/factory.ts';
import { FAKE_REVIEWS, FakeReviewGateway } from '../src/reviews/fake.ts';
import { GoogleReviewGateway } from '../src/reviews/google.ts';
import {
  DEMO_REVIEWS_ATTRIBUTION,
  GOOGLE_REVIEWS_ATTRIBUTION,
  toPublicReviews,
} from '../src/reviews/public.ts';
import { ReviewProviderError, type PlaceReview, type ReviewGateway } from '../src/reviews/types.ts';

const SYNTH_KEY = 'SYNTH-places-factory-key-0123456789-never-real';
const GOOGLE_ENV = {
  REVIEWS_PROVIDER: 'google',
  GOOGLE_PLACES_API_KEY: SYNTH_KEY,
  GOOGLE_PLACE_ID: 'ChIJSynthFactoryPlace',
  GOOGLE_REVIEWS_TERMS_CONFIRMED: 'true',
};

type ReviewsConfigInput = Pick<AppConfig, 'appEnv' | 'reviews'>;

function reviewsConfig(appEnv: AppConfig['appEnv'], env: Record<string, string>) {
  // Konfiguration in development laden (dort ist alles ladbar) und die Umgebung setzen –
  // simuliert eine an loadConfig vorbei gebaute Konfiguration (zweite Sperre).
  return {
    appEnv,
    reviews: loadConfig({ APP_ENV: 'development', ...env }).reviews,
  } satisfies ReviewsConfigInput;
}

const googleLike = (mode: ReviewGateway['mode']): ReviewGateway => ({
  mode,
  fetchPlaceReviews: async () => ({
    mode: 'google',
    rating: null,
    total: null,
    placeUri: null,
    reviews: [],
  }),
});

describe('Phase 16: Fabrik und Laufzeitsperren der Bewertungs-Grenze', () => {
  it('RF1. disabled (Default) ⇒ DisabledReviewGateway (Modus disabled, Abruf REVIEWS_DISABLED)', async () => {
    for (const appEnv of ['development', 'staging', 'demo', 'production'] as const) {
      const gateway = createReviewGateway(reviewsConfig(appEnv, {}));
      expect(gateway).toBeInstanceOf(DisabledReviewGateway);
      expect(gateway.mode).toBe('disabled');
    }
    await expect(new DisabledReviewGateway().fetchPlaceReviews()).rejects.toMatchObject({
      code: 'REVIEWS_DISABLED',
      reason: 'disabled',
    });
  });

  it('RF2. fake ⇒ FakeReviewGateway nur in demo/development; production/staging ⇒ Fehler (auch an loadConfig vorbei)', () => {
    for (const appEnv of ['demo', 'development'] as const) {
      const gateway = createReviewGateway(reviewsConfig(appEnv, { REVIEWS_PROVIDER: 'fake' }));
      expect(gateway).toBeInstanceOf(FakeReviewGateway);
      expect(gateway.mode).toBe('demo');
    }
    for (const appEnv of ['production', 'staging'] as const) {
      expect(() =>
        createReviewGateway(reviewsConfig(appEnv, { REVIEWS_PROVIDER: 'fake' })),
      ).toThrow(/Fake-Bewertungs-Gateway .* nicht zulässig/);
    }
  });

  it('RF3. google ⇒ GoogleReviewGateway nur mit globaler Grenze (db/budget); demo ⇒ Fehler; ohne Key fail-closed', () => {
    const budget = ReviewRequestBudget.inMemory(32);
    for (const appEnv of ['production', 'staging', 'development'] as const) {
      const gateway = createReviewGateway(reviewsConfig(appEnv, GOOGLE_ENV), { budget });
      expect(gateway).toBeInstanceOf(GoogleReviewGateway);
      expect(gateway.mode).toBe('google');
      // Ohne db/budget keine nur prozesslokale Grenze.
      expect(() => createReviewGateway(reviewsConfig(appEnv, GOOGLE_ENV))).toThrow(
        /globale Tagesgrenze/,
      );
    }
    expect(() => createReviewGateway(reviewsConfig('demo', GOOGLE_ENV), { budget })).toThrow(
      /demo nicht zulässig/,
    );
    // Key/Place ID/Bestätigung fehlen (an loadConfig vorbei) ⇒ Disabled statt Google.
    const base = reviewsConfig('production', GOOGLE_ENV);
    for (const reviews of [
      { ...base.reviews, google: { apiKey: null, placeId: 'ChIJx' } },
      { ...base.reviews, google: { apiKey: SYNTH_KEY, placeId: null } },
      { ...base.reviews, termsConfirmed: false },
    ]) {
      expect(createReviewGateway({ appEnv: 'production', reviews }, { budget }).mode).toBe(
        'disabled',
      );
    }
  });

  it('RF4. assertReviewGatewayAllowed: production/staging + demo ⇒ Startfehler; demo + google ⇒ Startfehler; sonst erlaubt', () => {
    expect(() => assertReviewGatewayAllowed('production', new FakeReviewGateway())).toThrow(
      /production nicht zulässig/,
    );
    expect(() => assertReviewGatewayAllowed('staging', new FakeReviewGateway())).toThrow(
      /staging nicht zulässig/,
    );
    expect(() => assertReviewGatewayAllowed('demo', googleLike('google'))).toThrow(
      /demo nicht zulässig/,
    );
    expect(() =>
      assertReviewGatewayAllowed('production', googleLike('weird' as ReviewGateway['mode'])),
    ).toThrow(/unbekanntem Modus/);
    expect(() => assertReviewGatewayAllowed('production', googleLike('google'))).not.toThrow();
    expect(() =>
      assertReviewGatewayAllowed('production', new DisabledReviewGateway()),
    ).not.toThrow();
    expect(() => assertReviewGatewayAllowed('demo', new FakeReviewGateway())).not.toThrow();
    expect(() => assertReviewGatewayAllowed('demo', new DisabledReviewGateway())).not.toThrow();
    expect(() => assertReviewGatewayAllowed('development', new FakeReviewGateway())).not.toThrow();
    expect(() => assertReviewGatewayAllowed('development', googleLike('google'))).not.toThrow();
  });

  it('RF5. FakeReviewGateway: synthetische deutsche DEMO-Texte, keine Fotos/Links/Kennzahlen, nie „Google“; Ausfall simulierbar', async () => {
    const gateway = new FakeReviewGateway();
    const result = await gateway.fetchPlaceReviews();
    expect(result).toMatchObject({ mode: 'demo', rating: null, total: null, placeUri: null });
    expect(result.reviews.length).toBeGreaterThan(0);
    for (const review of result.reviews) {
      expect(review.text.startsWith('DEMO-Beispieltext: ')).toBe(true);
      expect(review.authorName).toMatch(/^Demo-/);
      expect(review).toMatchObject({
        authorUri: null,
        authorPhotoUri: null,
        reviewUri: null,
        flagUri: null,
        translated: false,
      });
    }
    expect(JSON.stringify(result).toLowerCase()).not.toContain('google');
    // Rückgabe ist eine Kopie (kein geteilter, veränderbarer Zustand).
    result.reviews[0]!.text = 'x';
    expect(FAKE_REVIEWS[0]!.text).not.toBe('x');
    const failing = new FakeReviewGateway({ fail: true });
    await expect(failing.fetchPlaceReviews()).rejects.toBeInstanceOf(ReviewProviderError);
    expect(failing.calls).toBe(1);
  });
});

describe('Phase 16: öffentliches Bewertungs-DTO', () => {
  const googleReview = (overrides: Partial<PlaceReview> = {}): PlaceReview => ({
    authorName: 'Person',
    authorUri: 'https://www.google.com/maps/contrib/1',
    authorPhotoUri: 'https://lh3.googleusercontent.com/a-/1',
    rating: 5,
    text: 'Gut',
    translated: false,
    originalText: null,
    relativeTime: 'vor 1 Woche',
    publishTime: '2026-10-01T10:00:00Z',
    reviewUri: 'https://www.google.com/maps/reviews/1',
    flagUri: 'https://www.google.com/local/review/rap/report?postId=1',
    ...overrides,
  });

  it('RF6. demo: Attribution DEMO, nie „Google“, keine Links/Fotos/Kennzahlen – selbst wenn ein Gateway welche liefert', () => {
    const dto = toPublicReviews('demo', {
      mode: 'demo',
      rating: 4.9,
      total: 99,
      placeUri: 'https://maps.google.com/?cid=1',
      reviews: [googleReview({ translated: true, originalText: 'Good' })],
    });
    expect(dto.attribution).toBe(DEMO_REVIEWS_ATTRIBUTION);
    expect(dto).toMatchObject({
      mode: 'demo',
      rating: null,
      total: null,
      placeUri: null,
      translationNote: null,
      policyNote: null,
      policyUri: null,
    });
    expect(dto.reviews[0]).toMatchObject({
      authorUri: null,
      authorPhotoUri: null,
      reviewUri: null,
      flagUri: null,
      translated: false,
      originalText: null,
    });
    const { reviews: _reviews, ...frame } = dto;
    expect(JSON.stringify(frame).toLowerCase()).not.toContain('google');
  });

  it('RF7. google: Attribution „Google Maps“, Sortier-/Übersetzungs-/Richtlinienhinweis, Bewertungen ohne Pflicht-Attribution entfallen', () => {
    const dto = toPublicReviews('google', {
      mode: 'google',
      rating: 4.8,
      total: 42,
      placeUri: 'https://maps.google.com/?cid=1',
      reviews: [
        googleReview({ authorName: 'A', translated: true, originalText: 'Good' }),
        googleReview({ authorName: 'B', authorPhotoUri: null }),
        googleReview({ authorName: 'C', authorUri: null }),
        googleReview({ authorName: 'D', reviewUri: null }),
        googleReview({ authorName: 'E', flagUri: null }),
      ],
    });
    expect(dto.attribution).toBe(GOOGLE_REVIEWS_ATTRIBUTION);
    expect(dto.attribution).toBe('Google Maps');
    expect(dto.sortNote).toMatch(/Relevanz/);
    expect(dto.translationNote).toBe('Von Google übersetzt');
    expect(dto.policyUri).toBe('https://support.google.com/contributionpolicy/answer/7422880');
    expect(dto.reviews.map((r) => r.authorName)).toEqual(['A', 'E']);
    expect(dto.reviews[0]).toMatchObject({ translated: true, originalText: 'Good' });
    for (const review of dto.reviews) {
      expect(review.authorUri).not.toBeNull();
      expect(review.authorPhotoUri).not.toBeNull();
      expect(review.reviewUri).not.toBeNull();
    }
  });
});

describe('Phase 16: Log-Redaktion des Places-Keys', () => {
  it('RF8. REVIEWS_LOG_REDACT_PATHS sind gültige Pino-Pfade und schwärzen den Key unter allen Pfaden', async () => {
    const sink = new PassThrough();
    let output = '';
    sink.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const app = Fastify({
      logger: {
        level: 'info',
        redact: { paths: [...REVIEWS_LOG_REDACT_PATHS], censor: '[REDACTED]' },
        stream: sink,
      },
    });
    await app.ready();
    const config = loadConfig({ APP_ENV: 'development', ...GOOGLE_ENV });
    expect(config.reviews.google.apiKey).toBe(SYNTH_KEY);
    app.log.info({ config }, 'config');
    app.log.info({ reviews: config.reviews }, 'reviews');
    app.log.info({ ctx: { reviews: config.reviews } }, 'nested');
    app.log.info({ google: { apiKey: SYNTH_KEY } }, 'google');
    app.log.info({ env: { GOOGLE_PLACES_API_KEY: SYNTH_KEY } }, 'env');
    app.log.info({ GOOGLE_PLACES_API_KEY: SYNTH_KEY }, 'top');
    app.log.info({ headers: { 'x-goog-api-key': SYNTH_KEY } }, 'headers');
    app.log.info({ request: { headers: { 'X-Goog-Api-Key': SYNTH_KEY } } }, 'outgoing');
    await app.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(output).toContain('[REDACTED]');
    expect(output.split('\n').filter((line) => line.includes('"msg"')).length).toBe(8);
    expect(output).not.toContain(SYNTH_KEY);
  });
});
