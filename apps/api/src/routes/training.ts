import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authErrorStatus, requireAuth, requirePermission, sendAuthError } from '../auth/http.ts';
import type { AuthenticatedContext, StaffAuthService } from '../auth/service.ts';
import type { TrainingCatalogSource } from '../training/catalog-sync.ts';
import { TrainingError } from '../training/errors.ts';
import type { TrainingService } from '../training/training-service.ts';
import { UUID_PATTERN } from './auth.ts';

/**
 * Phase 14 (Training, Order §52/§53/§68/§73/§85, Design §4.4): Trainings-
 * Routen unter `/staff/training`.
 *
 * - Alle Umgebungen: `GET /me` (eigene Zuweisungen, Katalog, laufende Versuche,
 *   außerhalb demo zusätzlich der eigene Gate-/Freigabestatus) und
 *   `GET /definitions` (aktiver Katalog).
 * - Nur APP_ENV=demo (sonst nicht registriert ⇒ 404): Versuche starten/lesen/
 *   prüfen und die Admin-Routen (`training.manage`): Übersicht, Mitarbeiter-
 *   detail, Katalog, Zuweisung, Training-Reset.
 * - Kein „Cheat Pass“ (§73): es gibt keinen Endpunkt, der einen Versuch direkt
 *   auf `passed` setzt – bestanden wird nur über Fachereignisse + Evaluator.
 * - IDOR (§85): fremde Versuche antworten neutral 404; `training.manage` sieht alle.
 * - Antworten enthalten ausschließlich Trainings-Metadaten (§54/§82).
 */

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });
const userParams = z.object({ userId: uuidSchema });
const keySchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'muss ein Katalog-Schlüssel sein');
const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'muss ein gültiger Zeitpunkt sein');

const startBody = z.strictObject({ definitionKey: keySchema });
const assignBody = z.strictObject({
  userId: uuidSchema,
  pathKey: keySchema,
  dueAt: isoDateTime.nullable().optional(),
});
const resetBody = z.strictObject({
  userId: uuidSchema,
  pathKey: keySchema.nullable().optional(),
  definitionKey: keySchema.nullable().optional(),
});

/** Live-Gate-Status eines Mitarbeiters (`TrainingGate.statusForUser`, Agent TRAINING-GATES) – nur außerhalb demo. */
export type TrainingGateStatusProvider = (userId: string) => Promise<readonly object[]>;

export interface TrainingRouteDeps {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  training: TrainingService;
  gateStatus?: TrainingGateStatusProvider | undefined;
  /** Review-Fix F6: Katalog-Sync (fail-soft beim Start) – wird vor jeder Route sichergestellt. */
  catalog?: TrainingCatalogSource | undefined;
}

/** TrainingError ⇒ Status des AuthError-Codes + stabiler Trainings-Code (Muster `sendTourError`). */
export function sendTrainingError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean {
  if (error instanceof TrainingError) {
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

export const TRAINING_CATALOG_UNAVAILABLE = {
  code: 'TRAINING_CATALOG_UNAVAILABLE',
  message: 'Der Trainingskatalog ist vorübergehend nicht verfügbar.',
} as const;

/**
 * Review-Fix F6: der Katalog-Sync beim Start ist fail-soft (die API startet auch
 * ohne erreichbare Datenbank); vor jeder Trainingsroute wird er bei Bedarf
 * nachgeholt (`ensureSynced`, memoisiert – nach Erfolg kostenlos). Schlägt er
 * erneut fehl ⇒ 503 ohne Interna (Log nur errorName). Ohne Quelle no-op.
 */
export async function requireTrainingCatalog(
  request: FastifyRequest,
  reply: FastifyReply,
  catalog: TrainingCatalogSource | undefined,
): Promise<boolean> {
  if (catalog === undefined) return true;
  try {
    await catalog.ensureSynced();
    return true;
  } catch (error) {
    request.log.warn(
      { errorName: error instanceof Error ? error.name : 'Error' },
      'Trainingskatalog nicht verfügbar – Trainingsroute antwortet 503',
    );
    void reply
      .status(503)
      .send({ error: { ...TRAINING_CATALOG_UNAVAILABLE, correlationId: request.id } });
    return false;
  }
}

export function registerTrainingRoutes(app: FastifyInstance, deps: TrainingRouteDeps): void {
  const { auth, config, training } = deps;
  const demo = config.appEnv === 'demo';
  // Review-Fix F6: Katalog muss vorliegen (Lazy Retry nach fehlgeschlagenem Start-Sync).
  const catalogReady = (request: FastifyRequest, reply: FastifyReply) =>
    requireTrainingCatalog(request, reply, deps.catalog);

  const effectiveFor = (context: AuthenticatedContext) =>
    auth.effectivePermissions(context.user.id);

  // ── Alle Umgebungen ──────────────────────────────────────────────────────

  app.get('/staff/training/me', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await catalogReady(request, reply))) return;
    const effective = await effectiveFor(context);
    const overview = await training.overviewForUser(context.user.id, effective);
    const gates =
      demo || deps.gateStatus === undefined ? [] : await deps.gateStatus(context.user.id);
    return { ...overview, gates };
  });

  app.get('/staff/training/definitions', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await catalogReady(request, reply))) return;
    const effective = await effectiveFor(context);
    return { definitions: await training.definitionsView(context.user.id, effective) };
  });

  if (!demo) return;

  // ── Nur demo: Versuche (eigene) ──────────────────────────────────────────

  app.post('/staff/training/attempts', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await catalogReady(request, reply))) return;
    const body = parseOrThrow(startBody, request.body);
    try {
      const effective = await effectiveFor(context);
      const result = await training.startAttempt(context.user.id, body.definitionKey, effective);
      return reply.status(result.created ? 201 : 200).send({ attempt: result.attempt });
    } catch (error) {
      if (sendTrainingError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/training/attempts/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await catalogReady(request, reply))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      const effective = await effectiveFor(context);
      return await training.attemptDetail(params.id, {
        userId: context.user.id,
        admin: effective.has('training.manage'),
      });
    } catch (error) {
      if (sendTrainingError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/training/attempts/:id/check', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await catalogReady(request, reply))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    try {
      return await training.checkAttempt(context.user.id, params.id);
    } catch (error) {
      if (sendTrainingError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Nur demo: Admin (training.manage) ────────────────────────────────────

  const requireTrainingManager = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<AuthenticatedContext | null> => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return null;
    if (!(await requirePermission(request, reply, auth, context, 'training.manage'))) return null;
    if (!(await catalogReady(request, reply))) return null;
    return context;
  };

  app.get('/staff/training/admin/overview', async (request, reply) => {
    const context = await requireTrainingManager(request, reply);
    if (context === null) return;
    return training.listOverview();
  });

  app.get('/staff/training/admin/users/:userId', async (request, reply) => {
    const context = await requireTrainingManager(request, reply);
    if (context === null) return;
    const params = parseOrThrow(userParams, request.params, 'params');
    try {
      // Rechte des betrachteten Mitarbeiters (für `permissionMissing` je Übung).
      const effective = await auth.effectivePermissions(params.userId);
      return await training.userDetail(params.userId, effective);
    } catch (error) {
      if (sendTrainingError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/staff/training/admin/paths', async (request, reply) => {
    const context = await requireTrainingManager(request, reply);
    if (context === null) return;
    return training.listPaths();
  });

  app.post('/staff/training/admin/assignments', async (request, reply) => {
    const context = await requireTrainingManager(request, reply);
    if (context === null) return;
    const body = parseOrThrow(assignBody, request.body);
    try {
      const assignment = await training.assign(
        context.user.id,
        {
          userId: body.userId,
          pathKey: body.pathKey,
          dueAt: body.dueAt === undefined || body.dueAt === null ? null : new Date(body.dueAt),
        },
        { sessionId: context.session.id },
      );
      return reply.status(201).send({ assignment });
    } catch (error) {
      if (sendTrainingError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/training/admin/reset', async (request, reply) => {
    const context = await requireTrainingManager(request, reply);
    if (context === null) return;
    const body = parseOrThrow(resetBody, request.body);
    try {
      return await training.resetProgress(
        context.user.id,
        {
          userId: body.userId,
          pathKey: body.pathKey ?? null,
          definitionKey: body.definitionKey ?? null,
        },
        { sessionId: context.session.id },
      );
    } catch (error) {
      if (sendTrainingError(request, reply, error)) return;
      throw error;
    }
  });
}
