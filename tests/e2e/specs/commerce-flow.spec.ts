/**
 * Phase-3-E2E-Szenarien A–F (Vorgabe Nr. 51):
 * A Mitarbeiter: Login → Kunde → Vorgang → Anfrage → Angebot → PDF →
 *   versenden (Test-Outbox) → Online-Link.
 * B Kunde: Online-Angebot → Zusammenfassung → verbindlich annehmen →
 *   Bestätigung.
 * C Mitarbeiter: angenommener Vorgang → AB vorbereitet → prüfen →
 *   freigeben → versenden.
 * D Angebotsänderung: V1 senden → neue Version → V1-Link tot (Rotation) →
 *   V2 annehmbar.
 * E Ablauf: abgelaufen → Annahme blockiert → erneute Prüfung anfragen.
 * F Rabatt: >20 % ohne Freigabe → Versand blockiert → Freigabe → Versand.
 * Ausschließlich synthetische Testdaten (global-setup.ts / e2e-seed.ts).
 */
import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

const ADMIN_EMAIL = 'admin@e2e.example';
const ADMIN_PASSWORD = 'e2e-admin-passwort-1';
const SELLER_EMAIL = 'verkauf@e2e.example';
const SELLER_PASSWORD = 'e2e-verkauf-passwort-1';
const WEB_ORIGIN = 'http://127.0.0.1:3100';

test.describe.configure({ mode: 'serial' });

let staff: Page;
let customerPage: Page;
let processIdA = '';
let publicPathA = '';
let processIdD = '';
let processIdF = '';

test.beforeAll(async ({ browser }) => {
  staff = await browser.newPage();
  customerPage = await browser.newPage();
});
test.afterAll(async () => {
  await staff.close();
  await customerPage.close();
});

async function login(page: Page, email: string, password: string, firstName: string) {
  await page.goto('/login');
  await page.getByLabel('E-Mail').fill(email);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Heute' })).toBeVisible();
  await expect(page.getByText(new RegExp(`Willkommen, ${firstName}`))).toBeVisible();
}

/** Kunde + Vorgang anlegen; liefert die Vorgangs-ID aus der URL. */
async function createProcess(page: Page, firstName: string, lastName: string, email: string) {
  await page.getByRole('link', { name: 'Kunden', exact: true }).click();
  await page.getByRole('button', { name: 'Kunde anlegen' }).click();
  await page.getByLabel('Vorname').fill(firstName);
  await page.getByLabel('Nachname').fill(lastName);
  await page.getByLabel('E-Mail (optional)').fill(email);
  await page.getByRole('button', { name: 'Kunde anlegen' }).click();
  await expect(page.getByRole('heading', { name: `${firstName} ${lastName}` })).toBeVisible();
  await page.getByRole('button', { name: 'Vorgang anlegen' }).click();
  await expect(page.getByRole('heading', { name: /^MR-\d{4}-\d{4,}$/ })).toBeVisible();
  const match = /\/vorgaenge\/([0-9a-f-]{36})/.exec(page.url());
  expect(match).not.toBeNull();
  return match![1]!;
}

/** Anfrage erfassen: Event in 30 Tagen, 40 Gäste, 2×10-Maschine, 2 L Kirsche. */
async function fillInquiry(page: Page, processId: string) {
  await page.goto(`/vorgaenge/${processId}/anfrage`);
  await expect(page.getByRole('heading', { name: 'Anfrage' })).toBeVisible();
  const eventDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await page.getByLabel('Eventdatum').fill(eventDate);
  await page.getByLabel('Gästezahl (exakt)').fill('40');
  await page.getByLabel('Anlass').selectOption({ label: 'Geburtstag' });
  await page.getByLabel('Gewünschter Maschinentyp').selectOption({ label: '2×10 L' });
  await page.getByLabel('Sirup Kirsche – gratis (L)').fill('2');
  // Standard-Wochenend-Vorschlag ist sichtbar (nur Text, keine Kalenderdaten).
  await expect(
    page.getByText('Vorschlag Standard-Wochenende: Freitag 18:00 Uhr Abholung, Sonntag 11:00 Uhr'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Anfrage speichern' }).click();
  await expect(page.getByText('Anfrage gespeichert.')).toBeVisible();
}

/** Angebot aus der Anfrage erstellen (Entwurf, Version 1 mit 120,00 €). */
async function createOfferDraft(page: Page, processId: string) {
  await page.goto(`/vorgaenge/${processId}/angebot`);
  await page.getByRole('button', { name: 'Angebot erstellen (aus Anfrage)' }).click();
  await expect(page.getByRole('heading', { name: /Version 1/ })).toBeVisible();
  await expect(page.getByText(/Fester Angebotswert: 120,00/)).toBeVisible();
}

/**
 * Aktuellen Entwurf versenden und den öffentlichen Pfad zurückgeben. Wenn
 * bereits ein alter Link angezeigt wird (früherer Versand), auf den NEUEN
 * Link warten – sonst liest der Test den veralteten Zustand.
 */
async function sendOffer(page: Page, previousLink?: string): Promise<string> {
  await page.getByRole('button', { name: 'Angebot versenden' }).click();
  const link = page.getByTestId('public-offer-link');
  await expect(link).toBeVisible();
  if (previousLink !== undefined) {
    await expect(link).not.toHaveText(previousLink);
  }
  const path = (await link.innerText()).trim();
  expect(path).toMatch(/^\/angebot\/[A-Za-z0-9_-]{20,}$/);
  return path;
}

// ── Szenario A: Mitarbeiter erstellt und versendet ein Angebot ───────────

test('A: Admin-Login → Kunde → Vorgang → Anfrage erfassen', async () => {
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  processIdA = await createProcess(staff, 'Paula', 'Partyfee', 'paula@e2e.example');
  await fillInquiry(staff, processIdA);
});

test('A: Angebot erstellen → PDF-Vorschau → versenden → Outbox + Online-Link', async () => {
  await createOfferDraft(staff, processIdA);
  // Kommissionsartikel (Extra-Sirup gibt es hier nicht) – Gratis-Positionen
  // sind als „inklusive“ ausgewiesen; PDF-Vorschau ist verfügbar.
  await expect(staff.getByRole('link', { name: 'PDF-Vorschau öffnen' })).toBeVisible();
  publicPathA = await sendOffer(staff);

  // Versand liegt in der Dev/Test-Outbox (kein echter Mailversand).
  const outbox = await staff.request.get('/api/staff/outbox');
  expect(outbox.ok()).toBe(true);
  const body = (await outbox.json()) as { deliveries: { kind: string; recipient: string }[] };
  expect(body.deliveries.length).toBeGreaterThan(0);
  expect(body.deliveries[0]!.kind).toBe('offer');
  expect(body.deliveries[0]!.recipient).toBe('paula@e2e.example');
});

// ── Szenario B: Kunde nimmt online verbindlich an ────────────────────────

test('B: Kunde öffnet den Online-Link, sieht die Zusammenfassung und nimmt an', async () => {
  await customerPage.goto(`${WEB_ORIGIN}${publicPathA}`);
  await expect(customerPage.getByRole('heading', { name: 'Miet-Royal-Angebot' })).toBeVisible();
  await expect(customerPage.getByRole('heading', { name: 'Positionen' })).toBeVisible();
  await expect(customerPage.getByText(/Fester Angebotswert/)).toBeVisible();
  await expect(customerPage.getByText(/Gültig bis:/)).toBeVisible();
  await expect(
    customerPage.getByRole('link', { name: 'Angebot als PDF ansehen/herunterladen' }),
  ).toBeVisible();

  await customerPage.getByRole('button', { name: 'Angebot verbindlich annehmen' }).click();
  await expect(customerPage.getByRole('heading', { name: 'Vielen Dank!' })).toBeVisible();
  await expect(
    customerPage.getByText('Die Auftragsbestätigung folgt nach Prüfung/Freigabe durch Miet-Royal.'),
  ).toBeVisible();
});

// ── Szenario C: AB vorbereitet → prüfen → freigeben → versenden ──────────

test('C: Auftragsbestätigung ist vorbereitet und wird freigegeben und versendet', async () => {
  await staff.goto(`/vorgaenge/${processIdA}/angebot`);
  await expect(staff.getByRole('heading', { name: 'Auftragsbestätigung' })).toBeVisible();
  await expect(staff.getByText('Vorbereitet')).toBeVisible();

  // Abholadresse ist im Seed konfiguriert → keine Blocker, Freigabe möglich.
  await staff.getByRole('button', { name: 'Auftragsbestätigung freigeben' }).click();
  await expect(staff.getByText('Freigegeben')).toBeVisible();
  await staff.getByRole('button', { name: 'Auftragsbestätigung versenden' }).click();
  await expect(staff.getByText('Versendet', { exact: true })).toBeVisible();
});

// ── Szenario D: Neue Version ersetzt V1 ──────────────────────────────────

test('D: V1 senden → neue Version → alter Link tot → V2 annehmbar', async () => {
  processIdD = await createProcess(staff, 'Willi', 'Wechsel', 'willi@e2e.example');
  await fillInquiry(staff, processIdD);
  await createOfferDraft(staff, processIdD);
  const linkV1 = await sendOffer(staff);

  await staff.getByRole('button', { name: 'Neue Version erstellen' }).click();
  await expect(staff.getByRole('heading', { name: /Version 2/ })).toBeVisible();
  const linkV2 = await sendOffer(staff, linkV1);
  expect(linkV2).not.toBe(linkV1);

  // V1-Link ist durch die Token-Rotation neutral tot (keine Annahme möglich).
  await customerPage.goto(`${WEB_ORIGIN}${linkV1}`);
  await expect(
    customerPage.getByRole('heading', { name: 'Angebot nicht verfügbar' }),
  ).toBeVisible();

  // V2 ist annehmbar.
  await customerPage.goto(`${WEB_ORIGIN}${linkV2}`);
  await expect(customerPage.getByText(/Version 2/)).toBeVisible();
  await customerPage.getByRole('button', { name: 'Angebot verbindlich annehmen' }).click();
  await expect(customerPage.getByRole('heading', { name: 'Vielen Dank!' })).toBeVisible();
});

// ── Szenario E: Ablauf → Annahme blockiert → erneute Prüfung ─────────────

test('E: Abgelaufenes Angebot ist nicht annehmbar; erneute Prüfung anfragbar', async () => {
  const processIdE = await createProcess(staff, 'Emma', 'Eilig', 'emma@e2e.example');
  await fillInquiry(staff, processIdE);
  await createOfferDraft(staff, processIdE);
  const linkE = await sendOffer(staff);

  // Zeitreise: Ablaufdatum in die Vergangenheit setzen (nur diese eine
  // versendete Version – alle anderen sind bereits angenommen/ersetzt).
  execSync(
    `docker exec mietroyal-postgres psql -U mietroyal -d mietroyal_test -c "UPDATE offer_versions SET expires_at = now() - interval '1 hour' WHERE status = 'sent'"`,
    { stdio: 'pipe' },
  );

  await customerPage.goto(`${WEB_ORIGIN}${linkE}`);
  await expect(customerPage.getByRole('heading', { name: 'Angebot abgelaufen' })).toBeVisible();
  await expect(
    customerPage.getByRole('button', { name: 'Angebot verbindlich annehmen' }),
  ).toHaveCount(0);
  await customerPage.getByRole('button', { name: 'Erneute Prüfung anfragen' }).click();
  await expect(
    customerPage.getByText('Deine Anfrage zur erneuten Prüfung ist eingegangen.'),
  ).toBeVisible();
});

// ── Szenario F: Rabatt über 20 % braucht eine Freigabe ───────────────────

test('F: >20 % Rabatt ohne Freigabe blockiert den Versand; nach Freigabe klappt er', async ({
  browser,
}) => {
  // Admin bereitet Vorgang + Anfrage vor (der Verkäufer hat kein customer.create).
  processIdF = await createProcess(staff, 'Rita', 'Rabatt', 'rita@e2e.example');
  await fillInquiry(staff, processIdF);

  const seller = await browser.newPage();
  await login(seller, SELLER_EMAIL, SELLER_PASSWORD, 'Viktor');
  await createOfferDraft(seller, processIdF);

  // 25 % Rabatt mit Grund setzen (discount.over_20_request erlaubt das Setzen).
  await seller.getByLabel('Art').selectOption({ label: 'Prozent' });
  await seller.getByLabel('Prozent (z. B. 10)').fill('25');
  await seller.getByLabel('Interner Grund (Pflicht über 10 %)').fill('Stammkunden-Aktion (Test)');
  await seller.getByRole('button', { name: 'Rabatt setzen' }).click();
  await expect(seller.getByText(/Rabatt: -30,00/)).toBeVisible();
  await expect(seller.getByText(/Fester Angebotswert: 90,00/)).toBeVisible();

  // Versand ohne Freigabe → Fehlermeldung, KEIN öffentlicher Link.
  await seller.getByRole('button', { name: 'Angebot versenden' }).click();
  await expect(seller.locator('.error')).toContainText('Freigabe');
  await expect(seller.getByTestId('public-offer-link')).toHaveCount(0);

  // Admin gibt den Rabatt frei (discount.over_20_approve).
  await staff.goto(`/vorgaenge/${processIdF}/angebot`);
  await staff.getByRole('button', { name: 'Rabatt freigeben (>20 %)' }).click();
  await expect(staff.getByText('Rabattfreigabe erteilt.')).toBeVisible();

  // Jetzt darf der Verkäufer versenden.
  await seller.reload();
  await expect(seller.getByText('Rabattfreigabe erteilt.')).toBeVisible();
  const link = await sendOffer(seller);
  expect(link).toMatch(/^\/angebot\//);
  await seller.close();
});
