/**
 * Mail-Outbox (Phase 12, Order §§6/7/9): Fachservices reihen Zustellungen
 * ein; versendet wird ausschließlich durch den Job `mail.send` (nie in
 * einer offenen Transaktion). Beim Einreihen entsteht die stabile
 * Message-ID, der Empfänger-Snapshot, der validierte Kontext (ohne
 * Geheimnisse) und – falls vorhanden – die verschlüsselte Secret-Payload
 * (AES-256-GCM, Purpose `mail-secret-payload`, Entität = delivery id).
 *
 * Blockaden beim Einreihen (status `blocked`, nie ein Fehler für den Aufrufer):
 * - Gateway `disabled` (Mail nicht konfiguriert) ⇒ MAIL_NOT_CONFIGURED
 * - demo + Empfänger nicht auf der Whitelist ⇒ DEMO_NOT_WHITELISTED
 * - keine/ungültige Empfängeradresse ⇒ NO_RECIPIENT / INVALID_RECIPIENT
 * Idempotenz: `idempotencyKey` ist UNIQUE – ein zweiter Aufruf liefert die
 * vorhandene Zeile (`deduplicated: true`, tatsächlicher Status in
 * `existingStatus`), nie eine zweite Mail. Bewusste Wiederholungen nach einem
 * Fehlschlag laufen über `enqueueRetryingFailed` (`<key>:retry:<vorherige id>`),
 * manuelle Resends über `resend` (`<key>:resend:<quell-id>`, je Quelle einmal).
 */
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@mietroyal/config';
import {
  mailDeliveries,
  type Database,
  type DatabaseExecutor,
  type MailDeliveryRow,
} from '@mietroyal/database';
import type { JobQueue } from '@mietroyal/integrations';
import { and, desc, eq, gt, inArray, like, ne, sql } from 'drizzle-orm';
import { AuthError } from '../../auth/service.ts';
import { PayloadCryptoError, type PayloadCrypto } from '../payload-crypto.ts';
import { parseTransactionalKey } from '../transactional/keys.ts';
import {
  MAIL_BLOCKED_DEMO_NOT_WHITELISTED,
  MAIL_BLOCKED_NO_RECIPIENT,
  MAIL_BLOCKED_NOT_CONFIGURED,
  MAIL_SEND_JOB_TYPE,
  type MailAttachmentRef,
  type MailDeliveryKind,
  type MailDeliveryStatus,
  type MailEnqueueInput,
  type MailEnqueueResult,
  type MailOutbox,
  type OutboundMailGateway,
} from '../types.ts';
import { renderMailSubject, MAIL_TEMPLATE_VERSIONS } from './templates/index.ts';
import { isDemoWhitelisted } from './whitelist.ts';

export const MAIL_BLOCKED_INVALID_RECIPIENT = 'INVALID_RECIPIENT';
export const MAIL_SEND_JOB_MAX_ATTEMPTS = 3;

/** Blockaden, die nach einer Konfigurationsänderung per „erneut senden“ auflösbar sind. */
export const MAIL_RESENDABLE_BLOCK_REASONS: readonly string[] = [
  MAIL_BLOCKED_DEMO_NOT_WHITELISTED,
  MAIL_BLOCKED_NOT_CONFIGURED,
  'PUBLIC_WEB_BASE_URL_MISSING',
];

export const MAIL_DELIVERY_STATUS_LABELS: Record<MailDeliveryStatus, string> = {
  pending: 'Versand ausstehend',
  sending: 'Wird gesendet',
  sent: 'E-Mail gesendet',
  retry: 'Erneuter Versuch geplant',
  failed: 'Versand fehlgeschlagen',
  blocked: 'Versand blockiert',
  outcome_unknown: 'Zustellung unklar',
};

export const MAIL_DELIVERY_KIND_LABELS: Record<MailDeliveryKind, string> = {
  offer: 'Angebot',
  order_confirmation: 'Auftragsbestätigung',
  handover_protocol: 'Übergabeprotokoll',
  return_protocol: 'Rückgabeprotokoll',
  settlement_damage_missing_notice: 'Schaden-/Fehlteil-Information',
  cancellation_confirmation: 'Stornobestätigung',
  reminder_7_days: 'Erinnerung (7 Tage)',
  reminder_1_day: 'Erinnerung (1 Tag)',
  appointment_changed: 'Terminänderung',
  voucher_delivery: 'Gutschein',
  invoice_delivery: 'Rechnung',
  manual_customer_reply: 'Antwort an Kunde',
};

/** Listen-/Statusansicht ohne Secrets, Bodies oder Kontext. */
export interface MailDeliverySummary {
  id: string;
  kind: MailDeliveryKind;
  kindLabel: string;
  status: MailDeliveryStatus;
  statusLabel: string;
  processId: string | null;
  recipientEmail: string;
  subject: string;
  attempts: number;
  nextAttemptAt: string | null;
  sentAt: string | null;
  lastErrorCode: string | null;
  blockedReason: string | null;
  resendable: boolean;
  /** Härtung RA-3: bereits erneut gesendet als diese Zustellung (je Quelle genau einmal). */
  resentDeliveryId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function isResendable(row: Pick<MailDeliveryRow, 'status' | 'blockedReason'>): boolean {
  if (row.status === 'failed' || row.status === 'outcome_unknown') return true;
  return (
    row.status === 'blocked' && MAIL_RESENDABLE_BLOCK_REASONS.includes(row.blockedReason ?? '')
  );
}

/** Deterministischer Resend-Schlüssel je Quelle (Härtung RA-3). */
export function mailResendKey(source: Pick<MailDeliveryRow, 'id' | 'idempotencyKey'>): string {
  return `${source.idempotencyKey}:resend:${source.id}`;
}

/** Bewusste Wiederholung nach Fehlschlag: deterministisch je vorheriger Zustellung (RA-15). */
export function mailRetryKey(baseKey: string, previousDeliveryId: string): string {
  return `${baseKey}:retry:${previousDeliveryId}`;
}

/** Status, nach denen eine bewusste Fach-Wiederholung eine NEUE Zustellung anlegen darf. */
export const MAIL_RETRYABLE_AFTER_FAILURE: readonly MailDeliveryStatus[] = ['failed', 'blocked'];

export function summarizeDelivery(
  row: MailDeliveryRow,
  resentDeliveryId: string | null = null,
): MailDeliverySummary {
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: MAIL_DELIVERY_KIND_LABELS[row.kind],
    status: row.status,
    statusLabel: MAIL_DELIVERY_STATUS_LABELS[row.status],
    processId: row.processId,
    recipientEmail: row.recipientEmail,
    subject: row.subject,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    blockedReason: row.blockedReason,
    resendable: isResendable(row) && resentDeliveryId === null,
    resentDeliveryId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Eine Adresse, keine Liste, keine Steuerzeichen (Recipient-Injection). */
const RECIPIENT_PATTERN = /^[^\s@,;:<>"'\\()[\]]+@[^\s@,;:<>"'\\()[\]]+\.[^\s@,;:<>"'\\()[\]]+$/;

export function mailMessageDomain(config: Pick<AppConfig, 'mail'>): string {
  const from = config.mail.fromAddress;
  const domain =
    from === null
      ? ''
      : from
          .slice(from.lastIndexOf('@') + 1)
          .trim()
          .toLowerCase();
  return domain === '' ? 'miet-royal.local' : domain;
}

/** Stabile RFC-5322-Message-ID je Zustellung – vor dem ersten Versuch festgelegt. */
export function mailMessageIdFor(deliveryId: string, config: Pick<AppConfig, 'mail'>): string {
  return `<${deliveryId}@${mailMessageDomain(config)}>`;
}

export function mailSendJobKey(deliveryId: string, attempt = 0): string {
  return attempt === 0
    ? `${MAIL_SEND_JOB_TYPE}:${deliveryId}`
    : `${MAIL_SEND_JOB_TYPE}:${deliveryId}:${attempt}`;
}

function sanitizeName(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const cleaned = name.replace(/[\r\n\0]+/g, ' ').trim();
  return cleaned === '' ? null : cleaned.slice(0, 200);
}

/**
 * Härtung RA-3: id der Resend-Zustellung dieser Quelle (deterministischer Schlüssel) oder
 * null. Bewusst voll qualifiziert (äußere Tabelle `mail_deliveries`, innere `r`) – Drizzle
 * würde Spalten in `sql` unqualifiziert rendern und damit auf `r` beziehen.
 */
const resentDeliveryIdSql = sql<string | null>`(
  select r.id from mail_deliveries r
  where r.idempotency_key = mail_deliveries.idempotency_key || ':resend:' || mail_deliveries.id::text
)`;

export class MailOutboxService implements MailOutbox {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly crypto: PayloadCrypto,
    private readonly gateway: OutboundMailGateway,
    private readonly queue: JobQueue,
  ) {}

  /** Grund einer Einreih-Blockade oder null (nutzbar für UI-Hinweise vor dem Senden). */
  blockReasonFor(recipientEmail: string | null | undefined): string | null {
    const email = (recipientEmail ?? '').trim().toLowerCase();
    if (email === '') return MAIL_BLOCKED_NO_RECIPIENT;
    if (!RECIPIENT_PATTERN.test(email) || email.length > 254) return MAIL_BLOCKED_INVALID_RECIPIENT;
    if (this.gateway.kind === 'disabled') return MAIL_BLOCKED_NOT_CONFIGURED;
    if (
      this.config.appEnv === 'demo' &&
      !isDemoWhitelisted(email, this.config.mail.demoWhitelist)
    ) {
      return MAIL_BLOCKED_DEMO_NOT_WHITELISTED;
    }
    return null;
  }

  async enqueue(input: MailEnqueueInput, executor?: DatabaseExecutor): Promise<MailEnqueueResult> {
    return this.enqueueWithId(randomUUID(), input, executor);
  }

  private async enqueueWithId(
    deliveryId: string,
    input: MailEnqueueInput,
    executor?: DatabaseExecutor,
  ): Promise<MailEnqueueResult> {
    const db = executor ?? this.db;
    const email = (input.recipient.email ?? '').trim().toLowerCase();
    const blockedReason = this.blockReasonFor(email);
    // Kontext validieren + Betreff ableiten (wirft MailRenderError bei Programmierfehlern).
    const subject = renderMailSubject(input.kind, input.context, { appEnv: this.config.appEnv });
    const secrets = input.secrets ?? {};
    const hasSecrets = Object.keys(secrets).length > 0;
    const messageId = mailMessageIdFor(deliveryId, this.config);
    const now = new Date();

    const inserted = await db
      .insert(mailDeliveries)
      .values({
        id: deliveryId,
        kind: input.kind,
        processId: input.processId ?? null,
        customerId: input.customerId ?? null,
        bookingId: input.bookingId ?? null,
        recipientEmail: email === '' ? '' : email,
        recipientName: sanitizeName(input.recipient.name),
        subject,
        templateKind: input.kind,
        templateVersion: MAIL_TEMPLATE_VERSIONS[input.kind],
        context: input.context,
        secretPayloadCiphertext: hasSecrets
          ? this.crypto.encrypt(JSON.stringify(secrets), 'mail-secret-payload', deliveryId)
          : null,
        attachments: [...(input.attachments ?? [])],
        status: blockedReason === null ? 'pending' : 'blocked',
        blockedReason,
        idempotencyKey: input.idempotencyKey,
        messageId,
        inReplyToMessageId: input.inReplyToMessageId ?? null,
        conversationMessageId: input.conversationMessageId ?? null,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: mailDeliveries.idempotencyKey })
      .returning({ id: mailDeliveries.id, status: mailDeliveries.status });

    if (inserted.length > 0) {
      return {
        deliveryId,
        status: blockedReason === null ? 'pending' : 'blocked',
        deduplicated: false,
        existingStatus: null,
        messageId,
      };
    }
    const existing = await db
      .select({
        id: mailDeliveries.id,
        status: mailDeliveries.status,
        messageId: mailDeliveries.messageId,
      })
      .from(mailDeliveries)
      .where(eq(mailDeliveries.idempotencyKey, input.idempotencyKey));
    const row = existing[0];
    if (row === undefined)
      throw new Error('Mail-Zustellung mit diesem Idempotenzschlüssel nicht ermittelbar.');
    return {
      deliveryId: row.id,
      status: row.status === 'blocked' ? 'blocked' : 'pending',
      deduplicated: true,
      // Härtung RA-15: der echte Status (sent/failed/outcome_unknown/…) – nie verschleiert.
      existingStatus: row.status,
      messageId: row.messageId,
    };
  }

  /**
   * Bewusste Fach-Wiederholung (Härtung RA-15): wie `enqueue`, aber eine
   * vorhandene GESCHEITERTE bzw. blockierte Zustellung desselben Schlüssels
   * führt zu einer NEUEN Zustellung `<key>:retry:<vorherige id>` (deterministisch,
   * Doppelklick ⇒ dieselbe Zeile). Läuft oder lief die vorhandene Zustellung
   * (pending/sending/retry/sent/outcome_unknown), bleibt es bei ihr – der
   * Aufrufer meldet `existingStatus` wahrheitsgemäß. Die Kette ist durch die
   * Zahl bewusster Klicks begrenzt.
   */
  async enqueueRetryingFailed(
    input: MailEnqueueInput,
    executor?: DatabaseExecutor,
  ): Promise<MailEnqueueResult> {
    let result = await this.enqueue(input, executor);
    for (let depth = 0; depth < 100; depth += 1) {
      if (
        !result.deduplicated ||
        result.existingStatus === null ||
        !MAIL_RETRYABLE_AFTER_FAILURE.includes(result.existingStatus)
      ) {
        return result;
      }
      result = await this.enqueue(
        { ...input, idempotencyKey: mailRetryKey(input.idempotencyKey, result.deliveryId) },
        executor,
      );
    }
    return result;
  }

  /** Nach Commit aufrufen: reiht `mail.send` ein (Key je Zustellung; Wiederholung ist ein No-op). */
  async scheduleSend(deliveryId: string, runAt?: Date): Promise<void> {
    await this.queue.enqueue(
      MAIL_SEND_JOB_TYPE,
      { deliveryId, attempt: 0 },
      {
        idempotencyKey: mailSendJobKey(deliveryId),
        maxAttempts: MAIL_SEND_JOB_MAX_ATTEMPTS,
        ...(runAt === undefined ? {} : { runAt }),
      },
    );
  }

  /** Bequemlichkeit außerhalb von Transaktionen: einreihen + Job planen (blocked ⇒ kein Job). */
  async enqueueAndSchedule(input: MailEnqueueInput): Promise<MailEnqueueResult> {
    const result = await this.enqueue(input);
    if (result.status === 'pending') await this.scheduleSend(result.deliveryId);
    return result;
  }

  async byId(deliveryId: string, executor?: DatabaseExecutor): Promise<MailDeliveryRow | null> {
    const rows = await (executor ?? this.db)
      .select()
      .from(mailDeliveries)
      .where(eq(mailDeliveries.id, deliveryId));
    return rows[0] ?? null;
  }

  /** Outbox-Liste (neueste zuerst), optional nach Status/Vorgang gefiltert – nie Secrets/Bodies. */
  async list(
    filter: { status?: MailDeliveryStatus | undefined; processId?: string | undefined } = {},
    limit = 200,
  ): Promise<MailDeliverySummary[]> {
    const conditions = [
      ...(filter.status === undefined ? [] : [eq(mailDeliveries.status, filter.status)]),
      ...(filter.processId === undefined ? [] : [eq(mailDeliveries.processId, filter.processId)]),
    ];
    const rows = await this.db
      .select({ row: mailDeliveries, resentDeliveryId: resentDeliveryIdSql })
      .from(mailDeliveries)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(mailDeliveries.createdAt))
      .limit(limit);
    return rows.map((r) => summarizeDelivery(r.row, r.resentDeliveryId));
  }

  /** Letzte Zustellung je Art für einen Vorgang (Kommunikationsstatus, Order §35). */
  async latestPerKindForProcess(processId: string): Promise<MailDeliverySummary[]> {
    const rows = await this.db
      .select({ row: mailDeliveries, resentDeliveryId: resentDeliveryIdSql })
      .from(mailDeliveries)
      .where(eq(mailDeliveries.processId, processId))
      .orderBy(desc(mailDeliveries.createdAt));
    const latest = new Map<MailDeliveryKind, MailDeliverySummary>();
    for (const r of rows) {
      if (!latest.has(r.row.kind)) {
        latest.set(r.row.kind, summarizeDelivery(r.row, r.resentDeliveryId));
      }
    }
    return [...latest.values()];
  }

  /**
   * Manuelles „erneut senden“ (Order §§9/16): NEUE Zustellung mit NEUER
   * Message-ID (nie dieselbe), Kontext/Anhänge/Empfänger kopiert, Geheimnisse
   * aus der alten Payload entschlüsselt und für die neue ID neu verschlüsselt.
   * Nur für failed/outcome_unknown sowie konfigurationsbedingte Blockaden.
   *
   * Härtung RA-3: Quellzeile FOR UPDATE, deterministischer Schlüssel
   * `<alt>:resend:<quell-id>` ⇒ je Quelle genau EIN Resend (zweiter Aufruf,
   * auch parallel ⇒ 409). Der Resend einer Resend-Zustellung ist eine neue
   * Quelle und bleibt möglich. Ist für dasselbe Fachobjekt bereits eine
   * NEUERE Zustellung unterwegs, versendet oder unklar (z. B. „Gutschein
   * jetzt senden“ an die korrigierte Adresse), ist die alte Quelle überholt ⇒ 409.
   */
  async resend(deliveryId: string, createdBy: string | null): Promise<MailEnqueueResult> {
    const newId = randomUUID();
    const result = await this.db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(mailDeliveries)
        .where(eq(mailDeliveries.id, deliveryId))
        .for('update');
      const source = locked[0];
      if (source === undefined) throw new AuthError('NOT_FOUND', 'Zustellung nicht gefunden.');
      if (!isResendable(source)) {
        throw new AuthError('CONFLICT', 'Diese Zustellung kann nicht erneut gesendet werden.');
      }
      await this.assertNotSuperseded(tx, source);
      let secrets: Record<string, string> | undefined;
      if (source.secretPayloadCiphertext !== null) {
        try {
          secrets = JSON.parse(
            this.crypto.decrypt(source.secretPayloadCiphertext, 'mail-secret-payload', source.id),
          ) as Record<string, string>;
        } catch (error) {
          const code = error instanceof PayloadCryptoError ? error.code : 'FORMAT';
          throw new AuthError('CONFLICT', `Geheime Daten der Zustellung nicht lesbar (${code}).`);
        }
      }
      const enqueued = await this.enqueueWithId(
        newId,
        {
          kind: source.kind,
          processId: source.processId,
          customerId: source.customerId,
          bookingId: source.bookingId,
          recipient: { email: source.recipientEmail, name: source.recipientName },
          context: source.context as Record<string, unknown>,
          ...(secrets === undefined ? {} : { secrets }),
          attachments: source.attachments as MailAttachmentRef[],
          idempotencyKey: mailResendKey(source),
          inReplyToMessageId: source.inReplyToMessageId,
          conversationMessageId: source.conversationMessageId,
          createdBy,
        },
        tx,
      );
      if (enqueued.deduplicated) {
        throw new AuthError(
          'CONFLICT',
          'Diese Zustellung wurde bereits erneut gesendet – bitte die neuere Zustellung prüfen.',
        );
      }
      return enqueued;
    });
    if (result.status === 'pending') await this.scheduleSend(result.deliveryId);
    return result;
  }

  /**
   * Überholte Quelle (Härtung RA-3/RA-9): Für dasselbe Fachobjekt (Präfix
   * `<art>:<id>` des Schlüssels) existiert eine NEUERE Zustellung, die läuft,
   * versendet wurde oder unklar ist ⇒ kein Resend der alten Quelle (z. B. kein
   * Gutscheincode an die alte, falsche Adresse, nachdem er an die korrigierte
   * Adresse versendet wurde).
   */
  private async assertNotSuperseded(tx: DatabaseExecutor, source: MailDeliveryRow): Promise<void> {
    const parsed = parseTransactionalKey(source.idempotencyKey);
    if (parsed === null) return;
    const newer = await tx
      .select({ id: mailDeliveries.id })
      .from(mailDeliveries)
      .where(
        and(
          like(mailDeliveries.idempotencyKey, `${parsed.kind}:${parsed.entityId}%`),
          ne(mailDeliveries.id, source.id),
          gt(mailDeliveries.createdAt, source.createdAt),
          inArray(mailDeliveries.status, [
            'pending',
            'sending',
            'retry',
            'sent',
            'outcome_unknown',
          ]),
        ),
      )
      .limit(1);
    if (newer.length > 0) {
      throw new AuthError(
        'CONFLICT',
        'Für diesen Vorgang gibt es bereits eine neuere Zustellung derselben Art – die alte wird nicht erneut gesendet.',
      );
    }
  }
}
