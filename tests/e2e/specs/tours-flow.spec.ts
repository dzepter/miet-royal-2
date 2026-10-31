/**
 * Phase-13-E2E-Szenarien A–N (Order §82) – Touren, Routing, aktive Fahrt,
 * GPS, Verspätungsrisiko. Projekt `chromium`: Haupt-API mit
 * ROUTING_PROVIDER=graphhopper gegen den lokalen GraphHopper-Contract-Fake
 * (HTTPS 4567, /api/1; Steuerung helpers/routing.ts) – nie ein echter Provider.
 *
 * A Tour planen (drei Termine, Delivery + Return + weiterer, Fahrer, Zeiten,
 *   Reihenfolge, Puffer, speichern, Bereit)
 * B Routenvorschlag (flexible Fenster + ein exakter Termin, Adress-Review
 *   „Am Markt“, Vorschlag respektiert den exakten Termin, übernehmen)
 * C unmögliche Route (Warnung, keine Terminänderung)
 * D Zuständigkeit (Stopp einer anderen Person, kein stiller Wechsel, bewusste
 *   Reassignment-Bestätigung)
 * E Tour starten (manuell, aktive Tour, nächster Stopp, Navigation)
 * F GPS (Berechtigung/simulierte Position, serverseitig genau eine Zeile)
 * G Verspätungsrisiko (Fake-Position Frankfurt ⇒ Risk, genau ein Push je
 *   Empfänger, keine Kundenkommunikation, kein Spam)
 * H Recovery (Provider aus ⇒ „Route konnte gerade nicht berechnet werden.“,
 *   Tour bedienbar, externer Kartenlink ohne Key/Kundenname)
 * I Verschiebung während der Tour (stale ⇒ neu berechnen)
 * J Übernahme (atomar; erledigte Stopps bleiben beim bisherigen Fahrer; GPS weg)
 * K Vertretung (effektive Tourzuständigkeit)
 * L Kundenstatus „Unterwegs“ (interner Service – kein Endpunkt – über das
 *   Seed-Skript gegen die E2E-Datenbank geprüft; kein GPS/ETA)
 * M Offline (Arbeitspaket vorab geladen, Netz weg, Stoppliste + Navigation,
 *   Übergabe offline, Mutationen blockiert, Sync ⇒ Stopp erledigt ⇒ normales Ende)
 * N Tourende (offene Stopps blockieren, Planer-Abschluss mit Grund, Termine offen,
 *   Live-Standort gelöscht, Stopps wieder verfügbar)
 *
 * Daten: Basis-Seed + apps/api/scripts/e2e-tours-seed.ts (bestehende API-
 * Test-Helfer: echter Annahmepfad, Terminplanung, Mitarbeiter mit Rechten).
 * Alle Termine liegen HEUTE (Europe/Berlin) relativ zu „jetzt“. Ausschließlich
 * synthetische Testdaten; Adressen sind die bekannten Fake-Adressen
 * („Lieferweg 12, 55129 Mainz“, Depot „Robert-Koch-Straße 1, 55129 Mainz“,
 * mehrdeutig „Am Markt 1, 55116 Mainz“).
 */
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { ROUTING_FAKE_API_KEY } from '../fakes/constants.ts';
import { decryptedPushes } from '../helpers/communication-ops.ts';
import { runDueJobsViaApi } from '../helpers/jobs.ts';
import {
  clearPushRequests,
  createPushSubscriptionKeys,
  pushRequests,
  registerPushSubscription,
  type PushSubscriptionKeys,
} from '../helpers/push.ts';
import {
  failRouting,
  resetRoutingFake,
  routingRequestText,
  routingRequests,
} from '../helpers/routing.ts';
import { ADMIN_EMAIL, ADMIN_PASSWORD, resetE2eDatabase } from '../helpers/seed.ts';
import { queryTestDb } from '../helpers/voucher.ts';
import {
  appointmentRow,
  berlinClock,
  completeAppointmentViaSeed,
  delayIncidents,
  liveLocations,
  loginStaff,
  pushDeliveriesOfKind,
  seedTours,
  stopOf,
  tableCount,
  todayPlusMinutes,
  tourRow,
  tourViaApi,
  travelStatusViaSeed,
  type SeededBooking,
  type ToursSeedResult,
} from '../helpers/tours.ts';

test.describe.configure({ mode: 'serial' });

const PAUL = { email: 'paul.planer@e2e.example', password: 'e2e-paul-passwort-1' };
const FRITZ = { email: 'fritz.fahrer@e2e.example', password: 'e2e-fritz-passwort-1' };
const ZOE = { email: 'zoe.zweite@e2e.example', password: 'e2e-zoe-passwort-1' };

/** Bekannte Fake-Koordinaten (routing/testing/fake-server.ts). */
const MAINZ_NEAR = { latitude: 49.96, longitude: 8.27, accuracy: 20 };
const MAINZ_MOVED = { latitude: 49.975, longitude: 8.3, accuracy: 20 };
const FRANKFURT = { latitude: 50.11, longitude: 8.68, accuracy: 25 };
const FRANKFURT_MOVED = { latitude: 50.12, longitude: 8.7, accuracy: 25 };
/** Client-Drossel (lib/tours.ts): nie öfter als alle 15 s; Server: 1 Update je 10 s. */
const LOCATION_GAP_MS = 16_000;

/** 1×1-PNG (Testpixel) für das Gesamtfoto der Offline-Übergabe. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let erika: Page; // Admin (system.settings, Planung/Admin-Push)
let paul: Page; // Planer (calendar.manage + appointment.assign + view_all + process.view_all)
let fritzContext: BrowserContext; // „Gerät“ des Fahrers: Geolocation, Service Worker, Offline
let fritz: Page; // Fahrer (calendar.view + Übergabe-/Rückgaberechte)
let zoe: Page; // zweite Fahrerin (calendar.view + calendar.view_all + appointment.assign)

let seed: ToursSeedResult;
const b = (key: string): SeededBooking => {
  const booking = seed.bookings[key];
  if (booking === undefined) throw new Error(`Seed-Buchung ${key} fehlt`);
  return booking;
};
const userId = (key: string): string => {
  const user = seed.users[key];
  if (user === undefined) throw new Error(`Seed-Nutzer ${key} fehlt`);
  return user.id;
};

let tourA = '';
let tourT1 = '';
let tourT2 = '';
let keysFritz: PushSubscriptionKeys;
let keysErika: PushSubscriptionKeys;
let mailsBefore = 0;
let messagesBefore = 0;

const iso = (date: Date) => date.toISOString();

test.beforeAll(async ({ browser }) => {
  resetE2eDatabase();
  await resetRoutingFake();
  await clearPushRequests();
  // Termine HEUTE relativ zu jetzt (auf den Berliner Kalendertag geklemmt).
  const t = (delta: number) => iso(todayPlusMinutes(delta));
  seed = seedTours({
    adminEmail: ADMIN_EMAIL,
    depotAddress: 'Robert-Koch-Straße 1, 55129 Mainz',
    users: [
      {
        key: 'paul',
        firstName: 'Paul',
        lastName: 'Planer',
        email: PAUL.email,
        password: PAUL.password,
        permissions: [
          'calendar.view',
          'calendar.view_all',
          'calendar.manage',
          'calendar.drag_drop',
          'appointment.assign',
          'appointment.reassign_same_day',
          'process.view_all',
        ],
      },
      {
        key: 'fritz',
        firstName: 'Fritz',
        lastName: 'Fahrer',
        email: FRITZ.email,
        password: FRITZ.password,
        permissions: [
          'calendar.view',
          'process.view_all',
          'handover.view',
          'handover.prepare',
          'handover.perform',
          'return.view',
          'return.perform',
          'return.complete',
          'machine.view',
          'machine.assign',
          'inventory.view',
        ],
      },
      {
        key: 'zoe',
        firstName: 'Zoe',
        lastName: 'Zweite',
        email: ZOE.email,
        password: ZOE.password,
        // Übernahme setzt Sichtbarkeit der fremden Tour voraus (calendar.view_all) + appointment.assign;
        // aktive Touren sind immer „heute“ ⇒ Same-Day-Regel ⇒ appointment.reassign_same_day
        // (Order §29; ohne das Recht scheitert die Übernahme vollständig – Rollback, in Lauf 8 gesehen).
        permissions: [
          'calendar.view',
          'calendar.view_all',
          'appointment.assign',
          'appointment.reassign_same_day',
          'process.view_all',
        ],
      },
    ],
    bookings: [
      // A: Delivery + Return derselben Buchung + weitere Lieferung
      {
        key: 'a1',
        customer: { firstName: 'Anna', lastName: 'Anlieferung' },
        outbound: { startAt: t(120), endAt: t(180) },
        inbound: { startAt: t(360) },
      },
      {
        key: 'a2',
        customer: { firstName: 'Arno', lastName: 'Abend' },
        outbound: { startAt: t(200), endAt: t(260) },
      },
      // B: zwei Fenster + ein exakter Termin an der mehrdeutigen Adresse
      {
        key: 'b1',
        customer: { firstName: 'Bea', lastName: 'Bunt' },
        outbound: { startAt: t(60), endAt: t(180) },
      },
      {
        key: 'b2',
        customer: { firstName: 'Ben', lastName: 'Blau' },
        outbound: { startAt: t(60), endAt: t(240) },
      },
      {
        key: 'b3',
        customer: { firstName: 'Bo', lastName: 'Markt' },
        address: { street: 'Am Markt 1', postalCode: '55116', city: 'Mainz' },
        outbound: { startAt: t(150) },
      },
      // C: exakter Termin bereits verstrichen ⇒ nicht rechtzeitig erreichbar
      {
        key: 'c1',
        customer: { firstName: 'Cora', lastName: 'Chaos' },
        outbound: { startAt: t(-45) },
      },
      {
        key: 'c2',
        customer: { firstName: 'Carl', lastName: 'Cool' },
        outbound: { startAt: t(300), endAt: t(360) },
      },
      // D: Termin ist Zoe zugewiesen
      {
        key: 'd1',
        customer: { firstName: 'Dora', lastName: 'Dritte' },
        outbound: { startAt: t(240), endAt: t(300) },
        assignTo: 'zoe',
      },
      // E–L, N: aktive Tour T1 (e1 knappes Fenster für das Verspätungsrisiko)
      {
        key: 'e1',
        customer: { firstName: 'Emil', lastName: 'Erste' },
        outbound: { startAt: t(10), endAt: t(50) },
      },
      {
        key: 'e2',
        customer: { firstName: 'Ella', lastName: 'Exakt' },
        outbound: { startAt: t(90) },
      },
      {
        key: 'e3',
        customer: { firstName: 'Erik', lastName: 'Ende' },
        outbound: { startAt: t(120), endAt: t(180) },
      },
      // M: Offline-Tour T2 (Übergabe offline)
      {
        key: 'm1',
        customer: { firstName: 'Mia', lastName: 'Mobil' },
        outbound: { startAt: t(30), endAt: t(90) },
      },
    ],
  });

  erika = await browser.newPage();
  paul = await browser.newPage();
  zoe = await browser.newPage();
  fritzContext = await browser.newContext();
  await fritzContext.grantPermissions(['geolocation']);
  await fritzContext.setGeolocation(MAINZ_NEAR);
  fritz = await fritzContext.newPage();

  await loginStaff(erika, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await loginStaff(paul, PAUL.email, PAUL.password, 'Paul');
  await loginStaff(fritz, FRITZ.email, FRITZ.password, 'Fritz');
  await loginStaff(zoe, ZOE.email, ZOE.password, 'Zoe');
});

test.afterAll(async () => {
  await resetRoutingFake();
  await erika?.close();
  await paul?.close();
  await zoe?.close();
  await fritzContext?.close();
});

// ── UI-Helfer ────────────────────────────────────────────────────────────

/** Neue Tour (heute) für den Fahrer über /touren/neu; liefert die Tour-ID. */
async function createTourViaUi(page: Page, driverId: string): Promise<string> {
  await page.goto('/touren/neu');
  await expect(page.getByTestId('tour-new-form')).toBeVisible();
  await page.getByTestId('tour-new-driver').selectOption(driverId);
  await page.getByTestId('tour-new-submit').click();
  await page.waitForURL(/\/touren\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('tour-header')).toBeVisible();
  return /\/touren\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
}

/** Stopp aus „Verfügbare Stopps“ hinzufügen (ohne Zuständigkeitsdialog). */
async function addCandidate(page: Page, appointmentId: string) {
  await page.getByTestId(`candidate-add-${appointmentId}`).click();
  await expect(
    page.locator(`[data-testid^="tour-stop-"][data-appointment-id="${appointmentId}"]`),
  ).toBeVisible();
}

const stopRow = (page: Page, appointmentId: string): Locator =>
  page.locator(`[data-testid^="tour-stop-"][data-appointment-id="${appointmentId}"]`);

/** Navigationslink: nur Ziel – nie API-Key, nie Kundenname. */
function expectCleanNavigationHref(href: string | null, forbidden: readonly string[]) {
  expect(href, 'Navigationslink').not.toBeNull();
  expect(href!).toMatch(/^(https:\/\/|geo:)/);
  expect(href!).not.toContain(ROUTING_FAKE_API_KEY);
  expect(href!.toLowerCase()).not.toContain('key=');
  for (const word of forbidden) expect(href!).not.toContain(word);
}

/** Service Worker aktiv + Arbeitspaket geladen (Muster offline-flow.spec.ts). */
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

async function goOnlineAndSync(page: Page) {
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'online',
    { timeout: 30_000 },
  );
  await page.goto('/sync');
  await page.getByTestId('sync-now').click();
  await expect
    .poll(async () => page.getByTestId('offline-indicator').getAttribute('data-pending'), {
      timeout: 60_000,
      intervals: [2_000],
    })
    .toBe('0');
  const conflicts = await page.getByTestId('sync-conflict').allTextContents();
  const receipts = queryTestDb(
    `SELECT operation_type, context_kind, status, error_code, message FROM offline_mutation_receipts
      WHERE status <> 'applied' ORDER BY processed_at ASC`,
  );
  expect(
    conflicts,
    `Sync-Konflikte: ${JSON.stringify(conflicts)} Quittungen: ${JSON.stringify(receipts)}`,
  ).toHaveLength(0);
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute('data-conflicts', '0');
}

/** Offline-Navigation: harte Navigation, der Service Worker liefert die gecachte Seite. */
async function gotoOffline(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'commit' });
}

async function sign(page: Page, label: 'Kunde' | 'Mitarbeiter') {
  const pad: Locator = page.getByTestId(`signature-${label}`);
  const canvas = pad.getByLabel(`Unterschrift ${label}`);
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 110);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 150, { steps: 8 });
  await page.mouse.move(box.x + 320, box.y + 80, { steps: 8 });
  await page.mouse.up();
  await pad.getByRole('button', { name: 'Unterschrift übernehmen' }).click();
}

/** Übergabe-Wizard offline bis zum lokalen Abschluss (Phase-8-Offline-Flow, wie offline-flow.spec.ts). */
async function handoverWizardOffline(page: Page, processId: string) {
  const next = () => page.getByTestId('wizard-next').click();
  await gotoOffline(page, `/vorgaenge/${processId}/uebergabe`);
  await expect(page.getByTestId('wizard-offline-banner')).toBeVisible();
  await next(); // Vorgang
  await next(); // Maschinen (vorbereitet)
  await next(); // Artikel
  await page.getByRole('button', { name: 'Maschine gemeinsam geprüft' }).click();
  await expect(page.getByTestId('check-1')).toContainText('Maschine gemeinsam geprüft');
  await page
    .getByTestId('photo-input-1')
    .setInputFiles({ name: 'gesamtfoto.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(
    page.getByTestId('check-1').locator('img.photo-thumb[data-local="true"]'),
  ).toHaveCount(1);
  await next(); // Empfänger
  await page.getByRole('button', { name: 'Übernehmen', exact: true }).click();
  await expect(page.getByText('Empfangsperson gespeichert.')).toBeVisible();
  await next(); // Zusammenfassung
  await next(); // Unterschrift Kunde
  await sign(page, 'Kunde');
  await expect(page.getByText(/Unterschrieben von/)).toBeVisible();
  await next();
  await sign(page, 'Mitarbeiter');
  await expect(page.getByText(/Unterschrieben von/)).toBeVisible();
  await next();
  await expect(page.getByTestId('wizard-blockers')).toHaveCount(0);
  await page.getByTestId('finalize-button').click();
  await expect(page.getByTestId('wizard-offline-pending')).toContainText(
    'Übergabe offline erfasst – Synchronisierung ausstehend.',
  );
}

/**
 * Bestände ehrlich erfassen (kein erfundener Bestand): die Übergabe-Finalisierung prüft die
 * Bestandsdeckung der Lieferschein-Artikel (Phase 6/8) – Muster offline-flow.spec.ts.
 */
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

/** Maschine zuweisen + vorbereiten (online) – Voraussetzung der Übergabe. */
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

// ── A: Tour planen ───────────────────────────────────────────────────────

test('A Tour planen: drei Termine (Lieferung + Rückgabe + weitere Lieferung), Fahrer, Reihenfolge, Puffer, Zeiten, speichern', async () => {
  test.setTimeout(180_000);
  tourA = await createTourViaUi(paul, userId('fritz'));
  await expect(paul.getByTestId('tour-header')).toContainText('Entwurf');
  await expect(paul.getByRole('heading', { name: /Fritz Fahrer/ })).toBeVisible();

  // Verfügbare Stopps des Tages: Lieferung + Rückgabe von a1, Lieferung a2.
  await expect(paul.getByTestId('tour-candidates')).toBeVisible();
  await addCandidate(paul, b('a1').outbound.id);
  await addCandidate(paul, b('a1').inbound.id);
  await addCandidate(paul, b('a2').outbound.id);
  await expect(paul.locator('[data-testid^="tour-stop-"]')).toHaveCount(3);
  let view = await tourViaApi(paul, tourA);
  expect(view.stops.map((stop) => stop.appointmentId)).toEqual([
    b('a1').outbound.id,
    b('a1').inbound.id,
    b('a2').outbound.id,
  ]);
  // 15-Minuten-Standardpuffer je Stopp (Order §21).
  expect(view.stops.map((stop) => stop.bufferMinutes)).toEqual([15, 15, 15]);

  // Reihenfolge: a2-Lieferung vor die Rückgabe schieben (Pfeil „Nach oben“).
  const a2Stop = stopOf(view, b('a2').outbound.id).id;
  await paul.getByTestId(`stop-up-${a2Stop}`).click();
  await expect(stopRow(paul, b('a2').outbound.id)).toHaveAttribute('data-sequence', '2');
  // Puffer der ersten Lieferung auf 20 Minuten (nur dieser Stopp).
  const a1Stop = stopOf(view, b('a1').outbound.id).id;
  await paul.getByTestId(`stop-buffer-${a1Stop}`).fill('20');
  await paul.getByTestId(`stop-buffer-${a1Stop}`).press('Enter');
  await expect
    .poll(async () => stopOf(await tourViaApi(paul, tourA), b('a1').outbound.id).bufferMinutes)
    .toBe(20);

  // Zeiten/Distanz für die aktuelle Reihenfolge (Routing-Fake, kein echter Provider).
  await paul.getByTestId('tour-evaluate').click();
  await expect(paul.getByTestId('tour-header')).toContainText('Route berechnet', {
    timeout: 30_000,
  });
  await expect(paul.getByTestId('metric-distance')).not.toHaveText('–');
  await expect(paul.getByTestId('metric-duration')).not.toHaveText('–');
  await expect(paul.getByTestId(`stop-plan-${a1Stop}`)).toContainText('Geplante Ankunft');
  await expect(paul.getByTestId('route-attribution')).toBeVisible();
  // Projekt chromium: echter Provider-Pfad (Fake) ⇒ KEIN „Simulation (Demo)“.
  await expect(paul.getByTestId('route-simulation')).toHaveCount(0);

  // Gespeichert: Neuladen zeigt Reihenfolge, Puffer und Plan; Metriken ohne Preise.
  await paul.reload();
  await expect(paul.getByTestId('tour-header')).toContainText('Route berechnet');
  view = await tourViaApi(paul, tourA);
  expect(view.planningStatus).toBe('planned');
  expect(view.routeProvider).toBe('graphhopper');
  expect(view.plannedDistanceMeters).toBeGreaterThan(0);
  expect(view.plannedDurationSeconds).toBeGreaterThan(0);
  expect(stopOf(view, b('a2').outbound.id).sequence).toBe(2);
  expect(stopOf(view, b('a1').inbound.id).sequence).toBe(3);
  expect(stopOf(view, b('a1').outbound.id).bufferMinutes).toBe(20);
  expect(stopOf(view, b('a1').outbound.id).plannedArrivalAt).not.toBeNull();
  expect(JSON.stringify(view)).not.toMatch(/price|preis/i);

  // Datenminimierung (Order §4): an den Provider gehen nur Adressen/Koordinaten/Zeiten.
  const requests = await routingRequests();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((request) => request.keyPresent && request.keyValid)).toBe(true);
  const sent = routingRequestText(requests);
  expect(sent).not.toContain('Anlieferung');
  expect(sent).not.toContain('Abend');
  expect(sent).not.toContain(b('a1').processNumber);
  expect(sent).not.toContain(ROUTING_FAKE_API_KEY);

  // Bereit markieren.
  await paul.getByTestId('tour-ready').click();
  await expect(paul.getByTestId('tour-header')).toContainText('Bereit');
  expect(tourRow(tourA).status).toBe('ready');
});

// ── B: Routenvorschlag ───────────────────────────────────────────────────

test('B Routenvorschlag: Fenster + exakter Termin, Adresse für Route prüfen, Vorschlag respektiert den Termin, übernehmen', async () => {
  test.setTimeout(180_000);
  const tourB = await createTourViaUi(paul, userId('fritz'));
  await addCandidate(paul, b('b1').outbound.id);
  await addCandidate(paul, b('b2').outbound.id);
  await addCandidate(paul, b('b3').outbound.id);
  const before = await tourViaApi(paul, tourB);
  const b3Stop = stopOf(before, b('b3').outbound.id).id;

  // Mehrdeutige Adresse „Am Markt 1“ ⇒ Berechnung blockiert, Staff wählt den Kandidaten.
  await paul.getByTestId('tour-propose').click();
  const blocked = paul.getByTestId('tour-plan-blocked');
  await expect(blocked).toBeVisible({ timeout: 30_000 });
  await expect(blocked.locator('[data-reason="GEOCODING_REVIEW_REQUIRED"]')).toBeVisible();
  await paul.getByTestId(`blocked-review-${b3Stop}`).click();
  const dialog = paul.getByTestId('address-review-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Am Markt 1');
  const candidates = dialog.locator('[data-testid^="address-candidate-"]');
  await expect(candidates).toHaveCount(2);
  await candidates.first().click();
  await expect(dialog).toHaveCount(0);

  // Vorschlag: drei Stopps, keine Konflikte; exakter Termin wird nicht verschoben.
  await paul.getByTestId('tour-propose').click();
  const proposal = paul.getByTestId('tour-proposal');
  await expect(proposal).toBeVisible({ timeout: 30_000 });
  await expect(proposal.locator('[data-testid^="proposal-stop-"]')).toHaveCount(3);
  await expect(paul.getByTestId('proposal-conflict')).toHaveCount(0);
  await expect(paul.getByTestId('proposal-infeasible')).toHaveCount(0);
  await expect(paul.getByTestId('proposal-distance')).not.toHaveText('–');
  // Vorschlag ist noch nichts: Tour unverändert, bis „übernehmen“.
  expect((await tourViaApi(paul, tourB)).planningStatus).toBe('unplanned');

  await paul.getByTestId('tour-apply').click();
  await expect(paul.getByTestId('tour-header')).toContainText('Route berechnet', {
    timeout: 30_000,
  });
  const after = await tourViaApi(paul, tourB);
  expect(after.planningStatus).toBe('planned');
  const exact = stopOf(after, b('b3').outbound.id);
  const exactAt = new Date(exact.appointment.startAt!).getTime();
  expect(exact.plannedArrivalAt).not.toBeNull();
  // Fester Anker: Abfahrt vom Stopp nie vor dem exakten Termin, Ankunft spätestens zum Termin.
  expect(new Date(exact.plannedArrivalAt!).getTime()).toBeLessThanOrEqual(exactAt);
  const row = paul.locator(`[data-testid="tour-stop-${exact.id}"]`);
  await expect(row).toContainText(`${berlinClock(exact.appointment.startAt!)} Uhr`);
  // Termine selbst unverändert (Order §22: nie automatische Terminänderung) – Zeiten wie vor
  // der Planung (die Version stieg nur durch die Zuweisung an den Tourfahrer beim Hinzufügen).
  for (const key of ['b1', 'b2', 'b3']) {
    const stopBefore = stopOf(before, b(key).outbound.id);
    const current = appointmentRow(b(key).outbound.id);
    expect(current.status).toBe('scheduled');
    expect(new Date(current.start_at!).toISOString()).toBe(stopBefore.appointment.startAt);
    expect(current.end_at === null ? null : new Date(current.end_at).toISOString()).toBe(
      stopBefore.appointment.endAt,
    );
  }
});

// ── C: unmögliche Route ──────────────────────────────────────────────────

test('C Unmögliche Route: Warnung „nicht rechtzeitig erreichbar“, keine Terminänderung', async () => {
  test.setTimeout(120_000);
  const tourC = await createTourViaUi(paul, userId('fritz'));
  await addCandidate(paul, b('c1').outbound.id);
  await addCandidate(paul, b('c2').outbound.id);
  const c1Before = appointmentRow(b('c1').outbound.id);

  await paul.getByTestId('tour-propose').click();
  const proposal = paul.getByTestId('tour-proposal');
  await expect(proposal).toBeVisible({ timeout: 30_000 });
  await expect(paul.getByTestId('proposal-infeasible')).toBeVisible();
  await expect(paul.getByTestId('proposal-conflict').first()).toContainText(
    /nicht rechtzeitig erreichbar|konnte nicht eingeplant werden/,
  );
  await paul.getByTestId('tour-discard').click();
  await expect(proposal).toHaveCount(0);

  // Zeiten für die aktuelle Reihenfolge: Konflikt bleibt sichtbar, Status „nicht machbar“.
  await paul.getByTestId('tour-evaluate').click();
  await expect(paul.getByTestId('plan-infeasible')).toBeVisible({ timeout: 30_000 });
  await expect(paul.getByTestId('plan-conflict').first()).toContainText(
    'ist nach dem vorherigen Stopp voraussichtlich nicht rechtzeitig erreichbar.',
  );
  await expect(paul.getByTestId('tour-header')).toContainText('Route nicht machbar');
  await expect(
    paul.getByTestId('tour-warnings').locator('[data-warning="PLAN_INFEASIBLE"]'),
  ).toBeVisible();
  expect((await tourViaApi(paul, tourC)).planningStatus).toBe('infeasible');

  // Keine Terminmutation durch die Planung.
  const c1After = appointmentRow(b('c1').outbound.id);
  expect(c1After.start_at).toBe(c1Before.start_at);
  expect(c1After.version).toBe(c1Before.version);
  expect(c1After.status).toBe('scheduled');
});

// ── D: Zuständigkeit ─────────────────────────────────────────────────────

test('D Zuständigkeit: Stopp einer anderen Person – kein stiller Wechsel, bewusste Umzuweisung', async () => {
  test.setTimeout(120_000);
  const tourD = await createTourViaUi(paul, userId('fritz'));
  const appointmentId = b('d1').outbound.id;
  await expect(paul.getByTestId(`candidate-assignment-${appointmentId}`)).toContainText(
    'Zuständig: Zoe Zweite',
  );

  // Hinzufügen öffnet den Bestätigungsdialog – Abbrechen ändert nichts.
  await paul.getByTestId(`candidate-add-${appointmentId}`).click();
  const dialog = paul.getByTestId('reassign-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Zoe Zweite');
  await paul.getByTestId('reassign-dialog-cancel').click();
  await expect(dialog).toHaveCount(0);
  expect(appointmentRow(appointmentId).assigned_user_id).toBe(userId('zoe'));
  expect((await tourViaApi(paul, tourD)).stops).toHaveLength(0);

  // Bewusst bestätigen ⇒ Stopp hinzugefügt, Termin dem Tourfahrer zugewiesen.
  await paul.getByTestId(`candidate-add-${appointmentId}`).click();
  await expect(dialog).toBeVisible();
  await paul.getByTestId('reassign-confirm').click();
  await expect(stopRow(paul, appointmentId)).toBeVisible();
  expect(appointmentRow(appointmentId).assigned_user_id).toBe(userId('fritz'));
  const view = await tourViaApi(paul, tourD);
  expect(stopOf(view, appointmentId).appointment.assignedUserId).toBe(userId('fritz'));
});

// ── E: Tour starten ──────────────────────────────────────────────────────

test('E Tour starten: manuell, aktive Tour, nächster Stopp, Navigation', async () => {
  test.setTimeout(180_000);
  tourT1 = await createTourViaUi(paul, userId('fritz'));
  await addCandidate(paul, b('e1').outbound.id);
  await addCandidate(paul, b('e2').outbound.id);
  await addCandidate(paul, b('e3').outbound.id);
  await paul.getByTestId('tour-evaluate').click();
  await expect(paul.getByTestId('tour-header')).toContainText('Route berechnet', {
    timeout: 30_000,
  });
  expect(tourRow(tourT1).started_at).toBeNull();

  // Der Fahrer startet bewusst (Bestätigung) – kein Auto-Start.
  await fritz.goto(`/touren/${tourT1}`);
  await expect(fritz.getByTestId('tour-start')).toBeVisible();
  await fritz.getByTestId('tour-start').click();
  await expect(fritz.getByTestId('start-dialog')).toBeVisible();
  await fritz.getByTestId('start-confirm').click();
  await fritz.waitForURL(new RegExp(`/touren/aktiv\\?id=${tourT1}`));
  await expect(fritz.getByTestId('active-tour-page')).toBeVisible();

  const view = await tourViaApi(fritz, tourT1);
  expect(view.status).toBe('active');
  expect(tourRow(tourT1).started_at).not.toBeNull();
  const e1Stop = stopOf(view, b('e1').outbound.id);
  expect(view.nextStop?.id).toBe(e1Stop.id);

  const next = fritz.getByTestId('next-stop');
  await expect(next).toHaveAttribute('data-stop-id', e1Stop.id);
  await expect(next).toContainText(b('e1').processNumber);
  await expect(fritz.getByTestId('next-stop-address')).toContainText('Lieferweg 12');
  const navigation = fritz.getByTestId('navigation-start');
  await expect(navigation).toHaveAttribute('data-platform', 'web');
  expectCleanNavigationHref(await navigation.getAttribute('href'), ['Erste', 'Emil']);
  await expect(fritz.getByTestId('remaining-stops')).toContainText(b('e2').processNumber);
  await expect(fritz.getByTestId('remaining-stops')).toContainText(b('e3').processNumber);
  // „Heute“ bietet die aktive Tour prominent an.
  await fritz.goto('/');
  await expect(fritz.getByTestId('active-tour-resume')).toBeVisible();
});

// ── F: GPS ───────────────────────────────────────────────────────────────

test('F GPS: Berechtigung + simulierte Position ⇒ serverseitig genau eine aktuelle Zeile, keine Historie', async () => {
  test.setTimeout(120_000);
  expect(liveLocations(tourT1)).toHaveLength(0);
  await fritz.goto(`/touren/aktiv?id=${tourT1}`);
  await expect(fritz.getByTestId('location-card')).toBeVisible();
  await fritz.getByTestId('location-enable').click();
  await expect(fritz.getByTestId('location-active')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => liveLocations(tourT1).length, { timeout: 20_000 }).toBe(1);
  const first = liveLocations(tourT1)[0]!;
  expect(first.user_id).toBe(userId('fritz'));
  expect(first.latitude).toBeCloseTo(MAINZ_NEAR.latitude, 3);
  expect(first.longitude).toBeCloseTo(MAINZ_NEAR.longitude, 3);

  // Bewegung (> 250 m, nach der Client-Drossel): Update überschreibt – keine zweite Zeile.
  await fritz.waitForTimeout(LOCATION_GAP_MS);
  await fritzContext.setGeolocation(MAINZ_MOVED);
  await expect
    .poll(() => liveLocations(tourT1)[0]?.latitude ?? 0, { timeout: 30_000 })
    .toBeCloseTo(MAINZ_MOVED.latitude, 3);
  const rows = liveLocations(tourT1);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.longitude).toBeCloseTo(MAINZ_MOVED.longitude, 3);
  // Die Tour-View liefert nie Koordinaten des Fahrers (nur Zeitpunkte/stale).
  const view = await tourViaApi(paul, tourT1);
  expect(view.liveLocation).not.toBeNull();
  expect(view.liveLocation!.stale).toBe(false);
  expect(Object.keys(view.liveLocation!)).toEqual(
    expect.not.arrayContaining(['latitude', 'longitude']),
  );
  // Pünktlich (nahe Position, Fenster offen) ⇒ kein Risiko.
  expect(delayIncidents(tourT1)).toHaveLength(0);
});

// ── G: Verspätungsrisiko ─────────────────────────────────────────────────

test('G Verspätungsrisiko: Fake-ETA zu spät ⇒ Risk, genau ein Push je Empfänger, keine Kundenkommunikation', async () => {
  test.setTimeout(180_000);
  keysFritz = createPushSubscriptionKeys();
  keysErika = createPushSubscriptionKeys();
  await registerPushSubscription(fritz, keysFritz, 'E2E-Fritz');
  await registerPushSubscription(erika, keysErika, 'E2E-Erika');
  await clearPushRequests();
  mailsBefore = tableCount('mail_deliveries');
  messagesBefore = tableCount('conversation_messages');
  expect(pushDeliveriesOfKind('tour_delay_risk')).toHaveLength(0);

  // Position „Frankfurt“ (≈ 45 km ⇒ ≈ 1,5 h Fahrzeit im Fake) bei knappem Fenster von e1.
  await fritz.waitForTimeout(LOCATION_GAP_MS);
  await fritzContext.setGeolocation(FRANKFURT);
  await expect
    .poll(() => delayIncidents(tourT1).filter((row) => row.resolved_at === null).length, {
      timeout: 60_000,
    })
    .toBe(1);
  const incident = delayIncidents(tourT1)[0]!;
  const e1Stop = stopOf(await tourViaApi(paul, tourT1), b('e1').outbound.id);
  expect(incident.stop_id).toBe(e1Stop.id);
  await expect
    .poll(() => delayIncidents(tourT1)[0]!.notification_sent_at, { timeout: 20_000 })
    .not.toBeNull();
  expect(e1Stop.delay?.status).toBe('risk');

  // UI: Banner mit Vorgangsnummer + „Kunden kontaktieren“ (nur Link zur bestehenden Kommunikation).
  await fritz.reload();
  const banner = fritz.getByTestId('delay-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(`Tour droht Termin zu verpassen – ${b('e1').processNumber}`);
  await expect(fritz.getByTestId('delay-contact-customer')).toHaveAttribute(
    'href',
    `/vorgaenge/${b('e1').processId}/kommunikation`,
  );

  // Genau ein Push je Empfänger (Fahrer + Planung/Admin), datenminimiert.
  const deliveries = pushDeliveriesOfKind('tour_delay_risk');
  const recipients = new Set(deliveries.map((row) => row.user_id));
  expect(deliveries.length).toBe(recipients.size);
  expect(recipients.has(userId('fritz'))).toBe(true);
  expect(recipients.has(userId('admin'))).toBe(true);
  expect(recipients.has(userId('paul'))).toBe(true);
  // Zoe hat calendar.view_all (Planungs-Empfängerkreis), Viktor (nur calendar.view) nicht.
  expect(recipients.has(userId('zoe'))).toBe(true);
  expect(recipients.size).toBe(4);
  await runDueJobsViaApi(erika);
  await expect
    .poll(async () => (await pushRequests(keysFritz)).length, { timeout: 20_000 })
    .toBe(1);
  expect(await pushRequests(keysErika)).toHaveLength(1);
  const [push] = await decryptedPushes(keysFritz);
  expect(push!.payload.kind).toBe('tour_delay_risk');
  expect(push!.payload.title).toBe('Tour droht Termin zu verpassen');
  expect(push!.payload.body).toContain(b('e1').processNumber);
  expect(push!.payload.url).toBe('/touren/aktiv');
  expect(push!.plaintext).not.toContain('Lieferweg');
  expect(push!.plaintext).not.toContain('Erste');
  expect(push!.plaintext).not.toContain('49.');
  const [planningPush] = await decryptedPushes(keysErika);
  expect(planningPush!.payload.url).toBe(`/touren/${tourT1}`);

  // Weiterhin zu spät (weitere Position) ⇒ derselbe Incident, kein zweiter Push (kein Spam).
  // Nach dem Neuladen ist der Standort-Watch beendet (nichts im Browser gespeichert) –
  // der Fahrer gibt den Standort erneut frei.
  const evaluatedBefore = delayIncidents(tourT1)[0]!;
  await fritz.getByTestId('location-enable').click();
  await expect(fritz.getByTestId('location-active')).toBeVisible({ timeout: 30_000 });
  await fritz.waitForTimeout(LOCATION_GAP_MS);
  await fritzContext.setGeolocation(FRANKFURT_MOVED);
  await expect
    .poll(() => liveLocations(tourT1)[0]?.latitude ?? 0, { timeout: 30_000 })
    .toBeCloseTo(FRANKFURT_MOVED.latitude, 3);
  await expect.poll(() => delayIncidents(tourT1).length, { timeout: 30_000 }).toBe(1);
  expect(delayIncidents(tourT1)[0]!.id).toBe(evaluatedBefore.id);
  await runDueJobsViaApi(erika);
  expect(pushDeliveriesOfKind('tour_delay_risk')).toHaveLength(deliveries.length);
  expect(await pushRequests(keysFritz)).toHaveLength(1);
  expect(await pushRequests(keysErika)).toHaveLength(1);

  // Keine automatische Kundenkommunikation (Mail/WhatsApp/Nachricht).
  expect(tableCount('mail_deliveries')).toBe(mailsBefore);
  expect(tableCount('conversation_messages')).toBe(messagesBefore);
});

// ── H: Recovery ──────────────────────────────────────────────────────────

test('H Recovery: Provider aus ⇒ verständliche Meldung, Tour bedienbar, externer Kartenlink ohne Key', async () => {
  test.setTimeout(120_000);
  await failRouting({ endpoint: 'all', times: 20, status: 503 });
  await fritz.goto(`/touren/aktiv?id=${tourT1}`);
  await fritz.getByTestId('tour-recalculate').click();
  await expect(fritz.getByTestId('active-tour-error')).toHaveText(
    'Route konnte gerade nicht berechnet werden.',
    { timeout: 30_000 },
  );
  // Tourdaten bleiben gültig und bedienbar: nächster Stopp, Navigation, „Angekommen“.
  const view = await tourViaApi(fritz, tourT1);
  expect(view.status).toBe('active');
  const e1Stop = stopOf(view, b('e1').outbound.id);
  await expect(fritz.getByTestId('next-stop')).toHaveAttribute('data-stop-id', e1Stop.id);
  expectCleanNavigationHref(await fritz.getByTestId('navigation-start').getAttribute('href'), [
    'Erste',
    'Emil',
  ]);
  await fritz.getByTestId('stop-arrived').click();
  await expect
    .poll(async () => stopOf(await tourViaApi(fritz, tourT1), b('e1').outbound.id).state)
    .toBe('arrived');
  // Provider wieder da: Störungen + Aufzeichnung zurücksetzen.
  await resetRoutingFake();
  await fritz.getByTestId('tour-recalculate').click();
  await expect(fritz.getByTestId('active-tour-error')).toHaveCount(0, { timeout: 30_000 });
});

// ── I: Verschiebung während der Tour ─────────────────────────────────────

test('I Reschedule: Termin während der Tour verschoben ⇒ Route veraltet ⇒ neu berechnen', async () => {
  test.setTimeout(120_000);
  const e3 = appointmentRow(b('e3').outbound.id);
  const e2Before = appointmentRow(b('e2').outbound.id);
  const newStart = todayPlusMinutes(130);
  const newEnd = todayPlusMinutes(190);
  const response = await erika.request.patch(`/api/staff/appointments/${e3.id}/schedule`, {
    data: { startAt: iso(newStart), endAt: iso(newEnd), expectedVersion: e3.version },
  });
  expect(response.ok(), 'Termin verschieben').toBe(true);

  await expect.poll(async () => (await tourViaApi(paul, tourT1)).planningStatus).toBe('stale');
  // Fahrer ist inzwischen wieder nahe Mainz (Standort erneut freigeben): wieder pünktlich ⇒
  // Incident wird aufgelöst, kein weiterer Push (Order §55).
  await fritzContext.setGeolocation(MAINZ_NEAR);
  await fritz.reload();
  await expect(fritz.getByTestId('active-tour-warnings')).toContainText(
    'Route veraltet – neu berechnen',
  );
  // Server-Rate-Limit (1 Update je 10 s je Tour) abwarten, sonst zählt der Client ein 429 als gesendet.
  await fritz.waitForTimeout(LOCATION_GAP_MS);
  await fritz.getByTestId('location-enable').click();
  await expect(fritz.getByTestId('location-active')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => liveLocations(tourT1)[0]?.latitude ?? 0, { timeout: 30_000 })
    .toBeCloseTo(MAINZ_NEAR.latitude, 3);
  await expect
    .poll(() => delayIncidents(tourT1).filter((row) => row.resolved_at === null).length, {
      timeout: 60_000,
    })
    .toBe(0);
  const risky = pushDeliveriesOfKind('tour_delay_risk');
  expect(risky.length).toBe(new Set(risky.map((row) => row.user_id)).size);
  await fritz.getByTestId('tour-recalculate').click();
  await expect
    .poll(async () => (await tourViaApi(paul, tourT1)).planningStatus, { timeout: 30_000 })
    .toBe('planned');
  // Warnbox verschwindet ganz, wenn keine Warnung mehr vorliegt – sonst ohne „veraltet“.
  await expect
    .poll(async () => {
      const box = fritz.getByTestId('active-tour-warnings');
      return (await box.count()) === 0 ? '' : await box.innerText();
    })
    .not.toContain('Route veraltet');
  // Nur die bewusste Verschiebung hat Zeiten geändert – keine Terminmutation durch die Tour.
  const after = appointmentRow(e3.id);
  expect(new Date(after.start_at!).getTime()).toBe(newStart.getTime());
  const e2 = appointmentRow(b('e2').outbound.id);
  expect(e2.version).toBe(e2Before.version);
  expect(e2.start_at).toBe(e2Before.start_at);
  const view = await tourViaApi(paul, tourT1);
  expect(stopOf(view, e3.id).plannedArrivalAt).not.toBeNull();
});

// ── J: Übernahme ─────────────────────────────────────────────────────────

test('J Takeover: atomar – offene Stopps wechseln, erledigte bleiben beim bisherigen Fahrer', async () => {
  test.setTimeout(120_000);
  // Erster Stopp fachlich abgeschlossen (wie Übergabe) ⇒ erledigt; nächster Stopp e2.
  completeAppointmentViaSeed(ADMIN_EMAIL, b('e1').outbound.id);
  let view = await tourViaApi(paul, tourT1);
  expect(stopOf(view, b('e1').outbound.id).state).toBe('done');
  expect(view.nextStop?.id).toBe(stopOf(view, b('e2').outbound.id).id);
  expect(liveLocations(tourT1)).toHaveLength(1);

  await zoe.goto(`/touren/aktiv?id=${tourT1}`);
  await expect(zoe.getByTestId('tour-takeover')).toBeVisible();
  await zoe.getByTestId('tour-takeover').click();
  await expect(zoe.getByTestId('takeover-dialog')).toBeVisible();
  await zoe.getByTestId('takeover-confirm').click();
  await expect(zoe.getByTestId('active-tour-notice')).toContainText('Du hast die Tour übernommen.');

  view = await tourViaApi(zoe, tourT1);
  expect(view.assignedUserId).toBe(userId('zoe'));
  expect(view.status).toBe('active');
  expect(appointmentRow(b('e2').outbound.id).assigned_user_id).toBe(userId('zoe'));
  expect(appointmentRow(b('e3').outbound.id).assigned_user_id).toBe(userId('zoe'));
  // Erledigter Stopp bleibt Historie des bisherigen Fahrers.
  expect(appointmentRow(b('e1').outbound.id).assigned_user_id).toBe(userId('fritz'));
  expect(appointmentRow(b('e1').outbound.id).status).toBe('completed');
  // Live-Standort des alten Fahrers ist weg; weitere Updates von Fritz werden neutral abgelehnt.
  expect(liveLocations(tourT1)).toHaveLength(0);
  const rejected = await fritz.request.post(`/api/staff/tours/${tourT1}/location`, {
    data: { latitude: 49.96, longitude: 8.27, observedAt: iso(new Date()) },
  });
  expect(rejected.status()).toBe(404);
  // Fritz hat keine aktive Tour mehr; Zoe bedient sie weiter.
  await fritz.goto('/touren/aktiv');
  await expect(fritz.getByTestId('no-active-tour')).toBeVisible();
  await expect(zoe.getByTestId('location-card')).toBeVisible();
});

// ── K: Vertretung ────────────────────────────────────────────────────────

test('K Substitution: Vertretung macht Fritz zum effektiven Tourfahrer – und fällt nach Ende zurück', async () => {
  test.setTimeout(120_000);
  const created = await erika.request.post('/api/staff/substitutions', {
    data: {
      originalUserId: userId('zoe'),
      substituteUserId: userId('fritz'),
      startsAt: iso(new Date(Date.now() - 60_000)),
      endsAt: iso(new Date(Date.now() + 2 * 3_600_000)),
    },
  });
  expect(created.ok(), 'Vertretung anlegen').toBe(true);
  const substitutionId = ((await created.json()) as { substitution: { id: string } }).substitution
    .id;

  let view = await tourViaApi(paul, tourT1);
  expect(view.assignedUserId).toBe(userId('zoe'));
  expect(view.substituted).toBe(true);
  expect(view.effectiveDriverId).toBe(userId('fritz'));

  // Fritz sieht die Tour als „seine“ aktive Tour inkl. Vertretungshinweis und darf Standort senden.
  await fritz.goto('/touren/aktiv');
  await expect(fritz.getByTestId('active-tour-page')).toBeVisible();
  await expect(fritz.getByTestId('active-tour-driver')).toContainText('Fahrer: Zoe Zweite');
  await expect(fritz.getByTestId('active-tour-driver')).toContainText('Vertretung: Fritz Fahrer');
  await expect(fritz.getByTestId('location-card')).toBeVisible();
  // Server-Rate-Limit (1 Update je 10 s je Tour) abwarten – ein zuvor angenommenes Update zählt.
  await fritz.waitForTimeout(LOCATION_GAP_MS);
  const accepted = await fritz.request.post(`/api/staff/tours/${tourT1}/location`, {
    data: { latitude: 49.96, longitude: 8.27, observedAt: iso(new Date()) },
  });
  expect(accepted.status(), await accepted.text()).toBe(204);
  expect(liveLocations(tourT1)[0]?.user_id).toBe(userId('fritz'));

  // Vertretung beenden ⇒ Zuständigkeit fällt an Zoe zurück.
  const ended = await erika.request.post(`/api/staff/substitutions/${substitutionId}/end`);
  expect(ended.ok(), 'Vertretung beenden').toBe(true);
  view = await tourViaApi(paul, tourT1);
  expect(view.substituted).toBe(false);
  expect(view.effectiveDriverId).toBe(userId('zoe'));
  await fritz.goto('/touren/aktiv');
  await expect(fritz.getByTestId('no-active-tour')).toBeVisible();
  const rejected = await fritz.request.post(`/api/staff/tours/${tourT1}/location`, {
    data: { latitude: 49.96, longitude: 8.27, observedAt: iso(new Date()) },
  });
  expect(rejected.status()).toBe(404);
});

// ── L: Kundenstatus „Unterwegs“ ──────────────────────────────────────────

test('L Customer Status: nächster Kundenstopp der aktiven Tour ist „Unterwegs“ – ohne GPS/ETA (API-geprüft)', async () => {
  test.setTimeout(120_000);
  // Kein Endpunkt (Order §56–§58): getCustomerTravelStatus über das Seed-Skript gegen die E2E-Datenbank.
  expect(travelStatusViaSeed(b('e2').bookingId)).toBe('en_route');
  expect(travelStatusViaSeed(b('e3').bookingId)).toBe('none');
  expect(travelStatusViaSeed(b('e1').bookingId)).toBe('none');
  expect(travelStatusViaSeed(b('a1').bookingId)).toBe('none');
  // Die Tour-View (auch für Planung) enthält keine Fahrerkoordinaten.
  const view = await tourViaApi(paul, tourT1);
  expect(view.liveLocation === null || !('latitude' in view.liveLocation)).toBe(true);
});

// ── M: Offline ───────────────────────────────────────────────────────────

test('M Offline: Arbeitspaket vorab geladen, Netz weg ⇒ Stoppliste + Navigation, Übergabe offline, Mutationen blockiert, Sync ⇒ Ende', async () => {
  test.setTimeout(420_000);
  tourT2 = await createTourViaUi(paul, userId('fritz'));
  await addCandidate(paul, b('m1').outbound.id);
  const m1 = b('m1');

  // Voraussetzungen der Übergabe online: Bestände erfasst, Maschine zugewiesen + vorbereitet.
  await ensureInitialStock(erika, 'sirup-kirsche', 'Sirup Kirsche', 20);
  await ensureInitialStock(erika, 'sirup-waldmeister', 'Sirup Waldmeister', 10);
  await ensureInitialStock(erika, 'strohhalme-25', 'Strohhalme (25 Stück)', 20);
  await ensureInitialStock(erika, 'becher-25', 'Becher (25 Stück)', 40);
  await assignAndPrepareOnline(fritz, m1.processId, 'MR-10-02-01');
  await fritz.goto(`/touren/${tourT2}`);
  await fritz.getByTestId('tour-start').click();
  await fritz.getByTestId('start-confirm').click();
  await fritz.waitForURL(new RegExp(`/touren/aktiv\\?id=${tourT2}`));
  await expect(fritz.getByTestId('active-tour-page')).toBeVisible();
  const view = await tourViaApi(fritz, tourT2);
  const m1Stop = stopOf(view, m1.outbound.id);

  // Service Worker + Arbeitspaket (inkl. Snapshot der aktiven Tour) vorab laden.
  await waitForOfflineReady(fritz);
  await fritz.reload();
  await fritz.goto('/touren/aktiv');
  await fritz.goto(`/vorgaenge/${m1.processId}/uebergabe`);
  await refreshPackage(fritz);

  await goOffline(fritz);
  await gotoOffline(fritz, '/touren/aktiv');
  await expect(fritz.getByTestId('active-tour-page')).toBeVisible({ timeout: 30_000 });
  await expect(fritz.getByTestId('active-tour-offline')).toBeVisible();
  const next = fritz.getByTestId('next-stop');
  await expect(next).toHaveAttribute('data-stop-id', m1Stop.id);
  await expect(next).toContainText(m1.processNumber);
  await expect(fritz.getByTestId('next-stop-address')).toContainText('Lieferweg 12');
  expectCleanNavigationHref(await fritz.getByTestId('navigation-start').getAttribute('href'), [
    'Mobil',
    'Mia',
  ]);
  // Mutationen offline blockiert: kein „Angekommen“, kein Beenden, kein Standort, kein Neuberechnen.
  await expect(fritz.getByTestId('stop-arrived')).toHaveCount(0);
  await expect(fritz.getByTestId('tour-end')).toHaveCount(0);
  await expect(fritz.getByTestId('tour-recalculate')).toHaveCount(0);
  await expect(fritz.getByTestId('location-enable')).toHaveCount(0);
  expect(liveLocations(tourT2)).toHaveLength(0);

  // Übergabe offline über den Phase-8-Flow (Stopp wird erst nach der Synchronisierung erledigt).
  await handoverWizardOffline(fritz, m1.processId);
  expect(appointmentRow(m1.outbound.id).status).toBe('scheduled');

  await goOnlineAndSync(fritz);
  await expect
    .poll(() => appointmentRow(m1.outbound.id).status, { timeout: 30_000 })
    .toBe('completed');
  await fritz.goto(`/touren/aktiv?id=${tourT2}`);
  await expect(fritz.getByTestId('next-stop-none')).toBeVisible();
  await expect(fritz.getByTestId(`finished-stop-${m1Stop.id}`)).toBeVisible();
  // Alle Stopps erledigt ⇒ normales Ende (Order §59).
  await fritz.getByTestId('tour-end').click();
  await fritz.getByTestId('end-confirm').click();
  await expect(fritz.getByTestId('active-tour-notice')).toContainText('Tour beendet.');
  expect(tourRow(tourT2).status).toBe('completed');
  expect(tourRow(tourT2).end_reason).toBeNull();
  expect(liveLocations(tourT2)).toHaveLength(0);
});

// ── N: Tourende ──────────────────────────────────────────────────────────

test('N Tour End: offene Stopps blockieren, Planer beendet mit Grund, Termine bleiben offen, Standort gelöscht', async () => {
  test.setTimeout(120_000);
  // Fahrerin ohne calendar.manage: nur die Meldung, kein „Trotzdem beenden“.
  await zoe.goto(`/touren/aktiv?id=${tourT1}`);
  await zoe.getByTestId('tour-end').click();
  await zoe.getByTestId('end-confirm').click();
  await expect(zoe.getByTestId('active-tour-error')).toHaveText(
    'Die Tour enthält noch offene Stopps.',
  );
  await expect(zoe.getByTestId('force-end-dialog')).toHaveCount(0);
  expect(tourRow(tourT1).status).toBe('active');

  // Planer: Beenden ⇒ 409 ⇒ Dialog mit Pflichtgrund ⇒ „Trotzdem beenden“.
  await paul.goto(`/touren/aktiv?id=${tourT1}`);
  await paul.getByTestId('tour-end').click();
  await paul.getByTestId('end-confirm').click();
  await expect(paul.getByTestId('active-tour-error')).toHaveText(
    'Die Tour enthält noch offene Stopps.',
  );
  const dialog = paul.getByTestId('force-end-dialog');
  await expect(dialog).toBeVisible();
  await expect(paul.getByTestId('force-end-confirm')).toBeDisabled();
  await paul.getByTestId('tour-end-reason').fill('Fahrzeugausfall – Rest wird morgen neu geplant');
  await paul.getByTestId('force-end-confirm').click();
  await expect(paul.getByTestId('active-tour-notice')).toContainText('Tour beendet.');

  const tour = tourRow(tourT1);
  expect(tour.status).toBe('completed');
  expect(tour.ended_at).not.toBeNull();
  expect(tour.end_reason).toContain('Fahrzeugausfall');
  // Offene Termine bleiben geplant (nicht abgeschlossen), Live-Standort gelöscht, Incidents geschlossen.
  expect(appointmentRow(b('e2').outbound.id).status).toBe('scheduled');
  expect(appointmentRow(b('e3').outbound.id).status).toBe('scheduled');
  expect(liveLocations(tourT1)).toHaveLength(0);
  expect(delayIncidents(tourT1).every((row) => row.resolved_at !== null)).toBe(true);
  const rejected = await zoe.request.post(`/api/staff/tours/${tourT1}/location`, {
    data: { latitude: 49.96, longitude: 8.27, observedAt: iso(new Date()) },
  });
  expect(rejected.status()).toBe(404);
  await paul.goto(`/touren/${tourT1}`);
  await expect(paul.getByTestId('tour-completed')).toContainText('Grund: Fahrzeugausfall');
  // Beendete Tour gibt ihre offenen Stopps frei (Order §121): wieder als Kandidaten verfügbar.
  await createTourViaUi(paul, userId('zoe'));
  await expect(paul.getByTestId(`candidate-add-${b('e2').outbound.id}`)).toBeVisible();
  await expect(paul.getByTestId(`candidate-add-${b('e3').outbound.id}`)).toBeVisible();
  await expect(paul.getByTestId(`candidate-add-${b('e1').outbound.id}`)).toHaveCount(0);
});
