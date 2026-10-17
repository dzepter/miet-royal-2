/**
 * Phase-9-Pflichttests 136, 137, 143, 144, 145, 146 (Order §97) für den
 * Storno-Pfad: IDOR über unsichtbare Vorgänge/Stornierungen/Relationen,
 * Prozentsatz/Basis/Status nicht vom Client setzbar, production ohne
 * Buchhaltung/Versand (kein Job, Blocker, 409, blocked), Rechteprüfung,
 * keine sensiblen Daten im Serverlog.
 */
import { PassThrough } from 'node:stream';
import { loadConfig } from '@mietroyal/config';
import { cancellations, integrationJobs, processes } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { setCompletedVisibilityDays } from '../src/crm/settings-service.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  adminSession,
  bookedProcess,
  cancelBooking,
  resetForCancellationTests,
  staffWith,
} from './cancellation-helpers.ts';

let ctx: TestContext;
let logBuffer = '';

beforeAll(async () => {
  const sink = new PassThrough();
  sink.on('data', (chunk: Buffer) => {
    logBuffer += chunk.toString('utf8');
  });
  ctx = await createTestContext({ logDestination: sink, logLevel: 'info' });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetForCancellationTests(ctx);
  logBuffer = '';
});

/** Stornierten Vorgang für normale Mitarbeitende unsichtbar machen (Sichtbarkeitsfenster 0 Tage, Storno rückdatiert). */
async function hideCancelledProcess(adminId: string, processId: string) {
  await setCompletedVisibilityDays(ctx.db, adminId, 0);
  await ctx.db
    .update(processes)
    .set({ cancelledAt: new Date(Date.now() - 3 * 86_400_000) })
    .where(eq(processes.id, processId));
}

describe('136./137. IDOR', () => {
  it('136. Unsichtbare Stornierung ⇒ 404 für Ansicht, Transfer, Bestätigung; unbekannte IDs ⇒ 404', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const view = await cancelBooking(ctx, admin.id, world.processId);
    await hideCancelledProcess(admin.id, world.processId);
    const limited = await staffWith(
      ctx,
      admin.id,
      ['process.view_all', 'lexware.manual_transfer', 'email.approve_prepared', 'booking.cancel'],
      'Ida',
    );
    const requests = [
      { method: 'GET' as const, url: `/staff/processes/${world.processId}/cancellation` },
      { method: 'GET' as const, url: `/staff/processes/${world.processId}/cancellation/preview` },
      {
        method: 'POST' as const,
        url: `/staff/processes/${world.processId}/cancellation`,
        payload: { confirm: true },
      },
      { method: 'POST' as const, url: `/staff/cancellations/${view.id}/transfer`, payload: {} },
      {
        method: 'POST' as const,
        url: `/staff/cancellations/${view.id}/confirmation/send`,
        payload: {},
      },
    ];
    for (const request of requests) {
      const response = await ctx.app.inject({
        method: request.method,
        url: request.url,
        headers: { cookie: limited.cookie },
        ...('payload' in request ? { payload: request.payload } : {}),
      });
      expect(response.statusCode, request.url).toBe(404);
      expect(response.body).not.toContain('MOCK-STORNO');
      expect(response.body).not.toContain('klara');
    }
    // Admin (process.view_completed) sieht sie weiterhin; nichts wurde übertragen/versendet.
    const adminView = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie },
    });
    expect(adminView.statusCode).toBe(200);
    expect(ctx.accounting.calls).toHaveLength(0);
    expect((await ctx.db.select().from(cancellations))[0]!.confirmationStatus).toBe('prepared');
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/staff/cancellations/00000000-0000-4000-8000-000000000000/transfer',
      headers: { cookie },
      payload: {},
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('137. Prozessrelation: Folgevorgang aus unsichtbarem Storno ⇒ 404; Relation verrät im Detail keine unsichtbaren Vorgangsdaten', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    await cancelBooking(ctx, admin.id, world.processId);
    const created = (
      await ctx.app.inject({
        method: 'POST',
        url: `/staff/processes/${world.processId}/follow-up`,
        headers: { cookie },
        payload: {},
      })
    ).json() as { processId: string };
    await hideCancelledProcess(admin.id, world.processId);
    const limited = await staffWith(ctx, admin.id, ['process.view_all', 'process.create'], 'Jo');
    const hidden = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/follow-up`,
      headers: { cookie: limited.cookie },
      payload: {},
    });
    expect(hidden.statusCode).toBe(404);
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}`,
      headers: { cookie: limited.cookie },
    });
    expect(detail.statusCode).toBe(404);
    // Der sichtbare Folgevorgang nennt nur ID + Nummer des Vorgängers (kein Kundeninhalt).
    const followUp = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${created.processId}`,
      headers: { cookie: limited.cookie },
    });
    expect(followUp.statusCode).toBe(200);
    expect(followUp.json().relations.previousProcess).toEqual({
      id: world.processId,
      processNumber: world.processNumber,
    });
  });
});

describe('143./144. Client kann Prozentsatz/Basis/Status nicht senden', () => {
  it('143./144. feePercent, baseCents, feeCents, financeStatus, cancelledAt im Body ⇒ 400, nichts storniert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 3 });
    for (const payload of [
      { confirm: true, feePercent: 0 },
      { confirm: true, baseCents: 1 },
      { confirm: true, feeCents: 0 },
      { confirm: true, financeStatus: 'paid' },
      { confirm: true, cancelledAt: '2020-01-01T00:00:00.000Z' },
      { confirm: true, remainingDays: 99 },
      { confirm: false },
      {},
    ]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/staff/processes/${world.processId}/cancellation`,
        headers: { cookie },
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await ctx.db.select().from(cancellations)).toHaveLength(0);
    expect(await processStatusOf(world.processId)).toBe('open');
    // Nur die Bestätigung – Werte kommen ausschließlich vom Server.
    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie },
      payload: { confirm: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ feePercent: 100, baseCents: 7500, feeCents: 7500 });
    // Transfer-/Bestätigungs-Routen nehmen keine Fremdfelder an.
    const forged = await ctx.app.inject({
      method: 'POST',
      url: `/staff/cancellations/${ok.json().id}/transfer`,
      headers: { cookie },
      payload: { accountingReference: 'RE-1' },
    });
    expect(forged.statusCode).toBe(400);
  });
});

async function processStatusOf(processId: string) {
  return (await ctx.db.select().from(processes).where(eq(processes.id, processId)))[0]!.mainStatus;
}

describe('145. Production: keine Mock-Buchhaltung, kein Versand', () => {
  it('145. Production: Storno mit Gebühr ⇒ kein Job, Blocker not_configured, manuelle Übertragung 409, Bestätigung blocked, Mock-Steuerung 404', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 3 });
    const productionConfig = loadConfig({
      APP_ENV: 'production',
      DATABASE_URL: ctx.config.databaseUrl,
      AUTH_SECRET_KEY: '1'.repeat(64),
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: ctx.config.storage.driver === 'fs' ? ctx.config.storage.fsRoot : '/tmp/x',
      LOG_LEVEL: 'error',
    });
    const app = buildApp({
      config: { ...productionConfig, auth: ctx.config.auth },
      pool: ctx.pool,
      mailAdapter: ctx.mail,
      rateLimitEnabled: false,
      storage: ctx.storage,
      jobQueue: ctx.queue,
    });
    await app.ready();
    try {
      const preview = await app.inject({
        method: 'GET',
        url: `/staff/processes/${world.processId}/cancellation/preview`,
        headers: { cookie },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().accountingConfigured).toBe(false);
      const cancelled = await app.inject({
        method: 'POST',
        url: `/staff/processes/${world.processId}/cancellation`,
        headers: { cookie },
        payload: { confirm: true },
      });
      expect(cancelled.statusCode).toBe(200);
      const view = cancelled.json() as Record<string, unknown>;
      expect(view).toMatchObject({
        financeStatus: 'accounting_pending',
        accountingBlocker: 'not_configured',
        accountingProvider: 'disabled',
        permissions: { canManualTransfer: false },
      });
      expect(await ctx.db.select().from(integrationJobs)).toHaveLength(0);
      const transfer = await app.inject({
        method: 'POST',
        url: `/staff/cancellations/${view.id as string}/transfer`,
        headers: { cookie },
        payload: {},
      });
      expect(transfer.statusCode).toBe(409);
      expect(transfer.json().error.message).toContain('nicht konfiguriert');
      expect(ctx.accounting.calls).toHaveLength(0);
      const stored = (await ctx.db.select().from(cancellations))[0]!;
      expect(stored.financeStatus).toBe('accounting_pending');
      expect(stored.accountingReference).toBeNull();
      const confirmation = await app.inject({
        method: 'POST',
        url: `/staff/cancellations/${view.id as string}/confirmation/send`,
        headers: { cookie },
        payload: {},
      });
      expect(confirmation.statusCode).toBe(200);
      expect(confirmation.json().confirmationStatus).toBe('blocked');
      expect((await ctx.db.select().from(cancellations))[0]!.confirmationSentAt).toBeNull();
      const mock = await app.inject({
        method: 'POST',
        url: '/staff/accounting/mock/run-due-jobs',
        headers: { cookie },
        payload: {},
      });
      expect(mock.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('Rechte und Logging', () => {
  it('Vorschau mit settlement.view oder booking.cancel; Storno nur mit booking.cancel; GET mit process.view_all', async () => {
    const { admin } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const viewer = await staffWith(ctx, admin.id, ['process.view_all'], 'Olaf');
    const settlement = await staffWith(
      ctx,
      admin.id,
      ['process.view_all', 'settlement.view'],
      'Sven',
    );
    const previewUrl = `/staff/processes/${world.processId}/cancellation/preview`;
    expect(
      (await ctx.app.inject({ method: 'GET', url: previewUrl, headers: { cookie: viewer.cookie } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: previewUrl,
          headers: { cookie: settlement.cookie },
        })
      ).statusCode,
    ).toBe(200);
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie: settlement.cookie },
      payload: { confirm: true },
    });
    expect(denied.statusCode).toBe(403);
    expect(await ctx.db.select().from(cancellations)).toHaveLength(0);
    const none = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie: viewer.cookie },
    });
    expect(none.statusCode).toBe(404);
    const unauthenticated = await ctx.app.inject({ method: 'GET', url: previewUrl });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('146. Serverlog enthält keine Kundendaten, Beträge mit Kundenbezug oder Buchhaltungsreferenzen', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    logBuffer = '';
    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/cancellation`,
      headers: { cookie },
      payload: { confirm: true },
    });
    expect(cancelled.statusCode).toBe(200);
    await ctx.jobs.drain();
    await ctx.app.inject({
      method: 'POST',
      url: `/staff/cancellations/${cancelled.json().id}/transfer`,
      headers: { cookie },
      payload: {},
    });
    const stored = (await ctx.db.select().from(cancellations))[0]!;
    expect(stored.accountingReference).toMatch(/^MOCK-STORNO-/);
    expect(logBuffer).not.toContain('klara');
    expect(logBuffer).not.toContain('Kommerz');
    expect(logBuffer).not.toContain('Lieferweg');
    expect(logBuffer).not.toContain(stored.accountingReference!);
    expect(logBuffer).not.toContain('"baseCents"');
    expect(logBuffer).not.toContain('"feeCents"');
  });
});
