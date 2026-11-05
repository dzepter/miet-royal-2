import { bookings, customerPortalSessions, processes, type Database } from '@mietroyal/database';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';

/**
 * Phase 15 (CHAT, Order §29/§55): Hinweise für die Staff-Kommunikationsseite.
 * - `canReplyPortal`: der Vorgang hat eine bestätigte Buchung und ist offen bzw.
 *   wieder geöffnet – nur dann ist eine Portalantwort möglich (Order §25).
 * - `portalActive`: der Kunde besitzt mindestens eine gültige Portal-Session
 *   (nicht widerrufen, nicht abgelaufen) ⇒ Badge „Kundenportal aktiv“.
 * Reine Leseabfragen ohne Sichtbarkeitsprüfung – die Route hat sie bereits erledigt.
 */

export async function portalReplyPossible(db: Database, processId: string): Promise<boolean> {
  const rows = await db
    .select({ id: processes.id })
    .from(processes)
    .innerJoin(bookings, eq(bookings.processId, processes.id))
    .where(and(eq(processes.id, processId), inArray(processes.mainStatus, ['open', 'reopened'])));
  return rows.length > 0;
}

/** Hat der Kunde des Vorgangs eine gültige Portal-Session (nicht widerrufen, nicht abgelaufen)? */
export async function customerPortalActive(
  db: Database,
  processId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await db
    .select({ id: customerPortalSessions.id })
    .from(customerPortalSessions)
    .innerJoin(processes, eq(processes.customerId, customerPortalSessions.customerId))
    .where(
      and(
        eq(processes.id, processId),
        isNull(customerPortalSessions.revokedAt),
        gt(customerPortalSessions.expiresAt, now),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
