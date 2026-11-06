import { createHash, randomUUID } from 'node:crypto';
import {
  conversationMessages,
  customers,
  messagePhotos,
  processes,
  type ConversationMessageRow,
  type Database,
} from '@mietroyal/database';
import { StorageObjectNotFoundError, type StorageProvider } from '@mietroyal/integrations';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { AuthError } from '../../auth/service.ts';
import {
  ConversationService,
  MANUAL_REPLY_MAX_CHARS,
  photoStorageKey,
  type SenderSnapshot,
} from '../../communication/conversation/conversation-service.ts';
import {
  acceptImageAttachment,
  imageExtensionFor,
  INBOUND_MAIL_PHOTO_MAX_BYTES,
  type AllowedImageMime,
} from '../../communication/inbound/content.ts';
import type { PushService } from '../../communication/push/push-service.ts';
import { PortalError } from '../types.ts';
import { notifyStaffOfPortalMessage } from './notify.ts';
import { toPortalMessageView, type PortalMessagePhoto, type PortalMessageView } from './views.ts';

/**
 * Phase 15 (CHAT, Order §25–§28; Design §3.1): Kundenseite des Portal-Chats.
 *
 * - Quelle sind ausschließlich `conversation_messages` mit `channel = 'portal'`
 *   (keine E-Mail-/WhatsApp-Historie, keine Systemereignisse) des Vorgangs der
 *   bereits sichtbarkeitsgeprüften Buchung – die Route prüft Session + Policy.
 * - Fotos: Phase-12-Prüfung (`acceptImageAttachment`: MIME + Magic Bytes,
 *   JPEG/PNG/WebP, ≤ 8 MiB) – PDF/SVG/HTML werden NIE gespeichert; Ablage privat
 *   unter `photoStorageKey(messageId, ext)` VOR der Transaktion, Zeilen in EINER
 *   Transaktion mit der Nachricht; Teil-Uploads werden bei Fehlern entfernt.
 * - Absender ist IMMER der Kunde der Session (Snapshot {name, email, role:'customer'}).
 * - Nach dem Commit: Push an Admin + effektiv zuständige Person (notify.ts).
 * - Retention: unverändert Phase 12 (Terminal ⇒ Fotos, 12 Monate Text).
 */

export const PORTAL_MESSAGE_MAX_PHOTOS = 5;
export const PORTAL_PHOTO_MAX_BYTES = INBOUND_MAIL_PHOTO_MAX_BYTES;
export const PORTAL_PHOTO_REJECTED_MESSAGE = 'Nur Bilder im Format JPEG, PNG oder WebP bis 8 MB.';
export const PORTAL_TOO_MANY_PHOTOS_MESSAGE = `Höchstens ${PORTAL_MESSAGE_MAX_PHOTOS} Fotos je Nachricht.`;

export interface PortalChatPhotoInput {
  /** Vom Client deklarierter Typ – muss zu den Magic Bytes passen. */
  mimeType: string;
  bytes: Uint8Array;
}

export interface PortalChatServiceDeps {
  db: Database;
  storage: StorageProvider;
  push: PushService;
  logger?: { warn(obj: Record<string, unknown>, msg?: string): void };
}

export class PortalChatService {
  private readonly conversations: ConversationService;

  constructor(private readonly deps: PortalChatServiceDeps) {
    this.conversations = new ConversationService(deps.db, deps.storage);
  }

  /** Chronologisch: nur Kanal portal, keine Systemereignisse. */
  async listMessages(processId: string): Promise<PortalMessageView[]> {
    const rows = await this.deps.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.processId, processId),
          eq(conversationMessages.channel, 'portal'),
          eq(conversationMessages.isSystemEvent, false),
        ),
      )
      .orderBy(asc(conversationMessages.createdAt), asc(conversationMessages.id));
    const photos = await this.photosFor(rows.map((row) => row.id));
    return rows.map((row) => toPortalMessageView(row, photos.get(row.id) ?? []));
  }

  /**
   * Kundennachricht anlegen (Route hat Session, Sichtbarkeit und Zustand
   * `active` bereits geprüft). Wirft `PortalError('VALIDATION', 'PORTAL_PHOTO_REJECTED')`
   * bei unzulässigen Bildern – bevor irgendetwas gespeichert wird.
   */
  async createCustomerMessage(input: {
    processId: string;
    customerId: string;
    body: string;
    photos: readonly PortalChatPhotoInput[];
    now?: Date;
  }): Promise<PortalMessageView> {
    const body = input.body.trim();
    if (body === '') throw new AuthError('VALIDATION', 'Die Nachricht darf nicht leer sein.');
    if (body.length > MANUAL_REPLY_MAX_CHARS) {
      throw new AuthError(
        'VALIDATION',
        `Die Nachricht darf höchstens ${MANUAL_REPLY_MAX_CHARS} Zeichen haben.`,
      );
    }
    if (input.photos.length > PORTAL_MESSAGE_MAX_PHOTOS) {
      throw new PortalError('VALIDATION', 'PORTAL_PHOTO_REJECTED', PORTAL_TOO_MANY_PHOTOS_MESSAGE);
    }
    // Erst ALLE Bilder prüfen, dann speichern (kein Teilzustand bei Ablehnung).
    const accepted: { mime: AllowedImageMime; bytes: Uint8Array }[] = [];
    for (const photo of input.photos) {
      const mime = acceptImageAttachment(photo.mimeType, photo.bytes, PORTAL_PHOTO_MAX_BYTES);
      if (mime === null) {
        throw new PortalError('VALIDATION', 'PORTAL_PHOTO_REJECTED', PORTAL_PHOTO_REJECTED_MESSAGE);
      }
      accepted.push({ mime, bytes: photo.bytes });
    }
    const now = input.now ?? new Date();

    const targetRows = await this.deps.db
      .select({
        processNumber: processes.processNumber,
        email: customers.email,
        firstName: customers.firstName,
        lastName: customers.lastName,
        organizationName: customers.organizationName,
      })
      .from(processes)
      .innerJoin(customers, eq(customers.id, processes.customerId))
      .where(and(eq(processes.id, input.processId), eq(processes.customerId, input.customerId)));
    const target = targetRows[0];
    if (target === undefined) throw new AuthError('NOT_FOUND', 'Nicht gefunden.');
    const displayName =
      target.organizationName ?? [target.firstName, target.lastName].filter(Boolean).join(' ');
    const sender: SenderSnapshot = {
      name: displayName === '' ? null : displayName,
      email: target.email,
      role: 'customer',
    };

    const messageId = randomUUID();
    const stored: {
      storageKey: string;
      mimeType: AllowedImageMime;
      byteSize: number;
      sha256: string;
    }[] = [];
    const discardStored = async () => {
      for (const photo of stored) {
        await this.deps.storage.delete(photo.storageKey).catch(() => undefined);
      }
    };
    try {
      for (const photo of accepted) {
        const storageKey = photoStorageKey(messageId, imageExtensionFor(photo.mime));
        await this.deps.storage.put(storageKey, photo.bytes, { contentType: photo.mime });
        stored.push({
          storageKey,
          mimeType: photo.mime,
          byteSize: photo.bytes.length,
          sha256: createHash('sha256').update(photo.bytes).digest('hex'),
        });
      }
    } catch (error) {
      await discardStored();
      throw error;
    }

    let row: ConversationMessageRow;
    const photoViews: PortalMessagePhoto[] = [];
    try {
      row = await this.deps.db.transaction(async (tx) => {
        const created = await this.conversations.createInbound(
          {
            id: messageId,
            processId: input.processId,
            customerId: input.customerId,
            channel: 'portal',
            sender,
            subject: null,
            body,
            providerMessageId: null,
            replyToProviderMessageId: null,
            receivedAt: now,
          },
          tx,
        );
        for (const photo of stored) {
          const registered = await this.conversations.registerPhoto({ messageId, ...photo }, tx);
          photoViews.push({
            id: registered.id,
            mimeType: photo.mimeType,
            byteSize: photo.byteSize,
            deleted: false,
          });
        }
        return created;
      });
    } catch (error) {
      await discardStored();
      throw error;
    }

    // Benachrichtigung erst nach Commit (Push-Outbox + Job; Fehler nur geloggt).
    await notifyStaffOfPortalMessage(
      {
        db: this.deps.db,
        push: this.deps.push,
        ...(this.deps.logger ? { logger: this.deps.logger } : {}),
      },
      { messageId, processId: input.processId, processNumber: target.processNumber, now },
    );
    return toPortalMessageView(row, photoViews);
  }

  /**
   * Foto-Bytes nur, wenn die Nachricht zum Vorgang der (geprüften) Buchung
   * gehört und auf dem Kanal portal liegt; gelöscht/unbekannt ⇒ null.
   */
  async photoBytes(input: {
    processId: string;
    messageId: string;
    photoId: string;
  }): Promise<{ mimeType: string; bytes: Uint8Array } | null> {
    const messageRows = await this.deps.db
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.id, input.messageId),
          eq(conversationMessages.processId, input.processId),
          eq(conversationMessages.channel, 'portal'),
          eq(conversationMessages.isSystemEvent, false),
        ),
      );
    if (messageRows[0] === undefined) return null;
    const photoRows = await this.deps.db
      .select()
      .from(messagePhotos)
      .where(
        and(eq(messagePhotos.id, input.photoId), eq(messagePhotos.messageId, input.messageId)),
      );
    const photo = photoRows[0];
    if (photo === undefined || photo.deletedAt !== null) return null;
    try {
      const bytes = await this.deps.storage.get(photo.storageKey);
      return { mimeType: photo.mimeType, bytes };
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) return null;
      throw error;
    }
  }

  private async photosFor(
    messageIds: readonly string[],
  ): Promise<Map<string, PortalMessagePhoto[]>> {
    const map = new Map<string, PortalMessagePhoto[]>();
    if (messageIds.length === 0) return map;
    const rows = await this.deps.db
      .select({
        id: messagePhotos.id,
        messageId: messagePhotos.messageId,
        mimeType: messagePhotos.mimeType,
        byteSize: messagePhotos.byteSize,
        deletedAt: messagePhotos.deletedAt,
      })
      .from(messagePhotos)
      .where(inArray(messagePhotos.messageId, [...messageIds]))
      .orderBy(asc(messagePhotos.createdAt));
    for (const row of rows) {
      const list = map.get(row.messageId) ?? [];
      list.push({
        id: row.id,
        mimeType: row.mimeType,
        byteSize: row.byteSize,
        deleted: row.deletedAt !== null,
      });
      map.set(row.messageId, list);
    }
    return map;
  }
}
