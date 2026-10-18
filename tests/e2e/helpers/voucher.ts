import { execFileSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';
import { TEST_DATABASE_URL, WEB_ORIGIN } from './seed.ts';

/**
 * Phase-11-Helfer (Wiedermieter-Gutschein). Ausschließlich additiv zu den
 * Phase-9/10-Helfern (settlement.ts, lexware.ts).
 *
 * - Der Gutscheincode existiert in der Datenbank nur als SHA-256-Hash plus
 *   verschlüsselte Versandkopie; UI und API zeigen ihn nie (Order §§12/14).
 *   Für die Angebots-Szenarien liest `revealVoucherCode` die Versandkopie
 *   über den Phase-12-Pfad (serverseitige Entschlüsselung im Testskript
 *   apps/api/scripts/e2e-voucher-reveal.ts) – keine Produktroute, keine
 *   DB-Mutation, und zugleich der Nachweis, dass die Kopie entschlüsselbar ist.
 * - Datenbank-Lesezugriffe laufen wie in lexware.ts über `pg` aus dem
 *   API-Workspace (`queryTestDb`), nur gegen die Testdatenbank.
 * - UI-Wege (Vorgang/Anfrage/Angebot für einen BESTEHENDEN Kunden, Gutschein
 *   anwenden/entfernen, senden, online annehmen) laufen über die echte
 *   Staff-/Web-App.
 */

export const VOUCHER_INVALID_MESSAGE = 'Gutschein ist ungültig oder nicht verwendbar.';
export const VOUCHER_NOT_COMBINABLE_MESSAGE =
  'Gutschein kann nicht mit einem weiteren Rabatt oder Sonderpreis kombiniert werden.';
export const VOUCHER_RESERVED_ELSEWHERE = /bereits für ein anderes Angebot reserviert/;
export const LABEL_DELIVERY_PENDING = 'Versand ausstehend';
export const LABEL_STATUS_ACTIVE = 'Aktiv';
export const LABEL_STATUS_RESERVED = 'Für Angebot reserviert';
export const LABEL_STATUS_REDEEMED = 'Eingelöst';
/** Nie in der UI: Versand findet in Phase 11 nicht statt. */
export const NEVER_SENT = /gesendet|versendet/i;

const API_WORKSPACE_DIR = `${import.meta.dirname}/../../../apps/api`;
const REPO_ROOT = `${import.meta.dirname}/../../..`;

// ── Datenbank (nur lesen) ───────────────────────────────────────────────

/** Parametrisierte Abfrage gegen die Testdatenbank; Zeilen als JSON (Zeitstempel = ISO-Strings). */
export function queryTestDb<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  const script = [
    "const { Pool } = require('pg');",
    'const pool = new Pool({ connectionString: process.env.DATABASE_URL });',
    '(async () => {',
    '  const result = await pool.query(process.env.E2E_SQL, JSON.parse(process.env.E2E_PARAMS));',
    "  process.stdout.write(JSON.stringify(result.rows) + '\\n');",
    '  await pool.end();',
    '})().catch((e) => { console.error(e); process.exit(1); });',
  ].join('\n');
  // Ohne Shell (execFile): SQL/Parameter über die Umgebung, keine Quoting-Probleme.
  const output = execFileSync('node', ['-e', script], {
    cwd: API_WORKSPACE_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      E2E_SQL: sql,
      E2E_PARAMS: JSON.stringify(params),
    },
  });
  return JSON.parse(output.toString('utf8')) as T[];
}

export interface VoucherDbRow {
  id: string;
  customer_id: string;
  origin_process_id: string;
  origin_settlement_id: string;
  discount_percent: number;
  code_hash: string;
  code_suffix: string;
  status: 'active' | 'reserved' | 'redeemed';
  activated_at: string;
  expires_at: string;
  reserved_offer_id: string | null;
  reserved_at: string | null;
  delivery_status: 'pending' | 'sent';
  delivery_problem_code: string | null;
  delivered_at: string | null;
  delivery_code_ciphertext: string | null;
  version: number;
}

export function vouchersOfCustomer(customerId: string): VoucherDbRow[] {
  return queryTestDb<VoucherDbRow>(
    'SELECT * FROM vouchers WHERE customer_id = $1 ORDER BY created_at ASC',
    [customerId],
  );
}

export function voucherById(voucherId: string): VoucherDbRow {
  const rows = queryTestDb<VoucherDbRow>('SELECT * FROM vouchers WHERE id = $1', [voucherId]);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

export function allVouchers(): VoucherDbRow[] {
  return queryTestDb<VoucherDbRow>('SELECT * FROM vouchers ORDER BY created_at ASC');
}

export interface VoucherRedemptionDbRow {
  id: string;
  voucher_id: string;
  offer_id: string;
  booking_id: string;
  process_id: string;
  redeemed_at: string;
  expires_at_before_redemption: string;
  remaining_validity_seconds: number;
  cancellation_id: string | null;
  reactivated_at: string | null;
  final_consumption_reason: string | null;
}

export function redemptionsOfVoucher(voucherId: string): VoucherRedemptionDbRow[] {
  return queryTestDb<VoucherRedemptionDbRow>(
    'SELECT * FROM voucher_redemptions WHERE voucher_id = $1 ORDER BY redeemed_at ASC',
    [voucherId],
  );
}

/** Buchung eines Vorgangs (Gutschein-Snapshot, kein Klartext). */
export function bookingOfProcess(processId: string): {
  id: string;
  voucher_id: string | null;
  voucher_snapshot: Record<string, unknown> | null;
  totals_snapshot: Record<string, unknown> | null;
} {
  const rows = queryTestDb<{
    id: string;
    voucher_id: string | null;
    voucher_snapshot: Record<string, unknown> | null;
    totals_snapshot: Record<string, unknown> | null;
  }>(
    'SELECT id, voucher_id, voucher_snapshot, totals_snapshot FROM bookings WHERE process_id = $1',
    [processId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

export function cancellationOfProcess(processId: string): {
  id: string;
  created_at: string;
  fee_percent: number;
} {
  const rows = queryTestDb<{ id: string; created_at: string; fee_percent: number }>(
    'SELECT id, created_at, fee_percent FROM cancellations WHERE process_id = $1',
    [processId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/**
 * Klartextcode (kompakt `MR20XXXXXXXXXXXX`) aus der verschlüsselten
 * Versandkopie – über den Phase-12-Pfad des Produkts (siehe Kopfkommentar).
 */
export function revealVoucherCode(voucherId: string): string {
  const output = execFileSync(
    'pnpm',
    ['--filter', '@mietroyal/api', 'exec', 'tsx', 'scripts/e2e-voucher-reveal.ts'],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        APP_ENV: 'development',
        DATABASE_URL: TEST_DATABASE_URL,
        LOG_LEVEL: 'warn',
        VOUCHER_ID: voucherId,
      },
    },
  ).toString('utf8');
  const line = output
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('{'))
    .at(-1);
  expect(line, 'Reveal-Skript lieferte keinen Code').toBeDefined();
  const { code } = JSON.parse(line!) as { code: string };
  expect(code).toMatch(/^MR20[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12}$/);
  return code;
}

/** Anzeigeform MR20-XXXX-XXXX-XXXX. */
export function formatVoucherCode(compact: string): string {
  const body = compact.slice(4);
  return ['MR20', body.slice(0, 4), body.slice(4, 8), body.slice(8, 12)].join('-');
}

/** Syntaktisch gültiger, aber nicht existierender Code (deterministisch, nur Test). */
export function unknownVoucherCode(): string {
  return 'MR20-ABCD-EFGH-JKMN';
}

/** Prüft, dass ein Text den Code in keiner Form (kompakt, formatiert, Körper) enthält. */
export function expectNoPlaintextCode(text: string, compact: string): void {
  expect(text).not.toContain(compact);
  expect(text).not.toContain(formatVoucherCode(compact));
  expect(text).not.toContain(compact.slice(4));
}

// ── API (Staff-Session des Browsers) ────────────────────────────────────

export interface VoucherSummaryApi {
  id: string;
  status: 'active' | 'reserved' | 'redeemed' | 'expired';
  statusLabel: string;
  expiresAt: string;
  maskedReference: string;
  deliveryStatus: 'pending' | 'sent';
  deliveryLabel: string;
  reservedOfferId: string | null;
  originProcessId: string;
  originProcessNumber: string | null;
}

/** `GET /staff/customers/:id` – Rohtext + geparst (Klartext-Prüfung + Felder). */
export async function customerDetail(
  staff: Page,
  customerId: string,
): Promise<{ text: string; voucher: VoucherSummaryApi | null }> {
  const response = await staff.request.get(`/api/staff/customers/${customerId}`);
  expect(response.ok()).toBe(true);
  const text = await response.text();
  const data = JSON.parse(text) as { voucher: VoucherSummaryApi | null };
  return { text, voucher: data.voucher ?? null };
}

export async function processDetail(
  staff: Page,
  processId: string,
): Promise<{ text: string; customerId: string; voucher: VoucherSummaryApi | null }> {
  const response = await staff.request.get(`/api/staff/processes/${processId}`);
  expect(response.ok()).toBe(true);
  const text = await response.text();
  const data = JSON.parse(text) as {
    process: { customerId: string };
    voucher: VoucherSummaryApi | null;
  };
  return { text, customerId: data.process.customerId, voucher: data.voucher ?? null };
}

export interface OfferVersionApi {
  id: string;
  status: string;
  effectiveStatus: string;
  expiresAt: string | null;
  machineSubtotalCents: number | null;
  fixedTotalCents: number | null;
  discountType: string | null;
  voucher: {
    voucherId: string;
    discountPercent: number;
    machineSubtotalBeforeVoucherCents: number;
    voucherDiscountCents: number;
    machineSubtotalAfterVoucherCents: number;
    maskedReference: string;
    expiresAt: string | null;
  } | null;
}

/** `GET /staff/processes/:id/offer` – Rohtext + aktuelle Version. */
export async function offerOfProcess(
  staff: Page,
  processId: string,
): Promise<{ text: string; offerId: string; current: OfferVersionApi }> {
  const response = await staff.request.get(`/api/staff/processes/${processId}/offer`);
  expect(response.ok()).toBe(true);
  const text = await response.text();
  const data = JSON.parse(text) as {
    offer: { offer: { id: string; currentVersionId: string }; versions: OfferVersionApi[] } | null;
  };
  expect(data.offer).not.toBeNull();
  const current = data.offer!.versions.find((v) => v.id === data.offer!.offer.currentVersionId);
  expect(current).toBeDefined();
  return { text, offerId: data.offer!.offer.id, current: current! };
}

/** Gutschein per API anwenden – liefert Status + Rohantwort (Neutralitätsvergleich). */
export async function applyVoucherViaApi(
  staff: Page,
  versionId: string,
  code: string,
): Promise<{ status: number; body: string }> {
  const response = await staff.request.post(`/api/staff/offer-versions/${versionId}/voucher`, {
    data: { code },
  });
  return { status: response.status(), body: await response.text() };
}

// ── UI-Wege ─────────────────────────────────────────────────────────────

/** Kunde über die Kundenliste anlegen; liefert die Kunden-ID. */
export async function createCustomerViaUi(
  staff: Page,
  input: { firstName: string; lastName: string; email: string },
): Promise<string> {
  await staff.goto('/kunden');
  await staff.getByRole('button', { name: 'Kunde anlegen' }).click();
  await staff.getByLabel('Vorname').fill(input.firstName);
  await staff.getByLabel('Nachname').fill(input.lastName);
  await staff.getByLabel('E-Mail (optional)').fill(input.email);
  await staff.getByRole('button', { name: 'Kunde anlegen' }).click();
  await expect(
    staff.getByRole('heading', { name: `${input.firstName} ${input.lastName}` }),
  ).toBeVisible();
  await staff.waitForURL(/\/kunden\/[0-9a-f-]{36}$/);
  return /\/kunden\/([0-9a-f-]{36})/.exec(staff.url())![1]!;
}

export interface DraftOfferOptions {
  /** Bestehender Kunde (Kundenseite → „Vorgang anlegen“). */
  customerId: string;
  machineLabel?: '1×8 L' | '2×8 L' | '1×10 L' | '2×10 L';
  /** Eventdatum (YYYY-MM-DD); Standard heute + 30 Tage. */
  eventDate?: string;
  /** Zusätzlicher Sirup auf Kommission (Anfrage: „<Name> – zusätzlich (Kommission)“). */
  extraSyrup?: { name: string; liters: number };
  /** 6-L-Mischkanister (Kaufartikel). */
  purchaseCanisters?: number;
  /** Lieferung inkl. manuellem Lieferpreis im Entwurf (EUR, z. B. „49,00“). */
  delivery?: { street: string; postalCode: string; city: string; priceEuro: string };
}

/**
 * Neuer Vorgang + Anfrage + Angebotsentwurf (Version 1) für einen bestehenden
 * Kunden – NICHT versenden. Liefert IDs; die Angebotsseite bleibt geöffnet.
 */
export async function draftOfferForCustomer(
  staff: Page,
  options: DraftOfferOptions,
): Promise<{ processId: string; processNumber: string; offerId: string; versionId: string }> {
  await staff.goto(`/kunden/${options.customerId}`);
  await expect(staff.getByRole('heading', { name: 'Stammdaten' })).toBeVisible();
  await staff.getByRole('button', { name: 'Vorgang anlegen' }).click();
  const numberHeading = staff.getByRole('heading', { name: /^MR-\d{4}-\d{4,}$/ });
  await expect(numberHeading).toBeVisible();
  const processNumber = (await numberHeading.innerText()).trim();
  const processId = /\/vorgaenge\/([0-9a-f-]{36})/.exec(staff.url())![1]!;
  const draft = await draftOfferForProcess(staff, processId, options);
  return { processId, processNumber, ...draft };
}

/** Anfrage + Angebotsentwurf (Version 1) für einen bestehenden, noch leeren Vorgang. */
export async function draftOfferForProcess(
  staff: Page,
  processId: string,
  options: Omit<DraftOfferOptions, 'customerId'>,
): Promise<{ offerId: string; versionId: string }> {
  await staff.goto(`/vorgaenge/${processId}/anfrage`);
  const eventDate =
    options.eventDate ?? new Date(Date.now() + 30 * 24 * 3_600_000).toISOString().slice(0, 10);
  await staff.getByLabel('Eventdatum').fill(eventDate);
  await staff.getByLabel('Gästezahl (exakt)').fill('30');
  await staff.getByLabel('Anlass').selectOption({ label: 'Geburtstag' });
  await staff
    .getByLabel('Gewünschter Maschinentyp')
    .selectOption({ label: options.machineLabel ?? '1×10 L' });
  await staff.getByLabel('Sirup Kirsche – gratis (L)').fill('1');
  if (options.extraSyrup !== undefined) {
    await staff
      .getByLabel(`${options.extraSyrup.name} – zusätzlich (Kommission)`)
      .fill(String(options.extraSyrup.liters));
  }
  if (options.purchaseCanisters !== undefined && options.purchaseCanisters > 0) {
    await staff.getByLabel('6-L-Mischkanister (Stück)').fill(String(options.purchaseCanisters));
  }
  if (options.delivery !== undefined) {
    await staff.getByLabel('Lieferung anfragen').check();
    await staff.getByLabel('Liefer-/Eventadresse: Straße').fill(options.delivery.street);
    await staff.getByLabel('PLZ', { exact: true }).fill(options.delivery.postalCode);
    await staff.getByLabel('Ort', { exact: true }).fill(options.delivery.city);
  }
  await staff.getByRole('button', { name: 'Anfrage speichern' }).click();
  await expect(staff.getByText('Anfrage gespeichert.')).toBeVisible();

  await staff.goto(`/vorgaenge/${processId}/angebot`);
  await staff.getByRole('button', { name: 'Angebot erstellen (aus Anfrage)' }).click();
  await expect(staff.getByRole('heading', { name: /Version 1/ })).toBeVisible();
  if (options.delivery !== undefined) {
    await staff
      .getByLabel('Lieferpreis (EUR, individuell geprüft)')
      .fill(options.delivery.priceEuro);
    await staff.getByRole('button', { name: 'Lieferpreis speichern' }).click();
    await expect(staff.locator('.error')).toHaveCount(0);
    await staff.reload();
    await expect(staff.getByRole('heading', { name: /Version 1/ })).toBeVisible();
  }
  const { offerId, current } = await offerOfProcess(staff, processId);
  expect(current.effectiveStatus).toBe('draft');
  return { offerId, versionId: current.id };
}

export async function openOfferPage(staff: Page, processId: string): Promise<void> {
  await staff.goto(`/vorgaenge/${processId}/angebot`);
  await expect(staff.getByRole('heading', { name: /Version \d+/ })).toBeVisible();
}

/** Code im Bereich „Gutschein“ eingeben und anwenden; erwartet den Erfolgsblock. */
export async function applyVoucherViaUi(staff: Page, code: string): Promise<void> {
  const section = staff.getByTestId('voucher-section');
  await expect(section).toBeVisible();
  await section.getByTestId('voucher-code-input').fill(code);
  await section.getByTestId('voucher-apply').click();
  await expect(staff.getByTestId('voucher-applied')).toBeVisible();
  await expect(staff.getByTestId('voucher-error')).toHaveCount(0);
}

/** Code anwenden und die neutrale/fachliche Fehlermeldung erwarten (kein Erfolgsblock). */
export async function applyVoucherExpectError(
  staff: Page,
  code: string,
  message: string | RegExp,
): Promise<void> {
  const section = staff.getByTestId('voucher-section');
  await expect(section).toBeVisible();
  await section.getByTestId('voucher-code-input').fill(code);
  await section.getByTestId('voucher-apply').click();
  await expect(staff.getByTestId('voucher-error')).toContainText(message);
  await expect(staff.getByTestId('voucher-applied')).toHaveCount(0);
}

export async function removeVoucherViaUi(staff: Page): Promise<void> {
  await staff.getByTestId('voucher-remove').click();
  await expect(staff.getByTestId('voucher-applied')).toHaveCount(0);
  await expect(staff.getByTestId('voucher-code-input')).toBeVisible();
}

/** Erfolgsblock prüfen: regulär / Abzug / nach Gutschein (Cent) + Gültigkeitsinfo + Maske. */
export async function expectVoucherApplied(
  staff: Page,
  amounts: { regularCents: number; discountCents: number; afterCents: number },
  maskedReference?: string,
): Promise<void> {
  const applied = staff.getByTestId('voucher-applied');
  await expect(applied).toBeVisible();
  await expect(applied).toContainText('20-%-Wiederkehrer-Gutschein');
  await expect(applied).toContainText(`Maschinenmiete regulär: ${euro(amounts.regularCents)}`);
  await expect(applied).toContainText(`Gutschein 20 %: -${euro(amounts.discountCents)}`);
  await expect(applied).toContainText(euro(amounts.afterCents));
  await expect(applied.getByTestId('voucher-valid-until')).toContainText(/gültig bis/);
  if (maskedReference !== undefined) {
    await expect(applied.getByTestId('voucher-reference')).toHaveText(maskedReference);
  }
  const totals = staff.getByTestId('offer-totals-voucher');
  await expect(totals.getByTestId('voucher-machine-regular')).toHaveText(
    euro(amounts.regularCents),
  );
  await expect(totals.getByTestId('voucher-discount')).toHaveText(
    `-${euro(amounts.discountCents)}`,
  );
  await expect(totals.getByTestId('voucher-machine-after')).toHaveText(euro(amounts.afterCents));
}

/** „Angebot versenden“ → öffentlicher Pfad (Test-Outbox-Link). */
export async function sendOfferViaUi(staff: Page): Promise<string> {
  await staff.getByRole('button', { name: 'Angebot versenden' }).click();
  const link = staff.getByTestId('public-offer-link');
  await expect(link).toBeVisible();
  return (await link.innerText()).trim();
}

/** Versand scheitert mit Meldung (z. B. 409 reservierter Gutschein); kein Link. */
export async function sendOfferExpectError(staff: Page, message: string | RegExp): Promise<void> {
  await staff.getByRole('button', { name: 'Angebot versenden' }).click();
  await expect(staff.locator('p.error').first()).toContainText(message);
  await expect(staff.getByTestId('public-offer-link')).toHaveCount(0);
}

/** Öffentliche Angebotsseite öffnen; liefert den Seitentext (Klartext-Prüfung). */
export async function openPublicOffer(customerPage: Page, path: string): Promise<string> {
  await customerPage.goto(`${WEB_ORIGIN}${path}`);
  await expect(
    customerPage.getByRole('button', { name: 'Angebot verbindlich annehmen' }),
  ).toBeVisible();
  return customerPage.content();
}

export async function acceptPublicOffer(customerPage: Page): Promise<void> {
  await customerPage.getByRole('button', { name: 'Angebot verbindlich annehmen' }).click();
  await expect(customerPage.getByRole('heading', { name: 'Vielen Dank!' })).toBeVisible();
}

/** Karte „Wiederkehrer-Gutschein“ auf der Kundenseite prüfen (ohne Code). */
export async function expectCustomerVoucherCard(
  staff: Page,
  customerId: string,
  expected: { statusLabel: string; deliveryLabel?: string; maskedReference?: string },
): Promise<string> {
  await staff.goto(`/kunden/${customerId}`);
  await expect(staff.getByRole('heading', { name: 'Stammdaten' })).toBeVisible();
  const card = staff.getByTestId('customer-voucher');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('customer-voucher-status')).toContainText(expected.statusLabel);
  await expect(card.getByTestId('customer-voucher-delivery')).toContainText(
    expected.deliveryLabel ?? LABEL_DELIVERY_PENDING,
  );
  await expect(card).not.toContainText(NEVER_SENT);
  const reference = card.getByTestId('customer-voucher-reference');
  await expect(reference).toHaveText(/^MR20-••••-••••-[A-Z2-9]{4}$/);
  if (expected.maskedReference !== undefined) {
    await expect(reference).toHaveText(expected.maskedReference);
  }
  return (await reference.innerText()).trim();
}

export async function expectNoCustomerVoucherCard(staff: Page, customerId: string): Promise<void> {
  await staff.goto(`/kunden/${customerId}`);
  await expect(staff.getByRole('heading', { name: 'Stammdaten' })).toBeVisible();
  await expect(staff.getByTestId('customer-voucher')).toHaveCount(0);
}

/** Betrag wie die Staff-/Web-UI (de-DE): „1.234,56 €“. */
export function euro(cents: number): string {
  return `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)} €`;
}
