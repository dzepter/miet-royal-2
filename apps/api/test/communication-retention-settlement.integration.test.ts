/**
 * Phase 12 – RETENTION (Pflichttest 93, Order §25) für den HÄUFIGSTEN
 * Abschlussweg: Der Vorgang wird nicht über „Vorgang abschließen“ (CRM),
 * sondern durch den Buchhaltungs-Transfer der Abrechnung abgeschlossen –
 * automatisch im Job `settlement.accounting_transfer` oder manuell über
 * `POST /staff/settlements/:id/transfer`. Auch dann reiht der Abschluss
 * SOFORT den Foto-Retention-Job ein (vorher nur über den scan_due-Backstop;
 * aufgedeckt durch E2E-Szenario S, communication-ops.spec.ts).
 */
import {
  conversationMessages,
  documents,
  integrationJobs,
  messagePhotos,
  processes,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConversationService,
  photoStorageKey,
} from '../src/communication/conversation/conversation-service.ts';
import { retentionPhotosJobKey } from '../src/communication/retention/cleanup.ts';
import { COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE } from '../src/communication/types.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { truncateCommunicationTables } from './communication-helpers.ts';
import { adminSession, post, resetSettlementWorld, settledReturn } from './settlement-helpers.ts';

let ctx: TestContext;
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 0xff, 0xd9,
]);

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateCommunicationTables(ctx.pool);
  await resetSettlementWorld(ctx);
});

async function drain(): Promise<void> {
  for (let i = 0; i < 50; i += 1) if ((await ctx.jobs.runOnce()) === 'idle') break;
}

async function processRow(processId: string) {
  return (await ctx.db.select().from(processes).where(eq(processes.id, processId)))[0]!;
}

/** Eingehende Kundennachricht mit Chatfoto am Vorgang (wie der IMAP-/WhatsApp-Eingang). */
async function chatPhoto(processId: string) {
  const conversations = new ConversationService(ctx.db, ctx.storage);
  const process = await processRow(processId);
  const message = await conversations.createInbound({
    processId,
    customerId: process.customerId,
    channel: 'email',
    sender: { email: 'kunde@example.org' },
    subject: 'Foto vom Kratzer',
    body: 'Hallo, anbei ein Foto.',
    providerMessageId: null,
    replyToProviderMessageId: null,
    receivedAt: new Date(),
  });
  const storageKey = photoStorageKey(message.id, 'jpg');
  await ctx.storage.put(storageKey, new Uint8Array(JPEG), { contentType: 'image/jpeg' });
  const photo = await conversations.registerPhoto({
    messageId: message.id,
    storageKey,
    mimeType: 'image/jpeg',
    byteSize: JPEG.length,
    sha256: 'a'.repeat(64),
  });
  return { messageId: message.id, photoId: photo.id, storageKey };
}

async function expectRetentionJobFor(processId: string) {
  const completedAt = (await processRow(processId)).completedAt;
  expect(completedAt).not.toBeNull();
  const jobs = await ctx.db
    .select()
    .from(integrationJobs)
    .where(eq(integrationJobs.type, COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE));
  expect(jobs.map((job) => job.idempotencyKey)).toEqual([
    retentionPhotosJobKey(processId, completedAt!),
  ]);
}

async function expectPhotoDeletedDocumentsKept(
  processId: string,
  chat: { messageId: string; photoId: string; storageKey: string },
) {
  const photo = (
    await ctx.db.select().from(messagePhotos).where(eq(messagePhotos.id, chat.photoId))
  )[0]!;
  expect(photo.deletedAt).not.toBeNull();
  expect(await ctx.storage.exists(chat.storageKey)).toBe(false);
  // Chattext bleibt (12-Monats-Frist), Fachdokumente (Übergabe/Rückgabe) bleiben.
  const message = (
    await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, chat.messageId))
  )[0]!;
  expect(message.body).toBe('Hallo, anbei ein Foto.');
  const docs = await ctx.db.select().from(documents).where(eq(documents.processId, processId));
  expect(docs.length).toBeGreaterThan(0);
  for (const doc of docs) expect(await ctx.storage.exists(doc.storageKey)).toBe(true);
}

describe('93. Chatfoto-Löschung bei Abschluss über den Abrechnungs-Transfer', () => {
  it('93. (Transfer-Job) Auto-Transfer schließt den Vorgang ab ⇒ Foto-Retention-Job sofort eingereiht ⇒ Chatfoto gelöscht, Dokumente bleiben – ohne scan_due-Backstop', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world } = await settledReturn(ctx, admin.id, cookie);
    const chat = await chatPhoto(world.processId);

    await drain();
    expect((await processRow(world.processId)).mainStatus).toBe('completed');
    await expectRetentionJobFor(world.processId);
    // Kein scan_due-Lauf beteiligt (der Backstop ist hier nicht eingereiht).
    const scans = await ctx.db
      .select()
      .from(integrationJobs)
      .where(eq(integrationJobs.type, 'communication.scan_due'));
    expect(scans).toHaveLength(0);
    await expectPhotoDeletedDocumentsKept(world.processId, chat);
  });

  it('93. (manueller Transfer) POST /staff/settlements/:id/transfer schließt den Vorgang ab ⇒ Foto-Retention-Job sofort eingereiht ⇒ Chatfoto gelöscht', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    const chat = await chatPhoto(world.processId);

    const transfer = await post(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/transfer`,
      {
        version: view.settlement.version,
      },
    );
    expect(transfer.status).toBe(200);
    expect((await processRow(world.processId)).mainStatus).toBe('completed');
    await expectRetentionJobFor(world.processId);
    const photoBefore = (
      await ctx.db.select().from(messagePhotos).where(eq(messagePhotos.id, chat.photoId))
    )[0]!;
    expect(photoBefore.deletedAt).toBeNull();

    await drain();
    await expectPhotoDeletedDocumentsKept(world.processId, chat);
  });
});
