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
  /** Text unverändert wie geliefert (Google: ggf. übersetzt); ohne Text ''. */
  text: string;
  /** Google übersetzt Bewertungen ggf. – dann Hinweis anzeigen. */
  translated: boolean;
  /**
   * Phase 16 (reviews): Originaltext, nur wenn `translated` (Google empfiehlt, ihn
   * anzeigen zu können); sonst null bzw. nicht gesetzt.
   */
  originalText?: string | null;
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

/**
 * Phase 16 (reviews): technischer Grund eines Ausfalls – nur für Logs/Monitoring
 * (nie an den Browser; die Route antwortet immer neutral 503 `REVIEWS_UNAVAILABLE`).
 */
export type ReviewFailureReason =
  | 'disabled'
  | 'budget_exhausted'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'auth_invalid'
  | 'permission_denied'
  | 'not_found'
  | 'invalid_argument'
  | 'server_error'
  | 'unexpected_status'
  | 'invalid_response';

export class ReviewProviderError extends Error {
  /** Phase 16 (reviews): Grund für Logs (nie Key, URL, Antwortkörper oder Review-Inhalte). */
  readonly reason: ReviewFailureReason;
  /** HTTP-Status der Provider-Antwort, sofern eine kam. */
  readonly httpStatus: number | null;

  constructor(
    readonly code: 'REVIEWS_DISABLED' | 'REVIEWS_UNAVAILABLE' | 'REVIEWS_LIMIT_REACHED',
    message: string,
    details: { reason?: ReviewFailureReason; httpStatus?: number | null } = {},
  ) {
    super(message);
    this.name = 'ReviewProviderError';
    this.reason =
      details.reason ??
      (code === 'REVIEWS_DISABLED'
        ? 'disabled'
        : code === 'REVIEWS_LIMIT_REACHED'
          ? 'budget_exhausted'
          : 'unexpected_status');
    this.httpStatus = details.httpStatus ?? null;
  }
}

export interface ReviewGateway {
  /** Öffentlicher Modus (für `/public/site/settings`). */
  readonly mode: ReviewMode;
  /** Bewertungen holen – nie gecacht, nie gespeichert. Wirft `ReviewProviderError`. */
  fetchPlaceReviews(): Promise<PlaceReviewsResult>;
}
