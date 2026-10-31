import type { Database } from '@mietroyal/database';
import type { JobRunnerLogger } from '@mietroyal/integrations';
import type { PushService } from '../../communication/push/push-service.ts';
import type { PermissionResolver } from '../../communication/push/recipients.ts';
import type { DueScanner } from '../../communication/scan-due.ts';
import type { RoutingGateway } from '../../routing/types.ts';
import type { TourService } from '../tour-service.ts';
import type { OperativeAddressResolver, TourGeocodingResolver } from '../types.ts';
import { DelayRiskService } from './delay-risk-service.ts';
import { createTourDelayScanner } from './delay-scanner.ts';
import { DelayEvaluationState } from './delay-state.ts';
import { LocationService } from './location-service.ts';

/**
 * Phase 13 (tours-live): EINE Komposition für API (app.ts), Worker
 * (apps/worker über `@mietroyal/api/jobs/tours`) und Tests – GPS-Service,
 * Verspätungsbewertung, Scanner `tour_delay`. (Offline-Tour-Snapshot:
 * offline-snapshot.ts, in app.ts an die Offline-Routen gehängt.)
 */
export interface TourLiveModuleDeps {
  db: Database;
  tours: TourService;
  routing: RoutingGateway;
  geocoding: TourGeocodingResolver;
  addresses: OperativeAddressResolver;
  push: PushService;
  auth: PermissionResolver;
  logger?: JobRunnerLogger | undefined;
  /** Geteiltes In-Process-Gedächtnis (Tour-View liest den Bewertungsstand daraus). */
  state?: DelayEvaluationState | undefined;
  /** Tests: kürzeres Rate-Limit der Standort-Updates. */
  locationMinIntervalMs?: number | undefined;
}

export interface TourLiveModule {
  state: DelayEvaluationState;
  locations: LocationService;
  delay: DelayRiskService;
  scanner: DueScanner;
}

export function createTourLiveModule(deps: TourLiveModuleDeps): TourLiveModule {
  const state = deps.state ?? new DelayEvaluationState();
  const locations = new LocationService(deps.db, deps.tours, {
    minIntervalMs: deps.locationMinIntervalMs,
  });
  const delay = new DelayRiskService({
    db: deps.db,
    tours: deps.tours,
    gateway: deps.routing,
    geocoding: deps.geocoding,
    addresses: deps.addresses,
    push: deps.push,
    auth: deps.auth,
    state,
    logger: deps.logger,
  });
  const scanner = createTourDelayScanner({ db: deps.db, delay, logger: deps.logger });
  return { state, locations, delay, scanner };
}
