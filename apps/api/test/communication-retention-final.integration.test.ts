/**
 * Phase-12-Finalisierung – Retention der Kommunikation (Auftrag Punkt 4,
 * Tests R1–R20, R15b; R21–R29 = reproduzierte Befunde des adversarialen
 * Reviews: Media-Job-Key, Bezugszeit created_at, Reopen-Rennen, Retry bei
 * Fotofehlern, Rewrap, Purge-Rennen, Media-Job nach Reopen, scan_due).
 *
 * Terminal = abgeschlossen ODER storniert; Chatfotos sofort beim Eintritt in
 * terminal; Chattext + prozessgebundene Zustellungen 12 Berliner Kalender-
 * monate nach dem Retention-Anker (Terminalzeitpunkt); Unzugeordnetes/
 * Ignoriertes/Quarantäne 90 Kalendertage nach Eingang; nicht prozess-
 * gebundene Zustellungen 90 Tage nach Endzustand; Message-ID nur als Hash;
 * Fachbilder/Dokumente nie berührt; alles idempotent.
 * Zeitreisen: direkte DB-Updates (completed_at/cancelled_at/received_at/
 * retention_anchor_at …) und explizites `now` in den Service-Aufrufen.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  cancellations,
  conversationMessages,
  customers,
  inboundMailReceipts,
  inboundMailState,
  integrationJobs,
  mailDeliveries,
  messagePhotos,
  processes,
  whatsappContacts,
  whatsappEvents,
  type MailDeliveryRow,
} from '@mietroyal/database';
import { addBerlinCalendarDays, addBerlinCalendarMonths } from '@mietroyal/domain';
import { FakeInboundMailSource } from '../src/communication/inbound/sources.ts';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationService,
  photoStorageKey,
  type SenderSnapshot,
} from '../src/communication/conversation/conversation-service.ts';
import { inboundMessageIdHash } from '../src/communication/inbound/content.ts';
import { InboundMailProcessor } from '../src/communication/inbound/processor.ts';
import { MAIL_DELIVERY_SCRUBBED_SUBJECT } from '../src/communication/mail/outbox.ts';
import { PayloadCrypto } from '../src/communication/payload-crypto.ts';
import {
  berlinDay,
  createCleanupRetentionHandler,
  RetentionCleanupService,
  retentionBackstopJobKey,
  retentionPhotosJobKey,
} from '../src/communication/retention/cleanup.ts';
import { rewrapMailSecretPayloads } from '../src/communication/rewrap.ts';
import { enqueueDailyRetentionBackstop, runScanDue } from '../src/communication/scan-due.ts';
import {
  COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE,
  WHATSAPP_MEDIA_FETCH_JOB_TYPE,
  type WhatsAppGateway,
} from '../src/communication/types.ts';
import {
  createWhatsAppMediaFetchHandler,
  whatsappMediaStorageKey,
} from '../src/communication/whatsapp/jobs.ts';
import {
  WhatsAppWebhookService,
  whatsappMediaFetchJobKey,
} from '../src/communication/whatsapp/webhook-service.ts';
import type { ClaimedJob } from '@mietroyal/integrations';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { bookedProcess } from './cancellation-helpers.ts';
import {
  createCustomerWithProcess,
  insertOwnDelivery,
  truncateCommunicationTables,
  whatsappMessagePayload,
  whatsappStatusPayload,
} from './communication-helpers.ts';
import { adminVisibilityCtx, processServiceFor } from './crm-helpers.ts';
import { adminSession, finalizedReturn, resetSettlementWorld } from './settlement-helpers.ts';

let ctx: TestContext;
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 0xff, 0xd9,
]);
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIf/9k=';
/** Echt aussehende wamid: base64 enthält die wa_id 4917612345678 (nicht opak!). */
const WAMID = 'wamid.HBgNNDkxNzYxMjM0NTY3OBUCABIYFjNFQjBGQkQ3QjQ1RkY0QzJDNUE3AA==';
const WA_ID = '4917612345678';

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await truncateCommunicationTables(ctx.pool);
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateCommunicationTables(ctx.pool);
  await resetSettlementWorld(ctx);
  ctx.inboundMail.clear();
  ctx.inboundMail.uidValidity = 1;
});

// ── Hilfen ────────────────────────────────────────────────────────────────

const conversations = () => new ConversationService(ctx.db, ctx.storage);
const retention = () => ctx.scan.retention;

async function drain(): Promise<void> {
  for (let i = 0; i < 80; i += 1) if ((await ctx.jobs.runOnce()) === 'idle') break;
}

async function inject(
  cookie: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
) {
  return ctx.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function chatMessage(input: {
  processId: string | null;
  customerId: string | null;
  channel?: 'email' | 'whatsapp';
  body?: string;
  subject?: string | null;
  sender?: SenderSnapshot;
  providerMessageId?: string | null;
  replyTo?: string | null;
  receivedAt?: Date;
  photo?: boolean;
}) {
  const message = await conversations().createInbound({
    processId: input.processId,
    customerId: input.customerId,
    channel: input.channel ?? 'email',
    sender: input.sender ?? { name: 'Max Mustermann', email: 'max.mustermann@example.com' },
    subject: input.subject === undefined ? 'Foto vom Aufbau' : input.subject,
    body: input.body ?? 'Privater Chattext, Musterweg 1, 55116 Mainz',
    providerMessageId:
      input.providerMessageId === undefined
        ? `${randomUUID()}@example.com`
        : input.providerMessageId,
    replyToProviderMessageId: input.replyTo ?? null,
    receivedAt: input.receivedAt ?? new Date(),
  });
  if (input.photo === false) return { message, photo: null };
  const storageKey = photoStorageKey(message.id, 'jpg');
  await ctx.storage.put(storageKey, new Uint8Array(JPEG), { contentType: 'image/jpeg' });
  const photo = await conversations().registerPhoto({
    messageId: message.id,
    storageKey,
    mimeType: 'image/jpeg',
    byteSize: JPEG.length,
    sha256: createHash('sha256').update(JPEG).digest('hex'),
  });
  return { message, photo: { id: photo.id, storageKey } };
}

async function outboundStaffMessage(processId: string, customerId: string) {
  const rows = await ctx.db
    .insert(conversationMessages)
    .values({
      processId,
      customerId,
      channel: 'email',
      direction: 'outbound',
      senderSnapshot: { name: 'Erika Mitarbeiterin' },
      subject: 'Re: Ihre Anfrage MR-Test',
      body: 'Hallo Max, gern bis Samstag.',
      replyToProviderMessageId: 'kunde-1@example.com',
      deliveryState: 'sent',
    })
    .returning();
  return rows[0]!;
}

async function insertDelivery(input: {
  processId: string | null;
  customerId?: string | null;
  status: MailDeliveryRow['status'];
  kind?: MailDeliveryRow['kind'];
  sentAt?: Date | null;
  updatedAt?: Date;
  secret?: boolean;
}): Promise<MailDeliveryRow> {
  const rows = await ctx.db
    .insert(mailDeliveries)
    .values({
      kind: input.kind ?? 'order_confirmation',
      processId: input.processId,
      customerId: input.customerId ?? null,
      recipientEmail: 'max.mustermann@example.com',
      recipientName: 'Max Mustermann',
      subject: 'Ihre Auftragsbestätigung MR-Test',
      templateKind: input.kind ?? 'order_confirmation',
      context: { salutation: 'Hallo Max,', processNumber: 'MR-2026-0001' },
      attachments: [{ kind: 'document', documentId: randomUUID(), filename: 'ab.pdf' }],
      secretPayloadCiphertext: input.secret === false ? null : 'v1:geheim-test-ciphertext',
      status: input.status,
      idempotencyKey: `retention-test:${randomUUID()}`,
      messageId: `<${randomUUID()}@miet-royal.test>`,
      inReplyToMessageId: '<kunde-1@example.com>',
      attempts: 1,
      sentAt: input.sentAt ?? (input.status === 'sent' ? new Date() : null),
      providerCode: input.status === 'sent' ? 'SMTP_250' : null,
      lastErrorCode: input.status === 'failed' ? 'SMTP_550' : null,
      blockedReason: input.status === 'blocked' ? 'MAIL_NOT_CONFIGURED' : null,
      ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    })
    .returning();
  return rows[0]!;
}

const processRow = async (id: string) =>
  (await ctx.db.select().from(processes).where(eq(processes.id, id)))[0]!;
const messageRow = async (id: string) =>
  (await ctx.db.select().from(conversationMessages).where(eq(conversationMessages.id, id)))[0]!;
const photoRow = async (id: string) =>
  (await ctx.db.select().from(messagePhotos).where(eq(messagePhotos.id, id)))[0]!;
const deliveryRow = async (id: string) =>
  (await ctx.db.select().from(mailDeliveries).where(eq(mailDeliveries.id, id)))[0]!;

async function retentionJobs() {
  return ctx.db
    .select()
    .from(integrationJobs)
    .where(eq(integrationJobs.type, COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE));
}

async function setAnchor(processId: string, at: Date): Promise<void> {
  await ctx.db
    .update(conversationMessages)
    .set({ retentionAnchorAt: at })
    .where(eq(conversationMessages.processId, processId));
  await ctx.db
    .update(mailDeliveries)
    .set({ retentionAnchorAt: at })
    .where(eq(mailDeliveries.processId, processId));
}

/**
 * Serverseitigen Eingang (created_at) einer unzugeordneten Nachricht + Beleg
 * zurückdatieren. Review-Fund: Bezugszeitpunkt der 90-Tage-Frist ist
 * ausschließlich created_at – received_at (Date-Header) bleibt unverändert.
 */
async function backdateInbound(messageId: string, at: Date): Promise<void> {
  await ctx.db
    .update(conversationMessages)
    .set({ createdAt: at })
    .where(eq(conversationMessages.id, messageId));
  await ctx.db
    .update(inboundMailReceipts)
    .set({ createdAt: at })
    .where(eq(inboundMailReceipts.conversationMessageId, messageId));
}

function photoMail(input: {
  messageId: string | null;
  from?: string;
  inReplyTo?: string;
  date?: string;
  body?: string;
}): string {
  return [
    `From: ${input.from ?? 'Erika Beispiel <erika@example.net>'}`,
    'To: Miet-Royal Mainz <buero@miet-royal.test>',
    'Subject: Foto vom Stellplatz',
    `Date: ${input.date ?? 'Sat, 18 Oct 2026 11:00:00 +0200'}`,
    ...(input.messageId === null ? [] : [`Message-ID: <${input.messageId}>`]),
    ...(input.inReplyTo === undefined ? [] : [`In-Reply-To: <${input.inReplyTo}>`]),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    input.body ?? 'Anbei ein Foto, Telefon 0176 1234567.',
    '',
    '--b1',
    'Content-Type: image/jpeg; name="foto.jpg"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="foto.jpg"',
    '',
    JPEG_B64,
    '',
    '--b1--',
    '',
  ].join('\r\n');
}

const processor = (source = ctx.inboundMail) =>
  new InboundMailProcessor({ db: ctx.db, storage: ctx.storage, source });

function expectNoPii(value: unknown, needles: readonly string[]): void {
  const json = JSON.stringify(value);
  for (const needle of needles) expect(json).not.toContain(needle);
}

// ── R1–R4: Eintritt in terminal ──────────────────────────────────────────

describe('R1.–R4. Eintritt in terminal (abgeschlossen/storniert): Chatfotos sofort, Retention-Anker', () => {
  it('R1. Abschluss ⇒ Listener-Job: Chatfotos sofort gelöscht (Storage + deletedAt), Anker = completed_at für Nachrichten und prozessgebundene Zustellungen; Text bleibt; nicht prozessgebundene Zustellung ohne Anker', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const chat = await chatMessage({ processId: process.id, customerId: customer.id });
    const bound = await insertDelivery({
      processId: process.id,
      customerId: customer.id,
      status: 'sent',
    });
    const unbound = await insertDelivery({
      processId: null,
      status: 'sent',
      kind: 'voucher_delivery',
    });

    expect(
      (await inject(cookie, 'POST', `/staff/processes/${process.id}/complete`)).statusCode,
    ).toBe(200);
    const completedAt = (await processRow(process.id)).completedAt!;
    const jobs = await retentionJobs();
    expect(jobs.map((job) => job.idempotencyKey)).toEqual([
      retentionPhotosJobKey(process.id, completedAt),
    ]);
    expect(jobs[0]!.payload).toMatchObject({
      scope: 'photos',
      processId: process.id,
      terminalAt: completedAt.toISOString(),
    });
    // Nach dem Commit, vor dem Job: noch unverändert (Storage nie in der Transaktion).
    expect((await photoRow(chat.photo!.id)).deletedAt).toBeNull();

    await drain();
    expect((await photoRow(chat.photo!.id)).deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(chat.photo!.storageKey)).toBe(false);
    const message = await messageRow(chat.message.id);
    expect(message.retentionAnchorAt?.toISOString()).toBe(completedAt.toISOString());
    expect(message.body).toBe('Privater Chattext, Musterweg 1, 55116 Mainz');
    expect(message.piiScrubbedAt).toBeNull();
    expect((await deliveryRow(bound.id)).retentionAnchorAt?.toISOString()).toBe(
      completedAt.toISOString(),
    );
    expect((await deliveryRow(unbound.id)).retentionAnchorAt).toBeNull();
  });

  it('R2. Staff-Storno mit Buchung (Phase 9) ⇒ Listener-Job: Chatfotos sofort gelöscht, Anker = processes.cancelled_at (= cancellations.cancelled_at), auch für die Angebots-/AB-Zustellungen', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await bookedProcess(ctx, admin.id, { eventInDays: 40 });
    await drain();
    const chat = await chatMessage({ processId: world.processId, customerId: world.customerId });

    const response = await inject(
      cookie,
      'POST',
      `/staff/processes/${world.processId}/cancellation`,
      { confirm: true },
    );
    expect(response.statusCode).toBe(200);
    const process = await processRow(world.processId);
    expect(process.mainStatus).toBe('cancelled');
    const cancellation = (
      await ctx.db.select().from(cancellations).where(eq(cancellations.processId, world.processId))
    )[0]!;
    expect(cancellation.cancelledAt.toISOString()).toBe(process.cancelledAt!.toISOString());
    expect((await retentionJobs()).map((job) => job.idempotencyKey)).toContain(
      retentionPhotosJobKey(world.processId, process.cancelledAt!),
    );

    await drain();
    expect((await photoRow(chat.photo!.id)).deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(chat.photo!.storageKey)).toBe(false);
    expect((await messageRow(chat.message.id)).retentionAnchorAt?.toISOString()).toBe(
      process.cancelledAt!.toISOString(),
    );
    const deliveries = await ctx.db
      .select()
      .from(mailDeliveries)
      .where(eq(mailDeliveries.processId, world.processId));
    expect(deliveries.length).toBeGreaterThan(0);
    for (const delivery of deliveries) {
      expect(delivery.retentionAnchorAt?.toISOString()).toBe(process.cancelledAt!.toISOString());
    }
  });

  it('R3. Legacy-Storno ohne Buchung (POST /staff/processes/:id/cancel) ⇒ Fotos sofort gelöscht; Anker = cancelled_at, nie updated_at', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const chat = await chatMessage({ processId: process.id, customerId: customer.id });
    expect((await inject(cookie, 'POST', `/staff/processes/${process.id}/cancel`)).statusCode).toBe(
      200,
    );
    const cancelledAt = (await processRow(process.id)).cancelledAt!;
    expect((await retentionJobs()).map((job) => job.idempotencyKey)).toEqual([
      retentionPhotosJobKey(process.id, cancelledAt),
    ]);
    // Spätere technische Änderung am Vorgang darf den Anker nicht verschieben.
    await ctx.db
      .update(processes)
      .set({ updatedAt: new Date(cancelledAt.getTime() + 3_600_000) })
      .where(eq(processes.id, process.id));

    await drain();
    expect((await photoRow(chat.photo!.id)).deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(chat.photo!.storageKey)).toBe(false);
    expect((await messageRow(chat.message.id)).retentionAnchorAt?.toISOString()).toBe(
      cancelledAt.toISOString(),
    );
  });

  it('R4. Backstop (scan_due, alle 2 min) holt einen Storno ohne Listener nach: Fotos gelöscht, Anker gesetzt; offene Vorgänge unberührt', async () => {
    const { admin } = await adminSession(ctx);
    const cancelled = await createCustomerWithProcess(ctx, admin.id);
    const open = await createCustomerWithProcess(ctx, admin.id, { email: 'offen@example.org' });
    const chat = await chatMessage({
      processId: cancelled.process.id,
      customerId: cancelled.customer.id,
    });
    const openChat = await chatMessage({
      processId: open.process.id,
      customerId: open.customer.id,
    });
    // ProcessService OHNE Listener (z. B. Einreihen fehlgeschlagen) ⇒ kein Job.
    await processServiceFor(ctx).cancel(cancelled.process.id, adminVisibilityCtx());
    expect(await retentionJobs()).toHaveLength(0);

    const result = await ctx.scan.runOnce(new Date());
    expect(result.retention.photosDeleted).toBe(1);
    expect((await photoRow(chat.photo!.id)).deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(chat.photo!.storageKey)).toBe(false);
    const cancelledAt = (await processRow(cancelled.process.id)).cancelledAt!;
    expect((await messageRow(chat.message.id)).retentionAnchorAt?.toISOString()).toBe(
      cancelledAt.toISOString(),
    );
    expect((await photoRow(openChat.photo!.id)).deletedAt).toBeNull();
    expect((await messageRow(openChat.message.id)).retentionAnchorAt).toBeNull();
  });
});

// ── R5–R8: 12-Monats-Frist, Reopen ───────────────────────────────────────

describe('R5.–R8. Chattext 12 Berliner Kalendermonate nach dem Anker; Reopen', () => {
  it('R5. Abschluss: Text/Betreff/Absender/Message-IDs nach exakt 12 Berliner Kalendermonaten minimiert (inbound ⇒ {"role":"customer"}, outbound ⇒ {"role":"staff"}, WhatsApp-wamid entfernt); davor unverändert; Monatsende-Kappung exakt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const email = await chatMessage({
      processId: process.id,
      customerId: customer.id,
      providerMessageId: 'kunde-1@example.com',
      replyTo: '0b7c7f0e-1111-4222-8333-944445555666@miet-royal.test',
    });
    const whatsapp = await chatMessage({
      processId: process.id,
      customerId: customer.id,
      channel: 'whatsapp',
      subject: null,
      sender: { phone: WA_ID, name: 'Max WhatsApp' },
      providerMessageId: WAMID,
      photo: false,
    });
    const outbound = await outboundStaffMessage(process.id, customer.id);
    expect(
      (await inject(cookie, 'POST', `/staff/processes/${process.id}/complete`)).statusCode,
    ).toBe(200);
    await drain();
    // Abschluss am 19.10.2025 00:30 Berlin (CEST).
    await setAnchor(process.id, new Date('2025-10-18T22:30:00Z'));

    // 19.10.2026 00:15 Berlin ⇒ noch nicht fällig.
    const early = await retention().runBackstop(new Date('2026-10-18T22:15:00Z'), {
      textRetention: true,
    });
    expect(early.text.purged).toBe(0);
    expect((await messageRow(email.message.id)).body).toContain('Musterweg');

    // 19.10.2026 00:30 Berlin ⇒ exakt fällig.
    const now = new Date('2026-10-18T22:30:00Z');
    const result = await retention().runBackstop(now, { textRetention: true });
    expect(result.text).toEqual({ processes: 1, purged: 3 });
    const inbound = await messageRow(email.message.id);
    expect(inbound).toMatchObject({
      body: '',
      subject: null,
      senderSnapshot: { role: 'customer' },
      providerMessageId: null,
      replyToProviderMessageId: null,
    });
    expect(inbound.bodyDeletedAt?.toISOString()).toBe(now.toISOString());
    expect(inbound.piiScrubbedAt?.toISOString()).toBe(now.toISOString());
    expect(await messageRow(whatsapp.message.id)).toMatchObject({
      body: '',
      senderSnapshot: { role: 'customer' },
      providerMessageId: null,
    });
    expect(await messageRow(outbound.id)).toMatchObject({
      body: '',
      subject: null,
      senderSnapshot: { role: 'staff' },
      replyToProviderMessageId: null,
    });
    const rows = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.processId, process.id));
    expectNoPii(rows, ['Musterweg', 'max.mustermann', 'Max', 'Erika', WA_ID, WAMID, 'kunde-1@']);
    // API-Sicht: nur neutrale Rolle, Text als gelöscht markiert.
    const list = (
      await inject(cookie, 'GET', `/staff/processes/${process.id}/conversation`)
    ).json() as { messages: { body: string; bodyDeleted: boolean; sender: unknown }[] };
    expect(list.messages.every((m) => m.body === '' && m.bodyDeleted)).toBe(true);
    expectNoPii(list, ['Musterweg', 'max.mustermann', WA_ID]);

    // Monatsende: Anker 29.02.2028 12:00 Berlin ⇒ fällig am 28.02.2029 12:00 Berlin.
    const leap = await createCustomerWithProcess(ctx, admin.id, { email: 'schalt@example.org' });
    const leapMsg = await chatMessage({
      processId: leap.process.id,
      customerId: leap.customer.id,
      photo: false,
    });
    await processServiceFor(ctx).complete(leap.process.id, adminVisibilityCtx());
    await retention().stampAnchorsBackstop();
    await setAnchor(leap.process.id, new Date('2028-02-29T11:00:00Z'));
    await retention().purgeExpiredChatText(new Date('2029-02-28T10:59:00Z'));
    expect((await messageRow(leapMsg.message.id)).piiScrubbedAt).toBeNull();
    await retention().purgeExpiredChatText(new Date('2029-02-28T11:00:00Z'));
    expect((await messageRow(leapMsg.message.id)).piiScrubbedAt).not.toBeNull();
  });

  it('R6. Storno: Fristbeginn ist der Stornozeitpunkt (cancelled_at) – 12 Monate danach minimiert, eine Minute davor nicht', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const chat = await chatMessage({
      processId: process.id,
      customerId: customer.id,
      photo: false,
    });
    expect((await inject(cookie, 'POST', `/staff/processes/${process.id}/cancel`)).statusCode).toBe(
      200,
    );
    await drain();
    const cancelledAt = (await processRow(process.id)).cancelledAt!;
    expect((await messageRow(chat.message.id)).retentionAnchorAt?.toISOString()).toBe(
      cancelledAt.toISOString(),
    );
    const due = addBerlinCalendarMonths(cancelledAt, 12);
    await retention().purgeExpiredChatText(new Date(due.getTime() - 60_000));
    expect((await messageRow(chat.message.id)).piiScrubbedAt).toBeNull();
    await retention().purgeExpiredChatText(due);
    expect(await messageRow(chat.message.id)).toMatchObject({
      body: '',
      subject: null,
      senderSnapshot: { role: 'customer' },
    });
  });

  it('R7. Reopen setzt nichts zurück und restauriert nichts; neue Nachrichten ohne Anker; erneuter Abschluss ⇒ neuer Anker nur für die neuen Daten; Fristen laufen getrennt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const first = await chatMessage({ processId: process.id, customerId: customer.id });
    expect(
      (await inject(cookie, 'POST', `/staff/processes/${process.id}/complete`)).statusCode,
    ).toBe(200);
    await drain();
    const firstAnchor = (await messageRow(first.message.id)).retentionAnchorAt!;
    // Alte Daten nach 12 Monaten bereinigt …
    const t0 = new Date('2025-01-10T10:00:00Z');
    await setAnchor(process.id, t0);
    await retention().purgeExpiredChatText(addBerlinCalendarMonths(t0, 12));
    expect((await messageRow(first.message.id)).piiScrubbedAt).not.toBeNull();

    // … Reopen restauriert nichts.
    expect((await inject(cookie, 'POST', `/staff/processes/${process.id}/reopen`)).statusCode).toBe(
      200,
    );
    const afterReopen = await messageRow(first.message.id);
    expect(afterReopen.body).toBe('');
    expect(afterReopen.retentionAnchorAt?.toISOString()).toBe(t0.toISOString());
    expect((await photoRow(first.photo!.id)).deletedAt).not.toBeNull();
    expect(firstAnchor.getTime()).toBeGreaterThan(t0.getTime());

    // Neue Kommunikation läuft normal, Anker NULL bis zum nächsten Terminalzustand.
    const second = await chatMessage({
      processId: process.id,
      customerId: customer.id,
      body: 'Nach dem Reopen',
    });
    await retention().runBackstop(addBerlinCalendarMonths(new Date(), 24), { textRetention: true });
    const secondOpen = await messageRow(second.message.id);
    expect(secondOpen.retentionAnchorAt).toBeNull();
    expect(secondOpen.body).toBe('Nach dem Reopen');
    expect((await photoRow(second.photo!.id)).deletedAt).toBeNull();

    expect(
      (await inject(cookie, 'POST', `/staff/processes/${process.id}/complete`)).statusCode,
    ).toBe(200);
    await drain();
    const completedAgain = (await processRow(process.id)).completedAt!;
    expect((await messageRow(second.message.id)).retentionAnchorAt?.toISOString()).toBe(
      completedAgain.toISOString(),
    );
    expect((await messageRow(first.message.id)).retentionAnchorAt?.toISOString()).toBe(
      t0.toISOString(),
    );
    expect((await photoRow(second.photo!.id)).deletedAt).not.toBeNull();
    // Neue Daten erst 12 Monate nach dem NEUEN Abschluss.
    await retention().purgeExpiredChatText(
      new Date(addBerlinCalendarMonths(completedAgain, 12).getTime() - 1),
    );
    expect((await messageRow(second.message.id)).piiScrubbedAt).toBeNull();
    await retention().purgeExpiredChatText(addBerlinCalendarMonths(completedAgain, 12));
    expect((await messageRow(second.message.id)).body).toBe('');
  });

  it('R8. Terminal-Job läuft erst nach einem Reopen: nur Daten, die zum Terminalzeitpunkt zum Vorgang gehörten, erhalten den Anker bzw. verlieren ihre Fotos', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const before = await chatMessage({ processId: process.id, customerId: customer.id });
    expect(
      (await inject(cookie, 'POST', `/staff/processes/${process.id}/complete`)).statusCode,
    ).toBe(200);
    const completedAt = (await processRow(process.id)).completedAt!;
    // Job noch nicht gelaufen (Worker träge) – der Vorgang wird wieder geöffnet.
    expect((await inject(cookie, 'POST', `/staff/processes/${process.id}/reopen`)).statusCode).toBe(
      200,
    );
    const after = await chatMessage({
      processId: process.id,
      customerId: customer.id,
      body: 'Nach dem Reopen',
    });

    await drain();
    expect((await messageRow(before.message.id)).retentionAnchorAt?.toISOString()).toBe(
      completedAt.toISOString(),
    );
    expect((await photoRow(before.photo!.id)).deletedAt).not.toBeNull();
    expect((await messageRow(after.message.id)).retentionAnchorAt).toBeNull();
    expect((await photoRow(after.photo!.id)).deletedAt).toBeNull();
    expect(await ctx.storage.exists(after.photo!.storageKey)).toBe(true);
  });
});

// ── R9–R10: spätere Zuordnung zu terminalen Vorgängen ────────────────────

describe('R9.–R10. Nachträglich einem terminalen Vorgang zugeordnete Nachrichten', () => {
  it('R9. Manuelle Zuordnung zu einem abgeschlossenen Vorgang ⇒ Chatfotos sofort gelöscht; Anker beim nächsten Backstop = aktueller Terminalzeitpunkt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    expect(
      (await inject(cookie, 'POST', `/staff/processes/${process.id}/complete`)).statusCode,
    ).toBe(200);
    await drain();
    const unmatched = await chatMessage({ processId: null, customerId: null });

    const response = await inject(
      cookie,
      'POST',
      `/staff/communication/unmatched/${unmatched.message.id}/assign`,
      { processId: process.id },
    );
    expect(response.statusCode).toBe(200);
    expect((await photoRow(unmatched.photo!.id)).deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(unmatched.photo!.storageKey)).toBe(false);
    expect((await messageRow(unmatched.message.id)).retentionAnchorAt).toBeNull();

    await retention().runFrequentBackstop();
    const completedAt = (await processRow(process.id)).completedAt!;
    const assigned = await messageRow(unmatched.message.id);
    expect(assigned.processId).toBe(process.id);
    expect(assigned.customerId).toBe(customer.id);
    expect(assigned.retentionAnchorAt?.toISOString()).toBe(completedAt.toISOString());
  });

  it('R10. In-Reply-To (IMAP) auf eine Mail eines stornierten Vorgangs ⇒ zugeordnet, Fotos sofort gelöscht; Anker beim Backstop = Stornozeitpunkt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id, {
      email: 'erika@example.net',
    });
    await insertOwnDelivery(ctx, {
      processId: process.id,
      customerId: customer.id,
      messageId: '<offer-r10@miet-royal.test>',
      recipientEmail: 'erika@example.net',
    });
    expect((await inject(cookie, 'POST', `/staff/processes/${process.id}/cancel`)).statusCode).toBe(
      200,
    );
    await drain();

    ctx.inboundMail.add(
      photoMail({ messageId: 'r10@example.net', inReplyTo: 'offer-r10@miet-royal.test' }),
    );
    const result = await processor().pollOnce();
    expect(result.outcomes.map((o) => [o.result, o.matchReason, o.photos])).toEqual([
      ['matched', 'in_reply_to', 1],
    ]);
    const messageId = result.outcomes[0]!.conversationMessageId!;
    const photos = await ctx.db
      .select()
      .from(messagePhotos)
      .where(eq(messagePhotos.messageId, messageId));
    expect(photos).toHaveLength(1);
    expect(photos[0]!.deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(photos[0]!.storageKey)).toBe(false);
    expect((await messageRow(messageId)).retentionAnchorAt).toBeNull();

    await ctx.scan.runOnce(new Date());
    expect((await messageRow(messageId)).retentionAnchorAt?.toISOString()).toBe(
      (await processRow(process.id)).cancelledAt!.toISOString(),
    );
  });
});

// ── R11–R15: Unzugeordnetes, IMAP-Dedupe, Message-ID-Hash, WhatsApp ───────

describe('R11.–R15. Unzugeordnet/ignoriert/Quarantäne nach 90 Kalendertagen; Dedupe; WhatsApp', () => {
  it('R11. Unzugeordnete E-Mail nach 90 Kalendertagen: Text/Betreff/Absender leer, Fotos gelöscht, Beleg ohne Absender/Betreff, nicht mehr in der Inbox, nicht zuordenbar/ignorierbar; 1 min vorher unverändert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { process } = await createCustomerWithProcess(ctx, admin.id);
    ctx.inboundMail.add(photoMail({ messageId: 'r11@example.net' }));
    const poll = await processor().pollOnce();
    expect(poll.outcomes.map((o) => o.result)).toEqual(['unmatched']);
    const messageId = poll.outcomes[0]!.conversationMessageId!;
    const t0 = new Date('2026-03-01T09:00:00Z');
    await backdateInbound(messageId, t0);
    const [photo] = await ctx.db
      .select()
      .from(messagePhotos)
      .where(eq(messagePhotos.messageId, messageId));
    const due = addBerlinCalendarDays(t0, 90);

    await retention().purgeUnmatched(new Date(due.getTime() - 60_000));
    expect((await messageRow(messageId)).piiScrubbedAt).toBeNull();
    const inbox = (await inject(cookie, 'GET', '/staff/communication/unmatched')).json() as {
      messages: { id: string }[];
    };
    expect(inbox.messages.map((m) => m.id)).toEqual([messageId]);

    const result = await retention().purgeUnmatched(due);
    expect(result).toMatchObject({ messages: 1, receipts: 1, photosDeleted: 1, photosFailed: 0 });
    const scrubbed = await messageRow(messageId);
    expect(scrubbed).toMatchObject({
      body: '',
      subject: null,
      senderSnapshot: {},
      providerMessageId: null,
      processId: null,
    });
    expect(scrubbed.piiScrubbedAt?.toISOString()).toBe(due.toISOString());
    expect((await photoRow(photo!.id)).deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(photo!.storageKey)).toBe(false);
    const [receipt] = await ctx.db.select().from(inboundMailReceipts);
    expect(receipt).toMatchObject({
      mailbox: 'INBOX',
      uidValidity: '1',
      uid: 1,
      status: 'unmatched',
      fromAddress: null,
      subject: null,
      messageIdHash: inboundMessageIdHash('r11@example.net'),
    });
    // received_at (Date-Header) bleibt technischer Rest; die Frist lief über created_at.
    expect(receipt!.receivedAt.toISOString()).toBe(
      new Date('Sat, 18 Oct 2026 11:00:00 +0200').toISOString(),
    );
    expect(receipt!.createdAt.toISOString()).toBe(t0.toISOString());
    expect(receipt!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt!.piiScrubbedAt?.toISOString()).toBe(due.toISOString());
    expectNoPii([scrubbed, receipt], ['erika', 'Erika', 'Stellplatz', '0176', 'r11@example.net']);

    const after = (await inject(cookie, 'GET', '/staff/communication/unmatched')).json() as {
      messages: unknown[];
    };
    expect(after.messages).toEqual([]);
    const assign = await inject(
      cookie,
      'POST',
      `/staff/communication/unmatched/${messageId}/assign`,
      {
        processId: process.id,
      },
    );
    expect(assign.statusCode).toBe(404);
    const ignore = await inject(
      cookie,
      'POST',
      `/staff/communication/unmatched/${messageId}/ignore`,
    );
    expect(ignore.statusCode).toBe(404);
    expect((await messageRow(messageId)).processId).toBeNull();
  });

  it('R12. Ignorierte Nachricht und Quarantäne-Beleg (rejected) nach 90 Tagen bereinigt; zugeordnete Belege und jüngere Eingänge bleiben; ein in die Zukunft datierter Date-Header verlängert die Frist nicht', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id, {
      email: 'max.mustermann@example.com',
    });
    ctx.inboundMail.add(photoMail({ messageId: 'r12-ignored@example.net' }));
    ctx.inboundMail.add(
      photoMail({ messageId: 'r12-future@example.net', date: 'Fri, 01 Jan 2100 10:00:00 +0100' }),
    );
    ctx.inboundMail.add(photoMail({ messageId: 'r12-young@example.net' }));
    const poll = await processor().pollOnce();
    const [ignoredId, futureId, youngId] = poll.outcomes.map((o) => o.conversationMessageId!);
    expect(
      (await inject(cookie, 'POST', `/staff/communication/unmatched/${ignoredId}/ignore`))
        .statusCode,
    ).toBe(200);
    const t0 = new Date('2026-01-05T08:00:00Z');
    await backdateInbound(ignoredId!, t0);
    await ctx.db
      .update(conversationMessages)
      .set({ createdAt: t0 })
      .where(eq(conversationMessages.id, futureId!));
    await ctx.db
      .update(inboundMailReceipts)
      .set({ createdAt: t0 })
      .where(eq(inboundMailReceipts.conversationMessageId, futureId!));
    // Quarantäne-Beleg (rejected) und ein zugeordneter Beleg desselben Alters.
    await ctx.db.insert(inboundMailReceipts).values([
      {
        mailbox: 'INBOX',
        uidValidity: '1',
        uid: 900,
        fingerprint: 'f'.repeat(64),
        fromAddress: 'spam@example.org',
        subject: 'Kaputte Mail',
        receivedAt: t0,
        createdAt: t0,
        status: 'rejected',
        matchReason: 'quarantined:PG_22021',
      },
    ]);
    const matched = await chatMessage({
      processId: process.id,
      customerId: customer.id,
      photo: false,
      receivedAt: t0,
    });
    await ctx.db.insert(inboundMailReceipts).values({
      mailbox: 'INBOX',
      uidValidity: '1',
      uid: 901,
      fingerprint: 'e'.repeat(64),
      fromAddress: 'max.mustermann@example.com',
      subject: 'Zugeordnet',
      receivedAt: t0,
      createdAt: t0,
      status: 'matched',
      matchReason: 'in_reply_to',
      conversationMessageId: matched.message.id,
    });

    const now = addBerlinCalendarDays(t0, 90);
    await retention().purgeUnmatched(now);
    expect(await messageRow(ignoredId!)).toMatchObject({
      body: '',
      subject: null,
      senderSnapshot: {},
    });
    expect((await messageRow(futureId!)).piiScrubbedAt).not.toBeNull();
    expect((await messageRow(youngId!)).piiScrubbedAt).toBeNull();
    expect((await messageRow(matched.message.id)).piiScrubbedAt).toBeNull();
    const receipts = await ctx.db.select().from(inboundMailReceipts);
    const byUid = new Map(receipts.map((r) => [r.uid, r]));
    expect(byUid.get(900)).toMatchObject({
      status: 'rejected',
      matchReason: 'quarantined:PG_22021',
      fromAddress: null,
      subject: null,
      fingerprint: 'f'.repeat(64),
    });
    expect(byUid.get(900)!.piiScrubbedAt).not.toBeNull();
    expect(byUid.get(901)).toMatchObject({
      fromAddress: 'max.mustermann@example.com',
      piiScrubbedAt: null,
    });
    const ignoredReceipt = receipts.find((r) => r.conversationMessageId === ignoredId)!;
    expect(ignoredReceipt).toMatchObject({ status: 'ignored', fromAddress: null, subject: null });
    const youngReceipt = receipts.find((r) => r.conversationMessageId === youngId)!;
    expect(youngReceipt.fromAddress).toBe('erika@example.net');
  });

  it('R13. IMAP-Dedupe nach der Bereinigung: gleiche UID nach Neustart (UID-Tripel), Kopie nach UIDVALIDITY-Wechsel bzw. in zweiter Mailbox (message_id_hash) und Mail ohne Message-ID (Fingerprint) ⇒ Duplikat, nichts neu angelegt', async () => {
    await adminSession(ctx);
    const withId = photoMail({ messageId: 'r13@example.net' });
    const withoutId = photoMail({ messageId: null, body: 'Ohne Message-ID, aber mit Date.' });
    ctx.inboundMail.add(withId);
    ctx.inboundMail.add(withoutId);
    const first = await processor().pollOnce();
    expect(first.outcomes.map((o) => o.result)).toEqual(['unmatched', 'unmatched']);
    const t0 = new Date('2026-02-01T08:00:00Z');
    for (const outcome of first.outcomes) await backdateInbound(outcome.conversationMessageId!, t0);
    const purged = await retention().purgeUnmatched(addBerlinCalendarDays(t0, 90));
    expect(purged.messages).toBe(2);

    // (a) Neustart vor dem Fortschreiben: dieselben UIDs werden erneut gelesen.
    await ctx.db
      .update(inboundMailState)
      .set({ lastUid: 0 })
      .where(eq(inboundMailState.mailbox, 'INBOX'));
    const again = await processor().pollOnce();
    expect(again.outcomes.map((o) => o.result)).toEqual(['duplicate', 'duplicate']);
    // (b) Mailbox neu aufgebaut (neue UIDVALIDITY): Message-ID-Hash bzw. Fingerprint.
    ctx.inboundMail.resetMailbox(2);
    ctx.inboundMail.add(withId);
    ctx.inboundMail.add(withoutId);
    const rebuilt = await processor().pollOnce();
    expect(rebuilt.outcomes.map((o) => o.result)).toEqual(['duplicate', 'duplicate']);
    // (c) Kopie in einer zweiten Mailbox.
    const archive = new FakeInboundMailSource('Archiv');
    archive.add(withId);
    archive.add(withoutId);
    const copied = await processor(archive).pollOnce('Archiv');
    expect(copied.outcomes.map((o) => o.result)).toEqual(['duplicate', 'duplicate']);

    expect(await ctx.db.select().from(conversationMessages)).toHaveLength(2);
    expect(await ctx.db.select().from(inboundMailReceipts)).toHaveLength(2);
    const photos = await ctx.db.select().from(messagePhotos);
    expect(photos).toHaveLength(2);
    expect(photos.every((p) => p.deletedAt !== null)).toBe(true);
  });

  it('R14. Message-ID nur als Hash: keine Klartextspalte, kein Klartext im Beleg; Hash = SHA-256 (hex, UTF-8) der normalisierten ID wie der Backfill der Migration 0024', async () => {
    await adminSession(ctx);
    const rawId = 'Mixed.Case-ÄÖ-1@Example.NET';
    ctx.inboundMail.add(photoMail({ messageId: rawId }));
    await processor().pollOnce();
    const [receipt] = await ctx.db.select().from(inboundMailReceipts);
    const sqlHash = await ctx.pool.query<{ h: string }>(
      "SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h",
      [rawId],
    );
    expect(receipt!.messageIdHash).toBe(sqlHash.rows[0]!.h);
    expect(receipt!.messageIdHash).toBe(inboundMessageIdHash(rawId));
    expect(JSON.stringify(receipt)).not.toContain('Mixed.Case');
    const columns = await ctx.pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'inbound_mail_receipts'",
    );
    expect(columns.rows.map((c) => c.column_name)).not.toContain('message_id');
    expect(columns.rows.map((c) => c.column_name)).toContain('message_id_hash');
  });

  it('R15. WhatsApp: unzugeordnete Nachricht nach 90 Tagen ohne Telefon/Name/wamid, Foto gelöscht; Kontakt ohne Kunde gelöscht, mit Kunde bleibt; whatsapp_events behalten nur IDs/Status (wamid gehasht)', async () => {
    const { admin } = await adminSession(ctx);
    const { customer } = await createCustomerWithProcess(ctx, admin.id);
    const t0 = new Date('2026-04-01T12:00:00Z');
    const wa = await chatMessage({
      processId: null,
      customerId: null,
      channel: 'whatsapp',
      subject: null,
      sender: { phone: WA_ID, name: 'Max WhatsApp' },
      providerMessageId: WAMID,
      body: '[Bild]',
      receivedAt: t0,
    });
    await ctx.db
      .update(conversationMessages)
      .set({ createdAt: t0 })
      .where(eq(conversationMessages.id, wa.message.id));
    await ctx.db.insert(whatsappContacts).values([
      {
        waId: WA_ID,
        customerId: null,
        lastInboundAt: t0,
        profileName: 'Max WhatsApp',
        updatedAt: t0,
      },
      {
        waId: '4915111111111',
        customerId: customer.id,
        lastInboundAt: t0,
        profileName: 'Kundin',
        updatedAt: t0,
      },
      { waId: '4915222222222', customerId: null, lastInboundAt: new Date(), profileName: 'Jung' },
    ]);
    const outboundKey = `outbound:${randomUUID()}`;
    await ctx.db.insert(whatsappEvents).values([
      {
        providerMessageId: WAMID,
        eventType: 'message',
        phoneNumberId: '100000000000001',
        status: 'processed',
        resultCode: 'unmatched',
        receivedAt: t0,
        processedAt: t0,
        conversationMessageId: wa.message.id,
      },
      {
        providerMessageId: WAMID,
        eventType: 'status:read',
        phoneNumberId: '100000000000001',
        status: 'processed',
        resultCode: 'read',
        receivedAt: t0,
      },
      {
        providerMessageId: outboundKey,
        eventType: 'send_result',
        phoneNumberId: 'self',
        status: 'processed',
        resultCode: 'SENT',
        receivedAt: t0,
      },
    ]);

    await retention().runBackstop(addBerlinCalendarDays(t0, 89), { textRetention: true });
    expect((await messageRow(wa.message.id)).piiScrubbedAt).toBeNull();
    expect(await ctx.db.select().from(whatsappContacts)).toHaveLength(3);

    const now = addBerlinCalendarDays(t0, 90);
    const result = await retention().runBackstop(now, { textRetention: true });
    expect(result.whatsapp).toEqual({
      contactsDeleted: 1,
      eventsHashed: 2,
      eventsDeduplicated: 0,
      mediaJobKeysHashed: 0,
    });
    expect(await messageRow(wa.message.id)).toMatchObject({
      body: '',
      senderSnapshot: {},
      providerMessageId: null,
    });
    expect((await photoRow(wa.photo!.id)).deletedAt).not.toBeNull();
    const contacts = await ctx.db.select().from(whatsappContacts);
    expect(contacts.map((c) => c.waId).sort()).toEqual(['4915111111111', '4915222222222']);
    const hashed = `sha256:${createHash('sha256').update(WAMID, 'utf8').digest('hex')}`;
    const events = await ctx.db.select().from(whatsappEvents);
    expect(
      events.map((e) => [e.providerMessageId, e.eventType, e.status, e.resultCode]).sort(),
    ).toEqual(
      [
        [hashed, 'message', 'processed', 'unmatched'],
        [hashed, 'status:read', 'processed', 'read'],
        [outboundKey, 'send_result', 'processed', 'SENT'],
      ].sort(),
    );
    expectNoPii(events, [WAMID, WA_ID]);
    // Verspätete Wiederholung desselben Ereignisses ⇒ beim nächsten Lauf entfernt (kein UNIQUE-Konflikt).
    await ctx.db.insert(whatsappEvents).values({
      providerMessageId: WAMID,
      eventType: 'status:read',
      phoneNumberId: '100000000000001',
      status: 'processed',
      resultCode: 'read',
      receivedAt: t0,
    });
    const next = await retention().purgeWhatsAppTechnical(now);
    expect(next).toEqual({
      contactsDeleted: 0,
      eventsHashed: 0,
      eventsDeduplicated: 1,
      mediaJobKeysHashed: 0,
    });
    expect(await ctx.db.select().from(whatsappEvents)).toHaveLength(3);
  });
});

describe('R15b. WhatsApp-Dedupe nach dem Hashing', () => {
  it('R15b. Verspätete Webhook-Wiederholung einer Nachricht bzw. eines Status, deren wamid nach 90 Tagen nur noch gehasht vorliegt ⇒ Duplikat: keine neue Konversationszeile, kein Kontakt, keine Klartext-Eventzeile', async () => {
    const t0 = new Date('2026-04-01T12:00:00Z');
    const now = addBerlinCalendarDays(t0, 90);
    const service = new WhatsAppWebhookService({
      db: ctx.db,
      config: ctx.config,
      queue: ctx.queue,
      conversations: new ConversationService(ctx.db, ctx.storage),
      now: () => t0,
    });
    const first = await service.process(
      whatsappMessagePayload({
        id: WAMID,
        from: WA_ID,
        text: 'Hallo',
        timestamp: t0.getTime() / 1000,
      }),
    );
    expect(first.messages.map((m) => m.result)).not.toContain('duplicate');
    await service.process(whatsappStatusPayload({ id: WAMID, status: 'read' }));
    const messagesBefore = await ctx.db.select().from(conversationMessages);
    expect(messagesBefore).toHaveLength(1);
    await ctx.db
      .update(conversationMessages)
      .set({ createdAt: t0 })
      .where(eq(conversationMessages.id, messagesBefore[0]!.id));

    const result = await retention().runBackstop(now, { textRetention: true });
    expect(result.whatsapp.eventsHashed).toBe(2);
    expect(result.whatsapp.contactsDeleted).toBe(1);

    const replayMessage = await service.process(
      whatsappMessagePayload({
        id: WAMID,
        from: WA_ID,
        text: 'Hallo',
        timestamp: t0.getTime() / 1000,
      }),
    );
    expect(replayMessage.messages.map((m) => m.result)).toEqual(['duplicate']);
    const replayStatus = await service.process(
      whatsappStatusPayload({ id: WAMID, status: 'read' }),
    );
    expect(replayStatus.statuses.map((st) => st.duplicate)).toEqual([true]);

    expect(await ctx.db.select().from(conversationMessages)).toHaveLength(1);
    expect(await ctx.db.select().from(whatsappContacts)).toHaveLength(0);
    const events = await ctx.db.select().from(whatsappEvents);
    expect(events).toHaveLength(2);
    expectNoPii(events, [WAMID, WA_ID]);
  });
});

// ── R16–R18: mail_deliveries ──────────────────────────────────────────────

describe('R16.–R18. mail_deliveries: Fristen, Scrub, kein Resend', () => {
  it('R16. Prozessgebunden: 12 Berliner Monate nach dem Terminal-Anker ⇒ Empfänger/Betreff/Kontext/Anhänge/In-Reply-To/Secret entfernt, Systemereignis minimiert, Audit-Rest bleibt; pending/retry/sending nie', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const statuses = [
      'sent',
      'failed',
      'blocked',
      'outcome_unknown',
      'pending',
      'retry',
      'sending',
    ] as const;
    const rows = new Map<string, MailDeliveryRow>();
    for (const status of statuses) {
      rows.set(
        status,
        await insertDelivery({ processId: process.id, customerId: customer.id, status }),
      );
    }
    const sent = rows.get('sent')!;
    const event = await conversations().recordOutboundSystemEvent({
      processId: process.id,
      customerId: customer.id,
      channel: 'email',
      kind: 'order_confirmation',
      subject: sent.subject,
      mailDeliveryId: sent.id,
    });
    expect(
      (await inject(cookie, 'POST', `/staff/processes/${process.id}/complete`)).statusCode,
    ).toBe(200);
    await drain();
    for (const status of statuses) {
      expect((await deliveryRow(rows.get(status)!.id)).retentionAnchorAt).not.toBeNull();
    }
    const anchor = new Date('2025-06-30T22:00:00Z'); // 01.07.2025 00:00 Berlin
    await setAnchor(process.id, anchor);
    const due = addBerlinCalendarMonths(anchor, 12);

    expect(
      (await retention().purgeExpiredDeliveries(new Date(due.getTime() - 60_000))).processBound,
    ).toBe(0);
    const result = await retention().purgeExpiredDeliveries(due);
    expect(result).toEqual({ processBound: 4, unbound: 0, systemEvents: 1 });
    for (const status of ['sent', 'failed', 'blocked', 'outcome_unknown'] as const) {
      const before = rows.get(status)!;
      const after = await deliveryRow(before.id);
      expect(after).toMatchObject({
        recipientEmail: null,
        recipientName: null,
        subject: null,
        context: {},
        attachments: [],
        inReplyToMessageId: null,
        secretPayloadCiphertext: null,
        // Audit-Rest
        id: before.id,
        kind: before.kind,
        processId: process.id,
        customerId: customer.id,
        status: before.status,
        idempotencyKey: before.idempotencyKey,
        messageId: before.messageId,
        attempts: before.attempts,
        providerCode: before.providerCode,
        lastErrorCode: before.lastErrorCode,
        blockedReason: before.blockedReason,
        templateKind: before.templateKind,
      });
      expect(after.sentAt?.toISOString()).toBe(before.sentAt?.toISOString());
      expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString());
      expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
      expect(after.piiScrubbedAt?.toISOString()).toBe(due.toISOString());
      expectNoPii(after, ['max.mustermann', 'Max', 'Auftragsbestätigung MR', 'kunde-1', 'geheim']);
    }
    for (const status of ['pending', 'retry', 'sending'] as const) {
      const after = await deliveryRow(rows.get(status)!.id);
      expect(after).toMatchObject({
        recipientEmail: 'max.mustermann@example.com',
        subject: 'Ihre Auftragsbestätigung MR-Test',
        secretPayloadCiphertext: 'v1:geheim-test-ciphertext',
        piiScrubbedAt: null,
      });
    }
    // Auch Jahre später: laufende Zustellungen werden nie bereinigt.
    await retention().purgeExpiredDeliveries(addBerlinCalendarMonths(due, 120));
    expect((await deliveryRow(rows.get('pending')!.id)).piiScrubbedAt).toBeNull();
    // Verknüpftes Systemereignis (Betreff steht dort) gleichermaßen minimiert.
    expect(await messageRow(event.id)).toMatchObject({
      body: '',
      subject: null,
      senderSnapshot: { role: 'staff' },
      isSystemEvent: true,
      mailDeliveryId: sent.id,
    });
  });

  it('R17. Nicht prozessgebunden: 90 Berliner Kalendertage nach Endzustand (sent ⇒ sent_at; failed/blocked/outcome_unknown ⇒ updated_at); pending/retry/sending nie', async () => {
    await adminSession(ctx);
    const t0 = new Date('2026-02-10T10:00:00Z');
    const later = addBerlinCalendarDays(t0, 50);
    const sent = await insertDelivery({
      processId: null,
      status: 'sent',
      kind: 'voucher_delivery',
      sentAt: t0,
      updatedAt: later,
    });
    const failed = await insertDelivery({ processId: null, status: 'failed', updatedAt: t0 });
    const unknown = await insertDelivery({
      processId: null,
      status: 'outcome_unknown',
      updatedAt: t0,
    });
    const blocked = await insertDelivery({
      processId: null,
      status: 'blocked',
      updatedAt: addBerlinCalendarDays(t0, 1),
    });
    const running = await Promise.all(
      (['pending', 'retry', 'sending'] as const).map((status) =>
        insertDelivery({ processId: null, status, updatedAt: t0 }),
      ),
    );
    const due = addBerlinCalendarDays(t0, 90);

    expect(
      (await retention().purgeExpiredDeliveries(new Date(due.getTime() - 60_000))).unbound,
    ).toBe(0);
    expect((await retention().purgeExpiredDeliveries(due)).unbound).toBe(3);
    for (const row of [sent, failed, unknown]) {
      expect(await deliveryRow(row.id)).toMatchObject({
        recipientEmail: null,
        subject: null,
        context: {},
      });
    }
    expect((await deliveryRow(blocked.id)).piiScrubbedAt).toBeNull();
    expect((await retention().purgeExpiredDeliveries(addBerlinCalendarDays(t0, 91))).unbound).toBe(
      1,
    );
    expect((await deliveryRow(blocked.id)).recipientEmail).toBeNull();
    await retention().purgeExpiredDeliveries(addBerlinCalendarMonths(t0, 240));
    for (const row of running) {
      expect(await deliveryRow(row.id)).toMatchObject({
        recipientEmail: 'max.mustermann@example.com',
        piiScrubbedAt: null,
      });
    }
  });

  it('R18. Nach dem Scrub kein Resend: Route 409, resendable=false + Platzhalter in Outbox-/Statuslisten; Send-Job ohne Empfänger blockiert und sendet nie', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const failed = await insertDelivery({
      processId: process.id,
      customerId: customer.id,
      status: 'failed',
      secret: false,
    });
    const listed = (await inject(cookie, 'GET', '/staff/communication/deliveries')).json() as {
      deliveries: { id: string; resendable: boolean; piiScrubbed: boolean }[];
    };
    expect(listed.deliveries.find((d) => d.id === failed.id)).toMatchObject({
      resendable: true,
      piiScrubbed: false,
    });
    expect(
      (await inject(cookie, 'POST', `/staff/processes/${process.id}/complete`)).statusCode,
    ).toBe(200);
    await drain();
    const anchor = new Date('2025-03-01T10:00:00Z');
    await setAnchor(process.id, anchor);
    await retention().purgeExpiredDeliveries(addBerlinCalendarMonths(anchor, 12));

    const list = (await inject(cookie, 'GET', '/staff/communication/deliveries')).json() as {
      deliveries: Record<string, unknown>[];
    };
    const summary = list.deliveries.find((d) => d.id === failed.id)!;
    expect(summary).toMatchObject({
      resendable: false,
      piiScrubbed: true,
      recipientEmail: '',
      subject: MAIL_DELIVERY_SCRUBBED_SUBJECT,
      status: 'failed',
    });
    expectNoPii(list, ['max.mustermann', 'Auftragsbestätigung MR']);
    const status = (
      await inject(cookie, 'GET', `/staff/processes/${process.id}/communication-status`)
    ).json() as { deliveries: Record<string, unknown>[] };
    expect(status.deliveries.find((d) => d.id === failed.id)).toMatchObject({
      resendable: false,
      subject: MAIL_DELIVERY_SCRUBBED_SUBJECT,
    });
    const outbox = (await inject(cookie, 'GET', '/staff/outbox')).json() as {
      deliveries: { id: string; recipient: string }[];
    };
    expect(outbox.deliveries.find((d) => d.id === failed.id)?.recipient).toBe('');
    const resend = await inject(
      cookie,
      'POST',
      `/staff/communication/deliveries/${failed.id}/resend`,
    );
    expect(resend.statusCode).toBe(409);
    expect(
      await ctx.db.select().from(mailDeliveries).where(eq(mailDeliveries.processId, process.id)),
    ).toHaveLength(1);

    // Send-Job: eine Zeile ohne Empfänger (NULL) wird blockiert, nie versendet.
    ctx.mailGateway.reset();
    const orphan = await insertDelivery({ processId: null, status: 'pending' });
    await ctx.db
      .update(mailDeliveries)
      .set({ recipientEmail: null })
      .where(eq(mailDeliveries.id, orphan.id));
    await ctx.communication.outbox.scheduleSend(orphan.id);
    await drain();
    expect(await deliveryRow(orphan.id)).toMatchObject({
      status: 'blocked',
      blockedReason: 'NO_RECIPIENT',
    });
    expect(ctx.mailGateway.attempts).toHaveLength(0);
  });
});

// ── R19–R20: Fachdaten unberührt, Idempotenz ──────────────────────────────

describe('R19.–R20. Fachbilder/Dokumente nie berührt; Idempotenz', () => {
  it('R19. Negativtest: Übergabe-/Rückgabe-/Schadens-/Defektfotos, Signaturen, Dokumente (inkl. unterschriebener Protokolle) und ihre Storage-Dateien bleiben bei allen Retention-Läufen unverändert – nur das Chatfoto wird gelöscht', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const world = await finalizedReturn(ctx, admin.id, cookie, {
      damages: [{ description: 'Kratzer am Gehäuse', severity: 'light' }],
      cleanupMachines: [0],
    });
    const chat = await chatMessage({ processId: world.processId, customerId: world.customerId });
    await drain();

    const tables = {
      documents: 'storage_key',
      handover_photos: 'storage_key',
      handover_signatures: 'storage_key',
      return_photos: 'storage_key',
      damage_photos: 'storage_key',
      return_signatures: 'storage_key',
      technical_defects: 'photo_storage_key',
    } as const;
    const snapshot = async () => {
      const out: Record<string, unknown[]> = {};
      const files: Record<string, string> = {};
      for (const [table, column] of Object.entries(tables)) {
        const rows = (await ctx.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows as Record<
          string,
          unknown
        >[];
        out[table] = rows;
        for (const row of rows) {
          const key = row[column];
          if (typeof key !== 'string') continue;
          expect(await ctx.storage.exists(key)).toBe(true);
          files[key] = createHash('sha256')
            .update(await ctx.storage.get(key))
            .digest('hex');
        }
      }
      return { rows: out, files };
    };
    const before = await snapshot();
    expect(before.rows.documents!.length).toBeGreaterThan(0);
    expect(before.rows.handover_photos!.length).toBeGreaterThan(0);
    expect(before.rows.handover_signatures!.length).toBeGreaterThan(0);
    expect(before.rows.return_photos!.length).toBeGreaterThan(0);
    expect(before.rows.damage_photos!.length).toBeGreaterThan(0);
    expect(before.rows.return_signatures!.length).toBeGreaterThan(0);

    expect(
      (await inject(cookie, 'POST', `/staff/processes/${world.processId}/complete`)).statusCode,
    ).toBe(200);
    await drain();
    await ctx.scan.runOnce(new Date());
    // Alle Fristen weit überschritten: jede Retention-Stufe läuft.
    const farFuture = addBerlinCalendarMonths(new Date(), 360);
    await retention().runBackstop(farFuture, { textRetention: true });
    await retention().runBackstop(farFuture, { textRetention: true });

    expect((await photoRow(chat.photo!.id)).deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(chat.photo!.storageKey)).toBe(false);
    expect((await messageRow(chat.message.id)).body).toBe('');
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  it('R20. Idempotenz: doppelter Terminal-Job, doppelter Tages-Backstop und Wiederholung am Folgetag ändern nichts mehr (Zeitstempel bleiben); Tages-Bucket-Schlüssel dedupliziert', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const chat = await chatMessage({ processId: process.id, customerId: customer.id });
    const delivery = await insertDelivery({
      processId: process.id,
      customerId: customer.id,
      status: 'sent',
    });
    const unmatched = await chatMessage({ processId: null, customerId: null });
    expect(
      (await inject(cookie, 'POST', `/staff/processes/${process.id}/complete`)).statusCode,
    ).toBe(200);
    await drain();
    const completedAt = (await processRow(process.id)).completedAt!;
    // Job-Wiederholung (at-least-once): kein weiterer Effekt. Review-Fund Reopen-Rennen:
    // der Terminal-Job arbeitet immer mit Snapshot-Semantik (früher Modus `current`).
    const repeat = await retention().runTerminalCleanup(process.id, completedAt);
    expect(repeat).toEqual({
      mode: 'snapshot',
      terminalAt: completedAt,
      anchors: { messages: 0, deliveries: 0 },
      deleted: 0,
      failed: 0,
    });
    const photoDeletedAt = (await photoRow(chat.photo!.id)).deletedAt!;

    const t0 = new Date('2025-02-01T10:00:00Z');
    await setAnchor(process.id, t0);
    await backdateInbound(unmatched.message.id, t0);
    const now = addBerlinCalendarMonths(t0, 13);
    const first = await retention().runBackstop(now, { textRetention: true });
    expect(first.text.purged).toBe(1);
    expect(first.deliveries.processBound).toBe(1);
    expect(first.unmatched.messages).toBe(1);
    const snapshot = async () => ({
      message: await messageRow(chat.message.id),
      unmatched: await messageRow(unmatched.message.id),
      delivery: await deliveryRow(delivery.id),
      photos: await ctx.db
        .select()
        .from(messagePhotos)
        .where(inArray(messagePhotos.messageId, [chat.message.id, unmatched.message.id])),
    });
    const afterFirst = await snapshot();
    for (const at of [now, addBerlinCalendarDays(now, 1)]) {
      const again = await retention().runBackstop(at, { textRetention: true });
      expect(again.text).toEqual({ processes: 0, purged: 0 });
      expect(again.deliveries).toEqual({ processBound: 0, unbound: 0, systemEvents: 0 });
      expect(again.unmatched).toEqual({
        messages: 0,
        receipts: 0,
        photosDeleted: 0,
        photosFailed: 0,
      });
      expect(again.photos).toMatchObject({ deleted: 0, failed: 0 });
      expect(again.anchors).toEqual({ messages: 0, deliveries: 0 });
    }
    expect(await snapshot()).toEqual(afterFirst);
    expect(afterFirst.message.piiScrubbedAt?.toISOString()).toBe(now.toISOString());
    expect((await photoRow(chat.photo!.id)).deletedAt?.toISOString()).toBe(
      photoDeletedAt.toISOString(),
    );

    // Tages-Bucket: ein Job je Berliner Kalendertag.
    const day = new Date('2027-03-28T00:30:00Z'); // 28.03.2027 01:30 Berlin (vor der Umstellung)
    expect(await enqueueDailyRetentionBackstop(ctx.queue, day)).toBe(true);
    expect(await enqueueDailyRetentionBackstop(ctx.queue, new Date('2027-03-28T21:00:00Z'))).toBe(
      false,
    );
    expect(await enqueueDailyRetentionBackstop(ctx.queue, new Date('2027-03-28T22:30:00Z'))).toBe(
      true,
    );
    const keys = (await retentionJobs()).map((job) => job.idempotencyKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        retentionBackstopJobKey('2027-03-28'),
        retentionBackstopJobKey('2027-03-29'),
      ]),
    );
    // Eigene Service-Instanz (z. B. zweiter Worker) arbeitet auf demselben Stand ⇒ ebenfalls no-op.
    const other = new RetentionCleanupService({ db: ctx.db, storage: ctx.storage });
    const parallel = await other.runBackstop(now, { textRetention: true });
    expect(
      parallel.text.purged + parallel.deliveries.processBound + parallel.unmatched.messages,
    ).toBe(0);
    // Kunde/Vorgang selbst bleiben unverändert.
    expect(
      (await ctx.db.select().from(customers).where(eq(customers.id, customer.id)))[0]!.email,
    ).toBe(customer.email);
  });
});

// ── R21–R29: reproduzierte Befunde des adversarialen Reviews ──────────────

/** Job-Zeile wie vom Runner beansprucht (direkter Handler-Aufruf mit Hook). */
function claimed(job: typeof integrationJobs.$inferSelect, attempts = 1): ClaimedJob {
  return {
    id: job.id,
    type: job.type,
    payload: job.payload,
    idempotencyKey: job.idempotencyKey,
    attempts,
    maxAttempts: job.maxAttempts,
    claimedBy: 'retention-final-test',
  };
}

const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

async function mediaJobs() {
  return ctx.db
    .select()
    .from(integrationJobs)
    .where(eq(integrationJobs.type, WHATSAPP_MEDIA_FETCH_JOB_TYPE));
}

describe('R21.–R22. WhatsApp-Media-Job-Key; Bezugszeitpunkt created_at', () => {
  it('R21. Media-Job-Schlüssel = Konversationszeilen-ID (nie die telefonabgeleitete wamid), auch im Duplikatpfad; Altschlüssel `whatsapp.media_fetch:<wamid>` älter als 90 Tage ⇒ `…:sha256:<hex>` (UNIQUE-Kollision ⇒ Job-ID-Suffix), jüngere Alt- und UUID-Schlüssel bleiben; idempotent', async () => {
    const service = new WhatsAppWebhookService({
      db: ctx.db,
      config: ctx.config,
      queue: ctx.queue,
      conversations: conversations(),
    });
    const image = whatsappMessagePayload({
      id: WAMID,
      from: WA_ID,
      type: 'image',
      mediaId: 'media-r21',
    });
    const first = await service.process(image);
    const messageId = first.messages[0]!.conversationMessageId!;
    expect(whatsappMediaFetchJobKey(messageId)).toBe(`whatsapp.media_fetch:${messageId}`);
    let jobs = await mediaJobs();
    expect(jobs.map((job) => [job.idempotencyKey, job.payload])).toEqual([
      [whatsappMediaFetchJobKey(messageId), { messageId, mediaId: 'media-r21' }],
    ]);
    expectNoPii(jobs, [WAMID, WA_ID]);

    // Duplikatpfad (`mediaFor`): Absturz nach Commit vor dem Einreihen ⇒ Metas
    // Wiederholung reiht mit DEMSELBEN Schlüssel nach; weitere Wiederholung dedupliziert.
    await ctx.db
      .delete(integrationJobs)
      .where(eq(integrationJobs.type, WHATSAPP_MEDIA_FETCH_JOB_TYPE));
    const replay = await service.process(image);
    expect(replay.messages.map((m) => m.result)).toEqual(['duplicate']);
    await service.process(image);
    jobs = await mediaJobs();
    expect(jobs.map((job) => job.idempotencyKey)).toEqual([whatsappMediaFetchJobKey(messageId)]);
    expect(await ctx.db.select().from(conversationMessages)).toHaveLength(1);

    // Altbestand vor der Umstellung (Schlüssel mit wamid).
    const t0 = new Date('2026-04-01T12:00:00Z');
    const now = addBerlinCalendarDays(t0, 90);
    const legacy = (key: string, createdAt: Date) => ({
      type: WHATSAPP_MEDIA_FETCH_JOB_TYPE,
      payload: { messageId: randomUUID(), mediaId: 'media-alt' },
      idempotencyKey: key,
      status: 'succeeded' as const,
      attempts: 1,
      createdAt,
      updatedAt: createdAt,
    });
    const uuidKey = `whatsapp.media_fetch:${randomUUID()}`;
    const collidingHash = `whatsapp.media_fetch:sha256:${sha256Hex('wamid.kollision-r21')}`;
    const inserted = await ctx.db
      .insert(integrationJobs)
      .values([
        legacy(`whatsapp.media_fetch:${WAMID}`, t0),
        legacy('whatsapp.media_fetch:wamid.jung-r21', addBerlinCalendarDays(t0, 1)),
        legacy(uuidKey, t0),
        legacy(collidingHash, t0),
        legacy('whatsapp.media_fetch:wamid.kollision-r21', t0),
      ])
      .returning({ id: integrationJobs.id, key: integrationJobs.idempotencyKey });
    const collidingId = inserted.find((row) => row.key.endsWith('wamid.kollision-r21'))!.id;

    expect(
      (await retention().purgeWhatsAppTechnical(addBerlinCalendarDays(t0, 89))).mediaJobKeysHashed,
    ).toBe(0);
    const result = await retention().purgeWhatsAppTechnical(now);
    expect(result.mediaJobKeysHashed).toBe(2);
    const keys = (await mediaJobs()).map((job) => job.idempotencyKey).sort();
    expect(keys).toEqual(
      [
        whatsappMediaFetchJobKey(messageId),
        `whatsapp.media_fetch:sha256:${sha256Hex(WAMID)}`,
        'whatsapp.media_fetch:wamid.jung-r21',
        uuidKey,
        collidingHash,
        `${collidingHash}:${collidingId}`,
      ].sort(),
    );
    expectNoPii(
      (await mediaJobs()).filter((job) => !job.idempotencyKey.endsWith('jung-r21')),
      [WAMID, WA_ID, 'kollision-r21'],
    );
    // Idempotent.
    expect((await retention().purgeWhatsAppTechnical(now)).mediaJobKeysHashed).toBe(0);
    // Jüngerer Altschlüssel: nach Ablauf seiner eigenen 90 Tage ebenfalls gehasht.
    expect(
      (await retention().purgeWhatsAppTechnical(addBerlinCalendarDays(t0, 91))).mediaJobKeysHashed,
    ).toBe(1);
    expectNoPii(await mediaJobs(), [WAMID, WA_ID, 'wamid.']);
  });

  it('R22. Zurückdatierter Date-Header (2001) verkürzt die 90-Tage-Frist nicht: heute unverändert, fällig erst 90 Berliner Kalendertage nach created_at (serverseitige Speicherung); ein Zukunfts-Header (2100) verlängert sie nicht', async () => {
    await adminSession(ctx);
    ctx.inboundMail.add(
      photoMail({ messageId: 'r22-alt@example.net', date: 'Mon, 01 Jan 2001 10:00:00 +0100' }),
    );
    ctx.inboundMail.add(
      photoMail({
        messageId: 'r22-zukunft@example.net',
        date: 'Fri, 01 Jan 2100 10:00:00 +0100',
        body: 'Zukunft',
      }),
    );
    const poll = await processor().pollOnce();
    expect(poll.outcomes.map((o) => o.result)).toEqual(['unmatched', 'unmatched']);
    const [oldId, futureId] = poll.outcomes.map((o) => o.conversationMessageId!);
    const old = await messageRow(oldId!);
    const future = await messageRow(futureId!);
    expect(old.receivedAt?.toISOString()).toBe('2001-01-01T09:00:00.000Z');
    expect(future.receivedAt?.toISOString()).toBe('2100-01-01T09:00:00.000Z');
    const [oldPhoto] = await ctx.db
      .select()
      .from(messagePhotos)
      .where(eq(messagePhotos.messageId, oldId!));

    // Heute: nichts bereinigt (der Header läge > 90 Tage zurück).
    expect(await retention().purgeUnmatched(new Date())).toEqual({
      messages: 0,
      receipts: 0,
      photosDeleted: 0,
      photosFailed: 0,
    });
    expect((await messageRow(oldId!)).body).toContain('0176');
    expect((await photoRow(oldPhoto!.id)).deletedAt).toBeNull();
    expect(await ctx.storage.exists(oldPhoto!.storageKey)).toBe(true);
    const receiptOf = async (id: string) =>
      (
        await ctx.db
          .select()
          .from(inboundMailReceipts)
          .where(eq(inboundMailReceipts.conversationMessageId, id))
      )[0]!;
    expect((await receiptOf(oldId!)).fromAddress).toBe('erika@example.net');

    // 90 Berliner Kalendertage nach created_at fällig (1 min davor nicht). +1 s: die
    // Kalenderrechnung ist sekundengenau, created_at trägt Sekundenbruchteile.
    const dueOld = new Date(addBerlinCalendarDays(old.createdAt, 90).getTime() + 1_000);
    await retention().purgeUnmatched(new Date(dueOld.getTime() - 60_000));
    expect((await messageRow(oldId!)).piiScrubbedAt).toBeNull();
    await retention().purgeUnmatched(dueOld);
    expect(await messageRow(oldId!)).toMatchObject({ body: '', subject: null, senderSnapshot: {} });
    expect((await photoRow(oldPhoto!.id)).deletedAt).not.toBeNull();
    expect(await receiptOf(oldId!)).toMatchObject({ fromAddress: null, subject: null });
    // Zukunfts-Header: ebenfalls 90 Tage nach created_at (nicht erst 2100).
    await retention().purgeUnmatched(
      new Date(addBerlinCalendarDays(future.createdAt, 90).getTime() + 1_000),
    );
    expect((await messageRow(futureId!)).piiScrubbedAt).not.toBeNull();
    expect((await receiptOf(futureId!)).piiScrubbedAt).not.toBeNull();
  });
});

describe('R23.–R25. Reopen-Rennen und Retry der Terminalphase', () => {
  it('R23. Terminal-Job mit Reopen + neuer Nachricht (mit Foto) + neuer Zustellung zwischen Auswahl und Wirkung ⇒ neue Zeilen behalten Anker NULL und ihr Foto; Daten der Terminalphase erhalten T und verlieren ihre Fotos (Snapshot-Semantik immer)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const before = await chatMessage({ processId: process.id, customerId: customer.id });
    const boundBefore = await insertDelivery({
      processId: process.id,
      customerId: customer.id,
      status: 'sent',
    });
    expect(
      (await inject(cookie, 'POST', `/staff/processes/${process.id}/complete`)).statusCode,
    ).toBe(200);
    const completedAt = (await processRow(process.id)).completedAt!;
    const raced: {
      late?: Awaited<ReturnType<typeof chatMessage>>;
      delivery?: MailDeliveryRow;
    } = {};
    class RacingRetention extends RetentionCleanupService {
      override async stampAnchorsForProcess(
        processId: string,
        anchorAt: Date,
        joinedBefore?: Date,
      ) {
        if (raced.late === undefined) {
          // Job hat begonnen (Vorgang noch abgeschlossen) – jetzt committet ein Reopen + neue Kommunikation.
          await processServiceFor(ctx).reopen(processId, admin.id);
          raced.late = await chatMessage({
            processId,
            customerId: customer.id,
            body: 'Direkt nach dem Reopen',
          });
          raced.delivery = await insertDelivery({
            processId,
            customerId: customer.id,
            status: 'sent',
          });
        }
        return super.stampAnchorsForProcess(processId, anchorAt, joinedBefore);
      }
    }
    const handler = createCleanupRetentionHandler({
      retention: new RacingRetention({ db: ctx.db, storage: ctx.storage }),
    });
    const [job] = await retentionJobs();
    await handler(claimed(job!));

    expect((await processRow(process.id)).mainStatus).toBe('reopened');
    expect((await messageRow(before.message.id)).retentionAnchorAt?.toISOString()).toBe(
      completedAt.toISOString(),
    );
    expect((await deliveryRow(boundBefore.id)).retentionAnchorAt?.toISOString()).toBe(
      completedAt.toISOString(),
    );
    expect((await photoRow(before.photo!.id)).deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(before.photo!.storageKey)).toBe(false);
    expect((await messageRow(raced.late!.message.id)).retentionAnchorAt).toBeNull();
    expect((await deliveryRow(raced.delivery!.id)).retentionAnchorAt).toBeNull();
    expect((await photoRow(raced.late!.photo!.id)).deletedAt).toBeNull();
    expect(await ctx.storage.exists(raced.late!.photo!.storageKey)).toBe(true);
    // Backstop ändert daran nichts (Vorgang offen).
    await retention().runFrequentBackstop();
    expect((await messageRow(raced.late!.message.id)).retentionAnchorAt).toBeNull();
    expect((await photoRow(raced.late!.photo!.id)).deletedAt).toBeNull();
  });

  it('R24. Backstop-Rennen: die Fotoauswahl je Vorgang prüft den Terminalzustand in derselben Anweisung – Reopen + neue Nachricht zwischen Vorgangsliste und Löschung ⇒ neues Foto bleibt; deletePhotosIfProcessTerminal löscht nach Reopen nichts, nach erneutem Abschluss sofort', async () => {
    const { admin } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const before = await chatMessage({ processId: process.id, customerId: customer.id });
    // Abschluss OHNE Listener (Einreihen gescheitert) ⇒ nur der Backstop wirkt.
    await processServiceFor(ctx).complete(process.id, adminVisibilityCtx());
    const raced: { late?: Awaited<ReturnType<typeof chatMessage>> } = {};
    class RacingConversations extends ConversationService {
      override async deleteChatPhotosForProcess(
        processId: string,
        options: { joinedBefore?: Date; onlyWhileTerminal?: boolean } = {},
      ) {
        if (raced.late === undefined) {
          await processServiceFor(ctx).reopen(processId, admin.id);
          raced.late = await chatMessage({ processId, customerId: customer.id, body: 'Neu' });
        }
        return super.deleteChatPhotosForProcess(processId, options);
      }
    }
    const racing = new RetentionCleanupService({
      db: ctx.db,
      storage: ctx.storage,
      conversations: new RacingConversations(ctx.db, ctx.storage),
    });
    expect(await racing.cleanupPhotosBackstop()).toEqual({ processes: 1, deleted: 0, failed: 0 });
    const late = raced.late!;
    expect((await photoRow(late.photo!.id)).deletedAt).toBeNull();
    expect(await ctx.storage.exists(late.photo!.storageKey)).toBe(true);
    // Dokumentiertes Restrisiko (Enqueue gescheitert + Reopen vor dem Backstop): das
    // Foto der Terminalphase bleibt bis zum nächsten Terminalzustand.
    expect((await photoRow(before.photo!.id)).deletedAt).toBeNull();

    // deletePhotosIfProcessTerminal: Terminalprüfung und Fotoauswahl in einer Anweisung.
    expect(await conversations().deletePhotosIfProcessTerminal(late.message.id)).toEqual({
      deleted: 0,
      failed: 0,
      errorCode: null,
    });
    await processServiceFor(ctx).complete(process.id, adminVisibilityCtx());
    expect(await conversations().deletePhotosIfProcessTerminal(late.message.id)).toEqual({
      deleted: 1,
      failed: 0,
      errorCode: null,
    });
    expect(await ctx.storage.exists(late.photo!.storageKey)).toBe(false);
    // Nächster Backstop (wieder terminal): restliches Foto der ersten Terminalphase.
    expect((await retention().runFrequentBackstop()).photos.deleted).toBe(1);
    expect((await photoRow(before.photo!.id)).deletedAt).not.toBeNull();
  });

  it('R25. Storage-Fehler im Terminal-Job ⇒ Job endet nach getaner Arbeit mit neutralem Fehler (Queue-Retry, Anker schon gesetzt); nach schnellem Reopen greift der Backstop nicht mehr – der Retry löscht das Foto der Terminalphase trotzdem (Snapshot), die neue Nachricht bleibt unberührt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const chat = await chatMessage({ processId: process.id, customerId: customer.id });
    expect(
      (await inject(cookie, 'POST', `/staff/processes/${process.id}/complete`)).statusCode,
    ).toBe(200);
    const completedAt = (await processRow(process.id)).completedAt!;
    const failing = vi
      .spyOn(ctx.storage, 'delete')
      .mockRejectedValue(new Error('S3 503 SlowDown max.mustermann@example.com'));
    try {
      await drain();
    } finally {
      failing.mockRestore();
    }
    const [job] = await retentionJobs();
    expect(job).toMatchObject({ status: 'pending', attempts: 1 });
    expect(job!.lastError).toContain('RetentionPhotoDeletePendingError');
    expect(job!.lastError).not.toContain('max.mustermann');
    expect((await messageRow(chat.message.id)).retentionAnchorAt?.toISOString()).toBe(
      completedAt.toISOString(),
    );
    expect((await photoRow(chat.photo!.id)).deletedAt).toBeNull();
    expect(await ctx.storage.exists(chat.photo!.storageKey)).toBe(true);

    // Schneller Reopen (vor dem nächsten 2-min-Backstop) + neue Kommunikation.
    expect((await inject(cookie, 'POST', `/staff/processes/${process.id}/reopen`)).statusCode).toBe(
      200,
    );
    const late = await chatMessage({ processId: process.id, customerId: customer.id, body: 'Neu' });
    expect((await retention().runFrequentBackstop()).photos.deleted).toBe(0);
    expect((await photoRow(chat.photo!.id)).deletedAt).toBeNull();

    // Queue-Retry nach Ablauf des Backoffs.
    await ctx.db
      .update(integrationJobs)
      .set({ runAt: new Date(Date.now() - 1_000) })
      .where(eq(integrationJobs.id, job!.id));
    await drain();
    expect((await retentionJobs())[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect((await photoRow(chat.photo!.id)).deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(chat.photo!.storageKey)).toBe(false);
    expect((await messageRow(late.message.id)).retentionAnchorAt).toBeNull();
    expect((await photoRow(late.photo!.id)).deletedAt).toBeNull();
    expect(await ctx.storage.exists(late.photo!.storageKey)).toBe(true);
  });
});

describe('R26.–R29. Rewrap, Purge-Rennen, Media-Job nach Reopen, scan_due', () => {
  it('R26. Schlüssel-Rewrap verschiebt die 90-Tage-Frist nicht: Neuverschlüsseln lässt updated_at unverändert (Bereinigung exakt 90 Tage nach dem Endzustand); die Blockierung bei nicht entschlüsselbarem Payload ist ein Statuswechsel und setzt updated_at', async () => {
    const cryptoFor = (key: string, previous: string | null = null) =>
      new PayloadCrypto({
        ...ctx.config,
        communication: { payloadKey: key, payloadKeyPrevious: previous },
      });
    const keyA = ctx.config.communication.payloadKey;
    const rotated = cryptoFor('rotated-communication-payload-key-R26-0123456789', keyA);
    const t0 = new Date('2026-02-10T10:00:00Z');
    const failed = await insertDelivery({ processId: null, status: 'failed', updatedAt: t0 });
    const pending = await insertDelivery({ processId: null, status: 'pending', updatedAt: t0 });
    await ctx.db
      .update(mailDeliveries)
      .set({
        secretPayloadCiphertext: cryptoFor(keyA).encrypt(
          '{"offerToken":"r26"}',
          'mail-secret-payload',
          failed.id,
        ),
      })
      .where(eq(mailDeliveries.id, failed.id));
    await ctx.db
      .update(mailDeliveries)
      .set({
        secretPayloadCiphertext: cryptoFor(
          'completely-foreign-communication-key-0123456789',
        ).encrypt('{"offerToken":"x"}', 'mail-secret-payload', pending.id),
      })
      .where(eq(mailDeliveries.id, pending.id));

    expect(await rewrapMailSecretPayloads(ctx.db, rotated)).toMatchObject({
      rewrapped: 1,
      undecryptable: 1,
    });
    const rewrapped = await deliveryRow(failed.id);
    expect(rotated.inspect(rewrapped.secretPayloadCiphertext!).current).toBe(true);
    expect(rewrapped.updatedAt.toISOString()).toBe(t0.toISOString());
    const blocked = await deliveryRow(pending.id);
    expect(blocked).toMatchObject({ status: 'blocked', blockedReason: 'SECRET_UNDECRYPTABLE' });
    expect(blocked.updatedAt.getTime()).toBeGreaterThan(t0.getTime());

    const due = addBerlinCalendarDays(t0, 90);
    expect(
      (await retention().purgeExpiredDeliveries(new Date(due.getTime() - 60_000))).unbound,
    ).toBe(0);
    expect((await retention().purgeExpiredDeliveries(due)).unbound).toBe(1);
    expect(await deliveryRow(failed.id)).toMatchObject({
      recipientEmail: null,
      secretPayloadCiphertext: null,
    });
    // Frisch blockiert ⇒ Frist läuft ab dem Statuswechsel.
    expect((await deliveryRow(pending.id)).piiScrubbedAt).toBeNull();
  });

  it('R27. Unzugeordnet-Purge: Zuordnung zwischen Auswahl und Wirkung ⇒ Nachricht, Foto und Beleg bleiben unberührt (process_id IS NULL bzw. Belegstatus in derselben Anweisung)', async () => {
    const { admin } = await adminSession(ctx);
    const { process } = await createCustomerWithProcess(ctx, admin.id);
    ctx.inboundMail.add(photoMail({ messageId: 'r27-a@example.net' }));
    ctx.inboundMail.add(photoMail({ messageId: 'r27-b@example.net', body: 'Zweite Mail.' }));
    const poll = await processor().pollOnce();
    expect(poll.outcomes.map((o) => o.result)).toEqual(['unmatched', 'unmatched']);
    const [aId, bId] = poll.outcomes.map((o) => o.conversationMessageId!) as [string, string];
    const t0 = new Date('2026-03-01T09:00:00Z');
    await backdateInbound(aId, t0);
    await backdateInbound(bId, t0);
    const photoOf = async (id: string) =>
      (await ctx.db.select().from(messagePhotos).where(eq(messagePhotos.messageId, id)))[0]!;
    const receiptOf = async (id: string) =>
      (
        await ctx.db
          .select()
          .from(inboundMailReceipts)
          .where(eq(inboundMailReceipts.conversationMessageId, id))
      )[0]!;
    const assign = (id: string) =>
      conversations().assignUnmatched(id, { processId: process.id, staffUserId: admin.id });
    const hooked = { photos: false, scrub: false };
    class RacingConversations extends ConversationService {
      override async deleteChatPhotosForMessages(
        ids: readonly string[],
        options: { onlyUnassigned?: boolean } = {},
      ) {
        if (!hooked.photos) {
          hooked.photos = true;
          await assign(aId); // zwischen Fotoauswahl und Löschung
        }
        return super.deleteChatPhotosForMessages(ids, options);
      }
      override async scrubMessages(
        ids: readonly string[],
        now: Date,
        mode: 'matched' | 'unmatched',
      ) {
        if (!hooked.scrub) {
          hooked.scrub = true;
          await assign(bId); // zwischen Textauswahl und Scrub
        }
        return super.scrubMessages(ids, now, mode);
      }
    }
    const racing = new RetentionCleanupService({
      db: ctx.db,
      storage: ctx.storage,
      conversations: new RacingConversations(ctx.db, ctx.storage),
    });
    const result = await racing.purgeUnmatched(addBerlinCalendarDays(t0, 90));
    expect(hooked).toEqual({ photos: true, scrub: true });
    // Nur B's Foto war bei der Löschung noch unzugeordnet + fällig.
    expect(result).toEqual({ messages: 0, receipts: 0, photosDeleted: 1, photosFailed: 0 });
    for (const id of [aId, bId]) {
      const row = await messageRow(id);
      expect(row.processId).toBe(process.id);
      expect(row.piiScrubbedAt).toBeNull();
      expect(row.senderSnapshot).toMatchObject({ email: 'erika@example.net' });
      expect(await receiptOf(id)).toMatchObject({
        status: 'matched',
        fromAddress: 'erika@example.net',
        piiScrubbedAt: null,
      });
    }
    expect((await messageRow(aId)).body).toContain('0176');
    expect((await messageRow(bId)).body).toContain('Zweite Mail.');
    const photoA = await photoOf(aId);
    expect(photoA.deletedAt).toBeNull();
    expect(await ctx.storage.exists(photoA.storageKey)).toBe(true);
    expect((await photoOf(bId)).deletedAt).not.toBeNull();
  });

  it('R28. whatsapp.media_fetch nach Abschluss + Reopen: Nachricht der Terminalphase (Anker gesetzt) ⇒ kein Laden/Speichern; neue Nachricht nach dem Reopen ⇒ gespeichert; Abschluss + Terminal-Job + Reopen WÄHREND des Downloads ⇒ Foto nicht registriert, Datei entfernt', async () => {
    const { admin } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    ctx.whatsapp.reset();
    ctx.whatsapp.media.set('media-r28', { mimeType: 'image/jpeg', bytes: new Uint8Array(JPEG) });
    const waMessage = () =>
      chatMessage({
        processId: process.id,
        customerId: customer.id,
        channel: 'whatsapp',
        subject: null,
        sender: { phone: WA_ID },
        providerMessageId: `wamid.r28.${randomUUID()}`,
        body: '[Bild]',
        photo: false,
      });
    const photosOf = (id: string) =>
      ctx.db.select().from(messagePhotos).where(eq(messagePhotos.messageId, id));
    const early = await waMessage();
    await processServiceFor(ctx).complete(process.id, adminVisibilityCtx());
    const completedAt = (await processRow(process.id)).completedAt!;
    await retention().runTerminalCleanup(process.id, completedAt);
    expect((await messageRow(early.message.id)).retentionAnchorAt?.toISOString()).toBe(
      completedAt.toISOString(),
    );
    // Media-Job war träge: läuft erst nach dem Reopen.
    await processServiceFor(ctx).reopen(process.id, admin.id);
    const late = await waMessage();
    for (const row of [early, late]) {
      await ctx.queue.enqueue(
        WHATSAPP_MEDIA_FETCH_JOB_TYPE,
        { messageId: row.message.id, mediaId: 'media-r28' },
        { idempotencyKey: whatsappMediaFetchJobKey(row.message.id), maxAttempts: 5 },
      );
    }
    await drain();
    expect(ctx.whatsapp.mediaCalls).toEqual(['media-r28']);
    expect(await photosOf(early.message.id)).toHaveLength(0);
    expect(await photosOf(late.message.id)).toHaveLength(1);

    // Rennen: Abschluss + Terminal-Job + Reopen während des Downloads.
    const during = await waMessage();
    const racingGateway: WhatsAppGateway = {
      kind: 'fake',
      sendText: (message) => ctx.whatsapp.sendText(message),
      fetchMedia: async (mediaId) => {
        await processServiceFor(ctx).complete(process.id, adminVisibilityCtx());
        const at = (await processRow(process.id)).completedAt!;
        await retention().runTerminalCleanup(process.id, at);
        await processServiceFor(ctx).reopen(process.id, admin.id);
        return ctx.whatsapp.fetchMedia(mediaId);
      },
    };
    const puts = vi.spyOn(ctx.storage, 'put');
    try {
      const handler = createWhatsAppMediaFetchHandler({
        db: ctx.db,
        storage: ctx.storage,
        gateway: racingGateway,
      });
      const job = (
        await ctx.queue.enqueue(
          WHATSAPP_MEDIA_FETCH_JOB_TYPE,
          { messageId: during.message.id, mediaId: 'media-r28' },
          { idempotencyKey: whatsappMediaFetchJobKey(during.message.id), maxAttempts: 5 },
        )
      ).jobId;
      const [row] = await ctx.db.select().from(integrationJobs).where(eq(integrationJobs.id, job));
      await handler(claimed(row!));
      expect(puts).toHaveBeenCalledTimes(1);
      const storedKey = puts.mock.calls[0]![0];
      expect(await ctx.storage.exists(storedKey)).toBe(false);
    } finally {
      puts.mockRestore();
    }
    expect((await messageRow(during.message.id)).retentionAnchorAt).not.toBeNull();
    expect(await photosOf(during.message.id)).toHaveLength(0);
  });

  it('R29. scan_due: wirft der 2-min-Retention-Backstop, wird der Tagesjob trotzdem eingereiht (eigener try/catch, neutrales Log nur mit Code)', async () => {
    class FailingRetention extends RetentionCleanupService {
      override async runFrequentBackstop(): Promise<never> {
        throw new Error('Verbindung weg: Musterweg 1, max.mustermann@example.com');
      }
    }
    const errors: { context: Record<string, unknown>; message: string }[] = [];
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: (context: Record<string, unknown>, message: string) => {
        errors.push({ context, message });
      },
    };
    const now = new Date('2026-10-19T08:00:00Z');
    const result = await runScanDue(
      {
        db: ctx.db,
        queue: ctx.queue,
        scanners: [],
        retention: new FailingRetention({ db: ctx.db, storage: ctx.storage }),
        logger,
        reenqueue: false,
      },
      now,
    );
    expect(result.retention).toEqual({ photosDeleted: 0, textJobEnqueued: true });
    expect((await retentionJobs()).map((job) => job.idempotencyKey)).toEqual([
      retentionBackstopJobKey(berlinDay(now)),
    ]);
    expect(errors).toEqual([
      {
        context: { scanner: 'retention_backstop', errorCode: 'Error' },
        message: 'communication.scan_due: Retention-Backstop fehlgeschlagen',
      },
    ]);
    expectNoPii(errors, ['Musterweg', 'max.mustermann']);
  });
});

describe('R30.–R31. Review Runde 2', () => {
  it('R30. whatsapp.media_fetch: Vorgang wird während des Downloads terminal UND das Löschen der schon gespeicherten Datei scheitert ⇒ Job wirft (Retry); der Retry entfernt die Datei über den deterministischen Schlüssel, keine Fotozeile, keine verwaiste Datei', async () => {
    const { admin } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    ctx.whatsapp.reset();
    ctx.whatsapp.media.set('media-r30', { mimeType: 'image/jpeg', bytes: new Uint8Array(JPEG) });
    const during = await chatMessage({
      processId: process.id,
      customerId: customer.id,
      channel: 'whatsapp',
      subject: null,
      sender: { phone: WA_ID },
      providerMessageId: `wamid.r30.${randomUUID()}`,
      body: '[Bild]',
      photo: false,
    });
    const racingGateway: WhatsAppGateway = {
      kind: 'fake',
      sendText: (message) => ctx.whatsapp.sendText(message),
      fetchMedia: async (mediaId) => {
        await processServiceFor(ctx).complete(process.id, adminVisibilityCtx());
        const at = (await processRow(process.id)).completedAt!;
        await retention().runTerminalCleanup(process.id, at);
        return ctx.whatsapp.fetchMedia(mediaId);
      },
    };
    const handler = createWhatsAppMediaFetchHandler({
      db: ctx.db,
      storage: ctx.storage,
      gateway: racingGateway,
    });
    const job = (
      await ctx.queue.enqueue(
        WHATSAPP_MEDIA_FETCH_JOB_TYPE,
        { messageId: during.message.id, mediaId: 'media-r30' },
        { idempotencyKey: whatsappMediaFetchJobKey(during.message.id), maxAttempts: 5 },
      )
    ).jobId;
    const [row] = await ctx.db.select().from(integrationJobs).where(eq(integrationJobs.id, job));
    const key = whatsappMediaStorageKey(during.message.id, 'jpg');
    const deletes = vi.spyOn(ctx.storage, 'delete').mockRejectedValueOnce(new Error('S3 503'));
    try {
      await expect(handler(claimed(row!))).rejects.toThrow('S3 503');
    } finally {
      deletes.mockRestore();
    }
    expect(await ctx.storage.exists(key)).toBe(true); // noch da – aber wiederauffindbar
    expect(
      await ctx.db
        .select()
        .from(messagePhotos)
        .where(eq(messagePhotos.messageId, during.message.id)),
    ).toHaveLength(0);
    // Queue-Retry: Nachricht ist blockiert (Anker) ⇒ kein Download, Datei entfernt.
    await handler(claimed(row!));
    expect(await ctx.storage.exists(key)).toBe(false);
    expect(ctx.whatsapp.mediaCalls).toEqual(['media-r30']);
    expect(
      await ctx.db
        .select()
        .from(messagePhotos)
        .where(eq(messagePhotos.messageId, during.message.id)),
    ).toHaveLength(0);
  });

  it('R31. Abbruch zwischen Nachrichten- und Beleg-Minimierung ⇒ beides zurückgerollt (eine Transaktion); der nächste Lauf minimiert Nachricht UND zugeordneten Beleg', async () => {
    const { admin } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const matched = await chatMessage({
      processId: process.id,
      customerId: customer.id,
      photo: false,
    });
    await ctx.db.insert(inboundMailReceipts).values({
      mailbox: 'INBOX',
      uidValidity: '1',
      uid: 931,
      fingerprint: 'd'.repeat(64),
      fromAddress: 'max.mustermann@example.com',
      subject: 'Zugeordnet R31',
      receivedAt: new Date(),
      status: 'matched',
      matchReason: 'in_reply_to',
      conversationMessageId: matched.message.id,
    });
    await ctx.pool.query(`CREATE OR REPLACE FUNCTION zz_r31_fail() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'r31 abort'; END; $$ LANGUAGE plpgsql`);
    await ctx.pool.query(`CREATE TRIGGER zz_r31_fail BEFORE UPDATE ON inbound_mail_receipts
      FOR EACH ROW WHEN (NEW.pii_scrubbed_at IS NOT NULL) EXECUTE FUNCTION zz_r31_fail()`);
    const now = new Date();
    try {
      await expect(
        conversations().scrubMessages([matched.message.id], now, 'matched'),
      ).rejects.toThrow();
    } finally {
      await ctx.pool.query('DROP TRIGGER IF EXISTS zz_r31_fail ON inbound_mail_receipts');
      await ctx.pool.query('DROP FUNCTION IF EXISTS zz_r31_fail()');
    }
    expect((await messageRow(matched.message.id)).piiScrubbedAt).toBeNull();
    const result = await conversations().scrubMessages([matched.message.id], now, 'matched');
    expect(result).toEqual({ scrubbed: 1, receipts: 1 });
    const [receipt] = await ctx.db
      .select()
      .from(inboundMailReceipts)
      .where(eq(inboundMailReceipts.conversationMessageId, matched.message.id));
    expect(receipt).toMatchObject({ fromAddress: null, subject: null });
    expect(receipt!.piiScrubbedAt).not.toBeNull();
  });
});
