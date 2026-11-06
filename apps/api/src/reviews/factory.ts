import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import { ReviewRequestBudget } from './budget.ts';
import { FakeReviewGateway } from './fake.ts';
import { GoogleReviewGateway } from './google.ts';
import { ReviewProviderError, type ReviewGateway } from './types.ts';

/**
 * Phase 16 (REVIEWS, Order §18/§21, Design §1.5/§4/§11.2.6): Fabrik und Laufzeitsperren der
 * Bewertungs-Grenze – genau eine Instanz je API-Prozess (app.ts).
 *
 * - `google`   ⇒ GoogleReviewGateway (Key nur hier und im Header des Abrufs) mit der GLOBALEN
 *                Tagesgrenze in `integration_rate_limits` (Pflicht: `db`); nie in demo.
 * - `fake`     ⇒ FakeReviewGateway (Modus `demo`), nur demo/development.
 * - `disabled` ⇒ DisabledReviewGateway (Website blendet die Sektion aus).
 * Die Konfiguration lehnt unzulässige Kombinationen bereits beim Laden ab; Fabrik und
 * `assertReviewGatewayAllowed` sind die zweite bzw. dritte Sperre (auch für injizierte
 * Gateways).
 */

/**
 * Log-Redaktion: Pfade, unter denen ein Places-API-Key auftauchen könnte (app.ts übernimmt
 * die Liste in `redact.paths`; `apiKey`/`*.apiKey`/`*.*.apiKey` deckt app.ts bereits ab).
 * Der Gateway selbst loggt nie; die Route loggt nur Provider, Ergebnis, Grund, HTTP-Status,
 * Dauer und Anzahl.
 */
export const REVIEWS_LOG_REDACT_PATHS: readonly string[] = [
  'reviews.google.apiKey',
  '*.reviews.google.apiKey',
  'config.reviews.google.apiKey',
  '*.config.reviews.google.apiKey',
  'google.apiKey',
  '*.google.apiKey',
  'GOOGLE_PLACES_API_KEY',
  '*.GOOGLE_PLACES_API_KEY',
  'headers["x-goog-api-key"]',
  '*.headers["x-goog-api-key"]',
  'headers["X-Goog-Api-Key"]',
  '*.headers["X-Goog-Api-Key"]',
];

/**
 * Laufzeitsperre in buildApp (auch für injizierte Gateways): production/staging nie `demo`
 * (Fake), demo nie `google`. Wirft bei Verstoß (Startabbruch).
 */
export function assertReviewGatewayAllowed(appEnv: string, gateway: ReviewGateway): void {
  if (gateway.mode === 'demo' && (appEnv === 'production' || appEnv === 'staging')) {
    throw new Error(
      `Fake-Bewertungs-Gateway (synthetische Bewertungen) ist in ${appEnv} nicht zulässig.`,
    );
  }
  if (gateway.mode === 'google' && appEnv === 'demo') {
    throw new Error('Google-Bewertungs-Gateway ist in demo nicht zulässig (Demo ruft nie Google).');
  }
  if (gateway.mode !== 'disabled' && gateway.mode !== 'demo' && gateway.mode !== 'google') {
    throw new Error('Bewertungs-Gateway mit unbekanntem Modus.');
  }
}

export interface ReviewGatewayDeps {
  /** Pflicht für provider `google` (globale Tagesgrenze). */
  db?: Database;
  /** Nur Tests: vorbereitete Tagesgrenze statt der Datenbank-Zeile. */
  budget?: ReviewRequestBudget;
}

export class DisabledReviewGateway implements ReviewGateway {
  readonly mode = 'disabled' as const;

  async fetchPlaceReviews(): Promise<never> {
    throw new ReviewProviderError('REVIEWS_DISABLED', 'Bewertungen sind nicht aktiviert.');
  }
}

export function createReviewGateway(
  config: Pick<AppConfig, 'appEnv' | 'reviews'>,
  deps: ReviewGatewayDeps = {},
): ReviewGateway {
  const reviews = config.reviews;
  let gateway: ReviewGateway;
  if (reviews.provider === 'google') {
    if (config.appEnv === 'demo') {
      throw new Error('Google-Bewertungen sind in demo nicht zulässig (Demo ruft nie Google).');
    }
    const { apiKey, placeId } = reviews.google;
    if (apiKey === null || placeId === null || !reviews.termsConfirmed) {
      // Durch loadConfig nicht erreichbar (Key + Place ID + Bestätigung ⇔ google); fail-closed.
      gateway = new DisabledReviewGateway();
    } else {
      const budget =
        deps.budget ??
        (deps.db === undefined
          ? null
          : ReviewRequestBudget.forDatabase(deps.db, config.appEnv, reviews.dailyRequestLimit));
      if (budget === null) {
        // Nie eine nur prozesslokale Grenze im Betrieb (Design §11.2.6: global je Umgebung).
        throw new Error(
          'Google-Bewertungen brauchen die globale Tagesgrenze (db) – keine In-Process-Grenze.',
        );
      }
      gateway = new GoogleReviewGateway({ apiKey, placeId, budget });
    }
  } else if (reviews.provider === 'fake') {
    if (config.appEnv !== 'demo' && config.appEnv !== 'development') {
      throw new Error(
        `Fake-Bewertungs-Gateway (synthetische Bewertungen) ist in ${config.appEnv} nicht zulässig.`,
      );
    }
    gateway = new FakeReviewGateway();
  } else {
    gateway = new DisabledReviewGateway();
  }
  assertReviewGatewayAllowed(config.appEnv, gateway);
  return gateway;
}
