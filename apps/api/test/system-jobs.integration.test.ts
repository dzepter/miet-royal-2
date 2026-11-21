/**
 * Phase 19 (Pilot-Readiness): Operator-Sicht auf Hintergrundjobs – GET /staff/system/jobs.
 * Rein lesend; nur mit system.settings; dead/retrying mit sicheren Referenzen (nur UUIDs
 * von `…Id`-Feldern, nie Adressen/Inhalte) und Betriebsanweisung je Jobfamilie.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import {
  extractJobReferences,
  jobGuidance,
  type JobMonitorSnapshot,
} from '../src/system/job-monitor.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateAuthTables(ctx.pool);
  await ctx.pool.query('TRUNCATE TABLE integration_jobs');
});

async function snapshot(cookie: string): Promise<{ status: number; body: JobMonitorSnapshot }> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/staff/system/jobs',
    headers: { cookie },
  });
  return { status: response.statusCode, body: response.json() as JobMonitorSnapshot };
}

describe('Phase 19 – Operator-Sicht Hintergrundjobs', () => {
  it('P19-J1. ohne Anmeldung 401, ohne system.settings 403, mit Recht 200 (leerer Stand)', async () => {
    const admin = await bootstrapAdmin(ctx);
    const anonymous = await ctx.app.inject({ method: 'GET', url: '/staff/system/jobs' });
    expect(anonymous.statusCode).toBe(401);
    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Olga',
      lastName: 'Ohne-Recht',
      email: 'olga@test.example',
      password: 'olga-passwort-12345',
      permissionKeys: ['process.view_all'],
    });
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: '/staff/system/jobs',
      headers: { cookie: staff.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    const adminLogin = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const { status, body } = await snapshot(adminLogin.cookie);
    expect(status).toBe(200);
    expect(body.counts).toEqual({
      pending: 0,
      processing: 0,
      retrying: 0,
      dead: 0,
      succeededLast24h: 0,
    });
    expect(body.dead).toEqual([]);
    expect(body.retrying).toEqual([]);
  });

  it('P19-J2. dead- und retrying-Jobs erscheinen mit Typ, Versuchen, Fehler, sicherer Referenz und Anweisung', async () => {
    await bootstrapAdmin(ctx);
    const adminLogin = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const processId = randomUUID();
    const deliveryId = randomUUID();
    const dead = await ctx.queue.enqueue(
      'mail.send',
      {
        deliveryId,
        processId,
        to: 'kunde@example.invalid',
        subject: 'Vertraulicher Betreff',
        body: 'Text mit Kundendaten',
      },
      { idempotencyKey: `test:dead:${deliveryId}`, maxAttempts: 1 },
    );
    const claimedDead = await ctx.queue.claimNext('worker-test');
    expect(claimedDead?.id).toBe(dead.jobId);
    await ctx.queue.markFailed(claimedDead!, 'Error [SMTP_450]: Mailbox busy');
    const retrying = await ctx.queue.enqueue(
      'settlement.accounting_transfer',
      { settlementId: randomUUID(), note: 'frei' },
      { idempotencyKey: `test:retry:${randomUUID()}`, maxAttempts: 5 },
    );
    const claimedRetry = await ctx.queue.claimNext('worker-test');
    expect(claimedRetry?.id).toBe(retrying.jobId);
    await ctx.queue.markFailed(claimedRetry!, 'LexwareError [LEXWARE_503]: Service unavailable');
    const pending = await ctx.queue.enqueue(
      'voucher.eligibility_check',
      { settlementId: randomUUID() },
      { idempotencyKey: `test:pending:${randomUUID()}` },
    );
    expect(pending.deduplicated).toBe(false);

    const { status, body } = await snapshot(adminLogin.cookie);
    expect(status).toBe(200);
    expect(body.counts).toMatchObject({ dead: 1, retrying: 1, pending: 1, processing: 0 });
    expect(body.dead).toHaveLength(1);
    const deadEntry = body.dead[0]!;
    expect(deadEntry).toMatchObject({
      id: dead.jobId,
      type: 'mail.send',
      state: 'dead',
      attempts: 1,
      maxAttempts: 1,
      nextRunAt: null,
      lastError: 'Error [SMTP_450]: Mailbox busy',
      references: { deliveryId, processId },
      guidance: jobGuidance('mail.send'),
    });
    // Keine Kundendaten: Adresse, Betreff und Text des Payloads kommen nie heraus.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('kunde@example.invalid');
    expect(serialized).not.toContain('Vertraulicher Betreff');
    expect(serialized).not.toContain('Kundendaten');
    expect(body.retrying).toHaveLength(1);
    expect(body.retrying[0]).toMatchObject({
      id: retrying.jobId,
      type: 'settlement.accounting_transfer',
      state: 'retrying',
      attempts: 1,
      maxAttempts: 5,
    });
    expect(new Date(body.retrying[0]!.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(body.retrying[0]!.guidance).toMatch(/manuell wiederholen/);
  });

  it('P19-J3. Referenzextraktion lässt nur UUID-Werte von Id-Feldern durch; Anweisung je Familie', () => {
    const id = randomUUID();
    expect(
      extractJobReferences({
        processId: id,
        bookingId: 'nicht-uuid',
        to: 'kunde@example.invalid',
        id,
        nested: { settlementId: id },
        token: id,
      }),
    ).toEqual({ processId: id, id });
    expect(extractJobReferences(null)).toEqual({});
    expect(extractJobReferences([id])).toEqual({});
    expect(jobGuidance('push.send')).toMatch(/informativ/);
    expect(jobGuidance('voucher.delivery')).toMatch(/voucher:ensure/);
    expect(jobGuidance('unbekannt.job')).toMatch(/Worker-Log/);
  });
  it('P19-J4. Worker-Lebenszeichen: fällige Jobs, die länger als 5 min warten ⇒ stalled; nach Verarbeitung lastSucceededAt gesetzt', async () => {
    const admin = await bootstrapAdmin(ctx);
    const { cookie } = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const empty = await snapshot(cookie);
    expect(empty.status).toBe(200);
    expect(empty.body.worker).toEqual({
      lastSucceededAt: null,
      oldestDueAt: null,
      overdueSeconds: 0,
      stalled: false,
    });
    // Fälliger Job, der seit 10 min wartet (kein Worker läuft im Test) ⇒ Signal „verarbeitet nicht“.
    const dueSince = new Date(Date.now() - 10 * 60 * 1000);
    await ctx.queue.enqueue(
      'communication.scan_due',
      { processId: randomUUID() },
      { idempotencyKey: `p19-j4-stalled-${randomUUID()}`, runAt: dueSince },
    );
    // Zukünftiger Job zählt nicht als fällig.
    await ctx.queue.enqueue(
      'mail.send',
      { deliveryId: randomUUID() },
      {
        idempotencyKey: `p19-j4-future-${randomUUID()}`,
        runAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    );
    const stalled = await snapshot(cookie);
    expect(stalled.body.worker.stalled).toBe(true);
    expect(stalled.body.worker.overdueSeconds).toBeGreaterThanOrEqual(590);
    expect(stalled.body.worker.overdueSeconds).toBeLessThan(700);
    expect(stalled.body.worker.oldestDueAt).toBe(dueSince.toISOString());
    expect(stalled.body.worker.lastSucceededAt).toBeNull();
    expect(stalled.body.counts.pending).toBe(2);
    // Worker verarbeitet den fälligen Job ⇒ kein Rückstand mehr, letzter Erfolg gesetzt.
    const claimed = await ctx.queue.claimNext('worker-test');
    expect(claimed).not.toBeNull();
    await ctx.queue.markSucceeded(claimed!);
    const healthy = await snapshot(cookie);
    expect(healthy.body.worker.stalled).toBe(false);
    expect(healthy.body.worker.oldestDueAt).toBeNull();
    expect(healthy.body.worker.overdueSeconds).toBe(0);
    expect(healthy.body.worker.lastSucceededAt).not.toBeNull();
    expect(Date.now() - new Date(healthy.body.worker.lastSucceededAt!).getTime()).toBeLessThan(
      60_000,
    );
    expect(admin.id).toBeTruthy();
  });
});
