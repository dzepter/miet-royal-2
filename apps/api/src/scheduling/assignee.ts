import {
  staffSubstitutions,
  staffUsers,
  type Database,
  type StaffSubstitution,
} from '@mietroyal/database';
import { resolveEffectiveAssigneeId, type SubstitutionLike } from '@mietroyal/domain';
import { eq } from 'drizzle-orm';

/**
 * Effektive Zuständigkeit (Order §12): Die reine Auflösung lebt in
 * @mietroyal/domain (resolveEffectiveAssigneeId); hier steht nur das Laden
 * der Vertretungen. Historische Terminzuweisungen werden NIE umgeschrieben –
 * die Auflösung ist rein zeitabhängig, deshalb braucht das Ende einer
 * Vertretung keinen Hintergrundjob.
 */

export function toSubstitutionLike(row: StaffSubstitution): SubstitutionLike {
  return {
    originalUserId: row.originalUserId,
    substituteUserId: row.substituteUserId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    endedEarlyAt: row.endedEarlyAt,
  };
}

/**
 * Alle Vertretungen laden (kleine Tabelle; Filterung erfolgt zeitlich).
 * Vertretungen, deren Vertretung nicht mehr AKTIV ist (gesperrt/
 * deaktiviert), werden ignoriert – ein Nutzer ohne Login kann keine
 * Termine übernehmen, die Zuständigkeit fällt an das Original zurück.
 */
export async function loadSubstitutions(db: Database): Promise<SubstitutionLike[]> {
  const rows = await db
    .select({ substitution: staffSubstitutions, substituteStatus: staffUsers.status })
    .from(staffSubstitutions)
    .innerJoin(staffUsers, eq(staffUsers.id, staffSubstitutions.substituteUserId));
  return rows
    .filter((row) => row.substituteStatus === 'active')
    .map((row) => toSubstitutionLike(row.substitution));
}

/**
 * Effektiver Mitarbeiter eines Termins: für ZUKÜNFTIGE Termine zum
 * Terminbeginn ausgewertet (die Zeit, zu der die Arbeit stattfindet);
 * für bereits begonnene/überfällige oder ungeplante Termine zum Zeitpunkt
 * `now` – so fällt OFFENE Zuständigkeit nach Vertretungsende automatisch
 * an den Ursprungs-Mitarbeiter zurück (Order §12).
 */
export function effectiveAssigneeForAppointment(
  appointment: { assignedUserId: string | null; startAt: Date | null },
  substitutions: readonly SubstitutionLike[],
  now: Date,
): string | null {
  const at =
    appointment.startAt !== null && appointment.startAt.getTime() > now.getTime()
      ? appointment.startAt
      : now;
  return resolveEffectiveAssigneeId(appointment.assignedUserId, at, substitutions);
}
