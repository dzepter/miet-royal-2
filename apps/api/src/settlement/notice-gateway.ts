import type { AppConfig } from '@mietroyal/config';
import { AuthError } from '../auth/service.ts';

/**
 * Versandweg der kombinierten Kundeninformation vor Schaden-/Fehlteil-
 * belastung (Phase-9-Vorgabe §27–§31). Wie beim Angebotsversand gilt:
 *
 * - development/test/demo/staging: Outbox – der Versand wird ausschließlich
 *   in settlement_customer_notices protokolliert (status sent, gateway
 *   'outbox'); nichts verlässt das System.
 * - production: solange kein echter Mailadapter existiert, HART blockiert
 *   (status blocked, blockedReason) – es wird nie ein Versand vorgetäuscht
 *   und folglich auch keine 24-h-Frist gestartet.
 */

export interface SettlementNoticeRequest {
  noticeId: string;
  settlementId: string;
  recipientEmail: string;
  subject: string;
  bodyText: string;
}

export interface SettlementNoticeResult {
  gateway: 'outbox';
  gatewayReference: string;
}

export interface SettlementNoticeGateway {
  readonly kind: 'outbox' | 'disabled';
  isConfigured(): boolean;
  /** Wirft AuthError CONFLICT, wenn kein echter Versandweg existiert. */
  assertConfigured(): void;
  send(request: SettlementNoticeRequest): Promise<SettlementNoticeResult>;
}

export const NOTICE_NOT_CONFIGURED_MESSAGE =
  'Kundeninformation nicht versendbar: In Production ist kein Versandadapter konfiguriert.';

/** Obergrenze des In-Memory-Outbox-Protokolls (Datenminimierung, kein unbegrenztes Wachstum). */
export const OUTBOX_MEMORY_LIMIT = 100;

export class OutboxSettlementNoticeGateway implements SettlementNoticeGateway {
  readonly kind = 'outbox' as const;
  /** Für Tests: zuletzt „versendete“ Informationen (begrenzt; Protokoll liegt in der DB). */
  readonly sent: SettlementNoticeRequest[] = [];

  isConfigured(): boolean {
    return true;
  }

  assertConfigured(): void {
    // Outbox ist in Nicht-Production-Umgebungen immer verfügbar.
  }

  async send(request: SettlementNoticeRequest): Promise<SettlementNoticeResult> {
    this.sent.push(request);
    if (this.sent.length > OUTBOX_MEMORY_LIMIT)
      this.sent.splice(0, this.sent.length - OUTBOX_MEMORY_LIMIT);
    return { gateway: 'outbox', gatewayReference: `outbox:${request.noticeId}` };
  }
}

export class DisabledSettlementNoticeGateway implements SettlementNoticeGateway {
  readonly kind = 'disabled' as const;

  isConfigured(): boolean {
    return false;
  }

  assertConfigured(): void {
    throw new AuthError('CONFLICT', NOTICE_NOT_CONFIGURED_MESSAGE);
  }

  send(): Promise<SettlementNoticeResult> {
    this.assertConfigured();
    return Promise.reject(new AuthError('CONFLICT', NOTICE_NOT_CONFIGURED_MESSAGE));
  }
}

export function createSettlementNoticeGateway(config: AppConfig): SettlementNoticeGateway {
  if (config.appEnv === 'production') {
    // Der echte Mailadapter (spätere Phase) wird HIER angebunden.
    return new DisabledSettlementNoticeGateway();
  }
  return new OutboxSettlementNoticeGateway();
}
