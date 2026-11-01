import type { AppEnvironment } from '@mietroyal/config';
import {
  staffUsers,
  trainingAssignments,
  trainingAttemptEvents,
  trainingAttempts,
  trainingDefinitions,
  trainingPathItems,
  trainingPaths,
  type Database,
  type DatabaseExecutor,
  type TrainingAssignment,
  type TrainingAttempt,
  type TrainingAttemptEvent,
  type TrainingDefinition,
  type TrainingPath,
  type StaffUser,
} from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { recordSecurityEvent } from '../auth/audit.ts';
import {
  TRAINING_CATALOG,
  definitionOrderIndex,
  hasRequiredPermissions,
  type TrainingCatalog,
} from './catalog.ts';
import { TRAINING_ERROR_CODES, TRAINING_MESSAGES, TrainingError } from './errors.ts';
// Phase 14 Final §9: ein gemeinsamer Statuswert für Zuweisung und Live-Freigabe.
import { TRAINING_INACTIVE_USER_STATUS } from './gate-admin-service.ts';
import {
  evaluatorFor,
  isComplete,
  openStep,
  stepsView,
  type AcceptedEvent,
  type EvaluatorSpec,
} from './evaluators.ts';
import { refreshAssignmentProgress, refreshAssignmentsForDefinition } from './progress.ts';
import { acceptedEventsFor } from './recorder.ts';

/**
 * Phase 14 (Training, Order §§36–39, §§44–48, §53/§54, §85, Design §4.2):
 * Versuche, Fortschritt und Admin-Funktionen der Trainings-Metaebene. Alle
 * Antworten enthalten ausschließlich Metadaten (Keys, Status, Zähler,
 * Zeitpunkte, neutrale Codes) – nie Businessdaten (§54/§82).
 *
 * - Ein Versuch startet nur bewusst (§39); höchstens ein laufender Versuch je
 *   Mitarbeiter und Übung – idempotent über Vorabprüfung UND den partiellen
 *   Unique-Index (`ON CONFLICT … DO NOTHING` als Backstop für Doppelklicks).
 * - „Übung prüfen“ (§44): vollständig ⇒ `passed` + Ereignis `check_passed`;
 *   sonst `failed_check_count + 1` und Ereignis `check_failed` mit dem offenen
 *   Schritt und dem neutralen Code STEP_NOT_COMPLETED.
 * - Bestanden bleibt bestanden (§46): weder Katalog-Sync noch Demo-Reset
 *   ändern bestandene Versuche; nur ein bewusster Training-Reset (§48)
 *   supersediert sie (Historie bleibt, Runde + 1).
 */

export type TrainingItemState = 'passed' | 'in_progress' | 'open';

export interface TrainingStepView {
  key: string;
  title: string;
  done: boolean;
}

export interface TrainingSeedEntityRef {
  entityType: string;
  entityId: string;
}

export interface TrainingDefinitionView {
  key: string;
  version: number;
  title: string;
  objective: string;
  instructions: string;
  active: boolean;
  demoPath: string | null;
  seedKey: string | null;
  seedEntity: TrainingSeedEntityRef | null;
  steps: { key: string; title: string }[];
  permissionMissing: boolean;
}

/** Definition mit Zustand für den anfragenden Mitarbeiter (`/me`, `/definitions`). */
export interface TrainingDefinitionProgressView extends TrainingDefinitionView {
  state: TrainingItemState;
  passedAt: string | null;
  /** Laufender Versuch, sonst der jüngste nicht supersedierte Versuch (auch unterbrochen). */
  attempt: TrainingAttemptView | null;
}

export interface TrainingAttemptView {
  id: string;
  definitionKey: string;
  status: TrainingAttempt['status'];
  startedAt: string;
  completedAt: string | null;
  interruptedAt: string | null;
  interruptionCode: string | null;
  failedCheckCount: number;
  lastFailedCheckAt: string | null;
  steps: TrainingStepView[];
  openStep: { key: string; title: string } | null;
  assignmentId: string | null;
}

export interface TrainingAttemptEventView {
  eventKey: string;
  stepKey: string | null;
  result: TrainingAttemptEvent['result'];
  errorCode: string | null;
  occurredAt: string;
}

export interface TrainingAssignmentItemView {
  sequence: number;
  required: boolean;
  definition: TrainingDefinitionView;
  state: TrainingItemState;
  passedAt: string | null;
  attempt: TrainingAttemptView | null;
}

export interface TrainingAssignmentView {
  id: string;
  path: { key: string; title: string; description: string };
  status: TrainingAssignment['status'];
  assignedAt: string;
  dueAt: string | null;
  completedAt: string | null;
  round: number;
  items: TrainingAssignmentItemView[];
}

export interface TrainingOverview {
  environment: AppEnvironment;
  exercisesAvailable: boolean;
  assignments: TrainingAssignmentView[];
  definitions: TrainingDefinitionProgressView[];
  activeAttempts: TrainingAttemptView[];
}

export interface TrainingUserRef {
  id: string;
  firstName: string;
  lastName: string;
  /** Phase 14 Final §9: Kontostatus (active|locked|disabled) – deaktivierte Mitarbeiter erscheinen nur lesend. */
  status: StaffUser['status'];
}

export interface TrainingAdminItemView {
  definitionKey: string;
  title: string;
  state: TrainingItemState;
  lastAttempt: {
    status: TrainingAttempt['status'];
    failedCheckCount: number;
    lastFailedCheckAt: string | null;
    interruptionCode: string | null;
  } | null;
}

export interface TrainingAdminAssignmentView {
  pathKey: string;
  pathTitle: string;
  status: TrainingAssignment['status'];
  round: number;
  items: TrainingAdminItemView[];
}

export interface TrainingAdminUserOverview {
  user: TrainingUserRef;
  assignments: TrainingAdminAssignmentView[];
  interruptedAttempts: number;
  failedChecks: number;
}

export interface TrainingAdminAttemptView extends TrainingAttemptView {
  definitionTitle: string;
  definitionVersion: number;
  assignmentRound: number | null;
  supersededAt: string | null;
  events: TrainingAttemptEventView[];
}

export interface TrainingAdminUserDetail {
  user: TrainingUserRef;
  assignments: TrainingAssignmentView[];
  attempts: TrainingAdminAttemptView[];
}

export interface TrainingCatalogPathView {
  key: string;
  title: string;
  description: string;
  active: boolean;
  items: {
    sequence: number;
    required: boolean;
    definition: {
      key: string;
      version: number;
      title: string;
      active: boolean;
      evaluatorKey: string;
    };
  }[];
}

export interface TrainingResetResult {
  interruptedAttempts: number;
  supersededAttempts: number;
  resetAssignments: number;
}

export type SeedEntityResolver = (seedKey: string) => Promise<TrainingSeedEntityRef | null>;

export interface TrainingServiceDeps {
  db: Database;
  environment: AppEnvironment;
  /** Demo: Auflösung des Seed-Schlüssels über die Registry; sonst undefined ⇒ `seedEntity: null`. */
  seedEntities?: SeedEntityResolver | undefined;
  catalog?: TrainingCatalog | undefined;
  now?: (() => Date) | undefined;
}

export const TRAINING_RESET_INTERRUPTION_CODE = 'TRAINING_RESET';
export const DEMO_RESET_INTERRUPTION_CODE = 'DEMO_DATA_RESET';

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * Laufende Versuche als `interrupted` markieren (nie löschen) und je Versuch
 * ein Ereignis `interrupted` mit dem neutralen Code schreiben. Wird vom Demo-
 * Reset (`beforeBusinessWipe`, Code DEMO_DATA_RESET, Order §94) und vom
 * Training-Reset (Code TRAINING_RESET, §48) innerhalb der jeweiligen
 * Transaktion aufgerufen. Bestandene Versuche bleiben unangetastet.
 */
export async function interruptInProgressAttempts(
  tx: DatabaseExecutor,
  input: {
    code: string;
    now: Date;
    userId?: string | undefined;
    definitionIds?: readonly string[] | undefined;
  },
): Promise<number> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(input.code)) {
    throw new Error('Training: Unterbrechungscode muss ein neutraler Code sein');
  }
  if (input.definitionIds !== undefined && input.definitionIds.length === 0) return 0;
  const conditions = [eq(trainingAttempts.status, 'in_progress')];
  if (input.userId !== undefined) conditions.push(eq(trainingAttempts.userId, input.userId));
  if (input.definitionIds !== undefined) {
    conditions.push(inArray(trainingAttempts.definitionId, [...input.definitionIds]));
  }
  const interrupted = await tx
    .update(trainingAttempts)
    .set({
      status: 'interrupted',
      interruptedAt: input.now,
      interruptionCode: input.code,
      updatedAt: input.now,
    })
    .where(and(...conditions))
    .returning({ id: trainingAttempts.id });
  if (interrupted.length > 0) {
    await tx.insert(trainingAttemptEvents).values(
      interrupted.map((row) => ({
        attemptId: row.id,
        eventKey: 'training.interrupted',
        stepKey: null,
        result: 'interrupted' as const,
        errorCode: input.code,
        subjectRef: null,
        occurredAt: input.now,
      })),
    );
  }
  return interrupted.length;
}

export class TrainingService {
  private readonly db: Database;
  private readonly catalog: TrainingCatalog;
  private readonly now: () => Date;

  constructor(private readonly deps: TrainingServiceDeps) {
    this.db = deps.db;
    this.catalog = deps.catalog ?? TRAINING_CATALOG;
    this.now = deps.now ?? (() => new Date());
  }

  get environment(): AppEnvironment {
    return this.deps.environment;
  }

  get exercisesAvailable(): boolean {
    return this.deps.environment === 'demo';
  }

  // ── Versuche (Mitarbeiter) ────────────────────────────────────────────────

  async startAttempt(
    userId: string,
    definitionKey: string,
    effective: ReadonlySet<PermissionKey>,
    now = this.now(),
  ): Promise<{ attempt: TrainingAttemptView; created: boolean }> {
    const definition = await this.definitionByKey(this.db, definitionKey);
    if (definition === null) {
      throw new TrainingError(
        'NOT_FOUND',
        'TRAINING_DEFINITION_NOT_FOUND',
        TRAINING_MESSAGES.DEFINITION_NOT_FOUND,
      );
    }
    if (!definition.active) {
      throw new TrainingError(
        'CONFLICT',
        TRAINING_ERROR_CODES.DEFINITION_INACTIVE,
        TRAINING_MESSAGES.DEFINITION_INACTIVE,
        { definitionKey },
      );
    }
    const spec = this.catalog.definitions.find((candidate) => candidate.key === definitionKey);
    if (spec !== undefined && !hasRequiredPermissions(spec.requiredPermissions, effective)) {
      throw new TrainingError(
        'FORBIDDEN',
        TRAINING_ERROR_CODES.PERMISSION_MISSING,
        TRAINING_MESSAGES.PERMISSION_MISSING,
        { definitionKey },
      );
    }
    const existing = await this.activeAttempt(userId, definition.id);
    if (existing !== null) {
      return { attempt: await this.attemptViewOf(existing, definition), created: false };
    }
    const assignment = await this.assignmentForDefinition(userId, definition.id);
    const inserted = await this.db
      .insert(trainingAttempts)
      .values({
        userId,
        definitionId: definition.id,
        assignmentId: assignment?.id ?? null,
        assignmentRound: assignment?.round ?? null,
        definitionVersion: definition.version,
        status: 'in_progress',
        startedAt: now,
        updatedAt: now,
      })
      // Backstop des partiellen Unique-Index (Doppelklick/parallele Anfrage): kein
      // Fehler, sondern den bereits laufenden Versuch zurückgeben (§39).
      .onConflictDoNothing({
        target: [trainingAttempts.userId, trainingAttempts.definitionId],
        where: sql`"status" = 'in_progress'`,
      })
      .returning();
    const created = inserted[0];
    if (created === undefined) {
      const raced = await this.activeAttempt(userId, definition.id);
      if (raced === null) {
        throw new TrainingError('CONFLICT', 'TRAINING_ATTEMPT_CONFLICT', 'Bitte erneut versuchen.');
      }
      return { attempt: await this.attemptViewOf(raced, definition), created: false };
    }
    await refreshAssignmentsForDefinition(this.db, userId, definition.id, now);
    return { attempt: this.attemptView(created, definition, []), created: true };
  }

  async checkAttempt(
    userId: string,
    attemptId: string,
    now = this.now(),
  ): Promise<{
    attempt: TrainingAttemptView;
    passed: boolean;
    openStep: { key: string; title: string } | null;
  }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(trainingAttempts)
        .where(and(eq(trainingAttempts.id, attemptId), eq(trainingAttempts.userId, userId)))
        .for('update');
      const attempt = rows[0];
      if (attempt === undefined) {
        throw new TrainingError(
          'NOT_FOUND',
          'TRAINING_ATTEMPT_NOT_FOUND',
          TRAINING_MESSAGES.ATTEMPT_NOT_FOUND,
        );
      }
      const definition = await this.definitionById(tx, attempt.definitionId);
      const spec = this.specFor(definition);
      if (attempt.status === 'passed') {
        return {
          attempt: await this.attemptViewOf(attempt, definition, tx),
          passed: true,
          openStep: null,
        };
      }
      if (attempt.status === 'interrupted') {
        throw new TrainingError(
          'CONFLICT',
          TRAINING_ERROR_CODES.ATTEMPT_NOT_ACTIVE,
          TRAINING_MESSAGES.ATTEMPT_NOT_ACTIVE,
          { attemptId },
        );
      }
      const accepted = await acceptedEventsFor(tx, attempt.id);
      if (isComplete(spec, accepted)) {
        await tx
          .update(trainingAttempts)
          .set({ status: 'passed', completedAt: now, updatedAt: now })
          .where(eq(trainingAttempts.id, attempt.id));
        await tx.insert(trainingAttemptEvents).values({
          attemptId: attempt.id,
          eventKey: 'training.check',
          stepKey: null,
          result: 'check_passed',
          errorCode: null,
          subjectRef: null,
          occurredAt: now,
        });
        await refreshAssignmentsForDefinition(tx, userId, definition.id, now);
        const passedAttempt = await this.attemptById(tx, attempt.id);
        return {
          attempt: await this.attemptViewOf(passedAttempt, definition, tx),
          passed: true,
          openStep: null,
        };
      }
      const open = openStep(spec, accepted);
      await tx
        .update(trainingAttempts)
        .set({
          failedCheckCount: sql`${trainingAttempts.failedCheckCount} + 1`,
          lastFailedCheckAt: now,
          updatedAt: now,
        })
        .where(eq(trainingAttempts.id, attempt.id));
      await tx.insert(trainingAttemptEvents).values({
        attemptId: attempt.id,
        eventKey: 'training.check',
        stepKey: open?.key ?? null,
        result: 'check_failed',
        errorCode: TRAINING_ERROR_CODES.STEP_NOT_COMPLETED,
        subjectRef: null,
        occurredAt: now,
      });
      const updated = await this.attemptById(tx, attempt.id);
      return {
        attempt: await this.attemptViewOf(updated, definition, tx),
        passed: false,
        openStep: open === null ? null : { key: open.key, title: open.title },
      };
    });
  }

  /** Eigener Versuch (oder Admin) – fremde IDs antworten neutral 404 (§85). */
  async attemptDetail(
    attemptId: string,
    viewer: { userId: string; admin: boolean },
  ): Promise<{ attempt: TrainingAttemptView; events: TrainingAttemptEventView[] }> {
    const conditions = [eq(trainingAttempts.id, attemptId)];
    if (!viewer.admin) conditions.push(eq(trainingAttempts.userId, viewer.userId));
    const rows = await this.db
      .select()
      .from(trainingAttempts)
      .where(and(...conditions));
    const attempt = rows[0];
    if (attempt === undefined) {
      throw new TrainingError(
        'NOT_FOUND',
        'TRAINING_ATTEMPT_NOT_FOUND',
        TRAINING_MESSAGES.ATTEMPT_NOT_FOUND,
      );
    }
    const definition = await this.definitionById(this.db, attempt.definitionId);
    const events = await this.eventsFor(this.db, [attempt.id]);
    const own = events.get(attempt.id) ?? [];
    return {
      attempt: this.attemptView(attempt, definition, own),
      events: own.map(eventView),
    };
  }

  // ── Ansichten (Mitarbeiter) ──────────────────────────────────────────────

  /** Aktiver Katalog mit Zustand des anfragenden Mitarbeiters (freie Übungen bleiben nach Reload „erledigt“). */
  async definitionsView(
    userId: string,
    effective: ReadonlySet<PermissionKey>,
  ): Promise<TrainingDefinitionProgressView[]> {
    const definitions = await this.allDefinitions(this.db);
    const attempts = await this.attemptsForUser(userId);
    const events = await this.eventsFor(
      this.db,
      attempts.filter((attempt) => attempt.supersededAt === null).map((attempt) => attempt.id),
    );
    const seedCache = new Map<string, TrainingSeedEntityRef | null>();
    const views: TrainingDefinitionProgressView[] = [];
    for (const definition of definitions) {
      if (!definition.active) continue;
      views.push(
        await this.definitionProgressView(definition, effective, seedCache, attempts, events),
      );
    }
    return views;
  }

  async overviewForUser(
    userId: string,
    effective: ReadonlySet<PermissionKey>,
  ): Promise<TrainingOverview> {
    const definitions = await this.allDefinitions(this.db);
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    const seedCache = new Map<string, TrainingSeedEntityRef | null>();
    const attempts = await this.attemptsForUser(userId);
    const events = await this.eventsFor(
      this.db,
      attempts.filter((attempt) => attempt.supersededAt === null).map((attempt) => attempt.id),
    );
    const assignments = await this.assignmentViewsFor(userId, effective, {
      definitions: byId,
      attempts,
      events,
      seedCache,
    });
    const definitionViews: TrainingDefinitionProgressView[] = [];
    for (const definition of definitions) {
      if (!definition.active) continue;
      definitionViews.push(
        await this.definitionProgressView(definition, effective, seedCache, attempts, events),
      );
    }
    const activeAttempts = attempts
      .filter((attempt) => attempt.status === 'in_progress')
      .map((attempt) => {
        const definition = byId.get(attempt.definitionId);
        return definition === undefined
          ? null
          : this.attemptView(attempt, definition, events.get(attempt.id) ?? []);
      })
      .filter((view): view is TrainingAttemptView => view !== null);
    return {
      environment: this.deps.environment,
      exercisesAvailable: this.exercisesAvailable,
      assignments,
      definitions: definitionViews,
      activeAttempts,
    };
  }

  // ── Reset-Hook (Demo-Reset, Order §94) ───────────────────────────────────

  async interruptAllInProgress(
    tx: DatabaseExecutor,
    input: { code: string; now: Date },
  ): Promise<number> {
    return interruptInProgressAttempts(tx, { code: input.code, now: input.now });
  }

  // ── Admin (training.manage) ──────────────────────────────────────────────

  async listPaths(): Promise<{
    paths: TrainingCatalogPathView[];
    definitions: TrainingDefinitionView[];
  }> {
    const definitions = await this.allDefinitions(this.db);
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    const paths = await this.db.select().from(trainingPaths).orderBy(asc(trainingPaths.key));
    const items = await this.db
      .select()
      .from(trainingPathItems)
      .orderBy(asc(trainingPathItems.pathId), asc(trainingPathItems.sequence));
    const pathViews: TrainingCatalogPathView[] = paths
      .map((path) => ({
        key: path.key,
        title: path.title,
        description: path.description,
        active: path.active,
        items: items
          .filter((item) => item.pathId === path.id)
          .map((item) => {
            const definition = byId.get(item.definitionId);
            return definition === undefined
              ? null
              : {
                  sequence: item.sequence,
                  required: item.required,
                  definition: {
                    key: definition.key,
                    version: definition.version,
                    title: definition.title,
                    active: definition.active,
                    evaluatorKey: definition.evaluatorKey,
                  },
                };
          })
          .filter((item): item is NonNullable<typeof item> => item !== null),
      }))
      .sort(
        (a, b) => catalogPathOrder(this.catalog, a.key) - catalogPathOrder(this.catalog, b.key),
      );
    const seedCache = new Map<string, TrainingSeedEntityRef | null>();
    const definitionViews: TrainingDefinitionView[] = [];
    const none = new Set<PermissionKey>();
    for (const definition of definitions) {
      definitionViews.push(
        await this.definitionView(definition, none, seedCache, { skipPermission: true }),
      );
    }
    return { paths: pathViews, definitions: definitionViews };
  }

  async listOverview(): Promise<{ users: TrainingAdminUserOverview[] }> {
    // Alle nicht deaktivierten Mitarbeiter – auch ohne Zuweisung (Mitarbeiterauswahl der UI);
    // Phase 14 Final §9: deaktivierte Mitarbeiter bleiben mit ihrer Historie (Zuweisungen/Versuche)
    // lesend sichtbar – nichts wird gelöscht; ohne Historie werden sie nicht gelistet.
    const allUsers = await this.db
      .select({
        id: staffUsers.id,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
        status: staffUsers.status,
      })
      .from(staffUsers)
      .orderBy(asc(staffUsers.lastName), asc(staffUsers.firstName), asc(staffUsers.id));
    const definitions = await this.allDefinitions(this.db);
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    const paths = await this.db.select().from(trainingPaths);
    const pathById = new Map(paths.map((path) => [path.id, path]));
    const items = await this.db
      .select()
      .from(trainingPathItems)
      .orderBy(asc(trainingPathItems.sequence));
    const assignments = await this.db
      .select()
      .from(trainingAssignments)
      .orderBy(asc(trainingAssignments.assignedAt));
    const attempts = await this.db
      .select()
      .from(trainingAttempts)
      .where(isNull(trainingAttempts.supersededAt))
      .orderBy(asc(trainingAttempts.startedAt));
    const withHistory = new Set<string>([
      ...assignments.map((assignment) => assignment.userId),
      ...attempts.map((attempt) => attempt.userId),
    ]);
    const users = allUsers.filter(
      (user) => user.status !== TRAINING_INACTIVE_USER_STATUS || withHistory.has(user.id),
    );
    const result: TrainingAdminUserOverview[] = users.map((user) => {
      const own = attempts.filter((attempt) => attempt.userId === user.id);
      const assignmentViews: TrainingAdminAssignmentView[] = assignments
        .filter((assignment) => assignment.userId === user.id)
        .map((assignment) => {
          const path = pathById.get(assignment.pathId);
          return {
            pathKey: path?.key ?? '',
            pathTitle: path?.title ?? '',
            status: assignment.status,
            round: assignment.round,
            items: items
              .filter((item) => item.pathId === assignment.pathId)
              .map((item) => {
                const definition = byId.get(item.definitionId);
                if (definition === undefined) return null;
                const state = itemStateFor(own, definition.id);
                const last = latestAttemptFor(own, definition.id);
                return {
                  definitionKey: definition.key,
                  title: definition.title,
                  state: state.state,
                  lastAttempt:
                    last === null
                      ? null
                      : {
                          status: last.status,
                          failedCheckCount: last.failedCheckCount,
                          lastFailedCheckAt: iso(last.lastFailedCheckAt),
                          interruptionCode: last.interruptionCode,
                        },
                };
              })
              .filter((item): item is TrainingAdminItemView => item !== null),
          };
        });
      return {
        user,
        assignments: assignmentViews,
        interruptedAttempts: own.filter((attempt) => attempt.status === 'interrupted').length,
        failedChecks: own.reduce((sum, attempt) => sum + attempt.failedCheckCount, 0),
      };
    });
    return { users: result };
  }

  async userDetail(
    userId: string,
    effective: ReadonlySet<PermissionKey>,
  ): Promise<TrainingAdminUserDetail> {
    const user = await this.userById(userId);
    const definitions = await this.allDefinitions(this.db);
    const byId = new Map(definitions.map((definition) => [definition.id, definition]));
    const attempts = await this.attemptsForUser(userId);
    const events = await this.eventsFor(
      this.db,
      attempts.map((attempt) => attempt.id),
    );
    const seedCache = new Map<string, TrainingSeedEntityRef | null>();
    const assignments = await this.assignmentViewsFor(userId, effective, {
      definitions: byId,
      attempts,
      events,
      seedCache,
    });
    const attemptViews: TrainingAdminAttemptView[] = [...attempts]
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .map((attempt) => {
        const definition = byId.get(attempt.definitionId);
        if (definition === undefined) return null;
        const own = events.get(attempt.id) ?? [];
        return {
          ...this.attemptView(attempt, definition, own),
          definitionTitle: definition.title,
          definitionVersion: attempt.definitionVersion,
          assignmentRound: attempt.assignmentRound,
          supersededAt: iso(attempt.supersededAt),
          events: own.map(eventView),
        };
      })
      .filter((view): view is TrainingAdminAttemptView => view !== null);
    return { user, assignments, attempts: attemptViews };
  }

  async assign(
    adminId: string,
    input: { userId: string; pathKey: string; dueAt?: Date | null | undefined },
    options: { sessionId?: string | null | undefined; now?: Date | undefined } = {},
  ): Promise<TrainingAssignmentView> {
    const now = options.now ?? this.now();
    const user = await this.userById(input.userId);
    // Phase 14 Final §9: keine neue Zuweisung an einen deaktivierten Mitarbeiter (409);
    // bestehende Zuweisungen/Versuche bleiben Historie und lesbar.
    if (user.status === TRAINING_INACTIVE_USER_STATUS) {
      throw new TrainingError(
        'CONFLICT',
        TRAINING_ERROR_CODES.USER_INACTIVE,
        TRAINING_MESSAGES.USER_INACTIVE,
        { userId: user.id },
      );
    }
    const path = await this.pathByKey(input.pathKey);
    if (!path.active) {
      throw new TrainingError(
        'CONFLICT',
        TRAINING_ERROR_CODES.PATH_INACTIVE,
        TRAINING_MESSAGES.PATH_INACTIVE,
        { pathKey: input.pathKey },
      );
    }
    const inserted = await this.db
      .insert(trainingAssignments)
      .values({
        userId: user.id,
        pathId: path.id,
        assignedBy: adminId,
        assignedAt: now,
        dueAt: input.dueAt ?? null,
        status: 'assigned',
        round: 1,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [trainingAssignments.userId, trainingAssignments.pathId] })
      .returning();
    const assignment = inserted[0];
    if (assignment === undefined) {
      throw new TrainingError(
        'CONFLICT',
        TRAINING_ERROR_CODES.ASSIGNMENT_EXISTS,
        TRAINING_MESSAGES.ASSIGNMENT_EXISTS,
        { pathKey: input.pathKey },
      );
    }
    // Bereits bestandene Übungen zählen sofort (bestanden bleibt bestanden, §46).
    await refreshAssignmentProgress(this.db, assignment.id, now);
    await recordSecurityEvent(this.db, {
      type: 'training.assignment_created',
      actorUserId: adminId,
      targetUserId: user.id,
      sessionId: options.sessionId ?? null,
      details: {
        assignmentId: assignment.id,
        pathKey: path.key,
        dueAt: iso(input.dueAt ?? null),
      },
    });
    const views = await this.assignmentViewsFor(user.id, new Set<PermissionKey>(), undefined, {
      skipPermission: true,
    });
    const view = views.find((candidate) => candidate.id === assignment.id);
    if (view === undefined)
      throw new TrainingError(
        'NOT_FOUND',
        'TRAINING_ASSIGNMENT_NOT_FOUND',
        'Zuweisung nicht gefunden.',
      );
    return view;
  }

  async resetProgress(
    adminId: string,
    input: {
      userId: string;
      pathKey?: string | null | undefined;
      definitionKey?: string | null | undefined;
    },
    options: { sessionId?: string | null | undefined; now?: Date | undefined } = {},
  ): Promise<TrainingResetResult> {
    const now = options.now ?? this.now();
    const pathKey = input.pathKey ?? null;
    const definitionKey = input.definitionKey ?? null;
    if (pathKey !== null && definitionKey !== null) {
      throw new TrainingError(
        'VALIDATION',
        'TRAINING_RESET_SCOPE_INVALID',
        TRAINING_MESSAGES.RESET_SCOPE_INVALID,
      );
    }
    const user = await this.userById(input.userId);
    let definitionIds: string[] | null = null;
    let assignmentPathIds: string[] | null = null;
    if (definitionKey !== null) {
      const definition = await this.definitionByKey(this.db, definitionKey);
      if (definition === null) {
        throw new TrainingError(
          'NOT_FOUND',
          'TRAINING_DEFINITION_NOT_FOUND',
          TRAINING_MESSAGES.DEFINITION_NOT_FOUND,
        );
      }
      definitionIds = [definition.id];
      const containing = await this.db
        .select({ pathId: trainingPathItems.pathId })
        .from(trainingPathItems)
        .where(eq(trainingPathItems.definitionId, definition.id));
      assignmentPathIds = containing.map((row) => row.pathId);
    } else if (pathKey !== null) {
      const path = await this.pathByKey(pathKey);
      const items = await this.db
        .select({ definitionId: trainingPathItems.definitionId })
        .from(trainingPathItems)
        .where(eq(trainingPathItems.pathId, path.id));
      definitionIds = items.map((row) => row.definitionId);
      assignmentPathIds = [path.id];
    }
    const scope = definitionIds;
    const pathScope = assignmentPathIds;
    const result = await this.db.transaction(async (tx) => {
      const interruptedAttempts = await interruptInProgressAttempts(tx, {
        code: TRAINING_RESET_INTERRUPTION_CODE,
        now,
        userId: user.id,
        ...(scope === null ? {} : { definitionIds: scope }),
      });
      let supersededAttempts = 0;
      if (scope === null || scope.length > 0) {
        const supersedeConditions = [
          eq(trainingAttempts.userId, user.id),
          eq(trainingAttempts.status, 'passed'),
          isNull(trainingAttempts.supersededAt),
        ];
        if (scope !== null) supersedeConditions.push(inArray(trainingAttempts.definitionId, scope));
        const superseded = await tx
          .update(trainingAttempts)
          .set({ supersededAt: now, supersededBy: adminId, updatedAt: now })
          .where(and(...supersedeConditions))
          .returning({ id: trainingAttempts.id });
        supersededAttempts = superseded.length;
      }
      let resetAssignments = 0;
      if (pathScope === null || pathScope.length > 0) {
        const assignmentConditions = [eq(trainingAssignments.userId, user.id)];
        if (pathScope !== null)
          assignmentConditions.push(inArray(trainingAssignments.pathId, pathScope));
        const reset = await tx
          .update(trainingAssignments)
          .set({
            round: sql`${trainingAssignments.round} + 1`,
            status: 'assigned',
            completedAt: null,
            lastResetAt: now,
            lastResetBy: adminId,
            updatedAt: now,
          })
          .where(and(...assignmentConditions))
          .returning({ id: trainingAssignments.id });
        resetAssignments = reset.length;
        // Teil-Reset (einzelne Übung): übrige bestandene Übungen des Pfads bleiben sichtbar.
        for (const row of reset) await refreshAssignmentProgress(tx, row.id, now);
      }
      await recordSecurityEvent(tx, {
        type: 'training.assignment_reset',
        actorUserId: adminId,
        targetUserId: user.id,
        sessionId: options.sessionId ?? null,
        details: {
          scope: definitionKey !== null ? 'definition' : pathKey !== null ? 'path' : 'user',
          pathKey,
          definitionKey,
          interruptedAttempts,
          supersededAttempts,
          resetAssignments,
        },
      });
      return { interruptedAttempts, supersededAttempts, resetAssignments };
    });
    return result;
  }

  // ── Intern ────────────────────────────────────────────────────────────────

  private specFor(definition: TrainingDefinition): EvaluatorSpec {
    const spec = evaluatorFor(definition.evaluatorKey);
    if (spec === null) {
      throw new TrainingError(
        'CONFLICT',
        'TRAINING_CONFIGURATION_INVALID',
        'Diese Übung ist fehlerhaft konfiguriert.',
        { definitionKey: definition.key },
      );
    }
    return spec;
  }

  private async allDefinitions(executor: DatabaseExecutor): Promise<TrainingDefinition[]> {
    const rows = await executor.select().from(trainingDefinitions);
    return rows.sort((a, b) => {
      const order = definitionOrderIndex(a.key) - definitionOrderIndex(b.key);
      return order !== 0 ? order : a.key.localeCompare(b.key);
    });
  }

  private async definitionByKey(
    executor: DatabaseExecutor,
    key: string,
  ): Promise<TrainingDefinition | null> {
    const rows = await executor
      .select()
      .from(trainingDefinitions)
      .where(eq(trainingDefinitions.key, key));
    return rows[0] ?? null;
  }

  private async definitionById(
    executor: DatabaseExecutor,
    id: string,
  ): Promise<TrainingDefinition> {
    const rows = await executor
      .select()
      .from(trainingDefinitions)
      .where(eq(trainingDefinitions.id, id));
    const definition = rows[0];
    if (definition === undefined) {
      throw new TrainingError(
        'NOT_FOUND',
        'TRAINING_DEFINITION_NOT_FOUND',
        TRAINING_MESSAGES.DEFINITION_NOT_FOUND,
      );
    }
    return definition;
  }

  private async pathByKey(key: string): Promise<TrainingPath> {
    const rows = await this.db.select().from(trainingPaths).where(eq(trainingPaths.key, key));
    const path = rows[0];
    if (path === undefined) {
      throw new TrainingError(
        'NOT_FOUND',
        'TRAINING_PATH_NOT_FOUND',
        TRAINING_MESSAGES.PATH_NOT_FOUND,
      );
    }
    return path;
  }

  private async userById(userId: string): Promise<TrainingUserRef> {
    const rows = await this.db
      .select({
        id: staffUsers.id,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
        status: staffUsers.status,
      })
      .from(staffUsers)
      .where(eq(staffUsers.id, userId));
    const user = rows[0];
    if (user === undefined) {
      throw new TrainingError(
        'NOT_FOUND',
        'TRAINING_USER_NOT_FOUND',
        TRAINING_MESSAGES.USER_NOT_FOUND,
      );
    }
    return user;
  }

  private async attemptById(executor: DatabaseExecutor, id: string): Promise<TrainingAttempt> {
    const rows = await executor.select().from(trainingAttempts).where(eq(trainingAttempts.id, id));
    const attempt = rows[0];
    if (attempt === undefined) {
      throw new TrainingError(
        'NOT_FOUND',
        'TRAINING_ATTEMPT_NOT_FOUND',
        TRAINING_MESSAGES.ATTEMPT_NOT_FOUND,
      );
    }
    return attempt;
  }

  private async activeAttempt(
    userId: string,
    definitionId: string,
  ): Promise<TrainingAttempt | null> {
    const rows = await this.db
      .select()
      .from(trainingAttempts)
      .where(
        and(
          eq(trainingAttempts.userId, userId),
          eq(trainingAttempts.definitionId, definitionId),
          eq(trainingAttempts.status, 'in_progress'),
        ),
      );
    return rows[0] ?? null;
  }

  /** Zuweisung des Mitarbeiters, deren Pfad diese Übung enthält (älteste zuerst). */
  private async assignmentForDefinition(
    userId: string,
    definitionId: string,
  ): Promise<TrainingAssignment | null> {
    const rows = await this.db
      .select({ assignment: trainingAssignments })
      .from(trainingAssignments)
      .innerJoin(trainingPathItems, eq(trainingPathItems.pathId, trainingAssignments.pathId))
      .where(
        and(
          eq(trainingAssignments.userId, userId),
          eq(trainingPathItems.definitionId, definitionId),
        ),
      )
      .orderBy(asc(trainingAssignments.assignedAt));
    return rows[0]?.assignment ?? null;
  }

  private async attemptsForUser(userId: string): Promise<TrainingAttempt[]> {
    return this.db
      .select()
      .from(trainingAttempts)
      .where(eq(trainingAttempts.userId, userId))
      .orderBy(asc(trainingAttempts.startedAt), asc(trainingAttempts.id));
  }

  private async eventsFor(
    executor: DatabaseExecutor,
    attemptIds: readonly string[],
  ): Promise<Map<string, TrainingAttemptEvent[]>> {
    const result = new Map<string, TrainingAttemptEvent[]>();
    if (attemptIds.length === 0) return result;
    const rows = await executor
      .select()
      .from(trainingAttemptEvents)
      .where(inArray(trainingAttemptEvents.attemptId, [...attemptIds]))
      .orderBy(asc(trainingAttemptEvents.occurredAt), asc(trainingAttemptEvents.id));
    for (const row of rows) {
      const list = result.get(row.attemptId);
      if (list === undefined) result.set(row.attemptId, [row]);
      else list.push(row);
    }
    return result;
  }

  private async attemptViewOf(
    attempt: TrainingAttempt,
    definition: TrainingDefinition,
    executor: DatabaseExecutor = this.db,
  ): Promise<TrainingAttemptView> {
    const events = await this.eventsFor(executor, [attempt.id]);
    return this.attemptView(attempt, definition, events.get(attempt.id) ?? []);
  }

  private attemptView(
    attempt: TrainingAttempt,
    definition: TrainingDefinition,
    events: readonly TrainingAttemptEvent[],
  ): TrainingAttemptView {
    const spec = evaluatorFor(definition.evaluatorKey);
    const accepted: AcceptedEvent[] = [];
    for (const event of events) {
      if (event.result !== 'accepted' || event.stepKey === null) continue;
      accepted.push({ stepKey: event.stepKey, subjectRef: event.subjectRef });
    }
    const steps = spec === null ? [] : stepsView(spec, accepted);
    const open = spec === null || attempt.status === 'passed' ? null : openStep(spec, accepted);
    return {
      id: attempt.id,
      definitionKey: definition.key,
      status: attempt.status,
      startedAt: attempt.startedAt.toISOString(),
      completedAt: iso(attempt.completedAt),
      interruptedAt: iso(attempt.interruptedAt),
      interruptionCode: attempt.interruptionCode,
      failedCheckCount: attempt.failedCheckCount,
      lastFailedCheckAt: iso(attempt.lastFailedCheckAt),
      steps: attempt.status === 'passed' ? steps.map((step) => ({ ...step, done: true })) : steps,
      openStep: open === null ? null : { key: open.key, title: open.title },
      assignmentId: attempt.assignmentId,
    };
  }

  private async definitionView(
    definition: TrainingDefinition,
    effective: ReadonlySet<PermissionKey>,
    seedCache: Map<string, TrainingSeedEntityRef | null>,
    options: { skipPermission?: boolean } = {},
  ): Promise<TrainingDefinitionView> {
    const spec = this.catalog.definitions.find((candidate) => candidate.key === definition.key);
    const evaluator = evaluatorFor(definition.evaluatorKey);
    let seedEntity: TrainingSeedEntityRef | null = null;
    if (definition.seedKey !== null && this.deps.seedEntities !== undefined) {
      const cached = seedCache.get(definition.seedKey);
      if (cached !== undefined) seedEntity = cached;
      else {
        // Nur Typ + ID des Fachobjekts (§72) – keine weiteren Registry-Felder nach außen.
        const resolved = await this.deps.seedEntities(definition.seedKey);
        seedEntity =
          resolved === null
            ? null
            : { entityType: resolved.entityType, entityId: resolved.entityId };
        seedCache.set(definition.seedKey, seedEntity);
      }
    }
    return {
      key: definition.key,
      version: definition.version,
      title: definition.title,
      objective: definition.objective,
      instructions: definition.instructions,
      active: definition.active,
      demoPath: definition.demoPath,
      seedKey: definition.seedKey,
      seedEntity,
      steps:
        evaluator === null
          ? []
          : evaluator.steps.map((step) => ({ key: step.key, title: step.title })),
      permissionMissing:
        options.skipPermission === true || spec === undefined
          ? false
          : !hasRequiredPermissions(spec.requiredPermissions, effective),
    };
  }

  private async definitionProgressView(
    definition: TrainingDefinition,
    effective: ReadonlySet<PermissionKey>,
    seedCache: Map<string, TrainingSeedEntityRef | null>,
    attempts: readonly TrainingAttempt[],
    events: Map<string, TrainingAttemptEvent[]>,
  ): Promise<TrainingDefinitionProgressView> {
    const state = itemStateFor(attempts, definition.id);
    return {
      ...(await this.definitionView(definition, effective, seedCache)),
      state: state.state,
      passedAt: iso(state.passedAt),
      attempt:
        state.attempt === null
          ? null
          : this.attemptView(state.attempt, definition, events.get(state.attempt.id) ?? []),
    };
  }

  private async assignmentViewsFor(
    userId: string,
    effective: ReadonlySet<PermissionKey>,
    preloaded?:
      | {
          definitions: Map<string, TrainingDefinition>;
          attempts: TrainingAttempt[];
          events: Map<string, TrainingAttemptEvent[]>;
          seedCache: Map<string, TrainingSeedEntityRef | null>;
        }
      | undefined,
    options: { skipPermission?: boolean } = {},
  ): Promise<TrainingAssignmentView[]> {
    const definitions =
      preloaded?.definitions ??
      new Map(
        (await this.allDefinitions(this.db)).map((definition) => [definition.id, definition]),
      );
    const attempts = preloaded?.attempts ?? (await this.attemptsForUser(userId));
    const events =
      preloaded?.events ??
      (await this.eventsFor(
        this.db,
        attempts.filter((attempt) => attempt.supersededAt === null).map((attempt) => attempt.id),
      ));
    const seedCache = preloaded?.seedCache ?? new Map<string, TrainingSeedEntityRef | null>();
    const rows = await this.db
      .select({ assignment: trainingAssignments, path: trainingPaths })
      .from(trainingAssignments)
      .innerJoin(trainingPaths, eq(trainingPaths.id, trainingAssignments.pathId))
      .where(eq(trainingAssignments.userId, userId))
      .orderBy(asc(trainingAssignments.assignedAt), asc(trainingAssignments.id));
    const views: TrainingAssignmentView[] = [];
    for (const row of rows) {
      const items = await this.db
        .select()
        .from(trainingPathItems)
        .where(eq(trainingPathItems.pathId, row.path.id))
        .orderBy(asc(trainingPathItems.sequence));
      const itemViews: TrainingAssignmentItemView[] = [];
      for (const item of items) {
        const definition = definitions.get(item.definitionId);
        if (definition === undefined) continue;
        const state = itemStateFor(attempts, definition.id);
        itemViews.push({
          sequence: item.sequence,
          required: item.required,
          definition: await this.definitionView(definition, effective, seedCache, options),
          state: state.state,
          passedAt: iso(state.passedAt),
          attempt:
            state.attempt === null
              ? null
              : this.attemptView(state.attempt, definition, events.get(state.attempt.id) ?? []),
        });
      }
      views.push({
        id: row.assignment.id,
        path: { key: row.path.key, title: row.path.title, description: row.path.description },
        status: row.assignment.status,
        assignedAt: row.assignment.assignedAt.toISOString(),
        dueAt: iso(row.assignment.dueAt),
        completedAt: iso(row.assignment.completedAt),
        round: row.assignment.round,
        items: itemViews,
      });
    }
    return views;
  }
}

function catalogPathOrder(catalog: TrainingCatalog, key: string): number {
  const index = catalog.paths.findIndex((path) => path.key === key);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * Zustand einer Übung für einen Mitarbeiter: `passed` (nicht supersedierter
 * bestandener Versuch) > `in_progress` > `open`; `attempt` = laufender Versuch,
 * sonst der jüngste nicht supersedierte Versuch (z. B. „unterbrochen“ für den Hinweis in der UI).
 */
function itemStateFor(
  attempts: readonly TrainingAttempt[],
  definitionId: string,
): { state: TrainingItemState; passedAt: Date | null; attempt: TrainingAttempt | null } {
  const own = attempts.filter(
    (attempt) => attempt.definitionId === definitionId && attempt.supersededAt === null,
  );
  const inProgress = own.find((attempt) => attempt.status === 'in_progress') ?? null;
  const passed = own
    .filter((attempt) => attempt.status === 'passed')
    .sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))[0];
  if (passed !== undefined) {
    return { state: 'passed', passedAt: passed.completedAt, attempt: inProgress ?? passed };
  }
  if (inProgress !== null) return { state: 'in_progress', passedAt: null, attempt: inProgress };
  const latest = own[own.length - 1] ?? null;
  return { state: 'open', passedAt: null, attempt: latest };
}

function latestAttemptFor(
  attempts: readonly TrainingAttempt[],
  definitionId: string,
): TrainingAttempt | null {
  const own = attempts.filter((attempt) => attempt.definitionId === definitionId);
  return own[own.length - 1] ?? null;
}

function eventView(event: TrainingAttemptEvent): TrainingAttemptEventView {
  return {
    eventKey: event.eventKey,
    stepKey: event.stepKey,
    result: event.result,
    errorCode: event.errorCode,
    occurredAt: event.occurredAt.toISOString(),
  };
}
