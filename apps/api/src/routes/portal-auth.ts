import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { recordSecurityEvent } from '../auth/audit.ts';
import { sha256Hex } from '../auth/crypto.ts';
import { authErrorStatus, sendAuthError, sendError } from '../auth/http.ts';
import { AuthError } from '../auth/service.ts';
import { CustomerService } from '../crm/customer-service.ts';
import { normalizeEmailAddress } from '../crm/normalize.ts';
import { isReauthFresh } from '../portal/auth/constants.ts';
import type { PortalMagicLinkService } from '../portal/auth/magic-link-service.ts';
import { portalUserAgentLabel, type PortalSessionService } from '../portal/auth/session-service.ts';
import { buildPortalMeView } from '../portal/auth/views.ts';
import {
  clearPortalSessionCookie,
  isWellFormedPortalToken,
  portalSessionCookieName,
  requirePortalSession,
  setPortalSessionCookie,
} from '../portal/guard.ts';
import { PORTAL_MESSAGES, PortalError } from '../portal/types.ts';

/**
 * Phase 15 (Design §1.2): Auth-Grenze des Kundenportals. Staff-Cookie und
 * Angebots-Token werden hier NIE gelesen – nur das Portal-Cookie bzw. Tokens
 * aus dem POST-Body. Kein GET-Consume (Mail-Scanner).
 */
export interface PortalAuthRouteDeps {
  db: Database;
  config: AppConfig;
  sessions: PortalSessionService;
  magicLinks: PortalMagicLinkService;
  /** Default: aktiv, wenn @fastify/rate-limit registriert ist. */
  rateLimitEnabled?: boolean | undefined;
}

const requestSchema = z.strictObject({ email: z.string().min(1).max(320) });
const tokenSchema = z.strictObject({ token: z.string().min(1).max(200) });

/** Konstante Mindestdauer der Login-Anforderung – alle Pfade antworten gleich schnell (Order §11). */
const REQUEST_MIN_DURATION_MS = 150;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const PORTAL_REAUTH_REQUESTED_MESSAGE = 'Wir haben dir einen Bestätigungslink geschickt.';
export const PORTAL_EMAIL_CHANGE_REQUESTED_MESSAGE =
  'Wir haben einen Bestätigungslink an die neue Adresse geschickt.';

/**
 * IP-weiter Zusatzschutz der Login-Anforderung (30/min je IP, Fenster 60 s) –
 * @fastify/rate-limit erlaubt nur EINE Konfiguration je Route (dort Key
 * `ip|hash(E-Mail)`). Kleine In-Memory-Map, Einträge räumen sich selbst.
 */
export class IpWindowLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** true ⇒ Anfrage erlaubt. */
  hit(key: string, nowMs: number = Date.now()): boolean {
    if (this.hits.size > 10_000) this.prune(nowMs);
    const entry = this.hits.get(key);
    if (entry === undefined || nowMs - entry.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: nowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  private prune(nowMs: number): void {
    for (const [key, entry] of this.hits) {
      if (nowMs - entry.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}

function sendPortalError(request: FastifyRequest, reply: FastifyReply, error: unknown): boolean {
  if (error instanceof PortalError) {
    sendError(request, reply, authErrorStatus(error.code), error.portalCode, error.message);
    return true;
  }
  return sendAuthError(request, reply, error);
}

export function registerPortalAuthRoutes(app: FastifyInstance, deps: PortalAuthRouteDeps): void {
  const { config, sessions, magicLinks } = deps;
  const customersService = new CustomerService(deps.db);
  const rateLimitEnabled = deps.rateLimitEnabled ?? app.hasDecorator('rateLimit');
  const keyed = (max: number, timeWindow: string, keyOf: (request: FastifyRequest) => string) =>
    rateLimitEnabled ? { rateLimit: { max, timeWindow, keyGenerator: keyOf } } : false;
  const ipLimiter = new IpWindowLimiter(30, 60_000);

  const emailHashOf = (request: FastifyRequest): string => {
    const value = (request.body as Record<string, unknown> | null | undefined)?.email;
    const normalized =
      typeof value === 'string' ? normalizeEmailAddress(value.slice(0, 320)) : null;
    // Nicht rückrechenbarer Schlüsselanteil – die Adresse selbst erscheint nirgends.
    return sha256Hex(normalized ?? '').slice(0, 32);
  };
  const sessionKeyOf = (request: FastifyRequest): string => {
    const token = request.cookies[portalSessionCookieName(config.appEnv)];
    return `${request.ip}|${isWellFormedPortalToken(token) ? sha256Hex(token).slice(0, 32) : ''}`;
  };
  const requestLimit = keyed(10, '1 minute', (r) => `${r.ip}|${emailHashOf(r)}`);
  const ipLimit = keyed(10, '1 minute', (r) => r.ip);
  const reauthLimit = keyed(5, '15 minutes', sessionKeyOf);

  // ── Anmeldung ─────────────────────────────────────────────────────────────

  app.post('/portal/auth/request', { config: requestLimit }, async (request, reply) => {
    const body = parseOrThrow(requestSchema, request.body);
    if (rateLimitEnabled && !ipLimiter.hit(request.ip)) {
      sendError(
        request,
        reply,
        429,
        'RATE_LIMITED',
        'Zu viele Versuche. Bitte warte einen Moment.',
      );
      return;
    }
    // Immer derselbe Pfad, dieselbe Mindestdauer, dieselbe Antwort – Fehler nur loggen.
    const work = magicLinks.requestLogin(body.email).catch((error: unknown) => {
      request.log.error(
        { errorClass: error instanceof Error ? error.name : 'unknown' },
        'portal.magic_link.request_failed',
      );
    });
    await Promise.all([work, delay(REQUEST_MIN_DURATION_MS)]);
    return reply.status(202).send({ message: PORTAL_MESSAGES.MAGIC_LINK_REQUESTED });
  });

  app.post('/portal/auth/consume', { config: ipLimit }, async (request, reply) => {
    const body = parseOrThrow(tokenSchema, request.body);
    const now = new Date();
    try {
      const result = await magicLinks.consumeLogin(body.token, now, {
        userAgentLabel: portalUserAgentLabel(request.headers['user-agent']),
      });
      setPortalSessionCookie(reply, config, result.sessionToken, result.expiresAt, now);
      return { authenticated: true, expiresAt: result.expiresAt.toISOString() };
    } catch (error) {
      if (sendPortalError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/portal/auth/logout', async (request, reply) => {
    const token = request.cookies[portalSessionCookieName(config.appEnv)];
    const now = new Date();
    if (isWellFormedPortalToken(token)) {
      const context = await sessions.authenticate(token, { now });
      if (context !== null) {
        await sessions.revoke(context.sessionId, now);
        await recordSecurityEvent(deps.db, {
          type: 'portal.logout',
          details: { customerId: context.customerId, sessionId: context.sessionId },
        });
      }
    }
    clearPortalSessionCookie(reply, config);
    return reply.status(204).send();
  });

  app.get('/portal/me', async (request, reply) => {
    const now = new Date();
    const session = await requirePortalSession(request, reply, sessions, config, {
      now,
      touch: true,
    });
    if (session === null) return;
    try {
      const customer = await customersService.getActiveCustomer(session.customerId);
      return buildPortalMeView({
        customer,
        sessionExpiresAt: session.expiresAt,
        reauthFresh: isReauthFresh(session.reauthenticatedAt, now),
        links: {
          newInquiryUrl: config.portal.newInquiryUrl,
          phoneNumber: config.portal.phoneNumber,
        },
        environment: config.appEnv,
      });
    } catch (error) {
      if (error instanceof AuthError && error.code === 'NOT_FOUND') {
        clearPortalSessionCookie(reply, config);
        sendError(request, reply, 401, 'PORTAL_UNAUTHENTICATED', PORTAL_MESSAGES.UNAUTHENTICATED);
        return;
      }
      throw error;
    }
  });

  // ── Reauth (Order §32) ────────────────────────────────────────────────────

  app.post('/portal/auth/reauth/request', { config: reauthLimit }, async (request, reply) => {
    const now = new Date();
    const session = await requirePortalSession(request, reply, sessions, config, { now });
    if (session === null) return;
    try {
      await magicLinks.requestReauth(session, now);
    } catch (error) {
      request.log.error(
        { errorClass: error instanceof Error ? error.name : 'unknown' },
        'portal.reauth.request_failed',
      );
    }
    return reply.status(202).send({ message: PORTAL_REAUTH_REQUESTED_MESSAGE });
  });

  app.post('/portal/auth/reauth/consume', { config: ipLimit }, async (request, reply) => {
    const body = parseOrThrow(tokenSchema, request.body);
    const now = new Date();
    const session = await requirePortalSession(request, reply, sessions, config, { now });
    if (session === null) return;
    try {
      const result = await magicLinks.consumeReauth(body.token, session, now);
      return { reauthenticatedAt: result.reauthenticatedAt.toISOString() };
    } catch (error) {
      if (sendPortalError(request, reply, error)) return;
      throw error;
    }
  });

  // ── E-Mail-Wechsel (Order §34/§35) ────────────────────────────────────────

  app.post('/portal/auth/email-change/request', { config: reauthLimit }, async (request, reply) => {
    const body = parseOrThrow(requestSchema, request.body);
    const now = new Date();
    const session = await requirePortalSession(request, reply, sessions, config, { now });
    if (session === null) return;
    try {
      await magicLinks.requestEmailChange(session, body.email, now);
      return reply.status(202).send({ message: PORTAL_EMAIL_CHANGE_REQUESTED_MESSAGE });
    } catch (error) {
      if (sendPortalError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/portal/auth/email-change/consume', { config: ipLimit }, async (request, reply) => {
    const body = parseOrThrow(tokenSchema, request.body);
    try {
      await magicLinks.consumeEmailChange(body.token, new Date());
      // Alle Sessions des Kunden sind widerrufen – auch das Cookie dieses Geräts (falls vorhanden).
      clearPortalSessionCookie(reply, config);
      return { changed: true, message: PORTAL_MESSAGES.EMAIL_CHANGED };
    } catch (error) {
      if (sendPortalError(request, reply, error)) return;
      throw error;
    }
  });
}
