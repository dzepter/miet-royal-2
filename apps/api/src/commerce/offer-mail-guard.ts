import { offerVersions, type Database, type MailDeliveryRow } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import type { MailPreSendGuard } from '../communication/mail/send-job.ts';
import { parseTransactionalKey } from '../communication/transactional/keys.ts';
import { effectiveStatus } from './offer-service.ts';

/**
 * Phase 12 Härtung (Review A, RA-5): Pre-Send-Guard für Angebotsmails.
 * Wurde die Angebotsversion inzwischen durch eine neue Version abgelöst
 * (`effectiveStatus` = superseded – dieselbe Regel wie die öffentliche
 * Angebotsansicht/Annahme), wird die noch ausstehende Mail nicht mehr
 * versendet (`blocked` SUPERSEDED): ihr Link führt nur noch auf eine
 * ungültige Version. Nicht eindeutig zuordenbare Zustellungen (fremder
 * Schlüssel, Version unbekannt) werden NICHT blockiert – nur klar
 * bestimmbare Fälle.
 */
export const MAIL_BLOCKED_OFFER_SUPERSEDED = 'SUPERSEDED';

export function createOfferMailPreSendGuard(db: Database): MailPreSendGuard {
  return {
    check: async (delivery: MailDeliveryRow, { now }) => {
      if (delivery.kind !== 'offer') return null;
      const parsed = parseTransactionalKey(delivery.idempotencyKey);
      if (parsed === null || parsed.kind !== 'offer') return null;
      const rows = await db
        .select()
        .from(offerVersions)
        .where(eq(offerVersions.id, parsed.entityId));
      const version = rows[0];
      if (version === undefined) return null;
      return effectiveStatus(version, now) === 'superseded' ? MAIL_BLOCKED_OFFER_SUPERSEDED : null;
    },
  };
}
