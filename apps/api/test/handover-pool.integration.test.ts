/**
 * Phase-6-Finalisierung A1 (Order-Tests 1–6, Pflichttest 119): Kein
 * verschachtelter Pool-Zugriff unter Transaktionen/Sperren. Mit bewusst
 * kleinem Verbindungspool laufen parallele Finalisierungen VERSCHIEDENER
 * Übergaben ohne Verhungern/Timeout durch, erzeugen keine doppelten
 * Bewegungen/Dokumente und hinterlassen keine halb finalisierten
 * Übergaben. Ein Ein-Verbindungs-Pool macht jede verschachtelte
 * Pool-Akquise deterministisch zum Verbindungs-Timeout (Detektor).
 */
import { appointments, inventoryMovements, machineAssignments } from '@mietroyal/database';
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
import { adminVisibilityCtx, processServiceFor, truncateCrmTables } from './crm-helpers.ts';
import {
  commerceServices,
  setPickupExactAddress,
  truncateCommerceTables,
} from './commerce-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { machineByCode, resetWarehouse } from './warehouse-helpers.ts';
import {
  DAYS,
  HOURS,
  handoverServicesFor,
  initializeAllInventory,
  pngBytes,
  readyHandover,
  scheduledBooking,
  truncateHandoverTables,
} from './handover-helpers.ts';

async function resetAll(ctx: TestContext): Promise<void> {
  await truncateHandoverTables(ctx.pool);
  await resetWarehouse(ctx.pool);
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
}

async function adminSession(ctx: TestContext) {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const effective = await ctx.auth.effectivePermissions(admin.id);
  return { admin, cookie: session.cookie, effective };
}

const MACHINES = ['MR-10-01-01', 'MR-10-01-02', 'MR-10-01-03', 'MR-10-01-04', 'MR-10-01-05'];

describe('A1 – Pool mit 2 Verbindungen (Order-Tests 1–5, Pflichttest 119)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({ poolMax: 2 });
  });
  afterAll(async () => {
    await destroyTestContext(ctx);
  });
  beforeEach(async () => {
    await resetAll(ctx);
  });

  it('1.–5. Fünf parallele Finalisierungen verschiedener Übergaben laufen mit Pool 2 vollständig durch – ohne Timeout, Doppelbewegungen oder halbe Zustände', async () => {
    const { admin } = await adminSession(ctx);
    await initializeAllInventory(ctx, admin.id, 100);
    const worlds = [];
    for (const [index, code] of MACHINES.entries()) {
      // Getrennte Mietzeiträume: keine Kollisions-Overrides nötig.
      const from = new Date(Date.now() + (index + 1) * 10 * DAYS);
      const world = await scheduledBooking(ctx, admin.id, {
        from,
        to: new Date(from.getTime() + 2 * DAYS),
      });
      await readyHandover(ctx, admin.id, world.bookingId, [code]);
      worlds.push({ ...world, code });
    }
    expect(ctx.pool.totalCount).toBeLessThanOrEqual(2);

    // EINE Service-Instanz (keyed Mutex greift nur je Buchung) – alle fünf
    // Finalisierungen konkurrieren echt um die zwei Verbindungen.
    const services = handoverServicesFor(ctx);
    const startedAt = Date.now();
    const results = await Promise.allSettled(
      worlds.map((world) => services.handover.finalize(admin.id, world.bookingId)),
    );
    const elapsed = Date.now() - startedAt;
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected.map((r) => (r.status === 'rejected' ? String(r.reason) : ''))).toEqual([]);
    for (const result of results) {
      expect(result.status).toBe('fulfilled');
      if (result.status === 'fulfilled') {
        expect(result.value.handover.status).toBe('finalized');
        expect(result.value.handover.finalizedAt).not.toBeNull();
      }
    }
    // Kein Verhungern: weit unter dem 5-s-Verbindungs-Timeout je Akquise.
    expect(elapsed).toBeLessThan(20_000);
    expect(ctx.pool.totalCount).toBeLessThanOrEqual(2);

    // Keine doppelten Bewegungen (Becher + Strohhalme inklusive je Buchung).
    const movements = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.kind, 'issue'));
    expect(movements).toHaveLength(MACHINES.length * 2);
    // Keine doppelten Dokumente/Pakete.
    const docs = await ctx.pool.query(
      `SELECT booking_id, type, count(*)::int AS n FROM documents
       WHERE booking_id IS NOT NULL GROUP BY booking_id, type ORDER BY booking_id, type`,
    );
    expect(docs.rows).toHaveLength(MACHINES.length * 2);
    expect(docs.rows.every((row) => row.n === 1)).toBe(true);
    const packets = await ctx.pool.query(`SELECT count(*)::int AS n FROM delivery_packets`);
    expect(packets.rows[0].n).toBe(MACHINES.length);
    // Keine halb finalisierten Übergaben: Status, Zuordnungen, Maschinen, Termine.
    const handovers = await ctx.pool.query(
      `SELECT status, finalized_at FROM handovers ORDER BY booking_id`,
    );
    expect(handovers.rows.every((row) => row.status === 'finalized')).toBe(true);
    expect(handovers.rows.every((row) => row.finalized_at !== null)).toBe(true);
    const assignmentRows = await ctx.db.select().from(machineAssignments);
    expect(assignmentRows).toHaveLength(MACHINES.length);
    expect(assignmentRows.every((row) => row.status === 'issued')).toBe(true);
    for (const world of worlds) {
      const machine = await machineByCode(ctx.db, world.code);
      expect(machine.status).toBe('rented');
      const appointmentRows = await ctx.db
        .select()
        .from(appointments)
        .where(eq(appointments.id, world.outboundAppointmentId));
      expect(appointmentRows[0]?.status).toBe('completed');
    }
  });

  it('6. Dreifache Finalisierung DERSELBEN Übergabe über getrennte Instanzen mit Pool 2 liefert genau ein Ergebnis', async () => {
    const { admin } = await adminSession(ctx);
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    const results = await Promise.allSettled([
      handoverServicesFor(ctx).handover.finalize(admin.id, world.bookingId),
      handoverServicesFor(ctx).handover.finalize(admin.id, world.bookingId),
      handoverServicesFor(ctx).handover.finalize(admin.id, world.bookingId),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const finalizedAts = new Set(
      results.map((r) => (r.status === 'fulfilled' ? r.value.handover.finalizedAt : null)),
    );
    expect(finalizedAts.size).toBe(1);
    const movements = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.kind, 'issue'));
    expect(movements).toHaveLength(2);
    const docs = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM documents WHERE booking_id = $1`,
      [world.bookingId],
    );
    expect(docs.rows[0].n).toBe(2);
    const packets = await ctx.pool.query(`SELECT count(*)::int AS n FROM delivery_packets`);
    expect(packets.rows[0].n).toBe(1);
    expect(ctx.pool.totalCount).toBeLessThanOrEqual(2);
  });
});

describe('A1 – Detektor mit EINER Verbindung: keine verschachtelte Pool-Akquise auf den Mutationspfaden', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({ poolMax: 1 });
  });
  afterAll(async () => {
    await destroyTestContext(ctx);
  });
  beforeEach(async () => {
    await resetAll(ctx);
  });

  it('Zuweisen, Vorbereiten, Zurücknehmen, Wechseln, Lösen, AB-Freigabe/-Versand, Terminverschiebung, Finalisierung und Storno laufen mit Pool 1 durch', async () => {
    const { admin, effective } = await adminSession(ctx);
    await setPickupExactAddress(ctx, admin.id);
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id, {
      selections: [{ slug: 'sirup-kirsche', role: 'extra', quantity: 2 }],
    });
    const services = handoverServicesFor(ctx);

    // AB freigeben + versenden (Phase 3, zweiphasig ohne Pool unter Sperre).
    const commerce = commerceServices(ctx);
    const confirmation = await commerce.confirmations.byBookingId(world.bookingId);
    expect(confirmation).not.toBeNull();
    await commerce.confirmations.approve(admin.id, confirmation!.id);
    await commerce.confirmations.send(confirmation!.id);

    // Terminverschiebung (Live-Mietzeitraum wird unter Sperre neu gelesen).
    const outbound = (
      await ctx.db
        .select()
        .from(appointments)
        .where(eq(appointments.id, world.outboundAppointmentId))
    )[0]!;
    await services.scheduling.reschedule(admin.id, outbound.id, {
      startAt: new Date(outbound.startAt!.getTime() + 2 * HOURS),
      endAt: null,
      expectedVersion: outbound.version,
    });

    await services.handover.ensureForBooking(world.bookingId, admin.id);
    const slots = await services.assignments.slotsForBooking(world.bookingId);
    const slot = slots[0]!;
    const m1 = await machineByCode(ctx.db, 'MR-10-01-01');
    const m2 = await machineByCode(ctx.db, 'MR-10-01-02');
    await services.assignments.assign(admin.id, effective, slot.id, m1.id, null);
    await services.assignments.prepare(admin.id, slot.id);
    await services.assignments.unprepare(admin.id, slot.id);
    await services.assignments.assign(admin.id, effective, slot.id, m2.id, null); // Wechsel
    await services.assignments.release(admin.id, slot.id);
    await services.assignments.assign(admin.id, effective, slot.id, m1.id, null);
    await services.assignments.prepare(admin.id, slot.id);
    await services.assignments.refreshRiskIncidents();

    await services.handover.setRecipient(world.bookingId, { kind: 'customer' });
    await services.handover.checkMachine(admin.id, world.bookingId, slot.id);
    await services.handover.addPhoto(admin.id, world.bookingId, slot.id, {
      bytes: pngBytes(),
      mimeType: 'image/png',
    });
    await services.handover.sign(admin.id, world.bookingId, 'customer', pngBytes());
    await services.handover.sign(admin.id, world.bookingId, 'staff', pngBytes());
    const finalized = await services.handover.finalize(admin.id, world.bookingId);
    expect(finalized.handover.status).toBe('finalized');

    // Storno eines ZWEITEN Vorgangs mit aktiver Zuordnung (systemseitiges Lösen).
    const other = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 20 * DAYS),
      to: new Date(Date.now() + 22 * DAYS),
    });
    await services.handover.ensureForBooking(other.bookingId, admin.id);
    const otherSlot = (await services.assignments.slotsForBooking(other.bookingId))[0]!;
    await services.assignments.assign(admin.id, effective, otherSlot.id, m2.id, null);
    await services.assignments.prepare(admin.id, otherSlot.id);
    await processServiceFor(ctx).cancel(other.processId, adminVisibilityCtx());
    await services.assignments.refreshRiskIncidents(); // systemseitiges Lösen
    const released = await services.assignments.slotsForBooking(other.bookingId);
    expect(released[0]?.machine).toBeNull();
    expect(ctx.pool.totalCount).toBe(1);
  });
});
