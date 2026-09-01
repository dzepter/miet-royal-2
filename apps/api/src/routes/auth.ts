import type { AppConfig } from '@mietroyal/config';
import { parseOrThrow, z } from '@mietroyal/validation';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { deviceLabelFromUserAgent } from '../auth/device.ts';
import {
  clearSessionCookie,
  requireAuth,
  sendAuthError,
  sendError,
  setSessionCookie,
} from '../auth/http.ts';
import { NEUTRAL_LOGIN_MESSAGE, type StaffAuthService } from '../auth/service.ts';

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const loginSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(200),
});
const totpLoginSchema = z.object({
  challengeToken: z.string().min(10).max(200),
  code: z.string().min(4).max(12),
});
const recoveryLoginSchema = z.object({
  challengeToken: z.string().min(10).max(200),
  recoveryCode: z.string().min(6).max(20),
});
const challengeSchema = z.object({ challengeToken: z.string().min(10).max(200) });
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});
const forgotSchema = z.object({ email: z.string().min(3).max(320) });
const resetSchema = z.object({
  token: z.string().min(10).max(200),
  newPassword: z.string().min(1).max(200),
});
const unlockSchema = z.object({ password: z.string().min(1).max(200) });
const codeSchema = z.object({ code: z.string().min(4).max(12) });

interface AuthRouteOptions {
  auth: StaffAuthService;
  config: AppConfig;
  /** Rate-Limits für Brute-Force-Schutz (in Tests abschaltbar). */
  rateLimitEnabled: boolean;
}

function publicUser(user: {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  totpEnabled: boolean;
  totpRequired: boolean;
}) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    totpEnabled: user.totpEnabled,
    totpRequired: user.totpRequired,
  };
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { auth, config } = options;

  /**
   * Strenge Limits für Credential-Endpunkte (Brute-Force-Bremse).
   * Schlüssel = Client-IP PLUS Ziel (E-Mail / Challenge / Session): So bleibt
   * das Limit auch dann pro Konto wirksam, wenn alle Anfragen über denselben
   * Proxy-Hop eintreffen (Staff-Same-Origin-Proxy) – und eine einzelne
   * Quelle kann nicht das Login für alle blockieren.
   */
  const boundedBodyField = (request: FastifyRequest, field: string): string => {
    const value = (request.body as Record<string, unknown> | null | undefined)?.[field];
    return typeof value === 'string' ? value.trim().toLowerCase().slice(0, 80) : '';
  };
  const keyed = (max: number, timeWindow: string, keyOf: (request: FastifyRequest) => string) =>
    options.rateLimitEnabled ? { rateLimit: { max, timeWindow, keyGenerator: keyOf } } : false;
  const strictLimit = keyed(10, '1 minute', (r) => `${r.ip}|${boundedBodyField(r, 'email')}`);
  const challengeLimit = keyed(
    10,
    '1 minute',
    (r) => `${r.ip}|${boundedBodyField(r, 'challengeToken')}`,
  );
  const sessionLimit = keyed(
    10,
    '1 minute',
    (r) => `${r.ip}|${r.cookies?.mr_staff_session?.slice(0, 32) ?? ''}`,
  );
  const resetLimit = keyed(
    5,
    '15 minutes',
    (r) => `${r.ip}|${boundedBodyField(r, 'email')}${boundedBodyField(r, 'token')}`,
  );

  app.post('/auth/login', { config: strictLimit }, async (request, reply) => {
    const body = parseOrThrow(loginSchema, request.body);
    const deviceLabel = deviceLabelFromUserAgent(request.headers['user-agent']);
    const result = await auth.login({ ...body, deviceLabel });

    if (result.kind === 'failed') {
      sendError(request, reply, 401, 'LOGIN_FAILED', NEUTRAL_LOGIN_MESSAGE);
      return;
    }
    if (result.kind === 'totp_required' || result.kind === 'totp_setup_required') {
      return { next: result.kind, challengeToken: result.challengeToken };
    }
    setSessionCookie(reply, config, result.sessionToken);
    return { next: 'authenticated', user: publicUser(result.user) };
  });

  app.post('/auth/login/totp', { config: challengeLimit }, async (request, reply) => {
    const body = parseOrThrow(totpLoginSchema, request.body);
    try {
      const { sessionToken, user } = await auth.completeTotpLogin(body);
      setSessionCookie(reply, config, sessionToken);
      return { next: 'authenticated', user: publicUser(user) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/auth/login/recovery', { config: challengeLimit }, async (request, reply) => {
    const body = parseOrThrow(recoveryLoginSchema, request.body);
    try {
      const { sessionToken, user } = await auth.completeRecoveryLogin(body);
      setSessionCookie(reply, config, sessionToken);
      return { next: 'authenticated', user: publicUser(user) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // Erzwungene 2FA-Einrichtung beim Login (Challenge-basiert, noch ohne Session)
  app.post('/auth/totp/setup/begin', { config: challengeLimit }, async (request, reply) => {
    const body = parseOrThrow(challengeSchema, request.body);
    try {
      const { otpauthUri, secret } = await auth.beginTotpSetupWithChallenge(body.challengeToken);
      return { otpauthUri, secret, qrDataUrl: await QRCode.toDataURL(otpauthUri) };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.post('/auth/totp/setup/confirm', { config: challengeLimit }, async (request, reply) => {
    const body = parseOrThrow(totpLoginSchema, request.body);
    try {
      const { sessionToken, user, recoveryCodes } = await auth.confirmTotpSetupWithChallenge(body);
      setSessionCookie(reply, config, sessionToken);
      return { next: 'authenticated', user: publicUser(user), recoveryCodes };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  // Freiwillige 2FA-Einrichtung im eingeloggten Zustand
  app.post('/auth/totp/self/begin', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    if (context.user.totpEnabled) {
      sendError(request, reply, 409, 'CONFLICT', '2FA ist bereits eingerichtet.');
      return;
    }
    const { otpauthUri, secret } = await auth.beginTotpSetupForUser(context.user);
    return { otpauthUri, secret, qrDataUrl: await QRCode.toDataURL(otpauthUri) };
  });

  app.post('/auth/totp/self/confirm', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const body = parseOrThrow(codeSchema, request.body);
    try {
      const { recoveryCodes } = await auth.confirmTotpSetupForUser(context.user.id, body.code);
      return { recoveryCodes };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  app.get('/auth/me', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config, { allowLocked: true });
    if (context === null) return;
    if (context.appLocked) {
      // Gesperrter Zustand: nur das Nötigste für den Sperrbildschirm.
      return {
        appLocked: true,
        user: { firstName: context.user.firstName, lastName: context.user.lastName },
      };
    }
    const permissions = await auth.effectivePermissions(context.user.id);
    return {
      appLocked: false,
      user: publicUser(context.user),
      permissions: [...permissions].sort(),
    };
  });

  app.post('/auth/unlock', { config: sessionLimit }, async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config, { allowLocked: true });
    if (context === null) return;
    const body = parseOrThrow(unlockSchema, request.body);
    const ok = await auth.unlock(context, body.password);
    if (!ok) {
      sendError(request, reply, 401, 'INVALID_CREDENTIALS', 'Das Passwort ist falsch.');
      return;
    }
    return { unlocked: true };
  });

  app.post('/auth/logout', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config, { allowLocked: true });
    if (context === null) return;
    await auth.revokeSessionById(context.session.id, 'logout', context.user.id);
    clearSessionCookie(reply, config);
    return { loggedOut: true };
  });

  app.get('/auth/sessions', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const sessions = await auth.db.query.staffSessions.findMany({
      where: (table, { eq }) => eq(table.userId, context.user.id),
      orderBy: (table, { desc }) => desc(table.lastActivityAt),
      columns: {
        id: true,
        deviceLabel: true,
        createdAt: true,
        lastActivityAt: true,
        revokedAt: true,
      },
    });
    return {
      currentSessionId: context.session.id,
      sessions,
    };
  });

  /** Eigenes Gerät abmelden – strikt auf die eigene Person begrenzt (IDOR). */
  app.post('/auth/sessions/:sessionId/revoke', async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const params = parseOrThrow(
      z.object({ sessionId: z.string().regex(UUID_PATTERN, 'muss eine UUID sein') }),
      request.params,
      'params',
    );
    const target = await auth.db.query.staffSessions.findFirst({
      where: (table, { eq }) => eq(table.id, params.sessionId),
    });
    if (target === undefined || target.userId !== context.user.id) {
      sendError(request, reply, 404, 'NOT_FOUND', 'Sitzung nicht gefunden.');
      return;
    }
    await auth.revokeSessionById(target.id, 'self_revoked', context.user.id);
    return { revoked: true };
  });

  app.post('/auth/password/change', { config: sessionLimit }, async (request, reply) => {
    const context = await requireAuth(request, reply, auth, config);
    if (context === null) return;
    const body = parseOrThrow(passwordChangeSchema, request.body);
    try {
      await auth.changePassword(context, body.currentPassword, body.newPassword);
      return { changed: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });

  /** Antwort ist immer neutral – verrät nicht, ob die E-Mail existiert. */
  app.post('/auth/password/forgot', { config: resetLimit }, async (request) => {
    const body = parseOrThrow(forgotSchema, request.body);
    await auth.requestPasswordReset(body.email);
    return {
      message:
        'Falls ein Konto zu dieser E-Mail existiert, wurde ein Link zum Zurücksetzen verschickt.',
    };
  });

  app.post('/auth/password/reset', { config: resetLimit }, async (request, reply) => {
    const body = parseOrThrow(resetSchema, request.body);
    try {
      await auth.resetPassword(body.token, body.newPassword);
      return { reset: true };
    } catch (error) {
      if (sendAuthError(request, reply, error)) return;
      throw error;
    }
  });
}
