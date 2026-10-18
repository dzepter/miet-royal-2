import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { queryTestDb } from './voucher.ts';

/**
 * Phase-12-Helfer: Queue-Steuerung ohne Abrechnungsseite.
 *
 * - `runDueJobsViaApi`: dieselbe Mock-Route wie der Button „mock-run-jobs“
 *   (`POST /staff/accounting/mock/run-due-jobs`, system.settings, nie in
 *   production) – verarbeitet bis zu 50 fällige Jobs nacheinander im Runner
 *   der API (alle Phase-9–12-Handler inkl. mail.send, voucher.delivery,
 *   invoice.delivery, push.send, communication.scan_due). Nutzbar auf jeder
 *   Seite (z. B. Angebotsseite nach „Auftragsbestätigung versenden“).
 * - `releaseMailRetries`: Retry-Wartezeit (1 min × 2^n) einer Outbox-Zeile
 *   im Test überspringen – setzt `next_attempt_at` und den `run_at` des
 *   wartenden mail.send-Jobs auf „jetzt“ (reine Zeitverschiebung, keine
 *   fachliche Mutation; Muster wie e2e-backdate-cleaning).
 * - `enqueueScanDue` / `enqueueInboundPoll`: einen Lauf `communication.scan_due`
 *   bzw. `mail.inbound_poll` einreihen (der Worker tut das beim Start; die
 *   E2E-API hat keinen laufenden Worker).
 */

export async function runDueJobsViaApi(page: Page): Promise<{ processed: number; failed: number }> {
  const response = await page.request.post('/api/staff/accounting/mock/run-due-jobs', {
    timeout: 120_000,
  });
  expect(response.ok(), 'Mock-Route run-due-jobs').toBe(true);
  return (await response.json()) as { processed: number; failed: number };
}

export interface MailDeliveryDbRow {
  id: string;
  kind: string;
  process_id: string | null;
  customer_id: string | null;
  booking_id: string | null;
  recipient_email: string;
  subject: string;
  status: 'pending' | 'sending' | 'sent' | 'retry' | 'failed' | 'blocked' | 'outcome_unknown';
  idempotency_key: string;
  message_id: string;
  attempts: number;
  next_attempt_at: string | null;
  sent_at: string | null;
  provider_code: string | null;
  last_error_code: string | null;
  blocked_reason: string | null;
  secret_payload_ciphertext: string | null;
  attachments: { kind: string; documentId?: string; lexwareInvoiceId?: string; filename: string }[];
  context: Record<string, unknown>;
  created_at: string;
}

/** Outbox-Zeilen (älteste zuerst), optional je Vorgang und/oder Art. */
export function mailDeliveries(filter: { processId?: string; kind?: string } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.processId !== undefined) {
    params.push(filter.processId);
    where.push(`process_id = $${params.length}`);
  }
  if (filter.kind !== undefined) {
    params.push(filter.kind);
    where.push(`kind = $${params.length}::mail_delivery_kind`);
  }
  return queryTestDb<MailDeliveryDbRow>(
    `SELECT * FROM mail_deliveries ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
     ORDER BY created_at ASC`,
    params,
  );
}

/** Genau eine Outbox-Zeile der Art für den Vorgang. */
export function singleMailDelivery(processId: string, kind: string): MailDeliveryDbRow {
  const rows = mailDeliveries({ processId, kind });
  expect(rows, `Outbox ${kind}`).toHaveLength(1);
  return rows[0]!;
}

/** Wartezeit wartender Retries überspringen (Outbox + zugehöriger mail.send-Job). */
export function releaseMailRetries(deliveryId: string): void {
  queryTestDb(
    `UPDATE mail_deliveries SET next_attempt_at = now() - interval '1 second'
      WHERE id = $1 AND status = 'retry'`,
    [deliveryId],
  );
  queryTestDb(
    `UPDATE integration_jobs SET run_at = now() - interval '1 second'
      WHERE type = 'mail.send' AND status = 'pending' AND payload->>'deliveryId' = $1`,
    [deliveryId],
  );
}

/** Einen Scan-Lauf `communication.scan_due` sofort fällig einreihen (eindeutiger Schlüssel). */
export function enqueueScanDue(): void {
  queryTestDb(
    `INSERT INTO integration_jobs (type, payload, idempotency_key, max_attempts)
     VALUES ('communication.scan_due', '{}'::jsonb, $1, 3)`,
    [`communication.scan_due:e2e:${randomUUID()}`],
  );
}

/**
 * Einen IMAP-Abruf `mail.inbound_poll` sofort fällig einreihen (sonst nur beim
 * Worker-Start). Der Handler reiht danach selbst den nächsten 2-min-Bucket ein.
 */
export function enqueueInboundPoll(): void {
  queryTestDb(
    `INSERT INTO integration_jobs (type, payload, idempotency_key, max_attempts)
     VALUES ('mail.inbound_poll', '{}'::jsonb, $1, 3)`,
    [`mail.inbound_poll:e2e:${randomUUID()}`],
  );
}

/** Dateien unterhalb des Storage-Verzeichnisses der E2E-API (apps/api/.storage). */
export const E2E_STORAGE_ROOT = `${import.meta.dirname}/../../../apps/api/.storage`;
