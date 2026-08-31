import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@mietroyal/config';
import { pingDatabase } from '@mietroyal/database';
import { RequestValidationError } from '@mietroyal/validation';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';

export const API_VERSION = '0.1.0';

const CORRELATION_ID_HEADER = 'x-correlation-id';
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface AppOptions {
  config: AppConfig;
  /** Ohne Pool antwortet /ready mit 503 (z. B. in reinen Unit-Tests). */
  pool?: pg.Pool;
}

/**
 * Einheitliche Fehlerform für alle API-Antworten (PHASE_00_FOUNDATION.md,
 * Nr. 6). Interne Details (Stacktraces, SQL, Pfade) verlassen den Server nie.
 */
interface ErrorBody {
  error: {
    code: string;
    message: string;
    correlationId: string;
    issues?: readonly { path: string; message: string }[];
  };
}

export function buildApp({ config, pool }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    genReqId: (req) => {
      const incoming = req.headers[CORRELATION_ID_HEADER];
      if (typeof incoming === 'string' && CORRELATION_ID_PATTERN.test(incoming)) {
        return incoming;
      }
      return randomUUID();
    },
    trustProxy: false,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header(CORRELATION_ID_HEADER, request.id);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      error: {
        code: 'NOT_FOUND',
        message: 'Ressource nicht gefunden',
        correlationId: request.id,
      },
    };
    void reply.status(404).send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RequestValidationError) {
      const body: ErrorBody = {
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          correlationId: request.id,
          issues: error.issues,
        },
      };
      void reply.status(400).send(body);
      return;
    }

    const fastifyError = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    const statusCode = typeof fastifyError.statusCode === 'number' ? fastifyError.statusCode : 500;
    if (statusCode >= 400 && statusCode < 500) {
      // Client-Fehler (z. B. ungültiges JSON, Payload zu groß): Meldung ist
      // von Fastify generiert und enthält keine internen Details.
      const body: ErrorBody = {
        error: {
          code: typeof fastifyError.code === 'string' ? fastifyError.code : 'BAD_REQUEST',
          message:
            typeof fastifyError.message === 'string' ? fastifyError.message : 'Ungültige Anfrage',
          correlationId: request.id,
        },
      };
      void reply.status(statusCode).send(body);
      return;
    }

    // Interne Fehler: vollständig loggen, nach außen nur generische Antwort.
    request.log.error({ err: error }, 'Unbehandelter Fehler');
    const body: ErrorBody = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Interner Fehler. Bitte später erneut versuchen.',
        correlationId: request.id,
      },
    };
    void reply.status(500).send(body);
  });

  app.get('/health', async () => ({
    status: 'ok',
    version: API_VERSION,
    environment: config.appEnv,
  }));

  app.get('/ready', async (request, reply) => {
    if (pool === undefined) {
      const body: ErrorBody = {
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: 'Datenbankverbindung nicht konfiguriert',
          correlationId: request.id,
        },
      };
      return reply.status(503).send(body);
    }
    try {
      await pingDatabase(pool);
      return { status: 'ready' };
    } catch (error) {
      request.log.error({ err: error }, 'Readiness-Check fehlgeschlagen');
      const body: ErrorBody = {
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: 'Datenbank nicht erreichbar',
          correlationId: request.id,
        },
      };
      return reply.status(503).send(body);
    }
  });

  return app;
}
