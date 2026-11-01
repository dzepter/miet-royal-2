import { AuthError, type AuthErrorCode } from '../auth/service.ts';

/**
 * Phase 14 (Training, Order §54/§80, Design §4.2): fachliche Trainingsfehler
 * mit stabilem Code für die UI (z. B. TRAINING_DEFINITION_INACTIVE,
 * TRAINING_PERMISSION_MISSING); der HTTP-Status folgt dem AuthError-Code
 * (`authErrorStatus`: 400/403/404/409). `details` enthält nur Schlüssel und
 * Codes – nie Businessdaten.
 */
export class TrainingError extends AuthError {
  constructor(
    code: AuthErrorCode,
    readonly trainingCode: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code, message);
    this.name = 'TrainingError';
  }
}

export const TRAINING_ERROR_CODES = {
  DEFINITION_INACTIVE: 'TRAINING_DEFINITION_INACTIVE',
  PERMISSION_MISSING: 'TRAINING_PERMISSION_MISSING',
  ASSIGNMENT_EXISTS: 'TRAINING_ASSIGNMENT_EXISTS',
  PATH_INACTIVE: 'TRAINING_PATH_INACTIVE',
  ATTEMPT_NOT_ACTIVE: 'TRAINING_ATTEMPT_NOT_ACTIVE',
  /** Phase 14 Final §9: keine neue Zuweisung an einen deaktivierten Mitarbeiter (409). */
  USER_INACTIVE: 'TRAINING_USER_INACTIVE',
  /** Neutraler Fehlercode der bewussten Prüfung „Übung prüfen“ ohne erfüllte Kriterien (§44). */
  STEP_NOT_COMPLETED: 'STEP_NOT_COMPLETED',
} as const;

export const TRAINING_MESSAGES = {
  PERMISSION_MISSING: 'Für diese Übung fehlt dir aktuell die erforderliche Berechtigung.',
  DEFINITION_INACTIVE: 'Diese Übung ist derzeit nicht verfügbar.',
  DEFINITION_NOT_FOUND: 'Übung nicht gefunden.',
  PATH_NOT_FOUND: 'Trainingspfad nicht gefunden.',
  PATH_INACTIVE: 'Dieser Trainingspfad ist derzeit nicht verfügbar.',
  ATTEMPT_NOT_FOUND: 'Versuch nicht gefunden.',
  ATTEMPT_NOT_ACTIVE: 'Dieser Versuch ist nicht mehr aktiv – bitte die Übung neu starten.',
  ASSIGNMENT_EXISTS: 'Dieser Trainingspfad ist dem Mitarbeiter bereits zugewiesen.',
  USER_NOT_FOUND: 'Mitarbeiter nicht gefunden.',
  /** Phase 14 Final §9 */
  USER_INACTIVE: 'Der Mitarbeiter ist deaktiviert.',
  RESET_SCOPE_INVALID: 'Bitte entweder einen Pfad oder eine einzelne Übung wählen – nicht beides.',
  SETTLEMENT_DEMO_NOTE:
    'Die Übung endet vor der Übertragung an die Buchhaltung – in der Demo gibt es keine Buchhaltungsübertragung.',
} as const;
