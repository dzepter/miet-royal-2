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
