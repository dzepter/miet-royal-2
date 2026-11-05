/**
 * Phase-15-Sicherheitstests der Buchungsgrenze (Order §64, Design §0/§2.6):
 * Deep-Scan JEDER Portal-GET-Antwort (und der Storno-Antwort) auf verbotene
 * Schlüssel, 401 ohne/mit ungültiger Session, Staff-Session ist keine
 * Portal-Session, IDOR auf allen Buchungsrouten ⇒ neutrales 404 (unbekannte
 * und fremde IDs antworten identisch), keine Kunden-ID als Autorität.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE_NAME } from '../src/auth/http.ts';
import type { PortalDocumentView } from '../src/portal/views.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  createTestContext,
  destroyTestContext,
  login,
  type TestContext,
} from './auth-helpers.ts';
import { adminSession, bookedProcess, cancelBooking } from './cancellation-helpers.ts';
import { commerceServices, setPickupExactAddress } from './commerce-helpers.ts';
import {
  FORBIDDEN_PORTAL_KEYS,
  forbiddenKeysIn,
  portalApp,
  portalCookie,
  portalGet,
  portalPost,
  portalSessionFor,
  resetPortalWorld,
  type PortalTestApp,
} from './portal-test-helpers.ts';
import { createAcceptedBooking } from './scheduling-helpers.ts';
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

const bookingRoutes = (bookingId: string, documentId: string = randomUUID()) => [
  `/portal/bookings/${bookingId}`,
  `/portal/bookings/${bookingId}/travel-status`,
  `/portal/bookings/${bookingId}/documents`,
  `/portal/bookings/${bookingId}/documents/${documentId}`,
  `/portal/bookings/${bookingId}/cancellation/preview`,
];

describe('S1. Deep-Scan jeder Portal-Antwort', () => {
  it('S1. Keine verbotenen Schlüssel in Übersicht, Detail, Travel-Status, Dokumenten, Vorschau und Storno-Antwort', async () => {
    const { admin, cookie } = await adminSession(ctx);
    expect(FORBIDDEN_PORTAL_KEYS.length).toBeGreaterThan(30);

    // Reichhaltige Welt: Selbstabholung mit freigegebener AB + Abholadresse …
    await setPickupExactAddress(ctx, admin.id);
    const pickup = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    const services = commerceServices(ctx);
    const confirmation = (await services.confirmations.byBookingId(pickup.bookingId))!;
    await services.confirmations.approve(admin.id, confirmation.id);
    // … Lieferung, kostenpflichtiges Staff-Storno, abgeschlossen mit offener Rechnung …
    const delivery = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'delivery' });
    const cancelledFee = await bookedProcess(ctx, admin.id, { eventInDays: 10 });
    await cancelBooking(ctx, admin.id, cancelledFee.processId);
    const completed = await paidSettledWorld(ctx, admin.id, cookie, { paymentStatus: 'overdue' });
    // … und ein frisches Kundenstorno (POST-Antwort).
    const toCancel = await bookedProcess(ctx, admin.id, { eventInDays: 30 });

    const customers = [
      pickup.customerId,
      delivery.customerId,
      cancelledFee.customerId,
      completed.world.customerId,
      toCancel.customerId,
    ];
    const bookingIds = [
      pickup.bookingId,
      delivery.bookingId,
      cancelledFee.bookingId,
      completed.world.bookingId,
      toCancel.bookingId,
    ];
    let scanned = 0;
    for (const [index, customerId] of customers.entries()) {
      const session = await portalSessionFor(ctx, customerId);
      const bookingId = bookingIds[index]!;
      const responses = [await portalGet(portal.app, session.cookie, '/portal/bookings')];
      for (const url of bookingRoutes(bookingId).filter((u) => !u.includes('/documents/'))) {
        responses.push(await portalGet(portal.app, session.cookie, url));
      }
      const documents = responses[3]!.body as { documents: PortalDocumentView[] };
      for (const document of documents.documents) {
        const download = await portalGet(
          portal.app,
          session.cookie,
          `/portal/bookings/${bookingId}/documents/${document.id}`,
        );
        expect(download.status).toBe(200);
        expect(download.headers['content-type']).toBe('application/pdf');
      }
      if (bookingId === toCancel.bookingId) {
        responses.push(
          await portalPost(
            portal.app,
            session.cookie,
            `/portal/bookings/${bookingId}/cancellation`,
            {
              confirm: true,
              expectedFeeCents: 0, // Phase 15 (Review R2): 30 Tage ⇒ angezeigte Gebühr 0 €
            },
          ),
        );
      }
      for (const response of responses) {
        expect(response.status, `${customerId} ${JSON.stringify(response.body)}`).toBe(200);
        expect(forbiddenKeysIn(response.body)).toEqual([]);
        const text = JSON.stringify(response.body);
        expect(text).not.toContain(admin.id);
        expect(text).not.toContain(customerId);
        expect(text).not.toMatch(/documents\/offers\//); // Storage-Pfade
        scanned += 1;
      }
    }
    expect(scanned).toBeGreaterThanOrEqual(26);
  });
});

describe('S2–S5. Authentifizierung, Staff-Session, IDOR, Autorität', () => {
  it('S2. Ohne Cookie, mit unbekanntem oder fehlerhaftem Token ⇒ 401 PORTAL_UNAUTHENTICATED auf allen Routen', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createAcceptedBooking(ctx, admin.id);
    const unknown = portalCookie(ctx, 'A'.repeat(43));
    const malformed = portalCookie(ctx, 'kurz');
    for (const cookie of [null, unknown, malformed]) {
      for (const url of ['/portal/bookings', ...bookingRoutes(world.bookingId)]) {
        const response = await portalGet(portal.app, cookie, url);
        expect(response.status, `${cookie} ${url}`).toBe(401);
        expect(response.body).toMatchObject({ error: { code: 'PORTAL_UNAUTHENTICATED' } });
      }
      const post = await portalPost(
        portal.app,
        cookie,
        `/portal/bookings/${world.bookingId}/cancellation`,
        { confirm: true },
      );
      expect(post.status).toBe(401);
    }
  });

  it('S3. Eine Staff-Session ist keine Portal-Session', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createAcceptedBooking(ctx, admin.id);
    const staff = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(staff.cookie).toContain(SESSION_COOKIE_NAME);
    for (const url of ['/portal/bookings', `/portal/bookings/${world.bookingId}`]) {
      const response = await portalGet(portal.app, staff.cookie, url);
      expect(response.status).toBe(401);
    }
    // Auch als Wert des Portal-Cookies ist das Staff-Token wertlos.
    const staffToken = staff.cookie.split('=')[1]?.split(';')[0] ?? '';
    const response = await portalGet(portal.app, portalCookie(ctx, staffToken), '/portal/bookings');
    expect(response.status).toBe(401);
  });

  it('S4. IDOR: fremde und unbekannte IDs antworten identisch (404 „Nicht gefunden.“) auf allen Buchungsrouten', async () => {
    const { admin } = await adminSession(ctx);
    const victim = await createAcceptedBooking(ctx, admin.id);
    const attacker = await createAcceptedBooking(ctx, admin.id);
    const session = await portalSessionFor(ctx, attacker.customerId);
    const victimDocs = (
      (
        await portalGet(
          portal.app,
          (await portalSessionFor(ctx, victim.customerId)).cookie,
          `/portal/bookings/${victim.bookingId}/documents`,
        )
      ).body as { documents: PortalDocumentView[] }
    ).documents;
    expect(victimDocs.length).toBeGreaterThan(0);

    const foreign = bookingRoutes(victim.bookingId, victimDocs[0]!.id);
    const unknown = bookingRoutes(randomUUID());
    const malformed = ['/portal/bookings/nicht-eine-uuid', '/portal/bookings/1'];
    for (const url of [...foreign, ...unknown, ...malformed]) {
      const response = await portalGet(portal.app, session.cookie, url);
      expect(response.status, url).toBe(404);
      const body = response.body as { error: { code: string; message: string } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toBe('Nicht gefunden.');
    }
    // Fremdes Dokument über die eigene Buchung ⇒ ebenfalls 404.
    const crossDocument = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${attacker.bookingId}/documents/${victimDocs[0]!.id}`,
    );
    expect(crossDocument.status).toBe(404);
    // Fremdes Storno ⇒ 404, keine Wirkung.
    const cancel = await portalPost(
      portal.app,
      session.cookie,
      `/portal/bookings/${victim.bookingId}/cancellation`,
      { confirm: true },
    );
    expect(cancel.status).toBe(404);
    const victimView = await portalGet(
      portal.app,
      (await portalSessionFor(ctx, victim.customerId)).cookie,
      `/portal/bookings/${victim.bookingId}`,
    );
    expect((victimView.body as { portalState: string }).portalState).toBe('active');
  });

  it('S5. Kunden-ID im Body/Query ist nie Autorität: Fremdfelder ⇒ 400, Query wird ignoriert', async () => {
    const { admin } = await adminSession(ctx);
    const own = await createAcceptedBooking(ctx, admin.id);
    const other = await createAcceptedBooking(ctx, admin.id);
    const session = await portalSessionFor(ctx, own.customerId);
    const rejected = await portalPost(
      portal.app,
      session.cookie,
      `/portal/bookings/${own.bookingId}/cancellation`,
      // Phase 15 (Review R2): mit Pflichtfeld – die 400 kommt allein von `customerId` (strict).
      { confirm: true, expectedFeeCents: 0, customerId: other.customerId },
    );
    expect(rejected.status).toBe(400);
    const list = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings?customerId=${other.customerId}`,
    );
    expect(list.status).toBe(200);
    expect(
      (list.body as { bookings: { bookingId: string }[] }).bookings.map((b) => b.bookingId),
    ).toEqual([own.bookingId]);
    const detail = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${other.bookingId}?customerId=${other.customerId}`,
    );
    expect(detail.status).toBe(404);
  });
});
