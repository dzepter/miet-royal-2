/**
 * Phase 15 – Kundenportal CHAT, Kundenseite (Order §25–§28, §60; Design §3.1):
 * Nachrichten nur nach bestätigter Buchung und nur auf dem Kanal portal, Fotos
 * mit Phase-12-Prüfung (JPEG/PNG/WebP, Magic Bytes, 8 MiB), Sender aus der
 * Session, interne Push-Benachrichtigung ohne Nachrichtentext, Terminal ⇒ keine
 * neuen Nachrichten, Retention (Fotos sofort, Text 12 Monate), keine E-Mail-/
 * WhatsApp-Historie im Portal.
 */
import { randomUUID } from 'node:crypto';
import {
  conversationMessages,
  customerPortalSessions,
  messagePhotos,
  processes,
  pushDeliveries,
} from '@mietroyal/database';
import { addBerlinCalendarMonths } from '@mietroyal/domain';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConversationService } from '../src/communication/conversation/conversation-service.ts';
import { PORTAL_MESSAGE_PUSH_BODY } from '../src/communication/push/payload.ts';
import { PushService } from '../src/communication/push/push-service.ts';
import {
  notifyStaffOfPortalMessage,
  portalMessagePushKey,
  portalMessageRecipients,
} from '../src/portal/chat/notify.ts';
import { PORTAL_PHOTO_REJECTED_MESSAGE } from '../src/portal/chat/chat-service.ts';
import { PORTAL_MESSAGES } from '../src/portal/types.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createEmployeeWithPassword,
  createTestContext,
  destroyTestContext,
  login,
  type TestContext,
} from './auth-helpers.ts';
import { resetForCancellationTests } from './cancellation-helpers.ts';
import {
  completeProcess,
  createCustomerWithProcess,
  drainJobs,
  truncateCommunicationTables,
} from './communication-helpers.ts';
import { processServiceFor } from './crm-helpers.ts';
import { PNG_1X1 } from './handover-helpers.ts';
import { loginPortalCustomer, truncatePortalTables } from './portal-auth-helpers.ts';
import { JPEG_1X1 } from './return-helpers.ts';
import { createAcceptedBooking, substitutionServiceFor } from './scheduling-helpers.ts';

let ctx: TestContext;
let adminId: string;
let adminCookie: string;

const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');
const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
const PUSH_KEYS = { p256dh: 'BPk'.padEnd(87, 'A'), auth: 'auth-secret-16by' };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await truncateCommunicationTables(ctx.pool);
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncatePortalTables(ctx.pool);
  await truncateCommunicationTables(ctx.pool);
  await ctx.pool.query('TRUNCATE push_deliveries, push_subscriptions CASCADE');
  await resetForCancellationTests(ctx); // enthält Auth-/CRM-/Commerce-Reset in FK-Reihenfolge
  ctx.push.reset();
  ctx.mailGateway.reset();
  const admin = await bootstrapAdmin(ctx);
  adminId = admin.id;
  adminCookie = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
});

/** Bestätigte Buchung + Portal-Session des Kunden. */
async function portalBooking(options: Parameters<typeof createAcceptedBooking>[2] = {}) {
  const world = await createAcceptedBooking(ctx, adminId, options);
  const cookie = await loginPortalCustomer(ctx, world.customerId);
  return { ...world, cookie };
}

const listMessages = (cookie: string, bookingId: string) =>
  ctx.app.inject({
    method: 'GET',
    url: `/portal/bookings/${bookingId}/messages`,
    headers: { cookie },
  });

const postMessage = (cookie: string, bookingId: string, payload: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: `/portal/bookings/${bookingId}/messages`,
    headers: { cookie },
    payload,
  });

const photoRoute = (cookie: string, bookingId: string, messageId: string, photoId: string) =>
  ctx.app.inject({
    method: 'GET',
    url: `/portal/bookings/${bookingId}/messages/${messageId}/photos/${photoId}`,
    headers: { cookie },
  });

const photo = (bytes: Buffer, mimeType = 'image/png') => ({
  mimeType,
  dataBase64: bytes.toString('base64'),
});

/** Nur Portalzeilen – die Angebotsmail der Buchung erzeugt zusätzlich ein E-Mail-Systemereignis. */
async function messageRows(processId: string) {
  return ctx.db
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.processId, processId),
        eq(conversationMessages.channel, 'portal'),
      ),
    );
}

async function staffConversation(processId: string, cookie = adminCookie) {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/staff/processes/${processId}/conversation`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe('M1.–M2. Nur mit bestätigter Buchung; Kundentext', () => {
  it('M1. Erst nach Booking: Anfrage ohne Buchung, unbekannte und fremde Buchung ⇒ neutrales 404; ohne Session 401; Staff-Cookie ist keine Portal-Session', async () => {
    const { customer, process } = await createCustomerWithProcess(ctx, adminId, {
      email: 'ohne.buchung@example.com',
    });
    const cookie = await loginPortalCustomer(ctx, customer.id);
    // Vorgang ohne Buchung – weder über Prozess-ID noch über eine zufällige ID erreichbar.
    for (const id of [process.id, randomUUID()]) {
      const list = await listMessages(cookie, id);
      expect(list.statusCode).toBe(404);
      expect(list.json().error).toMatchObject({ code: 'NOT_FOUND', message: 'Nicht gefunden.' });
      const post = await postMessage(cookie, id, { body: 'Hallo' });
      expect(post.statusCode).toBe(404);
    }
    // Fremde Buchung (anderer Kunde) ⇒ 404, nicht 403.
    const other = await portalBooking();
    expect((await listMessages(cookie, other.bookingId)).statusCode).toBe(404);
    expect((await postMessage(cookie, other.bookingId, { body: 'Hallo' })).statusCode).toBe(404);
    expect(await messageRows(other.processId)).toHaveLength(0);
    // Ohne Session / mit Staff-Session ⇒ 401 PORTAL_UNAUTHENTICATED.
    const anonymous = await listMessages('', other.bookingId);
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe('PORTAL_UNAUTHENTICATED');
    const staffCookie = await listMessages(adminCookie, other.bookingId);
    expect(staffCookie.statusCode).toBe(401);
  });

  it('M2. Customer Text: 201 PortalMessageView (from customer), Zeile channel portal/inbound mit Kunden-Snapshot; GET listet chronologisch mit canSend', async () => {
    const world = await portalBooking();
    const response = await postMessage(world.cookie, world.bookingId, {
      body: '  Hallo, passt die Lieferung um 10 Uhr?  ',
    });
    expect(response.statusCode).toBe(201);
    const view = response.json();
    expect(view).toMatchObject({
      from: 'customer',
      body: 'Hallo, passt die Lieferung um 10 Uhr?',
      bodyDeleted: false,
      photos: [],
    });
    expect(Object.keys(view).sort()).toEqual(
      ['body', 'bodyDeleted', 'createdAt', 'from', 'id', 'photos'].sort(),
    );
    const rows = await messageRows(world.processId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: view.id,
      channel: 'portal',
      direction: 'inbound',
      customerId: world.customerId,
      isSystemEvent: false,
      deliveryState: 'received',
      senderSnapshot: {
        name: 'Klara Kommerz',
        email: 'klara.kommerz@test.example',
        role: 'customer',
      },
    });
    expect(rows[0]!.receivedAt).not.toBeNull();

    const second = await postMessage(world.cookie, world.bookingId, { body: 'Zweite Nachricht' });
    expect(second.statusCode).toBe(201);
    const list = await listMessages(world.cookie, world.bookingId);
    expect(list.statusCode).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    expect(list.json().canSend).toBe(true);
    expect(list.json().messages.map((m: { body: string }) => m.body)).toEqual([
      'Hallo, passt die Lieferung um 10 Uhr?',
      'Zweite Nachricht',
    ]);
    // Leere/überlange Nachricht ⇒ 400.
    expect((await postMessage(world.cookie, world.bookingId, { body: '   ' })).statusCode).toBe(
      400,
    );
    expect(
      (await postMessage(world.cookie, world.bookingId, { body: 'x'.repeat(5001) })).statusCode,
    ).toBe(400);
  });
});

describe('M3.–M6. Fotos', () => {
  it('M3. Erlaubtes Foto (PNG + JPEG): privat gespeichert, Metadaten im DTO ohne Storage-Key, Bytes nur über die Portal-Route mit no-store/nosniff; fremde Session 404', async () => {
    const world = await portalBooking();
    const response = await postMessage(world.cookie, world.bookingId, {
      body: 'Hier zwei Fotos',
      photos: [photo(PNG_1X1, 'image/png'), photo(JPEG_1X1, 'image/jpeg')],
    });
    expect(response.statusCode).toBe(201);
    const view = response.json();
    expect(view.photos).toHaveLength(2);
    expect(view.photos[0]).toMatchObject({
      mimeType: 'image/png',
      byteSize: PNG_1X1.length,
      deleted: false,
    });
    expect(view.photos[1]).toMatchObject({ mimeType: 'image/jpeg', byteSize: JPEG_1X1.length });
    const raw = JSON.stringify(view);
    expect(raw).not.toContain('storageKey');
    expect(raw).not.toContain('communication/messages/');

    const photoRows = await ctx.db
      .select()
      .from(messagePhotos)
      .where(eq(messagePhotos.messageId, view.id));
    expect(photoRows).toHaveLength(2);
    for (const row of photoRows) {
      expect(row.storageKey.startsWith(`communication/messages/${view.id}/`)).toBe(true);
      expect(await ctx.storage.exists(row.storageKey)).toBe(true);
    }

    const bytes = await photoRoute(world.cookie, world.bookingId, view.id, view.photos[0].id);
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/png');
    expect(bytes.headers['content-disposition']).toBe('inline');
    expect(bytes.headers['cache-control']).toBe('private, no-store');
    expect(bytes.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(bytes.rawPayload).equals(PNG_1X1)).toBe(true);

    // IDOR: fremder Kunde (eigene Buchung) ⇒ 404; falsche Nachricht/Buchung ⇒ 404; ohne Session 401.
    const stranger = await portalBooking();
    expect(
      (await photoRoute(stranger.cookie, world.bookingId, view.id, view.photos[0].id)).statusCode,
    ).toBe(404);
    expect(
      (await photoRoute(stranger.cookie, stranger.bookingId, view.id, view.photos[0].id))
        .statusCode,
    ).toBe(404);
    expect(
      (await photoRoute(world.cookie, world.bookingId, randomUUID(), view.photos[0].id)).statusCode,
    ).toBe(404);
    expect((await photoRoute('', world.bookingId, view.id, view.photos[0].id)).statusCode).toBe(
      401,
    );
    // Staff-Fotoroute liefert dasselbe Foto (Vorgangssichtbarkeit) – Kanal portal.
    const staff = await ctx.app.inject({
      method: 'GET',
      url: `/staff/messages/${view.id}/photos/${view.photos[1].id}`,
      headers: { cookie: adminCookie },
    });
    expect(staff.statusCode).toBe(200);
    expect(staff.headers['content-type']).toBe('image/jpeg');
  });

  it('M4. PDF blockiert: PDF-Bytes mit Bildtyp ⇒ 400 PORTAL_PHOTO_REJECTED, nichts gespeichert; application/pdf scheitert am Schema', async () => {
    const world = await portalBooking();
    const disguised = await postMessage(world.cookie, world.bookingId, {
      body: 'Anbei die Rechnung',
      photos: [photo(PNG_1X1, 'image/png'), photo(PDF_BYTES, 'image/png')],
    });
    expect(disguised.statusCode).toBe(400);
    expect(disguised.json().error).toMatchObject({
      code: 'PORTAL_PHOTO_REJECTED',
      message: PORTAL_PHOTO_REJECTED_MESSAGE,
    });
    const declared = await postMessage(world.cookie, world.bookingId, {
      body: 'Anbei die Rechnung',
      photos: [{ mimeType: 'application/pdf', dataBase64: PDF_BYTES.toString('base64') }],
    });
    expect(declared.statusCode).toBe(400);
    expect(await messageRows(world.processId)).toHaveLength(0);
    expect(await ctx.db.select().from(messagePhotos)).toHaveLength(0);
  });

  it('M5. SVG blockiert (kein Bild im Sinne der Allowlist), ebenso MIME-/Magic-Byte-Widerspruch und leere Daten', async () => {
    const world = await portalBooking();
    for (const bad of [
      photo(SVG_BYTES, 'image/png'),
      { mimeType: 'image/svg+xml', dataBase64: SVG_BYTES.toString('base64') },
      photo(JPEG_1X1, 'image/png'), // deklariert PNG, Bytes JPEG
      photo(Buffer.alloc(0), 'image/png'),
    ]) {
      const response = await postMessage(world.cookie, world.bookingId, {
        body: 'Bild',
        photos: [bad],
      });
      expect(response.statusCode).toBe(400);
    }
    expect(await messageRows(world.processId)).toHaveLength(0);
    expect(await ctx.db.select().from(messagePhotos)).toHaveLength(0);
  });

  it('M6. Größenlimit: Bild > 8 MiB ⇒ 400 PORTAL_PHOTO_REJECTED; mehr als 5 Fotos ⇒ 400; genau 8 MiB mit gültigem Header wird angenommen', async () => {
    const world = await portalBooking();
    const tooLarge = Buffer.alloc(8 * 1024 * 1024 + 1);
    PNG_1X1.copy(tooLarge, 0);
    const rejected = await postMessage(world.cookie, world.bookingId, {
      body: 'großes Bild',
      photos: [photo(tooLarge, 'image/png')],
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe('PORTAL_PHOTO_REJECTED');
    const tooMany = await postMessage(world.cookie, world.bookingId, {
      body: 'sechs Bilder',
      photos: Array.from({ length: 6 }, () => photo(PNG_1X1, 'image/png')),
    });
    expect(tooMany.statusCode).toBe(400);
    expect(await messageRows(world.processId)).toHaveLength(0);

    const exact = Buffer.alloc(8 * 1024 * 1024);
    PNG_1X1.copy(exact, 0);
    const accepted = await postMessage(world.cookie, world.bookingId, {
      body: 'passendes Bild',
      photos: [photo(exact, 'image/png')],
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().photos[0].byteSize).toBe(exact.length);
  });
});

describe('M7.–M8. Sender aus Session', () => {
  it('M7. Sender ist IMMER der Kunde der Session (Zeile, Snapshot, Staff-Ansicht)', async () => {
    const world = await portalBooking();
    const response = await postMessage(world.cookie, world.bookingId, { body: 'Von mir' });
    expect(response.statusCode).toBe(201);
    const rows = await messageRows(world.processId);
    expect(rows[0]!.customerId).toBe(world.customerId);
    expect(rows[0]!.createdByStaffId).toBeNull();
    const staffView = await staffConversation(world.processId);
    const portalRow = staffView.messages.find((m: { channel: string }) => m.channel === 'portal');
    expect(portalRow).toMatchObject({
      channel: 'portal',
      direction: 'inbound',
      customerId: world.customerId,
      sender: { name: 'Klara Kommerz', email: 'klara.kommerz@test.example' },
    });
  });

  it('M8. Client-Felder customerId/senderCustomerId/ownerId im Body ⇒ 400 (strictObject), nichts gespeichert', async () => {
    const world = await portalBooking();
    const stranger = await portalBooking();
    for (const extra of [
      { customerId: stranger.customerId },
      { senderCustomerId: stranger.customerId },
      { ownerId: stranger.customerId },
      { processId: stranger.processId },
    ]) {
      const response = await postMessage(world.cookie, world.bookingId, {
        body: 'Hallo',
        ...extra,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
    expect(await messageRows(world.processId)).toHaveLength(0);
    expect(await messageRows(stranger.processId)).toHaveLength(0);
  });
});

describe('M9.–M11. Staff-Sicht und Benachrichtigung', () => {
  it('M9. Staff sieht die Portalnachricht in der Vorgangskommunikation (Kanal portal, Fotos) samt canReplyPortal/portalActive', async () => {
    const world = await portalBooking();
    const created = await postMessage(world.cookie, world.bookingId, {
      body: 'Frage zur Abholung',
      photos: [photo(PNG_1X1)],
    });
    expect(created.statusCode).toBe(201);
    const view = await staffConversation(world.processId);
    const portalRows = view.messages.filter((m: { channel: string }) => m.channel === 'portal');
    expect(portalRows).toHaveLength(1);
    expect(portalRows[0]).toMatchObject({
      channel: 'portal',
      direction: 'inbound',
      body: 'Frage zur Abholung',
      isSystemEvent: false,
    });
    expect(portalRows[0].photos).toHaveLength(1);
    // Das E-Mail-Systemereignis der Angebotsmail bleibt für Staff sichtbar (nicht im Portal).
    expect(view.messages.some((m: { isSystemEvent: boolean }) => m.isSystemEvent)).toBe(true);
    expect(view.canReplyPortal).toBe(true);
    expect(view.portalActive).toBe(true);
  });

  it('M10. Benachrichtigung an Admin + effektiv zuständige Person (inkl. Vertretung), dedupliziert, nur aktive Nutzer; Schlüssel portal_message:<messageId>:<userId>', async () => {
    const anna = await createEmployeeWithPassword(ctx, adminId, {
      firstName: 'Anna',
      lastName: 'Zuständig',
      email: 'anna@test.example',
      password: 'anna-passwort-123456',
    });
    const bernd = await createEmployeeWithPassword(ctx, adminId, {
      firstName: 'Bernd',
      lastName: 'Vertreter',
      email: 'bernd@test.example',
      password: 'bernd-passwort-123456',
    });
    await createEmployeeWithPassword(ctx, adminId, {
      firstName: 'Carla',
      lastName: 'Unbeteiligt',
      email: 'carla@test.example',
      password: 'carla-passwort-123456',
    });
    const world = await portalBooking({ assignProcessTo: anna.id });
    const first = await postMessage(world.cookie, world.bookingId, { body: 'Erste Frage' });
    expect(first.statusCode).toBe(201);
    let rows = await ctx.db.select().from(pushDeliveries);
    expect(rows.map((row) => row.userId).sort()).toEqual([adminId, anna.id].sort());
    for (const row of rows) {
      expect(row.kind).toBe('portal_message');
      expect(row.idempotencyKey).toBe(portalMessagePushKey(first.json().id, row.userId));
    }
    // Wiederholung (Job-Retry-Semantik) erzeugt keine zweite Zeile.
    await notifyStaffOfPortalMessage(
      { db: ctx.db, push: new PushService(ctx.db, ctx.queue) },
      {
        messageId: first.json().id,
        processId: world.processId,
        processNumber: 'MR-2026-0001',
        now: new Date(),
      },
    ).catch(() => undefined);
    expect(await ctx.db.select().from(pushDeliveries)).toHaveLength(rows.length);

    // Vertretung aktiv ⇒ Bernd statt Anna.
    const now = new Date();
    await substitutionServiceFor(ctx).create(adminId, {
      originalUserId: anna.id,
      substituteUserId: bernd.id,
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 3_600_000),
    });
    expect((await portalMessageRecipients(ctx.db, world.processId, now)).sort()).toEqual(
      [adminId, bernd.id].sort(),
    );
    const second = await postMessage(world.cookie, world.bookingId, { body: 'Zweite Frage' });
    expect(second.statusCode).toBe(201);
    rows = await ctx.db.select().from(pushDeliveries);
    const secondRecipients = rows
      .filter((row) => row.idempotencyKey.startsWith(`portal_message:${second.json().id}:`))
      .map((row) => row.userId);
    expect(secondRecipients.sort()).toEqual([adminId, bernd.id].sort());

    // Ohne Zuständigkeit nur Admins; gesperrte Zuständige fallen weg.
    const unassigned = await portalBooking();
    expect(await portalMessageRecipients(ctx.db, unassigned.processId, now)).toEqual([adminId]);
  });

  it('M11. Push ohne Nachrichtentext: Titel „Neue Kundennachricht – MR-…“, fester Text, URL Vorgang/kommunikation – weder Payload noch Versand enthalten den Text', async () => {
    const secret = 'GEHEIMER-TEXT-DER-NIE-IM-PUSH-STEHT';
    const subscribe = await ctx.app.inject({
      method: 'POST',
      url: '/staff/push/subscriptions',
      headers: { cookie: adminCookie },
      payload: {
        endpoint: `https://push.example.test/send/admin-${'e'.repeat(40)}`,
        keys: PUSH_KEYS,
        userAgentLabel: 'Testgerät',
      },
    });
    expect([200, 201]).toContain(subscribe.statusCode);
    const world = await portalBooking();
    const created = await postMessage(world.cookie, world.bookingId, {
      body: secret,
      photos: [photo(PNG_1X1)],
    });
    expect(created.statusCode).toBe(201);
    const processRow = (
      await ctx.db.select().from(processes).where(eq(processes.id, world.processId))
    )[0]!;
    const rows = await ctx.db.select().from(pushDeliveries);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload).toEqual({
      kind: 'portal_message',
      title: `Neue Kundennachricht – ${processRow.processNumber}`,
      body: PORTAL_MESSAGE_PUSH_BODY,
      url: `/vorgaenge/${world.processId}/kommunikation`,
      tag: `portal-message:${world.processId}`,
    });
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(JSON.stringify(payload)).not.toContain('Klara');
    expect(JSON.stringify(payload)).not.toContain('image/');
    await drainJobs(ctx);
    const sent = ctx.push.sent.filter((record) => record.payload.kind === 'portal_message');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0]!.payload)).not.toContain(secret);
    expect(sent[0]!.payload.title).toBe(`Neue Kundennachricht – ${processRow.processNumber}`);
  });
});

describe('M12.–M15. Terminal, Retention, keine fremde Historie', () => {
  it('M12. Terminal: abgeschlossener Vorgang ⇒ Lesen erlaubt (canSend false), neue Nachricht 409 PORTAL_BOOKING_CLOSED; Staff-Portalantwort ebenfalls 409', async () => {
    const world = await portalBooking();
    expect((await postMessage(world.cookie, world.bookingId, { body: 'vorher' })).statusCode).toBe(
      201,
    );
    await completeProcess(ctx, world.processId);
    const list = await listMessages(world.cookie, world.bookingId);
    expect(list.statusCode).toBe(200);
    expect(list.json().canSend).toBe(false);
    expect(list.json().messages).toHaveLength(1);
    const blocked = await postMessage(world.cookie, world.bookingId, { body: 'nachher' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toMatchObject({
      code: 'PORTAL_BOOKING_CLOSED',
      message: PORTAL_MESSAGES.BOOKING_CLOSED,
    });
    expect(await messageRows(world.processId)).toHaveLength(1);
    const staffReply = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/conversation/reply`,
      headers: { cookie: adminCookie },
      payload: { channel: 'portal', body: 'Antwort' },
    });
    expect(staffReply.statusCode).toBe(409);
    // Wieder geöffnet ⇒ erneut möglich.
    await processServiceFor(ctx).reopen(world.processId, adminId);
    expect((await postMessage(world.cookie, world.bookingId, { body: 'wieder' })).statusCode).toBe(
      201,
    );
  });

  it('M13. Foto-Retention wie Phase 12: Abschluss ⇒ Portal-Fotos gelöscht (Storage + deletedAt), DTO deleted:true, Fotoroute 404; Text bleibt', async () => {
    const world = await portalBooking();
    const created = await postMessage(world.cookie, world.bookingId, {
      body: 'Foto zur Rückgabe',
      photos: [photo(PNG_1X1)],
    });
    expect(created.statusCode).toBe(201);
    const view = created.json();
    const photoRow = (
      await ctx.db.select().from(messagePhotos).where(eq(messagePhotos.id, view.photos[0].id))
    )[0]!;
    expect(await ctx.storage.exists(photoRow.storageKey)).toBe(true);
    await completeProcess(ctx, world.processId);
    const result = await ctx.scan.retention.runTerminalCleanup(world.processId, null);
    expect(result.deleted).toBe(1);
    const after = (
      await ctx.db.select().from(messagePhotos).where(eq(messagePhotos.id, view.photos[0].id))
    )[0]!;
    expect(after.deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(photoRow.storageKey)).toBe(false);
    const list = await listMessages(world.cookie, world.bookingId);
    expect(list.json().messages[0]).toMatchObject({
      body: 'Foto zur Rückgabe',
      bodyDeleted: false,
      photos: [{ id: view.photos[0].id, deleted: true }],
    });
    expect(
      (await photoRoute(world.cookie, world.bookingId, view.id, view.photos[0].id)).statusCode,
    ).toBe(404);
  });

  it('M14. Text-Retention: 12 Berliner Kalendermonate nach dem Retention-Anker wird der Portal-Text minimiert (bodyDeleted, kein Name/E-Mail im Snapshot)', async () => {
    const world = await portalBooking();
    expect(
      (await postMessage(world.cookie, world.bookingId, { body: 'Alter Portal-Text' })).statusCode,
    ).toBe(201);
    await completeProcess(ctx, world.processId);
    await ctx.scan.retention.runTerminalCleanup(world.processId, null);
    const now = new Date('2027-06-15T10:00:00.000Z');
    const anchor = addBerlinCalendarMonths(now, -12);
    await ctx.db
      .update(processes)
      .set({ completedAt: anchor })
      .where(eq(processes.id, world.processId));
    await ctx.db
      .update(conversationMessages)
      .set({ retentionAnchorAt: anchor })
      .where(eq(conversationMessages.processId, world.processId));
    const purged = await ctx.scan.retention.purgeExpiredChatText(now);
    expect(purged.purged).toBeGreaterThanOrEqual(1);
    const row = (await messageRows(world.processId))[0]!;
    expect(row.body).toBe('');
    expect(row.bodyDeletedAt).not.toBeNull();
    expect(row.senderSnapshot).toEqual({ role: 'customer' });
    const list = await listMessages(world.cookie, world.bookingId);
    expect(list.statusCode).toBe(200);
    expect(list.json().messages[0]).toMatchObject({
      from: 'customer',
      body: '',
      bodyDeleted: true,
    });
  });

  it('M15. Keine WhatsApp-/E-Mail-Historie im Portal: nur Kanal portal, keine Systemereignisse – Staff sieht weiterhin alles', async () => {
    const world = await portalBooking();
    const conversations = new ConversationService(ctx.db, ctx.storage);
    for (const channel of ['email', 'whatsapp'] as const) {
      await conversations.createInbound({
        processId: world.processId,
        customerId: world.customerId,
        channel,
        sender: { name: 'Klara', email: 'klara.kommerz@test.example' },
        subject: `${channel}-Betreff`,
        body: `Vertraulich per ${channel}`,
        providerMessageId: `<${channel}-1@example.com>`,
        replyToProviderMessageId: null,
        receivedAt: new Date(),
      });
    }
    expect(
      (await postMessage(world.cookie, world.bookingId, { body: 'Portal-Frage' })).statusCode,
    ).toBe(201);
    // Staff-Antwort per E-Mail (Outbox) erzeugt zusätzlich eine E-Mail-Zeile.
    const emailReply = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${world.processId}/conversation/reply`,
      headers: { cookie: adminCookie },
      payload: { channel: 'email', body: 'Antwort per Mail' },
    });
    expect(emailReply.statusCode).toBe(201);
    const list = await listMessages(world.cookie, world.bookingId);
    expect(list.statusCode).toBe(200);
    expect(list.json().messages).toHaveLength(1);
    expect(list.json().messages[0]).toMatchObject({ from: 'customer', body: 'Portal-Frage' });
    const raw = JSON.stringify(list.json());
    expect(raw).not.toContain('Vertraulich');
    expect(raw).not.toContain('Antwort per Mail');
    expect(raw).not.toContain('providerMessageId');
    const staff = await staffConversation(world.processId);
    expect(staff.messages.length).toBeGreaterThanOrEqual(4);
  });
});

describe('M16. Rate-Limit und Session-Hinweis', () => {
  it('M16. 20 Nachrichten pro Minute je Session, die 21. ⇒ 429; eine andere Session ist nicht betroffen', async () => {
    const limited = await createTestContext({ rateLimitEnabled: true });
    try {
      // Dieselbe Datenbank – Buchung und Sessions des Hauptkontexts sind sichtbar.
      const world = await portalBooking();
      const other = await loginPortalCustomer(ctx, world.customerId);
      for (let i = 0; i < 20; i += 1) {
        const response = await limited.app.inject({
          method: 'POST',
          url: `/portal/bookings/${world.bookingId}/messages`,
          headers: { cookie: world.cookie },
          payload: { body: `Nachricht ${i + 1}` },
        });
        expect(response.statusCode).toBe(201);
      }
      const blocked = await limited.app.inject({
        method: 'POST',
        url: `/portal/bookings/${world.bookingId}/messages`,
        headers: { cookie: world.cookie },
        payload: { body: 'Nachricht 21' },
      });
      expect(blocked.statusCode).toBe(429);
      const otherSession = await limited.app.inject({
        method: 'POST',
        url: `/portal/bookings/${world.bookingId}/messages`,
        headers: { cookie: other },
        payload: { body: 'Andere Session' },
      });
      expect(otherSession.statusCode).toBe(201);
      expect(await messageRows(world.processId)).toHaveLength(21);
    } finally {
      await destroyTestContext(limited);
    }
  });

  it('M16b. portalActive folgt der Session: widerrufene Session ⇒ false; ohne Session false', async () => {
    const world = await createAcceptedBooking(ctx, adminId);
    expect((await staffConversation(world.processId)).portalActive).toBe(false);
    await loginPortalCustomer(ctx, world.customerId);
    expect((await staffConversation(world.processId)).portalActive).toBe(true);
    await ctx.db
      .update(customerPortalSessions)
      .set({ revokedAt: new Date() })
      .where(eq(customerPortalSessions.customerId, world.customerId));
    expect((await staffConversation(world.processId)).portalActive).toBe(false);
  });
});

// Phase 15 (Review-Hinweis Polyglot, Defense in Depth): Ein Bild mit gültigen PNG-Magic-Bytes und
// angehängtem HTML/Script wird (wie jedes erlaubte Bild) angenommen. Die Portal-Fotoroute liefert es
// zusätzlich mit `content-security-policy: default-src 'none'; sandbox` aus – selbst bei falschem
// Sniffing/direktem Öffnen kann nichts ausgeführt oder nachgeladen werden.
describe('Polyglot-CSP. Portal-Fotoroute mit Content-Security-Policy', () => {
  it("Polyglot-CSP. PNG mit angehängtem <script> ⇒ Auslieferung als image/png mit nosniff, no-store UND content-security-policy „default-src 'none'; sandbox“", async () => {
    const world = await portalBooking();
    const polyglot = Buffer.concat([
      PNG_1X1,
      Buffer.from('<html><body><script>alert(document.cookie)</script></body></html>'),
    ]);
    const response = await postMessage(world.cookie, world.bookingId, {
      body: 'Polyglot',
      photos: [photo(polyglot, 'image/png')],
    });
    expect(response.statusCode).toBe(201);
    const view = response.json();
    const bytes = await photoRoute(world.cookie, world.bookingId, view.id, view.photos[0].id);
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/png');
    expect(bytes.headers['x-content-type-options']).toBe('nosniff');
    expect(bytes.headers['cache-control']).toBe('private, no-store');
    expect(bytes.headers['content-disposition']).toBe('inline');
    expect(bytes.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(bytes.rawPayload).equals(polyglot)).toBe(true);
  });
});
