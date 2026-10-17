import type { LexwareIntegrationStateRow } from '@mietroyal/database';
import type { LexwareContext } from './context.ts';

/**
 * Verbindungs-/Profilprüfung (Order §7) – Vertrag §3. Implementierung: Agent A.
 * Diese Datei definiert die verbindliche Schnittstelle; Aufrufer (Gateway,
 * Admin-Routen, Jobs) programmieren ausschließlich dagegen.
 */
export type LexwareBlockedCode =
  | 'LEXWARE_NOT_CONFIGURED'
  | 'LEXWARE_NOT_CONNECTED'
  | 'LEXWARE_ORGANIZATION_MISMATCH'
  | 'LEXWARE_UNAUTHORIZED'
  | 'LEXWARE_FORBIDDEN';

export class LexwareBlockedError extends Error {
  constructor(
    readonly code: LexwareBlockedCode,
    message: string,
  ) {
    super(message);
    this.name = 'LexwareBlockedError';
  }
}

export interface LexwareConnectionCheckResult {
  state: LexwareIntegrationStateRow;
  ok: boolean;
  code: string | null;
}

export class LexwareConnectionService {
  constructor(readonly lexware: LexwareContext) {}

  /** Aktueller Zustand der Umgebung (ohne Secrets); null, wenn nie geprüft. */
  async getState(): Promise<LexwareIntegrationStateRow | null> {
    void this.lexware;
    return null;
  }

  /** GET /v1/profile, Pinning der organizationId, Statusableitung (Vertrag §3). */
  async check(_actorId?: string): Promise<LexwareConnectionCheckResult> {
    throw new Error('LexwareConnectionService.check: noch nicht implementiert (Agent A)');
  }

  /** 401/token.revoked ⇒ „Verbindung getrennt“ (keine Auto-Retries). */
  async markDisconnected(_reason: string): Promise<void> {
    throw new Error(
      'LexwareConnectionService.markDisconnected: noch nicht implementiert (Agent A)',
    );
  }

  /** Admin bestätigt eine geänderte organizationId bewusst (Order §7). */
  async confirmOrganization(_actorId: string, _organizationId: string): Promise<void> {
    throw new Error(
      'LexwareConnectionService.confirmOrganization: noch nicht implementiert (Agent A)',
    );
  }

  /** Wirft LexwareBlockedError, wenn kein Transfer erlaubt ist (enabled ∧ connected ∧ organizationId gepinnt). */
  async assertReady(): Promise<{ organizationId: string; state: LexwareIntegrationStateRow }> {
    throw new LexwareBlockedError(
      'LEXWARE_NOT_CONFIGURED',
      'Buchhaltungsintegration nicht konfiguriert',
    );
  }
}
