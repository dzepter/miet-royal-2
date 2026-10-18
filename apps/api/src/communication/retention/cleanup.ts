/**
 * Retention der Vorgangs-Kommunikation (Phase 12, Order §25):
 * - Chatfotos (`message_photos`) werden bei Vorgangsabschluss gelöscht
 *   (Storage + `deleted_at`) – NUR Kommunikationsfotos, nie Fach-/Übergabe-/
 *   Rückgabe-/Schadenfotos oder Dokumente (die liegen in anderen Tabellen
 *   und werden hier nicht berührt).
 * - Chattext (`conversation_messages.body`) wird 12 Kalendermonate (Europe/
 *   Berlin) nach `processes.completed_at` geleert (`body_deleted_at`).
 *
 * Auslösung (Order §37, Job `communication.cleanup_retention`):
 * - Listener am Vorgangsabschluss ⇒ Job `…:<processId>:photos:<completedAt>`
 *   (der Zeitstempel im Schlüssel erlaubt einen erneuten Lauf nach Reopen +
 *   erneutem Abschluss; integration_jobs.idempotency_key bleibt UNIQUE).
 * - Backstop aus `communication.scan_due`: Fotos abgeschlossener Vorgänge bei
 *   jedem Lauf (deckt Abschlüsse über den Abrechnungs-Transfer im Worker ab),
 *   Text-Retention täglich (Schlüssel `…:<JJJJ-MM-TT>`).
 * Reopen: bereits geleerte Zeilen/gelöschte Fotos bleiben so; neue
 * Kommunikation läuft normal – erst ein erneuter Abschluss startet den
 * Foto-Lauf und die 12-Monats-Frist neu (completed_at wird neu gesetzt).
 */
import { conversationMessages, messagePhotos, processes, type Database } from '@mietroyal/database';
import { addBerlinCalendarMonths } from '@mietroyal/domain';
import type { JobHandler, JobQueue, JobRunnerLogger } from '@mietroyal/integrations';
import type { StorageProvider } from '@mietroyal/integrations';
import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import type { ProcessCompletionListener } from '../../crm/process-service.ts';
import { ConversationService } from '../conversation/conversation-service.ts';
import { COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE } from '../types.ts';

export const CHAT_TEXT_RETENTION_MONTHS = 12;

export type RetentionJobPayload =
  | { scope: 'photos'; processId: string }
  | { scope: 'backstop'; day: string; textRetention: boolean };

export function retentionPhotosJobKey(processId: string, completedAt: Date): string {
  return `${COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE}:${processId}:photos:${completedAt.toISOString()}`;
}

export function retentionBackstopJobKey(day: string): string {
  return `${COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE}:${day}`;
}

/** Berliner Kalendertag (JJJJ-MM-TT) – Tages-Bucket des Backstops. */
export function berlinDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export interface RetentionCleanupDeps {
  db: Database;
  storage: StorageProvider;
  conversations?: ConversationService;
  logger?: JobRunnerLogger | undefined;
}

export class RetentionCleanupService {
  private readonly conversations: ConversationService;

  constructor(private readonly deps: RetentionCleanupDeps) {
    this.conversations = deps.conversations ?? new ConversationService(deps.db, deps.storage);
  }

  /**
   * Fotos eines ABGESCHLOSSENEN Vorgangs löschen; offene/wieder geöffnete Vorgänge: no-op.
   * Härtung B15: Storage-Fehler ⇒ Zeile bleibt offen (`failed`), Backstop wiederholt.
   */
  async cleanupPhotosForProcess(processId: string): Promise<{ deleted: number; failed: number }> {
    const rows = await this.deps.db
      .select({ mainStatus: processes.mainStatus })
      .from(processes)
      .where(eq(processes.id, processId));
    if (rows[0]?.mainStatus !== 'completed') return { deleted: 0, failed: 0 };
    const result = await this.conversations.deleteChatPhotosForProcess(processId);
    this.logFailures(processId, result);
    return { deleted: result.deleted, failed: result.failed };
  }

  private logFailures(
    processId: string,
    result: { failed: number; errorCode: string | null },
  ): void {
    if (result.failed === 0) return;
    this.deps.logger?.error(
      { processId, failed: result.failed, errorCode: result.errorCode },
      'communication.cleanup_retention: Chatfotos nicht löschbar – Backstop wiederholt',
    );
  }

  /** Alle abgeschlossenen Vorgänge mit noch vorhandenen Chatfotos (Backstop). */
  async cleanupPhotosBackstop(): Promise<{ processes: number; deleted: number; failed: number }> {
    const rows = await this.deps.db
      .selectDistinct({ processId: conversationMessages.processId })
      .from(messagePhotos)
      .innerJoin(conversationMessages, eq(conversationMessages.id, messagePhotos.messageId))
      .innerJoin(processes, eq(processes.id, conversationMessages.processId))
      .where(and(isNull(messagePhotos.deletedAt), eq(processes.mainStatus, 'completed')));
    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.processId === null) continue;
      const result = await this.conversations.deleteChatPhotosForProcess(row.processId);
      this.logFailures(row.processId, result);
      deleted += result.deleted;
      failed += result.failed;
    }
    return { processes: rows.length, deleted, failed };
  }

  /** Chattext aller Vorgänge, deren Abschluss ≥ 12 Kalendermonate zurückliegt. */
  async purgeExpiredChatText(now = new Date()): Promise<{ processes: number; purged: number }> {
    const cutoff = addBerlinCalendarMonths(now, -CHAT_TEXT_RETENTION_MONTHS);
    const rows = await this.deps.db
      .selectDistinct({ processId: conversationMessages.processId })
      .from(conversationMessages)
      .innerJoin(processes, eq(processes.id, conversationMessages.processId))
      .where(
        and(
          isNull(conversationMessages.bodyDeletedAt),
          eq(processes.mainStatus, 'completed'),
          sql`${processes.completedAt} IS NOT NULL`,
          lte(processes.completedAt, cutoff),
        ),
      );
    let purged = 0;
    for (const row of rows) {
      if (row.processId === null) continue;
      purged += (await this.conversations.purgeChatTextForProcess(row.processId, now)).purged;
    }
    return { processes: rows.length, purged };
  }

  /** Backstop-Lauf (aus scan_due): Fotos immer, Text optional (täglich). */
  async runBackstop(now = new Date(), options: { textRetention: boolean }) {
    const photos = await this.cleanupPhotosBackstop();
    const text = options.textRetention
      ? await this.purgeExpiredChatText(now)
      : { processes: 0, purged: 0 };
    return { photos, text };
  }
}

/** Listener am Vorgangsabschluss: Foto-Lösch-Job je Abschluss einreihen. */
export function createRetentionCompletionListener(
  queue: JobQueue,
  logger?: JobRunnerLogger,
): ProcessCompletionListener {
  return {
    processCompleted: async (event) => {
      try {
        await queue.enqueue(
          COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE,
          { scope: 'photos', processId: event.processId } satisfies RetentionJobPayload,
          {
            idempotencyKey: retentionPhotosJobKey(event.processId, event.completedAt),
            maxAttempts: 5,
          },
        );
      } catch (error) {
        // Der Backstop in scan_due holt die Löschung nach – Abschluss bleibt gültig.
        logger?.error(
          { processId: event.processId, errorCode: error instanceof Error ? error.name : 'Error' },
          'communication.cleanup_retention: Job konnte nicht eingereiht werden',
        );
      }
    },
  };
}

export function createCleanupRetentionHandler(deps: {
  retention: RetentionCleanupService;
  logger?: JobRunnerLogger | undefined;
  now?: () => Date;
}): JobHandler {
  return async (job) => {
    const payload = (job.payload ?? {}) as Partial<RetentionJobPayload>;
    const now = deps.now === undefined ? new Date() : deps.now();
    if (payload.scope === 'photos' && typeof payload.processId === 'string') {
      const result = await deps.retention.cleanupPhotosForProcess(payload.processId);
      deps.logger?.info(
        { jobId: job.id, processId: payload.processId, deleted: result.deleted },
        'communication.cleanup_retention: Chatfotos gelöscht',
      );
      return;
    }
    if (payload.scope === 'backstop') {
      const result = await deps.retention.runBackstop(now, {
        textRetention: payload.textRetention === true,
      });
      deps.logger?.info(
        { jobId: job.id, ...result },
        'communication.cleanup_retention: Backstop ausgeführt',
      );
      return;
    }
    throw new Error('communication.cleanup_retention: unbekannte Payload');
  };
}
