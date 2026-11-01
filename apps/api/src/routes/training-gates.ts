import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authErrorStatus, requireAuth, requirePermission, sendAuthError } from '../auth/http.ts';
import type { StaffAuthService } from '../auth/service.ts';
import type { TrainingCatalogSource } from '../training/catalog-sync.ts';
import {
  TrainingGateAdminError,
  TrainingGateAdminService,
} from '../training/gate-admin-service.ts';
import { UUID_PATTERN } from './auth.ts';
import { requireTrainingCatalog } from './training.ts';

/**
 * Phase 14 (Design §4.4 „Nur außerhalb demo“, Order §67/§68, §98): Admin-
 * Routen der Live-Trainingssperren und Freigaben (`training.manage`). Werden
 * NUR außerhalb `APP_ENV=demo` registriert – in der Demo existieren sie nicht
 * (404), dort gibt es keine Live-Gate-Mutation. Diese Routen und alle Lese-
 * Routen werden NIE selbst gegated (§98/§99): Admin-Recovery bleibt möglich.
 */

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const definitionKeySchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_]*$/, 'ungültiger Übungsschlüssel');
const featureParams = z.object({ featureKey: z.string().min(1).max(100) });
const idParams = z.object({ id: uuidSchema });
const clearanceQuery = z.object({ userId: uuidSchema.optional() });

/** Strict: zusätzliche Felder (z. B. Demo-IDs) werden abgelehnt (§125 – keine Demo-Businessdaten). */
const gateBody = z.strictObject({ definitionKey: definitionKeySchema, enabled: z.boolean() });
const clearanceBody = z.strictObject({
  userId: uuidSchema,
  definitionKey: definitionKeySchema,
  source: z.enum(['verified_demo', 'override']),
  reason: z.string().max(1000).nullable().optional(),
  validUntil: z.iso.datetime({ offset: true }).nullable().optional(),
});

export interface TrainingGateRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  /** Test-Injection; Default: Service auf `db`/`config`. */
  admin?: TrainingGateAdminService;
  /** Review-Fix F6: Katalog-Sync (fail-soft beim Start) – wird vor jeder Route sichergestellt. */
  catalog?: TrainingCatalogSource | undefined;
}

/** Admin-Fehler mit Fachcode (409 TRAINING_DEFINITION_INACTIVE) – sonst sendAuthError. */
function sendTrainingAdminError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean {
  if (error instanceof TrainingGateAdminError) {
    void reply.status(authErrorStatus(error.code)).send({
      error: {
        code: error.trainingCode,
        message: error.message,
        correlationId: request.id,
        details: error.details,
      },
    });
    return true;
  }
  return sendAuthError(request, reply, error);
}

export function registerTrainingGateRoutes(
  app: FastifyInstance,
  options: TrainingGateRouteOptions,
): void {
  const { auth, config } = options;
  // Nie in der Demo (Order §68): keine Live-Gate-Mutation, Routen fehlen (404).
  if (config.appEnv === 'demo') return;
  const admin = options.admin ?? new TrainingGateAdminService(options.db, config);

  app.get('/staff/training/admin/gates', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'training.manage'))) return;
    if (!(await requireTrainingCatalog(request, reply, options.catalog))) return;
    return admin.listGates();
  });

  app.put('/staff/training/admin/gates/:featureKey', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'training.manage'))) return;
    if (!(await requireTrainingCatalog(request, reply, options.catalog))) return;
    const params = parseOrThrow(featureParams, request.params, 'params');
    const body = parseOrThrow(gateBody, request.body);
    try {
      const feature = await admin.setGate(context.user.id, params.featureKey, body);
      return { feature };
    } catch (error) {
      if (sendTrainingAdminError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/training/admin/clearances', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'training.manage'))) return;
    if (!(await requireTrainingCatalog(request, reply, options.catalog))) return;
    const query = parseOrThrow(clearanceQuery, request.query ?? {}, 'query');
    return { clearances: await admin.listClearances(query.userId) };
  });

  app.post('/staff/training/admin/clearances', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'training.manage'))) return;
    if (!(await requireTrainingCatalog(request, reply, options.catalog))) return;
    const body = parseOrThrow(clearanceBody, request.body);
    try {
      const result = await admin.grantClearance(context.user.id, {
        userId: body.userId,
        definitionKey: body.definitionKey,
        source: body.source,
        reason: body.reason ?? null,
        validUntil:
          body.validUntil === undefined || body.validUntil === null
            ? null
            : new Date(body.validUntil),
      });
      void reply.status(result.created ? 201 : 200);
      return { clearance: result.clearance, created: result.created };
    } catch (error) {
      if (sendTrainingAdminError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/training/admin/clearances/:id/revoke', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'training.manage'))) return;
    if (!(await requireTrainingCatalog(request, reply, options.catalog))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const result = await admin.revokeClearance(context.user.id, params.id);
      return { clearance: result.clearance, revoked: result.revoked };
    } catch (error) {
      if (sendTrainingAdminError(request, reply, error)) return;
      throw error;
    }
  });
}
