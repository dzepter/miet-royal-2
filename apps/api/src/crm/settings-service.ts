import { systemSettings, type Database } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';

/**
 * Sichtbarkeitsdauer abgeschlossener Vorgänge für normale Mitarbeitende
 * (Phase-2-Vorgabe Nr. 9). Adminpflegbar; Default greift, solange kein
 * Wert gesetzt ist.
 */
export const COMPLETED_VISIBILITY_KEY = 'completed_process_staff_visibility_days';
export const COMPLETED_VISIBILITY_DEFAULT_DAYS = 7;

export async function getCompletedVisibilityDays(db: Database): Promise<number> {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, COMPLETED_VISIBILITY_KEY));
  const value = rows[0]?.value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3650) {
    return value;
  }
  return COMPLETED_VISIBILITY_DEFAULT_DAYS;
}

export async function setCompletedVisibilityDays(
  db: Database,
  actorId: string,
  days: number,
): Promise<void> {
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    throw new AuthError('VALIDATION', 'Bitte eine Anzahl Tage zwischen 0 und 3650 angeben.');
  }
  await db
    .insert(systemSettings)
    .values({ key: COMPLETED_VISIBILITY_KEY, value: days, updatedBy: actorId })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: days, updatedBy: actorId, updatedAt: new Date() },
    });
}
