/**
 * Phase 18 – Abnahmeszenario F „Konflikt/Override“ (Order Szenario 6; systemweit A/B/C;
 * Karte C §3.2/§3.3/§3.9, §4.2, Lücken §6.1-5/-7, Hypothese H2).
 *
 * Geschäftskritische Konflikttypen (Begründung Karte C §3.9: physische Maschinenausgabe,
 * operative Zuständigkeit für Kundenstopps, Terminstand):
 * - F1 Maschinen-Override online: Kollision ⇒ 409 ohne Override; ohne Recht 403; ohne Grund 400;
 *   mit Recht + Grund protokolliert (genau eine aktive Override-Zeile je Zuordnung, ersetzte
 *   archiviert); harter Blocker „an anderen Vorgang ausgegeben“ nie – auch nicht für Admins.
 * - F2 Stale-Override (geänderte Problemlage) blockiert die Finalisierung; neue Bestätigung ⇒
 *   genau eine Finalisierung, Wiederholung ohne doppelten Nebeneffekt.
 * - F3 Offline-Override-Pfad beim Sync: MACHINE_UNAVAILABLE / VALIDATION / FORBIDDEN / applied.
 * - F4 Tour: Doppelstart ⇒ genau ein Start; zweite aktive Tour derselben Person ⇒ 409.
 * - F5 Konkurrierende Tour-Übernahmen mit `expectedVersion` ⇒ 200 + 409 TOUR_VERSION_CONFLICT,
 *   Stopp-Termine beim Gewinner, Live-Standort gelöscht; Beobachtung H2 dokumentiert.
 * - F6 Termin-CAS: parallele Reschedules mit derselben Version ⇒ genau einer gewinnt.
 * - F7 Integritäts-Backstop (acceptance-integrity).
 * Der CRM-Stale-PATCH-Fall ist bewusst nicht Teil dieser Datei (eigene Abnahmedatei).
 *
 * Ein Szenario, eine Welt: truncate nur in beforeAll, die Schritte bauen aufeinander auf.
 */
import {
  appointments,
  documents,
  inventoryMovements,
  machineAssignmentOverrides,
  machineAssignments,
  tourLiveLocations,
  tours,
} from '@mietroyal/database';
import { PERMISSION_KEYS, type PermissionKey } from '@mietroyal/permissions';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentStorageMismatches, integrityViolations } from './acceptance-integrity.ts';
import type { TestContext } from './auth-helpers.ts';
import {
  DAYS,
  HOURS,
  handoverServicesFor,
  initializeAllInventory,
  pngBytes,
  scheduledBooking,
} from './handover-helpers.ts';
import { settleMailJobs } from './mail-job-helpers.ts';
import { DEVICE_B, offlineHelpers, truncateOfflineWorld } from './offline-helpers.ts';
import { issuedBooking } from './return-helpers.ts';
import { createAcceptedBooking, schedulingServiceFor } from './scheduling-helpers.ts';
import {
  DRIVER_PERMISSIONS,
  DRIVER_POINT,
  PLANNER_PERMISSIONS,
  adminSession,
  apiFor,
  appointmentRow,
  bookingWithAppointments,
  createToursWorld,
  destroyToursWorld,
  getTour,
  inMinutes,
  pinMorningClockIfEvening,
  resetToursWorld,
  setLiveLocation,
  staffWith,
  todayBerlin,
  tourWithStops,
  type ToursWorld,
} from './tours-helpers.ts';
import { machineByCode } from './warehouse-helpers.ts';

let world: ToursWorld;
let ctx: TestContext;
/** Phase 17 (§27 B): abends Testuhr auf 09:00 Berlin zurück – `inMinutes(+N)` bleibt am Tourtag. */
let restoreClock: () => void = () => {};
const h = offlineHelpers(() => ctx);

let admin: { id: string };
let adminCookie: string;
let adminEffective: ReadonlySet<PermissionKey>;

interface SlotSnapshot {
  id: string;
  machine: { id: string } | null;
}

async function overridesOf(assignmentId: string) {
  return ctx.db
    .select()
    .from(machineAssignmentOverrides)
    .where(eq(machineAssignmentOverrides.assignmentId, assignmentId))
    .orderBy(asc(machineAssignmentOverrides.confirmedAt));
}

async function activeOverrides(assignmentId: string) {
  return (await overridesOf(assignmentId)).filter((row) => row.archivedAt === null);
}

async function overrideCount(): Promise<number> {
  return (await ctx.db.select().from(machineAssignmentOverrides)).length;
}

async function assignmentOf(assignmentId: string) {
  const rows = await ctx.db
    .select()
    .from(machineAssignments)
    .where(eq(machineAssignments.id, assignmentId));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function documentsOf(bookingId: string) {
  return ctx.db.select().from(documents).where(eq(documents.bookingId, bookingId));
}

async function issueMovementCount(): Promise<number> {
  return (
    await ctx.db.select().from(inventoryMovements).where(eq(inventoryMovements.kind, 'issue'))
  ).length;
}

/** HTTP-Zuweisung über die Staff-Route (Rechteprüfung serverseitig). */
async function assignViaRoute(
  cookie: string,
  bookingId: string,
  assignmentId: string,
  machineId: string,
  reason?: string,
) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/staff/handover/${bookingId}/slots/${assignmentId}/assign`,
    headers: { cookie },
    payload: {
      machineId,
      ...(reason === undefined ? {} : { override: { confirmed: true, reason } }),
    },
  });
  return { status: response.statusCode, body: response.json() as Record<string, unknown> };
}

async function handoverDetailViaRoute(bookingId: string) {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/staff/handover/${bookingId}`,
    headers: { cookie: adminCookie },
  });
  expect(response.statusCode).toBe(200);
  return (
    response.json() as {
      detail: {
        handover: { status: string };
        slots: { overrideStale: boolean; status: string }[];
        blockers: string[];
      };
    }
  ).detail;
}

async function finalizeViaRoute(bookingId: string) {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/staff/handover/${bookingId}/finalize`,
    headers: { cookie: adminCookie },
    payload: {},
  });
  return {
    status: response.statusCode,
    body: response.json() as {
      error?: { code: string };
      detail?: { finalized: boolean; handover: { status: string } };
    },
  };
}

beforeAll(async () => {
  restoreClock = pinMorningClockIfEvening();
  world = await createToursWorld();
  ctx = world.ctx;
  await resetToursWorld(world);
  await truncateOfflineWorld(ctx);
  const session = await adminSession(world);
  admin = session.admin;
  adminCookie = session.cookie;
  adminEffective = await ctx.auth.effectivePermissions(admin.id);
  await initializeAllInventory(ctx, admin.id, 20);
});
afterAll(async () => {
  await world.delayState.settle();
  await destroyToursWorld(world);
  restoreClock();
});

describe('Szenario F – Konflikt/Override (Phase 18)', () => {
  it('P18-F1. Maschinen-Override online: Kollision ⇒ 409; ohne Recht 403; ohne Grund 400; mit Recht+Grund protokolliert (eine aktive Zeile, ersetzte archiviert); ausgegebene Maschine nie – auch nicht für Admins', async () => {
    const services = handoverServicesFor(ctx);
    const from = new Date(Date.now() + 2 * DAYS);
    const to = new Date(Date.now() + 4 * DAYS);
    // Buchung B belegt Maschine X im überlappenden Zeitraum von Buchung A ⇒ Kollision.
    const bookingA = await scheduledBooking(ctx, admin.id, { from, to });
    const bookingB = await scheduledBooking(ctx, admin.id, {
      from: new Date(from.getTime() + 6 * HOURS),
      to: new Date(to.getTime() + 6 * HOURS),
    });
    await services.handover.ensureForBooking(bookingA.bookingId, admin.id);
    await services.handover.ensureForBooking(bookingB.bookingId, admin.id);
    const slotA = (await services.assignments.slotsForBooking(bookingA.bookingId))[0]!;
    const slotB = (await services.assignments.slotsForBooking(bookingB.bookingId))[0]!;
    const machineX = await machineByCode(ctx.db, 'MR-10-01-03');
    await services.assignments.assign(admin.id, adminEffective, slotB.id, machineX.id, null);
    const evaluation = await services.assignments.evaluateMachine(
      machineX.id,
      await services.assignments.assignmentById(slotA.id),
    );
    expect(evaluation.overrideRequired).toBe(true);
    expect(evaluation.hardBlocked).toBe(false);
    expect(evaluation.problems.map((p) => p.code)).toContain('collision');

    // Erkannt und sichtbar: ohne Override keine Zuweisung (409), kein stilles Umschalten.
    const collision = await assignViaRoute(adminCookie, bookingA.bookingId, slotA.id, machineX.id);
    expect(collision.status).toBe(409);
    expect((collision.body.error as { code: string }).code).toBe('CONFLICT');
    expect((await assignmentOf(slotA.id)).machineId).toBeNull();
    expect(await overrideCount()).toBe(0);

    // Ohne `machine.override_block` ⇒ 403, keine Override-Zeile.
    const plain = await h.staffWith(admin.id, h.OPERATIVE, 'PlainOnline');
    const forbidden = await assignViaRoute(
      plain.cookie,
      bookingA.bookingId,
      slotA.id,
      machineX.id,
      'Kunde wartet',
    );
    expect(forbidden.status).toBe(403);
    expect((await assignmentOf(slotA.id)).machineId).toBeNull();
    expect(await overrideCount()).toBe(0);

    // Mit Recht, aber ohne Grund ⇒ 400 (leer scheitert am Schema, nur Leerzeichen am Service).
    for (const reason of ['', '   ']) {
      const noReason = await assignViaRoute(
        adminCookie,
        bookingA.bookingId,
        slotA.id,
        machineX.id,
        reason,
      );
      expect(noReason.status).toBe(400);
    }
    expect((await assignmentOf(slotA.id)).machineId).toBeNull();
    expect(await overrideCount()).toBe(0);

    // Mit Recht + Grund ⇒ 200; genau eine aktive Override-Zeile mit Grund/Fingerprint/Bestätiger.
    const ok = await assignViaRoute(
      adminCookie,
      bookingA.bookingId,
      slotA.id,
      machineX.id,
      'Kunde B holt früher ab, telefonisch abgesprochen.',
    );
    expect(ok.status).toBe(200);
    const okSlot = ok.body.slot as {
      machine: { machineCode: string };
      override: { reason: string } | null;
    };
    expect(okSlot.machine.machineCode).toBe('MR-10-01-03');
    expect(okSlot.override?.reason).toContain('früher');
    const firstOverrides = await overridesOf(slotA.id);
    expect(firstOverrides).toHaveLength(1);
    const firstOverride = firstOverrides[0]!;
    expect(firstOverride.archivedAt).toBeNull();
    expect(firstOverride.reason).toBe('Kunde B holt früher ab, telefonisch abgesprochen.');
    expect(firstOverride.situationFingerprint).toBe(evaluation.situationFingerprint);
    expect(firstOverride.confirmedBy).toBe(admin.id);
    expect(firstOverride.machineId).toBe(machineX.id);
    expect((await assignmentOf(slotA.id)).overrideId).toBe(firstOverride.id);

    // Problemlage ändert sich (zusätzliche Sperre im Mietzeitraum): alter Override deckt sie
    // nicht; neue bewusste Bestätigung archiviert den alten – genau eine aktive Zeile.
    await services.machineService.createBlock(machineX.id, admin.id, {
      startsAt: new Date(from.getTime() + 1 * HOURS),
      endsAt: new Date(from.getTime() + 3 * HOURS),
      reason: 'Kurzfristige Wartung',
    });
    expect((await handoverDetailViaRoute(bookingA.bookingId)).slots[0]!.overrideStale).toBe(true);
    const reconfirmed = await assignViaRoute(
      adminCookie,
      bookingA.bookingId,
      slotA.id,
      machineX.id,
      'Wartung verschoben, mit Werkstatt abgesprochen.',
    );
    expect(reconfirmed.status).toBe(200);
    const allOverrides = await overridesOf(slotA.id);
    expect(allOverrides).toHaveLength(2);
    const active = await activeOverrides(slotA.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).not.toBe(firstOverride.id);
    expect(active[0]!.situationFingerprint).not.toBe(firstOverride.situationFingerprint);
    expect(allOverrides.find((row) => row.id === firstOverride.id)!.archivedAt).not.toBeNull();
    expect((await assignmentOf(slotA.id)).overrideId).toBe(active[0]!.id);
    expect((await handoverDetailViaRoute(bookingA.bookingId)).slots[0]!.overrideStale).toBe(false);

    // HARTER Blocker: Maschine Y ist an einen anderen Vorgang ausgegeben ⇒ 409 trotz Override
    // durch den Admin; Zuordnung A unverändert, Ausgabe Y unverändert.
    const issued = await issuedBooking(ctx, admin.id, {
      machineCodes: ['MR-10-01-04'],
      skipInventoryInit: true,
    });
    const machineY = await machineByCode(ctx.db, 'MR-10-01-04');
    expect(machineY.status).toBe('rented');
    const hardEvaluation = await services.assignments.evaluateMachine(
      machineY.id,
      await services.assignments.assignmentById(slotA.id),
    );
    expect(hardEvaluation.hardBlocked).toBe(true);
    expect(hardEvaluation.overrideRequired).toBe(false);
    const overridesBefore = await overrideCount();
    const hard = await assignViaRoute(
      adminCookie,
      bookingA.bookingId,
      slotA.id,
      machineY.id,
      'Trotzdem – Kunde besteht darauf.',
    );
    expect(hard.status).toBe(409);
    expect((hard.body.error as { code: string; message: string }).message).toContain(
      'nicht gleichzeitig bei zwei Kunden',
    );
    const slotAfter = await assignmentOf(slotA.id);
    expect(slotAfter.machineId).toBe(machineX.id);
    expect(slotAfter.overrideId).toBe(active[0]!.id);
    expect(await overrideCount()).toBe(overridesBefore);
    const issuedAssignment = await assignmentOf(issued.assignmentIds[0]!);
    expect(issuedAssignment.status).toBe('issued');
    expect(issuedAssignment.machineId).toBe(machineY.id);
    expect((await machineByCode(ctx.db, 'MR-10-01-04')).status).toBe('rented');
  });

  it('P18-F2. Stale-Override blockiert die Finalisierung (overrideStale-Blocker, 409); neue Bestätigung ⇒ genau eine Finalisierung, Wiederholung ohne zweiten Nebeneffekt', async () => {
    const services = handoverServicesFor(ctx);
    const from = new Date(Date.now() + 2 * DAYS);
    const to = new Date(Date.now() + 4 * DAYS);
    const booking = await scheduledBooking(ctx, admin.id, { from, to });
    const machineZ = await machineByCode(ctx.db, 'MR-10-01-05');
    await services.machineService.setStatus(machineZ.id, 'repair');
    await services.handover.ensureForBooking(booking.bookingId, admin.id);
    const slot = (await services.assignments.slotsForBooking(booking.bookingId))[0]!;
    const assigned = await services.assignments.assign(
      admin.id,
      adminEffective,
      slot.id,
      machineZ.id,
      {
        reason: 'Reparatur abgeschlossen, Freigabe der Werkstatt liegt vor.',
      },
    );
    expect(assigned.override).not.toBeNull();
    await services.assignments.prepare(admin.id, slot.id);
    await services.handover.setRecipient(booking.bookingId, { kind: 'customer' });
    await services.handover.checkMachine(admin.id, booking.bookingId, slot.id);
    await services.handover.addPhoto(admin.id, booking.bookingId, slot.id, {
      bytes: pngBytes(),
      mimeType: 'image/png',
    });
    await services.handover.sign(admin.id, booking.bookingId, 'customer', pngBytes());
    await services.handover.sign(admin.id, booking.bookingId, 'staff', pngBytes());
    expect((await handoverDetailViaRoute(booking.bookingId)).blockers).toEqual([]);

    // Wesentliche Änderung der Problemlage nach der Bestätigung: Sperre im Mietzeitraum.
    await services.machineService.createBlock(machineZ.id, admin.id, {
      startsAt: new Date(from.getTime() + 1 * HOURS),
      endsAt: new Date(from.getTime() + 3 * HOURS),
      reason: 'Kurzfristige Wartung',
    });
    const stale = await handoverDetailViaRoute(booking.bookingId);
    expect(stale.slots[0]!.overrideStale).toBe(true);
    expect(stale.blockers.join(' ')).toContain('Problemlage');
    const issuesBefore = await issueMovementCount();
    const blocked = await finalizeViaRoute(booking.bookingId);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error?.code).toBe('CONFLICT');
    expect((await handoverDetailViaRoute(booking.bookingId)).handover.status).toBe('draft');
    expect(await documentsOf(booking.bookingId)).toHaveLength(0);
    expect(await issueMovementCount()).toBe(issuesBefore);
    expect((await assignmentOf(slot.id)).status).toBe('prepared');

    // Auflösung nur über den vorhandenen Override-Prozess: neue Bestätigung mit Grund.
    await services.assignments.assign(admin.id, adminEffective, slot.id, machineZ.id, {
      reason: 'Wartung verschoben, abgesprochen.',
    });
    await services.assignments.prepare(admin.id, slot.id);
    await services.handover.checkMachine(admin.id, booking.bookingId, slot.id);
    const fresh = await handoverDetailViaRoute(booking.bookingId);
    expect(fresh.slots[0]!.overrideStale).toBe(false);
    expect(fresh.blockers).toEqual([]);
    expect(await activeOverrides(slot.id)).toHaveLength(1);
    expect(await overridesOf(slot.id)).toHaveLength(2);

    const finalized = await finalizeViaRoute(booking.bookingId);
    expect(finalized.status).toBe(200);
    expect(finalized.body.detail?.finalized).toBe(true);
    expect(finalized.body.detail?.handover.status).toBe('finalized');
    expect((await documentsOf(booking.bookingId)).map((d) => d.type).sort()).toEqual([
      'delivery_note',
      'handover_protocol',
    ]);
    const issuesAfter = await issueMovementCount();
    expect(issuesAfter).toBeGreaterThan(issuesBefore);
    expect((await machineByCode(ctx.db, 'MR-10-01-05')).status).toBe('rented');
    // Wiederholung (Doppelklick/Retry) ⇒ idempotent, kein doppelter Nebeneffekt.
    const again = await finalizeViaRoute(booking.bookingId);
    expect(again.status).toBe(200);
    expect(again.body.detail?.finalized).toBe(false);
    expect(await documentsOf(booking.bookingId)).toHaveLength(2);
    expect(await issueMovementCount()).toBe(issuesAfter);
    await settleMailJobs(ctx);
  });

  it('P18-F3. Offline-Override-Pfad beim Sync: harter Blocker ⇒ MACHINE_UNAVAILABLE; ohne Grund ⇒ VALIDATION; ohne Recht ⇒ FORBIDDEN; mit Grund, Recht und unveränderter Lage ⇒ applied', async () => {
    const services = handoverServicesFor(ctx);
    const from = new Date(Date.now() + 1 * DAYS);
    const to = new Date(Date.now() + 2 * DAYS);
    const bookingE = await scheduledBooking(ctx, admin.id, { from, to });
    const bookingF = await scheduledBooking(ctx, admin.id, {
      from: new Date(from.getTime() + 6 * HOURS),
      to: new Date(to.getTime() + 6 * HOURS),
    });
    await services.handover.ensureForBooking(bookingF.bookingId, admin.id);
    const slotF = (await services.assignments.slotsForBooking(bookingF.bookingId))[0]!;
    const machineV = await machineByCode(ctx.db, 'MR-10-01-06');
    await services.assignments.assign(admin.id, adminEffective, slotF.id, machineV.id, null);
    const machineY = await machineByCode(ctx.db, 'MR-10-01-04'); // seit F1 ausgegeben

    const overrider = await h.staffWith(
      admin.id,
      [...h.OPERATIVE, 'machine.override_block'],
      'Overrider',
    );
    const plain = await h.staffWith(admin.id, h.OPERATIVE, 'PlainOffline');
    const pkg = await h.packageFor(overrider.cookie);
    expect((await h.lease(plain.cookie, DEVICE_B)).statusCode).toBe(200);
    const snapshot = pkg.bookings.find((b) => b.bookingId === bookingE.bookingId)!;
    const slotE = (snapshot.handover as unknown as { slots: SlotSnapshot[] }).slots[0]!;
    const candidates = snapshot.candidateMachines[slotE.id]!;
    const candidateV = candidates.find((c) => c.machineId === machineV.id)!;
    expect(candidateV.overrideRequired).toBe(true);
    expect(candidateV.hardBlocked).toBe(false);
    expect(candidates.find((c) => c.machineId === machineY.id)!.hardBlocked).toBe(true);
    const outbound = snapshot.appointments.find((a) => a.kind !== 'return')!;
    const base = {
      processStatus: 'open',
      appointmentId: outbound.id,
      appointmentVersion: outbound.version,
      expectedMachineId: null,
    };
    const assign = (
      machineId: string,
      override: { reason: string } | null,
      situationFingerprint: string | null,
    ) => ({
      type: 'handover.assign',
      contextId: bookingE.bookingId,
      base,
      payload: { assignmentId: slotE.id, machineId, override, situationFingerprint },
    });
    const overridesBefore = await overrideCount();

    const hard = await h.sync(overrider.cookie, assign(machineY.id, { reason: 'Trotzdem' }, null));
    expect(hard.json.status).toBe('conflict');
    expect(hard.json.code).toBe('MACHINE_UNAVAILABLE');
    expect((hard.json.details as { server: string }).server).toContain('MR-10-01-04');
    expect((await assignmentOf(slotE.id)).machineId).toBeNull();

    const noReason = await h.sync(
      overrider.cookie,
      assign(machineV.id, { reason: '' }, candidateV.situationFingerprint),
    );
    expect(noReason.json.status).toBe('rejected');
    expect(noReason.json.code).toBe('VALIDATION');

    const noRight = await h.sync(
      plain.cookie,
      assign(machineV.id, { reason: 'Kunde wartet' }, candidateV.situationFingerprint),
      { deviceId: DEVICE_B },
    );
    expect(noRight.json.status).toBe('rejected');
    expect(noRight.json.code).toBe('FORBIDDEN');
    for (const key of PERMISSION_KEYS) expect(JSON.stringify(noRight.json)).not.toContain(key);
    expect((await assignmentOf(slotE.id)).machineId).toBeNull();
    expect(await overrideCount()).toBe(overridesBefore);

    const applied = await h.sync(
      overrider.cookie,
      assign(
        machineV.id,
        { reason: 'Kunde wartet, Rückgabe der Vorbuchung früher vereinbart' },
        candidateV.situationFingerprint,
      ),
    );
    expect(applied.json.status).toBe('applied');
    expect((await assignmentOf(slotE.id)).machineId).toBe(machineV.id);
    const active = await activeOverrides(slotE.id);
    expect(active).toHaveLength(1);
    expect(active[0]!.confirmedBy).toBe(overrider.user.id);
    expect(active[0]!.situationFingerprint).toBe(candidateV.situationFingerprint);
    expect(await overrideCount()).toBe(overridesBefore + 1);
  });

  it('P18-F4. Tour-Doppelstart (parallel) ⇒ genau ein Start, ein started_at; zweite aktive Tour derselben Person ⇒ 409 TOUR_DRIVER_ALREADY_ACTIVE', async () => {
    const api = apiFor(world.app, adminCookie);
    const driver = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Fahrer');
    const driverApi = apiFor(world.app, driver.cookie);
    const today = todayBerlin();
    const booking = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.user.id,
      outboundStartAt: inMinutes(60),
      outboundEndAt: inMinutes(120),
      street: 'Ahornweg 1',
    });
    const tour = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.user.id,
      appointmentIds: [booking.outbound.id],
    });
    expect((await getTour(api, tour.id)).startedAt).toBeNull();

    const [a, b] = await Promise.all([
      driverApi('POST', `/staff/tours/${tour.id}/start`, {}),
      driverApi('POST', `/staff/tours/${tour.id}/start`, {}),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.started, b.body.started].filter(Boolean)).toHaveLength(1);
    expect(a.body.tour.startedAt).toBe(b.body.tour.startedAt);
    const row = (await ctx.db.select().from(tours).where(eq(tours.id, tour.id)))[0]!;
    expect(row.status).toBe('active');
    expect(row.startedBy).toBe(driver.user.id);
    expect(row.startedAt?.toISOString()).toBe(a.body.tour.startedAt);
    const again = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(again.body.started).toBe(false);
    expect(again.body.tour.startedAt).toBe(a.body.tour.startedAt);

    // Zweite Tour derselben Person heute (Rückgabetermin ohne Zeit ist aufnehmbar) ⇒ 409.
    const second = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.user.id,
      appointmentIds: [booking.inbound.id],
    });
    const conflict = await driverApi('POST', `/staff/tours/${second.id}/start`, {});
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('TOUR_DRIVER_ALREADY_ACTIVE');
    const activeRows = (await ctx.db.select().from(tours).where(eq(tours.status, 'active'))).filter(
      (t) => t.assignedUserId === driver.user.id,
    );
    expect(activeRows.map((t) => t.id)).toEqual([tour.id]);
    expect((await getTour(api, second.id)).status).toBe('draft');
    await world.delayState.settle();
  });

  it('P18-F5. Konkurrierende Übernahmen mit expectedVersion ⇒ genau 200 + 409 TOUR_VERSION_CONFLICT; offene Stopp-Termine beim Gewinner, Live-Standort gelöscht; H2 dokumentiert', async () => {
    const api = apiFor(world.app, adminCookie);
    const driver = await staffWith(world, admin.id, DRIVER_PERMISSIONS, 'Fahrerin');
    const driverApi = apiFor(world.app, driver.cookie);
    const today = todayBerlin();
    const first = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.user.id,
      outboundStartAt: inMinutes(90),
      outboundEndAt: inMinutes(150),
      street: 'Birkenstraße 2',
    });
    const second = await bookingWithAppointments(world, admin.id, {
      assignTo: driver.user.id,
      outboundStartAt: inMinutes(180),
      outboundEndAt: inMinutes(240),
      street: 'Cederweg 3',
    });
    const tour = await tourWithStops(api, {
      tourDate: today,
      assignedUserId: driver.user.id,
      appointmentIds: [first.outbound.id, second.outbound.id],
    });
    const started = await driverApi('POST', `/staff/tours/${tour.id}/start`, {});
    expect(started.status).toBe(200);
    expect(started.body.started).toBe(true);
    await setLiveLocation(world, tour.id, driver.user.id, DRIVER_POINT);
    expect(
      await ctx.db.select().from(tourLiveLocations).where(eq(tourLiveLocations.tourId, tour.id)),
    ).toHaveLength(1);

    const planner1 = await staffWith(world, admin.id, PLANNER_PERMISSIONS, 'Planer');
    const planner2 = await staffWith(world, admin.id, PLANNER_PERMISSIONS, 'Planerin');
    const planner3 = await staffWith(world, admin.id, PLANNER_PERMISSIONS, 'Disponent');
    const api1 = apiFor(world.app, planner1.cookie);
    const api2 = apiFor(world.app, planner2.cookie);
    const api3 = apiFor(world.app, planner3.cookie);
    const before = await getTour(api, tour.id);
    const version: number = before.version;

    // Beide Übernahmen tragen den aktuellen Stand (wie die UI): genau eine gewinnt.
    const [r1, r2] = await Promise.all([
      api1('POST', `/staff/tours/${tour.id}/takeover`, { expectedVersion: version }),
      api2('POST', `/staff/tours/${tour.id}/takeover`, { expectedVersion: version }),
    ]);
    const results = [r1, r2];
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.error.code).toBe('TOUR_VERSION_CONFLICT');
    const winner = r1.status === 200 ? planner1 : planner2;
    const loserApi = r1.status === 200 ? api2 : api1;
    const after = await getTour(api, tour.id);
    expect(after.status).toBe('active');
    expect(after.assignedUserId).toBe(winner.user.id);
    expect(after.version).toBe(version + 1);
    for (const booking of [first, second]) {
      const appointment = (await appointmentRow(world, booking.outbound.id))!;
      expect(appointment.assignedUserId).toBe(winner.user.id);
      expect(appointment.status).toBe('scheduled');
    }
    expect(
      await ctx.db.select().from(tourLiveLocations).where(eq(tourLiveLocations.tourId, tour.id)),
    ).toHaveLength(0);
    // Der Verlierer mit veraltetem Stand erneut ⇒ wieder 409, nichts wird still überschrieben.
    const staleRetry = await loserApi('POST', `/staff/tours/${tour.id}/takeover`, {
      expectedVersion: version,
    });
    expect(staleRetry.status).toBe(409);
    expect(staleRetry.body.error.code).toBe('TOUR_VERSION_CONFLICT');
    expect((await getTour(api, tour.id)).assignedUserId).toBe(winner.user.id);

    // Beobachtung H2 (Karte C): ohne expectedVersion gewinnt die spätere Übernahme; die UI sendet immer tour.version
    const unversioned = await api3('POST', `/staff/tours/${tour.id}/takeover`, {});
    expect(unversioned.status).toBe(200);
    expect(unversioned.body.tour.assignedUserId).toBe(planner3.user.id);
    expect(unversioned.body.tour.version).toBe(version + 2);
    for (const booking of [first, second]) {
      expect((await appointmentRow(world, booking.outbound.id))!.assignedUserId).toBe(
        planner3.user.id,
      );
    }
    // Höchstens eine aktive Tour je Person – auch nach den Übernahmen.
    const activeTours = await ctx.db.select().from(tours).where(eq(tours.status, 'active'));
    const drivers = activeTours.map((t) => t.assignedUserId);
    expect(new Set(drivers).size).toBe(drivers.length);
    await world.delayState.settle();
  });

  it('P18-F6. Termin-CAS: zwei parallele Reschedules mit derselben expectedVersion ⇒ genau einer gewinnt, der andere 409', async () => {
    const scheduling = schedulingServiceFor(ctx);
    const booking = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    await scheduling.ensureAppointmentsForBooking(booking.bookingId);
    const rows = await ctx.db
      .select()
      .from(appointments)
      .where(eq(appointments.bookingId, booking.bookingId));
    const pickup = rows.find((row) => row.kind === 'pickup')!;
    const targetA = new Date(Date.now() + 100 * HOURS);
    const targetB = new Date(Date.now() + 200 * HOURS);
    const outcomes = await Promise.allSettled([
      scheduling.reschedule(admin.id, pickup.id, {
        startAt: targetA,
        endAt: null,
        expectedVersion: pickup.version,
      }),
      scheduling.reschedule(admin.id, pickup.id, {
        startAt: targetB,
        endAt: null,
        expectedVersion: pickup.version,
      }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
    const after = (
      await ctx.db.select().from(appointments).where(eq(appointments.id, pickup.id))
    )[0]!;
    expect(after.version).toBe(pickup.version + 1);
    const winnerStart = (fulfilled[0] as PromiseFulfilledResult<{ startAt: Date | null }>).value
      .startAt;
    expect(after.startAt?.toISOString()).toBe(winnerStart?.toISOString());
    expect([targetA.toISOString(), targetB.toISOString()]).toContain(after.startAt?.toISOString());
  });

  it('P18-F7. Integritäts-Backstop des Szenarios: keine Verletzung, Dokumente byteidentisch im Storage', async () => {
    // Override-Protokoll: nie eine aktive Doppelzeile je Zuordnung, nie ohne Grund.
    const duplicates = await ctx.pool.query(
      `SELECT assignment_id FROM machine_assignment_overrides WHERE archived_at IS NULL GROUP BY 1 HAVING count(*) > 1`,
    );
    expect(duplicates.rows).toEqual([]);
    expect((await ctx.db.select().from(machineAssignmentOverrides)).length).toBeGreaterThanOrEqual(
      5,
    );
    expect(await integrityViolations(ctx.pool)).toEqual([]);
    expect(await documentStorageMismatches(ctx.pool, ctx.storage)).toEqual([]);
  });
});
