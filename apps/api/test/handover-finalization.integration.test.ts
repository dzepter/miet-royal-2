/**
 * Phase-6-Pflichttests 71–83 (Order §65): Folgen der Finalisierung
 * (issued, Vermietet, Standort Kunde/Vorgang, Terminabschluss, Rückgabe
 * offen, Vorgang offen, Konsistenz), Storage-/PDF-Fehler ohne halben
 * Zustand, sicherer Retry, erneute Problemprüfung und neue
 * Override-Bestätigung bei geänderter Lage.
 */
import {
  appointments,
  inventoryMovements,
  machineAssignments,
  processes,
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
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { machineByCode, resetWarehouse } from './warehouse-helpers.ts';
import { HandoverService } from '../src/handover/handover-service.ts';
import { DocumentService } from '../src/commerce/document-service.ts';
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
  const appointmentRows = await ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, bookingId));
  const movements = await ctx.db
    .select()
    .from(inventoryMovements)
    .where(eq(inventoryMovements.kind, 'issue'));
  const docs = await ctx.pool.query(
    `SELECT count(*)::int AS n FROM documents WHERE booking_id = $1`,
    [bookingId],
  );
  const machine =
    assignmentRows[0]?.machineId === undefined || assignmentRows[0].machineId === null
      ? null
      : (
          await ctx.pool.query(`SELECT status, location_kind FROM machines WHERE id = $1`, [
            assignmentRows[0].machineId,
          ])
        ).rows[0];
  return {
    assignmentStatuses: assignmentRows.map((row) => row.status),
    appointmentStatuses: Object.fromEntries(appointmentRows.map((row) => [row.kind, row.status])),
    movementCount: movements.length,
    documentCount: docs.rows[0].n as number,
    machine,
  };
}

describe('71.–78. Folgen der Finalisierung', () => {
  it('71.–74./76.–78. Selbstabholung: issued, Vermietet, Kunde – Vorgang, Abholtermin abgeschlossen, Rückgabe offen, Vorgang offen', async () => {
    const { admin } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    const detail = await handover.finalize(admin.id, world.bookingId);
    const state = await snapshot(world.bookingId);
    expect(state.assignmentStatuses).toEqual(['issued']);
    expect(state.machine).toEqual({ status: 'rented', location_kind: 'customer' });
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    expect(machine.locationKind).toBe('customer');
    expect(machine.locationNote).toBe(detail.booking.processNumber); // Anzeige: „Kunde – MR-…“
    expect(state.appointmentStatuses).toEqual({ pickup: 'completed', return: 'scheduled' });
    const process = (
      await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
    )[0]!;
    expect(process.mainStatus).toBe('open');
    expect(state.movementCount).toBe(2);
    expect(state.documentCount).toBe(2);
    expect(detail.handover.status).toBe('finalized');
    expect(detail.handover.finalizedAt).not.toBeNull();
    // Die Maschinenliste zeigt den Vorgangsbezug statt einer Kundenadresse.
    expect(machine.locationNote).not.toContain('Lieferweg');
  });

  it('75. Lieferung: Liefertermin wird abgeschlossen, Rückgabe bleibt offen', async () => {
    const { admin } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id, { fulfillment: 'delivery' });
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-02']);
    await handover.finalize(admin.id, world.bookingId);
    const state = await snapshot(world.bookingId);
    expect(state.appointmentStatuses).toEqual({ delivery: 'completed', return: 'scheduled' });
  });

  it('Der manuelle Kalender-Abschluss umgeht die Übergabe nicht (Order §44)', async () => {
    const { admin, cookie } = await adminSession();
    const { scheduling } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id, { assignProcessTo: admin.id });
    const entry = await scheduling.entryById(world.outboundAppointmentId);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/appointments/${world.outboundAppointmentId}/complete`,
      headers: { cookie },
      payload: { expectedVersion: entry.version },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain('Übergabeprozess');
    // Rückgabetermine bleiben (bis Phase 7) intern abschließbar.
    const returnEntry = await scheduling.entryById(world.returnAppointmentId);
    const returnResponse = await ctx.app.inject({
      method: 'POST',
      url: `/staff/appointments/${world.returnAppointmentId}/complete`,
      headers: { cookie },
      payload: { expectedVersion: returnEntry.version },
    });
    expect(returnResponse.statusCode).toBe(200);
  });
});

describe('79.–81. Externe Fehler und Retry', () => {
  function servicesWithStorage(storage: StorageProvider) {
    const base = handoverServicesFor(ctx);
    const documentService = new DocumentService(ctx.db, storage);
    const handover = new HandoverService(
      ctx.db,
      storage,
      base.assignments,
      base.inventory,
      base.machineService,
      documentService,
      base.productService,
      base.scheduling,
    );
    return { ...base, documentService, handover };
  }

  it('79./81. Storage-Fehler beim Dokument-Upload → keine halb abgeschlossene Ausgabe; Retry gelingt', async () => {
    const { admin } = await adminSession();
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    const before = await snapshot(world.bookingId);
    const failing: StorageProvider = {
      put: async (key, data, options) => {
        if (key.startsWith('documents/')) throw new Error('S3 nicht erreichbar');
        await ctx.storage.put(key, data, options);
      },
      get: (key) => ctx.storage.get(key),
      exists: (key) => ctx.storage.exists(key),
      delete: (key) => ctx.storage.delete(key),
    };
    const broken = servicesWithStorage(failing);
    await expect(broken.handover.finalize(admin.id, world.bookingId)).rejects.toThrow(
      'S3 nicht erreichbar',
    );
    const after = await snapshot(world.bookingId);
    expect(after).toEqual(before);
    expect((await broken.handover.detail(world.bookingId)).handover.status).toBe('draft');
    // Retry mit funktionierendem Storage.
    const healthy = handoverServicesFor(ctx);
    const detail = await healthy.handover.finalize(admin.id, world.bookingId);
    expect(detail.handover.status).toBe('finalized');
    const state = await snapshot(world.bookingId);
    expect(state.movementCount).toBe(2);
    expect(state.documentCount).toBe(2);
    expect(state.assignmentStatuses).toEqual(['issued']);
  });

  it('R1. Änderung zwischen PDF-Rendern und Transaktion → Abbruch ohne halben Zustand, Retry gelingt', async () => {
    const { admin } = await adminSession();
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    const plain = handoverServicesFor(ctx);
    const before = await snapshot(world.bookingId);
    let mutated = false;
    const racing: StorageProvider = {
      put: async (key, data, options) => {
        await ctx.storage.put(key, data, options);
        if (!mutated && key.startsWith('documents/delivery-notes/')) {
          mutated = true;
          // Parallele Mengenänderung NACH dem Rendern, VOR der Transaktion.
          const detail = await plain.handover.detail(world.bookingId);
          const straws = detail.deliveryNote.items.find((item) =>
            item.description.includes('Strohhalme'),
          )!;
          await plain.handover.updateItemQuantity(world.bookingId, straws.id, 0);
        }
      },
      get: (key) => ctx.storage.get(key),
      exists: (key) => ctx.storage.exists(key),
      delete: (key) => ctx.storage.delete(key),
    };
    const racy = servicesWithStorage(racing);
    await expect(racy.handover.finalize(admin.id, world.bookingId)).rejects.toThrow(
      /zwischenzeitlich geändert/,
    );
    expect(mutated).toBe(true);
    expect(await snapshot(world.bookingId)).toEqual(before);
    expect((await plain.handover.detail(world.bookingId)).handover.status).toBe('draft');
    // Retry rendert die aktuellen Daten und gelingt.
    const detail = await plain.handover.finalize(admin.id, world.bookingId);
    expect(detail.handover.status).toBe('finalized');
    const state = await snapshot(world.bookingId);
    expect(state.documentCount).toBe(2);
    expect(state.movementCount).toBe(1); // Strohhalme = 0 → nur Becher ausgegeben
    expect(state.assignmentStatuses).toEqual(['issued']);
  });

  it('80. PDF-/Provider-Fehler vor dem Business-Commit → kein Fachzustand, keine Dokumente', async () => {
    const { admin } = await adminSession();
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    const before = await snapshot(world.bookingId);
    const base = handoverServicesFor(ctx);
    const brokenPdf = new HandoverService(
      ctx.db,
      ctx.storage,
      base.assignments,
      base.inventory,
      base.machineService,
      base.documentService,
      base.productService,
      base.scheduling,
      { existingDamagesFor: () => Promise.reject(new Error('Schadensquelle nicht erreichbar')) },
    );
    await expect(brokenPdf.finalize(admin.id, world.bookingId)).rejects.toThrow('Schadensquelle');
    expect(await snapshot(world.bookingId)).toEqual(before);
    expect((await base.handover.detail(world.bookingId)).handover.status).toBe('draft');
  });
});

describe('82.–83. Erneute Problemprüfung vor der Finalisierung', () => {
  it('82. Eine seit der Vorbereitung problematisch gewordene Maschine blockiert die Finalisierung', async () => {
    const { admin } = await adminSession();
    const { handover, machineService } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    await machineService.setStatus(machine.id, 'repair');
    const detail = await handover.detail(world.bookingId);
    expect(detail.slots[0]!.overrideStale).toBe(true);
    expect(detail.blockers.join(' ')).toContain('Problemlage');
    await expect(handover.finalize(admin.id, world.bookingId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect((await snapshot(world.bookingId)).assignmentStatuses).toEqual(['prepared']);
  });

  it('83. Ein alter Override deckt eine wesentlich geänderte Problemlage nicht ab – neue Bestätigung nötig', async () => {
    const { admin, effective } = await adminSession();
    const { handover, machineService, assignments } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const from = new Date(Date.now() + 2 * DAYS);
    const to = new Date(Date.now() + 4 * DAYS);
    const world = await scheduledBooking(ctx, admin.id, { from, to });
    const machine = await machineByCode(ctx.db, 'MR-10-01-03');
    await machineService.setStatus(machine.id, 'cleaning');
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    await assignments.assign(admin.id, effective, slot.id, machine.id, {
      reason: 'Reinigung ist bis morgen fertig.',
    });
    await assignments.prepare(admin.id, slot.id);
    await handover.setRecipient(world.bookingId, { kind: 'customer' });
    await handover.checkMachine(admin.id, world.bookingId, slot.id);
    await handover.addPhoto(admin.id, world.bookingId, slot.id, {
      bytes: new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64',
        ),
      ),
      mimeType: 'image/png',
    });
    await handover.sign(
      admin.id,
      world.bookingId,
      'customer',
      new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64',
        ),
      ),
    );
    await handover.sign(
      admin.id,
      world.bookingId,
      'staff',
      new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
          'base64',
        ),
      ),
    );
    expect((await handover.detail(world.bookingId)).blockers).toEqual([]);
    // Wesentliche Änderung: zusätzlich eine Sperre im Mietzeitraum.
    await machineService.createBlock(machine.id, admin.id, {
      startsAt: new Date(from.getTime() + 1 * HOURS),
      endsAt: new Date(from.getTime() + 3 * HOURS),
      reason: 'Kurzfristige Wartung',
    });
    const stale = await handover.detail(world.bookingId);
    expect(stale.slots[0]!.overrideStale).toBe(true);
    await expect(handover.finalize(admin.id, world.bookingId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // Neue bewusste Bestätigung deckt die neue Lage ab → Finalisierung möglich.
    await assignments.assign(admin.id, effective, slot.id, machine.id, {
      reason: 'Wartung verschoben, abgesprochen.',
    });
    await assignments.prepare(admin.id, slot.id);
    await handover.checkMachine(admin.id, world.bookingId, slot.id);
    const fresh = await handover.detail(world.bookingId);
    expect(fresh.slots[0]!.overrideStale).toBe(false);
    const finalized = await handover.finalize(admin.id, world.bookingId);
    expect(finalized.handover.status).toBe('finalized');
  });
});

describe('R6. Unveränderlichkeit nach Abschluss', () => {
  it('R6. Kein Mutator ändert eine abgeschlossene Übergabe (Mengen, Empfänger, Prüfung, Foto, Abholperson, Zusatzposition)', async () => {
    const { admin } = await adminSession();
    const { handover, productService } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    await handover.setRepresentative(admin.id, world.bookingId, {
      firstName: 'Anna',
      lastName: 'Abholung',
      phone: '+49 6131 000000',
    });
    const detail = await handover.finalize(admin.id, world.bookingId);
    expect(detail.handover.status).toBe('finalized');
    const slotId = detail.slots[0]!.id;
    const itemId = detail.deliveryNote.items[0]!.id;
    const syrup = await productService.getProductBySlug('sirup-kirsche');
    const conflict = { code: 'CONFLICT' };
    await expect(handover.updateItemQuantity(world.bookingId, itemId, 5)).rejects.toMatchObject(
      conflict,
    );
    await expect(
      handover.addAddition(admin.id, world.bookingId, syrup.id, 1),
    ).rejects.toMatchObject(conflict);
    await expect(
      handover.setRecipient(world.bookingId, { kind: 'other', name: 'Später Vertreter' }),
    ).rejects.toMatchObject(conflict);
    await expect(handover.checkMachine(admin.id, world.bookingId, slotId)).rejects.toMatchObject(
      conflict,
    );
    await expect(
      handover.addPhoto(admin.id, world.bookingId, slotId, {
        bytes: pngBytes(),
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject(conflict);
    await expect(
      handover.setRepresentative(admin.id, world.bookingId, {
        firstName: 'Neu',
        lastName: 'Nachher',
        phone: '+49 6131 111111',
      }),
    ).rejects.toMatchObject(conflict);
    await expect(handover.clearRepresentative(world.bookingId)).rejects.toMatchObject(conflict);
    await expect(
      handover.sign(admin.id, world.bookingId, 'customer', pngBytes()),
    ).rejects.toMatchObject(conflict);
    // Gelöschte Telefonnummer bleibt gelöscht, Empfänger/Unterschrift unverändert.
    const after = await handover.detail(world.bookingId);
    expect(after.representative?.phone).toBeNull();
    expect(after.handover.recipientName).toBe(detail.handover.recipientName);
    expect(after.signatures.customer?.signedAt).toBe(detail.signatures.customer?.signedAt);
    expect(after.machines[0]!.photos).toHaveLength(1);
  });
});

describe('R15. Tatsächliche Ausgabezeit', () => {
  it('R15. Nur bei Abweichung vom Abschluss gespeichert – keine doppelte Zeitinfo', async () => {
    const { admin } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const now = new Date();
    const a = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, a.bookingId, ['MR-10-01-01']);
    const same = await handover.finalize(
      admin.id,
      a.bookingId,
      { actualIssueAt: new Date(now.getTime() + 10_000) },
      now,
    );
    expect(same.handover.actualIssueAt).toBeNull();
    const b = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, b.bookingId, ['MR-10-01-02']);
    const earlier = new Date(now.getTime() - 2 * HOURS);
    const deviating = await handover.finalize(
      admin.id,
      b.bookingId,
      { actualIssueAt: earlier },
      now,
    );
    expect(deviating.handover.actualIssueAt).toBe(earlier.toISOString());
  });
});

describe('R16.–R18. Vorbereitung, Unterschrift-Bild, Evidenz', () => {
  it('R16. Ohne „vorbereitet“ blockiert die Finalisierung verständlich – kein Upload, kein Fachzustand', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    await assignments.assign(admin.id, effective, slot.id, machine.id, null); // kein prepare
    await handover.setRecipient(world.bookingId, { kind: 'customer' });
    await handover.checkMachine(admin.id, world.bookingId, slot.id);
    await handover.addPhoto(admin.id, world.bookingId, slot.id, {
      bytes: pngBytes(),
      mimeType: 'image/png',
    });
    await handover.sign(admin.id, world.bookingId, 'customer', pngBytes());
    await handover.sign(admin.id, world.bookingId, 'staff', pngBytes());
    const detail = await handover.detail(world.bookingId);
    expect(detail.blockers.some((b) => b.includes('vorbereitet'))).toBe(true);
    await expect(handover.finalize(admin.id, world.bookingId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const state = await snapshot(world.bookingId);
    expect(state.documentCount).toBe(0);
    expect(state.movementCount).toBe(0);
    expect(state.assignmentStatuses).toEqual(['assigned']);
  });

  it('R17. Eine strukturell plausible, aber nicht dekodierbare Unterschrift wird beim Speichern abgelehnt – kein Prozessabbruch, kein halber Zustand', async () => {
    const { admin } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    const header = Buffer.from(pngBytes()).subarray(0, 33); // Signatur + IHDR
    const idat = Buffer.concat([
      Buffer.from([0, 0, 0, 8]),
      Buffer.from('IDAT', 'latin1'),
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
      Buffer.from([0, 0, 0, 0]),
    ]);
    const iend = Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('IEND', 'latin1'),
      Buffer.from([0xae, 0x42, 0x60, 0x82]),
    ]);
    const corrupt = Buffer.concat([header, idat, iend, Buffer.alloc(16)]);
    // pdfkit würde ein solches Bild asynchron (prozessabbrechend) verwerfen –
    // die Unterschrift wird deshalb bereits beim Speichern abgelehnt.
    const before = await snapshot(world.bookingId);
    await expect(
      handover.sign(admin.id, world.bookingId, 'customer', new Uint8Array(corrupt)),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await snapshot(world.bookingId)).toEqual(before);
    const detail = await handover.detail(world.bookingId);
    expect(detail.handover.status).toBe('draft');
    expect(detail.signatures.customer?.signedAt).toBeDefined(); // alte gültige Unterschrift bleibt
    const finalized = await handover.finalize(admin.id, world.bookingId);
    expect(finalized.handover.status).toBe('finalized');
  });

  it('R18. Lösen oder Maschinenwechsel setzt Prüfung und Gesamtfoto zurück – erneute aktive Prüfung nötig', async () => {
    const { admin, effective } = await adminSession();
    const { assignments, handover } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const m1 = await machineByCode(ctx.db, 'MR-10-01-01');
    const m2 = await machineByCode(ctx.db, 'MR-10-01-02');
    await assignments.assign(admin.id, effective, slot.id, m1.id, null);
    await assignments.prepare(admin.id, slot.id);
    await handover.checkMachine(admin.id, world.bookingId, slot.id);
    await handover.addPhoto(admin.id, world.bookingId, slot.id, {
      bytes: pngBytes(),
      mimeType: 'image/png',
    });
    expect((await handover.detail(world.bookingId)).machines[0]?.checked).toBe(true);
    // Lösen → wieder dieselbe Maschine: Prüfung/Foto sind weg.
    await assignments.release(admin.id, slot.id);
    await assignments.assign(admin.id, effective, slot.id, m1.id, null);
    let detail = await handover.detail(world.bookingId);
    expect(detail.machines[0]?.checked).toBe(false);
    expect(detail.machines[0]?.photos).toHaveLength(0);
    expect(detail.blockers.some((b) => b.includes('Übergabeprüfung noch nicht bestätigt'))).toBe(
      true,
    );
    expect(detail.blockers.some((b) => b.includes('Gesamtfoto fehlt'))).toBe(true);
    // Maschinenwechsel entfernt die Evidenz ebenfalls.
    await handover.checkMachine(admin.id, world.bookingId, slot.id);
    await handover.addPhoto(admin.id, world.bookingId, slot.id, {
      bytes: pngBytes(),
      mimeType: 'image/png',
    });
    await assignments.assign(admin.id, effective, slot.id, m2.id, null);
    detail = await handover.detail(world.bookingId);
    expect(detail.machines[0]?.checked).toBe(false);
    expect(detail.machines[0]?.photos).toHaveLength(0);
  });
});
