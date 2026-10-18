/**
 * Phase 12 (Order §§22, 24, 25): Konversationen je Vorgang.
 *
 * - Eine Zeile je Nachricht (E-Mail/WhatsApp, inbound/outbound, Systemereignis).
 * - Sichtbarkeit = Vorgangssichtbarkeit (Routen prüfen; der Service liefert
 *   nur Daten für einen bereits geprüften Vorgang).
 * - Staff-Antwort per E-Mail: Empfänger ist NIE frei – immer die E-Mail des
 *   Kunden des Vorgangs; Versand über die Outbox (`MailOutbox`), Job nach Commit.
 * - Retention-Hilfen (`deleteChatPhotosForProcess`, `purgeChatTextForProcess`)
 *   werden vom Cleanup-Job (Agent R) aufgerufen; sie betreffen ausschließlich
 *   Kommunikationsfotos/-texte – nie Übergabe-/Rückgabe-/Schadensfotos.
 * - Eingehende Nachrichten autorisieren NIE Fachaktionen: dieser Service
 *   schreibt nur conversation_messages/message_photos.
 */
import { randomUUID } from 'node:crypto';
import type { AppEnvironment } from '@mietroyal/config';
import {
  conversationMessages,
  customers,
  inboundMailReceipts,
  messagePhotos,
  processes,
  staffUsers,
  whatsappContacts,
  type ConversationMessageRow,
  type Database,
  type DatabaseExecutor,
} from '@mietroyal/database';
import { StorageObjectNotFoundError, type StorageProvider } from '@mietroyal/integrations';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { AuthError } from '../../auth/service.ts';
import { previewOf } from '../inbound/content.ts';
import { renderMailSubject } from '../mail/templates/index.ts';
import type { MailDeliveryKind, MailOutbox } from '../types.ts';

export type ConversationChannel = 'email' | 'whatsapp' | 'portal';
export type ConversationDeliveryState = ConversationMessageRow['deliveryState'];

/** Absender-Snapshot ohne Secrets (Order §24). */
export interface SenderSnapshot {
  name?: string | null;
  email?: string | null;
  /** wa_id (Ziffern ohne Plus) bei WhatsApp. */
  phone?: string | null;
  /** Nicht gespeicherte Anhänge (PDF/ZIP/…): nur Zähler, nie Inhalte. */
  skippedAttachments?: number;
}

export const MANUAL_REPLY_MAX_CHARS = 5000;

export interface ConversationPhotoView {
  id: string;
  mimeType: string;
  byteSize: number;
  deleted: boolean;
}

export interface ConversationMessageView {
  id: string;
  processId: string | null;
  customerId: string | null;
  channel: ConversationChannel;
  direction: 'inbound' | 'outbound';
  sender: SenderSnapshot;
  subject: string | null;
  body: string;
  bodyDeleted: boolean;
  isSystemEvent: boolean;
  deliveryState: ConversationDeliveryState;
  providerMessageId: string | null;
  mailDeliveryId: string | null;
  sentAt: Date | null;
  receivedAt: Date | null;
  createdAt: Date;
  createdByStaff: { id: string; firstName: string; lastName: string } | null;
  photos: ConversationPhotoView[];
}

export interface UnmatchedMessageView {
  id: string;
  channel: ConversationChannel;
  sender: SenderSnapshot;
  subject: string | null;
  preview: string;
  receivedAt: Date | null;
  createdAt: Date;
  photoCount: number;
  /** Eindeutig erkannter Kunde (nur WhatsApp-Telefonabgleich), falls vorhanden. */
  customerId: string | null;
}

function snapshotOf(row: ConversationMessageRow): SenderSnapshot {
  const raw = row.senderSnapshot;
  if (raw === null || typeof raw !== 'object') return {};
  const value = raw as Record<string, unknown>;
  const out: SenderSnapshot = {};
  if (typeof value.name === 'string') out.name = value.name;
  if (typeof value.email === 'string') out.email = value.email;
  if (typeof value.phone === 'string') out.phone = value.phone;
  if (typeof value.skippedAttachments === 'number') {
    out.skippedAttachments = value.skippedAttachments;
  }
  return out;
}

export function photoStorageKey(messageId: string, extension: string): string {
  return `communication/messages/${messageId}/${randomUUID()}.${extension}`;
}

export class ConversationService {
  constructor(
    private readonly db: Database,
    private readonly storage: StorageProvider,
  ) {}

  // ── Lesen ──────────────────────────────────────────────────────────────

  /** Chronologische Liste eines (bereits sichtbarkeitsgeprüften) Vorgangs. */
  async listForProcess(processId: string): Promise<ConversationMessageView[]> {
    const rows = await this.db
      .select({
        message: conversationMessages,
        staffId: staffUsers.id,
        staffFirstName: staffUsers.firstName,
        staffLastName: staffUsers.lastName,
      })
      .from(conversationMessages)
      .leftJoin(staffUsers, eq(staffUsers.id, conversationMessages.createdByStaffId))
      .where(eq(conversationMessages.processId, processId))
      .orderBy(asc(conversationMessages.createdAt), asc(conversationMessages.id));
    const photosByMessage = await this.photosFor(rows.map((row) => row.message.id));
    return rows.map((row) =>
      this.toView(
        row.message,
        row.staffId === null
          ? null
          : {
              id: row.staffId,
              firstName: row.staffFirstName ?? '',
              lastName: row.staffLastName ?? '',
            },
        photosByMessage.get(row.message.id) ?? [],
      ),
    );
  }

  async byId(messageId: string): Promise<ConversationMessageRow | null> {
    const rows = await this.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, messageId));
    return rows[0] ?? null;
  }

  /** Foto-Metadaten + Bytes; nur nach Vorgangssichtbarkeitsprüfung durch die Route aufrufen. */
  async photoBytes(
    messageId: string,
    photoId: string,
  ): Promise<{ mimeType: string; bytes: Uint8Array } | null> {
    const rows = await this.db
      .select()
      .from(messagePhotos)
      .where(and(eq(messagePhotos.id, photoId), eq(messagePhotos.messageId, messageId)));
    const photo = rows[0];
    if (photo === undefined || photo.deletedAt !== null) return null;
    const bytes = await this.storage.get(photo.storageKey);
    return { mimeType: photo.mimeType, bytes };
  }

  private async photosFor(
    messageIds: readonly string[],
  ): Promise<Map<string, ConversationPhotoView[]>> {
    const map = new Map<string, ConversationPhotoView[]>();
    if (messageIds.length === 0) return map;
    const rows = await this.db
      .select()
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

  private toView(
    row: ConversationMessageRow,
    createdByStaff: ConversationMessageView['createdByStaff'],
    photos: ConversationPhotoView[],
  ): ConversationMessageView {
    return {
      id: row.id,
      processId: row.processId,
      customerId: row.customerId,
      channel: row.channel,
      direction: row.direction,
      sender: snapshotOf(row),
      subject: row.subject,
      body: row.bodyDeletedAt === null ? row.body : '',
      bodyDeleted: row.bodyDeletedAt !== null,
      isSystemEvent: row.isSystemEvent,
      deliveryState: row.deliveryState,
      providerMessageId: row.providerMessageId,
      mailDeliveryId: row.mailDeliveryId,
      sentAt: row.sentAt,
      receivedAt: row.receivedAt,
      createdAt: row.createdAt,
      createdByStaff,
      photos,
    };
  }

  // ── Schreiben (eingehend) ───────────────────────────────────────────────

  /**
   * Eingehende Nachricht anlegen (optional in einer Transaktion des Aufrufers).
   * `id` kann vorab erzeugt werden, damit Fotos unter dem Storage-Key der
   * Nachricht VOR der Transaktion hochgeladen werden können.
   */
  async createInbound(
    input: {
      id?: string;
      processId: string | null;
      customerId: string | null;
      channel: 'email' | 'whatsapp';
      sender: SenderSnapshot;
      subject: string | null;
      body: string;
      providerMessageId: string | null;
      replyToProviderMessageId: string | null;
      receivedAt: Date;
    },
    executor: DatabaseExecutor = this.db,
  ): Promise<ConversationMessageRow> {
    const inserted = await executor
      .insert(conversationMessages)
      .values({
        ...(input.id === undefined ? {} : { id: input.id }),
        processId: input.processId,
        customerId: input.customerId,
        channel: input.channel,
        direction: 'inbound',
        senderSnapshot: input.sender,
        subject: input.subject,
        body: input.body,
        providerMessageId: input.providerMessageId,
        replyToProviderMessageId: input.replyToProviderMessageId,
        isSystemEvent: false,
        deliveryState: 'received',
        receivedAt: input.receivedAt,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined)
      throw new AuthError('CONFLICT', 'Nachricht konnte nicht angelegt werden.');
    return row;
  }

  /** Foto-Zeile registrieren (Bytes liegen bereits unter `storageKey`). */
  async registerPhoto(
    input: {
      messageId: string;
      storageKey: string;
      mimeType: string;
      byteSize: number;
      sha256: string;
    },
    executor: DatabaseExecutor = this.db,
  ): Promise<{ id: string }> {
    const inserted = await executor
      .insert(messagePhotos)
      .values({
        messageId: input.messageId,
        storageKey: input.storageKey,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        sha256: input.sha256,
      })
      .returning({ id: messagePhotos.id });
    const row = inserted[0];
    if (row === undefined) throw new AuthError('CONFLICT', 'Foto konnte nicht angelegt werden.');
    return row;
  }

  // ── Schreiben (ausgehend) ───────────────────────────────────────────────

  /**
   * Automatische Mail als kompaktes Ereignis spiegeln (Agent M ruft das aus
   * der Outbox). Idempotent je mailDeliveryId.
   */
  async recordOutboundSystemEvent(
    input: {
      processId: string;
      customerId?: string | null;
      channel: 'email';
      kind: MailDeliveryKind;
      subject: string;
      mailDeliveryId: string;
    },
    executor: DatabaseExecutor = this.db,
  ): Promise<{ id: string; created: boolean }> {
    const existing = await executor
      .select({ id: conversationMessages.id })
      .from(conversationMessages)
      .where(eq(conversationMessages.mailDeliveryId, input.mailDeliveryId));
    const found = existing[0];
    if (found !== undefined) return { id: found.id, created: false };
    const inserted = await executor
      .insert(conversationMessages)
      .values({
        processId: input.processId,
        customerId: input.customerId ?? null,
        channel: input.channel,
        direction: 'outbound',
        senderSnapshot: { name: 'Miet-Royal' },
        subject: input.subject,
        body: `[${input.kind}] ${input.subject}`,
        mailDeliveryId: input.mailDeliveryId,
        isSystemEvent: true,
        deliveryState: 'queued',
      })
      .returning({ id: conversationMessages.id });
    const row = inserted[0];
    if (row === undefined)
      throw new AuthError('CONFLICT', 'Ereignis konnte nicht angelegt werden.');
    return { id: row.id, created: true };
  }

  /** Zustellstatus aus der Outbox spiegeln (Listener bei Agent M). */
  async markDeliveryState(
    mailDeliveryId: string,
    state: ConversationDeliveryState,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor
      .update(conversationMessages)
      .set({
        deliveryState: state,
        ...(state === 'sent' ? { sentAt: new Date() } : {}),
      })
      .where(eq(conversationMessages.mailDeliveryId, mailDeliveryId));
  }

  /**
   * Staff-Antwort per E-Mail (Order §24): Empfänger = E-Mail des Kunden des
   * Vorgangs (nie frei wählbar; der Absender einer eingehenden Mail wird nur
   * verwendet, wenn er mit der Kunden-E-Mail übereinstimmt – was auf
   * dasselbe hinausläuft). In-Reply-To = letzte eingehende Mail des Vorgangs.
   * Outbox-Zeile und Konversationszeile in EINER Transaktion; der Versand-Job
   * wird erst nach Commit eingereiht.
   */
  async replyByEmail(
    outbox: MailOutbox,
    input: { processId: string; body: string; staffUserId: string; appEnv: AppEnvironment },
  ): Promise<{
    messageId: string;
    mailDeliveryId: string;
    deliveryState: ConversationDeliveryState;
  }> {
    const body = input.body.trim();
    if (body === '') throw new AuthError('VALIDATION', 'Die Nachricht darf nicht leer sein.');
    if (body.length > MANUAL_REPLY_MAX_CHARS) {
      throw new AuthError(
        'VALIDATION',
        `Die Nachricht darf höchstens ${MANUAL_REPLY_MAX_CHARS} Zeichen haben.`,
      );
    }
    const target = await this.db
      .select({
        processNumber: processes.processNumber,
        customerId: processes.customerId,
        email: customers.email,
        firstName: customers.firstName,
        lastName: customers.lastName,
        organizationName: customers.organizationName,
      })
      .from(processes)
      .innerJoin(customers, eq(customers.id, processes.customerId))
      .where(eq(processes.id, input.processId));
    const row = target[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    const recipientEmail = (row.email ?? '').trim().toLowerCase();
    if (recipientEmail === '') {
      throw new AuthError(
        'CONFLICT',
        'Der Kunde hat keine E-Mail-Adresse – Antwort per E-Mail nicht möglich.',
      );
    }
    const recipientName =
      row.organizationName ?? [row.firstName, row.lastName].filter(Boolean).join(' ');
    const lastInbound = await this.db
      .select({
        providerMessageId: conversationMessages.providerMessageId,
        subject: conversationMessages.subject,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.processId, input.processId),
          eq(conversationMessages.channel, 'email'),
          eq(conversationMessages.direction, 'inbound'),
        ),
      )
      .orderBy(desc(conversationMessages.createdAt))
      .limit(1);
    const inReplyTo = lastInbound[0]?.providerMessageId ?? null;
    // Betreff kommt aus der zentralen Vorlage (Agent M) – hier nur gespiegelt.
    const salutation =
      row.organizationName === null && row.firstName !== null && row.firstName.trim() !== ''
        ? `Hallo ${row.firstName.trim()},`
        : 'Hallo,';
    const { appEnv } = input;
    const staff = await this.db
      .select({ firstName: staffUsers.firstName, lastName: staffUsers.lastName })
      .from(staffUsers)
      .where(eq(staffUsers.id, input.staffUserId));
    const staffName =
      staff[0] === undefined ? 'Miet-Royal' : `${staff[0].firstName} ${staff[0].lastName}`;
    const context = { salutation, processNumber: row.processNumber, body, staffName };
    const subject = renderMailSubject('manual_customer_reply', context, { appEnv });

    const messageId = randomUUID();
    const result = await this.db.transaction(async (tx) => {
      await tx.insert(conversationMessages).values({
        id: messageId,
        processId: input.processId,
        customerId: row.customerId,
        channel: 'email',
        direction: 'outbound',
        senderSnapshot: { name: staffName },
        subject,
        body,
        replyToProviderMessageId: inReplyTo,
        isSystemEvent: false,
        deliveryState: 'queued',
        createdByStaffId: input.staffUserId,
      });
      const enqueued = await outbox.enqueue(
        {
          kind: 'manual_customer_reply',
          processId: input.processId,
          customerId: row.customerId,
          recipient: { email: recipientEmail, name: recipientName === '' ? null : recipientName },
          context,
          idempotencyKey: `manual_customer_reply:${messageId}`,
          inReplyToMessageId: inReplyTo,
          conversationMessageId: messageId,
          createdBy: input.staffUserId,
        },
        tx,
      );
      const state: ConversationDeliveryState = enqueued.status === 'blocked' ? 'blocked' : 'queued';
      await tx
        .update(conversationMessages)
        .set({ mailDeliveryId: enqueued.deliveryId, deliveryState: state })
        .where(eq(conversationMessages.id, messageId));
      return { deliveryId: enqueued.deliveryId, state };
    });
    // Job erst nach Commit (Gateway nie unter offener Transaktion).
    if (result.state === 'queued') await outbox.scheduleSend(result.deliveryId);
    return { messageId, mailDeliveryId: result.deliveryId, deliveryState: result.state };
  }

  // ── Unmatched-Inbox (Order §22) ────────────────────────────────────────

  async listUnmatched(): Promise<UnmatchedMessageView[]> {
    const rows = await this.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          isNull(conversationMessages.processId),
          isNull(conversationMessages.ignoredAt),
          eq(conversationMessages.direction, 'inbound'),
        ),
      )
      .orderBy(desc(conversationMessages.createdAt));
    const photos = await this.photosFor(rows.map((row) => row.id));
    return rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      sender: snapshotOf(row),
      subject: row.subject,
      preview: row.bodyDeletedAt === null ? previewOf(row.body) : '',
      receivedAt: row.receivedAt,
      createdAt: row.createdAt,
      photoCount: (photos.get(row.id) ?? []).filter((photo) => !photo.deleted).length,
      customerId: row.customerId,
    }));
  }

  /** Zuordnung durch Mitarbeitende: nur Konversationszeile + Beleg – keine Fachmutation. */
  async assignUnmatched(
    messageId: string,
    input: { processId: string; staffUserId: string },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, messageId))
        .for('update');
      const message = rows[0];
      if (message === undefined || message.direction !== 'inbound') {
        throw new AuthError('NOT_FOUND', 'Nachricht nicht gefunden.');
      }
      if (message.processId !== null || message.ignoredAt !== null) {
        throw new AuthError('CONFLICT', 'Die Nachricht ist bereits zugeordnet oder ignoriert.');
      }
      const processRows = await tx
        .select({ id: processes.id, customerId: processes.customerId })
        .from(processes)
        .where(eq(processes.id, input.processId));
      const process = processRows[0];
      if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
      const now = new Date();
      await tx
        .update(conversationMessages)
        .set({
          processId: process.id,
          customerId: process.customerId,
          assignedByStaffId: input.staffUserId,
          assignedAt: now,
        })
        .where(eq(conversationMessages.id, messageId));
      await tx
        .update(inboundMailReceipts)
        .set({ status: 'matched', matchReason: 'manual' })
        .where(eq(inboundMailReceipts.conversationMessageId, messageId));
      const sender = snapshotOf(message);
      if (message.channel === 'whatsapp' && typeof sender.phone === 'string') {
        await tx
          .update(whatsappContacts)
          .set({ customerId: process.customerId, updatedAt: now })
          .where(and(eq(whatsappContacts.waId, sender.phone), isNull(whatsappContacts.customerId)));
      }
    });
  }

  async ignoreUnmatched(messageId: string, staffUserId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.id, messageId))
        .for('update');
      const message = rows[0];
      if (message === undefined || message.direction !== 'inbound') {
        throw new AuthError('NOT_FOUND', 'Nachricht nicht gefunden.');
      }
      if (message.processId !== null || message.ignoredAt !== null) {
        throw new AuthError('CONFLICT', 'Die Nachricht ist bereits zugeordnet oder ignoriert.');
      }
      await tx
        .update(conversationMessages)
        .set({ ignoredAt: new Date(), ignoredByStaffId: staffUserId })
        .where(eq(conversationMessages.id, messageId));
      await tx
        .update(inboundMailReceipts)
        .set({ status: 'ignored' })
        .where(eq(inboundMailReceipts.conversationMessageId, messageId));
    });
  }

  // ── Retention (Order §25; Aufruf aus dem Cleanup-Job) ──────────────────

  /**
   * Kommunikationsfotos eines Vorgangs löschen (Storage + deletedAt). Idempotent.
   * Härtung B15: `deletedAt` erst NACH erfolgreichem Storage-Löschen (ein
   * bereits fehlendes Objekt zählt als gelöscht). Scheitert das Löschen, bleibt
   * die Zeile offen – der Retention-Backstop (scan_due) versucht es erneut.
   * `errorCode`: neutraler Code des ersten Fehlers (nur für das Log).
   */
  async deleteChatPhotosForProcess(
    processId: string,
  ): Promise<{ deleted: number; failed: number; errorCode: string | null }> {
    const rows = await this.db
      .select({ id: messagePhotos.id, storageKey: messagePhotos.storageKey })
      .from(messagePhotos)
      .innerJoin(conversationMessages, eq(conversationMessages.id, messagePhotos.messageId))
      .where(and(eq(conversationMessages.processId, processId), isNull(messagePhotos.deletedAt)));
    let deleted = 0;
    let failed = 0;
    let errorCode: string | null = null;
    for (const row of rows) {
      try {
        await this.storage.delete(row.storageKey);
      } catch (error) {
        if (!(error instanceof StorageObjectNotFoundError)) {
          failed += 1;
          errorCode ??= error instanceof Error ? error.name || 'Error' : 'Error';
          continue;
        }
      }
      await this.db
        .update(messagePhotos)
        .set({ deletedAt: new Date() })
        .where(and(eq(messagePhotos.id, row.id), isNull(messagePhotos.deletedAt)));
      deleted += 1;
    }
    return { deleted, failed, errorCode };
  }

  /** Chattexte eines Vorgangs leeren (body ⇒ '', bodyDeletedAt). Idempotent. */
  async purgeChatTextForProcess(processId: string, now = new Date()): Promise<{ purged: number }> {
    const updated = await this.db
      .update(conversationMessages)
      .set({ body: '', subject: null, bodyDeletedAt: now })
      .where(
        and(
          eq(conversationMessages.processId, processId),
          isNull(conversationMessages.bodyDeletedAt),
        ),
      )
      .returning({ id: conversationMessages.id });
    return { purged: updated.length };
  }

  /** Letzte eingehende WhatsApp-Nachricht (für Antwortziel/Fenster). */
  async lastInboundWhatsApp(
    processId: string,
  ): Promise<{ waId: string; providerMessageId: string | null } | null> {
    const rows = await this.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.processId, processId),
          eq(conversationMessages.channel, 'whatsapp'),
          eq(conversationMessages.direction, 'inbound'),
        ),
      )
      .orderBy(desc(conversationMessages.createdAt))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const sender = snapshotOf(row);
    if (typeof sender.phone !== 'string' || sender.phone === '') return null;
    return { waId: sender.phone, providerMessageId: row.providerMessageId };
  }

  /** Noch nicht abgelaufene WhatsApp-Kontakte zählen (Hilfsfunktion für Status). */
  async countContactsWithOpenWindow(now: Date): Promise<number> {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(whatsappContacts)
      .where(gt(whatsappContacts.lastInboundAt, since));
    return rows[0]?.count ?? 0;
  }
}
