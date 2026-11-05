/**
 * Phase-15-Pflichttests Rechnungsstatus (Order §62, Design §2.2): open ⇒ Offen,
 * paid ⇒ Bezahlt (Buchung danach unsichtbar), overdue ⇒ Überfällig; keine
 * Providerreferenz, keine Transferfehler, keine Lexware-ID; vorläufige Schäden
 * erreichen den Kunden nicht; finaler Betrag erst nach Sperre; kein erfundenes
 * Rechnungs-PDF.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { portalInvoiceStatus } from '../src/portal/invoice-status.ts';
import type { VisibleBooking } from '../src/portal/visibility.ts';
import type { PortalBookingView, PortalDocumentView } from '../src/portal/views.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { adminSession, bookingRow } from './cancellation-helpers.ts';
import {
  forbiddenKeysIn,
  portalApp,
  portalGet,
  portalSessionFor,
  resetPortalWorld,
  type PortalTestApp,
} from './portal-test-helpers.ts';
import { openClarifications, settledReturn, settlementRowFor } from './settlement-helpers.ts';
import { paidSettledWorld } from './voucher-helpers.ts';

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

describe('I1–I3. Zahlungsstatus', () => {
  it('I1. open ⇒ „Offen“ mit finalem Betrag (amount_due) – Buchung completed_open', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'open' });
    const session = await portalSessionFor(ctx, paid.world.customerId);
    const view = await viewFor(session.cookie, paid.world.bookingId);
    expect(view.portalState).toBe('completed_open');
    expect(view.invoice).toEqual({
      status: 'open',
      label: 'Offen',
      finalAmountCents: paid.view.settlement.amountDueCents,
    });
    expect(view.canCancelOnline).toBe(false);
    expect(view.canMessage).toBe(false);
  });

  it('I2. paid ⇒ „Bezahlt“ (Abbildung) – und die Buchung ist im Portal nicht mehr aktuell', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'paid' });
    const session = await portalSessionFor(ctx, paid.world.customerId);
    const response = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${paid.world.bookingId}`,
    );
    expect(response.status).toBe(404);
    // Abbildung der Statuslogik (dieselbe Funktion, die die Ansicht nutzt):
    const settlement = (await settlementRowFor(ctx, paid.world.processId))!;
    expect(settlement.paymentStatus).toBe('paid');
    const visible: VisibleBooking = {
      booking: await bookingRow(ctx, paid.world.bookingId),
      process: {
        id: paid.world.processId,
        processNumber: 'MR-0000-0000',
        mainStatus: 'completed',
        eventDate: null,
      },
      settlement: {
        id: settlement.id,
        lockedAt: settlement.lockedAt,
        paymentStatus: settlement.paymentStatus,
        amountDueCents: settlement.amountDueCents,
      },
      cancellation: null,
      portalState: 'completed_open',
    };
    expect(portalInvoiceStatus(visible)).toEqual({
      status: 'paid',
      label: 'Bezahlt',
      finalAmountCents: settlement.amountDueCents,
    });
  });

  it('I3. overdue ⇒ „Überfällig“', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'overdue' });
    const session = await portalSessionFor(ctx, paid.world.customerId);
    const view = await viewFor(session.cookie, paid.world.bookingId);
    expect(view.invoice).toEqual({
      status: 'overdue',
      label: 'Überfällig',
      finalAmountCents: paid.view.settlement.amountDueCents,
    });
  });
});

describe('I4–I9. Keine Interna, keine vorläufigen Beträge, kein Rechnungs-PDF', () => {
  it('I4.–I6. Keine Providerreferenz, keine Transferfehler, keine Lexware-ID in der Portalantwort', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'open' });
    const session = await portalSessionFor(ctx, paid.world.customerId);
    const view = await viewFor(session.cookie, paid.world.bookingId);
    const text = JSON.stringify(view);
    expect(forbiddenKeysIn(view)).toEqual([]);
    expect(Object.keys(view.invoice).sort()).toEqual(['finalAmountCents', 'label', 'status']);
    const reference = paid.view.settlement.accountingReference;
    if (reference !== null) expect(text).not.toContain(reference);
    expect(text).not.toContain(paid.transferId);
    expect(text).not.toContain(paid.settlementId);
    expect(text).not.toMatch(/lexware|MOCK|transfer|accounting|provider/i);
    const keys = new Set<string>();
    JSON.parse(text, (key, value) => {
      keys.add(key);
      return value;
    });
    for (const forbidden of ['transfer', 'accounting', 'mapping', 'lines', 'clarifications']) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });

  it('I7./I8. Vorläufige Schäden erreichen den Kunden nicht; finaler Betrag erst nach Sperre', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view: settlementView } = await settledReturn(ctx, admin.id, cookie, {
      damages: [{ description: 'Kratzer im Gehäusedeckel', severity: 'light' }],
    });
    expect(openClarifications(settlementView, 'damage_cost').length).toBeGreaterThan(0);
    const session = await portalSessionFor(ctx, world.customerId);
    const view = await viewFor(session.cookie, world.bookingId);
    expect(view.portalState).toBe('active');
    expect(view.invoice).toEqual({
      status: 'preparing',
      label: 'Rechnung wird vorbereitet',
      finalAmountCents: null,
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain('Kratzer');
    expect(text).not.toMatch(/damage|schaden|fehlteil|clarification/i);
    // Keine Abrechnungspositionen/Klärungen im DTO – nur der neutrale Status.
    expect(text).not.toMatch(/"lines"|"clarifications"|"charges|"credits|unitPriceCents/);
  });

  it('I9. Kein erfundenes Rechnungs-PDF: Dokumentliste kennt keine Rechnung, keine Rechnungsroute', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const paid = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'open' });
    const session = await portalSessionFor(ctx, paid.world.customerId);
    const response = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${paid.world.bookingId}/documents`,
    );
    expect(response.status).toBe(200);
    const list = (response.body as { documents: PortalDocumentView[] }).documents;
    expect(list.length).toBeGreaterThan(0);
    for (const document of list) {
      expect([
        'offer',
        'order_confirmation',
        'delivery_note',
        'handover_protocol',
        'return_protocol',
      ]).toContain(document.type);
      expect(document.label).not.toMatch(/rechnung/i);
    }
    for (const url of [
      `/portal/bookings/${paid.world.bookingId}/invoice`,
      `/portal/bookings/${paid.world.bookingId}/invoice.pdf`,
      `/portal/bookings/${paid.world.bookingId}/documents/invoice`,
    ]) {
      expect((await portalGet(portal.app, session.cookie, url)).status, url).toBe(404);
    }
  });
});
