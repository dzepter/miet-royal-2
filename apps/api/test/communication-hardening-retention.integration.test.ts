/**
 * Phase 12 Härtung (Review B) – Retention der Vorgangs-Kommunikation:
 * Regressionstest zum Fund
 *  B15 Storage-Löschfehler wird nicht mehr verschluckt: die Foto-Zeile bleibt
 *      offen (kein deletedAt), der Backstop löscht beim nächsten Lauf,
 * sowie der geprüfte Punkt ohne Fund OK-5 (12-Monats-Grenze in Europe/Berlin).
 *
 * Hinweis (offene Fachregeln, bewusst NICHT umgesetzt/getestet): Review B
 * hat festgestellt, dass für Chatfotos/-texte STORNIERTER Vorgänge (B8) und
 * für unzugeordnete bzw. ignorierte Nachrichten ohne Vorgang (B9) keine
 * Retention greift. Order §25 regelt nur „Vorgangsabschluss“; Frist und
 * Bezugszeitpunkt für Storno/unzugeordnet sind fachlich nicht definiert ⇒
 * offene Punkte im Abschlussbericht, keine geratene Regel im Code.
 */
import { conversationMessages, messagePhotos, processes } from '@mietroyal/database';
import { StorageObjectNotFoundError, type StorageProvider } from '@mietroyal/integrations';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ConversationService,
  photoStorageKey,
} from '../src/communication/conversation/conversation-service.ts';
import { RetentionCleanupService } from '../src/communication/retention/cleanup.ts';
import {
  createTestContext,
  destroyTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { createCustomerWithProcess, truncateCommunicationTables } from './communication-helpers.ts';
import { adminVisibilityCtx, processServiceFor, truncateCrmTables } from './crm-helpers.ts';
import { adminSession } from './settlement-helpers.ts';

let ctx: TestContext;
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 0xff, 0xd9,
]);

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await truncateCommunicationTables(ctx.pool);
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateCommunicationTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
});

const conversations = () => new ConversationService(ctx.db, ctx.storage);

async function messageWithPhoto(processId: string | null, customerId: string | null) {
  const message = await conversations().createInbound({
    processId,
    customerId,
    channel: 'whatsapp',
    sender: { phone: '4917612345678', name: 'Max Mustermann' },
    subject: null,
    body: 'Privater Chattext mit Adresse Musterweg 1',
    providerMessageId: `wamid.${Math.random()}`,
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

const photoRow = async (id: string) =>
  (await ctx.db.select().from(messagePhotos).where(eq(messagePhotos.id, id)))[0]!;
const messageRow = async (id: string) =>
  (await ctx.db.select().from(conversationMessages).where(eq(conversationMessages.id, id)))[0]!;

describe('Härtung Review B – Retention', () => {
  it('B15. Storage-Löschfehler ⇒ Foto-Zeile bleibt offen (kein deletedAt), Fehler wird gezählt; der Backstop löscht nach Erholung des Storage; ein bereits fehlendes Objekt gilt als gelöscht', async () => {
    const { admin } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const chat = await messageWithPhoto(process.id, customer.id);
    const gone = await messageWithPhoto(process.id, customer.id);
    await processServiceFor(ctx).complete(process.id, adminVisibilityCtx());
    // S3/FS vorübergehend nicht erreichbar: delete wirft – außer für das bereits fehlende Objekt.
    const flaky: StorageProvider = {
      put: (key, data, options) => ctx.storage.put(key, data, options),
      get: (key) => ctx.storage.get(key),
      exists: (key) => ctx.storage.exists(key),
      delete: async (key) => {
        if (key === gone.storageKey) throw new StorageObjectNotFoundError(key);
        throw new Error('S3 503 SlowDown');
      },
    };
    const retention = new RetentionCleanupService({ db: ctx.db, storage: flaky });
    const result = await retention.cleanupPhotosForProcess(process.id);
    expect(result).toEqual({ deleted: 1, failed: 1 });
    expect((await photoRow(chat.photoId)).deletedAt).toBeNull();
    expect((await photoRow(gone.photoId)).deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(chat.storageKey)).toBe(true);

    // Später (Storage wieder gesund): Backstop findet die offene Zeile und löscht.
    const later = await ctx.scan.retention.runBackstop(new Date(), { textRetention: false });
    expect(later.photos).toMatchObject({ deleted: 1, failed: 0 });
    expect((await photoRow(chat.photoId)).deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(chat.storageKey)).toBe(false);
    // Idempotent: nichts mehr zu tun.
    expect(
      (await ctx.scan.retention.runBackstop(new Date(), { textRetention: false })).photos,
    ).toMatchObject({ deleted: 0, failed: 0 });
  });

  it('OK-5 (Review B, kein Fund): 12-Monats-Grenze nach Berliner Kalender (Abschluss 19.10.2025 00:30 Berlin)', async () => {
    const { admin } = await adminSession(ctx);
    const { customer, process } = await createCustomerWithProcess(ctx, admin.id);
    const chat = await messageWithPhoto(process.id, customer.id);
    await processServiceFor(ctx).complete(process.id, adminVisibilityCtx());
    // 2025-10-18T22:30Z = 19.10.2025 00:30 Berlin (CEST).
    await ctx.db
      .update(processes)
      .set({ completedAt: new Date('2025-10-18T22:30:00Z') })
      .where(eq(processes.id, process.id));
    // 19.10.2026 00:15 Berlin ⇒ noch nicht 12 Monate.
    await ctx.scan.retention.purgeExpiredChatText(new Date('2026-10-18T22:15:00Z'));
    expect((await messageRow(chat.message.id)).bodyDeletedAt).toBeNull();
    // 19.10.2026 00:31 Berlin ⇒ geleert.
    await ctx.scan.retention.purgeExpiredChatText(new Date('2026-10-18T22:31:00Z'));
    const purged = await messageRow(chat.message.id);
    expect(purged.bodyDeletedAt).not.toBeNull();
    expect(purged.body).toBe('');
  });
});
