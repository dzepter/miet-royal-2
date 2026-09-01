import type { AppConfig } from '@mietroyal/config';
import {
  staffLoginChallenges,
  staffPasswordResetTokens,
  staffRecoveryCodes,
  staffRolePermissions,
  staffSessions,
  staffUserPermissionOverrides,
  staffUserRoles,
  staffUsers,
  type Database,
  type StaffSession,
  type StaffUser,
} from '@mietroyal/database';
import {
  computeEffectivePermissions,
  hasAdminCapability,
  type PermissionKey,
  type PermissionOverride,
} from '@mietroyal/permissions';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { recordSecurityEvent, type SecurityEventInput } from './audit.ts';
import {
  encryptSecret,
  decryptSecret,
  generateRecoveryCode,
  generateToken,
  normalizeRecoveryCode,
  sha256Hex,
} from './crypto.ts';
import type { StaffMailPort } from './mail.ts';
import { hashPassword, validateNewPassword, verifyPassword } from './passwords.ts';
import { buildOtpauthUri, generateTotpSecret, verifyTotpCode } from './totp.ts';

/** 30 Tage Inaktivität → Session endgültig ungültig (ARCHITECTURE.md). */
export const SESSION_INACTIVITY_MS = 30 * 24 * 60 * 60 * 1000;
/** 15 Minuten Inaktivität → App-Sperre; Session bleibt bestehen. */
export const APP_LOCK_MS = 15 * 60 * 1000;
/** Login-Challenge (zwischen Passwort und 2. Faktor): 5 Minuten. */
export const LOGIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Passwort-Reset-Token: 60 Minuten, einmal verwendbar. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
/** last_activity-Schreibdrosselung. */
const ACTIVITY_WRITE_THROTTLE_MS = 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;

/** Neutrale Meldung für alle Login-Fehlschläge (keine internen Details). */
export const NEUTRAL_LOGIN_MESSAGE =
  'Anmeldung nicht möglich. Bitte prüfe E-Mail und Passwort oder wende dich an die Verwaltung.';

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'INVALID_TOKEN'
  | 'INVALID_CODE'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'LAST_ADMIN';

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

export type LoginResult =
  | { kind: 'failed' }
  | { kind: 'totp_required'; challengeToken: string }
  | { kind: 'totp_setup_required'; challengeToken: string }
  | { kind: 'session'; sessionToken: string; user: StaffUser };

export interface AuthenticatedContext {
  user: StaffUser;
  session: StaffSession;
  /** true = 15-Minuten-App-Sperre aktiv; Session bleibt gültig. */
  appLocked: boolean;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class StaffAuthService {
  readonly db: Database;
  private readonly config: AppConfig;
  private readonly mail: StaffMailPort;
  private dummyHashPromise: Promise<string> | undefined;

  constructor(db: Database, config: AppConfig, mail: StaffMailPort) {
    this.db = db;
    this.config = config;
    this.mail = mail;
  }

  private async dummyHash(): Promise<string> {
    this.dummyHashPromise ??= hashPassword(generateToken());
    return this.dummyHashPromise;
  }

  private audit(event: SecurityEventInput): Promise<void> {
    return recordSecurityEvent(this.db, event);
  }

  // ── Rechte ────────────────────────────────────────────────────────────────

  /**
   * Effektive Rechte IMMER frisch aus der Datenbank (Phase-1-Vorgabe Nr. 11:
   * Rechteänderungen gelten sofort, nichts wird in der Session eingefroren).
   */
  async effectivePermissions(
    userId: string,
    now = new Date(),
  ): Promise<ReadonlySet<PermissionKey>> {
    const roleKeys = await this.db
      .select({ permissionKey: staffRolePermissions.permissionKey })
      .from(staffUserRoles)
      .innerJoin(staffRolePermissions, eq(staffUserRoles.roleId, staffRolePermissions.roleId))
      .where(eq(staffUserRoles.userId, userId));

    const overrides = await this.db
      .select()
      .from(staffUserPermissionOverrides)
      .where(eq(staffUserPermissionOverrides.userId, userId));

    return computeEffectivePermissions({
      rolePermissionKeys: roleKeys.map((r) => r.permissionKey),
      overrides: overrides.map((o): PermissionOverride => ({
        permissionKey: o.permissionKey,
        effect: o.effect,
        validFrom: o.validFrom,
        validUntil: o.validUntil,
      })),
      now,
    });
  }

  // ── Login ────────────────────────────────────────────────────────────────

  async login(input: {
    email: string;
    password: string;
    deviceLabel: string;
  }): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const user = await this.findUserByEmail(email);

    if (user === undefined) {
      // Timing angleichen: auch für unbekannte E-Mails eine Argon2-Prüfung.
      await verifyPassword(await this.dummyHash(), input.password);
      return { kind: 'failed' };
    }

    const passwordOk = await verifyPassword(user.passwordHash, input.password);
    if (!passwordOk) return { kind: 'failed' };

    // Gesperrt/deaktiviert: exakt dieselbe neutrale Antwort wie „falsches
    // Passwort“ – keine internen Details nach außen.
    if (user.status !== 'active') return { kind: 'failed' };

    if (user.totpEnabled) {
      const challengeToken = await this.createLoginChallenge(user.id, 'totp', input.deviceLabel);
      return { kind: 'totp_required', challengeToken };
    }
    if (user.totpRequired) {
      const challengeToken = await this.createLoginChallenge(
        user.id,
        'totp_setup',
        input.deviceLabel,
      );
      return { kind: 'totp_setup_required', challengeToken };
    }

    const sessionToken = await this.createSession(user, input.deviceLabel);
    return { kind: 'session', sessionToken, user };
  }

  private async createLoginChallenge(
    userId: string,
    purpose: 'totp' | 'totp_setup',
    deviceLabel: string,
  ): Promise<string> {
    const token = generateToken();
    await this.db.insert(staffLoginChallenges).values({
      userId,
      tokenHash: sha256Hex(token),
      purpose,
      deviceLabel,
      expiresAt: new Date(Date.now() + LOGIN_CHALLENGE_TTL_MS),
    });
    return token;
  }

  private async consumeableChallenge(
    challengeToken: string,
    purpose: 'totp' | 'totp_setup',
  ): Promise<{ id: string; userId: string; deviceLabel: string; user: StaffUser }> {
    const rows = await this.db
      .select()
      .from(staffLoginChallenges)
      .where(eq(staffLoginChallenges.tokenHash, sha256Hex(challengeToken)));
    const challenge = rows[0];
    if (
      challenge === undefined ||
      challenge.purpose !== purpose ||
      challenge.consumedAt !== null ||
      challenge.expiresAt.getTime() <= Date.now()
    ) {
      throw new AuthError('INVALID_TOKEN', NEUTRAL_LOGIN_MESSAGE);
    }
    const user = await this.findUserById(challenge.userId);
    if (user === undefined || user.status !== 'active') {
      throw new AuthError('INVALID_TOKEN', NEUTRAL_LOGIN_MESSAGE);
    }
    return { id: challenge.id, userId: challenge.userId, deviceLabel: challenge.deviceLabel, user };
  }

  /** Atomar: schlägt fehl, wenn die Challenge parallel bereits verbraucht wurde. */
  private async consumeChallenge(challengeId: string): Promise<void> {
    const consumed = await this.db
      .update(staffLoginChallenges)
      .set({ consumedAt: new Date() })
      .where(and(eq(staffLoginChallenges.id, challengeId), isNull(staffLoginChallenges.consumedAt)))
      .returning({ id: staffLoginChallenges.id });
    if (consumed.length === 0) {
      throw new AuthError('INVALID_TOKEN', NEUTRAL_LOGIN_MESSAGE);
    }
  }

  /** Zweiter Login-Schritt: TOTP-Code. Falscher Code verbraucht die Challenge nicht. */
  async completeTotpLogin(input: {
    challengeToken: string;
    code: string;
  }): Promise<{ sessionToken: string; user: StaffUser }> {
    const challenge = await this.consumeableChallenge(input.challengeToken, 'totp');
    const secretEnc = challenge.user.totpSecretEnc;
    if (secretEnc === null) throw new AuthError('INVALID_TOKEN', NEUTRAL_LOGIN_MESSAGE);
    const secret = decryptSecret(secretEnc, this.config.auth.secretKey);
    const matchedStep = verifyTotpCode(secret, input.code);
    if (matchedStep === null) {
      throw new AuthError('INVALID_CODE', 'Der Code ist ungültig oder abgelaufen.');
    }
    // Replay-Schutz: derselbe Zeitschritt wird atomar nur EINMAL akzeptiert.
    const stepConsumed = await this.db
      .update(staffUsers)
      .set({ totpLastUsedStep: matchedStep, updatedAt: new Date() })
      .where(
        and(
          eq(staffUsers.id, challenge.userId),
          sql`(${staffUsers.totpLastUsedStep} IS NULL OR ${staffUsers.totpLastUsedStep} < ${matchedStep})`,
        ),
      )
      .returning({ id: staffUsers.id });
    if (stepConsumed.length === 0) {
      throw new AuthError(
        'INVALID_CODE',
        'Der Code wurde bereits verwendet. Bitte den nächsten Code eingeben.',
      );
    }
    await this.consumeChallenge(challenge.id);
    const sessionToken = await this.createSession(challenge.user, challenge.deviceLabel);
    return { sessionToken, user: challenge.user };
  }

  /** Zweiter Login-Schritt mit Recovery-Code (verlorenes 2FA-Gerät). */
  async completeRecoveryLogin(input: {
    challengeToken: string;
    recoveryCode: string;
  }): Promise<{ sessionToken: string; user: StaffUser }> {
    const challenge = await this.consumeableChallenge(input.challengeToken, 'totp');
    const codeHash = sha256Hex(normalizeRecoveryCode(input.recoveryCode));
    const rows = await this.db
      .select()
      .from(staffRecoveryCodes)
      .where(
        and(
          eq(staffRecoveryCodes.userId, challenge.userId),
          eq(staffRecoveryCodes.codeHash, codeHash),
          isNull(staffRecoveryCodes.usedAt),
        ),
      );
    const code = rows[0];
    if (code === undefined) {
      throw new AuthError('INVALID_CODE', 'Der Wiederherstellungscode ist ungültig.');
    }
    const consumed = await this.db
      .update(staffRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(staffRecoveryCodes.id, code.id), isNull(staffRecoveryCodes.usedAt)))
      .returning({ id: staffRecoveryCodes.id });
    if (consumed.length === 0) {
      throw new AuthError('INVALID_CODE', 'Der Wiederherstellungscode ist ungültig.');
    }
    await this.consumeChallenge(challenge.id);
    await this.audit({ type: 'twofa.recovery_code_used', targetUserId: challenge.userId });
    const sessionToken = await this.createSession(challenge.user, challenge.deviceLabel);
    return { sessionToken, user: challenge.user };
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  /**
   * Session-IDs entstehen ausschließlich hier, serverseitig, NACH
   * vollständiger Authentifizierung – Schutz gegen Session-Fixation.
   */
  private async createSession(user: StaffUser, deviceLabel: string): Promise<string> {
    const knownDevice = await this.db
      .select({ id: staffSessions.id })
      .from(staffSessions)
      .where(and(eq(staffSessions.userId, user.id), eq(staffSessions.deviceLabel, deviceLabel)))
      .limit(1);
    const isNewDevice = knownDevice.length === 0;

    const token = generateToken();
    const inserted = await this.db
      .insert(staffSessions)
      .values({ userId: user.id, tokenHash: sha256Hex(token), deviceLabel })
      .returning({ id: staffSessions.id });

    await this.audit({
      type: 'session.created',
      targetUserId: user.id,
      sessionId: inserted[0]?.id ?? null,
      details: { deviceLabel, newDevice: isNewDevice },
    });
    if (isNewDevice) {
      // Audit-Grundlage für den späteren Admin-Push „neues Gerät“ (Phase 12).
      await this.audit({
        type: 'session.new_device_login',
        targetUserId: user.id,
        sessionId: inserted[0]?.id ?? null,
        details: { deviceLabel },
      });
    }
    return token;
  }

  /**
   * Prüft ein Session-Token und liefert Nutzer + App-Lock-Zustand.
   * - 30 Tage inaktiv → Session wird widerrufen (endgültig).
   * - 15 Minuten inaktiv → appLocked=true; Aktivität wird dann NICHT
   *   aktualisiert (sonst würde die Sperre sich selbst aufheben) –
   *   Entsperren nur über unlock() mit erneuter Authentifizierung.
   */
  async authenticate(sessionToken: string): Promise<AuthenticatedContext | null> {
    const rows = await this.db
      .select()
      .from(staffSessions)
      .where(eq(staffSessions.tokenHash, sha256Hex(sessionToken)));
    const session = rows[0];
    if (session === undefined || session.revokedAt !== null) return null;

    const now = Date.now();
    const inactiveMs = now - session.lastActivityAt.getTime();
    if (inactiveMs > SESSION_INACTIVITY_MS) {
      await this.revokeSessionById(session.id, 'expired_inactivity', null);
      return null;
    }

    const user = await this.findUserById(session.userId);
    if (user === undefined) return null;
    if (user.status !== 'active') {
      await this.revokeSessionById(session.id, `user_${user.status}`, null);
      return null;
    }

    const appLocked = inactiveMs > APP_LOCK_MS;
    if (!appLocked && inactiveMs > ACTIVITY_WRITE_THROTTLE_MS) {
      await this.db
        .update(staffSessions)
        .set({ lastActivityAt: new Date() })
        .where(eq(staffSessions.id, session.id));
    }
    return { user, session, appLocked };
  }

  /** App-Sperre aufheben: erneute Authentifizierung mit dem Passwort. */
  async unlock(context: AuthenticatedContext, password: string): Promise<boolean> {
    const ok = await verifyPassword(context.user.passwordHash, password);
    if (!ok) return false;
    await this.db
      .update(staffSessions)
      .set({ lastActivityAt: new Date() })
      .where(eq(staffSessions.id, context.session.id));
    return true;
  }

  async revokeSessionById(
    sessionId: string,
    reason: string,
    actorUserId: string | null,
  ): Promise<void> {
    const updated = await this.db
      .update(staffSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(staffSessions.id, sessionId), isNull(staffSessions.revokedAt)))
      .returning({ id: staffSessions.id, userId: staffSessions.userId });
    const row = updated[0];
    if (row !== undefined) {
      await this.audit({
        type: 'session.revoked',
        actorUserId,
        targetUserId: row.userId,
        sessionId: row.id,
        details: { reason },
      });
    }
  }

  async revokeAllSessions(
    userId: string,
    reason: string,
    actorUserId: string | null,
    exceptSessionId?: string,
  ): Promise<number> {
    const active = await this.db
      .select({ id: staffSessions.id })
      .from(staffSessions)
      .where(and(eq(staffSessions.userId, userId), isNull(staffSessions.revokedAt)));
    const toRevoke = active.map((s) => s.id).filter((id) => id !== exceptSessionId);
    if (toRevoke.length > 0) {
      await this.db
        .update(staffSessions)
        .set({ revokedAt: new Date(), revokedReason: reason })
        .where(inArray(staffSessions.id, toRevoke));
    }
    await this.audit({
      type: 'session.revoked_all',
      actorUserId,
      targetUserId: userId,
      details: { reason, count: toRevoke.length, keptCurrent: exceptSessionId !== undefined },
    });
    return toRevoke.length;
  }

  // ── Passwörter ───────────────────────────────────────────────────────────

  /** Passwortwechsel eingeloggt: alle ANDEREN Sessions beenden, eigene bleibt. */
  async changePassword(
    context: AuthenticatedContext,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const ok = await verifyPassword(context.user.passwordHash, currentPassword);
    if (!ok) throw new AuthError('INVALID_CREDENTIALS', 'Das aktuelle Passwort ist falsch.');
    const problem = validateNewPassword(newPassword);
    if (problem !== null) throw new AuthError('VALIDATION', problem);

    await this.db
      .update(staffUsers)
      .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(staffUsers.id, context.user.id));
    await this.invalidateOpenResetTokens(context.user.id);
    await this.revokeAllSessions(
      context.user.id,
      'password_changed',
      context.user.id,
      context.session.id,
    );
    await this.audit({
      type: 'password.changed',
      actorUserId: context.user.id,
      targetUserId: context.user.id,
    });
  }

  /**
   * „Passwort vergessen“: Antwort ist IMMER neutral – ob die E-Mail existiert,
   * wird nicht verraten. Nur aktive Konten erhalten einen Token.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.findUserByEmail(normalizeEmail(email));
    if (user === undefined || user.status !== 'active') return;

    const token = generateToken();
    await this.db.insert(staffPasswordResetTokens).values({
      userId: user.id,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    });
    await this.mail.sendPasswordReset({ to: user.email, resetToken: token });
  }

  /** Reset mit Token: einmal verwendbar, danach ALLE Sessions widerrufen. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const problem = validateNewPassword(newPassword);
    if (problem !== null) throw new AuthError('VALIDATION', problem);

    const rows = await this.db
      .select()
      .from(staffPasswordResetTokens)
      .where(eq(staffPasswordResetTokens.tokenHash, sha256Hex(token)));
    const resetToken = rows[0];
    if (
      resetToken === undefined ||
      resetToken.usedAt !== null ||
      resetToken.expiresAt.getTime() <= Date.now()
    ) {
      throw new AuthError('INVALID_TOKEN', 'Der Link ist ungültig oder abgelaufen.');
    }
    const user = await this.findUserById(resetToken.userId);
    if (user === undefined || user.status !== 'active') {
      throw new AuthError('INVALID_TOKEN', 'Der Link ist ungültig oder abgelaufen.');
    }

    const consumed = await this.db
      .update(staffPasswordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(staffPasswordResetTokens.id, resetToken.id),
          isNull(staffPasswordResetTokens.usedAt),
        ),
      )
      .returning({ id: staffPasswordResetTokens.id });
    if (consumed.length === 0) {
      throw new AuthError('INVALID_TOKEN', 'Der Link ist ungültig oder abgelaufen.');
    }
    await this.db
      .update(staffUsers)
      .set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() })
      .where(eq(staffUsers.id, user.id));
    await this.invalidateOpenResetTokens(user.id);
    await this.revokeAllSessions(user.id, 'password_reset', user.id);
    await this.audit({ type: 'password.reset_completed', targetUserId: user.id });
  }

  // ── TOTP / 2FA ───────────────────────────────────────────────────────────

  /** Setup beginnen (per Login-Challenge bei Pflicht-Setup oder eingeloggt). */
  async beginTotpSetupForUser(user: StaffUser): Promise<{ secret: string; otpauthUri: string }> {
    const secret = generateTotpSecret();
    await this.db
      .update(staffUsers)
      .set({
        totpPendingSecretEnc: encryptSecret(secret, this.config.auth.secretKey),
        updatedAt: new Date(),
      })
      .where(eq(staffUsers.id, user.id));
    return { secret, otpauthUri: buildOtpauthUri(secret, user.email) };
  }

  async beginTotpSetupWithChallenge(
    challengeToken: string,
  ): Promise<{ secret: string; otpauthUri: string }> {
    const challenge = await this.consumeableChallenge(challengeToken, 'totp_setup');
    return this.beginTotpSetupForUser(challenge.user);
  }

  /** Setup bestätigen: erster gültiger Code aktiviert 2FA + Recovery-Codes. */
  async confirmTotpSetupForUser(
    userId: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.findUserById(userId);
    if (user === undefined || user.totpPendingSecretEnc === null) {
      throw new AuthError('CONFLICT', 'Es läuft keine 2FA-Einrichtung.');
    }
    const secret = decryptSecret(user.totpPendingSecretEnc, this.config.auth.secretKey);
    const matchedStep = verifyTotpCode(secret, code);
    if (matchedStep === null) {
      throw new AuthError('INVALID_CODE', 'Der Code ist ungültig. Bitte erneut versuchen.');
    }

    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
    await this.db.transaction(async (tx) => {
      await tx
        .update(staffUsers)
        .set({
          totpSecretEnc: user.totpPendingSecretEnc,
          totpPendingSecretEnc: null,
          totpEnabled: true,
          totpLastUsedStep: matchedStep,
          updatedAt: new Date(),
        })
        .where(eq(staffUsers.id, userId));
      await tx.delete(staffRecoveryCodes).where(eq(staffRecoveryCodes.userId, userId));
      for (const recoveryCode of recoveryCodes) {
        await tx.insert(staffRecoveryCodes).values({
          userId,
          codeHash: sha256Hex(normalizeRecoveryCode(recoveryCode)),
        });
      }
    });
    await this.audit({ type: 'twofa.enabled', targetUserId: userId });
    return { recoveryCodes };
  }

  /** Pflicht-Setup beim Login abschließen: aktiviert 2FA und erstellt die Session. */
  async confirmTotpSetupWithChallenge(input: {
    challengeToken: string;
    code: string;
  }): Promise<{ sessionToken: string; user: StaffUser; recoveryCodes: string[] }> {
    const challenge = await this.consumeableChallenge(input.challengeToken, 'totp_setup');
    const { recoveryCodes } = await this.confirmTotpSetupForUser(challenge.userId, input.code);
    await this.consumeChallenge(challenge.id);
    const sessionToken = await this.createSession(challenge.user, challenge.deviceLabel);
    return { sessionToken, user: challenge.user, recoveryCodes };
  }

  /** Nach Passwortwechsel/-reset: alle noch offenen Reset-Tokens entwerten. */
  private async invalidateOpenResetTokens(userId: string): Promise<void> {
    await this.db
      .update(staffPasswordResetTokens)
      .set({ usedAt: new Date() })
      .where(
        and(eq(staffPasswordResetTokens.userId, userId), isNull(staffPasswordResetTokens.usedAt)),
      );
  }

  // ── Hilfen ───────────────────────────────────────────────────────────────

  async findUserByEmail(normalizedEmail: string): Promise<StaffUser | undefined> {
    const rows = await this.db
      .select()
      .from(staffUsers)
      .where(eq(staffUsers.email, normalizedEmail));
    return rows[0];
  }

  async findUserById(id: string): Promise<StaffUser | undefined> {
    const rows = await this.db.select().from(staffUsers).where(eq(staffUsers.id, id));
    return rows[0];
  }

  async isAdminCapable(userId: string): Promise<boolean> {
    return hasAdminCapability(await this.effectivePermissions(userId));
  }
}
