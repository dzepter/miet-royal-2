import {
  trainingAttemptEvents,
  trainingAttempts,
  trainingDefinitions,
  type Database,
  type DatabaseExecutor,
} from '@mietroyal/database';
import { and, asc, eq } from 'drizzle-orm';
import type { TrainingEventKey } from './event-keys.ts';
import {
  evaluatorAcceptsEvent,
  evaluatorFor,
  isComplete,
  matchEvent,
  type AcceptedEvent,
  type MatchResultKind,
} from './evaluators.ts';
import { refreshAssignmentsForDefinition } from './progress.ts';

/**
 * Phase 14 (Training, Order §§41–43, §45, §81, Design §4.2): zentrale
 * Boundary TrainingEventRecorder.
 *
 * - APP_ENV != demo: Noop (keine Fachaktion wird als Trainingsversuch
 *   aufgezeichnet, §43).
 * - APP_ENV = demo: `DemoTrainingEventRecorder` – wird von den Fachrouten/Jobs
 *   IMMER erst NACH dem erfolgreichen Fachcommit aufgerufen (§42) und schreibt
 *   in einer eigenen kurzen Transaktion: laufende Versuche des Akteurs (und nur
 *   dieses Akteurs, §81) werden gesperrt, das Ereignis je Versuch über den
 *   Evaluator zugeordnet (accepted/duplicate/rejected), als Ereigniszeile
 *   gespeichert und bei Vollständigkeit wird der Versuch automatisch `passed`
 *   (§45, kein Doppelabschluss). Fehler werden gefangen und nur mit Code
 *   geloggt – sie erreichen NIE den Fachaufrufer.
 */

export interface TrainingEventInput {
  actorUserId: string;
  eventKey: TrainingEventKey;
  /** Serverseitig ermittelte ID des Fachobjekts (UUID) – nie Client-Eingabe. */
  subjectRef?: string | null | undefined;
  occurredAt?: Date | undefined;
}

export interface TrainingEventRecorder {
  record(input: TrainingEventInput): Promise<void>;
}

export interface TrainingRecorderLogger {
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface TrainingRecordOutcome {
  attemptId: string;
  stepKey: string | null;
  result: MatchResultKind;
  errorCode: string | null;
  /** true, wenn DIESES Ereignis den Versuch abgeschlossen hat. */
  passed: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createNoopTrainingRecorder(): TrainingEventRecorder {
  return { record: async () => undefined };
}

/** Akzeptierte Ereignisse eines Versuchs (nur Schritt + Fachobjekt). */
export async function acceptedEventsFor(
  executor: DatabaseExecutor,
  attemptId: string,
): Promise<AcceptedEvent[]> {
  const rows = await executor
    .select({
      stepKey: trainingAttemptEvents.stepKey,
      subjectRef: trainingAttemptEvents.subjectRef,
    })
    .from(trainingAttemptEvents)
    .where(
      and(
        eq(trainingAttemptEvents.attemptId, attemptId),
        eq(trainingAttemptEvents.result, 'accepted'),
      ),
    )
    .orderBy(asc(trainingAttemptEvents.occurredAt));
  const accepted: AcceptedEvent[] = [];
  for (const row of rows) {
    if (row.stepKey === null) continue;
    accepted.push({ stepKey: row.stepKey, subjectRef: row.subjectRef });
  }
  return accepted;
}

export class DemoTrainingEventRecorder implements TrainingEventRecorder {
  private readonly logger: TrainingRecorderLogger | undefined;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    options: { logger?: TrainingRecorderLogger | undefined; now?: (() => Date) | undefined } = {},
  ) {
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
  }

  async record(input: TrainingEventInput): Promise<void> {
    try {
      await this.recordOrThrow(input);
    } catch (error) {
      // Nie an den Fachaufrufer weiterreichen; nur Code/Klasse loggen (keine Inhalte).
      this.logger?.error(
        {
          eventKey: input.eventKey,
          errorName: error instanceof Error ? error.name : 'Error',
          dbCode: (error as { cause?: { code?: unknown } } | null)?.cause?.code ?? null,
        },
        'Training: Ereignis konnte nicht aufgezeichnet werden',
      );
    }
  }

  /** Wie `record`, wirft aber (Tests/Diagnose). */
  async recordOrThrow(input: TrainingEventInput): Promise<TrainingRecordOutcome[]> {
    const occurredAt = input.occurredAt ?? this.now();
    let subjectRef: string | null = input.subjectRef ?? null;
    if (subjectRef !== null && !UUID_PATTERN.test(subjectRef)) {
      this.logger?.warn(
        { eventKey: input.eventKey },
        'Training: subjectRef ist keine UUID – ignoriert',
      );
      subjectRef = null;
    }
    const subject = subjectRef;
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ attempt: trainingAttempts, evaluatorKey: trainingDefinitions.evaluatorKey })
        .from(trainingAttempts)
        .innerJoin(trainingDefinitions, eq(trainingDefinitions.id, trainingAttempts.definitionId))
        .where(
          and(
            eq(trainingAttempts.userId, input.actorUserId),
            eq(trainingAttempts.status, 'in_progress'),
          ),
        )
        .orderBy(asc(trainingAttempts.startedAt))
        .for('update', { of: trainingAttempts });
      const outcomes: TrainingRecordOutcome[] = [];
      for (const row of rows) {
        const spec = evaluatorFor(row.evaluatorKey);
        if (spec === null || !evaluatorAcceptsEvent(spec, input.eventKey)) continue;
        const accepted = await acceptedEventsFor(tx, row.attempt.id);
        const match = matchEvent(spec, accepted, { eventKey: input.eventKey, subjectRef: subject });
        await tx.insert(trainingAttemptEvents).values({
          attemptId: row.attempt.id,
          eventKey: input.eventKey,
          stepKey: match.stepKey,
          result: match.result,
          errorCode: match.errorCode,
          subjectRef: subject,
          occurredAt,
        });
        let passed = false;
        if (match.result === 'accepted' && match.stepKey !== null) {
          const next = [...accepted, { stepKey: match.stepKey, subjectRef: subject }];
          if (isComplete(spec, next)) {
            const updated = await tx
              .update(trainingAttempts)
              .set({ status: 'passed', completedAt: occurredAt, updatedAt: occurredAt })
              .where(
                and(
                  eq(trainingAttempts.id, row.attempt.id),
                  eq(trainingAttempts.status, 'in_progress'),
                ),
              )
              .returning({ id: trainingAttempts.id });
            passed = updated.length === 1;
            if (passed) {
              await refreshAssignmentsForDefinition(
                tx,
                row.attempt.userId,
                row.attempt.definitionId,
                occurredAt,
              );
            }
          }
        }
        outcomes.push({
          attemptId: row.attempt.id,
          stepKey: match.stepKey,
          result: match.result,
          errorCode: match.errorCode,
          passed,
        });
      }
      return outcomes;
    });
  }
}
