/**
 * Phase-6-Pflichttests 56–70 (Order §64): Übergabe nur mit Zuordnung,
 * aktiver Prüfung, Gesamtfoto je Maschine, beiden Unterschriften;
 * Mitarbeiter-Unterzeichner aus der Session; Vertreter ohne Ausweisdaten;
 * EIN kombiniertes Protokoll; neutraler Schadenstext; private Fotos;
 * finale Immutabilität; Double-Submit.
 */
import { handoverSignatures, handovers } from '@mietroyal/database';
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
import { machineByCode, resetWarehouse } from './warehouse-helpers.ts';
import {
  PNG_1X1,
  handoverServicesFor,
  initializeAllInventory,
  pdfText,
  pngBytes,
  scheduledBooking,
  truncateHandoverTables,
} from './handover-helpers.ts';

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

/** Übergabe bis auf einen gezielt weggelassenen Schritt vorbereiten. */
async function almostReady(
  adminId: string,
  effective: ReadonlySet<string>,
  skip: 'assign' | 'check' | 'photo' | 'customer' | 'staff' | 'none',
  machineCodes = ['MR-10-01-01'],
) {
  const services = handoverServicesFor(ctx);
  await initializeAllInventory(ctx, adminId);
  const world = await scheduledBooking(ctx, adminId, { machineQuantity: machineCodes.length });
  await services.handover.ensureForBooking(world.bookingId, adminId);
  const slots = await services.assignments.slotsForBooking(world.bookingId);
  if (skip !== 'assign') {
    for (const [index, slot] of slots.entries()) {
      const machine = await machineByCode(ctx.db, machineCodes[index]!);
      await services.assignments.assign(adminId, effective, slot.id, machine.id, null);
      await services.assignments.prepare(adminId, slot.id);
    }
    await services.handover.setRecipient(world.bookingId, { kind: 'customer' });
    for (const [index, slot] of slots.entries()) {
      if (skip !== 'check') await services.handover.checkMachine(adminId, world.bookingId, slot.id);
      if (skip !== 'photo' || index > 0) {
        await services.handover.addPhoto(adminId, world.bookingId, slot.id, {
          bytes: pngBytes(),
          mimeType: 'image/png',
        });
      }
    }
    if (skip !== 'customer')
      await services.handover.sign(adminId, world.bookingId, 'customer', pngBytes());
    if (skip !== 'staff')
      await services.handover.sign(adminId, world.bookingId, 'staff', pngBytes());
  }
  return { services, world, slots };
}

describe('56.–61. Pflichtschritte der Übergabe', () => {
  const cases: {
    no: string;
    skip: 'assign' | 'check' | 'photo' | 'customer' | 'staff';
    text: string;
  }[] = [
    { no: '56', skip: 'assign', text: 'noch keine konkrete Maschine' },
    { no: '57', skip: 'check', text: 'Übergabeprüfung' },
    { no: '58', skip: 'photo', text: 'Gesamtfoto' },
    { no: '60', skip: 'customer', text: 'Unterschrift Kunde' },
    { no: '61', skip: 'staff', text: 'Unterschrift Mitarbeiter' },
  ];
  for (const testCase of cases) {
    it(`${testCase.no}. Ohne „${testCase.skip}“ ist die Übergabe nicht finalisierbar`, async () => {
      const { admin, effective } = await adminSession();
      const { services, world } = await almostReady(admin.id, effective, testCase.skip);
      const detail = await services.handover.detail(world.bookingId);
      expect(detail.blockers.join(' ')).toContain(testCase.text);
      await expect(services.handover.finalize(admin.id, world.bookingId)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      expect((await services.handover.detail(world.bookingId)).handover.status).toBe('draft');
    });
  }

  it('59. Bei zwei Maschinen braucht JEDE ein eigenes Gesamtfoto', async () => {
    const { admin, effective } = await adminSession();
    const { services, world } = await almostReady(admin.id, effective, 'photo', [
      'MR-10-01-01',
      'MR-10-01-02',
    ]);
    // Nur die zweite Maschine hat ein Foto (almostReady lässt Foto 1 aus).
    const detail = await services.handover.detail(world.bookingId);
    expect(detail.blockers.join(' ')).toContain('MR-10-01-01: Gesamtfoto fehlt');
    expect(detail.blockers.join(' ')).not.toContain('MR-10-01-02: Gesamtfoto fehlt');
    await expect(services.handover.finalize(admin.id, world.bookingId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('62.–64. Unterzeichner und Vertreter', () => {
  it('62. Der Mitarbeiter-Unterzeichner kommt aus der Session – nicht vom Client', async () => {
    const { admin, effective } = await adminSession();
    const { services, world } = await almostReady(admin.id, effective, 'staff');
    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Sina',
      lastName: 'Signiert',
      email: 'sina.signiert@test.example',
      password: 'sina-passwort-1234',
      permissionKeys: ['process.view_all', 'handover.view', 'handover.perform'],
    });
    // Client-Behauptung „signerName“ wird strikt abgelehnt …
    const spoof = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/handover/${world.bookingId}/signatures/staff`,
      headers: { cookie: staff.cookie },
      payload: {
        dataBase64: PNG_1X1.toString('base64'),
        signerName: 'Admin Root',
        signerUserId: admin.id,
      },
    });
    expect(spoof.statusCode).toBe(400);
    // … die echte Signatur trägt die Session-Identität.
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/handover/${world.bookingId}/signatures/staff`,
      headers: { cookie: staff.cookie },
      payload: { dataBase64: PNG_1X1.toString('base64') },
    });
    expect(response.statusCode).toBe(200);
    const handover = (
      await ctx.db.select().from(handovers).where(eq(handovers.bookingId, world.bookingId))
    )[0]!;
    const rows = await ctx.db
      .select()
      .from(handoverSignatures)
      .where(eq(handoverSignatures.handoverId, handover.id));
    const staffSig = rows.find((row) => row.role === 'staff')!;
    expect(staffSig.signerUserId).toBe(staff.user.id);
    expect(staffSig.signerName).toBe('Sina Signiert');
    void services;
  });

  it('63./64. Der Vertretername wird gespeichert und erscheint im Protokoll – ohne Ausweisdaten', async () => {
    const { admin, effective } = await adminSession();
    const { services, world } = await almostReady(admin.id, effective, 'customer');
    await services.handover.setRepresentative(admin.id, world.bookingId, {
      firstName: 'Paula',
      lastName: 'Proxy',
      phone: '+49 6131 123456',
    });
    await services.handover.setRecipient(world.bookingId, { kind: 'representative' });
    await services.handover.sign(admin.id, world.bookingId, 'customer', pngBytes());
    const detail = await services.handover.finalize(admin.id, world.bookingId);
    expect(detail.handover.recipientName).toBe('Paula Proxy');
    // Ephemeres Telefon nach Abschluss gelöscht, Name bleibt (MASTER_SPEC §12).
    expect(detail.handover.recipientPhone).toBeNull();
    expect(detail.representative?.phone).toBeNull();
    expect(detail.representative?.firstName).toBe('Paula');
    const columns = await ctx.pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name IN ('booking_pickup_representatives', 'handovers')`,
    );
    const names = columns.rows.map((row) => String(row.column_name));
    expect(names.some((name) => /ausweis|id_number|passport|identity/i.test(name))).toBe(false);
    const protocol = await services.documentService.byId(detail.handover.protocolDocumentId!);
    const pdf = pdfText(await services.documentService.bytesFor(protocol));
    expect(pdf).toContain('Paula Proxy');
    expect(pdf).toContain('Hinterlegte Abholperson');
  });
});

describe('65.–70. Protokoll, Fotos, Immutabilität', () => {
  it('65./66./67. Mehrere Maschinen → EIN Protokoll mit Abschnitten, beiden Unterschriften und neutralem Schadenstext', async () => {
    const { admin, effective } = await adminSession();
    const { services, world } = await almostReady(admin.id, effective, 'none', [
      'MR-10-01-01',
      'MR-10-01-02',
    ]);
    const detail = await services.handover.finalize(admin.id, world.bookingId);
    const docs = await ctx.pool.query(`SELECT type FROM documents WHERE booking_id = $1`, [
      world.bookingId,
    ]);
    expect(docs.rows.filter((row) => row.type === 'handover_protocol')).toHaveLength(1);
    const protocol = await services.documentService.byId(detail.handover.protocolDocumentId!);
    const bytes = Buffer.from(await services.documentService.bytesFor(protocol));
    const pdf = pdfText(bytes);
    expect(pdf).toContain('Maschine MR-10-01-01');
    expect(pdf).toContain('Maschine MR-10-01-02');
    expect(pdf).toContain('Unterschrift Kunde / Vertreter');
    expect(pdf).toContain('Unterschrift Mitarbeiter');
    expect(pdf).toContain('Keine bestehenden Sch');
    expect(pdf).toContain('Maschine gemeinsam gepr');
    // Zwei eingebettete Unterschriftsbilder.
    expect((pdf.match(/\/Subtype \/Image/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('68. Gesamtfotos sind privat: nur mit Session + handover.view', async () => {
    const { admin, effective, cookie } = await adminSession();
    const { services, world } = await almostReady(admin.id, effective, 'none');
    const detail = await services.handover.detail(world.bookingId);
    const photoId = detail.machines[0]!.photos[0]!.id;
    expect(
      (await ctx.app.inject({ method: 'GET', url: `/staff/handover/photos/${photoId}` }))
        .statusCode,
    ).toBe(401);
    const outsider = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Fritz',
      lastName: 'Fremd',
      email: 'fritz.fremd@test.example',
      password: 'fritz-passwort-1234',
      permissionKeys: ['process.view_all', 'machine.view'],
    });
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/staff/handover/photos/${photoId}`,
          headers: { cookie: outsider.cookie },
        })
      ).statusCode,
    ).toBe(403);
    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/staff/handover/photos/${photoId}`,
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('image/png');
    expect(ok.headers['cache-control']).toContain('no-store');
  });

  it('69./70. Die finale Übergabe ist unveränderlich; Double-Submit ergibt genau EINE Übergabe', async () => {
    const { admin, effective } = await adminSession();
    const { services, world, slots } = await almostReady(admin.id, effective, 'none');
    const first = await services.handover.finalize(admin.id, world.bookingId);
    const second = await services.handover.finalize(admin.id, world.bookingId);
    expect(second.handover.finalizedAt).toBe(first.handover.finalizedAt);
    expect(second.handover.protocolDocumentId).toBe(first.handover.protocolDocumentId);
    for (const attempt of [
      () => services.handover.setRecipient(world.bookingId, { kind: 'other', name: 'Später' }),
      () => services.handover.sign(admin.id, world.bookingId, 'customer', pngBytes()),
      () => services.handover.checkMachine(admin.id, world.bookingId, slots[0]!.id),
      () =>
        services.handover.addPhoto(admin.id, world.bookingId, slots[0]!.id, {
          bytes: pngBytes(),
          mimeType: 'image/png',
        }),
      () => services.assignments.release(admin.id, slots[0]!.id),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'CONFLICT' });
    }
    const count = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM handovers WHERE booking_id = $1`,
      [world.bookingId],
    );
    expect(count.rows[0].n).toBe(1);
  });
});

describe('R14. Abholperson und Empfänger bleiben konsistent', () => {
  it('R14. Korrektur/Entfernen der Abholperson folgt in den Empfänger und entwertet die Kundenunterschrift', async () => {
    const { admin } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    await handover.setRepresentative(admin.id, world.bookingId, {
      firstName: 'Anna',
      lastName: 'Alt',
      phone: null,
    });
    await handover.setRecipient(world.bookingId, { kind: 'representative' });
    await handover.sign(admin.id, world.bookingId, 'customer', pngBytes());
    expect((await handover.detail(world.bookingId)).signatures.customer?.signerName).toBe(
      'Anna Alt',
    );
    await handover.setRepresentative(admin.id, world.bookingId, {
      firstName: 'Bea',
      lastName: 'Neu',
      phone: null,
    });
    let detail = await handover.detail(world.bookingId);
    expect(detail.handover.recipientName).toBe('Bea Neu');
    expect(detail.signatures.customer).toBeNull();
    await handover.sign(admin.id, world.bookingId, 'customer', pngBytes());
    await handover.clearRepresentative(world.bookingId);
    detail = await handover.detail(world.bookingId);
    expect(detail.handover.recipientKind).toBeNull();
    expect(detail.signatures.customer).toBeNull();
    expect(detail.blockers).toContain('Kunde oder Vertreter für die Übergabe noch nicht bestimmt.');
  });
});
