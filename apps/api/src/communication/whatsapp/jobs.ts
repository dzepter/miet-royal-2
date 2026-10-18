/**
 * Phase 12 (Order §§26, 28, 37): WhatsApp-Jobs auf der PostgreSQL-Queue.
 *
 * - `whatsapp.send` (Key `whatsapp.send:<conversationMessageId>`): ruft
 *   gateway.sendText NACH Commit der Konversationszeile auf; accepted ⇒
 *   deliveryState sent + providerMessageId; permanent ⇒ failed (Code als
 *   whatsapp_events-Zeile `send_result`); transient ⇒ werfen (Queue-Retry);
 *   unknown (Härtung B3: Request evtl. angekommen, keine Antwort) ⇒ failed mit
 *   Code OUTCOME_UNKNOWN OHNE Auto-Retry – Staff kann bewusst neu senden.
 * - `whatsapp.media_fetch` (Key `whatsapp.media_fetch:<providerMessageId>`):
 *   lädt ein Bild über gateway.fetchMedia, prüft es (nur JPEG/PNG/WebP,
 *   Magic Bytes, 5 MB) und speichert es privat als message_photos-Zeile.
 *   Härtung B5: existiert für die Nachricht schon IRGENDEINE Fotozeile (auch
 *   eine per Retention gelöschte) oder ist der Vorgang abgeschlossen, wird
 *   nichts (erneut) geladen.
 * Beide Handler sind idempotent (Zustand wird vor jeder Aktion geprüft).
 */
import { createHash } from 'node:crypto';
import {
  conversationMessages,
  messagePhotos,
  processes,
  whatsappEvents,
  type Database,
} from '@mietroyal/database';
import type {
  JobHandler,
  JobQueue,
  JobRunnerLogger,
  StorageProvider,
} from '@mietroyal/integrations';
import { and, eq } from 'drizzle-orm';
import { ConversationService, photoStorageKey } from '../conversation/conversation-service.ts';
import { imageExtensionFor, type AllowedImageMime } from '../inbound/content.ts';
import type { WhatsAppGateway } from '../types.ts';
import { WHATSAPP_OUTCOME_UNKNOWN } from './gateways.ts';
import { WHATSAPP_MEDIA_FETCH_JOB_TYPE, WHATSAPP_SEND_JOB_TYPE } from '../types.ts';

export interface WhatsAppJobDeps {
  db: Database;
  storage: StorageProvider;
  gateway: WhatsAppGateway;
  logger?: JobRunnerLogger;
}

export function whatsappSendIdempotencyKey(conversationMessageId: string): string {
  return `${WHATSAPP_SEND_JOB_TYPE}:${conversationMessageId}`;
}

export async function enqueueWhatsAppSend(
  queue: JobQueue,
  conversationMessageId: string,
): Promise<void> {
  await queue.enqueue(
    WHATSAPP_SEND_JOB_TYPE,
    { conversationMessageId },
    { idempotencyKey: whatsappSendIdempotencyKey(conversationMessageId), maxAttempts: 6 },
  );
}

class TransientWhatsAppError extends Error {
  constructor(code: string) {
    super(`whatsapp transient: ${code}`);
    this.name = 'TransientWhatsAppError';
  }
}

export function createWhatsAppSendHandler(deps: WhatsAppJobDeps): JobHandler {
  return async (job) => {
    const payload = job.payload as { conversationMessageId?: unknown } | null;
    const messageId = payload?.conversationMessageId;
    if (typeof messageId !== 'string' || messageId === '') {
      throw new Error('whatsapp.send: Payload ohne conversationMessageId');
    }
    const rows = await deps.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, messageId));
    const message = rows[0];
    if (
      message === undefined ||
      message.channel !== 'whatsapp' ||
      message.direction !== 'outbound'
    ) {
      deps.logger?.warn(
        { jobId: job.id, conversationMessageId: messageId },
        'whatsapp.send: Nachricht unbekannt',
      );
      return;
    }
    if (message.deliveryState !== 'queued') return; // bereits gesendet/fehlgeschlagen (idempotent)
    // Bei ausgehenden WhatsApp-Zeilen hält `phone` die Gegenstelle (wa_id des Kunden).
    const sender = message.senderSnapshot as { phone?: unknown } | null;
    const to = typeof sender?.phone === 'string' && sender.phone !== '' ? sender.phone : null;
    if (to === null) {
      await markFailed(deps, message.id, 'NO_RECIPIENT');
      return;
    }
    if (message.bodyDeletedAt !== null) {
      await markFailed(deps, message.id, 'BODY_PURGED');
      return;
    }
    const outcome = await deps.gateway.sendText({
      to,
      text: message.body,
      replyToProviderMessageId: message.replyToProviderMessageId,
    });
    if (outcome.outcome === 'accepted') {
      await deps.db
        .update(conversationMessages)
        .set({
          deliveryState: 'sent',
          providerMessageId: outcome.providerMessageId,
          sentAt: new Date(),
        })
        .where(
          and(
            eq(conversationMessages.id, message.id),
            eq(conversationMessages.deliveryState, 'queued'),
          ),
        );
      await recordSendResult(deps, message.id, 'processed', 'ACCEPTED');
      deps.logger?.info(
        { jobId: job.id, conversationMessageId: message.id, outcome: 'sent' },
        'whatsapp.send verarbeitet',
      );
      return;
    }
    if (outcome.outcome === 'permanent_error') {
      await markFailed(deps, message.id, outcome.code);
      deps.logger?.warn(
        { jobId: job.id, conversationMessageId: message.id, outcome: 'failed', code: outcome.code },
        'whatsapp.send dauerhaft fehlgeschlagen',
      );
      return;
    }
    if (outcome.outcome === 'unknown') {
      // Härtung B3: Zustellung unklar ⇒ kein Queue-Retry (sonst ggf. doppelte Antwort).
      await markFailed(deps, message.id, WHATSAPP_OUTCOME_UNKNOWN);
      deps.logger?.warn(
        {
          jobId: job.id,
          conversationMessageId: message.id,
          outcome: 'failed',
          code: WHATSAPP_OUTCOME_UNKNOWN,
        },
        'whatsapp.send: Ergebnis unklar – kein automatischer Neuversuch',
      );
      return;
    }
    if (job.attempts >= job.maxAttempts) {
      await markFailed(deps, message.id, outcome.code);
      return;
    }
    throw new TransientWhatsAppError(outcome.code);
  };
}

async function markFailed(deps: WhatsAppJobDeps, messageId: string, code: string): Promise<void> {
  await deps.db
    .update(conversationMessages)
    .set({ deliveryState: 'failed' })
    .where(
      and(eq(conversationMessages.id, messageId), eq(conversationMessages.deliveryState, 'queued')),
    );
  await recordSendResult(deps, messageId, 'failed', code);
}

/** Sendeergebnis als Ereigniszeile (Code für Admin/UI; keine Inhalte). */
async function recordSendResult(
  deps: WhatsAppJobDeps,
  messageId: string,
  status: 'processed' | 'failed',
  code: string,
): Promise<void> {
  await deps.db
    .insert(whatsappEvents)
    .values({
      providerMessageId: `outbound:${messageId}`,
      eventType: 'send_result',
      phoneNumberId: 'self',
      status,
      resultCode: code,
      processedAt: new Date(),
      conversationMessageId: messageId,
    })
    .onConflictDoUpdate({
      target: [whatsappEvents.providerMessageId, whatsappEvents.eventType],
      set: { status, resultCode: code, processedAt: new Date() },
    });
}

export function createWhatsAppMediaFetchHandler(deps: WhatsAppJobDeps): JobHandler {
  const conversations = new ConversationService(deps.db, deps.storage);
  return async (job) => {
    const payload = job.payload as { messageId?: unknown; mediaId?: unknown } | null;
    const messageId = payload?.messageId;
    const mediaId = payload?.mediaId;
    if (
      typeof messageId !== 'string' ||
      typeof mediaId !== 'string' ||
      messageId === '' ||
      mediaId === ''
    ) {
      throw new Error('whatsapp.media_fetch: Payload unvollständig');
    }
    const rows = await deps.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, messageId));
    const message = rows[0];
    if (message === undefined || message.channel !== 'whatsapp') return;
    // Idempotent: Foto existiert bereits (Wiederholung nach Absturz) ⇒ fertig.
    // Härtung B5: auch eine per Retention GELÖSCHTE Zeile zählt – sonst lädt ein
    // Replay das Chatfoto nach der Löschung erneut.
    const existing = await deps.db
      .select({ id: messagePhotos.id })
      .from(messagePhotos)
      .where(eq(messagePhotos.messageId, messageId))
      .limit(1);
    if (existing.length > 0) return;
    // Retention: Vorgang abgeschlossen (Fotos werden gelöscht) ⇒ nichts mehr nachladen.
    if (message.bodyDeletedAt !== null) return;
    if (message.processId !== null) {
      const owner = await deps.db
        .select({ mainStatus: processes.mainStatus })
        .from(processes)
        .where(eq(processes.id, message.processId));
      if (owner[0]?.mainStatus === 'completed') return;
    }

    const outcome = await deps.gateway.fetchMedia(mediaId);
    if (outcome.outcome === 'transient_error') {
      if (job.attempts >= job.maxAttempts) {
        await noteMediaFailure(deps, messageId, outcome.code);
        return;
      }
      throw new TransientWhatsAppError(outcome.code);
    }
    if (outcome.outcome === 'permanent_error') {
      await noteMediaFailure(deps, messageId, outcome.code);
      deps.logger?.warn(
        { jobId: job.id, conversationMessageId: messageId, code: outcome.code },
        'whatsapp.media_fetch abgelehnt',
      );
      return;
    }
    const mime = outcome.mimeType as AllowedImageMime;
    const storageKey = photoStorageKey(messageId, imageExtensionFor(mime));
    await deps.storage.put(storageKey, outcome.bytes, { contentType: mime });
    await conversations.registerPhoto({
      messageId,
      storageKey,
      mimeType: mime,
      byteSize: outcome.bytes.length,
      sha256: createHash('sha256').update(outcome.bytes).digest('hex'),
    });
    deps.logger?.info(
      { jobId: job.id, conversationMessageId: messageId, bytes: outcome.bytes.length },
      'whatsapp.media_fetch gespeichert',
    );
  };
}

async function noteMediaFailure(
  deps: WhatsAppJobDeps,
  messageId: string,
  code: string,
): Promise<void> {
  await deps.db
    .update(conversationMessages)
    .set({ body: `[Bild konnte nicht geladen werden: ${code}]` })
    .where(and(eq(conversationMessages.id, messageId), eq(conversationMessages.body, '[Bild]')));
}

export { WHATSAPP_MEDIA_FETCH_JOB_TYPE, WHATSAPP_SEND_JOB_TYPE };
