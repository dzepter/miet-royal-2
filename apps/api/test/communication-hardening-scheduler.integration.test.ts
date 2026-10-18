/**
 * Phase 12 Härtung (Review B) – Scheduler-Kette und Erinnerungsversand:
 * Regressionstests zu den Funden
 *  B6  Worker-Uhr hinter DB-Uhr reißt die Self-Re-Enqueue-Kette nicht mehr ab
 *      (Folge-Bucket aus dem Payload) + Ketten-Watchdog im Worker,
 *  B7  Erinnerung/Terminänderung im Retry wird nach Verschiebung/Storno NICHT
 *      mehr versendet (Pre-Send-Guard ⇒ blocked STALE_APPOINTMENT),
 * sowie die geprüften Punkte ohne Fund OK-3/OK-4/OK-7.
 */
import {
  appointmentOverdueIncidents,
  appointments,
  bookings,
  integrationJobs,
  mailDeliveries,
  processes,
  pushDeliveries,
} from '@mietroyal/database';
import type { ClaimedJob } from '@mietroyal/integrations';
import { and, eq, gt } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { followUpBucket, startChainWatchdog } from '../src/communication/chain-bucket.ts';
import {
  createInboundPollHandler,
  inboundPollIdempotencyKey,
} from '../src/communication/inbound/poll-job.ts';
import type { InboundMailProcessor } from '../src/communication/inbound/processor.ts';
import { PushService } from '../src/communication/push/push-service.ts';
import { PushRuleScanner } from '../src/communication/push/rules.ts';
import {
  MAIL_BLOCKED_STALE_APPOINTMENT,
  reminderDueAt,
} from '../src/communication/reminders/service.ts';
import {
  createScanDueHandler,
  enqueueScanDue,
  SCAN_DUE_INTERVAL_MS,
  scanDueIdempotencyKey,
} from '../src/communication/scan-due.ts';
import {
  COMMUNICATION_SCAN_DUE_JOB_TYPE,
  MAIL_INBOUND_POLL_JOB_TYPE,
} from '../src/communication/types.ts';
import {
  createTestContext,
  destroyTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { setPickupExactAddress, truncateCommerceTables } from './commerce-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import { DAYS, HOURS } from './handover-helpers.ts';
import {
  createAcceptedBooking,
  schedulingServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';
import { adminSession } from './settlement-helpers.ts';

let ctx: TestContext;
const MINUTES = 60_000;

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      MAIL_ENABLED: 'true',
      MAIL_SMTP_HOST: 'smtp.test.example',
      MAIL_SMTP_USER: 'mailer@miet-royal.test',
      MAIL_SMTP_PASSWORD: 'smtp-password-never-logged',
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
    'TRUNCATE appointment_reminders, customer_action_tokens, booking_customer_contacts, mail_deliveries, push_deliveries, push_subscriptions, integration_jobs CASCADE',
  );
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  ctx.mailGateway.reset();
});

function claimed(id: string, idempotencyKey: string, payload: unknown = {}): ClaimedJob {
  return {
    id,
    type: COMMUNICATION_SCAN_DUE_JOB_TYPE,
    payload,
    idempotencyKey,
    attempts: 1,
    maxAttempts: 3,
    claimedBy: 'hardening-b',
  };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 100; i += 1) if ((await ctx.jobs.runOnce()) === 'idle') break;
}

async function futureJobs(type: string, after: Date) {
  return ctx.db
    .select()
    .from(integrationJobs)
    .where(and(eq(integrationJobs.type, type), gt(integrationJobs.runAt, after)));
}

function scanHandler(at: () => Date) {
  return createScanDueHandler({
    db: ctx.db,
    queue: ctx.queue,
    scanners: [],
    retention: ctx.scan.retention,
    now: at,
  });
}

describe('Härtung Review B – Self-Re-Enqueue-Kette (B6)', () => {
  it('B6. Worker-Uhr 5 ms hinter der DB-Uhr: der Bucket-Job reiht trotzdem genau EINEN Folgejob (Bucket + 2 min) ein – die scan_due-Kette reißt nicht ab', async () => {
    const bucket = new Date(Math.ceil(Date.now() / SCAN_DUE_INTERVAL_MS) * SCAN_DUE_INTERVAL_MS);
    const payload = { bucket: bucket.toISOString() };
    const enq = await ctx.queue.enqueue(COMMUNICATION_SCAN_DUE_JOB_TYPE, payload, {
      idempotencyKey: scanDueIdempotencyKey(bucket),
      runAt: bucket,
      maxAttempts: 3,
    });
    const handler = scanHandler(() => new Date(bucket.getTime() - 5));
    await handler(claimed(enq.jobId, scanDueIdempotencyKey(bucket), payload));
    // Replay desselben Laufs (Lease abgelaufen) ⇒ kein zweiter Folgejob.
    await handler(claimed(enq.jobId, scanDueIdempotencyKey(bucket), payload));
    const future = await futureJobs(COMMUNICATION_SCAN_DUE_JOB_TYPE, bucket);
    const next = new Date(bucket.getTime() + SCAN_DUE_INTERVAL_MS);
    expect(future).toHaveLength(1);
    expect(future[0]!.idempotencyKey).toBe(scanDueIdempotencyKey(next));
    expect(future[0]!.runAt.toISOString()).toBe(next.toISOString());
    expect(future[0]!.payload).toEqual({ bucket: next.toISOString() });
  });

  it('B6b. Dieselbe Kettenlogik im IMAP-Poller (mail.inbound_poll): Folge-Bucket aus dem Payload', async () => {
    const bucket = new Date(Math.ceil(Date.now() / SCAN_DUE_INTERVAL_MS) * SCAN_DUE_INTERVAL_MS);
    const payload = { bucket: bucket.toISOString() };
    await ctx.queue.enqueue(MAIL_INBOUND_POLL_JOB_TYPE, payload, {
      idempotencyKey: inboundPollIdempotencyKey(bucket),
      runAt: bucket,
    });
    const processor = {
      pollOnce: async (mailbox: string) => ({
        mailbox,
        fetched: 0,
        lastUid: null,
        errorCode: null,
      }),
    } as unknown as InboundMailProcessor;
    const handler = createInboundPollHandler({
      processor,
      source: { kind: 'imap' } as never,
      queue: ctx.queue,
      mailbox: 'INBOX',
      now: () => new Date(bucket.getTime() - 5),
    });
    await handler({ ...claimed('x', 'x', payload), type: MAIL_INBOUND_POLL_JOB_TYPE });
    const future = await futureJobs(MAIL_INBOUND_POLL_JOB_TYPE, bucket);
    expect(future).toHaveLength(1);
    expect(future[0]!.idempotencyKey).toBe(
      inboundPollIdempotencyKey(new Date(bucket.getTime() + SCAN_DUE_INTERVAL_MS)),
    );
  });

  it('B6c. Folge-Bucket = max(Payload-Bucket + 2 min, Bucket nach now) – auch bei vorgehender Uhr und ohne Payload', () => {
    const b = new Date('2026-10-20T10:00:00.000Z');
    const iso = (d: Date) => d.toISOString();
    expect(iso(followUpBucket(b, new Date(b.getTime() - 5), SCAN_DUE_INTERVAL_MS))).toBe(
      '2026-10-20T10:02:00.000Z',
    );
    expect(iso(followUpBucket(b, new Date(b.getTime() + 30_000), SCAN_DUE_INTERVAL_MS))).toBe(
      '2026-10-20T10:02:00.000Z',
    );
    // Verspäteter Lauf (Backlog): nie in die Vergangenheit, sondern nach now.
    expect(iso(followUpBucket(b, new Date('2026-10-20T10:07:10.000Z'), SCAN_DUE_INTERVAL_MS))).toBe(
      '2026-10-20T10:08:00.000Z',
    );
    expect(
      iso(followUpBucket(null, new Date('2026-10-20T10:01:30.000Z'), SCAN_DUE_INTERVAL_MS)),
    ).toBe('2026-10-20T10:02:00.000Z');
  });

  it('B6d. Watchdog: setzt eine abgerissene Kette mit dem AKTUELLEN Bucket neu auf; bei intakter Kette dedupliziert; parallele Ketten laufen im nächsten Bucket zusammen (keine Doppelkette)', async () => {
    const t0 = new Date(Math.floor(Date.now() / SCAN_DUE_INTERVAL_MS) * SCAN_DUE_INTERVAL_MS);
    // Abgerissene Kette: kein Job vorhanden ⇒ Watchdog-Tick reiht den aktuellen Bucket ein.
    let ticks = 0;
    const watchdog = startChainWatchdog(
      [
        async () => {
          ticks += 1;
          await enqueueScanDue(ctx.queue, new Date(t0.getTime() + 10_000));
        },
      ],
      { intervalMs: 10 },
    );
    for (let i = 0; i < 200 && ticks < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    watchdog.stop();
    expect(ticks).toBeGreaterThanOrEqual(3);
    const all = await ctx.db
      .select()
      .from(integrationJobs)
      .where(eq(integrationJobs.type, COMMUNICATION_SCAN_DUE_JOB_TYPE));
    expect(all.map((job) => job.idempotencyKey)).toEqual([scanDueIdempotencyKey(t0)]);

    // Kette B (Job t0, verspätet im Backlog) + Watchdog-Kette (Job t0+2min) laufen
    // beide erst im Bucket t0+2min ⇒ beide reihen t0+4min ein ⇒ genau EIN Folgejob.
    const t1 = new Date(t0.getTime() + SCAN_DUE_INTERVAL_MS);
    await enqueueScanDue(ctx.queue, new Date(t1.getTime() + 5_000));
    const late = () => new Date(t1.getTime() + 20_000);
    await scanHandler(late)(claimed('a', 'a', { bucket: t0.toISOString() }));
    await scanHandler(late)(claimed('b', 'b', { bucket: t1.toISOString() }));
    const future = await futureJobs(COMMUNICATION_SCAN_DUE_JOB_TYPE, t1);
    expect(future.map((job) => job.idempotencyKey)).toEqual([
      scanDueIdempotencyKey(new Date(t1.getTime() + SCAN_DUE_INTERVAL_MS)),
    ]);
  });
});

describe('Härtung Review B – Doppelketten (OK)', () => {
  it('OK-7 (Review B, kein Fund): zwei Worker-Boots in verschiedenen Buckets + Replay eines Laufs ⇒ genau EIN ausstehender Folgejob', async () => {
    const t0 = new Date(Math.floor(Date.now() / SCAN_DUE_INTERVAL_MS) * SCAN_DUE_INTERVAL_MS);
    const t1 = new Date(t0.getTime() + 30_000);
    const t2 = new Date(t0.getTime() + SCAN_DUE_INTERVAL_MS + 10_000);
    await enqueueScanDue(ctx.queue, t1); // Worker A bootet
    await enqueueScanDue(ctx.queue, t2); // Worker B bootet im nächsten Bucket
    const run = (at: Date) =>
      createScanDueHandler({
        db: ctx.db,
        queue: ctx.queue,
        scanners: [],
        retention: ctx.scan.retention,
        now: () => at,
      })(claimed('x', 'x'));
    await run(t1);
    await run(t2);
    await run(t2); // Replay (Lease abgelaufen, erneut ausgeführt)
    const future = await ctx.db
      .select()
      .from(integrationJobs)
      .where(
        and(
          eq(integrationJobs.type, COMMUNICATION_SCAN_DUE_JOB_TYPE),
          gt(integrationJobs.runAt, t2),
        ),
      );
    expect(future).toHaveLength(1);
    expect(future[0]!.idempotencyKey).toBe(
      scanDueIdempotencyKey(new Date(t0.getTime() + 2 * SCAN_DUE_INTERVAL_MS)),
    );
  });
});

/** Buchung mit geplantem Pickup-Termin (alte Buchung ⇒ Reminder fällig). */
async function pickupWorld(adminId: string, startAt: Date) {
  const booking = await createAcceptedBooking(ctx, adminId, { fulfillment: 'pickup' });
  const scheduling = schedulingServiceFor(ctx);
  await scheduling.ensureAppointmentsForBooking(booking.bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, booking.bookingId));
  const pickup = rows.find((row) => row.kind === 'pickup')!;
  await scheduling.reschedule(adminId, pickup.id, {
    startAt,
    endAt: null,
    expectedVersion: pickup.version,
  });
  await ctx.db
    .update(bookings)
    .set({ createdAt: new Date(Date.now() - 60 * DAYS) })
    .where(eq(bookings.id, booking.bookingId));
  await drain();
  ctx.mailGateway.reset();
  return { ...booking, pickupId: pickup.id, scheduling };
}

describe('Härtung Review B – Reschedule-Race der Erinnerungen (B7)', () => {
  async function retryDue(kind: 'reminder_7_days' | 'reminder_1_day'): Promise<void> {
    await ctx.pool.query(
      "UPDATE mail_deliveries SET next_attempt_at = now() - interval '1 second' WHERE kind = $1",
      [kind],
    );
    await ctx.pool.query("UPDATE integration_jobs SET run_at = now() WHERE status = 'pending'");
    await drain();
  }

  it('B7. 7-Tage-Mail im Retry, Termin wird verschoben ⇒ der Retry versendet NICHT mehr mit dem alten Termin (blocked STALE_APPOINTMENT)', async () => {
    const { admin } = await adminSession(ctx);
    await setPickupExactAddress(ctx, admin.id);
    const oldStart = new Date(Date.now() + 7 * DAYS - 30 * MINUTES);
    oldStart.setUTCSeconds(0, 0);
    const w = await pickupWorld(admin.id, oldStart);
    ctx.mailGateway.nextOutcomes({ outcome: 'transient_error' });
    const summary = await ctx.scan.reminders.scanDue(new Date());
    expect(summary.enqueued).toBe(1);
    await drain();
    const [pending] = await ctx.db
      .select()
      .from(mailDeliveries)
      .where(eq(mailDeliveries.kind, 'reminder_7_days'));
    expect(pending!.status).toBe('retry');
    ctx.mailGateway.reset();

    const [current] = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.id, w.pickupId));
    await w.scheduling.reschedule(admin.id, w.pickupId, {
      startAt: new Date(oldStart.getTime() + 3 * DAYS),
      endAt: null,
      expectedVersion: current!.version,
    });

    await retryDue('reminder_7_days');
    const [row] = await ctx.db
      .select()
      .from(mailDeliveries)
      .where(eq(mailDeliveries.kind, 'reminder_7_days'));
    expect(row!.status).toBe('blocked');
    expect(row!.blockedReason).toBe(MAIL_BLOCKED_STALE_APPOINTMENT);
    expect(ctx.mailGateway.sent.filter((m) => m.subject.includes('Erinnerung'))).toHaveLength(0);
    expect(ctx.mailGateway.attempts).toHaveLength(0);
  });

  it('B7b. 1-Tag-Mail im Retry, Vorgang/Termin storniert ⇒ der Retry versendet nicht (blocked STALE_APPOINTMENT)', async () => {
    const { admin } = await adminSession(ctx);
    await setPickupExactAddress(ctx, admin.id);
    const start = new Date(Date.now() + 1 * DAYS - 30 * MINUTES);
    start.setUTCSeconds(0, 0);
    const w = await pickupWorld(admin.id, start);
    ctx.mailGateway.nextOutcomes({ outcome: 'transient_error' });
    await ctx.scan.reminders.scanDue(new Date());
    await drain();
    ctx.mailGateway.reset();
    await ctx.db
      .update(processes)
      .set({ mainStatus: 'cancelled', cancelledAt: new Date() })
      .where(eq(processes.id, w.processId));
    await ctx.db
      .update(appointments)
      .set({ status: 'cancelled', cancelledAt: new Date() })
      .where(eq(appointments.processId, w.processId));
    await retryDue('reminder_1_day');
    const [row] = await ctx.db
      .select()
      .from(mailDeliveries)
      .where(eq(mailDeliveries.kind, 'reminder_1_day'));
    expect(row!.status).toBe('blocked');
    expect(row!.blockedReason).toBe(MAIL_BLOCKED_STALE_APPOINTMENT);
    expect(ctx.mailGateway.attempts).toHaveLength(0);
  });

  it('B7c. Unveränderter Termin: der Retry versendet die Erinnerung regulär (Guard blockiert nur Veraltetes)', async () => {
    const { admin } = await adminSession(ctx);
    await setPickupExactAddress(ctx, admin.id);
    const start = new Date(Date.now() + 7 * DAYS - 30 * MINUTES);
    start.setUTCSeconds(0, 0);
    await pickupWorld(admin.id, start);
    expect(reminderDueAt('reminder_7_days', start).getTime()).toBeLessThan(Date.now());
    ctx.mailGateway.nextOutcomes({ outcome: 'transient_error' });
    await ctx.scan.reminders.scanDue(new Date());
    await drain();
    await retryDue('reminder_7_days');
    const [row] = await ctx.db
      .select()
      .from(mailDeliveries)
      .where(eq(mailDeliveries.kind, 'reminder_7_days'));
    expect(row!.status).toBe('sent');
    expect(ctx.mailGateway.sent.filter((m) => m.subject.includes('Erinnerung'))).toHaveLength(1);
  });

  it('B7d. Terminänderungs-Mail eingereiht, Termin danach storniert ⇒ nicht versendet (blocked STALE_APPOINTMENT)', async () => {
    const { admin } = await adminSession(ctx);
    const start = new Date(Date.now() + 9 * DAYS);
    start.setUTCMinutes(0, 0, 0);
    const w = await pickupWorld(admin.id, start);
    const [current] = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.id, w.pickupId));
    await w.scheduling.reschedule(admin.id, w.pickupId, {
      startAt: new Date(start.getTime() + 1 * DAYS),
      endAt: null,
      expectedVersion: current!.version,
    });
    const informed = await ctx.scan.appointmentInfo.informCustomer(admin.id, w.pickupId);
    expect(informed.status).toBe('pending');
    await ctx.db.transaction(async (tx) => {
      await w.scheduling.cancelForProcessWithin(tx, w.processId, new Date());
      await tx
        .update(processes)
        .set({ mainStatus: 'cancelled', cancelledAt: new Date() })
        .where(eq(processes.id, w.processId));
    });
    await drain();
    const [row] = await ctx.db
      .select()
      .from(mailDeliveries)
      .where(eq(mailDeliveries.id, informed.deliveryId));
    expect(row!.status).toBe('blocked');
    expect(row!.blockedReason).toBe(MAIL_BLOCKED_STALE_APPOINTMENT);
    expect(ctx.mailGateway.sent.filter((m) => m.subject.includes('Terminänderung'))).toHaveLength(
      0,
    );
  });
});

describe('Härtung Review B – DST und parallele Scans (OK)', () => {
  it('OK-3 (Review B, kein Fund): 7d/1d über die Umstellung (gleiche Wanduhrzeit); Termine um 02:30 in der Herbststunde', () => {
    // Frühjahr: Termin So 04.04.2027 10:00 CEST ⇒ 7d = So 28.03.2027 10:00 CEST (167 h).
    const spring = new Date('2027-04-04T08:00:00Z');
    expect(reminderDueAt('reminder_7_days', spring).toISOString()).toBe('2027-03-28T08:00:00.000Z');
    // Herbst: Termin Mo 26.10.2026 02:30 CET ⇒ 1d = So 25.10.2026 02:30 (erste, CEST-Variante) = 00:30Z.
    const fall = new Date('2026-10-26T01:30:00Z');
    expect(reminderDueAt('reminder_1_day', fall).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    // Termin in der doppelten Stunde (25.10.2026 02:30 CET = 01:30Z) ⇒ 7d = 18.10. 02:30 CEST.
    const doubled = new Date('2026-10-25T01:30:00Z');
    expect(reminderDueAt('reminder_7_days', doubled).toISOString()).toBe(
      '2026-10-18T00:30:00.000Z',
    );
    // Frühjahrslücke als Ziel: Termin So 04.04.2027 02:30 CEST ⇒ 28.03. 02:30 existiert nicht ⇒ 03:30 CEST.
    const gap = new Date('2027-04-04T00:30:00Z');
    expect(reminderDueAt('reminder_7_days', gap).toISOString()).toBe('2027-03-28T01:30:00.000Z');
  });

  it('OK-4 (Review B, kein Fund): parallele Scans (Reminder + Overdue-Push) ⇒ je eine Zustellung', async () => {
    const { admin } = await adminSession(ctx);
    await setPickupExactAddress(ctx, admin.id);
    const start = new Date(Date.now() + 7 * DAYS - 30 * MINUTES);
    const w = await pickupWorld(admin.id, start);
    const [ret] = await ctx.db
      .select()
      .from(appointments)
      .where(and(eq(appointments.bookingId, w.bookingId), eq(appointments.kind, 'return')));
    await w.scheduling.reschedule(admin.id, ret!.id, {
      startAt: new Date(Date.now() - 2 * HOURS),
      endAt: null,
      expectedVersion: ret!.version,
    });
    const scanner = () =>
      new PushRuleScanner({ db: ctx.db, push: new PushService(ctx.db, ctx.queue), auth: ctx.auth });
    const now = new Date();
    await Promise.all([
      ctx.scan.reminders.scanDue(now),
      ctx.scan.reminders.scanDue(now),
      ctx.scan.reminders.scanDue(now),
      scanner().scanOverdueReturns(now),
      scanner().scanOverdueReturns(now),
      scanner().scanOverdueReturns(now),
    ]);
    const reminders = await ctx.db
      .select()
      .from(mailDeliveries)
      .where(eq(mailDeliveries.kind, 'reminder_7_days'));
    expect(reminders).toHaveLength(1);
    expect(await ctx.db.select().from(appointmentOverdueIncidents)).toHaveLength(1);
    const overdue = (await ctx.db.select().from(pushDeliveries)).filter(
      (row) => row.kind === 'return_overdue',
    );
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.userId).toBe(admin.id);
  });
});
