import {
  appointments,
  processes,
  pushDeliveries,
  type Appointment,
  type DatabaseExecutor,
} from '@mietroyal/database';
import { berlinDateOf, isSameBerlinDay } from '@mietroyal/domain';
import { and, eq, sql } from 'drizzle-orm';
import { effectiveAssigneeForAppointment, loadSubstitutions } from '../../scheduling/assignee.ts';
import { appointmentPushFingerprint, pushKeys, reassignmentKeyPrefix } from './keys.ts';

/**
 * Phase 12 Finalisierung (B2): Versandzeit-Prüfung terminbezogener Pushes.
 *
 * Der Claim (rules.ts) stellt sicher, dass beim ANLEGEN der Zustellung die
 * Person zuständig war. Zwischen Commit und `push.send` (Queue-Latenz,
 * Retry-Backoff +30 s …) kann sich der Termin aber ändern (Neuzuweisung,
 * Verschiebung, Storno, Vertretungswechsel). Deshalb bewertet `push.send` vor
 * jedem Gateway-Aufruf die Zustellung gegen den AKTUELLEN Stand – dieselben
 * Bausteine wie die Regeln (pushKeys, appointmentPushFingerprint,
 * effectiveAssigneeForAppointment), also keine zweite Fachlogik.
 *
 * Ergebnis (`DeliveryCurrency`):
 * - `current`  ⇒ senden.
 * - `superseded` (nur 1h-Push, Verhalten unverändert) ⇒ `skipped`/`SUPERSEDED`;
 *   Schlüssel wird freigegeben, wenn noch kein Gerät erreicht wurde (RA14/RA15).
 * - Kurzfrist-Push (Phase 12 Finalisierung 2, Regel F):
 *   `closed` ⇒ die Zuweisungs-Version gilt nicht mehr (Termin nicht geplant,
 *   Vorgang storniert, requestedAt/-for geändert, assigned ≠ requested_for,
 *   start_at fehlt oder liegt an einem anderen Berliner Kalendertag als
 *   requestedAt) ⇒ `skipped`/`SUPERSEDED`, Schlüssel bleibt BELEGT – damit
 *   schließt die Zustellung die Version (keine Wiederbelebung bei
 *   heute → morgen → heute).
 *   `recipient_changed` ⇒ Version gültig + same-day, aber die effektive
 *   Zuständigkeit (Vertretung) ist jetzt eine andere Person ⇒ `skipped`/
 *   `SUPERSEDED_RECIPIENT`; Schlüssel wird freigegeben, wenn noch kein Gerät
 *   erreicht wurde. Der nächste Scan erzeugt K(neuer Empfänger) genau einmal.
 *
 * Restfenster: Gateways laufen nie in einer offenen Transaktion (keine
 * Sperre während des Versands) – eine Änderung, die NACH der Prüfung und
 * während des laufenden Gateway-Aufrufs committed wird, kann genau diesen
 * einen Aufruf nicht mehr verhindern.
 */

export const PUSH_SUPERSEDED_CODE = 'SUPERSEDED';
/** Phase 12 Finalisierung 2: Kurzfrist-Push überholt, weil die effektive Zuständigkeit wechselte. */
export const PUSH_SUPERSEDED_RECIPIENT_CODE = 'SUPERSEDED_RECIPIENT';

export type DeliveryCurrency = 'current' | 'superseded' | 'recipient_changed' | 'closed';

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

// ── Kurzfrist-Push: Zuweisungs-Version (Regeln A, C, E) ─────────────────────

/** Regel C: Push nur, wenn start_at gesetzt UND am selben Berliner Kalendertag wie requestedAt. */
export function isSameDayReassignment(startAt: Date | null, requestedAt: Date): boolean {
  return startAt !== null && isSameBerlinDay(startAt, requestedAt);
}

/**
 * Review Runde 3 (B2): Ein NEUER Kurzfrist-Anspruch (Claim) entsteht nie NACH dem
 * Durchführungstag – kein „Kurzfrist“-Push am Folgetag (z. B. nach einem
 * regulären Vertretungsende) und kein Nachholen nach Mitternacht. Da der Claim
 * nie vor der Neuzuweisung liegt (requestedAt am Durchführungstag), heißt das:
 * Claims nur AM Durchführungstag. Die Versandprüfung braucht das nicht – der
 * Job läuft unmittelbar nach dem Claim.
 */
export function isReassignmentClaimDay(
  startAt: Date | null,
  requestedAt: Date,
  now: Date,
): boolean {
  return (
    startAt !== null &&
    isSameDayReassignment(startAt, requestedAt) &&
    berlinDateOf(now) <= berlinDateOf(startAt)
  );
}

export interface ReassignmentVersionDelivery {
  idempotencyKey: string;
  userId: string;
  status: string;
  lastErrorCode: string | null;
}

/**
 * Alle Kurzfrist-Zustellungen EINER Zuweisungs-Version (Termin + requestedAt):
 * kind `assignment_reassigned`, gleicher Termin, Schlüssel mit dem Präfix der
 * Version (auch freigegebene mit Suffix). Auch in einer Transaktion nutzbar.
 */
export async function loadReassignmentVersionDeliveries(
  db: DatabaseExecutor,
  appointmentId: string,
  requestedAt: Date,
): Promise<ReassignmentVersionDelivery[]> {
  return db
    .select({
      idempotencyKey: pushDeliveries.idempotencyKey,
      userId: pushDeliveries.userId,
      status: pushDeliveries.status,
      lastErrorCode: pushDeliveries.lastErrorCode,
    })
    .from(pushDeliveries)
    .where(
      and(
        eq(pushDeliveries.kind, 'assignment_reassigned'),
        eq(pushDeliveries.appointmentId, appointmentId),
        sql`starts_with(${pushDeliveries.idempotencyKey}, ${reassignmentKeyPrefix(appointmentId, requestedAt)})`,
      ),
    );
}

/**
 * Regel E: Version „geschlossen“ ⇔ (assignment_notified_at gesetzt UND keine
 * Zustellung der Version – No-op beim Claim: storniert/anderer Tag/inaktiv)
 * ODER (eine Zustellung der Version wurde schließend überholt: `skipped` +
 * `SUPERSEDED`). Geschlossene Versionen erzeugen nie wieder einen Push.
 */
export function isReassignmentVersionClosed(
  assignmentNotifiedAt: Date | null,
  deliveries: readonly ReassignmentVersionDelivery[],
): boolean {
  if (assignmentNotifiedAt !== null && deliveries.length === 0) return true;
  return deliveries.some(
    (delivery) => delivery.status === 'skipped' && delivery.lastErrorCode === PUSH_SUPERSEDED_CODE,
  );
}

/**
 * Regel A: Ist die Zuweisungs-Version des Termins gültig (geplant,
 * requestedAt/-for gesetzt, assigned = requested_for)? Liefert requestedAt.
 */
function validReassignmentVersion(appointment: Appointment): Date | null {
  const requestedAt = appointment.acknowledgementRequestedAt;
  const requestedFor = appointment.acknowledgementRequestedFor;
  if (appointment.status !== 'scheduled') return null;
  if (requestedAt === null || requestedFor === null) return null;
  if (appointment.assignedUserId !== requestedFor) return null;
  return requestedAt;
}

async function loadAppointmentWithProcess(
  db: DatabaseExecutor,
  appointmentId: string,
): Promise<{ appointment: Appointment; processCancelled: boolean } | null> {
  const rows = await db
    .select({ appointment: appointments, mainStatus: processes.mainStatus })
    .from(appointments)
    .innerJoin(processes, eq(processes.id, appointments.processId))
    .where(eq(appointments.id, appointmentId));
  const row = rows[0];
  if (row === undefined) return null;
  return { appointment: row.appointment, processCancelled: row.mainStatus === 'cancelled' };
}

/**
 * Empfänger + Schlüssel, die der aktuelle Terminstand für diese Art erzeugen
 * würde; `null` ⇒ der aktuelle Stand erzeugt gar keine Zustellung (Termin
 * nicht geplant, Vorgang storniert, ohne Zeit/Zuständigkeit; Kurzfrist-Push:
 * keine gültige Version oder nicht am selben Berliner Tag).
 */
export async function currentAppointmentPushKey(
  db: DatabaseExecutor,
  kind: string,
  appointmentId: string,
  now: Date,
): Promise<{ userId: string; key: string } | null> {
  const loaded = await loadAppointmentWithProcess(db, appointmentId);
  if (loaded === null || loaded.processCancelled) return null;
  const { appointment } = loaded;
  if (appointment.status !== 'scheduled') return null;

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
    const requestedAt = validReassignmentVersion(appointment);
    if (requestedAt === null) return null;
    if (!isSameDayReassignment(appointment.startAt, requestedAt)) return null;
    // Regel B: Empfänger = EFFEKTIVE Zuständigkeit (wie die 1h-Regel).
    const recipient = effectiveAssigneeForAppointment(
      appointment,
      await loadSubstitutions(db),
      now,
    );
    if (recipient === null) return null;
    // requestedAt aus demselben Lesepfad (JS-Date, ms-genau) wie im Claim.
    return { userId: recipient, key: pushKeys.reassignment(appointmentId, requestedAt, recipient) };
  }
  return null;
}

/** Bewertung einer Zustellung gegen den aktuellen Stand (siehe Moduldoku). */
export async function deliveryCurrency(
  db: DatabaseExecutor,
  delivery: AppointmentBoundDelivery,
  now: Date,
): Promise<DeliveryCurrency> {
  if (!requiresCurrencyCheck(delivery) || delivery.appointmentId === null) return 'current';
  const appointmentId = delivery.appointmentId;

  if (delivery.kind === 'assignment_reassigned') {
    const loaded = await loadAppointmentWithProcess(db, appointmentId);
    if (loaded === null || loaded.processCancelled) return 'closed';
    const { appointment } = loaded;
    const requestedAt = validReassignmentVersion(appointment);
    if (requestedAt === null) return 'closed';
    // Gehört die Zustellung zur aktuellen Version (gleicher Termin + requestedAt)?
    if (!delivery.idempotencyKey.startsWith(reassignmentKeyPrefix(appointmentId, requestedAt))) {
      return 'closed';
    }
    if (!isSameDayReassignment(appointment.startAt, requestedAt)) return 'closed';
    const recipient = effectiveAssigneeForAppointment(
      appointment,
      await loadSubstitutions(db),
      now,
    );
    if (recipient === null || recipient !== delivery.userId) return 'recipient_changed';
    return delivery.idempotencyKey === pushKeys.reassignment(appointmentId, requestedAt, recipient)
      ? 'current'
      : 'closed';
  }

  const current = await currentAppointmentPushKey(db, delivery.kind, appointmentId, now);
  return current !== null &&
    current.userId === delivery.userId &&
    current.key === delivery.idempotencyKey
    ? 'current'
    : 'superseded';
}

/** true ⇒ senden; false ⇒ überholt. Nicht geprüfte Zustellungen ⇒ immer true. */
export async function isDeliveryStillCurrent(
  db: DatabaseExecutor,
  delivery: AppointmentBoundDelivery,
  now: Date,
): Promise<boolean> {
  return (await deliveryCurrency(db, delivery, now)) === 'current';
}
