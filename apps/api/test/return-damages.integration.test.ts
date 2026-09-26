/**
 * Phase-7-Pflichttests 51–74 (Order §§72/73): Schadensdokumentation
 * (Schweregrade, Pflichtbeschreibung, Foto- und Markierungspflicht, mehrere
 * Markierungen/Schäden, normalisierte Koordinaten, ungültige Koordinaten,
 * private Fotos, kein Geldbetrag, finanzielle Klärung, aktuelle Schäden,
 * „nicht mehr aktuell“, historische Daten, unveränderter PDF-Hash) und die
 * Existing-Damage-Integration in die nächste Übergabe (Snapshot, Diagramm +
 * Text, keine Fotos im Kunden-PDF, spätere Auflösung ohne PDF-Änderung).
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
  pdfText,
  pngBytes,
  readyHandover,
  scheduledBooking,
  truncateHandoverTables,
} from './handover-helpers.ts';
import {
  AREA_MARKER,
  jpegBytes,
  POINT_MARKER,
  readyReturn,
  startedReturn,
} from './return-helpers.ts';

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

describe('51.–68. Schadensdokumentation', () => {
  it('51./52./53. Schweregrade leicht, mittel und schwer werden exakt so gespeichert und benannt', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    for (const severity of ['light', 'medium', 'severe'] as const) {
      await services.returns.addDamage(admin.id, world.bookingId, rm.id, {
        severity,
        description: `Schaden ${severity}`,
        markers: [POINT_MARKER],
      });
    }
    const view = await services.returns.detail(world.bookingId);
    expect(view.machines[0]!.damages.map((d) => [d.severity, d.severityLabel])).toEqual([
      ['light', 'leicht'],
      ['medium', 'mittel'],
      ['severe', 'schwer'],
    ]);
    await expect(
      services.returns.addDamage(admin.id, world.bookingId, rm.id, {
        severity: 'total' as never,
        description: 'x',
        markers: [POINT_MARKER],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('54. Beschreibung ist Pflicht (auch nicht nur Leerzeichen)', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    await expect(
      services.returns.addDamage(admin.id, world.bookingId, rm.id, {
        severity: 'light',
        description: '   ',
        markers: [POINT_MARKER],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/returns/${world.bookingId}/machines/${rm.id}/damages`,
      headers: { cookie },
      payload: { severity: 'light', description: '', markers: [POINT_MARKER] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('55. Mindestens ein Foto ist Pflicht – ohne Foto keine Finalisierung, mit Foto möglich', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const { damageId } = await services.returns.addDamage(admin.id, world.bookingId, rm.id, {
      severity: 'medium',
      description: 'Kratzer am Gehäuse',
      markers: [POINT_MARKER],
    });
    let view = await services.returns.detail(world.bookingId);
    expect(view.blockers).toEqual([expect.stringContaining('mindestens ein Foto fehlt')]);
    await expect(services.returns.finalize(admin.id, world.bookingId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await services.damages.addPhoto(admin.id, damageId, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    view = await services.returns.detail(world.bookingId);
    expect(view.blockers).toEqual([]);
    expect(view.machines[0]!.damages[0]!.photos).toHaveLength(1);
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    expect(finalized.return.status).toBe('finalized');
  });

  it('56./57. Mindestens eine Markierung ist Pflicht; mehrere Markierungen (Punkt + Fläche, mehrere Ansichten) sind möglich', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    await expect(
      services.returns.addDamage(admin.id, world.bookingId, rm.id, {
        severity: 'light',
        description: 'ohne Marker',
        markers: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await services.returns.addDamage(admin.id, world.bookingId, rm.id, {
      severity: 'light',
      description: 'drei Marker',
      markers: [POINT_MARKER, AREA_MARKER, { view: 'back', markerType: 'point', x: 0.9, y: 0.1 }],
    });
    const view = await services.returns.detail(world.bookingId);
    const damage = view.machines[0]!.damages[0]!;
    expect(damage.markers).toHaveLength(3);
    expect(damage.markers.map((m) => m.viewLabel)).toEqual(['Vorne', 'Links', 'Hinten']);
    expect(damage.markers[1]).toMatchObject({ markerType: 'area', width: 0.3, height: 0.2 });
  });

  it('58. Mehrere Schäden derselben Maschine sind möglich (und jeweils löschbar im Entwurf)', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    const a = await services.returns.addDamage(admin.id, world.bookingId, rm.id, {
      severity: 'light',
      description: 'Schaden A',
      markers: [POINT_MARKER],
    });
    await services.returns.addDamage(admin.id, world.bookingId, rm.id, {
      severity: 'severe',
      description: 'Schaden B',
      markers: [AREA_MARKER],
    });
    let view = await services.returns.detail(world.bookingId);
    expect(view.machines[0]!.damages.map((d) => d.description)).toEqual(['Schaden A', 'Schaden B']);
    await services.returns.deleteDamage(admin.id, world.bookingId, a.damageId);
    view = await services.returns.detail(world.bookingId);
    expect(view.machines[0]!.damages.map((d) => d.description)).toEqual(['Schaden B']);
  });

  it('59. Markierungen werden normalisiert (0..1) und grafikunabhängig gespeichert', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    await services.returns.addDamage(admin.id, world.bookingId, rm.id, {
      severity: 'light',
      description: 'normalisiert',
      markers: [{ view: 'right', markerType: 'area', x: 0.25, y: 0.5, width: 0.5, height: 0.25 }],
    });
    const rows = await ctx.pool.query<{
      view: string;
      marker_type: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>('SELECT view, marker_type, x, y, width, height FROM damage_markers');
    expect(rows.rows[0]).toEqual({
      view: 'right',
      marker_type: 'area',
      x: 0.25,
      y: 0.5,
      width: 0.5,
      height: 0.25,
    });
    const columns = await ctx.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'damage_markers'`,
    );
    // Keine Pixel-/Bildbezüge: die Koordinaten hängen an keiner konkreten Grafik.
    expect(columns.rows.some((row) => /pixel|image|asset|svg/i.test(row.column_name))).toBe(false);
  });

  it('60. Ungültige Koordinaten werden abgelehnt (Service und Route)', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    const attempt = (markers: unknown[]) =>
      services.returns.addDamage(admin.id, world.bookingId, rm.id, {
        severity: 'light',
        description: 'ungültig',
        markers: markers as never,
      });
    await expect(
      attempt([{ view: 'front', markerType: 'point', x: 1.2, y: 0.5 }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      attempt([{ view: 'front', markerType: 'point', x: -0.1, y: 0.5 }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      attempt([{ view: 'front', markerType: 'area', x: 0.8, y: 0.5, width: 0.5, height: 0.1 }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      attempt([{ view: 'front', markerType: 'area', x: 0.1, y: 0.1 }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      attempt([{ view: 'top', markerType: 'point', x: 0.1, y: 0.1 }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/returns/${world.bookingId}/machines/${rm.id}/damages`,
      headers: { cookie },
      payload: {
        severity: 'light',
        description: 'x',
        markers: [{ view: 'front', markerType: 'point', x: 5, y: 0.5 }],
      },
    });
    expect(response.statusCode).toBe(400);
    const rows = await ctx.pool.query('SELECT count(*)::int AS n FROM machine_damages');
    expect(rows.rows[0].n).toBe(0);
  });

  it('61. Schadensfotos sind privat, integritätsgesichert und ohne Kundendaten im Schlüssel', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    const { damageId } = await services.returns.addDamage(admin.id, world.bookingId, rm.id, {
      severity: 'light',
      description: 'Foto-Test',
      markers: [POINT_MARKER],
    });
    const { photoId } = await services.damages.addPhoto(admin.id, damageId, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/staff/damages/photos/${photoId}`,
    });
    expect(anonymous.statusCode).toBe(401);
    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/staff/damages/photos/${photoId}`,
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['cache-control']).toContain('private');
    const key = await ctx.pool.query<{ storage_key: string; sha256: string }>(
      'SELECT storage_key, sha256 FROM damage_photos',
    );
    expect(key.rows[0]!.storage_key).toMatch(/^damages\/[0-9a-f-]{36}\/[0-9a-f]{16}\.jpg$/);
    expect(key.rows[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Manipulierter Storage-Inhalt fällt bei Integritätsprüfung auf.
    await ctx.storage.put(key.rows[0]!.storage_key, pngBytes(), { contentType: 'image/png' });
    const tampered = await ctx.app.inject({
      method: 'GET',
      url: `/staff/damages/photos/${photoId}`,
      headers: { cookie },
    });
    expect(tampered.statusCode).toBe(409);
    // Falscher Bildtyp wird abgelehnt.
    await expect(
      services.damages.addPhoto(admin.id, damageId, { bytes: pngBytes(), mimeType: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('62./63. Kein Geldbetrag am Schaden; „finanzielle Klärung erforderlich“ ist gesetzt; Kostenfelder werden abgewiesen', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    const columns = await ctx.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'machine_damages'`,
    );
    expect(
      columns.rows.some((row) => /cost|amount|cents|price|betrag/i.test(row.column_name)),
    ).toBe(false);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/returns/${world.bookingId}/machines/${rm.id}/damages`,
      headers: { cookie },
      payload: {
        severity: 'light',
        description: 'mit Kosten',
        markers: [POINT_MARKER],
        amountCents: 12_000,
      },
    });
    expect(response.statusCode).toBe(400);
    await services.returns.addDamage(admin.id, world.bookingId, rm.id, {
      severity: 'light',
      description: 'ohne Kosten',
      markers: [POINT_MARKER],
    });
    const view = await services.returns.detail(world.bookingId);
    expect(view.machines[0]!.damages[0]!.requiresFinancialReview).toBe(true);
    expect(
      view.summary.lines.some((line) => line.includes('finanzielle Klärung erforderlich')),
    ).toBe(true);
  });

  it('64./65. Neuer Return-Schaden wird erst mit der Finalisierung zum aktuellen Maschinenschaden – und ist dann in der Maschinenansicht sichtbar', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const { damageId } = await services.returns.addDamage(admin.id, world.bookingId, rm.id, {
      severity: 'medium',
      description: 'Delle an der Seite',
      markers: [AREA_MARKER],
    });
    await services.damages.addPhoto(admin.id, damageId, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    expect(await services.damages.currentForMachine(machine.id)).toEqual([]);
    await services.returns.finalize(admin.id, world.bookingId);
    const current = await services.damages.currentForMachine(machine.id);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({
      id: damageId,
      description: 'Delle an der Seite',
      severityLabel: 'mittel',
      current: true,
      origin: 'return',
    });
    expect(current[0]!.activatedAt).not.toBeNull();
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/${machine.id}/condition`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().currentDamages).toHaveLength(1);
    expect(response.json().currentDamages[0].markers).toHaveLength(1);
    expect(response.json().currentDamages[0].photos).toHaveLength(1);
  });

  it('66./67./68. „Nicht mehr aktuell“ entfernt den Schaden aus der aktuellen Ansicht; historische Rückgabedaten und der PDF-Hash bleiben unverändert', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const { damageId } = await services.returns.addDamage(admin.id, world.bookingId, rm.id, {
      severity: 'severe',
      description: 'Riss im Deckel',
      markers: [POINT_MARKER],
    });
    await services.damages.addPhoto(admin.id, damageId, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    const documentBefore = await services.documentService.byId(
      finalized.return.protocolDocumentId!,
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/damages/${damageId}/resolve`,
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(await services.damages.currentForMachine(machine.id)).toEqual([]);
    await expect(services.damages.resolveCurrent(admin.id, damageId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // Historisch bleibt alles: Schaden, Markierung, Foto, Rückgabe-Detail.
    const rows = await ctx.pool.query(
      'SELECT resolved_at, resolved_by FROM machine_damages WHERE id = $1',
      [damageId],
    );
    expect(rows.rows[0].resolved_at).not.toBeNull();
    expect(rows.rows[0].resolved_by).toBe(admin.id);
    const historical = await services.returns.detail(world.bookingId);
    expect(historical.machines[0]!.damages.map((d) => d.description)).toEqual(['Riss im Deckel']);
    expect(historical.machines[0]!.damages[0]!.current).toBe(false);
    const documentAfter = (
      await ctx.db.select().from(documents).where(eq(documents.id, documentBefore.id))
    )[0]!;
    expect(documentAfter.sha256).toBe(documentBefore.sha256);
    const bytes = await services.documentService.bytesFor(documentAfter);
    expect(pdfText(bytes)).toContain('Riss im Deckel');
  });
});

describe('69.–74. Bestehende Schäden bei der nächsten Übergabe (ExistingDamageProvider)', () => {
  async function returnedWithDamage(adminId: string) {
    const { world, services, detail } = await startedReturn(ctx, adminId);
    const rm = detail.machines[0]!;
    await readyReturn(ctx, adminId, services, world.bookingId);
    const { damageId } = await services.returns.addDamage(adminId, world.bookingId, rm.id, {
      severity: 'medium',
      description: 'Kratzer vorne links',
      markers: [{ view: 'front', markerType: 'point', x: 0.2, y: 0.3 }],
    });
    await services.damages.addPhoto(adminId, damageId, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    await services.returns.finalize(adminId, world.bookingId);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    await services.returns.completeCleaning(adminId, machine.id);
    return { services, machine, damageId };
  }

  async function nextHandover(adminId: string) {
    const next = await scheduledBooking(ctx, adminId, {
      from: new Date(Date.now() + 10 * DAYS),
      to: new Date(Date.now() + 12 * DAYS),
    });
    await readyHandover(ctx, adminId, next.bookingId, ['MR-10-01-01']);
    return next;
  }

  it('69./70./71./72. Zukünftige Übergabe liest aktuelle Schäden, friert den Snapshot ein und zeigt Diagramm + Text – ohne alte Fotos', async () => {
    const { admin } = await adminSession();
    const { services, machine, damageId } = await returnedWithDamage(admin.id);
    expect(await services.damages.existingDamagesFor(machine.id)).toHaveLength(1);
    const next = await nextHandover(admin.id);
    const handover = await services.handover.finalize(admin.id, next.bookingId);
    const snapshot = await ctx.pool.query<{ existing_damages_snapshot: unknown }>(
      `SELECT existing_damages_snapshot FROM handover_machine_checks c
       JOIN machine_assignments a ON a.id = c.assignment_id WHERE a.booking_id = $1`,
      [next.bookingId],
    );
    expect(snapshot.rows[0]!.existing_damages_snapshot).toEqual([
      expect.objectContaining({
        id: damageId,
        severity: 'medium',
        severityLabel: 'mittel',
        description: 'Kratzer vorne links',
        markers: [
          { view: 'front', markerType: 'point', x: 0.2, y: 0.3, width: null, height: null },
        ],
      }),
    ]);
    const document = await services.documentService.byId(handover.handover.protocolDocumentId!);
    const bytes = await services.documentService.bytesFor(document);
    const text = pdfText(bytes);
    expect(text).toContain('Bestehende Schäden');
    expect(text).toContain('mittel: Kratzer vorne links');
    expect(text).toContain('Schweregrad: mittel');
    expect(text).toContain('Vorne'); // Ansichtsbeschriftung des Schemas
    // Kein Schadensfoto im Kunden-Übergabeprotokoll – codec-unabhängig gezählt:
    // genau die 2 Unterschriften als Bilder, sonst nichts (Gesamtfotos bleiben intern).
    const pdfSource = Buffer.from(bytes).toString('latin1');
    const imageObjects =
      (pdfSource.match(/\/Subtype\s*\/Image/g) ?? []).length -
      (pdfSource.match(/\/SMask\s+\d+\s+0\s+R/g) ?? []).length; // Alpha-Masken herausrechnen
    expect(imageObjects).toBe(2);
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('/DCTDecode');
  });

  it('73. Späteres Auflösen des Schadens ändert das finale alte Übergabeprotokoll und den Snapshot nicht', async () => {
    const { admin } = await adminSession();
    const { services, damageId } = await returnedWithDamage(admin.id);
    const next = await nextHandover(admin.id);
    const handover = await services.handover.finalize(admin.id, next.bookingId);
    const before = await services.documentService.byId(handover.handover.protocolDocumentId!);
    await services.damages.resolveCurrent(admin.id, damageId);
    const after = await services.documentService.byId(before.id);
    expect(after.sha256).toBe(before.sha256);
    expect(after.storageKey).toBe(before.storageKey);
    const snapshot = await ctx.pool.query<{ existing_damages_snapshot: { id: string }[] }>(
      `SELECT existing_damages_snapshot FROM handover_machine_checks c
       JOIN machine_assignments a ON a.id = c.assignment_id WHERE a.booking_id = $1`,
      [next.bookingId],
    );
    expect(snapshot.rows[0]!.existing_damages_snapshot.map((d) => d.id)).toEqual([damageId]);
    expect(pdfText(await services.documentService.bytesFor(after))).toContain(
      'Kratzer vorne links',
    );
  });

  it('74. Ohne aktuelle Schäden steht „Keine bestehenden Schäden dokumentiert.“ im Übergabeprotokoll', async () => {
    const { admin } = await adminSession();
    const { services, damageId } = await returnedWithDamage(admin.id);
    await services.damages.resolveCurrent(admin.id, damageId);
    const next = await nextHandover(admin.id);
    const handover = await services.handover.finalize(admin.id, next.bookingId);
    const document = await services.documentService.byId(handover.handover.protocolDocumentId!);
    expect(pdfText(await services.documentService.bytesFor(document))).toContain(
      'Keine bestehenden Schäden dokumentiert.',
    );
    const snapshot = await ctx.pool.query<{ existing_damages_snapshot: unknown }>(
      `SELECT existing_damages_snapshot FROM handover_machine_checks c
       JOIN machine_assignments a ON a.id = c.assignment_id WHERE a.booking_id = $1`,
      [next.bookingId],
    );
    expect(snapshot.rows[0]!.existing_damages_snapshot).toEqual([]);
  });
});
