import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth, requirePermission, sendAuthError, sendError } from '../auth/http.ts';
import type { AuthenticatedContext } from '../auth/service.ts';
import { ProductService } from '../commerce/product-service.ts';
import { ProcessService } from '../crm/process-service.ts';
import { getCompletedVisibilityDays } from '../crm/settings-service.ts';
import { buildVisibilityContext } from '../crm/visibility.ts';
import { isWellFormedPortalToken, portalSessionCookieName } from '../portal/guard.ts';
import { buildPublicCatalog } from '../public/catalog.ts';
import { buildConfiguratorPreview } from '../public/configurator.ts';
import { configuratorPreviewSchema, publicInquirySchema } from '../public/schemas.ts';
import {
  loadWebsiteSubmissionView,
  PublicInquiryError,
  WebsiteInquiryService,
} from '../public/website-inquiry.ts';
import type { WebsiteModuleDeps } from '../website/module.ts';
import { UUID_PATTERN } from './auth.ts';
import { IpWindowLimiter } from './portal-auth.ts';

/**
 * Phase 16 (PUBLIC, Design §3 + §11): öffentlicher Slush-Konfigurator und Website-Anfrage.
 *
 * - `GET  /public/configurator/catalog`  – öffentliche Katalog-Projektion (SSR + Browser,
 *   KEIN IP-Limit: Server-Komponenten lesen alle von der Web-Server-IP; `no-store`).
 * - `POST /public/configurator/preview`  – laufende Übersicht über die zentrale Preisengine
 *   (60/min je IP). Verstöße sind Hinweise, nie Fehler; ≥ 250 Gäste nur Hinweis.
 * - `POST /public/inquiries`             – Website-Anfrage ⇒ genau ein Vorgang
 *   (5/min + 20/h je IP), idempotent über `clientMutationId`.
 * - `GET  /staff/processes/:id/website-submission` – Staff-Hinweis (Recht wie die
 *   Inquiry-Ansicht des Vorgangs: `inquiry.view` + Vorgangs-Sichtbarkeit).
 *
 * CSRF (Sec-Fetch-Site/Origin) greift global für alle POSTs; es gibt keine CORS-Header.
 * In demo unterliegen die POSTs Reset-Gate und Barrier (503 `DEMO_RESET`).
 * Request-Bodies werden nie geloggt; Fehlerantworten tragen nur Feldpfade.
 */

const idParams = z.object({ id: z.string().regex(UUID_PATTERN, 'muss eine UUID sein') });

/** Phase 16 (PUBLIC): IP-Limits (Design §3.2/§3.3). */
export const PUBLIC_PREVIEW_MINUTE_LIMIT = 60;
export const PUBLIC_INQUIRY_MINUTE_LIMIT = 5;
export const PUBLIC_INQUIRY_HOURLY_LIMIT = 20;

export function registerPublicConfiguratorRoutes(
  instance: FastifyInstance,
  deps: WebsiteModuleDeps,
): void {
  const { db, config, auth } = deps;
  const productService = new ProductService(db);
  const inquiryService = new WebsiteInquiryService(db);
  const processService = new ProcessService(db);
  const rateLimitEnabled = deps.rateLimitEnabled ?? instance.hasDecorator('rateLimit');
  const perIpPerMinute = (max: number) =>
    rateLimitEnabled
      ? {
          rateLimit: {
            max,
            timeWindow: '1 minute',
            keyGenerator: (request: FastifyRequest) => request.ip,
          },
        }
      : false;
  // @fastify/rate-limit erlaubt nur EINE Konfiguration je Route ⇒ Stundenfenster in-process.
  const hourlyLimiter = new IpWindowLimiter(PUBLIC_INQUIRY_HOURLY_LIMIT, 60 * 60 * 1000);

  // ── Katalog ───────────────────────────────────────────────────────────────

  instance.get('/public/configurator/catalog', async (request, reply) => {
    const catalog = await buildPublicCatalog(db, new Date(), { logger: request.log });
    void reply.header('cache-control', 'no-store');
    return catalog;
  });

  // ── Laufende Übersicht ───────────────────────────────────────────────────

  instance.post(
    '/public/configurator/preview',
    { config: perIpPerMinute(PUBLIC_PREVIEW_MINUTE_LIMIT) },
    async (request, reply) => {
      const body = parseOrThrow(configuratorPreviewSchema, request.body ?? {});
      const preview = await buildConfiguratorPreview(
        db,
        productService,
        {
          guests: body.guests,
          selection: {
            machineSlug: body.machineSlug ?? null,
            syrups: body.syrups ?? { free: [], extra: [] },
            extras: body.extras ?? { cups25: 0, straws25: 0 },
            canisters: body.canisters ?? 0,
            fulfillment: body.fulfillment ?? 'pickup',
          },
        },
        new Date(),
      );
      void reply.header('cache-control', 'no-store');
      return preview;
    },
  );

  // ── Website-Anfrage ──────────────────────────────────────────────────────

  /** Optionale Portal-Session VOR der Transaktion (ohne Touch; nie 401, nie Cookie-Löschen). */
  const portalCustomerIdOf = async (request: FastifyRequest): Promise<string | null> => {
    const token = request.cookies[portalSessionCookieName(config.appEnv)];
    if (!isWellFormedPortalToken(token)) return null;
    const session = await deps.portalSessions.authenticate(token, { touch: false });
    return session?.customerId ?? null;
  };

  instance.post(
    '/public/inquiries',
    { config: perIpPerMinute(PUBLIC_INQUIRY_MINUTE_LIMIT) },
    async (request, reply) => {
      if (rateLimitEnabled && !hourlyLimiter.hit(request.ip)) {
        sendError(
          request,
          reply,
          429,
          'RATE_LIMITED',
          'Zu viele Anfragen. Bitte versuche es später erneut.',
        );
        return;
      }
      const body = parseOrThrow(publicInquirySchema, request.body);
      const portalCustomerId = await portalCustomerIdOf(request);
      try {
        const outcome = await inquiryService.submit(body, { portalCustomerId });
        void reply.header('cache-control', 'no-store');
        return reply.status(outcome.status === 'created' ? 201 : 200).send({
          processNumber: outcome.processNumber,
          receivedAt: outcome.receivedAt,
        });
      } catch (error) {
        if (error instanceof PublicInquiryError) {
          void reply.status(409).send({
            error: {
              code: error.code,
              message: error.message,
              correlationId: request.id,
              ...(error.processNumber === null ? {} : { processNumber: error.processNumber }),
            },
          });
          return;
        }
        if (sendAuthError(request, reply, error)) return;
        throw error;
      }
    },
  );

  // ── Staff-Hinweis zur Website-Anfrage ────────────────────────────────────

  /** Wie `requireVisibleProcess` der Inquiry-Route: process.view_all + Sichtbarkeitsfenster; unsichtbar = 404. */
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

  instance.get('/staff/processes/:id/website-submission', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!(await requirePermission(request, reply, auth, context, 'inquiry.view'))) return;
    const params = parseOrThrow(idParams, request.params, 'params');
    if (!(await requireVisibleProcess(request, reply, context, params.id))) return;
    const view = await loadWebsiteSubmissionView(db, params.id);
    if (view === null) {
      sendError(
        request,
        reply,
        404,
        'NOT_FOUND',
        'Zu diesem Vorgang gibt es keine Website-Anfrage.',
      );
      return;
    }
    return view;
  });
}
