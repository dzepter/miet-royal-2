'use client';

import { apiFetch, type ApiResult } from './api';

/**
 * Phase 19 (Pilot-Readiness): Operator-Sicht auf Hintergrundjobs (GET /staff/system/jobs,
 * Recht system.settings). Rein lesend; die Wiederholung erfolgt fachlich über die in
 * `guidance` genannten vorhandenen Funktionen.
 */
export type JobMonitorState = 'dead' | 'retrying';

export interface JobMonitorEntry {
  id: string;
  type: string;
  state: JobMonitorState;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastError: string | null;
  references: Record<string, string>;
  guidance: string;
}

export interface JobMonitorWorkerSignal {
  lastSucceededAt: string | null;
  oldestDueAt: string | null;
  overdueSeconds: number;
  /** Fällige Jobs warten länger als 5 min ⇒ kein Worker verarbeitet. */
  stalled: boolean;
}

export interface JobMonitorSnapshot {
  generatedAt: string;
  counts: {
    pending: number;
    processing: number;
    retrying: number;
    dead: number;
    succeededLast24h: number;
  };
  worker: JobMonitorWorkerSignal;
  dead: JobMonitorEntry[];
  retrying: JobMonitorEntry[];
}

export function fetchJobMonitor(): Promise<ApiResult<JobMonitorSnapshot>> {
  return apiFetch<JobMonitorSnapshot>('/staff/system/jobs');
}

/** Lesbare Bezeichnung der Jobfamilie (Fallback: technischer Typ). */
export const JOB_TYPE_LABELS: Record<string, string> = {
  'mail.send': 'E-Mail-Versand',
  'mail.inbound_poll': 'Posteingang abrufen',
  'settlement.accounting_transfer': 'Abrechnung an Buchhaltung übertragen',
  'cancellation.accounting_transfer': 'Storno an Buchhaltung übertragen',
  'lexware.event.process': 'Lexware-Ereignis verarbeiten',
  'invoice.delivery': 'Rechnung zustellen',
  'voucher.eligibility_check': 'Gutschein prüfen',
  'voucher.delivery': 'Gutschein zustellen',
  'push.send': 'Push-Benachrichtigung',
  'whatsapp.send': 'WhatsApp senden',
  'whatsapp.media_fetch': 'WhatsApp-Medien abrufen',
  'communication.scan_due': 'Erinnerungs-/Regel-Lauf',
  'communication.cleanup_retention': 'Aufbewahrungs-Bereinigung',
  'system.heartbeat': 'Systemprüfung',
  'demo.storage_cleanup': 'Demo-Dateien bereinigen',
};

export function jobTypeLabel(type: string): string {
  return JOB_TYPE_LABELS[type] ?? type;
}

/** Referenz auf den Vorgang, falls der Job eine Vorgangs-ID trägt. */
export function jobProcessLink(entry: JobMonitorEntry): string | null {
  const processId = entry.references['processId'];
  return processId === undefined ? null : `/vorgaenge/${processId}`;
}
