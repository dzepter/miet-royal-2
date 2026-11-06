import { z } from '@mietroyal/validation';
import type { ReviewRequestBudget } from './budget.ts';
import {
  ReviewProviderError,
  type PlaceReview,
  type PlaceReviewsResult,
  type ReviewFailureReason,
  type ReviewGateway,
} from './types.ts';

/**
 * Phase 16 (REVIEWS, Order §18, Design §4/§11.2.6): einziger HTTP-Client gegen die Places
 * API (New) – Place Details (geprüft 2026-11-06, docs/GOOGLE_REVIEWS_API_NOTES.md).
 *
 * - `GET https://places.googleapis.com/v1/places/{placeId}?languageCode=de&regionCode=DE`
 *   (Host fest; nur Tests übergeben `baseUrl` eines lokalen Fake-Servers).
 * - Auth ausschließlich im Header `X-Goog-Api-Key` (nie als `key=` in der URL ⇒ der Key
 *   steht in keiner URL, keinem Log, keinem Fehler); Feldmaske im Header `X-Goog-FieldMask`.
 * - Timeout 3 s gesamt (inkl. Body), KEINE Wiederholung, kein Cache, nichts in die DB
 *   (Google verbietet Speichern/Cachen von Bewertungen); Antwort höchstens 1 MiB.
 * - Vor jedem Abruf die GLOBALE Tagesgrenze (`ReviewRequestBudget`); 429 ⇒ globale Pause.
 * - Antwort strikt auf eine Whitelist abgebildet: nur Bewertungen mit vollständiger
 *   Pflicht-Attribution (`authorAttribution.displayName`, `.uri`, `.photoUri`) und
 *   `googleMapsUri`; jede URI muss `https:` sein und auf einem erlaubten Google-Host liegen
 *   (`*.googleusercontent.com`, `www.google.com`, `maps.google.com`, `google.com`), sonst
 *   wird die Bewertung verworfen (fail-closed). Texte bleiben unverändert (keine Kürzung,
 *   keine eigene Übersetzung, keine Auswahl nach Sternen); Reihenfolge wie geliefert.
 * - Gesendet werden nur Key, Place ID, Feldmaske, Sprache und Region – nie Daten der
 *   Website-Besucher (IP, User-Agent, Cookies, Referrer).
 */

export const GOOGLE_PLACES_BASE_URL = 'https://places.googleapis.com';
/** Design §4: genau diese Felder (Abrechnung nach der höchsten SKU: Enterprise + Atmosphere). */
export const GOOGLE_REVIEWS_FIELD_MASK = 'id,rating,userRatingCount,googleMapsUri,reviews';
export const GOOGLE_REVIEWS_LANGUAGE_CODE = 'de';
export const GOOGLE_REVIEWS_REGION_CODE = 'DE';
export const GOOGLE_REVIEWS_TIMEOUT_MS = 3000;
export const GOOGLE_REVIEWS_MAX_RESPONSE_BYTES = 1024 * 1024;
/** Laut Google höchstens 5 Bewertungen je Ort. */
export const GOOGLE_REVIEWS_MAX_REVIEWS = 5;

const ALLOWED_EXACT_HOSTS: ReadonlySet<string> = new Set([
  'www.google.com',
  'maps.google.com',
  'google.com',
]);
const ALLOWED_HOST_SUFFIX = '.googleusercontent.com';
const MAX_URI_LENGTH = 2048;

/**
 * `https:`-URI auf einem erlaubten Google-Host (ohne Zugangsdaten/Port) oder null.
 * Die Host-Liste ist laut Google nicht verbindlich dokumentiert (Doku-Beispiele) ⇒ vor
 * Go-live im Staging-Smoke-Test prüfen (docs/GOOGLE_REVIEWS_API_NOTES.md).
 */
export function safeGoogleUri(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > MAX_URI_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const allowed =
    ALLOWED_EXACT_HOSTS.has(host) ||
    (host.endsWith(ALLOWED_HOST_SUFFIX) && host.length > ALLOWED_HOST_SUFFIX.length);
  return allowed ? url.href : null;
}

const localizedTextSchema = z.object({
  text: z.string().optional(),
  languageCode: z.string().optional(),
});

/** Bewertung laut REST-Referenz (`Review`); alles optional geparst, Pflicht wird unten geprüft. */
const reviewSchema = z.object({
  rating: z.number(),
  text: localizedTextSchema.optional(),
  originalText: localizedTextSchema.optional(),
  authorAttribution: z.object({
    displayName: z.string(),
    uri: z.string(),
    photoUri: z.string(),
  }),
  relativePublishTimeDescription: z.string().optional(),
  publishTime: z.string().optional(),
  googleMapsUri: z.string(),
  flagContentUri: z.string().optional(),
});

const placeSchema = z.object({
  id: z.string().optional(),
  rating: z.number().optional(),
  userRatingCount: z.number().optional(),
  googleMapsUri: z.string().optional(),
  reviews: z.array(z.unknown()).optional(),
});

function primaryLanguage(code: string | undefined): string | null {
  const trimmed = code?.trim().toLowerCase() ?? '';
  if (trimmed === '') return null;
  return trimmed.split(/[-_]/)[0] ?? null;
}

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.trim() !== '' ? value : null;
}

/** Eine Bewertung abbilden oder verwerfen (null) – nie verändern. */
export function mapGoogleReview(raw: unknown): PlaceReview | null {
  const parsed = reviewSchema.safeParse(raw);
  if (!parsed.success) return null;
  const review = parsed.data;
  if (!Number.isFinite(review.rating) || review.rating < 1 || review.rating > 5) return null;
  const authorName = review.authorAttribution.displayName;
  if (authorName.trim() === '') return null;
  const authorUri = safeGoogleUri(review.authorAttribution.uri);
  const authorPhotoUri = safeGoogleUri(review.authorAttribution.photoUri);
  const reviewUri = safeGoogleUri(review.googleMapsUri);
  if (authorUri === null || authorPhotoUri === null || reviewUri === null) return null;
  let flagUri: string | null = null;
  if (review.flagContentUri !== undefined) {
    flagUri = safeGoogleUri(review.flagContentUri);
    // Ein gelieferter, aber unzulässiger Meldelink ⇒ Bewertung verwerfen (fail-closed).
    if (flagUri === null) return null;
  }
  const localized = nonEmpty(review.text?.text);
  const original = nonEmpty(review.originalText?.text);
  const localizedLanguage = primaryLanguage(review.text?.languageCode);
  const originalLanguage = primaryLanguage(review.originalText?.languageCode);
  const translated =
    localized !== null &&
    original !== null &&
    localizedLanguage !== null &&
    originalLanguage !== null &&
    localizedLanguage !== originalLanguage;
  const publishTime =
    review.publishTime !== undefined && Number.isFinite(Date.parse(review.publishTime))
      ? review.publishTime
      : null;
  return {
    authorName,
    authorUri,
    authorPhotoUri,
    rating: review.rating,
    text: localized ?? original ?? '',
    translated,
    originalText: translated ? original : null,
    relativeTime: nonEmpty(review.relativePublishTimeDescription),
    publishTime,
    reviewUri,
    flagUri,
  };
}

/** Ganze Place-Details-Antwort abbilden; unerwartete Grundform ⇒ `invalid_response`. */
export function mapGooglePlaceResponse(body: unknown): PlaceReviewsResult {
  const parsed = placeSchema.safeParse(body);
  if (!parsed.success) {
    throw unavailable('invalid_response', 200);
  }
  const place = parsed.data;
  const rating =
    place.rating !== undefined &&
    Number.isFinite(place.rating) &&
    place.rating >= 1 &&
    place.rating <= 5
      ? place.rating
      : null;
  const total =
    place.userRatingCount !== undefined &&
    Number.isSafeInteger(place.userRatingCount) &&
    place.userRatingCount >= 0
      ? place.userRatingCount
      : null;
  const reviews: PlaceReview[] = [];
  for (const raw of (place.reviews ?? []).slice(0, GOOGLE_REVIEWS_MAX_REVIEWS)) {
    const review = mapGoogleReview(raw);
    if (review !== null) reviews.push(review);
  }
  return {
    mode: 'google',
    rating,
    total,
    placeUri: safeGoogleUri(place.googleMapsUri),
    reviews,
  };
}

function unavailable(reason: ReviewFailureReason, httpStatus: number | null = null) {
  return new ReviewProviderError(
    'REVIEWS_UNAVAILABLE',
    'Bewertungen sind gerade nicht verfügbar.',
    {
      reason,
      httpStatus,
    },
  );
}

function reasonForStatus(status: number): ReviewFailureReason {
  if (status === 400) return 'invalid_argument';
  if (status === 401) return 'auth_invalid';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return 'unexpected_status';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** Antwortkörper mit Größenlimit lesen (Abbruch durch das Timeout-Signal wirkt auch hier). */
async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (body === null) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw unavailable('invalid_response', response.status);
    }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export interface GoogleReviewGatewayOptions {
  apiKey: string;
  placeId: string;
  /** Globale Tagesgrenze (Betrieb: `ReviewRequestBudget.forDatabase`). */
  budget: ReviewRequestBudget;
  /** NUR Tests (lokaler Fake-HTTP-Server); Betrieb immer `GOOGLE_PLACES_BASE_URL`. */
  baseUrl?: string;
  /** NUR Tests; Betrieb `GOOGLE_REVIEWS_TIMEOUT_MS`. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GoogleReviewGateway implements ReviewGateway {
  readonly mode = 'google' as const;
  private readonly apiKey: string;
  private readonly url: string;
  private readonly budget: ReviewRequestBudget;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GoogleReviewGatewayOptions) {
    if (options.apiKey === '') throw new Error('GoogleReviewGateway: apiKey fehlt');
    if (!/^[A-Za-z0-9_-]+$/.test(options.placeId)) {
      throw new Error('GoogleReviewGateway: placeId ungültig');
    }
    const baseUrl = (options.baseUrl ?? GOOGLE_PLACES_BASE_URL).replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.url = `${baseUrl}/v1/places/${encodeURIComponent(options.placeId)}?languageCode=${GOOGLE_REVIEWS_LANGUAGE_CODE}&regionCode=${GOOGLE_REVIEWS_REGION_CODE}`;
    this.budget = options.budget;
    this.timeoutMs = options.timeoutMs ?? GOOGLE_REVIEWS_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchPlaceReviews(): Promise<PlaceReviewsResult> {
    const decision = await this.budget.tryConsume();
    if (!decision.granted) {
      throw new ReviewProviderError(
        'REVIEWS_LIMIT_REACHED',
        'Bewertungen sind gerade nicht verfügbar.',
        { reason: decision.reason },
      );
    }
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': this.apiKey,
          'X-Goog-FieldMask': GOOGLE_REVIEWS_FIELD_MASK,
          accept: 'application/json',
        },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw unavailable(isAbortError(error) ? 'timeout' : 'network');
    }
    if (response.status !== 200) {
      // Fehlerkörper nie lesen/loggen (kann z. B. die Server-IP nennen).
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 429) await this.budget.pauseAfterProviderRateLimit();
      throw unavailable(reasonForStatus(response.status), response.status);
    }
    let body: unknown;
    try {
      body = JSON.parse(await readLimitedText(response, GOOGLE_REVIEWS_MAX_RESPONSE_BYTES));
    } catch (error) {
      if (error instanceof ReviewProviderError) throw error;
      throw unavailable(isAbortError(error) ? 'timeout' : 'invalid_response', 200);
    }
    return mapGooglePlaceResponse(body);
  }
}
