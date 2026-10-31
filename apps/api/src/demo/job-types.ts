import { COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE } from '../communication/types.ts';

/**
 * Phase 14 (reset, Order §21/§22): Jobtypen aus Sicht des Demo-Resets. Bewusst
 * ein leichtes Modul ohne Fachservice-Importe, weil der Worker-Guard
 * (`apps/api/src/jobs/demo.ts`, Export `@mietroyal/api/jobs/demo`) es lädt.
 *
 * - Business-Jobs (`DEMO_BUSINESS_JOB_TYPES`) tragen Geschäfts-Payload des
 *   Datensatzes; der Reset löscht sie (pending/dead/succeeded), und der
 *   Worker-Guard neutralisiert überlebende (processing) Exemplare, deren
 *   `created_at` vor dem Beginn des letzten Resets liegt (DEMO_DATASET_CHANGED).
 * - Vorgangsgebundene Retention-Jobs (`communication.cleanup_retention` mit
 *   `scope: 'photos'`) gehören ebenfalls zum Datensatz; der tägliche Backstop
 *   (`scope: 'backstop'`) ist Infrastruktur.
 * - `demo.storage_cleanup` ist Infrastruktur des Resets selbst: er räumt
 *   Storage-Objekte des ALTEN Datensatzes nach, die beim Reset nicht gelöscht
 *   werden konnten – nie vom Zeitstempel-Skip betroffen, nie in der Löschliste.
 */
export const DEMO_BUSINESS_JOB_TYPES: readonly string[] = [
  'mail.send',
  'push.send',
  'settlement.accounting_transfer',
  'cancellation.accounting_transfer',
  'voucher.eligibility_check',
  'voucher.delivery',
  'invoice.delivery',
  'whatsapp.send',
  'whatsapp.media_fetch',
  'lexware.event.process',
];

/** Phase 14 (reset, Order §22): Nachbereinigung fehlgeschlagener Storage-Löschungen. */
export const DEMO_STORAGE_CLEANUP_JOB_TYPE = 'demo.storage_cleanup';

/** Grund in `integration_jobs.last_error`, wenn der Guard einen Job des alten Datensatzes beendet. */
export const DEMO_DATASET_CHANGED_REASON = 'DEMO_DATASET_CHANGED';

/**
 * Gehört ein Job zum Demo-Datensatz (und damit zu dessen Generation)?
 * Infrastruktur-Jobs (Heartbeat, Scanner, IMAP-Poll, Retention-Backstop,
 * Storage-Nachbereinigung) sind nie datensatzgebunden.
 */
export function isDemoDatasetBoundJob(type: string, payload: unknown): boolean {
  if (DEMO_BUSINESS_JOB_TYPES.includes(type)) return true;
  if (type !== COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE) return false;
  const scope =
    typeof payload === 'object' && payload !== null
      ? (payload as { scope?: unknown }).scope
      : undefined;
  return scope === 'photos';
}
