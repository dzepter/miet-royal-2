import type { AppConfig } from '@mietroyal/config';
import {
  staffTrainingClearances,
  staffUsers,
  trainingDefinitions,
  trainingFeatureRequirements,
  type Database,
  type DatabaseExecutor,
  type StaffTrainingClearance,
} from '@mietroyal/database';
import { and, asc, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { recordSecurityEvent } from '../auth/audit.ts';
import { AuthError, type AuthErrorCode } from '../auth/service.ts';
import { TRAINING_FEATURES, isTrainingFeatureKey, type TrainingFeatureKey } from './features.ts';

/**
 * Phase 14 (Order §58, §59, §61, §62, §71, §84; Design §4.4): Verwaltung der
 * Live-Sperren und Freigaben – ausschließlich außerhalb der Demo (die Routen
 * werden in demo nicht registriert, §68). Production erfährt NIE automatisch
 * von Demo-Ergebnissen (W2): ein Admin mit `training.manage` bestätigt
 * bewusst „Demo-Training bestätigt“ (`verified_demo`) oder vergibt einen
 * `override` (Begründung Pflicht, optional befristet). Gespeichert werden nur
 * user_id, definition_key, source, reason, valid_from/valid_until,
 * granted_by/granted_at, revoked_at/revoked_by – keine Demo-Businessdaten.
 * Audit-Details enthalten nur IDs/Keys/Zeitstempel, nie den Begründungstext.
 */

/** Admin-Fehler mit stabilem Code (z. B. 409 TRAINING_DEFINITION_INACTIVE). */
export class TrainingGateAdminError extends AuthError {
  constructor(
    code: AuthErrorCode,
    readonly trainingCode: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code, message);
    this.name = 'TrainingGateAdminError';
  }
}

export const TRAINING_GATE_ADMIN_MESSAGES = {
  OVERRIDE_REASON_REQUIRED: 'Für einen Override ist eine Begründung erforderlich.',
  DEFINITION_INACTIVE:
    'Diese Übung ist nicht aktiv – eine Sperre kann nur auf eine aktive Übung zeigen.',
  DEFINITION_NOT_FOUND: 'Übung nicht gefunden.',
  FEATURE_NOT_FOUND: 'Funktion nicht gefunden.',
  USER_NOT_FOUND: 'Mitarbeiter nicht gefunden.',
  CLEARANCE_NOT_FOUND: 'Freigabe nicht gefunden.',
  VALID_UNTIL_IN_PAST: 'Das Ablaufdatum muss in der Zukunft liegen.',
} as const;

export interface GateDefinitionRef {
  key: string;
  title: string;
  active: boolean;
}

export interface GateFeatureView {
  featureKey: TrainingFeatureKey;
  title: string;
  description: string;
  requirement: {
    definitionKey: string;
    enabled: boolean;
    configuredAt: Date;
    configuredBy: string | null;
  } | null;
  definition: GateDefinitionRef | null;
}

export interface GateOverview {
  environment: AppConfig['appEnv'];
  /** Sperren werden nur in production erzwungen (§63) – sonst reine Konfiguration. */
  enforced: boolean;
  features: GateFeatureView[];
  definitions: GateDefinitionRef[];
}

export interface ClearanceView {
  id: string;
  userId: string;
  user: { firstName: string; lastName: string } | null;
  definitionKey: string;
  definitionTitle: string | null;
  source: 'verified_demo' | 'override';
  reason: string | null;
  validFrom: Date;
  validUntil: Date | null;
  grantedBy: string | null;
  grantedAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  /** Gültig zum Abfragezeitpunkt (nicht widerrufen, begonnen, nicht abgelaufen). */
  active: boolean;
}

export interface GrantClearanceInput {
  userId: string;
  definitionKey: string;
  source: 'verified_demo' | 'override';
  reason?: string | null | undefined;
  validUntil?: Date | null | undefined;
}

function clearanceActive(row: StaffTrainingClearance, now: Date): boolean {
  return (
    row.revokedAt === null &&
    row.validFrom.getTime() <= now.getTime() &&
    (row.validUntil === null || row.validUntil.getTime() > now.getTime())
  );
}

export class TrainingGateAdminService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  // ── Live-Sperren (§61, §71, §97) ─────────────────────────────────────────

  async listGates(): Promise<GateOverview> {
    const [requirements, definitions] = await Promise.all([
      this.db.select().from(trainingFeatureRequirements),
      this.db
        .select({
          key: trainingDefinitions.key,
          title: trainingDefinitions.title,
          active: trainingDefinitions.active,
        })
        .from(trainingDefinitions)
        .orderBy(asc(trainingDefinitions.createdAt), asc(trainingDefinitions.key)),
    ]);
    const requirementByKey = new Map(requirements.map((row) => [row.featureKey, row]));
    const definitionByKey = new Map(definitions.map((row) => [row.key, row]));
    return {
      environment: this.config.appEnv,
      enforced: this.config.appEnv === 'production',
      features: TRAINING_FEATURES.map((feature) => {
        const requirement = requirementByKey.get(feature.key) ?? null;
        return {
          featureKey: feature.key,
          title: feature.title,
          description: feature.description,
          requirement:
            requirement === null
              ? null
              : {
                  definitionKey: requirement.definitionKey,
                  enabled: requirement.enabled,
                  configuredAt: requirement.configuredAt,
                  configuredBy: requirement.configuredBy,
                },
          definition:
            requirement === null ? null : (definitionByKey.get(requirement.definitionKey) ?? null),
        };
      }),
      definitions,
    };
  }

  /**
   * Sperre setzen (Upsert je Feature). Aktivieren verlangt eine aktive Übung
   * (§71/§97 ⇒ 409 TRAINING_DEFINITION_INACTIVE); Deaktivieren ist auch mit
   * inzwischen inaktiver Übung möglich (Admin-Recovery, §98). Audit
   * `training.gate_enabled`/`gate_disabled` nur bei Wechsel des wirksamen
   * Zustands (aktiv + Übung).
   */
  async setGate(
    actorId: string,
    featureKey: string,
    input: { definitionKey: string; enabled: boolean },
    now = new Date(),
  ): Promise<GateFeatureView> {
    if (!isTrainingFeatureKey(featureKey)) {
      throw new AuthError('NOT_FOUND', TRAINING_GATE_ADMIN_MESSAGES.FEATURE_NOT_FOUND);
    }
    const key: TrainingFeatureKey = featureKey;
    await this.db.transaction(async (tx) => {
      const definition = await definitionByKey(tx, input.definitionKey);
      if (definition === null) {
        throw new AuthError('NOT_FOUND', TRAINING_GATE_ADMIN_MESSAGES.DEFINITION_NOT_FOUND);
      }
      if (input.enabled && !definition.active) {
        throw new TrainingGateAdminError(
          'CONFLICT',
          'TRAINING_DEFINITION_INACTIVE',
          TRAINING_GATE_ADMIN_MESSAGES.DEFINITION_INACTIVE,
          { featureKey: key, definitionKey: definition.key },
        );
      }
      const [existing] = await tx
        .select()
        .from(trainingFeatureRequirements)
        .where(eq(trainingFeatureRequirements.featureKey, key))
        .for('update');
      await tx
        .insert(trainingFeatureRequirements)
        .values({
          featureKey: key,
          definitionKey: definition.key,
          enabled: input.enabled,
          configuredBy: actorId,
          configuredAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: trainingFeatureRequirements.featureKey,
          set: {
            definitionKey: definition.key,
            enabled: input.enabled,
            configuredBy: actorId,
            configuredAt: now,
            updatedAt: now,
          },
        });
      const previousState =
        existing === undefined || !existing.enabled ? null : existing.definitionKey;
      const nextState = input.enabled ? definition.key : null;
      if (previousState === nextState) return;
      await recordSecurityEvent(tx, {
        type: nextState === null ? 'training.gate_disabled' : 'training.gate_enabled',
        actorUserId: actorId,
        details: {
          featureKey: key,
          definitionKey: definition.key,
          previousDefinitionKey: existing?.definitionKey ?? null,
          previousEnabled: existing?.enabled ?? false,
        },
      });
    });
    const overview = await this.listGates();
    const feature = overview.features.find((entry) => entry.featureKey === key);
    if (feature === undefined) {
      throw new AuthError('NOT_FOUND', TRAINING_GATE_ADMIN_MESSAGES.FEATURE_NOT_FOUND);
    }
    return feature;
  }

  // ── Freigaben (§58, §59, §62, §84) ───────────────────────────────────────

  async listClearances(userId: string | undefined, now = new Date()): Promise<ClearanceView[]> {
    const rows = await this.db
      .select()
      .from(staffTrainingClearances)
      .where(userId === undefined ? undefined : eq(staffTrainingClearances.userId, userId))
      .orderBy(desc(staffTrainingClearances.grantedAt), desc(staffTrainingClearances.id));
    return this.toViews(rows, now);
  }

  /**
   * Freigabe anlegen. `override` ohne Begründung ⇒ 400 VALIDATION (§59);
   * unbekannte Übung/Mitarbeiter ⇒ 404. Idempotent gegen Doppelklick: eine
   * bereits gültige Freigabe gleicher Quelle für Mitarbeiter + Übung wird
   * zurückgegeben (`created: false`) statt dupliziert – sonst könnte ein
   * Widerruf einer von zwei gleichen Zeilen die Sperre unbemerkt offen lassen.
   */
  async grantClearance(
    actorId: string,
    input: GrantClearanceInput,
    now = new Date(),
  ): Promise<{ clearance: ClearanceView; created: boolean }> {
    const reason = input.reason === undefined || input.reason === null ? null : input.reason.trim();
    if (input.source === 'override' && (reason === null || reason.length === 0)) {
      throw new AuthError('VALIDATION', TRAINING_GATE_ADMIN_MESSAGES.OVERRIDE_REASON_REQUIRED);
    }
    const validUntil = input.validUntil ?? null;
    if (validUntil !== null && validUntil.getTime() <= now.getTime()) {
      throw new AuthError('VALIDATION', TRAINING_GATE_ADMIN_MESSAGES.VALID_UNTIL_IN_PAST);
    }
    const result = await this.db.transaction(async (tx) => {
      const definition = await definitionByKey(tx, input.definitionKey);
      if (definition === null) {
        throw new AuthError('NOT_FOUND', TRAINING_GATE_ADMIN_MESSAGES.DEFINITION_NOT_FOUND);
      }
      const [user] = await tx
        .select({ id: staffUsers.id })
        .from(staffUsers)
        .where(eq(staffUsers.id, input.userId))
        .limit(1);
      if (user === undefined) {
        throw new AuthError('NOT_FOUND', TRAINING_GATE_ADMIN_MESSAGES.USER_NOT_FOUND);
      }
      // Serialisierung je Mitarbeiter + Übung (Doppelklick, zwei Admins gleichzeitig).
      const existing = await tx
        .select()
        .from(staffTrainingClearances)
        .where(
          and(
            eq(staffTrainingClearances.userId, input.userId),
            eq(staffTrainingClearances.definitionKey, definition.key),
            eq(staffTrainingClearances.source, input.source),
            isNull(staffTrainingClearances.revokedAt),
            lte(staffTrainingClearances.validFrom, now),
            or(
              isNull(staffTrainingClearances.validUntil),
              gt(staffTrainingClearances.validUntil, now),
            ),
          ),
        )
        .orderBy(desc(staffTrainingClearances.grantedAt))
        .for('update');
      const current = existing.find((row) => clearanceActive(row, now));
      if (current !== undefined) return { row: current, created: false };
      const [inserted] = await tx
        .insert(staffTrainingClearances)
        .values({
          userId: input.userId,
          definitionKey: definition.key,
          source: input.source,
          reason,
          validFrom: now,
          validUntil,
          grantedBy: actorId,
          grantedAt: now,
        })
        .returning();
      if (inserted === undefined) throw new Error('Freigabe konnte nicht angelegt werden.');
      await recordSecurityEvent(tx, {
        type:
          input.source === 'verified_demo' ? 'training.demo_verified' : 'training.override_granted',
        actorUserId: actorId,
        targetUserId: input.userId,
        details: {
          clearanceId: inserted.id,
          definitionKey: definition.key,
          source: input.source,
          validUntil: validUntil === null ? null : validUntil.toISOString(),
        },
      });
      return { row: inserted, created: true };
    });
    const [clearance] = await this.toViews([result.row], now);
    if (clearance === undefined) throw new Error('Freigabe konnte nicht gelesen werden.');
    return { clearance, created: result.created };
  }

  /** Widerruf – idempotent (bereits widerrufen ⇒ unverändert, kein zweites Audit); wirkt sofort (§65). */
  async revokeClearance(
    actorId: string,
    clearanceId: string,
    now = new Date(),
  ): Promise<{ clearance: ClearanceView; revoked: boolean }> {
    const result = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(staffTrainingClearances)
        .where(eq(staffTrainingClearances.id, clearanceId))
        .for('update');
      if (existing === undefined) {
        throw new AuthError('NOT_FOUND', TRAINING_GATE_ADMIN_MESSAGES.CLEARANCE_NOT_FOUND);
      }
      if (existing.revokedAt !== null) return { row: existing, revoked: false };
      const [updated] = await tx
        .update(staffTrainingClearances)
        .set({ revokedAt: now, revokedBy: actorId })
        .where(eq(staffTrainingClearances.id, clearanceId))
        .returning();
      if (updated === undefined) throw new Error('Freigabe konnte nicht widerrufen werden.');
      await recordSecurityEvent(tx, {
        type:
          existing.source === 'verified_demo'
            ? 'training.demo_verification_revoked'
            : 'training.override_revoked',
        actorUserId: actorId,
        targetUserId: existing.userId,
        details: {
          clearanceId: existing.id,
          definitionKey: existing.definitionKey,
          source: existing.source,
          revokedAt: now.toISOString(),
        },
      });
      return { row: updated, revoked: true };
    });
    const [clearance] = await this.toViews([result.row], now);
    if (clearance === undefined) throw new Error('Freigabe konnte nicht gelesen werden.');
    return { clearance, revoked: result.revoked };
  }

  private async toViews(rows: StaffTrainingClearance[], now: Date): Promise<ClearanceView[]> {
    if (rows.length === 0) return [];
    const userIds = [...new Set(rows.map((row) => row.userId))];
    const definitionKeys = [...new Set(rows.map((row) => row.definitionKey))];
    const [users, definitions] = await Promise.all([
      this.db
        .select({
          id: staffUsers.id,
          firstName: staffUsers.firstName,
          lastName: staffUsers.lastName,
        })
        .from(staffUsers)
        .where(inArray(staffUsers.id, userIds)),
      this.db
        .select({ key: trainingDefinitions.key, title: trainingDefinitions.title })
        .from(trainingDefinitions)
        .where(inArray(trainingDefinitions.key, definitionKeys)),
    ]);
    const userById = new Map(users.map((user) => [user.id, user]));
    const titleByKey = new Map(definitions.map((definition) => [definition.key, definition.title]));
    return rows.map((row) => {
      const user = userById.get(row.userId);
      return {
        id: row.id,
        userId: row.userId,
        user: user === undefined ? null : { firstName: user.firstName, lastName: user.lastName },
        definitionKey: row.definitionKey,
        definitionTitle: titleByKey.get(row.definitionKey) ?? null,
        source: row.source,
        reason: row.reason,
        validFrom: row.validFrom,
        validUntil: row.validUntil,
        grantedBy: row.grantedBy,
        grantedAt: row.grantedAt,
        revokedAt: row.revokedAt,
        revokedBy: row.revokedBy,
        active: clearanceActive(row, now),
      };
    });
  }
}

async function definitionByKey(
  db: DatabaseExecutor,
  key: string,
): Promise<GateDefinitionRef | null> {
  const [row] = await db
    .select({
      key: trainingDefinitions.key,
      title: trainingDefinitions.title,
      active: trainingDefinitions.active,
    })
    .from(trainingDefinitions)
    .where(eq(trainingDefinitions.key, key))
    .limit(1);
  return row ?? null;
}
