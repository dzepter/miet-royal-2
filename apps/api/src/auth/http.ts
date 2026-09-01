import type { AppConfig } from '@mietroyal/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PermissionKey } from '@mietroyal/permissions';
import { AuthError, type AuthenticatedContext, type StaffAuthService } from './service.ts';

export const SESSION_COOKIE_NAME = 'mr_staff_session';

export function sendError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): void {
  void reply.status(status).send({
    error: { code, message, correlationId: request.id },
  });
}

const AUTH_ERROR_STATUS: Record<AuthError['code'], number> = {
  INVALID_CREDENTIALS: 401,
  INVALID_TOKEN: 401,
  INVALID_CODE: 400,
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LAST_ADMIN: 409,
};

/** Mappt AuthError auf eine strukturierte Antwort; andere Fehler laufen weiter. */
export function sendAuthError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
): boolean {
  if (error instanceof AuthError) {
    sendError(request, reply, AUTH_ERROR_STATUS[error.code], error.code, error.message);
    return true;
  }
  return false;
}

export function setSessionCookie(reply: FastifyReply, config: AppConfig, token: string): void {
  void reply.setCookie(SESSION_COOKIE_NAME, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.appEnv !== 'development',
    // 30 Tage: passend zur serverseitigen Inaktivitätsgrenze. Ohne maxAge
    // würde der Browser das Cookie beim Schließen löschen und die 30-Tage-
    // Gerätesession wäre praktisch nie erreichbar. Autorität bleibt der
    // Server (Widerruf/Ablauf gelten unabhängig vom Cookie).
    maxAge: 30 * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  void reply.clearCookie(SESSION_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.appEnv !== 'development',
  });
}

/**
 * Authentifiziert die Anfrage über das Session-Cookie.
 * Bei aktiver 15-Minuten-App-Sperre werden nur Endpunkte mit
 * allowLocked=true bedient (Entsperren, Logout, /auth/me).
 * Antwortet selbst mit 401 und gibt dann null zurück.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: StaffAuthService,
  config: AppConfig,
  options: { allowLocked?: boolean } = {},
): Promise<AuthenticatedContext | null> {
  const token = request.cookies?.[SESSION_COOKIE_NAME];
  if (token === undefined || token === '') {
    sendError(request, reply, 401, 'UNAUTHENTICATED', 'Bitte anmelden.');
    return null;
  }
  const context = await auth.authenticate(token);
  if (context === null) {
    clearSessionCookie(reply, config);
    sendError(request, reply, 401, 'UNAUTHENTICATED', 'Bitte anmelden.');
    return null;
  }
  if (context.appLocked && options.allowLocked !== true) {
    sendError(request, reply, 401, 'APP_LOCKED', 'App gesperrt – bitte entsperren.');
    return null;
  }
  return context;
}

/**
 * Serverseitige Rechteprüfung – IMMER frisch berechnet (Rechteänderungen
 * gelten sofort, nichts wird in der Session eingefroren). Antwortet selbst
 * mit 403 und gibt false zurück, wenn das Recht fehlt.
 */
export async function requirePermission(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: StaffAuthService,
  context: AuthenticatedContext,
  permissionKey: PermissionKey,
): Promise<boolean> {
  const effective = await auth.effectivePermissions(context.user.id);
  if (!effective.has(permissionKey)) {
    sendError(request, reply, 403, 'FORBIDDEN', 'Dafür fehlt dir die erforderliche Berechtigung.');
    return false;
  }
  return true;
}

/**
 * CSRF-Schutz passend zur Architektur (SameSite=Strict-Cookie + Same-Origin-
 * Proxy der Staff-App): zustandsändernde Anfragen aus fremdem Kontext werden
 * abgelehnt. Moderne Browser senden Sec-Fetch-Site; 'cross-site' wird
 * blockiert. Legacy-Fälle ohne Sec-Fetch-Site mit Origin-Header müssen auf
 * der Allowlist stehen. Anfragen ohne Browser-Header (Tests, curl) tragen
 * keine Ambient-Credentials im CSRF-Sinn und passieren.
 */
export function csrfRejects(request: FastifyRequest, allowedOrigins: readonly string[]): boolean {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;

  const secFetchSite = request.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string') {
    // Nur same-origin (und 'none' = direkte Nutzeraktion) ist erlaubt.
    // 'same-site' wird ebenfalls blockiert: eine kompromittierte Schwester-
    // Subdomain darf keine Staff-Aktionen auslösen.
    return secFetchSite === 'cross-site' || secFetchSite === 'same-site';
  }
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') {
    return !allowedOrigins.includes(origin);
  }
  if (origin === 'null') return true;
  return false;
}
