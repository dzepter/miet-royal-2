import { tourLiveLocations, tours, type Database } from '@mietroyal/database';
import type { JobRunnerLogger } from '@mietroyal/integrations';
import { and, eq, gte } from 'drizzle-orm';
import type { DueScanner } from '../../communication/scan-due.ts';
import { LIVE_LOCATION_STALE_MS } from '../views.ts';
import type { DelayRiskService } from './delay-risk-service.ts';

/**
 * Phase 13 (Design §9): DueScanner `tour_delay` im zentralen
 * `communication.scan_due` (alle 2 min): alle aktiven Touren mit frischem
 * Live-Standort (≤ 10 min) werden bewertet – die Drossel des Services
 * (≥ 3 min seit der letzten Bewertung ODER ≥ 500 m) entscheidet, ob wirklich
 * gerechnet wird. Fängt auch Stopp-Abschlüsse/Stornos auf, die außerhalb
 * der Tour-Routen passieren (Übergabe/Rückgabe/Storno).
 */
export function createTourDelayScanner(deps: {
  db: Database;
  delay: DelayRiskService;
  logger?: JobRunnerLogger | undefined;
}): DueScanner {
  return {
    name: 'tour_delay',
    async scanDue(now: Date) {
      const rows = await deps.db
        .select({ tourId: tours.id })
        .from(tours)
        .innerJoin(tourLiveLocations, eq(tourLiveLocations.tourId, tours.id))
        .where(
          and(
            eq(tours.status, 'active'),
            gte(tourLiveLocations.observedAt, new Date(now.getTime() - LIVE_LOCATION_STALE_MS)),
          ),
        );
      const summary = { evaluated: 0, skipped: 0, failed: 0 };
      for (const row of rows) {
        try {
          const result = await deps.delay.evaluate(row.tourId, 'scanner', now);
          if (result.status === 'skipped') summary.skipped += 1;
          else summary.evaluated += 1;
        } catch (error) {
          summary.failed += 1;
          deps.logger?.warn(
            {
              tourId: row.tourId,
              errorCode: error instanceof Error ? error.name || 'Error' : 'Error',
            },
            'tour_delay: Bewertung fehlgeschlagen',
          );
        }
      }
      return summary;
    },
  };
}
