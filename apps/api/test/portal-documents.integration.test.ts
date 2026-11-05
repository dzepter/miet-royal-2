/**
 * Phase-15-Pflichttests Dokumente (Order §59, Design §2.3): nur finale,
 * kundenrelevante Dokumente der sichtbaren Buchung – angenommene Angebotsversion
 * (nie supersedete), freigegebene AB, Lieferschein/Übergabeprotokoll nach
 * finalisierter Übergabe, Rückgabeprotokoll; keine Entwürfe; fremdes Dokument
 * 404; private Bytes mit no-store/nosniff und sicherem Dateinamen; kein
 * Storage-Key im DTO.
 */
import { deliveryNotes, documents, handovers } from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PORTAL_DOCUMENT_LABELS, type PortalDocumentView } from '../src/portal/views.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { adminSession } from './cancellation-helpers.ts';
import {
  commerceServices,
  createCommerceWorld,
  setPickupExactAddress,
} from './commerce-helpers.ts';
import {
  initializeAllInventory,
  readyHandover,
  scheduledBooking,
} from './handover-helpers.ts';
import { settleMailJobs } from './mail-job-helpers.ts';
import {
  forbiddenKeysIn,
  portalApp,
  portalGet,
  portalSessionFor,
  resetPortalWorld,
  type PortalTestApp,
} from './portal-test-helpers.ts';
import { issuedBooking, readyReturn, startedReturn } from './return-helpers.ts';
import { createAcceptedBooking } from './scheduling-helpers.ts';

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

async function documentsFor(cookie: string, bookingId: string): Promise<PortalDocumentView[]> {
  const response = await portalGet(portal.app, cookie, `/portal/bookings/${bookingId}/documents`);
  expect(response.status).toBe(200);
  return (response.body as { documents: PortalDocumentView[] }).documents;
}

/** Angebot V1 versenden, V2 erzeugen+versenden, V2 annehmen ⇒ V1 supersedet. */
async function bookingWithSupersededOffer(
  adminId: string,
  effective: ReadonlySet<PermissionKey>,
) {
  const world = await createCommerceWorld(ctx, adminId);
  const services = commerceServices(ctx);
  const { offerId, versionId: v1 } = await services.offers.createOffer(adminId, world.processId);
  await services.offers.send(adminId, v1, effective);
  const next = await services.offers.createNewVersion(adminId, offerId, 'Preis erneut geprüft');
  const { token } = await services.offers.send(adminId, next.versionId, effective);
  await settleMailJobs(ctx);
  const { bookingId } = await services.offers.accept(token);
  const v1Doc = (await ctx.db.select().from(documents).where(eq(documents.offerVersionId, v1)))[0]!;
  const v2Doc = (
    await ctx.db.select().from(documents).where(eq(documents.offerVersionId, next.versionId))
  )[0]!;
  return { world, services, bookingId, v1Doc, v2Doc };
}

describe('D1–D6. Welche Dokumente sichtbar sind', () => {
  it('D1./D2. Nur die angenommene Angebotsversion – die supersedete V1 ist unsichtbar und nicht ladbar', async () => {
    const { admin, effective } = await adminSession(ctx);
    const { world, bookingId, v1Doc, v2Doc } = await bookingWithSupersededOffer(
      admin.id,
      effective,
    );
    const session = await portalSessionFor(ctx, world.customerId);
    const list = await documentsFor(session.cookie, bookingId);
    expect(list).toEqual([
      {
        id: v2Doc.id,
        type: 'offer',
        label: PORTAL_DOCUMENT_LABELS.offer,
        createdAt: v2Doc.createdAt.toISOString(),
      },
    ]);
    const superseded = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${bookingId}/documents/${v1Doc.id}`,
    );
    expect(superseded.status).toBe(404);
  });

  it('D3./D6. Auftragsbestätigung erst nach Freigabe – vorbereitete AB (Entwurf) ist unsichtbar', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createAcceptedBooking(ctx, admin.id, { fulfillment: 'pickup' });
    const session = await portalSessionFor(ctx, world.customerId);
    const services = commerceServices(ctx);
    const confirmation = (await services.confirmations.byBookingId(world.bookingId))!;
    expect(confirmation.status).toBe('prepared');
    expect((await documentsFor(session.cookie, world.bookingId)).map((d) => d.type)).toEqual([
      'offer',
    ]);

    await setPickupExactAddress(ctx, admin.id);
    await services.confirmations.approve(admin.id, confirmation.id);
    const approved = await services.confirmations.byId(confirmation.id);
    const list = await documentsFor(session.cookie, world.bookingId);
    expect(list.map((d) => d.type)).toEqual(['offer', 'order_confirmation']);
    expect(list[1]).toMatchObject({
      id: approved.documentId,
      label: PORTAL_DOCUMENT_LABELS.order_confirmation,
    });
  });

  it('D4./D6. Lieferschein + Übergabeprotokoll nur nach finalisierter Übergabe (Entwurf unsichtbar)', async () => {
    const { admin } = await adminSession(ctx);
    // Entwurf: Übergabe vorbereitet, aber nicht finalisiert ⇒ keine Übergabedokumente.
    await initializeAllInventory(ctx, admin.id, 20);
    const draft = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, draft.bookingId, ['MR-10-01-01']);
    const draftSession = await portalSessionFor(ctx, draft.customerId);
    expect((await documentsFor(draftSession.cookie, draft.bookingId)).map((d) => d.type)).toEqual([
      'offer',
    ]);

    // Finalisiert ⇒ Lieferschein und Übergabeprotokoll.
    const issued = await issuedBooking(ctx, admin.id, {
      machineCodes: ['MR-10-01-02'],
      skipInventoryInit: true,
    });
    const handover = (
      await ctx.db.select().from(handovers).where(eq(handovers.bookingId, issued.bookingId))
    )[0]!;
    const note = (
      await ctx.db.select().from(deliveryNotes).where(eq(deliveryNotes.bookingId, issued.bookingId))
    )[0]!;
    expect(handover.status).toBe('finalized');
    const session = await portalSessionFor(ctx, issued.customerId);
    const list = await documentsFor(session.cookie, issued.bookingId);
    expect(list.map((d) => d.type).sort()).toEqual(['delivery_note', 'handover_protocol', 'offer']);
    expect(list.find((d) => d.type === 'handover_protocol')).toMatchObject({
      id: handover.protocolDocumentId,
      label: PORTAL_DOCUMENT_LABELS.handover_protocol,
    });
    expect(list.find((d) => d.type === 'delivery_note')).toMatchObject({
      id: note.documentId,
      label: PORTAL_DOCUMENT_LABELS.delivery_note,
    });
  });

  it('D5. Rückgabeprotokoll nach finalisierter Rückgabe', async () => {
    const { admin } = await adminSession(ctx);
    const { world, services } = await startedReturn(ctx, admin.id);
    const session = await portalSessionFor(ctx, world.customerId);
    expect(
      (await documentsFor(session.cookie, world.bookingId)).some(
        (d) => d.type === 'return_protocol',
      ),
    ).toBe(false);
    await readyReturn(ctx, admin.id, services, world.bookingId);
    const finalized = await services.returns.finalize(admin.id, world.bookingId);
    await settleMailJobs(ctx);
    const list = await documentsFor(session.cookie, world.bookingId);
    expect(list.find((d) => d.type === 'return_protocol')).toMatchObject({
      id: finalized.return.protocolDocumentId,
      label: PORTAL_DOCUMENT_LABELS.return_protocol,
    });
    // Alle Dokumenttypen stammen aus der festen Kundenliste – nie „Rechnung“.
    for (const document of list) {
      expect(Object.keys(PORTAL_DOCUMENT_LABELS)).toContain(document.type);
    }
  });
});

describe('D7–D11. Download: Eigentum, private Bytes, Header, kein Storage-Key', () => {
  it('D7. Fremdes Dokument ⇒ 404 (fremde Buchung, fremdes Dokument über eigene Buchung)', async () => {
    const { admin, effective } = await adminSession(ctx);
    const a = await bookingWithSupersededOffer(admin.id, effective);
    const b = await createAcceptedBooking(ctx, admin.id);
    const sessionB = await portalSessionFor(ctx, b.customerId);
    // B versucht A's Dokument über A's Buchung …
    const viaForeignBooking = await portalGet(
      portal.app,
      sessionB.cookie,
      `/portal/bookings/${a.bookingId}/documents/${a.v2Doc.id}`,
    );
    expect(viaForeignBooking.status).toBe(404);
    // … und über die eigene Buchung (Dokument gehört nicht dazu).
    const viaOwnBooking = await portalGet(
      portal.app,
      sessionB.cookie,
      `/portal/bookings/${b.bookingId}/documents/${a.v2Doc.id}`,
    );
    expect(viaOwnBooking.status).toBe(404);
    expect(viaOwnBooking.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
    // Ohne Session: 401.
    const anonymous = await portalGet(
      portal.app,
      null,
      `/portal/bookings/${a.bookingId}/documents/${a.v2Doc.id}`,
    );
    expect(anonymous.status).toBe(401);
  });

  it('D8.–D10. Eigenes Dokument: PDF-Bytes aus privatem Storage, no-store, nosniff, sicherer Dateiname', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createAcceptedBooking(ctx, admin.id);
    const session = await portalSessionFor(ctx, world.customerId);
    const [offer] = await documentsFor(session.cookie, world.bookingId);
    const response = await portalGet(
      portal.app,
      session.cookie,
      `/portal/bookings/${world.bookingId}/documents/${offer!.id}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.raw.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(String(response.headers['content-disposition'])).toMatch(
      /^inline; filename="[a-z0-9-]+\.pdf"$/,
    );
    expect(String(response.headers['content-disposition'])).toContain('angebot.pdf');
    const row = (await ctx.db.select().from(documents).where(eq(documents.id, offer!.id)))[0]!;
    expect(response.raw.length).toBe(row.byteSize);
  });

  it('D11. Dokument-DTO enthält weder Storage-Key noch Hash/Byte-Größe', async () => {
    const { admin } = await adminSession(ctx);
    const world = await createAcceptedBooking(ctx, admin.id);
    const session = await portalSessionFor(ctx, world.customerId);
    const list = await documentsFor(session.cookie, world.bookingId);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]!).sort()).toEqual(['createdAt', 'id', 'label', 'type']);
    expect(forbiddenKeysIn(list)).toEqual([]);
    const row = (await ctx.db.select().from(documents).where(eq(documents.id, list[0]!.id)))[0]!;
    const text = JSON.stringify(list);
    expect(text).not.toContain(row.storageKey);
    expect(text).not.toContain(row.sha256);
  });
});
