/**
 * Phase-12-Finalisierung (Retention §4.1): EINE Definition des terminalen
 * Vorgangszustands für die Kommunikations-Retention.
 *
 * Terminal = `completed` ODER `cancelled`. Terminalzeitpunkt:
 * - completed ⇒ `processes.completed_at` (ProcessService.complete),
 * - cancelled ⇒ `processes.cancelled_at` – der persistierte fachliche
 *   Stornozeitpunkt: beide Storno-Wege (Legacy-Storno ohne Buchung und
 *   Phase-9-Storno mit Buchung) schreiben ihn an EINER Stelle
 *   (`ProcessService.markCancelledWithin`); beim Phase-9-Storno ist er
 *   identisch mit `cancellations.cancelled_at` (derselbe Zeitstempel in
 *   derselben Transaktion). Nie `updated_at`.
 * Nach einem Reopen ist der Vorgang nicht terminal; ein erneuter Abschluss
 * bzw. ein Storno setzt einen NEUEN Zeitpunkt.
 */
import type { Process } from '@mietroyal/database';

export const PROCESS_TERMINAL_STATUSES = ['completed', 'cancelled'] as const;
export type ProcessTerminalStatus = (typeof PROCESS_TERMINAL_STATUSES)[number];

export function isTerminalProcessStatus(
  status: Process['mainStatus'] | null | undefined,
): status is ProcessTerminalStatus {
  return status === 'completed' || status === 'cancelled';
}

/** Terminalzeitpunkt des AKTUELLEN Zustands oder null (offen/wieder geöffnet). */
export function processTerminalAt(
  process: Pick<Process, 'mainStatus' | 'completedAt' | 'cancelledAt'>,
): Date | null {
  if (process.mainStatus === 'completed') return process.completedAt;
  if (process.mainStatus === 'cancelled') return process.cancelledAt;
  return null;
}

/**
 * SQL-Ausdruck des Terminalzeitpunkts für eine Tabelle/Alias `p` (= processes)
 * – nur in rohen SQL-Texten dieses Moduls verwendet (keine Nutzereingabe).
 */
export const PROCESS_TERMINAL_AT_SQL = `CASE p.main_status
  WHEN 'completed' THEN p.completed_at
  WHEN 'cancelled' THEN p.cancelled_at
END`;
