import {
  customerPortalSessions,
  customers,
  type CustomerPortalSessionRow,
  type Database,
  type DatabaseExecutor,
} from '@mietroyal/database';
import { and, eq, isNull } from 'drizzle-orm';
import { generateToken, sha256Hex } from '../../auth/crypto.ts';
import { isWellFormedPortalToken, type PortalSessionAuthenticator } from '../guard.ts';
import type { PortalSessionContext } from '../types.ts';
import { PORTAL_LAST_SEEN_THROTTLE_MS, PORTAL_SESSION_TTL_MS } from './constants.ts';

/**
 * Phase 15 (Order §8/§12): Portal-Sessions. Das Token (32 Zufallsbytes base64url)
 * existiert im Klartext nur im HttpOnly-Cookie; die Datenbank kennt ausschließlich
 * den SHA-256-Hex. Lebensdauer ABSOLUT 30 Tage ab `created_at` – `last_seen_at`
 * ist reine Diagnostik und verlängert nie. Ein gelöschter Kunde macht jede
 * Session ungültig.
 */
export class PortalSessionService implements PortalSessionAuthenticator {
  constructor(private readonly db: Database) {}

  /** Neue Session: created = authenticated = reauthenticated = now, Ablauf absolut now + 30 Tage. */
  async create(
    customerId: string,
    now: Date,
    userAgentLabel: string | null,
    executor?: DatabaseExecutor,
  ): Promise<{ token: string; session: CustomerPortalSessionRow }> {
    const token = generateToken();
    const inserted = await (executor ?? this.db)
      .insert(customerPortalSessions)
      .values({
        customerId,
        tokenHash: sha256Hex(token),
        createdAt: now,
        authenticatedAt: now,
        reauthenticatedAt: now,
        expiresAt: new Date(now.getTime() + PORTAL_SESSION_TTL_MS),
        userAgentLabel,
      })
      .returning();
    const session = inserted[0];
    if (session === undefined) throw new Error('Portal-Session konnte nicht angelegt werden.');
    return { token, session };
  }

  async authenticate(
    token: string,
    options: { now?: Date; touch?: boolean } = {},
  ): Promise<PortalSessionContext | null> {
    if (!isWellFormedPortalToken(token)) return null;
    const now = options.now ?? new Date();
    const rows = await this.db
      .select({ session: customerPortalSessions, customerDeletedAt: customers.deletedAt })
      .from(customerPortalSessions)
      .innerJoin(customers, eq(customers.id, customerPortalSessions.customerId))
      .where(eq(customerPortalSessions.tokenHash, sha256Hex(token)));
    const row = rows[0];
    if (row === undefined) return null;
    const { session } = row;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() <= now.getTime()) return null;
    if (row.customerDeletedAt !== null) return null;

    if (options.touch === true) {
      const lastSeen = session.lastSeenAt?.getTime() ?? 0;
      if (now.getTime() - lastSeen >= PORTAL_LAST_SEEN_THROTTLE_MS) {
        // Nur last_seen_at – NIE expires_at (kein Sliding Window, Order §8).
        await this.db
          .update(customerPortalSessions)
          .set({ lastSeenAt: now })
          .where(eq(customerPortalSessions.id, session.id));
      }
    }
    return toContext(session);
  }

  async byId(
    sessionId: string,
    executor?: DatabaseExecutor,
  ): Promise<CustomerPortalSessionRow | null> {
    const rows = await (executor ?? this.db)
      .select()
      .from(customerPortalSessions)
      .where(eq(customerPortalSessions.id, sessionId));
    return rows[0] ?? null;
  }

  /** Reauth-Zeitpunkt erneuern – ausdrücklich ohne `expires_at` (Order §32). */
  async markReauthenticated(
    sessionId: string,
    now: Date,
    executor?: DatabaseExecutor,
  ): Promise<void> {
    await (executor ?? this.db)
      .update(customerPortalSessions)
      .set({ reauthenticatedAt: now })
      .where(
        and(eq(customerPortalSessions.id, sessionId), isNull(customerPortalSessions.revokedAt)),
      );
  }

  async revoke(sessionId: string, now: Date, executor?: DatabaseExecutor): Promise<boolean> {
    const updated = await (executor ?? this.db)
      .update(customerPortalSessions)
      .set({ revokedAt: now })
      .where(
        and(eq(customerPortalSessions.id, sessionId), isNull(customerPortalSessions.revokedAt)),
      )
      .returning({ id: customerPortalSessions.id });
    return updated.length > 0;
  }

  /** Alle offenen Sessions eines Kunden widerrufen (E-Mail-Wechsel, Order §35). */
  async revokeAllForCustomer(
    customerId: string,
    now: Date,
    executor?: DatabaseExecutor,
  ): Promise<number> {
    const updated = await (executor ?? this.db)
      .update(customerPortalSessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(customerPortalSessions.customerId, customerId),
          isNull(customerPortalSessions.revokedAt),
        ),
      )
      .returning({ id: customerPortalSessions.id });
    return updated.length;
  }
}

function toContext(session: CustomerPortalSessionRow): PortalSessionContext {
  return {
    sessionId: session.id,
    customerId: session.customerId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    authenticatedAt: session.authenticatedAt,
    reauthenticatedAt: session.reauthenticatedAt,
  };
}

/**
 * Grobe Geräteklasse aus dem User-Agent – ohne Versionsnummern, max. 60 Zeichen,
 * nie der rohe Header (Order §8 `user_agent_label`). Nur Anzeige/Diagnostik.
 */
export function portalUserAgentLabel(userAgent: string | undefined): string | null {
  if (userAgent === undefined || userAgent.trim() === '') return null;
  const ua = userAgent.toLowerCase();
  let browser = 'Browser';
  if (ua.includes('edg/')) browser = 'Edge';
  else if (ua.includes('opr/') || ua.includes('opera')) browser = 'Opera';
  else if (ua.includes('chrome/') || ua.includes('crios/')) browser = 'Chrome';
  else if (ua.includes('firefox/') || ua.includes('fxios/')) browser = 'Firefox';
  else if (ua.includes('safari/')) browser = 'Safari';

  let system: string | null = null;
  if (ua.includes('iphone')) system = 'iPhone';
  else if (ua.includes('ipad')) system = 'iPad';
  else if (ua.includes('android')) system = 'Android';
  else if (ua.includes('windows')) system = 'Windows';
  else if (ua.includes('mac os') || ua.includes('macintosh')) system = 'Mac';
  else if (ua.includes('linux')) system = 'Linux';

  const label = system === null ? browser : `${browser} auf ${system}`;
  return label.slice(0, 60);
}
