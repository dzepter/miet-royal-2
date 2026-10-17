import type { AppConfig } from '@mietroyal/config';
import { AuthError } from '../auth/service.ts';
import { OUTBOX_MEMORY_LIMIT } from '../settlement/notice-gateway.ts';

/**
 * Versandweg der Stornobestätigung (Phase-9-Vorgabe §57/§61) nach dem
 * Muster des Kundeninformations-Gateways der Abrechnung:
 *
 * - development/test/demo/staging: Outbox – der Versand wird ausschließlich
 *   an der Stornierung protokolliert (confirmationStatus 'sent', Referenz
 *   `outbox:cancellation-confirmation:<id>`); nichts verlässt das System.
 * - production: solange kein echter Mailadapter existiert, HART blockiert
 *   (confirmationStatus 'blocked') – es wird nie ein Versand vorgetäuscht.
 */

export interface CancellationConfirmationRequest {
  cancellationId: string;
  processNumber: string;
  recipientEmail: string | null;
}

export interface CancellationConfirmationResult {
  gateway: 'outbox';
  gatewayReference: string;
}

export interface CancellationConfirmationGateway {
  readonly kind: 'outbox' | 'disabled';
  isConfigured(): boolean;
  /** Wirft AuthError CONFLICT, wenn kein echter Versandweg existiert. */
  assertConfigured(): void;
  send(request: CancellationConfirmationRequest): Promise<CancellationConfirmationResult>;
}

export const CONFIRMATION_NOT_CONFIGURED_MESSAGE =
  'Stornobestätigung nicht versendbar: In Production ist kein Versandadapter konfiguriert.';

export function cancellationConfirmationReference(cancellationId: string): string {
  return `outbox:cancellation-confirmation:${cancellationId}`;
}

export class OutboxCancellationConfirmationGateway implements CancellationConfirmationGateway {
  readonly kind = 'outbox' as const;
  /** Für Tests: alle „versendeten“ Bestätigungen. */
  readonly sent: CancellationConfirmationRequest[] = [];

  isConfigured(): boolean {
    return true;
  }

  assertConfigured(): void {
    // Outbox ist in Nicht-Production-Umgebungen immer verfügbar.
  }

  async send(request: CancellationConfirmationRequest): Promise<CancellationConfirmationResult> {
    this.sent.push(request);
    // Datenminimierung: In-Memory-Protokoll begrenzen (Nachweis liegt in der DB).
    if (this.sent.length > OUTBOX_MEMORY_LIMIT)
      this.sent.splice(0, this.sent.length - OUTBOX_MEMORY_LIMIT);
    return {
      gateway: 'outbox',
      gatewayReference: cancellationConfirmationReference(request.cancellationId),
    };
  }
}

export class DisabledCancellationConfirmationGateway implements CancellationConfirmationGateway {
  readonly kind = 'disabled' as const;

  isConfigured(): boolean {
    return false;
  }

  assertConfigured(): void {
    throw new AuthError('CONFLICT', CONFIRMATION_NOT_CONFIGURED_MESSAGE);
  }

  send(): Promise<CancellationConfirmationResult> {
    return Promise.reject(new AuthError('CONFLICT', CONFIRMATION_NOT_CONFIGURED_MESSAGE));
  }
}

export function createCancellationConfirmationGateway(
  config: AppConfig,
): CancellationConfirmationGateway {
  if (config.appEnv === 'production') {
    // Der echte Mailadapter (spätere Phase) wird HIER angebunden.
    return new DisabledCancellationConfirmationGateway();
  }
  return new OutboxCancellationConfirmationGateway();
}
