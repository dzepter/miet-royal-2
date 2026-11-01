/**
 * Phase 14 (offline epoch, Order §91/§92): Generation („Epoch“) des Demo-
 * Datensatzes im lokalen Arbeitsbereich. Der Server liefert die Epoch nur in
 * APP_ENV=demo (Lease, Paket, Status); außerhalb der Demo ist sie überall
 * null, und keine der Prüfungen hier greift (Production unverändert).
 *
 * - Meta `datasetEpoch`: Epoch des zuletzt übernommenen Pakets.
 * - Jede Mutation trägt die Epoch zum Zeitpunkt des Einreihens; der Transport
 *   sendet sie je Sync-Anfrage (Wert der Mutation, sonst Meta).
 * - 409 `DEMO_DATASET_CHANGED` ⇒ `DatasetChangedError` (Queue bricht ab wie bei
 *   ungültiger Sitzung), Meta `datasetChangedPending` – der alte Stand wird erst
 *   nach bewusster Bestätigung verworfen und ein neues Paket geladen.
 */

/** Meta-Schlüssel (Klartext, nur technische Werte). */
export const META_DATASET_EPOCH = 'datasetEpoch';
export const META_DATASET_CHANGED_PENDING = 'datasetChangedPending';

/** Fehlercode des Servers (409) für Mutationen eines früheren Datenstands. */
export const DEMO_DATASET_CHANGED_CODE = 'DEMO_DATASET_CHANGED';

/**
 * Datensatzwechsel erkannt? Nur wenn beide Seiten eine Epoch kennen und sie
 * sich unterscheiden – ohne Epoch (Production/Development, erstes Paket)
 * nie ein Wechsel.
 */
export function datasetChanged(
  localEpoch: string | null | undefined,
  serverEpoch: string | null | undefined,
): boolean {
  if (typeof localEpoch !== 'string' || typeof serverEpoch !== 'string') return false;
  return localEpoch !== serverEpoch;
}

/** Hinweistext des Clients (n = nicht synchronisierte Erfassungen). */
export function datasetChangedMessage(pendingCount: number): string {
  return `Die Demo-Daten wurden zurückgesetzt. ${pendingCount} nicht synchronisierte Erfassungen gehören zum alten Datenstand und können nicht mehr übernommen werden.`;
}
