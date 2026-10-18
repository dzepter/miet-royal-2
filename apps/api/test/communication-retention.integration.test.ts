/**
 * Phase 12 – RETENTION (Pflichttests 93–96, Order §25/§42): Chatfotos bei
 * Vorgangsabschluss löschen (Listener ⇒ Job), Fach-/Dokumentdaten bleiben,
 * Chattext 12 Kalendermonate nach Abschluss leeren (Backstop), Reopen.
 */
import { conversationMessages, documents, messagePhotos, processes } from '@mietroyal/database';
import { addBerlinCalendarMonths } from '@mietroyal/domain';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DocumentService } from '../src/commerce/document-service.ts';
import {
  ConversationService,
  photoStorageKey,
} from '../src/communication/conversation/conversation-service.ts';
import {
  retentionBackstopJobKey,
  retentionPhotosJobKey,
} from '../src/communication/retention/cleanup.ts';
import { COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE } from '../src/communication/types.ts';
import { integrationJobs } from '@mietroyal/database';
import {
  createTestContext,
  destroyTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { createCustomerWithProcess, truncateCommunicationTables } from './communication-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import { adminSession } from './settlement-helpers.ts';

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
  await truncateCommerceTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
});

const conversations = () => new ConversationService(ctx.db, ctx.storage);

async function messageWithPhoto(
  processId: string,
  customerId: string,
  body = 'Hallo, hier ein Foto',
) {
  const message = await conversations().createInbound({
    processId,
    customerId,
    channel: 'email',
    sender: { email: 'kunde@example.org' },
    subject: 'Foto',
    body,
    providerMessageId: null,
    replyToProviderMessageId: null,
    receivedAt: new Date(),
  });
  const key = photoStorageKey(message.id, 'jpg');
  await ctx.storage.put(key, new Uint8Array(JPEG), { contentType: 'image/jpeg' });
  const photo = await conversations().registerPhoto({
    messageId: message.id,
    storageKey: key,
    mimeType: 'image/jpeg',
    byteSize: JPEG.length,
    sha256: 'x'.repeat(64),
  });
  return { message, photoId: photo.id, storageKey: key };
}

async function photoRow(id: string) {
  return (await ctx.db.select().from(messagePhotos).where(eq(messagePhotos.id, id)))[0]!;
}

async function messageRow(id: string) {
  return (
    await ctx.db.select().from(conversationMessages).where(eq(conversationMessages.id, id))
  )[0]!;
}

async function drain(): Promise<void> {
  for (let i = 0; i < 50; i += 1) if ((await ctx.jobs.runOnce()) === 'idle') break;
}

async function completeViaRoute(cookie: string, processId: string): Promise<number> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: `/staff/processes/${processId}/complete`,
    headers: { cookie },
  });
  return response.statusCode;
}

describe('93.–94. Abschluss-Löschung der Chatfotos; Fachdaten bleiben', () => {
  it('93. Vorgangsabschluss ⇒ Job communication.cleanup_retention ⇒ Chatfotos gelöscht (Storage + deletedAt); Chattext bleibt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const a = await messageWithPhoto(process.id, customer.id);
    const b = await messageWithPhoto(process.id, customer.id, 'zweites Foto');
    expect(await ctx.storage.exists(a.storageKey)).toBe(true);

    expect(await completeViaRoute(cookie, process.id)).toBe(200);
    const completed = (
      await ctx.db.select().from(processes).where(eq(processes.id, process.id))
    )[0]!;
    const jobs = await ctx.db
      .select()
      .from(integrationJobs)
      .where(eq(integrationJobs.type, COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.idempotencyKey).toBe(retentionPhotosJobKey(process.id, completed.completedAt!));
    // Vor dem Job: noch vorhanden (Löschung läuft außerhalb der Abschluss-Transaktion).
    expect((await photoRow(a.photoId)).deletedAt).toBeNull();

    await drain();
    expect((await photoRow(a.photoId)).deletedAt).not.toBeNull();
    expect((await photoRow(b.photoId)).deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(a.storageKey)).toBe(false);
    expect(await ctx.storage.exists(b.storageKey)).toBe(false);
    // Text bleibt (12-Monats-Frist läuft erst), Foto-Zeile bleibt als Marker.
    expect((await messageRow(a.message.id)).body).toBe('Hallo, hier ein Foto');
    expect((await messageRow(a.message.id)).bodyDeletedAt).toBeNull();
    // Wiederholter Job-Lauf ist ein No-op (idempotent).
    await ctx.scan.retention.cleanupPhotosForProcess(process.id);
    expect(await ctx.db.select().from(messagePhotos)).toHaveLength(2);
  });

  it('94. Nur Kommunikationsfotos: Dokumente und Fotos offener Vorgänge bleiben unangetastet', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const other = await createCustomerWithProcess(ctx, admin.id, { email: 'andere@example.org' });
    const chat = await messageWithPhoto(process.id, customer.id);
    const openChat = await messageWithPhoto(other.process.id, other.customer.id);
    const docs = new DocumentService(ctx.db, ctx.storage);
    const document = await docs.createFinalDocument({
      type: 'offer',
      processId: process.id,
      storageKey: `documents/${process.id}/angebot.pdf`,
      bytes: Buffer.from('%PDF-1.4 test'),
    });
    // Fremdes Fachfoto (z. B. Rückgabe) liegt unter einem anderen Präfix im selben Storage.
    const foreignKey = `returns/${process.id}/machine-1/foto.jpg`;
    await ctx.storage.put(foreignKey, new Uint8Array(JPEG), { contentType: 'image/jpeg' });

    expect(await completeViaRoute(cookie, process.id)).toBe(200);
    await drain();
    await ctx.scan.retention.runBackstop(new Date(), { textRetention: true });

    expect((await photoRow(chat.photoId)).deletedAt).not.toBeNull();
    expect((await photoRow(openChat.photoId)).deletedAt).toBeNull();
    expect(await ctx.storage.exists(openChat.storageKey)).toBe(true);
    expect(await ctx.storage.exists(document.storageKey)).toBe(true);
    expect(await ctx.storage.exists(foreignKey)).toBe(true);
    const docRows = await ctx.db.select().from(documents).where(eq(documents.id, document.id));
    expect(docRows).toHaveLength(1);
    expect(docRows[0]!.sha256).toBe(document.sha256);
  });
});

describe('95.–96. 12-Monats-Text-Retention und Reopen', () => {
  it('95. Chattext wird 12 Kalendermonate (Berlin) nach Abschluss geleert; jüngere Abschlüsse und offene Vorgänge nicht', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const old = await createCustomerWithProcess(ctx, admin.id, { email: 'alt@example.org' });
    const recent = await createCustomerWithProcess(ctx, admin.id, { email: 'neu@example.org' });
    const open = await createCustomerWithProcess(ctx, admin.id, { email: 'offen@example.org' });
    const oldMsg = await messageWithPhoto(old.process.id, old.customer.id, 'alter Text');
    const recentMsg = await messageWithPhoto(recent.process.id, recent.customer.id, 'neuer Text');
    const openMsg = await messageWithPhoto(open.process.id, open.customer.id, 'offener Text');
    expect(await completeViaRoute(cookie, old.process.id)).toBe(200);
    expect(await completeViaRoute(cookie, recent.process.id)).toBe(200);
    await drain();
    const now = new Date('2027-06-15T10:00:00.000Z');
    await ctx.db
      .update(processes)
      .set({ completedAt: addBerlinCalendarMonths(now, -12) }) // exakt 12 Monate ⇒ fällig
      .where(eq(processes.id, old.process.id));
    await ctx.db
      .update(processes)
      .set({ completedAt: new Date(addBerlinCalendarMonths(now, -12).getTime() + 60_000) })
      .where(eq(processes.id, recent.process.id));
    // Offener Vorgang mit uraltem (unplausiblem) completedAt-Rest darf nie geleert werden.
    await ctx.db
      .update(processes)
      .set({ completedAt: new Date('2020-01-01T00:00:00.000Z') })
      .where(eq(processes.id, open.process.id));

    const result = await ctx.scan.retention.runBackstop(now, { textRetention: true });
    expect(result.text.processes).toBe(1);
    expect(result.text.purged).toBe(1);
    const purged = await messageRow(oldMsg.message.id);
    expect(purged.body).toBe('');
    expect(purged.subject).toBeNull();
    expect(purged.bodyDeletedAt).not.toBeNull();
    expect((await messageRow(recentMsg.message.id)).body).toBe('neuer Text');
    expect((await messageRow(openMsg.message.id)).body).toBe('offener Text');
    // Idempotent: zweiter Lauf leert nichts erneut.
    const again = await ctx.scan.retention.runBackstop(now, { textRetention: true });
    expect(again.text.purged).toBe(0);
    // Ohne Text-Retention (nicht-täglicher Lauf) bleibt Text unberührt.
    const silent = await ctx.scan.retention.runBackstop(now, { textRetention: false });
    expect(silent.text).toEqual({ processes: 0, purged: 0 });
    expect(retentionBackstopJobKey('2027-06-15')).toBe(
      'communication.cleanup_retention:2027-06-15',
    );
  });

  it('96. Reopen: alte Löschungen bleiben, neue Kommunikation läuft normal; erneuter Abschluss räumt neue Fotos (neuer Job-Schlüssel)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const first = await messageWithPhoto(process.id, customer.id, 'vor Abschluss');
    expect(await completeViaRoute(cookie, process.id)).toBe(200);
    await drain();
    expect((await photoRow(first.photoId)).deletedAt).not.toBeNull();

    const reopen = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/reopen`,
      headers: { cookie },
    });
    expect(reopen.statusCode).toBe(200);
    const second = await messageWithPhoto(process.id, customer.id, 'nach Reopen');
    // Backstop (wie der 2-min-Scan): wieder geöffneter Vorgang ist nicht „abgeschlossen“ ⇒ neues Foto bleibt.
    await ctx.scan.retention.runBackstop(new Date(), { textRetention: true });
    expect((await photoRow(second.photoId)).deletedAt).toBeNull();
    expect(await ctx.storage.exists(second.storageKey)).toBe(true);
    expect((await messageRow(second.message.id)).body).toBe('nach Reopen');
    expect((await messageRow(first.message.id)).body).toBe('vor Abschluss');
    // Konversation des Vorgangs zeigt beide Nachrichten (neue Kommunikation läuft normal).
    const list = await conversations().listForProcess(process.id);
    expect(list).toHaveLength(2);

    expect(await completeViaRoute(cookie, process.id)).toBe(200);
    const jobs = await ctx.db
      .select()
      .from(integrationJobs)
      .where(eq(integrationJobs.type, COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE));
    expect(jobs).toHaveLength(2); // zwei Abschlüsse ⇒ zwei Schlüssel (completedAt im Key)
    await drain();
    expect((await photoRow(second.photoId)).deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(second.storageKey)).toBe(false);
    // Alte Zeile unverändert (kein erneutes Löschen nötig).
    const firstAfter = await photoRow(first.photoId);
    expect(firstAfter.deletedAt).not.toBeNull();
  });
});
