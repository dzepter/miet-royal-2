import type { AppConfig } from '@mietroyal/config';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance } from 'fastify';
import { requireAuth, sendError } from '../auth/http.ts';
import type { StaffAuthService } from '../auth/service.ts';
import { checkPushEndpoint } from '../communication/push/endpoint-policy.ts';
import type { PushSubscriptionService } from '../communication/push/subscription-service.ts';
import type { PushGateway } from '../communication/types.ts';

/**
 * Web-Push-Routen (Phase 12, Order §29): Jede gültige Session darf das
 * EIGENE Gerät registrieren und die eigenen Geräte sehen – kein neues Recht
 * (Push ist Werkzeug, keine Datenfreigabe). Endpoint/Keys werden
 * entgegengenommen, aber nie zurückgegeben oder geloggt.
 * Härtung B10: außerhalb von development nur Endpoints bekannter Push-Dienste
 * (communication/push/endpoint-policy.ts) – kein SSRF über den Endpoint.
 * Phase 12 Finalisierung (bestätigte Entscheidung): KEIN Push-Opt-out in
 * Miet-Royal – es gibt bewusst keine Route zum Abmelden/Ausschalten. Die
 * bewusste Entscheidung ist die Browserberechtigung; danach deaktiviert nur
 * die Technik (Logout/Revoke/Inaktivität/Mitarbeiter deaktiviert, 404/410,
 * unzulässiger Endpoint, Übernahme des Endpoints durch einen anderen User).
 */

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function isHttpsEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

const endpointSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(isHttpsEndpoint, 'muss eine https-Adresse ohne Zugangsdaten sein');

const subscribeBody = z.object({
  endpoint: endpointSchema,
  keys: z.object({
    p256dh: z.string().min(16).max(256).regex(BASE64URL_PATTERN, 'ungültiges Format'),
    auth: z.string().min(8).max(128).regex(BASE64URL_PATTERN, 'ungültiges Format'),
  }),
  userAgentLabel: z.string().max(120).optional(),
});

const endpointBody = z.object({ endpoint: endpointSchema });

interface PushRouteOptions {
  auth: StaffAuthService;
  config: AppConfig;
  subscriptions: PushSubscriptionService;
  /** Aktives Gateway: Registrierung nur, wenn Push konfiguriert ist (oder der Test-Fake aktiv ist). */
  gateway: PushGateway;
}

export function registerPushRoutes(app: FastifyInstance, options: PushRouteOptions): void {
  const { auth, config, subscriptions } = options;
  const enabled = config.push.enabled || options.gateway.kind === 'fake';

  app.get('/staff/push/vapid-public-key', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config, { touchActivity: false });
    if (context === null) return;
    return { enabled, publicKey: config.push.enabled ? config.push.vapidPublicKey : null };
  });

  app.post('/staff/push/subscriptions', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (!enabled) {
      sendError(
        request,
        reply,
        409,
        'PUSH_NOT_CONFIGURED',
        'Web Push ist auf diesem Server nicht konfiguriert.',
      );
      return;
    }
    const body = parseOrThrow(subscribeBody, request.body, 'body');
    if (checkPushEndpoint(body.endpoint, config.appEnv) !== null) {
      sendError(
        request,
        reply,
        400,
        'PUSH_ENDPOINT_NOT_ALLOWED',
        'Dieser Push-Dienst wird nicht unterstützt.',
      );
      return;
    }
    const label = body.userAgentLabel?.trim() ?? '';
    const result = await subscriptions.register({
      userId: context.user.id,
      sessionId: context.session.id,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgentLabel: label === '' ? context.session.deviceLabel : label,
    });
    request.log.info(
      { subscriptionId: result.id, reassigned: result.reassigned },
      'Push-Subscription registriert',
    );
    return { subscriptionId: result.id };
  });

  app.get('/staff/push/subscriptions', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config, { touchActivity: false });
    if (context === null) return;
    const devices = await subscriptions.listOwn(context.user.id, context.session.id);
    return { devices };
  });

  /**
   * Status des eigenen Browsers: ist dieser Endpoint für DIESEN User aktiv?
   * Phase 12 Finalisierung (B1): eine an eine andere gültige Session desselben
   * Users gebundene Subscription wird dabei an die aktuelle Session gebunden
   * (Details: PushSubscriptionService.statusForSession); fremder User ⇒ false.
   */
  app.post('/staff/push/subscriptions/status', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config, { touchActivity: false });
    if (context === null) return;
    const body = parseOrThrow(endpointBody, request.body, 'body');
    return {
      active: await subscriptions.statusForSession(
        context.user.id,
        context.session.id,
        body.endpoint,
      ),
    };
  });
}
