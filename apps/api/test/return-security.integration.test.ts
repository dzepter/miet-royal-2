/**
 * Phase-7-Sicherheitstests 122–137 (Order §79): IDOR für Return, Schaden,
 * Schadensfoto, Fehlteil, technischen Defekt, Lagerrücknahme, Unterschrift,
 * Dokument; QR umgeht keine Rechte; Client kann Reinigungsgebühr,
 * Schadenkosten, Rückgabemenge und Unterzeichner nicht manipulieren; keine
 * Signaturen/Fotos/Telefonnummern in Fehlermeldungen/Logpfaden;
 * Demo-/Production- und Storage-Isolation.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertConfigsIsolated, loadConfig } from '@mietroyal/config';
import { FilesystemStorageProvider } from '@mietroyal/integrations';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { maskLoggedPath } from '../src/app.ts';
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
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { machineByCode, resetWarehouse } from './warehouse-helpers.ts';
import { DAYS, pngBytes, truncateHandoverTables } from './handover-helpers.ts';
import { jpegBytes, POINT_MARKER, readyReturn, startedReturn } from './return-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateHandoverTables(ctx.pool);
  await resetWarehouse(ctx.pool);
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
});

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const effective = await ctx.auth.effectivePermissions(admin.id);
  return { admin, cookie: session.cookie, effective };
}

async function staffWith(adminId: string, keys: string[], suffix: string) {
  return createStaffWithPermissions(ctx, adminId, {
    firstName: 'Test',
    lastName: suffix,
    email: `test.${suffix.toLowerCase()}@test.example`,
    password: `${suffix.toLowerCase()}-passwort-1234`,
    permissionKeys: keys as never,
  });
}

const RETURN_KEYS = [
  'return.view',
  'return.perform',
  'return.complete',
  'damage.document',
  'missing_item.create',
  'missing_item.resolve',
  'machine.view',
];
const UNKNOWN = '00000000-0000-0000-0000-000000000000';

/** Zwei ausgegebene Buchungen A und B mit gestarteten Rückgaben. */
async function twoReturns(adminId: string) {
  const a = await startedReturn(ctx, adminId);
  const b = await startedReturn(ctx, adminId, {
    machineCodes: ['MR-10-01-02'],
    skipInventoryInit: true,
    from: new Date(Date.now() + 10 * DAYS),
    to: new Date(Date.now() + 12 * DAYS),
  });
  return { a, b, services: a.services };
}

describe('122.–130. IDOR und Rechte', () => {
  it('122./127. Return-/Lagerrücknahme-IDOR: fremde Abschnitte/Positionen über die URL sind neutral 404; ohne Sichtbarkeit 403', async () => {
    const { admin, cookie } = await adminSession();
    const { a, b } = await twoReturns(admin.id);
    const crossMachine = await ctx.app.inject({
      method: 'POST',
      url: `/staff/returns/${a.world.bookingId}/machines/${b.detail.machines[0]!.id}/accessories`,
      headers: { cookie },
      payload: { complete: true },
    });
    expect(crossMachine.statusCode).toBe(404);
    const crossItem = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/returns/${a.world.bookingId}/items/${b.detail.items[0]!.id}`,
      headers: { cookie },
      payload: { returnedUnopenedQuantity: 1 },
    });
    expect(crossItem.statusCode).toBe(404);
    const unknown = await ctx.app.inject({
      method: 'GET',
      url: `/staff/returns/${UNKNOWN}`,
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
    const noVisibility = await staffWith(admin.id, RETURN_KEYS, 'Blind');
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/staff/returns/${a.world.bookingId}`,
      headers: { cookie: noVisibility.cookie },
    });
    expect(denied.statusCode).toBe(403);
    const noRight = await staffWith(admin.id, ['process.view_all'], 'Norecht');
    const forbidden = await ctx.app.inject({
      method: 'POST',
      url: `/staff/returns/${a.world.bookingId}/start`,
      headers: { cookie: noRight.cookie },
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/staff/returns',
      headers: { cookie: noRight.cookie },
    });
    expect(list.statusCode).toBe(403);
  });

  it('123./124. Damage- und Schadensfoto-IDOR: fremde Schäden nicht erreichbar, Fotos nur mit Recht und Sichtbarkeit', async () => {
    const { admin, cookie } = await adminSession();
    const { a, b, services } = await twoReturns(admin.id);
    const damageB = await services.returns.addDamage(
      admin.id,
      b.world.bookingId,
      b.detail.machines[0]!.id,
      {
        severity: 'light',
        description: 'Schaden B',
        markers: [POINT_MARKER],
      },
    );
    const { photoId } = await services.damages.addPhoto(admin.id, damageB.damageId, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    const crossCreate = await ctx.app.inject({
      method: 'POST',
      url: `/staff/returns/${a.world.bookingId}/machines/${b.detail.machines[0]!.id}/damages`,
      headers: { cookie },
      payload: { severity: 'light', description: 'x', markers: [POINT_MARKER] },
    });
    expect(crossCreate.statusCode).toBe(404);
    const crossDelete = await ctx.app.inject({
      method: 'DELETE',
      url: `/staff/returns/${a.world.bookingId}/damages/${damageB.damageId}`,
      headers: { cookie },
    });
    expect(crossDelete.statusCode).toBe(404);
    const noResolveRight = await staffWith(
      admin.id,
      RETURN_KEYS.concat('process.view_all'),
      'Resolver',
    );
    const resolve = await ctx.app.inject({
      method: 'POST',
      url: `/staff/damages/${damageB.damageId}/resolve`,
      headers: { cookie: noResolveRight.cookie },
      payload: {},
    });
    expect(resolve.statusCode).toBe(403);
    const blind = await staffWith(admin.id, ['return.view'], 'Fotoblind');
    const photoDenied = await ctx.app.inject({
      method: 'GET',
      url: `/staff/damages/photos/${photoId}`,
      headers: { cookie: blind.cookie },
    });
    expect(photoDenied.statusCode).toBe(403);
    const noRights = await staffWith(admin.id, ['customer.view'], 'Kunde');
    const photoForbidden = await ctx.app.inject({
      method: 'GET',
      url: `/staff/damages/photos/${photoId}`,
      headers: { cookie: noRights.cookie },
    });
    expect(photoForbidden.statusCode).toBe(403);
    const unknownPhoto = await ctx.app.inject({
      method: 'GET',
      url: `/staff/damages/photos/${UNKNOWN}`,
      headers: { cookie },
    });
    expect(unknownPhoto.statusCode).toBe(404);
    const photoUploadForeign = await ctx.app.inject({
      method: 'POST',
      url: `/staff/damages/${damageB.damageId}/photos`,
      headers: { cookie: blind.cookie },
      payload: { mimeType: 'image/jpeg', dataBase64: Buffer.from(jpegBytes()).toString('base64') },
    });
    expect([403]).toContain(photoUploadForeign.statusCode);
  });

  it('125./126. Fehlteil- und Defekt-IDOR: fremde Fälle neutral 404, ohne Recht 403, unbekannte Maschine 404', async () => {
    const { admin, cookie } = await adminSession();
    const { a, b, services } = await twoReturns(admin.id);
    const missingB = await services.returns.addMissingCase(
      admin.id,
      b.world.bookingId,
      b.detail.machines[0]!.id,
      {
        accessoryType: 'lid',
        missingQuantity: 1,
      },
    );
    const crossDelete = await ctx.app.inject({
      method: 'DELETE',
      url: `/staff/returns/${a.world.bookingId}/missing/${missingB.caseId}`,
      headers: { cookie },
    });
    expect(crossDelete.statusCode).toBe(404);
    const noRight = await staffWith(admin.id, ['return.view', 'process.view_all'], 'Fehlteil');
    const resolveDenied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/missing-items/${missingB.caseId}/resolve`,
      headers: { cookie: noRight.cookie },
      payload: {},
    });
    expect(resolveDenied.statusCode).toBe(403);
    const blind = await staffWith(admin.id, ['missing_item.resolve'], 'Fehlteilblind');
    const resolveBlind = await ctx.app.inject({
      method: 'POST',
      url: `/staff/missing-items/${missingB.caseId}/resolve`,
      headers: { cookie: blind.cookie },
      payload: {},
    });
    expect(resolveBlind.statusCode).toBe(403);
    const unknownCase = await ctx.app.inject({
      method: 'POST',
      url: `/staff/missing-items/${UNKNOWN}/resolve`,
      headers: { cookie },
      payload: {},
    });
    expect(unknownCase.statusCode).toBe(404);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    const defectDenied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/technical-defects`,
      headers: { cookie: noRight.cookie },
      payload: { description: 'x' },
    });
    expect(defectDenied.statusCode).toBe(403);
    const defectUnknown = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${UNKNOWN}/technical-defects`,
      headers: { cookie },
      payload: { description: 'x' },
    });
    expect(defectUnknown.statusCode).toBe(404);
  });

  it('128./129. Signatur- und Dokument-IDOR: fremde/unsichtbare Buchungen 403, ungültige Rolle 400, Rückgabe-Recht öffnet keine Angebote', async () => {
    const { admin, cookie } = await adminSession();
    const { a, services } = await twoReturns(admin.id);
    const blind = await staffWith(admin.id, RETURN_KEYS, 'Sigblind');
    const put = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/returns/${a.world.bookingId}/signatures/customer`,
      headers: { cookie: blind.cookie },
      payload: { dataBase64: Buffer.from(pngBytes()).toString('base64') },
    });
    expect(put.statusCode).toBe(403);
    const badRole = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/returns/${a.world.bookingId}/signatures/admin`,
      headers: { cookie },
      payload: { dataBase64: Buffer.from(pngBytes()).toString('base64') },
    });
    expect(badRole.statusCode).toBe(400);
    await readyReturn(ctx, admin.id, services, a.world.bookingId);
    const get = await ctx.app.inject({
      method: 'GET',
      url: `/staff/returns/${a.world.bookingId}/signatures/customer`,
      headers: { cookie: blind.cookie },
    });
    expect(get.statusCode).toBe(403);
    // Angebots-PDF ist mit reinem Rückgabe-Recht nicht abrufbar.
    const offerDoc = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM documents WHERE type = 'offer' LIMIT 1`,
    );
    const viewer = await staffWith(admin.id, ['return.view', 'process.view_all'], 'Viewer');
    const offer = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${offerDoc.rows[0]!.id}`,
      headers: { cookie: viewer.cookie },
    });
    expect(offer.statusCode).toBe(403);
  });

  it('130. QR umgeht keine Rückgabe-Rechte: ohne return.view 403, ohne Sichtbarkeit 403, mit beidem 200', async () => {
    const { admin } = await adminSession();
    await twoReturns(admin.id);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    const noRight = await staffWith(admin.id, ['machine.view', 'process.view_all'], 'Qr');
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/staff/returns/resolve-qr/${machine.qrToken}`,
      headers: { cookie: noRight.cookie },
    });
    expect(denied.statusCode).toBe(403);
    const blind = await staffWith(admin.id, ['return.view'], 'Qrblind');
    const invisible = await ctx.app.inject({
      method: 'GET',
      url: `/staff/returns/resolve-qr/${machine.qrToken}`,
      headers: { cookie: blind.cookie },
    });
    expect(invisible.statusCode).toBe(403);
    const ok = await staffWith(admin.id, ['return.view', 'process.view_all'], 'Qrok');
    const allowed = await ctx.app.inject({
      method: 'GET',
      url: `/staff/returns/resolve-qr/${machine.qrToken}`,
      headers: { cookie: ok.cookie },
    });
    expect(allowed.statusCode).toBe(200);
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/staff/returns/resolve-qr/${machine.qrToken}`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('131.–137. Manipulation, Logs, Isolation', () => {
  it('131. Der Client kann die Reinigungsgebühr weder auf 0 noch auf einen anderen Wert setzen', async () => {
    const { admin, cookie, effective } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    for (const payload of [
      { emptied: false, rinsedTwice: true, nothingDismantled: true, cleanupFeeSnapshotCents: 0 },
      { emptied: false, rinsedTwice: true, nothingDismantled: true, cleanupRequired: false },
      { emptied: false, rinsedTwice: true, nothingDismantled: true, cleanupFeeCents: 100 },
    ]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/staff/returns/${world.bookingId}/machines/${rm.id}/cleanliness`,
        headers: { cookie },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    await services.returns.checkCleanliness(admin.id, effective, world.bookingId, rm.id, {
      emptied: false,
      rinsedTwice: true,
      nothingDismantled: true,
    });
    const row = await ctx.pool.query('SELECT cleanup_fee_snapshot_cents FROM return_machines');
    expect(row.rows[0].cleanup_fee_snapshot_cents).toBe(7500);
    // DB-Backstop: Fakt ohne Betrag oder Betrag ohne Fakt ist unmöglich.
    await expect(
      ctx.pool.query('UPDATE return_machines SET cleanup_fee_snapshot_cents = 0'),
    ).rejects.toThrow();
  });

  it('132./133. Schadenkosten können nicht eingeschleust werden; returned > issued ist auch per SQL unmöglich', async () => {
    const { admin, cookie } = await adminSession();
    const { world, detail } = await startedReturn(ctx, admin.id, {
      selections: [
        { slug: 'sirup-kirsche', role: 'free', quantity: 1 },
        { slug: 'sirup-kirsche', role: 'extra', quantity: 2 },
      ],
      stock: 30,
    });
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    for (const url of [
      `/staff/returns/${world.bookingId}/machines/${detail.machines[0]!.id}/damages`,
      `/staff/machines/${machine.id}/damages`,
    ]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url,
        headers: { cookie },
        payload: {
          severity: 'light',
          description: 'x',
          markers: [POINT_MARKER],
          costCents: 5000,
          photo: {
            mimeType: 'image/jpeg',
            dataBase64: Buffer.from(jpegBytes()).toString('base64'),
          },
        },
      });
      expect(response.statusCode).toBe(400);
    }
    const item = detail.items.find((i) => i.kind === 'commission')!;
    await expect(
      ctx.pool.query(
        'UPDATE return_inventory_items SET returned_unopened_quantity = 99 WHERE id = $1',
        [item.id],
      ),
    ).rejects.toThrow();
    const extra = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/returns/${world.bookingId}/items/${item.id}`,
      headers: { cookie },
      payload: { returnedUnopenedQuantity: 1, chargeableQuantity: 0 },
    });
    expect(extra.statusCode).toBe(400);
  });

  it('134./135. Unterzeichner nicht fälschbar; Fehlermeldungen und Logpfade ohne Signatur-/Foto-/Telefondaten', async () => {
    const { admin, cookie } = await adminSession();
    const { world } = await startedReturn(ctx, admin.id);
    const bogus = Buffer.from('kein-png-' + 'x'.repeat(200)).toString('base64');
    const badSignature = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/returns/${world.bookingId}/signatures/customer`,
      headers: { cookie },
      payload: { dataBase64: bogus, signerName: 'Gefälscht' },
    });
    expect(badSignature.statusCode).toBe(400);
    expect(badSignature.body).not.toContain(bogus.slice(0, 40));
    expect(badSignature.body).not.toContain('Gefälscht');
    const badReturner = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/returns/${world.bookingId}/returner`,
      headers: { cookie },
      payload: { kind: 'other', firstName: 'Otto', lastName: '', phone: '+49 6131 987654' },
    });
    expect(badReturner.statusCode).toBe(400);
    expect(badReturner.body).not.toContain('987654');
    const badPhoto = await ctx.app.inject({
      method: 'POST',
      url: `/staff/returns/${world.bookingId}/machines/${UNKNOWN}/photos`,
      headers: { cookie },
      payload: { mimeType: 'image/png', dataBase64: bogus },
    });
    expect([400, 404]).toContain(badPhoto.statusCode);
    expect(badPhoto.body).not.toContain(bogus.slice(0, 40));
    expect(maskLoggedPath(`/staff/returns/${world.bookingId}/signatures/customer?token=abc`)).toBe(
      `/staff/returns/${world.bookingId}/signatures/customer`,
    );
    // Maschinen-QR-Token des Rückgabe-Einstiegs erscheint nie im Klartext im Log.
    expect(maskLoggedPath('/staff/returns/resolve-qr/0123456789abcdef0123456789abcdef')).toBe(
      '/staff/returns/resolve-qr/***',
    );
  });

  it('136. Demo-/Production-Isolation bleibt erzwungen (inkl. Storage-Bucket)', () => {
    const base = {
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://prod:SYNTH@db-prod.internal:5432/mietroyal_prod',
      AUTH_SECRET_KEY: '1'.repeat(64),
      STORAGE_DRIVER: 's3',
      STORAGE_S3_ENDPOINT: 'https://s3.synthetic.example',
      STORAGE_S3_REGION: 'eu-central-1',
      STORAGE_S3_BUCKET: 'mietroyal-prod-documents',
      STORAGE_S3_ACCESS_KEY_ID: 'SYNTH-PROD',
      STORAGE_S3_SECRET_ACCESS_KEY: 'SYNTH-prod-secret',
    };
    const production = loadConfig(base);
    const demo = loadConfig({
      ...base,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://demo:SYNTH@db-demo.internal:5432/mietroyal_demo',
      AUTH_SECRET_KEY: '2'.repeat(64),
      STORAGE_S3_BUCKET: 'mietroyal-demo-documents',
      STORAGE_S3_ACCESS_KEY_ID: 'SYNTH-DEMO',
      STORAGE_S3_SECRET_ACCESS_KEY: 'SYNTH-demo-secret',
    });
    expect(() => assertConfigsIsolated(production, demo)).not.toThrow();
    const sameBucket = loadConfig({
      ...base,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://demo:SYNTH@db-demo.internal:5432/mietroyal_demo',
      AUTH_SECRET_KEY: '2'.repeat(64),
    });
    expect(() => assertConfigsIsolated(production, sameBucket)).toThrow();
  });

  it('137. Storage-Isolation: Rückgabefotos/Protokolle liegen nur im Storage der eigenen Umgebung', async () => {
    const { admin, effective } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    await services.returns.checkCleanliness(admin.id, effective, world.bookingId, rm.id, {
      emptied: false,
      rinsedTwice: true,
      nothingDismantled: true,
    });
    await services.returns.addCleanupPhoto(admin.id, world.bookingId, rm.id, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    await readyReturn(ctx, admin.id, services, world.bookingId, { skipCleanliness: true });
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    const keys = await ctx.pool.query<{ storage_key: string }>(
      `SELECT storage_key FROM return_photos UNION ALL SELECT storage_key FROM documents WHERE id = $1`,
      [finalized.return.protocolDocumentId],
    );
    // Isolation ist Konfigurationssache (Test 136: getrennte Buckets/Roots je
    // Umgebung). Hier: alle Schlüssel sind relative, umgebungsneutrale Pfade ohne
    // Kundendaten – sie lösen sich nur innerhalb des konfigurierten Storage der
    // eigenen Umgebung auf, in einem anders gewurzelten Storage nicht.
    const otherEnvironment = new FilesystemStorageProvider(
      mkdtempSync(join(tmpdir(), 'mietroyal-other-')),
    );
    expect(keys.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of keys.rows) {
      expect(row.storage_key).toMatch(/^(returns|documents)\/[A-Za-z0-9/_.-]+$/);
      expect(row.storage_key).not.toMatch(/\.\.|^\/|customer|kunde|@/i);
      expect(await ctx.storage.exists(row.storage_key)).toBe(true);
      expect(await otherEnvironment.exists(row.storage_key)).toBe(false);
      await expect(otherEnvironment.get(row.storage_key)).rejects.toThrow();
    }
  });
});

describe('Review-Härtungen (Order §§66/79/81): Sichtbarkeit und Existenz-Orakel', () => {
  it('R5. Grundrecht vor dem Laden: ohne process.view_all immer 403 – unbekannte IDs verraten keine Existenz', async () => {
    const { admin } = await adminSession();
    await startedReturn(ctx, admin.id);
    const blind = await staffWith(admin.id, RETURN_KEYS, 'Orakel');
    for (const url of [
      `/staff/returns/${UNKNOWN}`,
      `/staff/returns/photos/${UNKNOWN}`,
      `/staff/damages/photos/${UNKNOWN}`,
      `/staff/technical-defects/${UNKNOWN}/photo`,
      '/staff/returns/resolve-qr/0123456789abcdef0123456789abcdef0123456789abcdef',
      '/staff/missing-items',
    ]) {
      const response = await ctx.app.inject({
        method: 'GET',
        url,
        headers: { cookie: blind.cookie },
      });
      expect(response.statusCode, url).toBe(403);
    }
    for (const url of [
      `/staff/damages/${UNKNOWN}/resolve`,
      `/staff/missing-items/${UNKNOWN}/resolve`,
      `/staff/returns/${UNKNOWN}/start`,
    ]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url,
        headers: { cookie: blind.cookie },
        payload: {},
      });
      expect(response.statusCode, url).toBe(403);
    }
  });

  it('R6. Nachtrag und Defekt hängen am letzten Rückgabevorgang: ohne dessen Sichtbarkeit kein Schreiben; Fehlteile/Defekte nur mit Vorgangsrecht sichtbar', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    await services.returns.addMissingCase(admin.id, world.bookingId, detail.machines[0]!.id, {
      accessoryType: 'lid',
      missingQuantity: 1,
    });
    await readyReturn(ctx, admin.id, services, world.bookingId, { skipAccessories: true });
    await services.returns.finalize(admin.id, world.bookingId);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    await services.damages.addTechnicalDefect(admin.id, machine.id, {
      description: 'Pumpe defekt',
      photo: null,
    });
    const finding = {
      severity: 'light',
      description: 'Kratzer',
      markers: [POINT_MARKER],
      photo: { mimeType: 'image/jpeg', dataBase64: Buffer.from(jpegBytes()).toString('base64') },
    };
    const blind = await staffWith(
      admin.id,
      ['damage.document', 'machine.change_status'],
      'Nachtragblind',
    );
    const damageDenied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/damages`,
      headers: { cookie: blind.cookie },
      payload: finding,
    });
    expect(damageDenied.statusCode).toBe(403);
    const defectDenied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/technical-defects`,
      headers: { cookie: blind.cookie },
      payload: { description: 'Noch ein Defekt', photo: null },
    });
    expect(defectDenied.statusCode).toBe(403);
    expect(await services.damages.currentForMachine(machine.id)).toEqual([]);
    expect(await services.damages.technicalDefectsFor(machine.id)).toHaveLength(1);
    // Maschinenansicht ohne process.view_all: keine vorgangsbezogenen Einträge.
    const machineOnly = await staffWith(admin.id, ['machine.view'], 'Nurmaschine');
    const condition = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/${machine.id}/condition`,
      headers: { cookie: machineOnly.cookie },
    });
    expect(condition.statusCode).toBe(200);
    expect(condition.json().openMissingCases).toEqual([]);
    expect(condition.json().technicalDefects).toEqual([]);
    const adminCondition = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/${machine.id}/condition`,
      headers: { cookie },
    });
    expect(adminCondition.json().openMissingCases).toHaveLength(1);
    expect(adminCondition.json().technicalDefects).toHaveLength(1);
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/staff/missing-items',
      headers: { cookie },
    });
    expect(list.json().cases).toHaveLength(1);
  });
});
