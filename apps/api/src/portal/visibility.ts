import {
  bookings,
  cancellations,
  processes,
  settlements,
  type Booking,
  type Database,
} from '@mietroyal/database';
import { and, eq } from 'drizzle-orm';
import type { CancellationRow } from '../cancellation/cancellation-service.ts';

// Phase 15 (Final-Korrektur): Prüfreihenfolge A (Stornozeile) → B (Settlement final bezahlt ⇒
// immer unsichtbar, auch nach Reopen) → C (Vorgangsstatus); siehe Kopfkommentar.
/**
 * Phase 15 (Order §13/§14, Design §2.1): `CustomerPortalVisibilityPolicy` – die
 * EINZIGE Stelle, die entscheidet, welche Buchung für einen Kunden im Portal
 * „aktuell“ ist. Keine verteilten Heuristiken, keine Historie:
 *
 * - Sichtbar wird eine Buchung erst mit echter `bookings`-Zeile (Anfrage,
 *   Angebotsentwurf oder nur versendetes Angebot sind NIE eine Portalbuchung).
 * - Buchung UND Vorgang müssen demselben Kunden gehören (beide Spalten).
 *
 * Phase 15 (Final-Korrektur) – verbindliche Prüfreihenfolge in `portalStateOf`:
 *
 * A. Stornozeile vorhanden (Phase 15, Review R1: unabhängig vom Vorgangsstatus,
 *    also auch nach einem Reopen) ⇒ ausschließlich die Storno-Regeln: 0 € nur als
 *    Bestätigungsansicht direkt nach der eigenen Aktion des Kunden (24 h, nur
 *    Detailroute/Storno-Antwort, nie in Listen – Review R12); kostenpflichtig
 *    `cancelled_fee` bis `finance_status = 'paid'`.
 * B. Reguläres Settlement final bezahlt (`isSettlementFinallyPaid`: `locked_at`
 *    gesetzt UND `payment_status = 'paid'`) ⇒ IMMER unsichtbar – unabhängig vom
 *    Vorgangsstatus (`completed`, `reopened` oder administrativ wieder `open`). Ein
 *    Staff-Reopen ist ein interner Arbeitsstatus und reaktiviert keine finanziell
 *    abgeschlossene Kundenbuchung (kein Chat, keine Tour, kein Snapshot); ein neuer
 *    Mietvorgang ist eine neue Buchung. NULL in `locked_at` oder `payment_status`
 *    ist nie „final bezahlt“.
 * C. Erst dann nach Vorgangsstatus:
 *    - `open`/`reopened` ⇒ `active`;
 *    - `completed` ⇒ `completed_open`, solange finanziell kundenseitig offen (kein
 *      Settlement, nicht gesperrt, kein Zahlungsstatus, open/overdue);
 *    - `cancelled` ohne Stornozeile ⇒ unsichtbar.
 *
 * Dasselbe Prädikat sperrt die Staff-Portalantwort (`portal/chat/staff-hints.ts`,
 * `ConversationService.replyByPortal`). Es gibt KEINE Route und KEINEN Parameter für
 * „alle“/„vergangene“ Buchungen.
 */

export type PortalBookingState = 'active' | 'completed_open' | 'cancelled_free' | 'cancelled_fee';

/** Kostenfreie Stornos bleiben nur so lange über die Detailroute erreichbar. */
export const PORTAL_CANCELLED_FREE_VISIBLE_MS = 24 * 60 * 60 * 1000;

export interface VisibleBookingProcess {
  id: string;
  processNumber: string;
  mainStatus: 'open' | 'completed' | 'reopened' | 'cancelled';
  eventDate: string | null;
}

export interface VisibleBookingSettlement {
  id: string;
  lockedAt: Date | null;
  paymentStatus: 'open' | 'paid' | 'overdue' | null;
  amountDueCents: number;
}

export interface VisibleBooking {
  booking: Booking;
  process: VisibleBookingProcess;
  settlement: VisibleBookingSettlement | null;
  cancellation: CancellationRow | null;
  portalState: PortalBookingState;
}

type CandidateRow = {
  booking: Booking;
  process: VisibleBookingProcess;
  settlement: VisibleBookingSettlement | null;
  cancellation: CancellationRow | null;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Eventdatum einer Buchung für die Sortierung (Snapshot, sonst Vorgang). */
export function visibleBookingEventDate(
  row: Pick<CandidateRow, 'booking' | 'process'>,
): string | null {
  const snapshot = record(row.booking.eventSnapshot);
  const value = snapshot.eventDate;
  if (typeof value === 'string' && value.trim() !== '') return value;
  return row.process.eventDate;
}

/**
 * Phase 15 (Final-Korrektur): Reguläres Settlement final bezahlt – übertragen/gesperrt
 * (`locked_at` gesetzt) UND `payment_status = 'paid'`. Kein Settlement, `locked_at` NULL oder
 * `payment_status` NULL/open/overdue ist NIE „final bezahlt“ (SQL-NULL-Semantik eines
 * LEFT JOIN auf `settlements`). Einzige Definition – auch für die Staff-Portalantwort.
 */
export function isSettlementFinallyPaid(
  settlement: Pick<VisibleBookingSettlement, 'lockedAt' | 'paymentStatus'> | null,
): boolean {
  return settlement !== null && settlement.lockedAt !== null && settlement.paymentStatus === 'paid';
}

/**
 * Zustand je Kandidatenzeile – `null` = im Portal unsichtbar. `includeCancelledFree`
 * erlaubt die Bestätigungsansicht eines kostenfreien KUNDENstornos (24 h; nur
 * Detailroute und Antwort des Storno-POST).
 */
export function portalStateOf(
  row: CandidateRow,
  now: Date,
  options: { includeCancelledFree: boolean },
): PortalBookingState | null {
  // (A) Phase 15 (Review R1): Eine Buchung mit Stornozeile ist NIE `active` – auch nicht, wenn
  // der Vorgang danach wieder geöffnet wurde (Phase 9: die alte Buchung wird nicht reaktiviert).
  // Der Zustand kommt dann ausschließlich aus der Stornozeile.
  if (row.cancellation !== null) return cancelledStateOf(row.cancellation, now, options);
  // (B) Phase 15 (Final-Korrektur): final bezahlt ⇒ unsichtbar, VOR jeder Auswertung des
  // Vorgangsstatus – ein Reopen (oder ein administrativ wieder offener Vorgang) macht die alte,
  // finanziell abgeschlossene Buchung nicht wieder zur „Bestätigten Buchung“.
  if (isSettlementFinallyPaid(row.settlement)) return null;
  // (C) Normale Regeln nach Vorgangsstatus.
  switch (row.process.mainStatus) {
    case 'open':
    case 'reopened':
      return 'active';
    case 'completed':
      // Phase 15 (Final-Korrektur): `paid` mit `locked_at` ist durch (B) bereits ausgeschlossen –
      // übrig bleibt „finanziell kundenseitig offen“ (kein Settlement, nicht gesperrt, kein
      // Zahlungsstatus, open/overdue).
      return 'completed_open';
    case 'cancelled':
      // Ohne Stornozeile (z. B. Vorgang ohne Buchungsstorno) ⇒ unsichtbar.
      return null;
  }
}

/** Zustand aus der Stornozeile: 0 € nur im Bestätigungsfenster, sonst bis `paid` sichtbar. */
function cancelledStateOf(
  cancellation: CancellationRow,
  now: Date,
  options: { includeCancelledFree: boolean },
): PortalBookingState | null {
  if (cancellation.feeCents === 0) {
    if (!options.includeCancelledFree) return null;
    // Phase 15 (Review R12): Bestätigungsansicht nur nach eigener Aktion des Kunden –
    // ein kostenfreies Staff-Storno ist sofort unsichtbar.
    if (cancellation.cancelerType !== 'customer') return null;
    const age = now.getTime() - cancellation.cancelledAt.getTime();
    return age <= PORTAL_CANCELLED_FREE_VISIBLE_MS ? 'cancelled_free' : null;
  }
  return cancellation.financeStatus === 'paid' ? null : 'cancelled_fee';
}

async function loadCandidates(
  db: Database,
  customerId: string,
  bookingId: string | null,
): Promise<CandidateRow[]> {
  const ownership = and(
    eq(bookings.customerId, customerId),
    eq(processes.customerId, customerId),
    ...(bookingId === null ? [] : [eq(bookings.id, bookingId)]),
  );
  const rows = await db
    .select({
      booking: bookings,
      process: {
        id: processes.id,
        processNumber: processes.processNumber,
        mainStatus: processes.mainStatus,
        eventDate: processes.eventDate,
      },
      settlement: {
        id: settlements.id,
        lockedAt: settlements.lockedAt,
        paymentStatus: settlements.paymentStatus,
        amountDueCents: settlements.amountDueCents,
      },
      cancellation: cancellations,
    })
    .from(bookings)
    .innerJoin(processes, eq(processes.id, bookings.processId))
    .leftJoin(settlements, eq(settlements.bookingId, bookings.id))
    .leftJoin(cancellations, eq(cancellations.bookingId, bookings.id))
    .where(ownership);
  return rows.map((row) => ({
    booking: row.booking,
    process: row.process,
    // Left Join: ohne Treffer liefert Drizzle ein Objekt mit null-Feldern bzw. null.
    settlement: row.settlement === null || row.settlement.id === null ? null : row.settlement,
    cancellation: row.cancellation,
  }));
}

function compareVisible(a: VisibleBooking, b: VisibleBooking): number {
  const dateA = visibleBookingEventDate(a);
  const dateB = visibleBookingEventDate(b);
  if (dateA !== dateB) {
    if (dateA === null) return 1;
    if (dateB === null) return -1;
    return dateA < dateB ? -1 : 1;
  }
  return a.process.processNumber < b.process.processNumber
    ? -1
    : a.process.processNumber > b.process.processNumber
      ? 1
      : 0;
}

/**
 * Aktuelle Buchungen eines Kunden (Order §15): sortiert nach nächstem
 * Eventdatum (NULL zuletzt), dann Vorgangsnummer. Kostenfreie Stornos erscheinen
 * hier NIE.
 */
export async function listVisibleBookings(
  db: Database,
  customerId: string,
  now: Date = new Date(),
): Promise<VisibleBooking[]> {
  const candidates = await loadCandidates(db, customerId, null);
  const visible: VisibleBooking[] = [];
  for (const row of candidates) {
    const portalState = portalStateOf(row, now, { includeCancelledFree: false });
    if (portalState === null) continue;
    visible.push({ ...row, portalState });
  }
  return visible.sort(compareVisible);
}

/**
 * Eine Buchung des Kunden auflösen – fremd/unbekannt/unsichtbar ⇒ `null`
 * (Route: neutrales 404). `includeCancelledFree` nur für die Detailansicht und
 * die Antwort des Storno-POST direkt nach einem kostenfreien Kundenstorno (24 h);
 * alle übrigen Unterrouten lösen ohne Fenster auf (Phase 15, Review R12).
 */
export async function resolveVisibleBooking(
  db: Database,
  customerId: string,
  bookingId: string,
  now: Date = new Date(),
  options: { includeCancelledFree?: boolean } = {},
): Promise<VisibleBooking | null> {
  const candidates = await loadCandidates(db, customerId, bookingId);
  const row = candidates[0];
  if (row === undefined) return null;
  const portalState = portalStateOf(row, now, {
    includeCancelledFree: options.includeCancelledFree ?? false,
  });
  if (portalState === null) return null;
  return { ...row, portalState };
}

export const CustomerPortalVisibilityPolicy = {
  listVisibleBookings,
  resolveVisibleBooking,
  portalStateOf,
  isSettlementFinallyPaid, // Phase 15 (Final-Korrektur)
};
