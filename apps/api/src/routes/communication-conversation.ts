import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { JobQueue, StorageProvider } from '@mietroyal/integrations';
import { StorageObjectNotFoundError } from '@mietroyal/integrations';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
import type { AuthenticatedContext, StaffAuthService } from '../auth/service.ts';
import {
  ConversationService,
  MANUAL_REPLY_MAX_CHARS,
} from '../communication/conversation/conversation-service.ts';
import type { MailOutbox, WhatsAppGateway } from '../communication/types.ts';
import { WhatsAppReplyService } from '../communication/whatsapp/reply-service.ts';
import { getCompletedVisibilityDays } from '../crm/settings-service.ts';
import { ProcessService } from '../crm/process-service.ts';
import { buildVisibilityContext } from '../crm/visibility.ts';
import { UUID_PATTERN } from './auth.ts';

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });
const photoParams = z.object({ id: uuidSchema, photoId: uuidSchema });
const replySchema = z.object({
  channel: z.enum(['email', 'whatsapp']),
  body: z.string().min(1, 'darf nicht leer sein').max(MANUAL_REPLY_MAX_CHARS),
});

export interface ConversationRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  storage: StorageProvider;
  queue: JobQueue;
  whatsappGateway: WhatsAppGateway;
  /** Phase 12 (Agent M): Outbox; ohne Instanz ist die E-Mail-Antwort blockiert (409). */
  mailOutbox?: MailOutbox;
}

/**
 * Phase 12 (Order §24): Kommunikation je Vorgang.
 * - GET  /staff/processes/:id/conversation – chronologisch (Vorgangssichtbarkeit).
 * - POST /staff/processes/:id/conversation/reply – { channel, body }; Empfänger
 *   NIE frei (Kunden-E-Mail bzw. wa_id der letzten Kundennachricht);
 *   E-Mail: message.reply_customer, WhatsApp: whatsapp.reply (+ Service-Fenster).
 * - GET  /staff/messages/:id/photos/:photoId – Bytes nur bei Vorgangssichtbarkeit
 *   (unzugeordnete Nachrichten: message.reply_customer wie die Unmatched-Inbox).
 */
export function registerConversationRoutes(
  app: FastifyInstance,
  options: ConversationRouteOptions,
): void {
  const { db, auth, config, storage, queue, whatsappGateway, mailOutbox } = options;
  const conversations = new ConversationService(db, storage);
  const processService = new ProcessService(db);
  const whatsappReplies = new WhatsAppReplyService({
    db,
    queue,
    gateway: whatsappGateway,
    conversations,
  });

  /** Zentrale Vorgangs-Sichtbarkeit (wie routes/crm.ts, commerce.ts): unsichtbar = neutrales 404. */
  const requireVisibleProcess = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    processId: string,
  ): Promise<boolean> => {
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return false;
    const effective = await auth.effectivePermissions(context.user.id);
    const visibility = buildVisibilityContext(effective, await getCompletedVisibilityDays(db));
    try {
      await processService.getVisibleProcess(processId, visibility);
      return true;
    } catch (error) {
      if (sendAuthError(request, reply, error)) return false;
      throw error;
    }
  };

  app.get('/staff/processes/:id/conversation', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    const effective = await auth.effectivePermissions(context.user.id);
    const messages = await conversations.listForProcess(params.id);
    const whatsapp = await whatsappReplies.windowFor(params.id);
    return {
      messages,
      canReplyEmail: effective.has('message.reply_customer') && mailOutbox !== undefined,
      canReplyWhatsApp: effective.has('whatsapp.reply') && whatsappGateway.kind !== 'disabled',
      whatsapp: {
        mode: config.whatsapp.mode,
        available: whatsapp.available,
        windowOpen: whatsapp.open,
        windowEndsAt: whatsapp.windowEndsAt,
      },
    };
  });

  app.post('/staff/processes/:id/conversation/reply', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(replySchema, request.body);
    const permission = body.channel === 'email' ? 'message.reply_customer' : 'whatsapp.reply';
    if (!(await requirePermission(request, reply, auth, context, permission))) return;
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    try {
      if (body.channel === 'email') {
        if (mailOutbox === undefined) {
          sendError(
            request,
            reply,
            409,
            'MAIL_NOT_CONFIGURED',
            'E-Mail-Versand ist in dieser Umgebung nicht konfiguriert.',
          );
          return;
        }
        const result = await conversations.replyByEmail(mailOutbox, {
          processId: params.id,
          body: body.body,
          staffUserId: context.user.id,
          appEnv: config.appEnv,
        });
        return reply.status(201).send({
          messageId: result.messageId,
          channel: 'email',
          deliveryState: result.deliveryState,
          mailDeliveryId: result.mailDeliveryId,
        });
      }
      const result = await whatsappReplies.reply({
        processId: params.id,
        body: body.body,
        staffUserId: context.user.id,
      });
      return reply
        .status(201)
        .send({ messageId: result.messageId, channel: 'whatsapp', deliveryState: 'queued' });
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/messages/:id/photos/:photoId', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const params = parseOrThrow(photoParams, request.params, 'params');
    const message = await conversations.byId(params.id);
    if (message === null) {
      sendError(request, reply, 404, 'NOT_FOUND', 'Foto nicht gefunden.');
      return;
    }
    if (message.processId === null) {
      // Unzugeordnet: dieselbe Berechtigung wie die Unmatched-Inbox.
      if (!(await requirePermission(request, reply, auth, context, 'message.reply_customer')))
        return;
    } else if (!(await requireVisibleProcess(request, reply, context, message.processId))) {
      return;
    }
    try {
      const photo = await conversations.photoBytes(params.id, params.photoId);
      if (photo === null) {
        sendError(request, reply, 404, 'NOT_FOUND', 'Foto nicht gefunden.');
        return;
      }
      return reply
        .header('content-type', photo.mimeType)
        .header('content-disposition', 'inline')
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(photo.bytes));
    } catch (error) {
      if (error instanceof StorageObjectNotFoundError) {
        sendError(request, reply, 404, 'NOT_FOUND', 'Foto nicht gefunden.');
        return;
      }
      throw error;
    }
  });
}
