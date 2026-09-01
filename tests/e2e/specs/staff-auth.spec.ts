/**
 * Phase-1-E2E-Smokes (Vorgabe Nr. 19): Staff-Login, Mitarbeiterverwaltung,
 * Mitarbeiter erstellen, Berechtigung ändern, Sperren, gesperrter Login.
 * Ein fortlaufender Ablauf mit synthetischen Testdaten (global-setup.ts).
 */
import { expect, test, type Page } from '@playwright/test';

const ADMIN_EMAIL = 'admin@e2e.example';
const ADMIN_PASSWORD = 'e2e-admin-passwort-1';
const EMPLOYEE_EMAIL = 'neu@e2e.example';
const EMPLOYEE_PASSWORD = 'e2e-mitarbeiter-pw-1';

test.describe.configure({ mode: 'serial' });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
});
test.afterAll(async () => {
  await page.close();
});

test('Staff-Login: Admin meldet sich an', async () => {
  await page.goto('/login');
  await page.getByLabel('E-Mail').fill(ADMIN_EMAIL);
  await page.getByLabel('Passwort', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: /Willkommen, Erika/ })).toBeVisible();
});

test('Admin öffnet die Mitarbeiterverwaltung', async () => {
  await page.getByRole('link', { name: 'Mitarbeiter', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Mitarbeiter' })).toBeVisible();
  await expect(page.getByText('E2E, Erika')).toBeVisible();
});

test('Mitarbeiter erstellen (inkl. Passwort über Einrichtungs-Link)', async () => {
  await page.getByRole('button', { name: 'Neuen Mitarbeiter anlegen' }).click();
  await page.getByLabel('Vorname').fill('Nora');
  await page.getByLabel('Nachname').fill('Neu');
  await page.getByLabel('E-Mail').fill(EMPLOYEE_EMAIL);
  await page.getByRole('button', { name: 'Anlegen', exact: true }).click();

  await expect(page.getByRole('heading', { name: /Einrichtungs-Link/ })).toBeVisible();
  const setupLink = (await page.locator('.code-box').textContent()) ?? '';
  expect(setupLink).toContain('/passwort-zuruecksetzen?token=');
  await expect(page.getByText('Neu, Nora')).toBeVisible();

  // Die neue Person setzt über den Link ihr eigenes Passwort (eigener Kontext).
  const employeeContext = await page.context().browser()!.newContext();
  const employeePage = await employeeContext.newPage();
  await employeePage.goto(setupLink);
  await employeePage.getByLabel('Neues Passwort', { exact: true }).fill(EMPLOYEE_PASSWORD);
  await employeePage.getByLabel('Neues Passwort wiederholen').fill(EMPLOYEE_PASSWORD);
  await employeePage.getByRole('button', { name: 'Passwort setzen' }).click();
  await expect(employeePage.getByRole('heading', { name: /Anmeldung/ })).toBeVisible();

  // Login der neuen Person funktioniert.
  await employeePage.getByLabel('E-Mail').fill(EMPLOYEE_EMAIL);
  await employeePage.getByLabel('Passwort', { exact: true }).fill(EMPLOYEE_PASSWORD);
  await employeePage.getByRole('button', { name: 'Anmelden' }).click();
  await expect(employeePage.getByRole('heading', { name: /Willkommen, Nora/ })).toBeVisible();
  await employeeContext.close();
});

test('Berechtigung ändern (individuelles Recht vergeben)', async () => {
  await page.getByRole('link', { name: 'Neu, Nora' }).click();
  await expect(page.getByRole('heading', { name: /Nora Neu/ })).toBeVisible();

  await page.getByLabel('Berechtigung').selectOption({ label: 'Kunden ansehen (customer.view)' });
  await page.getByRole('button', { name: 'Recht hinzufügen' }).click();
  await expect(page.getByText('Gespeichert.')).toBeVisible();
  await expect(page.getByText(/Erlaubt:.*Kunden ansehen/)).toBeVisible();
  await expect(page.getByText(/Effektive Rechte \(1\)/)).toBeVisible();
});

test('Mitarbeiter sperren', async () => {
  await page.getByRole('button', { name: 'Sperren' }).click();
  await expect(page.locator('.badge.locked')).toHaveText('gesperrt');
});

test('Gesperrter Mitarbeiter: Login scheitert mit neutraler Meldung', async () => {
  const lockedContext = await page.context().browser()!.newContext();
  const lockedPage = await lockedContext.newPage();
  await lockedPage.goto('/login');
  await lockedPage.getByLabel('E-Mail').fill(EMPLOYEE_EMAIL);
  await lockedPage.getByLabel('Passwort', { exact: true }).fill(EMPLOYEE_PASSWORD);
  await lockedPage.getByRole('button', { name: 'Anmelden' }).click();
  await expect(lockedPage.getByText(/Anmeldung nicht möglich/)).toBeVisible();
  // Keine internen Details (Status "gesperrt" wird nicht verraten).
  await expect(lockedPage.getByText(/gesperrt|deaktiviert/)).toHaveCount(0);
  await lockedContext.close();
});
