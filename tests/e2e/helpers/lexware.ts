import { execFileSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';
import { TEST_DATABASE_URL } from './seed.ts';

/**
 * Phase-10-Helfer (Lexware Office gegen den lokalen Contract-Fake).
 * Ausschließlich additiv zu den Phase-9-Helfern (settlement.ts).
 *
 * - Fake-Steuerung über `/__control/*` des Fakes (Port 4555, siehe
 *   playwright.config.ts) – kein Lexware-Aufruf, kein echter Account.
 * - Webhooks: Body vom Fake signieren lassen (`sign-webhook`) und an die
 *   Lexware-API-Instanz (Port 3104) posten – danach Jobs über `mock-run-jobs`.
 * - UI-Wege (Einstellungen, Steuerkonfiguration) laufen über die echte Staff-UI.
 */

/** Fake-Lexware (Contract-Fake) – Ports/IDs identisch zu playwright.config.ts. */
export const LEXWARE_FAKE_ORIGIN = 'http://127.0.0.1:4555';
/** API-Instanz mit Lexware-Provider (Projekt `lexware`). */
export const LEXWARE_API_ORIGIN = 'http://127.0.0.1:3104';
export const LEXWARE_ORGANIZATION_ID = 'e2e-org-00000000-0000-4000-8000-000000000001';
export const LEXWARE_FAKE_API_KEY = 'e2e-fake-lexware-key';
export const LEXWARE_FAKE_COMPANY = 'Miet-Royal Testfirma (FAKE)';

export interface FakeInvoiceSummary {
  id: string;
  voucherNumber: string | null;
  voucherStatus: 'draft' | 'open' | 'paid' | 'voided';
  totalGrossAmount: number;
  remark?: string;
  address: Record<string, unknown>;
  lineItems: Record<string, unknown>[];
}

export interface FakeContactSummary {
  id: string;
  version: number;
  person?: { firstName?: string; lastName: string };
  company?: { name: string };
  addresses?: { billing?: Record<string, unknown>[] };
  emailAddresses?: { business?: string[] };
}

async function control<T = Record<string, unknown>>(
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(`${LEXWARE_FAKE_ORIGIN}/__control/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Fake-Steuerung ${action} fehlgeschlagen: ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Fake vollständig zurücksetzen (Kontakte, Rechnungen, Subscriptions, Fehlerinjektionen). */
export async function resetFake(): Promise<void> {
  await control('reset');
}

export async function fakeInvoices(): Promise<FakeInvoiceSummary[]> {
  return (await control<{ invoices: FakeInvoiceSummary[] }>('invoices')).invoices;
}

export async function fakeContacts(): Promise<FakeContactSummary[]> {
  return (await control<{ contacts: FakeContactSummary[] }>('contacts')).contacts;
}

export async function fakeSubscriptions(): Promise<{ eventType: string }[]> {
  return (await control<{ subscriptions: { eventType: string }[] }>('subscriptions')).subscriptions;
}

export async function fakeRequestLog(): Promise<
  { method: string; path: string; status: number }[]
> {
  return (
    await control<{ requests: { method: string; path: string; status: number }[] }>('request-log')
  ).requests;
}

export interface FailNextOptions {
  /** Regex gegen `${METHOD} ${pathname}`, z. B. `POST /v1/invoices`. */
  match: string;
  status: number;
  times?: number;
  retryAfterSeconds?: number;
  /** `after_create`: Ressource anlegen, Antwort verschlucken (Unknown Outcome). */
  mode?: 'status' | 'hang' | 'after_create';
}

export async function failNext(options: FailNextOptions): Promise<void> {
  await control('fail-next', { times: 1, ...options });
}

export async function setInvoicePaid(invoiceId: string, paidDate?: string): Promise<void> {
  await control('invoice-paid', { invoiceId, ...(paidDate === undefined ? {} : { paidDate }) });
}

export async function setInvoiceVoided(invoiceId: string): Promise<void> {
  await control('invoice-voided', { invoiceId });
}

export async function setInvoiceDeleted(invoiceId: string): Promise<void> {
  await control('invoice-deleted', { invoiceId });
}

/** Fälligkeitsdatum (YYYY-MM-DD) setzen – Vergangenheit ⇒ überfällig. */
export async function setInvoiceDueDate(invoiceId: string, dueDate: string): Promise<void> {
  await control('invoice-due-date', { invoiceId, dueDate });
}

export interface SeedContactInput {
  email?: string;
  lastName?: string;
  companyName?: string;
  person?: { firstName?: string; lastName: string };
  company?: { name: string };
  addresses?: { billing?: Record<string, unknown>[] };
}

/** Kontakt direkt im Fake anlegen (bestehender Lexware-Kunde). Liefert die Kontakt-ID. */
export async function seedContact(input: SeedContactInput): Promise<string> {
  return (await control<{ id: string }>('seed-contact', { ...input })).id;
}

export interface WebhookPayload {
  eventType: string;
  resourceId: string;
  eventDate?: string;
  organizationId?: string;
}

/** Webhook-Body vom Fake signieren lassen (RSA-SHA512, festes Fake-Schlüsselpaar). */
export async function signWebhook(
  payload: WebhookPayload,
): Promise<{ body: string; signature: string }> {
  return control<{ body: string; signature: string }>('sign-webhook', { ...payload });
}

/** Rohen Body mit Signatur-Header an `<API>/webhooks/lexware` senden (ohne Staff-Login). */
export async function postWebhook(
  apiOrigin: string,
  body: string,
  signature: string,
): Promise<Response> {
  return fetch(`${apiOrigin}/webhooks/lexware`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Lxo-Signature': signature },
    body,
  });
}

/** Signierten Webhook zustellen (Fake-Signatur) – liefert den HTTP-Status der API. */
export async function postSignedWebhook(
  apiOrigin: string,
  payload: WebhookPayload,
): Promise<number> {
  const signed = await signWebhook(payload);
  const response = await postWebhook(apiOrigin, signed.body, signed.signature);
  return response.status;
}

/**
 * Lexware-/Steuer-Zustand der Testdatenbank zurücksetzen, den der Basis-Seed
 * (apps/api/scripts/e2e-seed.ts) nicht anfasst: Integrationsstatus,
 * Webhook-Events, Rate-Limit-Slots, Steuerkonfiguration (inkl. globalem
 * taxType in system_settings). Läuft über `pg` aus dem API-Workspace.
 */
export function resetLexwareE2eState(options: { onlyTaxConfig?: boolean } = {}): void {
  const statements =
    options.onlyTaxConfig === true
      ? [
          'TRUNCATE accounting_tax_config',
          "DELETE FROM system_settings WHERE key = 'accounting_lexware_tax_type'",
        ]
      : [
          'TRUNCATE accounting_tax_config',
          "DELETE FROM system_settings WHERE key = 'accounting_lexware_tax_type'",
          'TRUNCATE lexware_webhook_events',
          'TRUNCATE lexware_rate_limit',
          'TRUNCATE lexware_integration_state',
        ];
  const script = [
    "const { Pool } = require('pg');",
    'const pool = new Pool({ connectionString: process.env.DATABASE_URL });',
    '(async () => {',
    `  for (const sql of ${JSON.stringify(statements)}) await pool.query(sql);`,
    '  await pool.end();',
    '})().catch((e) => { console.error(e); process.exit(1); });',
  ].join('\n');
  // Ohne Shell (execFile): keine Quoting-Probleme mit dem Skripttext.
  execFileSync('node', ['-e', script], {
    cwd: `${import.meta.dirname}/../../../apps/api`,
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
}

// ── UI-Wege ─────────────────────────────────────────────────────────────

/** Einstellungen → Abschnitt Lexware (nur system.settings). */
export async function openLexwareSettings(staff: Page) {
  await staff.goto('/einstellungen');
  await expect(staff.getByTestId('lexware-section')).toBeVisible();
}

/** „Verbindung prüfen“ auf der Einstellungsseite → Status „Verbunden“. */
export async function checkLexwareConnection(staff: Page) {
  await openLexwareSettings(staff);
  await staff.getByTestId('lexware-check-connection').click();
  await expect(staff.getByTestId('lexware-status')).toContainText('Verbunden');
}

/** Steuerkonfiguration: synthetische Testwerte setzen (nur Nicht-Production). */
export async function applySyntheticTax(staff: Page) {
  await staff.goto('/einstellungen/steuern');
  await expect(staff.getByTestId('tax-config-page')).toBeVisible();
  await staff.getByTestId('tax-apply-synthetic').click();
  // Bestätigungsdialog (UI, Vertrag §7: Überschreiben aller Kategorien).
  await staff.getByTestId('tax-synthetic-confirm').click();
  await expect(staff.getByTestId('tax-synthetic-badge')).toContainText('SYNTHETISCH');
  await expect(staff.getByTestId('tax-complete')).toBeVisible();
}

/** Kunden-ID eines Vorgangs (Staff-API, gleiche Browser-Session). */
export async function customerIdOfProcess(staff: Page, processId: string): Promise<string> {
  const response = await staff.request.get(`/api/staff/processes/${processId}`);
  expect(response.ok()).toBe(true);
  const data = (await response.json()) as { process: { customerId: string } };
  return data.process.customerId;
}

/** Als Admin: einer Mitarbeiterin ein einzelnes Recht per Override gewähren. */
export async function grantPermission(staff: Page, email: string, permissionKey: string) {
  const users = await staff.request.get('/api/staff/users');
  expect(users.ok()).toBe(true);
  const { users: list } = (await users.json()) as { users: { id: string; email: string }[] };
  const user = list.find((entry) => entry.email === email);
  expect(user).toBeDefined();
  const response = await staff.request.post(`/api/staff/users/${user!.id}/overrides`, {
    data: { permissionKey, effect: 'allow' },
  });
  expect(response.ok()).toBe(true);
}
