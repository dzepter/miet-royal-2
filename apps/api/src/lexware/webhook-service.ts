import { createHash, type KeyObject } from 'node:crypto';
import type { AppConfig } from '@mietroyal/config';
import { lexwareWebhookEvents, type Database } from '@mietroyal/database';
import type { JobQueue } from '@mietroyal/integrations';
import { z } from '@mietroyal/validation';
import { eq } from 'drizzle-orm';
import type { LexwareConnectionService } from './connection-service.ts';
import type { LexwareContext, LexwareLogger } from './context.ts';
import { LEXWARE_REQUIRED_EVENT_TYPES } from './subscription-service.ts';
import { LEXWARE_WEBHOOK_PUBLIC_KEY_PEM } from './webhook-public-key.ts';
import { loadWebhookPublicKey, verifyLexwareSignature } from './webhook-signature.ts';

/**
 * Annahme eingehender Lexware-Webhooks (Order §§44–47): Signatur über die
 * ROHBYTES (X-Lxo-Signature, RSA-SHA512, offizieller Public Key bzw.
 * konfigurierter Ersatz für den Contract-Fake), organizationId gegen den
 * gepinnten Wert, Payload-Schema, Eventtyp-Allowlist, SHA-256-Fingerprint-
 * Deduplizierung (ON CONFLICT DO NOTHING) und Einreihen des Jobs
 * `lexware.event.process`. Es wird NICHTS inline bei Lexware abgerufen und
 * der Body wird nie geloggt – nur IDs/Codes.
 */
export const LEXWARE_EVENT_PROCESS_JOB_TYPE = 'lexware.event.process';
export const LEXWARE_WEBHOOK_BODY_LIMIT = 64 * 1024;
export const LEXWARE_WEBHOOK_EVENT_TYPES: readonly string[] = LEXWARE_REQUIRED_EVENT_TYPES;

const webhookPayloadSchema = z.object({
  organizationId: z.string().min(1).max(128),
  eventType: z.string().min(1).max(64),
  resourceId: z.string().min(1).max(128),
  eventDate: z.string().min(1).max(64),
});

export type LexwareWebhookOutcome =
  | { status: 401; result: 'invalid_signature' }
  | { status: 400; result: 'invalid_payload' }
  | { status: 403; result: 'organization_mismatch' }
  | { status: 202; result: 'ignored' | 'duplicate' | 'queued'; eventId?: string };

export interface LexwareWebhookServiceDeps {
  db: Database;
  config: AppConfig;
  lexware: LexwareContext;
  queue: JobQueue;
  connection: LexwareConnectionService;
}

export function lexwareEventFingerprint(input: {
  organizationId: string;
  eventType: string;
  resourceId: string;
  eventDate: string;
}): string {
  return createHash('sha256')
    .update(`${input.organizationId}|${input.eventType}|${input.resourceId}|${input.eventDate}`)
    .digest('hex');
}

export function lexwareEventIdempotencyKey(fingerprint: string): string {
  return `lexware-event:${fingerprint}`;
}

export class LexwareWebhookService {
  private publicKey: KeyObject | null = null;

  constructor(private readonly deps: LexwareWebhookServiceDeps) {}

  private key(): KeyObject {
    if (this.publicKey === null) {
      this.publicKey = loadWebhookPublicKey(
        this.deps.config.lexware.webhookPublicKeyPem ?? LEXWARE_WEBHOOK_PUBLIC_KEY_PEM,
      );
    }
    return this.publicKey;
  }

  /** `log`: Request-Logger (Korrelation); Default ist der Lexware-Kontextlogger. */
  async receive(
    rawBody: Uint8Array,
    signatureHeader: string | undefined,
    correlationId: string,
    log?: LexwareLogger,
  ): Promise<LexwareWebhookOutcome> {
    const logger = log ?? this.deps.lexware.logger;
    if (!verifyLexwareSignature(this.key(), rawBody, signatureHeader)) {
      logger.warn(
        { lexware: { webhook: 'rejected', code: 'INVALID_SIGNATURE' }, correlationId },
        'Lexware-Webhook abgelehnt',
      );
      return { status: 401, result: 'invalid_signature' };
    }
    let parsed: z.infer<typeof webhookPayloadSchema>;
    try {
      const json = JSON.parse(Buffer.from(rawBody).toString('utf8')) as unknown;
      const result = webhookPayloadSchema.safeParse(json);
      if (!result.success) throw new Error('schema');
      parsed = result.data;
    } catch {
      logger.warn(
        { lexware: { webhook: 'rejected', code: 'INVALID_PAYLOAD' }, correlationId },
        'Lexware-Webhook abgelehnt',
      );
      return { status: 400, result: 'invalid_payload' };
    }
    const eventDate = new Date(parsed.eventDate);
    if (Number.isNaN(eventDate.getTime())) {
      logger.warn(
        { lexware: { webhook: 'rejected', code: 'INVALID_PAYLOAD' }, correlationId },
        'Lexware-Webhook abgelehnt',
      );
      return { status: 400, result: 'invalid_payload' };
    }

    const state = await this.deps.connection.getState();
    const pinned = this.deps.config.lexware.organizationId ?? state?.organizationId ?? null;
    if (pinned === null || pinned !== parsed.organizationId) {
      logger.warn(
        {
          lexware: {
            webhook: 'rejected',
            code: 'ORGANIZATION_MISMATCH',
            organizationId: parsed.organizationId,
            pinnedOrganizationId: pinned,
            eventType: parsed.eventType,
          },
          correlationId,
        },
        'Lexware-Webhook mit fremder organizationId abgelehnt',
      );
      return { status: 403, result: 'organization_mismatch' };
    }

    if (!LEXWARE_WEBHOOK_EVENT_TYPES.includes(parsed.eventType)) {
      logger.info(
        { lexware: { webhook: 'ignored', eventType: parsed.eventType }, correlationId },
        'Lexware-Webhook ignoriert (Eventtyp nicht abonniert)',
      );
      return { status: 202, result: 'ignored' };
    }

    const fingerprint = lexwareEventFingerprint(parsed);
    const inserted = await this.deps.db
      .insert(lexwareWebhookEvents)
      .values({
        fingerprint,
        organizationId: parsed.organizationId,
        eventType: parsed.eventType,
        resourceId: parsed.resourceId,
        eventDate,
        status: 'queued',
      })
      .onConflictDoNothing({ target: lexwareWebhookEvents.fingerprint })
      .returning({ id: lexwareWebhookEvents.id });
    const event = inserted[0];
    if (event === undefined) {
      // Insert und Enqueue sind nicht atomar: ein Crash dazwischen wird durch
      // Lexwares erneute Zustellung geheilt – der Job wird mit demselben
      // Idempotenzschlüssel erneut eingereiht (die Queue dedupliziert).
      const known = await this.deps.db
        .select({ id: lexwareWebhookEvents.id })
        .from(lexwareWebhookEvents)
        .where(eq(lexwareWebhookEvents.fingerprint, fingerprint));
      const existing = known[0];
      if (existing !== undefined) {
        await this.deps.queue.enqueue(
          LEXWARE_EVENT_PROCESS_JOB_TYPE,
          { eventId: existing.id },
          { idempotencyKey: lexwareEventIdempotencyKey(fingerprint) },
        );
      }
      logger.info(
        { lexware: { webhook: 'duplicate', eventType: parsed.eventType }, correlationId },
        'Lexware-Webhook bereits bekannt',
      );
      return { status: 202, result: 'duplicate' };
    }
    await this.deps.queue.enqueue(
      LEXWARE_EVENT_PROCESS_JOB_TYPE,
      { eventId: event.id },
      { idempotencyKey: lexwareEventIdempotencyKey(fingerprint) },
    );
    logger.info(
      {
        lexware: {
          webhook: 'queued',
          eventId: event.id,
          eventType: parsed.eventType,
          resourceId: parsed.resourceId,
        },
        correlationId,
      },
      'Lexware-Webhook eingereiht',
    );
    return { status: 202, result: 'queued', eventId: event.id };
  }
}
