/**
 * Phase 18 (Gesamt-Abnahme) – Szenario D „Storno“ als API-Integrationslauf gegen echte
 * Services (Mock-Buchhaltung, FakeMailGateway; Eventdaten als Berliner Kalendertage).
 *
 * Geprüft wird (Karte B, Prozess D): Gebühr nach Resttagen auf Basis der eingefrorenen
 * regulären Maschinenpreise (half-up), der Storno als EINE Transaktion (Termine storniert,
 * Zuordnungen gelöst, reservierte Maschine wieder einsatzbereit, keine Lagerbewegung,
 * Dokumente und Buchung unverändert), Idempotenz (Doppel-/Parallelstorno, genau ein
 * Transfer), die Bindung des Kundenstornos an die angezeigte Gebühr, verbotene Übergänge
 * (abgeschlossen, Rückgabe vorhanden, ausgegeben), serverseitige Rechte ohne Nebenwirkung,
 * 0 % ohne Rechnung/Job, die Sperre der stornierten Buchung nach einem Reopen sowie am
 * Ende die systemweiten SQL-Invarianten (acceptance-integrity.ts).
 */
import {
  accountingTransfers,
  appointments,
  cancellations,
  documents,
  integrationJobs,
  machineAssignments,
  mailDeliveries,
  processes,
  rentalReturns,
} from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CancellationPreview,
  CancellationView,
} from '../src/cancellation/cancellation-service.ts';
import type { PortalBookingView, PortalCancellationPreview } from '../src/portal/views.ts';
import {
  documentStorageMismatches,
  integrityViolations,
  tableCounts,
} from './acceptance-integrity.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  adminSession,
  bookedProcess,
  bookingRow,
  eventDateInDays,
  staffWith,
} from './cancellation-helpers.ts';
import { DAYS, handoverServicesFor } from './handover-helpers.ts';
import {
  forbiddenKeysIn,
  portalApp,
  portalGet,
  portalPost,
  portalSessionFor,
  resetPortalWorld,
  type PortalTestApp,
} from './portal-test-helpers.ts';
import { issuedBooking, startedReturn } from './return-helpers.ts';
import { drainAllJobs, settledReturn, settlementRowFor } from './settlement-helpers.ts';
import { machineByCode } from './warehouse-helpers.ts';

let ctx: TestContext;
let portal: PortalTestApp;
let adminId: string;
let cookie: string;
let effective: ReadonlySet<PermissionKey>;

/** Staff-Storno aus D1 (vorbereitete Maschine, 50 %, Bestätigung „prepared“) – von D4 und D6 weiterverwendet. */
const D1 = { processId: '', bookingId: '', cancellationId: '', slotId: '', machineId: '' };

beforeAll(async () => {
  ctx = await createTestContext();
  portal = await portalApp(ctx);
  await resetPortalWorld(ctx);
  const session = await adminSession(ctx);
  adminId = session.admin.id;
  cookie = session.cookie;
  effective = session.effective;
});
afterAll(async () => {
  await portal.close();
  await destroyTestContext(ctx);
});

// ── Lokale Hilfen ───────────────────────────────────────────────────────────

interface SnapshotItem {
  kind: string;
  quantity: number;
  standardUnitPriceCents: number;
}

/** Stornobasis laut Produktregel: Σ regulärer Maschinen-Listenpreis × Menge aus dem Buchungs-Snapshot. */
async function expectedBase(bookingId: string): Promise<number> {
  const row = await bookingRow(ctx, bookingId);
  return (row.itemsSnapshot as SnapshotItem[])
    .filter((item) => item.kind === 'machine')
    .reduce((sum, item) => sum + item.standardUnitPriceCents * item.quantity, 0);
}

/** Gebühr = Basis × Satz / 100, kaufmännisch (half up) auf ganze Cent. */
const feeOf = (base: number, percent: number) => Math.floor((base * percent + 50) / 100);

const staffGet = (url: string, sessionCookie = cookie) =>
  ctx.app.inject({ method: 'GET', url, headers: { cookie: sessionCookie } });

const staffPost = (url: string, payload: Record<string, unknown>, sessionCookie = cookie) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie: sessionCookie }, payload });

const cancelViaRoute = (processId: string, sessionCookie = cookie) =>
  staffPost(`/staff/processes/${processId}/cancellation`, { confirm: true }, sessionCookie);

async function previewFor(processId: string): Promise<CancellationPreview> {
  const response = await staffGet(`/staff/processes/${processId}/cancellation/preview`);
  expect(response.statusCode).toBe(200);
  return response.json() as CancellationPreview;
}

async function count(table: string): Promise<number> {
  const counts = await tableCounts(ctx.pool, [table]);
  return counts[table] ?? 0;
}

async function jobCount(type: string): Promise<number> {
  const rows = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(integrationJobs)
    .where(eq(integrationJobs.type, type));
  return Number(rows[0]?.n ?? 0);
}

async function processRow(processId: string) {
  return (await ctx.db.select().from(processes).where(eq(processes.id, processId)))[0]!;
}

async function cancellationsOf(processId: string) {
  return ctx.db.select().from(cancellations).where(eq(cancellations.processId, processId));
}

async function appointmentsOf(bookingId: string) {
  return ctx.db
    .select()
    .from(appointments)
    .where(eq(appointments.bookingId, bookingId))
    .orderBy(asc(appointments.kind));
}

async function assignmentsOf(bookingId: string) {
  return ctx.db
    .select()
    .from(machineAssignments)
    .where(eq(machineAssignments.bookingId, bookingId))
    .orderBy(asc(machineAssignments.slotNo));
}

async function documentsOf(processId: string) {
  return (await ctx.db.select().from(documents).where(eq(documents.processId, processId)))
    .map((row) => ({ id: row.id, type: row.type, sha256: row.sha256, storageKey: row.storageKey }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function transfersOf(processId: string) {
  return ctx.db
    .select()
    .from(accountingTransfers)
    .where(eq(accountingTransfers.processId, processId));
}

async function cancellationJobsFor(cancellationId: string) {
  return ctx.db
    .select()
    .from(integrationJobs)
    .where(
      and(
        eq(integrationJobs.type, 'cancellation.accounting_transfer'),
        sql`${integrationJobs.payload}->>'cancellationId' = ${cancellationId}`,
      ),
    );
}

async function confirmationDeliveries(processId: string) {
  return ctx.db
    .select()
    .from(mailDeliveries)
    .where(
      and(
        eq(mailDeliveries.processId, processId),
        eq(mailDeliveries.kind, 'cancellation_confirmation'),
      ),
    );
}

const cancellationCalls = () => ctx.accounting.calls.filter((call) => call.kind === 'cancellation');

// ── Szenario D – Storno ─────────────────────────────────────────────────────

describe('Phase 18 – Szenario D: Storno', () => {
  it('P18-D1. Staff-Storno 10 Tage vor dem Event: Vorschau 50 % der regulären Maschinenmiete (half-up); EINE Transaktion storniert Termine, löst die vorbereitete Zuordnung, gibt die Maschine frei – keine Lagerbewegung, Dokumente und Buchung unverändert; Doppel- und Parallelstorno idempotent; genau ein Transfer', async () => {
    const booked = await bookedProcess(ctx, adminId, { eventInDays: 10 });
    D1.processId = booked.processId;
    D1.bookingId = booked.bookingId;
    // Maschine zuweisen und vorbereiten ⇒ „Reserviert“ (die Freigabe muss nachweisbar sein).
    const { handover, assignments } = handoverServicesFor(ctx);
    await handover.ensureForBooking(booked.bookingId, adminId);
    const slot = (await assignments.slotsForBooking(booked.bookingId))[0]!;
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    await assignments.assign(adminId, effective, slot.id, machine.id, null);
    await assignments.prepare(adminId, slot.id);
    D1.slotId = slot.id;
    D1.machineId = machine.id;
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('reserved');
    expect((await assignmentsOf(booked.bookingId)).map((a) => a.status)).toEqual(['prepared']);

    // Vorschau: Satz/Basis/Gebühr ausschließlich aus der Domänenregel.
    const base = await expectedBase(booked.bookingId);
    expect(base).toBeGreaterThan(0);
    const preview = await previewFor(booked.processId);
    expect(preview).toMatchObject({
      eventDate: eventDateInDays(10),
      remainingDays: 10,
      feePercent: 50,
      baseCents: base,
      feeCents: feeOf(base, 50),
      roundingMethod: 'half_up',
      willRelease: { appointments: 2, assignments: 1, reservedMachines: 1 },
      blockers: [],
      accountingConfigured: true,
    });

    // Vorher-Zustand: Dokumente (Anzahl + SHA-256), Buchungs-Snapshot, Lagerbewegungen.
    const documentsBefore = await documentsOf(booked.processId);
    expect(documentsBefore.length).toBeGreaterThan(0); // Angebots-PDF aus dem Annahmepfad
    const bookingBefore = await bookingRow(ctx, booked.bookingId);
    const movementsBefore = await count('inventory_movements');
    expect(await count('cancellations')).toBe(0);

    const cancelled = await cancelViaRoute(booked.processId);
    expect(cancelled.statusCode).toBe(200);
    const view = cancelled.json() as CancellationView;
    expect(view).toMatchObject({
      processId: booked.processId,
      cancelerType: 'admin',
      feePercent: 50,
      baseCents: base,
      feeCents: feeOf(base, 50),
      roundingMethod: 'half_up',
      financeStatus: 'accounting_pending',
      financeStatusLabel: 'Stornorechnung – Buchhaltung ausstehend',
      confirmationStatus: 'prepared',
      releasedResources: { appointments: 2, assignments: 1, machines: 1, riskIncidents: 0 },
    });
    D1.cancellationId = view.id;

    // Endzustand (Karte B, D4).
    const rows = await cancellationsOf(booked.processId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: view.id,
      bookingId: booked.bookingId,
      cancelerType: 'admin',
      cancelerStaffId: adminId,
      eventDate: eventDateInDays(10),
      remainingDays: 10,
      feePercent: 50,
      baseCents: base,
      feeCents: feeOf(base, 50),
      roundingMethod: 'half_up',
      financeStatus: 'accounting_pending',
      confirmationStatus: 'prepared',
      reopenedAt: null,
    });
    expect(rows[0]!.accountingTransferId).not.toBeNull();
    const process = await processRow(booked.processId);
    expect(process.mainStatus).toBe('cancelled');
    expect(process.cancelledAt?.getTime()).toBe(rows[0]!.cancelledAt.getTime());
    const appointmentRows = await appointmentsOf(booked.bookingId);
    expect(appointmentRows).toHaveLength(2);
    expect(appointmentRows.every((a) => a.status === 'cancelled' && a.cancelledAt !== null)).toBe(
      true,
    );
    const slots = await assignmentsOf(booked.bookingId);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ status: 'open', machineId: null });
    expect(slots[0]!.releasedAt).not.toBeNull();
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('ready');
    expect(await count('inventory_movements')).toBe(movementsBefore);
    expect(await documentsOf(booked.processId)).toEqual(documentsBefore);
    expect(await bookingRow(ctx, booked.bookingId)).toEqual(bookingBefore);
    expect(await ctx.db.select().from(rentalReturns)).toEqual([]);

    // Idempotenz: zweites und paralleles Storno liefern dieselbe Zeile.
    const second = await cancelViaRoute(booked.processId);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(view.id);
    const [p1, p2] = await Promise.all([
      cancelViaRoute(booked.processId),
      cancelViaRoute(booked.processId),
    ]);
    expect([p1.statusCode, p2.statusCode]).toEqual([200, 200]);
    expect(new Set([p1.json().id, p2.json().id])).toEqual(new Set([view.id]));
    expect(await count('cancellations')).toBe(1);

    // Genau ein Transferjob, genau ein Transfer (Mock), danach manuell ⇒ already_succeeded.
    expect(await cancellationJobsFor(view.id)).toHaveLength(1);
    expect(await transfersOf(booked.processId)).toHaveLength(1);
    await drainAllJobs(ctx);
    const transfers = await transfersOf(booked.processId);
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ kind: 'cancellation', status: 'succeeded', attempts: 1 });
    expect(cancellationCalls()).toHaveLength(1);
    expect(cancellationCalls()[0]!.amountDueCents).toBe(feeOf(base, 50));
    const stored = (await cancellationsOf(booked.processId))[0]!;
    expect(stored.financeStatus).toBe('invoice_open');
    expect(stored.accountingReference).toMatch(/^MOCK-STORNO-/);
    const manual = await staffPost(`/staff/cancellations/${view.id}/transfer`, {});
    expect(manual.statusCode).toBe(200);
    expect(manual.json().outcome).toBe('already_succeeded');
    expect(await transfersOf(booked.processId)).toHaveLength(1);
    expect(cancellationCalls()).toHaveLength(1);
    expect((await processRow(booked.processId)).mainStatus).toBe('cancelled');
    // Zwischenstand direkt nach dem Storno: keine Geisterreservierung, keine offenen Termine,
    // Gebühr/Status/Transfer konsistent (systemweite Invarianten).
    expect(await integrityViolations(ctx.pool)).toEqual([]);
  });

  it('P18-D2. Kundenstorno ist an die angezeigte Gebühr gebunden: falscher Prüfwert ⇒ 409 PORTAL_CANCELLATION_FEE_CHANGED ohne Zeile; richtiger Wert ⇒ canceler customer, Bestätigungsmail genau einmal; zweiter POST idempotent', async () => {
    const booked = await bookedProcess(ctx, adminId, { eventInDays: 10 });
    const session = await portalSessionFor(ctx, booked.customerId);
    const base = await expectedBase(booked.bookingId);
    const preview = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}/cancellation/preview`,
    );
    expect(preview.status).toBe(200);
    const shown = preview.body as PortalCancellationPreview;
    expect(shown).toMatchObject({
      remainingDays: 10,
      feePercent: 50,
      baseCents: base,
      feeCents: feeOf(base, 50),
      allowed: true,
      blockedMessage: null,
    });
    expect(forbiddenKeysIn(shown)).toEqual([]);
    ctx.mailGateway.reset();

    const wrong = await portalPost(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}/cancellation`,
      { confirm: true, expectedFeeCents: shown.feeCents! + 1 },
    );
    expect(wrong.status).toBe(409);
    expect(wrong.body).toMatchObject({ error: { code: 'PORTAL_CANCELLATION_FEE_CHANGED' } });
    expect(await cancellationsOf(booked.processId)).toEqual([]);
    expect((await processRow(booked.processId)).mainStatus).toBe('open');
    expect((await appointmentsOf(booked.bookingId)).map((a) => a.status)).toEqual([
      'scheduled',
      'scheduled',
    ]);
    expect(await confirmationDeliveries(booked.processId)).toEqual([]);

    const right = await portalPost(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}/cancellation`,
      { confirm: true, expectedFeeCents: shown.feeCents },
    );
    expect(right.status).toBe(200);
    const view = right.body as PortalBookingView;
    expect(view.portalState).toBe('cancelled_fee');
    expect(view.cancellation).toMatchObject({
      feePercent: 50,
      feeCents: feeOf(base, 50),
      invoiceFollows: true,
    });
    expect(view.invoice).toEqual({
      status: 'preparing',
      label: 'Rechnung wird vorbereitet',
      finalAmountCents: null,
    });
    expect(forbiddenKeysIn(view)).toEqual([]);
    let row = (await cancellationsOf(booked.processId))[0]!;
    expect(row).toMatchObject({
      cancelerType: 'customer',
      cancelerStaffId: null,
      feePercent: 50,
      feeCents: feeOf(base, 50),
      financeStatus: 'accounting_pending',
      confirmationStatus: 'queued',
    });
    let deliveries = await confirmationDeliveries(booked.processId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.idempotencyKey).toBe(`cancellation_confirmation:${row.id}`);

    await drainAllJobs(ctx); // Bestätigungsmail (Outbox) + Storno-Transfer (Mock)
    row = (await cancellationsOf(booked.processId))[0]!;
    expect(row.confirmationStatus).toBe('sent');
    expect(row.confirmationSentAt).not.toBeNull();
    expect(row.financeStatus).toBe('invoice_open');
    deliveries = await confirmationDeliveries(booked.processId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe('sent');
    expect(ctx.mailGateway.sent.filter((mail) => mail.subject.includes('Storno'))).toHaveLength(1);
    expect(await transfersOf(booked.processId)).toHaveLength(1);

    const again = await portalPost(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}/cancellation`,
      { confirm: true, expectedFeeCents: shown.feeCents },
    );
    expect(again.status).toBe(200);
    expect((again.body as PortalBookingView).portalState).toBe('cancelled_fee');
    expect(await cancellationsOf(booked.processId)).toHaveLength(1);
    expect(await confirmationDeliveries(booked.processId)).toHaveLength(1);
    expect(ctx.mailGateway.sent.filter((mail) => mail.subject.includes('Storno'))).toHaveLength(1);
    expect(await transfersOf(booked.processId)).toHaveLength(1);
  });

  it('P18-D3a. Blocker: abgeschlossener Vorgang (abgerechnet) ⇒ 409 CANCELLATION_BLOCKED „bitte zuerst wieder öffnen“ – keine Zeile, Status unverändert', async () => {
    const { world } = await settledReturn(ctx, adminId, cookie, { machineCodes: ['MR-10-01-02'] });
    await drainAllJobs(ctx); // Auto-Transfer ⇒ Abrechnung übertragen, Vorgang abgeschlossen
    expect((await processRow(world.processId)).mainStatus).toBe('completed');
    const settlement = (await settlementRowFor(ctx, world.processId))!;
    expect(settlement.status).toBe('transferred');

    const preview = await previewFor(world.processId);
    expect(preview.blockers).toEqual(
      expect.arrayContaining([
        'Der Vorgang ist abgeschlossen – bitte zuerst wieder öffnen.',
        'Mindestens eine Maschine wurde bereits ausgegeben.',
        'Für die Buchung existiert bereits eine Rückgabe.',
      ]),
    );
    const response = await cancelViaRoute(world.processId);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CANCELLATION_BLOCKED');
    expect(response.json().error.message).toContain('bitte zuerst wieder öffnen');
    expect(await cancellationsOf(world.processId)).toEqual([]);
    expect((await processRow(world.processId)).mainStatus).toBe('completed');
    expect((await settlementRowFor(ctx, world.processId))!.status).toBe('transferred');
    expect((await assignmentsOf(world.bookingId)).map((a) => a.status)).toEqual(['returned']);
  });

  it('P18-D3b. Blocker: Rückgabe existiert (Entwurf) ⇒ 409 CANCELLATION_BLOCKED – keine Zeile, Rückgabe und Vorgang unverändert', async () => {
    const { world, detail } = await startedReturn(ctx, adminId, {
      machineCodes: ['MR-10-01-03'],
      from: new Date(Date.now() + 20 * DAYS),
      to: new Date(Date.now() + 22 * DAYS),
    });
    expect(detail.return.status).toBe('draft');
    const preview = await previewFor(world.processId);
    expect(preview.blockers).toContain('Für die Buchung existiert bereits eine Rückgabe.');
    const response = await cancelViaRoute(world.processId);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CANCELLATION_BLOCKED');
    expect(response.json().error.message).toContain('existiert bereits eine Rückgabe');
    expect(await cancellationsOf(world.processId)).toEqual([]);
    expect((await processRow(world.processId)).mainStatus).toBe('open');
    const returns = await ctx.db
      .select()
      .from(rentalReturns)
      .where(eq(rentalReturns.bookingId, world.bookingId));
    expect(returns).toHaveLength(1);
    expect(returns[0]!.status).toBe('draft');
    expect((await assignmentsOf(world.bookingId)).map((a) => a.status)).toEqual(['issued']);
  });

  it('P18-D3c. Blocker: Maschine ausgegeben (Übergabe abgeschlossen) ⇒ 409 CANCELLATION_BLOCKED – keine Zeile, Zuordnung bleibt ausgegeben', async () => {
    const issued = await issuedBooking(ctx, adminId, {
      machineCodes: ['MR-10-01-04'],
      from: new Date(Date.now() + 30 * DAYS),
      to: new Date(Date.now() + 32 * DAYS),
    });
    const preview = await previewFor(issued.processId);
    expect(preview.blockers).toEqual(
      expect.arrayContaining([
        'Mindestens eine Maschine wurde bereits ausgegeben.',
        expect.stringContaining('Die Übergabe ist bereits abgeschlossen'),
      ]),
    );
    const response = await cancelViaRoute(issued.processId);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CANCELLATION_BLOCKED');
    expect(response.json().error.message).toContain('ausgegeben');
    expect(await cancellationsOf(issued.processId)).toEqual([]);
    expect((await processRow(issued.processId)).mainStatus).toBe('open');
    expect((await assignmentsOf(issued.bookingId)).map((a) => a.status)).toEqual(['issued']);
    expect((await machineByCode(ctx.db, 'MR-10-01-04')).status).toBe('rented');
    expect((await appointmentsOf(issued.bookingId)).map((a) => a.status)).toEqual([
      'completed',
      'scheduled',
    ]);
  });

  it('P18-D4. Rechte: Storno ohne booking.cancel 403 ohne Zeile; Bestätigung ohne email.approve_prepared 403 ohne Outbox-Zeile; Transfer ohne lexware.manual_transfer 403 ohne Gateway-Aufruf', async () => {
    const booked = await bookedProcess(ctx, adminId, { eventInDays: 10 });
    const viewer = await staffWith(ctx, adminId, ['process.view_all', 'settlement.view'], 'Sven');
    // Vorschau ist mit settlement.view erlaubt – das Storno selbst nicht.
    const preview = await staffGet(
      `/staff/processes/${booked.processId}/cancellation/preview`,
      viewer.cookie,
    );
    expect(preview.statusCode).toBe(200);
    const denied = await cancelViaRoute(booked.processId, viewer.cookie);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');
    expect(await cancellationsOf(booked.processId)).toEqual([]);
    expect((await processRow(booked.processId)).mainStatus).toBe('open');
    expect((await appointmentsOf(booked.bookingId)).map((a) => a.status)).toEqual([
      'scheduled',
      'scheduled',
    ]);

    // Stornobestätigung (Staff-Storno D1, Status „prepared“) ohne email.approve_prepared.
    const plain = await staffWith(ctx, adminId, ['process.view_all'], 'Nora');
    const mailsBefore = await count('mail_deliveries');
    const confirmation = await staffPost(
      `/staff/cancellations/${D1.cancellationId}/confirmation/send`,
      {},
      plain.cookie,
    );
    expect(confirmation.statusCode).toBe(403);
    expect(confirmation.json().error.code).toBe('FORBIDDEN');
    const d1 = (await cancellationsOf(D1.processId))[0]!;
    expect(d1.confirmationStatus).toBe('prepared');
    expect(d1.confirmationSentAt).toBeNull();
    expect(await confirmationDeliveries(D1.processId)).toEqual([]);
    expect(await count('mail_deliveries')).toBe(mailsBefore);

    // Manuelle Übertragung ohne lexware.manual_transfer.
    const callsBefore = ctx.accounting.calls.length;
    const transfersBefore = await count('accounting_transfers');
    const transfer = await staffPost(
      `/staff/cancellations/${D1.cancellationId}/transfer`,
      {},
      plain.cookie,
    );
    expect(transfer.statusCode).toBe(403);
    expect(transfer.json().error.code).toBe('FORBIDDEN');
    expect(ctx.accounting.calls).toHaveLength(callsBefore);
    expect(await count('accounting_transfers')).toBe(transfersBefore);
  });

  it('P18-D5. 0 % (Event ≥ 15 Tage): Gebühr 0, finance_status no_invoice, kein Transfer, kein Transferjob; kostenfreies Staff-Storno ist im Portal sofort unsichtbar', async () => {
    const booked = await bookedProcess(ctx, adminId, { eventInDays: 30 });
    const base = await expectedBase(booked.bookingId);
    const preview = await previewFor(booked.processId);
    expect(preview).toMatchObject({
      remainingDays: 30,
      feePercent: 0,
      baseCents: base,
      feeCents: 0,
    });
    const callsBefore = ctx.accounting.calls.length;
    const transferJobsBefore = await jobCount('cancellation.accounting_transfer');
    const retentionJobsBefore = await jobCount('communication.cleanup_retention');

    const response = await cancelViaRoute(booked.processId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      feePercent: 0,
      feeCents: 0,
      baseCents: base,
      financeStatus: 'no_invoice',
      financeStatusLabel: 'Storniert – ohne Rechnung',
    });
    const row = (await cancellationsOf(booked.processId))[0]!;
    expect(row).toMatchObject({
      feePercent: 0,
      feeCents: 0,
      baseCents: base,
      financeStatus: 'no_invoice',
      accountingTransferId: null,
      cancelerType: 'admin',
    });
    expect((await processRow(booked.processId)).mainStatus).toBe('cancelled');
    expect(await transfersOf(booked.processId)).toEqual([]);
    expect(await cancellationJobsFor(row.id)).toEqual([]);
    expect(await jobCount('cancellation.accounting_transfer')).toBe(transferJobsBefore);
    // Einziger Nachlauf eines 0-%-Stornos: der Retention-Anker für Chatfotos (Phase 12 §4.1) –
    // kein Buchhaltungsjob.
    expect(await jobCount('communication.cleanup_retention')).toBe(retentionJobsBefore + 1);
    await drainAllJobs(ctx);
    expect(ctx.accounting.calls).toHaveLength(callsBefore);
    expect(await transfersOf(booked.processId)).toEqual([]);
    // Manuelle Übertragung ohne Rechnung ⇒ 409 (nichts zu übertragen).
    const nothing = await staffPost(`/staff/cancellations/${row.id}/transfer`, {});
    expect(nothing.statusCode).toBe(409);
    expect(ctx.accounting.calls).toHaveLength(callsBefore);
    // Portal (Review R12): kostenfreies Staff-Storno ⇒ sofort unsichtbar.
    const session = await portalSessionFor(ctx, booked.customerId);
    const list = await portalGet(portal.app, session.cookie, '/portal/bookings');
    expect(list.status).toBe(200);
    expect((list.body as { bookings: unknown[] }).bookings).toEqual([]);
    expect(
      (await portalGet(portal.app, session.cookie, `/portal/bookings/${booked.bookingId}`)).status,
    ).toBe(404);
  });

  it('P18-D6. Reopen nach Storno: Vorgang „wieder geöffnet“, Buchung bleibt gesperrt (Zuweisung, Vorbereitung, Rückgabestart ⇒ 409), erneutes Storno ⇒ 409 – Stornozeile und Maschine unverändert', async () => {
    const reopen = await staffPost(`/staff/processes/${D1.processId}/reopen`, {});
    expect(reopen.statusCode).toBe(200);
    expect(reopen.json()).toEqual({ reopened: true });
    expect((await processRow(D1.processId)).mainStatus).toBe('reopened');
    const row = (await cancellationsOf(D1.processId))[0]!;
    expect(row.reopenedAt).not.toBeNull();
    expect(row.reopenedBy).toBe(adminId);
    expect(row.financeStatus).toBe('invoice_open'); // Stornokosten bleiben geschuldet (§63)

    const assign = await staffPost(`/staff/handover/${D1.bookingId}/slots/${D1.slotId}/assign`, {
      machineId: D1.machineId,
    });
    expect(assign.statusCode).toBe(409);
    expect(assign.json().error.message).toContain('storniert');
    const prepare = await staffPost(
      `/staff/handover/${D1.bookingId}/slots/${D1.slotId}/prepare`,
      {},
    );
    expect(prepare.statusCode).toBe(409);
    const returnStart = await staffPost(`/staff/returns/${D1.bookingId}/start`, {});
    expect(returnStart.statusCode).toBe(409);
    const again = await cancelViaRoute(D1.processId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.message).toContain('wieder geöffnet');
    const preview = await previewFor(D1.processId);
    expect(preview.blockers).toContain('Der Vorgang ist bereits storniert.');

    expect(await cancellationsOf(D1.processId)).toHaveLength(1);
    expect((await assignmentsOf(D1.bookingId))[0]).toMatchObject({
      status: 'open',
      machineId: null,
    });
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('ready');
    expect(
      await ctx.db.select().from(rentalReturns).where(eq(rentalReturns.bookingId, D1.bookingId)),
    ).toEqual([]);
    expect(await transfersOf(D1.processId)).toHaveLength(1);
  });

  it('P18-D7. Integrität nach Szenario D: alle SQL-Invarianten (inkl. Geisterreservierung, Termine, Gebührenkonsistenz) und Dokument-Storage ohne Befund', async () => {
    expect(await integrityViolations(ctx.pool)).toEqual([]);
    expect(await documentStorageMismatches(ctx.pool, ctx.storage)).toEqual([]);
    const counts = await tableCounts(ctx.pool, ['cancellations', 'accounting_transfers']);
    // Stornos: D1 (Staff, 50 %), D2 (Kunde, 50 %), D5 (Staff, 0 %); Transfers: D1, D2 und die Abrechnung aus D3a.
    expect(counts).toEqual({ cancellations: 3, accounting_transfers: 3 });
  });
});
