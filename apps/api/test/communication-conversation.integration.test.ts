/**
 * Phase 12 – Konversation je Vorgang (Order §24/§25; Pflichttests
 * CONVERSATION 86–92 inkl. SECURITY Mail/Conversation/Photo-IDOR):
 * inbound/outbound chronologisch, Vorgangssichtbarkeit, Foto-Sichtbarkeit,
 * Staff-Antwort per E-Mail (Recht, Outbox, kein freies Empfängerfeld,
 * In-Reply-To), Systemereignisse, Zustellstatus-Spiegelung, Retention-Hilfen.
 */
import {
  conversationMessages,
  mailDeliveries,
  messagePhotos,
  processes,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConversationService,
  photoStorageKey,
} from '../src/communication/conversation/conversation-service.ts';
import { InboundMailProcessor } from '../src/communication/inbound/processor.ts';
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
import {
  completeProcess,
  createCustomerWithProcess,
  drainJobs,
  insertOwnDelivery,
  loadMailFixture,
  truncateCommunicationTables,
} from './communication-helpers.ts';
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';

let ctx: TestContext;
let adminId: string;
let adminCookie: string;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  // Nichts in der geteilten Test-DB zurücklassen (Statusroute anderer Tests erwartet leeren Poller-Zustand).
  await truncateCommunicationTables(ctx.pool);
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateCommunicationTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  ctx.inboundMail.clear();
  ctx.mailGateway.reset();
  const admin = await bootstrapAdmin(ctx);
  adminId = admin.id;
  adminCookie = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
});

const service = () => new ConversationService(ctx.db, ctx.storage);
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 0xff, 0xd9,
]);

/** Eingehende Mail (Fixture) dem Vorgang zuordnen – über In-Reply-To auf eine eigene Zustellung. */
async function inboundFor(
  process: { id: string; customerId: string },
  fixture = 'reply-in-reply-to.eml',
) {
  await insertOwnDelivery(ctx, {
    processId: process.id,
    customerId: process.customerId,
    messageId: `<offer-1@miet-royal.test>`,
    recipientEmail: 'max.mustermann@example.com',
  }).catch(() => undefined);
  ctx.inboundMail.add(loadMailFixture(fixture));
  await new InboundMailProcessor({
    db: ctx.db,
    storage: ctx.storage,
    source: ctx.inboundMail,
  }).pollOnce();
  const rows = await ctx.db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.direction, 'inbound'));
  return rows[rows.length - 1]!;
}

async function photoFor(messageId: string) {
  const key = photoStorageKey(messageId, 'jpg');
  await ctx.storage.put(key, new Uint8Array(JPEG), { contentType: 'image/jpeg' });
  return service().registerPhoto({
    messageId,
    storageKey: key,
    mimeType: 'image/jpeg',
    byteSize: JPEG.length,
    sha256: 'x'.repeat(64),
  });
}

const conversation = (processId: string, cookie = adminCookie) =>
  ctx.app.inject({
    method: 'GET',
    url: `/staff/processes/${processId}/conversation`,
    headers: { cookie },
  });

describe('Liste und Sichtbarkeit (86–88)', () => {
  it('86. Eingehende und ausgehende Nachrichten erscheinen chronologisch mit Absender, Zustellstatus und Fotos', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, {
      email: 'max.mustermann@example.com',
    });
    const inbound = await inboundFor(process);
    await photoFor(inbound.id);
    await service().recordOutboundSystemEvent({
      processId: process.id,
      customerId: process.customerId,
      channel: 'email',
      kind: 'offer',
      subject: 'Ihr Angebot von Miet-Royal',
      mailDeliveryId: (await ctx.db.select().from(mailDeliveries))[0]!.id,
    });
    const response = await conversation(process.id);
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({
      direction: 'inbound',
      channel: 'email',
      sender: { name: 'Max Mustermann', email: 'max.mustermann@example.com' },
      deliveryState: 'received',
      isSystemEvent: false,
    });
    expect(body.messages[0].photos).toHaveLength(1);
    expect(body.messages[0].photos[0]).toMatchObject({ mimeType: 'image/jpeg', deleted: false });
    expect(body.messages[1]).toMatchObject({
      direction: 'outbound',
      isSystemEvent: true,
      subject: 'Ihr Angebot von Miet-Royal',
      deliveryState: 'queued',
    });
    expect(body.canReplyEmail).toBe(true);
    expect(body.whatsapp).toMatchObject({ available: false, windowOpen: false });
    // Keine Storage-Keys/Secrets in der Antwort.
    expect(JSON.stringify(body)).not.toContain('communication/messages/');
  });

  it('87. IDOR: ohne process.view_all 403; unsichtbarer (alt abgeschlossener) Vorgang ⇒ neutrales 404 für Liste, Antwort und Foto', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, {
      email: 'max.mustermann@example.com',
    });
    const inbound = await inboundFor(process);
    const photo = await photoFor(inbound.id);
    const noView = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Nina',
      lastName: 'NoView',
      email: 'nina@test.example',
      password: 'nina-passwort-123456',
      permissionKeys: ['message.reply_customer', 'whatsapp.reply'],
    });
    expect((await conversation(process.id, noView.cookie)).statusCode).toBe(403);
    const photoDenied = await ctx.app.inject({
      method: 'GET',
      url: `/staff/messages/${inbound.id}/photos/${photo.id}`,
      headers: { cookie: noView.cookie },
    });
    expect(photoDenied.statusCode).toBe(403);

    // Abgeschlossen vor 30 Tagen, Sichtbarkeitsfenster 7 Tage: normale Mitarbeitende sehen nichts.
    await completeProcess(ctx, process.id);
    await ctx.db
      .update(processes)
      .set({ completedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) })
      .where(eq(processes.id, process.id));
    const staff = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Sven',
      lastName: 'Staff',
      email: 'sven@test.example',
      password: 'sven-passwort-123456',
      permissionKeys: ['process.view_all', 'message.reply_customer'],
    });
    expect((await conversation(process.id, staff.cookie)).statusCode).toBe(404);
    const reply = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/conversation/reply`,
      headers: { cookie: staff.cookie },
      payload: { channel: 'email', body: 'Hallo' },
    });
    expect(reply.statusCode).toBe(404);
    const photoHidden = await ctx.app.inject({
      method: 'GET',
      url: `/staff/messages/${inbound.id}/photos/${photo.id}`,
      headers: { cookie: staff.cookie },
    });
    expect(photoHidden.statusCode).toBe(404);
    expect(photoHidden.json().error.code).toBe('NOT_FOUND');
    // Admin (process.view_completed) sieht weiterhin alles.
    expect((await conversation(process.id)).statusCode).toBe(200);
  });

  it('88. Foto-Sichtbarkeit: Foto nur über seine eigene Nachricht; fremde Nachrichten-ID ⇒ 404; unzugeordnet nur mit message.reply_customer; gelöschte Fotos 404', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, {
      email: 'max.mustermann@example.com',
    });
    const matched = await inboundFor(process);
    const matchedPhoto = await photoFor(matched.id);
    ctx.inboundMail.add(loadMailFixture('unmatched.eml'));
    await new InboundMailProcessor({
      db: ctx.db,
      storage: ctx.storage,
      source: ctx.inboundMail,
    }).pollOnce();
    const unmatched = (
      await ctx.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.channel, 'email'))
    ).find((row) => row.processId === null)!;
    const unmatchedPhoto = await photoFor(unmatched.id);

    const viewer = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Vera',
      lastName: 'View',
      email: 'vera@test.example',
      password: 'vera-passwort-123456',
      permissionKeys: ['process.view_all'],
    });
    const get = (messageId: string, photoId: string, cookie = viewer.cookie) =>
      ctx.app.inject({
        method: 'GET',
        url: `/staff/messages/${messageId}/photos/${photoId}`,
        headers: { cookie },
      });
    expect((await get(matched.id, matchedPhoto.id)).statusCode).toBe(200);
    // Foto einer anderen Nachricht über eine sichtbare Nachrichten-ID ⇒ 404 (keine Querverbindung).
    expect((await get(matched.id, unmatchedPhoto.id)).statusCode).toBe(404);
    // Unzugeordnete Nachricht: nur mit administrativem Kommunikationsrecht.
    expect((await get(unmatched.id, unmatchedPhoto.id)).statusCode).toBe(403);
    expect((await get(unmatched.id, unmatchedPhoto.id, adminCookie)).statusCode).toBe(200);
    // Unbekannte IDs ⇒ 404.
    expect((await get('11111111-2222-4333-8444-555555555555', matchedPhoto.id)).statusCode).toBe(
      404,
    );
    // Gelöschtes Foto (Retention) ⇒ 404.
    await service().deleteChatPhotosForProcess(process.id);
    expect((await get(matched.id, matchedPhoto.id)).statusCode).toBe(404);
  });
});

describe('Staff-Antwort per E-Mail (89–91)', () => {
  it('89. Antwort braucht message.reply_customer; Empfänger ist IMMER die Kunden-E-Mail (kein freies Feld); In-Reply-To = letzte Kundenmail; Versand über Outbox + Job; Status wird gespiegelt', async () => {
    const { customer, process } = await createCustomerWithProcess(ctx, adminId, {
      email: 'max.mustermann@example.com',
    });
    const inbound = await inboundFor(process);
    const viewer = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Vera',
      lastName: 'View',
      email: 'vera@test.example',
      password: 'vera-passwort-123456',
      permissionKeys: ['process.view_all'],
    });
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/conversation/reply`,
      headers: { cookie: viewer.cookie },
      payload: { channel: 'email', body: 'Hallo' },
    });
    expect(denied.statusCode).toBe(403);

    const replier = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Rita',
      lastName: 'Reply',
      email: 'rita@test.example',
      password: 'rita-passwort-123456',
      permissionKeys: ['process.view_all', 'message.reply_customer'],
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/conversation/reply`,
      headers: { cookie: replier.cookie },
      payload: {
        channel: 'email',
        body: 'Hallo Max,\n\nLieferung am Freitag ist möglich.',
        // Angriff: freie Empfänger werden ignoriert (kein Feld im Vertrag).
        to: 'angreifer@evil.example',
        recipient: { email: 'angreifer@evil.example' },
      },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json();
    expect(created).toMatchObject({ channel: 'email', deliveryState: 'queued' });
    const [delivery] = await ctx.db
      .select()
      .from(mailDeliveries)
      .where(eq(mailDeliveries.id, created.mailDeliveryId));
    expect(delivery).toMatchObject({
      kind: 'manual_customer_reply',
      processId: process.id,
      customerId: customer.id,
      recipientEmail: 'max.mustermann@example.com',
      status: 'pending',
      inReplyToMessageId: inbound.providerMessageId,
      conversationMessageId: created.messageId,
      createdBy: replier.user.id,
    });
    expect(JSON.stringify(delivery)).not.toContain('evil.example');
    const [outbound] = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, created.messageId));
    expect(outbound).toMatchObject({
      direction: 'outbound',
      channel: 'email',
      processId: process.id,
      mailDeliveryId: delivery!.id,
      replyToProviderMessageId: inbound.providerMessageId,
      createdByStaffId: replier.user.id,
      isSystemEvent: false,
      senderSnapshot: { name: 'Rita Reply' },
    });
    expect(outbound!.body).toContain('Lieferung am Freitag');

    // Versand-Job läuft NACH Commit über den Fake-Gateway; Zustellstatus wird gespiegelt.
    await drainJobs(ctx);
    expect(ctx.mailGateway.sent).toHaveLength(1);
    const sent = ctx.mailGateway.sent[0]!;
    expect(sent.to.email).toBe('max.mustermann@example.com');
    expect(sent.inReplyTo).toContain('reply-1@example.com');
    expect(sent.text).toContain('Lieferung am Freitag ist möglich.');
    expect(sent.text).toContain('Mit freundlichen Grüßen');
    expect(sent.html).not.toContain('<script');
    const [afterSend] = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, created.messageId));
    expect(afterSend!.deliveryState).toBe('sent');
    expect(afterSend!.sentAt).not.toBeNull();
    // Liste zeigt beide in Reihenfolge.
    const list = (await conversation(process.id, replier.cookie)).json().messages;
    expect(list.map((m: { direction: string }) => m.direction)).toEqual(['inbound', 'outbound']);
  });

  it('90. Kunde ohne E-Mail ⇒ 409, nichts eingereiht; leere/überlange Nachricht ⇒ 400', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, {});
    const noMail = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/conversation/reply`,
      headers: { cookie: adminCookie },
      payload: { channel: 'email', body: 'Hallo' },
    });
    expect(noMail.statusCode).toBe(409);
    expect(await ctx.db.select().from(mailDeliveries)).toHaveLength(0);
    expect(await ctx.db.select().from(conversationMessages)).toHaveLength(0);
    const tooLong = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/conversation/reply`,
      headers: { cookie: adminCookie },
      payload: { channel: 'email', body: 'x'.repeat(5001) },
    });
    expect(tooLong.statusCode).toBe(400);
    const empty = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/conversation/reply`,
      headers: { cookie: adminCookie },
      payload: { channel: 'email', body: '' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('91. Systemereignisse sind idempotent je Zustellung; markDeliveryState spiegelt Outbox-Status', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, {
      email: 'max.mustermann@example.com',
    });
    const deliveryId = await insertOwnDelivery(ctx, {
      processId: process.id,
      customerId: process.customerId,
      messageId: '<ab-1@miet-royal.test>',
      recipientEmail: 'max.mustermann@example.com',
    });
    const first = await service().recordOutboundSystemEvent({
      processId: process.id,
      channel: 'email',
      kind: 'order_confirmation',
      subject: 'Auftragsbestätigung',
      mailDeliveryId: deliveryId,
    });
    const second = await service().recordOutboundSystemEvent({
      processId: process.id,
      channel: 'email',
      kind: 'order_confirmation',
      subject: 'Auftragsbestätigung',
      mailDeliveryId: deliveryId,
    });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(await ctx.db.select().from(conversationMessages)).toHaveLength(1);
    await service().markDeliveryState(deliveryId, 'failed');
    const [row] = await ctx.db.select().from(conversationMessages);
    expect(row!.deliveryState).toBe('failed');
    await service().markDeliveryState(deliveryId, 'sent');
    const [again] = await ctx.db.select().from(conversationMessages);
    expect(again!.deliveryState).toBe('sent');
    expect(again!.sentAt).not.toBeNull();
  });
});

describe('Retention-Hilfen (92)', () => {
  it('92. deleteChatPhotosForProcess löscht nur Kommunikationsfotos DIESES Vorgangs (Storage + deletedAt); purgeChatTextForProcess leert nur Texte dieses Vorgangs', async () => {
    const a = await createCustomerWithProcess(ctx, adminId, {
      email: 'max.mustermann@example.com',
    });
    const b = await createCustomerWithProcess(ctx, adminId, { email: 'erika@example.net' });
    const inboundA = await inboundFor(a.process);
    const photoA = await photoFor(inboundA.id);
    const inboundB = await service().createInbound({
      processId: b.process.id,
      customerId: b.customer.id,
      channel: 'email',
      sender: { email: 'erika@example.net' },
      subject: 'B',
      body: 'Text B bleibt',
      providerMessageId: 'b-1@example.net',
      replyToProviderMessageId: null,
      receivedAt: new Date(),
    });
    const photoB = await photoFor(inboundB.id);
    const keyA = (
      await ctx.db.select().from(messagePhotos).where(eq(messagePhotos.id, photoA.id))
    )[0]!.storageKey;
    const keyB = (
      await ctx.db.select().from(messagePhotos).where(eq(messagePhotos.id, photoB.id))
    )[0]!.storageKey;

    expect(await service().deleteChatPhotosForProcess(a.process.id)).toEqual({
      deleted: 1,
      failed: 0,
      errorCode: null,
    });
    expect(await ctx.storage.exists(keyA)).toBe(false);
    expect(await ctx.storage.exists(keyB)).toBe(true);
    const [rowA] = await ctx.db.select().from(messagePhotos).where(eq(messagePhotos.id, photoA.id));
    const [rowB] = await ctx.db.select().from(messagePhotos).where(eq(messagePhotos.id, photoB.id));
    expect(rowA!.deletedAt).not.toBeNull();
    expect(rowB!.deletedAt).toBeNull();
    // Idempotent.
    expect(await service().deleteChatPhotosForProcess(a.process.id)).toEqual({
      deleted: 0,
      failed: 0,
      errorCode: null,
    });

    const now = new Date('2027-10-18T10:00:00Z');
    expect(await service().purgeChatTextForProcess(a.process.id, now)).toEqual({ purged: 1 });
    expect(await service().purgeChatTextForProcess(a.process.id, now)).toEqual({ purged: 0 });
    const [textA] = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, inboundA.id));
    const [textB] = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, inboundB.id));
    // Phase-12-Finalisierung §4.3: zusätzlich Absender-Snapshot minimiert (nur Rolle),
    // E-Mail-Message-IDs entfernt.
    expect(textA).toMatchObject({
      body: '',
      subject: null,
      senderSnapshot: { role: 'customer' },
      providerMessageId: null,
    });
    expect(textA!.bodyDeletedAt?.toISOString()).toBe(now.toISOString());
    expect(textA!.piiScrubbedAt?.toISOString()).toBe(now.toISOString());
    expect(textB).toMatchObject({ body: 'Text B bleibt', bodyDeletedAt: null });
    // Liste zeigt gelöschte Texte als leer markiert; Zeiten bleiben, der Absender
    // nur noch als neutrale Rolle (keine Namen/E-Mail/Telefon).
    const list = (await conversation(a.process.id)).json().messages;
    expect(list[0]).toMatchObject({
      body: '',
      bodyDeleted: true,
      sender: { role: 'customer' },
    });
    expect(JSON.stringify(list[0])).not.toContain('max.mustermann@example.com');
    expect(list[0].photos[0]).toMatchObject({ deleted: true });
  });
});
