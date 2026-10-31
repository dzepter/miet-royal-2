import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import { berlinDateOf, berlinStartOfDay } from '@mietroyal/domain';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
// Phase 14 (training gate): Live-Trainingssperre (Order §56–§66) – nach Rechten, vor der Fachaktion.
import { requireTrainingGate } from '../training/gate-http.ts';
import { createNoopTrainingGate, type TrainingGate } from '../training/gate-service.ts';
// Phase 14 (training): Tour-Ereignisse NACH erfolgreichem Fachcommit (Order §41/§42, §77).
import { createNoopTrainingRecorder, type TrainingEventRecorder } from '../training/recorder.ts';
import type { AuthenticatedContext, StaffAuthService } from '../auth/service.ts';
import { RoutingError, type RoutingGateway } from '../routing/types.ts';
import type { AppointmentChangeListener } from '../scheduling/hooks.ts';
import { SchedulingService } from '../scheduling/scheduling-service.ts';
import { TOUR_MESSAGES, TourError } from '../tours/errors.ts';
import { PlanningService } from '../tours/planning-service.ts';
import type { LoadedTour, TourService } from '../tours/tour-service.ts';
import type { TourDelaySource } from '../tours/live/delay-state.ts';
import type { OperativeAddressResolver, TourGeocodingResolver } from '../tours/types.ts';
import { buildTourView, buildTourViews, type TourViewDeps } from '../tours/views.ts';
import { UUID_PATTERN } from './auth.ts';

/**
 * Phase 13 (Design §8): Tour-Routen. Rechte (kein neues Recht, Order §28):
 * calendar.view ⇒ eigene/effektive Touren; calendar.view_all ⇒ alle;
 * calendar.manage ⇒ anlegen/bearbeiten/planen/starten/beenden aller;
 * Fahrer (gespeichert oder Vertretung) ⇒ start/end/arrived/recalculate der
 * eigenen Tour; appointment.assign ⇒ Übernahme. Fremde Touren: neutral 404.
 */

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });
const stopParams = z.object({ id: uuidSchema, stopId: uuidSchema });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'muss ein Datum (JJJJ-MM-TT) sein');
const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'muss ein gültiger Zeitpunkt sein')
  .refine((value) => {
    const year = new Date(value).getUTCFullYear();
    return year >= 2020 && year <= 2100;
  }, 'liegt außerhalb des fachlich möglichen Zeitraums (2020–2100)');
const version = z.number().int().min(1);

const createBody = z.object({ tourDate: isoDate, assignedUserId: uuidSchema });
const addStopBody = z.object({
  appointmentId: uuidSchema,
  expectedVersion: version.optional(),
  reassign: z.boolean().optional(),
});
const versionBody = z.object({ expectedVersion: version.optional() }).optional();
const orderBody = z.object({
  expectedVersion: version.optional(),
  order: z.array(uuidSchema).max(200),
});
const stopPatchBody = z.object({
  expectedVersion: version.optional(),
  isPinned: z.boolean().optional(),
  bufferMinutes: z.number().int().min(0).max(240).optional(),
});
const proposeBody = z.object({ departureAt: isoDateTime.optional() }).optional();
const applyBody = z.object({
  expectedVersion: version,
  order: z.array(uuidSchema).max(200),
  departureAt: isoDateTime.optional(),
});
const evaluateBody = z.object({ expectedVersion: version, departureAt: isoDateTime.optional() });
// Phase 13 (Fix F4): Restroute nur mit Version (Provider-Ergebnis nie auf veraltete Version).
const recalculateBody = z.object({ expectedVersion: version });
const endBody = z
  .object({ force: z.boolean().optional(), reason: z.string().max(500).optional() })
  .optional();
const confirmBody = z.object({ cacheId: uuidSchema, candidateRef: z.string().min(1).max(200) });

const AUTH_STATUS: Record<string, number> = {
  VALIDATION: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
};

export interface TourRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  tours: TourService;
  routing: RoutingGateway;
  geocoding: TourGeocodingResolver;
  addresses: OperativeAddressResolver;
  /** Phase 13 (tours-live): Bewertungsstand der Verspätungsprognose für die View (optional). */
  delay?: TourDelaySource | undefined;
  /** Phase 14 (training gate): Live-Trainingssperre `tour.start` / `tour.takeover` (Default: Noop). */
  trainingGate?: TrainingGate;
  /** Phase 14 (training): Recorder für `tour.planned|ready|started|completed` (demo), Default Noop. */
  trainingRecorder?: TrainingEventRecorder;
}

/** Tour-Fehler mit stabilem Code (409/400/403/404), Routing-Fehler 503/409 – nie Provider-Details. */
export function sendTourError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean {
  if (error instanceof TourError) {
    void reply.status(AUTH_STATUS[error.code] ?? 409).send({
      error: {
        code: error.tourCode,
        message: error.message,
        correlationId: request.id,
        details: error.details,
      },
    });
    return true;
  }
  if (error instanceof RoutingError) {
    if (error.kind === 'disabled') {
      sendError(request, reply, 409, 'ROUTING_DISABLED', TOUR_MESSAGES.ROUTING_DISABLED);
    } else {
      sendError(request, reply, 503, 'ROUTING_UNAVAILABLE', TOUR_MESSAGES.ROUTING_UNAVAILABLE);
    }
    return true;
  }
  return sendAuthError(request, reply, error);
}

export function registerTourRoutes(app: FastifyInstance, options: TourRouteOptions): void {
  const { db, auth, config, tours } = options;
  const trainingGate = options.trainingGate ?? createNoopTrainingGate(); // Phase 14 (training gate)
  const trainingRecorder = options.trainingRecorder ?? createNoopTrainingRecorder(); // Phase 14 (training)
  const planning = new PlanningService(
    db,
    tours,
    options.routing,
    options.geocoding,
    options.addresses,
  );
  const scheduling = new SchedulingService(db);
  const viewDeps: TourViewDeps = {
    db,
    tours,
    addresses: options.addresses,
    geocoding: options.geocoding,
    delay: options.delay, // Phase 13 (tours-live)
  };

  const viewerOf = async (context: AuthenticatedContext) => ({
    userId: context.user.id,
    permissions: await auth.effectivePermissions(context.user.id),
  });

  /** Sichtbare Tour laden – fremde IDs neutral 404 (kein Existenz-Orakel). */
  const loadVisible = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    tourId: string,
  ): Promise<LoadedTour | null> => {
    try {
      // Phase 13 (Fix N4): Sichtbarkeit zuerst an der ungesperrten Zeile prüfen –
      // der 404-Pfad fremder Nutzer löst keine Heilung/Sperre aus.
      const tour = await tours.byId(tourId);
      const effective = await auth.effectivePermissions(context.user.id);
      if (await tours.canView(tour, context.user.id, effective)) return await tours.load(tourId);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'NOT_FOUND')) throw error;
    }
    sendError(request, reply, 404, 'NOT_FOUND', 'Tour nicht gefunden.');
    return null;
  };

  const requireManage = (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
  ) => requirePermission(request, reply, auth, context, 'calendar.manage');

  /** Operative Aktion: calendar.manage ODER Fahrer (gespeichert/effektiv) der Tour. */
  const requireManageOrDriver = async (
    request: FastifyRequest,
    reply: FastifyReply,
    context: AuthenticatedContext,
    loaded: LoadedTour,
  ): Promise<boolean> => {
    const effective = await auth.effectivePermissions(context.user.id);
    if (effective.has('calendar.manage')) return true;
    if (await tours.isDriver(loaded.tour, context.user.id)) return true;
    sendError(request, reply, 403, 'FORBIDDEN', 'Dafür fehlt dir die erforderliche Berechtigung.');
    return false;
  };

  const respondTour = async (context: AuthenticatedContext, tourId: string) => ({
    tour: await buildTourView(viewDeps, await tours.load(tourId), await viewerOf(context)),
  });

  // ── Lesen ────────────────────────────────────────────────────────────────

  app.get('/staff/tours', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const query = parseOrThrow(z.object({ date: isoDate.optional() }), request.query, 'query');
    const viewer = await viewerOf(context);
    const scope =
      viewer.permissions.has('calendar.view_all') || viewer.permissions.has('calendar.manage')
        ? 'all'
        : 'mine';
    const date = query.date ?? berlinDateOf(new Date());
    const all = await tours.listForDate(date);
    const visible: LoadedTour[] = [];
    for (const loaded of all) {
      if (
        scope === 'all' ||
        (await tours.canView(loaded.tour, viewer.userId, viewer.permissions))
      ) {
        visible.push(loaded);
      }
    }
    return { scope, date, tours: await buildTourViews(viewDeps, visible, viewer) };
  });

  app.get('/staff/tours/active', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    // Phase 13 Final (§7) / Corr (§2): zentrale Auflösung `resolveActiveToursFor` –
    // keine eigene length-Semantik. `single` ⇒ `tour`; `conflict` ⇒ `tour` ist die
    // erste in deterministischer Reihenfolge (started_at, id) UND `conflict` nennt
    // alle betroffenen Touren (jede einzeln über ihre ID erreichbar; nichts wird
    // automatisch beendet oder übertragen) – die Konfliktanzeige bleibt (M14).
    const resolution = await tours.resolveActiveToursFor(context.user.id);
    if (resolution.kind === 'none') return { tour: null, conflict: null };
    const active = resolution.kind === 'single' ? [resolution.tour] : resolution.tours;
    const views = await buildTourViews(viewDeps, active, await viewerOf(context));
    return {
      tour: views[0]!,
      conflict:
        resolution.kind === 'single'
          ? null
          : {
              tours: views.map((view) => ({
                id: view.id,
                tourDate: view.tourDate,
                assignedUserId: view.assignedUserId,
                assignedName: view.assignedName,
                effectiveDriverId: view.effectiveDriverId,
                effectiveDriverName: view.effectiveDriverName,
                substituted: view.substituted,
                startedAt: view.startedAt,
              })),
            },
    };
  });

  app.get('/staff/tours/:id', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    return { tour: await buildTourView(viewDeps, loaded, await viewerOf(context)) };
  });

  /** Verfügbare Stopps des Tourtags (nicht in offener Tour) mit Zuständigkeitshinweis. */
  app.get('/staff/tours/:id/candidates', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireManage(request, reply, context))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    const dayStart = berlinStartOfDay(loaded.tour.tourDate);
    const nextDayStart = berlinStartOfDay(
      berlinDateOf(new Date(dayStart.getTime() + 36 * 3600_000)),
    );
    const dayEntries = await scheduling.listCalendar(context.user.id, {
      from: dayStart,
      to: nextDayStart,
      scope: 'all',
    });
    const unplanned = (await scheduling.listOrganizationalOpen(context.user.id, 'all')).filter(
      (entry) => entry.startAt === null,
    );
    const planned = await tours.plannedAppointmentIds();
    const seen = new Set<string>();
    const appointments = [...dayEntries, ...unplanned]
      .filter((entry) => entry.status === 'scheduled' && !planned.has(entry.id))
      .filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)))
      .map((entry) => {
        const assignment: 'unassigned' | 'tour_driver' | 'other' =
          entry.assignedUserId === null
            ? 'unassigned'
            : entry.assignedUserId === loaded.tour.assignedUserId ||
                entry.effectiveAssigneeId === loaded.tour.assignedUserId
              ? 'tour_driver'
              : 'other';
        // Datenminimal: keine Telefonnummer in der Kandidatenliste.
        const { customerPhone: _phone, ...rest } = entry;
        return { ...rest, assignment };
      });
    return { appointments };
  });

  // ── Anlegen / Stopps / Reihenfolge (calendar.manage) ─────────────────────

  app.post('/staff/tours', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireManage(request, reply, context))) return;
    const body = parseOrThrow(createBody, request.body);
    try {
      const tour = await tours.create(context.user.id, body);
      return await respondTour(context, tour.id);
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/tours/:id/stops', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireManage(request, reply, context))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(addStopBody, request.body);
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      await tours.addStop(context.user.id, params.id, body, effective);
      return await respondTour(context, params.id);
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  app.delete('/staff/tours/:id/stops/:stopId', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireManage(request, reply, context))) return;
    const params = parseOrThrow(stopParams, request.params, 'params');
    const body = parseOrThrow(versionBody, request.body ?? undefined) ?? {};
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    try {
      await tours.removeStop(context.user.id, params.id, params.stopId, body);
      return await respondTour(context, params.id);
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/tours/:id/stops/order', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireManage(request, reply, context))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(orderBody, request.body);
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    try {
      await tours.reorder(context.user.id, params.id, body);
      return await respondTour(context, params.id);
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  app.patch('/staff/tours/:id/stops/:stopId', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireManage(request, reply, context))) return;
    const params = parseOrThrow(stopParams, request.params, 'params');
    const body = parseOrThrow(stopPatchBody, request.body);
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    try {
      await tours.updateStop(context.user.id, params.id, params.stopId, body);
      return await respondTour(context, params.id);
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Planung (Design §6) ──────────────────────────────────────────────────

  app.post('/staff/tours/:id/plan/propose', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireManage(request, reply, context))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(proposeBody, request.body ?? undefined) ?? {};
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    try {
      return await planning.propose(params.id, {
        departureAt: body.departureAt === undefined ? undefined : new Date(body.departureAt),
      });
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/tours/:id/plan/apply', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireManage(request, reply, context))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(applyBody, request.body);
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    try {
      const result = await planning.apply(params.id, context.user.id, {
        expectedVersion: body.expectedVersion,
        order: body.order,
        departureAt: body.departureAt === undefined ? undefined : new Date(body.departureAt),
      });
      // Phase 14 (training): nur eine umsetzbare Planung zählt.
      if (result.tour.tour.planningStatus === 'planned') {
        await trainingRecorder.record({
          actorUserId: context.user.id,
          eventKey: 'tour.planned',
          subjectRef: params.id,
        });
      }
      return {
        tour: await buildTourView(viewDeps, result.tour, await viewerOf(context)),
        plan: result.plan,
      };
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/tours/:id/plan/evaluate', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireManage(request, reply, context))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(evaluateBody, request.body);
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    try {
      const result = await planning.evaluate(params.id, context.user.id, {
        expectedVersion: body.expectedVersion,
        departureAt: body.departureAt === undefined ? undefined : new Date(body.departureAt),
      });
      // Phase 14 (training): nur eine umsetzbare Planung zählt.
      if (result.tour.tour.planningStatus === 'planned') {
        await trainingRecorder.record({
          actorUserId: context.user.id,
          eventKey: 'tour.planned',
          subjectRef: params.id,
        });
      }
      return {
        tour: await buildTourView(viewDeps, result.tour, await viewerOf(context)),
        plan: result.plan,
      };
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/tours/:id/plan/recalculate', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    if (!(await requireManageOrDriver(request, reply, context, loaded))) return;
    // Phase 13 (Fix F4): expectedVersion ist Pflicht (CAS, Order §62) – nach der
    // Sichtbarkeitsprüfung geparst, damit fremde IDs weiterhin neutral 404 liefern.
    const body = parseOrThrow(recalculateBody, request.body ?? {});
    try {
      const result = await planning.recalculate(params.id, context.user.id, body);
      return {
        tour: await buildTourView(viewDeps, result.tour, await viewerOf(context)),
        plan: result.plan,
      };
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  /** Bewusste Staff-Auswahl eines Geocoding-Kandidaten – nur für Adressen DIESER Tour (IDOR). */
  app.post('/staff/tours/:id/geocoding/confirm', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireManage(request, reply, context))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(confirmBody, request.body);
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    if (options.geocoding.confirmCandidate === undefined) {
      sendError(
        request,
        reply,
        409,
        'GEOCODING_CONFIRM_UNAVAILABLE',
        'Die Adressbestätigung ist derzeit nicht verfügbar.',
      );
      return;
    }
    try {
      const now = new Date();
      const texts = new Set<string>();
      const depot = await options.addresses.getDepotAddress(db);
      if (depot.text !== null) texts.add(depot.text);
      for (const entry of loaded.stops) {
        const address = await options.addresses.resolveOperativeAddress(db, entry.appointment);
        if (address.text !== null) texts.add(address.text);
      }
      // Phase 13 (Fix N5): nur der Cache-Stand (peekCached) – die Bestätigung löst
      // keine Provider-Aufrufe/Credits für die übrigen Touradressen aus.
      const peek = options.geocoding.peekCached;
      let allowed = false;
      for (const text of texts) {
        const resolution =
          peek === undefined
            ? await options.geocoding.resolve(text, { now })
            : await peek.call(options.geocoding, text, { now });
        if (resolution !== null && resolution.cacheId === body.cacheId) allowed = true;
      }
      if (!allowed) {
        sendError(request, reply, 404, 'NOT_FOUND', 'Adresse nicht gefunden.');
        return;
      }
      await options.geocoding.confirmCandidate(body.cacheId, body.candidateRef, context.user.id);
      return await respondTour(context, params.id);
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  // ── Lebenszyklus ─────────────────────────────────────────────────────────

  app.post('/staff/tours/:id/ready', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireManage(request, reply, context))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(versionBody, request.body ?? undefined) ?? {};
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    try {
      const ready = await tours.markReady(context.user.id, params.id, body);
      // Phase 14 (training): nur der Übergang draft → ready (Status vorher gelesen).
      if (loaded.tour.status === 'draft' && ready.status === 'ready') {
        await trainingRecorder.record({
          actorUserId: context.user.id,
          eventKey: 'tour.ready',
          subjectRef: params.id,
        });
      }
      return await respondTour(context, params.id);
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/tours/:id/start', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(versionBody, request.body ?? undefined) ?? {};
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    if (!(await requireManageOrDriver(request, reply, context, loaded))) return;
    // Phase 14 (training gate)
    if (!(await requireTrainingGate(request, reply, trainingGate, context.user.id, 'tour.start')))
      return;
    try {
      const result = await tours.start(context.user.id, params.id, body);
      // Phase 14 (training): idempotenter Wiederholungsaufruf (`started: false`) zählt nicht.
      if (result.started) {
        await trainingRecorder.record({
          actorUserId: context.user.id,
          eventKey: 'tour.started',
          subjectRef: params.id,
        });
      }
      return { started: result.started, ...(await respondTour(context, params.id)) };
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/tours/:id/end', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(endBody, request.body ?? undefined) ?? {};
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    if (!(await requireManageOrDriver(request, reply, context, loaded))) return;
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      const result = await tours.end(context.user.id, params.id, {
        ...(body.force === undefined ? {} : { force: body.force }),
        reason: body.reason ?? null,
        canForce: effective.has('calendar.manage'),
      });
      // Phase 14 (training): nur ein tatsächliches Ende (`ended: true`) zählt.
      if (result.ended) {
        await trainingRecorder.record({
          actorUserId: context.user.id,
          eventKey: 'tour.completed',
          subjectRef: params.id,
        });
      }
      return { ended: result.ended, ...(await respondTour(context, params.id)) };
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/tours/:id/cancel', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requireManage(request, reply, context))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    try {
      const result = await tours.cancel(context.user.id, params.id);
      return { cancelled: result.cancelled, ...(await respondTour(context, params.id)) };
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/tours/:id/takeover', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const body = parseOrThrow(versionBody, request.body ?? undefined) ?? {};
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'appointment.assign'))) return;
    // Phase 14 (training gate)
    if (
      !(await requireTrainingGate(request, reply, trainingGate, context.user.id, 'tour.takeover'))
    )
      return;
    try {
      const effective = await auth.effectivePermissions(context.user.id);
      await tours.takeover(context.user.id, params.id, body, effective);
      return await respondTour(context, params.id);
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/staff/tours/:id/stops/:stopId/arrived', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const params = parseOrThrow(stopParams, request.params, 'params');
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    if (!(await requireManageOrDriver(request, reply, context, loaded))) return;
    try {
      await tours.markArrived(context.user.id, params.id, params.stopId);
      return await respondTour(context, params.id);
    } catch (error) {
      if (sendTourError(request, reply, error)) return;
      throw error;
    }
  });
}

/** Listener-Fabrik für app.ts (Terminänderung ⇒ stale) – re-export für die Komposition. */
export type { AppointmentChangeListener };
