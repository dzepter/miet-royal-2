'use client';

/** Gemeinsame Typen/Labels der Kunden-/Vorgangsbereiche (nur Darstellung). */

export const STATUS_LABELS = {
  open: 'Offen',
  completed: 'Abgeschlossen',
  reopened: 'Wieder geöffnet',
  cancelled: 'Storniert',
} as const;

export type MainStatus = keyof typeof STATUS_LABELS;

export const STATUS_BADGE_CLASS: Record<MainStatus, string> = {
  open: 'active',
  completed: 'locked',
  reopened: '',
  cancelled: 'locked',
};

export interface ProcessRow {
  id: string;
  processNumber: string;
  mainStatus: MainStatus;
  eventDate: string | null;
  customerType?: 'private' | 'organization';
  customerFirstName?: string | null;
  customerLastName?: string | null;
  customerOrganizationName?: string | null;
  assignedFirstName?: string | null;
  assignedLastName?: string | null;
}

export function customerName(row: {
  customerType?: 'private' | 'organization';
  customerFirstName?: string | null;
  customerLastName?: string | null;
  customerOrganizationName?: string | null;
}): string {
  if (row.customerType === 'organization') return row.customerOrganizationName ?? 'Organisation';
  return [row.customerLastName, row.customerFirstName].filter(Boolean).join(', ');
}

export function formatEventDate(value: string | null): string {
  if (value === null || value === '') return '–';
  const [year, month, day] = value.split('-');
  return `${day}.${month}.${year}`;
}

/**
 * Wiederkehrer-Gutschein (Phase 11, §52/§53) aus der Customer-/Process-API:
 * Status, Gültigkeit, Versandstatus und maskierte Referenz – nie der Code.
 */
export interface VoucherSummary {
  id: string;
  status: 'active' | 'reserved' | 'redeemed' | 'expired';
  statusLabel: string;
  expiresAt: string;
  maskedReference: string;
  deliveryStatus: 'pending' | 'sent';
  deliveryLabel: string;
  /** Phase 12 (Order §15): z. B. NO_EMAIL, MAIL_FAILED, DELIVERY_COPY_UNDECRYPTABLE – nie Code/Hash. */
  deliveryProblemCode?: string | null;
  /** Phase 12: „Gutschein jetzt senden“ möglich (laut Server). */
  canSendNow?: boolean;
  reservedOfferId: string | null;
  originProcessId: string;
  originProcessNumber: string | null;
}

export function formatBerlinDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '–';
  return new Date(value).toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}
