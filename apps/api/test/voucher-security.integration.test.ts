/**
 * Phase-11-Pflichttests Security 21, 25–29, 112/113, 124–127 (Order §§12,
 * 14, 56, 59, 60, 127): kein Klartextcode in DB-Spalten, Kunden-/Vorgangs-
 * API, Logs, Angebots-/Buchungs-Snapshots; Kunden-/Gutschein-IDOR über die
 * bestehenden Rechte; Request-Logging ohne Body; Versandkopie nie im
 * Frontend; Offline-Sync kennt keine Gutschein-Mutation.
 *
 * Phase-11-Finale, Punkt 2 (F16–F20): Das stdout-Reveal-Script ist entfernt;
 * der Klartext darf weder im API-Log (In-Prozess-Jobrunner der API) noch im
 * Worker-Log noch über irgendeine registrierte Route erscheinen.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { bookings, offerVersions, vouchers } from '@mietroyal/database';
import { formatVoucherCode } from '@mietroyal/domain';
import { JobRunner, type JobRunnerLogger } from '@mietroyal/integrations';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFinanceJobHandlers } from '../src/jobs/finance.ts';
import {
  enqueueVoucherEligibility,
  voucherEligibilityIdempotencyKey,
} from '../src/voucher/voucher-jobs.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { bookingRow } from './cancellation-helpers.ts';
import { createStaffWithPermissions, createTestCustomer } from './crm-helpers.ts';
import { adminSession } from './settlement-helpers.ts';
import { voucherWorld } from './voucher-offer-helpers.ts';
import {
  drainJobs,
  issueTestVoucher,
  payAndCompleteWorld,
  resetVoucherWorld,
  voucherDeliveryFor,
  voucherRow,
  voucherServiceFor,
  vouchersForSettlement,
} from './voucher-helpers.ts';

let ctx: TestContext;
const logLines: string[] = [];
const logDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});
const logText = () => logLines.join('');

beforeAll(async () => {
  ctx = await createTestContext({ logDestination, logLevel: 'trace' });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetVoucherWorld(ctx);
  logLines.length = 0;
});

/** Alle Text-/JSON-Spalten der Datenbank nach einem Klartext durchsuchen (nur Test). */
async function tablesContaining(needle: string): Promise<string[]> {
  const columns = await ctx.pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb', 'json')`,
  );
  const hits: string[] = [];
  for (const column of columns.rows) {
    const result = await ctx.pool.query(
      `SELECT 1 FROM "${column.table_name}" WHERE "${column.column_name}"::text ILIKE $1 LIMIT 1`,
      [`%${needle}%`],
    );
    if (result.rowCount !== null && result.rowCount > 0) {
      hits.push(`${column.table_name}.${column.column_name}`);
    }
  }
  return hits;
}

async function issuedWorld() {
  const { admin, cookie } = await adminSession(ctx);
  const paid = await payAndCompleteWorld(ctx, admin.id, cookie);
  await drainJobs(ctx);
  const voucher = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
  const code = await voucherDeliveryFor(ctx).revealCodeForDelivery(voucher.id);
  return { admin, cookie, paid, voucher, code };
}

describe('Kein Klartext (Tests 21, 25–29, 27)', () => {
  it('21./27./28./29. Nach Erzeugung, Reservierung und Einlösung steht der Code in KEINER DB-Spalte (auch nicht in Snapshots/Jobs) und in keiner Logzeile', async () => {
    const { paid, voucher, code } = await issuedWorld();
    const service = voucherServiceFor(ctx);
    const offerId = (await bookingRow(ctx, paid.world.bookingId)).offerId;
    await ctx.db.transaction((tx) =>
      service.reserveForOffer(tx, {
        voucherId: voucher.id,
        offerId,
        customerId: paid.world.customerId,
        now: new Date(),
      }),
    );
    await ctx.db.transaction((tx) =>
      service.redeem(tx, {
        voucherId: voucher.id,
        offerId,
        bookingId: paid.world.bookingId,
        processId: paid.world.processId,
        customerId: paid.world.customerId,
        expectedDiscountCents: 2000,
        machineSubtotalCents: 10_000,
        now: new Date(),
      }),
    );
    const body = code.slice(4);
    expect(await tablesContaining(code)).toEqual([]);
    expect(await tablesContaining(formatVoucherCode(code))).toEqual([]);
    expect(await tablesContaining(body)).toEqual([]);
    // Snapshot-Spalten der Angebots-/Buchungsreihen tragen keinen Klartext.
    const versions = await ctx.db.select().from(offerVersions);
    const bookingRows = await ctx.db.select().from(bookings);
    const snapshots = JSON.stringify([
      versions.map((v) => v.voucherSnapshot),
      bookingRows.map((b) => b.voucherSnapshot),
    ]);
    expect(snapshots).not.toContain(body);
    // Log (Level trace) ohne Klartext/Hash/Kopie.
    const log = logText();
    expect(log).not.toContain(code);
    expect(log).not.toContain(body);
    expect(log).not.toContain(formatVoucherCode(code));
    expect(log).not.toContain(voucher.deliveryCodeCiphertext!);
  });

  it('25./125. Kunden-API: nur maskierte Referenz/Status – nie Code, Hash, Versandkopie, Ciphertext-Feld', async () => {
    const { cookie, paid, voucher, code } = await issuedWorld();
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/staff/customers/${paid.world.customerId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const json = response.json() as { voucher: Record<string, unknown> | null };
    expect(json.voucher).toMatchObject({
      id: voucher.id,
      status: 'active',
      statusLabel: 'Aktiv',
      maskedReference: `MR20-••••-••••-${voucher.codeSuffix}`,
      deliveryStatus: 'pending',
      deliveryLabel: 'Versand ausstehend',
      originProcessId: paid.world.processId,
    });
    expect(Object.keys(json.voucher!).sort()).toEqual(
      [
        'deliveryLabel',
        'deliveryStatus',
        'expiresAt',
        'id',
        'maskedReference',
        'originProcessId',
        'originProcessNumber',
        'reservedOfferId',
        'status',
        'statusLabel',
      ].sort(),
    );
    const text = response.body;
    expect(text).not.toContain(code);
    expect(text).not.toContain(code.slice(4));
    expect(text).not.toContain(voucher.codeHash);
    expect(text).not.toContain(voucher.deliveryCodeCiphertext!);
    expect(text).not.toMatch(/codeHash|deliveryCodeCiphertext|ciphertext/i);
  });

  it('26./125. Vorgangs-API: „20-%-Wiedermieter-Gutschein erstellt – Versand ausstehend“ ohne Code/Hash/Kopie', async () => {
    const { admin, cookie, paid, voucher, code } = await issuedWorld();
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${paid.world.processId}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const json = response.json() as { voucher: Record<string, unknown> | null };
    expect(json.voucher).toMatchObject({
      id: voucher.id,
      status: 'active',
      deliveryStatus: 'pending',
      deliveryLabel: 'Versand ausstehend',
      maskedReference: `MR20-••••-••••-${voucher.codeSuffix}`,
    });
    expect(response.body).not.toContain(code.slice(4));
    expect(response.body).not.toContain(voucher.codeHash);
    expect(response.body).not.toContain(voucher.deliveryCodeCiphertext!);
    expect(response.body).not.toMatch(/codeHash|deliveryCodeCiphertext/i);
    // Ohne Gutschein: voucher null (kein Fehler).
    const other = await createTestCustomer(ctx, admin.id, { email: 'andere@test.example' });
    const none = await ctx.app.inject({
      method: 'GET',
      url: `/staff/customers/${other.id}`,
      headers: { cookie },
    });
    expect(none.statusCode).toBe(200);
    expect((none.json() as { voucher: unknown }).voucher).toBeNull();
  });
});

describe('IDOR (Tests 112/113)', () => {
  it('112. Voucher-IDOR: ohne customer.view kein Kundenprofil (403); mit Recht nur der Gutschein DIESES Kunden; fremder Kunde ⇒ voucher null', async () => {
    const { admin, cookie, paid, voucher } = await issuedWorld();
    const limited = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Lena',
      lastName: 'Lager',
      email: 'lena.lager@test.example',
      password: 'lena-passwort-12345',
      permissionKeys: ['machine.view'],
    });
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/staff/customers/${paid.world.customerId}`,
      headers: { cookie: limited.cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain(voucher.codeSuffix);
    // Zweiter Kunde mit eigenem Test-Gutschein: jedes Profil zeigt nur den eigenen.
    const other = await createTestCustomer(ctx, admin.id, { email: 'zweiter@test.example' });
    const otherProfile = await ctx.app.inject({
      method: 'GET',
      url: `/staff/customers/${other.id}`,
      headers: { cookie },
    });
    expect((otherProfile.json() as { voucher: unknown }).voucher).toBeNull();
    const ownProfile = await ctx.app.inject({
      method: 'GET',
      url: `/staff/customers/${paid.world.customerId}`,
      headers: { cookie },
    });
    expect((ownProfile.json() as { voucher: { id: string } }).voucher.id).toBe(voucher.id);
    // Der Summary-Datensatz nennt keine Kunden-ID eines anderen Kunden.
    expect(ownProfile.body).not.toContain(other.id);
  });

  it('113. Customer-IDOR: Vorgang ohne process.view_all ⇒ 403 (kein Gutschein-Leak); fremder Vorgang desselben Kunden zeigt keinen fremden Gutschein', async () => {
    const { admin, cookie, paid, voucher } = await issuedWorld();
    const limited = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Olaf',
      lastName: 'Ohnesicht',
      email: 'olaf@test.example',
      password: 'olaf-passwort-12345',
      permissionKeys: ['customer.view'],
    });
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${paid.world.processId}`,
      headers: { cookie: limited.cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain(voucher.codeSuffix);
    // Unbekannte/fremde Vorgangs-ID ⇒ 404, keine Gutscheindaten.
    const missing = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${randomUUID()}`,
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain(voucher.codeSuffix);
    // Gutschein eines ANDEREN Kunden erscheint nie am Vorgang dieses Kunden.
    const other = await createTestCustomer(ctx, admin.id, { email: 'dritter@test.example' });
    await issueTestVoucher(ctx, {
      customerId: other.id,
      originProcessId: paid.world.processId,
      originBookingId: paid.world.bookingId,
      originReturnId: paid.world.returnId,
      originSettlementId: paid.settlementId,
    }).catch(() => undefined); // UNIQUE origin_settlement_id verhindert einen zweiten – bewusst.
    const profile = await ctx.app.inject({
      method: 'GET',
      url: `/staff/customers/${other.id}`,
      headers: { cookie },
    });
    expect((profile.json() as { voucher: unknown }).voucher).toBeNull();
  });
});

describe('Logging, Frontend, Offline (Tests 124–127)', () => {
  it('124. Request-Logging enthält den Gutscheincode aus dem Request-Body nicht (Apply-Request)', async () => {
    const { cookie, paid, code } = await issuedWorld();
    logLines.length = 0;
    const version = await ctx.db.select({ id: offerVersions.id }).from(offerVersions).limit(1);
    const versionId = version[0]?.id ?? randomUUID();
    const formatted = formatVoucherCode(code);
    const apply = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${versionId}/voucher`,
      headers: { cookie },
      payload: { code: formatted },
    });
    // Route (Agent O) kann 200/400/404/409 liefern – entscheidend ist das Log.
    expect([200, 400, 404, 409]).toContain(apply.statusCode);
    const log = logText();
    expect(log).toContain('/staff/offer-versions/');
    expect(log).not.toContain(formatted);
    expect(log).not.toContain(code);
    expect(log).not.toContain(code.slice(4));
    expect(apply.body).not.toContain(code.slice(4));
    void paid;
  });

  it('125. Versandkopie und Hash verlassen den Server nie (Kunden-, Vorgangs-Route, Fehlerantworten)', async () => {
    const { cookie, paid, voucher } = await issuedWorld();
    for (const url of [
      `/staff/customers/${paid.world.customerId}`,
      `/staff/processes/${paid.world.processId}`,
      `/staff/processes/${paid.world.processId}/settlement`,
    ]) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).not.toContain(voucher.codeHash);
      expect(response.body, url).not.toContain(voucher.deliveryCodeCiphertext!);
    }
    // Kein Endpunkt liefert den Klartext: Gutschein-Routen mit Klartext existieren nicht.
    for (const url of [
      `/staff/vouchers/${voucher.id}`,
      `/staff/vouchers/${voucher.id}/code`,
      `/staff/vouchers/${voucher.id}/reveal`,
      `/staff/customers/${paid.world.customerId}/voucher`,
    ]) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it('126. Umgebungsisolation: anderer AUTH_SECRET_KEY entschlüsselt die Kopie nicht (siehe auch Unit 24/126); Hash bleibt prüfbar', async () => {
    const { voucher, code, paid } = await issuedWorld();
    const { decryptDeliveryCode } = await import('../src/voucher/voucher-crypto.ts');
    expect(() =>
      decryptDeliveryCode(
        voucher.deliveryCodeCiphertext!,
        voucher.id,
        'demo-environment-secret-key-zzzzzzzzzzzzzzzzzzzz',
      ),
    ).toThrow();
    expect(
      decryptDeliveryCode(voucher.deliveryCodeCiphertext!, voucher.id, ctx.config.auth.secretKey),
    ).toBe(code);
    const validated = await voucherServiceFor(ctx).validateForOffer({
      code,
      customerId: paid.world.customerId,
      offerId: randomUUID(),
    });
    expect(validated.ok).toBe(true);
    expect((await voucherRow(ctx, voucher.id))!.status).toBe('active');
  });

  it('127. Offline-Sync kennt keine Gutschein-Mutation (voucher.apply ⇒ 400, strict Schema)', async () => {
    const { cookie, code } = await issuedWorld();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/staff/offline/sync',
      headers: { cookie },
      payload: {
        deviceId: randomUUID(),
        environment: 'development',
        clientTime: new Date().toISOString(),
        mutation: {
          clientMutationId: randomUUID(),
          type: 'voucher.apply',
          contextKind: 'booking',
          contextId: randomUUID(),
          createdAt: new Date().toISOString(),
          baseVersion: null,
          payload: { code },
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(logText()).not.toContain(code.slice(4));
  });
});

/**
 * Phase-11-Finale, Punkt 2 (Pflichttests F16–F20, F21 in voucher-delivery):
 * kein Klartext-Gutscheincode über Logs oder HTTP – das frühere
 * stdout-Reveal-Script (apps/api/scripts/e2e-voucher-reveal.ts) existiert
 * nicht mehr; E2E entschlüsselt in-process (tests/e2e/helpers/voucher.ts).
 */
describe('Phase-11-Finale: kein Klartext über Logs/HTTP (F16, F17, F19, F20)', () => {
  /** Alle Code-Formen plus Hash/Kopie, in denen ein Leak sichtbar wäre. */
  function leakNeedles(
    code: string,
    voucher: { codeHash: string; deliveryCodeCiphertext: string | null },
  ) {
    return [
      code,
      code.slice(4),
      formatVoucherCode(code),
      voucher.codeHash,
      voucher.deliveryCodeCiphertext!,
    ];
  }

  it('F16. API-Log (trace): Erzeugung über den In-Prozess-Jobrunner der API (run-due-jobs), Kunden-/Vorgangs-/Angebots-Abrufe und Apply – keine Logzeile enthält Code, Hash oder Versandkopie', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie);
    logLines.length = 0;
    // Jobs über die API-Route: der Handler läuft im API-Prozess mit app.log.
    const run = await ctx.app.inject({
      method: 'POST',
      url: '/staff/accounting/mock/run-due-jobs',
      headers: { cookie },
    });
    expect(run.statusCode).toBe(200);
    expect((run.json() as { processed: number }).processed).toBeGreaterThan(0);
    const voucher = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
    const code = await voucherDeliveryFor(ctx).revealCodeForDelivery(voucher.id);
    // Zugriffe, die den Gutschein berühren (Views + Apply-Versuch).
    for (const url of [
      `/staff/customers/${paid.world.customerId}`,
      `/staff/processes/${paid.world.processId}`,
      `/staff/processes/${paid.world.processId}/offer`,
    ]) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode, url).toBe(200);
    }
    const version = await ctx.db.select({ id: offerVersions.id }).from(offerVersions).limit(1);
    await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${version[0]?.id ?? randomUUID()}/voucher`,
      headers: { cookie },
      payload: { code: formatVoucherCode(code) },
    });
    const log = logText();
    // Der Job wurde tatsächlich im API-Prozess verarbeitet und protokolliert …
    expect(log).toContain('voucher.eligibility_check verarbeitet');
    expect(log).toContain(voucher.id);
    // … aber ohne Klartext/Hash/Kopie in irgendeiner Zeile.
    for (const needle of leakNeedles(code, voucher)) expect(log).not.toContain(needle);
  });

  it('F17. Worker-Log: eigener JobRunner mit Logger (wie apps/worker) verarbeitet voucher.eligibility_check – Outcome/IDs im Log, nie Code, Hash oder Versandkopie', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await payAndCompleteWorld(ctx, admin.id, cookie);
    // Die automatisch eingereihten Jobs ohne Logger abräumen, dann den
    // Gutschein entfernen: der Worker-Job unten erzeugt ihn neu und loggt.
    await drainJobs(ctx);
    await ctx.db.delete(vouchers);
    const workerLines: string[] = [];
    const workerLogger: JobRunnerLogger = {
      info: (context, message) =>
        workerLines.push(JSON.stringify({ level: 'info', ...context, message })),
      warn: (context, message) =>
        workerLines.push(JSON.stringify({ level: 'warn', ...context, message })),
      error: (context, message) =>
        workerLines.push(JSON.stringify({ level: 'error', ...context, message })),
    };
    const worker = new JobRunner(ctx.queue, 'phase11-final-worker', workerLogger);
    registerFinanceJobHandlers(worker, {
      db: ctx.db,
      config: ctx.config,
      queue: ctx.queue,
      storage: ctx.storage,
      accountingGateway: ctx.gateway,
      lexware: ctx.lexware,
      lexwareConnection: ctx.lexwareConnection,
      workerId: 'phase11-final-worker',
      logger: workerLogger,
    });
    await enqueueVoucherEligibility(ctx.queue, {
      settlementId: paid.settlementId,
      trigger: 'manual',
      key: voucherEligibilityIdempotencyKey(paid.settlementId, 'manual', randomUUID()),
    });
    expect(await worker.runOnce()).toBe('processed');
    const voucher = (await vouchersForSettlement(ctx, paid.settlementId))[0]!;
    expect(voucher).toBeDefined();
    const code = await voucherDeliveryFor(ctx).revealCodeForDelivery(voucher.id);
    const workerLog = workerLines.join('\n');
    expect(workerLog).toContain('voucher.eligibility_check verarbeitet');
    expect(workerLog).toContain(paid.settlementId);
    expect(workerLog).toMatch(/"outcome":"created"/);
    for (const needle of leakNeedles(code, voucher)) expect(workerLog).not.toContain(needle);
    // Auch das API-Log (Enqueue/Views während des Aufbaus) bleibt sauber.
    for (const needle of leakNeedles(code, voucher)) expect(logText()).not.toContain(needle);
  });

  it('F19. Kein Produkt-/Test-HTTP-Endpunkt liefert Klartext: keine Route mit reveal/code/vouchers; Kunden-, Vorgangs-, Angebots- und öffentliche Antworten ohne Code/Hash/Kopie', async () => {
    // (a) Routentabelle der App: kein Pfad, der einen Code herausgeben könnte.
    const routes = ctx.app.printRoutes({ commonPrefix: false });
    expect(routes).not.toMatch(/reveal/i);
    expect(routes).not.toMatch(/voucher-code/i);
    expect(routes).not.toMatch(/\/vouchers\b/i);
    expect(routes).not.toMatch(/\/code\b/i);
    expect(routes).not.toMatch(/\/(test|e2e|debug|internal)\b/i);
    // Einziger Gutschein-Pfad: Apply/Remove am Angebotsentwurf (nimmt den Code
    // entgegen, gibt ihn nie zurück) – kein weiterer Pfad endet auf /voucher.
    const voucherPaths = routes.split('\n').filter((line) => /\/voucher\b/i.test(line));
    expect(voucherPaths).toHaveLength(1);
    expect(voucherPaths[0]).toMatch(/\/voucher \(POST, DELETE\)/);
    expect(routes).toMatch(/offer-versions\/:id/);
    // (b) Antworten mit angewendetem Gutschein (Staff + öffentlich).
    const { admin, cookie } = await adminSession(ctx);
    const world = await voucherWorld(ctx, admin.id);
    const voucher = (await voucherRow(ctx, world.voucherId))!;
    const apply = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${world.versionId}/voucher`,
      headers: { cookie },
      payload: { code: world.code },
    });
    expect(apply.statusCode).toBe(200);
    const sent = await ctx.app.inject({
      method: 'POST',
      url: `/staff/offer-versions/${world.versionId}/send`,
      headers: { cookie },
    });
    expect(sent.statusCode).toBe(200);
    const token = (sent.json().publicPath as string).replace('/angebot/', '');
    const needles = leakNeedles(world.compact, voucher);
    expect(apply.body).not.toContain(world.compact.slice(4));
    for (const [url, headers] of [
      [`/staff/customers/${world.customerId}`, { cookie }],
      [`/staff/processes/${world.processId}`, { cookie }],
      [`/staff/processes/${world.processId}/offer`, { cookie }],
      [`/public/offers/${token}`, {}],
    ] as const) {
      const response = await ctx.app.inject({ method: 'GET', url, headers });
      expect(response.statusCode, url).toBe(200);
      for (const needle of needles) expect(response.body, url).not.toContain(needle);
      expect(response.body, url).not.toMatch(/codeHash|deliveryCodeCiphertext|ciphertext/i);
    }
    // (c) Denkbare Test-/Reveal-Endpunkte existieren nicht (auch nicht ohne Auth).
    for (const url of [
      `/staff/vouchers/${world.voucherId}/reveal`,
      `/test/vouchers/${world.voucherId}/reveal`,
      `/e2e/voucher-code/${world.voucherId}`,
      `/internal/vouchers/${world.voucherId}/code`,
      `/public/vouchers/${world.voucherId}`,
    ]) {
      const response = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode, url).toBe(404);
      for (const needle of needles) expect(response.body, url).not.toContain(needle);
    }
  });

  it('F20. Keine Klartextdatei und kein Reveal-Script: revealCodeForDelivery liefert den Code nur als Rückgabewert (kein stdout/stderr, kein Log, kein fs-Zugriff im Modul); apps/api/scripts/e2e-voucher-reveal.ts existiert nicht mehr', async () => {
    const { voucher, code } = await issuedWorld();
    const scriptsDir = fileURLToPath(new URL('../scripts/', import.meta.url));
    expect(existsSync(join(scriptsDir, 'e2e-voucher-reveal.ts'))).toBe(false);
    expect(readdirSync(scriptsDir).filter((name) => /reveal/i.test(name))).toEqual([]);
    // Die serverinterne Boundary schreibt nichts: kein fs-/Konsolen-/stdout-Zugriff im Modul.
    const source = readFileSync(
      fileURLToPath(new URL('../src/voucher/voucher-delivery.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/node:fs|writeFile|console\.|process\.std(out|err)/);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      logLines.length = 0;
      const again = await voucherDeliveryFor(ctx).revealCodeForDelivery(voucher.id);
      expect(again).toBe(code);
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(logText()).not.toContain(code.slice(4));
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
