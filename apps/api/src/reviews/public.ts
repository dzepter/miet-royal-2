import type { PlaceReviewsResult } from './types.ts';

/**
 * Phase 16 (REVIEWS, Design §4/§11.2.6): öffentliches DTO von `GET /public/reviews`.
 *
 * - mode `google`: Pflicht-Attribution „Google Maps“; je Bewertung `authorUri`,
 *   `authorPhotoUri`, `reviewUri` IMMER gesetzt (sonst wird die Bewertung verworfen);
 *   Sortier-/Filterhinweis, Übersetzungshinweis und Hinweis zur Google-Richtlinie.
 * - mode `demo`: Attribution „DEMO – synthetische Beispielbewertungen“, NIE „Google“; alle
 *   Links/Fotos/Kennzahlen null.
 * Nichts davon wird gespeichert oder gecacht (Route: `Cache-Control: no-store`).
 */

export const GOOGLE_REVIEWS_ATTRIBUTION = 'Google Maps';
export const DEMO_REVIEWS_ATTRIBUTION = 'DEMO – synthetische Beispielbewertungen';
export const GOOGLE_REVIEWS_SORT_NOTE =
  'Bis zu 5 Bewertungen von Google Maps, ausgewählt und sortiert nach Relevanz durch Google. Wir filtern nicht nach Sternen; Bewertungen ohne vollständige Angaben zur verfassenden Person werden nicht angezeigt.';
export const DEMO_REVIEWS_SORT_NOTE =
  'Feste Beispieltexte der DEMO-Umgebung – keine echten Bewertungen.';
export const GOOGLE_REVIEWS_TRANSLATION_NOTE = 'Von Google übersetzt';
export const GOOGLE_REVIEWS_POLICY_NOTE =
  'Google prüft Bewertungen nicht, sucht aber nach gefälschten Inhalten und entfernt sie, sobald sie erkannt werden.';
export const GOOGLE_REVIEWS_POLICY_URI =
  'https://support.google.com/contributionpolicy/answer/7422880';

export interface PublicReviewItem {
  authorName: string;
  authorUri: string | null;
  authorPhotoUri: string | null;
  rating: number;
  text: string;
  /** true ⇒ `translationNote` anzeigen; `originalText` optional aufklappbar. */
  translated: boolean;
  originalText: string | null;
  relativeTime: string | null;
  publishTime: string | null;
  reviewUri: string | null;
  flagUri: string | null;
}

export interface PublicReviewsResponse {
  mode: 'google' | 'demo';
  rating: number | null;
  total: number | null;
  placeUri: string | null;
  attribution: string;
  sortNote: string;
  /** Beschriftung übersetzter Bewertungen (nur google). */
  translationNote: string | null;
  /** Hinweis auf Googles Richtlinie zu Bewertungen (nur google). */
  policyNote: string | null;
  policyUri: string | null;
  reviews: PublicReviewItem[];
}

export function toPublicReviews(
  mode: 'google' | 'demo',
  result: PlaceReviewsResult,
): PublicReviewsResponse {
  if (mode === 'demo') {
    return {
      mode: 'demo',
      rating: null,
      total: null,
      placeUri: null,
      attribution: DEMO_REVIEWS_ATTRIBUTION,
      sortNote: DEMO_REVIEWS_SORT_NOTE,
      translationNote: null,
      policyNote: null,
      policyUri: null,
      reviews: result.reviews.map((review) => ({
        authorName: review.authorName,
        authorUri: null,
        authorPhotoUri: null,
        rating: review.rating,
        text: review.text,
        translated: false,
        originalText: null,
        relativeTime: review.relativeTime,
        publishTime: review.publishTime,
        reviewUri: null,
        flagUri: null,
      })),
    };
  }
  const reviews: PublicReviewItem[] = [];
  for (const review of result.reviews) {
    // Zweite Sperre (auch für injizierte Gateways): ohne Pflicht-Attribution keine Anzeige.
    if (review.authorUri === null || review.authorPhotoUri === null || review.reviewUri === null) {
      continue;
    }
    reviews.push({
      authorName: review.authorName,
      authorUri: review.authorUri,
      authorPhotoUri: review.authorPhotoUri,
      rating: review.rating,
      text: review.text,
      translated: review.translated,
      originalText: review.translated ? (review.originalText ?? null) : null,
      relativeTime: review.relativeTime,
      publishTime: review.publishTime,
      reviewUri: review.reviewUri,
      flagUri: review.flagUri,
    });
  }
  return {
    mode: 'google',
    rating: result.rating,
    total: result.total,
    placeUri: result.placeUri,
    attribution: GOOGLE_REVIEWS_ATTRIBUTION,
    sortNote: GOOGLE_REVIEWS_SORT_NOTE,
    translationNote: GOOGLE_REVIEWS_TRANSLATION_NOTE,
    policyNote: GOOGLE_REVIEWS_POLICY_NOTE,
    policyUri: GOOGLE_REVIEWS_POLICY_URI,
    reviews,
  };
}
