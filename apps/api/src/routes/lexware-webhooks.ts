import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { JobQueue } from '@mietroyal/integrations';
import type { FastifyInstance } from 'fastify';
import { LexwareConnectionService } from '../lexware/connection-service.ts';
import type { LexwareContext } from '../lexware/context.ts';
import { LEXWARE_WEBHOOK_BODY_LIMIT, LexwareWebhookService } from '../lexware/webhook-service.ts';

export interface LexwareWebhookRouteOptions {
  db: Database;
  config: AppConfig;
  lexware: LexwareContext;
  queue: JobQueue;
}

/**
 * POST /webhooks/lexware (Order §44): ohne Staff-Login, mit eigenem
 * Content-Type-Parser (Rohbytes, 64 KB) in einem eigenen Fastify-Scope, damit
 * der globale JSON-Parser den Body nicht vorher verändert. Antworten sind
 * neutral (401/403 ohne Details); ohne aktive Lexware-Konfiguration 404.
 * Alles Weitere (Signatur, Organisation, Dedup, Job) macht der Service –
 * kein Lexware-Aufruf inline, Antwort in Millisekunden.
 */
export function registerLexwareWebhookRoutes(
  app: FastifyInstance,
  options: LexwareWebhookRouteOptions,
): void {
  const { db, config, lexware, queue } = options;
  const connection = new LexwareConnectionService(lexware);
  const service = new LexwareWebhookService({ db, config, lexware, queue, connection });

  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: LEXWARE_WEBHOOK_BODY_LIMIT },
      (_request, body, done) => done(null, body),
    );
    scope.post(
      '/webhooks/lexware',
      { bodyLimit: LEXWARE_WEBHOOK_BODY_LIMIT },
      async (request, reply) => {
        if (lexware.client === null) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Ressource nicht gefunden',
              correlationId: request.id,
            },
          });
        }
        const raw = request.body;
        const rawBody = Buffer.isBuffer(raw) ? raw : Buffer.alloc(0);
        const header = request.headers['x-lxo-signature'];
        const signature = Array.isArray(header) ? header[0] : header;
        const outcome = await service.receive(rawBody, signature, request.id, request.log);
        if (outcome.status === 202) {
          return reply.status(202).send({ status: outcome.result });
        }
        if (outcome.status === 400) {
          return reply.status(400).send({
            error: { code: 'BAD_REQUEST', message: 'Ungültige Anfrage', correlationId: request.id },
          });
        }
        // 401/403: neutral, ohne Hinweis auf den Grund (Order §45/§46).
        return reply.status(outcome.status).send({
          error: { code: 'REJECTED', message: 'Anfrage abgelehnt', correlationId: request.id },
        });
      },
    );
  });
}
