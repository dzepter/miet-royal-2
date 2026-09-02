/**
 * Phase-5-Pflichttests 23–39 (Order §52): Sperren, interne Verfügbarkeit,
 * Kapazität aus echten Maschinen, Kapazitätskonflikte über die bestehende
 * Konfliktarchitektur, Suppression-Neubewertung, Alternativen und
 * Auswahlvorschlag mit Eligibility.
 */
import { appointments } from '@mietroyal/database';
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
import {
  createAcceptedBooking,
  schedulingServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';
import {
  availabilityServiceFor,
  machineByCode,
  machineServiceFor,
  productBySlug,
  resetWarehouse,
} from './warehouse-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetWarehouse(ctx.pool);
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
});

const HOURS = 3_600_000;

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

/** Bestätigte Buchung mit gesetztem Mietzeitraum (Abholung → Rückgabe). */
async function bookingWithRental(
  adminId: string,
  machineSlug: string,
  from: Date,
  to: Date,
  options: { machineQuantity?: number } = {},
) {
  const scheduling = schedulingServiceFor(ctx);
  const world = await createAcceptedBooking(ctx, adminId, {
    fulfillment: 'pickup',
    machineSlug,
    ...options,
  });
  await scheduling.ensureAppointmentsForBooking(world.bookingId);
  const rows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, world.bookingId));
  const pickup = rows.find((row) => row.kind === 'pickup')!;
  const back = rows.find((row) => row.kind === 'return')!;
  await scheduling.reschedule(adminId, pickup.id, {
    startAt: from,
    endAt: null,
    expectedVersion: pickup.version,
  });
  await scheduling.reschedule(adminId, back.id, {
    startAt: to,
    endAt: null,
    expectedVersion: back.version,
  });
  return { scheduling, world, pickupId: pickup.id, returnId: back.id };
}

describe('23.–25. Sperren', () => {
  it('23. Sperre mit Zeitraum und Pflichtgrund wird angelegt', async () => {
    const { cookie } = await adminSession();
    const machine = await machineByCode(ctx.db, 'MR-08-02-01');
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/blocks`,
      headers: { cookie },
      payload: {
        startsAt: new Date(Date.now() + 24 * HOURS).toISOString(),
        endsAt: new Date(Date.now() + 48 * HOURS).toISOString(),
        reason: 'Interne Nutzung Firmenfeier',
      },
    });
    expect(response.statusCode).toBe(200);
  });

  it('24. Sperre ohne Grund wird abgelehnt', async () => {
    const { cookie } = await adminSession();
    const machine = await machineByCode(ctx.db, 'MR-08-02-01');
    for (const reason of ['', '   ']) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/staff/machines/${machine.id}/blocks`,
        headers: { cookie },
        payload: {
          startsAt: new Date(Date.now() + 24 * HOURS).toISOString(),
          endsAt: new Date(Date.now() + 48 * HOURS).toISOString(),
          reason,
        },
      });
      expect(response.statusCode, JSON.stringify(reason)).toBe(400);
    }
  });

  it('25. Berechtigte Person kann eine Sperre aufheben (ohne Pflichtbegründung)', async () => {
    const { admin, cookie } = await adminSession();
    const service = machineServiceFor(ctx);
    const machine = await machineByCode(ctx.db, 'MR-08-02-01');
    const block = await service.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() + 24 * HOURS),
      endsAt: new Date(Date.now() + 48 * HOURS),
      reason: 'Geplante Reparatur',
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machine-blocks/${block.id}/lift`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(await service.openBlocks(machine.id)).toHaveLength(0);
  });
});

describe('26.–31. Interne Kapazität', () => {
  const interval = () => ({
    from: new Date(Date.now() + 24 * HOURS),
    to: new Date(Date.now() + 48 * HOURS),
  });

  it('26./27. Reparatur- und Außer-Betrieb-Maschinen sind nicht regulär verfügbar', async () => {
    await adminSession();
    const availability = availabilityServiceFor(ctx);
    const service = machineServiceFor(ctx);
    const product = await productBySlug(ctx.db, 'slush-1x8');
    const first = await machineByCode(ctx.db, 'MR-08-01-01');
    const second = await machineByCode(ctx.db, 'MR-08-01-02');
    await service.setStatus(first.id, 'repair');
    await service.setStatus(second.id, 'out_of_service');
    const check = await availability.checkProduct(product.id, interval());
    expect(check.totalMachines).toBe(2);
    expect(check.minUsable).toBe(0);
    expect(check.unavailableMachines.map((entry) => entry.reason).sort()).toEqual([
      'Status Außer Betrieb',
      'Status Reparatur',
    ]);
  });

  it('28./29. Eine aktive Sperre reduziert die Kapazität nur im überlappenden Zeitraum', async () => {
    const { admin } = await adminSession();
    const availability = availabilityServiceFor(ctx);
    const service = machineServiceFor(ctx);
    const product = await productBySlug(ctx.db, 'slush-1x8');
    const first = await machineByCode(ctx.db, 'MR-08-01-01');
    await service.createBlock(first.id, admin.id, {
      startsAt: interval().from,
      endsAt: interval().to,
      reason: 'Interne Nutzung',
    });
    const inWindow = await availability.checkProduct(product.id, interval());
    expect(inWindow.minUsable).toBe(1);
    // Nicht überlappender Zeitraum: volle Kapazität.
    const later = await availability.checkProduct(product.id, {
      from: new Date(Date.now() + 72 * HOURS),
      to: new Date(Date.now() + 96 * HOURS),
    });
    expect(later.minUsable).toBe(2);
  });

  it('30. Fehlende Terminzeiten → „nicht vollständig prüfbar“, keine Ablehnung', async () => {
    const { admin } = await adminSession();
    const availability = availabilityServiceFor(ctx);
    const scheduling = schedulingServiceFor(ctx);
    // Buchung OHNE Terminzeiten (Selbstabholung ohne Snapshot-Fenster).
    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'pickup',
      machineSlug: 'slush-2x8',
    });
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    const product = await productBySlug(ctx.db, 'slush-2x8');
    const check = await availability.checkProduct(product.id, {
      from: new Date(Date.now()),
      to: new Date(Date.now() + 60 * 24 * HOURS),
    });
    expect(check.notFullyCheckable).toBe(true);
    expect(check.reasons.join(' ')).toContain('noch nicht vollständig prüfbar – Terminzeit fehlt');
    // Keine Ablehnung/Blockade: Status bleibt eine Einschätzung.
    expect(['available', 'tight', 'conflict']).toContain(check.status);
  });

  it('31. Kapazität wird aus dem ECHTEN Maschinenbestand berechnet', async () => {
    await adminSession();
    const availability = availabilityServiceFor(ctx);
    const service = machineServiceFor(ctx);
    const product = await productBySlug(ctx.db, 'slush-2x8');
    const before = await availability.checkProduct(product.id, interval());
    expect(before.totalMachines).toBe(1);
    await service.createMachine({ productId: product.id });
    const after = await availability.checkProduct(product.id, interval());
    expect(after.totalMachines).toBe(2);
    expect(after.minUsable).toBe(2);
  });
});

describe('32.–36. Kapazitätskonflikte (bestehende Konfliktarchitektur)', () => {
  it('32.–34. Zwei überlappende Buchungen gegen eine Maschine → Warnung am Termin, keine Blockade', async () => {
    const { admin } = await adminSession();
    const from = new Date(Date.now() + 24 * HOURS);
    const to = new Date(Date.now() + 72 * HOURS);
    const a = await bookingWithRental(admin.id, 'slush-2x8', from, to);
    const b = await bookingWithRental(
      admin.id,
      'slush-2x8',
      new Date(from.getTime() + 6 * HOURS),
      new Date(to.getTime() + 6 * HOURS),
    );

    const entries = await a.scheduling.listForProcess(a.world.processId);
    const pickupEntry = entries.find((entry) => entry.id === a.pickupId)!;
    const capacity = pickupEntry.conflicts.find((c) => c.type === 'machine_capacity');
    expect(capacity).toBeDefined();
    expect(capacity!.severity).toBe('warning');
    expect(capacity!.reason).toContain('Kapazitätswarnung');
    expect(capacity!.reason).toContain('2 Maschinen benötigt');

    // 33: Die Warnung blockiert NICHTS – Termine bleiben verschiebbar.
    const rescheduled = await b.scheduling.reschedule(admin.id, b.pickupId, {
      startAt: new Date(from.getTime() + 7 * HOURS),
      endAt: null,
      expectedVersion: entries.length > 0 ? (await b.scheduling.entryById(b.pickupId)).version : 1,
    });
    expect(rescheduled.id).toBe(b.pickupId);
  });

  it('35. Eine Suppression wirkt nach relevanter Bestands-/Sperränderung NICHT weiter', async () => {
    const { admin } = await adminSession();
    const from = new Date(Date.now() + 24 * HOURS);
    const to = new Date(Date.now() + 72 * HOURS);
    const a = await bookingWithRental(admin.id, 'slush-2x8', from, to);
    await bookingWithRental(admin.id, 'slush-2x8', from, to);

    const scheduling = a.scheduling;
    let entry = await scheduling.entryById(a.pickupId);
    const conflict = entry.conflicts.find((c) => c.type === 'machine_capacity');
    expect(conflict).toBeDefined();

    // "Konflikt gelöst" über den normalen Weg.
    const contextRows = await scheduling.listForConflictCheck(conflict!.appointmentIds);
    await scheduling.conflicts.resolve(
      { appointments: contextRows },
      'machine_capacity',
      conflict!.appointmentIds,
    );
    entry = await scheduling.entryById(a.pickupId);
    expect(entry.conflicts.some((c) => c.type === 'machine_capacity')).toBe(false);

    // Relevante Änderung der Maschinenlage: zweite 2×8-Maschine kommt hinzu
    // und wird wieder entfernt … hier: Sperre auf die einzige Maschine.
    const service = machineServiceFor(ctx);
    const machine = await machineByCode(ctx.db, 'MR-08-02-01');
    await service.createBlock(machine.id, admin.id, {
      startsAt: from,
      endsAt: to,
      reason: 'Geplante Reparatur',
    });
    entry = await scheduling.entryById(a.pickupId);
    // Neuer fachlicher Fingerprint → Konflikt erscheint wieder.
    expect(entry.conflicts.some((c) => c.type === 'machine_capacity')).toBe(true);
  });

  it('36. Alternativen sind reine Vorschläge – die Buchung bleibt unverändert', async () => {
    const { admin } = await adminSession();
    const availability = availabilityServiceFor(ctx);
    const from = new Date(Date.now() + 24 * HOURS);
    const to = new Date(Date.now() + 72 * HOURS);
    const a = await bookingWithRental(admin.id, 'slush-2x8', from, to);
    await bookingWithRental(admin.id, 'slush-2x8', from, to);
    const product = await productBySlug(ctx.db, 'slush-2x8');
    const check = await availability.checkProduct(product.id, { from, to });
    expect(check.status).toBe('conflict');
    expect(check.alternatives.length).toBeGreaterThan(0);
    expect(check.alternatives[0]!.note).toContain('Mögliche Alternative');
    // Buchung/Snapshot unverändert – keine automatische Umstellung.
    const items = (
      await ctx.pool.query(`SELECT items_snapshot FROM bookings WHERE id = $1`, [a.world.bookingId])
    ).rows[0].items_snapshot as { kind: string; productSnapshot: { name?: string } }[];
    expect(items.find((item) => item.kind === 'machine')?.productSnapshot?.name).toContain('2×8');
  });
});

describe('37.–39. Auswahlvorschlag (Phase-6-Vorbereitung)', () => {
  it('37./38. Ältestes BEKANNTES Kaufdatum wird bevorzugt; unbekannte Daten werden nicht erfunden', async () => {
    await adminSession();
    const availability = availabilityServiceFor(ctx);
    const service = machineServiceFor(ctx);
    const product = await productBySlug(ctx.db, 'slush-1x8');
    const first = await machineByCode(ctx.db, 'MR-08-01-01');
    const second = await machineByCode(ctx.db, 'MR-08-01-02');
    await service.updateMasterData(second.id, { purchaseDate: '2021-05-01' });
    await service.updateMasterData(first.id, { purchaseDate: '2023-01-15' });
    let suggestion = await availability.suggestMachines(product.id, null);
    expect(suggestion.preferred?.machineCode).toBe('MR-08-01-02');
    expect(suggestion.preferredBasis).toBe('Ältestes bekanntes Kaufdatum');

    // Ohne Kaufdaten: deterministischer Fallback über die Maschinen-ID.
    await service.updateMasterData(first.id, { purchaseDate: null });
    await service.updateMasterData(second.id, { purchaseDate: null });
    suggestion = await availability.suggestMachines(product.id, null);
    expect(suggestion.preferred?.machineCode).toBe('MR-08-01-01');
    expect(suggestion.preferred?.purchaseDate).toBeNull();
    expect(suggestion.preferredBasis).toContain('Kaufdatum unbekannt');
  });

  it('39. Blockierte/nicht einsetzbare Maschinen liefern override_required statt stiller Freigabe', async () => {
    const { admin } = await adminSession();
    const availability = availabilityServiceFor(ctx);
    const service = machineServiceFor(ctx);
    const product = await productBySlug(ctx.db, 'slush-1x8');
    const interval = {
      from: new Date(Date.now() + 24 * HOURS),
      to: new Date(Date.now() + 48 * HOURS),
    };
    const first = await machineByCode(ctx.db, 'MR-08-01-01');
    const second = await machineByCode(ctx.db, 'MR-08-01-02');
    await service.createBlock(first.id, admin.id, {
      startsAt: interval.from,
      endsAt: interval.to,
      reason: 'Interne Nutzung',
    });
    await service.setStatus(second.id, 'repair');
    const suggestion = await availability.suggestMachines(product.id, interval);
    expect(suggestion.preferred).toBeNull();
    const byCode = new Map(suggestion.others.map((entry) => [entry.machineCode, entry]));
    expect(byCode.get('MR-08-01-01')?.eligibility).toBe('override_required');
    expect(byCode.get('MR-08-01-02')?.eligibility).toBe('override_required');
    expect(byCode.get('MR-08-01-01')?.reasons.join(' ')).toContain('Gesperrt');
  });
});

describe('R1–R4. Review-Fixes: Mengen, Null-Kapazität, Fingerprint-Stabilität', () => {
  it('R1. Der Bedarf zählt die gebuchte MENGE, nicht die Anzahl Buchungen', async () => {
    const { admin } = await adminSession();
    const availability = availabilityServiceFor(ctx);
    const from = new Date(Date.now() + 24 * HOURS);
    const to = new Date(Date.now() + 72 * HOURS);
    // EINE Buchung über 2 × „2×10“ belegt beide physischen Maschinen.
    await bookingWithRental(admin.id, 'slush-2x10', from, to, { machineQuantity: 2 });
    const product = await productBySlug(ctx.db, 'slush-2x10');
    let check = await availability.checkProduct(product.id, { from, to });
    expect(check.peakDemand).toBe(2);
    expect(check.status).toBe('tight');
    // Fällt eine Maschine aus, entsteht trotz nur EINER Buchung ein Konflikt.
    const service = machineServiceFor(ctx);
    const machine = await machineByCode(ctx.db, 'MR-10-02-01');
    await service.setStatus(machine.id, 'repair');
    check = await availability.checkProduct(product.id, { from, to });
    expect(check.status).toBe('conflict');
    expect(check.reasons.join(' ')).toContain('bis zu 2 Maschinen benötigt, aber nur 1');
  });

  it('R2. Null einsetzbare Maschinen sind NIE „verfügbar“ – Alternativen werden vorgeschlagen', async () => {
    await adminSession();
    const availability = availabilityServiceFor(ctx);
    const service = machineServiceFor(ctx);
    const product = await productBySlug(ctx.db, 'slush-2x8');
    const machine = await machineByCode(ctx.db, 'MR-08-02-01');
    await service.setStatus(machine.id, 'repair');
    const check = await availability.checkProduct(product.id, {
      from: new Date(Date.now() + 24 * HOURS),
      to: new Date(Date.now() + 48 * HOURS),
    });
    expect(check.status).toBe('conflict');
    expect(check.reasons.join(' ')).toContain('keine Maschine einsetzbar');
    // §19-Alternative (2×8 → größere 2×10) erscheint als reiner Vorschlag.
    expect(check.alternatives.some((alt) => alt.productSlug === 'slush-2x10')).toBe(true);
  });

  it('R3. Irrelevante Sperren außerhalb des Konfliktfensters entwerten eine Suppression NICHT', async () => {
    const { admin } = await adminSession();
    const from = new Date(Date.now() + 24 * HOURS);
    const to = new Date(Date.now() + 72 * HOURS);
    const a = await bookingWithRental(admin.id, 'slush-2x8', from, to);
    await bookingWithRental(admin.id, 'slush-2x8', from, to);
    const scheduling = a.scheduling;
    let entry = await scheduling.entryById(a.pickupId);
    const conflict = entry.conflicts.find((c) => c.type === 'machine_capacity');
    expect(conflict).toBeDefined();
    const contextRows = await scheduling.listForConflictCheck(conflict!.appointmentIds);
    await scheduling.conflicts.resolve(
      { appointments: contextRows },
      'machine_capacity',
      conflict!.appointmentIds,
    );
    // Sperre WEIT außerhalb des Cluster-Fensters (in 30 Tagen): fachlich
    // irrelevant für den unterdrückten Konflikt → Suppression bleibt wirksam.
    const service = machineServiceFor(ctx);
    const machine = await machineByCode(ctx.db, 'MR-08-02-01');
    await service.createBlock(machine.id, admin.id, {
      startsAt: new Date(Date.now() + 30 * 24 * HOURS),
      endsAt: new Date(Date.now() + 31 * 24 * HOURS),
      reason: 'Wartung in ferner Zukunft',
    });
    entry = await scheduling.entryById(a.pickupId);
    expect(entry.conflicts.some((c) => c.type === 'machine_capacity')).toBe(false);
  });

  it('R4. Mutationsantworten und Sperranlage: Hinweise auf nicht prüfbare Buchungen gehen nicht verloren', async () => {
    const { admin, cookie } = await adminSession();
    const scheduling = schedulingServiceFor(ctx);
    // Buchung ohne Terminzeiten → „nicht vollständig prüfbar“.
    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'pickup',
      machineSlug: 'slush-1x8',
    });
    await scheduling.ensureAppointmentsForBooking(world.bookingId);
    // Sperre auf eine von zwei 1×8-Maschinen: Kapazität bleibt „verfügbar“,
    // der §15-Hinweis muss trotzdem in den Warnungen stehen.
    const machine = await machineByCode(ctx.db, 'MR-08-01-01');
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/blocks`,
      headers: { cookie },
      payload: {
        startsAt: new Date(Date.now() + 24 * HOURS).toISOString(),
        endsAt: new Date(Date.now() + 48 * HOURS).toISOString(),
        reason: 'Interne Nutzung',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { warnings: string[] };
    expect(body.warnings.join(' ')).toContain('noch nicht vollständig prüfbar');
  });
});
