/**
 * Phase 16 (Order §18, Design §1.5/§4): Provider-Grenze für Bewertungen.
 *
 * - `disabled` ⇒ keine Bewertungen; die Website blendet die Sektion komplett aus.
 * - `google`   ⇒ echte Google-Bewertungen (Places API (New), serverseitig, kein Cache,
 *                nichts in der DB – Google-Nutzungsbedingungen, docs/GOOGLE_REVIEWS_API_NOTES.md).
 * - `demo`     ⇒ synthetische Beispielbewertungen, NUR in demo/development, immer als DEMO
 *                gekennzeichnet, nie als „Google“.
 */
export type ReviewMode = 'disabled' | 'google' | 'demo';

export interface PlaceReview {
  authorName: string;
  /** Google: Profil des Verfassers (Pflicht-Attribution); Demo: null. */
  authorUri: string | null;
  /** Google: Profilbild (Pflicht-Attribution, vom Browser bei Google geladen); Demo: null. */
  authorPhotoUri: string | null;
  rating: number;
  text: string;
  /** Google übersetzt Bewertungen ggf. – dann Hinweis anzeigen. */
  translated: boolean;
  relativeTime: string | null;
  publishTime: string | null;
  /** Google: Link zur einzelnen Bewertung auf Google Maps; Demo: null. */
  reviewUri: string | null;
  /** Google: Meldelink; Demo: null. */
  flagUri: string | null;
}

export interface PlaceReviewsResult {
  mode: Exclude<ReviewMode, 'disabled'>;
  rating: number | null;
  total: number | null;
  placeUri: string | null;
  reviews: PlaceReview[];
}

export class ReviewProviderError extends Error {
  constructor(
    readonly code: 'REVIEWS_DISABLED' | 'REVIEWS_UNAVAILABLE' | 'REVIEWS_LIMIT_REACHED',
    message: string,
  ) {
    super(message);
    this.name = 'ReviewProviderError';
  }
}

export interface ReviewGateway {
  /** Öffentlicher Modus (für `/public/site/settings`). */
  readonly mode: ReviewMode;
  /** Bewertungen holen – nie gecacht, nie gespeichert. Wirft `ReviewProviderError`. */
  fetchPlaceReviews(): Promise<PlaceReviewsResult>;
}
