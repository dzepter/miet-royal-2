/**
 * Fassade der Kommunikationsschicht (Phase 12, Order §2) für Fachmodule:
 * `mail` (Outbox – einreihen/planen), `crypto` (zentrale Payload-
 * Verschlüsselung für Aktions-/Dokument-Token und Gutscheincodes). Die
 * Fachlogik bleibt in den Domainservices; hier gibt es keinen Versand und
 * keine Vorschau – Rendering passiert ausschließlich im Job `mail.send`.
 */
import type { MailOutboxService } from './mail/outbox.ts';
import type { PayloadCrypto } from './payload-crypto.ts';

export class CommunicationService {
  constructor(
    readonly mail: MailOutboxService,
    readonly crypto: PayloadCrypto,
  ) {}
}
