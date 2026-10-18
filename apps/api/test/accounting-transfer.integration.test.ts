/**
 * Phase 9 – gemeinsame Buchhaltungs-Transfer-Boundary und Mock-Steuerung
 * (Vorgabe §36–§43, §77–§78, §81; Pflichttests 135 Transfer-IDOR-Basis,
 * 138 „transferred“ nicht vom Client setzbar, 139 Referenz nicht fälschbar,
 * 145 Mock-Steuerung in production blockiert, 149 Snapshot unveränderbar).
 * Nutzt eine Storno-Transferzeile (kein Settlement nötig), damit die
 * Boundary unabhängig von Abrechnungs-/Storno-Services geprüft wird.
 */
import { loadConfig } from '@mietroyal/config';
import {
  accountingTransfers,
  cancellations,
  processes,
  type DatabaseTransaction,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cancellationTransferIdempotencyKey,
  DisabledAccountingGateway,
  MockAccountingGateway,
  type AccountingGateway,
  type AccountingPayload,
} from '../src/accounting/gateway.ts';
import { AccountingTransferService } from '../src/accounting/transfer-service.ts';
import { buildApp } from '../src/app.ts';
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
import { truncateCommerceTables } from './commerce-helpers.ts';
import { createAcceptedBooking } from './scheduling-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE accounting_transfers, cancellations, process_relations CASCADE');
  await ctx.pool.query('TRUNCATE integration_jobs');
  // Reihenfolge: Auth-Reset leert product_prices (FK) – Commerce-Reset seedet neu.
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  ctx.accounting.calls.length = 0;
  ctx.accounting.failNext(0);
});

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

/** Synthetische Stornierung mit Gebühr als Transferziel (nur Boundary-Test). */
async function cancellationTarget(adminId: string) {
  const world = await createAcceptedBooking(ctx, adminId);
  const processRows = await ctx.db
    .select()
    .from(processes)
    .where(eq(processes.id, world.processId));
  const process = processRows[0]!;
  const bookingId = world.bookingId;
  const customer = { id: world.customerId };
  const [row] = await ctx.db
    .insert(cancellations)
    .values({
      processId: process.id,
      bookingId,
      cancelerType: 'employee',
      cancelerStaffId: adminId,
      cancelledAt: new Date(),
      eventDate: '2026-08-01',
      remainingDays: 10,
      feePercent: 50,
      baseCents: 9_999,
      feeCents: 5_000,
      financeStatus: 'accounting_pending',
    })
    .returning();
  const cancellation = row!;
  const payload: AccountingPayload = {
    schemaVersion: 1,
    kind: 'cancellation',
    sourceId: cancellation.id,
    processId: process.id,
    processNumber: process.processNumber,
    bookingId,
    eventDate: '2026-08-01',
    customer: {
      customerId: customer.id,
      displayName: 'Max Mustermann',
      companyName: null,
      email: null,
      billingAddress: { street: null, postalCode: null, city: null },
    },
    lines: [
      {
        id: `cancellation-${cancellation.id}`,
        type: 'cancellation_fee',
        description: `Stornokosten gemäß Mietbedingungen – Vorgang ${process.processNumber}`,
        quantity: 1,
        unit: 'Pauschale',
        unitPriceCents: 5_000,
        amountCents: 5_000,
        direction: 'charge',
      },
    ],
    totals: { chargesCents: 5_000, creditsCents: 0, amountDueCents: 5_000, overpaymentCents: 0 },
    cancellation: {
      originalEventDate: '2026-08-01',
      regularMachinePriceCents: 9_999,
      feePercent: 50,
      feeCents: 5_000,
      remainingDays: 10,
    },
    tax: null,
    idempotencyKey: cancellationTransferIdempotencyKey(cancellation.id),
    createdAt: new Date().toISOString(),
  };
  return { process, cancellation, payload };
}

function serviceWith(gateway: AccountingGateway = ctx.accounting): AccountingTransferService {
  return new AccountingTransferService(ctx.db, gateway, ctx.queue);
}

const noopHooks = {
  recheck: async () => true,
  onSuccess: async () => undefined,
};

describe('AccountingTransferService – Vorbereitung und Idempotenz (§37/§39/§81)', () => {
  it('prepare() legt genau eine Transferzeile mit eingefrorenem Snapshot an – auch bei parallelem Aufruf', async () => {
    const { admin } = await adminSession();
    const { cancellation, payload } = await cancellationTarget(admin.id);
    const service = serviceWith();
    const target = {
      kind: 'cancellation' as const,
      cancellationId: cancellation.id,
      processId: cancellation.processId,
    };
    const rows = await Promise.all(
      Array.from({ length: 4 }, () =>
        ctx.db.transaction((tx: DatabaseTransaction) => service.prepare(tx, target, payload)),
      ),
    );
    const ids = new Set(rows.map((row) => row.id));
    expect(ids.size).toBe(1);
    const all = await ctx.db.select().from(accountingTransfers);
    expect(all).toHaveLength(1);
    expect(all[0]!.snapshotHash).toBe(AccountingTransferService.hashSnapshot(payload));
    expect(all[0]!.status).toBe('pending');
    expect(all[0]!.provider).toBe('mock');
    // Zweiter Payload mit anderem Betrag ändert den eingefrorenen Snapshot NICHT (§81/149).
    const changed = { ...payload, totals: { ...payload.totals, amountDueCents: 1 } };
    const again = await ctx.db.transaction((tx) => service.prepare(tx, target, changed));
    expect(again.id).toBe(all[0]!.id);
    expect((again.snapshot as AccountingPayload).totals.amountDueCents).toBe(5_000);
  });

  it('prepare() lehnt einen Payload mit fremdem Idempotenzschlüssel ab (139: Referenz/Key nicht fälschbar)', async () => {
    const { admin } = await adminSession();
    const { cancellation, payload } = await cancellationTarget(admin.id);
    const service = serviceWith();
    await expect(
      ctx.db.transaction((tx) =>
        service.prepare(
          tx,
          {
            kind: 'cancellation',
            cancellationId: cancellation.id,
            processId: cancellation.processId,
          },
          { ...payload, idempotencyKey: 'cancellation-transfer:gefaelscht' },
        ),
      ),
    ).rejects.toThrow(/Idempotenzschlüssel/);
  });

  it('execute(): Doppelklick/paralleler Worker ⇒ genau EIN Gateway-Aufruf, identische Referenz (§39)', async () => {
    const { admin } = await adminSession();
    const { cancellation, payload } = await cancellationTarget(admin.id);
    const service = serviceWith();
    const row = await ctx.db.transaction((tx) =>
      service.prepare(
        tx,
        {
          kind: 'cancellation',
          cancellationId: cancellation.id,
          processId: cancellation.processId,
        },
        payload,
      ),
    );
    let successHooks = 0;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.execute(row.id, {
          recheck: async () => true,
          onSuccess: async () => {
            successHooks += 1;
          },
        }),
      ),
    );
    expect(results.filter((r) => r.outcome === 'succeeded')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already_succeeded')).toHaveLength(4);
    expect(successHooks).toBe(1);
    expect(ctx.accounting.calls).toHaveLength(1);
    const stored = await service.byId(row.id);
    expect(stored?.status).toBe('succeeded');
    expect(stored?.externalReference).toMatch(/^MOCK-STORNO-MR-/);
    expect(stored?.paymentStatus).toBe('open');
    expect(stored?.transferredAt).not.toBeNull();
    expect(stored?.attempts).toBe(1);
    // Snapshot nach Erfolg unverändert (149).
    expect(stored?.snapshotHash).toBe(AccountingTransferService.hashSnapshot(payload));
  });

  it('execute(): recheck=false ⇒ kein Gateway-Aufruf (TOCTOU-Schutz §80)', async () => {
    const { admin } = await adminSession();
    const { cancellation, payload } = await cancellationTarget(admin.id);
    const service = serviceWith();
    const row = await ctx.db.transaction((tx) =>
      service.prepare(
        tx,
        {
          kind: 'cancellation',
          cancellationId: cancellation.id,
          processId: cancellation.processId,
        },
        payload,
      ),
    );
    const result = await service.execute(row.id, { ...noopHooks, recheck: async () => false });
    expect(result.outcome).toBe('skipped');
    expect(ctx.accounting.calls).toHaveLength(0);
    expect((await service.byId(row.id))?.status).toBe('pending');
  });

  it('execute(): transienter Fehler ⇒ failed + Versuchszähler + neutraler Code; Retry gelingt mit derselben Referenzlogik (§40)', async () => {
    const { admin } = await adminSession();
    const { cancellation, payload } = await cancellationTarget(admin.id);
    const service = serviceWith();
    const row = await ctx.db.transaction((tx) =>
      service.prepare(
        tx,
        {
          kind: 'cancellation',
          cancellationId: cancellation.id,
          processId: cancellation.processId,
        },
        payload,
      ),
    );
    ctx.accounting.failNext(2);
    let failures = 0;
    const first = await service.execute(row.id, {
      ...noopHooks,
      onFailure: async () => {
        failures += 1;
      },
    });
    expect(first.outcome).toBe('failed');
    expect(first.errorCode).toBe('TRANSIENT');
    const second = await service.execute(row.id, { ...noopHooks });
    expect(second.outcome).toBe('failed');
    const third = await service.execute(row.id, { ...noopHooks });
    expect(third.outcome).toBe('succeeded');
    expect(failures).toBe(1);
    const stored = await service.byId(row.id);
    expect(stored?.attempts).toBe(3);
    expect(stored?.lastErrorCode).toBeNull();
    expect(ctx.accounting.calls).toHaveLength(1);
    expect(stored?.externalReference).toBe(ctx.accounting.calls[0]!.externalReference);
  });

  it('DisabledAccountingGateway (production): Übertragung schlägt mit NOT_CONFIGURED fehl, nichts wird als übertragen markiert (§23/§36)', async () => {
    const { admin } = await adminSession();
    const { cancellation, payload } = await cancellationTarget(admin.id);
    const disabled = new DisabledAccountingGateway();
    expect(disabled.isConfigured()).toBe(false);
    expect(() => disabled.assertConfigured()).toThrow(/Buchhaltungsintegration nicht konfiguriert/);
    const service = serviceWith(disabled);
    const row = await ctx.db.transaction((tx) =>
      service.prepare(
        tx,
        {
          kind: 'cancellation',
          cancellationId: cancellation.id,
          processId: cancellation.processId,
        },
        payload,
      ),
    );
    expect(row.provider).toBe('disabled');
    const result = await service.execute(row.id, noopHooks);
    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('NOT_CONFIGURED');
    const stored = await service.byId(row.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.externalReference).toBeNull();
    expect(stored?.transferredAt).toBeNull();
  });

  it('enqueue(): automatischer Anlass dedupliziert über den Transfer-Idempotenzschlüssel', async () => {
    const { admin } = await adminSession();
    const { cancellation, payload } = await cancellationTarget(admin.id);
    const service = serviceWith();
    const row = await ctx.db.transaction((tx) =>
      service.prepare(
        tx,
        {
          kind: 'cancellation',
          cancellationId: cancellation.id,
          processId: cancellation.processId,
        },
        payload,
      ),
    );
    const first = await service.enqueue(row);
    const second = await service.enqueue(row);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.jobId).toBe(first.jobId);
  });

  it('setPaymentStatus(): nur für erfolgreiche Übertragungen; spiegelt paid in die Stornierung (§42/§60)', async () => {
    const { admin } = await adminSession();
    const { cancellation, payload } = await cancellationTarget(admin.id);
    const service = serviceWith();
    const row = await ctx.db.transaction((tx) =>
      service.prepare(
        tx,
        {
          kind: 'cancellation',
          cancellationId: cancellation.id,
          processId: cancellation.processId,
        },
        payload,
      ),
    );
    await expect(service.setPaymentStatus(row.id, 'paid')).rejects.toThrow(/nur für erfolgreich/);
    await service.execute(row.id, noopHooks);
    const updated = await service.setPaymentStatus(row.id, 'paid');
    expect(updated.paymentStatus).toBe('paid');
    const stored = await ctx.db
      .select()
      .from(cancellations)
      .where(eq(cancellations.id, cancellation.id));
    expect(stored[0]?.paymentStatus).toBe('paid');
    expect(stored[0]?.financeStatus).toBe('paid');
    const reopened = await service.setPaymentStatus(row.id, 'open');
    expect(reopened.paymentStatus).toBe('open');
    const stored2 = await ctx.db
      .select()
      .from(cancellations)
      .where(eq(cancellations.id, cancellation.id));
    expect(stored2[0]?.financeStatus).toBe('invoice_open');
  });
});

describe('Mock-Steuerung (§42/§43/§77, Tests 145/147)', () => {
  it('GET /staff/accounting/status zeigt Mock klar gekennzeichnet (settlement.view)', async () => {
    const { admin, cookie } = await adminSession();
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/staff/accounting/status',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: 'mock',
      configured: true,
      mock: true,
      mockControlsAvailable: true,
      environment: 'development',
    });
    const limited = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Ohne',
      lastName: 'Recht',
      email: 'ohne@test.example',
      password: 'ohne-recht-passwort-1',
      permissionKeys: ['process.view_all'],
    });
    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/staff/accounting/status',
      headers: { cookie: limited.cookie },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('Mock-Routen verlangen system.settings – normale Fachrechte reichen nicht (§77)', async () => {
    const { admin } = await adminSession();
    const finance = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Fach',
      lastName: 'Recht',
      email: 'fach@test.example',
      password: 'fach-recht-passwort-1',
      permissionKeys: ['settlement.view', 'settlement.release', 'lexware.manual_transfer'],
    });
    for (const url of [
      '/staff/accounting/mock/payment-status',
      '/staff/accounting/mock/fail-next',
      '/staff/accounting/mock/expire-wait',
      '/staff/accounting/mock/run-due-jobs',
    ]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url,
        headers: { cookie: finance.cookie },
        payload: {},
      });
      expect(response.statusCode, url).toBe(403);
    }
  });

  it('Mock-Zahlungsstatus und „fällige Jobs ausführen“ funktionieren für Admin; Status wird als MOCK gekennzeichnet', async () => {
    const { admin, cookie } = await adminSession();
    const { cancellation, payload } = await cancellationTarget(admin.id);
    const service = serviceWith();
    const row = await ctx.db.transaction((tx) =>
      service.prepare(
        tx,
        {
          kind: 'cancellation',
          cancellationId: cancellation.id,
          processId: cancellation.processId,
        },
        payload,
      ),
    );
    await service.execute(row.id, noopHooks);
    const paid = await ctx.app.inject({
      method: 'POST',
      url: '/staff/accounting/mock/payment-status',
      headers: { cookie },
      payload: { transferId: row.id, status: 'paid' },
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ transferId: row.id, paymentStatus: 'paid', mock: true });
    // Unbekannte/fremde Transfer-ID ⇒ 404 (135).
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/staff/accounting/mock/payment-status',
      headers: { cookie },
      payload: { transferId: '00000000-0000-4000-8000-000000000000', status: 'paid' },
    });
    expect(unknown.statusCode).toBe(404);
    // Client kann keine Referenz/keinen Status „transferred“ setzen (138/139): unbekannte Felder ⇒ 400.
    const forged = await ctx.app.inject({
      method: 'POST',
      url: '/staff/accounting/mock/payment-status',
      headers: { cookie },
      payload: { transferId: row.id, status: 'paid', externalReference: 'RE-2026-1' },
    });
    expect(forged.statusCode).toBe(400);
    const failNext = await ctx.app.inject({
      method: 'POST',
      url: '/staff/accounting/mock/fail-next',
      headers: { cookie },
      payload: { count: 1 },
    });
    expect(failNext.json()).toMatchObject({ pendingFailures: 1, mock: true });
    ctx.accounting.failNext(0);
    const run = await ctx.app.inject({
      method: 'POST',
      url: '/staff/accounting/mock/run-due-jobs',
      headers: { cookie },
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ processed: 0, failed: 0, mock: true });
  });

  it('145. In production existiert keine Mock-Steuerung (404) und der Status meldet „disabled“', async () => {
    const { cookie } = await adminSession();
    const productionConfig = loadConfig({
      APP_ENV: 'production',
      DATABASE_URL: ctx.config.databaseUrl,
      AUTH_SECRET_KEY: '1'.repeat(64),
      COMMUNICATION_PAYLOAD_KEY: 'c1'.repeat(32),
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
      const status = await app.inject({
        method: 'GET',
        url: '/staff/accounting/status',
        headers: { cookie },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        provider: 'disabled',
        configured: false,
        mock: false,
        mockControlsAvailable: false,
        environment: 'production',
      });
      for (const url of [
        '/staff/accounting/mock/payment-status',
        '/staff/accounting/mock/fail-next',
        '/staff/accounting/mock/expire-wait',
        '/staff/accounting/mock/run-due-jobs',
      ]) {
        const response = await app.inject({
          method: 'POST',
          url,
          headers: { cookie },
          payload: {},
        });
        expect(response.statusCode, url).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it('Mock-Gateway ist deterministisch: gleiche idempotencyKey ⇒ gleiche Referenz; Referenz trägt MOCK-Präfix (§38)', async () => {
    const gateway = new MockAccountingGateway();
    const payload = {
      schemaVersion: 1 as const,
      kind: 'settlement' as const,
      sourceId: 's',
      processId: 'p',
      processNumber: 'MR-2026-0001',
      bookingId: 'b',
      eventDate: '2026-01-01',
      customer: {
        customerId: 'c',
        displayName: 'X',
        companyName: null,
        email: null,
        billingAddress: { street: null, postalCode: null, city: null },
      },
      lines: [],
      totals: { chargesCents: 0, creditsCents: 0, amountDueCents: 0, overpaymentCents: 0 },
      tax: null,
      idempotencyKey: 'settlement-transfer:s',
      createdAt: new Date().toISOString(),
    };
    const a = await gateway.transfer({
      idempotencyKey: 'settlement-transfer:s',
      payload,
      attempt: 1,
    });
    const b = await gateway.transfer({
      idempotencyKey: 'settlement-transfer:s',
      payload,
      attempt: 2,
    });
    expect(a.externalReference).toBe(b.externalReference);
    expect(a.externalReference).toMatch(/^MOCK-RE-MR-2026-0001-0001$/);
    expect(a.paymentStatus).toBe('open');
  });
});
