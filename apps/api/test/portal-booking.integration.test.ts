/**
 * Phase-15-Pflichttests Buchungsansicht (Order §58, Design §2.2): Snapshot-
 * Treue (Maschine/Extras/Event/Preis, Produktpreis- und Profiländerungen
 * ändern nichts), Liefer- und kanonische Abholadresse, Navigation ohne
 * Kunden-/Vorgangsdaten, exakte Zeit vs. Zeitfenster, „Unterwegs“ über
 * getCustomerTravelStatus ohne ETA/GPS/Fahrername.
 */
import { bookings } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PortalBookingView } from '../src/portal/views.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { adminSession, bookingRow } from './cancellation-helpers.ts';
import { productServiceFor, setPickupExactAddress } from './commerce-helpers.ts';
import { customerServiceFor } from './crm-helpers.ts';
import {
  appointmentsForBooking,
  portalApp,
  portalGet,
  portalSessionFor,
  resetPortalWorld,
  type PortalTestApp,
} from './portal-test-helpers.ts';
import { createAcceptedBooking, schedulingServiceFor } from './scheduling-helpers.ts';
import {
  berlinAt,
  createToursWorld,
  destroyToursWorld,
  resetToursWorld,
  startActiveTour,
  todayBerlin,
  type ToursWorld,
} from './tours-helpers.ts';

const PICKUP_ADDRESS = 'Teststraße 1, 55129 Mainz-Hechtsheim (SYNTHETISCH)';
const DAY_MS = 86_400_000;

interface SnapshotItem {
  kind: string;
  description: string;
  quantity: number;
  unit: string | null;
  agreedUnitPriceCents: number;
  totalCents: number | null;
  billingMode: string;
  standardUnitPriceCents: number;
}

describe('B1–B8. Buchungsansicht aus dem Snapshot', () => {
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

  async function viewFor(cookie: string, bookingId: string): Promise<PortalBookingView> {
    const response = await portalGet(portal.app, cookie, `/portal/bookings/${bookingId}`);
    expect(response.status).toBe(200);
    return response.body as PortalBookingView;
  }

  it('B1. Maschine, Extras, Event und Preis kommen exakt aus dem eingefrorenen Snapshot', async () => {
    const { admin } = await adminSession(ctx);
    const products = productServiceFor(ctx);
    const cups = await products.getProductBySlug('becher-25');
    const syrup = await products.getProductBySlug('sirup-kirsche');
    const world = await createAcceptedBooking(ctx, admin.id, {
      eventStart: new Date(Date.now() + 30 * DAY_MS),
      selections: [
        { productId: syrup.id, role: 'free', quantity: 2 },
        { productId: cups.id, role: 'extra', quantity: 3 },
      ],
    });
    const session = await portalSessionFor(ctx, world.customerId);
    const view = await viewFor(session.cookie, world.bookingId);
    const row = await bookingRow(ctx, world.bookingId);
    const items = row.itemsSnapshot as SnapshotItem[];
    const totals = row.totalsSnapshot as Record<string, number>;
    const event = row.eventSnapshot as Record<string, unknown>;

    expect(view.bookingId).toBe(world.bookingId);
    expect(view.processNumber).toMatch(/^MR-\d{4}-\d{4}$/);
    expect(view.items).toHaveLength(items.length);
    for (const item of items) {
      const shown = view.items.find((i) => i.description === item.description);
      expect(shown, item.description).toBeDefined();
      expect(shown).toEqual({
        kind: item.kind,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        agreedUnitPriceCents: item.agreedUnitPriceCents,
        totalCents: item.totalCents,
        billingMode: item.billingMode,
      });
    }
    expect(view.items.some((i) => i.kind === 'machine')).toBe(true);
    expect(view.items.some((i) => i.kind === 'syrup')).toBe(true);
    expect(view.price).toEqual({
      agreedTotalCents: totals.fixedTotalCents,
      machineSubtotalCents: totals.machineSubtotalCents,
      discountCents: totals.discountCents,
      voucherDiscountCents: totals.voucherDiscountCents,
      deliveryPriceCents: null,
    });
    expect(view.event).toEqual({
      eventDate: event.eventDate,
      eventStart: event.eventStart,
      eventEnd: null,
      guestCount: 40,
      occasion: 'birthday',
      onsiteContactName: null,
    });
    expect(view.acceptedAt).toBe(row.acceptedAt.toISOString());
    expect(view.portalState).toBe('active');
    expect(view.canMessage).toBe(true);
    expect(view.canCancelOnline).toBe(true);
    expect(view.invoice).toEqual({
      status: 'none',
      label: 'Keine Rechnung vorhanden',
      finalAmountCents: null,
    });
    expect(view.cancellation).toBeNull();
  });

  it('B2. Eine Produktpreisänderung ändert die Portalansicht nicht (Snapshot-only)', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createAcceptedBooking(ctx, admin.id);
    const session = await portalSessionFor(ctx, world.customerId);
    const before = await viewFor(session.cookie, world.bookingId);
    await productServiceFor(ctx).setCurrentPrice(admin.id, world.machineId, 999_999);
    const after = await viewFor(session.cookie, world.bookingId);
    expect(after.price).toEqual(before.price);
    expect(after.items).toEqual(before.items);
    expect(after.price.agreedTotalCents).toBeLessThan(999_999);
  });

  it('B3. Eine Profiländerung ändert weder Snapshot noch Portalansicht', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createAcceptedBooking(ctx, admin.id);
    const session = await portalSessionFor(ctx, world.customerId);
    const before = await viewFor(session.cookie, world.bookingId);
    const snapshotBefore = (await bookingRow(ctx, world.bookingId)).customerSnapshot;
    await customerServiceFor(ctx).updateCustomer(admin.id, world.customerId, {
      type: 'private',
      firstName: 'Neuer',
      lastName: 'Nachname',
      email: 'neue.adresse@example.com',
      phone: '0171 1112233',
      billingStreet: 'Neue Straße 9',
    });
    const after = await viewFor(session.cookie, world.bookingId);
    expect((await bookingRow(ctx, world.bookingId)).customerSnapshot).toEqual(snapshotBefore);
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain('Neuer');
  });

  it('B4. Lieferung: vereinbarte Lieferadresse aus dem Snapshot, keine Abholung/Navigation', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'delivery' });
    const session = await portalSessionFor(ctx, world.customerId);
    const view = await viewFor(session.cookie, world.bookingId);
    expect(view.fulfillment).toBe('delivery');
    expect(view.delivery).toEqual({ street: 'Lieferweg 12', postalCode: '55129', city: 'Mainz' });
    expect(view.pickup).toBeNull();
    expect(view.travelStatus).toBe('none');
    const row = await bookingRow(ctx, world.bookingId);
    const delivery = row.deliverySnapshot as Record<string, number>;
    expect(view.price.deliveryPriceCents).toBe(delivery.deliveryPriceCents);
    expect(view.appointments.map((a) => [a.kind, a.label])).toEqual([
      ['delivery', 'Lieferung'],
      ['return', 'Rückholung'],
    ]);
  });

  it('B5. Selbstabholung: nur die kanonische, konfigurierte Abholadresse + Navigation', async () => {
    const { admin } = await adminSession(ctx);
    await setPickupExactAddress(ctx, admin.id);
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    const session = await portalSessionFor(ctx, world.customerId);
    const view = await viewFor(session.cookie, world.bookingId);
    expect(view.fulfillment).toBe('pickup');
    expect(view.delivery).toBeNull();
    expect(view.pickup?.address).toBe(PICKUP_ADDRESS);
    const encoded = encodeURIComponent(PICKUP_ADDRESS);
    expect(view.pickup?.navigation).toEqual({
      apple: `https://maps.apple.com/?daddr=${encoded}`,
      android: `geo:0,0?q=${encoded}`,
      web: `https://www.google.com/maps/dir/?api=1&destination=${encoded}`,
    });
  });

  it('B6. Fehlende Abholadresse wird nicht erfunden (address null, keine Navigation)', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    const session = await portalSessionFor(ctx, world.customerId);
    const view = await viewFor(session.cookie, world.bookingId);
    expect(view.pickup).toEqual({ address: null, navigation: null });
    expect(JSON.stringify(view)).not.toContain('Hechtsheim');
  });

  it('B7. Navigationslinks enthalten nur die Adresse – keine Kunden-/Vorgangsdaten', async () => {
    const { admin } = await adminSession(ctx);
    await setPickupExactAddress(ctx, admin.id);
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    const session = await portalSessionFor(ctx, world.customerId);
    const view = await viewFor(session.cookie, world.bookingId);
    const links = view.pickup!.navigation!;
    expect(Object.keys(links).sort()).toEqual(['android', 'apple', 'web']);
    for (const link of Object.values(links)) {
      expect(link).not.toContain(view.processNumber);
      expect(link).not.toContain(world.customerId);
      expect(link).not.toContain(world.bookingId);
      expect(link).not.toContain('Klara');
      expect(link).not.toContain('Kommerz');
      expect(link).not.toMatch(/key=/i);
    }
  });

  it('B8. Exakte Zeit vs. Zeitfenster vs. ungeplant – aus Fenstern wird keine Uhrzeit erfunden', async () => {
    const { admin } = await adminSession(ctx);
    const from = new Date(Date.now() + 30 * DAY_MS);
    from.setUTCHours(8, 0, 0, 0);
    const to = new Date(from.getTime() + 2 * 3_600_000);
    const world = await createAcceptedBooking(ctx, admin.id, {
      fulfillment: 'pickup',
      collectionWindowFrom: from,
      collectionWindowTo: to,
    });
    const session = await portalSessionFor(ctx, world.customerId);
    let view = await viewFor(session.cookie, world.bookingId);
    const pickup = view.appointments.find((a) => a.kind === 'pickup')!;
    const ret = view.appointments.find((a) => a.kind === 'return')!;
    expect(pickup).toEqual({
      kind: 'pickup',
      label: 'Abholung',
      timing: 'window',
      startAt: from.toISOString(),
      endAt: to.toISOString(),
      status: 'scheduled',
    });
    expect(ret).toEqual({
      kind: 'return',
      label: 'Rückgabe',
      timing: 'unplanned',
      startAt: null,
      endAt: null,
      status: 'scheduled',
    });

    // Mitarbeiter legt eine exakte Zeit fest ⇒ exact ohne Ende.
    const rows = await appointmentsForBooking(ctx, world.bookingId);
    const pickupRow = rows.find((r) => r.kind === 'pickup')!;
    const exact = new Date(from.getTime() + 30 * 60_000);
    await schedulingServiceFor(ctx).reschedule(admin.id, pickupRow.id, {
      startAt: exact,
      endAt: null,
      expectedVersion: pickupRow.version,
    });
    view = await viewFor(session.cookie, world.bookingId);
    expect(view.appointments.find((a) => a.kind === 'pickup')).toMatchObject({
      timing: 'exact',
      startAt: exact.toISOString(),
      endAt: null,
    });
    // Termin-DTO trägt nur die kundensicheren Felder.
    for (const appointment of view.appointments) {
      expect(Object.keys(appointment).sort()).toEqual([
        'endAt',
        'kind',
        'label',
        'startAt',
        'status',
        'timing',
      ]);
    }
  });
});

describe('B9–B12. „Unterwegs“ (Phase-13-Status) – ohne GPS, ETA, Fahrername', () => {
  let world: ToursWorld;
  let portal: PortalTestApp;

  beforeAll(async () => {
    world = await createToursWorld();
    portal = await portalApp(world.ctx);
  });
  afterAll(async () => {
    await portal.close();
    await destroyToursWorld(world);
  });
  beforeEach(async () => {
    await resetToursWorld(world);
  });

  it('B9.–B12. en_route nur für den nächsten Kundenstopp der aktiven Tour; Antwort ohne Fahrer/GPS/ETA', async () => {
    const today = todayBerlin();
    const active = await startActiveTour(world, [
      { startAt: berlinAt(today, 23, 0), street: 'Ahornweg 1' },
      { startAt: berlinAt(today, 23, 20), street: 'Birkenstraße 2' },
    ]);
    const [first, second] = active.bookings;
    const firstSession = await portalSessionFor(world.ctx, first!.customerId);
    const secondSession = await portalSessionFor(world.ctx, second!.customerId);

    const firstStatus = await portalGet(
      portal.app,
      firstSession.cookie,
      `/portal/bookings/${first!.bookingId}/travel-status`,
    );
    expect(firstStatus.status).toBe(200);
    expect(firstStatus.body).toEqual({ status: 'en_route' });
    expect(String(firstStatus.headers['cache-control'])).toContain('no-store');

    const secondStatus = await portalGet(
      portal.app,
      secondSession.cookie,
      `/portal/bookings/${second!.bookingId}/travel-status`,
    );
    expect(secondStatus.body).toEqual({ status: 'none' });

    // Übersicht und Detail tragen denselben Status.
    const list = await portalGet(portal.app, firstSession.cookie, '/portal/bookings');
    expect((list.body as { bookings: { travelStatus: string }[] }).bookings[0]?.travelStatus).toBe(
      'en_route',
    );
    const detail = await portalGet(
      portal.app,
      firstSession.cookie,
      `/portal/bookings/${first!.bookingId}`,
    );
    expect(detail.status).toBe(200);
    const view = detail.body as PortalBookingView;
    expect(view.travelStatus).toBe('en_route');

    // Kein ETA, keine Koordinaten, kein Fahrer – in keiner Antwort (B10–B12).
    for (const body of [firstStatus.body, list.body, detail.body]) {
      const text = JSON.stringify(body).toLowerCase();
      expect(text).not.toMatch(/eta|minuten|latitude|longitude|"lat"|"lon"|gps|driver|fahrer/);
      expect(text).not.toContain(active.driver.id);
      expect(text).not.toContain(active.tour.id);
    }
    expect(Object.keys(firstStatus.body as object)).toEqual(['status']);

    // Selbstabholung ist nie „unterwegs“ (Bestand des Kunden: Lieferung fehlt ⇒ none).
    const bookingRows = await world.ctx.db
      .select({ fulfillment: bookings.fulfillment })
      .from(bookings)
      .where(eq(bookings.id, first!.bookingId));
    expect(bookingRows[0]?.fulfillment).toBe('delivery');
  });
});
