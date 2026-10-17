/**
 * Phase-8-Finalisierung – Härtungsszenarien L1–L7 (Pflichttests der
 * Finalisierungs-Order; die Nummern stehen an jeder Szene):
 *
 * L1 Abmelden mit ausstehenden Daten (41–45): Dialog statt stillem Löschen,
 *    Abbrechen lässt alles unverändert, „zuerst synchronisieren“ führt zu
 *    /sync, ohne Pending direkter Logout mit leeren Stores, bewusstes
 *    Verwerfen nur zweistufig.
 * L2 Geschützter PDF-Viewer (31–35): Dokument offline aus dem verschlüsselten
 *    Store als Blob-URL, Sperre entfernt Viewer und revoziert die URL, nach
 *    Entsperrung wieder nutzbar, kein PDF-Klartext im Store.
 * L3 Offline-Suche (36–40): Vorgangsnummer, Kundenname, Maschinencode, nur
 *    innerhalb des Arbeitspakets, kein Kundenname im Klartext der Stores.
 * L4 Konfliktdetails (26–30): Maschinenwechsel, Terminänderung, Storno und
 *    Rechte-Entzug als verständliche Gegenüberstellung ohne Kundendaten.
 * L5 Override offline (46–48): Grund ist Pflicht, Zuweisung bleibt pending,
 *    ohne `machine.override_block` kein Grundfeld.
 * L6 Lease/Uhr/Fehlversuche/Neuaufbau (54, 59–61): 5 Fehlversuche sperren die
 *    Offline-Entsperrung, eine zurückgestellte Uhr belebt keine Lease, der
 *    Neuaufbau nach Passwortänderung ist zweistufig, veraltete Pakete werden
 *    bereinigt.
 * L7 Client-Logs & QR (12, 53, 55–58): keine Telefonnummer, kein Rohtoken,
 *    keine Bildbytes in der Konsole; Token nie in einer Request-URL; QR-
 *    Ergebnis ohne Kundendaten.
 *
 * Läuft unabhängig (Basis-Seed zu Beginn, eigene Buchungen über die echten
 * Phase-3/4/6-Wege wie offline-flow A). Ausschließlich synthetische Testdaten;
 * Fotos und Unterschriften sind Testpixel. Der Staff-Server läuft als
 * Produktions-Build (playwright.config.ts), damit die App-Shell offline startet.
 *
 * Abweichungen von der wörtlichen Szenenbeschreibung (bewusst, begründet):
 * - Netz zurück = automatische Synchronisierung (§30/§42). „Online ohne Sync“
 *   ist über die echte Oberfläche kein erreichbarer Zustand; der Logout-Dialog
 *   wird deshalb offline ausgelöst, und für den Verwerfen-Zweig entsteht ein
 *   serverseitiger Konflikt, der auch online „ausstehend“ bleibt.
 * - Eine Passwortänderung widerruft alle ANDEREN Sitzungen. Von einem zweiten
 *   Gerät aus würde Gerät 1 beim nächsten Onlinekontakt zur Anmeldung geleitet
 *   und nie den Sperrbildschirm sehen. Die Änderung läuft daher über die
 *   eigene Sitzung per API (der lokale Arbeitsbereich erfährt davon nichts –
 *   genau die Situation „Passwort geändert, Wrap A veraltet“).
 * - Serveränderungen während der Offline-Arbeit laufen – wie in offline-flow E –
 *   über `page.request` (Node-seitig, von `setOffline` nicht betroffen).
 */
import {
  expect,
  test,
  type BrowserContext,
  type ConsoleMessage,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';
import { acceptedBooking as acceptedBookingViaUi } from '../helpers/booking.ts';
import { ADMIN_EMAIL, ADMIN_PASSWORD, resetE2eDatabase } from '../helpers/seed.ts';

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

const ADMIN_PASSWORD_NEU = 'e2e-admin-neues-passwort-2';
const PIA_EMAIL = 'pia.praxis@e2e.example';
const PIA_PASSWORD = 'e2e-pia-passwort-1';
/** Synthetische Telefonnummer der Rückgabeperson (nur operativ, nie in Logs). */
const RETURNER_PHONE = '0171 5550123';
const HOUR_MS = 3_600_000;
/** Operative Rolle OHNE `machine.override_block` (L4 Rechte-Entzug, L5 Override ohne Recht). */
const OPERATIVE_PERMISSIONS = [
  'process.view_all',
  'customer.view',
  'calendar.view',
  'handover.view',
  'handover.prepare',
  'handover.perform',
  'delivery_note.edit',
  'machine.view',
  'machine.assign',
  'return.view',
  'return.perform',
];
const LOCAL_STORES = [
  'bookings',
  'machines',
  'documents',
  'media',
  'mutations',
  'workspace',
  'packages',
];

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let staff: Page;
let customerPage: Page;
let contextP: BrowserContext | null = null;
let pia: Page | null = null;
let processB = '';
let numberB = '';
let bookingB = '';
let numberP = '';
let processK = '';
let bookingK = '';
let processS = '';
let processR = '';
let processO = '';
let bookingO = '';
let piaId = '';
let roleId = '';
let tokenMachine01 = '';
let tokenMachineP = '';

test.beforeAll(async ({ browser }) => {
  resetE2eDatabase();
  // Eigener Kontext für das „Gerät“ (Offline-Schaltung, Service Worker, IndexedDB);
  // die Kundenseite bleibt in einem separaten Kontext dauerhaft online.
  context = await browser.newContext();
  staff = await context.newPage();
  autoAcceptDialogs(staff);
  customerPage = await browser.newPage();
});
test.afterAll(async () => {
  await customerPage.close();
  if (contextP !== null) await contextP.close();
  await context.close();
});

/** Native Rückfragen (window.confirm, z. B. Zeit speichern, Konflikt verwerfen) bestätigen. */
function autoAcceptDialogs(page: Page) {
  page.on('dialog', (dialog) => {
    void dialog.accept().catch(() => undefined);
  });
}

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
/** Absoluter Zeitpunkt (ISO) einer Berliner Ortszeit – für Terminänderungen per API. */
function berlinInstant(dayIso: string, hour: number, minute = 0): string {
  const [y, m, d] = dayIso.split('-').map(Number);
  const wanted = `${dayIso} ${pad(hour)}:${pad(minute)}`;
  const format = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  for (const offsetHours of [2, 1, 0]) {
    const candidate = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1, hour - offsetHours, minute));
    if (format.format(candidate) === wanted) return candidate.toISOString();
  }
  throw new Error(`Berliner Ortszeit nicht bestimmbar: ${wanted}`);
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

/**
 * Nach dem Login: Service Worker aktiv, Paket geladen, Tab vom Worker gesteuert,
 * benötigte Seiten-Shells online besucht (= gecacht), Paket aktuell.
 */
async function bootstrapDevice(page: Page, paths: string[]) {
  await waitForOfflineReady(page);
  await page.reload();
  for (const path of paths) await page.goto(path);
  await refreshPackage(page);
}

async function goOffline(page: Page) {
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'offline',
  );
}

async function goOnline(page: Page) {
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'online',
    { timeout: 30_000 },
  );
}

/** Online schalten, synchronisieren und warten, bis nichts mehr aussteht (mit Diagnose). */
async function goOnlineAndSync(page: Page) {
  await goOnline(page);
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

/** Online schalten, synchronisieren und auf mindestens einen Konflikt warten. */
async function goOnlineAndSyncExpectConflicts(page: Page) {
  await goOnline(page);
  await page.goto('/sync');
  await page.getByTestId('sync-now').click();
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute('data-conflicts', /[1-9]/, {
    timeout: 60_000,
  });
  await expect(page.getByTestId('offline-indicator')).toContainText('PRÜFUNG ERFORDERLICH');
  await expect(page.getByTestId('sync-conflict').first()).toBeVisible();
}

/**
 * Alle Konflikte bewusst verwerfen (je mit Rückfrage) – auf /sync. Die erwartete
 * Anzahl kommt vom Live-Indikator (die Zeilen der Seite laden asynchron nach).
 */
async function discardAllConflicts(page: Page) {
  if (!/\/sync(\?|$)/.test(page.url())) await page.goto('/sync');
  const indicator = page.getByTestId('offline-indicator');
  const expected = Number(await indicator.getAttribute('data-conflicts'));
  await expect(page.getByTestId('sync-conflict')).toHaveCount(expected);
  for (let remaining = expected; remaining > 0; remaining -= 1) {
    await page.getByTestId('sync-conflict').first().getByTestId('conflict-discard').click();
    await expect(page.getByTestId('sync-conflict')).toHaveCount(remaining - 1);
  }
  await expect(indicator).toHaveAttribute('data-conflicts', '0');
}

/**
 * Konflikte verwerfen und erneut synchronisieren, bis weder Konflikte noch
 * ausstehende Änderungen übrig sind (Folgeänderungen einer verworfenen
 * Erfassung können im nächsten Lauf erneut zur Prüfung landen).
 */
async function settleConflicts(page: Page) {
  const indicator = page.getByTestId('offline-indicator');
  for (let round = 0; round < 6; round += 1) {
    await discardAllConflicts(page);
    await page.getByTestId('sync-now').click();
    await expect
      .poll(
        async () =>
          (await indicator.getAttribute('data-pending')) === '0' ||
          (await indicator.getAttribute('data-conflicts')) !== '0',
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe(true);
    if (
      (await indicator.getAttribute('data-pending')) === '0' &&
      (await indicator.getAttribute('data-conflicts')) === '0'
    )
      return;
  }
  throw new Error('Konflikte/ausstehende Änderungen ließen sich nicht bereinigen.');
}

/** Online schalten und den lokalen Stand vollständig bereinigen (Konflikte verwerfen). */
async function syncAndSettle(page: Page) {
  await goOnline(page);
  await page.goto('/sync');
  await settleConflicts(page);
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

/** Alle lokalen Stores leer, keine Identität (Logout/Wipe, Tests 41/42/113). */
async function expectWorkspaceWiped(page: Page) {
  for (const store of LOCAL_STORES) {
    expect(await storeCount(page, store), `Store ${store} leer`).toBe(0);
  }
  expect(await page.evaluate(() => localStorage.getItem('mr.staff.offlineIdentity'))).toBeNull();
}

/** Offline-Navigation: harte Navigation, der Service Worker liefert die gecachte Seite. */
async function gotoOffline(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'commit' });
}

async function setTime(
  page: Page,
  processId: string,
  row: 'Abholung / Ausgabe' | 'Rückgabe',
  start: string,
) {
  await page.goto(`/vorgaenge/${processId}/termine`);
  await page.locator('.entry-row', { hasText: row }).click();
  const card = page.getByTestId('appointment-preview');
  await card.getByLabel('Beginn').fill(start);
  await card.getByLabel('Ende (optional, Zeitfenster)').fill('');
  await card.getByRole('button', { name: 'Zeit speichern' }).click();
  await expect(
    page.locator('.entry-row', { hasText: row }).getByText(`${start.slice(11)} Uhr`),
  ).toBeVisible();
  await card.getByLabel('Vorschau schließen').click();
}

/** Terminzeit serverseitig verschieben (API) – während das Gerät offline arbeitet. */
async function setTimeApi(
  page: Page,
  processId: string,
  kind: 'pickup' | 'return',
  startAt: string,
) {
  const list = (await (
    await page.request.get(`/api/staff/processes/${processId}/appointments`)
  ).json()) as { entries: { id: string; kind: string; version: number }[] };
  const entry = list.entries.find((e) => e.kind === kind);
  expect(entry).toBeDefined();
  const response = await page.request.patch(`/api/staff/appointments/${entry!.id}/schedule`, {
    data: { startAt, endAt: null, expectedVersion: entry!.version },
  });
  expect(response.ok()).toBe(true);
}

async function ensureInitialStock(page: Page, slug: string, productName: string, amount: number) {
  await page.goto('/lager');
  const row = page.getByTestId(`inventory-${slug}`);
  await expect(row).toBeVisible();
  if ((await row.getByText(/Noch nicht initial erfasst/).count()) === 0) return;
  await row.getByLabel(`Anfangsbestand ${productName}`).fill(String(amount));
  await row.getByRole('button', { name: 'Anfangsbestand erfassen' }).click();
  await expect(page.getByRole('heading', { name: 'Inventur' })).toBeVisible();
  await page.getByRole('button', { name: 'Bestandskorrektur freigeben' }).click();
  await expect(page.getByText('Inventur freigegeben – Bestand wurde angepasst.')).toBeVisible();
}

async function acceptedBooking(
  firstName: string,
  lastName: string,
  email: string,
  machineLabel: '1×10 L' | '2×10 L' = '1×10 L',
) {
  return acceptedBookingViaUi(staff, customerPage, {
    firstName,
    lastName,
    email,
    machineLabel,
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

async function assignAndPrepareOnline(page: Page, processId: string, machineCode: string) {
  await page.goto(`/vorgaenge/${processId}/ausgabe`);
  const slot = page.getByTestId('slot-1');
  await slot.getByRole('button', { name: 'Maschine wählen' }).click();
  await page
    .getByTestId(`suggest-${machineCode}`)
    .getByRole('button', { name: 'Wählen', exact: true })
    .click();
  await expect(page.getByText(`Maschine ${machineCode} zugewiesen.`)).toBeVisible();
  await slot.getByRole('button', { name: 'Als vorbereitet markieren' }).click();
  await expect(slot).toContainText('Vorbereitet');
}

/** Bereits zugewiesenen Slot 1 online als vorbereitet markieren. */
async function prepareSlotOnline(page: Page, processId: string) {
  await page.goto(`/vorgaenge/${processId}/ausgabe`);
  const slot = page.getByTestId('slot-1');
  await slot.getByRole('button', { name: 'Als vorbereitet markieren' }).click();
  await expect(slot).toContainText('Vorbereitet');
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

/** Nur Prüfung + Gesamtfoto offline erfassen (zwei pending Mutationen, wie offline-flow E). */
async function checkAndPhotoOffline(page: Page, processId: string) {
  await gotoOffline(page, `/vorgaenge/${processId}/uebergabe`);
  await expect(page.getByTestId('wizard-offline-banner')).toBeVisible();
  await next(page);
  await next(page);
  await next(page);
  await page.getByRole('button', { name: 'Maschine gemeinsam geprüft' }).click();
  await expect(page.getByTestId('check-1')).toContainText('Maschine gemeinsam geprüft');
  await page
    .getByTestId('photo-input-1')
    .setInputFiles({ name: 'gesamtfoto.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(
    page.getByTestId('check-1').locator('img.photo-thumb[data-local="true"]'),
  ).toHaveCount(1);
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute('data-pending', /[1-9]/);
}

/** Maschinenstatus über das Maschinendetail setzen (Fachweg wie offline-flow J). */
async function setMachineStatus(page: Page, machineCode: string, optionLabel: string) {
  await page.goto('/maschinen');
  await page.getByRole('link', { name: machineCode }).click();
  await page.getByLabel('Neuer Status').selectOption({ label: optionLabel });
  await page.getByRole('button', { name: 'Status speichern' }).click();
  await expect(
    page.locator('.badge', { hasText: optionLabel.replace(/^\S+\s/, '') }).first(),
  ).toBeVisible();
}

/** QR-Identifier einer Maschine (nur online, Maschinendetail). */
async function qrTokenOf(page: Page, machineCode: string): Promise<string> {
  await page.goto('/maschinen');
  await page.getByRole('link', { name: machineCode }).click();
  const token = (await page.getByTestId('qr-token').innerText()).trim();
  expect(token.length).toBeGreaterThanOrEqual(32);
  return token;
}

/** Reinigung offline abschließen (eine pending Mutation, wie offline-flow G/J). */
async function cleanCompleteOffline(page: Page, machineCode: string) {
  await gotoOffline(page, '/reinigung');
  await expect(page.getByTestId(`cleaning-${machineCode}`)).toBeVisible();
  await page.getByTestId(`clean-complete-${machineCode}`).click();
  await expect(page.getByTestId('cleaning-pending')).toContainText(
    `Reinigung ${machineCode} offline erfasst – Synchronisierung ausstehend.`,
  );
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute('data-pending', /[1-9]/);
}

/** App-Sperre auslösen (wie offline-flow A) und Sperrbildschirm erwarten. */
async function lockApp(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('mr-app-locked')));
  await expect(page.getByRole('dialog', { name: 'App gesperrt' })).toBeVisible({
    timeout: 30_000,
  });
}

async function unlockOffline(page: Page, password: string) {
  await expect(page.getByTestId('offline-unlock-hint')).toBeVisible({ timeout: 30_000 });
  await page.locator('#unlock-password').fill(password);
  await page.getByRole('button', { name: 'Entsperren' }).click();
  await expect(page.getByRole('dialog', { name: 'App gesperrt' })).toHaveCount(0);
}

/** Kein Kundenname / keine E-Mail in Konfliktzeilen (Test 30). */
async function expectNoCustomerData(page: Page, fragments: string[]) {
  const texts = await page.getByTestId('sync-conflict').allTextContents();
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) {
    for (const fragment of fragments) expect(text).not.toContain(fragment);
    // Keine internen Rechte-Keys in der Erklärung.
    expect(text).not.toMatch(/\b(handover|return|machine)\.[a-z_]+/);
  }
}

// ── L1: Abmelden mit ausstehenden Daten ─────────────────────────────────

test('L1: Abmelden mit Pending → Dialog, Abbrechen, zuerst synchronisieren, bewusst verwerfen (41–45)', async () => {
  test.setTimeout(480_000);
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  // Bestände ehrlich erfassen (kein erfundener Bestand): die Offline-Ausgabe blockiert sonst.
  await ensureInitialStock(staff, 'sirup-kirsche', 'Sirup Kirsche', 20);
  await ensureInitialStock(staff, 'sirup-waldmeister', 'Sirup Waldmeister', 10);
  await ensureInitialStock(staff, 'strohhalme-25', 'Strohhalme (25 Stück)', 20);
  await ensureInitialStock(staff, 'becher-25', 'Becher (25 Stück)', 40);
  ({ processId: processB, processNumber: numberB } = await acceptedBooking(
    'Olga',
    'Hardening',
    'olga.hardening@e2e.example',
  ));
  await setTime(staff, processB, 'Abholung / Ausgabe', fillAt(berlinDayPlus(1), 9));
  await setTime(staff, processB, 'Rückgabe', fillAt(berlinDayPlus(2), 11));
  await assignAndPrepareOnline(staff, processB, 'MR-10-01-01');
  bookingB = await bookingIdOf(staff, processB);
  await bootstrapDevice(staff, [
    `/vorgaenge/${processB}/uebergabe`,
    `/vorgaenge/${processB}/rueckgabe`,
    '/ausgabe',
    '/reinigung',
    '/tablet',
    '/suche',
  ]);

  // Offline-Übergabe erfassen (wie offline-flow B bis „offline erfasst“).
  await goOffline(staff);
  await handoverWizardOffline(staff, processB);
  const indicator = staff.getByTestId('offline-indicator');
  const pendingBefore = (await indicator.getAttribute('data-pending'))!;
  expect(Number(pendingBefore)).toBeGreaterThanOrEqual(5);
  const mutationsBefore = await storeCount(staff, 'mutations');
  const mediaBefore = await storeCount(staff, 'media');
  const bookingsBefore = await storeCount(staff, 'bookings');
  expect(mutationsBefore).toBeGreaterThan(0);
  expect(mediaBefore).toBeGreaterThanOrEqual(3); // Foto + 2 Unterschriften

  // Test 45: „Abmelden“ mit Pending → Dialog statt window.confirm; Abbrechen ändert nichts.
  await staff.getByRole('button', { name: 'Abmelden' }).click();
  const dialog = staff.getByTestId('logout-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog).toContainText('noch nicht synchronisierte Erfassungen');
  await expect(dialog).toContainText('unwiderruflich');
  await expect(dialog.getByTestId('logout-sync-first')).toBeVisible();
  await expect(dialog.getByTestId('logout-discard')).toBeVisible();
  await dialog.getByTestId('logout-cancel').click();
  await expect(staff.getByTestId('logout-dialog')).toHaveCount(0);
  expect(staff.url()).not.toMatch(/\/login/);
  await expect(indicator).toHaveAttribute('data-pending', pendingBefore);
  expect(await storeCount(staff, 'mutations')).toBe(mutationsBefore);
  expect(await storeCount(staff, 'media')).toBe(mediaBefore);
  expect(await storeCount(staff, 'bookings')).toBe(bookingsBefore);
  expect(await storeCount(staff, 'workspace')).toBeGreaterThan(0);

  // Test 43: „zuerst synchronisieren“ führt nach /sync, nichts wird gelöscht.
  await staff.getByRole('button', { name: 'Abmelden' }).click();
  await expect(staff.getByTestId('logout-dialog')).toBeVisible();
  await staff.getByTestId('logout-dialog').getByTestId('logout-sync-first').click();
  await staff.waitForURL(/\/sync(\?|$)/);
  await expect(staff.getByTestId('logout-dialog')).toHaveCount(0);
  await expect(indicator).toHaveAttribute('data-pending', pendingBefore);
  expect(await storeCount(staff, 'mutations')).toBe(mutationsBefore);
  // Serverseitig ist NICHTS final, solange nicht synchronisiert wurde.
  const serverBefore = (await (
    await staff.request.get(`/api/staff/handover/${bookingB}`)
  ).json()) as { detail: { handover: { status: string } }; documents: unknown[] };
  expect(serverBefore.detail.handover.status).not.toBe('finalized');
  expect(serverBefore.documents).toHaveLength(0);

  // Netz zurück → Synchronisierung → Server final (Lieferschein + Protokoll).
  await goOnlineAndSync(staff);
  await expect(indicator).toHaveAttribute('data-conflicts', '0');
  const serverAfter = (await (
    await staff.request.get(`/api/staff/handover/${bookingB}`)
  ).json()) as { detail: { handover: { status: string } }; documents: { type: string }[] };
  expect(serverAfter.detail.handover.status).toBe('finalized');
  expect(serverAfter.documents.map((d) => d.type).sort()).toEqual([
    'delivery_note',
    'handover_protocol',
  ]);
  expect((await machineByCode(staff, 'MR-10-01-01')).status).toBe('rented');

  // Tests 41/43: ohne Pending direkter Logout – kein Dialog, Stores vollständig leer.
  await staff.goto('/sync');
  await expect(indicator).toHaveAttribute('data-pending', '0');
  await staff.getByRole('button', { name: 'Abmelden' }).click();
  await staff.waitForURL(/\/login/);
  await expect(staff.getByTestId('logout-dialog')).toHaveCount(0);
  await expectWorkspaceWiped(staff);

  // Neues Pending: Reinigung offline abschließen; serverseitig wurde die Reinigung
  // zwischenzeitlich beendet (anderes Gerät) → beim Sync ein Konflikt, der auch
  // online „ausstehend“ bleibt (Pending inkl. Prüfung erforderlich).
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await bootstrapDevice(staff, ['/reinigung']);
  await setMachineStatus(staff, 'MR-10-01-02', '🟡 Reinigung');
  await refreshPackage(staff);
  await staff.goto('/reinigung');
  await expect(staff.getByTestId('cleaning-MR-10-01-02')).toBeVisible();
  await goOffline(staff);
  await cleanCompleteOffline(staff, 'MR-10-01-02');
  const machine02 = await machineByCode(staff, 'MR-10-01-02');
  const serverClean = await staff.request.post(
    `/api/staff/machines/${machine02.id}/clean-complete`,
  );
  expect(serverClean.ok()).toBe(true);
  await goOnlineAndSyncExpectConflicts(staff);
  const conflictMutations = await storeCount(staff, 'mutations');
  expect(conflictMutations).toBeGreaterThan(0);

  // Test 44: „Verwerfen“ ist zweistufig; Abbrechen in Stufe 2 lässt die Daten unberührt.
  await staff.getByRole('button', { name: 'Abmelden' }).click();
  await expect(staff.getByTestId('logout-dialog')).toBeVisible();
  await staff.getByTestId('logout-dialog').getByTestId('logout-discard').click();
  const confirm = staff.getByTestId('logout-dialog-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('unwiderruflich');
  await expect(confirm.getByTestId('logout-discard-confirm')).toContainText(
    'Ja, unwiderruflich verwerfen und abmelden',
  );
  await confirm.getByTestId('logout-cancel').click();
  await expect(staff.getByTestId('logout-dialog-confirm')).toHaveCount(0);
  if ((await staff.getByTestId('logout-dialog').count()) > 0) {
    await staff.getByTestId('logout-dialog').getByTestId('logout-cancel').click();
  }
  await expect(staff.getByTestId('logout-dialog')).toHaveCount(0);
  expect(staff.url()).not.toMatch(/\/login/);
  expect(await storeCount(staff, 'mutations')).toBe(conflictMutations);
  await expect(indicator).toHaveAttribute('data-conflicts', /[1-9]/);

  // Tests 42/44: bewusst verwerfen und abmelden → /login, alle Stores leer.
  await staff.getByRole('button', { name: 'Abmelden' }).click();
  await staff.getByTestId('logout-dialog').getByTestId('logout-discard').click();
  await staff.getByTestId('logout-dialog-confirm').getByTestId('logout-discard-confirm').click();
  await staff.waitForURL(/\/login/);
  await expectWorkspaceWiped(staff);
});

// ── L2: Geschützter PDF-Viewer ──────────────────────────────────────────

test('L2: Geschützter PDF-Viewer offline → Blob-URL, Sperre revoziert, Store ohne Klartext (31–35)', async () => {
  test.setTimeout(300_000);
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await bootstrapDevice(staff, [`/vorgaenge/${processB}/uebergabe`]);
  const handover = (await (await staff.request.get(`/api/staff/handover/${bookingB}`)).json()) as {
    documents: { id: string; type: string }[];
  };
  expect(handover.documents).toHaveLength(2);
  const documentId = handover.documents.find((d) => d.type === 'delivery_note')!.id;
  // Viewer-Shell einmal online besuchen (Service Worker cacht die Seite), Paket mit Dokumenten laden.
  await staff.goto(`/dokumente/${documentId}?booking=${bookingB}`);
  await refreshPackage(staff);
  expect(await storeCount(staff, 'documents')).toBeGreaterThanOrEqual(1);

  // Test 31: offline aus dem Wizard heraus öffnen → Blob-URL mit echten PDF-Bytes.
  await goOffline(staff);
  await gotoOffline(staff, `/vorgaenge/${processB}/uebergabe`);
  await expect(staff.getByText(/✓ Übergabe abgeschlossen am/)).toBeVisible();
  await staff.getByTestId(`document-offline-${documentId}`).click();
  await staff.waitForURL(new RegExp(`/dokumente/${documentId}`));
  expect(new URL(staff.url()).searchParams.get('booking')).toBe(bookingB);
  await expect(staff.getByTestId('document-viewer')).toBeVisible();
  const frame = staff.getByTestId('document-frame');
  await expect(frame).toBeVisible();
  const blobUrl = (await frame.getAttribute('src'))!;
  expect(blobUrl).toMatch(/^blob:/);
  const head = await staff.evaluate(async (url) => {
    const response = await fetch(url);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { length: bytes.length, head: String.fromCharCode(...bytes.subarray(0, 4)) };
  }, blobUrl);
  expect(head.head).toBe('%PDF');
  expect(head.length).toBeGreaterThan(100);

  // Tests 32/34: Sperre → Viewer weg, Blob-URL revoziert.
  await lockApp(staff);
  await expect(staff.getByTestId('document-frame')).toHaveCount(0);
  await expect(staff.getByTestId('document-viewer')).toHaveCount(0);
  const revoked = await staff.evaluate(async (url) => {
    try {
      await fetch(url);
      return false;
    } catch {
      return true;
    }
  }, blobUrl);
  expect(revoked).toBe(true);

  // Test 33: nach Offline-Entsperrung erneut über den Link öffnen.
  await unlockOffline(staff, ADMIN_PASSWORD);
  await gotoOffline(staff, `/vorgaenge/${processB}/uebergabe`);
  await expect(staff.getByText(/✓ Übergabe abgeschlossen am/)).toBeVisible();
  await staff.getByTestId(`document-offline-${documentId}`).click();
  await staff.waitForURL(new RegExp(`/dokumente/${documentId}`));
  await expect(staff.getByTestId('document-viewer')).toBeVisible();
  await expect(staff.getByTestId('document-frame')).toHaveAttribute('src', /^blob:/);

  // Test 35: Dokumente liegen verschlüsselt (kein „%PDF“, kein Base64-Präfix „JVBERi0“).
  const documentsText = await storeText(staff, 'documents');
  expect(documentsText.length).toBeGreaterThan(0);
  expect(documentsText).toContain(documentId);
  expect(documentsText).not.toContain('%PDF');
  expect(documentsText).not.toContain('JVBERi0');
  await goOnline(staff);
});

// ── L3: Offline-Suche ───────────────────────────────────────────────────

test('L3: Offline-Suche → Vorgang, Kunde, Maschine, Paketgrenze, kein Klartext (36–40)', async () => {
  test.setTimeout(300_000);
  // Vorgang AUSSERHALB des Pakets (Ausgabe in +10 Tagen), online angelegt und vorbereitet.
  const outside = await acceptedBooking(
    'Paul',
    'Pakettfern',
    'paul.pakettfern@e2e.example',
    '2×10 L',
  );
  numberP = outside.processNumber;
  await setTime(staff, outside.processId, 'Abholung / Ausgabe', fillAt(berlinDayPlus(10), 9));
  await setTime(staff, outside.processId, 'Rückgabe', fillAt(berlinDayPlus(11), 11));
  await assignAndPrepareOnline(staff, outside.processId, 'MR-10-02-01');
  await staff.goto('/suche');
  await refreshPackage(staff);
  expect(await storeCount(staff, 'bookings')).toBeGreaterThanOrEqual(1);

  await goOffline(staff);
  await gotoOffline(staff, '/suche');
  const box = staff.getByRole('searchbox');
  await expect(box).toBeVisible();
  await expect(staff.getByTestId('search-offline-hint')).toBeVisible();
  // Test 36: Vorgangsnummer.
  await box.fill(numberB);
  await expect(staff.getByTestId(`search-process-${numberB}`)).toBeVisible();
  // Test 37: Kundenname (Nachname) → Treffer zeigt den Kundennamen.
  await box.fill('Hardening');
  const customerHit = staff.getByTestId(`search-process-${numberB}`);
  await expect(customerHit).toBeVisible();
  await expect(customerHit).toContainText('Hardening');
  await expect(customerHit).toContainText(numberB);
  // Test 38: Maschinencode.
  await box.fill('MR-10-01-01');
  await expect(staff.getByTestId('search-machine-MR-10-01-01')).toBeVisible();
  await expect(staff.getByTestId('search-machine-MR-10-01-01')).toContainText('MR-10-01-01');
  // Test 39: Vorgang außerhalb des Pakets → kein Treffer.
  await box.fill(numberP);
  await expect(staff.getByTestId('search-machine-MR-10-01-01')).toHaveCount(0);
  await expect(staff.getByTestId(`search-process-${numberP}`)).toHaveCount(0);
  await expect(staff.locator('main')).not.toContainText('Pakettfern');
  await box.fill('Pakettfern');
  await expect(staff.getByTestId(`search-process-${numberP}`)).toHaveCount(0);
  await expect(staff.locator('main')).not.toContainText(numberP);
  // Test 40: kein Kundenname im Klartext der lokalen Stores.
  for (const store of ['bookings', 'machines']) {
    const text = await storeText(staff, store);
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain('Hardening');
    expect(text).not.toContain('Olga');
    expect(text).not.toContain('olga.hardening');
    expect(text).not.toContain('Pakettfern');
  }
  await goOnline(staff);
});

// ── L4: Konfliktdetails ─────────────────────────────────────────────────

test('L4a: Konfliktdetails → Maschinenwechsel, Terminänderung, Storno (26–28, 30)', async () => {
  test.setTimeout(540_000);
  const customerK = ['Quirlfeld', 'Konrad', 'konrad.quirlfeld@e2e.example'];
  ({ processId: processK } = await acceptedBooking('Konrad', 'Quirlfeld', customerK[2]!));
  await setTime(staff, processK, 'Abholung / Ausgabe', fillAt(berlinDayPlus(1), 13));
  await setTime(staff, processK, 'Rückgabe', fillAt(berlinDayPlus(2), 15));
  await assignAndPrepareOnline(staff, processK, 'MR-10-01-03');
  bookingK = await bookingIdOf(staff, processK);
  await staff.goto(`/vorgaenge/${processK}/uebergabe`);
  await refreshPackage(staff);

  // Test 26: Maschine offline geprüft/fotografiert, Server weist um → beide Codes sichtbar.
  await goOffline(staff);
  await checkAndPhotoOffline(staff, processK);
  const slots = (await (await staff.request.get(`/api/staff/handover/${bookingK}`)).json()) as {
    detail: { slots: { id: string }[] };
  };
  const other = await machineByCode(staff, 'MR-10-01-04');
  const reassign = await staff.request.post(
    `/api/staff/handover/${bookingK}/slots/${slots.detail.slots[0]!.id}/assign`,
    { data: { machineId: other.id } },
  );
  expect(reassign.ok()).toBe(true);
  await goOnlineAndSyncExpectConflicts(staff);
  const machineConflict = staff.getByTestId('sync-conflict').first();
  await expect(machineConflict.getByTestId('conflict-offline')).toContainText('MR-10-01-03');
  await expect(machineConflict.getByTestId('conflict-server')).toContainText('MR-10-01-04');
  await expect(machineConflict.getByTestId('conflict-offline')).not.toContainText('MR-10-01-04');
  await expect(machineConflict.getByTestId('conflict-action')).not.toBeEmpty();
  await expectNoCustomerData(staff, customerK);
  // Serverstand wurde NICHT überschrieben.
  const afterReassign = (await (
    await staff.request.get(`/api/staff/handover/${bookingK}`)
  ).json()) as { detail: { slots: { machine: { machineCode: string } }[] } };
  expect(afterReassign.detail.slots[0]!.machine.machineCode).toBe('MR-10-01-04');
  await settleConflicts(staff);

  // Test 27: Übergabe offline abgeschlossen, Server verschiebt die Ausgabezeit 13:00 → 14:30.
  await prepareSlotOnline(staff, processK);
  await staff.goto(`/vorgaenge/${processK}/uebergabe`);
  await refreshPackage(staff);
  await goOffline(staff);
  await handoverWizardOffline(staff, processK);
  await setTimeApi(staff, processK, 'pickup', berlinInstant(berlinDayPlus(1), 14, 30));
  await goOnlineAndSyncExpectConflicts(staff);
  const appointmentConflict = staff
    .locator('[data-testid="sync-conflict"]', { hasText: '14:30' })
    .first();
  await expect(appointmentConflict).toBeVisible();
  await expect(appointmentConflict.getByTestId('conflict-offline')).toContainText('13:00');
  await expect(appointmentConflict.getByTestId('conflict-server')).toContainText('14:30');
  await expect(appointmentConflict.getByTestId('conflict-action')).not.toBeEmpty();
  await expectNoCustomerData(staff, customerK);
  // Nichts wurde still final: Übergabe serverseitig nicht abgeschlossen.
  const afterAppointment = (await (
    await staff.request.get(`/api/staff/handover/${bookingK}`)
  ).json()) as { detail: { handover: { status: string } } };
  expect(afterAppointment.detail.handover.status).not.toBe('finalized');
  await settleConflicts(staff);

  // Test 28: Übergabe offline abgeschlossen, Vorgang zwischenzeitlich storniert.
  const customerS = ['Sturmvogel', 'Sven', 'sven.sturmvogel@e2e.example'];
  ({ processId: processS } = await acceptedBooking('Sven', 'Sturmvogel', customerS[2]!));
  await setTime(staff, processS, 'Abholung / Ausgabe', fillAt(berlinDayPlus(3), 9));
  await setTime(staff, processS, 'Rückgabe', fillAt(berlinDayPlus(4), 11));
  await assignAndPrepareOnline(staff, processS, 'MR-10-01-03');
  const bookingS = await bookingIdOf(staff, processS);
  await staff.goto(`/vorgaenge/${processS}/uebergabe`);
  await refreshPackage(staff);
  await goOffline(staff);
  await handoverWizardOffline(staff, processS);
  const cancelled = await staff.request.post(`/api/staff/processes/${processS}/cancel`, {
    data: {},
  });
  expect(cancelled.ok()).toBe(true);
  await goOnlineAndSyncExpectConflicts(staff);
  const cancelConflict = staff.getByTestId('sync-conflict').first();
  await expect(cancelConflict.getByTestId('conflict-server')).toContainText('storniert');
  await expect(cancelConflict.getByTestId('conflict-action')).not.toBeEmpty();
  await expectNoCustomerData(staff, customerS);
  const afterCancel = (await (
    await staff.request.get(`/api/staff/handover/${bookingS}`)
  ).json()) as { detail: { handover: { status: string } } };
  expect(afterCancel.detail.handover.status).not.toBe('finalized');
  expect((await machineByCode(staff, 'MR-10-01-03')).status).not.toBe('rented');
  await settleConflicts(staff);
});

test('L4b: Konfliktdetails → Rechte-Entzug ohne Rechte-Key, keine Kundendaten (29–30)', async () => {
  test.setTimeout(420_000);
  // Mitarbeiterin mit operativen Rechten (über die Admin-Sitzung, echte Admin-API).
  const created = await staff.request.post('/api/staff/users', {
    data: { firstName: 'Pia', lastName: 'Praxis', email: PIA_EMAIL },
  });
  expect(created.ok()).toBe(true);
  const createdBody = (await created.json()) as { user: { id: string }; setupToken: string };
  piaId = createdBody.user.id;
  const reset = await staff.request.post('/api/auth/password/reset', {
    data: { token: createdBody.setupToken, newPassword: PIA_PASSWORD },
  });
  expect(reset.ok()).toBe(true);
  const role = await staff.request.post('/api/staff/roles', {
    data: { name: 'E2E-Operativ ohne Override', permissionKeys: OPERATIVE_PERMISSIONS },
  });
  expect(role.ok()).toBe(true);
  roleId = ((await role.json()) as { roleId: string }).roleId;
  const granted = await staff.request.post(`/api/staff/users/${piaId}/roles`, {
    data: { roleIds: [roleId] },
  });
  expect(granted.ok()).toBe(true);

  const customerR = ['Nebelkamm', 'Rita', 'rita.nebelkamm@e2e.example'];
  ({ processId: processR } = await acceptedBooking('Rita', 'Nebelkamm', customerR[2]!));
  await setTime(staff, processR, 'Abholung / Ausgabe', fillAt(berlinDayPlus(1), 15));
  await setTime(staff, processR, 'Rückgabe', fillAt(berlinDayPlus(2), 17));
  await assignAndPrepareOnline(staff, processR, 'MR-10-01-05');

  // Zweites Gerät: Pia erfasst offline Prüfung + Foto.
  contextP = await staff.context().browser()!.newContext();
  pia = await contextP.newPage();
  autoAcceptDialogs(pia);
  await login(pia, PIA_EMAIL, PIA_PASSWORD, 'Pia');
  await bootstrapDevice(pia, [`/vorgaenge/${processR}/uebergabe`]);
  await goOffline(pia);
  await checkAndPhotoOffline(pia, processR);

  // Admin entzieht die Rolle, bevor Pia synchronisiert (Test 29).
  const revoked = await staff.request.post(`/api/staff/users/${piaId}/roles`, {
    data: { roleIds: [] },
  });
  expect(revoked.ok()).toBe(true);
  await goOnlineAndSyncExpectConflicts(pia);
  const rightsConflict = pia.getByTestId('sync-conflict').first();
  await expect(rightsConflict.getByTestId('conflict-server')).toContainText('Berechtigung');
  await expect(rightsConflict.getByTestId('conflict-server')).not.toContainText('handover.');
  await expect(rightsConflict.getByTestId('conflict-server')).not.toContainText('return.');
  await expect(rightsConflict.getByTestId('conflict-server')).not.toContainText('machine.');
  await expect(rightsConflict.getByTestId('conflict-action')).not.toBeEmpty();
  // Test 30: keine Kundendaten in den Konfliktzeilen.
  await expectNoCustomerData(pia, customerR);
  // Serverseitig nichts übernommen; lokale Beweise bleiben bis zur bewussten Entscheidung.
  const bookingR = await bookingIdOf(staff, processR);
  const serverR = (await (await staff.request.get(`/api/staff/handover/${bookingR}`)).json()) as {
    detail: { machines: { photos?: unknown[] }[] };
  };
  expect(serverR.detail.machines[0]?.photos?.length ?? 0).toBe(0);
  expect(await storeCount(pia, 'media')).toBeGreaterThanOrEqual(1);
  await settleConflicts(pia);

  // Rolle zurück (für L5: Mitarbeiterin OHNE machine.override_block).
  const regranted = await staff.request.post(`/api/staff/users/${piaId}/roles`, {
    data: { roleIds: [roleId] },
  });
  expect(regranted.ok()).toBe(true);
});

// ── L5: Override offline ────────────────────────────────────────────────

test('L5: Override offline → Grund Pflicht, Zuweisung pending, ohne Recht kein Grundfeld (46–48)', async () => {
  test.setTimeout(420_000);
  ({ processId: processO } = await acceptedBooking(
    'Otto',
    'Overbeck',
    'otto.overbeck@e2e.example',
  ));
  await setTime(staff, processO, 'Abholung / Ausgabe', fillAt(berlinDayPlus(2), 10));
  await setTime(staff, processO, 'Rückgabe', fillAt(berlinDayPlus(3), 12));
  bookingO = await bookingIdOf(staff, processO);
  // Problemlage lokal bekannt: Maschine in Reparatur (Statuswechsel über das Maschinendetail).
  await setMachineStatus(staff, 'MR-10-01-06', '🔴 Reparatur');
  await staff.goto(`/vorgaenge/${processO}/ausgabe`);
  await refreshPackage(staff);

  await goOffline(staff);
  await gotoOffline(staff, `/vorgaenge/${processO}/ausgabe`);
  const slot = staff.getByTestId('slot-1');
  await slot.getByRole('button', { name: 'Maschine wählen' }).click();
  const entry = staff.getByTestId('suggest-MR-10-01-06');
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('Reparatur');
  await entry.getByRole('button', { name: /Trotzdem wählen/ }).click();
  const dialog = staff.getByTestId('override-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('MR-10-01-06');
  const reason = dialog.locator('#override-reason');
  await expect(reason).toBeVisible();
  const confirm = dialog.getByRole('button', { name: /Trotzdem zuordnen/ });
  // Test 48: ohne Grund keine Bestätigung möglich.
  await expect(reason).toHaveValue('');
  await expect(confirm).toBeDisabled();
  await reason.fill('   ');
  await expect(confirm).toBeDisabled();
  await expect(staff.getByTestId('offline-chosen-1')).toHaveCount(0);
  // Test 46: mit Grund → lokal zugewiesen, pending – serverseitig nichts.
  await reason.fill('Reparatur abgeschlossen, Freigabe mündlich (E2E)');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(staff.getByText('Maschine MR-10-01-06 mit Override zugewiesen.')).toBeVisible();
  await expect(staff.getByTestId('offline-chosen-1')).toBeVisible();
  await expect(slot).toContainText('MR-10-01-06');
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute('data-pending', /[1-9]/);
  const serverSlot = (await (
    await staff.request.get(`/api/staff/handover/${bookingO}`)
  ).json()) as {
    detail: { slots: { machine: { machineCode: string } | null }[] };
  };
  expect(serverSlot.detail.slots[0]!.machine).toBeNull();

  // Test 47: Mitarbeiterin ohne `machine.override_block` – eigenes Gerät, offline: kein Grundfeld.
  expect(pia).not.toBeNull();
  await pia!.goto(`/vorgaenge/${processO}/ausgabe`);
  await refreshPackage(pia!);
  await goOffline(pia!);
  await gotoOffline(pia!, `/vorgaenge/${processO}/ausgabe`);
  await pia!.getByTestId('slot-1').getByRole('button', { name: 'Maschine wählen' }).click();
  await pia!
    .getByTestId('suggest-MR-10-01-06')
    .getByRole('button', { name: /Trotzdem wählen/ })
    .click();
  const piaDialog = pia!.getByTestId('override-dialog');
  await expect(piaDialog).toBeVisible();
  await expect(piaDialog.locator('#override-reason')).toHaveCount(0);
  await expect(piaDialog.getByRole('button', { name: /Trotzdem zuordnen/ })).toHaveCount(0);
  await expect(piaDialog).toContainText(/Maschinensperre übersteuern/);
  await expect(pia!.getByTestId('offline-chosen-1')).toHaveCount(0);
  await goOnline(pia!);
  await contextP!.close();
  contextP = null;
  pia = null;

  // Pending Override synchronisieren; die serverseitige Re-Bewertung (49–51) prüft der
  // Integrationstest – hier nur: nichts bleibt ausstehend hängen.
  await syncAndSettle(staff);
});

// ── L6: Lease, Uhr, Fehlversuche, Neuaufbau, veraltetes Paket ──────────

test('L6a: Fünf Fehlversuche sperren die Offline-Entsperrung, Online-Entsperrung setzt zurück (60)', async () => {
  test.setTimeout(300_000);
  await staff.goto('/sync');
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute('data-pending', '0');
  await goOffline(staff);
  await gotoOffline(staff, '/');
  await expect(staff.getByRole('heading', { name: 'Heute' })).toBeVisible({ timeout: 30_000 });
  await lockApp(staff);
  await expect(staff.getByTestId('offline-unlock-hint')).toBeVisible();
  const unlockButton = staff.getByRole('button', { name: 'Entsperren' });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await staff.locator('#unlock-password').fill(`falsches-passwort-${attempt}`);
    await unlockButton.click();
    await expect(staff.getByText('Das Passwort ist falsch.')).toBeVisible();
    await expect(unlockButton).toBeEnabled();
  }
  // 6. Versuch – auch mit korrektem Passwort gesperrt.
  await staff.locator('#unlock-password').fill(ADMIN_PASSWORD);
  await unlockButton.click();
  await expect(
    staff.getByText(
      'Zu viele Fehlversuche – die Offline-Entsperrung ist auf diesem Gerät gesperrt. Bitte mit Verbindung anmelden.',
    ),
  ).toBeVisible();
  await expect(staff.getByRole('heading', { name: 'Heute' })).toHaveCount(0);
  // Online: Entsperrung gegen den Server → klappt und setzt den Zähler zurück.
  await context.setOffline(false);
  await staff.evaluate(() => window.dispatchEvent(new Event('online')));
  await staff.locator('#unlock-password').fill(ADMIN_PASSWORD);
  await unlockButton.click();
  await expect(staff.getByRole('heading', { name: 'Heute' })).toBeVisible({ timeout: 30_000 });
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'online',
    { timeout: 30_000 },
  );
  // Danach offline erneut entsperrbar (Zähler zurückgesetzt).
  await goOffline(staff);
  await lockApp(staff);
  await unlockOffline(staff, ADMIN_PASSWORD);
  await expect(staff.getByRole('heading', { name: 'Heute' })).toBeVisible();
  await goOnline(staff);
});

test('L6b: Lease > 72 h → gesperrt; zurückgestellte Uhr belebt die Lease nicht; online erneuert (61)', async () => {
  test.setTimeout(300_000);
  await goOffline(staff);
  await staff.clock.install();
  await staff.clock.setSystemTime(new Date(Date.now() + 73 * HOUR_MS));
  await gotoOffline(staff, '/');
  await expect(staff.getByTestId('offline-unlock-hint')).toBeVisible({ timeout: 30_000 });
  await staff.locator('#unlock-password').fill(ADMIN_PASSWORD);
  await staff.getByRole('button', { name: 'Entsperren' }).click();
  await expect(
    staff.getByText(/Offline-Berechtigung dieses Geräts ist abgelaufen \(max\. 72 Stunden\)/),
  ).toBeVisible();
  await expect(staff.getByRole('heading', { name: 'Heute' })).toHaveCount(0);

  // Uhr zurück auf die echte Zeit: die Lease wird NICHT wieder gültig.
  await staff.clock.setSystemTime(new Date());
  await gotoOffline(staff, '/');
  await expect(staff.getByTestId('offline-unlock-hint')).toBeVisible({ timeout: 30_000 });
  await staff.locator('#unlock-password').fill(ADMIN_PASSWORD);
  await staff.getByRole('button', { name: 'Entsperren' }).click();
  await expect(
    staff.getByText(/Offline-Berechtigung dieses Geräts ist abgelaufen \(max\. 72 Stunden\)/),
  ).toBeVisible();
  await expect(staff.getByRole('heading', { name: 'Heute' })).toHaveCount(0);

  // Online + Passwort: Re-Autorisierung über den Server, Lease erneuert.
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
  // Offline wieder nutzbar.
  await goOffline(staff);
  await gotoOffline(staff, '/');
  await expect(staff.getByRole('heading', { name: 'Heute' })).toBeVisible({ timeout: 30_000 });
  await expect(staff.getByTestId('offline-indicator')).toContainText('OFFLINE');
  await goOnline(staff);
});

test('L6c: Neuaufbau nach Passwortänderung mit Pending → zweistufig, Daten bis zur Bestätigung erhalten (59)', async () => {
  test.setTimeout(360_000);
  // Pending offline: Reinigung abschließen.
  await setMachineStatus(staff, 'MR-10-01-02', '🟡 Reinigung');
  await refreshPackage(staff);
  await staff.goto('/reinigung');
  await goOffline(staff);
  await cleanCompleteOffline(staff, 'MR-10-01-02');
  const mutationsBefore = await storeCount(staff, 'mutations');
  expect(mutationsBefore).toBeGreaterThan(0);

  // Lease abgelaufen (Gerätezeit +73 h) → gesperrt.
  await staff.clock.setSystemTime(new Date(Date.now() + 73 * HOUR_MS));
  await gotoOffline(staff, '/');
  await expect(staff.getByTestId('offline-unlock-hint')).toBeVisible({ timeout: 30_000 });

  // Passwort „anderswo“ geändert: API-Aufruf über die eigene Sitzung (der lokale
  // Arbeitsbereich erfährt davon nichts; andere Sitzungen würden widerrufen).
  const changed = await staff.request.post('/api/auth/password/change', {
    data: { currentPassword: ADMIN_PASSWORD, newPassword: ADMIN_PASSWORD_NEU },
  });
  expect(changed.ok()).toBe(true);

  // Uhr zurück, online: Server akzeptiert das neue Passwort, der lokale Arbeitsbereich nicht.
  await staff.clock.setSystemTime(new Date());
  await context.setOffline(false);
  await staff.locator('#unlock-password').fill(ADMIN_PASSWORD_NEU);
  await staff.getByRole('button', { name: 'Entsperren' }).click();
  const refused = staff.getByTestId('rekey-refused');
  await expect(refused).toBeVisible({ timeout: 30_000 });
  await expect(staff.getByRole('heading', { name: 'Heute' })).toHaveCount(0);
  expect(await storeCount(staff, 'mutations')).toBe(mutationsBefore);

  // Stufe 2 abbrechen → Daten bleiben.
  await refused.getByTestId('rekey-discard').click();
  const confirm = staff.getByTestId('rekey-dialog-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm.getByTestId('rekey-discard-confirm')).toBeVisible();
  await confirm.getByTestId('rekey-cancel').click();
  await expect(staff.getByTestId('rekey-dialog-confirm')).toHaveCount(0);
  await expect(staff.getByRole('heading', { name: 'Heute' })).toHaveCount(0);
  expect(await storeCount(staff, 'mutations')).toBe(mutationsBefore);
  expect(await storeCount(staff, 'workspace')).toBeGreaterThan(0);

  // Erneut: bewusst verwerfen → Arbeitsbereich neu, App nutzbar, Pending-Daten weg.
  if ((await staff.getByTestId('rekey-discard').count()) === 0) {
    await staff.locator('#unlock-password').fill(ADMIN_PASSWORD_NEU);
    await staff.getByRole('button', { name: 'Entsperren' }).click();
    await expect(staff.getByTestId('rekey-refused')).toBeVisible({ timeout: 30_000 });
  }
  await staff.getByTestId('rekey-discard').click();
  await staff.getByTestId('rekey-dialog-confirm').getByTestId('rekey-discard-confirm').click();
  await expect(staff.getByRole('heading', { name: 'Heute' })).toBeVisible({ timeout: 60_000 });
  await expect(staff.getByRole('dialog', { name: 'App gesperrt' })).toHaveCount(0);
  expect(await storeCount(staff, 'mutations')).toBe(0);
  expect(await storeCount(staff, 'media')).toBe(0);
  // Die lokale Reinigungserfassung ist verworfen – serverseitig weiterhin in Reinigung.
  expect((await machineByCode(staff, 'MR-10-01-02')).status).toBe('cleaning');

  // Passwort über „Mein Konto“ zurücksetzen (erneuert zugleich den lokalen Passwort-Wrap),
  // damit Folgeszenarien und -Specs mit dem Seed-Passwort arbeiten.
  await staff.goto('/konto');
  await staff.locator('#current-password').fill(ADMIN_PASSWORD_NEU);
  await staff.locator('#new-password').fill(ADMIN_PASSWORD);
  await staff.getByRole('button', { name: 'Passwort ändern' }).click();
  await expect(staff.getByText(/Passwort geändert\./)).toBeVisible();
  await refreshPackage(staff);
  await expect(staff.getByTestId('lease-info')).toBeVisible();
});

test('L6d: Veraltetes Paket → genau ein Paket lokal, Snapshots entsprechen dem letzten Paket (54)', async () => {
  test.setTimeout(300_000);
  await staff.goto('/sync');
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute('data-pending', '0');
  const deviceId = await staff.evaluate(() => localStorage.getItem('mr.staff.deviceId'));
  expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
  const packageSize = async () => {
    const response = await staff.request.post('/api/staff/offline/package', {
      data: { deviceId, environment: 'development', includeDocuments: false },
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { bookings: unknown[] }).bookings.length;
  };

  await refreshPackage(staff);
  // Zwischenzeitlich neue Buchung im Horizont.
  const added = await acceptedBooking('Zara', 'Zusatzfeld', 'zara.zusatzfeld@e2e.example');
  await setTime(staff, added.processId, 'Abholung / Ausgabe', fillAt(berlinDayPlus(1), 8));
  await setTime(staff, added.processId, 'Rückgabe', fillAt(berlinDayPlus(2), 10));
  const bookingZ = await bookingIdOf(staff, added.processId);
  await refreshPackage(staff);
  expect(await storeCount(staff, 'packages')).toBe(1);
  expect(await storeText(staff, 'bookings')).toContain(bookingZ);
  expect(await storeCount(staff, 'bookings')).toBe(await packageSize());

  // Termin aus dem Horizont (+10 Tage) → nach Aktualisierung lokal nicht mehr vorhanden.
  await setTime(staff, added.processId, 'Rückgabe', fillAt(berlinDayPlus(11), 10));
  await setTime(staff, added.processId, 'Abholung / Ausgabe', fillAt(berlinDayPlus(10), 8));
  await refreshPackage(staff);
  expect(await storeCount(staff, 'packages')).toBe(1);
  expect(await storeText(staff, 'bookings')).not.toContain(bookingZ);
  expect(await storeCount(staff, 'bookings')).toBe(await packageSize());
});

// ── L7: Client-Logs & QR ────────────────────────────────────────────────

test('L7: Client-Logs & QR → keine Telefonnummer/Rohtoken/Bildbytes in der Konsole, Token nie in URLs (12, 53, 55–58)', async () => {
  test.setTimeout(480_000);
  tokenMachine01 = await qrTokenOf(staff, 'MR-10-01-01');
  tokenMachineP = await qrTokenOf(staff, 'MR-10-02-01');
  await staff.goto(`/vorgaenge/${processB}/rueckgabe`);
  await staff.goto('/tablet');
  await refreshPackage(staff);
  const consoleLines: string[] = [];
  const onConsole = (message: ConsoleMessage) => consoleLines.push(message.text());
  staff.on('console', onConsole);

  // Komplette Offline-Rückgabe: sonstige Rückgabeperson mit Telefon, QR-Bestätigung,
  // Schaden mit Foto, zwei Unterschriften, lokaler Abschluss (Tests 55–58, Clientteil).
  await goOffline(staff);
  await gotoOffline(staff, `/vorgaenge/${processB}/rueckgabe`);
  await expect(staff.getByTestId('wizard-offline-banner')).toBeVisible();
  await staff.getByTestId('return-start').click();
  await expect(staff.getByText('Rückgabe begonnen.')).toBeVisible();
  await expect(staff.getByRole('heading', { name: '1. Vorgang und Rückgabeperson' })).toBeVisible();
  await staff.getByLabel('Sonstige Rückgabeperson').check();
  await staff.locator('#returner-first').fill('Rolf');
  await staff.locator('#returner-last').fill('Rückläufer');
  await staff.locator('#returner-phone').fill(RETURNER_PHONE);
  await staff.getByTestId('returner-save').click();
  await expect(staff.getByText('Rückgabeperson übernommen.')).toBeVisible();
  await next(staff);
  await expect(staff.getByRole('heading', { name: '2. Maschinen bestätigen' })).toBeVisible();
  await staff.getByRole('button', { name: /Scannen zur Bestätigung/ }).click();
  await staff.locator('#qr-manual').fill(tokenMachine01);
  await staff.getByRole('button', { name: 'Auflösen' }).click();
  await expect(staff.getByText('Maschine MR-10-01-01 bestätigt.')).toBeVisible();
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
  await expect(staff.getByRole('heading', { name: '5. Kommissionsrückgabe' })).toBeVisible();
  await next(staff);
  await expect(staff.getByRole('heading', { name: '6. Schäden dokumentieren' })).toBeVisible();
  await staff.getByTestId('damage-add-1').click();
  const form = staff.getByTestId('damage-form-1');
  await staff.getByTestId('damage-diagram-view-left').click();
  await clickDiagram(staff.getByTestId('damage-diagram-svg'), 0.4, 0.3);
  await expect(staff.getByTestId('damage-diagram-marker-0')).toBeVisible();
  await form.locator('#damage-severity').selectOption('medium');
  await form.locator('#damage-description').fill('Kratzer offline erfasst (E2E Härtung)');
  await staff.getByTestId('damage-save').click();
  await expect(staff.getByText(/Schaden gespeichert/)).toBeVisible();
  await staff
    .locator('input[data-testid^="damage-photo-input-"]')
    .setInputFiles({ name: 'schaden.jpg', mimeType: 'image/jpeg', buffer: JPEG_1X1 });
  await expect(staff.getByText('Schadensfoto gespeichert.')).toBeVisible();
  await next(staff);
  await expect(staff.getByRole('heading', { name: '7. Zusammenfassung' })).toBeVisible();
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

  // Test 53: QR-Ergebnis im Tabletmodus – nur Maschinencode + Kontext, kein Kundenname.
  await gotoOffline(staff, '/tablet');
  await staff.getByTestId('tablet-actions').getByTestId('tablet-qr').click();
  await staff.locator('#qr-manual').fill(tokenMachine01);
  await staff.getByRole('button', { name: 'Auflösen' }).click();
  const scanResult = staff.getByTestId('tablet-scan-result');
  await expect(scanResult).toContainText('Maschine MR-10-01-01');
  await expect(scanResult).not.toContainText('Hardening');
  await expect(scanResult).not.toContainText('Olga');
  await expect(scanResult).not.toContainText('olga.hardening');
  await expect(scanResult).not.toContainText(RETURNER_PHONE);
  await staff.getByRole('button', { name: 'Schließen' }).click();
  // Maschine eines Vorgangs AUSSERHALB des Pakets: neutrale Meldung oder nur die Maschine.
  await staff.getByTestId('tablet-actions').getByTestId('tablet-qr').click();
  await staff.locator('#qr-manual').fill(tokenMachineP);
  await staff.getByRole('button', { name: 'Auflösen' }).click();
  const invalid = staff.getByText('Dieser QR-Code ist nicht gültig.');
  await expect(scanResult.or(invalid)).toBeVisible();
  if ((await scanResult.count()) > 0) {
    await expect(scanResult).toContainText('MR-10-02-01');
    await expect(scanResult).not.toContainText('Pakettfern');
    await expect(scanResult).not.toContainText('Paul');
    await expect(scanResult).not.toContainText(numberP);
    await expect(scanResult.getByTestId('tablet-scan-ausgabe')).toHaveCount(0);
    await expect(scanResult.getByTestId('tablet-scan-rueckgabe')).toHaveCount(0);
  }
  await expect(staff.locator('main')).not.toContainText('Pakettfern');
  await staff.getByRole('button', { name: 'Schließen' }).click();

  // Tests 55–58 (Clientteil): Konsole ohne Telefonnummer, Rohtoken, Bildbytes.
  staff.off('console', onConsole);
  const joined = consoleLines.join('\n');
  expect(joined).not.toContain(RETURNER_PHONE);
  expect(joined).not.toContain(RETURNER_PHONE.replace(/\s/g, ''));
  expect(joined.toLowerCase()).not.toContain(tokenMachine01.toLowerCase());
  expect(joined.toLowerCase()).not.toContain(tokenMachineP.toLowerCase());
  expect(joined).not.toContain('iVBORw0KGgo'); // PNG (Unterschriften)
  expect(joined).not.toContain('/9j/'); // JPEG (Schadensfoto)
  // Rohtoken auch nicht im Klartext des lokalen Maschinen-Stores.
  const machinesText = await storeText(staff, 'machines');
  expect(machinesText.toLowerCase()).not.toContain(tokenMachine01.toLowerCase());

  // Rückgabe synchronisieren → serverseitig final, Maschine in Reinigung.
  await goOnlineAndSync(staff);
  await expect(staff.getByTestId('offline-indicator')).toHaveAttribute('data-conflicts', '0');
  expect((await machineByCode(staff, 'MR-10-01-01')).status).toBe('cleaning');

  // Test 12: Online-Auflösung – der Rohtoken steht in keiner Request-URL (POST-Body),
  // der Deep-Link /qr/<token> hinterlässt den Token nicht in der Seiten-URL.
  const requestUrls: string[] = [];
  const onRequest = (request: Request) => requestUrls.push(request.url());
  staff.on('request', onRequest);
  await staff.goto('/tablet');
  await staff.getByTestId('tablet-actions').getByTestId('tablet-qr').click();
  await staff.locator('#qr-manual').fill(tokenMachine01);
  await staff.getByRole('button', { name: 'Auflösen' }).click();
  await expect(staff.getByTestId('tablet-scan-result')).toContainText('Maschine MR-10-01-01');
  await staff.getByRole('button', { name: 'Schließen' }).click();
  await staff.goto(`/qr/${tokenMachine01}`);
  await staff.waitForURL(/\/maschinen\/[0-9a-f-]{36}(\?|$)/, { timeout: 30_000 });
  expect(staff.url().toLowerCase()).not.toContain(tokenMachine01.toLowerCase());
  await expect(staff.getByTestId('qr-token')).toBeVisible();
  staff.off('request', onRequest);
  const leaking = requestUrls
    .filter((url) => url.toLowerCase().includes(tokenMachine01.toLowerCase()))
    .map((url) => new URL(url).pathname)
    .filter((pathname) => pathname !== `/qr/${tokenMachine01}`);
  expect(leaking).toEqual([]);
  expect(
    requestUrls.some((url) => new URL(url).pathname === '/api/staff/machines/qr/resolve'),
  ).toBe(true);
});
