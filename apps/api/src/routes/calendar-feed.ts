import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import { z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAuth, requirePermission, sendError } from '../auth/http.ts';
import type { StaffAuthService } from '../auth/service.ts';
import { CalendarFeedService } from '../communication/calendar/feed-service.ts';
import { getStaffAppBaseUrl } from '../crm/settings-service.ts';

/**
 * Privater ICS-Feed (Phase 12, Order §33):
 * - POST /staff/calendar/feed (calendar.view): Token erzeugen/regenerieren –
 *   Klartext-URL genau einmal in der Antwort.
 * - GET  /staff/calendar/feed (calendar.view): Status ohne Token.
 * - GET  /public/calendar/<token>.ics: öffentlich, rate-limitiert, neutral
 *   404 bei ungültig/unbekannt/ohne Recht calendar.view; Pfad im Log maskiert
 *   (app.ts maskLoggedPath). Der ausgegebene Link lautet
 *   `<Staff-Basis-URL>/api/public/calendar/<token>.ics` – der Staff-Proxy
 *   streift `/api` ab (Härtung B16).
 * Andere Methoden auf dem Feed existieren nicht (Fastify ⇒ 404) – read-only.
 */

const feedFileParams = z.object({
  file: z.string().regex(/^[A-Za-z0-9_-]{43}\.ics$/, 'ungültig'),
});

interface CalendarFeedRouteOptions {
  db: Database;
  auth: StaffAuthService;
  config: AppConfig;
  rateLimitEnabled: boolean;
}

export const CALENDAR_FEED_NO_BASE_URL_HINT =
  'Es ist keine Staff-App-Basis-URL konfiguriert – bitte die Adresse der Mitarbeiter-App vor den Pfad setzen.';

export function registerCalendarFeedRoutes(
  app: FastifyInstance,
  options: CalendarFeedRouteOptions,
): void {
  const { db, auth, config } = options;
  const feeds = new CalendarFeedService(db, auth);
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

  app.get('/staff/calendar/feed', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config, { touchActivity: false });
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    return feeds.status(context.user.id);
  });

  app.post('/staff/calendar/feed', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'calendar.view'))) return;
    const { token, regenerated } = await feeds.issueToken(context.user.id);
    const baseUrl = await getStaffAppBaseUrl(db);
    const path = CalendarFeedService.feedPath(token);
    request.log.info({ userId: context.user.id, regenerated }, 'Kalender-Feed-Token erzeugt');
    return {
      url: `${baseUrl ?? ''}${path}`,
      absolute: baseUrl !== null,
      regenerated,
      hint: baseUrl === null ? CALENDAR_FEED_NO_BASE_URL_HINT : null,
    };
  });

  app.get('/public/calendar/:file', { config: publicLimit(60) }, async (request, reply) => {
    const parsed = feedFileParams.safeParse(request.params);
    const resolved = parsed.success
      ? await feeds.resolveToken(parsed.data.file.slice(0, -'.ics'.length))
      : null;
    if (resolved === null) {
      sendError(request, reply, 404, 'NOT_FOUND', 'Dieser Kalender ist nicht verfügbar.');
      return;
    }
    const body = await feeds.buildFeed(resolved.userId, resolved.displayName);
    void reply.header('content-type', 'text/calendar; charset=utf-8');
    void reply.header('cache-control', 'private, no-store');
    void reply.header('content-disposition', 'inline; filename="miet-royal.ics"');
    return reply.send(body);
  });
}
