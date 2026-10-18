/**
 * Phase 12 (reminders): öffentliche Kunden-Aktionslinks (Order §20) und
 * Staff-Aktionen „Kunden über Terminänderung informieren“ (Order §19) sowie
 * Einsicht der vom Kunden gepflegten Kontakte.
 *
 * Öffentlich (`/public/actions/:token`, `publicLimit`, Pfad im Log maskiert):
 * - GET  ⇒ { action: { purpose, processNumber, appointmentAt, appointmentEndAt,
 *            current: { firstName, lastName, phone } | null } } – Datenminimierung:
 *            keine weiteren Kundendaten.
 * - POST { firstName, lastName, phone } ⇒ { action } (aktueller Stand).
 * Jede Unbrauchbarkeit des Links (unbekannt, abgelaufen, widerrufen, falscher
 * Zweck, Cutoff ab 1 h vor Termin, Termin/Vorgang storniert) ⇒ IMMER dasselbe
 * neutrale 404; auch syntaktisch ungültige Tokens (kein 400 – kein Orakel).
 */
import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
import type { AuthenticatedContext, StaffAuthService } from '../auth/service.ts';
import { AuthError } from '../auth/service.ts';
import type { CustomerActionLinkService } from '../communication/action-links/service.ts';
import type { AppointmentCustomerInfoService } from '../communication/reminders/service.ts';
import { ProcessService } from '../crm/process-service.ts';
import { getCompletedVisibilityDays } from '../crm/settings-service.ts';
import { buildVisibilityContext } from '../crm/visibility.ts';
import { SchedulingService } from '../scheduling/scheduling-service.ts';
import { UUID_PATTERN } from './auth.ts';

const idParams = z.object({ id: z.string().regex(UUID_PATTERN, 'muss eine UUID sein') });
const NEUTRAL_MESSAGE = 'Dieser Link ist nicht verfügbar.';

export interface CommunicationActionRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  rateLimitEnabled: boolean;
  actionLinks: CustomerActionLinkService;
  appointmentInfo: AppointmentCustomerInfoService;
}

export function registerCommunicationActionRoutes(
  app: FastifyInstance,
  options: CommunicationActionRouteOptions,
): void {
  const { db, auth, config, actionLinks, appointmentInfo } = options;
  const scheduling = new SchedulingService(db);
  const processService = new ProcessService(db);

  const publicLimit = (max: number) =>
    options.rateLimitEnabled
      ? {
          rateLimit: {
            max,
            timeWindow: '1 minute',
            keyGenerator: (request: FastifyRequest) => request.ip,
          },
        }
      : false;

  const tokenOf = (request: FastifyRequest): string => {
    const params = request.params as { token?: unknown } | null;
    return typeof params?.token === 'string' ? params.token : '';
  };

  // ── Öffentliche Aktionslinks (Order §20) ────────────────────────────────

  app.get('/public/actions/:token', { config: publicLimit(60) }, async (request, reply) => {
    void reply.header('cache-control', 'private, no-store');
    const action = await actionLinks.resolve(tokenOf(request));
    if (action === null) {
      sendError(request, reply, 404, 'NOT_FOUND', NEUTRAL_MESSAGE);
      return;
    }
    return { action };
  });

  app.post('/public/actions/:token', { config: publicLimit(10) }, async (request, reply) => {
    void reply.header('cache-control', 'private, no-store');
    try {
      const action = await actionLinks.submit(tokenOf(request), request.body);
      if (action === null) {
        sendError(request, reply, 404, 'NOT_FOUND', NEUTRAL_MESSAGE);
        return;
      }
      return { action };
    } catch (error) {
      if (error instanceof AuthError && error.code === 'VALIDATION') {
        sendError(request, reply, 400, 'VALIDATION', error.message);
        return;
      }
      throw error;
    }
  });

  // ── Staff: Kunden über Terminänderung informieren (Order §19) ───────────

  /** Terminsichtbarkeit wie routes/scheduling.ts (calendar.view_all oder eigener/effektiver Termin). */
  const requireVisibleAppointment = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    appointmentId: string,
  ): Promise<boolean> => {
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      if (effective.has('calendar.view_all')) return true;
      const entry = await scheduling.entryById(appointmentId);
      if (entry.assignedUserId === context.user.id || entry.effectiveAssigneeId === context.user.id)
        return true;
      sendError(request, reply, 404, 'NOT_FOUND', 'Termin nicht gefunden.');
      return false;
    } catch (error) {
      if (sendAuthError(request, reply, error)) return false;
      throw error;
    }
  };

  app.post('/staff/appointments/:id/inform-customer', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    // Bewusste Freigabe einer vorbereiteten Kundenmail (wie Stornobestätigung).
    if (!(await requirePermission(request, reply, auth, context, 'email.approve_prepared'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleAppointment(request, reply, context, params.id))) return;
    try {
      const result = await appointmentInfo.informCustomer(context.user.id, params.id);
      // „informed“ nur, wenn eine Zustellung neu eingeplant ist oder noch läuft –
      // nie bei bereits gesendeter oder unklarer Zustellung.
      const informed =
        result.status === 'pending' &&
        result.existingStatus !== 'sent' &&
        result.existingStatus !== 'outcome_unknown';
      return { ...result, informed };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Staff: vom Kunden gepflegte Kontakte (Abholperson / Kontakt vor Ort) ─

  app.get('/staff/processes/:id/customer-contacts', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      const visibility = buildVisibilityContext(effective, await getCompletedVisibilityDays(db));
      await processService.getVisibleProcess(params.id, visibility);
      return { contacts: await actionLinks.contactsForProcess(params.id) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });
}
