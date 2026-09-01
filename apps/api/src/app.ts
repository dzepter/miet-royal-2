import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import type { AppConfig } from '@mietroyal/config';
import { createDb, pingDatabase } from '@mietroyal/database';
import { RequestValidationError } from '@mietroyal/validation';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { StaffAdminService } from './auth/admin-service.ts';
import { csrfRejects } from './auth/http.ts';
import { createMailAdapter, type StaffMailPort } from './auth/mail.ts';
import { StaffAuthService } from './auth/service.ts';
import { registerAuthRoutes } from './routes/auth.ts';
import { registerStaffAdminRoutes } from './routes/staff-admin.ts';

export const API_VERSION = '0.1.0';

const CORRELATION_ID_HEADER = 'x-correlation-id';
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export interface AppOptions {
  config: AppConfig;
  /** Ohne Pool antwortet /ready mit 503 und Auth-Routen fehlen (reine Unit-Tests). */
  pool?: pg.Pool;
  /** Test-Injection für den Mailversand (Default: umgebungsabhängiger Adapter). */
  mailAdapter?: StaffMailPort;
  /** Brute-Force-Limits; in Integrationstests abschaltbar. Default: true. */
  rateLimitEnabled?: boolean;
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

export function buildApp({
  config,
  pool,
  mailAdapter,
  rateLimitEnabled = true,
}: AppOptions): FastifyInstance {
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
    // 0 = keinem Proxy vertrauen; hinter dem Staff-Proxy/nginx die Hop-Zahl
    // setzen (API_TRUST_PROXY_HOPS), damit request.ip – und damit das
    // Brute-Force-Limit – die echte Client-IP trifft statt der Proxy-IP.
    // Niemals pauschal true (X-Forwarded-For wäre von Direktaufrufern fälschbar).
    trustProxy:
      config.api.trustProxyHops > 0
        ? (_address: string, hop: number) => hop < config.api.trustProxyHops
        : false,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header(CORRELATION_ID_HEADER, request.id);
  });

  void app.register(fastifyCookie);
  if (rateLimitEnabled) {
    // global:false – Limits gelten gezielt auf den Auth-Endpunkten.
    // hook 'preHandler': erst nach dem Body-Parsing, damit die keyGeneratoren
    // E-Mail/Challenge aus dem Body in den Limit-Schlüssel aufnehmen können.
    void app.register(fastifyRateLimit, { global: false, hook: 'preHandler' });
  }

  // CSRF-Schutz für zustandsändernde Anfragen (Details: auth/http.ts).
  app.addHook('onRequest', async (request, reply) => {
    if (csrfRejects(request, config.auth.allowedOrigins)) {
      const body: ErrorBody = {
        error: {
          code: 'CSRF_REJECTED',
          message: 'Anfrage aus fremdem Kontext abgelehnt.',
          correlationId: request.id,
        },
      };
      void reply.status(403).send(body);
    }
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

    // Unique-Constraint-Rennen (z. B. doppelte E-Mail/Rollenname parallel):
    // korrektes 409 statt generischem 500.
    if ((error as { code?: unknown }).code === '23505') {
      const body: ErrorBody = {
        error: {
          code: 'CONFLICT',
          message: 'Der Eintrag existiert bereits.',
          correlationId: request.id,
        },
      };
      void reply.status(409).send(body);
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

  if (pool !== undefined) {
    const db = createDb(pool);
    const authService = new StaffAuthService(db, config, mailAdapter ?? createMailAdapter(config));
    const adminService = new StaffAdminService(authService);
    // Als Plugin NACH @fastify/rate-limit registrieren, damit dessen
    // onRoute-Hook die per-Route-Limits der Auth-Endpunkte wirklich anwendet.
    void app.register(async (instance) => {
      registerAuthRoutes(instance, {
        auth: authService,
        config,
        rateLimitEnabled,
      });
      registerStaffAdminRoutes(instance, { auth: authService, admin: adminService, config });
    });
  }

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
