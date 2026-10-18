/**
 * Phase 12 (mail): Admin-Status/-Aktionen der Kommunikation (system.settings,
 * Order §35) und der kompakte Kommunikationsstatus je Vorgang (Vorgangs-
 * sichtbarkeit wie die übrigen Prozessrouten). Keine Antwort enthält
 * Passwörter, Token, Private Keys, Secret-Payloads oder Mailinhalte.
 */
import type { AppConfig } from '@mietroyal/config';
import { inboundMailState, pushSubscriptions, type Database } from '@mietroyal/database';
import { parseOrThrow, z } from '@mietroyal/validation';
import { count, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, requirePermission, sendAuthError } from '../auth/http.ts';
import type { StaffAuthService } from '../auth/service.ts';
import type { CommunicationContext } from '../communication/context.ts';
import { ProcessService } from '../crm/process-service.ts';
import { getCompletedVisibilityDays } from '../crm/settings-service.ts';
import { buildVisibilityContext } from '../crm/visibility.ts';
import { whatsappStatusSummary } from '../communication/whatsapp/status.ts';
import { UUID_PATTERN } from './auth.ts';

/** WhatsApp-Kennzahlen für die Admin-Statusseite – keine Telefonnummern/Inhalte/Secrets. */
async function whatsappStatusForAdmin(db: Database, config: AppConfig) {
  const summary = await whatsappStatusSummary(db, config);
  return {
    mode: summary.mode,
    label: summary.label,
    graphApiVersion: summary.graphApiVersion,
    lastInboundAt: summary.lastInboundAt?.toISOString() ?? null,
    eventsLast24h: summary.eventsLast24h,
    contactsWithOpenWindow: summary.contactsWithOpenWindow,
  };
}

export interface CommunicationAdminRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  communication: CommunicationContext;
}

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });
const listQuery = z.object({
  status: z
    .enum(['pending', 'sending', 'sent', 'retry', 'failed', 'blocked', 'outcome_unknown'])
    .optional(),
  processId: uuidSchema.optional(),
});

export function registerCommunicationAdminRoutes(
  app: FastifyInstance,
  options: CommunicationAdminRouteOptions,
): void {
  const { db, auth, config, communication } = options;
  const processService = new ProcessService(db);

  const requireSettings = async (request: FastifyRequest, reply: FastifyReply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return null;
    if (!(await requirePermission(request, reply, auth, context, 'system.settings'))) return null;
    return context;
  };

  app.get('/staff/communication/status', async (request, reply) => {
    if ((await requireSettings(request, reply)) === null) return;
    const imapRows = await db.select().from(inboundMailState).limit(1);
    const imap = imapRows[0];
    const devices = await db
      .select({ value: count() })
      .from(pushSubscriptions)
      .where(isNull(pushSubscriptions.disabledAt));
    return {
      environment: config.appEnv,
      mail: {
        enabled: config.mail.enabled,
        gateway: communication.mailGateway.kind,
        smtpHost: config.mail.smtp?.host ?? null,
        smtpPort: config.mail.smtp?.port ?? null,
        smtpTls: config.mail.smtp?.tls ?? null,
        fromName: config.mail.fromName,
        fromAddress: config.mail.fromAddress,
        replyAddress: config.mail.replyAddress,
        publicWebBaseUrl: config.mail.publicWebBaseUrl,
        demoWhitelistCount: config.mail.demoWhitelist.length,
      },
      imap: {
        configured: config.mail.imap !== null,
        host: config.mail.imap?.host ?? null,
        folder: config.mail.imap?.folder ?? null,
        lastPollAt: imap?.lastPollAt?.toISOString() ?? null,
        lastSuccessAt: imap?.lastSuccessAt?.toISOString() ?? null,
        lastErrorCode: imap?.lastErrorCode ?? null,
      },
      whatsapp: await whatsappStatusForAdmin(db, config),
      push: {
        enabled: config.push.enabled,
        vapidPublicKey: config.push.vapidPublicKey,
        activeDevices: devices[0]?.value ?? 0,
      },
    };
  });

  app.post('/staff/communication/mail/check', async (request, reply) => {
    if ((await requireSettings(request, reply)) === null) return;
    const result = await communication.mailGateway.verify();
    return { ok: result.ok, code: result.code, gateway: communication.mailGateway.kind };
  });

  app.get('/staff/communication/deliveries', async (request, reply) => {
    if ((await requireSettings(request, reply)) === null) return;
    const query = parseOrThrow(listQuery, request.query, 'query');
    return { deliveries: await communication.outbox.list(query) };
  });

  app.post('/staff/communication/deliveries/:id/resend', async (request, reply) => {
    const context = await requireSettings(request, reply);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const result = await communication.outbox.resend(params.id, context.user.id);
      return {
        deliveryId: result.deliveryId,
        status: result.status,
        messageId: result.messageId,
      };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /** Kompakter Kommunikationsstatus je Vorgang (letzte Zustellung je Art). */
  app.get('/staff/processes/:id/communication-status', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      const visibility = buildVisibilityContext(effective, await getCompletedVisibilityDays(db));
      await processService.getVisibleProcess(params.id, visibility);
      return {
        mailConfigured: communication.mailGateway.kind !== 'disabled',
        deliveries: await communication.outbox.latestPerKindForProcess(params.id),
      };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });
}
