import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance } from 'fastify';
import { requireAuth, requirePermission, sendAuthError } from '../auth/http.ts';
import { AuthError, type StaffAuthService } from '../auth/service.ts';
import { ConversationService } from '../communication/conversation/conversation-service.ts';
import { ProcessService } from '../crm/process-service.ts';
import { getCompletedVisibilityDays } from '../crm/settings-service.ts';
import { buildVisibilityContext } from '../crm/visibility.ts';
import { UUID_PATTERN } from './auth.ts';

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });
const assignSchema = z.object({ processId: uuidSchema });

export interface CommunicationInboxRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  storage: StorageProvider;
}

/**
 * Phase 12 (Order §22/§36): Unmatched-Inbox („Mehr → Kommunikation → Nicht
 * zugeordnet“). Recht: `message.reply_customer` (administratives
 * Kommunikationsrecht „Kunden antworten“ – wer Kundennachrichten beantworten
 * darf, darf sie auch sichten und einem Vorgang zuordnen; `system.settings`
 * wäre reine Admin-Infrastruktur, `email.approve_prepared` betrifft nur
 * ausgehende Freigaben). Keine Mailbox-App: nur Absender, Betreff, Zeit,
 * Vorschau; Aktionen „zuordnen“ und „ignorieren“ – nie eine Fachmutation.
 */
export function registerCommunicationInboxRoutes(
  app: FastifyInstance,
  options: CommunicationInboxRouteOptions,
): void {
  const { db, auth, config, storage } = options;
  const conversations = new ConversationService(db, storage);
  const processService = new ProcessService(db);

  app.get('/staff/communication/unmatched', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'message.reply_customer'))) return;
    return { messages: await conversations.listUnmatched() };
  });

  app.post('/staff/communication/unmatched/:id/assign', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'message.reply_customer'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(assignSchema, request.body);
    try {
      // Zielvorgang muss für die handelnde Person sichtbar sein (gleiche
      // Sichtbarkeitsregel wie alle Vorgangsrouten; unsichtbar = neutrales 404).
      const effective = await auth.effectivePermissions(context.user.id);
      if (!effective.has('process.view_all')) {
        throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
      }
      const visibility = buildVisibilityContext(effective, await getCompletedVisibilityDays(db));
      await processService.getVisibleProcess(body.processId, visibility);
      await conversations.assignUnmatched(params.id, {
        processId: body.processId,
        staffUserId: context.user.id,
      });
      return { assigned: true, processId: body.processId };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/communication/unmatched/:id/ignore', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'message.reply_customer'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      await conversations.ignoreUnmatched(params.id, context.user.id);
      return { ignored: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });
}
