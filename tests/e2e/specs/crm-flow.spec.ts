/**
 * Phase-2-E2E-Pflichtablauf (Vorgabe Nr. 23): Admin-Login → Kunde anlegen →
 * Vorgang anlegen → Vorgangsliste → Suche → Mitarbeiter zuweisen → interne
 * Notiz → Vorgang abschließen → Sichtbarkeit/Bearbeitung nach Abschluss.
 * Ausschließlich synthetische Testdaten (global-setup.ts).
 */
import { expect, test, type Page } from '@playwright/test';

const ADMIN_EMAIL = 'admin@e2e.example';
const ADMIN_PASSWORD = 'e2e-admin-passwort-1';

test.describe.configure({ mode: 'serial' });

let page: Page;
let processNumber = '';

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
});

test('Admin meldet sich an', async () => {
  await page.goto('/login');
  await page.getByLabel('E-Mail').fill(ADMIN_EMAIL);
  await page.getByLabel('Passwort', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: /Willkommen, Erika/ })).toBeVisible();
});

test('Kunde anlegen (Privatperson, minimale Pflichtfelder)', async () => {
  await page.getByRole('link', { name: 'Kunden', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Kunden' })).toBeVisible();
  await page.getByRole('button', { name: 'Kunde anlegen' }).click();
  await page.getByLabel('Vorname').fill('Klara');
  await page.getByLabel('Nachname').fill('Musterfrau');
  await page.getByLabel('E-Mail (optional)').fill('klara@e2e.example');
  await page.getByLabel('Telefon (optional)').fill('0170 1112233');
  await page.getByRole('button', { name: 'Kunde anlegen' }).click();
  await expect(page.getByRole('heading', { name: 'Klara Musterfrau' })).toBeVisible();
  await expect(page.getByText('E-Mail: klara@e2e.example')).toBeVisible();
});

test('Vorgang für den Kunden anlegen (MR-Nummer sichtbar)', async () => {
  await page.getByRole('button', { name: 'Vorgang anlegen' }).click();
  await expect(page.getByRole('heading', { name: /^MR-\d{4}-\d{4,}$/ })).toBeVisible();
  processNumber = (await page.getByRole('heading', { name: /^MR-/ }).innerText()).trim();
  await expect(page.getByText('Klara Musterfrau')).toBeVisible();
  await expect(page.locator('.badge.active')).toHaveText('Offen');
  // NÄCHSTE AKTION ist seit Phase 3 dynamisch: ohne Anfrage → „Anfrage erfassen“.
  await expect(page.getByRole('heading', { name: 'Nächste Aktion' })).toBeVisible();
  await expect(
    page.getByLabel('Nächste Aktion').getByRole('link', { name: 'Anfrage erfassen' }),
  ).toBeVisible();
});

test('Vorgangsliste zeigt den offenen Vorgang', async () => {
  await page.getByRole('link', { name: 'Vorgänge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vorgänge' })).toBeVisible();
  await expect(page.getByRole('link', { name: processNumber })).toBeVisible();
  await expect(page.getByText('Musterfrau, Klara')).toBeVisible();
});

test('Globale Suche findet den Vorgang über einen Namensteil', async () => {
  await page.getByRole('link', { name: 'Suche' }).click();
  await page.getByRole('searchbox').fill('Musterfr');
  await expect(page.getByRole('heading', { name: 'Vorgänge' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Kunden' })).toBeVisible();
  await expect(page.getByRole('link', { name: processNumber })).toBeVisible();
  // Über die Suche direkt in den Vorgang springen.
  await page.getByRole('link', { name: processNumber }).click();
  await expect(page.getByRole('heading', { name: processNumber })).toBeVisible();
});

test('Mitarbeiter zuweisen', async () => {
  await page.getByLabel('Zuständiger Mitarbeiter').selectOption({ label: 'E2E, Erika' });
  await expect(page.getByText('Zuständig: Erika E2E')).toBeVisible();
});

test('Interne Notiz anlegen (Autor sichtbar)', async () => {
  await page.getByLabel('Neue Notiz').fill('Aufbau am Vortag telefonisch geklärt.');
  await page.getByRole('button', { name: 'Notiz speichern' }).click();
  await expect(page.getByText('Aufbau am Vortag telefonisch geklärt.')).toBeVisible();
  await expect(page.getByText(/Erika E2E ·/)).toBeVisible();
});

test('Vorgang abschließen', async () => {
  await page.getByRole('button', { name: 'Vorgang abschließen' }).click();
  await expect(page.locator('.badge.locked').first()).toHaveText('Abgeschlossen');
});

test('Nach Abschluss: Bearbeitung gesperrt, Sichtbarkeit nur über Filter', async () => {
  // Bearbeitungsfunktionen sind verschwunden, die Sperr-Erklärung ist da.
  await expect(page.getByText(/für die normale Bearbeitung gesperrt/)).toBeVisible();
  await expect(page.getByLabel('Neue Notiz')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Vorgang abschließen' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Datum ändern' })).toHaveCount(0);
  // Admin mit Recht sieht die Wiederöffnen-Aktion.
  await expect(page.getByRole('button', { name: 'Wieder öffnen' })).toBeVisible();

  // Standard-Vorgangsliste zeigt nur offene Vorgänge – der Vorgang fehlt.
  // (Offene Vorgänge aus dem Commerce-Spec können weiterhin gelistet sein.)
  await page.getByRole('link', { name: 'Vorgänge', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vorgänge' })).toBeVisible();
  await expect(page.getByRole('link', { name: processNumber })).toHaveCount(0);

  // Mit „Abgeschlossene einblenden“ (Berechtigung!) erscheint er wieder.
  await page.getByLabel('Abgeschlossene einblenden').check();
  await expect(page.getByRole('link', { name: processNumber })).toBeVisible();
  await expect(page.locator('.badge.locked')).toHaveText('Abgeschlossen');
});
