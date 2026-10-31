import { randomUUID } from 'node:crypto';
import { demoDatasetState, type Database, type DatabaseExecutor } from '@mietroyal/database';
import { eq, sql } from 'drizzle-orm';

/**
 * Phase 14 (Order §8): erwartete Version des kanonischen Demo-Datensatzes.
 * Bei jeder inhaltlichen Änderung des Seeds erhöhen. Ein älterer Stand in der
 * Datenbank wird NIE automatisch zurückgesetzt – nur als „veraltet“ gemeldet.
 */
export const DEMO_DATASET_VERSION = 1;

/**
 * Reset gilt als hängen geblieben, wenn er länger als diese Spanne läuft
 * (Review F8: 10 min – ein Reset dauert ≈ 10 s; nach einem Prozessabbruch in
 * Phase B/C bleibt das Flag sonst stehen und sperrt die Demo bis zum Ablauf;
 * früher löst nur `pnpm demo:reset --force` auf).
 */
export const DEMO_RESET_STALE_MS = 10 * 60 * 1000;

export interface DemoDatasetStateView {
  datasetVersion: number | null;
  expectedDatasetVersion: number;
  outdated: boolean;
  seededAt: Date | null;
  seededBy: string | null;
  lastResetAt: Date | null;
  lastResetBy: string | null;
  resetInProgress: boolean;
  resetStartedAt: Date | null;
  /** true, wenn ein Reset begonnen, aber nicht abgeschlossen wurde (Flag älter als DEMO_RESET_STALE_MS). */
  resetStale: boolean;
  /**
   * Phase 14 (reset, Order §21): Beginn des LETZTEN Resets (DB-Uhr; bleibt nach
   * Abschluss stehen). Jobs mit `created_at` davor gehören zum alten Datensatz.
   */
  lastResetStartedAt: Date | null;
  /** Phase 14 (offline epoch, Order §91): Generation des Datensatzes – jeder Reset erzeugt eine neue. */
  datasetEpoch: string | null;
}

/**
 * Zustand des Demo-Datensatzes (Singleton-Zeile id = 1). Reine Zustands-
 * verwaltung ohne Fachlogik; Seed und Reset liegen in eigenen Services.
 */
export class DemoDatasetService {
  constructor(private readonly db: Database) {}

  async state(now = new Date()): Promise<DemoDatasetStateView> {
    const [row] = await this.db
      .select()
      .from(demoDatasetState)
      .where(eq(demoDatasetState.id, 1))
      .limit(1);
    if (row === undefined) {
      return {
        datasetVersion: null,
        expectedDatasetVersion: DEMO_DATASET_VERSION,
        outdated: false,
        seededAt: null,
        seededBy: null,
        lastResetAt: null,
        lastResetBy: null,
        resetInProgress: false,
        resetStartedAt: null,
        resetStale: false,
        lastResetStartedAt: null,
        datasetEpoch: null,
      };
    }
    const resetStale =
      row.resetInProgress &&
      row.resetStartedAt !== null &&
      now.getTime() - row.resetStartedAt.getTime() > DEMO_RESET_STALE_MS;
    return {
      datasetVersion: row.datasetVersion,
      expectedDatasetVersion: DEMO_DATASET_VERSION,
      outdated: row.seededAt !== null && row.datasetVersion < DEMO_DATASET_VERSION,
      seededAt: row.seededAt,
      seededBy: row.seededBy,
      lastResetAt: row.lastResetAt,
      lastResetBy: row.lastResetBy,
      resetInProgress: row.resetInProgress,
      resetStartedAt: row.resetStartedAt,
      resetStale,
      lastResetStartedAt: row.lastResetStartedAt,
      datasetEpoch: row.datasetEpoch,
    };
  }

  /**
   * Phase 14 (offline epoch): aktuelle Generation des Demo-Datensatzes; null,
   * solange keine Zustandszeile existiert (vor dem ersten Seed). Außerhalb der
   * Demo gibt es kein Demo-Modul – dort ist die Epoch immer null.
   */
  async datasetEpoch(): Promise<string | null> {
    const [row] = await this.db
      .select({ datasetEpoch: demoDatasetState.datasetEpoch })
      .from(demoDatasetState)
      .where(eq(demoDatasetState.id, 1))
      .limit(1);
    return row?.datasetEpoch ?? null;
  }

  /** Phase 14 (reset): Beginn des letzten Resets (für den Worker-Guard, siehe `state()`). */
  async lastResetStartedAt(): Promise<Date | null> {
    const [row] = await this.db
      .select({ lastResetStartedAt: demoDatasetState.lastResetStartedAt })
      .from(demoDatasetState)
      .where(eq(demoDatasetState.id, 1))
      .limit(1);
    return row?.lastResetStartedAt ?? null;
  }

  /** Schneller Blick fürs Reset-Gate (nur das Flag, ohne Berechnungen). */
  async resetInProgress(): Promise<boolean> {
    const [row] = await this.db
      .select({ resetInProgress: demoDatasetState.resetInProgress })
      .from(demoDatasetState)
      .where(eq(demoDatasetState.id, 1))
      .limit(1);
    return row?.resetInProgress ?? false;
  }

  /** Sperrt die Singleton-Zeile (legt sie bei Bedarf an) – nur innerhalb einer Transaktion nutzen. */
  async lockRow(tx: DatabaseExecutor): Promise<typeof demoDatasetState.$inferSelect> {
    await tx
      .insert(demoDatasetState)
      .values({ id: 1, datasetVersion: 0 })
      .onConflictDoNothing({ target: demoDatasetState.id });
    const rows = await tx
      .select()
      .from(demoDatasetState)
      .where(eq(demoDatasetState.id, 1))
      .for('update');
    const row = rows[0];
    if (row === undefined) throw new Error('demo_dataset_state: Zeile fehlt');
    return row;
  }

  async markSeeded(
    tx: DatabaseExecutor,
    input: { datasetVersion: number; seededBy: string | null; now: Date },
  ): Promise<void> {
    await this.lockRow(tx);
    await tx
      .update(demoDatasetState)
      .set({
        datasetVersion: input.datasetVersion,
        seededAt: input.now,
        seededBy: input.seededBy,
        updatedAt: input.now,
      })
      .where(eq(demoDatasetState.id, 1));
  }

  async beginReset(
    tx: DatabaseExecutor,
    input: { actorId: string | null; now: Date },
  ): Promise<void> {
    await tx
      .update(demoDatasetState)
      .set({
        resetInProgress: true,
        resetStartedAt: input.now,
        lastResetBy: input.actorId,
        // Phase 14 (reset, Order §21): bewusst die DB-Uhr (`now()`) – dieselbe
        // Uhr wie `integration_jobs.created_at`, gegen die der Worker-Guard
        // vergleicht; ein injiziertes `now` (Tests, Zeitverschiebung) würde den
        // Vergleich sonst verfälschen. Bleibt nach Abschluss stehen.
        lastResetStartedAt: sql`now()`,
        updatedAt: input.now,
      })
      .where(eq(demoDatasetState.id, 1));
  }

  async endReset(
    tx: DatabaseExecutor,
    input: { datasetVersion: number; actorId: string | null; now: Date },
  ): Promise<void> {
    await tx
      .update(demoDatasetState)
      .set({
        resetInProgress: false,
        resetStartedAt: null,
        lastResetAt: input.now,
        lastResetBy: input.actorId,
        datasetVersion: input.datasetVersion,
        seededAt: input.now,
        seededBy: input.actorId,
        // Phase 14 (offline epoch, Order §91/§92): neue Generation – alte
        // Offline-Pakete/-Mutationen gelten ab jetzt nicht mehr.
        datasetEpoch: randomUUID(),
        updatedAt: sql`now()`,
      })
      .where(eq(demoDatasetState.id, 1));
  }
}
