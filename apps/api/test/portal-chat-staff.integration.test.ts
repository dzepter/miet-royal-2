/**
 * Phase 15 – Kundenportal CHAT, Staff-Seite (Order §29, §55, §60; Design §3.2):
 * Staff-Antwort auf dem Kanal portal (Recht message.reply_customer), sofort im
 * Portal sichtbar, E-Mail-Hinweis `customer_portal_reply_notice` ohne Chattext,
 * Mail scheitert/blockiert ⇒ Portalnachricht bleibt, Terminal ⇒ 409,
 * GET-Hinweise canReplyPortal/portalActive.
 */
import { conversationMessages, mailDeliveries } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConversationService } from '../src/communication/conversation/conversation-service.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
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
import { createStaffWithPermissions } from './crm-helpers.ts';
import { loginPortalCustomer, truncatePortalTables } from './portal-auth-helpers.ts';
import { createAcceptedBooking } from './scheduling-helpers.ts';

let ctx: TestContext;
let adminId: string;
let adminCookie: string;

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
  ctx.mailGateway.reset();
  const admin = await bootstrapAdmin(ctx);
  adminId = admin.id;
  adminCookie = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
});

const reply = (processId: string, cookie: string, payload: Record<string, unknown>) =>
  ctx.app.inject({
    method: 'POST',
    url: `/staff/processes/${processId}/conversation/reply`,
    headers: { cookie },
    payload,
  });

const conversation = (processId: string, cookie = adminCookie) =>
  ctx.app.inject({
    method: 'GET',
    url: `/staff/processes/${processId}/conversation`,
    headers: { cookie },
  });

const portalMessages = (cookie: string, bookingId: string) =>
  ctx.app.inject({
    method: 'GET',
    url: `/portal/bookings/${bookingId}/messages`,
    headers: { cookie },
  });

async function noticeDeliveries() {
  return ctx.db
    .select()
    .from(mailDeliveries)
    .where(eq(mailDeliveries.kind, 'customer_portal_reply_notice'));
}

async function messageRows(processId: string) {
  return ctx.db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.processId, processId));
}

describe('M17.–M19. Staff reply channel portal', () => {
  it('M17. Antwort auf Kanal portal: 201 {channel portal, deliveryState sent, noticeStatus queued}; Zeile outbound/portal mit Staff-Referenz und Rollen-Snapshot', async () => {
    const world = await createAcceptedBooking(ctx, adminId);
    const response = await reply(world.processId, adminCookie, {
      channel: 'portal',
      body: '  Gern, 10 Uhr passt.  ',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      channel: 'portal',
      deliveryState: 'sent',
      noticeStatus: 'queued',
    });
    const rows = await messageRows(world.processId);
    const portal = rows.filter((row) => row.channel === 'portal');
    expect(portal).toHaveLength(1);
    expect(portal[0]).toMatchObject({
      id: response.json().messageId,
      direction: 'outbound',
      body: 'Gern, 10 Uhr passt.',
      isSystemEvent: false,
      deliveryState: 'sent',
      createdByStaffId: adminId,
      customerId: world.customerId,
      senderSnapshot: { name: 'Anna Admin', role: 'staff' },
      mailDeliveryId: null,
    });
    expect(portal[0]!.sentAt).not.toBeNull();
    // Staff-Konversation zeigt die Zeile mit Kanal portal.
    const staffView = (await conversation(world.processId)).json();
    const shown = staffView.messages.find((m: { channel: string }) => m.channel === 'portal');
    expect(shown).toMatchObject({ direction: 'outbound', body: 'Gern, 10 Uhr passt.' });
    expect(shown.createdByStaff).toMatchObject({ id: adminId });
    // Leer ⇒ 400, unbekannter Kanal ⇒ 400.
    expect(
      (await reply(world.processId, adminCookie, { channel: 'portal', body: ' ' })).statusCode,
    ).toBe(400);
    expect(
      (await reply(world.processId, adminCookie, { channel: 'sms', body: 'x' })).statusCode,
    ).toBe(400);
  });

  it('M18. Staff braucht message.reply_customer: ohne Recht 403 (auch mit whatsapp.reply), mit Recht 201; canReplyPortal spiegelt das Recht', async () => {
    const world = await createAcceptedBooking(ctx, adminId);
    const viewer = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Vera',
      lastName: 'Viewer',
      email: 'vera@test.example',
      password: 'vera-passwort-123456',
      permissionKeys: ['process.view_all', 'whatsapp.reply'],
    });
    const denied = await reply(world.processId, viewer.cookie, {
      channel: 'portal',
      body: 'Hallo',
    });
    expect(denied.statusCode).toBe(403);
    expect((await conversation(world.processId, viewer.cookie)).json().canReplyPortal).toBe(false);
    expect((await messageRows(world.processId)).filter((r) => r.channel === 'portal')).toHaveLength(
      0,
    );
    const replier = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Rolf',
      lastName: 'Replier',
      email: 'rolf@test.example',
      password: 'rolf-passwort-123456',
      permissionKeys: ['process.view_all', 'message.reply_customer'],
    });
    expect((await conversation(world.processId, replier.cookie)).json().canReplyPortal).toBe(true);
    const allowed = await reply(world.processId, replier.cookie, {
      channel: 'portal',
      body: 'Hallo',
    });
    expect(allowed.statusCode).toBe(201);
    const row = (await messageRows(world.processId)).find((r) => r.channel === 'portal')!;
    expect(row.createdByStaffId).toBe(replier.user.id);
  });

  it('M19. Customer sieht Reply: from miet_royal, sofort sichtbar – ohne Staff-Namen, Staff-IDs, E-Mail-/Outbox-Details', async () => {
    const world = await createAcceptedBooking(ctx, adminId);
    const cookie = await loginPortalCustomer(ctx, world.customerId);
    const customerMessage = await ctx.app.inject({
      method: 'POST',
      url: `/portal/bookings/${world.bookingId}/messages`,
      headers: { cookie },
      payload: { body: 'Frage vom Kunden' },
    });
    expect(customerMessage.statusCode).toBe(201);
    const response = await reply(world.processId, adminCookie, {
      channel: 'portal',
      body: 'Antwort von Miet-Royal',
    });
    expect(response.statusCode).toBe(201);
    const list = await portalMessages(cookie, world.bookingId);
    expect(list.statusCode).toBe(200);
    expect(list.json().messages).toHaveLength(2);
    expect(list.json().messages[1]).toMatchObject({
      id: response.json().messageId,
      from: 'miet_royal',
      body: 'Antwort von Miet-Royal',
      bodyDeleted: false,
      photos: [],
    });
    const raw = JSON.stringify(list.json());
    for (const forbidden of [
      'Anna',
      'Admin',
      adminId,
      'createdByStaff',
      'staffUserId',
      'sender',
      'mailDeliveryId',
      'providerMessageId',
      'deliveryState',
      'subject',
      'storageKey',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

describe('M20.–M22. E-Mail-Hinweis', () => {
  it('M20. Reply-Mail-Hinweis: Zustellung customer_portal_reply_notice an die Kunden-E-Mail mit Kontext {salutation, processNumber}, Key customer_portal_reply_notice:<messageId>; Versand mit festem Text + Portal-Link', async () => {
    const world = await createAcceptedBooking(ctx, adminId);
    const response = await reply(world.processId, adminCookie, {
      channel: 'portal',
      body: 'Vertraulicher Antworttext',
    });
    expect(response.statusCode).toBe(201);
    const messageId = response.json().messageId as string;
    const deliveries = await noticeDeliveries();
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0]!;
    expect(delivery).toMatchObject({
      processId: world.processId,
      customerId: world.customerId,
      recipientEmail: 'klara.kommerz@test.example',
      status: 'pending',
      idempotencyKey: `customer_portal_reply_notice:${messageId}`,
      conversationMessageId: messageId,
      createdBy: adminId,
    });
    expect(delivery.subject).toMatch(/^Neue Nachricht von Miet-Royal – Vorgang MR-\d{4}-\d{4}$/);
    expect(delivery.context).toEqual({
      salutation: 'Hallo Klara Kommerz,',
      processNumber: expect.stringMatching(/^MR-\d{4}-\d{4}$/),
    });
    expect(delivery.secretPayloadCiphertext).toBeNull();

    await drainJobs(ctx);
    expect(ctx.mailGateway.sent).toHaveLength(1);
    const mail = ctx.mailGateway.sent[0]!;
    expect(mail.to.email).toBe('klara.kommerz@test.example');
    expect(mail.subject).toBe(delivery.subject);
    expect(mail.text).toContain('Du hast eine neue Nachricht von Miet-Royal.');
    expect(mail.text).toContain('/konto');
    expect(mail.text).not.toContain('Vertraulicher Antworttext');
    expect(mail.html).not.toContain('Vertraulicher Antworttext');
    // Die Portalnachricht bleibt „sent“ – der Mailstatus wird nicht auf sie gespiegelt.
    const row = (await messageRows(world.processId)).find((r) => r.id === messageId)!;
    expect(row.deliveryState).toBe('sent');
    // Zweite Antwort ⇒ zweiter Hinweis (je Nachricht ein Key).
    const second = await reply(world.processId, adminCookie, {
      channel: 'portal',
      body: 'Noch etwas',
    });
    expect(second.statusCode).toBe(201);
    expect(await noticeDeliveries()).toHaveLength(2);
  });

  it('M21. Keine Chatbody-Pflicht in der Mail: Kontext-Schema enthält keinen Body; Mail scheitert dauerhaft ⇒ Portalnachricht bleibt sichtbar', async () => {
    const world = await createAcceptedBooking(ctx, adminId);
    const cookie = await loginPortalCustomer(ctx, world.customerId);
    ctx.mailGateway.nextOutcomes({ outcome: 'permanent_error', code: 'SMTP_550' });
    const response = await reply(world.processId, adminCookie, {
      channel: 'portal',
      body: 'Bleibt trotz Mailfehler',
    });
    expect(response.statusCode).toBe(201);
    await drainJobs(ctx);
    const delivery = (await noticeDeliveries())[0]!;
    expect(delivery.status).toBe('failed');
    expect(Object.keys(delivery.context as Record<string, unknown>).sort()).toEqual([
      'processNumber',
      'salutation',
    ]);
    const list = await portalMessages(cookie, world.bookingId);
    expect(list.json().messages).toHaveLength(1);
    expect(list.json().messages[0]).toMatchObject({
      from: 'miet_royal',
      body: 'Bleibt trotz Mailfehler',
    });
    const row = (await messageRows(world.processId)).find((r) => r.channel === 'portal')!;
    expect(row.deliveryState).toBe('sent');
  });

  it('M22. Ohne Outbox (Mail nicht konfiguriert) ⇒ noticeStatus unavailable, Nachricht gespeichert; Kunde ohne E-Mail ⇒ unavailable', async () => {
    const world = await createAcceptedBooking(ctx, adminId);
    const service = new ConversationService(ctx.db, ctx.storage);
    const withoutOutbox = await service.replyByPortal(null, {
      processId: world.processId,
      body: 'Ohne Mailweg',
      staffUserId: adminId,
      appEnv: 'development',
    });
    expect(withoutOutbox).toMatchObject({
      channel: 'portal',
      deliveryState: 'sent',
      noticeStatus: 'unavailable',
    });
    expect(await noticeDeliveries()).toHaveLength(0);
    await ctx.pool.query('UPDATE customers SET email = NULL WHERE id = $1', [world.customerId]);
    const noEmail = await reply(world.processId, adminCookie, {
      channel: 'portal',
      body: 'Ohne E-Mail',
    });
    expect(noEmail.statusCode).toBe(201);
    expect(noEmail.json().noticeStatus).toBe('unavailable');
    expect(await noticeDeliveries()).toHaveLength(0);
    expect((await messageRows(world.processId)).filter((r) => r.channel === 'portal')).toHaveLength(
      2,
    );
  });
});

describe('M23.–M24. Terminal und Hinweise', () => {
  it('M23. Terminal/ohne Buchung: abgeschlossener Vorgang ⇒ 409 (E-Mail-Antwort weiterhin möglich); Vorgang ohne Buchung ⇒ 409; canReplyPortal false', async () => {
    const world = await createAcceptedBooking(ctx, adminId);
    await completeProcess(ctx, world.processId);
    const blocked = await reply(world.processId, adminCookie, {
      channel: 'portal',
      body: 'zu spät',
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('CONFLICT');
    expect((await conversation(world.processId)).json().canReplyPortal).toBe(false);
    const email = await reply(world.processId, adminCookie, { channel: 'email', body: 'per Mail' });
    expect(email.statusCode).toBe(201);
    expect((await messageRows(world.processId)).filter((r) => r.channel === 'portal')).toHaveLength(
      0,
    );
    const { process } = await createCustomerWithProcess(ctx, adminId, {
      email: 'nur.anfrage@example.com',
    });
    expect((await conversation(process.id)).json().canReplyPortal).toBe(false);
    const noBooking = await reply(process.id, adminCookie, { channel: 'portal', body: 'Hallo' });
    expect(noBooking.statusCode).toBe(409);
    expect(await noticeDeliveries()).toHaveLength(0);
  });

  it('M24. GET conversation: canReplyPortal nur mit Buchung + offenem Vorgang + Recht; portalActive nur mit gültiger Session', async () => {
    const world = await createAcceptedBooking(ctx, adminId);
    let view = (await conversation(world.processId)).json();
    expect(view).toMatchObject({ canReplyPortal: true, portalActive: false });
    expect(view.canReplyEmail).toBe(true);
    await loginPortalCustomer(ctx, world.customerId);
    view = (await conversation(world.processId)).json();
    expect(view.portalActive).toBe(true);
    // Abgelaufene Session zählt nicht.
    await ctx.pool.query(
      `UPDATE customer_portal_sessions SET created_at = now() - interval '31 days', expires_at = now() - interval '1 day' WHERE customer_id = $1`,
      [world.customerId],
    );
    view = (await conversation(world.processId)).json();
    expect(view.portalActive).toBe(false);
    await loginPortalCustomer(ctx, world.customerId);
    expect((await conversation(world.processId)).json().portalActive).toBe(true);
  });
});
