import type { AppConfig } from '@mietroyal/config';
import {
  staffTrainingClearances,
  trainingDefinitions,
  trainingFeatureRequirements,
  type Database,
  type StaffTrainingClearance,
} from '@mietroyal/database';
import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import type { TrainingCatalogSource } from './catalog-sync.ts';
import { TRAINING_FEATURE_KEYS, trainingFeatureSpec, type TrainingFeatureKey } from './features.ts';

/**
 * Phase 14 (Order §56–§66, §97; Design §4.5): zentrale Grenze für Live-
 * Trainingssperren. Ein Gate ist eine ZUSÄTZLICHE Bedingung zur normalen
 * Permission – die Rechteprüfung bleibt vollständig maßgeblich und läuft
 * vorher (§55/§64). Erzwungen wird ausschließlich in `APP_ENV=production`
 * (§63); demo/development/staging kennen Sperren nur als Konfiguration.
 *
 * Sicherheitsregeln (§65): jede Prüfung liest frisch aus der Datenbank (kein
 * Cache, nichts im Session-Cookie), ein Widerruf wirkt sofort; es gibt keinen
 * Systemadmin-Bypass (§59 – ein Systemadmin gibt sich bewusst einen Override
 * über denselben auditierten Weg). Inkonsistente Konfiguration (aktive Sperre
 * mit fehlender/inaktiver Übung) blockiert die Fachaktion fail-closed (§97).
 */

export type TrainingGateCode = 'TRAINING_REQUIRED' | 'TRAINING_CONFIGURATION_INVALID';

/** Gate-Verstoß: HTTP 403 mit eigenem Code und verständlichem Text (§66). */
export class TrainingGateError extends AuthError {
  constructor(
    readonly trainingCode: TrainingGateCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super('FORBIDDEN', message);
    this.name = 'TrainingGateError';
  }
}

/**
 * Phase 14 Final §13: der Katalog ist fail-soft beim Start, das production-Gate aber nie fail-open –
 * scheitert der nachgeholte Katalog-Sync in der Gate-Auswertung, wird die Fachaktion blockiert
 * (HTTP 503 `TRAINING_CATALOG_UNAVAILABLE`, siehe `gate-http.ts`; Offline-Sync: Fehler ⇒ kein Apply).
 * Kein `TrainingGateError` (der wäre im Offline-Sync eine dauerhafte Ablehnung) – der Zustand ist vorübergehend.
 */
export const TRAINING_GATE_UNAVAILABLE_MESSAGE =
  'Der Trainingskatalog ist vorübergehend nicht verfügbar.';

export class TrainingGateUnavailableError extends Error {
  readonly trainingCode = 'TRAINING_CATALOG_UNAVAILABLE' as const;

  constructor(readonly featureKey: TrainingFeatureKey) {
    super(TRAINING_GATE_UNAVAILABLE_MESSAGE);
    this.name = 'TrainingGateUnavailableError';
  }
}

export const TRAINING_GATE_MESSAGES = {
  required: (title: string) =>
    `Für diese Funktion ist zuerst das Training ‚${title}‘ erforderlich.`,
  configurationInvalid:
    'Diese Funktion ist durch eine fehlerhaft konfigurierte Trainingssperre blockiert. Bitte wende dich an die Verwaltung.',
} as const;

export interface GateClearanceView {
  id: string;
  source: 'verified_demo' | 'override';
  validFrom: Date;
  validUntil: Date | null;
}

/** Status einer aktivierten Sperre für einen Mitarbeiter (`GET /staff/training/me`, Feld `gates`). */
export interface GateStatusView {
  featureKey: TrainingFeatureKey;
  title: string;
  /** Sperre wird in dieser Umgebung erzwungen (nur production, §63). */
  enforced: boolean;
  requiredTraining: { key: string; title: string; active: boolean } | null;
  /** Aktive Sperre ohne gültige Übungsdefinition – in production fail-closed (§97). */
  configurationInvalid: boolean;
  cleared: boolean;
  clearance: GateClearanceView | null;
}

export type GateEvaluation =
  /** Keine Erzwingung in dieser Umgebung (§63). */
  | { outcome: 'not_enforced'; featureKey: TrainingFeatureKey }
  /** Keine oder deaktivierte Sperre (§99: Gate standardmäßig aus). */
  | { outcome: 'open'; featureKey: TrainingFeatureKey }
  /** Sperre aktiv, Übung fehlt oder ist inaktiv – fail-closed (§97). */
  | {
      outcome: 'configuration_invalid';
      featureKey: TrainingFeatureKey;
      requiredTrainingKey: string;
    }
  | {
      outcome: 'cleared';
      featureKey: TrainingFeatureKey;
      requiredTrainingKey: string;
      title: string;
      clearance: GateClearanceView;
    }
  | {
      outcome: 'required';
      featureKey: TrainingFeatureKey;
      requiredTrainingKey: string;
      title: string;
    };

export interface TrainingGateInput {
  userId: string;
  featureKey: TrainingFeatureKey;
  now?: Date;
}

/**
 * Schnittstelle für Routen und Offline-Sync. `assert` wirft `TrainingGateError`;
 * `evaluate`/`statusForUser` werfen nie (Anzeige in `/staff/training/me`).
 */
export interface TrainingGate {
  assert(input: TrainingGateInput): Promise<void>;
  evaluate(input: TrainingGateInput): Promise<GateEvaluation>;
  statusForUser(userId: string, now?: Date): Promise<GateStatusView[]>;
}

/** Ohne Verdrahtung (Seeds, Skripte, Alt-Tests): keine Sperre, kein Status. */
export function createNoopTrainingGate(): TrainingGate {
  return {
    assert: async () => undefined,
    evaluate: async ({ featureKey }) => ({ outcome: 'not_enforced', featureKey }),
    statusForUser: async () => [],
  };
}

/** Gültige Freigabe (§62): nicht widerrufen, begonnen, nicht abgelaufen. */
function isClearanceValid(clearance: StaffTrainingClearance, now: Date): boolean {
  return (
    clearance.revokedAt === null &&
    clearance.validFrom.getTime() <= now.getTime() &&
    (clearance.validUntil === null || clearance.validUntil.getTime() > now.getTime())
  );
}

/** Zur Anzeige die „stärkste“ Freigabe: Demo-Bestätigung vor Override, dann die längste Gültigkeit. */
function preferClearance(
  current: StaffTrainingClearance | null,
  candidate: StaffTrainingClearance,
): StaffTrainingClearance {
  if (current === null) return candidate;
  if (current.source !== candidate.source) {
    return current.source === 'verified_demo' ? current : candidate;
  }
  if (current.validUntil === null) return current;
  if (candidate.validUntil === null) return candidate;
  return candidate.validUntil.getTime() > current.validUntil.getTime() ? candidate : current;
}

export class TrainingGateService implements TrainingGate {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    /** Review-Fix F6: Katalog vor dem Laden eines Requirements sicherstellen (Lazy Retry nach fail-soft-Start). */
    private readonly options: { catalog?: TrainingCatalogSource | undefined } = {},
  ) {}

  /** Erzwingung nur in production (§63). */
  get enforced(): boolean {
    return this.config.appEnv === 'production';
  }

  /**
   * Gate-Auswertung (§64, Schritte 3–5): production + Sperre aktiv ⇒ gültige
   * Freigabe nötig, sonst `TRAINING_REQUIRED`; inkonsistente Sperre ⇒
   * `TRAINING_CONFIGURATION_INVALID`. Außerhalb production wird nichts gelesen.
   */
  async assert(input: TrainingGateInput): Promise<void> {
    if (!this.enforced) return;
    const evaluation = await this.inspect(input);
    switch (evaluation.outcome) {
      case 'open':
      case 'cleared':
      case 'not_enforced':
        return;
      case 'configuration_invalid':
        throw new TrainingGateError(
          'TRAINING_CONFIGURATION_INVALID',
          TRAINING_GATE_MESSAGES.configurationInvalid,
          {
            featureKey: evaluation.featureKey,
            requiredTrainingKey: evaluation.requiredTrainingKey,
          },
        );
      case 'required':
        throw new TrainingGateError(
          'TRAINING_REQUIRED',
          TRAINING_GATE_MESSAGES.required(evaluation.title),
          {
            featureKey: evaluation.featureKey,
            requiredTrainingKey: evaluation.requiredTrainingKey,
            title: evaluation.title,
          },
        );
    }
  }

  /** Wie `assert`, aber ohne Werfen – `not_enforced` außerhalb production. */
  async evaluate(input: TrainingGateInput): Promise<GateEvaluation> {
    if (!this.enforced) return { outcome: 'not_enforced', featureKey: input.featureKey };
    return this.inspect(input);
  }

  /**
   * Status aller aktivierten Sperren für einen Mitarbeiter (Design §4.4,
   * `gates` in `/staff/training/me`): nur außerhalb demo (§68/§88); in
   * staging/development mit `enforced: false` (nur Vorschau).
   */
  async statusForUser(userId: string, now = new Date()): Promise<GateStatusView[]> {
    if (this.config.appEnv === 'demo') return [];
    const requirements = await this.db
      .select()
      .from(trainingFeatureRequirements)
      .where(eq(trainingFeatureRequirements.enabled, true));
    const byKey = new Map(requirements.map((row) => [row.featureKey, row]));
    const result: GateStatusView[] = [];
    // Katalogreihenfolge; Zeilen zu unbekannten Feature-Keys werden ignoriert.
    for (const featureKey of TRAINING_FEATURE_KEYS) {
      const requirement = byKey.get(featureKey);
      if (requirement === undefined) continue;
      const definition = await this.definitionByKey(requirement.definitionKey);
      const clearance =
        definition === null
          ? null
          : await this.validClearance(userId, requirement.definitionKey, now);
      const configurationInvalid = definition === null || !definition.active;
      result.push({
        featureKey,
        title: trainingFeatureSpec(featureKey).title,
        enforced: this.enforced,
        requiredTraining:
          definition === null
            ? null
            : { key: definition.key, title: definition.title, active: definition.active },
        configurationInvalid,
        cleared: !configurationInvalid && clearance !== null,
        clearance: clearance === null ? null : toClearanceView(clearance),
      });
    }
    return result;
  }

  /** Frische Auswertung gegen die Datenbank (kein Cache, §65). */
  private async inspect(input: TrainingGateInput): Promise<GateEvaluation> {
    const now = input.now ?? new Date();
    // Review-Fix F6: nach einem fehlgeschlagenen Start-Sync liegt der Katalog erst hier vor
    // (memoisiert, danach kostenlos); scheitert er erneut, bleibt die Aktion blockiert –
    // Phase 14 Final §13: fail-closed als `TrainingGateUnavailableError` (503, nie Interna).
    try {
      await this.options.catalog?.ensureSynced();
    } catch {
      throw new TrainingGateUnavailableError(input.featureKey);
    }
    const [requirement] = await this.db
      .select()
      .from(trainingFeatureRequirements)
      .where(eq(trainingFeatureRequirements.featureKey, input.featureKey))
      .limit(1);
    if (requirement === undefined || !requirement.enabled) {
      return { outcome: 'open', featureKey: input.featureKey };
    }
    const definition = await this.definitionByKey(requirement.definitionKey);
    if (definition === null || !definition.active) {
      return {
        outcome: 'configuration_invalid',
        featureKey: input.featureKey,
        requiredTrainingKey: requirement.definitionKey,
      };
    }
    const clearance = await this.validClearance(input.userId, definition.key, now);
    if (clearance !== null) {
      return {
        outcome: 'cleared',
        featureKey: input.featureKey,
        requiredTrainingKey: definition.key,
        title: definition.title,
        clearance: toClearanceView(clearance),
      };
    }
    return {
      outcome: 'required',
      featureKey: input.featureKey,
      requiredTrainingKey: definition.key,
      title: definition.title,
    };
  }

  private async definitionByKey(key: string) {
    const [row] = await this.db
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

  private async validClearance(
    userId: string,
    definitionKey: string,
    now: Date,
  ): Promise<StaffTrainingClearance | null> {
    const rows = await this.db
      .select()
      .from(staffTrainingClearances)
      .where(
        and(
          eq(staffTrainingClearances.userId, userId),
          eq(staffTrainingClearances.definitionKey, definitionKey),
          isNull(staffTrainingClearances.revokedAt),
          lte(staffTrainingClearances.validFrom, now),
          or(
            isNull(staffTrainingClearances.validUntil),
            gt(staffTrainingClearances.validUntil, now),
          ),
        ),
      );
    let best: StaffTrainingClearance | null = null;
    for (const row of rows) {
      // Doppelte Absicherung gegen Grenzfälle der Zeitvergleiche in der Datenbank.
      if (!isClearanceValid(row, now)) continue;
      best = preferClearance(best, row);
    }
    return best;
  }
}

function toClearanceView(row: StaffTrainingClearance): GateClearanceView {
  return { id: row.id, source: row.source, validFrom: row.validFrom, validUntil: row.validUntil };
}
