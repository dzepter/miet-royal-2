/**
 * Phase 16 (WEB, Order §18, Design §1.5/§4/§11.2.6): Bewertungen per Klick-zum-Laden.
 *
 * Erst der Klick auf „Bewertungen anzeigen“ ruft `GET /api/public/reviews` (serverseitig ⇒
 * Provider, kein Cache, nichts gespeichert). Kein Google-JavaScript, kein Widget. Ohne aktiven
 * Provider (`disabled`) gibt es die Sektion nicht. Demo-Bewertungen sind immer als DEMO
 * gekennzeichnet und nie als „Google“ beschriftet. Reine Funktionen (node --test).
 */
import type { PublicReview, PublicReviewsResponse, ReviewMode } from './site-types.ts';

export const REVIEWS_URL = '/api/public/reviews';

export const REVIEWS_TEXT = {
  BUTTON: 'Bewertungen anzeigen',
  LOADING: 'Bewertungen werden geladen …',
  GOOGLE_NOTICE: 'Beim Laden werden Bewertungen und Profilbilder von Google abgerufen.',
  DEMO_NOTICE: 'Synthetische DEMO-Beispielbewertungen – keine echten Kundenmeinungen.',
  UNAVAILABLE: 'Bewertungen sind gerade nicht verfügbar.',
  TRANSLATED: 'Von Google übersetzt',
  DEMO_BADGE: 'DEMO',
} as const;

/** Sektion nur bei aktivem Provider (Order §18: ohne echten Provider komplett ausblenden). */
export function reviewsSectionVisible(mode: ReviewMode | string | null | undefined): boolean {
  return mode === 'google' || mode === 'demo';
}

export function reviewsNotice(mode: ReviewMode | string): string {
  return mode === 'demo' ? REVIEWS_TEXT.DEMO_NOTICE : REVIEWS_TEXT.GOOGLE_NOTICE;
}

/** Nur https-Links (Autor, Bewertung, Melden, Ort) – alles andere wird nicht verlinkt. */
export function safeHttpsUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isReview(value: unknown): value is PublicReview {
  if (typeof value !== 'object' || value === null) return false;
  const review = value as Record<string, unknown>;
  return (
    typeof review.authorName === 'string' &&
    typeof review.rating === 'number' &&
    typeof review.text === 'string'
  );
}

export function isReviewsResponse(value: unknown): value is PublicReviewsResponse {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.mode === 'google' || record.mode === 'demo') &&
    typeof record.attribution === 'string' &&
    Array.isArray(record.reviews) &&
    record.reviews.every(isReview)
  );
}

/**
 * Google-Pflicht-Attribution (Design §11.2.6): im Google-Modus nur Bewertungen mit Autorname,
 * Autor-Link und Profilbild (https); Demo-Bewertungen haben weder Links noch Fotos.
 */
export function displayableReviews(response: PublicReviewsResponse): PublicReview[] {
  if (response.mode === 'demo') {
    return response.reviews.map((review) => ({
      ...review,
      authorUri: null,
      authorPhotoUri: null,
      reviewUri: null,
      flagUri: null,
    }));
  }
  return response.reviews.filter(
    (review) =>
      review.authorName.trim() !== '' &&
      safeHttpsUrl(review.authorUri) !== null &&
      safeHttpsUrl(review.authorPhotoUri) !== null,
  );
}

/** Attributionszeile: Demo nie „Google“ (Order §18/Design §4). */
export function attributionText(response: PublicReviewsResponse): string {
  if (response.mode === 'demo') {
    return /google/i.test(response.attribution)
      ? 'DEMO – synthetische Beispielbewertungen'
      : response.attribution;
  }
  return response.attribution.trim() === '' ? 'Google Maps' : response.attribution;
}

export type ReviewsOutcome = { kind: 'ok'; data: PublicReviewsResponse } | { kind: 'unavailable' };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export async function fetchReviews(fetchImpl: FetchLike = defaultFetch): Promise<ReviewsOutcome> {
  try {
    const response = await fetchImpl(REVIEWS_URL, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return { kind: 'unavailable' };
    const body: unknown = await response.json().catch(() => null);
    return isReviewsResponse(body) ? { kind: 'ok', data: body } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}
