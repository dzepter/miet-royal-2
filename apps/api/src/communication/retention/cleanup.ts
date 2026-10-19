/**
 * Retention der Kommunikation (Phase 12, Order §25; Phase-12-Finalisierung §4).
 *
 * Terminal = `completed` ODER `cancelled` (retention/terminal.ts), Terminal-
 * zeitpunkt = `processes.completed_at` bzw. `processes.cancelled_at` (der von
 * beiden Storno-Wegen in `ProcessService.markCancelledWithin` geschriebene
 * fachliche Stornozeitpunkt).
 *
 * 1. Eintritt in terminal (Listener am Abschluss UND am Storno ⇒ Job
 *    `…:<processId>:photos:<terminalAt>`; Backstop in scan_due alle 2 min):
 *    - Retention-Anker: alle Konversationszeilen und prozessgebundenen
 *      mail_deliveries des Vorgangs mit `retention_anchor_at IS NULL` erhalten
 *      den Terminalzeitpunkt. Reopen setzt nichts zurück; danach entstehende
 *      Zeilen bleiben NULL bis zum nächsten Terminalzustand (neuer Zeitpunkt).
 *      Später einem terminalen Vorgang zugeordnete Zeilen (In-Reply-To,
 *      manuelle Zuordnung) erhalten beim nächsten Backstop den AKTUELLEN
 *      Terminalzeitpunkt.
 *    - Chatfotos (`message_photos`) werden sofort gelöscht (Storage +
 *      `deleted_at`, Härtung B15: deletedAt erst nach erfolgreichem Löschen,
 *      StorageObjectNotFoundError = Erfolg). NUR Kommunikationsfotos – nie
 *      Übergabe-/Rückgabe-/Schadens-/Defektfotos, Signaturen oder Dokumente
 *      (andere Tabellen, hier nie berührt).
 *    - Snapshot-Semantik (Review-Fund Reopen-Rennen): Der Job wirkt IMMER nur
 *      auf Zeilen, die zum Terminalzeitpunkt T der Payload (Altpayload ohne
 *      Zeitpunkt: aktueller Terminalzeitpunkt) bereits zum Vorgang gehörten
 *      (`COALESCE(assigned_at, created_at) ≤ T`) – unabhängig davon, ob der
 *      Vorgang inzwischen wieder geöffnet ist. Neue Kommunikation nach einem
 *      Reopen bleibt unberührt; später einem terminalen Vorgang zugeordnete
 *      Zeilen erledigen `deletePhotosIfProcessTerminal` + Backstop.
 *    - Scheitert das Löschen eines Fotos (Storage), endet der Job nach getaner
 *      Arbeit mit einem neutralen Fehler ⇒ Queue-Retry (maxAttempts 5); dank
 *      Snapshot wirkt der Retry auch nach einem schnellen Reopen (der Backstop
 *      greift dann nicht mehr). Anker sind idempotent.
 *    - Backstop-Fotolöschung prüft den Terminalzustand in DERSELBEN SQL-
 *      Anweisung wie die Fotoauswahl (konsistenter Statement-Snapshot).
 * 2. Täglicher Backstop (`communication.cleanup_retention:<JJJJ-MM-TT>`):
 *    - Chattext: Anker + 12 Berliner Kalendermonate ≤ now ⇒ PII-Minimierung
 *      (`ConversationService.scrubMessages`, Modus `matched`).
 *    - mail_deliveries: prozessgebunden Anker + 12 Berliner Kalendermonate,
 *      nicht prozessgebunden 90 Berliner Kalendertage nach dem Endzustand
 *      (sent ⇒ sent_at; failed/blocked/outcome_unknown ⇒ updated_at = der
 *      persistierte Zeitpunkt des letzten Statuswechsels) ⇒ Empfänger,
 *      Betreff, Kontext, Anhänge, In-Reply-To, Secret-Payload entfernt;
 *      pending/retry/sending NIE. Verknüpfte Systemereignisse der Konversation
 *      werden gleichermaßen minimiert. Danach kein Resend.
 *    - Unzugeordnet/ignoriert (processId NULL) und Belege unmatched/ignored/
 *      rejected: 90 Berliner Kalendertage nach dem Eingang ⇒ Text/Betreff/
 *      Absender leer, Chatfotos gelöscht, Beleg ohne Absender/Betreff;
 *      technische Minimaldaten (mailbox, UIDVALIDITY, UID, Status, receivedAt,
 *      Fingerprint, message_id_hash) bleiben ⇒ IMAP-Dedupe funktioniert weiter.
 *      Bezugszeitpunkt = ausschließlich `created_at` (serverseitiger Eingang/
 *      Speicherung): `received_at` ist absendergesteuert (Date-Header bzw.
 *      WhatsApp-Zeitstempel) – ein zurück- oder vorausdatierter Header darf
 *      die Frist weder verkürzen noch verlängern (Review-Fund). Auswahl und
 *      Wirkung prüfen „unzugeordnet“ bzw. den Belegstatus in DERSELBEN
 *      Anweisung (eine Zuordnung dazwischen lässt Nachricht/Foto unberührt).
 *    - WhatsApp: Kontakte ohne Kunde, deren letzte Nachricht > 90 Tage
 *      zurückliegt, werden gelöscht (wa_id = Telefonnummer; keine Referenz
 *      zeigt auf whatsapp_contacts, das 24-h-Fenster ist längst geschlossen,
 *      eine neue Nachricht legt die Zeile neu an). whatsapp_events enthalten
 *      nur IDs/Typ/Status/Codes – die wamid ist aber base64-kodiert aus der
 *      wa_id abgeleitet ⇒ nach 90 Tagen nur noch als `sha256:<hex>` (Metas
 *      Webhook-Wiederholungen enden nach Tagen; die Zeile bleibt als Beleg).
 *      Ebenso Altschlüssel `whatsapp.media_fetch:<wamid>` in integration_jobs
 *      (neue Jobs: `whatsapp.media_fetch:<conversationMessageId>`) ⇒
 *      `whatsapp.media_fetch:sha256:<hex>`.
 * Alle Schritte sind idempotent (`pii_scrubbed_at IS NULL` bzw. `deleted_at
 * IS NULL`) und at-least-once-sicher.
 */
import {
  conversationMessages,
  inboundMailReceipts,
  mailDeliveries,
  messagePhotos,
  processes,
  type Database,
} from '@mietroyal/database';
import { addBerlinCalendarDays, addBerlinCalendarMonths } from '@mietroyal/domain';
import type { JobHandler, JobQueue, JobRunnerLogger } from '@mietroyal/integrations';
import type { StorageProvider } from '@mietroyal/integrations';
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { ProcessCompletionListener } from '../../crm/process-service.ts';
import { ConversationService } from '../conversation/conversation-service.ts';
import {
  COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE,
  WHATSAPP_MEDIA_FETCH_JOB_TYPE,
} from '../types.ts';
import {
  PROCESS_TERMINAL_AT_SQL,
  PROCESS_TERMINAL_STATUSES,
  processTerminalAt,
} from './terminal.ts';

export const CHAT_TEXT_RETENTION_MONTHS = 12;
/** Unzugeordnete/ignorierte Nachrichten und Belege (Finalisierung §4.4). */
export const UNMATCHED_RETENTION_DAYS = 90;
/** Nicht prozessgebundene Zustellungen nach Endzustand (Finalisierung §4.6). */
export const UNBOUND_DELIVERY_RETENTION_DAYS = 90;
/** WhatsApp-Kontakte ohne Kunde / wamids in whatsapp_events. */
export const WHATSAPP_TECHNICAL_RETENTION_DAYS = 90;
/** Endzustände, in denen eine Zustellung bereinigt werden darf (nie pending/retry/sending). */
export const MAIL_DELIVERY_SCRUBBABLE_STATUSES = [
  'sent',
  'failed',
  'blocked',
  'outcome_unknown',
] as const;

const BATCH_SIZE = 500;
/** Neue `whatsapp.media_fetch`-Schlüssel tragen die Konversationszeilen-ID (UUID). */
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const MAX_BATCHES = 1000;

export type RetentionJobPayload =
  | { scope: 'photos'; processId: string; terminalAt?: string }
  | { scope: 'backstop'; day: string; textRetention: boolean };

export function retentionPhotosJobKey(processId: string, terminalAt: Date): string {
  return `${COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE}:${processId}:photos:${terminalAt.toISOString()}`;
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

/** Exakte Fälligkeit: Anker + 12 Berliner Kalendermonate ≤ now (zentrale Domänenfunktion). */
export function isTwelveMonthRetentionDue(anchor: Date, now: Date): boolean {
  return addBerlinCalendarMonths(anchor, CHAT_TEXT_RETENTION_MONTHS).getTime() <= now.getTime();
}

/**
 * Grobe SQL-Vorauswahl (Obermenge) für die 12-Monats-Frist: Monatsende-
 * Kappung (29.02. + 12 Monate = 28.02.) und Zeitumstellung verschieben die
 * exakte Grenze um höchstens einen Tag – exakt entschieden wird je Zeile mit
 * `isTwelveMonthRetentionDue`.
 */
function twelveMonthCandidateCutoff(now: Date): Date {
  return addBerlinCalendarDays(addBerlinCalendarMonths(now, -CHAT_TEXT_RETENTION_MONTHS), 2);
}

export interface RetentionCleanupDeps {
  db: Database;
  storage: StorageProvider;
  conversations?: ConversationService;
  logger?: JobRunnerLogger | undefined;
}

export interface AnchorStampResult {
  messages: number;
  deliveries: number;
}

export interface PhotoCleanupResult {
  deleted: number;
  failed: number;
}

export interface TerminalCleanupResult extends PhotoCleanupResult {
  /** `snapshot` = Anker/Fotos nur für Zeilen ≤ T; `noop` = kein Terminalzeitpunkt bekannt. */
  mode: 'snapshot' | 'noop';
  /** Verwendeter Snapshot-Zeitpunkt T (null bei `noop`). */
  terminalAt: Date | null;
  anchors: AnchorStampResult;
}

/**
 * Terminal-Job: mindestens ein Chatfoto war nicht löschbar (Storage) ⇒ neutraler
 * Fehler NACH getaner Arbeit, damit die Queue den Job wiederholt (Snapshot ⇒
 * wirkt auch nach einem Reopen). Meldung ohne Daten (nur Zähler im Log).
 */
export class RetentionPhotoDeletePendingError extends Error {
  constructor() {
    super('communication.cleanup_retention: Chatfotos nicht löschbar – erneuter Versuch');
    this.name = 'RetentionPhotoDeletePendingError';
  }
}

export interface DeliveryPurgeResult {
  processBound: number;
  unbound: number;
  systemEvents: number;
}

export interface UnmatchedPurgeResult {
  messages: number;
  receipts: number;
  photosDeleted: number;
  photosFailed: number;
}

export interface WhatsAppPurgeResult {
  contactsDeleted: number;
  eventsHashed: number;
  eventsDeduplicated: number;
  /** Altschlüssel `whatsapp.media_fetch:<wamid>` in integration_jobs ⇒ `…:sha256:<hex>`. */
  mediaJobKeysHashed: number;
}

export interface RetentionBackstopResult {
  anchors: AnchorStampResult;
  photos: { processes: number; deleted: number; failed: number };
  text: { processes: number; purged: number };
  deliveries: DeliveryPurgeResult;
  unmatched: UnmatchedPurgeResult;
  whatsapp: WhatsAppPurgeResult;
}

function rowCount(result: unknown): number {
  const count = (result as { rowCount?: unknown } | null)?.rowCount;
  return typeof count === 'number' ? count : 0;
}

export class RetentionCleanupService {
  private readonly conversations: ConversationService;

  constructor(private readonly deps: RetentionCleanupDeps) {
    this.conversations = deps.conversations ?? new ConversationService(deps.db, deps.storage);
  }

  private logFailures(
    processId: string | null,
    result: { failed: number; errorCode: string | null },
  ): void {
    if (result.failed === 0) return;
    this.deps.logger?.error(
      { processId, failed: result.failed, errorCode: result.errorCode },
      'communication.cleanup_retention: Chatfotos nicht löschbar – Job-Retry bzw. Backstop wiederholt',
    );
  }

  // ── Eintritt in terminal ────────────────────────────────────────────────

  /**
   * Fotos eines TERMINALEN (abgeschlossenen oder stornierten) Vorgangs löschen;
   * offene/wieder geöffnete Vorgänge: no-op.
   * Härtung B15: Storage-Fehler ⇒ Zeile bleibt offen (`failed`), Backstop wiederholt.
   */
  async cleanupPhotosForProcess(processId: string): Promise<PhotoCleanupResult> {
    // Terminalprüfung in derselben Anweisung wie die Fotoauswahl (Reopen-Rennen).
    const result = await this.conversations.deleteChatPhotosForProcess(processId, {
      onlyWhileTerminal: true,
    });
    this.logFailures(processId, result);
    return { deleted: result.deleted, failed: result.failed };
  }

  /**
   * Retention-Anker eines Vorgangs setzen (nur Zeilen ohne Anker). `joinedBefore`:
   * nur Zeilen, die zu diesem Zeitpunkt schon zum Vorgang gehörten (Snapshot).
   */
  async stampAnchorsForProcess(
    processId: string,
    anchorAt: Date,
    joinedBefore?: Date,
  ): Promise<AnchorStampResult> {
    const messages = await this.deps.db
      .update(conversationMessages)
      .set({ retentionAnchorAt: anchorAt })
      .where(
        and(
          eq(conversationMessages.processId, processId),
          isNull(conversationMessages.retentionAnchorAt),
          ...(joinedBefore === undefined
            ? []
            : [
                lte(
                  sql`COALESCE(${conversationMessages.assignedAt}, ${conversationMessages.createdAt})`,
                  joinedBefore,
                ),
              ]),
        ),
      )
      .returning({ id: conversationMessages.id });
    const deliveries = await this.deps.db
      .update(mailDeliveries)
      .set({ retentionAnchorAt: anchorAt })
      .where(
        and(
          eq(mailDeliveries.processId, processId),
          isNull(mailDeliveries.retentionAnchorAt),
          ...(joinedBefore === undefined ? [] : [lte(mailDeliveries.createdAt, joinedBefore)]),
        ),
      )
      .returning({ id: mailDeliveries.id });
    return { messages: messages.length, deliveries: deliveries.length };
  }

  /**
   * Job des Terminal-Listeners: Anker setzen + Chatfotos sofort löschen – IMMER
   * mit Snapshot-Semantik zu T = `terminalAt` der Payload (Altpayload ohne
   * Zeitpunkt: aktueller Terminalzeitpunkt, sonst no-op). Wirkt nur auf Zeilen
   * mit `COALESCE(assigned_at, created_at) ≤ T` (Zustellungen: `created_at ≤
   * T`), unabhängig davon, ob der Vorgang inzwischen wieder geöffnet oder
   * erneut terminal ist – keine Status-Lese-dann-Schreib-Lücke (Review-Fund
   * Reopen-Rennen). Spätere Zuordnungen zu einem terminalen Vorgang erledigen
   * `deletePhotosIfProcessTerminal` und der Backstop.
   */
  async runTerminalCleanup(
    processId: string,
    terminalAt: Date | null,
  ): Promise<TerminalCleanupResult> {
    let snapshotAt = terminalAt;
    if (snapshotAt === null) {
      const rows = await this.deps.db
        .select({
          mainStatus: processes.mainStatus,
          completedAt: processes.completedAt,
          cancelledAt: processes.cancelledAt,
        })
        .from(processes)
        .where(eq(processes.id, processId));
      snapshotAt = rows[0] === undefined ? null : processTerminalAt(rows[0]);
    }
    if (snapshotAt === null) {
      return {
        mode: 'noop',
        terminalAt: null,
        anchors: { messages: 0, deliveries: 0 },
        deleted: 0,
        failed: 0,
      };
    }
    const anchors = await this.stampAnchorsForProcess(processId, snapshotAt, snapshotAt);
    const photos = await this.conversations.deleteChatPhotosForProcess(processId, {
      joinedBefore: snapshotAt,
    });
    this.logFailures(processId, photos);
    return {
      mode: 'snapshot',
      terminalAt: snapshotAt,
      anchors,
      deleted: photos.deleted,
      failed: photos.failed,
    };
  }

  /**
   * Backstop: alle terminalen Vorgänge – Zeilen ohne Anker erhalten den AKTUELLEN
   * Terminalzeitpunkt. Je Tabelle EIN `UPDATE … FROM processes` (Review-Fund
   * Reopen-Rennen, bestätigt konsistent): Status und Zielzeilen stammen aus
   * demselben Statement-Snapshot – nach einem Reopen committete Nachrichten sind
   * nie enthalten, ein vor dem Statement committeter Reopen schließt den Vorgang aus.
   */
  async stampAnchorsBackstop(): Promise<AnchorStampResult> {
    const messages = await this.deps.db.execute(
      sql.raw(`UPDATE conversation_messages m
          SET retention_anchor_at = ${PROCESS_TERMINAL_AT_SQL}
         FROM processes p
        WHERE m.process_id = p.id
          AND m.retention_anchor_at IS NULL
          AND p.main_status IN ('completed', 'cancelled')
          AND ${PROCESS_TERMINAL_AT_SQL} IS NOT NULL`),
    );
    const deliveries = await this.deps.db.execute(
      sql.raw(`UPDATE mail_deliveries d
          SET retention_anchor_at = ${PROCESS_TERMINAL_AT_SQL}
         FROM processes p
        WHERE d.process_id = p.id
          AND d.retention_anchor_at IS NULL
          AND p.main_status IN ('completed', 'cancelled')
          AND ${PROCESS_TERMINAL_AT_SQL} IS NOT NULL`),
    );
    return { messages: rowCount(messages), deliveries: rowCount(deliveries) };
  }

  /**
   * Alle terminalen Vorgänge mit noch vorhandenen Chatfotos (Backstop). Die
   * Vorgangsliste ist nur eine Vorauswahl: die Fotoauswahl je Vorgang prüft den
   * Terminalzustand in DERSELBEN Anweisung (`onlyWhileTerminal`) – ein Reopen
   * zwischen Liste und Löschung lässt alle Fotos dieses Vorgangs unberührt.
   */
  async cleanupPhotosBackstop(): Promise<{ processes: number; deleted: number; failed: number }> {
    const rows = await this.deps.db
      .selectDistinct({ processId: conversationMessages.processId })
      .from(messagePhotos)
      .innerJoin(conversationMessages, eq(conversationMessages.id, messagePhotos.messageId))
      .innerJoin(processes, eq(processes.id, conversationMessages.processId))
      .where(
        and(
          isNull(messagePhotos.deletedAt),
          inArray(processes.mainStatus, [...PROCESS_TERMINAL_STATUSES]),
        ),
      );
    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.processId === null) continue;
      const result = await this.conversations.deleteChatPhotosForProcess(row.processId, {
        onlyWhileTerminal: true,
      });
      this.logFailures(row.processId, result);
      deleted += result.deleted;
      failed += result.failed;
    }
    return { processes: rows.length, deleted, failed };
  }

  // ── Fristen (täglich) ──────────────────────────────────────────────────

  /** Chattext/PII aller Zeilen, deren Retention-Anker ≥ 12 Berliner Kalendermonate zurückliegt. */
  async purgeExpiredChatText(now = new Date()): Promise<{ processes: number; purged: number }> {
    await this.stampAnchorsBackstop();
    const cutoff = twelveMonthCandidateCutoff(now);
    const processIds = new Set<string>();
    let purged = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const rows = await this.deps.db
        .select({
          id: conversationMessages.id,
          processId: conversationMessages.processId,
          anchor: conversationMessages.retentionAnchorAt,
        })
        .from(conversationMessages)
        .where(
          and(
            isNull(conversationMessages.piiScrubbedAt),
            isNotNull(conversationMessages.retentionAnchorAt),
            lte(conversationMessages.retentionAnchorAt, cutoff),
          ),
        )
        .orderBy(asc(conversationMessages.retentionAnchorAt), asc(conversationMessages.id))
        .limit(BATCH_SIZE);
      const due = rows.filter(
        (row) => row.anchor !== null && isTwelveMonthRetentionDue(row.anchor, now),
      );
      if (due.length > 0) {
        const result = await this.conversations.scrubMessages(
          due.map((row) => row.id),
          now,
          'matched',
        );
        purged += result.scrubbed;
        for (const row of due) if (row.processId !== null) processIds.add(row.processId);
      }
      // Sortiert nach Anker: die erste nicht fällige Zeile beendet den Lauf.
      if (due.length < rows.length || rows.length < BATCH_SIZE) break;
    }
    return { processes: processIds.size, purged };
  }

  /** mail_deliveries: Empfänger/Betreff/Kontext/Anhänge/Secrets nach Frist entfernen. */
  async purgeExpiredDeliveries(now = new Date()): Promise<DeliveryPurgeResult> {
    await this.stampAnchorsBackstop();
    const scrubbable = inArray(mailDeliveries.status, [...MAIL_DELIVERY_SCRUBBABLE_STATUSES]);
    let processBound = 0;
    let unbound = 0;
    let systemEvents = 0;

    // Prozessgebunden: Anker + 12 Berliner Kalendermonate.
    const cutoff = twelveMonthCandidateCutoff(now);
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const rows = await this.deps.db
        .select({ id: mailDeliveries.id, anchor: mailDeliveries.retentionAnchorAt })
        .from(mailDeliveries)
        .where(
          and(
            isNotNull(mailDeliveries.processId),
            isNull(mailDeliveries.piiScrubbedAt),
            isNotNull(mailDeliveries.retentionAnchorAt),
            lte(mailDeliveries.retentionAnchorAt, cutoff),
            scrubbable,
          ),
        )
        .orderBy(asc(mailDeliveries.retentionAnchorAt), asc(mailDeliveries.id))
        .limit(BATCH_SIZE);
      const due = rows.filter(
        (row) => row.anchor !== null && isTwelveMonthRetentionDue(row.anchor, now),
      );
      if (due.length > 0) {
        const result = await this.scrubDeliveries(
          due.map((row) => row.id),
          now,
        );
        processBound += result.deliveries;
        systemEvents += result.systemEvents;
      }
      if (due.length < rows.length || rows.length < BATCH_SIZE) break;
    }

    // Nicht prozessgebunden: 90 Berliner Kalendertage nach dem Endzustand.
    const unboundCutoff = addBerlinCalendarDays(now, -UNBOUND_DELIVERY_RETENTION_DAYS);
    const endedAt = sql`CASE WHEN ${mailDeliveries.status} = 'sent'
      THEN COALESCE(${mailDeliveries.sentAt}, ${mailDeliveries.updatedAt})
      ELSE ${mailDeliveries.updatedAt} END`;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const rows = await this.deps.db
        .select({ id: mailDeliveries.id })
        .from(mailDeliveries)
        .where(
          and(
            isNull(mailDeliveries.processId),
            isNull(mailDeliveries.piiScrubbedAt),
            scrubbable,
            lte(endedAt, unboundCutoff),
          ),
        )
        .limit(BATCH_SIZE);
      if (rows.length === 0) break;
      const result = await this.scrubDeliveries(
        rows.map((row) => row.id),
        now,
      );
      unbound += result.deliveries;
      systemEvents += result.systemEvents;
      if (rows.length < BATCH_SIZE || result.deliveries === 0) break;
    }
    return { processBound, unbound, systemEvents };
  }

  /**
   * Zustellungen bereinigen (Audit-Rest bleibt: id, kind, processId/customerId/
   * bookingId, Status, Idempotenzschlüssel, Message-ID, Versuche, Zeiten,
   * neutrale Codes, Vorlagenart/-version). Status wird im UPDATE erneut geprüft
   * (nie eine laufende Zustellung). Verknüpfte Systemereignisse ⇒ `matched`-Scrub.
   */
  private async scrubDeliveries(
    ids: readonly string[],
    now: Date,
  ): Promise<{ deliveries: number; systemEvents: number }> {
    if (ids.length === 0) return { deliveries: 0, systemEvents: 0 };
    const updated = await this.deps.db
      .update(mailDeliveries)
      .set({
        recipientEmail: null,
        recipientName: null,
        subject: null,
        context: {},
        attachments: [],
        inReplyToMessageId: null,
        secretPayloadCiphertext: null,
        piiScrubbedAt: now,
      })
      .where(
        and(
          inArray(mailDeliveries.id, [...ids]),
          isNull(mailDeliveries.piiScrubbedAt),
          inArray(mailDeliveries.status, [...MAIL_DELIVERY_SCRUBBABLE_STATUSES]),
        ),
      )
      .returning({ id: mailDeliveries.id });
    if (updated.length === 0) return { deliveries: 0, systemEvents: 0 };
    const events = await this.deps.db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          inArray(
            conversationMessages.mailDeliveryId,
            updated.map((row) => row.id),
          ),
          eq(conversationMessages.isSystemEvent, true),
          isNull(conversationMessages.piiScrubbedAt),
        ),
      );
    const scrubbed = await this.conversations.scrubMessages(
      events.map((row) => row.id),
      now,
      'matched',
    );
    return { deliveries: updated.length, systemEvents: scrubbed.scrubbed };
  }

  /**
   * Unzugeordnete/ignorierte Nachrichten + Belege unmatched/ignored/rejected nach
   * 90 Tagen. Bezugszeitpunkt ausschließlich `created_at` (serverseitig; der
   * absendergesteuerte `received_at` verkürzt/verlängert die Frist nie).
   */
  async purgeUnmatched(now = new Date()): Promise<UnmatchedPurgeResult> {
    const cutoff = addBerlinCalendarDays(now, -UNMATCHED_RETENTION_DAYS);
    const unmatchedDue = and(
      isNull(conversationMessages.processId),
      lte(conversationMessages.createdAt, cutoff),
    );

    // 1. Chatfotos (unabhängig vom Text-Scrub, damit ein Storage-Fehler beim
    //    nächsten Lauf erneut versucht wird – Härtung B15). Die Löschung prüft
    //    „noch unzugeordnet“ erneut in ihrer Fotoauswahl (`onlyUnassigned`).
    let photosDeleted = 0;
    let photosFailed = 0;
    const photoMessages = await this.deps.db
      .selectDistinct({ id: conversationMessages.id })
      .from(messagePhotos)
      .innerJoin(conversationMessages, eq(conversationMessages.id, messagePhotos.messageId))
      .where(and(isNull(messagePhotos.deletedAt), unmatchedDue));
    for (let i = 0; i < photoMessages.length; i += BATCH_SIZE) {
      const result = await this.conversations.deleteChatPhotosForMessages(
        photoMessages.slice(i, i + BATCH_SIZE).map((row) => row.id),
        { onlyUnassigned: true },
      );
      this.logFailures(null, result);
      photosDeleted += result.deleted;
      photosFailed += result.failed;
    }

    // 2. Text/Betreff/Absender (+ verknüpfte Belege).
    let messages = 0;
    let receipts = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const rows = await this.deps.db
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(and(unmatchedDue, isNull(conversationMessages.piiScrubbedAt)))
        .limit(BATCH_SIZE);
      if (rows.length === 0) break;
      const result = await this.conversations.scrubMessages(
        rows.map((row) => row.id),
        now,
        'unmatched',
      );
      messages += result.scrubbed;
      receipts += result.receipts;
      if (rows.length < BATCH_SIZE || result.scrubbed === 0) break;
    }

    // 3. Belege ohne (zugeordnete) Konversationszeile: unmatched/ignored/rejected (Quarantäne).
    //    Status + Frist in DERSELBEN UPDATE-Bedingung (Zuordnung setzt `matched`).
    const receiptRows = await this.deps.db
      .update(inboundMailReceipts)
      .set({ fromAddress: null, subject: null, piiScrubbedAt: now })
      .where(
        and(
          inArray(inboundMailReceipts.status, ['unmatched', 'ignored', 'rejected']),
          isNull(inboundMailReceipts.piiScrubbedAt),
          lte(inboundMailReceipts.createdAt, cutoff),
        ),
      )
      .returning({ id: inboundMailReceipts.id });
    receipts += receiptRows.length;
    return { messages, receipts, photosDeleted, photosFailed };
  }

  /** WhatsApp: Kontakte ohne Kunde (> 90 Tage) löschen, wamids in whatsapp_events hashen. */
  async purgeWhatsAppTechnical(now = new Date()): Promise<WhatsAppPurgeResult> {
    const cutoff = addBerlinCalendarDays(now, -WHATSAPP_TECHNICAL_RETENTION_DAYS).toISOString();
    const contacts = await this.deps.db.execute(
      sql`DELETE FROM whatsapp_contacts
           WHERE customer_id IS NULL
             AND COALESCE(last_inbound_at, updated_at) <= ${cutoff}::timestamptz`,
    );
    const hashed = sql.raw(
      `'sha256:' || encode(sha256(convert_to(e.provider_message_id, 'UTF8')), 'hex')`,
    );
    const events = await this.deps.db.execute(
      sql`UPDATE whatsapp_events e
             SET provider_message_id = ${hashed}
           WHERE e.received_at <= ${cutoff}::timestamptz
             AND e.provider_message_id NOT LIKE 'sha256:%'
             AND e.provider_message_id NOT LIKE 'outbound:%'
             AND NOT EXISTS (
               SELECT 1 FROM whatsapp_events d
                WHERE d.event_type = e.event_type AND d.provider_message_id = ${hashed}
             )`,
    );
    // Rest = verspätete Wiederholung eines bereits gehashten Ereignisses (gleiche wamid + Typ).
    const duplicates = await this.deps.db.execute(
      sql`DELETE FROM whatsapp_events e
           WHERE e.received_at <= ${cutoff}::timestamptz
             AND e.provider_message_id NOT LIKE 'sha256:%'
             AND e.provider_message_id NOT LIKE 'outbound:%'`,
    );
    const mediaJobKeysHashed = await this.hashLegacyMediaJobKeys(cutoff);
    return {
      contactsDeleted: rowCount(contacts),
      eventsHashed: rowCount(events),
      eventsDeduplicated: rowCount(duplicates),
      mediaJobKeysHashed,
    };
  }

  /**
   * Review-Fund (wamid in integration_jobs): Altschlüssel
   * `whatsapp.media_fetch:<wamid>` (vor der Umstellung auf die Konversations-
   * zeilen-ID) älter als 90 Tage ⇒ `whatsapp.media_fetch:sha256:<hex>` (gleiche
   * Hash-Berechnung wie whatsapp_events). Neue Schlüssel (UUID) und bereits
   * gehashte bleiben. UNIQUE: kollidiert der Hash (praktisch ausgeschlossen),
   * erhält die Zeile zusätzlich ihre Job-ID als Suffix – nie Klartext übrig.
   */
  private async hashLegacyMediaJobKeys(cutoff: string): Promise<number> {
    const prefix = `${WHATSAPP_MEDIA_FETCH_JOB_TYPE}:`;
    const legacy = sql`j.type = ${WHATSAPP_MEDIA_FETCH_JOB_TYPE}
             AND j.created_at <= ${cutoff}::timestamptz
             AND starts_with(j.idempotency_key, ${prefix})
             AND NOT starts_with(j.idempotency_key, ${`${prefix}sha256:`})
             AND substr(j.idempotency_key, ${prefix.length + 1}) !~ ${UUID_PATTERN}`;
    const hashed = sql`${`${prefix}sha256:`} || encode(sha256(convert_to(substr(j.idempotency_key, ${prefix.length + 1}), 'UTF8')), 'hex')`;
    const first = await this.deps.db.execute(
      sql`UPDATE integration_jobs j
             SET idempotency_key = ${hashed}
           WHERE ${legacy}
             AND NOT EXISTS (SELECT 1 FROM integration_jobs d WHERE d.idempotency_key = ${hashed})`,
    );
    const rest = await this.deps.db.execute(
      sql`UPDATE integration_jobs j
             SET idempotency_key = ${hashed} || ':' || j.id::text
           WHERE ${legacy}`,
    );
    return rowCount(first) + rowCount(rest);
  }

  /** 2-min-Backstop (scan_due): Anker + Chatfotos terminaler Vorgänge. */
  async runFrequentBackstop(): Promise<{
    anchors: AnchorStampResult;
    photos: { processes: number; deleted: number; failed: number };
  }> {
    const anchors = await this.stampAnchorsBackstop();
    const photos = await this.cleanupPhotosBackstop();
    return { anchors, photos };
  }

  /** Backstop-Lauf (Job): Anker + Fotos immer, Fristen optional (täglich). */
  async runBackstop(
    now = new Date(),
    options: { textRetention: boolean },
  ): Promise<RetentionBackstopResult> {
    const { anchors, photos } = await this.runFrequentBackstop();
    if (!options.textRetention) {
      return {
        anchors,
        photos,
        text: { processes: 0, purged: 0 },
        deliveries: { processBound: 0, unbound: 0, systemEvents: 0 },
        unmatched: { messages: 0, receipts: 0, photosDeleted: 0, photosFailed: 0 },
        whatsapp: {
          contactsDeleted: 0,
          eventsHashed: 0,
          eventsDeduplicated: 0,
          mediaJobKeysHashed: 0,
        },
      };
    }
    const text = await this.purgeExpiredChatText(now);
    const deliveries = await this.purgeExpiredDeliveries(now);
    const unmatched = await this.purgeUnmatched(now);
    const whatsapp = await this.purgeWhatsAppTechnical(now);
    return { anchors, photos, text, deliveries, unmatched, whatsapp };
  }
}

/**
 * Listener am Eintritt in terminal: Abschluss UND Storno reihen je
 * Terminalzeitpunkt einen Job ein (Anker + Chatfotos sofort). Der Zeitstempel
 * im Schlüssel erlaubt einen erneuten Lauf nach Reopen + erneutem Terminal-
 * zustand; integration_jobs.idempotency_key bleibt UNIQUE.
 */
export function createRetentionCompletionListener(
  queue: JobQueue,
  logger?: JobRunnerLogger,
): ProcessCompletionListener & {
  processCancelled(event: { processId: string; cancelledAt: Date }): Promise<void>;
} {
  const enqueue = async (processId: string, terminalAt: Date): Promise<void> => {
    try {
      await queue.enqueue(
        COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE,
        {
          scope: 'photos',
          processId,
          terminalAt: terminalAt.toISOString(),
        } satisfies RetentionJobPayload,
        { idempotencyKey: retentionPhotosJobKey(processId, terminalAt), maxAttempts: 5 },
      );
    } catch (error) {
      // Der Backstop in scan_due holt die Arbeit nach – Abschluss/Storno bleibt gültig.
      logger?.error(
        { processId, errorCode: error instanceof Error ? error.name : 'Error' },
        'communication.cleanup_retention: Job konnte nicht eingereiht werden',
      );
    }
  };
  return {
    processCompleted: (event) => enqueue(event.processId, event.completedAt),
    processCancelled: (event) => enqueue(event.processId, event.cancelledAt),
  };
}

function parseTerminalAt(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function createCleanupRetentionHandler(deps: {
  retention: RetentionCleanupService;
  logger?: JobRunnerLogger | undefined;
  now?: () => Date;
}): JobHandler {
  return async (job) => {
    const payload = (job.payload ?? {}) as Partial<RetentionJobPayload> & { terminalAt?: unknown };
    const now = deps.now === undefined ? new Date() : deps.now();
    if (payload.scope === 'photos' && typeof payload.processId === 'string') {
      const result = await deps.retention.runTerminalCleanup(
        payload.processId,
        parseTerminalAt(payload.terminalAt),
      );
      deps.logger?.info(
        {
          jobId: job.id,
          processId: payload.processId,
          mode: result.mode,
          anchors: result.anchors,
          deleted: result.deleted,
          failed: result.failed,
        },
        'communication.cleanup_retention: Terminal-Lauf (Anker + Chatfotos)',
      );
      // Review-Fund „Terminalphase verpufft“: Storage-Fehler ⇒ Queue-Retry (Snapshot,
      // wirkt auch nach Reopen; Anker idempotent). Erst NACH getaner Arbeit werfen.
      if (result.failed > 0) throw new RetentionPhotoDeletePendingError();
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
