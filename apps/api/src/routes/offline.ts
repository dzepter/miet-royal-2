import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
import {
  leaseRequestSchema,
  offlineEnvironmentSchema,
  packageRequestSchema,
  syncRequestSchema,
  type OfflineStatusResponse,
} from '@mietroyal/offline/shared';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { recordSecurityEvent } from '../auth/audit.ts';
import { requireAuth, sendAuthError, sendError } from '../auth/http.ts';
import type { StaffAuthService } from '../auth/service.ts';
import { DocumentService } from '../commerce/document-service.ts';
import { ProductService } from '../commerce/product-service.ts';
import { ProcessService } from '../crm/process-service.ts';
import { AssignmentService } from '../handover/assignment-service.ts';
import { HandoverService } from '../handover/handover-service.ts';
import { OfflineEnvironmentMismatchError, OfflineLeaseService } from '../offline/lease-service.ts';
import { OfflineLeaseRequiredError, OfflinePackageService } from '../offline/package-service.ts';
import { OfflineSyncService, SyncInProgressError } from '../offline/sync-service.ts';
import { DamageService } from '../returns/damage-service.ts';
import { ReturnService, type ReturnFinalizedListener } from '../returns/return-service.ts';
import { SchedulingService } from '../scheduling/scheduling-service.ts';
import { InventoryService } from '../warehouse/inventory-service.ts';
import { MachineService } from '../warehouse/machine-service.ts';
import type { CleaningEndedListener } from '../voucher/voucher-jobs.ts';
import { UUID_PATTERN } from './auth.ts';

/** Ein Request je Mutation; Fotos (≤ 6 MB) + Unterschrift Base64-kodiert (Order §§27/30). */
const SYNC_BODY_LIMIT = 12 * 1024 * 1024;

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const bookingParams = z.object({ bookingId: uuidSchema });
const secretQuery = z.object({ deviceId: uuidSchema, environment: offlineEnvironmentSchema });

interface OfflineRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  storage: StorageProvider;
  /** Phase 9: Nachlauf nach erfolgreicher Finalisierung (Abrechnung anlegen) – verdrahtet in app.ts. */
  finalizedListeners?: readonly ReturnFinalizedListener[];
  /** Phase 11: Reinigungsende ⇒ Gutschein-Prüfjob (Trigger B) – verdrahtet in app.ts. */
  cleaningEndedListener?: CleaningEndedListener;
}

/**
 * Offline-Endpunkte der Staff-PWA (Phase 8): Statusprüfung, 72-h-Lease,
 * Arbeitspaket, Einzel-Snapshot und Sync. Alle Endpunkte verlangen eine
 * gültige Session; außer dem Statusendpunkt auch eine entsperrte.
 */
export function registerOfflineRoutes(app: FastifyInstance, options: OfflineRouteOptions): void {
  const { db, auth, config, storage, cleaningEndedListener } = options;
  const machineService = new MachineService(db, storage, cleaningEndedListener);
  const assignments = new AssignmentService(db, machineService, storage);
  const inventory = new InventoryService(db);
  const documentService = new DocumentService(db, storage);
  const productService = new ProductService(db);
  const scheduling = new SchedulingService(db);
  const damages = new DamageService(db, storage);
  const handover = new HandoverService(
    db,
    storage,
    assignments,
    inventory,
    machineService,
    documentService,
    productService,
    scheduling,
    damages,
  );
  const returns = new ReturnService(
    db,
    storage,
    inventory,
    machineService,
    documentService,
    scheduling,
    damages,
    assignments,
    options.finalizedListeners ?? [],
  );
  const processes = new ProcessService(db);
  const leases = new OfflineLeaseService(db, config);
  const packages = new OfflinePackageService({
    db,
    auth,
    config,
    handover,
    returns,
    assignments,
    damages,
    machines: machineService,
    inventory,
    documents: documentService,
    leases,
  });
  const sync = new OfflineSyncService({
    db,
    auth,
    config,
    handover,
    returns,
    assignments,
    damages,
    processes,
    scheduling,
    machines: machineService,
    leases,
  });

  const handleOfflineError = async (
    request: FastifyRequest,
    reply: FastifyReply,
    error: unknown,
    actorUserId: string | null,
  ): Promise<boolean> => {
    if (error instanceof OfflineEnvironmentMismatchError) {
      // Harte Ablehnung (§76) – protokolliert ohne Fachdaten.
      await recordSecurityEvent(db, {
        type: 'offline.environment_mismatch',
        actorUserId,
        targetUserId: actorUserId,
        details: {
          clientEnvironment: error.clientEnvironment,
          serverEnvironment: config.appEnv,
        },
      });
      sendError(request, reply, 409, 'ENVIRONMENT_MISMATCH', error.message);
      return true;
    }
    if (error instanceof OfflineLeaseRequiredError) {
      sendError(request, reply, 409, 'OFFLINE_LEASE_REQUIRED', error.message);
      return true;
    }
    if (error instanceof SyncInProgressError) {
      reply.header('retry-after', '5');
      sendError(request, reply, 503, 'SYNC_IN_PROGRESS', error.message);
      return true;
    }
    return sendAuthError(request, reply, error);
  };

  /**
   * Konnektivitäts-/Statusprüfung (§78): authentifiziert, aber OHNE die
   * Aktivität zu verlängern (sonst würde ein Hintergrund-Ping die App-Sperre
   * aushebeln). Auch im gesperrten Zustand erreichbar, damit der Sperr-
   * bildschirm zwischen Online-/Offline-Entsperrung unterscheiden kann.
   */
  app.get('/staff/offline/status', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config, {
      allowLocked: true,
      touchActivity: false,
    });
    if (context === null) return;
    const response: OfflineStatusResponse = {
      online: true,
      appLocked: context.appLocked,
      serverTime: new Date().toISOString(),
      environment: config.appEnv,
    };
    return response;
  });

  // ── Lease (Order §8) ─────────────────────────────────────────────────────

  app.post('/staff/offline/lease', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const body = parseOrThrow(leaseRequestSchema, request.body);
    try {
      leases.assertEnvironment(body.environment);
      const effective = await auth.effectivePermissions(context.user.id);
      if (!leases.hasOfflineAccess(effective)) {
        sendError(
          request,
          reply,
          403,
          'FORBIDDEN',
          'Der Offlinebetrieb ist nur für Konten mit operativen Rechten verfügbar.',
        );
        return;
      }
      return await leases.issue(context, body.deviceId, body.environment, effective);
    } catch (error) {
      if (await handleOfflineError(request, reply, error, context.user.id)) return;
      throw error;
    }
  });

  app.get('/staff/offline/lease/secret', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const query = parseOrThrow(secretQuery, request.query, 'query');
    try {
      const secret = await leases.currentSecret(context.user.id, query.deviceId, query.environment);
      if (secret === null) {
        sendError(request, reply, 404, 'NOT_FOUND', 'Für dieses Gerät besteht kein Offline-Lease.');
        return;
      }
      return secret;
    } catch (error) {
      if (await handleOfflineError(request, reply, error, context.user.id)) return;
      throw error;
    }
  });

  app.post('/staff/offline/lease/revoke', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const body = parseOrThrow(leaseRequestSchema, request.body);
    try {
      const revoked = await leases.revokeForDevice(
        context.user.id,
        context.user.id,
        body.deviceId,
        body.environment,
        'logout',
      );
      return { revoked };
    } catch (error) {
      if (await handleOfflineError(request, reply, error, context.user.id)) return;
      throw error;
    }
  });

  // ── Arbeitspaket (Order §§9–12) ──────────────────────────────────────────

  app.post('/staff/offline/package', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const body = parseOrThrow(packageRequestSchema, request.body);
    try {
      return await packages.build(context, body);
    } catch (error) {
      if (await handleOfflineError(request, reply, error, context.user.id)) return;
      throw error;
    }
  });

  app.get('/staff/offline/bookings/:bookingId', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const params = parseOrThrow(bookingParams, request.params, 'params');
    try {
      return await packages.bookingSnapshotFor(context, params.bookingId);
    } catch (error) {
      if (await handleOfflineError(request, reply, error, context.user.id)) return;
      throw error;
    }
  });

  // ── Sync (Order §§27–33, 61–67) ──────────────────────────────────────────

  app.post('/staff/offline/sync', { bodyLimit: SYNC_BODY_LIMIT }, async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const body = parseOrThrow(syncRequestSchema, request.body);
    try {
      return await sync.process(context, body);
    } catch (error) {
      if (await handleOfflineError(request, reply, error, context.user.id)) return;
      throw error;
    }
  });
}
