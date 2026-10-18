import {
  pushSubscriptions,
  staffSessions,
  staffUsers,
  type Database,
  type DatabaseExecutor,
} from '@mietroyal/database';
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
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

export type SubscriptionDisableReason =
  | 'user_unsubscribed'
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

  /** Eigene Subscription abmelden – nur die eigene (fremder Endpoint ⇒ false, neutral). */
  async unsubscribe(userId: string, endpoint: string): Promise<boolean> {
    const updated = await this.db
      .update(pushSubscriptions)
      .set({ disabledAt: new Date(), disabledReason: 'user_unsubscribed' })
      .where(
        and(
          eq(pushSubscriptions.endpoint, endpoint),
          eq(pushSubscriptions.userId, userId),
          isNull(pushSubscriptions.disabledAt),
        ),
      )
      .returning({ id: pushSubscriptions.id });
    return updated.length > 0;
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

  /** Ist der Endpoint dieses Users aktuell aktiv registriert? (Status-Anzeige) */
  async isActiveForUser(userId: string, endpoint: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.endpoint, endpoint),
          eq(pushSubscriptions.userId, userId),
          isNull(pushSubscriptions.disabledAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
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
      if (row.sessionId !== null && row.sessionRevokedAt !== null) {
        await this.disableById(row.id, 'session_revoked');
        continue;
      }
      if (
        row.sessionId !== null &&
        row.sessionLastActivityAt !== null &&
        isSessionExpiredByInactivity(row.sessionLastActivityAt, now)
      ) {
        await this.disableById(row.id, 'session_expired');
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
