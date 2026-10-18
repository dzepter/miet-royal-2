/**
 * Job `voucher.delivery` (Phase 12, Order §§15/37): Gutscheinmail über die
 * zentrale Outbox. Auslöser: Erzeugung des Gutscheins (nach Commit des
 * Eligibility-Jobs), der Sweep aus `communication.scan_due`
 * (`enqueuePendingVoucherDeliveries`) und die Staff-Aktion „Gutschein jetzt
 * senden“ (nachdem eine Kunden-E-Mail hinterlegt wurde).
 *
 * Bedingungen (alle im Job geprüft, idempotent): Mail-Gateway nicht
 * deaktiviert, Kunde hat E-Mail, Gutschein `pending` mit Versandkopie, Kopie
 * entschlüsselbar. Der Klartextcode existiert nur im Arbeitsspeicher dieses
 * Jobs und verschlüsselt in der Outbox-Payload (`secrets.voucherCode`) – nie
 * im Kontext, nie im Log, nie für Staff. Nach bestätigtem Versand setzt der
 * Sent-Listener `markDelivered` (sent, delivered_at, Kopie gelöscht, Hash
 * bleibt). Ohne E-Mail bleibt der Gutschein gültig (`NO_EMAIL`).
 *
 * Härtung RA-9: „Gutschein jetzt senden“ nach GESCHEITERTER bzw. blockierter
 * Vorzustellung legt eine NEUE Zustellung `voucher_delivery:<id>:retry:<prev>`
 * an die AKTUELLE Kundenadresse an (nur mit `retryOfDeliveryId` = aktuelle
 * Zustellung des Gutscheins, also nur als bewusste Staff-Aktion – automatisch
 * nie doppelt). Härtung H6: abgelaufene Gutscheine werden nie versendet
 * (`VOUCHER_EXPIRED`) – weder im Job noch im Sweep noch über die Route.
 */
import type { AppConfig } from '@mietroyal/config';
import { customers, mailDeliveries, vouchers, type Database } from '@mietroyal/database';
import { isVoucherExpired } from '@mietroyal/domain';
import type { JobHandler, JobQueue, JobRunnerLogger } from '@mietroyal/integrations';
import { and, asc, eq, gt, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';
import { customerDisplayName } from '../crm/customer-service.ts';
import { VOUCHER_PROBLEM_EXPIRED, VoucherDeliveryService } from '../voucher/voucher-delivery.ts';
import type { MailOutboxService } from './mail/outbox.ts';
import type { VoucherDeliveryMailContext } from './mail/templates/contexts.ts';
import { mailSalutation, transactionalKey, transactionalRetryKey } from './transactional/keys.ts';
import { VOUCHER_DELIVERY_JOB_TYPE, type OutboundMailGateway } from './types.ts';

export const VOUCHER_PROBLEM_NO_EMAIL = 'NO_EMAIL';
export const VOUCHER_PROBLEM_UNDECRYPTABLE = 'DELIVERY_COPY_UNDECRYPTABLE';
export const VOUCHER_PROBLEM_MAIL_FAILED = 'MAIL_FAILED';
export { VOUCHER_PROBLEM_EXPIRED };

/**
 * Automatischer Versand (kein Staff-Klick) nur bei EXPLIZIT konfiguriertem
 * Mailversand: Gateway nicht deaktiviert UND MAIL_ENABLED mit vollständigen
 * SMTP-Daten. In jeder echten Umgebung ist das dasselbe (SMTP ⇔
 * config.mail.enabled; Fake ist in production verboten); fail-closed, weil
 * der erfolgreiche Versand die Versandkopie unwiderruflich löscht.
 */
export function voucherMailConfigured(
  config: Pick<AppConfig, 'mail'>,
  gateway: Pick<OutboundMailGateway, 'kind'>,
): boolean {
  return gateway.kind !== 'disabled' && config.mail.enabled;
}

export function voucherDeliveryJobKey(voucherId: string, suffix?: string): string {
  return suffix === undefined
    ? `${VOUCHER_DELIVERY_JOB_TYPE}:${voucherId}`
    : `${VOUCHER_DELIVERY_JOB_TYPE}:${voucherId}:${suffix}`;
}

/**
 * Job einreihen (Wiederholung mit demselben Schlüssel ist ein No-op).
 * `retryOfDeliveryId` nur für die bewusste Staff-Aktion nach gescheiterter
 * Vorzustellung (Härtung RA-9).
 */
export async function enqueueVoucherDelivery(
  queue: JobQueue,
  voucherId: string,
  suffix?: string,
  options: { retryOfDeliveryId?: string | null } = {},
): Promise<void> {
  const retryOfDeliveryId = options.retryOfDeliveryId ?? null;
  await queue.enqueue(
    VOUCHER_DELIVERY_JOB_TYPE,
    retryOfDeliveryId === null ? { voucherId } : { voucherId, retryOfDeliveryId },
    { idempotencyKey: voucherDeliveryJobKey(voucherId, suffix) },
  );
}

/**
 * Sweep (von `communication.scan_due`, Agent R): offene Zustellungen ohne
 * Outbox-Zeile erneut einreihen – Zeit-Bucket im Schlüssel, weil Jobschlüssel
 * für immer UNIQUE sind. Gutscheine mit vorhandener (gescheiterter) Zustellung
 * laufen über den manuellen Resend der Outbox, nie automatisch doppelt.
 */
export async function enqueuePendingVoucherDeliveries(deps: {
  db: Database;
  queue: JobQueue;
  now?: Date;
  limit?: number;
  /** Optional: ohne konfigurierten Mailversand keine (wirkungslosen) Jobs einreihen. */
  config?: Pick<AppConfig, 'mail'>;
}): Promise<number> {
  if (deps.config !== undefined && !deps.config.mail.enabled) return 0;
  const now = deps.now ?? new Date();
  const bucket = now.toISOString().slice(0, 13);
  // Härtung H6: abgelaufene, nie versendete Gutscheine sichtbar markieren – kein Versand mehr.
  await deps.db
    .update(vouchers)
    .set({ deliveryProblemCode: VOUCHER_PROBLEM_EXPIRED, updatedAt: now })
    .where(
      and(
        eq(vouchers.deliveryStatus, 'pending'),
        isNotNull(vouchers.deliveryCodeCiphertext),
        isNull(vouchers.mailDeliveryId),
        lte(vouchers.expiresAt, now),
        or(
          isNull(vouchers.deliveryProblemCode),
          ne(vouchers.deliveryProblemCode, VOUCHER_PROBLEM_EXPIRED),
        ),
      ),
    );
  const rows = await deps.db
    .select({ id: vouchers.id })
    .from(vouchers)
    .innerJoin(customers, eq(customers.id, vouchers.customerId))
    .where(
      and(
        eq(vouchers.deliveryStatus, 'pending'),
        isNotNull(vouchers.deliveryCodeCiphertext),
        isNull(vouchers.mailDeliveryId),
        gt(vouchers.expiresAt, now),
        isNotNull(customers.email),
      ),
    )
    .orderBy(asc(vouchers.createdAt))
    .limit(deps.limit ?? 100);
  for (const row of rows) await enqueueVoucherDelivery(deps.queue, row.id, `sweep:${bucket}`);
  return rows.length;
}

export interface VoucherDeliveryJobDeps {
  db: Database;
  config: AppConfig;
  outbox: MailOutboxService;
  mailGateway: Pick<OutboundMailGateway, 'kind'>;
  logger?: JobRunnerLogger | undefined;
}

export type VoucherDeliveryOutcome =
  | 'queued'
  | 'already_queued'
  | 'not_pending'
  | 'expired'
  | 'no_email'
  | 'mail_not_configured'
  | 'undecryptable'
  | 'blocked';

export class VoucherDeliveryJob {
  private readonly deliveries: VoucherDeliveryService;

  constructor(private readonly deps: VoucherDeliveryJobDeps) {
    this.deliveries = new VoucherDeliveryService(deps.db, deps.config);
  }

  async process(
    voucherId: string,
    now = new Date(),
    options: { retryOfDeliveryId?: string | null } = {},
  ): Promise<VoucherDeliveryOutcome> {
    const rows = await this.deps.db
      .select({ voucher: vouchers, customer: customers })
      .from(vouchers)
      .innerJoin(customers, eq(customers.id, vouchers.customerId))
      .where(eq(vouchers.id, voucherId));
    const hit = rows[0];
    if (hit === undefined) return 'not_pending';
    const { voucher, customer } = hit;
    if (voucher.deliveryStatus !== 'pending' || voucher.deliveryCodeCiphertext === null) {
      return 'not_pending';
    }
    // Härtung H6: abgelaufene Gutscheine nie versenden (Gutschein bleibt, wie er ist).
    if (isVoucherExpired(voucher.expiresAt, now)) {
      await this.setProblem(voucherId, VOUCHER_PROBLEM_EXPIRED, now);
      return 'expired';
    }
    // Automatisch nie doppelt: existiert bereits eine Zustellung, entscheidet die Outbox –
    // außer bei der bewussten Staff-Aktion nach GESCHEITERTER Vorzustellung (RA-9).
    let retryOf: string | null = null;
    if (voucher.mailDeliveryId !== null) {
      if (options.retryOfDeliveryId !== voucher.mailDeliveryId) return 'already_queued';
      const previous = await this.deps.db
        .select({ status: mailDeliveries.status })
        .from(mailDeliveries)
        .where(eq(mailDeliveries.id, voucher.mailDeliveryId));
      const previousStatus = previous[0]?.status ?? 'failed';
      if (previousStatus !== 'failed' && previousStatus !== 'blocked') return 'already_queued';
      retryOf = voucher.mailDeliveryId;
    }
    const email = (customer.email ?? '').trim();
    if (email === '') {
      await this.setProblem(voucherId, VOUCHER_PROBLEM_NO_EMAIL, now);
      return 'no_email';
    }
    if (!voucherMailConfigured(this.deps.config, this.deps.mailGateway)) {
      // Gutschein bleibt gültig und pending; der Sweep versucht es später erneut.
      return 'mail_not_configured';
    }
    let code: string;
    try {
      code = await this.deliveries.revealCodeForDelivery(voucherId);
    } catch {
      await this.setProblem(voucherId, VOUCHER_PROBLEM_UNDECRYPTABLE, now);
      this.deps.logger?.error(
        { voucher: { voucherId, problem: VOUCHER_PROBLEM_UNDECRYPTABLE } },
        'voucher.delivery: Versandkopie nicht entschlüsselbar – kein Versand',
      );
      return 'undecryptable';
    }
    const context: VoucherDeliveryMailContext = {
      salutation: mailSalutation(customerDisplayName(customer)),
      validUntil: voucher.expiresAt.toISOString(),
    };
    const result = await this.deps.outbox.enqueueAndSchedule({
      kind: 'voucher_delivery',
      processId: voucher.originProcessId,
      customerId: voucher.customerId,
      bookingId: voucher.originBookingId,
      recipient: { email, name: customerDisplayName(customer) },
      context,
      secrets: { voucherCode: code },
      idempotencyKey:
        retryOf === null
          ? transactionalKey('voucher_delivery', voucherId)
          : transactionalRetryKey('voucher_delivery', voucherId, retryOf),
    });
    await this.deps.db
      .update(vouchers)
      .set({
        mailDeliveryId: result.deliveryId,
        deliveryProblemCode: result.status === 'pending' ? null : result.status,
        updatedAt: now,
      })
      .where(
        and(
          eq(vouchers.id, voucherId),
          eq(vouchers.deliveryStatus, 'pending'),
          retryOf === null ? isNull(vouchers.mailDeliveryId) : eq(vouchers.mailDeliveryId, retryOf),
        ),
      );
    this.deps.logger?.info(
      { voucher: { voucherId, mailDeliveryId: result.deliveryId, status: result.status } },
      'voucher.delivery: Gutscheinmail eingereiht',
    );
    return result.status === 'pending' ? 'queued' : 'blocked';
  }

  private async setProblem(voucherId: string, code: string, now: Date): Promise<void> {
    await this.deps.db
      .update(vouchers)
      .set({ deliveryProblemCode: code, updatedAt: now })
      .where(and(eq(vouchers.id, voucherId), eq(vouchers.deliveryStatus, 'pending')));
  }
}

export function createVoucherDeliveryHandler(deps: VoucherDeliveryJobDeps): JobHandler {
  const job = new VoucherDeliveryJob(deps);
  return async (queued) => {
    const payload = queued.payload as { voucherId?: unknown; retryOfDeliveryId?: unknown } | null;
    const voucherId = payload?.voucherId;
    if (typeof voucherId !== 'string' || voucherId === '') {
      throw new Error('voucher.delivery: Payload ohne voucherId');
    }
    const retryOfDeliveryId =
      typeof payload?.retryOfDeliveryId === 'string' ? payload.retryOfDeliveryId : null;
    const outcome = await job.process(voucherId, new Date(), { retryOfDeliveryId });
    deps.logger?.info(
      { jobId: queued.id, voucher: { voucherId, outcome }, attempt: queued.attempts },
      'voucher.delivery verarbeitet',
    );
  };
}
