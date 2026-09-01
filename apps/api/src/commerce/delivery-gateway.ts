import { offerDeliveries, type Database } from '@mietroyal/database';
import type { AppConfig } from '@mietroyal/config';
import { AuthError } from '../auth/service.ts';

/**
 * Fachlicher Versandprozess für Angebote/Auftragsbestätigungen
 * (Phase-3-Vorgabe Nr. 24). Die echte E-Mail-Infrastruktur kommt in einer
 * späteren Phase – hier gibt es NUR den fachlichen Adapterpunkt:
 *
 * - Development/Test/Staging/Demo: Outbox-Adapter (protokolliert den
 *   Versand nachvollziehbar in offer_deliveries; nichts verlässt das System).
 * - Production: solange kein echter Versandadapter konfiguriert ist, wird
 *   der Versand HART blockiert – es wird niemals so getan, als sei eine
 *   E-Mail verschickt worden. `assertConfigured()` erlaubt die Blockade
 *   VOR jeder Zustandsänderung (kein Einfrieren ohne echten Versandweg).
 */

export interface OfferDeliveryRequest {
  kind: 'offer' | 'order_confirmation';
  offerVersionId?: string | undefined;
  orderConfirmationId?: string | undefined;
  recipient: string;
  subject: string;
  body: string;
}

export interface OfferDeliveryGateway {
  /** Wirft, wenn kein echter Versandweg existiert – VOR dem Einfrieren aufrufen. */
  assertConfigured(): void;
  deliver(request: OfferDeliveryRequest): Promise<void>;
}

export class OutboxDeliveryGateway implements OfferDeliveryGateway {
  constructor(private readonly db: Database) {}

  assertConfigured(): void {
    // Outbox ist in Nicht-Production-Umgebungen immer verfügbar.
  }

  async deliver(request: OfferDeliveryRequest): Promise<void> {
    // Vorgabe Nr. 25: Das Zugriffstoken liegt in der DB NUR als Hash – auch
    // die Outbox-Kopie des Textes maskiert deshalb den Token im Link (der
    // echte Link erreicht den Kunden über den späteren Mail-Adapter; in
    // Dev/Test zeigt die Staff-UI den Link direkt nach dem Versand an).
    const maskedBody = request.body.replace(/(\/angebot\/)[A-Za-z0-9_-]+/g, '$1***');
    await this.db.insert(offerDeliveries).values({
      kind: request.kind,
      offerVersionId: request.offerVersionId ?? null,
      orderConfirmationId: request.orderConfirmationId ?? null,
      recipient: request.recipient,
      subject: request.subject,
      body: maskedBody,
    });
  }
}

export class UnconfiguredProductionGateway implements OfferDeliveryGateway {
  assertConfigured(): void {
    throw new AuthError(
      'CONFLICT',
      'Versand nicht möglich: In Production ist noch kein echter Versandadapter konfiguriert. ' +
        'Der Versand wird bewusst blockiert, statt einen Versand vorzutäuschen.',
    );
  }

  deliver(): Promise<void> {
    this.assertConfigured();
    return Promise.resolve();
  }
}

export function createOfferDeliveryGateway(config: AppConfig, db: Database): OfferDeliveryGateway {
  if (config.appEnv === 'production') {
    // Kommt der echte Mail-Adapter (spätere Phase), wird er HIER angebunden.
    return new UnconfiguredProductionGateway();
  }
  return new OutboxDeliveryGateway(db);
}
