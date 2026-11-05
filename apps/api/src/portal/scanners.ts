import type { Database } from '@mietroyal/database';
import type { DueScanner } from '../communication/scan-due.ts';
import type { AppConfig } from '@mietroyal/config';
import type { JobQueue } from '@mietroyal/integrations';

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
}

export function createPortalScanners(_deps: PortalScannerDeps): DueScanner[] {
  const scanners: DueScanner[] = [];
  // Phase 15 (AUTH): scanners.push(createPortalAuthCleanupScanner(deps));
  // Phase 15 (BOOKING): scanners.push(createPortalCancellationMailBackstopScanner(deps));
  return scanners;
}
