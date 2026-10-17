import { cancellations, type DatabaseExecutor } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';

/**
 * Phase 9 §63: Eine stornierte Buchung wird NIE reaktiviert – auch nicht
 * nach einem Admin-Reopen des Vorgangs (der wieder geöffnete Vorgang ist nur
 * Arbeitsgrundlage; operativ geht es ausschließlich über einen Folgevorgang).
 * Maßgeblich ist die historische Stornozeile, nicht der Vorgangsstatus.
 * Der Server bleibt autoritativ; Aufrufer prüfen unter ihren Sperren.
 */
export const BOOKING_CANCELLED_MESSAGE =
  'Die Buchung wurde storniert – bitte einen Folgevorgang aus dem Storno anlegen.';

export async function isBookingCancelled(
  executor: DatabaseExecutor,
  processId: string,
): Promise<boolean> {
  const rows = await executor
    .select({ id: cancellations.id })
    .from(cancellations)
    .where(eq(cancellations.processId, processId))
    .limit(1);
  return rows.length > 0;
}

/** Wirft AuthError CONFLICT, wenn für den Vorgang eine Stornozeile existiert. */
export async function assertBookingNotCancelled(
  executor: DatabaseExecutor,
  processId: string,
): Promise<void> {
  if (await isBookingCancelled(executor, processId)) {
    throw new AuthError('CONFLICT', BOOKING_CANCELLED_MESSAGE);
  }
}
