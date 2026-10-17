import {
  lexwareIntegrationState,
  type DatabaseExecutor,
  type LexwareIntegrationStateRow,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import type { LexwareContext } from './context.ts';
import { LexwareApiError } from './errors.ts';

/**
 * Verbindungs-/Profilprüfung (Order §7) – Vertrag §3. Genau eine Zeile je
 * Umgebung in `lexware_integration_state`; die `organizationId` wird beim
 * ersten erfolgreichen Profilabruf gepinnt (bzw. gegen
 * `config.lexware.organizationId` geprüft). Ändert sie sich später, läuft
 * NICHTS still weiter: Status `organization_mismatch`, der neue Wert liegt in
 * `pendingOrganizationId`, bis ein Admin ihn mit `confirmOrganization`
 * bewusst übernimmt. Es werden keine Secrets und keine Personendaten des
 * Profils (`created.*`) gespeichert; Logs enthalten nur IDs/Codes.
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

/** Business-Feature, das Miet-Royal im Lexware-Vertrag voraussetzt (docs/LEXWARE_API_NOTES.md). */
export const LEXWARE_REQUIRED_BUSINESS_FEATURE = 'INVOICING';

export const LEXWARE_STATUS_LABELS: Record<LexwareIntegrationStateRow['status'], string> = {
  not_configured: 'Nicht eingerichtet',
  connected: 'Verbunden',
  error: 'Fehler',
  incomplete: 'Konfiguration unvollständig',
  disconnected: 'Verbindung getrennt',
  organization_mismatch: 'Organisation geändert',
};

export const LEXWARE_BLOCKED_MESSAGES: Record<LexwareBlockedCode, string> = {
  LEXWARE_NOT_CONFIGURED: 'Buchhaltungsintegration nicht konfiguriert',
  LEXWARE_NOT_CONNECTED: 'Lexware-Verbindung getrennt – Einstellungen prüfen',
  LEXWARE_ORGANIZATION_MISMATCH:
    'Lexware-Organisation hat sich geändert – Bestätigung erforderlich',
  LEXWARE_UNAUTHORIZED: 'API-Key ungültig/abgelaufen',
  LEXWARE_FORBIDDEN: 'API-Berechtigung fehlt',
};

type StatePatch = Partial<Omit<typeof lexwareIntegrationState.$inferInsert, 'environment' | 'id'>>;

export class LexwareConnectionService {
  constructor(readonly lexware: LexwareContext) {}

  private get environment(): string {
    return this.lexware.config.appEnv;
  }

  /** Aktueller Zustand der Umgebung (ohne Secrets); null, wenn nie geprüft. */
  async getState(
    executor: DatabaseExecutor = this.lexware.db,
  ): Promise<LexwareIntegrationStateRow | null> {
    const rows = await executor
      .select()
      .from(lexwareIntegrationState)
      .where(eq(lexwareIntegrationState.environment, this.environment));
    return rows[0] ?? null;
  }

  /** Upsert der Umgebungszeile; gibt den gespeicherten Stand zurück. */
  private async upsert(patch: StatePatch): Promise<LexwareIntegrationStateRow> {
    const now = new Date();
    const rows = await this.lexware.db
      .insert(lexwareIntegrationState)
      .values({ environment: this.environment, ...patch, updatedAt: now })
      .onConflictDoUpdate({
        target: lexwareIntegrationState.environment,
        set: { ...patch, updatedAt: now },
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('lexware_integration_state: Upsert ohne Zeile');
    return row;
  }

  /** GET /v1/profile, Pinning der organizationId, Statusableitung (Vertrag §3). */
  async check(actorId?: string): Promise<LexwareConnectionCheckResult> {
    const now = new Date();
    const client = this.lexware.client;
    if (client === null) {
      const state = await this.upsert({
        status: 'not_configured',
        lastCheckedAt: now,
        lastErrorCode: 'LEXWARE_NOT_CONFIGURED',
      });
      return { state, ok: false, code: 'LEXWARE_NOT_CONFIGURED' };
    }

    let profile;
    try {
      profile = (await client.profile()).data;
    } catch (error) {
      if (!(error instanceof LexwareApiError)) throw error;
      const code = error.code;
      const state =
        error.kind === 'unauthorized'
          ? await this.upsert({
              status: 'disconnected',
              lastCheckedAt: now,
              lastErrorCode: code,
              disconnectedAt: now,
            })
          : await this.upsert({ status: 'error', lastCheckedAt: now, lastErrorCode: code });
      this.lexware.logger.warn(
        { lexware: { check: 'profile', code, status: state.status }, actorId: actorId ?? null },
        'Lexware-Verbindungsprüfung fehlgeschlagen',
      );
      return { state, ok: false, code };
    }

    const previous = await this.getState();
    const configured = this.lexware.config.lexware.organizationId;
    // Gepinnter Wert: zuerst die Konfiguration, sonst der beim ersten
    // erfolgreichen Abruf gespeicherte Wert; nie der Profilwert selbst.
    const pinned = configured ?? previous?.organizationId ?? null;
    const profileFields: StatePatch = {
      companyName: profile.companyName,
      connectionId: profile.connectionId ?? null,
      taxType: profile.taxType ?? null,
      smallBusiness: profile.smallBusiness ?? null,
      businessFeatures: profile.businessFeatures ?? null,
      lastCheckedAt: now,
    };

    if (pinned !== null && pinned !== profile.organizationId) {
      const state = await this.upsert({
        ...profileFields,
        status: 'organization_mismatch',
        organizationId: pinned,
        pendingOrganizationId: profile.organizationId,
        lastErrorCode: 'LEXWARE_ORGANIZATION_MISMATCH',
      });
      this.lexware.logger.warn(
        {
          lexware: {
            check: 'profile',
            code: 'LEXWARE_ORGANIZATION_MISMATCH',
            pinnedOrganizationId: pinned,
            profileOrganizationId: profile.organizationId,
          },
          actorId: actorId ?? null,
        },
        'Lexware-organizationId weicht vom gepinnten Wert ab',
      );
      return { state, ok: false, code: 'LEXWARE_ORGANIZATION_MISMATCH' };
    }

    const features = profile.businessFeatures ?? [];
    if (!features.includes(LEXWARE_REQUIRED_BUSINESS_FEATURE)) {
      const state = await this.upsert({
        ...profileFields,
        status: 'incomplete',
        organizationId: profile.organizationId,
        pendingOrganizationId: null,
        lastErrorCode: 'LEXWARE_FEATURE_MISSING',
      });
      return { state, ok: false, code: 'LEXWARE_FEATURE_MISSING' };
    }

    const state = await this.upsert({
      ...profileFields,
      status: 'connected',
      organizationId: profile.organizationId,
      pendingOrganizationId: null,
      lastSuccessAt: now,
      lastErrorCode: null,
      disconnectedAt: null,
    });
    this.lexware.logger.info(
      {
        lexware: { check: 'profile', status: 'connected', organizationId: profile.organizationId },
        actorId: actorId ?? null,
      },
      'Lexware-Verbindung geprüft',
    );
    return { state, ok: true, code: null };
  }

  /** 401/token.revoked ⇒ „Verbindung getrennt“ (keine Auto-Retries, nichts wird gelöscht). */
  async markDisconnected(reason: string): Promise<void> {
    const now = new Date();
    await this.upsert({
      status: 'disconnected',
      lastErrorCode: reason,
      disconnectedAt: now,
      lastCheckedAt: now,
    });
    this.lexware.logger.warn(
      { lexware: { status: 'disconnected', code: reason } },
      'Lexware-Verbindung getrennt',
    );
  }

  /**
   * Admin bestätigt eine geänderte organizationId bewusst (Order §7). Der
   * Wert muss dem zuletzt gesehenen `pendingOrganizationId` entsprechen; ist
   * die Organisation per Konfiguration gepinnt, muss die Konfiguration
   * geändert werden – eine UI-Bestätigung kann sie nicht übersteuern.
   */
  async confirmOrganization(actorId: string, organizationId: string): Promise<void> {
    const state = await this.getState();
    if (state === null || state.pendingOrganizationId === null) {
      throw new AuthError('CONFLICT', 'Es liegt keine geänderte Lexware-Organisation vor.');
    }
    if (state.pendingOrganizationId !== organizationId) {
      throw new AuthError(
        'CONFLICT',
        'Die angegebene Organisation entspricht nicht der zuletzt gemeldeten.',
      );
    }
    const configured = this.lexware.config.lexware.organizationId;
    if (configured !== null && configured !== organizationId) {
      throw new AuthError(
        'CONFLICT',
        'Die Lexware-Organisation ist in der Konfiguration (LEXWARE_ORGANIZATION_ID) festgelegt und muss dort geändert werden.',
      );
    }
    await this.upsert({
      organizationId,
      pendingOrganizationId: null,
      organizationConfirmedBy: actorId,
      organizationConfirmedAt: new Date(),
    });
    this.lexware.logger.warn(
      { lexware: { organizationId, action: 'confirm_organization' }, actorId },
      'Lexware-Organisation administrativ bestätigt',
    );
    // Status aus dem aktuellen Profil neu ableiten (connected/incomplete/…).
    await this.check(actorId);
  }

  /** enabled ∧ connected ∧ organizationId gepinnt (Vertrag §3). */
  async isTransferReady(): Promise<boolean> {
    try {
      await this.assertReady();
      return true;
    } catch (error) {
      if (error instanceof LexwareBlockedError) return false;
      throw error;
    }
  }

  /** Wirft LexwareBlockedError, wenn kein Transfer erlaubt ist (enabled ∧ connected ∧ organizationId gepinnt). */
  async assertReady(
    executor: DatabaseExecutor = this.lexware.db,
  ): Promise<{ organizationId: string; state: LexwareIntegrationStateRow }> {
    if (!this.lexware.config.lexware.enabled || this.lexware.client === null) {
      throw blocked('LEXWARE_NOT_CONFIGURED');
    }
    const state = await this.getState(executor);
    if (state === null) throw blocked('LEXWARE_NOT_CONNECTED');
    switch (state.status) {
      case 'organization_mismatch':
        throw blocked('LEXWARE_ORGANIZATION_MISMATCH');
      case 'disconnected':
        throw blocked(
          state.lastErrorCode === 'LEXWARE_UNAUTHORIZED'
            ? 'LEXWARE_UNAUTHORIZED'
            : 'LEXWARE_NOT_CONNECTED',
        );
      case 'error':
        throw blocked(
          state.lastErrorCode === 'LEXWARE_FORBIDDEN'
            ? 'LEXWARE_FORBIDDEN'
            : 'LEXWARE_NOT_CONNECTED',
        );
      case 'connected':
        break;
      default:
        throw blocked('LEXWARE_NOT_CONNECTED');
    }
    if (state.organizationId === null) throw blocked('LEXWARE_NOT_CONNECTED');
    return { organizationId: state.organizationId, state };
  }
}

function blocked(code: LexwareBlockedCode): LexwareBlockedError {
  return new LexwareBlockedError(code, LEXWARE_BLOCKED_MESSAGES[code]);
}
