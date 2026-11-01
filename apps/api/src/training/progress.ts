import {
  trainingAssignments,
  trainingAttempts,
  trainingPathItems,
  type DatabaseExecutor,
  type TrainingAssignment,
} from '@mietroyal/database';
import { and, eq, inArray, isNull } from 'drizzle-orm';

/**
 * Phase 14 (Training, Order §36/§46/§48, Design §4.2): Fortschritt einer
 * Zuweisung. Eine Übung gilt als bestanden, wenn der Mitarbeiter dafür einen
 * NICHT supersedierten `passed`-Versuch besitzt – unabhängig davon, ob der
 * Versuch mit der Zuweisung verknüpft wurde (bestanden bleibt bestanden; nur
 * ein bewusster Training-Reset setzt `superseded_at`, §48). Status:
 * `completed` = alle Pflichtübungen bestanden, `in_progress` = mindestens ein
 * laufender oder bestandener Versuch, sonst `assigned`.
 */

export type AssignmentStatus = TrainingAssignment['status'];

async function assignmentStatusFor(
  executor: DatabaseExecutor,
  assignment: TrainingAssignment,
): Promise<AssignmentStatus> {
  const items = await executor
    .select({ definitionId: trainingPathItems.definitionId, required: trainingPathItems.required })
    .from(trainingPathItems)
    .where(eq(trainingPathItems.pathId, assignment.pathId));
  if (items.length === 0) return 'assigned';
  const attempts = await executor
    .select({ definitionId: trainingAttempts.definitionId, status: trainingAttempts.status })
    .from(trainingAttempts)
    .where(
      and(
        eq(trainingAttempts.userId, assignment.userId),
        isNull(trainingAttempts.supersededAt),
        inArray(
          trainingAttempts.definitionId,
          items.map((item) => item.definitionId),
        ),
        inArray(trainingAttempts.status, ['passed', 'in_progress']),
      ),
    );
  const passed = new Set(attempts.filter((a) => a.status === 'passed').map((a) => a.definitionId));
  const active = attempts.some((a) => a.status === 'in_progress');
  const required = items.filter((item) => item.required);
  if (required.length > 0 && required.every((item) => passed.has(item.definitionId))) {
    return 'completed';
  }
  return passed.size > 0 || active ? 'in_progress' : 'assigned';
}

/** Status einer Zuweisung neu berechnen und – nur bei Änderung – speichern. */
export async function refreshAssignmentProgress(
  executor: DatabaseExecutor,
  assignmentId: string,
  now: Date,
): Promise<AssignmentStatus | null> {
  const rows = await executor
    .select()
    .from(trainingAssignments)
    .where(eq(trainingAssignments.id, assignmentId));
  const assignment = rows[0];
  if (assignment === undefined) return null;
  const status = await assignmentStatusFor(executor, assignment);
  if (status !== assignment.status) {
    await executor
      .update(trainingAssignments)
      .set({
        status,
        completedAt: status === 'completed' ? now : null,
        updatedAt: now,
      })
      .where(eq(trainingAssignments.id, assignmentId));
  }
  return status;
}

/** Alle Zuweisungen des Mitarbeiters aktualisieren, deren Pfad diese Übung enthält. */
export async function refreshAssignmentsForDefinition(
  executor: DatabaseExecutor,
  userId: string,
  definitionId: string,
  now: Date,
): Promise<void> {
  const rows = await executor
    .select({ id: trainingAssignments.id })
    .from(trainingAssignments)
    .innerJoin(trainingPathItems, eq(trainingPathItems.pathId, trainingAssignments.pathId))
    .where(
      and(eq(trainingAssignments.userId, userId), eq(trainingPathItems.definitionId, definitionId)),
    );
  for (const row of rows) await refreshAssignmentProgress(executor, row.id, now);
}
