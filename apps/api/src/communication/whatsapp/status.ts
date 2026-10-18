/**
 * Phase 12 (Order §35): WhatsApp-Statuszusammenfassung für die Admin-
 * Einstellungen (Agent M liest sie) – nie Secrets, nie Nummern.
 */
import type { AppConfig } from '@mietroyal/config';
import { whatsappContacts, whatsappEvents, type Database } from '@mietroyal/database';
import { gt, sql } from 'drizzle-orm';
import { WHATSAPP_MOCK_LABEL } from './gateways.ts';

export interface WhatsAppStatusSummary {
  mode: AppConfig['whatsapp']['mode'];
  /** Nur in demo/development (Mock): Kennzeichnung für die UI. */
  label: string | null;
  graphApiVersion: string;
  lastInboundAt: Date | null;
  eventsLast24h: number;
  contactsWithOpenWindow: number;
}

export async function whatsappStatusSummary(
  db: Database,
  config: AppConfig,
  now = new Date(),
): Promise<WhatsAppStatusSummary> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [last] = await db
    .select({ lastInboundAt: sql<Date | null>`max(${whatsappContacts.lastInboundAt})` })
    .from(whatsappContacts);
  const [events] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(whatsappEvents)
    .where(gt(whatsappEvents.receivedAt, since));
  const [open] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(whatsappContacts)
    .where(gt(whatsappContacts.lastInboundAt, since));
  const raw = last?.lastInboundAt ?? null;
  return {
    mode: config.whatsapp.mode,
    label: config.whatsapp.mode === 'mock' ? WHATSAPP_MOCK_LABEL : null,
    graphApiVersion: config.whatsapp.graphApiVersion,
    lastInboundAt: raw === null ? null : raw instanceof Date ? raw : new Date(raw),
    eventsLast24h: events?.count ?? 0,
    contactsWithOpenWindow: open?.count ?? 0,
  };
}
