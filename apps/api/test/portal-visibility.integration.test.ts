/**
 * Phase-15-Pflichttests Visibility (Order §57, Design §2.1/§2.6): die zentrale
 * CustomerPortalVisibilityPolicy – Anfrage/Angebot nie sichtbar, open/reopened
 * sichtbar, completed nur solange finanziell offen, Stornos je nach Gebühr und
 * Zahlungsstatus, mehrere aktuelle Buchungen sortiert, fremde Buchung 404,
 * keine Historien-API.
 */
import { cancellations, processes } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PORTAL_STATE_LABELS } from '../src/portal/views.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { adminSession, bookedProcess, cancelBooking } from './cancellation-helpers.ts';
import { commerceServices, createCommerceWorld } from './commerce-helpers.ts';
import { adminVisibilityCtx, processServiceFor } from './crm-helpers.ts';
import {
  acceptedBookingForCustomer,
  portalApp,
  portalGet,
  portalSessionFor,
  resetPortalWorld,
  type PortalTestApp,
} from './portal-test-helpers.ts';
import { createAcceptedBooking } from './scheduling-helpers.ts';
import { drainAllJobs } from './settlement-helpers.ts';
import { paidSettledWorld, setPaymentViaRoute } from './voucher-helpers.ts';

let ctx: TestContext;
let portal: PortalTestApp;

beforeAll(async () => {
  ctx = await createTestContext();
  portal = await portalApp(ctx);
});
afterAll(async () => {
  await portal.close();
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetPortalWorld(ctx);
});

interface Summary {
  bookingId: string;
  processNumber: string;
  portalState: string;
  stateLabel: string;
  eventDate: string | null;
}

async function listFor(cookie: string): Promise<Summary[]> {
  const response = await portalGet(portal.app, cookie, '/portal/bookings');
  expect(response.status).toBe(200);
  return (response.body as { bookings: Summary[] }).bookings;
}

async function detailStatus(cookie: string, bookingId: string): Promise<number> {
  return (await portalGet(portal.app, cookie, `/portal/bookings/${bookingId}`)).status;
}

const HOUR_MS = 3_600_000;

describe('V1–V4. Grundzustände', () => {
  it('V1. Anfrage ohne Buchung ist im Portal unsichtbar (keine Buchung, Detail 404)', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createCommerceWorld(ctx, admin.id);
    const session = await portalSessionFor(ctx, world.customerId);
    expect(await listFor(session.cookie)).toEqual([]);
    expect(await detailStatus(session.cookie, world.processId)).toBe(404);
  });

  it('V2. Ein versendetes, nicht angenommenes Angebot ist keine Portalbuchung', async () => {
    const { admin, effective } = await adminSession(ctx);
    const world = await createCommerceWorld(ctx, admin.id);
    const services = commerceServices(ctx);
    const { versionId } = await services.offers.createOffer(admin.id, world.processId);
    await services.offers.send(admin.id, versionId, effective);
    const session = await portalSessionFor(ctx, world.customerId);
    expect(await listFor(session.cookie)).toEqual([]);
  });

  it('V3. Offener Vorgang mit Buchung ist sichtbar (active, „Bestätigte Buchung“)', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createAcceptedBooking(ctx, admin.id);
    const session = await portalSessionFor(ctx, world.customerId);
    const list = await listFor(session.cookie);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      bookingId: world.bookingId,
      portalState: 'active',
      stateLabel: PORTAL_STATE_LABELS.active,
    });
    expect(list[0]!.processNumber).toMatch(/^MR-\d{4}-\d{4}$/);
    expect(await detailStatus(session.cookie, world.bookingId)).toBe(200);
  });

  it('V4. completed ohne Abrechnung bleibt sichtbar (completed_open); reopened ist wieder active', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const session = await portalSessionFor(ctx, booked.customerId);
    const processService = processServiceFor(ctx);
    await processService.complete(booked.processId, adminVisibilityCtx());
    let list = await listFor(session.cookie);
    expect(list.map((b) => b.portalState)).toEqual(['completed_open']);
    expect(list[0]!.stateLabel).toBe(PORTAL_STATE_LABELS.completed_open);

    await processService.reopen(booked.processId, admin.id);
    const row = (
      await ctx.db.select().from(processes).where(eq(processes.id, booked.processId))
    )[0]!;
    expect(row.mainStatus).toBe('reopened');
    list = await listFor(session.cookie);
    expect(list.map((b) => b.portalState)).toEqual(['active']);
  });
});

describe('V5–V6. Abgeschlossen und finanziell offen/bezahlt', () => {
  it('V5. completed + Zahlungsstatus open bzw. overdue ⇒ sichtbar als completed_open', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const open = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'open' });
    const openSession = await portalSessionFor(ctx, open.world.customerId);
    const openList = await listFor(openSession.cookie);
    expect(openList).toHaveLength(1);
    expect(openList[0]).toMatchObject({
      bookingId: open.world.bookingId,
      portalState: 'completed_open',
    });

    const overdue = await paidSettledWorld(ctx, admin.id, cookie, {
      paymentStatus: 'overdue',
      machineCodes: ['MR-10-01-02'],
    });
    const overdueSession = await portalSessionFor(ctx, overdue.world.customerId);
    expect((await listFor(overdueSession.cookie)).map((b) => b.portalState)).toEqual([
      'completed_open',
    ]);
  });

  it('V6. completed + paid ⇒ unsichtbar (Liste leer, Detail 404)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'paid' });
    const session = await portalSessionFor(ctx, paid.world.customerId);
    expect(await listFor(session.cookie)).toEqual([]);
    expect(await detailStatus(session.cookie, paid.world.bookingId)).toBe(404);
  });
});

describe('V7–V9. Stornierte Buchungen', () => {
  it('V7. 0-Euro-Storno: nicht in der Liste, Detail nur 24 h als Bestätigungsansicht, danach 404', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 30 });
    const session = await portalSessionFor(ctx, booked.customerId);
    const view = await cancelBooking(ctx, admin.id, booked.processId);
    expect(view.feeCents).toBe(0);

    expect(await listFor(session.cookie)).toEqual([]);
    const detail = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${booked.bookingId}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      portalState: 'cancelled_free',
      stateLabel: PORTAL_STATE_LABELS.cancelled_free,
      cancellation: { feeCents: 0, feePercent: 0, invoiceFollows: false },
    });

    // Nach dem 24-h-Fenster verschwindet auch die Bestätigungsansicht.
    await ctx.db
      .update(cancellations)
      .set({ cancelledAt: new Date(Date.now() - 25 * HOUR_MS) })
      .where(eq(cancellations.processId, booked.processId));
    expect(await detailStatus(session.cookie, booked.bookingId)).toBe(404);
  });

  it('V8. Kostenpflichtiges Storno bleibt sichtbar, solange finanziell offen (cancelled_fee)', async () => {
    const { admin } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const session = await portalSessionFor(ctx, booked.customerId);
    const view = await cancelBooking(ctx, admin.id, booked.processId);
    expect(view.feePercent).toBe(50);

    const list = await listFor(session.cookie);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      bookingId: booked.bookingId,
      portalState: 'cancelled_fee',
      stateLabel: PORTAL_STATE_LABELS.cancelled_fee,
    });
    expect(await detailStatus(session.cookie, booked.bookingId)).toBe(200);
  });

  it('V9. Kostenpflichtiges Storno + bezahlt ⇒ unsichtbar', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const booked = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    const session = await portalSessionFor(ctx, booked.customerId);
    await cancelBooking(ctx, admin.id, booked.processId);
    await drainAllJobs(ctx); // Storno-Transferjob (Mock-Buchhaltung)
    const row = (
      await ctx.db.select().from(cancellations).where(eq(cancellations.processId, booked.processId))
    )[0]!;
    expect(row.financeStatus).toBe('invoice_open');
    expect((await listFor(session.cookie)).map((b) => b.portalState)).toEqual(['cancelled_fee']);

    await setPaymentViaRoute(ctx, cookie, row.accountingTransferId!, 'paid');
    expect(await listFor(session.cookie)).toEqual([]);
    expect(await detailStatus(session.cookie, booked.bookingId)).toBe(404);
  });
});

describe('V10–V13. Keine Historie, mehrere Buchungen, fremde Buchung', () => {
  it('V10. Eine alte bezahlte Buchung erscheint nie – auch nicht über Query-Parameter', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'paid' });
    const current = await acceptedBookingForCustomer(ctx, admin.id, paid.world.customerId, {
      eventInDays: 20,
    });
    const session = await portalSessionFor(ctx, paid.world.customerId);
    for (const url of [
      '/portal/bookings',
      '/portal/bookings?all=1',
      '/portal/bookings?history=true',
      '/portal/bookings?includeCompleted=1&includePaid=1',
    ]) {
      const response = await portalGet(portal.app, session.cookie, url);
      expect(response.status).toBe(200);
      const ids = (response.body as { bookings: Summary[] }).bookings.map((b) => b.bookingId);
      expect(ids).toEqual([current.bookingId]);
    }
    expect(await detailStatus(session.cookie, paid.world.bookingId)).toBe(404);
  });

  it('V11. Mehrere aktuelle eigene Buchungen: sortiert nach nächstem Eventdatum, dann Vorgangsnummer', async () => {
    const { admin } = await adminSession(ctx);
    const first = await createAcceptedBooking(ctx, admin.id, { eventInDays: 40 });
    const second = await acceptedBookingForCustomer(ctx, admin.id, first.customerId, {
      eventInDays: 20,
    });
    const third = await acceptedBookingForCustomer(ctx, admin.id, first.customerId, {
      eventInDays: 40,
      fulfillment: 'delivery',
    });
    const session = await portalSessionFor(ctx, first.customerId);
    const list = await listFor(session.cookie);
    expect(list).toHaveLength(3);
    expect(list[0]!.bookingId).toBe(second.bookingId);
    // Gleiches Eventdatum: Vorgangsnummer entscheidet (first wurde vor third angelegt).
    expect(list.slice(1).map((b) => b.bookingId)).toEqual([first.bookingId, third.bookingId]);
    expect(list[1]!.processNumber < list[2]!.processNumber).toBe(true);
    for (const entry of list) expect(entry.portalState).toBe('active');
  });

  it('V12. Fremde Buchung ⇒ neutrales 404 auf jeder Buchungsroute', async () => {
    const { admin } = await adminSession(ctx);
    const own = await createAcceptedBooking(ctx, admin.id);
    const other = await createAcceptedBooking(ctx, admin.id);
    const session = await portalSessionFor(ctx, other.customerId);
    for (const suffix of [
      '',
      '/travel-status',
      '/documents',
      '/cancellation/preview',
      `/documents/${own.bookingId}`,
    ]) {
      const response = await portalGet(
        portal.app,
        session.cookie,
        `/portal/bookings/${own.bookingId}${suffix}`,
      );
      expect(response.status, suffix).toBe(404);
      expect(response.body).toMatchObject({
        error: { code: 'NOT_FOUND', message: 'Nicht gefunden.' },
      });
    }
    expect((await listFor(session.cookie)).map((b) => b.bookingId)).toEqual([other.bookingId]);
  });

  it('V13. Es gibt keine History-API', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createAcceptedBooking(ctx, admin.id);
    const session = await portalSessionFor(ctx, world.customerId);
    for (const url of [
      '/portal/bookings/history',
      '/portal/bookings/archive',
      '/portal/bookings/all',
      '/portal/history',
      `/portal/customers/${world.customerId}/bookings`,
    ]) {
      const response = await portalGet(portal.app, session.cookie, url);
      expect(response.status, url).toBe(404);
    }
  });
});
