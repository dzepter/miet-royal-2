/**
 * Phase-11-E2E-Szenario K (Order §73): Lexware-Zahlungsrückmeldung – signierter
 * `payment.changed`-Webhook ⇒ Job auf der PostgreSQL-Queue ⇒ exakt EIN
 * Wiedermieter-Gutschein, auch bei doppeltem Webhook. Läuft NUR im Playwright-
 * Projekt `lexware` (zweite API-/Staff-Instanz gegen den Contract-Fake, siehe
 * playwright.config.ts) – nie gegen einen echten Account.
 *
 * Unabhängig: Basis-Seed + Lexware-Zustand + Fake-Reset zu Beginn, eigene
 * Buchung über die echten Phase-3/4/6/7-Wege. Worker nur über `mock-run-jobs`;
 * Zahlung nur über Fake-Steuerung + signierten Webhook (keine Mock-Zahlung
 * mit Lexware). Ausschließlich synthetische Testdaten.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  applySyntheticTax,
  checkLexwareConnection,
  fakeInvoices,
  LEXWARE_API_ORIGIN,
  openLexwareSettings,
  postSignedWebhook,
  resetFake,
  resetLexwareE2eState,
  setInvoicePaid,
} from '../helpers/lexware.ts';
import { ADMIN_EMAIL, ADMIN_PASSWORD, resetE2eDatabase } from '../helpers/seed.ts';
import {
  cleanMachine,
  ensureInitialStock,
  issueAndReturn,
  login,
  openSettlement,
  runDueJobs,
} from '../helpers/settlement.ts';
import {
  allVouchers,
  expectCustomerVoucherCard,
  expectNoCustomerVoucherCard,
  LABEL_DELIVERY_PENDING,
  LABEL_STATUS_ACTIVE,
  NEVER_SENT,
  processDetail,
  vouchersOfCustomer,
} from '../helpers/voucher.ts';

test.describe.configure({ mode: 'serial' });

const LABEL_TRANSFERRED = 'An Buchhaltung übertragen';

let staff: Page; // Erika (Admin)
let customerPage: Page;

test.beforeAll(async ({ browser }) => {
  resetE2eDatabase();
  resetLexwareE2eState();
  await resetFake();
  staff = await browser.newPage();
  customerPage = await browser.newPage();
});
test.afterAll(async () => {
  await staff.close();
  await customerPage.close();
});

test('K: Lexware: Rechnung bezahlt → signierter payment.changed-Webhook (doppelt) → Job → genau ein Gutschein, Versand ausstehend', async () => {
  test.setTimeout(600_000);
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await ensureInitialStock(staff, 'sirup-kirsche', 'Sirup Kirsche', 10);
  await ensureInitialStock(staff, 'sirup-waldmeister', 'Sirup Waldmeister', 10);
  await ensureInitialStock(staff, 'strohhalme-25', 'Strohhalme (25 Stück)', 20);
  await ensureInitialStock(staff, 'becher-25', 'Becher (25 Stück)', 40);
  await ensureInitialStock(staff, 'mischkanister-6l', '6-L-Mischkanister', 10, { optional: true });

  // Lexware verbunden, Webhooks eingerichtet, Steuerkonfiguration synthetisch (wie Phase-10-A).
  await checkLexwareConnection(staff);
  await staff.getByTestId('lexware-section').getByTestId('lexware-setup-webhooks').click();
  await expect(staff.getByTestId('lexware-webhook-status')).not.toContainText(/nicht/i);
  await applySyntheticTax(staff);
  await openLexwareSettings(staff);
  await expect(staff.getByTestId('lexware-tax-status')).toContainText(/vollständig/);

  const { processId, processNumber } = await issueAndReturn(staff, customerPage, {
    firstName: 'Lena',
    lastName: 'Lexware',
    email: 'lena@e2e.example',
    machineCodes: ['MR-10-01-01'],
  });
  const customerId = (await processDetail(staff, processId)).customerId;
  expect(allVouchers()).toHaveLength(0);

  // Transfer über den Worker ⇒ finale Rechnung im Fake, Zahlung offen.
  await openSettlement(staff, processId);
  await expect(staff.getByTestId('mock-badge')).toHaveCount(0);
  await runDueJobs(staff);
  await expect(staff.getByTestId('settlement-status')).toContainText(LABEL_TRANSFERRED);
  await expect(staff.getByTestId('payment-status')).toContainText('Offen');
  const invoice = (await fakeInvoices()).find(
    (entry) => entry.remark?.includes(processNumber) === true,
  );
  expect(invoice).toBeDefined();

  // Reinigung abgeschlossen, aber nicht bezahlt ⇒ noch kein Gutschein (§47).
  await cleanMachine(staff, 'MR-10-01-01');
  await openSettlement(staff, processId);
  await runDueJobs(staff);
  expect(vouchersOfCustomer(customerId)).toHaveLength(0);
  await expectNoCustomerVoucherCard(staff, customerId);

  // Bezahlt in Lexware ⇒ zwei signierte Webhooks (Duplikat) ⇒ Jobs ⇒ genau EIN Gutschein.
  await setInvoicePaid(invoice!.id);
  const payload = { eventType: 'payment.changed', resourceId: invoice!.id };
  expect(await postSignedWebhook(LEXWARE_API_ORIGIN, payload)).toBe(202);
  expect([200, 202]).toContain(await postSignedWebhook(LEXWARE_API_ORIGIN, payload));
  await openSettlement(staff, processId);
  await expect(staff.getByTestId('payment-status')).toContainText('Offen');
  await runDueJobs(staff);
  await expect(staff.getByTestId('payment-status')).toContainText('Bezahlt');
  // Ggf. nachgelagert eingereihte Gutschein-Jobs (Trigger A nach Commit) verarbeiten.
  await runDueJobs(staff);
  const created = vouchersOfCustomer(customerId);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    status: 'active',
    discount_percent: 20,
    delivery_status: 'pending',
    delivered_at: null,
    origin_process_id: processId,
  });
  expect(created[0]!.delivery_code_ciphertext).not.toBeNull();
  expect(allVouchers()).toHaveLength(1);

  // Erneuter Webhook + Worker ⇒ weiterhin genau einer (§10/§48).
  expect([200, 202]).toContain(await postSignedWebhook(LEXWARE_API_ORIGIN, payload));
  await runDueJobs(staff);
  expect(allVouchers()).toHaveLength(1);

  await expectCustomerVoucherCard(staff, customerId, {
    statusLabel: LABEL_STATUS_ACTIVE,
    deliveryLabel: LABEL_DELIVERY_PENDING,
    maskedReference: `MR20-••••-••••-${created[0]!.code_suffix}`,
  });
  await staff.goto(`/vorgaenge/${processId}`);
  const line = staff.getByTestId('process-voucher');
  await expect(line).toContainText('20-%-Wiedermieter-Gutschein erstellt');
  await expect(line).toContainText(LABEL_DELIVERY_PENDING);
  await expect(line).not.toContainText(NEVER_SENT);
  const api = await processDetail(staff, processId);
  expect(api.voucher?.id).toBe(created[0]!.id);
  expect(api.text).not.toContain(created[0]!.code_hash);
  expect(api.text).not.toContain('deliveryCodeCiphertext');
});
