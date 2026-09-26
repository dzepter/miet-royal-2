/**
 * Phase-7-Pflichttests 95–110 (Order §76): Folgen der Finalisierung
 * (Assignments returned, Maschinen Reinigung, Standort Lager, Rückgabetermin
 * completed, Vorgang offen, actual_return_at, Lager konsistent, aktuelle
 * Schäden, Fehlteil-Follow-ups, Return-Paket versandbereit ohne echten
 * Versand), Double-Submit, Storage-/PDF-Fehler ohne halben Zustand, sicherer
 * Retry, Kalender-Sperre für Rückgabetermine ausgegebener Buchungen.
 */
import {
  appointments,
  inventoryMovements,
  machineAssignments,
  processes,
  rentalReturns,
} from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
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
import { schedulingServiceFor, truncateSchedulingTables } from './scheduling-helpers.ts';
import { machineByCode, resetWarehouse } from './warehouse-helpers.ts';
import {
  handoverServicesFor,
  scheduledBooking,
  truncateHandoverTables,
} from './handover-helpers.ts';
import { DocumentService } from '../src/commerce/document-service.ts';
import { DamageService } from '../src/returns/damage-service.ts';
import { ReturnService } from '../src/returns/return-service.ts';
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

async function snapshot(bookingId: string) {
  const assignmentRows = await ctx.db
    .select()
    .from(machineAssignments)
    .where(eq(machineAssignments.bookingId, bookingId));
  const returnRows = await ctx.db
    .select()
    .from(rentalReturns)
    .where(eq(rentalReturns.bookingId, bookingId));
  const movements = await ctx.db
    .select()
    .from(inventoryMovements)
    .where(eq(inventoryMovements.kind, 'return'));
  const docs = await ctx.pool.query(
    `SELECT count(*)::int AS n FROM documents WHERE type = 'return_protocol'`,
  );
  const packets = await ctx.pool.query(
    `SELECT count(*)::int AS n FROM delivery_packets WHERE kind = 'return_completed'`,
  );
  const machine = await machineByCode(ctx.db, 'MR-10-01-01');
  return {
    assignmentStatuses: assignmentRows.map((row) => row.status),
    returnStatus: returnRows[0]?.status ?? null,
    movements: movements.length,
    documents: docs.rows[0].n as number,
    packets: packets.rows[0].n as number,
    machineStatus: machine.status,
  };
}

/** ReturnService mit austauschbarem Storage/Schadensdienst (Fehlerinjektion). */
function returnServiceWith(overrides: { storage?: StorageProvider; damages?: DamageService }) {
  const base = handoverServicesFor(ctx);
  const storage = overrides.storage ?? ctx.storage;
  const damages = overrides.damages ?? base.damages;
  return new ReturnService(
    ctx.db,
    storage,
    base.inventory,
    base.machineService,
    new DocumentService(ctx.db, storage),
    base.scheduling,
    damages,
    base.assignments,
  );
}

describe('95.–105. Folgen der Finalisierung', () => {
  it('95./96./97./98./99./100. Assignments returned, Maschinen Reinigung im Lager, Rückgabetermin completed, Vorgang offen, tatsächliche Rückgabezeit gesetzt', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id, {
      machineCodes: ['MR-10-01-01', 'MR-10-01-02'],
    });
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const before = new Date();
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    const assignmentRows = await ctx.db
      .select()
      .from(machineAssignments)
      .where(eq(machineAssignments.bookingId, world.bookingId));
    expect(
      assignmentRows.every((row) => row.status === 'returned' && row.returnedAt !== null),
    ).toBe(true);
    for (const code of ['MR-10-01-01', 'MR-10-01-02']) {
      const machine = await machineByCode(ctx.db, code);
      expect(machine.status).toBe('cleaning');
      expect(machine.locationKind).toBe('warehouse');
      expect(machine.locationNote).toBeNull();
      expect(machine.cleaningSince).not.toBeNull();
    }
    const appointment = (
      await ctx.db.select().from(appointments).where(eq(appointments.id, world.returnAppointmentId))
    )[0]!;
    expect(appointment.status).toBe('completed');
    expect(appointment.completedBy).toBe(admin.id);
    const process = (
      await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
    )[0]!;
    expect(process.mainStatus).toBe('open');
    expect(finalized.return.actualReturnAt).not.toBeNull();
    expect(finalized.return.actualReturnAt).toBe(finalized.return.originalActualReturnAt);
    expect(new Date(finalized.return.actualReturnAt!).getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
    expect(finalized.machines.every((m) => m.returnedAt !== null)).toBe(true);
    expect(finalized.nextAction).toBe('done');
  });

  it('100. Vor der Finalisierung korrigierte Zeit wird übernommen; danach separat korrigiert – Original und PDF bleiben', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const earlier = new Date(Date.now() - 2 * 3_600_000);
    earlier.setMilliseconds(0);
    const draft = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/returns/${world.bookingId}/actual-return-time`,
      headers: { cookie },
      payload: { actualReturnAt: earlier.toISOString() },
    });
    expect(draft.statusCode).toBe(200);
    const future = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/returns/${world.bookingId}/actual-return-time`,
      headers: { cookie },
      payload: { actualReturnAt: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(future.statusCode).toBe(400);
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    expect(finalized.return.actualReturnAt).toBe(earlier.toISOString());
    expect(finalized.return.originalActualReturnAt).toBe(earlier.toISOString());
    const document = await services.documentService.byId(finalized.return.protocolDocumentId!);
    const corrected = new Date(Date.now() - 3 * 3_600_000);
    corrected.setMilliseconds(0);
    const correction = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/returns/${world.bookingId}/actual-return-time`,
      headers: { cookie },
      payload: { actualReturnAt: corrected.toISOString() },
    });
    expect(correction.statusCode).toBe(200);
    const view = await services.returns.detail(world.bookingId);
    expect(view.return.actualReturnAt).toBe(corrected.toISOString());
    expect(view.return.correctedActualReturnAt).toBe(corrected.toISOString());
    expect(view.return.originalActualReturnAt).toBe(earlier.toISOString());
    expect(view.return.correctedAt).not.toBeNull();
    expect((await services.documentService.byId(document.id)).sha256).toBe(document.sha256);
  });

  it('101./102./103./104./105. Lager konsistent, aktuelle Schäden und Fehlteil-Follow-ups erzeugt, Paket versandbereit – nie „versendet“ ohne Adapter', async () => {
    const { admin, cookie } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id, {
      selections: [
        { slug: 'sirup-kirsche', role: 'free', quantity: 1 },
        { slug: 'sirup-kirsche', role: 'extra', quantity: 3 },
      ],
      stock: 30,
    });
    const rm = detail.machines[0]!;
    const syrup = detail.items.find((i) => i.kind === 'commission')!;
    await services.returns.setReturnedQuantity(admin.id, world.bookingId, syrup.id, 2);
    await services.returns.addMissingCase(admin.id, world.bookingId, rm.id, {
      accessoryType: 'drip_tray',
      missingQuantity: 1,
    });
    const { damageId } = await services.returns.addDamage(admin.id, world.bookingId, rm.id, {
      severity: 'light',
      description: 'Kleiner Kratzer',
      markers: [POINT_MARKER],
    });
    await services.damages.addPhoto(admin.id, damageId, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    await readyReturn(ctx, admin.id, services, world.bookingId, { skipAccessories: true });
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    // Lager: letzte Bewegung je Artikel = aktueller Bestand.
    const ledger = await ctx.pool.query<{
      item_id: string;
      resulting_stock: number;
      current_stock: number;
    }>(
      `SELECT DISTINCT ON (m.item_id) m.item_id, m.resulting_stock, i.current_stock
       FROM inventory_movements m JOIN inventory_items i ON i.id = m.item_id
       ORDER BY m.item_id, m.created_at DESC, m.id DESC`,
    );
    expect(ledger.rows.every((row) => row.resulting_stock === row.current_stock)).toBe(true);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    expect(await services.damages.currentForMachine(machine.id)).toHaveLength(1);
    expect(finalized.machines[0]!.missingCases[0]!.followUpOpenedAt).not.toBeNull();
    const packets = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${world.processId}/delivery-packets`,
      headers: { cookie },
    });
    expect(packets.statusCode).toBe(200);
    const returnPacket = (
      packets.json().packets as {
        kind: string;
        status: string;
        sentAt: string | null;
        documentIds: string[];
      }[]
    ).find((p) => p.kind === 'return_completed')!;
    expect(returnPacket).toMatchObject({ status: 'ready', sentAt: null });
    expect(returnPacket.documentIds).toEqual([finalized.return.protocolDocumentId]);
    const sent = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM delivery_packets WHERE status = 'sent'`,
    );
    expect(sent.rows[0].n).toBe(0);
  });
});

describe('106.–110. Idempotenz, Fehlerfälle, Retry, Kalender-Sperre', () => {
  it('106. Double-Submit (gleiche und getrennte Instanzen) → genau ein finaler Return, ein PDF, ein Paket', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const results = await Promise.allSettled([
      services.returns.finalize(admin.id, world.bookingId),
      services.returns.finalize(admin.id, world.bookingId),
      handoverServicesFor(ctx).returns.finalize(admin.id, world.bookingId),
      handoverServicesFor(ctx).returns.finalize(admin.id, world.bookingId),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const finalizedAts = new Set(
      results.map((r) => (r.status === 'fulfilled' ? r.value.return.finalizedAt : null)),
    );
    expect(finalizedAts.size).toBe(1);
    const state = await snapshot(world.bookingId);
    expect(state).toMatchObject({
      returnStatus: 'finalized',
      documents: 1,
      packets: 1,
      machineStatus: 'cleaning',
    });
    const assignments = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM machine_assignments WHERE booking_id = $1 AND status = 'returned'`,
      [world.bookingId],
    );
    expect(assignments.rows[0].n).toBe(1);
  });

  it('107./109. Storage-Fehler beim PDF-Upload → kein halber Return; Retry mit funktionierendem Storage gelingt', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const failing: StorageProvider = {
      put: async (key, data, options) => {
        if (key.startsWith('documents/return-protocols/'))
          throw new Error('Storage nicht erreichbar');
        return ctx.storage.put(key, data, options);
      },
      get: (key) => ctx.storage.get(key),
      exists: (key) => ctx.storage.exists(key),
      delete: (key) => ctx.storage.delete(key),
    };
    await expect(
      returnServiceWith({ storage: failing }).finalize(admin.id, world.bookingId),
    ).rejects.toThrow('Storage nicht erreichbar');
    expect(await snapshot(world.bookingId)).toEqual({
      assignmentStatuses: ['issued'],
      returnStatus: 'draft',
      movements: 0,
      documents: 0,
      packets: 0,
      machineStatus: 'rented',
    });
    const retry = await services.returns.finalize(admin.id, world.bookingId);
    expect(retry.return.status).toBe('finalized');
    expect(await snapshot(world.bookingId)).toMatchObject({
      assignmentStatuses: ['returned'],
      documents: 1,
      packets: 1,
      machineStatus: 'cleaning',
    });
  });

  it('108./109. PDF-Fehler (nicht einbettbares Foto) → verständlicher Fehler, kein halber Return; Retry sicher', async () => {
    const { admin } = await adminSession();
    const { world, services, detail } = await startedReturn(ctx, admin.id);
    const { damageId } = await services.returns.addDamage(
      admin.id,
      world.bookingId,
      detail.machines[0]!.id,
      {
        severity: 'light',
        description: 'Foto-Fehlerfall',
        markers: [POINT_MARKER],
      },
    );
    await services.damages.addPhoto(admin.id, damageId, {
      bytes: jpegBytes(),
      mimeType: 'image/jpeg',
    });
    await readyReturn(ctx, admin.id, services, world.bookingId);
    class BrokenPhotos extends DamageService {
      override photosBytesFor(): Promise<Uint8Array[]> {
        return Promise.resolve([new Uint8Array(Buffer.from('kein-bild'))]);
      }
    }
    await expect(
      returnServiceWith({ damages: new BrokenPhotos(ctx.db, ctx.storage) }).finalize(
        admin.id,
        world.bookingId,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('Foto') as string,
    });
    expect(await snapshot(world.bookingId)).toMatchObject({
      assignmentStatuses: ['issued'],
      returnStatus: 'draft',
      documents: 0,
      packets: 0,
      machineStatus: 'rented',
    });
    const retry = await services.returns.finalize(admin.id, world.bookingId);
    expect(retry.return.status).toBe('finalized');
    expect(await snapshot(world.bookingId)).toMatchObject({ documents: 1, packets: 1 });
  });

  it('110. Manueller Kalenderabschluss kann die Rückgabe-Finalisierung nicht umgehen; nicht ausgegebene Buchungen bleiben abschließbar', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    const scheduling = schedulingServiceFor(ctx);
    let appointment = (
      await ctx.db.select().from(appointments).where(eq(appointments.id, world.returnAppointmentId))
    )[0]!;
    await ctx.pool.query('UPDATE appointments SET assigned_user_id = $1 WHERE id = $2', [
      admin.id,
      appointment.id,
    ]);
    appointment = (
      await ctx.db.select().from(appointments).where(eq(appointments.id, appointment.id))
    )[0]!;
    await expect(
      scheduling.complete(admin.id, appointment.id, appointment.version),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Rückgabeprozess') as string,
    });
    expect(
      (await ctx.db.select().from(appointments).where(eq(appointments.id, appointment.id)))[0]!
        .status,
    ).toBe('scheduled');
    // Nur bestätigt (nichts ausgegeben): der neutrale interne Abschluss bleibt möglich.
    const confirmed = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 20 * 86_400_000),
      to: new Date(Date.now() + 22 * 86_400_000),
    });
    await ctx.pool.query('UPDATE appointments SET assigned_user_id = $1 WHERE id = $2', [
      admin.id,
      confirmed.returnAppointmentId,
    ]);
    const plain = (
      await ctx.db
        .select()
        .from(appointments)
        .where(eq(appointments.id, confirmed.returnAppointmentId))
    )[0]!;
    const completed = await scheduling.complete(admin.id, plain.id, plain.version);
    expect(completed.status).toBe('completed');
    // Die Rückgabe-Finalisierung ist die autoritative Completion.
    await readyReturn(ctx, admin.id, services, world.bookingId);
    await services.returns.finalize(admin.id, world.bookingId);
    expect(
      (await ctx.db.select().from(appointments).where(eq(appointments.id, appointment.id)))[0]!
        .status,
    ).toBe('completed');
  });
});

describe('Review-Härtung (Order §47): alle ausgegebenen Zuordnungen müssen Teil der Rückgabe sein', () => {
  it('R4. Eine nach dem Rückgabestart zusätzlich ausgegebene Zuordnung blockiert die Finalisierung – kein halber Zustand', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const other = await machineByCode(ctx.db, 'MR-10-01-02');
    // Simuliert eine (im regulären Ablauf nicht erreichbare) weitere ausgegebene Zuordnung.
    await ctx.pool.query(
      `INSERT INTO machine_assignments (booking_id, process_id, product_id, slot_no, machine_id, status, issued_at)
       SELECT booking_id, process_id, product_id, 99, $2, 'issued', now() FROM machine_assignments
       WHERE booking_id = $1 AND slot_no = 1`,
      [world.bookingId, other.id],
    );
    await expect(services.returns.finalize(admin.id, world.bookingId)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('stimmen nicht mehr mit der Rückgabe überein'),
    });
    const view = await services.returns.detail(world.bookingId);
    expect(view.return.status).toBe('draft');
    expect(await services.returns.documentsFor(world.bookingId)).toEqual([]);
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('rented');
  });
});
