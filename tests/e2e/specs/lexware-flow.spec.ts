/**
 * Phase-10-E2E-Szenarien A–N (Order §91): Lexware Office ausschließlich gegen
 * den lokalen Contract-Fake (apps/api/src/lexware/testing/fake-server.ts) –
 * nie gegen einen echten Account. Läuft NUR im Playwright-Projekt `lexware`
 * (zweite API-/Staff-Instanz mit Lexware-Provider, siehe playwright.config.ts);
 * das Standardprojekt bleibt auf dem MOCK-Provider (Phase-1–9-Specs).
 *
 * Unabhängig: Basis-Seed + Lexware-Zustand + Fake-Reset zu Beginn, eigene
 * Buchungen über die echten Phase-3/4/6/7-Wege (helpers/settlement.ts).
 * Worker nur über `mock-run-jobs` (auch mit Lexware außerhalb production),
 * Zahlungs-/Belegänderungen nur über die Fake-Steuerung + signierte Webhooks.
 * Ausschließlich synthetische Testdaten.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { acceptedBooking } from '../helpers/booking.ts';
import { clearSink, mailsMatching, pdfAttachment } from '../helpers/mail.ts';
import {
  applySyntheticTax,
  checkLexwareConnection,
  customerIdOfProcess,
  failNext,
  fakeContacts,
  fakeInvoices,
  fakeRequestLog,
  fakeSubscriptions,
  grantPermission,
  LEXWARE_API_ORIGIN,
  LEXWARE_FAKE_API_KEY,
  LEXWARE_FAKE_COMPANY,
  openLexwareSettings,
  postSignedWebhook,
  postWebhook,
  resetFake,
  resetLexwareE2eState,
  seedContact,
  setInvoiceDueDate,
  setInvoicePaid,
  setInvoiceVoided,
  signWebhook,
  type FakeInvoiceSummary,
} from '../helpers/lexware.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  resetE2eDatabase,
  SELLER_EMAIL,
  SELLER_PASSWORD,
} from '../helpers/seed.ts';
import {
  berlinDayPlus,
  berlinTodayIso,
  cancelViaUi,
  cleanMachine,
  ensureInitialStock,
  formatEuro,
  issueAndReturn,
  issueBooking,
  login,
  openSettlement,
  returnBooking,
  runDueJobs,
} from '../helpers/settlement.ts';

test.describe.configure({ mode: 'serial' });

/** Seed-Listenpreis (Cent): 1×10 L = 75,00 €. */
const MACHINE_1X10 = 7500;

const LABEL_TRANSFERRED = 'An Buchhaltung übertragen';
const LABEL_TRANSFER_CHECK = 'Lexware-Übertragung prüfen';
const LABEL_DELIVERY_PENDING = 'Versand: Ausstehend';
/**
 * Phase 12 (Order §16): nach erfolgreicher Rechnung reiht die API die
 * Rechnungsmail ein (invoice.delivery ⇒ mail.send, PDF transient aus Lexware);
 * die E2E-Lexware-API versendet an die lokale SMTP-Senke. „Versendet“ erst nach
 * bestätigtem SMTP-Versand – vorher (z. B. direkt nach manuellem Retry) „Ausstehend“.
 */
const LABEL_DELIVERY_SENT = 'Versand: Versendet';
const LABEL_INVOICE_CREATED = 'Rechnung: erstellt';
/** Vor dem Worker-Lauf: bereit oder (optional) „Übertragung geplant“. */
const READY_OR_PLANNED = /Bereit zur Buchhaltung|Übertragung geplant/;
/** Deeplink: nur die offizielle Permalink-Struktur, nie ein Key. */
const DEEPLINK_PATH = '/permalink/invoices/view/';
const NEVER_SENT = /gesendet|versendet/i;

let staff: Page; // Erika (Admin – alle Rechte inkl. system.settings, accounting.view_reference)
let customerPage: Page;
let seller: Page | null = null; // Viktor (Verkauf – ohne accounting.view_reference)
let browserRef: Browser;

/** Szenario B (Basis für C/D/E/N). */
let processB = '';
let numberB = '';
let customerB = '';
let invoiceB: FakeInvoiceSummary | null = null;
/** Szenario C (Basis für F/L/M). */
let processC = '';
let invoiceC: FakeInvoiceSummary | null = null;
/** Szenario G (Storno – Basis für N). */
let processG = '';

test.beforeAll(async ({ browser }) => {
  resetE2eDatabase();
  resetLexwareE2eState();
  await resetFake();
  await clearSink(); // Phase 12: Mail-Zählungen nur für diese Spec
  browserRef = browser;
  staff = await browser.newPage();
  customerPage = await browser.newPage();
});
test.afterAll(async () => {
  await staff.close();
  await customerPage.close();
  if (seller !== null) await seller.close();
});

const status = () => staff.getByTestId('settlement-status');
const blocker = (code: string) => staff.getByTestId(`accounting-blocker-${code}`);

/**
 * Lexware-Transfer über den Worker; prüft den Buchhaltungsblock (Order §69) und liefert die Nummer.
 * Phase 12: derselbe Job-Lauf versendet danach die Rechnungsmail ⇒ „Versendet“.
 */
async function transferViaJobs(): Promise<string> {
  await runDueJobs(staff);
  await expect(status()).toContainText(LABEL_TRANSFERRED);
  await expectInvoiceBlock('sent');
  return (await staff.getByTestId('accounting-reference').innerText()).trim();
}

/**
 * Buchhaltungsblock nach erfolgreichem Transfer (Admin-Sicht). `delivery`:
 * Rechnungsmail noch nicht verarbeitet (`pending`, nie „versendet“) oder per
 * SMTP zugestellt (`sent`, Phase 12).
 */
async function expectInvoiceBlock(delivery: 'pending' | 'sent') {
  const block = staff.getByTestId('accounting-block');
  await expect(block).toBeVisible();
  await expect(staff.getByTestId('accounting-provider')).toContainText('Lexware');
  await expect(staff.getByTestId('accounting-invoice-status')).toContainText(LABEL_INVOICE_CREATED);
  if (delivery === 'sent') {
    await expect(staff.getByTestId('invoice-delivery-status')).toContainText(LABEL_DELIVERY_SENT);
  } else {
    await expect(staff.getByTestId('invoice-delivery-status')).toContainText(
      LABEL_DELIVERY_PENDING,
    );
    await expect(block).not.toContainText(NEVER_SENT);
  }
  await expect(staff.getByTestId('settlement-locked-hint')).toBeVisible();
  await expect(staff.getByTestId('mock-badge')).toHaveCount(0);
  const reference = staff.getByTestId('accounting-reference');
  await expect(reference).toBeVisible();
  expect((await reference.innerText()).trim().length).toBeGreaterThan(0);
  const deeplink = staff.getByTestId('lexware-open-invoice');
  await expect(deeplink).toBeVisible();
  const href = (await deeplink.getAttribute('href')) ?? '';
  expect(href).toContain(DEEPLINK_PATH);
  expect(href).not.toContain(LEXWARE_FAKE_API_KEY);
}

/** Manueller Retry („Lexware-Übertragung erneut versuchen“) mit Bestätigung. */
async function retryTransfer() {
  const retry = staff.getByTestId('retry-transfer');
  await expect(retry).toBeVisible();
  await expect(retry).toContainText(/erneut versuchen/);
  await retry.click();
  await staff.getByTestId('transfer-confirm').click();
}

async function expectProcessCompleted(processId: string) {
  await staff.goto(`/vorgaenge/${processId}`);
  await expect(staff.locator('.badge', { hasText: 'Abgeschlossen' }).first()).toBeVisible();
  await expect(staff.getByTestId('process-settlement')).toContainText(LABEL_TRANSFERRED);
}

/** Genau eine Fake-Rechnung mit Vorgangsnummer + MR-Transfer-Marker in der Remark. */
async function expectSingleInvoiceFor(
  processNumber: string,
  reference: string,
): Promise<FakeInvoiceSummary> {
  const invoices = await fakeInvoices();
  const matching = invoices.filter((invoice) => invoice.remark?.includes(processNumber) === true);
  expect(matching).toHaveLength(1);
  const invoice = matching[0]!;
  expect(invoice.remark).toMatch(/MR-Transfer: MRT-[A-Za-z0-9]{10}/);
  expect(invoice.voucherStatus).toBe('open');
  expect(invoice.voucherNumber).toBe(reference);
  return invoice;
}

/** Kundenstammdaten (Rechnungsadresse) über die Kundenseite ändern. */
async function editCustomerAddress(customerId: string, street: string, zip: string, city: string) {
  await staff.goto(`/kunden/${customerId}`);
  await staff.getByRole('button', { name: 'Bearbeiten' }).click();
  await staff.getByLabel('Rechnungsadresse: Straße (optional)').fill(street);
  await staff.getByLabel('PLZ', { exact: true }).fill(zip);
  await staff.getByLabel('Ort', { exact: true }).fill(city);
  await staff.getByRole('button', { name: 'Speichern' }).click();
  await expect(staff.getByRole('heading', { name: 'Stammdaten' })).toBeVisible();
  await expect(staff.getByText(`Rechnungsadresse: ${street}, ${zip}, ${city}`)).toBeVisible();
}

// ── A: Verbindung prüfen ─────────────────────────────────────────────────

test('A: Admin Einstellungen → Lexware → Verbindung prüfen: Firmenname sichtbar, kein Key; Webhooks einrichten; Steuerkonfiguration synthetisch setzen', async () => {
  test.setTimeout(300_000);
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await ensureInitialStock(staff, 'sirup-kirsche', 'Sirup Kirsche', 10);
  await ensureInitialStock(staff, 'sirup-waldmeister', 'Sirup Waldmeister', 10);
  await ensureInitialStock(staff, 'strohhalme-25', 'Strohhalme (25 Stück)', 20);
  await ensureInitialStock(staff, 'becher-25', 'Becher (25 Stück)', 40);
  await ensureInitialStock(staff, 'mischkanister-6l', '6-L-Mischkanister', 10, { optional: true });

  await openLexwareSettings(staff);
  const section = staff.getByTestId('lexware-section');
  await expect(section.getByTestId('lexware-status')).not.toContainText('Verbunden');
  await checkLexwareConnection(staff);
  await expect(section.getByTestId('lexware-company')).toContainText(LEXWARE_FAKE_COMPANY);
  await expect(section.getByTestId('lexware-org')).toContainText('e2e-org-');
  await expect(section.getByTestId('lexware-last-check')).not.toBeEmpty();
  // Der API-Key erscheint nirgends (Seite, Status-Antwort).
  expect(await staff.content()).not.toContain(LEXWARE_FAKE_API_KEY);
  const statusResponse = await staff.request.get('/api/staff/lexware/status');
  expect(statusResponse.ok()).toBe(true);
  expect(await statusResponse.text()).not.toContain(LEXWARE_FAKE_API_KEY);

  // Webhooks einrichten (idempotent): alle benötigten Eventtypen im Fake.
  await section.getByTestId('lexware-setup-webhooks').click();
  await expect(section.getByTestId('lexware-webhook-status')).not.toContainText(/nicht/i);
  const subscriptions = await fakeSubscriptions();
  for (const eventType of [
    'invoice.status.changed',
    'invoice.changed',
    'invoice.deleted',
    'payment.changed',
  ]) {
    expect(subscriptions.map((s) => s.eventType)).toContain(eventType);
  }
  // A1: token.revoked (OAuth-Refresh-Token-Ereignis) wird nicht mehr abonniert.
  expect(subscriptions.map((s) => s.eventType)).not.toContain('token.revoked');
  await section.getByTestId('lexware-setup-webhooks').click();
  expect((await fakeSubscriptions()).length).toBe(subscriptions.length);

  // Steuerkonfiguration: unvollständig → synthetisch setzen → vollständig.
  await expect(section.getByTestId('lexware-tax-status')).toContainText(/unvollständig/);
  await section.getByTestId('lexware-open-tax-config').click();
  await expect(staff).toHaveURL(/\/einstellungen\/steuern$/);
  await expect(staff.getByTestId('tax-hint')).toContainText(
    'Steuerkonfiguration vor Produktivbetrieb mit Buchhaltung/Steuerberatung prüfen.',
  );
  await applySyntheticTax(staff);
  await expect(staff.getByTestId('tax-row-machine_rental')).toBeVisible();
  await expect(staff.getByTestId('tax-row-cancellation_charge')).toBeVisible();
  await openLexwareSettings(staff);
  await expect(section.getByTestId('lexware-tax-status')).not.toContainText(/unvollständig/);
  await expect(section.getByTestId('lexware-tax-status')).toContainText(/vollständig/);
});

// ── B: Normale Rechnung ──────────────────────────────────────────────────

test('B: Return → Transfer → Kontakt angelegt → finale Rechnung → Nummer nur Admin → Vorgang abgeschlossen → Zahlung offen', async () => {
  test.setTimeout(480_000);
  ({ processId: processB, processNumber: numberB } = await issueAndReturn(
    staff,
    customerPage,
    {
      firstName: 'Bernd',
      lastName: 'Beleg',
      email: 'bernd@e2e.example',
      machineCodes: ['MR-10-01-01'],
      additions: [{ name: 'Waldmeister', quantity: 2 }],
      booking: {
        delivery: {
          street: 'Teststraße 2',
          postalCode: '55129',
          city: 'Mainz',
          priceEuro: '49,00',
        },
        discountPercent: 10,
        expectedDiscountEuro: '7,50',
        purchaseCanisters: 1,
      },
    },
    { commission: { name: 'Waldmeister', unopenedBack: 1 } },
  ));
  customerB = await customerIdOfProcess(staff, processB);
  expect(await fakeContacts()).toHaveLength(0);

  await openSettlement(staff, processB);
  await expect(staff.getByTestId('accounting-provider')).toContainText('Lexware');
  await expect(staff.getByTestId('mock-badge')).toHaveCount(0);
  await expect(staff.locator('[data-testid^="accounting-blocker-"]')).toHaveCount(0);
  await expect(status()).toContainText(READY_OR_PLANNED);
  const due = MACHINE_1X10 + 4900 + 500 + 1200 - 750;
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(formatEuro(due));

  const reference = await transferViaJobs();
  await expect(staff.getByTestId('payment-status')).toContainText('Offen');
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(formatEuro(due));

  // Fake: genau EIN Kontakt (Privatperson) und genau EINE finale Rechnung mit Marker.
  const contacts = await fakeContacts();
  expect(contacts).toHaveLength(1);
  expect(contacts[0]!.person).toMatchObject({ firstName: 'Bernd', lastName: 'Beleg' });
  expect(contacts[0]!.emailAddresses?.business).toEqual(['bernd@e2e.example']);
  invoiceB = await expectSingleInvoiceFor(numberB, reference);
  expect(invoiceB.address['contactId']).toBe(contacts[0]!.id);
  expect(invoiceB.address['name']).toContain('Beleg');
  expect(invoiceB.lineItems.length).toBeGreaterThanOrEqual(5); // Miete, Lieferung, Kauf, Kommission, Rabatt
  expect(invoiceB.totalGrossAmount).toBeGreaterThan(0);
  expect(staff.url()).not.toContain(LEXWARE_FAKE_API_KEY);

  // Zweiter Worker-Lauf: kein zweiter Transfer, keine zweite Rechnung.
  await runDueJobs(staff);
  await expect(staff.getByTestId('accounting-reference')).toHaveText(reference);
  expect(await fakeInvoices()).toHaveLength(1);
  await expectProcessCompleted(processB);

  // Verkauf (ohne accounting.view_reference, mit settlement.view): Status ja, Nummer/Deeplink nein.
  await grantPermission(staff, SELLER_EMAIL, 'settlement.view');
  seller = await browserRef.newPage();
  await login(seller, SELLER_EMAIL, SELLER_PASSWORD, 'Viktor');
  await seller.goto(`/vorgaenge/${processB}/abrechnung`);
  await expect(seller.getByTestId('settlement-page')).toBeVisible();
  await expect(seller.getByTestId('accounting-provider')).toContainText('Lexware');
  await expect(seller.getByTestId('accounting-invoice-status')).toContainText(
    LABEL_INVOICE_CREATED,
  );
  await expect(seller.getByTestId('payment-status')).toContainText('Offen');
  await expect(seller.getByTestId('invoice-delivery-status')).toContainText(LABEL_DELIVERY_SENT);
  await expect(seller.getByTestId('accounting-reference')).toHaveCount(0);
  await expect(seller.getByTestId('lexware-open-invoice')).toHaveCount(0);
  expect(await seller.content()).not.toContain(reference);
  expect(await seller.content()).not.toContain(DEEPLINK_PATH);
});

// ── C: Bestehender Kunde, zweiter Vorgang ────────────────────────────────

test('C: Bestehender Kunde, zweiter Vorgang: Mapping wiederverwendet (kein zweiter Kontakt), zweite Rechnung mit Adress-Snapshot', async () => {
  test.setTimeout(480_000);
  await editCustomerAddress(customerB, 'Alte Straße 1', '55116', 'Mainz');
  await expect(staff.getByTestId('lexware-contact-status')).toBeVisible();

  let numberC: string;
  ({ processId: processC, processNumber: numberC } = await issueAndReturn(staff, customerPage, {
    firstName: 'Bernd',
    lastName: 'Beleg',
    email: 'bernd@e2e.example',
    machineCodes: ['MR-10-01-02'],
    booking: { existingCustomerId: customerB },
  }));
  expect(await customerIdOfProcess(staff, processC)).toBe(customerB);
  await openSettlement(staff, processC);
  const reference = await transferViaJobs();
  await expect(staff.getByTestId('payment-status')).toContainText('Offen');

  const contacts = await fakeContacts();
  expect(contacts).toHaveLength(1);
  invoiceC = await expectSingleInvoiceFor(numberC, reference);
  expect(invoiceC.address['contactId']).toBe(contacts[0]!.id);
  expect(invoiceC.address['street']).toBe('Alte Straße 1');
  expect(invoiceC.id).not.toBe(invoiceB!.id);
  expect(await fakeInvoices()).toHaveLength(2);
  await expectProcessCompleted(processC);
});

// ── D: Kundenprofil geändert ─────────────────────────────────────────────

test('D: Kundenprofil geändert → Lexware-Kontakt aktualisiert, alte Rechnung behält die eingefrorene Adresse', async () => {
  test.setTimeout(480_000);
  await editCustomerAddress(customerB, 'Neue Straße 7', '55131', 'Mainz');
  const { processId, processNumber } = await issueAndReturn(staff, customerPage, {
    firstName: 'Bernd',
    lastName: 'Beleg',
    email: 'bernd@e2e.example',
    machineCodes: ['MR-10-01-03'],
    booking: { existingCustomerId: customerB },
  });
  await openSettlement(staff, processId);
  const reference = await transferViaJobs();

  // Kontakt aus dem AKTUELLEN Kundenstamm aktualisiert (kein zweiter Kontakt).
  const contacts = await fakeContacts();
  expect(contacts).toHaveLength(1);
  expect(contacts[0]!.addresses?.billing?.[0]?.['street']).toBe('Neue Straße 7');
  expect(contacts[0]!.version).toBeGreaterThan(1);

  // Neue Rechnung mit neuer Adresse; alte Rechnungen unverändert (Snapshot).
  const invoiceD = await expectSingleInvoiceFor(processNumber, reference);
  expect(invoiceD.address['street']).toBe('Neue Straße 7');
  const invoices = await fakeInvoices();
  expect(invoices).toHaveLength(3);
  const oldC = invoices.find((invoice) => invoice.id === invoiceC!.id);
  expect(oldC?.address['street']).toBe('Alte Straße 1');
  const oldB = invoices.find((invoice) => invoice.id === invoiceB!.id);
  expect(oldB?.address['street'] ?? '').not.toBe('Neue Straße 7');
});

// ── E: payment.changed → Bezahlt ─────────────────────────────────────────

test('E: Zahlung in Lexware → signierter payment.changed-Webhook → Job → „Bezahlt“', async () => {
  test.setTimeout(180_000);
  await setInvoicePaid(invoiceB!.id);
  expect(
    await postSignedWebhook(LEXWARE_API_ORIGIN, {
      eventType: 'payment.changed',
      resourceId: invoiceB!.id,
    }),
  ).toBe(202);
  await openSettlement(staff, processB);
  await expect(staff.getByTestId('payment-status')).toContainText('Offen');
  await runDueJobs(staff);
  await expect(staff.getByTestId('payment-status')).toContainText('Bezahlt');
  await expect(status()).toContainText(LABEL_TRANSFERRED);
  // Zahlung ändert den (in B bereits erfolgten) Rechnungsversand nicht.
  await expect(staff.getByTestId('invoice-delivery-status')).toContainText(LABEL_DELIVERY_SENT);
  // Duplikat (gleicher Fingerprint) ändert nichts; Vorgang bleibt abgeschlossen.
  await staff.reload();
  await expect(staff.getByTestId('payment-status')).toContainText('Bezahlt');
  await expectProcessCompleted(processB);
});

// ── F: Überfällig ────────────────────────────────────────────────────────

test('F: Fälligkeit überschritten → invoice.changed-Webhook → Job → „Überfällig“', async () => {
  test.setTimeout(180_000);
  await setInvoiceDueDate(invoiceC!.id, berlinDayPlus(-1));
  expect(
    await postSignedWebhook(LEXWARE_API_ORIGIN, {
      eventType: 'invoice.changed',
      resourceId: invoiceC!.id,
    }),
  ).toBe(202);
  await openSettlement(staff, processC);
  await runDueJobs(staff);
  await expect(staff.getByTestId('payment-status')).toContainText('Überfällig');
  await expect(status()).toContainText(LABEL_TRANSFERRED);
  await expect(staff.getByTestId('settlement-locked-hint')).toBeVisible();
  // Hauptstatus bleibt abgeschlossen (Order §66).
  await expectProcessCompleted(processC);
});

// ── G: Storno → genau eine Stornokostenrechnung ──────────────────────────

test('G: 50 % Storno → genau eine Stornokostenrechnung in Lexware → „Stornorechnung offen“, Vorgang bleibt storniert', async () => {
  test.setTimeout(360_000);
  ({ processId: processG } = await acceptedBooking(staff, customerPage, {
    firstName: 'Gisela',
    lastName: 'Gegenruf',
    email: 'gisela@e2e.example',
    machineLabel: '1×10 L',
    guestCount: 30,
    freeSyrupLiters: 1,
    confirmOrder: true,
    eventDate: berlinDayPlus(10),
  }));
  const before = (await fakeInvoices()).length;
  await cancelViaUi(staff, processG, {
    days: 10,
    percent: 50,
    baseCents: MACHINE_1X10,
    feeCents: 3750,
  });
  const cancellation = staff.getByTestId('process-cancellation');
  await expect(cancellation.getByTestId('cancellation-finance-status')).toContainText(
    /Stornorechnung/,
  );
  await runDueJobs(staff);
  await expect(cancellation.getByTestId('cancellation-finance-status')).toContainText(
    'Stornorechnung offen',
  );
  await expect(cancellation.getByTestId('cancellation-invoice-status')).toContainText(
    LABEL_INVOICE_CREATED,
  );
  // Phase 12: Stornorechnung im selben Job-Lauf per Mail versendet.
  await expect(cancellation.getByTestId('cancellation-delivery-status')).toContainText(
    LABEL_DELIVERY_SENT,
  );
  const reference = cancellation.getByTestId('cancellation-reference');
  await expect(reference).toBeVisible();
  const voucherNumber = (await reference.innerText()).trim();
  expect(voucherNumber.length).toBeGreaterThan(0);
  const deeplink = cancellation.getByTestId('cancellation-open-invoice');
  expect((await deeplink.getAttribute('href')) ?? '').toContain(DEEPLINK_PATH);

  const invoices = await fakeInvoices();
  expect(invoices).toHaveLength(before + 1);
  const storno = invoices.find((invoice) => invoice.voucherNumber === voucherNumber);
  expect(storno).toBeDefined();
  expect(storno!.lineItems).toHaveLength(1);
  expect(JSON.stringify(storno!.lineItems[0])).toContain('Stornokosten');
  expect(Math.round(storno!.totalGrossAmount * 100)).toBeGreaterThanOrEqual(3750);
  // Zweiter Lauf: keine zweite Stornorechnung; Vorgang bleibt storniert.
  await runDueJobs(staff);
  expect(await fakeInvoices()).toHaveLength(before + 1);
  await expect(staff.locator('.badge', { hasText: 'Storniert' }).first()).toBeVisible();
  await expect(staff.locator('.badge', { hasText: 'Abgeschlossen' })).toHaveCount(0);
});

// ── H: Timeout nach Create → Recovery ────────────────────────────────────

test('H: Timeout NACH dem Rechnungs-Create → Unknown Outcome → Recovery verbindet dieselbe Rechnung (kein zweiter Create)', async () => {
  test.setTimeout(480_000);
  const { processId, processNumber } = await issueAndReturn(staff, customerPage, {
    firstName: 'Hanna',
    lastName: 'Hänger',
    email: 'hanna@e2e.example',
    machineCodes: ['MR-10-01-04'],
  });
  const before = (await fakeInvoices()).length;
  await failNext({ match: 'POST /v1/invoices', status: 0, times: 1, mode: 'after_create' });
  await openSettlement(staff, processId);
  await runDueJobs(staff);
  // Nicht übertragen, aber Rechnung im Fake angelegt (unknown outcome).
  await expect(status()).not.toContainText(LABEL_TRANSFERRED);
  await expect(status()).toContainText(LABEL_TRANSFER_CHECK);
  expect(await fakeInvoices()).toHaveLength(before + 1);
  await expect(staff.getByTestId('accounting-reference')).toHaveCount(0);

  // Retry ⇒ Recovery (Belegliste + Marker) ⇒ dieselbe Rechnung – kein zweiter Create.
  await retryTransfer();
  await expect(status()).toContainText(LABEL_TRANSFERRED);
  // Phase 12: Rechnungsmail erst im nächsten Job-Lauf (invoice.delivery ⇒ mail.send).
  await expectInvoiceBlock('pending');
  await runDueJobs(staff);
  await expectInvoiceBlock('sent');
  const reference = (await staff.getByTestId('accounting-reference').innerText()).trim();
  const invoices = await fakeInvoices();
  expect(invoices).toHaveLength(before + 1);
  const recovered = await expectSingleInvoiceFor(processNumber, reference);
  expect(invoices.map((invoice) => invoice.id)).toContain(recovered.id);
  await expectProcessCompleted(processId);
});

// ── I: Mehrdeutiger Kontakt ──────────────────────────────────────────────

test('I: Mehrdeutiger Lexware-Kontakt → Transfer blockiert → Admin wählt Kontakt → Transfer erfolgreich', async () => {
  test.setTimeout(480_000);
  // Zwei bestehende Lexware-Kontakte mit gleicher E-Mail und gleichem Namen – kein Auto-Merge.
  const first = await seedContact({
    email: 'ines@e2e.example',
    person: { firstName: 'Ines', lastName: 'Igel' },
    addresses: {
      billing: [{ street: 'Igelweg 1', zip: '55116', city: 'Mainz', countryCode: 'DE' }],
    },
  });
  const second = await seedContact({
    email: 'ines@e2e.example',
    person: { firstName: 'Ines', lastName: 'Igel' },
    addresses: {
      billing: [{ street: 'Igelweg 2', zip: '55116', city: 'Mainz', countryCode: 'DE' }],
    },
  });
  const contactsBefore = (await fakeContacts()).length;
  const { processId, processNumber } = await issueAndReturn(staff, customerPage, {
    firstName: 'Ines',
    lastName: 'Igel',
    email: 'ines@e2e.example',
    machineCodes: ['MR-10-01-05'],
  });
  const customerId = await customerIdOfProcess(staff, processId);
  const invoicesBefore = (await fakeInvoices()).length;

  await openSettlement(staff, processId);
  await runDueJobs(staff);
  await expect(status()).not.toContainText(LABEL_TRANSFERRED);
  await expect(blocker('CONTACT_REVIEW_REQUIRED')).toContainText('Lexware-Kontakt prüfen');
  expect(await fakeInvoices()).toHaveLength(invoicesBefore);
  expect(await fakeContacts()).toHaveLength(contactsBefore);

  // Kundenseite: Kandidaten sichtbar, Admin wählt den ersten Kontakt.
  await staff.goto(`/kunden/${customerId}`);
  const candidates = staff.getByTestId('lexware-contact-candidates');
  await expect(candidates).toBeVisible();
  await expect(staff.getByTestId(`lexware-contact-candidate-${first}`)).toBeVisible();
  await expect(staff.getByTestId(`lexware-contact-candidate-${second}`)).toBeVisible();
  await staff.getByTestId(`lexware-contact-link-${first}`).click();
  await staff.getByTestId('lexware-contact-link-confirm').click();
  await expect(staff.getByTestId('lexware-contact-status')).not.toContainText(/prüfen/);
  await expect(staff.getByTestId('lexware-contact-candidates')).toHaveCount(0);

  await openSettlement(staff, processId);
  await expect(blocker('CONTACT_REVIEW_REQUIRED')).toHaveCount(0);
  await retryTransfer();
  await expect(status()).toContainText(LABEL_TRANSFERRED);
  // Phase 12: Rechnungsmail erst im nächsten Job-Lauf (invoice.delivery ⇒ mail.send).
  await expectInvoiceBlock('pending');
  await runDueJobs(staff);
  await expectInvoiceBlock('sent');
  const reference = (await staff.getByTestId('accounting-reference').innerText()).trim();
  const invoice = await expectSingleInvoiceFor(processNumber, reference);
  expect(invoice.address['contactId']).toBe(first);
  expect(await fakeContacts()).toHaveLength(contactsBefore);
  expect(await fakeInvoices()).toHaveLength(invoicesBefore + 1);
});

// ── J: Steuerkonfiguration fehlt ─────────────────────────────────────────

test('J: Steuerkonfiguration fehlt → Transfer blockiert (kein Lexware-Aufruf) → synthetisch setzen → Retry erfolgreich', async () => {
  test.setTimeout(480_000);
  resetLexwareE2eState({ onlyTaxConfig: true });
  await openLexwareSettings(staff);
  await expect(staff.getByTestId('lexware-tax-status')).toContainText(/unvollständig/);

  const { processId, processNumber } = await issueAndReturn(staff, customerPage, {
    firstName: 'Jana',
    lastName: 'Jahresabschluss',
    email: 'jana@e2e.example',
    machineCodes: ['MR-10-01-06'],
  });
  const invoicesBefore = (await fakeInvoices()).length;
  await openSettlement(staff, processId);
  await runDueJobs(staff);
  await expect(status()).not.toContainText(LABEL_TRANSFERRED);
  await expect(blocker('TAX_CONFIG_INCOMPLETE')).toContainText(
    'Steuerkonfiguration für Buchhaltung unvollständig',
  );
  expect(await fakeInvoices()).toHaveLength(invoicesBefore);

  await applySyntheticTax(staff);
  await openSettlement(staff, processId);
  await expect(blocker('TAX_CONFIG_INCOMPLETE')).toHaveCount(0);
  await retryTransfer();
  await expect(status()).toContainText(LABEL_TRANSFERRED);
  // Phase 12: Rechnungsmail erst im nächsten Job-Lauf (invoice.delivery ⇒ mail.send).
  await expectInvoiceBlock('pending');
  await runDueJobs(staff);
  await expectInvoiceBlock('sent');
  const reference = (await staff.getByTestId('accounting-reference').innerText()).trim();
  await expectSingleInvoiceFor(processNumber, reference);
  expect(await fakeInvoices()).toHaveLength(invoicesBefore + 1);
});

// ── K: Anzahlung/Kaution blockiert ───────────────────────────────────────

test('K: Anzahlung und angewendete Kaution → Transfer blockiert (fail closed), keine Rechnung in Lexware', async () => {
  test.setTimeout(480_000);
  await cleanMachine(staff, 'MR-10-01-01');
  const { processId } = await issueBooking(staff, customerPage, {
    firstName: 'Kai',
    lastName: 'Kaution',
    email: 'kai@e2e.example',
    machineCodes: ['MR-10-01-01'],
  });
  await staff.goto(`/vorgaenge/${processId}`);
  const payments = staff.getByTestId('payments-section');
  const advance = payments.getByTestId('advance-form');
  await advance.getByTestId('advance-amount').fill('20,00');
  await advance.getByTestId('advance-received-at').fill(berlinTodayIso());
  await advance.getByTestId('advance-reference').fill('E2E-LX-ANZ');
  await advance.getByTestId('advance-submit').click();
  await expect(payments.getByTestId('advance-item')).toContainText(formatEuro(2000));
  const depositForm = payments.getByTestId('deposit-form');
  await depositForm.getByTestId('deposit-amount').fill('100,00');
  await depositForm.getByTestId('deposit-received-at').fill(berlinTodayIso());
  await depositForm.getByTestId('deposit-submit').click();
  await expect(payments.getByTestId('deposit-item')).toHaveCount(1);

  await returnBooking(staff, processId, { slots: 1 });
  await staff.goto(`/vorgaenge/${processId}`);
  const deposit = staff.getByTestId('payments-section').getByTestId('deposit-item');
  await deposit.getByTestId('deposit-apply-amount').fill('30,00');
  await deposit.getByTestId('deposit-apply').click();
  await expect(deposit.getByTestId('deposit-held-remaining')).toContainText(formatEuro(7000));

  const invoicesBefore = (await fakeInvoices()).length;
  await openSettlement(staff, processId);
  await expect(staff.getByTestId('settlement-line-advance_payment_credit')).toContainText(
    formatEuro(2000),
  );
  await expect(staff.getByTestId('settlement-line-deposit_applied_credit')).toContainText(
    formatEuro(3000),
  );
  await expect(blocker('ADVANCE_PAYMENT_UNSUPPORTED')).toContainText(
    'Lexware-Abbildung für Anzahlung muss vor Übertragung geklärt werden.',
  );
  await expect(blocker('DEPOSIT_UNSUPPORTED')).toContainText(
    'Lexware-Abbildung für angewendete Kaution muss vor Übertragung geklärt werden.',
  );
  await runDueJobs(staff);
  await expect(status()).not.toContainText(LABEL_TRANSFERRED);
  await expect(staff.getByTestId('accounting-reference')).toHaveCount(0);
  await expect(staff.getByTestId('settlement-locked-hint')).toHaveCount(0);
  expect(await fakeInvoices()).toHaveLength(invoicesBefore);
  // Beträge bleiben unverändert (kein Rabatt, kein Betragsverlust).
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(
    formatEuro(MACHINE_1X10 - 2000 - 3000),
  );
});

// ── L: Ungültiger Webhook ────────────────────────────────────────────────

test('L: Ungültige Signatur / fremde Organisation → 401/403, kein Job, kein Statuswechsel', async () => {
  test.setTimeout(180_000);
  // Im Fake ist C jetzt bezahlt – ein VERARBEITETER Webhook würde „Bezahlt“ liefern.
  await setInvoicePaid(invoiceC!.id);
  const signed = await signWebhook({ eventType: 'payment.changed', resourceId: invoiceC!.id });

  // Manipulierte Signatur.
  const tampered = await postWebhook(
    LEXWARE_API_ORIGIN,
    signed.body,
    `AAAA${signed.signature.slice(4)}`,
  );
  expect([401, 403]).toContain(tampered.status);
  // Manipulierter Body (Signatur passt nicht mehr zu den Rohbytes).
  const bodyChanged = await postWebhook(
    LEXWARE_API_ORIGIN,
    signed.body.replace('payment.changed', 'invoice.changed'),
    signed.signature,
  );
  expect([401, 403]).toContain(bodyChanged.status);
  // Fehlender Header.
  const missing = await fetch(`${LEXWARE_API_ORIGIN}/webhooks/lexware`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: signed.body,
  });
  expect([401, 403]).toContain(missing.status);
  // Korrekt signiert, aber fremde organizationId.
  const foreign = await postSignedWebhook(LEXWARE_API_ORIGIN, {
    eventType: 'payment.changed',
    resourceId: invoiceC!.id,
    organizationId: 'e2e-org-ffffffff-ffff-4fff-8fff-ffffffffffff',
  });
  expect([401, 403]).toContain(foreign);

  await openSettlement(staff, processC);
  await runDueJobs(staff);
  await expect(staff.getByTestId('payment-status')).toContainText('Überfällig');
  await expect(staff.getByTestId('payment-status')).not.toContainText('Bezahlt');
});

// ── M: Extern storniert ──────────────────────────────────────────────────

test('M: Rechnung extern storniert (voided) → Webhook → „Buchhaltungsprüfung erforderlich“, Abrechnung bleibt gesperrt, keine Neurechnung', async () => {
  test.setTimeout(180_000);
  const invoicesBefore = (await fakeInvoices()).length;
  await setInvoiceVoided(invoiceC!.id);
  expect(
    await postSignedWebhook(LEXWARE_API_ORIGIN, {
      eventType: 'invoice.status.changed',
      resourceId: invoiceC!.id,
    }),
  ).toBe(202);
  await openSettlement(staff, processC);
  await runDueJobs(staff);
  const attention = staff.getByTestId('accounting-attention');
  await expect(attention).toBeVisible();
  await expect(attention).toContainText('Buchhaltungsprüfung erforderlich');
  await expect(staff.getByTestId('settlement-locked-hint')).toBeVisible();
  await expect(staff.getByTestId('line-edit')).toHaveCount(0);
  await expect(staff.getByTestId('transfer-now')).toHaveCount(0);
  await expect(staff.getByTestId('retry-transfer')).toHaveCount(0);
  await expect(staff.getByTestId('lexware-open-invoice')).toBeVisible();
  // Kein neuer Beleg, keine lokale Finanzmutation.
  expect(await fakeInvoices()).toHaveLength(invoicesBefore);
  await expect(staff.getByTestId('payment-status')).not.toContainText('Bezahlt');
  await staff.goto(`/vorgaenge/${processC}`);
  await expect(staff.getByTestId('process-settlement')).toContainText(/Buchhaltungsprüfung/);
});

// ── N: Versandstatus ─────────────────────────────────────────────────────

test('N: Rechnungsversand (Phase 12): Miet-Royal mailt jede Rechnung genau einmal mit Lexware-PDF, „Versand: Versendet“ (Abrechnung und Storno); Lexware selbst versendet nichts', async () => {
  test.setTimeout(180_000);
  await openSettlement(staff, processB);
  await expect(staff.getByTestId('payment-status')).toContainText('Bezahlt');
  await expect(staff.getByTestId('invoice-delivery-status')).toContainText(LABEL_DELIVERY_SENT);
  await expect(staff.getByTestId('settlement-page')).not.toContainText(/per Lexware versendet/i);

  await staff.goto(`/vorgaenge/${processG}`);
  const cancellation = staff.getByTestId('process-cancellation');
  await expect(cancellation.getByTestId('cancellation-delivery-status')).toContainText(
    LABEL_DELIVERY_SENT,
  );
  // Genau EINE Rechnungsmail je Rechnung (B/C/D: Bernd, G: Storno Gisela) – trotz mehrfacher
  // Job-Läufe und Webhooks (Order §16: automatisch nie doppelt); Anhang = Lexware-PDF.
  const bernd = await mailsMatching({ to: 'bernd@e2e.example', subject: /^Rechnung / });
  expect(bernd).toHaveLength(3);
  const gisela = await mailsMatching({ to: 'gisela@e2e.example', subject: /^Rechnung / });
  expect(gisela).toHaveLength(1);
  for (const mail of [...bernd, ...gisela]) {
    pdfAttachment(mail, /^Rechnung-.+\.pdf$/);
  }
  expect(new Set(bernd.map((mail) => mail.messageId)).size).toBe(3);
  // Fake-Prüfung: Lexware wird nie zum Versenden aufgerufen (es gibt keinen Mail-Endpunkt);
  // der Anhang kommt transient über GET /v1/invoices/{id}/file.
  const requests = await fakeRequestLog();
  expect(requests.some((request) => /mail|send|deliver/i.test(request.path))).toBe(false);
  expect(requests.some((request) => /^\/v1\/invoices\/[^/]+\/file$/.test(request.path))).toBe(true);
});
