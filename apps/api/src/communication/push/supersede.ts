import { appointments, processes, type DatabaseExecutor } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { effectiveAssigneeForAppointment, loadSubstitutions } from '../../scheduling/assignee.ts';
import { appointmentPushFingerprint, pushKeys } from './rules.ts';

/**
 * Phase 12 Finalisierung (B2): Versandzeit-Prüfung terminbezogener Pushes.
 *
 * Der Claim (rules.ts) stellt sicher, dass beim ANLEGEN der Zustellung die
 * Person zuständig war. Zwischen Commit und `push.send` (Queue-Latenz,
 * Retry-Backoff +30 s …) kann sich der Termin aber ändern (Neuzuweisung,
 * Verschiebung, Storno). Deshalb berechnet `push.send` vor jedem
 * Gateway-Aufruf den Schlüssel, den der AKTUELLE Stand erzeugen würde, und
 * vergleicht ihn mit dem gespeicherten `idempotency_key` – dieselben
 * Bausteine wie die Regeln (pushKeys, appointmentPushFingerprint,
 * effectiveAssigneeForAppointment), also keine zweite Fachlogik.
 * Passt er nicht ⇒ Zustellung `skipped`/`SUPERSEDED`, kein Versand. Die
 * aktuell zuständige Person erhält ihren eigenen Push über die Regel
 * (neuer Fingerprint bzw. neuer requestedAt ⇒ neuer Anspruch).
 *
 * Restfenster: Gateways laufen nie in einer offenen Transaktion (keine
 * Sperre während des Versands) – eine Änderung, die NACH der Prüfung und
 * während des laufenden Gateway-Aufrufs committed wird, kann genau diesen
 * einen Aufruf nicht mehr verhindern.
 */

export const PUSH_SUPERSEDED_CODE = 'SUPERSEDED';

/** Kinds mit Versandzeit-Prüfung (Zustellungen mit `appointmentId`). */
const APPOINTMENT_BOUND_KINDS: ReadonlySet<string> = new Set([
  'appointment_1h',
  'assignment_reassigned',
]);

export interface AppointmentBoundDelivery {
  kind: string;
  userId: string;
  idempotencyKey: string;
  appointmentId: string | null;
}

/** Nur Zustellungen mit `appointmentId` und einem der beiden Kinds; Altbestand/andere unverändert. */
export function requiresCurrencyCheck(delivery: AppointmentBoundDelivery): boolean {
  return delivery.appointmentId !== null && APPOINTMENT_BOUND_KINDS.has(delivery.kind);
}

/**
 * Empfänger + Schlüssel, die der aktuelle Terminstand für diese Art erzeugen
 * würde; `null` ⇒ der aktuelle Stand erzeugt gar keine Zustellung (Termin
 * nicht geplant, Vorgang storniert, ohne Zeit/Zuständigkeit, keine offene
 * Kurzfrist-Neuzuweisung).
 */
export async function currentAppointmentPushKey(
  db: DatabaseExecutor,
  kind: string,
  appointmentId: string,
  now: Date,
): Promise<{ userId: string; key: string } | null> {
  const rows = await db
    .select({ appointment: appointments, mainStatus: processes.mainStatus })
    .from(appointments)
    .innerJoin(processes, eq(processes.id, appointments.processId))
    .where(eq(appointments.id, appointmentId));
  const row = rows[0];
  if (row === undefined) return null;
  const { appointment } = row;
  if (appointment.status !== 'scheduled' || row.mainStatus === 'cancelled') return null;

  if (kind === 'appointment_1h') {
    const startAt = appointment.startAt;
    if (startAt === null) return null;
    const assignee = effectiveAssigneeForAppointment(appointment, await loadSubstitutions(db), now);
    if (assignee === null) return null;
    return {
      userId: assignee,
      key: pushKeys.appointment1h(
        appointmentId,
        appointmentPushFingerprint(appointmentId, startAt, assignee),
      ),
    };
  }
  if (kind === 'assignment_reassigned') {
    const requestedAt = appointment.acknowledgementRequestedAt;
    const requestedFor = appointment.acknowledgementRequestedFor;
    if (requestedAt === null || requestedFor === null) return null;
    if (appointment.assignedUserId !== requestedFor) return null;
    // requestedAt aus demselben Lesepfad (JS-Date, ms-genau) wie im Claim.
    return {
      userId: requestedFor,
      key: pushKeys.reassignment(appointmentId, requestedAt, requestedFor),
    };
  }
  return null;
}

/** true ⇒ senden; false ⇒ überholt (SUPERSEDED). Nicht geprüfte Zustellungen ⇒ immer true. */
export async function isDeliveryStillCurrent(
  db: DatabaseExecutor,
  delivery: AppointmentBoundDelivery,
  now: Date,
): Promise<boolean> {
  if (!requiresCurrencyCheck(delivery) || delivery.appointmentId === null) return true;
  const current = await currentAppointmentPushKey(db, delivery.kind, delivery.appointmentId, now);
  return (
    current !== null &&
    current.userId === delivery.userId &&
    current.key === delivery.idempotencyKey
  );
}
