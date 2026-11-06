import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendError } from '../auth/http.ts';
import { toPublicReviews } from '../reviews/public.ts';
import { ReviewProviderError } from '../reviews/types.ts';
import type { WebsiteModuleDeps } from '../website/module.ts';

/**
 * Phase 16 (REVIEWS, Order §18, Design §1.5/§4/§11.2.6): `GET /public/reviews` – Bewertungen
 * nach Klick („Bewertungen anzeigen“) über die ReviewGateway-Grenze.
 *
 * - Provider `disabled` ⇒ 404 `REVIEWS_DISABLED` (die Website blendet die Sektion aus).
 * - Provider-Fehler, Timeout, Tagesgrenze, Google-429 ⇒ 503 `REVIEWS_UNAVAILABLE` mit
 *   neutraler Meldung (nie Grund, Status oder Details im Body) – die übrige Website bleibt
 *   unberührt.
 * - `Sec-Fetch-Site: cross-site|same-site` ⇒ 403 `CSRF_REJECTED` (fremde Seiten sollen keine
 *   bezahlten Abrufe auslösen); ohne Header (Server, Tests) erlaubt.
 * - Nur GET – keine automatische HEAD-Route (HEAD ⇒ 404 ohne Provider-Abruf).
 * - 10 Abrufe je Minute und IP; `Cache-Control: no-store` auf JEDER Antwort (Google
 *   verbietet Caching); keine CORS-Header.
 * - Log nur `{ reviews: { provider, outcome, reason, httpStatus, durationMs, reviewCount } }` –
 *   nie Key, URL, Antwortkörper, Review-Texte oder Autorennamen.
 */

export const PUBLIC_REVIEWS_MINUTE_LIMIT = 10;
const UNAVAILABLE_MESSAGE = 'Bewertungen sind gerade nicht verfügbar.';

export function registerPublicReviewRoutes(
  instance: FastifyInstance,
  deps: WebsiteModuleDeps,
): void {
  const gateway = deps.reviews;
  const rateLimitEnabled = deps.rateLimitEnabled ?? instance.hasDecorator('rateLimit');

  instance.get(
    '/public/reviews',
    {
      // Review demo_reviews-3: KEINE automatische HEAD-Route (Fastify-Default) – HEAD würde
      // denselben Handler samt bezahltem Provider-Abruf ausführen und hätte einen eigenen
      // Rate-Limit-Topf. HEAD /public/reviews ⇒ 404, das Gateway wird nie aufgerufen.
      exposeHeadRoute: false,
      ...(rateLimitEnabled
        ? {
            config: {
              rateLimit: {
                max: PUBLIC_REVIEWS_MINUTE_LIMIT,
                timeWindow: '1 minute',
                keyGenerator: (request: FastifyRequest) => request.ip,
              },
            },
          }
        : {}),
    },
    async (request, reply) => {
      void reply.header('cache-control', 'no-store');
      const site = request.headers['sec-fetch-site'];
      if (site === 'cross-site' || site === 'same-site') {
        sendError(request, reply, 403, 'CSRF_REJECTED', 'Anfrage aus fremdem Kontext abgelehnt.');
        return reply;
      }
      if (gateway.mode === 'disabled') {
        sendError(request, reply, 404, 'REVIEWS_DISABLED', 'Bewertungen sind nicht aktiviert.');
        return reply;
      }
      const mode = gateway.mode;
      const started = performance.now();
      try {
        const result = await gateway.fetchPlaceReviews();
        if (result.mode !== mode) {
          throw new ReviewProviderError('REVIEWS_UNAVAILABLE', UNAVAILABLE_MESSAGE, {
            reason: 'invalid_response',
          });
        }
        const dto = toPublicReviews(mode, result);
        request.log.info(
          {
            reviews: {
              provider: mode,
              outcome: 'ok',
              durationMs: Math.round(performance.now() - started),
              reviewCount: dto.reviews.length,
            },
          },
          'Bewertungen abgerufen',
        );
        return dto;
      } catch (error) {
        const durationMs = Math.round(performance.now() - started);
        if (error instanceof ReviewProviderError && error.code === 'REVIEWS_DISABLED') {
          sendError(request, reply, 404, 'REVIEWS_DISABLED', 'Bewertungen sind nicht aktiviert.');
          return reply;
        }
        request.log.warn(
          {
            reviews: {
              provider: mode,
              outcome: 'unavailable',
              // Nur eigene Klassifikation – nie Fehlermeldung, Stack, URL oder Body.
              reason: error instanceof ReviewProviderError ? error.reason : 'internal_error',
              httpStatus: error instanceof ReviewProviderError ? error.httpStatus : null,
              durationMs,
            },
          },
          'Bewertungen nicht verfügbar',
        );
        sendError(request, reply, 503, 'REVIEWS_UNAVAILABLE', UNAVAILABLE_MESSAGE);
        return reply;
      }
    },
  );
}
