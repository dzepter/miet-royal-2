import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import { ReviewProviderError, type ReviewGateway } from './types.ts';

/**
 * Log-Redaktion: Pfade, unter denen ein Places-API-Key auftauchen könnte (app.ts übernimmt
 * die Liste in `redact.paths`). Vom Teil REVIEWS gepflegt.
 */
export const REVIEWS_LOG_REDACT_PATHS: readonly string[] = [];

/**
 * Laufzeitsperre in buildApp (auch für injizierte Gateways): production nie `demo`
 * (Fake), demo nie `google`. Vom Teil REVIEWS implementiert; wirft bei Verstoß.
 */
export function assertReviewGatewayAllowed(_appEnv: string, _gateway: ReviewGateway): void {
  // Wird vom Teil REVIEWS implementiert.
}

/**
 * Phase 16 (Fundament): Fabrik der Bewertungs-Grenze. Vorläufig liefert sie immer
 * `DisabledReviewGateway`; der Teil REVIEWS ersetzt das durch die konfigurationsabhängige
 * Auswahl (disabled | fake nur demo/development | google nur mit Key, Place ID und
 * Bestätigung; production nie fake, demo nie google).
 */
export interface ReviewGatewayDeps {
  db?: Database;
}

export class DisabledReviewGateway implements ReviewGateway {
  readonly mode = 'disabled' as const;

  async fetchPlaceReviews(): Promise<never> {
    throw new ReviewProviderError('REVIEWS_DISABLED', 'Bewertungen sind nicht aktiviert.');
  }
}

export function createReviewGateway(
  _config: AppConfig,
  _deps: ReviewGatewayDeps = {},
): ReviewGateway {
  return new DisabledReviewGateway();
}
