import {
  pushSubscriptions,
  staffSessions,
  staffUsers,
  type Database,
  type DatabaseExecutor,
} from '@mietroyal/database';
import { and, count, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { isSessionExpiredByInactivity, sessionInactivityCutoff } from '../../auth/service.ts';
import type { PushSubscriptionTarget } from '../types.ts';

/**
 * Push-Subscriptions je Staff-User/Gerätesession/Browser (Order §29).
 *
 * - Eine Subscription ist an den User UND die Session gebunden, in der sie
 *   registriert wurde; Logout/Revoke/Deaktivierung deaktivieren sie
 *   (Listener in der Auth + Lazy-Prüfung beim Versand als Backstop).
 * - `endpoint` ist UNIQUE (ein Browser = ein Endpoint). Registriert ein
 *   ANDERER User denselben Endpoint (Gerät gewechselt), wird die Zeile dem
 *   neuen User zugeordnet (`reassigned`): der alte User sieht sie nie wieder,
 *   Zähler/Erfolge werden zurückgesetzt. Ein „Übernehmen“ fremder
 *   Subscriptions durch Raten ist unmöglich, weil Endpoint UND Schlüssel aus
 *   dem eigenen Browser stammen müssen.
 * - Endpoint/Keys verlassen den Server nie (Liste eigener Geräte zeigt nur
 *   Label/Zeitpunkte), werden nie geloggt.
 */

/**
 * Gründe einer TECHNISCHEN Deaktivierung. Phase 12 Finalisierung: kein
 * Push-Opt-out in Miet-Royal – `user_unsubscribed` wird nicht mehr erzeugt
 * (Bestandszeilen mit diesem Grund dürfen bleiben, siehe DATA_MODEL).
 */
export type SubscriptionDisableReason =
  | 'gone'
  | 'session_revoked'
  | 'user_inactive'
  | 'reassigned'
  // Phase 12 Härtung: Session per Inaktivitätsregel abgelaufen (B11) / Endpoint unzulässig (B10).
  | 'session_expired'
  | 'endpoint_not_allowed';

export interface RegisterSubscriptionInput {
  userId: string;
  sessionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgentLabel: string | null;
}

export interface OwnDeviceView {
  id: string;
  userAgentLabel: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  /** true, wenn die Subscription zur aktuellen Session gehört. */
  currentSession: boolean;
}

export interface ActiveTarget extends PushSubscriptionTarget {
  id: string;
}

/**
 * Phase 12 Finalisierung: technischer Deaktivierungsgrund einer (noch nicht
 * deaktivierten) Subscription aus dem Zustand ihrer gebundenen Session –
 * `null` ⇒ Bindung gültig. EINE Stelle für Versand (Lazy-Backstop) und
 * Statusroute: widerrufen ⇒ `session_revoked`, per Inaktivitätsregel der
 * Auth abgelaufen ⇒ `session_expired` (B11). Ohne Session (Altbestand) gültig.
 */
function sessionDisableReason(
  binding: {
    sessionId: string | null;
    sessionRevokedAt: Date | null;
    sessionLastActivityAt: Date | null;
  },
  now: Date,
): SubscriptionDisableReason | null {
  if (binding.sessionId === null) return null;
  if (binding.sessionRevokedAt !== null) return 'session_revoked';
  if (
    binding.sessionLastActivityAt !== null &&
    isSessionExpiredByInactivity(binding.sessionLastActivityAt, now)
  ) {
    return 'session_expired';
  }
  return null;
}

/** SQL-Form derselben Gültigkeit (nicht widerrufen, nicht per Inaktivität abgelaufen; B11). */
function sessionStillValid(now: Date) {
  return sql`(${pushSubscriptions.sessionId} IS NULL OR (${staffSessions.revokedAt} IS NULL AND (${staffSessions.lastActivityAt} IS NULL OR ${staffSessions.lastActivityAt} >= ${sessionInactivityCutoff(now)})))`;
}

export class PushSubscriptionService {
  constructor(private readonly db: Database) {}

  async register(input: RegisterSubscriptionInput): Promise<{ id: string; reassigned: boolean }> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, input.endpoint))
        .for('update');
      const row = existing[0];
      const now = new Date();
      if (row === undefined) {
        const inserted = await tx
          .insert(pushSubscriptions)
          .values({
            userId: input.userId,
            sessionId: input.sessionId,
            endpoint: input.endpoint,
            p256dh: input.p256dh,
            auth: input.auth,
            userAgentLabel: input.userAgentLabel,
          })
          .returning({ id: pushSubscriptions.id });
        const id = inserted[0]?.id;
        if (id === undefined) throw new Error('Push-Subscription konnte nicht angelegt werden');
        return { id, reassigned: false };
      }
      const reassigned = row.userId !== input.userId;
      await tx
        .update(pushSubscriptions)
        .set({
          userId: input.userId,
          sessionId: input.sessionId,
          p256dh: input.p256dh,
          auth: input.auth,
          userAgentLabel: input.userAgentLabel,
          disabledAt: null,
          disabledReason: null,
          // Fremdübernahme: Historie des alten Users wird nicht mitgenommen.
          ...(reassigned ? { createdAt: now, lastSuccessAt: null } : {}),
        })
        .where(eq(pushSubscriptions.id, row.id));
      return { id: row.id, reassigned };
    });
  }

  async listOwn(userId: string, currentSessionId: string): Promise<OwnDeviceView[]> {
    const rows = await this.db
      .select({
        id: pushSubscriptions.id,
        userAgentLabel: pushSubscriptions.userAgentLabel,
        createdAt: pushSubscriptions.createdAt,
        lastSuccessAt: pushSubscriptions.lastSuccessAt,
        sessionId: pushSubscriptions.sessionId,
        sessionRevokedAt: staffSessions.revokedAt,
      })
      .from(pushSubscriptions)
      .leftJoin(staffSessions, eq(staffSessions.id, pushSubscriptions.sessionId))
      .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.disabledAt)))
      .orderBy(pushSubscriptions.createdAt);
    return rows
      .filter((row) => row.sessionRevokedAt === null)
      .map((row) => ({
        id: row.id,
        userAgentLabel: row.userAgentLabel,
        createdAt: row.createdAt.toISOString(),
        lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
        currentSession: row.sessionId === currentSessionId,
      }));
  }

  /**
   * Status des eigenen Browsers (POST /staff/push/subscriptions/status) –
   * Phase 12 Finalisierung (B1): `true` NUR, wenn die Subscription mit diesem
   * Endpoint DIESEM User gehört, nicht deaktiviert ist und danach an die
   * aktuelle Session gebunden ist:
   * - fremder User / unbekannter Endpoint / deaktiviert ⇒ `false`, keine
   *   Änderung (deaktivierte Abos werden nie automatisch reaktiviert – die UI
   *   zeigt „aktivieren“, die erneute Registrierung ist die Reaktivierung);
   * - an eine ANDERE, noch gültige Session (oder an keine – Altbestand)
   *   gebunden ⇒ auf `currentSessionId` umbinden: Besitz des Endpoints (nur
   *   der eigene Browser kennt ihn) + gültige Session desselben Users belegen
   *   dasselbe Browserprofil – kein neues Opt-in nötig;
   * - an eine widerrufene/per Inaktivität abgelaufene Session gebunden ⇒
   *   technisch deaktiviert (wie der Lazy-Backstop des Versands), `false`.
   * Sperre auf der Subscription-Zeile (FOR UPDATE) gegen parallele
   * Registrierung/Übernahme.
   */
  async statusForSession(
    userId: string,
    currentSessionId: string,
    endpoint: string,
    now = new Date(),
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: pushSubscriptions.id,
          userId: pushSubscriptions.userId,
          sessionId: pushSubscriptions.sessionId,
          disabledAt: pushSubscriptions.disabledAt,
          sessionRevokedAt: staffSessions.revokedAt,
          sessionLastActivityAt: staffSessions.lastActivityAt,
        })
        .from(pushSubscriptions)
        .leftJoin(staffSessions, eq(staffSessions.id, pushSubscriptions.sessionId))
        .where(eq(pushSubscriptions.endpoint, endpoint))
        .for('update', { of: pushSubscriptions });
      const row = rows[0];
      if (row === undefined || row.userId !== userId || row.disabledAt !== null) return false;
      if (row.sessionId === currentSessionId) return true;
      const reason = sessionDisableReason(row, now);
      if (reason !== null) {
        await tx
          .update(pushSubscriptions)
          .set({ disabledAt: now, disabledReason: reason })
          .where(eq(pushSubscriptions.id, row.id));
        return false;
      }
      await tx
        .update(pushSubscriptions)
        .set({ sessionId: currentSessionId })
        .where(eq(pushSubscriptions.id, row.id));
      return true;
    });
  }

  /**
   * Phase 12 Finalisierung (B1): nach einem Login die aktiven Subscriptions
   * DESSELBEN Users, die an eine andere, noch gültige Session MIT DEMSELBEN
   * Geräte-Hash (`staff_sessions.device_token_hash`) gebunden sind, an die neue
   * Session binden – sonst hinge das Abo an der alten Session (festes
   * Cookie-maxAge, gleitende Server-Session): deren Ablauf beendete Push still,
   * ein Logout der neuen Session deaktivierte es nicht.
   * Nie umgebunden: Subscriptions anderer User (auch auf demselben Gerät –
   * keine Übertragung zwischen Personen), deaktivierte Abos, Bindungen an
   * widerrufene/abgelaufene Sessions (technisch beendet), Sessions ohne Hash
   * (vor dem Rollout). Ein einziges UPDATE ⇒ idempotent und race-arm.
   * Rückgabe: Anzahl umgebundener Subscriptions.
   */
  async rebindSameDeviceSessions(
    userId: string,
    newSessionId: string,
    now = new Date(),
  ): Promise<number> {
    const current = alias(staffSessions, 'current_session');
    const previousSameDevice = this.db
      .select({ id: staffSessions.id })
      .from(staffSessions)
      .innerJoin(current, eq(current.id, newSessionId))
      .where(
        and(
          eq(current.userId, userId),
          isNull(current.revokedAt),
          isNotNull(current.deviceTokenHash),
          eq(staffSessions.userId, userId),
          ne(staffSessions.id, current.id),
          eq(staffSessions.deviceTokenHash, current.deviceTokenHash),
          isNull(staffSessions.revokedAt),
          gte(staffSessions.lastActivityAt, sessionInactivityCutoff(now)),
        ),
      );
    const updated = await this.db
      .update(pushSubscriptions)
      .set({ sessionId: newSessionId })
      .where(
        and(
          eq(pushSubscriptions.userId, userId),
          isNull(pushSubscriptions.disabledAt),
          inArray(pushSubscriptions.sessionId, previousSameDevice),
        ),
      )
      .returning({ id: pushSubscriptions.id });
    return updated.length;
  }

  async disableForSession(
    sessionId: string,
    reason: SubscriptionDisableReason,
    executor: DatabaseExecutor = this.db,
  ): Promise<number> {
    const updated = await executor
      .update(pushSubscriptions)
      .set({ disabledAt: new Date(), disabledReason: reason })
      .where(and(eq(pushSubscriptions.sessionId, sessionId), isNull(pushSubscriptions.disabledAt)))
      .returning({ id: pushSubscriptions.id });
    return updated.length;
  }

  async disableForUser(
    userId: string,
    reason: SubscriptionDisableReason,
    executor: DatabaseExecutor = this.db,
  ): Promise<number> {
    const updated = await executor
      .update(pushSubscriptions)
      .set({ disabledAt: new Date(), disabledReason: reason })
      .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.disabledAt)))
      .returning({ id: pushSubscriptions.id });
    return updated.length;
  }

  async disableById(id: string, reason: SubscriptionDisableReason): Promise<void> {
    await this.db
      .update(pushSubscriptions)
      .set({ disabledAt: new Date(), disabledReason: reason })
      .where(and(eq(pushSubscriptions.id, id), isNull(pushSubscriptions.disabledAt)));
  }

  async markSuccess(ids: readonly string[], at = new Date()): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(pushSubscriptions)
      .set({ lastSuccessAt: at })
      .where(inArray(pushSubscriptions.id, ids));
  }

  /**
   * Versandziele eines Users: nur aktive Subscriptions, deren User aktiv und
   * deren Session nicht widerrufen ist. Nicht mehr gültige Zeilen werden
   * dabei deaktiviert (Backstop zum Auth-Listener) – Order §29 „Revoke/
   * disabled ⇒ kein Push“ gilt damit auch ohne Listener-Lauf.
   * Härtung B11: auch Sessions, die nach der Inaktivitätsregel der Auth
   * abgelaufen sind (`isSessionExpiredByInactivity`), erhalten keinen Push.
   */
  async activeTargetsForUser(userId: string, now = new Date()): Promise<ActiveTarget[]> {
    const rows = await this.db
      .select({
        id: pushSubscriptions.id,
        endpoint: pushSubscriptions.endpoint,
        p256dh: pushSubscriptions.p256dh,
        auth: pushSubscriptions.auth,
        sessionId: pushSubscriptions.sessionId,
        sessionRevokedAt: staffSessions.revokedAt,
        sessionLastActivityAt: staffSessions.lastActivityAt,
        userStatus: staffUsers.status,
      })
      .from(pushSubscriptions)
      .innerJoin(staffUsers, eq(staffUsers.id, pushSubscriptions.userId))
      .leftJoin(staffSessions, eq(staffSessions.id, pushSubscriptions.sessionId))
      .where(and(eq(pushSubscriptions.userId, userId), isNull(pushSubscriptions.disabledAt)));
    const targets: ActiveTarget[] = [];
    for (const row of rows) {
      if (row.userStatus !== 'active') {
        await this.disableById(row.id, 'user_inactive');
        continue;
      }
      const sessionReason = sessionDisableReason(row, now);
      if (sessionReason !== null) {
        await this.disableById(row.id, sessionReason);
        continue;
      }
      targets.push({ id: row.id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth });
    }
    return targets;
  }

  /** Hat der User mindestens ein aktives Gerät (ohne Lazy-Deaktivierung)? */
  async hasActiveSubscription(userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .innerJoin(staffUsers, eq(staffUsers.id, pushSubscriptions.userId))
      .leftJoin(staffSessions, eq(staffSessions.id, pushSubscriptions.sessionId))
      .where(
        and(
          eq(pushSubscriptions.userId, userId),
          isNull(pushSubscriptions.disabledAt),
          eq(staffUsers.status, 'active'),
          sessionStillValid(new Date()),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Aktive Geräte gesamt (Admin-Status, Order §35) – nur eine Zahl. */
  async countActive(): Promise<number> {
    const rows = await this.db
      .select({ value: count() })
      .from(pushSubscriptions)
      .innerJoin(staffUsers, eq(staffUsers.id, pushSubscriptions.userId))
      .leftJoin(staffSessions, eq(staffSessions.id, pushSubscriptions.sessionId))
      .where(
        and(
          isNull(pushSubscriptions.disabledAt),
          eq(staffUsers.status, 'active'),
          sessionStillValid(new Date()),
        ),
      );
    return Number(rows[0]?.value ?? 0);
  }
}
