/**
 * Phase 12 (Order §28): Staff-Antwort per WhatsApp.
 *
 * - Nur im Customer-Service-Window (24 h ab letzter Kundennachricht; Quelle:
 *   whatsapp_contacts.last_inbound_at); außerhalb ⇒ CONFLICT mit dem
 *   festen Hinweistext (keine Templates, keine automatischen Nachrichten).
 * - Empfänger NIE frei: wa_id der letzten eingehenden WhatsApp-Nachricht des
 *   Vorgangs. Versand über den Job `whatsapp.send` nach Commit.
 */
import {
  conversationMessages,
  processes,
  staffUsers,
  whatsappContacts,
  type Database,
} from '@mietroyal/database';
import type { JobQueue } from '@mietroyal/integrations';
import { eq } from 'drizzle-orm';
import { AuthError } from '../../auth/service.ts';
import {
  MANUAL_REPLY_MAX_CHARS,
  type ConversationService,
} from '../conversation/conversation-service.ts';
import { WHATSAPP_WINDOW_CLOSED_MESSAGE, type WhatsAppGateway } from '../types.ts';
import { enqueueWhatsAppSend } from './jobs.ts';
import { WHATSAPP_SERVICE_WINDOW_MS } from './webhook-service.ts';

export class WhatsAppReplyService {
  constructor(
    private readonly deps: {
      db: Database;
      queue: JobQueue;
      gateway: WhatsAppGateway;
      conversations: ConversationService;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.deps.now === undefined ? new Date() : this.deps.now();
  }

  /** Fensterstatus für die UI (ohne Nummer nach außen). */
  async windowFor(
    processId: string,
  ): Promise<{ available: boolean; open: boolean; windowEndsAt: Date | null }> {
    const last = await this.deps.conversations.lastInboundWhatsApp(processId);
    if (last === null) return { available: false, open: false, windowEndsAt: null };
    const contact = await this.contact(last.waId);
    const endsAt =
      contact?.lastInboundAt === null || contact === null
        ? null
        : new Date(contact.lastInboundAt.getTime() + WHATSAPP_SERVICE_WINDOW_MS);
    return {
      available: true,
      open: endsAt !== null && endsAt.getTime() > this.now().getTime(),
      windowEndsAt: endsAt,
    };
  }

  private async contact(waId: string) {
    const rows = await this.deps.db
      .select()
      .from(whatsappContacts)
      .where(eq(whatsappContacts.waId, waId));
    return rows[0] ?? null;
  }

  async reply(input: {
    processId: string;
    body: string;
    staffUserId: string;
  }): Promise<{ messageId: string }> {
    if (this.deps.gateway.kind === 'disabled') {
      throw new AuthError('CONFLICT', 'WhatsApp ist in dieser Umgebung nicht konfiguriert.');
    }
    const body = input.body.trim();
    if (body === '') throw new AuthError('VALIDATION', 'Die Nachricht darf nicht leer sein.');
    if (body.length > MANUAL_REPLY_MAX_CHARS) {
      throw new AuthError(
        'VALIDATION',
        `Die Nachricht darf höchstens ${MANUAL_REPLY_MAX_CHARS} Zeichen haben.`,
      );
    }
    const last = await this.deps.conversations.lastInboundWhatsApp(input.processId);
    if (last === null) {
      throw new AuthError(
        'CONFLICT',
        'Zu diesem Vorgang liegt keine WhatsApp-Nachricht des Kunden vor.',
      );
    }
    const contact = await this.contact(last.waId);
    const lastInboundAt = contact?.lastInboundAt ?? null;
    if (
      lastInboundAt === null ||
      lastInboundAt.getTime() + WHATSAPP_SERVICE_WINDOW_MS <= this.now().getTime()
    ) {
      throw new AuthError('CONFLICT', WHATSAPP_WINDOW_CLOSED_MESSAGE);
    }
    const staff = await this.deps.db
      .select({ firstName: staffUsers.firstName, lastName: staffUsers.lastName })
      .from(staffUsers)
      .where(eq(staffUsers.id, input.staffUserId));
    const staffName =
      staff[0] === undefined ? 'Miet-Royal' : `${staff[0].firstName} ${staff[0].lastName}`;
    const processRow = await this.deps.db
      .select({ customerId: processes.customerId })
      .from(processes)
      .where(eq(processes.id, input.processId));
    if (processRow[0] === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    const inserted = await this.deps.db
      .insert(conversationMessages)
      .values({
        processId: input.processId,
        customerId: processRow[0].customerId,
        channel: 'whatsapp',
        direction: 'outbound',
        // `phone` = Gegenstelle (wa_id des Kunden) – nie frei wählbar.
        senderSnapshot: { name: staffName, phone: last.waId },
        subject: null,
        body,
        replyToProviderMessageId: last.providerMessageId,
        isSystemEvent: false,
        deliveryState: 'queued',
        createdByStaffId: input.staffUserId,
      })
      .returning({ id: conversationMessages.id });
    const row = inserted[0];
    if (row === undefined)
      throw new AuthError('CONFLICT', 'Nachricht konnte nicht angelegt werden.');
    // Job nach dem (autocommit) Insert – Gateway nie unter offener Transaktion.
    await enqueueWhatsAppSend(this.deps.queue, row.id);
    return { messageId: row.id };
  }
}
