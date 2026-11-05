import type { AppConfig, AppEnvironment } from '@mietroyal/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sendError } from '../auth/http.ts';
import { PORTAL_MESSAGES, type PortalSessionContext } from './types.ts';

/**
 * Phase 15 (Order §9): Cookie der Portal-Session. Außerhalb von development
 * `__Host-`-Präfix (Secure, Path=/, kein Domain – vom Browser erzwungen),
 * in development ohne Präfix, weil `__Host-` Secure verlangt.
 */
export const PORTAL_SESSION_COOKIE_DEVELOPMENT = 'mr_customer_session';
export const PORTAL_SESSION_COOKIE_HOST_PREFIXED = '__Host-mr_customer_session';

export function portalSessionCookieName(appEnv: AppEnvironment): string {
  return appEnv === 'development'
    ? PORTAL_SESSION_COOKIE_DEVELOPMENT
    : PORTAL_SESSION_COOKIE_HOST_PREFIXED;
}

/** Sessiontoken: 32 Zufallsbytes base64url ⇒ exakt 43 Zeichen. */
const PORTAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isWellFormedPortalToken(value: unknown): value is string {
  return typeof value === 'string' && PORTAL_TOKEN_PATTERN.test(value);
}

/**
 * Schnittstelle, die der AUTH-Teil implementiert: liefert den Session-Kontext
 * zu einem Klartext-Sessiontoken oder `null` (unbekannt, abgelaufen, widerrufen,
 * Kunde gelöscht). `touch` darf `last_seen_at` gedrosselt schreiben, verlängert
 * aber NIE `expires_at`.
 */
export interface PortalSessionAuthenticator {
  authenticate(
    token: string,
    options?: { now?: Date; touch?: boolean },
  ): Promise<PortalSessionContext | null>;
}

/**
 * Zentrale Portal-Authentifizierung für alle `/portal/*`-Routen außer der
 * Auth-Grenze selbst. Ohne gültige Session: 401 `PORTAL_UNAUTHENTICATED` und
 * das Cookie wird gelöscht. Gibt den Kontext zurück oder `null`, wenn die
 * Antwort bereits gesendet wurde.
 */
export async function requirePortalSession(
  request: FastifyRequest,
  reply: FastifyReply,
  authenticator: PortalSessionAuthenticator,
  config: AppConfig,
  options: { now?: Date; touch?: boolean } = {},
): Promise<PortalSessionContext | null> {
  const cookieName = portalSessionCookieName(config.appEnv);
  const token = request.cookies[cookieName];
  if (!isWellFormedPortalToken(token)) {
    sendError(request, reply, 401, 'PORTAL_UNAUTHENTICATED', PORTAL_MESSAGES.UNAUTHENTICATED);
    return null;
  }
  const context = await authenticator.authenticate(token, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.touch === undefined ? {} : { touch: options.touch }),
  });
  if (context === null) {
    clearPortalSessionCookie(reply, config);
    sendError(request, reply, 401, 'PORTAL_UNAUTHENTICATED', PORTAL_MESSAGES.UNAUTHENTICATED);
    return null;
  }
  return context;
}

/** Portal-Cookie setzen (Order §9): HttpOnly, Secure außerhalb development, Path=/, kein Domain, SameSite=Strict. */
export function setPortalSessionCookie(
  reply: FastifyReply,
  config: AppConfig,
  token: string,
  expiresAt: Date,
  now: Date = new Date(),
): void {
  const maxAge = Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  void reply.setCookie(portalSessionCookieName(config.appEnv), token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.appEnv !== 'development',
    maxAge,
  });
}

export function clearPortalSessionCookie(reply: FastifyReply, config: AppConfig): void {
  void reply.clearCookie(portalSessionCookieName(config.appEnv), {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.appEnv !== 'development',
  });
}
