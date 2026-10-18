import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { JobQueue, StorageProvider } from '@mietroyal/integrations';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AccountingGateway } from '../accounting/gateway.ts';
import type { AccountingTransferService } from '../accounting/transfer-service.ts';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
import type { AuthenticatedContext, StaffAuthService } from '../auth/service.ts';
import {
  CancellationBlockedError,
  FollowUpExistsError,
  createCancellationService,
  type CancellationService,
  type CancellationViewer,
} from '../cancellation/cancellation-service.ts';
import type { CancellationConfirmationMailer } from '../communication/transactional/mailers.ts';
import { ProcessService } from '../crm/process-service.ts';
import { getCompletedVisibilityDays } from '../crm/settings-service.ts';
import { buildVisibilityContext } from '../crm/visibility.ts';
import { UUID_PATTERN } from './auth.ts';

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });
/**
 * Der Client bestätigt nur – Prozentsatz, Basis, Gebühr, Status oder
 * Zeitpunkt sind serverseitig berechnet und werden als unbekannte Felder
 * abgewiesen (strictObject ⇒ 400; Tests 143/144).
 */
const cancelBody = z.strictObject({ confirm: z.literal(true) });
const emptyBody = z.strictObject({}).optional();

export interface CancellationRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  storage: StorageProvider;
  queue: JobQueue;
  accountingGateway: AccountingGateway;
  transfers: AccountingTransferService;
  /** Phase 12 (Order §14): Stornobestätigung über die Mail-Outbox (ohne Mailer: blocked). */
  confirmations?: CancellationConfirmationMailer;
  /** Optional geteilte Instanz (z. B. mit der Legacy-Storno-Route). */
  cancellationService?: CancellationService;
}

/** Fachliche Fehlerklassen auf sprechende Codes abbilden (sonst sendAuthError). */
export function sendCancellationError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean {
  if (error instanceof CancellationBlockedError) {
    sendError(request, reply, 409, 'CANCELLATION_BLOCKED', error.message);
    return true;
  }
  if (error instanceof FollowUpExistsError) {
    sendError(request, reply, 409, 'FOLLOW_UP_EXISTS', error.message);
    return true;
  }
  return sendAuthError(request, reply, error);
}

/**
 * Storno-/Folgevorgangs-Routen (Phase 9 §§49–§64). Alle Routen verlangen
 * die Sichtbarkeit des Vorgangs (Phase-2-Regel; fremde/unsichtbare IDs ⇒
 * neutrales 404, Tests 136/137).
 */
export function registerCancellationRoutes(
  app: FastifyInstance,
  options: CancellationRouteOptions,
): void {
  const { db, auth, config, storage, transfers } = options;
  const service =
    options.cancellationService ??
    createCancellationService({
      db,
      config,
      storage,
      transfers,
      ...(options.confirmations === undefined ? {} : { confirmations: options.confirmations }),
      logger: app.log,
    });
  const processService = new ProcessService(db);

  const viewerFor = async (context: AuthenticatedContext): Promise<CancellationViewer> => ({
    permissions: await auth.effectivePermissions(context.user.id),
    isAdmin: await auth.isSystemAdmin(context.user.id),
  });

  /** Zentrale Vorgangs-Sichtbarkeit – unsichtbar = neutrales 404. */
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

  /** Stornierung laden + Sichtbarkeit des Vorgangs (IDOR-Schutz, Test 136). */
  const visibleCancellation = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    cancellationId: string,
  ) => {
    if (!(await requirePermission(request, reply, auth, context, 'process.view_all'))) return null;
    const row = await service.byId(cancellationId);
    if (row === null) {
      sendError(request, reply, 404, 'NOT_FOUND', 'Stornierung nicht gefunden.');
      return null;
    }
    if (!(await requireVisibleProcess(request, reply, context, row.processId))) return null;
    return row;
  };

  // ── Vorschau / Storno / Ansicht ─────────────────────────────────────────

  app.get('/staff/processes/:id/cancellation/preview', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    // PERMISSIONS.md: Vorschau mit booking.cancel ODER settlement.view.
    const effective = await auth.effectivePermissions(context.user.id);
    if (!effective.has('booking.cancel') && !effective.has('settlement.view')) {
      sendError(
        request,
        reply,
        403,
        'FORBIDDEN',
        'Dafür fehlt dir die erforderliche Berechtigung.',
      );
      return;
    }
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    try {
      return await service.preview(params.id);
    } catch (error) {
      if (sendCancellationError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/processes/:id/cancellation', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'booking.cancel'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    parseOrThrow(cancelBody, request.body);
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    try {
      const viewer = await viewerFor(context);
      return await service.cancel(
        params.id,
        { id: context.user.id, type: viewer.isAdmin ? 'admin' : 'employee' },
        viewer,
      );
    } catch (error) {
      if (sendCancellationError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/processes/:id/cancellation', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    try {
      return await service.viewForProcess(params.id, await viewerFor(context));
    } catch (error) {
      if (sendCancellationError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Buchhaltung / Bestätigung ───────────────────────────────────────────

  app.post('/staff/cancellations/:id/transfer', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    parseOrThrow(emptyBody, request.body);
    const row = await visibleCancellation(request, reply, context, params.id);
    if (row === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'lexware.manual_transfer')))
      return;
    try {
      return await service.transfer(row.id, await viewerFor(context));
    } catch (error) {
      if (sendCancellationError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/cancellations/:id/confirmation/send', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    parseOrThrow(emptyBody, request.body);
    const row = await visibleCancellation(request, reply, context, params.id);
    if (row === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'email.approve_prepared'))) return;
    try {
      return await service.sendConfirmation(row.id);
    } catch (error) {
      if (sendCancellationError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Folgevorgang (Order §64) ────────────────────────────────────────────

  app.post('/staff/processes/:id/follow-up', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    parseOrThrow(emptyBody, request.body);
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    if (!(await requirePermission(request, reply, auth, context, 'process.create'))) return;
    try {
      return await service.createFollowUp(params.id, context.user.id);
    } catch (error) {
      if (sendCancellationError(request, reply, error)) return;
      throw error;
    }
  });
}
