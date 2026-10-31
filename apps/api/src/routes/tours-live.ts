import type { AppConfig } from '@mietroyal/config';
import { tourDelayIncidents, type Database } from '@mietroyal/database';
import { parseOrThrow, z } from '@mietroyal/validation';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, requirePermission, sendError } from '../auth/http.ts';
import type { AuthenticatedContext, StaffAuthService } from '../auth/service.ts';
import type { DelayTrigger } from '../tours/live/delay-risk-service.ts';
import {
  LOCATION_BODY_LIMIT_BYTES,
  LocationRateLimitedError,
} from '../tours/live/location-service.ts';
import type { TourLiveModule } from '../tours/live/module.ts';
import type { LoadedTour, TourService } from '../tours/tour-service.ts';
import { LIVE_LOCATION_STALE_MS } from '../tours/views.ts';
import { UUID_PATTERN } from './auth.ts';
import { sendTourError } from './tours.ts';

/**
 * Phase 13 (tours-live, Design §8): Live-Routen der aktiven Tour.
 * - POST /staff/tours/:id/location – nur effektiver Fahrer einer aktiven
 *   Tour (sonst neutral 404), Body ≤ 512 B, Rate-Limit 1/10 s je Tour (429),
 *   204 ohne Body; die Verspätungsbewertung läuft NACH der Antwort
 *   asynchron (Fehler nur geloggt, nie Koordinaten).
 * - GET /staff/tours/:id/delay – Stand der Verspätungsprognose (sichtbare Tour).
 * - onResponse-Haken: Tour-Mutationen über die Tour-Routen (Reihenfolge,
 *   Stopp ±, Pin/Puffer, Restroute) stoßen eine Bewertung an (Design §9,
 *   Trigger „Plan geändert/recalculate“ – ohne Drossel).
 */

const uuidSchema = z.string().regex(UUID_PATTERN, 'muss eine UUID sein');
const idParams = z.object({ id: uuidSchema });
const locationBody = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().min(0).max(100_000).nullable().optional(),
  observedAt: z
    .string()
    .max(40)
    .refine((value) => !Number.isNaN(Date.parse(value)), 'muss ein gültiger Zeitpunkt sein'),
});

/** Tour-Routen, nach deren erfolgreicher Antwort eine Bewertung sinnvoll ist (Design §9). */
const TRIGGERING_ROUTES: Record<string, DelayTrigger> = {
  'POST /staff/tours/:id/plan/recalculate': 'recalculate',
  'POST /staff/tours/:id/stops/order': 'plan_changed',
  'POST /staff/tours/:id/stops': 'plan_changed',
  'DELETE /staff/tours/:id/stops/:stopId': 'plan_changed',
  'PATCH /staff/tours/:id/stops/:stopId': 'plan_changed',
  'POST /staff/tours/:id/stops/:stopId/arrived': 'stop_changed',
};

export interface TourLiveRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  tours: TourService;
  live: TourLiveModule;
}

export function registerTourLiveRoutes(app: FastifyInstance, options: TourLiveRouteOptions): void {
  const { db, auth, config, tours, live } = options;

  /** Bewertung NACH der Antwort (nächster Event-Loop-Durchlauf); im Gedächtnis als laufend registriert (`settle()`). */
  const evaluateLater = (request: FastifyRequest, tourId: string, trigger: DelayTrigger) => {
    void live.state.track(
      new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => live.delay.evaluate(tourId, trigger))
        .catch((error: unknown) => {
          request.log.warn(
            {
              tourId,
              trigger,
              errorCode: error instanceof Error ? error.name || 'Error' : 'Error',
            },
            'Verspätungsbewertung fehlgeschlagen',
          );
        }),
    );
  };

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

  app.post(
    '/staff/tours/:id/location',
    { bodyLimit: LOCATION_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const context = await requireAuth(request, reply, auth, config);
      if (context === null) return;
      const params = parseOrThrow(idParams, request.params, 'params');
      const body = parseOrThrow(locationBody, request.body);
      try {
        await live.locations.update(context.user.id, params.id, {
          latitude: body.latitude,
          longitude: body.longitude,
          accuracyMeters: body.accuracyMeters ?? null,
          observedAt: new Date(body.observedAt),
        });
      } catch (error) {
        if (error instanceof LocationRateLimitedError) {
          void reply
            .status(429)
            .header('retry-after', String(Math.ceil(error.retryAfterMs / 1000)))
            .send({
              error: {
                code: 'LOCATION_RATE_LIMITED',
                message: error.message,
                correlationId: request.id,
              },
            });
          return;
        }
        if (sendTourError(request, reply, error)) return;
        throw error;
      }
      void reply.status(204).send();
      evaluateLater(request, params.id, 'location');
    },
  );

  app.get('/staff/tours/:id/delay', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    const loaded = await loadVisible(request, reply, context, params.id);
    if (loaded === null) return;
    const now = new Date();
    const last = live.delay.lastEvaluation(params.id);
    if (
      loaded.tour.status === 'active' &&
      last !== undefined &&
      last.status !== 'unavailable' &&
      now.getTime() - last.evaluatedAt.getTime() <= LIVE_LOCATION_STALE_MS
    ) {
      return {
        status: last.status,
        evaluatedAt: last.evaluatedAt.toISOString(),
        stops: last.stops.map((stop) => ({
          stopId: stop.stopId,
          predictedArrivalAt: stop.predictedArrivalAt?.toISOString() ?? null,
          deadlineAt: stop.deadlineAt?.toISOString() ?? null,
          late: stop.late,
        })),
      };
    }
    // Ohne frische In-Process-Bewertung (anderer Prozess, Neustart, Provider-
    // Fehler): offene Incidents aus der DB bleiben sichtbar – nie Entwarnung.
    // Phase 13 (Fix F2/F3): nur für aktive Touren und nur zu verbleibenden Stopps.
    const remainingStopIds = new Set(
      loaded.stops
        .filter((entry) => entry.state === 'open' || entry.state === 'arrived')
        .map((entry) => entry.stop.id),
    );
    const open =
      loaded.tour.status !== 'active'
        ? []
        : (
            await db
              .select()
              .from(tourDelayIncidents)
              .where(
                and(
                  eq(tourDelayIncidents.tourId, params.id),
                  isNull(tourDelayIncidents.resolvedAt),
                ),
              )
          ).filter((row) => remainingStopIds.has(row.stopId));
    if (open.length > 0) {
      const evaluatedAt = new Date(Math.max(...open.map((row) => row.lastEvaluatedAt.getTime())));
      return {
        status: 'risk',
        evaluatedAt: evaluatedAt.toISOString(),
        stops: open.map((row) => ({
          stopId: row.stopId,
          predictedArrivalAt: row.predictedArrivalAt.toISOString(),
          deadlineAt: row.deadlineAt.toISOString(),
          late: true,
        })),
      };
    }
    return {
      status: 'unavailable',
      evaluatedAt: last?.evaluatedAt.toISOString() ?? null,
      reason:
        last?.reason ?? (loaded.tour.status === 'active' ? 'NO_LIVE_LOCATION' : 'TOUR_NOT_ACTIVE'),
      stops: [],
    };
  });

  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode !== 200) return;
    const trigger = TRIGGERING_ROUTES[`${request.method} ${request.routeOptions.url ?? ''}`];
    if (trigger === undefined) return;
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return;
    evaluateLater(request, id, trigger);
  });
}
