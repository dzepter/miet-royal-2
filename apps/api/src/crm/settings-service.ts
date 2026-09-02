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

// ── Generische String-Settings (Phase 3: Abholung, Vorgaben Nr. 13/33) ────

export const PICKUP_PUBLIC_AREA_KEY = 'pickup_public_area';
export const PICKUP_PUBLIC_AREA_DEFAULT = 'Mainz-Hechtsheim';
export const PICKUP_EXACT_ADDRESS_KEY = 'pickup_exact_address';

export async function getStringSetting(db: Database, key: string): Promise<string | null> {
  const rows = await db.select().from(systemSettings).where(eq(systemSettings.key, key));
  const value = rows[0]?.value;
  if (typeof value === 'string' && value.trim() !== '') return value;
  return null;
}

export async function setStringSetting(
  db: Database,
  actorId: string,
  key: string,
  value: string | null,
): Promise<void> {
  const stored = value === null || value.trim() === '' ? null : value.trim();
  await db
    .insert(systemSettings)
    .values({ key, value: stored, updatedBy: actorId })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: stored, updatedBy: actorId, updatedAt: new Date() },
    });
}

/** Öffentliche Abholregion (Default: Mainz-Hechtsheim). */
export async function getPickupPublicArea(db: Database): Promise<string> {
  return (await getStringSetting(db, PICKUP_PUBLIC_AREA_KEY)) ?? PICKUP_PUBLIC_AREA_DEFAULT;
}

/** Exakte Abholadresse – NIE erfunden; null = nicht konfiguriert. */
export async function getPickupExactAddress(db: Database): Promise<string | null> {
  return getStringSetting(db, PICKUP_EXACT_ADDRESS_KEY);
}

// ── Scheduling-Settings (Phase 4, Order §25/§32) ──────────────────────────

export const APPOINTMENT_REMINDER_MINUTES_KEY = 'appointment_reminder_minutes';
export const APPOINTMENT_REMINDER_MINUTES_DEFAULT = 60;

/**
 * Vorlauf der geschäftskritischen Termin-Erinnerung in Minuten (Default 60).
 * Adminpflegbar als Systemsetting; NICHT pro Mitarbeiter deaktivierbar.
 */
export async function getAppointmentReminderMinutes(db: Database): Promise<number> {
  const rows = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, APPOINTMENT_REMINDER_MINUTES_KEY));
  const value = rows[0]?.value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= 24 * 60) {
    return value;
  }
  return APPOINTMENT_REMINDER_MINUTES_DEFAULT;
}

export async function setAppointmentReminderMinutes(
  db: Database,
  actorId: string,
  minutes: number,
): Promise<void> {
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 24 * 60) {
    throw new AuthError(
      'VALIDATION',
      'Bitte einen Erinnerungs-Vorlauf zwischen 5 und 1440 Minuten angeben.',
    );
  }
  await db
    .insert(systemSettings)
    .values({ key: APPOINTMENT_REMINDER_MINUTES_KEY, value: minutes, updatedBy: actorId })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: minutes, updatedBy: actorId, updatedAt: new Date() },
    });
}
