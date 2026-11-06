/**
 * Phase 16 (REVIEWS, Order §18/§25, Design §4/§11.2.6/§11.3): GoogleReviewGateway gegen den
 * lokalen Contract-Fake der Places API (New) – NIE gegen Google. Feldmaske/Header/Sprache,
 * Pflicht-Attribution und Host-Allowlist (sonst verworfen), Übersetzungs-Flag, Fehler/
 * Timeout/429 ohne Wiederholung, kein Cache, Größenlimit, Key nie in Fehlern; Tagesgrenze
 * (Token-Bucket über den IntegrationRateLimiter) mit simulierter Uhr. Namen „RG<n>.“.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reviewBudgetPolicy, ReviewRequestBudget } from '../src/reviews/budget.ts';
import {
  GOOGLE_PLACES_BASE_URL,
  GOOGLE_REVIEWS_FIELD_MASK,
  GoogleReviewGateway,
  mapGooglePlaceResponse,
  safeGoogleUri,
  type GoogleReviewGatewayOptions,
} from '../src/reviews/google.ts';
import {
  defaultPlacesFakeBody,
  PLACES_FAKE_DEFAULT_PLACE_ID,
  startPlacesFakeServer,
  type PlacesFakeServer,
} from '../src/reviews/testing/fake-places-server.ts';
import { ReviewProviderError } from '../src/reviews/types.ts';

const SYNTH_KEY = 'SYNTH-places-gateway-key-0123456789-never-real';
let fake: PlacesFakeServer;

beforeAll(async () => {
  fake = await startPlacesFakeServer({ apiKey: SYNTH_KEY });
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(() => {
  fake.state.reset();
});

function gatewayFor(overrides: Partial<GoogleReviewGatewayOptions> = {}): GoogleReviewGateway {
  return new GoogleReviewGateway({
    apiKey: SYNTH_KEY,
    placeId: PLACES_FAKE_DEFAULT_PLACE_ID,
    budget: ReviewRequestBudget.inMemory(1000),
    baseUrl: fake.baseUrl,
    timeoutMs: 1000,
    ...overrides,
  });
}

async function providerError(promise: Promise<unknown>): Promise<ReviewProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewProviderError);
    const providerError = error as ReviewProviderError;
    // Neutral: nie Key, URL oder Antwortkörper im Fehler.
    expect(providerError.message).toBe('Bewertungen sind gerade nicht verfügbar.');
    expect(JSON.stringify({ ...providerError, stack: providerError.stack })).not.toContain(
      SYNTH_KEY,
    );
    return providerError;
  }
  throw new Error('ReviewProviderError erwartet');
}

/** Eine Review im Antwortformat der Places API (Platzhalter-URLs der Doku-Beispiele). */
function review(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: `places/x/reviews/${n}`,
    relativePublishTimeDescription: `vor ${n} Tagen`,
    rating: 5,
    text: { text: `Text ${n}`, languageCode: 'de' },
    originalText: { text: `Text ${n}`, languageCode: 'de' },
    authorAttribution: {
      displayName: `Person ${n}`,
      uri: `https://www.google.com/maps/contrib/${n}`,
      photoUri: `https://lh3.googleusercontent.com/a-/${n}`,
    },
    publishTime: '2026-10-01T10:00:00Z',
    flagContentUri: `https://www.google.com/local/review/rap/report?postId=${n}`,
    googleMapsUri: `https://www.google.com/maps/reviews/data=${n}`,
    ...overrides,
  };
}

describe('Phase 16: GoogleReviewGateway (lokaler Fake, kein Google)', () => {
  it('RG1. Request: GET /v1/places/{id}, languageCode=de&regionCode=DE, Feldmaske + Key nur im Header, keine Besucherdaten', async () => {
    const result = await gatewayFor().fetchPlaceReviews();
    expect(result.mode).toBe('google');
    expect(fake.state.requests).toHaveLength(1);
    const request = fake.state.requests[0]!;
    expect(request.method).toBe('GET');
    expect(request.path).toBe(`/v1/places/${PLACES_FAKE_DEFAULT_PLACE_ID}`);
    expect(request.query).toEqual({ languageCode: 'de', regionCode: 'DE' });
    expect(request.fieldMask).toBe('id,rating,userRatingCount,googleMapsUri,reviews');
    expect(GOOGLE_REVIEWS_FIELD_MASK).toBe(request.fieldMask);
    expect(request.keyValid).toBe(true);
    for (const header of [
      'cookie',
      'authorization',
      'referer',
      'x-forwarded-for',
      'x-real-ip',
      'forwarded',
    ]) {
      expect(request.headerNames).not.toContain(header);
    }
    // Produktion: Host fest.
    expect(GOOGLE_PLACES_BASE_URL).toBe('https://places.googleapis.com');
  });

  it('RG2. Abbildung: Rating/Anzahl/Place-Link, Reihenfolge wie geliefert, Pflicht-Attribution gesetzt, Übersetzung erkannt, Texte unverändert', async () => {
    const result = await gatewayFor().fetchPlaceReviews();
    expect(result.rating).toBe(4.8);
    expect(result.total).toBe(42);
    expect(result.placeUri).toBe('https://maps.google.com/?cid=1234567890');
    expect(result.reviews.map((r) => r.authorName)).toEqual([
      'Test Person 1',
      'Test Person 2',
      'Test Person 3',
    ]);
    for (const r of result.reviews) {
      expect(r.authorUri).toMatch(/^https:\/\/www\.google\.com\/maps\/contrib\//);
      expect(r.authorPhotoUri).toMatch(/^https:\/\/lh3\.googleusercontent\.com\//);
      expect(r.reviewUri).toMatch(/^https:\/\/www\.google\.com\/maps\/reviews\//);
      expect(r.flagUri).toMatch(/^https:\/\/www\.google\.com\/local\/review\//);
    }
    const [first, second, third] = result.reviews;
    expect(first).toMatchObject({
      rating: 5,
      text: 'Synthetischer Testtext 1.',
      translated: false,
      originalText: null,
      relativeTime: 'vor 1 Wochen',
      publishTime: '2026-10-01T10:00:00.000000Z',
    });
    expect(second).toMatchObject({
      text: 'Synthetischer Testtext 2 (übersetzt).',
      translated: true,
      originalText: 'Synthetic test text 2.',
    });
    expect(third?.rating).toBe(4);
  });

  it('RG3. Bewertungen ohne Pflicht-Attribution (Name, Profil, Avatar, googleMapsUri) werden verworfen', () => {
    const body = {
      reviews: [
        review(1),
        review(2, { authorAttribution: { displayName: 'P2', uri: 'https://www.google.com/x' } }),
        review(3, {
          authorAttribution: { displayName: 'P3', photoUri: 'https://lh3.googleusercontent.com/a' },
        }),
        review(4, {
          authorAttribution: {
            displayName: '  ',
            uri: 'https://www.google.com/x',
            photoUri: 'https://lh3.googleusercontent.com/a',
          },
        }),
        review(5, { googleMapsUri: undefined }),
        review(6, { rating: 0 }),
        review(7, { rating: 6 }),
        review(8, { authorAttribution: undefined }),
        'kaputt',
        null,
      ],
    };
    const result = mapGooglePlaceResponse(body);
    expect(result.reviews.map((r) => r.authorName)).toEqual(['Person 1']);
  });

  it('RG4. fremde Hosts/Schemata verwerfen die Bewertung (Allowlist *.googleusercontent.com, www.google.com, maps.google.com, google.com)', () => {
    const bad = [
      'http://www.google.com/maps/contrib/1',
      'https://evil.example/maps/contrib/1',
      'https://www.google.com.evil.example/x',
      'https://googleusercontent.com.evil.example/x',
      'https://googleusercontent.com/x',
      'https://www.google.de/maps/contrib/1',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'https://user:pw@www.google.com/x',
      'https://www.google.com:8443/x',
      '//www.google.com/x',
      `https://www.google.com/${'a'.repeat(2100)}`,
    ];
    for (const uri of bad) {
      expect(safeGoogleUri(uri), uri).toBeNull();
      const variants = [
        review(1, {
          authorAttribution: {
            displayName: 'P',
            uri,
            photoUri: 'https://lh3.googleusercontent.com/a',
          },
        }),
        review(2, {
          authorAttribution: { displayName: 'P', uri: 'https://www.google.com/x', photoUri: uri },
        }),
        review(3, { googleMapsUri: uri }),
        review(4, { flagContentUri: uri }),
      ];
      expect(mapGooglePlaceResponse({ reviews: variants }).reviews, uri).toEqual([]);
    }
    for (const good of [
      'https://www.google.com/maps/contrib/1',
      'https://maps.google.com/maps/contrib/1',
      'https://google.com/maps?cid=1',
      'https://lh3.googleusercontent.com/a-/x=s128',
      'https://LH5.GoogleUserContent.com/p/x',
    ]) {
      expect(safeGoogleUri(good), good).not.toBeNull();
    }
    // Fehlender Meldelink ist erlaubt (null), ein unzulässiger nicht.
    const noFlag = mapGooglePlaceResponse({ reviews: [review(1, { flagContentUri: undefined })] });
    expect(noFlag.reviews[0]?.flagUri).toBeNull();
    // Place-Link mit fremdem Host ⇒ null (Bewertungen bleiben).
    const place = mapGooglePlaceResponse({
      googleMapsUri: 'https://evil.example/x',
      rating: 7,
      userRatingCount: -1,
      reviews: [review(1)],
    });
    expect(place).toMatchObject({ placeUri: null, rating: null, total: null });
    expect(place.reviews).toHaveLength(1);
  });

  it('RG5. ohne Text: leerer Text (Sterne bleiben); nur Originaltext: unübersetzt; höchstens 5 Bewertungen', () => {
    const result = mapGooglePlaceResponse({
      reviews: [
        review(1, { text: undefined, originalText: undefined }),
        review(2, { text: undefined, originalText: { text: 'Original', languageCode: 'en' } }),
        review(3, {
          text: { text: 'Hallo', languageCode: 'de-DE' },
          originalText: { text: 'Hallo', languageCode: 'de' },
        }),
        review(4),
        review(5),
        review(6),
      ],
    });
    expect(result.reviews).toHaveLength(5);
    expect(result.reviews[0]).toMatchObject({ text: '', translated: false, originalText: null });
    expect(result.reviews[1]).toMatchObject({ text: 'Original', translated: false });
    expect(result.reviews[2]).toMatchObject({ text: 'Hallo', translated: false });
    expect(() => mapGooglePlaceResponse('kein Objekt')).toThrow(ReviewProviderError);
    expect(() => mapGooglePlaceResponse({ reviews: 'x' })).toThrow(ReviewProviderError);
  });

  it('RG6. Fehler: 5xx/403/404/400/kaputtes JSON/zu große Antwort ⇒ REVIEWS_UNAVAILABLE, genau EIN Request (keine Wiederholung)', async () => {
    const cases: Array<{ status?: number; mode?: 'invalid_json'; reason: string }> = [
      { status: 500, reason: 'server_error' },
      { status: 503, reason: 'server_error' },
      { status: 400, reason: 'invalid_argument' },
      { status: 404, reason: 'not_found' },
      { mode: 'invalid_json', reason: 'invalid_response' },
    ];
    for (const failure of cases) {
      fake.state.reset();
      fake.state.failures.push({ times: 1, ...failure });
      const error = await providerError(gatewayFor().fetchPlaceReviews());
      expect(error.code).toBe('REVIEWS_UNAVAILABLE');
      expect(error.reason).toBe(failure.reason);
      expect(fake.state.requests).toHaveLength(1);
    }
    fake.state.reset();
    const wrongKey = await providerError(gatewayFor({ apiKey: 'SYNTH-wrong' }).fetchPlaceReviews());
    expect(wrongKey).toMatchObject({ reason: 'permission_denied', httpStatus: 403 });
    fake.state.reset();
    fake.state.body = { reviews: [{ text: { text: 'x'.repeat(1024 * 1024 + 10) } }] };
    const tooLarge = await providerError(gatewayFor().fetchPlaceReviews());
    expect(tooLarge.reason).toBe('invalid_response');
  });

  it('RG7. Timeout ⇒ REVIEWS_UNAVAILABLE (timeout) ohne Wiederholung; Netzfehler ⇒ network', async () => {
    fake.state.failures.push({ times: 1, mode: 'delay', delayMs: 1500 });
    const started = Date.now();
    const error = await providerError(gatewayFor({ timeoutMs: 150 }).fetchPlaceReviews());
    expect(error.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1400);
    expect(fake.state.requests).toHaveLength(1);
    const network = await providerError(
      gatewayFor({ baseUrl: 'http://127.0.0.1:9' }).fetchPlaceReviews(),
    );
    expect(network.reason).toBe('network');
    // Standard-Timeout im Betrieb: 3 s.
    const { GOOGLE_REVIEWS_TIMEOUT_MS } = await import('../src/reviews/google.ts');
    expect(GOOGLE_REVIEWS_TIMEOUT_MS).toBe(3000);
  });

  it('RG8. 429 ⇒ rate_limited + globale Pause: der nächste Abruf scheitert sofort OHNE Request', async () => {
    const gateway = gatewayFor();
    fake.state.failures.push({ times: 1, status: 429 });
    const first = await providerError(gateway.fetchPlaceReviews());
    expect(first).toMatchObject({ code: 'REVIEWS_UNAVAILABLE', reason: 'rate_limited' });
    const second = await providerError(gateway.fetchPlaceReviews());
    expect(second).toMatchObject({ code: 'REVIEWS_LIMIT_REACHED', reason: 'rate_limited' });
    expect(fake.state.requests).toHaveLength(1);
  });

  it('RG9. kein Cache: zwei Abrufe ⇒ zwei Requests; geänderte Antwort sofort sichtbar', async () => {
    const gateway = gatewayFor();
    const first = await gateway.fetchPlaceReviews();
    fake.state.body = { ...(defaultPlacesFakeBody() as object), rating: 3.9 };
    const second = await gateway.fetchPlaceReviews();
    expect(fake.state.requests).toHaveLength(2);
    expect(first.rating).toBe(4.8);
    expect(second.rating).toBe(3.9);
  });

  it('RG10. Konstruktor: leerer Key bzw. Place ID mit fremden Zeichen ⇒ Fehler (kein Request)', () => {
    expect(() => gatewayFor({ apiKey: '' })).toThrow(/apiKey/);
    expect(() => gatewayFor({ placeId: '../admin' })).toThrow(/placeId/);
    expect(() => gatewayFor({ placeId: 'a?b=c' })).toThrow(/placeId/);
    expect(fake.state.requests).toHaveLength(0);
  });
});

describe('Phase 16: Tagesgrenze (Token-Bucket über den IntegrationRateLimiter)', () => {
  it('RG11. Policy: Default 32 ⇒ Burst 8, Abstand 57,6 min; kleine Grenzen ohne Burst', () => {
    expect(reviewBudgetPolicy(32)).toEqual({
      dailyRequestLimit: 32,
      burst: 8,
      intervalMs: 3_456_000,
      toleranceMs: 7 * 3_456_000,
    });
    expect(reviewBudgetPolicy(1)).toMatchObject({
      burst: 1,
      intervalMs: 86_400_000,
      toleranceMs: 0,
    });
    expect(reviewBudgetPolicy(3)).toMatchObject({ burst: 1, intervalMs: 28_800_000 });
    expect(() => reviewBudgetPolicy(0)).toThrow();
    expect(() => reviewBudgetPolicy(1.5)).toThrow();
  });

  it('RG12. in KEINEM gleitenden 24-h-Fenster mehr als das Limit – auch unter Dauerlast; Burst sofort; Erholung nach der Pause', async () => {
    for (const limit of [1, 2, 5, 8, 32]) {
      let now = Date.parse('2026-11-06T00:00:00Z');
      const budget = ReviewRequestBudget.inMemory(limit, () => now);
      const granted: number[] = [];
      // Drei Tage lang alle 5 Minuten ein Versuch (Dauerlast) plus Spitzen.
      for (let step = 0; step < (3 * 24 * 60) / 5; step += 1) {
        const attempts = step % 50 === 0 ? 20 : 1;
        for (let i = 0; i < attempts; i += 1) {
          const decision = await budget.tryConsume();
          if (decision.granted) granted.push(now);
        }
        now += 5 * 60 * 1000;
      }
      for (let i = 0; i < granted.length; i += 1) {
        const windowEnd = granted[i]! + 24 * 60 * 60 * 1000;
        const inWindow = granted.filter((t) => t >= granted[i]! && t < windowEnd).length;
        expect(inWindow, `limit ${limit}`).toBeLessThanOrEqual(limit);
      }
      // Unter Dauerlast blockiert die Grenze nie dauerhaft: jeder Tag bekommt Abrufe.
      for (let day = 0; day < 3; day += 1) {
        const start = Date.parse('2026-11-06T00:00:00Z') + day * 86_400_000;
        expect(
          granted.filter((t) => t >= start && t < start + 86_400_000).length,
          `limit ${limit} Tag ${day}`,
        ).toBeGreaterThanOrEqual(Math.max(1, Math.floor(limit / 2)));
      }
    }
    // Burst: 8 sofort, der 9. nicht; nach dem Pausenende wieder frei.
    let now = Date.parse('2026-11-06T12:00:00Z');
    const budget = ReviewRequestBudget.inMemory(32, () => now);
    for (let i = 0; i < 8; i += 1) expect((await budget.tryConsume()).granted).toBe(true);
    expect(await budget.tryConsume()).toEqual({ granted: false, reason: 'budget_exhausted' });
    expect(await budget.tryConsume()).toEqual({ granted: false, reason: 'budget_exhausted' });
    now += 2 * 3_456_000;
    expect((await budget.tryConsume()).granted).toBe(true);
  });

  it('RG13. Grenze erreicht ⇒ Gateway wirft REVIEWS_LIMIT_REACHED, OHNE Google-Request', async () => {
    let now = Date.parse('2026-11-06T12:00:00Z');
    const gateway = gatewayFor({ budget: ReviewRequestBudget.inMemory(1, () => now) });
    await gateway.fetchPlaceReviews();
    const error = await providerError(gateway.fetchPlaceReviews());
    expect(error).toMatchObject({ code: 'REVIEWS_LIMIT_REACHED', reason: 'budget_exhausted' });
    expect(fake.state.requests).toHaveLength(1);
    // Pause = 24 h + 1 s Sicherheitsabstand.
    now += 86_400_000 + 500;
    await providerError(gateway.fetchPlaceReviews());
    now += 501;
    await gateway.fetchPlaceReviews();
    expect(fake.state.requests).toHaveLength(2);
  });
});
