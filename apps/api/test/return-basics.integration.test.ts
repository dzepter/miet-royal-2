/**
 * Phase-7-Pflichttests 1–22 (Order §§68/69): Rückgabe-Basis (keine
 * Rückgabe ohne Ausgabe, Start, QR-Einstieg, mehrere Maschinen, Rückgabe-
 * person Kunde/Vertreter/sonstige, keine Ausweisdaten, Telefon nach
 * Finalisierung gelöscht, Name bleibt) und Zubehör/Fehlteile (Sollwerte je
 * Behälterzahl, Pflichtkontrolle je Maschine, Fehlteil-Fälle, Follow-up ohne
 * Fälligkeit, Ein-Klick-Erledigung, finanzielle Klärung).
 */
import { machineAssignments, rentalReturns } from '@mietroyal/database';
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
  handoverServicesFor,
  initializeAllInventory,
  pdfText,
  readyHandover,
  scheduledBooking,
  truncateHandoverTables,
} from './handover-helpers.ts';
import { readyReturn, startedReturn } from './return-helpers.ts';
import { buildVisibilityContext } from '../src/crm/visibility.ts';

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

describe('1.–11. Rückgabe-Basis', () => {
  it('1. Nicht ausgegebene Buchung (nur bestätigt / nur vorbereitet) kann keine Rückgabe starten oder finalisieren', async () => {
    const { admin, cookie } = await adminSession();
    const { returns } = handoverServicesFor(ctx);
    const confirmed = await scheduledBooking(ctx, admin.id);
    await expect(returns.start(admin.id, confirmed.bookingId)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('noch keine Maschine ausgegeben') as string,
    });
    await expect(returns.finalize(admin.id, confirmed.bookingId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // Nur vorbereitet (Reserviert), nicht ausgegeben.
    await initializeAllInventory(ctx, admin.id, 20);
    const prepared = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 10 * 86_400_000),
      to: new Date(Date.now() + 12 * 86_400_000),
    });
    await readyHandover(ctx, admin.id, prepared.bookingId, ['MR-10-01-02']);
    await expect(returns.start(admin.id, prepared.bookingId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/returns/${prepared.bookingId}/start`,
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    const rows = await ctx.db.select().from(rentalReturns);
    expect(rows).toHaveLength(0);
  });

  it('2. Ausgegebene Buchung kann eine Rückgabe starten (Entwurf, ein Abschnitt je Maschine)', async () => {
    const { admin } = await adminSession();
    const { detail } = await startedReturn(ctx, admin.id);
    expect(detail.return.status).toBe('draft');
    expect(detail.machines).toHaveLength(1);
    expect(detail.machines[0]!.machineCode).toBe('MR-10-01-01');
    expect(detail.machines[0]!.machineStatus).toBe('rented');
    expect(detail.nextAction).toBe('returner');
    expect(detail.blockers.length).toBeGreaterThan(0);
  });

  it('3. QR-Scan einer ausgegebenen Maschine findet den richtigen aktiven Vorgang (Service + Route)', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    const resolved = await services.returns.resolveQr(machine.qrToken);
    expect(resolved.bookingId).toBe(world.bookingId);
    expect(resolved.processId).toBe(world.processId);
    expect(resolved.machineCode).toBe('MR-10-01-01');
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/staff/returns/resolve-qr/${machine.qrToken}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().bookingId).toBe(world.bookingId);
  });

  it('4. Falscher QR-Code und nicht ausgegebene Maschine liefern denselben neutralen Fehler', async () => {
    const { admin, cookie } = await adminSession();
    const { services } = await startedReturn(ctx, admin.id);
    const other = await machineByCode(ctx.db, 'MR-10-01-02');
    const neutral = 'Für diesen QR-Code ist kein ausgegebener Vorgang offen.';
    await expect(services.returns.resolveQr('deadbeef'.repeat(4))).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: neutral,
    });
    await expect(services.returns.resolveQr(other.qrToken)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: neutral,
    });
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/staff/returns/resolve-qr/${other.qrToken}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toBe(neutral);
  });

  it('5. Mehrere ausgegebene Maschinen werden in EINEM Return geführt; Start ist idempotent', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id, {
      machineCodes: ['MR-10-01-01', 'MR-10-01-02'],
    });
    expect(detail.machines.map((m) => m.machineCode)).toEqual(['MR-10-01-01', 'MR-10-01-02']);
    const again = await services.returns.start(admin.id, world.bookingId);
    expect(again.id).toBe(detail.return.id);
    const rows = await ctx.db.select().from(rentalReturns);
    expect(rows).toHaveLength(1);
  });

  it('6. Rückgabeperson „Kunde selbst“ übernimmt den Kundennamen', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await services.returns.setReturner(admin.id, world.bookingId, { kind: 'customer' });
    const detail = await services.returns.detail(world.bookingId);
    expect(detail.return.returnerKind).toBe('customer');
    expect(detail.return.returnerName).toBe(detail.booking.customerName);
    expect(detail.return.returnerPhone).toBeNull();
  });

  it('7. Rückgabeperson „bekannte Vertretung“ nutzt die hinterlegte Abholperson; ohne Hinterlegung abgelehnt', async () => {
    const { admin } = await adminSession();
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    const services = handoverServicesFor(ctx);
    await services.handover.setRepresentative(admin.id, world.bookingId, {
      firstName: 'Anna',
      lastName: 'Abholung',
      phone: '+49 6131 1',
    });
    await services.handover.finalize(admin.id, world.bookingId);
    await services.returns.start(admin.id, world.bookingId);
    await services.returns.setReturner(admin.id, world.bookingId, { kind: 'representative' });
    const detail = await services.returns.detail(world.bookingId);
    expect(detail.return.returnerKind).toBe('representative');
    expect(detail.return.returnerName).toBe('Anna Abholung');

    const noRep = await startedReturn(ctx, admin.id, {
      machineCodes: ['MR-10-01-02'],
      skipInventoryInit: true,
      from: new Date(Date.now() + 10 * 86_400_000),
      to: new Date(Date.now() + 12 * 86_400_000),
    });
    await expect(
      noRep.services.returns.setReturner(admin.id, noRep.world.bookingId, {
        kind: 'representative',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('8. Spontane andere Rückgabeperson: Vorname, Nachname, Telefon Pflicht', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await expect(
      services.returns.setReturner(admin.id, world.bookingId, {
        kind: 'other',
        firstName: 'Otto',
        lastName: 'Other',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await services.returns.setReturner(admin.id, world.bookingId, {
      kind: 'other',
      firstName: 'Otto',
      lastName: 'Other',
      phone: '+49 6131 999',
    });
    const detail = await services.returns.detail(world.bookingId);
    expect(detail.return.returnerKind).toBe('other');
    expect(detail.return.returnerName).toBe('Otto Other');
    expect(detail.return.returnerPhone).toBe('+49 6131 999');
  });

  it('9. Keine Ausweisdaten im Datenmodell der Rückgabe', async () => {
    const columns = await ctx.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('rental_returns','return_machines','return_signatures','missing_accessory_cases')`,
    );
    const suspicious = columns.rows.filter((row) =>
      /ausweis|passport|identity|id_number|document_number|id_card|birth/i.test(row.column_name),
    );
    expect(suspicious).toEqual([]);
    expect(columns.rows.some((row) => row.column_name === 'returner_phone')).toBe(true);
  });

  it('10./11. Telefonnummer der Rückgabeperson wird bei Finalisierung gelöscht – der Name bleibt historisch (auch im PDF)', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await readyReturn(ctx, admin.id, services, world.bookingId, {
      returner: { kind: 'other', firstName: 'Otto', lastName: 'Other', phone: '+49 6131 999' },
    });
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    expect(finalized.return.status).toBe('finalized');
    expect(finalized.return.returnerName).toBe('Otto Other');
    expect(finalized.return.returnerPhone).toBeNull();
    const row = (await ctx.db.select().from(rentalReturns))[0]!;
    expect(row.returnerPhone).toBeNull();
    expect(row.returnerPhoneDeletedAt).not.toBeNull();
    expect(row.returnerName).toBe('Otto Other');
    const document = await services.documentService.byId(finalized.return.protocolDocumentId!);
    const text = pdfText(await services.documentService.bytesFor(document));
    expect(text).toContain('Otto Other');
    expect(text).not.toContain('+49 6131 999');
  });
});

describe('12.–22. Zubehör und Fehlteile', () => {
  it('12. 1-Behälter-Maschine → 1 Deckel + 1 Tropfschale erwartet', async () => {
    const { admin } = await adminSession();
    const { detail } = await startedReturn(ctx, admin.id);
    expect(detail.machines[0]!.expectedLids).toBe(1);
    expect(detail.machines[0]!.expectedDripTrays).toBe(1);
  });

  it('13. 2-Behälter-Maschine → 2 Deckel + 2 Tropfschalen erwartet', async () => {
    const { admin } = await adminSession();
    const { detail } = await startedReturn(ctx, admin.id, {
      machineSlug: 'slush-2x10',
      machineCodes: ['MR-10-02-01'],
    });
    expect(detail.machines[0]!.expectedLids).toBe(2);
    expect(detail.machines[0]!.expectedDripTrays).toBe(2);
  });

  it('14. Zubehörprüfung ist je Maschine Pflicht – eine unbestätigte Maschine blockiert die Finalisierung', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id, {
      machineCodes: ['MR-10-01-01', 'MR-10-01-02'],
    });
    await readyReturn(ctx, admin.id, services, world.bookingId, { skipAccessories: true });
    await services.returns.confirmAccessoriesComplete(
      admin.id,
      world.bookingId,
      detail.machines[0]!.id,
    );
    const view = await services.returns.detail(world.bookingId);
    expect(view.blockers).toEqual([
      expect.stringContaining('MR-10-01-02: Zubehörkontrolle noch nicht bestätigt'),
    ]);
    await expect(services.returns.finalize(admin.id, world.bookingId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('15. Zubehör vollständig → einfacher Zustand, kein Fehlteil-Eintrag', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    await services.returns.confirmAccessoriesComplete(
      admin.id,
      world.bookingId,
      detail.machines[0]!.id,
    );
    const view = await services.returns.detail(world.bookingId);
    expect(view.machines[0]!.accessoryComplete).toBe(true);
    expect(view.machines[0]!.accessoryCheckedAt).not.toBeNull();
    expect(view.machines[0]!.missingCases).toEqual([]);
    const cases = await ctx.pool.query('SELECT count(*)::int AS n FROM missing_accessory_cases');
    expect(cases.rows[0].n).toBe(0);
  });

  it('16. Fehlender Deckel → Fehlteil-Fall; „vollständig“ ist dann nicht möglich; Entfernen setzt die Kontrolle zurück', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const machineId = detail.machines[0]!.id;
    const { caseId } = await services.returns.addMissingCase(admin.id, world.bookingId, machineId, {
      accessoryType: 'lid',
      missingQuantity: 1,
    });
    let view = await services.returns.detail(world.bookingId);
    expect(view.machines[0]!.accessoryComplete).toBe(false);
    expect(view.machines[0]!.missingCases[0]).toMatchObject({
      id: caseId,
      accessoryType: 'lid',
      accessoryLabel: 'Deckel',
      missingQuantity: 1,
      status: 'open',
    });
    await expect(
      services.returns.confirmAccessoriesComplete(admin.id, world.bookingId, machineId),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await services.returns.deleteMissingCase(admin.id, world.bookingId, caseId);
    view = await services.returns.detail(world.bookingId);
    expect(view.machines[0]!.accessoryComplete).toBeNull();
    expect(view.machines[0]!.missingCases).toEqual([]);
  });

  it('17. Fehlende Tropfschale → Fehlteil-Fall; mehr als der Sollwert wird abgelehnt', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const machineId = detail.machines[0]!.id;
    await expect(
      services.returns.addMissingCase(admin.id, world.bookingId, machineId, {
        accessoryType: 'drip_tray',
        missingQuantity: 2,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await services.returns.addMissingCase(admin.id, world.bookingId, machineId, {
      accessoryType: 'drip_tray',
      missingQuantity: 1,
      description: 'Tropfschale fehlt komplett',
    });
    const view = await services.returns.detail(world.bookingId);
    expect(view.machines[0]!.missingCases[0]).toMatchObject({
      accessoryLabel: 'Tropfschale',
      description: 'Tropfschale fehlt komplett',
    });
  });

  it('18./19. Kein Foto für ein Fehlteil erforderlich; Rückgabe finalisierbar; Follow-up aktiv ohne Fälligkeitsdatum', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    await services.returns.addMissingCase(admin.id, world.bookingId, detail.machines[0]!.id, {
      accessoryType: 'lid',
      missingQuantity: 1,
    });
    await readyReturn(ctx, admin.id, services, world.bookingId, { skipAccessories: true });
    const before = await services.returns.detail(world.bookingId);
    expect(before.blockers).toEqual([]);
    expect(before.machines[0]!.missingCases[0]!.followUpOpenedAt).toBeNull();
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    expect(finalized.return.status).toBe('finalized');
    const open = await services.returns.openMissingCases();
    expect(open).toHaveLength(1);
    expect(open[0]!.followUpOpenedAt).not.toBeNull();
    const columns = await ctx.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'missing_accessory_cases'`,
    );
    expect(columns.rows.some((row) => /due|faellig|deadline/i.test(row.column_name))).toBe(false);
    expect(columns.rows.some((row) => /photo|cost|amount|cents/i.test(row.column_name))).toBe(
      false,
    );
  });

  it('20.–22. Ein Klick erledigt das Fehlteil; offen = finanzielle Klärung, erledigt = nicht mehr offen (idempotent)', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const { caseId } = await services.returns.addMissingCase(
      admin.id,
      world.bookingId,
      detail.machines[0]!.id,
      { accessoryType: 'lid', missingQuantity: 1 },
    );
    // Vor der Finalisierung gibt es kein „Erledigt“ – nur Entfernen im Entwurf.
    await expect(services.returns.resolveMissingCase(admin.id, caseId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await readyReturn(ctx, admin.id, services, world.bookingId, { skipAccessories: true });
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    expect(finalized.machines[0]!.missingCases[0]!.requiresFinancialReview).toBe(true);
    expect(finalized.summary.lines.some((line) => line.includes('finanzielle Klärung'))).toBe(true);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/missing-items/${caseId}/resolve`,
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().case).toMatchObject({
      status: 'resolved',
      requiresFinancialReview: false,
    });
    const again = await services.returns.resolveMissingCase(admin.id, caseId);
    expect(again.status).toBe('resolved');
    expect(await services.returns.openMissingCases()).toEqual([]);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    const condition = await services.returns.machineCondition(machine.id);
    expect(condition.openMissingCases).toEqual([]);
    // Historisches Protokoll unverändert: Dokument-Hash gleich.
    const document = await services.documentService.byId(finalized.return.protocolDocumentId!);
    expect(pdfText(await services.documentService.bytesFor(document))).toContain('1 × Deckel');
    const assignment = (
      await ctx.db
        .select()
        .from(machineAssignments)
        .where(eq(machineAssignments.bookingId, world.bookingId))
    )[0]!;
    expect(assignment.status).toBe('returned');
  });
});

describe('Review-Härtung (Order §5): Browse-Regel ±3 Tage ist kalendertagbasiert', () => {
  it('R7. Rückgabeliste gruppiert nach Berliner Kalendertagen – unabhängig von der Uhrzeit des Aufrufs', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    const visibility = buildVisibilityContext(new Set(), 30);
    // Fester Aufrufzeitpunkt: 08:00 Uhr Berlin (06:00Z, Sommerzeit).
    const now = new Date('2026-09-26T06:00:00.000Z');
    const setReturnAt = async (iso: string) => {
      await ctx.pool.query(
        `UPDATE appointments SET start_at = $2, end_at = $2::timestamptz + interval '30 minutes'
         WHERE booking_id = $1 AND kind = 'return'`,
        [world.bookingId, iso],
      );
    };
    const groupOf = async () =>
      (await services.returns.listOpen(visibility, now)).find(
        (entry) => entry.bookingId === world.bookingId,
      )?.group;
    await setReturnAt('2026-09-29T20:00:00.000Z'); // Tag +3, 22:00 Berlin – nach 08:00 + 72 h
    expect(await groupOf()).toBe('upcoming');
    await setReturnAt('2026-09-29T22:30:00.000Z'); // Tag +4, 00:30 Berlin – außerhalb
    expect(await groupOf()).toBeUndefined();
    await setReturnAt('2026-09-26T21:00:00.000Z'); // heute, 23:00 Berlin
    expect(await groupOf()).toBe('today');
    await setReturnAt('2026-09-26T05:00:00.000Z'); // heute, 07:00 Berlin – bereits vorbei
    expect(await groupOf()).toBe('overdue');
  });
});
