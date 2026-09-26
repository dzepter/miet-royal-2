/**
 * Phase-7-Pflichttests 23–34 (Order §70): Rückgabevorbereitung (entleert,
 * zweimal gespült, nichts demontiert), Reinigungsgebühr-Fakt 75 € je
 * betroffener Maschine (kein Settlement), Beweisfoto-Pflicht, private
 * Fotos, kleine Restmenge ohne Gebühr, keine Bild-KI/Auto-Gebühr.
 */
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
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { resetWarehouse } from './warehouse-helpers.ts';
import { pdfText, pngBytes, truncateHandoverTables } from './handover-helpers.ts';
import { jpegBytes, readyReturn, startedReturn } from './return-helpers.ts';

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

const ALL_OK = { emptied: true, rinsedTwice: true, nothingDismantled: true };

describe('23.–34. Rückgabevorbereitung und Reinigungsgebühr-Fakt', () => {
  it('23./24./25. Entleert, zweimal gespült und nichts demontiert werden je Maschine aktiv bestätigt', async () => {
    const { admin, effective } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    expect(rm.emptied).toBeNull();
    expect(rm.cleanlinessCheckedAt).toBeNull();
    expect(detail.blockers).toContainEqual(expect.stringContaining('Rückgabevorbereitung'));
    await services.returns.checkCleanliness(admin.id, effective, world.bookingId, rm.id, ALL_OK);
    const view = await services.returns.detail(world.bookingId);
    expect(view.machines[0]).toMatchObject({
      emptied: true,
      rinsedTwice: true,
      nothingDismantled: true,
      cleanupRequired: false,
      cleanupFeeCents: null,
      cleanupReason: null,
    });
    expect(view.machines[0]!.cleanlinessCheckedAt).not.toBeNull();
    expect(view.blockers.some((b) => b.includes('Rückgabevorbereitung'))).toBe(false);
  });

  it('26. Ordnungsgemäß vorbereitet → keine Reinigungsgebühr, auch nach Finalisierung', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    expect(finalized.summary.cleanupFeeTotalCents).toBe(0);
    expect(finalized.summary.cleanupMachines).toBe(0);
    const row = await ctx.pool.query(
      'SELECT cleanup_required, cleanup_fee_snapshot_cents FROM return_machines',
    );
    expect(row.rows[0]).toEqual({ cleanup_required: false, cleanup_fee_snapshot_cents: null });
  });

  it('27. Nicht ordnungsgemäß → unveränderlicher 75-€-Candidate mit Grund aus den fehlgeschlagenen Kriterien', async () => {
    const { admin, effective } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    await services.returns.checkCleanliness(
      admin.id,
      effective,
      world.bookingId,
      detail.machines[0]!.id,
      {
        emptied: false,
        rinsedTwice: true,
        nothingDismantled: false,
      },
    );
    const view = await services.returns.detail(world.bookingId);
    expect(view.machines[0]).toMatchObject({
      cleanupRequired: true,
      cleanupFeeCents: 7500,
      cleanupReason: 'nicht entleert, Teile demontiert',
    });
    expect(view.summary.cleanupFeeTotalCents).toBe(7500);
    expect(view.summary.withoutComplaint).toBe(false);
  });

  it('28./29. Zwei betroffene Maschinen → 2 × 75 €; nur eine betroffene → einmal 75 €', async () => {
    const { admin, effective } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id, {
      machineCodes: ['MR-10-01-01', 'MR-10-01-02'],
    });
    const [first, second] = detail.machines;
    await services.returns.checkCleanliness(admin.id, effective, world.bookingId, first!.id, {
      ...ALL_OK,
      rinsedTwice: false,
    });
    await services.returns.checkCleanliness(admin.id, effective, world.bookingId, second!.id, {
      ...ALL_OK,
      emptied: false,
    });
    let view = await services.returns.detail(world.bookingId);
    expect(view.summary.cleanupMachines).toBe(2);
    expect(view.summary.cleanupFeeTotalCents).toBe(15_000);
    // Zweite Maschine doch ordnungsgemäß → nur noch einmal 75 €.
    await services.returns.checkCleanliness(
      admin.id,
      effective,
      world.bookingId,
      second!.id,
      ALL_OK,
    );
    view = await services.returns.detail(world.bookingId);
    expect(view.summary.cleanupMachines).toBe(1);
    expect(view.summary.cleanupFeeTotalCents).toBe(7500);
    expect(view.machines[1]!.cleanupFeeCents).toBeNull();
  });

  it('30. Der Gebühr-Candidate ist ein Rückgabe-Fakt – keine Settlement-/Rechnungs-/Lexware-Tabellen', async () => {
    const tables = await ctx.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const names = tables.rows.map((row) => row.table_name);
    expect(names.some((name) => /settlement|invoice|rechnung|lexware|charge/i.test(name))).toBe(
      false,
    );
    expect(names).toContain('return_machines');
    const columns = await ctx.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'return_machines'`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining(['cleanup_required', 'cleanup_fee_snapshot_cents', 'cleanup_reason']),
    );
  });

  it('31./32. Cleanup-Fall ohne Beweisfoto nicht finalisierbar; mit Foto finalisierbar, Fakt im PDF', async () => {
    const { admin, effective } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    await readyReturn(ctx, admin.id, services, world.bookingId, { skipCleanliness: true });
    await services.returns.checkCleanliness(admin.id, effective, world.bookingId, rm.id, {
      ...ALL_OK,
      emptied: false,
    });
    let view = await services.returns.detail(world.bookingId);
    expect(view.blockers).toEqual([expect.stringContaining('Beweisfoto')]);
    await expect(services.returns.finalize(admin.id, world.bookingId)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Beweisfoto') as string,
    });
    await services.returns.addCleanupPhoto(admin.id, world.bookingId, rm.id, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    view = await services.returns.detail(world.bookingId);
    expect(view.blockers).toEqual([]);
    expect(view.machines[0]!.cleanupPhotos).toHaveLength(1);
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    expect(finalized.return.status).toBe('finalized');
    const document = await services.documentService.byId(finalized.return.protocolDocumentId!);
    const text = pdfText(await services.documentService.bytesFor(document));
    expect(text).toContain('Reinigungsgebühr-Fakt: 75,00');
    expect(text).toContain('nicht entleert');
    expect(text).not.toContain('Rechnungsnummer');
  });

  it('33. Beweisfotos sind privat: nur authentifiziert mit return.view und Vorgangs-Sichtbarkeit', async () => {
    const { admin, effective, cookie } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    await services.returns.checkCleanliness(admin.id, effective, world.bookingId, rm.id, {
      ...ALL_OK,
      rinsedTwice: false,
    });
    const { photoId } = await services.returns.addCleanupPhoto(admin.id, world.bookingId, rm.id, {
      bytes: pngBytes(),
      mimeType: 'image/png',
    });
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/staff/returns/photos/${photoId}`,
    });
    expect(anonymous.statusCode).toBe(401);
    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/staff/returns/photos/${photoId}`,
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.headers['cache-control']).toContain('private');
    // Mitarbeiter ohne return.view → 403 (kein Existenz-Orakel über Storage).
    const limited = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Lena',
      lastName: 'Lager',
      email: 'lager@example.test',
      password: 'lager-passwort-123',
      permissionKeys: ['machine.view', 'process.view_all'],
    });
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/staff/returns/photos/${photoId}`,
      headers: { cookie: limited.cookie },
    });
    expect(denied.statusCode).toBe(403);
    // Storage-Schlüssel enthält keine Kundendaten (nur IDs).
    const key = await ctx.pool.query<{ storage_key: string }>(
      'SELECT storage_key FROM return_photos',
    );
    expect(key.rows[0]!.storage_key).toMatch(
      /^returns\/[0-9a-f-]{36}\/photos\/[0-9a-f-]{36}-[0-9a-f]{16}\.png$/,
    );
  });

  it('34. Kleine Restmenge kann als ordnungsgemäß dokumentiert werden – keine Bild-KI, kein Auto-Fakt durch ein Foto', async () => {
    const { admin, effective } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    // Mitarbeiter entscheidet: trotz kleiner Restmenge ordnungsgemäß.
    await services.returns.checkCleanliness(admin.id, effective, world.bookingId, rm.id, ALL_OK);
    // Ein optionales Foto ändert die Entscheidung nicht (keine optische Analyse).
    await services.returns.addCleanupPhoto(admin.id, world.bookingId, rm.id, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    const view = await services.returns.detail(world.bookingId);
    expect(view.machines[0]!.cleanupRequired).toBe(false);
    expect(view.machines[0]!.cleanupFeeCents).toBeNull();
    expect(view.summary.cleanupFeeTotalCents).toBe(0);
    // Ohne return.mark_cleanup_issue darf kein Mangel erfasst werden (Recht serverseitig).
    const limited = new Set(['return.perform']);
    await expect(
      services.returns.checkCleanliness(admin.id, limited, world.bookingId, rm.id, {
        ...ALL_OK,
        emptied: false,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
