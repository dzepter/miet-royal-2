/**
 * Phase-7-Pflichttests 82–94 (Order §75): Unterschriften (Kunde und
 * Mitarbeiter Pflicht, Mitarbeiter-ID aus der Session, Kunden-/Vertretername),
 * kombiniertes Rückgabeprotokoll (mehrere Maschinen → EIN PDF, beide
 * Unterschriften, neue Schadensfotos, Fehlteile, Reinigungs-Fakt, „Rückgabe
 * ohne Beanstandung“), Immutabilität, verifizierbarer Hash, Dokument-IDOR.
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
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { resetWarehouse } from './warehouse-helpers.ts';
import { pdfText, pngBytes, truncateHandoverTables } from './handover-helpers.ts';
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

describe('82.–85. Unterschriften', () => {
  it('82./83. Ohne Kunden- bzw. Mitarbeiterunterschrift ist die Rückgabe blockiert', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await readyReturn(ctx, admin.id, services, world.bookingId, { skipSignatures: true });
    let view = await services.returns.detail(world.bookingId);
    expect(view.blockers).toEqual([
      'Unterschrift Kunde / Vertreter fehlt.',
      'Unterschrift Mitarbeiter fehlt.',
    ]);
    await services.returns.sign(admin.id, world.bookingId, 'staff', pngBytes());
    view = await services.returns.detail(world.bookingId);
    expect(view.blockers).toEqual(['Unterschrift Kunde / Vertreter fehlt.']);
    await expect(services.returns.finalize(admin.id, world.bookingId)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Unterschrift Kunde') as string,
    });
    await services.returns.sign(admin.id, world.bookingId, 'customer', pngBytes());
    view = await services.returns.detail(world.bookingId);
    expect(view.blockers).toEqual([]);
    expect(view.nextAction).toBe('finalize');
  });

  it('84. Die Mitarbeiter-ID des Unterzeichners kommt aus der Auth-Session – der Client kann sie nicht setzen', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await readyReturn(ctx, admin.id, services, world.bookingId, { skipSignatures: true });
    const spoof = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/returns/${world.bookingId}/signatures/staff`,
      headers: { cookie },
      payload: {
        dataBase64: Buffer.from(pngBytes()).toString('base64'),
        signerUserId: '00000000-0000-0000-0000-000000000000',
      },
    });
    expect(spoof.statusCode).toBe(400);
    const ok = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/returns/${world.bookingId}/signatures/staff`,
      headers: { cookie },
      payload: { dataBase64: Buffer.from(pngBytes()).toString('base64') },
    });
    expect(ok.statusCode).toBe(200);
    const row = await ctx.pool.query<{ signer_user_id: string; signer_name: string }>(
      `SELECT signer_user_id, signer_name FROM return_signatures WHERE role = 'staff'`,
    );
    expect(row.rows[0]!.signer_user_id).toBe(admin.id);
    const user = await ctx.pool.query<{ first_name: string; last_name: string }>(
      'SELECT first_name, last_name FROM staff_users WHERE id = $1',
      [admin.id],
    );
    expect(row.rows[0]!.signer_name).toBe(`${user.rows[0]!.first_name} ${user.rows[0]!.last_name}`);
  });

  it('85. Kunden-/Vertretername der Unterschrift ist korrekt; Wechsel der Rückgabeperson entwertet die Kundenunterschrift', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await expect(
      services.returns.sign(admin.id, world.bookingId, 'customer', pngBytes()),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await readyReturn(ctx, admin.id, services, world.bookingId, {
      returner: { kind: 'other', firstName: 'Otto', lastName: 'Other', phone: '0123' },
    });
    let view = await services.returns.detail(world.bookingId);
    expect(view.signatures.customer?.signerName).toBe('Otto Other');
    await services.returns.setReturner(admin.id, world.bookingId, { kind: 'customer' });
    view = await services.returns.detail(world.bookingId);
    expect(view.signatures.customer).toBeNull();
    expect(view.signatures.staff).not.toBeNull();
    await services.returns.sign(admin.id, world.bookingId, 'customer', pngBytes());
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    const document = await services.documentService.byId(finalized.return.protocolDocumentId!);
    const text = pdfText(await services.documentService.bytesFor(document));
    expect(text).toContain(`Rückgabe durch: ${finalized.booking.customerName} (Kunde selbst)`);
  });
});

describe('86.–94. Rückgabeprotokoll-PDF', () => {
  it('86./87./91. Mehrere Maschinen → EIN kombiniertes PDF mit beiden Unterschriften und „Rückgabe ohne Beanstandung“', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id, {
      machineCodes: ['MR-10-01-01', 'MR-10-01-02'],
    });
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    expect(finalized.summary.withoutComplaint).toBe(true);
    const docs = await ctx.db.select().from(documents).where(eq(documents.type, 'return_protocol'));
    expect(docs).toHaveLength(1);
    const bytes = await services.documentService.bytesFor(docs[0]!);
    const text = pdfText(bytes);
    expect(text).toContain('Rückgabeprotokoll');
    expect(text).toContain(`Vorgang ${finalized.booking.processNumber}`);
    expect(text).toContain('Maschine MR-10-01-01');
    expect(text).toContain('Maschine MR-10-01-02');
    expect(text).toContain('Zubehör vollständig');
    expect(text).toContain('Rückgabe ohne Beanstandung.');
    expect(text).toContain('Unterschrift Kunde / Vertreter');
    expect(text).toContain('Unterschrift Mitarbeiter');
    expect(text).toContain('keine Rechnung');
    // Zwei eingebettete Signaturbilder (PNG-Bildobjekte).
    const images =
      Buffer.from(bytes)
        .toString('latin1')
        .match(/\/Subtype \/Image/g) ?? [];
    expect(images.length).toBeGreaterThanOrEqual(2);
  });

  it('88./89./90. Neue Schadensfotos, Fehlteile und der Reinigungs-Fakt erscheinen im PDF – Zusammenfassung mit Feststellungen', async () => {
    const { admin, effective } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const rm = detail.machines[0]!;
    await services.returns.setReturner(admin.id, world.bookingId, { kind: 'customer' });
    await services.returns.addMissingCase(admin.id, world.bookingId, rm.id, {
      accessoryType: 'lid',
      missingQuantity: 1,
    });
    await services.returns.checkCleanliness(admin.id, effective, world.bookingId, rm.id, {
      emptied: true,
      rinsedTwice: false,
      nothingDismantled: true,
    });
    await services.returns.addCleanupPhoto(admin.id, world.bookingId, rm.id, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    const { damageId } = await services.returns.addDamage(admin.id, world.bookingId, rm.id, {
      severity: 'medium',
      description: 'Kratzer am Deckel',
      markers: [POINT_MARKER],
    });
    await services.damages.addPhoto(admin.id, damageId, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    await services.returns.sign(admin.id, world.bookingId, 'customer', pngBytes());
    await services.returns.sign(admin.id, world.bookingId, 'staff', pngBytes());
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    expect(finalized.summary.withoutComplaint).toBe(false);
    const document = await services.documentService.byId(finalized.return.protocolDocumentId!);
    const bytes = await services.documentService.bytesFor(document);
    const text = pdfText(bytes);
    expect(text).toContain('Neue Schäden: 1');
    expect(text).toContain('Schweregrad: mittel');
    expect(text).toContain('Kratzer am Deckel');
    expect(text).toContain('Fehlteile: 1 × Deckel');
    expect(text).toContain('Reinigungsgebühr-Fakt: 75,00');
    expect(text).toContain('nicht zweimal gespült');
    expect(text).not.toContain('Rückgabe ohne Beanstandung.');
    // Fotos (JPEG) sind im Rückgabeprotokoll eingebettet (Order §32/§18).
    const raw = Buffer.from(bytes).toString('latin1');
    expect((raw.match(/\/DCTDecode/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('92./93. Das finale PDF ist immutable und sein Hash verifizierbar; Manipulation im Storage fällt auf', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    const document = await services.documentService.byId(finalized.return.protocolDocumentId!);
    expect(document.finalizedAt).not.toBeNull();
    const bytes = await services.documentService.bytesFor(document);
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(document.sha256);
    // Erneute Finalisierung / Zeitkorrektur erzeugen kein neues Dokument.
    await services.returns.finalize(admin.id, world.bookingId);
    await services.returns.correctActualReturnAt(
      admin.id,
      world.bookingId,
      new Date(Date.now() - 3_600_000),
    );
    const again = await services.documentService.byId(document.id);
    expect(again.sha256).toBe(document.sha256);
    const count = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM documents WHERE type = 'return_protocol'`,
    );
    expect(count.rows[0].n).toBe(1);
    const download = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${document.id}`,
      headers: { cookie },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    await ctx.storage.put(document.storageKey, new Uint8Array([1, 2, 3]), {
      contentType: 'application/pdf',
    });
    const tampered = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${document.id}`,
      headers: { cookie },
    });
    expect(tampered.statusCode).toBe(409);
  });

  it('94. Dokument-IDOR: ohne return.view/offer.view/handover.view und ohne Vorgangs-Sichtbarkeit kein Zugriff', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    const documentId = finalized.return.protocolDocumentId!;
    const noRight = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Nora',
      lastName: 'Nichts',
      email: 'nora@example.test',
      password: 'nora-passwort-123',
      permissionKeys: ['machine.view'],
    });
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${documentId}`,
      headers: { cookie: noRight.cookie },
    });
    expect(denied.statusCode).toBe(403);
    const noVisibility = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Rita',
      lastName: 'Rückgabe',
      email: 'rita@example.test',
      password: 'rita-passwort-123',
      permissionKeys: ['return.view'],
    });
    const invisible = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${documentId}`,
      headers: { cookie: noVisibility.cookie },
    });
    expect(invisible.statusCode).toBe(403);
    const withVisibility = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Vera',
      lastName: 'View',
      email: 'vera@example.test',
      password: 'vera-passwort-123',
      permissionKeys: ['return.view', 'process.view_all'],
    });
    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${documentId}`,
      headers: { cookie: withVisibility.cookie },
    });
    expect(ok.statusCode).toBe(200);
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${documentId}`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
