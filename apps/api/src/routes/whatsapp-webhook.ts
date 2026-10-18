import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { JobQueue, StorageProvider } from '@mietroyal/integrations';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ConversationService } from '../communication/conversation/conversation-service.ts';
import {
  WHATSAPP_WEBHOOK_BODY_LIMIT,
  WhatsAppWebhookService,
} from '../communication/whatsapp/webhook-service.ts';

export interface WhatsAppWebhookRouteOptions {
  db: Database;
  config: AppConfig;
  queue: JobQueue;
  storage: StorageProvider;
  rateLimitEnabled: boolean;
}

/**
 * Phase 12 (Order §26): öffentlicher Meta-Webhook.
 * - GET  /webhooks/whatsapp: Verify-Challenge (hub.mode=subscribe,
 *   hub.verify_token in konstanter Zeit) ⇒ 200 text/plain hub.challenge; sonst 403.
 * - POST /webhooks/whatsapp: eigener Content-Type-Parser (Rohbytes, 3 MB) in
 *   einem eigenen Fastify-Scope (wie routes/lexware-webhooks.ts), Signatur
 *   X-Hub-Signature-256 über die unveränderten Bytes; ungültig/fehlend ⇒ 401
 *   ohne Details; gültig ⇒ idempotente Verarbeitung, dann 200 (DB-Fehler ⇒
 *   500, Meta wiederholt).
 * Ohne Live-Konfiguration (mock/disabled) antworten beide Routen neutral 404.
 */
export function registerWhatsAppWebhookRoutes(
  app: FastifyInstance,
  options: WhatsAppWebhookRouteOptions,
): void {
  const { db, config, queue, storage } = options;
  const conversations = new ConversationService(db, storage);
  const service = new WhatsAppWebhookService({ db, config, queue, conversations, logger: app.log });
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
  const notFound = (request: FastifyRequest) => ({
    error: { code: 'NOT_FOUND', message: 'Ressource nicht gefunden', correlationId: request.id },
  });

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: WHATSAPP_WEBHOOK_BODY_LIMIT },
      (_request, body, done) => done(null, body),
    );
    // Meta sendet application/json; alles andere wird als Rohbytes gelesen und
    // scheitert an der Signaturprüfung – niemals am globalen JSON-Parser.
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: WHATSAPP_WEBHOOK_BODY_LIMIT },
      (_request, body, done) => done(null, body),
    );

    scope.get('/webhooks/whatsapp', { config: publicLimit(30) }, async (request, reply) => {
      if (!service.live) return reply.status(404).send(notFound(request));
      const query = request.query as Record<string, unknown>;
      const pick = (key: string) =>
        typeof query[key] === 'string' ? (query[key] as string) : undefined;
      const mode = pick('hub.mode');
      const token = pick('hub.verify_token');
      const hubChallenge = pick('hub.challenge');
      const challenge = service.verifyChallenge({
        ...(mode === undefined ? {} : { mode }),
        ...(token === undefined ? {} : { token }),
        ...(hubChallenge === undefined ? {} : { challenge: hubChallenge }),
      });
      if (challenge === null) {
        return reply.status(403).send({
          error: { code: 'REJECTED', message: 'Anfrage abgelehnt', correlationId: request.id },
        });
      }
      return reply.status(200).header('content-type', 'text/plain; charset=utf-8').send(challenge);
    });

    scope.post(
      '/webhooks/whatsapp',
      { config: publicLimit(600), bodyLimit: WHATSAPP_WEBHOOK_BODY_LIMIT },
      async (request, reply) => {
        if (!service.live) return reply.status(404).send(notFound(request));
        const raw = request.body;
        const rawBody = Buffer.isBuffer(raw) ? raw : Buffer.alloc(0);
        const header = request.headers['x-hub-signature-256'];
        const signature = Array.isArray(header) ? header[0] : header;
        if (!service.verifySignature(rawBody, signature)) {
          // Neutral: kein Hinweis, ob Header fehlt oder Signatur falsch ist.
          return reply.status(401).send({
            error: { code: 'REJECTED', message: 'Anfrage abgelehnt', correlationId: request.id },
          });
        }
        let body: unknown;
        try {
          body = JSON.parse(rawBody.toString('utf8'));
        } catch {
          return reply.status(400).send({
            error: { code: 'BAD_REQUEST', message: 'Ungültige Anfrage', correlationId: request.id },
          });
        }
        const result = await service.process(body);
        return reply.status(200).send({
          received: true,
          messages: result.messages.length,
          statuses: result.statuses.length,
        });
      },
    );
  });
}
