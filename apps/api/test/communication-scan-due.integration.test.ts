/**
 * Phase 12 – Scheduler `communication.scan_due` (Order §32/§37): Boot-Enqueue
 * und Self-Re-Enqueue mit Zeit-Bucket-Schlüssel (2 min), Fehlertoleranz der
 * Scanner, Outbox-Backstop (pending/retry ohne Job, veraltetes `sending`),
 * täglicher Retention-Backstop-Job, Reihenfolge Reminder → Push-Regeln.
 */
import { integrationJobs, mailDeliveries } from '@mietroyal/database';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mailSendJobKey } from '../src/communication/mail/outbox.ts';
import { retentionBackstopJobKey, berlinDay } from '../src/communication/retention/cleanup.ts';
import {
  enqueueScanDue,
  nextScanDueBucket,
  OUTBOX_BACKSTOP_GRACE_MS,
  outboxBackstopJobKey,
  runScanDue,
  SCAN_DUE_INTERVAL_MS,
  scanDueBucketStart,
  scanDueIdempotencyKey,
  type DueScanner,
} from '../src/communication/scan-due.ts';
import {
  COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE,
  COMMUNICATION_SCAN_DUE_JOB_TYPE,
  MAIL_SEND_JOB_TYPE,
} from '../src/communication/types.ts';
import {
  createTestContext,
  destroyTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCommunicationTables, createCustomerWithProcess } from './communication-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import { adminSession } from './settlement-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      MAIL_ENABLED: 'true',
      MAIL_SMTP_HOST: 'smtp.test.example',
      MAIL_SMTP_USER: 'mailer@miet-royal.test',
      MAIL_SMTP_PASSWORD: 'smtp-password-never-logged',
      MAIL_FROM_NAME: 'Miet-Royal Mainz',
      MAIL_FROM_ADDRESS: 'noreply@miet-royal.test',
    },
  });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateCommunicationTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  ctx.mailGateway.reset();
});

async function jobsOfType(type: string) {
  return ctx.db
    .select()
    .from(integrationJobs)
    .where(eq(integrationJobs.type, type))
    .orderBy(asc(integrationJobs.runAt));
}

function scanDeps(scanners: DueScanner[], reenqueue = true) {
  return {
    db: ctx.db,
    queue: ctx.queue,
    scanners,
    retention: ctx.scan.retention,
    reenqueue,
  };
}

describe('Self-Re-Enqueue mit Bucket-Schlüssel', () => {
  it('Boot-Enqueue dedupliziert je 2-min-Bucket; jeder Lauf reiht die Zielminute mit eigenem Schlüssel ein', async () => {
    // Testzeitpunkt liegt sicher NACH der Echtzeit (morgen, 90 s nach einem Bucket-Beginn) –
    // datumsunabhängig statt eines festen Datums, das irgendwann in der Vergangenheit liegt.
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    const now = new Date(tomorrow - (tomorrow % SCAN_DUE_INTERVAL_MS) + 90_000);
    const bucket = scanDueBucketStart(now);
    expect(bucket.getTime()).toBe(now.getTime() - 90_000);
    expect(nextScanDueBucket(now).getTime()).toBe(bucket.getTime() + 120_000);
    expect(SCAN_DUE_INTERVAL_MS).toBe(120_000);
    await enqueueScanDue(ctx.queue, now);
    await enqueueScanDue(ctx.queue, new Date(now.getTime() + 20_000)); // gleicher Bucket ⇒ kein zweiter Job
    let jobs = await jobsOfType(COMMUNICATION_SCAN_DUE_JOB_TYPE);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.idempotencyKey).toBe(scanDueIdempotencyKey(bucket));

    // Der registrierte Handler des Test-Runners verarbeitet den Job und reiht den nächsten Bucket ein.
    // Phase 12 Härtung (B6): Folge-Bucket = max(Payload-Bucket + 2 min, Bucket nach now) – hier
    // liegt der Payload-Bucket (fester Testzeitpunkt) nach der Echtzeit ⇒ Payload-Bucket + 2 min.
    expect(await ctx.jobs.runOnce()).toBe('processed');
    jobs = await jobsOfType(COMMUNICATION_SCAN_DUE_JOB_TYPE);
    expect(jobs).toHaveLength(2);
    const next = jobs.find((job) => job.status === 'pending')!;
    expect(next.idempotencyKey).toBe(scanDueIdempotencyKey(nextScanDueBucket(now)));
    expect(next.idempotencyKey).toBe(scanDueIdempotencyKey(next.runAt));
    expect(next.runAt.getTime()).toBeGreaterThan(Date.now() - 1_000);

    // Direkter Lauf mit fester Zeit: Zielminute = Bucket-Beginn + 2 min, Wiederholung ist ein No-op.
    const fixed = new Date('2026-10-20T12:00:10.000Z');
    await runScanDue(scanDeps([]), fixed);
    await runScanDue(scanDeps([]), new Date(fixed.getTime() + 1_000));
    const chained = (await jobsOfType(COMMUNICATION_SCAN_DUE_JOB_TYPE)).filter((job) =>
      job.idempotencyKey.endsWith('2026-10-20T12:02:00.000Z'),
    );
    expect(chained).toHaveLength(1);
    expect(chained[0]!.runAt.toISOString()).toBe('2026-10-20T12:02:00.000Z');
  });

  it('Scanner-Fehler sind tolerant: der nächste Lauf ist bereits eingereiht, weitere Scanner laufen, Fehler werden mit Code gemeldet', async () => {
    const calls: string[] = [];
    const scanners: DueScanner[] = [
      {
        name: 'boom',
        scanDue: async () => {
          calls.push('boom');
          throw new TypeError('kaputt');
        },
      },
      {
        name: 'ok',
        scanDue: async (at) => {
          calls.push(`ok:${at.toISOString()}`);
        },
      },
    ];
    const now = new Date('2026-10-21T08:00:00.000Z');
    const result = await runScanDue(scanDeps(scanners), now);
    expect(calls).toEqual(['boom', 'ok:2026-10-21T08:00:00.000Z']);
    expect(result.scanners).toEqual([
      { name: 'boom', ok: false, errorCode: 'TypeError' },
      { name: 'ok', ok: true, errorCode: null },
    ]);
    const jobs = await jobsOfType(COMMUNICATION_SCAN_DUE_JOB_TYPE);
    expect(jobs.map((job) => job.idempotencyKey)).toContain(
      scanDueIdempotencyKey(new Date('2026-10-21T08:02:00.000Z')),
    );
  });

  it('Der produktive Scan enthält Reminder-, Push-, Gutschein- und Rechnungs-Scanner (Reminder zuerst)', () => {
    expect(ctx.scan.scanners.map((scanner) => scanner.name)).toEqual([
      'reminders',
      'push_rules',
      'voucher_sweep',
      'invoice_sweep',
    ]);
  });
});

describe('Outbox-Backstop', () => {
  async function pendingDelivery(processId: string, customerId: string, key: string) {
    const result = await ctx.communication.outbox.enqueue({
      kind: 'order_confirmation',
      processId,
      customerId,
      recipient: { email: 'kunde@example.org' },
      context: { salutation: 'Hallo,', processNumber: 'MR-2026-0001', eventDate: null },
      idempotencyKey: key,
    });
    return result.deliveryId;
  }

  it('pending ohne Job (älter als die Karenz) bekommt einen Backstop-Job mit Bucket-Schlüssel und wird versendet; frische Zeilen nicht', async () => {
    const { admin } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const stuck = await pendingDelivery(process.id, customer.id, 'backstop:stuck');
    const fresh = await pendingDelivery(process.id, customer.id, 'backstop:fresh');
    const now = new Date();
    await ctx.db
      .update(mailDeliveries)
      .set({ updatedAt: new Date(now.getTime() - OUTBOX_BACKSTOP_GRACE_MS - 60_000) })
      .where(eq(mailDeliveries.id, stuck));
    const result = await runScanDue(scanDeps([], false), now);
    expect(result.outboxBackstop).toBe(1);
    const mailJobs = await jobsOfType(MAIL_SEND_JOB_TYPE);
    expect(mailJobs).toHaveLength(1);
    expect(mailJobs[0]!.idempotencyKey).toBe(outboxBackstopJobKey(stuck, scanDueBucketStart(now)));
    expect(mailJobs[0]!.payload).toMatchObject({ deliveryId: stuck, backstop: true });
    // Gleicher Bucket erneut: kein zweiter Job; nächster Bucket später ebenfalls nicht (Job offen).
    expect((await runScanDue(scanDeps([], false), now)).outboxBackstop).toBe(0);
    expect(
      (await runScanDue(scanDeps([], false), new Date(now.getTime() + SCAN_DUE_INTERVAL_MS)))
        .outboxBackstop,
    ).toBe(0);
    expect(await jobsOfType(MAIL_SEND_JOB_TYPE)).toHaveLength(1);

    for (let i = 0; i < 20; i += 1) if ((await ctx.jobs.runOnce()) === 'idle') break;
    const rows = await ctx.db.select().from(mailDeliveries);
    expect(rows.find((row) => row.id === stuck)!.status).toBe('sent');
    expect(rows.find((row) => row.id === fresh)!.status).toBe('pending');
    expect(ctx.mailGateway.sent).toHaveLength(1);
    // Nach dem Versand: kein weiterer Backstop (Zeile sent).
    expect(
      (await runScanDue(scanDeps([], false), new Date(now.getTime() + 2 * SCAN_DUE_INTERVAL_MS)))
        .outboxBackstop,
    ).toBe(0);
  });

  it('Zeilen mit offenem mail.send-Job bekommen keinen zweiten Job; veraltete sending-Zeilen werden abgeschlossen (outcome_unknown, Härtung RA-2)', async () => {
    const { admin } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const scheduled = await pendingDelivery(process.id, customer.id, 'backstop:scheduled');
    await ctx.communication.outbox.scheduleSend(scheduled);
    const stale = await pendingDelivery(process.id, customer.id, 'backstop:stale');
    const now = new Date();
    await ctx.db
      .update(mailDeliveries)
      .set({ updatedAt: new Date(now.getTime() - OUTBOX_BACKSTOP_GRACE_MS - 60_000) })
      .where(eq(mailDeliveries.id, scheduled));
    await ctx.db
      .update(mailDeliveries)
      .set({
        status: 'sending',
        sendingSince: new Date(now.getTime() - 20 * 60_000),
        updatedAt: new Date(now.getTime() - 20 * 60_000),
      })
      .where(eq(mailDeliveries.id, stale));
    const result = await runScanDue(scanDeps([], false), now);
    expect(result.outboxBackstop).toBe(1);
    const keys = (await jobsOfType(MAIL_SEND_JOB_TYPE)).map((job) => job.idempotencyKey).sort();
    expect(keys).toEqual(
      [mailSendJobKey(scheduled), outboxBackstopJobKey(stale, scanDueBucketStart(now))].sort(),
    );
    for (let i = 0; i < 20; i += 1) if ((await ctx.jobs.runOnce()) === 'idle') break;
    const rows = await ctx.db.select().from(mailDeliveries);
    const statusOf = (id: string) => rows.find((row) => row.id === id)!.status;
    expect(statusOf(scheduled)).toBe('sent');
    // Phase 12 Härtung (RA-2): hängender Versuch wird nicht erneut gesendet.
    expect(statusOf(stale)).toBe('outcome_unknown');
    expect(rows.find((row) => row.id === stale)!.lastErrorCode).toBe('SENDING_STALE');
    expect(ctx.mailGateway.sent).toHaveLength(1);
  });
});

describe('Retention-Backstop', () => {
  it('reiht den Text-Retention-Job genau einmal je Berliner Tag ein', async () => {
    const now = new Date('2026-10-22T05:30:00.000Z');
    const first = await runScanDue(scanDeps([], false), now);
    expect(first.retention.textJobEnqueued).toBe(true);
    const second = await runScanDue(scanDeps([], false), new Date(now.getTime() + 3 * 3_600_000));
    expect(second.retention.textJobEnqueued).toBe(false);
    const nextDay = await runScanDue(scanDeps([], false), new Date('2026-10-22T22:30:00.000Z')); // 23.10. 00:30 Berlin
    expect(nextDay.retention.textJobEnqueued).toBe(true);
    const jobs = await jobsOfType(COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE);
    expect(jobs.map((job) => job.idempotencyKey).sort()).toEqual([
      retentionBackstopJobKey('2026-10-22'),
      retentionBackstopJobKey('2026-10-23'),
    ]);
    expect(berlinDay(new Date('2026-10-22T22:30:00.000Z'))).toBe('2026-10-23');
    expect(jobs[0]!.payload).toMatchObject({ scope: 'backstop', textRetention: true });
    // Die Jobs laufen fehlerfrei durch den registrierten Handler.
    for (let i = 0; i < 20; i += 1) if ((await ctx.jobs.runOnce()) === 'idle') break;
    const done = await jobsOfType(COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE);
    expect(done.every((job) => job.status === 'succeeded')).toBe(true);
  });
});
