/**
 * Phase-8-E2E-Szenarien A–K (Order §93): Offlinebetrieb, PWA-Sync und
 * Lager-/Tabletmodus der Staff-App – ausschließlich über die echten Wege
 * (Login, Arbeitspaket, bestehende Wizards, Synchronisierung).
 *
 * A Login online → Arbeitspaket → offline → Neustart aus dem verschlüsselten
 *   Arbeitsbereich (Manifest, Service Worker, kein /api im Cache, IndexedDB
 *   ohne Klartext, flüchtiger Schlüssel, App-Sperre + Offline-Entsperrung).
 * B Offline-Ausgabe → lokal abgeschlossen (pending, NICHT server-final)
 *   → online synchronisiert → Server final (Protokoll, Lieferschein, Maschine).
 * C/D Offline-Rückgabe mit Kommission (returned > issued lokal abgelehnt),
 *   Schaden + Foto → Sync → Reinigung, Rückgabeprotokoll, Schaden serverseitig.
 * E Serveränderung während der Offline-Arbeit → Konflikt statt Overwrite,
 *   lokale Beweise bleiben, bewusstes Verwerfen.
 * F Zwei Geräte schließen denselben Vorgang offline ab → einer gewinnt,
 *   der andere sieht den Konflikt; genau ein Fachabschluss.
 * G 15-Minuten-Sperre auch offline → sichere Offline-Entsperrung →
 *   Pending-Daten unverändert; Logout mit Pending warnt.
 * H Lease > 72 h → Offline-Öffnung blockiert → online neu autorisiert.
 * I Lageransicht pro Gerät → offline Ausgabe/Rückgabe/QR/Reinigung, keine
 *   Admin-Bereiche, keine PIN, keine Rechteerweiterung, kein Rohtoken lokal.
 * J Neue Service-Worker-Version → Hinweis erst ohne ausstehende Erfassung →
 *   Pending-Daten bleiben.
 * K Abmelden ohne ausstehende Daten → lokaler Arbeitsbereich vollständig gelöscht.
 *
 * Läuft unabhängig (Basis-Seed zu Beginn, eigene Buchungen über die echten
 * Phase-3/4/6-Wege). Ausschließlich synthetische Testdaten; Fotos und
 * Unterschriften sind Testpixel. Der Staff-Server läuft als Produktions-Build
 * (playwright.config.ts), damit die App-Shell offline startet.
 */
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { acceptedBooking as acceptedBookingViaUi } from '../helpers/booking.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  SELLER_EMAIL,
  SELLER_PASSWORD,
  resetE2eDatabase,
} from '../helpers/seed.ts';

/** 1×1-PNG (Testpixel) für Gesamtfotos. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** Kleinstes gültiges JPEG (1×1) – Schadensfoto. */
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let staff: Page;
let customerPage: Page;
let processB = '';
let numberB = '';
let bookingB = '';
let processE = '';
let bookingE = '';
let processF = '';
let numberF = '';
let bookingF = '';
let qrToken03 = '';
let qrToken05 = '';

test.beforeAll(async ({ browser }) => {
  resetE2eDatabase();
  // Eigener Kontext für das „Gerät“ (Offline-Schaltung, Service Worker, IndexedDB);
  // die Kundenseite bleibt in einem separaten Kontext dauerhaft online.
  context = await browser.newContext();
  staff = await context.newPage();
  customerPage = await browser.newPage();
});
test.afterAll(async () => {
  await customerPage.close();
  await context.close();
});

async function login(page: Page, email: string, password: string, firstName: string) {
  await page.goto('/login');
  await page.getByLabel('E-Mail').fill(email);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Heute' })).toBeVisible();
  await expect(page.getByText(new RegExp(`Willkommen, ${firstName}`))).toBeVisible();
}

const pad = (value: number) => String(value).padStart(2, '0');
function berlinTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
function berlinDayPlus(days: number): string {
  const [y, m, d] = berlinTodayIso().split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}
function fillAt(dayIso: string, hour: number, minute = 0): string {
  return `${dayIso}T${pad(hour)}:${pad(minute)}`;
}

/** Sichtbarer Text eines unkomprimierten pdfkit-Dokuments (Hex-Strings). */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  let out = '';
  for (const match of raw.matchAll(/<([0-9a-fA-F]+)>/g)) {
    const hex = match[1]!;
    if (hex.length % 2 === 0) out += Buffer.from(hex, 'hex').toString('latin1');
  }
  return `${raw}\n${out}`;
}

/** Privates Dokument über die authentifizierte Staff-Session laden. */
async function fetchPdf(href: string): Promise<string> {
  const response = await staff.request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type'] ?? '').toContain('application/pdf');
  return pdfText(await response.body());
}

/** Wartet auf Service Worker + geladenes Arbeitspaket (Indikator ONLINE, Paketstand sichtbar). */
async function waitForOfflineReady(page: Page) {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.active !== null && registration?.active !== undefined;
  });
  await page.goto('/sync');
  await expect(page.getByText(/Arbeitspaket \(heute ±3 Tage\) vom/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'online',
  );
}

async function refreshPackage(page: Page) {
  await page.goto('/sync');
  await page.getByTestId('package-refresh').click();
  await expect(page.getByText('Arbeitspaket aktualisiert.')).toBeVisible({ timeout: 30_000 });
}

async function goOffline(page: Page) {
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'offline',
  );
}

/** Online schalten, synchronisieren und warten, bis nichts mehr aussteht (mit Diagnose). */
async function goOnlineAndSync(page: Page) {
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'online',
    {
      timeout: 30_000,
    },
  );
  await page.goto('/sync');
  await page.getByTestId('sync-now').click();
  await expect
    .poll(
      async () => {
        const pending = await page.getByTestId('offline-indicator').getAttribute('data-pending');
        if (pending === '0') return '0';
        const rows = await page.getByTestId('sync-pending-row').allTextContents();
        const status = await page.getByTestId('sync-status').textContent();
        console.log(`[sync] pending=${pending} status=${status} rows=${JSON.stringify(rows)}`);
        return pending;
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toBe('0');
}

/** Anzahl der Datensätze eines lokalen Stores (Klartext-Metadaten, keine Fachdaten). */
async function storeCount(page: Page, storeName: string): Promise<number> {
  return page.evaluate(async (store) => {
    const databases = await indexedDB.databases();
    const name = databases.map((d) => d.name ?? '').find((n) => n.startsWith('mietroyal-offline-'));
    if (name === undefined) return -1;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count;
  }, storeName);
}

/** Klartext-Serialisierung eines lokalen Stores (zum Nachweis, dass Rohtoken/Fachdaten fehlen). */
async function storeText(page: Page, storeName: string): Promise<string> {
  return page.evaluate(async (store) => {
    const databases = await indexedDB.databases();
    const name = databases.map((d) => d.name ?? '').find((n) => n.startsWith('mietroyal-offline-'));
    if (name === undefined) return '';
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return JSON.stringify(rows, (_k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v));
  }, storeName);
}

/** Diagnose: Klartext-Metadaten des lokalen Stores (keine Fachdaten) protokollieren. */
async function dumpOfflineStore(page: Page, label: string) {
  const info = await page.evaluate(async () => {
    const databases = await indexedDB.databases();
    const names = databases
      .map((d) => d.name ?? '')
      .filter((n) => n.startsWith('mietroyal-offline-'));
    const result: Record<string, unknown> = {
      names,
      identity: localStorage.getItem('mr.staff.offlineIdentity'),
    };
    for (const name of names) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const rows = await new Promise<{ processId: string; packageId: string }[]>(
        (resolve, reject) => {
          const request = db.transaction('bookings').objectStore('bookings').getAll();
          request.onsuccess = () =>
            resolve(request.result as { processId: string; packageId: string }[]);
          request.onerror = () => reject(request.error);
        },
      );
      const packages = await new Promise<{ packageId: string }[]>((resolve, reject) => {
        const request = db.transaction('packages').objectStore('packages').getAll();
        request.onsuccess = () => resolve(request.result as { packageId: string }[]);
        request.onerror = () => reject(request.error);
      });
      db.close();
      result[name] = {
        bookings: rows.map((r) => `${r.processId}@${r.packageId.slice(0, 8)}`),
        packages: packages.map((p) => p.packageId.slice(0, 8)),
      };
    }
    return result;
  });
  console.log(`[store:${label}] ${JSON.stringify(info)}`);
}

/** Offline-Navigation: harte Navigation, der Service Worker liefert die gecachte Seite. */
async function gotoOffline(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'commit' });
}

async function setTime(processId: string, row: 'Abholung / Ausgabe' | 'Rückgabe', start: string) {
  await staff.goto(`/vorgaenge/${processId}/termine`);
  await staff.locator('.entry-row', { hasText: row }).click();
  const card = staff.getByTestId('appointment-preview');
  await card.getByLabel('Beginn').fill(start);
  await card.getByLabel('Ende (optional, Zeitfenster)').fill('');
  staff.once('dialog', (dialog) => void dialog.accept());
  await card.getByRole('button', { name: 'Zeit speichern' }).click();
  await expect(
    staff.locator('.entry-row', { hasText: row }).getByText(`${start.slice(11)} Uhr`),
  ).toBeVisible();
  await card.getByLabel('Vorschau schließen').click();
}

async function ensureInitialStock(slug: string, productName: string, amount: number) {
  await staff.goto('/lager');
  const row = staff.getByTestId(`inventory-${slug}`);
  await expect(row).toBeVisible();
  if ((await row.getByText(/Noch nicht initial erfasst/).count()) === 0) return;
  await row.getByLabel(`Anfangsbestand ${productName}`).fill(String(amount));
  await row.getByRole('button', { name: 'Anfangsbestand erfassen' }).click();
  await expect(staff.getByRole('heading', { name: 'Inventur' })).toBeVisible();
  await staff.getByRole('button', { name: 'Bestandskorrektur freigeben' }).click();
  await expect(staff.getByText('Inventur freigegeben – Bestand wurde angepasst.')).toBeVisible();
}

async function acceptedBooking(firstName: string, lastName: string, email: string) {
  return acceptedBookingViaUi(staff, customerPage, {
    firstName,
    lastName,
    email,
    machineLabel: '1×10 L',
    guestCount: 30,
    freeSyrupLiters: 1,
    confirmOrder: true,
  });
}

async function bookingIdOf(page: Page, processId: string): Promise<string> {
  const response = await page.request.get(`/api/staff/processes/${processId}/handover`);
  const body = (await response.json()) as { detail: { booking: { id: string } } | null };
  return body.detail!.booking.id;
}

async function assignAndPrepareOnline(processId: string, machineCode: string) {
  await staff.goto(`/vorgaenge/${processId}/ausgabe`);
  const slot = staff.getByTestId('slot-1');
  await slot.getByRole('button', { name: 'Maschine wählen' }).click();
  await staff
    .getByTestId(`suggest-${machineCode}`)
    .getByRole('button', { name: 'Wählen', exact: true })
    .click();
  await expect(staff.getByText(`Maschine ${machineCode} zugewiesen.`)).toBeVisible();
  await slot.getByRole('button', { name: 'Als vorbereitet markieren' }).click();
  await expect(slot).toContainText('Vorbereitet');
}

/** Zusatzposition (Kommission) im Lieferschein-Entwurf – online, vor der Offline-Ausgabe. */
async function addAddition(processId: string, productName: string, quantity: number) {
  await staff.goto(`/vorgaenge/${processId}/ausgabe`);
  const note = staff.getByTestId('delivery-note');
  const option = note.locator('#addition-product option', { hasText: productName });
  await note.locator('#addition-product').selectOption((await option.getAttribute('value'))!);
  await note.getByLabel('Zusatzmenge').fill(String(quantity));
  await note.getByRole('button', { name: 'Zusatzposition hinzufügen' }).click();
  await expect(staff.getByText(/Zusatzposition mit aktuellem Preis gespeichert/)).toBeVisible();
}

async function next(page: Page) {
  await page.getByTestId('wizard-next').click();
}

async function sign(page: Page, label: 'Kunde' | 'Mitarbeiter') {
  const padLocator: Locator = page.getByTestId(`signature-${label}`);
  const canvas = padLocator.getByLabel(`Unterschrift ${label}`);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 110);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 150, { steps: 8 });
  await page.mouse.move(box.x + 320, box.y + 80, { steps: 8 });
  await page.mouse.up();
  await padLocator.getByRole('button', { name: 'Unterschrift übernehmen' }).click();
}

async function clickDiagram(svg: Locator, fx: number, fy: number) {
  const box = (await svg.boundingBox())!;
  await svg.click({ position: { x: box.width * fx, y: box.height * fy } });
}

async function machineByCode(page: Page, machineCode: string) {
  const machines = (await (await page.request.get('/api/staff/machines')).json()) as {
    machines: { id: string; machineCode: string; status: string }[];
  };
  const machine = machines.machines.find((m) => m.machineCode === machineCode);
  expect(machine).toBeDefined();
  return machine!;
}

/** Übergabe-Wizard ab Schritt „Prüfung & Foto“ bis zum lokalen Abschluss (offline). */
async function handoverWizardOffline(page: Page, processId: string) {
  await gotoOffline(page, `/vorgaenge/${processId}/uebergabe`);
  await expect(page.getByTestId('wizard-offline-banner')).toBeVisible();
  await next(page); // Vorgang
  await next(page); // Maschinen (vorbereitet)
  await next(page); // Artikel
  await page.getByRole('button', { name: 'Maschine gemeinsam geprüft' }).click();
  await expect(page.getByTestId('check-1')).toContainText('Maschine gemeinsam geprüft');
  await page
    .getByTestId('photo-input-1')
    .setInputFiles({ name: 'gesamtfoto.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(
    page.getByTestId('check-1').locator('img.photo-thumb[data-local="true"]'),
  ).toHaveCount(1);
  await next(page); // Empfänger
  await page.getByRole('button', { name: 'Übernehmen', exact: true }).click();
  await expect(page.getByText('Empfangsperson gespeichert.')).toBeVisible();
  await next(page); // Zusammenfassung
  await next(page); // Unterschrift Kunde
  await sign(page, 'Kunde');
  await expect(page.getByText(/Unterschrieben von/)).toBeVisible();
  await next(page);
  await sign(page, 'Mitarbeiter');
  await expect(page.getByText(/Unterschrieben von/)).toBeVisible();
  await next(page);
  await expect(page.getByTestId('wizard-blockers')).toHaveCount(0);
  await page.getByTestId('finalize-button').click();
  await expect(page.getByTestId('wizard-offline-pending')).toContainText(
    'Übergabe offline erfasst – Synchronisierung ausstehend.',
  );
}

// ── Szenario A: PWA-Offline-Start ────────────────────────────────────────

test('A: Login online → Arbeitspaket → offline → Neustart aus dem verschlüsselten Arbeitsbereich', async () => {
  test.setTimeout(300_000);
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  // Bestände ehrlich erfassen (kein erfundener Bestand): die Offline-Ausgabe blockiert sonst.
  await ensureInitialStock('sirup-kirsche', 'Sirup Kirsche', 20);
  await ensureInitialStock('sirup-waldmeister', 'Sirup Waldmeister', 10);
  await ensureInitialStock('strohhalme-25', 'Strohhalme (25 Stück)', 20);
  await ensureInitialStock('becher-25', 'Becher (25 Stück)', 40);
  ({ processId: processB, processNumber: numberB } = await acceptedBooking(
    'Olga',
    'Offline',
    'olga@e2e.example',
  ));
  await setTime(processB, 'Abholung / Ausgabe', fillAt(berlinDayPlus(1), 9));
  await setTime(processB, 'Rückgabe', fillAt(berlinDayPlus(2), 11));
  await assignAndPrepareOnline(processB, 'MR-10-01-01');
  // Kommissionsartikel für die Offline-Rückgabe (Szenario C/D): 3 × Sirup Waldmeister.
  await addAddition(processB, 'Waldmeister', 3);
  bookingB = await bookingIdOf(staff, processB);

  // Manifest gültig + verlinkt, Icons abrufbar, Service Worker aktiv (Tests 1–3).
  const manifest = await staff.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  const manifestJson = (await manifest.json()) as {
    name: string;
    short_name: string;
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
  };
  expect(manifestJson.display).toBe('standalone');
  expect(manifestJson.icons.length).toBeGreaterThanOrEqual(3);
  expect(manifestJson.name.length).toBeGreaterThan(0);
  expect(manifestJson.short_name.length).toBeGreaterThan(0);
  expect(manifestJson.start_url).toBe('/');
  expect(manifestJson.icons.some((i) => i.sizes === '192x192' && i.type === 'image/png')).toBe(
    true,
  );
  expect(manifestJson.icons.some((i) => i.sizes === '512x512' && i.type === 'image/png')).toBe(
    true,
  );
  expect(manifestJson.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const icon of manifestJson.icons) {
    const iconResponse = await staff.request.get(icon.src);
    expect(iconResponse.ok()).toBe(true);
    expect(iconResponse.headers()['content-type']).toContain(icon.type.split('/')[1]!);
  }
  await expect(staff.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  await waitForOfflineReady(staff);
  // Erneut laden, damit der Sitzungs-Tab vom Service Worker kontrolliert wird und die
  // benötigten Seiten-Shells gecacht sind (Online-Besuch = Cache).
  await staff.reload();
  await staff.goto(`/vorgaenge/${processB}/ausgabe`);
  await staff.goto(`/vorgaenge/${processB}/uebergabe`);
  await staff.goto(`/vorgaenge/${processB}/rueckgabe`);
  await staff.goto('/ausgabe');
  await staff.goto('/rueckgabe');
  await staff.goto('/tablet');
  await staff.goto('/reinigung');
  await refreshPackage(staff);
  // Nach der Aktualisierung liegt genau EIN aktuelles Paket lokal (veraltetes bereinigt, Test 112).
  await refreshPackage(staff);
  expect(await storeCount(staff, 'packages')).toBe(1);

  // Keine Fachdaten im Service-Worker-Cache (Test 4).
  const cachedApi = await staff.evaluate(async () => {
    const keys = await caches.keys();
    let apiHits = 0;
    for (const key of keys) {
      const cache = await caches.open(key);
      for (const request of await cache.keys()) {
        if (new URL(request.url).pathname.startsWith('/api/')) apiHits += 1;
      }
    }
    return { keys, apiHits };
  });
  expect(cachedApi.keys.some((key) => key.startsWith('mr-'))).toBe(true);
  expect(cachedApi.apiHits).toBe(0);

  // IndexedDB: eigene Datenbank je Umgebung × Benutzer, Fachpayload verschlüsselt (Tests 5/8/92).
  const idb = await staff.evaluate(async () => {
    const databases = await indexedDB.databases();
    const name = databases.map((d) => d.name ?? '').find((n) => n.startsWith('mietroyal-offline-'));
    if (name === undefined) return { name: null, count: 0, plaintext: true };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction('bookings').objectStore('bookings').getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const text = JSON.stringify(rows);
    return {
      name,
      count: rows.length,
      plaintext: text.includes('Offline, Olga') || text.includes('olga@'),
    };
  });
  expect(idb.name).toMatch(/^mietroyal-offline-development-/);
  expect(idb.count).toBeGreaterThanOrEqual(1);
  expect(idb.plaintext).toBe(false);
  // Kein Passwort/Hash/TOTP im lokalen Arbeitsbereich (Test 14) – nur die Schlüsselhülle.
  const workspaceText = await storeText(staff, 'workspace');
  expect(workspaceText).toContain('wrappedByPassword');
  expect(workspaceText).not.toContain(ADMIN_PASSWORD);
  expect(workspaceText.toLowerCase()).not.toContain('totp');

  // Offline schalten, neu laden: App-Shell startet; die entsperrte Sitzung bleibt über
  // den flüchtigen Schlüssel im Service Worker erhalten (kein erneuter Passwort-Prompt).
  await goOffline(staff);
  await gotoOffline(staff, '/');
  await expect(staff.getByRole('heading', { name: 'Heute' })).toBeVisible({ timeout: 30_000 });
  await expect(staff.getByTestId('offline-indicator')).toContainText('OFFLINE');
  // App-Sperre auch offline (Test 11): Sperre auslösen → Sperrbildschirm; auch nach
  // Reload bleibt es gesperrt (Schlüssel im Worker gelöscht) → Offline-Entsperrung (Tests 9/10).
  await staff.evaluate(() => window.dispatchEvent(new Event('mr-app-locked')));
  await expect(staff.getByTestId('offline-unlock-hint')).toBeVisible({ timeout: 30_000 });
  await gotoOffline(staff, '/');
  await expect(staff.getByTestId('offline-unlock-hint')).toBeVisible({ timeout: 30_000 });
  await staff.locator('#unlock-password').fill('falsches-passwort');
  await staff.getByRole('button', { name: 'Entsperren' }).click();
  await expect(staff.getByText('Das Passwort ist falsch.')).toBeVisible();
  await staff.locator('#unlock-password').fill(ADMIN_PASSWORD);
  await staff.getByRole('button', { name: 'Entsperren' }).click();
  await expect(staff.getByRole('heading', { name: 'Heute' })).toBeVisible();
  await expect(staff.getByTestId('offline-indicator')).toContainText('OFFLINE');
  // Relevante Vorgänge sind offline sichtbar.
  await gotoOffline(staff, '/ausgabe');
  await staff.getByLabel('Tag').fill(berlinDayPlus(1));
  await expect(staff.getByTestId(`issue-${numberB}`)).toBeVisible();
  await context.setOffline(false);
});

// ── Szenario B: Offline-Ausgabe ───────────────────────────────────────────

test('B: Offline-Ausgabe → lokal abgeschlossen → online synchronisiert → Serverzustand korrekt', async () => {
  test.setTimeout(300_000);
  await goOffline(staff);
  await handoverWizardOffline(staff, processB);
  await expect(staff.getByTestId('offline-indicator')).toContainText('ÄNDERUNGEN AUSSTEHEND');
  // Serverseitig ist NICHTS final, solange nicht synchronisiert wurde (Test 41).
  const serverBefore = (await (
    await staff.request.get(`/api/staff/handover/${bookingB}`)
  ).json()) as {
    detail: { handover: { status: string } };
    documents: unknown[];
  };
  expect(serverBefore.detail.handover.status).not.toBe('finalized');
  expect(serverBefore.documents).toHaveLength(0);
  expect((await machineByCode(staff, 'MR-10-01-01')).status).not.toBe('rented');
  // Nicht als serverseitig ausgegeben behaupten: Ausgabe-Liste zeigt „offline erfasst“.
  await gotoOffline(staff, '/ausgabe');
  await staff.getByLabel('Tag').fill(berlinDayPlus(1));
  await expect(
    staff.getByTestId(`issue-${numberB}`).getByTestId('offline-pending-badge'),
  ).toContainText('Übergabe offline erfasst – Synchronisierung ausstehend');
  const pendingBefore = Number(
    await staff.getByTestId('offline-indicator').getAttribute('data-pending'),
  );
  expect(pendingBefore).toBeGreaterThanOrEqual(5); // Prüfung, Foto, Empfänger, 2 Unterschriften, Abschluss

  // Netz zurück → Synchronisierung → Server final (Tests 42–46).
  await goOnlineAndSync(staff);
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute('data-conflicts', '0');
  await expect(staff.getByTestId('offline-indicator')).toContainText('SYNCHRONISIERT');
  const serverAfter = (await (
    await staff.request.get(`/api/staff/handover/${bookingB}`)
  ).json()) as {
    detail: {
      handover: { status: string };
      slots: { machine: { machineCode: string } | null }[];
      machines: { photoCount?: number; photos?: unknown[] }[];
    };
    documents: { type: string }[];
  };
  expect(serverAfter.detail.handover.status).toBe('finalized');
  expect(serverAfter.documents).toHaveLength(2);
  expect(serverAfter.documents.map((d) => d.type).sort()).toEqual([
    'delivery_note',
    'handover_protocol',
  ]);
  expect((await machineByCode(staff, 'MR-10-01-01')).status).toBe('rented');
  // Der Wizard zeigt online den finalen Serverstand mit den serverseitig erzeugten Dokumenten.
  await staff.goto(`/vorgaenge/${processB}/uebergabe`);
  await expect(staff.getByText(/✓ Übergabe abgeschlossen am/)).toBeVisible();
  const final = staff.getByTestId('wizard-final');
  await expect(final.getByRole('link', { name: 'Lieferschein' })).toHaveCount(1);
  await expect(final.getByRole('link', { name: 'Übergabeprotokoll' })).toHaveCount(1);
  const protocolText = await fetchPdf(
    (await final.getByRole('link', { name: 'Übergabeprotokoll' }).getAttribute('href'))!,
  );
  expect(protocolText).toContain('MR-10-01-01');
  expect(protocolText).toContain('Offline, Olga');
  expect(protocolText).toContain('Erika E2E');
});

// ── Szenario C/D: Offline-Rückgabe ───────────────────────────────────────

test('C/D: Offline-Rückgabe mit Kommission, Schaden + Foto → Sync → Reinigung, Protokoll, Schaden', async () => {
  test.setTimeout(300_000);
  // Nach der synchronisierten Übergabe: Paket mit Rückgabe-Seed laden, Wizard-Shell online besuchen.
  await staff.goto(`/vorgaenge/${processB}/rueckgabe`);
  await refreshPackage(staff);
  await goOffline(staff);
  await gotoOffline(staff, `/vorgaenge/${processB}/rueckgabe`);
  await expect(staff.getByTestId('wizard-offline-banner')).toBeVisible();

  // Rückgabe offline beginnen, Rückgabeperson, Maschinen, Zubehör, Vorbereitung (Tests 48–51).
  await staff.getByTestId('return-start').click();
  await expect(staff.getByText('Rückgabe begonnen.')).toBeVisible();
  await expect(staff.getByRole('heading', { name: '1. Vorgang und Rückgabeperson' })).toBeVisible();
  await staff.getByTestId('returner-save').click();
  await expect(staff.getByText('Rückgabeperson übernommen.')).toBeVisible();
  await next(staff);
  await expect(staff.getByRole('heading', { name: '2. Maschinen bestätigen' })).toBeVisible();
  await expect(staff.getByTestId('return-machine-1')).toContainText('MR-10-01-01');
  await next(staff);
  await expect(staff.getByRole('heading', { name: '3. Zubehör prüfen' })).toBeVisible();
  await staff.getByTestId('accessory-complete-1').click();
  await expect(staff.getByTestId('accessory-1')).toContainText('✓ Zubehör vollständig');
  await next(staff);
  await expect(
    staff.getByRole('heading', { name: '4. Rückgabevorbereitung des Kunden' }),
  ).toBeVisible();
  await staff.getByTestId('cleanliness-confirm-1').click();
  await expect(staff.getByTestId('cleanliness-1')).toContainText('Ordnungsgemäß vorbereitet');
  await next(staff);

  // Kommission offline (Tests 52/53): mehr zurück als ausgegeben wird LOKAL abgelehnt.
  await expect(staff.getByRole('heading', { name: '5. Kommissionsrückgabe' })).toBeVisible();
  const row = staff.locator('[data-testid^="return-item-"]', { hasText: 'Waldmeister' });
  await expect(row).toContainText('Kommission');
  await expect(row).toContainText('Ausgegeben: 3');
  const pendingBeforeQuantity = Number(
    await staff.getByTestId('offline-indicator').getAttribute('data-pending'),
  );
  await row.getByLabel('Ungeöffnet zurück').fill('5');
  await row.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(staff.getByText(/Rückgabemenge muss zwischen 0 und 3 liegen/)).toBeVisible();
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute(
    'data-pending',
    String(pendingBeforeQuantity),
  );
  await row.getByLabel('Ungeöffnet zurück').fill('2');
  await row.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(staff.getByText('Rückgabemenge übernommen.')).toBeVisible();
  await expect(row).toContainText('verbraucht/abrechenbar: 1');
  await next(staff);

  // Schaden mit Marker + Foto offline (Tests 55/56); Foto bleibt lokal (data-local).
  await expect(staff.getByRole('heading', { name: '6. Schäden dokumentieren' })).toBeVisible();
  await staff.getByTestId('damage-add-1').click();
  const form = staff.getByTestId('damage-form-1');
  await staff.getByTestId('damage-diagram-view-left').click();
  await clickDiagram(staff.getByTestId('damage-diagram-svg'), 0.4, 0.3);
  await expect(staff.getByTestId('damage-diagram-marker-0')).toBeVisible();
  await form.locator('#damage-severity').selectOption('medium');
  await form.locator('#damage-description').fill('Kratzer offline erfasst (E2E)');
  await staff.getByTestId('damage-save').click();
  await expect(staff.getByText(/Schaden gespeichert/)).toBeVisible();
  const damage = staff
    .locator('.conflict-box', { hasText: 'Kratzer offline erfasst (E2E)' })
    .first();
  await expect(damage).toContainText('mittel');
  await staff
    .locator('input[data-testid^="damage-photo-input-"]')
    .setInputFiles({ name: 'schaden.jpg', mimeType: 'image/jpeg', buffer: JPEG_1X1 });
  await expect(staff.getByText('Schadensfoto gespeichert.')).toBeVisible();
  await expect(
    staff.getByTestId('damages-1').locator('img.photo-thumb[data-local="true"]'),
  ).toHaveCount(1);
  await next(staff);

  // Zusammenfassung, beide Unterschriften, lokaler Abschluss → pending (Tests 58/59).
  await expect(staff.getByRole('heading', { name: '7. Zusammenfassung' })).toBeVisible();
  await expect(staff.getByTestId('return-summary')).toContainText('Kratzer offline erfasst (E2E)');
  await expect(staff.getByTestId('return-summary')).not.toContainText('Rückgabe ohne Beanstandung');
  await next(staff);
  await expect(
    staff.getByRole('heading', { name: '8. Unterschrift Kunde / Vertreter' }),
  ).toBeVisible();
  await sign(staff, 'Kunde');
  await expect(staff.getByText(/Unterschrieben von/)).toBeVisible();
  await next(staff);
  await expect(staff.getByRole('heading', { name: '9. Unterschrift Mitarbeiter' })).toBeVisible();
  await sign(staff, 'Mitarbeiter');
  await expect(staff.getByText(/Unterschrieben von/)).toBeVisible();
  await next(staff);
  await expect(staff.getByRole('heading', { name: '10. Rückgabe abschließen' })).toBeVisible();
  await expect(staff.getByTestId('wizard-blockers')).toHaveCount(0);
  await staff.getByTestId('finalize-button').click();
  await expect(staff.getByTestId('wizard-offline-pending')).toContainText(
    'Rückgabe offline erfasst – Synchronisierung ausstehend.',
  );
  // Rückgabe-Liste offline: „offline erfasst“, keine Behauptung eines Serverabschlusses.
  await gotoOffline(staff, '/rueckgabe');
  await expect(
    staff.getByTestId(`return-${numberB}`).getByTestId('offline-pending-badge'),
  ).toBeVisible();
  // Serverseitig unverändert: Maschine weiterhin vermietet, Rückgabe nicht final.
  expect((await machineByCode(staff, 'MR-10-01-01')).status).toBe('rented');

  // Sync → serverseitig genau einmal finalisiert: Reinigung, Protokoll, Schaden (Tests 60–63).
  await goOnlineAndSync(staff);
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute('data-conflicts', '0');
  const machine = await machineByCode(staff, 'MR-10-01-01');
  expect(machine.status).toBe('cleaning');
  const returnAfter = (await (
    await staff.request.get(`/api/staff/returns/${bookingB}`)
  ).json()) as {
    detail: { return: { status: string } };
    documents: { type: string }[];
  };
  expect(returnAfter.detail.return.status).toBe('finalized');
  expect(returnAfter.documents.filter((d) => d.type === 'return_protocol')).toHaveLength(1);
  const condition = (await (
    await staff.request.get(`/api/staff/machines/${machine.id}/condition`)
  ).json()) as {
    currentDamages: { description: string }[];
  };
  expect(condition.currentDamages.map((d) => d.description)).toContain(
    'Kratzer offline erfasst (E2E)',
  );
  // Rückgabeprotokoll serverseitig erzeugt – mit Kommission und Schaden.
  await staff.goto(`/vorgaenge/${processB}`);
  const card = staff.getByTestId('process-return');
  await expect(card).toContainText('abgeschlossen am');
  const protocolHref = await card
    .getByRole('link', { name: 'Rückgabeprotokoll' })
    .getAttribute('href');
  const protocolText = await fetchPdf(protocolHref!);
  expect(protocolText).toContain('Rückgabeprotokoll');
  expect(protocolText).toContain('Kratzer offline erfasst (E2E)');
  expect(protocolText).toContain('ungeöffnet zurück 2');
  expect(protocolText).toContain('verbraucht/abrechenbar 1');
  // Reinigungsliste online zeigt die Maschine aus dem synchronisierten Return (Test 65).
  await staff.goto('/reinigung');
  await expect(staff.getByTestId('cleaning-MR-10-01-01')).toContainText('In Reinigung seit');
});

// ── Szenario E: Konflikt statt Overwrite ─────────────────────────────────

test('E: Serveränderung während Offline-Arbeit → Konflikt, lokale Beweise bleiben', async () => {
  test.setTimeout(300_000);
  ({ processId: processE } = await acceptedBooking('Konrad', 'Konflikt', 'konrad@e2e.example'));
  await setTime(processE, 'Abholung / Ausgabe', fillAt(berlinDayPlus(1), 13));
  await setTime(processE, 'Rückgabe', fillAt(berlinDayPlus(2), 15));
  await assignAndPrepareOnline(processE, 'MR-10-01-03');
  bookingE = await bookingIdOf(staff, processE);
  await staff.goto(`/vorgaenge/${processE}/uebergabe`);
  await refreshPackage(staff);

  await goOffline(staff);
  await gotoOffline(staff, `/vorgaenge/${processE}/uebergabe`);
  await next(staff);
  await next(staff);
  await next(staff);
  await staff.getByRole('button', { name: 'Maschine gemeinsam geprüft' }).click();
  await staff
    .getByTestId('photo-input-1')
    .setInputFiles({ name: 'gesamtfoto.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(
    staff.getByTestId('check-1').locator('img.photo-thumb[data-local="true"]'),
  ).toHaveCount(1);

  // Paralleler Online-Kontext: Maschine serverseitig anders zuweisen (API, nicht vom Offline-Tab betroffen).
  const slots = (await (await staff.request.get(`/api/staff/handover/${bookingE}`)).json()) as {
    detail: { slots: { id: string }[] };
  };
  const other = await machineByCode(staff, 'MR-10-01-04');
  const reassign = await staff.request.post(
    `/api/staff/handover/${bookingE}/slots/${slots.detail.slots[0]!.id}/assign`,
    { data: { machineId: other.id } },
  );
  expect(reassign.ok()).toBe(true);

  await context.setOffline(false);
  await staff.evaluate(() => window.dispatchEvent(new Event('online')));
  await staff.goto('/sync');
  await staff.getByTestId('sync-now').click();
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute('data-conflicts', /[1-9]/, {
    timeout: 60_000,
  });
  await expect(staff.getByTestId('offline-indicator')).toContainText('PRÜFUNG ERFORDERLICH');
  const conflict = staff.getByTestId('sync-conflict').first();
  await expect(conflict).toContainText('Die Maschine wurde zwischenzeitlich anders zugewiesen.');
  await expect(conflict).toContainText('Serverstand laden und die Eingabe prüfen');
  await expect(conflict.getByRole('link', { name: 'Serverstand laden & prüfen' })).toHaveAttribute(
    'href',
    `/vorgaenge/${processE}/uebergabe`,
  );
  // Serverstand wurde NICHT überschrieben; lokale Beweise (Foto) bleiben erhalten.
  const after = (await (await staff.request.get(`/api/staff/handover/${bookingE}`)).json()) as {
    detail: { slots: { machine: { machineCode: string } }[]; machines: { photos: unknown[] }[] };
  };
  expect(after.detail.slots[0]!.machine.machineCode).toBe('MR-10-01-04');
  // Beide Erfassungen (Prüfung + Foto) betreffen die neu zugewiesene Maschine → beide zur
  // Prüfung, nichts wird still angewendet, nichts bleibt „ausstehend“ hängen (Tests 77/81/88).
  await expect(staff.getByTestId('sync-conflict')).toHaveCount(2);
  await expect(staff.getByTestId('sync-pending-row')).toHaveCount(0);
  expect(await storeCount(staff, 'media')).toBeGreaterThanOrEqual(1);
  // Beide bewusst verwerfen (je mit Rückfrage) → keine Konflikte mehr.
  for (let remaining = 2; remaining > 0; remaining -= 1) {
    staff.once('dialog', (dialog) => void dialog.accept());
    await staff.getByTestId('sync-conflict').first().getByTestId('conflict-discard').click();
    await expect(staff.getByTestId('sync-conflict')).toHaveCount(remaining - 1);
  }
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute('data-conflicts', '0');
});

// ── Szenario F: Doppelgerät ──────────────────────────────────────────────

test('F: Zwei Geräte schließen denselben Vorgang offline ab → einer gewinnt, der andere sieht den Konflikt', async () => {
  test.setTimeout(360_000);
  ({ processId: processF, processNumber: numberF } = await acceptedBooking(
    'Doris',
    'Doppelt',
    'doris@e2e.example',
  ));
  await setTime(processF, 'Abholung / Ausgabe', fillAt(berlinDayPlus(1), 16));
  await setTime(processF, 'Rückgabe', fillAt(berlinDayPlus(2), 17));
  await assignAndPrepareOnline(processF, 'MR-10-01-05');
  bookingF = await bookingIdOf(staff, processF);
  await staff.goto(`/vorgaenge/${processF}/uebergabe`);
  await refreshPackage(staff);

  // Zweites Gerät desselben Benutzers (eigener Kontext = eigene Geräte-ID, eigener Store).
  const contextB = await staff.context().browser()!.newContext();
  const deviceB = await contextB.newPage();
  await login(deviceB, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await waitForOfflineReady(deviceB);
  await deviceB.reload();
  await deviceB.goto(`/vorgaenge/${processF}/uebergabe`);
  await refreshPackage(deviceB);

  await goOffline(staff);
  await handoverWizardOffline(staff, processF);
  await dumpOfflineStore(deviceB, 'B-before-offline');
  await deviceB.context().setOffline(true);
  await deviceB.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(deviceB.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'offline',
  );
  await gotoOffline(deviceB, `/vorgaenge/${processF}/uebergabe`);
  await dumpOfflineStore(deviceB, 'B-offline-wizard');
  await handoverWizardOffline(deviceB, processF);

  // Gerät A gewinnt (kein Konflikt), Gerät B sieht den Konflikt (Test 76).
  await goOnlineAndSync(staff);
  await expect(staff.getByTestId('sync-conflict')).toHaveCount(0);
  await deviceB.context().setOffline(false);
  await deviceB.evaluate(() => window.dispatchEvent(new Event('online')));
  await deviceB.goto('/sync');
  await deviceB.getByTestId('sync-now').click();
  await expect(deviceB.getByTestId('offline-indicator')).toHaveAttribute(
    'data-conflicts',
    /[1-9]/,
    {
      timeout: 60_000,
    },
  );
  await expect(deviceB.getByTestId('sync-conflict').first()).toContainText(
    'Bereits abgeschlossen – vermutlich von einem anderen Gerät.',
  );
  // Genau ein Fachabschluss, genau zwei Dokumente; lokale Beweise auf Gerät B bleiben (Tests 88/89).
  const detail = (await (await staff.request.get(`/api/staff/handover/${bookingF}`)).json()) as {
    detail: { handover: { status: string } };
    documents: unknown[];
  };
  expect(detail.detail.handover.status).toBe('finalized');
  expect(detail.documents).toHaveLength(2);
  expect((await machineByCode(staff, 'MR-10-01-05')).status).toBe('rented');
  expect(await storeCount(deviceB, 'media')).toBeGreaterThanOrEqual(3); // Foto + 2 Unterschriften
  await contextB.close();
});

// ── Szenario G: App-Sperre offline ───────────────────────────────────────

test('G: 15-Minuten-Sperre auch offline → sichere Offline-Entsperrung → Pending-Daten unverändert', async () => {
  test.setTimeout(240_000);
  await refreshPackage(staff);
  await staff.goto('/reinigung');
  await goOffline(staff);
  // Fake-Uhr VOR dem Offline-Start installieren, damit der Inaktivitäts-Timer des
  // AuthGuard auf der Fake-Uhr läuft und per runFor vorgespult werden kann.
  await staff.clock.install();
  await gotoOffline(staff, '/reinigung');
  // Reinigungsliste offline aus dem lokalen Paket: Maschine des synchronisierten Returns (Test 65).
  await expect(staff.getByTestId('cleaning-MR-10-01-01')).toContainText('In Reinigung seit');
  // Offline-Reinigungsabschluss als pending Mutation (Maschine aus synchronisiertem Return, Test 66).
  await staff.getByTestId('clean-complete-MR-10-01-01').click();
  await expect(staff.getByTestId('cleaning-pending')).toContainText(
    'Reinigung MR-10-01-01 offline erfasst – Synchronisierung ausstehend.',
  );
  const pendingBefore = await staff.getByTestId('offline-indicator').getAttribute('data-pending');
  expect(Number(pendingBefore)).toBeGreaterThanOrEqual(1);

  await staff.clock.runFor(16 * 60 * 1000);
  await expect(staff.getByRole('dialog', { name: 'App gesperrt' })).toBeVisible();
  // Gesperrt: keine Fachinhalte hinter dem Overlay.
  await expect(staff.getByTestId('cleaning-MR-10-01-01')).toHaveCount(0);
  await staff.locator('#unlock-password').fill(ADMIN_PASSWORD);
  await staff.getByRole('button', { name: 'Entsperren' }).click();
  await expect(staff.getByRole('dialog', { name: 'App gesperrt' })).toHaveCount(0);
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute(
    'data-pending',
    pendingBefore!,
  );
  // Abmelden mit ausstehenden Daten: Warnung, kein stilles Löschen (Test 114).
  const mutationsBeforeLogout = await storeCount(staff, 'mutations');
  await staff.getByRole('button', { name: 'Abmelden' }).click();
  const logoutDialog = staff.getByTestId('logout-dialog');
  await expect(logoutDialog).toBeVisible();
  await expect(logoutDialog).toContainText('nicht synchronisierte Erfassungen');
  await expect(logoutDialog).toContainText('unwiderruflich');
  await logoutDialog.getByTestId('logout-cancel').click();
  await expect(logoutDialog).toHaveCount(0);
  await expect(staff.getByRole('heading', { name: 'Reinigung', exact: true })).toBeVisible();
  expect(await storeCount(staff, 'mutations')).toBe(mutationsBeforeLogout);

  await goOnlineAndSync(staff);
  expect((await machineByCode(staff, 'MR-10-01-01')).status).toBe('ready');
});

// ── Szenario H: Lease-Ablauf ─────────────────────────────────────────────

test('H: Lease > 72 h → Offline-Öffnung blockiert → online neu autorisiert → wieder verfügbar', async () => {
  test.setTimeout(240_000);
  await goOffline(staff);
  // Gerätezeit 73 h in die Zukunft: die lokale Lease (max. 72 h) ist abgelaufen (Test 13).
  await staff.clock.setSystemTime(new Date(Date.now() + 73 * 3_600_000));
  await gotoOffline(staff, '/');
  await expect(staff.getByTestId('offline-unlock-hint')).toBeVisible({ timeout: 30_000 });
  await staff.locator('#unlock-password').fill(ADMIN_PASSWORD);
  await staff.getByRole('button', { name: 'Entsperren' }).click();
  await expect(
    staff.getByText(/Offline-Berechtigung dieses Geräts ist abgelaufen \(max\. 72 Stunden\)/),
  ).toBeVisible();
  // Keine Fachinhalte ohne gültige Lease.
  await expect(staff.getByRole('heading', { name: 'Heute' })).toHaveCount(0);

  // Online mit korrekter Gerätezeit: Re-Autorisierung über den Server (Passwort), Lease erneuert.
  await staff.clock.setSystemTime(new Date());
  await context.setOffline(false);
  await staff.locator('#unlock-password').fill(ADMIN_PASSWORD);
  await staff.getByRole('button', { name: 'Entsperren' }).click();
  await expect(staff.getByRole('heading', { name: 'Heute' })).toBeVisible({ timeout: 30_000 });
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'online',
    { timeout: 30_000 },
  );
  await staff.goto('/sync');
  await expect(staff.getByTestId('lease-info')).toContainText(
    'Offline-Berechtigung dieses Geräts gültig bis',
  );
  await expect(staff.getByText(/Arbeitspaket \(heute ±3 Tage\) vom/)).toBeVisible({
    timeout: 30_000,
  });
  // Offline wieder nutzbar (Lease erneuert).
  await goOffline(staff);
  await gotoOffline(staff, '/');
  await expect(staff.getByRole('heading', { name: 'Heute' })).toBeVisible({ timeout: 30_000 });
  await expect(staff.getByTestId('offline-indicator')).toContainText('OFFLINE');
  await context.setOffline(false);
});

// ── Szenario I: Lager-/Tabletmodus ───────────────────────────────────────

test('I: Lageransicht pro Gerät → offline Ausgabe/Rückgabe/QR/Reinigung, keine Admin-Bereiche', async () => {
  test.setTimeout(240_000);
  await staff.goto('/maschinen');
  await staff.getByRole('link', { name: 'MR-10-01-03' }).click();
  qrToken03 = (await staff.getByTestId('qr-token').innerText()).trim();
  await staff.goto('/maschinen');
  await staff.getByRole('link', { name: 'MR-10-01-05' }).click();
  qrToken05 = (await staff.getByTestId('qr-token').innerText()).trim();
  const consoleLines: string[] = [];
  const onConsole = (message: { text(): string }) => consoleLines.push(message.text());
  staff.on('console', onConsole);
  await staff.goto('/tablet');
  await staff.getByTestId('warehouse-mode-on').click();
  await expect(staff.getByText('Die Lageransicht ist auf diesem Gerät aktiv.')).toBeVisible();
  // Reduzierte Navigation – sofort, ohne Reload (Tests 118/119).
  await expect(staff.getByRole('link', { name: 'Mitarbeiter' })).toHaveCount(0);
  await expect(staff.getByRole('link', { name: 'Einstellungen' })).toHaveCount(0);
  await expect(staff.getByRole('link', { name: 'Lager-Tablet', exact: true })).toBeVisible();
  await expect(staff.getByRole('link', { name: 'Synchronisierung', exact: true })).toBeVisible();
  // Keine zusätzliche Lager-PIN: kein Dialog, kein Passwort-/PIN-Feld (Test 125).
  await expect(staff.getByRole('dialog')).toHaveCount(0);
  await expect(staff.locator('input[type="password"], input[inputmode="numeric"]')).toHaveCount(0);
  // Anderer Browser desselben Benutzers bleibt in der Vollansicht (Test 120); eingeschränkter
  // Benutzer bekommt im Tabletmodus keine Aktionen über seine Rechte hinaus (Tests 117/121).
  const otherContext = await staff.context().browser()!.newContext();
  const otherPage = await otherContext.newPage();
  await login(otherPage, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await otherPage.goto('/tablet');
  await expect(otherPage.getByRole('link', { name: 'Mitarbeiter' })).toBeVisible();
  await expect(otherPage.getByTestId('warehouse-mode-on')).toBeVisible();
  await otherPage.getByRole('button', { name: 'Abmelden' }).click();
  await otherPage.waitForURL(/\/login/);
  await login(otherPage, SELLER_EMAIL, SELLER_PASSWORD, 'Viktor');
  await otherPage.goto('/tablet');
  await otherPage.getByTestId('warehouse-mode-on').click();
  await expect(otherPage.getByText('Die Lageransicht ist auf diesem Gerät aktiv.')).toBeVisible();
  await expect(otherPage.getByTestId('tablet-ausgabe')).toHaveCount(0);
  await expect(otherPage.getByTestId('tablet-rueckgabe')).toHaveCount(0);
  await expect(otherPage.getByTestId('tablet-qr')).toHaveCount(0);
  await expect(otherPage.getByTestId('tablet-reinigung')).toHaveCount(0);
  await expect(otherPage.getByTestId('tablet-lager')).toHaveCount(0);
  await otherContext.close();

  await goOffline(staff);
  await gotoOffline(staff, '/tablet');
  await expect(staff.getByTestId('tablet-offline-banner')).toBeVisible();
  const actions = staff.getByTestId('tablet-actions');
  await expect(actions.getByTestId('tablet-ausgabe')).toContainText('AUSGABE');
  await expect(actions.getByTestId('tablet-rueckgabe')).toContainText('RÜCKGABE');
  await expect(actions.getByTestId('tablet-qr')).toContainText('QR SCANNEN');
  await expect(actions.getByTestId('tablet-reinigung')).toContainText('REINIGUNG');
  await expect(actions.getByTestId('tablet-lager')).toBeVisible();
  // QR offline über den lokalen Hash-Vergleich (Test 27/124).
  await actions.getByTestId('tablet-qr').click();
  await staff.locator('#qr-manual').fill(qrToken03);
  await staff.getByRole('button', { name: 'Auflösen' }).click();
  await expect(staff.getByTestId('tablet-scan-result')).toContainText('Maschine MR-10-01-03');
  await expect(
    staff.getByTestId('tablet-scan-result').getByRole('link', { name: 'Maschine / Reinigung' }),
  ).toBeVisible();
  await staff.getByRole('button', { name: 'Schließen' }).click();
  // Unbekannter QR: neutrale Meldung, keine Fachdaten (Test 29).
  await actions.getByTestId('tablet-qr').click();
  await staff.locator('#qr-manual').fill('0123456789abcdef0123456789abcdef0123456789abcdef');
  await staff.getByRole('button', { name: 'Auflösen' }).click();
  await expect(staff.getByText('Dieser QR-Code ist nicht gültig.')).toBeVisible();
  await staff.getByRole('button', { name: 'Schließen' }).click();
  // Ausgegebene Maschine → passender operativer Kontext: Rückgabe des Vorgangs (Test 124).
  await actions.getByTestId('tablet-qr').click();
  await staff.locator('#qr-manual').fill(qrToken05);
  await staff.getByRole('button', { name: 'Auflösen' }).click();
  await expect(staff.getByTestId('tablet-scan-result')).toContainText('Maschine MR-10-01-05');
  await expect(
    staff.getByTestId('tablet-scan-result').getByRole('button', { name: `Rückgabe ${numberF}` }),
  ).toBeVisible();
  await staff.getByRole('button', { name: 'Schließen' }).click();
  // Rohtoken weder in Konsolenausgaben noch im Klartext des lokalen Maschinen-Stores (Tests 28/96).
  staff.off('console', onConsole);
  expect(consoleLines.join('\n')).not.toContain(qrToken03);
  expect(consoleLines.join('\n')).not.toContain(qrToken05);
  const machinesText = await storeText(staff, 'machines');
  expect(machinesText.length).toBeGreaterThan(0);
  expect(machinesText).not.toContain(qrToken03);
  expect(machinesText).not.toContain(qrToken05);
  expect(machinesText.toLowerCase()).not.toContain(qrToken03.toLowerCase());
  // Rückgabe-Kachel listet die erwartete Rückgabe im Fenster heute ±3 Tage (Test 122).
  await actions.getByTestId('tablet-rueckgabe').click();
  await expect(staff.getByRole('heading', { name: 'Rückgabe', exact: true })).toBeVisible();
  await expect(staff.getByTestId(`return-${numberF}`)).toBeVisible();
  // Reinigungs-Kachel offline erreichbar.
  await gotoOffline(staff, '/tablet');
  await staff.getByTestId('tablet-actions').getByTestId('tablet-reinigung').click();
  await expect(staff.getByRole('heading', { name: 'Reinigung', exact: true })).toBeVisible();

  await context.setOffline(false);
  await staff.evaluate(() => window.dispatchEvent(new Event('online')));
  await staff.goto('/tablet');
  await staff.getByTestId('warehouse-mode-off').click();
  await expect(staff.getByRole('link', { name: 'Mitarbeiter' })).toBeVisible();
});

// ── Szenario J: PWA-Update ohne Datenverlust ──────────────────────────────

test('J: Neue Service-Worker-Version → Hinweis erst ohne ausstehende Erfassung → Pending-Daten bleiben', async () => {
  test.setTimeout(240_000);
  // Eine Maschine deterministisch in Reinigung bringen (Fachweg über das Maschinendetail).
  await staff.goto('/maschinen');
  await staff.getByRole('link', { name: 'MR-10-01-02' }).click();
  await staff.getByLabel('Neuer Status').selectOption({ label: '🟡 Reinigung' });
  await staff.getByRole('button', { name: 'Status speichern' }).click();
  await expect(staff.locator('.badge', { hasText: 'Reinigung' })).toBeVisible();
  await refreshPackage(staff);
  await staff.goto('/reinigung');
  await expect(staff.getByTestId('cleaning-MR-10-01-02')).toBeVisible();
  // Neue SW-Version simulieren (andere Script-URL = Update für denselben Scope).
  await staff.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js?v=e2e-update', { updateViaCache: 'none' });
  });
  await staff.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.waiting !== null && registration?.waiting !== undefined;
  });
  await goOffline(staff);
  await gotoOffline(staff, '/reinigung');
  // Wartende Version + ausstehende Erfassung: kein Update-Hinweis (§72).
  await staff.getByTestId('clean-complete-MR-10-01-02').click();
  await expect(staff.getByTestId('cleaning-pending')).toBeVisible();
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute('data-pending', /[1-9]/);
  await expect(staff.getByTestId('update-banner')).toHaveCount(0);
  await goOnlineAndSync(staff);
  expect((await machineByCode(staff, 'MR-10-01-02')).status).toBe('ready');
  await expect(staff.getByTestId('update-banner')).toContainText('Neue Version verfügbar.', {
    timeout: 30_000,
  });
  const mutationsBeforeUpdate = await storeCount(staff, 'mutations');
  const bookingsBeforeUpdate = await storeCount(staff, 'bookings');
  // Aktivierung nur per Klick; der Tab lädt danach mit der neuen Version neu.
  await Promise.all([
    staff.waitForEvent('load'),
    staff.getByRole('button', { name: 'Jetzt aktualisieren' }).click(),
  ]);
  // Die wartende Version ist aktiviert (keine wartende mehr, Seite wird von einem Worker
  // gesteuert, kein Hinweis mehr). Die Script-URL ist kein Nachweis: die App registriert bei
  // jedem Start wieder `/sw.js`, Chromium ersetzt damit die per Test-URL simulierte wartende
  // Version durch eine gleichwertige unter der Standard-URL.
  await expect
    .poll(
      () =>
        staff.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return (
            registration !== undefined &&
            registration.waiting === null &&
            navigator.serviceWorker.controller !== null
          );
        }),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(staff.getByTestId('update-banner')).toHaveCount(0);
  // Nach dem Update: Arbeitsbereich und Sitzung intakt, keine erneute Anmeldung, Daten vorhanden.
  await staff.goto('/sync');
  await expect(staff.getByTestId('lease-info')).toBeVisible({ timeout: 30_000 });
  await expect(staff.getByText(/Arbeitspaket \(heute ±3 Tage\) vom/)).toBeVisible();
  // Lokale Datensätze (Mutationen, Vorgänge) unverändert (Test 116).
  expect(await storeCount(staff, 'mutations')).toBe(mutationsBeforeUpdate);
  expect(await storeCount(staff, 'bookings')).toBe(bookingsBeforeUpdate);
});

// ── Szenario K: Logout ohne Pending löscht lokale Fachdaten ─────────────

test('K: Abmelden ohne ausstehende Daten → lokaler Arbeitsbereich vollständig gelöscht', async () => {
  test.setTimeout(120_000);
  await staff.goto('/sync');
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute('data-pending', '0');
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute('data-conflicts', '0');
  expect(await storeCount(staff, 'bookings')).toBeGreaterThan(0);
  await staff.getByRole('button', { name: 'Abmelden' }).click();
  await staff.waitForURL(/\/login/);
  // Alle Stores leer: Vorgänge, Maschinen, Dokumente, Medien, Mutationen, Arbeitsbereich (Test 113).
  for (const store of [
    'bookings',
    'machines',
    'documents',
    'media',
    'mutations',
    'workspace',
    'packages',
  ]) {
    expect(await storeCount(staff, store)).toBe(0);
  }
  expect(await staff.evaluate(() => localStorage.getItem('mr.staff.offlineIdentity'))).toBeNull();
  // Ohne Arbeitsbereich startet die App offline nicht mehr aus lokalen Daten.
  await context.setOffline(true);
  await gotoOffline(staff, '/');
  await expect(staff.getByText('Keine Verbindung zum Server. Bitte erneut versuchen.')).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  await expect(staff.getByRole('heading', { name: 'Heute' })).toHaveCount(0);
  await context.setOffline(false);
});
