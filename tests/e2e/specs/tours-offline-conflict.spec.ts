/**
 * Phase 13 Corr (§3/§5/§6/§7/§8) – Mehrere aktive Touren OFFLINE (Projekt `chromium`).
 *
 * Konflikt wie Szenario K/Multi-Tour: Fritz startet Tour A, Zoe startet Tour B,
 * danach Vertretung Zoe→Fritz ⇒ Fritz ist effektiv für BEIDE Touren zuständig.
 * Das Arbeitspaket enthält dann `activeTours: [A, B]` (nie still nur die erste).
 *
 * M6  Offline-UI zeigt den Konflikt („Mehrere aktive Touren gleichzeitig – Planung
 *     prüfen.“) mit Auswahl beider Touren – KEIN automatisches Umschalten.
 * M7  Offline-UI öffnet Tour A (`/touren/aktiv?id=<A>`), read-only.
 * M8  Offline-UI öffnet Tour B, read-only.
 * M9  Navigationslinks beider Touren offline vorhanden – ohne Key, ohne Kundenname.
 * M16 Altes Paket (`activeTour` statt `activeTours`) wird robust als EINE Tour
 *     gelesen; `activeTour: null` ⇒ keine Tour; danach kanonische Form wieder Konflikt.
 * M17 Offline keine Tourmutation (kein Angekommen/Beenden/Neuberechnen/Standort).
 *
 * Hinweis zu M16: Das Paket liegt AES-GCM-verschlüsselt (DEK nur im Seitenspeicher)
 * in IndexedDB – ein direktes Umschreiben des Stores ist aus dem Test nicht
 * möglich. Stattdessen wird die Serverantwort von POST /api/staff/offline/package
 * in der Seite (fetch-Umhüllung) auf die ALTE Form umgeschrieben; der Client
 * speichert das Paket unverändert (keine Rückübersetzung) ⇒ im Store liegt ein
 * echtes Alt-Format-Paket, das der Lesepfad normalisiert.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { ROUTING_FAKE_API_KEY } from '../fakes/constants.ts';
import { resetRoutingFake } from '../helpers/routing.ts';
import { ADMIN_EMAIL, ADMIN_PASSWORD, resetE2eDatabase } from '../helpers/seed.ts';
import {
  liveLocations,
  loginStaff,
  seedTours,
  stopOf,
  todayPlusMinutes,
  tourRow,
  tourViaApi,
  type SeededBooking,
  type ToursSeedResult,
} from '../helpers/tours.ts';

test.describe.configure({ mode: 'serial' });

const PAUL = { email: 'paul.planer@e2e.example', password: 'e2e-paul-passwort-1' };
const FRITZ = { email: 'fritz.fahrer@e2e.example', password: 'e2e-fritz-passwort-1' };
const ZOE = { email: 'zoe.zweite@e2e.example', password: 'e2e-zoe-passwort-1' };

let erika: Page; // Admin (Vertretung anlegen/beenden)
let paul: Page; // Planer
let fritzContext: BrowserContext; // „Gerät“ des Fahrers: Service Worker, Offline
let fritz: Page; // Fahrer A (wird per Vertretung auch für B zuständig)
let zoe: Page; // Fahrerin B

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
let tourB = '';
let stopA = '';
let stopB = '';
let substitutionId = '';
const navigationHrefs: Record<string, string> = {};

const iso = (date: Date) => date.toISOString();

test.beforeAll(async ({ browser }) => {
  resetE2eDatabase();
  await resetRoutingFake();
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
        permissions: ['calendar.view', 'process.view_all'],
      },
      {
        key: 'zoe',
        firstName: 'Zoe',
        lastName: 'Zweite',
        email: ZOE.email,
        password: ZOE.password,
        permissions: ['calendar.view', 'process.view_all'],
      },
    ],
    bookings: [
      // Tour A (Fritz): Lieferung am Lieferweg
      {
        key: 'o1',
        customer: { firstName: 'Olga', lastName: 'Offline' },
        outbound: { startAt: t(60), endAt: t(120) },
      },
      // Tour B (Zoe): Lieferung „Am Markt“ – anderer Navigationslink als Tour A
      {
        key: 'o2',
        customer: { firstName: 'Otto', lastName: 'Ortswechsel' },
        address: { street: 'Am Markt 1', postalCode: '55116', city: 'Mainz' },
        outbound: { startAt: t(90), endAt: t(150) },
      },
    ],
  });

  erika = await browser.newPage();
  paul = await browser.newPage();
  zoe = await browser.newPage();
  fritzContext = await browser.newContext();
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

// ── Helfer (Muster tours-flow.spec.ts / offline-flow.spec.ts) ────────────

async function createTourViaUi(page: Page, driverId: string): Promise<string> {
  await page.goto('/touren/neu');
  await expect(page.getByTestId('tour-new-form')).toBeVisible();
  await page.getByTestId('tour-new-driver').selectOption(driverId);
  await page.getByTestId('tour-new-submit').click();
  await page.waitForURL(/\/touren\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('tour-header')).toBeVisible();
  return /\/touren\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
}

async function addCandidate(page: Page, appointmentId: string) {
  await page.getByTestId(`candidate-add-${appointmentId}`).click();
  await expect(
    page.locator(`[data-testid^="tour-stop-"][data-appointment-id="${appointmentId}"]`),
  ).toBeVisible();
}

/** Fahrer startet die eigene Tour bewusst über den Dialog. */
async function startTourViaUi(page: Page, tourId: string) {
  await page.goto(`/touren/${tourId}`);
  await expect(page.getByTestId('tour-start')).toBeVisible();
  await page.getByTestId('tour-start').click();
  await expect(page.getByTestId('start-dialog')).toBeVisible();
  await page.getByTestId('start-confirm').click();
  await page.waitForURL(new RegExp(`/touren/aktiv\\?id=${tourId}`));
  await expect(page.getByTestId('active-tour-page')).toBeVisible();
  expect(tourRow(tourId).status).toBe('active');
}

/** Navigationslink: nur Ziel – nie API-Key, nie Kundenname. */
function expectCleanNavigationHref(href: string | null, forbidden: readonly string[]) {
  expect(href, 'Navigationslink').not.toBeNull();
  expect(href!).toMatch(/^(https:\/\/|geo:)/);
  expect(href!).not.toContain(ROUTING_FAKE_API_KEY);
  expect(href!.toLowerCase()).not.toContain('key=');
  for (const word of forbidden) expect(href!).not.toContain(word);
}

const FORBIDDEN_IN_LINKS = ['Olga', 'Offline', 'Otto', 'Ortswechsel'] as const;

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

async function goOnline(page: Page) {
  await page.context().setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'online',
    { timeout: 30_000 },
  );
}

/** Offline-Navigation: harte Navigation, der Service Worker liefert die gecachte Seite. */
async function gotoOffline(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'commit' });
}

/** M17: offline keine Tourmutation und kein GPS. */
async function expectNoMutations(page: Page, tourId: string) {
  await expect(page.getByTestId('stop-arrived')).toHaveCount(0);
  await expect(page.getByTestId('tour-end')).toHaveCount(0);
  await expect(page.getByTestId('tour-recalculate')).toHaveCount(0);
  await expect(page.getByTestId('tour-takeover')).toHaveCount(0);
  await expect(page.getByTestId('location-enable')).toHaveCount(0);
  await expect(page.getByTestId('location-card')).toHaveCount(0);
  expect(liveLocations(tourId)).toHaveLength(0);
}

/**
 * Paketabruf mit Antwort im ALTEN Format (`activeTour` statt `activeTours`):
 * `window.fetch` wird NUR für diesen Abruf in der Seite umhüllt (der Service
 * Worker fasst /api/* nie an; die Laufzeit nutzt das globale `fetch`). Der
 * Client speichert das Paket unverändert ⇒ im Store liegt ein Alt-Format-Paket.
 * Liefert die Anzahl umgeschriebener Antworten und die kanonische Tourzahl des
 * Servers; der anschließende Reload entfernt die Umhüllung wieder.
 */
async function refreshPackageAsLegacy(
  page: Page,
  mode: 'first' | 'null',
): Promise<{ rewritten: number; serverTours: number }> {
  await page.goto('/sync');
  await page.evaluate((legacyMode) => {
    const w = window as unknown as { __legacyPkg?: { rewritten: number; serverTours: number } };
    w.__legacyPkg = { rewritten: 0, serverTours: -1 };
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes('/api/staff/offline/package') || !response.ok) return response;
      const pkg = (await response.json()) as Record<string, unknown> & { activeTours?: unknown[] };
      const tours = Array.isArray(pkg.activeTours) ? pkg.activeTours : [];
      const { activeTours: _dropped, ...rest } = pkg;
      void _dropped;
      w.__legacyPkg!.serverTours = tours.length;
      w.__legacyPkg!.rewritten += 1;
      const legacy = { ...rest, activeTour: legacyMode === 'first' ? (tours[0] ?? null) : null };
      return new Response(JSON.stringify(legacy), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    };
  }, mode);
  await page.getByTestId('package-refresh').click();
  await expect(page.getByText('Arbeitspaket aktualisiert.')).toBeVisible({ timeout: 30_000 });
  const seen = await page.evaluate(
    () =>
      (window as unknown as { __legacyPkg: { rewritten: number; serverTours: number } })
        .__legacyPkg,
  );
  await page.reload(); // Umhüllung entfernen
  return seen;
}

// ── Konflikt aufbauen + M6 ───────────────────────────────────────────────

test('M6 Offline-UI zeigt Konflikt: zwei aktive Touren derselben effektiven Person – Hinweis + Auswahl, kein automatisches Umschalten', async () => {
  test.setTimeout(240_000);
  tourA = await createTourViaUi(paul, userId('fritz'));
  await addCandidate(paul, b('o1').outbound.id);
  tourB = await createTourViaUi(paul, userId('zoe'));
  await addCandidate(paul, b('o2').outbound.id);

  await startTourViaUi(fritz, tourA);
  await startTourViaUi(zoe, tourB);
  stopA = stopOf(await tourViaApi(fritz, tourA), b('o1').outbound.id).id;
  stopB = stopOf(await tourViaApi(zoe, tourB), b('o2').outbound.id).id;

  // Vertretung Zoe→Fritz ⇒ Fritz effektiv für A UND B (Planungskonflikt, Order §6).
  const created = await erika.request.post('/api/staff/substitutions', {
    data: {
      originalUserId: userId('zoe'),
      substituteUserId: userId('fritz'),
      startsAt: iso(new Date(Date.now() - 60_000)),
      endsAt: iso(new Date(Date.now() + 2 * 3_600_000)),
    },
  });
  expect(created.ok(), 'Vertretung anlegen').toBe(true);
  substitutionId = ((await created.json()) as { substitution: { id: string } }).substitution.id;

  // Online: Konflikt sichtbar, keine Tour beendet/übertragen (M14-Gegenprobe aus Fahrersicht).
  const active = await fritz.request.get('/api/staff/tours/active');
  expect(active.ok()).toBe(true);
  const activeJson = (await active.json()) as {
    tour: { id: string } | null;
    conflict: { tours: { id: string }[] } | null;
  };
  expect(activeJson.conflict, 'conflict online').not.toBeNull();
  expect(activeJson.conflict!.tours.map((t) => t.id).sort()).toEqual([tourA, tourB].sort());
  expect(tourRow(tourA).status).toBe('active');
  expect(tourRow(tourB).status).toBe('active');

  // Service Worker + Arbeitspaket (beide aktive Touren) vorab laden.
  await waitForOfflineReady(fritz);
  await fritz.reload();
  await fritz.goto('/touren/aktiv');
  await expect(fritz.getByTestId('active-tour-conflict')).toBeVisible();
  await refreshPackage(fritz);

  await goOffline(fritz);
  await gotoOffline(fritz, '/touren/aktiv');
  const conflict = fritz.getByTestId('offline-tour-conflict');
  await expect(conflict).toBeVisible({ timeout: 30_000 });
  await expect(conflict).toContainText('Mehrere aktive Touren gleichzeitig – Planung prüfen.');
  await expect(fritz.getByTestId('active-tour-offline')).toBeVisible();
  await expect(fritz.getByTestId(`offline-tour-choice-${tourA}`)).toHaveAttribute(
    'href',
    `/touren/aktiv?id=${tourA}`,
  );
  await expect(fritz.getByTestId(`offline-tour-choice-${tourB}`)).toHaveAttribute(
    'href',
    `/touren/aktiv?id=${tourB}`,
  );
  // Kein automatisches Umschalten: ohne ?id= wird KEINE Tour (auch nicht die zuerst gestartete) gezeigt.
  await expect(fritz.getByTestId('next-stop')).toHaveCount(0);
  await expect(fritz.getByTestId('next-stop-none')).toHaveCount(0);
  await expect(fritz.getByTestId('remaining-stops')).toHaveCount(0);
  await expect(fritz.getByTestId('no-active-tour')).toHaveCount(0);
  await expect(fritz.getByTestId('active-tour-conflict')).toHaveCount(0); // nur Online-Variante
  await expectNoMutations(fritz, tourA);
});

// ── M7 / M8: beide Touren offline lesbar ─────────────────────────────────

test('M7 Offline-UI öffnet Tour A über die Auswahl – read-only, Konflikt bleibt sichtbar', async () => {
  test.setTimeout(120_000);
  await fritz.getByTestId(`offline-tour-choice-${tourA}`).click();
  await fritz.waitForURL(new RegExp(`/touren/aktiv\\?id=${tourA}$`));
  await expect(fritz.getByTestId('active-tour-page')).toBeVisible({ timeout: 30_000 });
  await expect(fritz.getByTestId('active-tour-offline')).toBeVisible();
  await expect(fritz.getByTestId('offline-tour-conflict')).toBeVisible();
  await expect(fritz.getByTestId(`offline-tour-choice-${tourA}`)).toHaveAttribute(
    'aria-current',
    'page',
  );
  const next = fritz.getByTestId('next-stop');
  await expect(next).toHaveAttribute('data-stop-id', stopA);
  await expect(next).toContainText(b('o1').processNumber);
  await expect(next).not.toContainText(b('o2').processNumber);
  await expect(fritz.getByTestId('next-stop-address')).toContainText('Lieferweg 12');
  const href = await fritz.getByTestId('navigation-start').getAttribute('href');
  expectCleanNavigationHref(href, FORBIDDEN_IN_LINKS);
  navigationHrefs[tourA] = href!;
  await expectNoMutations(fritz, tourA);
});

test('M8 Offline-UI öffnet Tour B – read-only, andere Stoppliste', async () => {
  test.setTimeout(120_000);
  await gotoOffline(fritz, `/touren/aktiv?id=${tourB}`);
  await expect(fritz.getByTestId('active-tour-page')).toBeVisible({ timeout: 30_000 });
  await expect(fritz.getByTestId('active-tour-offline')).toBeVisible();
  await expect(fritz.getByTestId('offline-tour-conflict')).toBeVisible();
  await expect(fritz.getByTestId(`offline-tour-choice-${tourB}`)).toHaveAttribute(
    'aria-current',
    'page',
  );
  const next = fritz.getByTestId('next-stop');
  await expect(next).toHaveAttribute('data-stop-id', stopB);
  await expect(next).toContainText(b('o2').processNumber);
  await expect(next).not.toContainText(b('o1').processNumber);
  await expect(fritz.getByTestId('next-stop-address')).toContainText('Am Markt 1');
  const href = await fritz.getByTestId('navigation-start').getAttribute('href');
  expectCleanNavigationHref(href, FORBIDDEN_IN_LINKS);
  navigationHrefs[tourB] = href!;
  await expectNoMutations(fritz, tourB);
});

// ── M9: Navigation beider Touren ─────────────────────────────────────────

test('M9 Navigationslinks beider Touren offline vorhanden – nur Ziel, ohne Key und Kundenname', async () => {
  test.setTimeout(120_000);
  expect(navigationHrefs[tourA], 'Link Tour A').toBeDefined();
  expect(navigationHrefs[tourB], 'Link Tour B').toBeDefined();
  expect(navigationHrefs[tourA]).not.toBe(navigationHrefs[tourB]);
  expect(decodeURIComponent(navigationHrefs[tourA]!)).toContain('Lieferweg');
  expect(decodeURIComponent(navigationHrefs[tourB]!)).toContain('Am Markt');
  for (const href of Object.values(navigationHrefs)) {
    expectCleanNavigationHref(href, FORBIDDEN_IN_LINKS);
    expect(href).not.toContain(b('o1').processNumber);
    expect(href).not.toContain(b('o2').processNumber);
  }
  // Tour A erneut (harte Navigation) – Link weiterhin da; Tour nicht verändert.
  await gotoOffline(fritz, `/touren/aktiv?id=${tourA}`);
  await expect(fritz.getByTestId('navigation-start')).toHaveAttribute(
    'href',
    navigationHrefs[tourA]!,
    { timeout: 30_000 },
  );
  expect(tourRow(tourA).status).toBe('active');
  expect(tourRow(tourB).status).toBe('active');
});

// ── M16: altes Paketformat ───────────────────────────────────────────────

test('M16 Altes Paket mit activeTour (statt activeTours) wird robust als eine Tour gelesen; null ⇒ keine Tour; kanonisch ⇒ Konflikt', async () => {
  test.setTimeout(240_000);
  await goOnline(fritz);

  // Alt-Format mit genau einer Tour (so schrieb der Server vor der Korrektur).
  const legacyFirst = await refreshPackageAsLegacy(fritz, 'first');
  expect(legacyFirst.rewritten).toBe(1);
  expect(legacyFirst.serverTours, 'Server liefert weiterhin beide Touren').toBe(2);

  await goOffline(fritz);
  await gotoOffline(fritz, '/touren/aktiv');
  await expect(fritz.getByTestId('active-tour-page')).toBeVisible({ timeout: 30_000 });
  await expect(fritz.getByTestId('active-tour-offline')).toBeVisible();
  await expect(fritz.getByTestId('offline-tour-conflict')).toHaveCount(0);
  await expect(fritz.getByTestId('next-stop')).toHaveAttribute('data-stop-id', stopA);
  expectCleanNavigationHref(
    await fritz.getByTestId('navigation-start').getAttribute('href'),
    FORBIDDEN_IN_LINKS,
  );
  await expectNoMutations(fritz, tourA);

  // Alt-Format ohne Tour (`activeTour: null`) ⇒ „Offline ist keine aktive Tour gespeichert.“
  await goOnline(fritz);
  const legacyNull = await refreshPackageAsLegacy(fritz, 'null');
  expect(legacyNull.rewritten).toBe(1);
  expect(legacyNull.serverTours).toBe(2);
  await goOffline(fritz);
  await gotoOffline(fritz, '/touren/aktiv');
  await expect(fritz.getByTestId('no-active-tour')).toContainText(
    'Offline ist keine aktive Tour gespeichert.',
    { timeout: 30_000 },
  );
  await expect(fritz.getByTestId('offline-tour-conflict')).toHaveCount(0);

  // Kanonisches Serverpaket (ohne Umschreibung) ⇒ Konflikt wieder vollständig sichtbar.
  await goOnline(fritz);
  await refreshPackage(fritz);
  await goOffline(fritz);
  await gotoOffline(fritz, '/touren/aktiv');
  await expect(fritz.getByTestId('offline-tour-conflict')).toBeVisible({ timeout: 30_000 });
  await expect(fritz.getByTestId(`offline-tour-choice-${tourA}`)).toBeVisible();
  await expect(fritz.getByTestId(`offline-tour-choice-${tourB}`)).toBeVisible();

  // Aufräumen: online, Vertretung beenden ⇒ Konflikt gelöst (Planung löst online, Order §6).
  await goOnline(fritz);
  const ended = await erika.request.post(`/api/staff/substitutions/${substitutionId}/end`);
  expect(ended.ok(), 'Vertretung beenden').toBe(true);
  const active = await fritz.request.get('/api/staff/tours/active');
  const activeJson = (await active.json()) as {
    tour: { id: string } | null;
    conflict: unknown;
  };
  expect(activeJson.conflict).toBeNull();
  expect(activeJson.tour?.id).toBe(tourA);
  expect(tourRow(tourA).status).toBe('active');
  expect(tourRow(tourB).status).toBe('active');
});
