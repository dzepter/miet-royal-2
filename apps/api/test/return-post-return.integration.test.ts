/**
 * Phase-7-Pflichttests 75–81 (Order §74): nachträgliche Feststellung
 * (Maschine noch in Reinigung → weiterer Return-Schaden mit Foto/Beschreibung/
 * Marker; unterschriebenes PDF unverändert; nach Einsatzbereit abgelehnt) und
 * technische Defekte (intern zum letzten Return; keine finanzielle Klärung;
 * nach nächster Ausgabe nicht mehr rückwirkend zuordenbar).
 */
import { documents } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
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
import { truncateCrmTables } from './crm-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { machineByCode, resetWarehouse } from './warehouse-helpers.ts';
import {
  DAYS,
  pngBytes,
  readyHandover,
  scheduledBooking,
  truncateHandoverTables,
} from './handover-helpers.ts';
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
  return { admin, cookie: session.cookie };
}

async function finalizedReturn(adminId: string) {
  const { world, services } = await startedReturn(ctx, adminId);
  await readyReturn(ctx, adminId, services, world.bookingId);
  const finalized = await services.returns.finalize(adminId, world.bookingId);
  const machine = await machineByCode(ctx.db, 'MR-10-01-01');
  return { world, services, finalized, machine };
}

const FINDING = {
  severity: 'light' as const,
  description: 'Nachträglich entdeckter Kratzer',
  markers: [POINT_MARKER],
  photo: { bytes: jpegBytes(), mimeType: 'image/jpeg' as const },
};

describe('75.–78. Nachträgliche Feststellung', () => {
  it('75. Maschine noch in Reinigung → weiterer Kundenschaden zum letzten Return erlaubt (post_return_finding, sofort aktuell)', async () => {
    const { admin, cookie } = await adminSession();
    const { services, finalized, machine } = await finalizedReturn(admin.id);
    expect(machine.status).toBe('cleaning');
    const created = await services.damages.createPostReturnFinding(admin.id, machine.id, FINDING);
    expect(created.returnId).toBe(finalized.return.id);
    const current = await services.damages.currentForMachine(machine.id);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      origin: 'post_return_finding',
      description: 'Nachträglich entdeckter Kratzer',
      requiresFinancialReview: true,
      current: true,
    });
    expect(current[0]!.photos).toHaveLength(1);
    const forReturn = await services.damages.forReturn(finalized.return.id);
    expect(forReturn.map((d) => d.origin)).toEqual(['post_return_finding']);
    // Auch über die Route (Maschine → Nachtrag).
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/damages`,
      headers: { cookie },
      payload: {
        severity: 'medium',
        description: 'Zweiter Nachtrag',
        markers: [POINT_MARKER],
        photo: { mimeType: 'image/png', dataBase64: Buffer.from(pngBytes()).toString('base64') },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(await services.damages.currentForMachine(machine.id)).toHaveLength(2);
  });

  it('76. Der Nachtrag verlangt weiterhin Beschreibung, Schweregrad, Markierung UND Foto', async () => {
    const { admin, cookie } = await adminSession();
    const { services, machine } = await finalizedReturn(admin.id);
    await expect(
      services.damages.createPostReturnFinding(admin.id, machine.id, {
        ...FINDING,
        description: ' ',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      services.damages.createPostReturnFinding(admin.id, machine.id, { ...FINDING, markers: [] }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      services.damages.createPostReturnFinding(admin.id, machine.id, {
        ...FINDING,
        photo: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const withoutPhoto = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/damages`,
      headers: { cookie },
      payload: { severity: 'light', description: 'ohne Foto', markers: [POINT_MARKER] },
    });
    expect(withoutPhoto.statusCode).toBe(400);
    const rows = await ctx.pool.query('SELECT count(*)::int AS n FROM machine_damages');
    expect(rows.rows[0].n).toBe(0);
    const orphaned = await ctx.pool.query('SELECT count(*)::int AS n FROM damage_photos');
    expect(orphaned.rows[0].n).toBe(0);
  });

  it('77. Das unterschriebene Rückgabeprotokoll wird durch den Nachtrag NICHT überschrieben', async () => {
    const { admin } = await adminSession();
    const { services, finalized, machine } = await finalizedReturn(admin.id);
    const before = await services.documentService.byId(finalized.return.protocolDocumentId!);
    await services.damages.createPostReturnFinding(admin.id, machine.id, FINDING);
    const after = (await ctx.db.select().from(documents).where(eq(documents.id, before.id)))[0]!;
    expect(after.sha256).toBe(before.sha256);
    expect(after.storageKey).toBe(before.storageKey);
    const count = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM documents WHERE type = 'return_protocol'`,
    );
    expect(count.rows[0].n).toBe(1);
    const detail = await services.returns.detail(finalized.booking.id);
    expect(detail.return.protocolDocumentId).toBe(before.id);
  });

  it('78. Nach „Gereinigt & einsatzbereit“ wird ein neuer Kundenschaden zum alten Return abgelehnt; bestehende Einträge bleiben', async () => {
    const { admin, cookie } = await adminSession();
    const { services, machine } = await finalizedReturn(admin.id);
    await services.damages.createPostReturnFinding(admin.id, machine.id, FINDING);
    await services.returns.completeCleaning(admin.id, machine.id);
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('ready');
    await expect(
      services.damages.createPostReturnFinding(admin.id, machine.id, FINDING),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/damages`,
      headers: { cookie },
      payload: {
        ...FINDING,
        photo: { mimeType: 'image/jpeg', dataBase64: Buffer.from(jpegBytes()).toString('base64') },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(await services.damages.currentForMachine(machine.id)).toHaveLength(1);
    const condition = await services.returns.machineCondition(machine.id);
    expect(condition.postReturnFindingOpen).toBe(false);
  });

  it('78b. Ein später manuell gesetzter Status „Reinigung“ öffnet das Nachtragsfenster nicht erneut (Order §§37/38)', async () => {
    const { admin, cookie } = await adminSession();
    const { services, machine } = await finalizedReturn(admin.id);
    const first = await services.damages.createPostReturnFinding(admin.id, machine.id, FINDING);
    await services.returns.completeCleaning(admin.id, machine.id);
    await services.machineService.setStatus(machine.id, 'cleaning');
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('cleaning');
    await expect(
      services.damages.createPostReturnFinding(admin.id, machine.id, FINDING),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/damages`,
      headers: { cookie },
      payload: {
        ...FINDING,
        photo: { mimeType: 'image/jpeg', dataBase64: Buffer.from(jpegBytes()).toString('base64') },
      },
    });
    expect(response.statusCode).toBe(409);
    // Auch ein weiteres Foto zum bereits erfassten Nachtrag ist nach Reinigungsabschluss gesperrt.
    await expect(
      services.damages.addPhoto(admin.id, first.damageId, {
        bytes: jpegBytes(),
        mimeType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await services.damages.currentForMachine(machine.id)).toHaveLength(1);
    expect((await services.returns.machineCondition(machine.id)).postReturnFindingOpen).toBe(false);
  });
});

describe('79.–81. Technische Defekte nach Rückgabe', () => {
  it('79./80. Technischer Defekt wird intern mit dem letzten Return verknüpft – ohne Kundenbelastung, ohne finanzielle Klärung, mit Reparaturhinweis', async () => {
    const { admin, cookie } = await adminSession();
    const { services, finalized, machine } = await finalizedReturn(admin.id);
    const result = await services.damages.addTechnicalDefect(admin.id, machine.id, {
      description: 'Kompressor läuft nicht an',
      photo: { bytes: pngBytes(), mimeType: 'image/png' },
    });
    expect(result.hint).toContain('Reparatur');
    const defects = await services.damages.technicalDefectsFor(machine.id);
    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatchObject({
      returnId: finalized.return.id,
      processId: finalized.booking.processId,
      description: 'Kompressor läuft nicht an',
      requiresFinancialReview: false,
      hasPhoto: true,
    });
    // Kein Kundenschaden, kein Betrag.
    expect(await services.damages.currentForMachine(machine.id)).toEqual([]);
    const columns = await ctx.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'technical_defects'`,
    );
    expect(columns.rows.some((row) => /cost|amount|cents|price/i.test(row.column_name))).toBe(
      false,
    );
    // Auch nach Reinigungsabschluss (noch nicht erneut ausgegeben) verknüpfbar; via Route.
    await services.returns.completeCleaning(admin.id, machine.id);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/technical-defects`,
      headers: { cookie },
      payload: { description: 'Display flackert' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().hint).toContain('Reparatur');
    expect(await services.damages.technicalDefectsFor(machine.id)).toHaveLength(2);
    const photo = await ctx.app.inject({
      method: 'GET',
      url: `/staff/technical-defects/${defects[0]!.id}/photo`,
      headers: { cookie },
    });
    expect(photo.statusCode).toBe(200);
  });

  it('81. Nach der nächsten Ausgabe derselben Maschine ist kein neuer Defekt mehr rückwirkend zuordenbar; historische Defekte bleiben', async () => {
    const { admin } = await adminSession();
    const { services, machine } = await finalizedReturn(admin.id);
    await services.damages.addTechnicalDefect(admin.id, machine.id, {
      description: 'Alter Defekt',
    });
    await services.returns.completeCleaning(admin.id, machine.id);
    expect(await services.damages.defectLinkOpen(machine.id)).toBe(true);
    const next = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 10 * DAYS),
      to: new Date(Date.now() + 12 * DAYS),
    });
    await readyHandover(ctx, admin.id, next.bookingId, ['MR-10-01-01']);
    await services.handover.finalize(admin.id, next.bookingId);
    expect(await services.damages.defectLinkOpen(machine.id)).toBe(false);
    await expect(
      services.damages.addTechnicalDefect(admin.id, machine.id, { description: 'Neuer Defekt' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const defects = await services.damages.technicalDefectsFor(machine.id);
    expect(defects.map((d) => d.description)).toEqual(['Alter Defekt']);
  });
});
