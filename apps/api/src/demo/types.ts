import { AuthError, type AuthErrorCode } from '../auth/service.ts';

/**
 * Phase 14 (Demo-Umgebung): fachliche Demo-Fehler mit stabilem Code für die
 * UI; der HTTP-Status folgt dem AuthError-Code (400/403/404/409).
 */
export class DemoError extends AuthError {
  constructor(
    code: AuthErrorCode,
    readonly demoCode: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code, message);
    this.name = 'DemoError';
  }
}

export const DEMO_MESSAGES = {
  DEMO_ONLY: 'Nur in der Demo-Umgebung verfügbar.',
  DEMO_DATA_EXISTS: 'Demo-Daten existieren bereits – demo:reset verwenden.',
  DEMO_RESET_RUNNING: 'Die Demo-Umgebung wird gerade zurückgesetzt.',
  DEMO_RESET:
    'Die Demo-Umgebung wird gerade zurückgesetzt. Bitte in einer Minute erneut versuchen.',
  DEMO_OUTDATED: 'Demo-Datenstand ist veraltet – Zurücksetzen empfohlen.',
  RESET_CONFIRMATION: 'DEMO ZURÜCKSETZEN',
} as const;

/** Stabiler Seed-Schlüssel des kanonischen Demo-Datensatzes (Order §13). */
export type DemoSeedKey = string;

export interface DemoSeedEntityRef {
  seedKey: DemoSeedKey;
  entityType: string;
  entityId: string;
  datasetVersion: number;
}

/** Ergebnis eines Demo-Resets (nur Zähler, nie Inhalte). */
export interface DemoResetResult {
  ok: true;
  datasetVersion: number;
  seededAt: Date;
  durationMs: number;
  deleted: Record<string, number>;
  seeded: Record<string, number>;
}

/**
 * Schnittstelle zwischen Routen/CLI (PLATFORM) und dem Reset-Service (SEED):
 * `reset` ist global serialisiert (Advisory-Lock), setzt alle Demo-
 * Geschäftsdaten auf den kanonischen Datensatz zurück und wirft
 * `DemoError('CONFLICT','DEMO_RESET_RUNNING', …)`, wenn bereits ein Reset läuft.
 */
export interface DemoResetRunner {
  reset(input: { actorId: string | null; now?: Date }): Promise<DemoResetResult>;
}
