import type { Database } from '@mietroyal/database';
import type { DueScanner } from '../communication/scan-due.ts';
import type { AppConfig } from '@mietroyal/config';
import type { JobQueue } from '@mietroyal/integrations';
import { createPortalAuthCleanupScanner } from './auth/cleanup-scanner.ts'; // Phase 15 (AUTH)
import type { CancellationService } from '../cancellation/cancellation-service.ts'; // Phase 15 (BOOKING)
import { createPortalCancellationMailBackstopScanner } from './cancellation.ts'; // Phase 15 (BOOKING)

/**
 * Phase 15 (Order §52/§43): Periodische Portal-Aufräum- und Backstop-Schritte.
 * Sie laufen über den bestehenden `communication.scan_due`-Lauf (alle 2 min) –
 * KEINE eigene Scheduler-Infrastruktur. Jeder Teil (AUTH: Session-/Magic-Link-
 * Cleanup, BOOKING: Storno-Bestätigungs-Backstop) ergänzt hier seinen Scanner.
 */
export interface PortalScannerDeps {
  db: Database;
  config: AppConfig;
  queue: JobQueue;
  logger?: { warn(obj: Record<string, unknown>, msg?: string): void };
  /** Phase 15 (BOOKING): Storno-Service für den Bestätigungs-Backstop (optional; app.ts/Worker reichen ihn durch). */
  cancellationConfirmations?: Pick<CancellationService, 'sendConfirmation'> | undefined;
}

export function createPortalScanners(deps: PortalScannerDeps): DueScanner[] {
  const scanners: DueScanner[] = [];
  scanners.push(createPortalAuthCleanupScanner(deps)); // Phase 15 (AUTH)
  // Phase 15 (BOOKING): Backstop der automatischen Stornobestätigung (Order §43) –
  // braucht den Storno-Service (sendConfirmation); ohne ihn (z. B. Worker ohne
  // Komposition) wird der Scanner nicht registriert.
  if (deps.cancellationConfirmations !== undefined) {
    scanners.push(
      createPortalCancellationMailBackstopScanner({
        db: deps.db,
        confirmations: deps.cancellationConfirmations,
        ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      }),
    );
  }
  return scanners;
}
