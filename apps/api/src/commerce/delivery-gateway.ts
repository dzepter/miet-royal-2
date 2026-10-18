import type { AppConfig } from '@mietroyal/config';
import type { DatabaseExecutor } from '@mietroyal/database';
import { AuthError } from '../auth/service.ts';
import type { MailOutboxService } from '../communication/mail/outbox.ts';
import type {
  MailEnqueueInput,
  MailEnqueueResult,
  OutboundMailGateway,
} from '../communication/types.ts';

/**
 * Fachlicher Versandprozess für Angebote/Auftragsbestätigungen (Phase-3-
 * Vorgabe Nr. 24, Phase 12 Order §11): Der Versand läuft über die zentrale
 * Mail-Outbox (`mail_deliveries`) und den Job `mail.send` – nie innerhalb
 * einer offenen Transaktion gegen einen Provider. Die frühere Tabelle
 * `offer_deliveries` (Phase-5-Altbestand, Token dort bereits maskiert)
 * wird nicht mehr befüllt; die Outbox ist die einzige Versandspur.
 *
 * - Nicht-Production: immer einreihbar; ohne konfigurierten Mailweg endet
 *   die Zustellung `blocked` (MAIL_NOT_CONFIGURED) – sichtbar, nie vorgetäuscht.
 * - Production ohne Mailweg: `assertConfigured()` blockiert HART (CONFLICT)
 *   VOR jeder Zustandsänderung (kein Einfrieren ohne echten Versandweg).
 */
export interface OfferDeliveryGateway {
  /** Wirft, wenn in production kein echter Versandweg existiert – VOR dem Einfrieren aufrufen. */
  assertConfigured(): void;
  /** Outbox-Zeile schreiben – `executor` = laufende Transaktion des Aufrufers. */
  enqueue(input: MailEnqueueInput, executor?: DatabaseExecutor): Promise<MailEnqueueResult>;
  /** Nach dem Commit: Versandjob planen (nur für `pending`). */
  scheduleSend(deliveryId: string): Promise<void>;
}

export const OFFER_DELIVERY_NOT_CONFIGURED_MESSAGE =
  'Versand nicht möglich: In Production ist kein Mailversand (SMTP) konfiguriert. ' +
  'Der Versand wird bewusst blockiert, statt einen Versand vorzutäuschen.';

export class OutboxOfferDeliveryGateway implements OfferDeliveryGateway {
  constructor(
    private readonly outbox: MailOutboxService,
    private readonly appEnv: AppConfig['appEnv'],
    private readonly mailGatewayKind: OutboundMailGateway['kind'],
  ) {}

  assertConfigured(): void {
    if (this.appEnv === 'production' && this.mailGatewayKind === 'disabled') {
      throw new AuthError('CONFLICT', OFFER_DELIVERY_NOT_CONFIGURED_MESSAGE);
    }
  }

  enqueue(input: MailEnqueueInput, executor?: DatabaseExecutor): Promise<MailEnqueueResult> {
    return this.outbox.enqueue(input, executor);
  }

  scheduleSend(deliveryId: string): Promise<void> {
    return this.outbox.scheduleSend(deliveryId);
  }
}

/** Production ohne Versandweg: blockiert hart (Tests „Blockade VOR dem Einfrieren“). */
export class UnconfiguredProductionGateway implements OfferDeliveryGateway {
  assertConfigured(): void {
    throw new AuthError('CONFLICT', OFFER_DELIVERY_NOT_CONFIGURED_MESSAGE);
  }

  enqueue(): Promise<MailEnqueueResult> {
    return Promise.reject(new AuthError('CONFLICT', OFFER_DELIVERY_NOT_CONFIGURED_MESSAGE));
  }

  scheduleSend(): Promise<void> {
    return Promise.reject(new AuthError('CONFLICT', OFFER_DELIVERY_NOT_CONFIGURED_MESSAGE));
  }
}

export function createOfferDeliveryGateway(
  config: Pick<AppConfig, 'appEnv'>,
  communication: { outbox: MailOutboxService; mailGateway: Pick<OutboundMailGateway, 'kind'> },
): OfferDeliveryGateway {
  return new OutboxOfferDeliveryGateway(
    communication.outbox,
    config.appEnv,
    communication.mailGateway.kind,
  );
}
