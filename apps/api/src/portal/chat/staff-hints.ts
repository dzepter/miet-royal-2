import {
  bookings,
  cancellations, // Phase 15 (Review R1)
  customerPortalSessions,
  processes,
  settlements, // Phase 15 (Final-Korrektur)
  type Database,
} from '@mietroyal/database';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { isSettlementFinallyPaid } from '../visibility.ts'; // Phase 15 (Final-Korrektur)

/**
 * Phase 15 (CHAT, Order §29/§55): Hinweise für die Staff-Kommunikationsseite.
 * - `canReplyPortal`: der Vorgang hat eine bestätigte Buchung und ist offen bzw.
 *   wieder geöffnet – nur dann ist eine Portalantwort möglich (Order §25). Phase 15
 *   (Review R1): nie bei einer Buchung mit Stornozeile (auch nicht nach einem Reopen).
 *   Phase 15 (Final-Korrektur): nie, wenn das Settlement der Buchung final bezahlt ist
 *   (`isSettlementFinallyPaid`: `locked_at` gesetzt UND `payment_status = 'paid'`) – ein
 *   Reopen macht den alten Chat nicht wieder beschreibbar.
 * - `portalActive`: der Kunde besitzt mindestens eine gültige Portal-Session
 *   (nicht widerrufen, nicht abgelaufen) ⇒ Badge „Kundenportal aktiv“.
 * Reine Leseabfragen ohne Sichtbarkeitsprüfung – die Route hat sie bereits erledigt.
 */

export async function portalReplyPossible(db: Database, processId: string): Promise<boolean> {
  const rows = await db
    .select({
      id: processes.id,
      // Phase 15 (Final-Korrektur): Settlement-Spalten per LEFT JOIN (kein Settlement ⇒ NULL).
      settlementLockedAt: settlements.lockedAt,
      settlementPaymentStatus: settlements.paymentStatus,
    })
    .from(processes)
    .innerJoin(bookings, eq(bookings.processId, processes.id))
    // Phase 15 (Review R1): mit Stornozeile keine Portalantwort – auch nicht nach einem Reopen
    // (gleiche Regel wie ConversationService.replyByPortal und die Portal-Policy).
    .leftJoin(cancellations, eq(cancellations.bookingId, bookings.id))
    .leftJoin(settlements, eq(settlements.bookingId, bookings.id)) // Phase 15 (Final-Korrektur)
    .where(
      and(
        eq(processes.id, processId),
        inArray(processes.mainStatus, ['open', 'reopened']),
        isNull(cancellations.id),
      ),
    );
  // Phase 15 (Final-Korrektur): final bezahlt ⇒ keine Portalantwort. Prüfung in JS mit dem
  // Policy-Prädikat – NULL in `locked_at`/`payment_status` (oder kein Settlement) sperrt nie.
  return rows.some(
    (row) =>
      !isSettlementFinallyPaid({
        lockedAt: row.settlementLockedAt,
        paymentStatus: row.settlementPaymentStatus,
      }),
  );
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
