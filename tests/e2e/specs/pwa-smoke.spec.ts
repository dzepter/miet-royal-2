/**
 * WebKit-Smoke der Staff-PWA (Phase-8-Order §94): PWA-Grundstart, IndexedDB,
 * Offline-App-Shell und Sync-Status auf der Safari-Engine (iPhone/iPad sind
 * wichtige Zielgeräte). Läuft nur im Playwright-Projekt „webkit“
 * (playwright.config.ts); Chromium deckt die vollständigen Offline-Szenarien
 * über offline-flow.spec.ts ab. Wenn WebKit in der Umgebung nicht
 * installierbar ist, wird das Projekt mit E2E_WEBKIT=0 abgeschaltet – dann
 * gilt dieser Smoke als NICHT ausgeführt.
 */
import { expect, test, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, resetE2eDatabase } from '../helpers/seed.ts';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetE2eDatabase();
});

async function login(page: Page) {
  await page.goto('/login');
  await page.getByLabel('E-Mail').fill(ADMIN_EMAIL);
  await page.getByLabel('Passwort', { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Heute' })).toBeVisible();
  await expect(page.getByText(/Willkommen, Erika/)).toBeVisible();
}

test('WebKit: PWA-Grundstart, IndexedDB, Offline-App-Shell, Sync-Status', async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);

  // PWA-Grundstart: Manifest gültig, verlinkt, PNG-Icons abrufbar (Tests 1/2).
  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  const manifestJson = (await manifest.json()) as {
    name: string;
    short_name: string;
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
  };
  expect(manifestJson.name.length).toBeGreaterThan(0);
  expect(manifestJson.short_name.length).toBeGreaterThan(0);
  expect(manifestJson.start_url).toBe('/');
  expect(manifestJson.display).toBe('standalone');
  expect(manifestJson.icons.some((i) => i.sizes === '192x192' && i.type === 'image/png')).toBe(
    true,
  );
  expect(manifestJson.icons.some((i) => i.sizes === '512x512' && i.type === 'image/png')).toBe(
    true,
  );
  expect(manifestJson.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const icon of manifestJson.icons.filter((i) => i.type === 'image/png')) {
    const iconResponse = await page.request.get(icon.src);
    expect(iconResponse.ok()).toBe(true);
    expect(iconResponse.headers()['content-type'] ?? '').toContain('png');
  }
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);

  // Service Worker registriert und aktiv, Scope = Wurzel (Test 2/3).
  const registration = await page.evaluate(async () => {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing?.active) return { active: true, scope: existing.scope };
    const ready = await navigator.serviceWorker.ready;
    return { active: ready.active !== null, scope: ready.scope };
  });
  expect(registration.active).toBe(true);
  expect(new URL(registration.scope).pathname).toBe('/');

  // Sync-Status online, Arbeitspaket geladen.
  await page.goto('/sync');
  await expect(page.getByText(/Arbeitspaket \(heute ±3 Tage\) vom/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('sync-status')).toContainText(/ONLINE|SYNCHRONISIERT/);
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'online',
  );

  // IndexedDB: Datenbank je Umgebung × Benutzer mit verschlüsseltem Arbeitsbereich
  // (Schlüsselhülle vorhanden, kein Passwort im Klartext) – Tests 5/8/14.
  const idb = await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    const name = databases.map((d) => d.name ?? '').find((n) => n.startsWith('mietroyal-offline-'));
    if (name === undefined) return { name: null, workspace: '' };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction('workspace').objectStore('workspace').getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return { name, workspace: JSON.stringify(rows) };
  });
  expect(idb.name).toMatch(/^mietroyal-offline-development-/);
  expect(idb.workspace).toContain('wrappedByPassword');
  expect(idb.workspace).not.toContain(ADMIN_PASSWORD);

  // Offline-App-Shell: ohne Netz neu laden → App startet aus dem lokalen Arbeitsbereich.
  // Je nach Engine bleibt die Sitzung über den flüchtigen Schlüssel entsperrt oder der
  // Sperrbildschirm „App gesperrt“ verlangt die Offline-Entsperrung mit dem Passwort.
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.goto('/', { waitUntil: 'commit' });
  const lockDialog = page.getByRole('dialog', { name: 'App gesperrt' });
  const heute = page.getByRole('heading', { name: 'Heute' });
  await expect(lockDialog.or(heute).first()).toBeVisible({ timeout: 30_000 });
  if ((await lockDialog.count()) > 0) {
    await expect(page.getByTestId('offline-unlock-hint')).toBeVisible();
    await page.locator('#unlock-password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Entsperren' }).click();
  }
  await expect(heute).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('offline-indicator')).toContainText('OFFLINE');
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'offline',
  );

  // Netz zurück → Sync-Status wieder ONLINE/SYNCHRONISIERT.
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'online',
    { timeout: 30_000 },
  );
  await page.goto('/sync');
  await expect(page.getByTestId('sync-status')).toContainText(/ONLINE|SYNCHRONISIERT/);
});
