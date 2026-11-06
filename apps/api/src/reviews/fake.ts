import {
  ReviewProviderError,
  type PlaceReview,
  type PlaceReviewsResult,
  type ReviewGateway,
} from './types.ts';

/**
 * Phase 16 (REVIEWS, Order §18/§21, Design §4): synthetische Beispielbewertungen für
 * demo/development (und Tests). Modus `demo` – die Route beschriftet sie immer mit
 * „DEMO – synthetische Beispielbewertungen“, nie mit „Google“. Keine Autorenfotos, keine
 * Links, keine Gesamtbewertung/Anzahl (keine erfundenen Kennzahlen), keine Daten echter
 * Personen; jeder Text beginnt mit „DEMO-Beispieltext“. In staging/production verweigern
 * Konfiguration, Fabrik und `assertReviewGatewayAllowed` diesen Gateway.
 */
export const FAKE_REVIEWS: readonly PlaceReview[] = [
  {
    authorName: 'Demo-Kundin A.',
    authorUri: null,
    authorPhotoUri: null,
    rating: 5,
    text: 'DEMO-Beispieltext: Die Abholung hat reibungslos geklappt und die Einweisung war gut verständlich. Unsere Gäste hatten viel Freude am Slush.',
    translated: false,
    originalText: null,
    relativeTime: null,
    publishTime: null,
    reviewUri: null,
    flagUri: null,
  },
  {
    authorName: 'Demo-Kunde B.',
    authorUri: null,
    authorPhotoUri: null,
    rating: 5,
    text: 'DEMO-Beispieltext: Schnelle Rückmeldung auf unsere Anfrage und ein übersichtliches Angebot. Gerne wieder.',
    translated: false,
    originalText: null,
    relativeTime: null,
    publishTime: null,
    reviewUri: null,
    flagUri: null,
  },
  {
    authorName: 'Demo-Verein C.',
    authorUri: null,
    authorPhotoUri: null,
    rating: 4,
    text: 'DEMO-Beispieltext: Die Maschine lief beim Vereinsfest zuverlässig. Beim nächsten Mal stimmen wir die Sorten etwas früher ab.',
    translated: false,
    originalText: null,
    relativeTime: null,
    publishTime: null,
    reviewUri: null,
    flagUri: null,
  },
];

export interface FakeReviewGatewayOptions {
  /** Nur Tests: Provider-Ausfall simulieren (wirft wie ein echter Ausfall). */
  fail?: boolean;
}

export class FakeReviewGateway implements ReviewGateway {
  readonly mode = 'demo' as const;
  /** Nur Tests: Anzahl der Abrufe. */
  calls = 0;
  private readonly fail: boolean;

  constructor(options: FakeReviewGatewayOptions = {}) {
    this.fail = options.fail ?? false;
  }

  async fetchPlaceReviews(): Promise<PlaceReviewsResult> {
    this.calls += 1;
    if (this.fail) {
      throw new ReviewProviderError(
        'REVIEWS_UNAVAILABLE',
        'Bewertungen sind gerade nicht verfügbar.',
        { reason: 'server_error' },
      );
    }
    return {
      mode: 'demo',
      rating: null,
      total: null,
      placeUri: null,
      reviews: FAKE_REVIEWS.map((review) => ({ ...review })),
    };
  }
}
