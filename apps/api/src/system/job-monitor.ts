import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { integrationJobs, type Database } from '@mietroyal/database';

/**
 * Phase 19 (Pilot-Readiness, Operator-Sicht auf Hintergrundjobs):
 * Die Jobqueue beendet Jobs nach `max_attempts` Fehlversuchen endgültig als `dead`
 * (packages/integrations, PostgresJobQueue.markFailed). Bisher war das nur im Worker-Log
 * sichtbar – im Pilotbetrieb muss ein Operator ohne Datenbankzugriff erkennen, WELCHER Job
 * (Typ, Zeitpunkt, Versuche, Fehlerzusammenfassung, fachliche Referenz) endgültig gescheitert
 * ist und was zu tun ist. Dieses Modul liest ausschließlich `integration_jobs` (keine
 * Statusänderung, kein „auf erfolgreich setzen“) und reduziert den Payload auf sichere interne
 * Referenzen (UUID-Werte von `…Id`-Feldern); Freitext, Adressen oder Inhalte werden nie
 * ausgegeben. `last_error` ist bereits die PII-arme Zusammenfassung des Runners
 * (summarizeJobError: Fehlerklasse, Code, erste Zeile).
 */
export const JOB_MONITOR_LIST_LIMIT = 50;

/**
 * Worker-Lebenszeichen ohne neue Infrastruktur: Warten fällige Jobs länger als diese Spanne,
 * verarbeitet kein Worker (gestoppt, hängend, falsche Datenbank) – die Lease verwaister Jobs
 * beträgt 5 min, der Poll des Workers 1 s; 5 min ohne Claim eines fälligen Jobs ist also nie normal.
 */
export const WORKER_STALL_SECONDS = 300;

export type JobMonitorState = 'dead' | 'retrying';

export interface JobMonitorEntry {
  id: string;
  type: string;
  state: JobMonitorState;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  /** Zeitpunkt der letzten Statusänderung (dead) bzw. nächster Versuch (retrying). */
  updatedAt: string;
  nextRunAt: string | null;
  lastError: string | null;
  /** Nur UUID-Werte von Referenzfeldern des Payloads (z. B. processId, settlementId). */
  references: Record<string, string>;
  /** Betriebsanweisung je Jobfamilie (vorhandene Funktionen, keine neuen Fachregeln). */
  guidance: string;
}

export interface JobMonitorWorkerSignal {
  /** Letzter erfolgreich abgeschlossener Job (beliebiger Typ) – null: noch keiner. */
  lastSucceededAt: string | null;
  /** Fälligkeit des ältesten wartenden, bereits fälligen Jobs – null: nichts fällig. */
  oldestDueAt: string | null;
  /** Sekunden, die der älteste fällige Job bereits wartet (0 ohne fällige Jobs). */
  overdueSeconds: number;
  /** true ⇒ fällige Jobs warten länger als WORKER_STALL_SECONDS: kein Worker verarbeitet. */
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFERENCE_KEY_RE = /(^id$|Id$)/;

/** Reduziert einen Job-Payload auf sichere interne Referenzen (nur UUIDs unter `…Id`-Schlüsseln). */
export function extractJobReferences(payload: unknown): Record<string, string> {
  const references: Record<string, string> = {};
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return references;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (REFERENCE_KEY_RE.test(key) && typeof value === 'string' && UUID_RE.test(value)) {
      references[key] = value;
    }
  }
  return references;
}

/**
 * Betriebsanweisung je Jobfamilie. Jobs kehren nie automatisch aus `dead` zurück; die
 * Wiederholung erfolgt fachlich über die genannte, bereits vorhandene Funktion.
 */
export function jobGuidance(type: string): string {
  if (type === 'mail.send') {
    return 'Einstellungen → Kommunikation: Zustellung prüfen und bewusst „Erneut senden“; vorher SMTP-Status prüfen.';
  }
  if (type === 'mail.inbound_poll') {
    return 'Posteingang (IMAP) prüfen – Einstellungen → Kommunikation; der Ketten-Watchdog reiht den Abruf automatisch neu ein.';
  }
  if (type === 'settlement.accounting_transfer' || type === 'cancellation.accounting_transfer') {
    return 'Abrechnung des Vorgangs öffnen und die Übertragung manuell wiederholen (Recht lexware.manual_transfer); Lexware-Verbindung in den Einstellungen prüfen.';
  }
  if (type === 'lexware.event.process') {
    return 'Lexware-Ereignis nicht verarbeitet: Einstellungen → Lexware „Zahlungsstatus abgleichen“ (pnpm lexware:reconcile) für die betroffene Rechnung.';
  }
  if (type === 'invoice.delivery') {
    return 'Rechnungsmail nicht zugestellt: Zustellung unter Einstellungen → Kommunikation erneut senden; Rechnung bleibt in Lexware verfügbar.';
  }
  if (type.startsWith('voucher.')) {
    return 'Gutschein prüfen (Vorgang/Abrechnung); Backfill idempotent mit `pnpm voucher:ensure`.';
  }
  if (type === 'push.send') {
    return 'Push ist rein informativ (at-least-once); kein Fachzustand betroffen. Gerät/Abo unter Einstellungen → Kommunikation → Push prüfen.';
  }
  if (type.startsWith('whatsapp.')) {
    return 'WhatsApp-Versand/Medienabruf fehlgeschlagen: Konversation im Vorgang prüfen und Antwort erneut senden; Zugang unter Einstellungen → Kommunikation prüfen.';
  }
  if (type === 'communication.scan_due' || type === 'communication.cleanup_retention') {
    return 'Systemlauf (Scanner/Retention): Ursache im Worker-Log (jobId) prüfen; der nächste Lauf wird automatisch eingereiht.';
  }
  if (type.startsWith('demo.')) {
    return 'Nur Demo-Umgebung: Einstellungen → Demo (Storage-Bereinigung) prüfen.';
  }
  return 'Ursache im Worker-Log (jobId) prüfen und die fachliche Aktion nach Behebung erneut auslösen; Jobs kehren nie automatisch aus „dead“ zurück.';
}

type JobRow = typeof integrationJobs.$inferSelect;

function toEntry(row: JobRow, state: JobMonitorState): JobMonitorEntry {
  return {
    id: row.id,
    type: row.type,
    state,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    nextRunAt: state === 'retrying' ? row.runAt.toISOString() : null,
    lastError: row.lastError,
    references: extractJobReferences(row.payload),
    guidance: jobGuidance(row.type),
  };
}

/** Lesender Schnappschuss der Jobqueue für Operatoren (system.settings). */
export async function loadJobMonitorSnapshot(db: Database): Promise<JobMonitorSnapshot> {
  const generatedAt = new Date();
  const since24h = new Date(generatedAt.getTime() - 24 * 60 * 60 * 1000);
  const [countRow] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${integrationJobs.status} = 'pending' and ${integrationJobs.attempts} = 0)`,
      processing: sql<number>`count(*) filter (where ${integrationJobs.status} = 'processing')`,
      retrying: sql<number>`count(*) filter (where ${integrationJobs.status} = 'pending' and ${integrationJobs.attempts} > 0)`,
      dead: sql<number>`count(*) filter (where ${integrationJobs.status} = 'dead')`,
      succeededLast24h: sql<number>`count(*) filter (where ${integrationJobs.status} = 'succeeded' and ${integrationJobs.updatedAt} > ${since24h})`,
      lastSucceededAt: sql<Date | null>`max(${integrationJobs.updatedAt}) filter (where ${integrationJobs.status} = 'succeeded')`,
      oldestDueAt: sql<Date | null>`min(${integrationJobs.runAt}) filter (where ${integrationJobs.status} = 'pending' and ${integrationJobs.runAt} <= ${generatedAt})`,
    })
    .from(integrationJobs);
  const dead = await db
    .select()
    .from(integrationJobs)
    .where(eq(integrationJobs.status, 'dead'))
    .orderBy(desc(integrationJobs.updatedAt))
    .limit(JOB_MONITOR_LIST_LIMIT);
  const retrying = await db
    .select()
    .from(integrationJobs)
    .where(and(eq(integrationJobs.status, 'pending'), gt(integrationJobs.attempts, 0)))
    .orderBy(desc(integrationJobs.updatedAt))
    .limit(JOB_MONITOR_LIST_LIMIT);
  const n = (value: unknown): number => Number(value ?? 0);
  const at = (value: unknown): Date | null => {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const lastSucceededAt = at(countRow?.lastSucceededAt);
  const oldestDueAt = at(countRow?.oldestDueAt);
  const overdueSeconds =
    oldestDueAt === null
      ? 0
      : Math.max(0, Math.floor((generatedAt.getTime() - oldestDueAt.getTime()) / 1000));
  return {
    generatedAt: generatedAt.toISOString(),
    counts: {
      pending: n(countRow?.pending),
      processing: n(countRow?.processing),
      retrying: n(countRow?.retrying),
      dead: n(countRow?.dead),
      succeededLast24h: n(countRow?.succeededLast24h),
    },
    worker: {
      lastSucceededAt: lastSucceededAt === null ? null : lastSucceededAt.toISOString(),
      oldestDueAt: oldestDueAt === null ? null : oldestDueAt.toISOString(),
      overdueSeconds,
      stalled: overdueSeconds > WORKER_STALL_SECONDS,
    },
    dead: dead.map((row) => toEntry(row, 'dead')),
    retrying: retrying.map((row) => toEntry(row, 'retrying')),
  };
}
