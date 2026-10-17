/**
 * Sync-Queue (Phase-8-Order §§27–31, 34–37, 42, Tests 69–80, 109–111).
 *
 * Mutationen werden sequenziell in lokaler Reihenfolge (`seq`) gesendet, eine
 * Mutation erst, wenn alle Abhängigkeiten (`dependsOn`, z. B. Medien vor der
 * Finalisierung) synchronisiert sind. Ergebnisse:
 * - applied  ⇒ `synced` + Receipt, Medien `uploaded`
 * - conflict ⇒ `conflict` + ConflictRecord (kein Retry; bewusst „Erneut anwenden“/„Verwerfen“)
 * - rejected ⇒ `failed_permanent` + ConflictRecord (kein Retry)
 * - transient (Netz/5xx/Timeout) ⇒ `failed_retryable` mit exponentiellem Backoff;
 *   nach `maxAutoRetries` keine automatische Wiederholung mehr (nur „Jetzt synchronisieren“)
 * - Sitzung ungültig ⇒ Lauf endet, Mutation bleibt `pending` (§39)
 * Ein unterbrochener Lauf („syncing“ ohne Ergebnis) wird beim nächsten Lauf
 * erneut gesendet – serverseitige Receipts machen das idempotent (§§28, 63).
 * Bereinigung entfernt nur synchronisierte Mutationen und ausschließlich von
 * ihnen referenzierte Medien nach der Aufräumfrist; pending/conflict nie.
 */
import { toBase64 } from './crypto.ts';
import type {
  ConflictDetails,
  OfflineMutationType,
  SyncMediaInput,
  SyncMutationInput,
} from './mutations.ts';
import type { MutationRecord } from './records.ts';
import type { DecryptedMutation, OfflineStore } from './store.ts';

/** Ein Request je Mutation (POST /staff/offline/sync). */
export type SyncMutationEnvelope = SyncMutationInput;

export type SyncOutcome =
  | { status: 'applied'; resultRef: Record<string, string> | null; processedAt: string }
  | {
      status: 'conflict';
      code: string;
      message: string | null;
      serverState: unknown;
      /** Fachliche Gegenüberstellung des Servers (§4) – wird verschlüsselt mitgespeichert. */
      details?: ConflictDetails | null;
      processedAt: string;
    }
  | {
      status: 'rejected';
      code: string;
      message: string | null;
      serverState?: unknown;
      details?: ConflictDetails | null;
      processedAt: string;
    };

export interface SyncTransport {
  send(envelope: SyncMutationEnvelope): Promise<SyncOutcome>;
}

/** Vorübergehender Fehler (Netz, 5xx, Timeout): Backoff und Retry. */
export class TransientSyncError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? `Vorübergehender Synchronisierungsfehler (${code}).`);
    this.name = 'TransientSyncError';
  }
}

/** Sitzung ungültig/abgelaufen (401): Lauf beenden, alles bleibt pending. */
export class SessionInvalidError extends Error {
  constructor(message = 'Die Sitzung ist nicht mehr gültig.') {
    super(message);
    this.name = 'SessionInvalidError';
  }
}

export interface SyncRunResult {
  attempted: number;
  applied: number;
  conflicts: number;
  rejected: number;
  transientFailures: number;
  sessionInvalid: boolean;
}

export interface SyncEngineOptions {
  now?: () => Date;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  maxAutoRetries?: number;
  cleanupDelayMs?: number;
}

export const DEFAULT_BACKOFF_BASE_MS = 5_000;
export const DEFAULT_BACKOFF_CAP_MS = 5 * 60_000;
export const DEFAULT_MAX_AUTO_RETRIES = 8;
/** Aufräumfrist synchronisierter Mutationen/Medien (§36): 1 h. */
export const DEFAULT_CLEANUP_DELAY_MS = 60 * 60_000;

/** Exponentieller Backoff ohne Jitter (deterministisch testbar): base · 2^(n−1), gedeckelt. */
export function backoffDelayMs(retryCount: number, baseMs: number, capMs: number): number {
  const exponent = Math.max(0, Math.min(retryCount - 1, 30));
  return Math.min(capMs, baseMs * 2 ** exponent);
}

/**
 * Fachliche Eltern-Kind-Beziehungen: das Kind ist ohne das Elternteil sinnlos
 * (Verwerfen kaskadiert, §29). Reine Reihenfolge-Abhängigkeiten (Abschluss
 * wartet auf alle vorherigen Erfassungen) kaskadieren NICHT.
 */
const CHILD_TYPES: Partial<Record<OfflineMutationType, readonly OfflineMutationType[]>> = {
  'return.damage': ['return.damage_photo'],
};

export class SyncEngine {
  private running = false;
  private readonly now: () => Date;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly maxAutoRetries: number;
  private readonly cleanupDelayMs: number;

  constructor(
    private readonly store: OfflineStore,
    private readonly transport: SyncTransport,
    options: SyncEngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffCapMs = options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    this.maxAutoRetries = options.maxAutoRetries ?? DEFAULT_MAX_AUTO_RETRIES;
    this.cleanupDelayMs = options.cleanupDelayMs ?? DEFAULT_CLEANUP_DELAY_MS;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Offene Arbeit: pending + syncing + failed_retryable (nicht synced/conflict/rejected). */
  async pendingCount(): Promise<number> {
    const counts = await this.store.countByStatus();
    return counts.pending + counts.syncing + counts.failed_retryable;
  }

  /** „Prüfung erforderlich“: Konflikte und endgültig abgelehnte Mutationen. */
  async conflictCount(): Promise<number> {
    const counts = await this.store.countByStatus();
    return counts.conflict + counts.failed_permanent;
  }

  /** Eine Mutation ist sendebereit, wenn alle Abhängigkeiten synchronisiert sind. */
  private dependenciesSatisfied(mutation: MutationRecord, all: readonly MutationRecord[]): boolean {
    for (const dependencyId of mutation.dependsOn) {
      const dependency = all.find((m) => m.clientMutationId === dependencyId);
      if (dependency === undefined) continue; // bereits bereinigt/verworfen ⇒ kein Hindernis
      if (dependency.status !== 'synced') return false;
    }
    return true;
  }

  private async envelopeFor(mutation: DecryptedMutation): Promise<SyncMutationEnvelope> {
    const media: SyncMediaInput[] = [];
    for (const mediaId of mutation.mediaIds) {
      const entry = await this.store.getMediaBytes(mediaId);
      if (entry === null) continue;
      media.push({
        mediaId: entry.record.mediaId,
        purpose: entry.record.purpose,
        mimeType: entry.record.mimeType as SyncMediaInput['mimeType'],
        sha256: entry.record.sha256,
        dataBase64: toBase64(entry.bytes),
      });
    }
    return {
      clientMutationId: mutation.clientMutationId,
      type: mutation.type,
      contextKind: mutation.contextKind,
      contextId: mutation.contextId,
      createdAt: mutation.createdAt,
      baseVersion: mutation.baseVersion,
      payload: mutation.payload,
      media,
    };
  }

  private inBackoff(record: MutationRecord, force: boolean): boolean {
    if (force || record.status !== 'failed_retryable') return false;
    // Automatische Versuche erschöpft (nextAttemptAt null): nur noch manuell.
    if (record.nextAttemptAt === null) return true;
    return Date.parse(record.nextAttemptAt) > this.now().getTime();
  }

  /**
   * Einen Sync-Durchlauf ausführen: sequenziell, in Sequenzreihenfolge.
   * `force` ignoriert Backoff-Wartezeiten (manuelles „Jetzt synchronisieren“),
   * `onlyIds` beschränkt den Lauf (z. B. „Erneut anwenden“ eines Konflikts).
   */
  async runOnce(
    options: { force?: boolean; onlyIds?: readonly string[] } = {},
  ): Promise<SyncRunResult> {
    const result: SyncRunResult = {
      attempted: 0,
      applied: 0,
      conflicts: 0,
      rejected: 0,
      transientFailures: 0,
      sessionInvalid: false,
    };
    if (this.running) return result;
    this.running = true;
    try {
      const all = await this.store.listMutationRecords();
      // Unterbrochener Lauf (Seite geschlossen/neu geladen, Tab beendet) hinterlässt
      // „syncing“ ohne Ergebnis: erneut ausstehend. Die Wiederholung ist über die
      // serverseitigen Receipts idempotent (§§28, 63).
      for (const record of all) {
        if (record.status !== 'syncing') continue;
        record.status = 'pending';
        await this.store.updateMutation(
          record.clientMutationId,
          { status: 'pending' },
          this.now().toISOString(),
        );
      }
      for (const record of all) {
        const eligibleStatus = record.status === 'pending' || record.status === 'failed_retryable';
        if (!eligibleStatus) continue;
        if (options.onlyIds !== undefined && !options.onlyIds.includes(record.clientMutationId))
          continue;
        if (!this.dependenciesSatisfied(record, all)) continue;
        if (this.inBackoff(record, options.force === true)) continue;
        const mutation = await this.store.getMutation(record.clientMutationId);
        if (mutation === null) continue;
        result.attempted += 1;
        await this.store.updateMutation(
          record.clientMutationId,
          { status: 'syncing' },
          this.now().toISOString(),
        );
        record.status = 'syncing';
        try {
          const outcome = await this.transport.send(await this.envelopeFor(mutation));
          const processedIso = this.now().toISOString();
          if (outcome.status === 'applied') {
            record.status = 'synced';
            await this.store.updateMutation(
              record.clientMutationId,
              { status: 'synced', lastErrorCode: null, nextAttemptAt: null },
              processedIso,
            );
            await this.store.putReceipt({
              clientMutationId: record.clientMutationId,
              status: 'applied',
              processedAt: outcome.processedAt,
              resultRef: outcome.resultRef,
              code: null,
            });
            for (const mediaId of record.mediaIds) {
              await this.store.updateMedia(mediaId, { status: 'uploaded' });
            }
            await this.store.deleteConflict(record.clientMutationId);
            result.applied += 1;
          } else if (outcome.status === 'conflict') {
            record.status = 'conflict';
            await this.store.updateMutation(
              record.clientMutationId,
              { status: 'conflict', lastErrorCode: outcome.code, nextAttemptAt: null },
              processedIso,
            );
            await this.store.putConflict(record.clientMutationId, {
              code: outcome.code,
              status: 'conflict',
              message: outcome.message,
              serverState: outcome.serverState,
              details: outcome.details ?? null,
              processedAt: outcome.processedAt,
            });
            await this.store.putReceipt({
              clientMutationId: record.clientMutationId,
              status: 'conflict',
              processedAt: outcome.processedAt,
              resultRef: null,
              code: outcome.code,
            });
            result.conflicts += 1;
          } else {
            record.status = 'failed_permanent';
            await this.store.updateMutation(
              record.clientMutationId,
              { status: 'failed_permanent', lastErrorCode: outcome.code, nextAttemptAt: null },
              processedIso,
            );
            await this.store.putConflict(record.clientMutationId, {
              code: outcome.code,
              status: 'rejected',
              message: outcome.message,
              serverState: outcome.serverState ?? null,
              details: outcome.details ?? null,
              processedAt: outcome.processedAt,
            });
            await this.store.putReceipt({
              clientMutationId: record.clientMutationId,
              status: 'rejected',
              processedAt: outcome.processedAt,
              resultRef: null,
              code: outcome.code,
            });
            result.rejected += 1;
          }
        } catch (error) {
          if (error instanceof SessionInvalidError) {
            record.status = 'pending';
            await this.store.updateMutation(
              record.clientMutationId,
              { status: 'pending' },
              this.now().toISOString(),
            );
            result.sessionInvalid = true;
            break;
          }
          const code = error instanceof TransientSyncError ? error.code : 'NETWORK_ERROR';
          const retryCount = record.retryCount + 1;
          const exhausted = retryCount >= this.maxAutoRetries;
          const nextAttemptAt = exhausted
            ? null
            : new Date(
                this.now().getTime() +
                  backoffDelayMs(retryCount, this.backoffBaseMs, this.backoffCapMs),
              ).toISOString();
          record.status = 'failed_retryable';
          record.retryCount = retryCount;
          record.nextAttemptAt = nextAttemptAt;
          await this.store.updateMutation(
            record.clientMutationId,
            { status: 'failed_retryable', retryCount, nextAttemptAt, lastErrorCode: code },
            this.now().toISOString(),
          );
          result.transientFailures += 1;
          // Bei Netzwerkausfall weitere Versuche in diesem Durchlauf sparen.
          if (code === 'NETWORK_ERROR') break;
        }
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  /**
   * Konflikt/Ablehnung erneut versuchen (nach bewusster Prüfung des
   * Serverstands): Status zurück auf pending, Zähler und lokale Konflikt-/
   * Receipt-Daten zurücksetzen – der Server bewertet neu (§64).
   */
  async retryMutation(clientMutationId: string): Promise<void> {
    const nowIso = this.now().toISOString();
    const updated = await this.store.updateMutation(
      clientMutationId,
      { status: 'pending', retryCount: 0, nextAttemptAt: null, lastErrorCode: null },
      nowIso,
    );
    if (updated === null) return;
    await this.store.deleteConflict(clientMutationId);
    await this.store.deleteReceipts([clientMutationId]);
  }

  /**
   * Bewusst verwerfen – einschließlich fachlich abhängiger Kinder (z. B. das
   * Schadenfoto eines verworfenen Schadens, §29). Reine Reihenfolge-Abhängigkeiten
   * (etwa der Abschluss, der auf alle vorherigen Erfassungen wartet) bleiben
   * erhalten und werden nach dem Verwerfen sendebereit. Exklusiv referenzierte
   * Medien werden entfernt. Liefert die verworfenen IDs.
   */
  async discardMutation(clientMutationId: string): Promise<string[]> {
    const all = await this.store.listMutationRecords();
    if (!all.some((m) => m.clientMutationId === clientMutationId)) return [];
    const toDiscard = new Set<string>([clientMutationId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const m of all) {
        if (toDiscard.has(m.clientMutationId)) continue;
        const parents = all.filter(
          (p) => toDiscard.has(p.clientMutationId) && m.dependsOn.includes(p.clientMutationId),
        );
        if (
          m.status !== 'synced' &&
          parents.some((p) => (CHILD_TYPES[p.type] ?? []).includes(m.type))
        ) {
          toDiscard.add(m.clientMutationId);
          grew = true;
        }
      }
    }
    const ids = [...toDiscard];
    const remaining = all.filter((m) => !toDiscard.has(m.clientMutationId));
    const stillReferenced = new Set(remaining.flatMap((m) => m.mediaIds));
    const removable = all
      .filter((m) => toDiscard.has(m.clientMutationId))
      .flatMap((m) => m.mediaIds)
      .filter((id) => !stillReferenced.has(id));
    await this.store.deleteMutations(ids);
    for (const id of ids) await this.store.deleteConflict(id);
    await this.store.deleteReceipts(ids);
    if (removable.length > 0) await this.store.deleteMedia([...new Set(removable)]);
    return ids;
  }

  /**
   * Bereinigung synchronisierter Mutationen/Medien nach der Aufräumfrist (§36).
   * Pending-/Konflikt-Daten (und ihre Medien) werden NIE entfernt (§§35/37).
   */
  async cleanupSynced(): Promise<{ mutations: number; media: number }> {
    const cutoff = this.now().getTime() - this.cleanupDelayMs;
    const all = await this.store.listMutationRecords();
    const removable = all.filter((m) => m.status === 'synced' && Date.parse(m.updatedAt) <= cutoff);
    const removableIds = removable.map((m) => m.clientMutationId);
    if (removableIds.length > 0) {
      await this.store.deleteMutations(removableIds);
      await this.store.deleteReceipts(removableIds);
    }
    const remaining = all.filter((m) => !removableIds.includes(m.clientMutationId));
    const referenced = new Set(remaining.flatMap((m) => m.mediaIds));
    const media = (await this.store.listMediaRecords()).filter(
      (m) =>
        m.status === 'uploaded' && !referenced.has(m.mediaId) && Date.parse(m.createdAt) <= cutoff,
    );
    if (media.length > 0) await this.store.deleteMedia(media.map((m) => m.mediaId));
    return { mutations: removableIds.length, media: media.length };
  }
}
