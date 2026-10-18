/**
 * Job `mail.send` (Phase 12, Order §§3/9/16/37): verarbeitet genau eine
 * Outbox-Zeile. Die Outbox ist der Taktgeber – nicht die Job-Queue:
 * - Claim: UPDATE … WHERE status IN (pending, retry) RETURNING; kein Claim ⇒
 *   No-op (idempotent, at-least-once-sicher). Eine seit > 15 min hängende
 *   `sending`-Zeile (Worker-Absturz während/nach der SMTP-Annahme) wird NICHT
 *   erneut gesendet, sondern als `outcome_unknown` (SENDING_STALE)
 *   abgeschlossen – nur manuelles „erneut senden“ (Härtung RA-2).
 * - Vor dem Versand (Härtung RA-13/B7): Empfänger-/Konfigurationsprüfung wie
 *   beim Einreihen (`MailOutboxService.blockReasonFor`, u. a. Demo-Whitelist)
 *   und registrierte Pre-Send-Guards der Fachmodule (`MailPreSendGuard`, z. B.
 *   veraltete Terminerinnerung, abgelöste Angebotsversion) ⇒ `blocked` mit
 *   neutralem Code. Der generische Job kennt keine Fachregeln.
 * - Geheimnisse werden nur im Arbeitsspeicher entschlüsselt (Fehler ⇒ blocked
 *   SECRET_UNDECRYPTABLE), Anhänge beim Versand aufgelöst (Dokumente aus dem
 *   Speicher, Lexware-Rechnung transient – nie persistiert).
 * - Ergebnis: sent ⇒ sent + Secret-Payload gelöscht; transient ⇒ retry mit
 *   eigenem Backoff (1 min × 2^(n−1), max 6 h, max 8 Versuche ⇒ failed) über
 *   einen NEUEN Job `mail.send:<id>:<attempt>`; permanent ⇒ failed;
 *   unknown ⇒ outcome_unknown (kein automatischer Retry; nur manuelles
 *   „erneut senden“ mit neuer Message-ID).
 * - Der Handler wirft nur bei Infrastrukturfehlern (DB) – Gateway-Ergebnisse
 *   sind nie Job-Fehler. Logging: deliveryId/kind/status/errorCode.
 */
import type { AppConfig } from '@mietroyal/config';
import { mailDeliveries, type Database, type MailDeliveryRow } from '@mietroyal/database';
import type { JobHandler, JobQueue, JobRunnerLogger } from '@mietroyal/integrations';
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { DocumentService } from '../../commerce/document-service.ts';
import type { PayloadCrypto } from '../payload-crypto.ts';
import {
  MAIL_BLOCKED_SECRET_UNDECRYPTABLE,
  MAIL_SEND_JOB_TYPE,
  type MailAttachmentRef,
  type OutboundMailGateway,
  type OutboundMailMessage,
} from '../types.ts';
import { MAIL_SEND_JOB_MAX_ATTEMPTS, MailOutboxService, mailSendJobKey } from './outbox.ts';
import { MailRenderError, renderMail } from './templates/index.ts';

export const MAIL_MAX_ATTEMPTS = 8;
export const MAIL_BACKOFF_BASE_MS = 60_000;
export const MAIL_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
export const MAIL_SENDING_STALE_MS = 15 * 60 * 1000;
export const MAIL_BLOCKED_ATTACHMENT_UNAVAILABLE = 'ATTACHMENT_UNAVAILABLE';
export const MAIL_BLOCKED_RENDER_FAILED = 'RENDER_FAILED';
/** Härtung RA-2: hängende `sending`-Zeile ⇒ outcome_unknown statt Doppelversand. */
export const MAIL_OUTCOME_SENDING_STALE = 'SENDING_STALE';
/** Pre-Send-Guard warf (DB o. ä.) ⇒ Retry mit Backoff, kein Versand ohne Prüfung. */
export const MAIL_PRE_SEND_CHECK_FAILED = 'PRE_SEND_CHECK_FAILED';

/** Outbox-Backoff: Versuch n (1-basiert, bereits gezählt) ⇒ Wartezeit bis zum nächsten. */
export function mailRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(MAIL_BACKOFF_MAX_MS, MAIL_BACKOFF_BASE_MS * 2 ** exponent);
}

/** Transiente Rechnungsdatei (Lexware) – wird nie gespeichert (Order §16). */
export interface InvoiceFileFetcher {
  fetch(lexwareInvoiceId: string): Promise<Uint8Array>;
}

export interface MailSentListener {
  /** Nach bestätigtem Versand (idempotent implementieren – kann bei Job-Wiederholung erneut laufen). */
  mailSent(delivery: MailDeliveryRow): Promise<void>;
}

/**
 * Pre-Send-Guard (Härtung B7/RA-5): ein Fachmodul prüft unmittelbar vor dem
 * Versand, ob die Zustellung fachlich noch gilt. `null` ⇒ Versand erlaubt;
 * sonst ein neutraler Code ⇒ Zustellung `blocked` (kein Versand, kein Retry).
 * Guards prüfen nur „ihre“ Arten (`delivery.kind`) und liefern sonst null.
 */
export interface MailPreSendGuard {
  check(delivery: MailDeliveryRow, context: { now: Date }): Promise<string | null>;
}

export interface MailFailedListener {
  mailFailed(
    delivery: MailDeliveryRow,
    result: { status: 'failed' | 'outcome_unknown' | 'blocked'; errorCode: string | null },
  ): Promise<void>;
}

export interface MailSendJobDeps {
  db: Database;
  config: AppConfig;
  crypto: PayloadCrypto;
  gateway: OutboundMailGateway;
  queue: JobQueue;
  documents: DocumentService;
  /** Lazy, damit Agent-T-Anbindungen nach der Komposition registriert werden können. */
  invoiceFiles: () => InvoiceFileFetcher | null;
  sentListeners: () => readonly MailSentListener[];
  failedListeners: () => readonly MailFailedListener[];
  /** Härtung B7: Pre-Send-Guards der Fachmodule (lazy wie die Listener). */
  preSendGuards?: () => readonly MailPreSendGuard[];
  logger?: JobRunnerLogger | undefined;
  now?: () => Date;
}

export function publicWebBaseUrlFor(config: AppConfig): string | null {
  if (config.mail.publicWebBaseUrl !== null) return config.mail.publicWebBaseUrl;
  return config.appEnv === 'development' ? 'http://localhost:3000' : null;
}

export function buildOutboundMessage(
  delivery: MailDeliveryRow,
  rendered: { subject: string; text: string; html: string },
  attachments: OutboundMailMessage['attachments'],
  config: AppConfig,
): OutboundMailMessage {
  const fromAddress = config.mail.fromAddress ?? 'noreply@miet-royal.local';
  return {
    messageId: delivery.messageId,
    to: { email: delivery.recipientEmail, name: delivery.recipientName },
    from: { email: fromAddress, name: config.mail.fromName },
    replyTo: config.mail.replyAddress,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    inReplyTo: delivery.inReplyToMessageId,
    references: delivery.inReplyToMessageId === null ? [] : [delivery.inReplyToMessageId],
    attachments,
  };
}

export class MailSendProcessor {
  private readonly now: () => Date;
  /** Dieselbe Empfänger-/Konfigurationsprüfung wie beim Einreihen (eine Implementierung). */
  private readonly recipientPolicy: Pick<MailOutboxService, 'blockReasonFor'>;

  constructor(private readonly deps: MailSendJobDeps) {
    this.now = deps.now ?? (() => new Date());
    this.recipientPolicy = new MailOutboxService(
      deps.db,
      deps.config,
      deps.crypto,
      deps.gateway,
      deps.queue,
    );
  }

  /** Ein Versandversuch für eine Zustellung – idempotent (ohne Claim passiert nichts). */
  async process(
    deliveryId: string,
    options: { rerunListeners?: boolean } = {},
  ): Promise<
    | { outcome: 'noop'; status: MailDeliveryRow['status'] | null }
    | { outcome: MailDeliveryRow['status']; errorCode: string | null }
  > {
    const { db, config, crypto, gateway, queue, documents, logger } = this.deps;
    const now = this.now();
    const claimed = await db
      .update(mailDeliveries)
      .set({ status: 'sending', sendingSince: now, updatedAt: now })
      .where(
        and(
          eq(mailDeliveries.id, deliveryId),
          inArray(mailDeliveries.status, ['pending', 'retry']),
          or(
            sql`${mailDeliveries.nextAttemptAt} IS NULL`,
            sql`${mailDeliveries.nextAttemptAt} <= ${now}`,
          ),
        ),
      )
      .returning();
    const delivery = claimed[0];
    if (delivery === undefined) {
      const stale = await this.closeStaleSending(deliveryId, now);
      if (stale !== null) return stale;
      const current = await db
        .select({ status: mailDeliveries.status })
        .from(mailDeliveries)
        .where(eq(mailDeliveries.id, deliveryId));
      const status = current[0]?.status ?? null;
      if (status === 'sent' && options.rerunListeners === true) {
        const rows = await db
          .select()
          .from(mailDeliveries)
          .where(eq(mailDeliveries.id, deliveryId));
        if (rows[0] !== undefined) await this.notifySent(rows[0]);
      }
      return { outcome: 'noop', status };
    }

    // 0. Vor dem Versand erneut prüfen (Härtung RA-13/B7): Empfänger/Konfiguration
    //    (z. B. inzwischen verschärfte Demo-Whitelist) und fachliche Guards.
    const recipientBlock = this.recipientPolicy.blockReasonFor(delivery.recipientEmail);
    if (recipientBlock !== null) return this.block(delivery, recipientBlock);
    for (const guard of this.deps.preSendGuards?.() ?? []) {
      let guardCode: string | null;
      try {
        guardCode = await guard.check(delivery, { now });
      } catch {
        return this.retryOrFail(delivery, MAIL_PRE_SEND_CHECK_FAILED, queue);
      }
      if (guardCode !== null) return this.block(delivery, guardCode);
    }

    // 1. Geheimnisse nur im Arbeitsspeicher.
    let secrets: Record<string, string> = {};
    if (delivery.secretPayloadCiphertext !== null) {
      try {
        const parsed: unknown = JSON.parse(
          crypto.decrypt(delivery.secretPayloadCiphertext, 'mail-secret-payload', delivery.id),
        );
        if (typeof parsed !== 'object' || parsed === null)
          throw new Error('Secret-Payload ungültig');
        secrets = parsed as Record<string, string>;
      } catch {
        return this.block(delivery, MAIL_BLOCKED_SECRET_UNDECRYPTABLE);
      }
    }

    // 2. Rendern (text + html) – Kontext aus der Outbox, Geheimnisse aus dem Speicher.
    let rendered;
    try {
      rendered = renderMail(delivery.kind, delivery.context, secrets, {
        appEnv: config.appEnv,
        publicWebBaseUrl: publicWebBaseUrlFor(config),
      });
    } catch (error) {
      const code = error instanceof MailRenderError ? error.code : MAIL_BLOCKED_RENDER_FAILED;
      return this.block(delivery, code);
    }

    // 3. Anhänge auflösen (Dokumente unveränderlich; Rechnung transient).
    const attachments: { filename: string; contentType: string; content: Uint8Array }[] = [];
    try {
      for (const ref of delivery.attachments as MailAttachmentRef[]) {
        attachments.push(await this.resolveAttachment(ref, documents));
      }
    } catch {
      // Kein Anhang verfügbar: transient möglich (Lexware down) – als Retry behandeln.
      return this.retryOrFail(delivery, MAIL_BLOCKED_ATTACHMENT_UNAVAILABLE, queue);
    }

    // 4. Versand über das Gateway (außerhalb jeder Transaktion).
    const message = buildOutboundMessage(delivery, rendered, attachments, config);
    let outcome;
    try {
      outcome = await gateway.send(message);
    } catch {
      // Unerwarteter Transportabsturz: Zustellung unklar.
      outcome = { outcome: 'unknown' as const, code: 'GATEWAY_EXCEPTION' };
    }

    const sentAt = this.now();
    switch (outcome.outcome) {
      case 'sent': {
        const updated = await db
          .update(mailDeliveries)
          .set({
            status: 'sent',
            sentAt,
            providerCode: outcome.providerCode,
            lastErrorCode: null,
            nextAttemptAt: null,
            sendingSince: null,
            attempts: delivery.attempts + 1,
            // Geheimnisse werden nach dem Versand nicht mehr gebraucht (Order §7/§15).
            secretPayloadCiphertext: null,
            updatedAt: sentAt,
          })
          .where(eq(mailDeliveries.id, delivery.id))
          .returning();
        logger?.info(
          { mail: { deliveryId: delivery.id, kind: delivery.kind, status: 'sent' } },
          'mail.send: zugestellt',
        );
        if (updated[0] !== undefined) await this.notifySent(updated[0]);
        return { outcome: 'sent', errorCode: null };
      }
      case 'transient_error':
        return this.retryOrFail(delivery, outcome.code, queue);
      case 'permanent_error':
        return this.finish(delivery, 'failed', outcome.code);
      case 'unknown':
        return this.finish(delivery, 'outcome_unknown', outcome.code);
    }
  }

  /**
   * Härtung RA-2: `sending` seit > 15 min ⇒ Zustellung unklar (Absturz nach
   * der SMTP-Annahme möglich) ⇒ outcome_unknown statt erneutem Versand.
   * Atomar (nur wer die Zeile umstellt, benachrichtigt die Listener).
   */
  private async closeStaleSending(
    deliveryId: string,
    now: Date,
  ): Promise<{ outcome: 'outcome_unknown'; errorCode: string } | null> {
    const staleBefore = new Date(now.getTime() - MAIL_SENDING_STALE_MS);
    const updated = await this.deps.db
      .update(mailDeliveries)
      .set({
        status: 'outcome_unknown',
        attempts: sql`${mailDeliveries.attempts} + 1`,
        lastErrorCode: MAIL_OUTCOME_SENDING_STALE,
        nextAttemptAt: null,
        sendingSince: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(mailDeliveries.id, deliveryId),
          eq(mailDeliveries.status, 'sending'),
          lt(mailDeliveries.sendingSince, staleBefore),
        ),
      )
      .returning();
    const row = updated[0];
    if (row === undefined) return null;
    this.deps.logger?.error(
      {
        mail: {
          deliveryId: row.id,
          kind: row.kind,
          status: 'outcome_unknown',
          errorCode: MAIL_OUTCOME_SENDING_STALE,
        },
      },
      'mail.send: hängender Versuch – Zustellung unklar',
    );
    await this.notifyFailed(row, 'outcome_unknown', MAIL_OUTCOME_SENDING_STALE);
    return { outcome: 'outcome_unknown', errorCode: MAIL_OUTCOME_SENDING_STALE };
  }

  private async resolveAttachment(
    ref: MailAttachmentRef,
    documents: DocumentService,
  ): Promise<{ filename: string; contentType: string; content: Uint8Array }> {
    if (ref.kind === 'document') {
      const row = await documents.byId(ref.documentId);
      return {
        filename: ref.filename,
        contentType: row.mimeType,
        content: await documents.bytesFor(row),
      };
    }
    const fetcher = this.deps.invoiceFiles();
    if (fetcher === null) throw new Error('Kein Rechnungsabruf konfiguriert');
    return {
      filename: ref.filename,
      contentType: 'application/pdf',
      content: await fetcher.fetch(ref.lexwareInvoiceId),
    };
  }

  private async retryOrFail(delivery: MailDeliveryRow, code: string, queue: JobQueue) {
    const attempts = delivery.attempts + 1;
    if (attempts >= MAIL_MAX_ATTEMPTS) return this.finish(delivery, 'failed', code, attempts);
    const now = this.now();
    const nextAttemptAt = new Date(now.getTime() + mailRetryDelayMs(attempts));
    await this.deps.db
      .update(mailDeliveries)
      .set({
        status: 'retry',
        attempts,
        nextAttemptAt,
        lastErrorCode: code,
        sendingSince: null,
        updatedAt: now,
      })
      .where(eq(mailDeliveries.id, delivery.id));
    await queue.enqueue(
      MAIL_SEND_JOB_TYPE,
      { deliveryId: delivery.id, attempt: attempts },
      {
        idempotencyKey: mailSendJobKey(delivery.id, attempts),
        runAt: nextAttemptAt,
        maxAttempts: MAIL_SEND_JOB_MAX_ATTEMPTS,
      },
    );
    this.deps.logger?.warn(
      {
        mail: {
          deliveryId: delivery.id,
          kind: delivery.kind,
          status: 'retry',
          errorCode: code,
          attempts,
        },
      },
      'mail.send: erneuter Versuch geplant',
    );
    return { outcome: 'retry' as const, errorCode: code };
  }

  private async finish(
    delivery: MailDeliveryRow,
    status: 'failed' | 'outcome_unknown',
    code: string,
    attempts = delivery.attempts + 1,
  ) {
    const now = this.now();
    const updated = await this.deps.db
      .update(mailDeliveries)
      .set({
        status,
        attempts,
        lastErrorCode: code,
        nextAttemptAt: null,
        sendingSince: null,
        updatedAt: now,
      })
      .where(eq(mailDeliveries.id, delivery.id))
      .returning();
    this.deps.logger?.error(
      { mail: { deliveryId: delivery.id, kind: delivery.kind, status, errorCode: code } },
      'mail.send: nicht zugestellt',
    );
    if (updated[0] !== undefined) await this.notifyFailed(updated[0], status, code);
    return { outcome: status, errorCode: code };
  }

  private async block(delivery: MailDeliveryRow, reason: string) {
    const now = this.now();
    const updated = await this.deps.db
      .update(mailDeliveries)
      .set({
        status: 'blocked',
        blockedReason: reason,
        lastErrorCode: reason,
        sendingSince: null,
        updatedAt: now,
      })
      .where(eq(mailDeliveries.id, delivery.id))
      .returning();
    this.deps.logger?.error(
      {
        mail: {
          deliveryId: delivery.id,
          kind: delivery.kind,
          status: 'blocked',
          errorCode: reason,
        },
      },
      'mail.send: blockiert',
    );
    if (updated[0] !== undefined) await this.notifyFailed(updated[0], 'blocked', reason);
    return { outcome: 'blocked' as const, errorCode: reason };
  }

  private async notifySent(delivery: MailDeliveryRow): Promise<void> {
    for (const listener of this.deps.sentListeners()) {
      // Listener-Fehler werden zum Job-Fehler (Queue wiederholt; Listener sind idempotent).
      await listener.mailSent(delivery);
    }
  }

  private async notifyFailed(
    delivery: MailDeliveryRow,
    status: 'failed' | 'outcome_unknown' | 'blocked',
    errorCode: string | null,
  ): Promise<void> {
    for (const listener of this.deps.failedListeners()) {
      try {
        await listener.mailFailed(delivery, { status, errorCode });
      } catch (error) {
        this.deps.logger?.error(
          {
            mail: {
              deliveryId: delivery.id,
              kind: delivery.kind,
              listenerError: error instanceof Error ? error.name : 'Error',
            },
          },
          'mail.send: Fehler-Listener fehlgeschlagen',
        );
      }
    }
  }
}

export function createMailSendHandler(deps: MailSendJobDeps): JobHandler {
  const processor = new MailSendProcessor(deps);
  return async (job) => {
    const payload = job.payload as { deliveryId?: unknown } | null;
    const deliveryId = payload?.deliveryId;
    if (typeof deliveryId !== 'string' || deliveryId === '') {
      throw new Error('mail.send: Payload ohne deliveryId');
    }
    await processor.process(deliveryId, { rerunListeners: job.attempts > 1 });
  };
}
