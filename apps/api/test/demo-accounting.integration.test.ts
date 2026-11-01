import { loadConfig } from '@mietroyal/config';
import {
  accountingTransfers,
  offers,
  offerVersions,
  processes,
  settlements,
  vouchers,
} from '@mietroyal/database';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertAccountingGatewayAllowed,
  createAccountingGateway,
  DisabledAccountingGateway,
  MockAccountingGateway,
} from '../src/accounting/gateway.ts';
import { buildApp } from '../src/app.ts';
import { PayloadCrypto } from '../src/communication/payload-crypto.ts';
import { DEMO_SEED_KEYS } from '../src/demo/seed/data.ts';
import { voucherSituationFixture } from '../src/demo/seed/fixtures/voucher-fixture.ts';
import { createAccountingGatewayFor } from '../src/jobs/finance.ts';
import { DEMO_ACCOUNTING_UNAVAILABLE_HINT } from '../src/settlement/settlement-service.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  DEMO_TEST_AUTH_SECRET_KEY,
  DEMO_TEST_COMMUNICATION_PAYLOAD_KEY,
  destroyTestContext,
  login,
  type TestContext,
} from './auth-helpers.ts';
import {
  createDemoTestContext,
  demoServicesFor,
  demoTestNow,
  freshDemoDatabase,
  type DemoTestServices,
} from './demo-helpers.ts';

/**
 * Phase 14 (ACCOUNTING, Order W1/W1.1/§24/§29/§30/§96, Pflichttests §101
 * Nr. 14/15): Lexware und externe Buchhaltungsübertragung sind in APP_ENV=demo
 * IMMER disabled – kein Mock-Erfolg, keine Fake-Referenz, keine simulierte
 * Übertragung. Die Demo-Abrechnung endet fachlich bei „Bereit zur Buchhaltung“
 * (kein Fehlerzustand); die Gutschein-Situation entsteht als Seed-Fixture.
 * Läuft gegen den kanonischen Demo-Seed in einer eigenen Test-DB.
 *
 * T96 (Settlement-Training ohne Lexware-Erfolg, §106) liegt beim Agenten
 * TRAINING-CORE (Trainingsmodul); hier wird nur der dafür nötige Zustand
 * „geprüft bis unmittelbar VOR der externen Übertragung“ abgesichert.
 */

const SEED_TIMEOUT_MS = 180_000;
const MOCK_CONTROL_ROUTES = [
  '/staff/accounting/mock/payment-status',
  '/staff/accounting/mock/fail-next',
  '/staff/accounting/mock/expire-wait',
] as const;

let ctx: TestContext;
let demo: DemoTestServices;
let adminId: string;
let cookie = '';
const now = demoTestNow();

beforeAll(async () => {
  ctx = await createDemoTestContext();
  demo = demoServicesFor(ctx);
  ({ adminId } = await freshDemoDatabase(ctx));
  await demo.seed.seed({ actorId: adminId, now });
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  if (session.statusCode !== 200) throw new Error(`Demo-Login: ${session.statusCode}`);
  cookie = session.cookie;
}, SEED_TIMEOUT_MS);

afterAll(async () => {
  await destroyTestContext(ctx);
});

async function resolveId(seedKey: string): Promise<string> {
  const ref = await demo.registry.resolve(seedKey);
  if (ref === null) throw new Error(`Seed-Schlüssel ${seedKey} fehlt`);
  return ref.entityId;
}

async function countRows(sql: string): Promise<number> {
  const result = await ctx.pool.query(sql);
  return result.rows[0].n as number;
}

async function settlementViewFor(processId: string) {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/staff/processes/${processId}/settlement`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    settlement: {
      id: string;
      status: string;
      version: number;
      accountingBlocker: string | null;
      accountingProvider: string | null;
      accountingReference: string | null;
      autoTransferPlannedAt: string | null;
      accounting: { provider: string; blockers: unknown[] };
    };
    transfer: unknown;
    dominantAction: { key: string; label: string; hint: string };
    mock: { isMock: boolean; controlsAvailable: boolean };
  };
}

function demoConfigLike() {
  return loadConfig({
    APP_ENV: 'demo',
    DATABASE_URL: ctx.config.databaseUrl,
    STORAGE_DRIVER: 'fs',
    STORAGE_FS_ROOT: ctx.config.storage.driver === 'fs' ? ctx.config.storage.fsRoot : '/tmp/x',
    AUTH_SECRET_KEY: DEMO_TEST_AUTH_SECRET_KEY,
    COMMUNICATION_PAYLOAD_KEY: DEMO_TEST_COMMUNICATION_PAYLOAD_KEY,
    LOG_LEVEL: 'error',
  });
}

describe('Phase 14 – Demo: Lexware/Accounting immer disabled (W1)', () => {
  it('T14. Demo Lexware immer disabled: Gateway/Status `disabled`, kein Lexware-Client, Webhook 404, Lexware-Key ist Konfigurationsfehler', async () => {
    // Fabrik und aktives Gateway des Demo-Kontexts.
    expect(ctx.config.appEnv).toBe('demo');
    expect(ctx.config.lexware.enabled).toBe(false);
    expect(ctx.lexware.client).toBeNull();
    expect(ctx.gateway.provider).toBe('disabled');
    expect(ctx.gateway.isConfigured()).toBe(false);
    expect(ctx.transfersFor().isConfigured()).toBe(false);
    expect(createAccountingGateway(ctx.config)).toBeInstanceOf(DisabledAccountingGateway);
    // Auch ein (hypothetisch) aktiver Lexware-Kontext führt in demo nie zu Lexware.
    expect(
      createAccountingGateway(ctx.config, {
        client: {},
        gateway: () => new MockAccountingGateway(),
      }).provider,
    ).toBe('disabled');
    expect(createAccountingGatewayFor(ctx.config, ctx.lexware).provider).toBe('disabled');
    // Der Mock bleibt development/staging vorbehalten.
    expect(
      createAccountingGateway(
        loadConfig({ APP_ENV: 'development', DATABASE_URL: ctx.config.databaseUrl }),
      ).provider,
    ).toBe('mock');

    const status = await ctx.app.inject({
      method: 'GET',
      url: '/staff/accounting/status',
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      provider: 'disabled',
      configured: false,
      mock: false,
      mockControlsAvailable: false,
      mockPaymentControlsAvailable: false,
      environment: 'demo',
    });

    const lexwareStatus = await ctx.app.inject({
      method: 'GET',
      url: '/staff/lexware/status',
      headers: { cookie },
    });
    expect(lexwareStatus.statusCode).toBe(200);
    expect(lexwareStatus.json()).toMatchObject({ configured: false });

    // Kein Webhook-Endpunkt ohne aktive Lexware-Konfiguration (neutrales 404).
    const webhook = await ctx.app.inject({
      method: 'POST',
      url: '/webhooks/lexware',
      headers: { 'content-type': 'application/json' },
      payload: { eventType: 'invoice.status.changed', resourceId: 'x' },
    });
    expect(webhook.statusCode).toBe(404);

    // Ein Lexware-Key in demo ist ein Konfigurationsfehler (packages/config, fail-closed).
    expect(() =>
      loadConfig({
        APP_ENV: 'demo',
        DATABASE_URL: ctx.config.databaseUrl,
        STORAGE_DRIVER: 'fs',
        STORAGE_FS_ROOT: '/tmp/x',
        AUTH_SECRET_KEY: DEMO_TEST_AUTH_SECRET_KEY,
        COMMUNICATION_PAYLOAD_KEY: DEMO_TEST_COMMUNICATION_PAYLOAD_KEY,
        LEXWARE_ENABLED: 'true',
        LEXWARE_API_KEY: 'never-real-demo-key-0000000000000000',
      }),
    ).toThrow(/LEXWARE_API_KEY/);
  });

  it('T14b. Fail-closed-Guard: buildApp mit Mock-Gateway wirft in demo und production, development bleibt erlaubt; Guard-Funktion für Worker/Seed', async () => {
    const demoConfig = demoConfigLike();
    expect(() =>
      buildApp({ config: demoConfig, accountingGateway: new MockAccountingGateway() }),
    ).toThrow(/Mock-Buchhaltungs-Gateway/);
    const productionConfig = loadConfig({
      APP_ENV: 'production',
      DATABASE_URL: ctx.config.databaseUrl,
      AUTH_SECRET_KEY: '1'.repeat(64),
      COMMUNICATION_PAYLOAD_KEY: 'c1'.repeat(32),
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: ctx.config.storage.driver === 'fs' ? ctx.config.storage.fsRoot : '/tmp/x',
      LOG_LEVEL: 'error',
    });
    expect(() =>
      buildApp({ config: productionConfig, accountingGateway: new MockAccountingGateway() }),
    ).toThrow(/Mock-Buchhaltungs-Gateway/);
    // Disabled ist überall zulässig; development darf den Mock weiter injizieren.
    const demoApp = buildApp({
      config: demoConfig,
      accountingGateway: new DisabledAccountingGateway(),
    });
    await demoApp.close();
    const devApp = buildApp({
      config: loadConfig({ APP_ENV: 'development', DATABASE_URL: ctx.config.databaseUrl }),
      accountingGateway: new MockAccountingGateway(),
    });
    await devApp.close();

    const mock = new MockAccountingGateway();
    const disabled = new DisabledAccountingGateway();
    expect(() => assertAccountingGatewayAllowed('demo', mock)).toThrow(/Mock-Buchhaltungs-Gateway/);
    expect(() => assertAccountingGatewayAllowed('production', mock)).toThrow(
      /Mock-Buchhaltungs-Gateway/,
    );
    expect(() => assertAccountingGatewayAllowed('development', mock)).not.toThrow();
    expect(() => assertAccountingGatewayAllowed('staging', mock)).not.toThrow();
    expect(() => assertAccountingGatewayAllowed('demo', disabled)).not.toThrow();
    expect(() => assertAccountingGatewayAllowed('production', disabled)).not.toThrow();
    // Der Seed verdrahtet dasselbe Gateway über die Fabrik: nie Mock in der Demo.
    expect(demo.services.settlements).toBeDefined();
    expect(await countRows(`SELECT count(*)::int AS n FROM accounting_transfers`)).toBe(0);
  });

  it('W1.1. Seed-Fixture „voucher.situation“: genau EIN aktiver Gutschein des Wiedermieters ohne Transferreferenz, Registry nur mit entity_id, normaler voucher.delivery-Job, anwendbar in einem neuen Angebot des Wiedermieters', async () => {
    const customerId = await resolveId(DEMO_SEED_KEYS.customerPrivateRepeat);
    const originProcessId = await resolveId(DEMO_SEED_KEYS.processCompleted);
    const ref = await demo.registry.resolve(DEMO_SEED_KEYS.voucherSituation);
    expect(ref).not.toBeNull();
    expect(ref!.entityType).toBe('voucher');

    const customerVouchers = await ctx.db
      .select()
      .from(vouchers)
      .where(eq(vouchers.customerId, customerId));
    expect(customerVouchers).toHaveLength(1);
    const voucher = customerVouchers[0]!;
    expect(voucher.id).toBe(ref!.entityId);
    expect(voucher.status).toBe('active');
    expect(voucher.deliveryStatus).toBe('pending');
    expect(voucher.reservedOfferId).toBeNull();
    expect(voucher.originProcessId).toBe(originProcessId);
    expect(voucher.discountPercent).toBe(20);
    expect(voucher.expiresAt.getTime()).toBeGreaterThan(now.getTime());
    expect(voucher.codeSuffix).toHaveLength(4);
    // Registry trägt nur die ID – nie Code, Hash oder Suffix.
    const registryRow = await ctx.pool.query(
      `SELECT to_jsonb(e) AS row FROM demo_seed_entities e WHERE seed_key = $1`,
      [DEMO_SEED_KEYS.voucherSituation],
    );
    const serialized = JSON.stringify(registryRow.rows[0].row);
    expect(serialized).not.toContain(voucher.codeHash);
    expect(serialized).not.toContain(voucher.codeSuffix);

    // Ursprungs-Settlement: unverändert ohne Übertragung – keine Providerreferenz, keine Rechnungsnummer.
    const origin = (
      await ctx.db.select().from(settlements).where(eq(settlements.id, voucher.originSettlementId))
    )[0]!;
    expect(origin.processId).toBe(originProcessId);
    expect(origin.status).toBe('ready_for_accounting');
    expect(origin.accountingTransferId).toBeNull();
    expect(origin.accountingProvider).toBeNull();
    expect(origin.accountingReference).toBeNull();
    expect(origin.paymentStatus).toBeNull();
    expect(
      await ctx.db
        .select({ id: accountingTransfers.id })
        .from(accountingTransfers)
        .where(eq(accountingTransfers.settlementId, origin.id)),
    ).toHaveLength(0);
    expect(await countRows(`SELECT count(*)::int AS n FROM lexware_invoice_mappings`)).toBe(0);
    expect(await countRows(`SELECT count(*)::int AS n FROM lexware_webhook_events`)).toBe(0);
    // Normaler Versandweg: genau ein voucher.delivery-Job (kein Eligibility-/Transferjob).
    const deliveryJobs = await ctx.pool.query(
      `SELECT type FROM integration_jobs WHERE type LIKE 'voucher.%' OR type LIKE '%accounting_transfer'`,
    );
    expect(deliveryJobs.rows.map((row: { type: string }) => row.type)).toEqual([
      'voucher.delivery',
    ]);

    // Fixture ist idempotent (zweiter Lauf: kein zweiter Gutschein) und nur in demo erlaubt.
    const effective = await ctx.auth.effectivePermissions(adminId, now);
    const fixtureCtx = {
      db: ctx.db,
      config: ctx.config,
      services: demo.services,
      now,
      clock: { at: () => now, now } as never,
      actorId: adminId,
      effective,
      visibility: { canViewCompleted: true, visibilityDays: 0, now },
      registry: demo.registry,
      datasetVersion: 1,
      register: async () => undefined,
      resolve: (key: string) => resolveId(key),
    };
    await voucherSituationFixture.run(fixtureCtx as never);
    expect(
      await ctx.db
        .select({ id: vouchers.id })
        .from(vouchers)
        .where(eq(vouchers.customerId, customerId)),
    ).toHaveLength(1);
    await expect(
      voucherSituationFixture.run({
        ...fixtureCtx,
        config: { ...ctx.config, appEnv: 'development' },
      } as never),
    ).rejects.toMatchObject({ name: 'DemoError', demoCode: 'DEMO_ONLY' });

    // Anwendbar im Entwurf des zweiten Vorgangs des Wiedermieters (POST /staff/offer-versions/:id/voucher).
    const repeatProcessId = await resolveId(DEMO_SEED_KEYS.processRepeatSecond);
    const drafts = await ctx.db
      .select({ versionId: offerVersions.id, voucherId: offerVersions.voucherId })
      .from(offerVersions)
      .innerJoin(offers, eq(offers.id, offerVersions.offerId))
      .where(and(eq(offers.processId, repeatProcessId), eq(offerVersions.status, 'draft')));
    expect(drafts).toHaveLength(1);
    const draft = drafts[0]!;
    expect(draft.voucherId).toBeNull();
    // Nur der Test kennt den Code: Versandkopie wie der Versandjob entschlüsselt (PayloadCrypto v2).
    const code = new PayloadCrypto(ctx.config).decrypt(
      voucher.deliveryCodeCiphertext!,
      'voucher-delivery',
      voucher.id,
    );
    const applied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${draft.versionId}/voucher`,
      headers: { cookie },
      payload: { code },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toEqual({ applied: true });
    const updatedDraft = (
      await ctx.db.select().from(offerVersions).where(eq(offerVersions.id, draft.versionId))
    )[0]!;
    expect(updatedDraft.voucherId).toBe(voucher.id);
    // Reservierung erst beim Versand – im Entwurf bleibt der Gutschein aktiv.
    const after = (await ctx.db.select().from(vouchers).where(eq(vouchers.id, voucher.id)))[0]!;
    expect(after.status).toBe('active');
    // Aufräumen für Folge-Szenarien (Entwurf wieder ohne Gutschein).
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/staff/offer-versions/${draft.versionId}/voucher`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(200);
  });

  it('T15. Demo kann keine simulierte erfolgreiche Lexware-Übertragung erzeugen: Settlement bleibt „Bereit zur Buchhaltung“, kein Job, transferNow 409, Mock-Steuerung 409, run-due-jobs überträgt nichts, Vorgang bleibt offen, Blocker demo_unavailable', async () => {
    const processId = await resolveId(DEMO_SEED_KEYS.processCleaningPending);
    const view = await settlementViewFor(processId);
    expect(view.settlement.status).toBe('ready_for_accounting');
    expect(view.settlement.accountingBlocker).toBe('demo_unavailable');
    expect(view.settlement.accountingProvider).toBeNull();
    expect(view.settlement.accountingReference).toBeNull();
    expect(view.settlement.autoTransferPlannedAt).toBeNull();
    expect(view.settlement.accounting.provider).toBe('disabled');
    expect(view.settlement.accounting.blockers).toEqual([]);
    expect(view.transfer).toBeNull();
    expect(view.dominantAction).toEqual({
      key: 'demo_unavailable',
      label: 'Bereit zur Buchhaltung',
      hint: 'Buchhaltungsübertragung ist in der Demo nicht verfügbar.',
    });
    expect(view.dominantAction.hint).toBe(DEMO_ACCOUNTING_UNAVAILABLE_HINT);
    expect(view.mock).toEqual({ isMock: false, controlsAvailable: false });

    const noJobs = `SELECT count(*)::int AS n FROM integration_jobs
      WHERE type IN ('settlement.accounting_transfer', 'cancellation.accounting_transfer', 'lexware.event.process')`;
    expect(await countRows(noJobs)).toBe(0);

    // Manuelle Übertragung: 409 ACCOUNTING_NOT_CONFIGURED – nichts wird vorbereitet oder gesperrt.
    const transfer = await ctx.app.inject({
      method: 'POST',
      url: `/staff/settlements/${view.settlement.id}/transfer`,
      headers: { cookie },
      payload: { version: view.settlement.version },
    });
    expect(transfer.statusCode).toBe(409);
    expect(transfer.json().error.code).toBe('ACCOUNTING_NOT_CONFIGURED');

    // Mock-Steuerung: 409 ohne Mock-Instanz (Zahlungsstatus/Fehler/Frist nicht simulierbar).
    const payloads: Record<(typeof MOCK_CONTROL_ROUTES)[number], Record<string, unknown>> = {
      '/staff/accounting/mock/payment-status': {
        transferId: '00000000-0000-4000-8000-000000000001',
        status: 'paid',
      },
      '/staff/accounting/mock/fail-next': { count: 1 },
      '/staff/accounting/mock/expire-wait': { settlementId: view.settlement.id },
    };
    for (const url of MOCK_CONTROL_ROUTES) {
      const response = await ctx.app.inject({
        method: 'POST',
        url,
        headers: { cookie },
        payload: payloads[url],
      });
      expect(response.statusCode, url).toBe(409);
      expect(response.json().error.code).toBe('CONFLICT');
    }

    // „Fällige Jobs ausführen“ bleibt erreichbar (reiner Job-Trigger) – überträgt aber nichts.
    const run = await ctx.app.inject({
      method: 'POST',
      url: '/staff/accounting/mock/run-due-jobs',
      headers: { cookie },
      payload: {},
    });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ failed: 0, mock: true });
    // Auch der Job-Runner des Test-Kontexts (wie der Worker) ändert nichts.
    for (let i = 0; i < 20; i += 1) if ((await ctx.jobs.runOnce()) === 'idle') break;

    const settlementRow = (
      await ctx.db.select().from(settlements).where(eq(settlements.id, view.settlement.id))
    )[0]!;
    expect(settlementRow.status).toBe('ready_for_accounting');
    expect(settlementRow.accountingTransferId).toBeNull();
    expect(settlementRow.lockedAt).toBeNull();
    expect(settlementRow.transferredAt).toBeNull();
    expect(await countRows(`SELECT count(*)::int AS n FROM accounting_transfers`)).toBe(0);
    expect(await countRows(`SELECT count(*)::int AS n FROM lexware_invoice_mappings`)).toBe(0);
    expect(await countRows(noJobs)).toBe(0);
    const processRow = (
      await ctx.db.select().from(processes).where(eq(processes.id, processId))
    )[0]!;
    expect(processRow.mainStatus).toBe('open');
    const again = await settlementViewFor(processId);
    expect(again.settlement.status).toBe('ready_for_accounting');
    expect(again.settlement.accountingBlocker).toBe('demo_unavailable');
    expect(again.dominantAction.key).toBe('demo_unavailable');
    // Keine Mock-Referenz irgendwo im Datensatz.
    expect(
      await countRows(
        `SELECT count(*)::int AS n FROM settlements WHERE accounting_reference LIKE 'MOCK-%'`,
      ),
    ).toBe(0);
  });

  it('T15b. Storno in der Demo: Stornokosten bleiben „Buchhaltung ausstehend“ ohne Job/Transfer, Blocker demo_unavailable in Vorschau und Sicht (kein Fehlerzustand)', async () => {
    const processId = await resolveId(DEMO_SEED_KEYS.processBookingAcceptedPickup);
    const preview = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${processId}/cancellation/preview`,
      headers: { cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      accountingConfigured: false,
      accountingBlocker: 'demo_unavailable',
      blockers: [],
    });
    expect(preview.json().feeCents).toBeGreaterThan(0);

    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${processId}/cancellation`,
      headers: { cookie },
      payload: { confirm: true },
    });
    expect(cancelled.statusCode).toBe(200);
    const viewResponse = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${processId}/cancellation`,
      headers: { cookie },
    });
    expect(viewResponse.statusCode).toBe(200);
    const view = viewResponse.json();
    expect(view.feeCents).toBeGreaterThan(0);
    expect(view.financeStatus).toBe('accounting_pending');
    expect(view.accountingBlocker).toBe('demo_unavailable');
    // Phase 9 friert den Storno-Payload beim Storno ein (Transferzeile `pending`, Provider des
    // aktiven Gateways = `disabled`) – wie production ohne Lexware: nie `mock`, nie `lexware`,
    // keine externe Referenz, kein Erfolg, kein Job.
    expect(view.accountingProvider).toBe('disabled');
    expect(view.accountingReference).toBeNull();
    expect(view.lastTransferErrorCode).toBeNull();
    expect(view.accounting.provider).toBe('disabled');
    expect(view.accounting.invoice).toMatchObject({ created: false });
    expect(view.transfer).toMatchObject({
      provider: 'disabled',
      mock: false,
      externalReference: null,
    });
    expect(view.transfer.status).not.toBe('succeeded');
    expect(
      await countRows(
        `SELECT count(*)::int AS n FROM integration_jobs WHERE type = 'cancellation.accounting_transfer'`,
      ),
    ).toBe(0);
    // Manuelle Storno-Übertragung ebenfalls 409 (nicht konfiguriert) – kein Fake-Erfolg.
    const transfer = await ctx.app.inject({
      method: 'POST',
      url: `/staff/cancellations/${view.id}/transfer`,
      headers: { cookie },
      payload: {},
    });
    // Phase-9-Pfad des Storno-Transfers: AuthError CONFLICT „Buchhaltungsintegration nicht konfiguriert“.
    expect(transfer.statusCode).toBe(409);
    expect(transfer.json().error.code).toBe('CONFLICT');
    expect(transfer.json().error.message).toContain('Buchhaltungsintegration nicht konfiguriert');
    expect(
      await countRows(
        `SELECT count(*)::int AS n FROM accounting_transfers
         WHERE status = 'succeeded' OR external_reference IS NOT NULL OR provider <> 'disabled'`,
      ),
    ).toBe(0);
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${processId}/cancellation`,
      headers: { cookie },
    });
    expect(after.json()).toMatchObject({
      financeStatus: 'accounting_pending',
      accountingBlocker: 'demo_unavailable',
      lastTransferErrorCode: null,
    });
  });
});
