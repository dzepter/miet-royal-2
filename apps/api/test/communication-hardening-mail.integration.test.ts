/**
 * Phase 12 Härtung (Review A, Zusatzauftrag an Fix-Agent B – send-job.ts):
 * Regressionstests zu den Funden
 *  RA-2  hängende `sending`-Zeile (Absturz nach SMTP-Annahme) wird NICHT
 *        erneut versendet, sondern als outcome_unknown (SENDING_STALE)
 *        abgeschlossen,
 *  RA-5  (= Review B7) Erinnerung im Retry nach Terminverschiebung/Storno wird
 *        nicht mit dem alten Termin zugestellt (Pre-Send-Guard),
 *        ergänzt: Angebotsmail einer abgelösten Version ⇒ blocked SUPERSEDED,
 *  RA-13 Demo-Whitelist wird auch unmittelbar vor dem Versand geprüft.
 * Kein echter Provider: FakeMailGateway bzw. ein „annehmen und hängen“-Gateway.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@mietroyal/config';
import { appointments, mailDeliveries, processes, type MailDeliveryRow } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAIL_BLOCKED_OFFER_SUPERSEDED } from '../src/commerce/offer-mail-guard.ts';
import { FakeMailGateway } from '../src/communication/mail/gateways.ts';
import { MailOutboxService } from '../src/communication/mail/outbox.ts';
import {
  MAIL_OUTCOME_SENDING_STALE,
  MailSendProcessor,
  type MailFailedListener,
} from '../src/communication/mail/send-job.ts';
import { PayloadCrypto } from '../src/communication/payload-crypto.ts';
import {
  MAIL_BLOCKED_STALE_APPOINTMENT,
  reminderDueAt,
} from '../src/communication/reminders/service.ts';
import { scheduleOutboxBackstop } from '../src/communication/scan-due.ts';
import type {
  MailEnqueueInput,
  OutboundMailGateway,
  OutboundMailMessage,
  OutboundMailOutcome,
} from '../src/communication/types.ts';
import {
  createTestContext,
  destroyTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import {
  commerceServices,
  createCommerceWorld,
  setPickupExactAddress,
  truncateCommerceTables,
} from './commerce-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import { DAYS } from './handover-helpers.ts';
import {
  createAcceptedBooking,
  schedulingServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';
import { adminSession } from './settlement-helpers.ts';

const MINUTES = 60_000;
let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      MAIL_ENABLED: 'true',
      MAIL_SMTP_HOST: 'smtp.test.example',
      MAIL_SMTP_USER: 'mailer@miet-royal.test',
      MAIL_SMTP_PASSWORD: 'smtp-password-hardening',
      MAIL_FROM_NAME: 'Miet-Royal Mainz',
      MAIL_FROM_ADDRESS: 'noreply@miet-royal.test',
      MAIL_PUBLIC_WEB_BASE_URL: 'https://web.test.example',
    },
  });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query(
    'TRUNCATE appointment_reminders, customer_action_tokens, booking_customer_contacts, mail_deliveries, integration_jobs CASCADE',
  );
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  ctx.mailGateway.reset();
});

async function drain(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if ((await ctx.jobs.runOnce()) === 'idle') break;
  }
}

async function row(id: string): Promise<MailDeliveryRow> {
  const rows = await ctx.db.select().from(mailDeliveries).where(eq(mailDeliveries.id, id));
  if (rows[0] === undefined) throw new Error('Zustellung fehlt');
  return rows[0];
}

/** Prozessor wie im Worker (Listener + Pre-Send-Guards des Kontexts). */
function processorWith(
  gateway: OutboundMailGateway,
  now?: () => Date,
  failedListeners: () => readonly MailFailedListener[] = ctx.communication.mailFailedListeners,
) {
  const c = ctx.communication;
  return new MailSendProcessor({
    db: c.db,
    config: c.config,
    crypto: c.crypto,
    gateway,
    queue: c.queue,
    documents: c.documents,
    invoiceFiles: c.invoiceFileFetcher,
    sentListeners: c.mailSentListeners,
    failedListeners,
    preSendGuards: c.mailPreSendGuards,
    ...(now === undefined ? {} : { now }),
  });
}

function returnProtocolInput(key = `hardening:${randomUUID()}`): MailEnqueueInput {
  return {
    kind: 'return_protocol',
    recipient: { email: 'kunde@example.org', name: 'Max Mustermann' },
    context: {
      salutation: 'Hallo Max,',
      processNumber: 'MR-2026-0001',
      returnAt: '2026-10-18T10:00:00Z',
    },
    idempotencyKey: key,
  };
}

/** Gateway, das die Nachricht „annimmt“ und dann nie antwortet (Worker stirbt danach). */
class AcceptThenHangGateway implements OutboundMailGateway {
  readonly kind = 'fake' as const;
  readonly seen: OutboundMailMessage[] = [];
  send(message: OutboundMailMessage): Promise<OutboundMailOutcome> {
    this.seen.push(message);
    return new Promise<OutboundMailOutcome>(() => undefined);
  }
  async verify() {
    return { ok: true, code: null };
  }
}

describe('Härtung Review A – hängender Versand (RA-2)', () => {
  it('RA-2. Absturz nach SMTP-Annahme: die veraltete `sending`-Zeile wird nach 15 min NICHT erneut versendet, sondern outcome_unknown (SENDING_STALE), Fehler-Listener benachrichtigt; nur manuelles Resend', async () => {
    const enqueued = await ctx.communication.outbox.enqueue(returnProtocolInput());
    const hanging = new AcceptThenHangGateway();
    void processorWith(hanging).process(enqueued.deliveryId);
    for (let i = 0; i < 100 && hanging.seen.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(hanging.seen).toHaveLength(1);
    expect((await row(enqueued.deliveryId)).status).toBe('sending');

    // Vor Ablauf der 15 min: No-op.
    const early = await processorWith(ctx.mailGateway).process(enqueued.deliveryId);
    expect(early).toEqual({ outcome: 'noop', status: 'sending' });

    // 16 Minuten später: Backstop plant einen Job – der schließt die Zeile als unklar ab.
    const later = new Date(Date.now() + 16 * MINUTES);
    expect(await scheduleOutboxBackstop(ctx.db, ctx.queue, later)).toBe(1);
    const failures: { status: string; errorCode: string | null }[] = [];
    const listener: MailFailedListener = {
      mailFailed: async (_delivery, result) => {
        failures.push(result);
      },
    };
    const second = await processorWith(
      ctx.mailGateway,
      () => later,
      () => [listener],
    ).process(enqueued.deliveryId);
    expect(second).toEqual({ outcome: 'outcome_unknown', errorCode: MAIL_OUTCOME_SENDING_STALE });
    expect(ctx.mailGateway.attempts).toHaveLength(0);
    expect(failures).toEqual([
      { status: 'outcome_unknown', errorCode: MAIL_OUTCOME_SENDING_STALE },
    ]);
    const after = await row(enqueued.deliveryId);
    expect(after).toMatchObject({
      status: 'outcome_unknown',
      lastErrorCode: MAIL_OUTCOME_SENDING_STALE,
      sendingSince: null,
      attempts: 1,
    });
    // Wiederholung (Replay) bleibt ein No-op; „erneut senden“ ist möglich.
    expect(await processorWith(ctx.mailGateway, () => later).process(enqueued.deliveryId)).toEqual({
      outcome: 'noop',
      status: 'outcome_unknown',
    });
    const resent = await ctx.communication.outbox.resend(enqueued.deliveryId, null);
    expect(resent.status).toBe('pending');
    expect(resent.messageId).not.toBe(enqueued.messageId);
  });
});

// ── RA-5 (= B7): Erinnerung im Retry nach Terminänderung/Storno ────────────

function futureStart(days = 8): Date {
  const start = new Date(Date.now() + days * DAYS);
  start.setUTCMinutes(0, 0, 0);
  return start;
}

async function pickupWorld(adminId: string, startAt: Date) {
  const booking = await createAcceptedBooking(ctx, adminId, { fulfillment: 'pickup' });
  const scheduling = schedulingServiceFor(ctx);
  await scheduling.ensureAppointmentsForBooking(booking.bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, booking.bookingId));
  const outbound = rows.find((r) => r.kind === 'pickup')!;
  await scheduling.reschedule(adminId, outbound.id, {
    startAt,
    endAt: null,
    expectedVersion: outbound.version,
  });
  await drain();
  ctx.mailGateway.reset();
  return { ...booking, outboundId: outbound.id, scheduling };
}

async function reminderInRetry(adminId: string, startAt: Date) {
  const w = await pickupWorld(adminId, startAt);
  await ctx.scan.reminders.scanDue(
    new Date(reminderDueAt('reminder_1_day', startAt).getTime() + MINUTES),
  );
  ctx.mailGateway.nextOutcomes({ outcome: 'transient_error', code: 'SMTP_421' });
  await drain();
  const deliveries = (await ctx.db.select().from(mailDeliveries)).filter(
    (r) => r.kind === 'reminder_1_day',
  );
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0]!.status).toBe('retry');
  ctx.mailGateway.reset();
  return { w, delivery: deliveries[0]! };
}

describe('Härtung Review A – Erinnerung im Retry nach Terminänderung/Storno (RA-5 = B7)', () => {
  it('RA-5a. Verschobener Termin: die alte 1-Tag-Erinnerung wird beim Retry NICHT zugestellt (blocked STALE_APPOINTMENT)', async () => {
    const { admin } = await adminSession(ctx);
    await setPickupExactAddress(ctx, admin.id);
    const oldStart = futureStart();
    const { w, delivery } = await reminderInRetry(admin.id, oldStart);
    const current = (
      await ctx.db.select().from(appointments).where(eq(appointments.id, w.outboundId))
    )[0]!;
    await w.scheduling.reschedule(admin.id, w.outboundId, {
      startAt: new Date(oldStart.getTime() + 2 * DAYS),
      endAt: null,
      expectedVersion: current.version,
    });
    const result = await processorWith(
      ctx.mailGateway,
      () => new Date(Date.now() + 5 * MINUTES),
    ).process(delivery.id);
    expect(result).toEqual({ outcome: 'blocked', errorCode: MAIL_BLOCKED_STALE_APPOINTMENT });
    expect(ctx.mailGateway.attempts).toHaveLength(0);
    expect((await row(delivery.id)).blockedReason).toBe(MAIL_BLOCKED_STALE_APPOINTMENT);
  });

  it('RA-5b. Stornierter Vorgang/Termin: die 1-Tag-Erinnerung im Retry wird nicht zugestellt', async () => {
    const { admin } = await adminSession(ctx);
    await setPickupExactAddress(ctx, admin.id);
    const { w, delivery } = await reminderInRetry(admin.id, futureStart());
    await ctx.db.transaction(async (tx) => {
      await w.scheduling.cancelForProcessWithin(tx, w.processId, new Date());
      await tx
        .update(processes)
        .set({ mainStatus: 'cancelled', cancelledAt: new Date() })
        .where(eq(processes.id, w.processId));
    });
    const result = await processorWith(
      ctx.mailGateway,
      () => new Date(Date.now() + 5 * MINUTES),
    ).process(delivery.id);
    expect(result).toEqual({ outcome: 'blocked', errorCode: MAIL_BLOCKED_STALE_APPOINTMENT });
    expect(ctx.mailGateway.attempts).toHaveLength(0);
  });

  it('RA-5c. Angebotsmail einer inzwischen abgelösten Version (neue Version angelegt) wird nicht mehr versendet (blocked SUPERSEDED); die aktuelle Version geht regulär raus', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createCommerceWorld(ctx, admin.id);
    const services = commerceServices(ctx);
    const { offerId, versionId } = await services.offers.createOffer(admin.id, world.processId);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    // Versand eingereiht, Job aber noch nicht gelaufen (SMTP-Stau) …
    await services.offers.send(admin.id, versionId, effective);
    const pending = (await ctx.db.select().from(mailDeliveries)).find((r) => r.kind === 'offer')!;
    expect(pending.status).toBe('pending');
    // … während Staff bereits eine neue Version anlegt (alte Version abgelöst).
    await services.offers.createNewVersion(admin.id, offerId, 'Menge angepasst');
    await drain();
    expect(await row(pending.id)).toMatchObject({
      status: 'blocked',
      blockedReason: MAIL_BLOCKED_OFFER_SUPERSEDED,
    });
    expect(ctx.mailGateway.attempts.filter((m) => m.messageId === pending.messageId)).toHaveLength(
      0,
    );
  });

  it('RA-5d (Kontrolle). Unveränderte Angebotsversion wird regulär versendet', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createCommerceWorld(ctx, admin.id);
    const services = commerceServices(ctx);
    const { versionId } = await services.offers.createOffer(admin.id, world.processId);
    await services.offers.send(admin.id, versionId, await ctx.auth.effectivePermissions(admin.id));
    await drain();
    const offer = (await ctx.db.select().from(mailDeliveries)).find((r) => r.kind === 'offer')!;
    expect(offer.status).toBe('sent');
  });
});

// ── RA-13: Demo-Whitelist beim Versand ─────────────────────────────────────

function demo(whitelist: string) {
  const config = loadConfig({
    APP_ENV: 'demo',
    DATABASE_URL: ctx.config.databaseUrl,
    AUTH_SECRET_KEY: '2'.repeat(64),
    COMMUNICATION_PAYLOAD_KEY: 'd2'.repeat(32),
    STORAGE_DRIVER: 'fs',
    STORAGE_FS_ROOT: ctx.config.storage.driver === 'fs' ? ctx.config.storage.fsRoot : '/tmp/x',
    MAIL_ENABLED: 'true',
    MAIL_SMTP_HOST: 'smtp.demo.example',
    MAIL_SMTP_USER: 'u',
    MAIL_SMTP_PASSWORD: 'p',
    MAIL_FROM_ADDRESS: 'demo@miet-royal.test',
    MAIL_DEMO_WHITELIST: whitelist,
    MAIL_PUBLIC_WEB_BASE_URL: 'https://demo.miet-royal.test',
  });
  const gateway = new FakeMailGateway();
  const crypto = new PayloadCrypto(config);
  const outbox = new MailOutboxService(ctx.db, config, crypto, gateway, ctx.queue);
  const processor = new MailSendProcessor({
    db: ctx.db,
    config,
    crypto,
    gateway,
    queue: ctx.queue,
    documents: ctx.communication.documents,
    invoiceFiles: () => null,
    sentListeners: () => [],
    failedListeners: () => [],
  });
  return { gateway, outbox, processor };
}

describe('Härtung Review A – Demo-Whitelist beim Versand (RA-13)', () => {
  it('RA-13. Verschärfte Whitelist greift auch für bereits eingereihte Zustellungen: blocked DEMO_NOT_WHITELISTED, kein Versand; freigegebene Adresse geht weiter raus', async () => {
    const before = demo('@example.org');
    const blocked = await before.outbox.enqueue({
      ...returnProtocolInput('ra13-hardening-1'),
      recipient: { email: 'echter.kunde@example.org', name: 'Echter Kunde' },
    });
    const allowed = await before.outbox.enqueue({
      ...returnProtocolInput('ra13-hardening-2'),
      recipient: { email: 'tester@example.org', name: 'Tester' },
    });
    expect(blocked.status).toBe('pending');
    expect(allowed.status).toBe('pending');

    // Neustart mit eng gefasster Whitelist.
    const after = demo('tester@example.org');
    expect(await after.processor.process(blocked.deliveryId)).toEqual({
      outcome: 'blocked',
      errorCode: 'DEMO_NOT_WHITELISTED',
    });
    expect(await row(blocked.deliveryId)).toMatchObject({
      status: 'blocked',
      blockedReason: 'DEMO_NOT_WHITELISTED',
    });
    expect(await after.processor.process(allowed.deliveryId)).toEqual({
      outcome: 'sent',
      errorCode: null,
    });
    expect(after.gateway.attempts.map((m) => m.to.email)).toEqual(['tester@example.org']);
    expect(after.gateway.sent[0]!.subject.startsWith('[DEMO] ')).toBe(true);
  });
});
