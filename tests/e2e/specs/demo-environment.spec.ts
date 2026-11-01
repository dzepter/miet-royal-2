/**
 * Phase-14-E2E-Szenarien der Demo-Umgebung (Order §109: A Demo Banner,
 * C Demo Reset, Q Live↔Demo-Wechsel; Order §§5, 6, 8, 14–18, 20, §31;
 * Design §§3–7). Die Teilszenarien D1–D7 stammen aus Phase-14-Teil 1 und
 * bleiben als Feinbezeichnung erhalten; B/D–P liegen in training-demo.spec.ts:
 *
 * - A/D1 Demo-Kennzeichnung (Badge auf Login + in jedem Header genau einmal,
 *   Dokumenttitel „DEMO · “, fester Banner der Demo-Web-Instanz)
 * - Q/D2 Live↔Demo-Wechsel („Live öffnen“ nur mit STAFF_LIVE_URL, Dialog, neues
 *   Fenster exakt `<origin>/login` ohne Session/IDs/Query, Abbrechen ⇒ nichts)
 * - C/D3 Einstellungen → Demo nur mit demo.manage; Status; „veraltet“-Hinweis
 * - C/D4 Reset-Dialog mit Pflichteingabe „DEMO ZURÜCKSETZEN“, Reset, Status,
 *   kanonischer Datensatz in der DB, Security-Events `demo.reset_started` +
 *   `demo.reset_completed` (nur Meta-Details), Admin bleibt angemeldet
 * - C/D5 503-Gate während `reset_in_progress` (Mutation 503 DEMO_RESET, GET/auth ok)
 * - C/D6 Seed-Nützlichkeit (Registry inkl. `voucher.situation`, Heute/Touren/
 *   Kalender, nur Beispieldomains, keine Mail verlässt die Whitelist)
 * - C/D7 Reset löscht keine Staff-/Trainingsdaten (zweiter Mitarbeiter mit
 *   Rolle, Sessions, bekannte Geräte bleiben)
 *
 * Projekt `demo-communication` (playwright.config.ts): Demo-API (APP_ENV=demo,
 * Port 3106, eigene Datenbank `mietroyal_test_demo`, STAFF_LIVE_URL gesetzt),
 * Demo-Staff-Instanz (next dev, Port 3107 = baseURL) und Demo-Web-Instanz
 * (WEB_APP_ENV=demo, Port 3108). Der Live-Gegentest (kein Badge, kein Wechsel-
 * Button ohne STAFF_DEMO_URL, keine Demo-Routen, kein Web-Banner) läuft im
 * Projekt `chromium` gegen Haupt-API/-Staff/-Web (development); die Demo-Tests
 * überspringen sich dort und der Gegentest im Demo-Projekt.
 *
 * Fakten aus der Demo-Datenbank liest die Spec direkt (queryDatabase); der
 * zweite Mitarbeiter entsteht über den bestehenden Seed-Weg
 * (apps/api/scripts/e2e-tours-seed.ts, createStaffWithPermissions). Der Reset
 * selbst läuft ausschließlich über die Staff-UI (Dialog ⇒ POST /staff/demo/reset).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { queryDatabase } from '../helpers/communication-ops.ts';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  DEMO_API_ORIGIN,
  DEMO_DATABASE_URL,
  DEMO_LIVE_URL,
  DEMO_MAIL_WHITELIST,
  DEMO_STAFF_ORIGIN,
  DEMO_TRAINEE_EMAIL,
  DEMO_TRAINEE_PASSWORD,
  DEMO_WEB_ORIGIN,
} from '../helpers/demo-env.ts';
import { clearSink, sinkMails } from '../helpers/mail.ts';
import { ADMIN_EMAIL, ADMIN_PASSWORD, resetE2eDatabase, WEB_ORIGIN } from '../helpers/seed.ts';
import { berlinTodayIso, gotoCalendarDay, login } from '../helpers/settlement.ts';
import { seedTours } from '../helpers/tours.ts';

test.describe.configure({ mode: 'serial' });

const DEMO_PROJECT = 'demo-communication';
const LIVE_PROJECT = 'chromium';

/** Texte der Staff-UI (apps/staff/lib/demo.ts, lib/api.ts) und der API (demo/types.ts). */
const BADGE_TEXT = 'DEMO – keine echten Kundendaten';
const TITLE_PREFIX = /^DEMO · /;
const RESET_CONFIRMATION = 'DEMO ZURÜCKSETZEN';
const RESET_GATE_MESSAGE =
  'Die Demo-Umgebung wird gerade zurückgesetzt. Bitte in einer Minute erneut versuchen.';
const OUTDATED_TEXT = 'Demo-Datenstand ist veraltet – Zurücksetzen empfohlen.';
const EXPECTED_DATASET_VERSION = 1;

/**
 * Pflicht-Szenarien (Order §10) – Kopie von REQUIRED_DEMO_SEED_KEYS
 * (apps/api/src/demo/seed/data.ts) inkl. `voucher.situation` (seit W1.1 ein
 * synthetischer Fixture-Gutschein des Wiedermieters ohne Buchhaltungstransfer).
 */
const REQUIRED_SEED_KEYS = [
  'customer.private.basic',
  'customer.org.basic',
  'customer.private.repeat',
  'process.inquiry.new',
  'process.offer.draft',
  'process.offer.sent',
  'process.booking.accepted.pickup',
  'process.booking.accepted.delivery',
  'process.handover.ready',
  'process.rental.active',
  'process.return.due',
  'process.return.overdue',
  'process.return.damage',
  'process.return.missing_part',
  'process.cleaning.pending',
  'process.settlement.review',
  'process.completed',
  'process.repeat.second',
  'appointment.return.planned',
  'appointment.return.due_today',
  'appointment.return.overdue',
  'conversation.email.inbound',
  'conversation.email.reply',
  'tour.today.multi_stop',
  'tour.future.planned',
  'inventory.stocktake.initial',
  'inventory.movement.incoming',
  'inventory.item.low_stock',
  'machine.ready.basic',
  'machine.assigned',
  'machine.reserved',
  'machine.rented',
  'machine.cleaning',
  'machine.blocked',
  'voucher.situation',
] as const;

const TRAINEE_PERMISSIONS = [
  'system.settings',
  'calendar.view',
  'customer.view',
  'process.view_all',
];

// ── Helfer ─────────────────────────────────────────────────────────────

function demoDb<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return queryDatabase<T>(DEMO_DATABASE_URL, sql, params);
}

interface ApiResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

/** Direkter Aufruf der Demo-API (Node-fetch) – das Demo-Cookie ist `Secure` und wird explizit mitgegeben. */
async function demoApi<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${DEMO_API_ORIGIN}${path}`, {
    method,
    headers: {
      connection: 'close',
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: response.status, data: data as T, headers: response.headers };
}

/** API-Login (eigene Session) – liefert das Session-Cookie `name=value`. */
async function apiLogin(email: string, password: string): Promise<string> {
  const response = await fetch(`${DEMO_API_ORIGIN}/auth/login`, {
    method: 'POST',
    headers: { connection: 'close', 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status, `API-Login ${email}`).toBe(200);
  const match = /(__Host-)?mr_staff_session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '');
  expect(match, 'Demo-Session-Cookie').not.toBeNull();
  return `${match![1] ?? ''}mr_staff_session=${match![2]}`;
}

interface DemoStatus {
  environment: string;
  datasetVersion: number | null;
  expectedDatasetVersion: number;
  outdated: boolean;
  outdatedHint: string | null;
  seededAt: string | null;
  seededBy: { id: string; name: string } | null;
  lastResetAt: string | null;
  lastResetBy: { id: string; name: string } | null;
  resetInProgress: boolean;
  resetStartedAt: string | null;
  resetStale: boolean;
  counts: { customers: number; processes: number; tours: number };
  seedEntities: number;
  /** Phase 14 (reset, Order §22): Nachbereinigung alter Demo-Dateien (Jobs pending/dead). */
  storageCleanup: { pendingJobs: number; deadJobs: number };
}

async function demoStatus(cookie: string): Promise<DemoStatus> {
  const result = await demoApi<DemoStatus>('GET', '/staff/demo/status', { cookie });
  expect(result.status, 'GET /staff/demo/status').toBe(200);
  return result.data;
}

/** Harmlose Business-Mutation (legt nichts an): Dublettenprüfung. */
function duplicateCheck(cookie: string) {
  return demoApi<{ error?: { code: string; message: string } }>(
    'POST',
    '/staff/customers/duplicate-check',
    { cookie, body: { type: 'private', firstName: 'Gate', lastName: 'Prüfung' } },
  );
}

/** Genau ein Header-Badge mit vollem Text im Markup und Titel-Präfix (Design §3). */
async function expectDemoHeader(page: Page, heading: string) {
  await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  const badge = page.getByTestId('demo-badge');
  await expect(badge).toHaveCount(1);
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText(BADGE_TEXT);
  await expect(badge).toHaveAttribute('aria-label', BADGE_TEXT);
  await expect(page.locator('header').getByTestId('demo-badge')).toHaveCount(1);
  await expect(page).toHaveTitle(TITLE_PREFIX);
}

async function loginDemoAdmin(page: Page) {
  await login(page, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, 'Dana');
}

/**
 * `GET /api/auth/me` aus dem Browserkontext der Seite: Das Demo-Session-Cookie
 * ist `Secure` – Chromium sendet es auf http://127.0.0.1 (vertrauenswürdiger
 * Loopback), Playwrights `page.request` dagegen nicht. Für die Frage „ist der
 * Browser noch angemeldet?“ zählt der Browser.
 */
async function browserAuthMe(page: Page): Promise<{ status: number; data: unknown }> {
  return page.evaluate(async () => {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status: response.status, data };
  });
}

interface StaffSnapshot {
  userIds: string[];
  roleIds: string[];
  userRoles: string[];
  rolePermissions: string[];
  sessionIds: string[];
  deviceIds: string[];
  pushSubscriptions: number;
}

/** Staff-/Geräte-/Session-Bestand (Order §18) – IDs, damit spätere Logins den Vergleich nicht stören. */
function staffSnapshot(): StaffSnapshot {
  const ids = (sql: string) =>
    demoDb<{ id: string }>(sql)
      .map((row) => row.id)
      .sort();
  return {
    userIds: ids('SELECT id FROM staff_users'),
    roleIds: ids('SELECT id FROM staff_roles'),
    userRoles: ids("SELECT user_id || ':' || role_id AS id FROM staff_user_roles"),
    rolePermissions: ids(
      "SELECT role_id || ':' || permission_key AS id FROM staff_role_permissions",
    ),
    sessionIds: ids('SELECT id FROM staff_sessions WHERE revoked_at IS NULL'),
    deviceIds: ids('SELECT id FROM staff_known_devices'),
    pushSubscriptions: Number(
      demoDb<{ n: string }>('SELECT count(*)::text AS n FROM push_subscriptions')[0]!.n,
    ),
  };
}

function berlinYear(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric' }).format(
    new Date(),
  );
}

// ── Zustand über die seriellen Tests hinweg ───────────────────────────

let adminCookie = '';
let adminId = '';
let traineeId = '';
let traineeCookie = '';
let traineeContext: BrowserContext | null = null;
let outdatedSeededAt = '';
let staffBefore: StaffSnapshot | null = null;
let securityEventsBefore = 0;

test.describe('Demo-Umgebung (Projekt demo-communication)', () => {
  test.skip(
    () => test.info().project.name !== DEMO_PROJECT,
    'Demo-Szenarien laufen nur gegen die Demo-API/-Staff-Instanz (Projekt demo-communication).',
  );

  test.beforeAll(async () => {
    await clearSink();
    const health = await demoApi<{ environment: string }>('GET', '/health');
    expect(health.data.environment).toBe('demo');
    adminCookie = await apiLogin(DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD);
    const admin = demoDb<{ id: string }>(
      'SELECT id FROM staff_users WHERE lower(email) = lower($1)',
      [DEMO_ADMIN_EMAIL],
    );
    expect(admin).toHaveLength(1);
    adminId = admin[0]!.id;
  });

  test.afterAll(async () => {
    await traineeContext?.close();
  });

  test('A/D1 Demo-Kennzeichnung: Badge „DEMO – keine echten Kundendaten“ auf der Login-Seite und genau einmal im Header (Heute/Vorgänge/Einstellungen), Dokumenttitel „DEMO · “, fester Banner der Demo-Web-Instanz', async ({
    page,
  }) => {
    await page.goto('/login');
    const badge = page.getByTestId('demo-badge');
    await expect(badge).toHaveCount(1);
    await expect(badge).toBeVisible();
    // Text Pflicht (nicht nur Farbe): voller Text im Markup + aria-label, kompakt bleibt „DEMO“.
    await expect(badge).toHaveText(BADGE_TEXT);
    await expect(badge).toHaveAttribute('aria-label', BADGE_TEXT);
    await expect(badge).toHaveAttribute('role', 'status');
    await expect(badge).toContainText('DEMO');
    await expect(page).toHaveTitle(TITLE_PREFIX);

    await loginDemoAdmin(page);
    await expectDemoHeader(page, 'Heute');
    await page.goto('/vorgaenge');
    await expectDemoHeader(page, 'Vorgänge');
    await page.goto('/einstellungen');
    await expectDemoHeader(page, 'Einstellungen');
    // Client-seitiger Seitenwechsel: Badge bleibt genau einmal, Titel-Präfix bleibt.
    await page.getByRole('link', { name: 'Heute', exact: true }).click();
    await expectDemoHeader(page, 'Heute');

    // Öffentliche Demo-Web-Instanz (WEB_APP_ENV=demo): Banner auf jeder Seite, Text im Markup.
    await page.goto(`${DEMO_WEB_ORIGIN}/`);
    const banner = page.getByTestId('demo-banner');
    await expect(banner).toHaveCount(1);
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(BADGE_TEXT);
    await expect(banner).toHaveAttribute('aria-label', BADGE_TEXT);
  });

  test('Q/D2 Live↔Demo-Wechsel: „Live öffnen“ nur mit STAFF_LIVE_URL; Dialog „Es wird nichts übertragen“; Abbrechen ⇒ nichts; Bestätigen ⇒ neues Fenster exakt <origin>/login ohne Cookie, Query, IDs oder Referer; kein Auto-Redirect', async ({
    page,
    context,
  }) => {
    const me = await demoApi<{ counterpart: { kind: string; url: string } | null }>(
      'GET',
      '/auth/me',
      { cookie: adminCookie },
    );
    expect(me.status).toBe(200);
    expect(me.data.counterpart).toEqual({ kind: 'live', url: DEMO_LIVE_URL });

    await loginDemoAdmin(page);
    const button = page.getByTestId('switch-environment');
    await expect(button).toHaveCount(1);
    await expect(button).toHaveText('Live öffnen');

    // Abbrechen: Dialog schließt, kein neues Fenster, Seite unverändert.
    let pagesOpened = 0;
    context.on('page', () => {
      pagesOpened += 1;
    });
    await button.click();
    const dialog = page.getByTestId('switch-environment-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Es wird nichts übertragen');
    await expect(dialog).toContainText('Du musst dich dort separat anmelden.');
    await page.getByTestId('switch-environment-dialog-cancel').click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(500);
    expect(pagesOpened).toBe(0);
    expect(context.pages()).toHaveLength(1);
    await expect(page.getByRole('heading', { name: 'Heute' })).toBeVisible();

    // Bestätigen: die Gegen-URL wird nie aufgelöst (example.invalid) – das Routing fängt das
    // neue Fenster ab und protokolliert Request-Kopfzeilen (Cookie/Referer dürfen fehlen).
    const liveRequests: { url: string; cookie: string | undefined; referer: string | undefined }[] =
      [];
    await context.route(`${DEMO_LIVE_URL}/**`, async (route) => {
      const headers = route.request().headers();
      liveRequests.push({
        url: route.request().url(),
        cookie: headers['cookie'],
        referer: headers['referer'],
      });
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>Live (E2E-Stub)</title><p data-testid="live-stub">Live-Anmeldung (Stub)</p>',
      });
    });
    await button.click();
    await expect(dialog).toBeVisible();
    const popupPromise = context.waitForEvent('page');
    await page.getByTestId('switch-environment-confirm').click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(popup.url()).toBe(`${DEMO_LIVE_URL}/login`);
    const target = new URL(popup.url());
    expect(target.origin).toBe(DEMO_LIVE_URL);
    expect(target.pathname).toBe('/login');
    expect(target.search).toBe('');
    expect(target.hash).toBe('');
    await expect(popup.getByTestId('live-stub')).toBeVisible();
    // noopener/noreferrer: kein window.opener im neuen Fenster (Playwrights `page.opener()`
    // meldet den CDP-Opener auch bei noopener – daher im Fenster selbst prüfen), kein Referer,
    // kein Cookie (anderer Origin).
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    expect(liveRequests.length).toBeGreaterThanOrEqual(1);
    for (const request of liveRequests) {
      expect(request.url).toBe(`${DEMO_LIVE_URL}/login`);
      expect(request.cookie).toBeUndefined();
      expect(request.referer).toBeUndefined();
    }
    const liveCookies = await context.cookies(DEMO_LIVE_URL);
    expect(liveCookies.filter((cookie) => /mr_staff/.test(cookie.name))).toEqual([]);
    // Ursprungsfenster: Dialog zu, weiterhin angemeldet in der Demo, keine Weiterleitung.
    await expect(dialog).toBeHidden();
    expect(new URL(page.url()).origin).toBe(DEMO_STAFF_ORIGIN);
    await expect(page.getByRole('heading', { name: 'Heute' })).toBeVisible();
    await expect(page.getByTestId('demo-badge')).toHaveCount(1);
    await popup.close();
    await context.unroute(`${DEMO_LIVE_URL}/**`);
  });

  test('C/D3 Einstellungen → Demo: nur mit demo.manage (Mitarbeiter ohne Recht: kein Link, Hinweis auf der Seite, API 403); Status mit Version/erwarteter Version/Zählern/Registry/Storage-Bereinigung; „veraltet“-Hinweis bei dataset_version 0 (Einstellungen + Heute)', async ({
    browser,
    page,
  }) => {
    test.setTimeout(240_000);
    // Zweiter Mitarbeiter mit Rolle (ohne demo.manage) über den bestehenden Seed-Weg.
    const seeded = seedTours(
      {
        adminEmail: DEMO_ADMIN_EMAIL,
        users: [
          {
            key: 'trainee',
            firstName: 'Sven',
            lastName: 'Schulung',
            email: DEMO_TRAINEE_EMAIL,
            password: DEMO_TRAINEE_PASSWORD,
            permissions: TRAINEE_PERMISSIONS,
          },
        ],
      },
      DEMO_DATABASE_URL,
    );
    traineeId = seeded.users.trainee!.id;
    traineeCookie = await apiLogin(DEMO_TRAINEE_EMAIL, DEMO_TRAINEE_PASSWORD);
    const traineeMe = await demoApi<{ permissions: string[]; environment: string }>(
      'GET',
      '/auth/me',
      { cookie: traineeCookie },
    );
    expect(traineeMe.status).toBe(200);
    expect(traineeMe.data.environment).toBe('demo');
    expect(traineeMe.data.permissions).toEqual(expect.arrayContaining(TRAINEE_PERMISSIONS));
    expect(traineeMe.data.permissions).not.toContain('demo.manage');

    // Ohne Recht: API 403 für Status, Registry und Reset.
    for (const path of ['/staff/demo/status', '/staff/demo/seed-entities']) {
      const denied = await demoApi<{ error: { code: string } }>('GET', path, {
        cookie: traineeCookie,
      });
      expect(denied.status, path).toBe(403);
    }
    const deniedReset = await demoApi<{ error: { code: string } }>('POST', '/staff/demo/reset', {
      cookie: traineeCookie,
      body: { confirmation: RESET_CONFIRMATION },
    });
    expect(deniedReset.status).toBe(403);

    // Ohne Recht in der UI: kein Link/Karte, Seite zeigt den Hinweis; Badge trotzdem sichtbar.
    traineeContext = await browser.newContext();
    const traineePage = await traineeContext.newPage();
    await login(traineePage, DEMO_TRAINEE_EMAIL, DEMO_TRAINEE_PASSWORD, 'Sven');
    await expect(traineePage.getByTestId('demo-badge')).toHaveCount(1);
    await expect(traineePage.getByTestId('demo-outdated-hint')).toHaveCount(0);
    await traineePage.goto('/einstellungen');
    await expect(traineePage.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
    await expect(traineePage.getByTestId('settings-demo-card')).toHaveCount(0);
    await expect(traineePage.getByTestId('settings-link-demo')).toHaveCount(0);
    await traineePage.goto('/einstellungen/demo');
    await expect(traineePage.getByTestId('demo-not-available')).toBeVisible();
    await expect(traineePage.getByTestId('demo-not-available')).toContainText(
      'nur in der Demo-Umgebung für Administratoren',
    );
    await expect(traineePage.getByTestId('demo-reset')).toHaveCount(0);
    await expect(traineePage.getByTestId('demo-status')).toHaveCount(0);

    // Admin (demo.manage automatisch): Link ⇒ Statusseite.
    await loginDemoAdmin(page);
    await page.goto('/einstellungen');
    await expect(page.getByTestId('settings-demo-card')).toBeVisible();
    await page.getByTestId('settings-link-demo').click();
    await expect(page).toHaveURL(/\/einstellungen\/demo$/);
    await expect(page.getByTestId('demo-settings')).toBeVisible();
    await expect(page.getByTestId('demo-not-available')).toHaveCount(0);
    const status = page.getByTestId('demo-status');
    await expect(status).toBeVisible();
    const apiStatus = await demoStatus(adminCookie);
    expect(apiStatus.environment).toBe('demo');
    expect(apiStatus.expectedDatasetVersion).toBe(EXPECTED_DATASET_VERSION);
    expect(apiStatus.resetInProgress).toBe(false);
    // Vor dem ersten Seed/Reset: keine Version, keine Registry.
    expect(apiStatus.datasetVersion).toBeNull();
    expect(apiStatus.seededAt).toBeNull();
    expect(apiStatus.seedEntities).toBe(0);
    // Phase 14 (reset): keine ausstehende/fehlgeschlagene Storage-Bereinigung, kein UI-Hinweis.
    expect(apiStatus.storageCleanup).toEqual({ pendingJobs: 0, deadJobs: 0 });
    await expect(page.getByTestId('demo-storage-cleanup')).toHaveCount(0);
    await expect(page.getByTestId('demo-dataset-version')).toHaveText('–');
    await expect(status).toContainText(`(erwartet ${EXPECTED_DATASET_VERSION})`);
    await expect(page.getByTestId('demo-counts')).toHaveText(
      `Kunden: ${apiStatus.counts.customers} · Vorgänge: ${apiStatus.counts.processes} · Touren: ${apiStatus.counts.tours} · Seed-Szenarien: 0`,
    );
    await expect(page.getByTestId('demo-reset')).toBeEnabled();

    // Veralteter Datenstand (Order §8): dataset_version 0 mit gesetztem seeded_at ⇒ Hinweis,
    // nie ein automatischer Reset.
    const inserted = demoDb<{ seeded_at: string }>(
      `INSERT INTO demo_dataset_state (id, dataset_version, seeded_at)
       VALUES (1, 0, now())
       ON CONFLICT (id) DO UPDATE SET dataset_version = 0, seeded_at = now()
       RETURNING seeded_at`,
    );
    outdatedSeededAt = inserted[0]!.seeded_at;
    const outdatedStatus = await demoStatus(adminCookie);
    expect(outdatedStatus.outdated).toBe(true);
    expect(outdatedStatus.outdatedHint).toBe(OUTDATED_TEXT);
    expect(outdatedStatus.datasetVersion).toBe(0);
    await page.reload();
    await expect(page.getByTestId('demo-outdated')).toBeVisible();
    await expect(page.getByTestId('demo-outdated')).toHaveText(OUTDATED_TEXT);
    await expect(page.getByTestId('demo-dataset-version')).toHaveText('0');
    await expect(page.getByTestId('demo-reset-running')).toHaveCount(0);
    await page.goto('/');
    await expect(page.getByTestId('demo-outdated-hint')).toBeVisible();
    await expect(page.getByTestId('demo-outdated-hint')).toContainText(OUTDATED_TEXT);
    // Kein Hinweis für den Mitarbeiter ohne demo.manage.
    await traineePage.goto('/');
    await expect(traineePage.getByRole('heading', { name: 'Heute' })).toBeVisible();
    await expect(traineePage.getByTestId('demo-outdated-hint')).toHaveCount(0);
    // Datenstand unverändert (kein automatischer Reset durch Anzeige/Status).
    expect((await demoStatus(adminCookie)).datasetVersion).toBe(0);
  });

  test('C/D4 Reset-Dialog: Bestätigen erst bei exakt „DEMO ZURÜCKSETZEN“; Reset läuft (busy), Ergebnis-Hinweis, Status aktualisiert; DB enthält danach genau den kanonischen Datensatz (MR-<Jahr>-0001 ff., Registry inkl. Fixture-Gutschein); Security-Events demo.reset_started/completed; Admin bleibt angemeldet', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    staffBefore = staffSnapshot();
    securityEventsBefore = Number(
      demoDb<{ n: string }>('SELECT count(*)::text AS n FROM staff_security_events')[0]!.n,
    );
    // Eigener Altbestand (unabhängig von der Dateireihenfolge): muss nach dem Reset weg sein.
    const legacy = await demoApi<{ customer: { id: string } }>('POST', '/staff/customers', {
      cookie: adminCookie,
      body: {
        type: 'private',
        firstName: 'Alt',
        lastName: 'Bestand',
        email: 'alt.bestand@example.invalid',
      },
    });
    expect(legacy.status, 'Altbestand anlegen').toBe(200);
    const legacyCustomerId = legacy.data.customer.id;
    expect(
      demoDb('SELECT id FROM customers WHERE id = $1', [legacyCustomerId]),
      'Altbestand vor dem Reset',
    ).toHaveLength(1);

    await loginDemoAdmin(page);
    await page.goto('/einstellungen/demo');
    await expect(page.getByTestId('demo-outdated')).toBeVisible();
    await page.getByTestId('demo-reset').click();
    const dialog = page.getByTestId('demo-reset-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('unwiderruflich gelöscht');
    const confirm = page.getByTestId('demo-reset-confirm');
    const input = page.getByTestId('demo-reset-confirmation');
    await expect(confirm).toBeDisabled();
    // Falscheingaben bleiben deaktiviert (Schreibweise, Umlaut, Zusatzzeichen).
    for (const wrong of ['DEMO ZURUECKSETZEN', 'demo zurücksetzen', 'DEMO ZURÜCKSETZEN!', 'DEMO']) {
      await input.fill(wrong);
      await expect(confirm).toBeDisabled();
    }
    await input.fill(RESET_CONFIRMATION);
    await expect(confirm).toBeEnabled();

    const resetResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/staff/demo/reset') && response.request().method() === 'POST',
      { timeout: 150_000 },
    );
    await confirm.click();
    // Während des Laufs: busy (Bestätigen/Abbrechen/Eingabe deaktiviert).
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveText('Wird zurückgesetzt …');
    await expect(page.getByTestId('demo-reset-dialog-cancel')).toBeDisabled();
    await expect(input).toBeDisabled();
    const response = await resetResponse;
    expect(response.status(), await response.text()).toBe(200);
    const result = (await response.json()) as {
      ok: boolean;
      datasetVersion: number;
      seededAt: string;
      durationMs: number;
      deleted: Record<string, number>;
      seeded: Record<string, number>;
    };
    expect(result.ok).toBe(true);
    expect(result.datasetVersion).toBe(EXPECTED_DATASET_VERSION);
    expect(result.seeded['customers']).toBeGreaterThan(0);
    expect(result.seeded['processes']).toBeGreaterThan(0);
    expect(result.seeded['tours']).toBeGreaterThan(0);

    // Ergebnis-Hinweis und aktualisierter Status in der UI.
    await expect(dialog).toBeHidden();
    const notice = page.getByTestId('demo-reset-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(
      `Demo-Geschäftsdaten wurden zurückgesetzt (Datenstand Version ${EXPECTED_DATASET_VERSION}`,
    );
    await expect(page.getByTestId('demo-reset-error')).toHaveCount(0);
    await expect(page.getByTestId('demo-outdated')).toHaveCount(0);
    await expect(page.getByTestId('demo-reset-running')).toHaveCount(0);
    await expect(page.getByTestId('demo-reset-stale')).toHaveCount(0);
    await expect(page.getByTestId('demo-dataset-version')).toHaveText(
      String(EXPECTED_DATASET_VERSION),
    );
    await expect(page.getByTestId('demo-status')).toContainText('von Dana Demo');
    await expect(page.getByTestId('demo-reset')).toBeEnabled();

    const status = await demoStatus(adminCookie);
    expect(status.datasetVersion).toBe(EXPECTED_DATASET_VERSION);
    expect(status.datasetVersion).toBe(status.expectedDatasetVersion);
    expect(status.outdated).toBe(false);
    expect(status.resetInProgress).toBe(false);
    expect(status.resetStale).toBe(false);
    expect(status.seededAt).not.toBeNull();
    expect(new Date(status.seededAt!).getTime()).toBeGreaterThan(
      new Date(outdatedSeededAt).getTime(),
    );
    expect(status.lastResetAt).not.toBeNull();
    expect(status.seededBy).toEqual({ id: adminId, name: 'Dana Demo' });
    expect(status.lastResetBy).toEqual({ id: adminId, name: 'Dana Demo' });
    expect(status.counts).toEqual({
      customers: result.seeded['customers'],
      processes: result.seeded['processes'],
      tours: result.seeded['tours'],
    });
    expect(status.seedEntities).toBe(result.seeded['seedEntities']);
    expect(status.storageCleanup).toEqual({ pendingJobs: 0, deadJobs: 0 });
    await expect(page.getByTestId('demo-storage-cleanup')).toHaveCount(0);
    await expect(page.getByTestId('demo-counts')).toHaveText(
      `Kunden: ${status.counts.customers} · Vorgänge: ${status.counts.processes} · Touren: ${status.counts.tours} · Seed-Szenarien: ${status.seedEntities}`,
    );
    // Seed-Szenarien in der UI (Registry).
    await page.getByText('Seed-Szenarien anzeigen').click();
    const entityList = page.getByTestId('demo-seed-entities');
    await expect(entityList).toBeVisible();
    await expect(entityList.locator('li')).toHaveCount(status.seedEntities);
    await expect(entityList).toContainText('process.offer.draft');

    // Datenbank: genau der kanonische Datensatz – Vorgangsnummern wieder ab 0001, alte Daten weg.
    const numbers = demoDb<{ process_number: string }>(
      'SELECT process_number FROM processes ORDER BY process_number',
    ).map((row) => row.process_number);
    const year = berlinYear();
    expect(numbers).toEqual(
      Array.from(
        { length: result.seeded['processes']! },
        (_, index) => `MR-${year}-${String(index + 1).padStart(4, '0')}`,
      ),
    );
    expect(
      demoDb(
        `SELECT id FROM customers WHERE email IS NULL
            OR (email NOT LIKE '%@example.com' AND email NOT LIKE '%@example.invalid')`,
      ),
      'nur synthetische Seed-Kunden',
    ).toHaveLength(0);
    expect(
      demoDb('SELECT id FROM customers WHERE id = $1', [legacyCustomerId]),
      'Altbestand nach dem Reset',
    ).toHaveLength(0);
    const registryKeys = demoDb<{ seed_key: string; dataset_version: number }>(
      'SELECT seed_key, dataset_version FROM demo_seed_entities',
    );
    expect(registryKeys).toHaveLength(status.seedEntities);
    for (const row of registryKeys) expect(row.dataset_version).toBe(EXPECTED_DATASET_VERSION);
    const keys = new Set(registryKeys.map((row) => row.seed_key));
    for (const key of REQUIRED_SEED_KEYS) expect(keys.has(key), `Seed-Key ${key}`).toBe(true);
    // W1.1: der Fixture-Gutschein des Wiedermieters ist der einzige Gutschein – ohne Transfer.
    const vouchers = demoDb<{ id: string; status: string }>('SELECT id, status FROM vouchers');
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0]!.status).toBe('active');
    expect(
      registryKeys.find((row) => row.seed_key === 'voucher.situation'),
      'Registry-Eintrag voucher.situation',
    ).toBeDefined();
    expect(demoDb('SELECT id FROM accounting_transfers')).toHaveLength(0);
    const state = demoDb<{
      dataset_version: number;
      reset_in_progress: boolean;
      reset_started_at: string | null;
      seeded_by: string;
      last_reset_by: string;
    }>('SELECT * FROM demo_dataset_state WHERE id = 1');
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({
      dataset_version: EXPECTED_DATASET_VERSION,
      reset_in_progress: false,
      reset_started_at: null,
      seeded_by: adminId,
      last_reset_by: adminId,
    });

    // Security-Events (Order §31): Start und Abschluss desselben Laufs mit dem Admin als Actor,
    // Details ausschließlich resetRunId/datasetVersion/status (kein Seed-Inhalt).
    const events = demoDb<{
      type: string;
      actor_user_id: string;
      details: Record<string, unknown>;
    }>(
      `SELECT type, actor_user_id, details FROM staff_security_events
        WHERE type IN ('demo.reset_started', 'demo.reset_completed', 'demo.reset_failed')
        ORDER BY created_at`,
    );
    expect(events.map((event) => event.type)).toEqual([
      'demo.reset_started',
      'demo.reset_completed',
    ]);
    for (const event of events) {
      expect(event.actor_user_id).toBe(adminId);
      expect(Object.keys(event.details).sort()).toEqual(['datasetVersion', 'resetRunId', 'status']);
      expect(event.details).toMatchObject({ datasetVersion: EXPECTED_DATASET_VERSION });
    }
    expect(events[0]!.details['status']).toBe('started');
    expect(events[1]!.details['status']).toBe('completed');
    expect(events[0]!.details['resetRunId']).toEqual(events[1]!.details['resetRunId']);
    expect(JSON.stringify(events)).not.toMatch(/example\.com|Beispiel|@/);

    // Admin bleibt angemeldet: nächste Seiten laden, /auth/me ok, Vorgänge zeigen den Seed.
    const meAfter = await browserAuthMe(page);
    expect(meAfter.status, 'Browser-Session des Admins nach dem Reset').toBe(200);
    expect(meAfter.data).toMatchObject({ appLocked: false, environment: 'demo' });
    await page.goto('/vorgaenge');
    await expectDemoHeader(page, 'Vorgänge');
    await expect(page.getByText(`MR-${year}-0001`, { exact: true })).toBeVisible();
    expect((await demoApi('GET', '/auth/me', { cookie: adminCookie })).status).toBe(200);
  });

  test('C/D5 503-Gate: während reset_in_progress liefert eine Business-Mutation (API und UI) 503 DEMO_RESET mit lesbarer Meldung, GET-Seiten laden weiter, /auth/me funktioniert; nach Rücksetzen des Flags geht es wieder', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await loginDemoAdmin(page);
    const customersBefore = demoDb<{ n: string }>('SELECT count(*)::text AS n FROM customers')[0]!
      .n;
    expect((await duplicateCheck(adminCookie)).status).toBe(200);

    demoDb(
      `UPDATE demo_dataset_state SET reset_in_progress = true, reset_started_at = now() WHERE id = 1`,
    );
    try {
      // Gate liest den Zustand mit 1-s-Cache.
      await expect
        .poll(async () => (await duplicateCheck(adminCookie)).status, { timeout: 10_000 })
        .toBe(503);
      const blocked = await duplicateCheck(adminCookie);
      expect(blocked.status).toBe(503);
      expect(blocked.headers.get('retry-after')).toBe('15');
      expect(blocked.data.error).toMatchObject({ code: 'DEMO_RESET', message: RESET_GATE_MESSAGE });
      expect(blocked.data.error!.message).toContain('wird gerade zurückgesetzt');
      const create = await demoApi<{ error: { code: string } }>('POST', '/staff/customers', {
        cookie: adminCookie,
        body: { type: 'private', firstName: 'Gate', lastName: 'Prüfung' },
      });
      expect(create.status).toBe(503);
      expect(create.data.error.code).toBe('DEMO_RESET');

      // UI: Kunde anlegen ⇒ lesbare Meldung, kein Logout, kein Datensatz.
      await page.goto('/kunden');
      await expect(page.getByRole('heading', { name: 'Kunden' })).toBeVisible();
      await page.getByRole('button', { name: 'Kunde anlegen' }).click();
      await page.getByLabel('Vorname', { exact: true }).fill('Gate');
      await page.getByLabel('Nachname', { exact: true }).fill('Prüfung');
      await page.getByRole('button', { name: 'Kunde anlegen' }).click();
      const gateError = page.locator('p.error', { hasText: 'zurückgesetzt' });
      await expect(gateError).toBeVisible();
      await expect(gateError).toHaveText(RESET_GATE_MESSAGE);
      await expect(page).toHaveURL(/\/kunden$/);

      // GET-Seiten laden weiter, Anmeldung bleibt, Statusseite zeigt den laufenden Reset.
      await page.goto('/vorgaenge');
      await expectDemoHeader(page, 'Vorgänge');
      await page.goto('/');
      await expectDemoHeader(page, 'Heute');
      for (const path of ['/auth/me', '/staff/demo/status', '/staff/customers', '/health']) {
        expect((await demoApi('GET', path, { cookie: adminCookie })).status, path).toBe(200);
      }
      expect((await browserAuthMe(page)).status).toBe(200);
      // Reset-Routen und Auth sind vom Gate ausgenommen: Logout/Login funktionieren weiter.
      const extraLogin = await demoApi('POST', '/auth/login', {
        body: { email: DEMO_ADMIN_EMAIL, password: DEMO_ADMIN_PASSWORD },
      });
      expect(extraLogin.status).toBe(200);
      await page.goto('/einstellungen/demo');
      await expect(page.getByTestId('demo-reset-running')).toBeVisible();
      await expect(page.getByTestId('demo-reset-running')).toContainText(
        'wird gerade zurückgesetzt',
      );
      await expect(page.getByTestId('demo-reset')).toBeDisabled();
    } finally {
      demoDb(
        `UPDATE demo_dataset_state SET reset_in_progress = false, reset_started_at = NULL WHERE id = 1`,
      );
    }
    await expect
      .poll(async () => (await duplicateCheck(adminCookie)).status, { timeout: 10_000 })
      .toBe(200);
    await page.reload();
    await expect(page.getByTestId('demo-reset-running')).toHaveCount(0);
    await expect(page.getByTestId('demo-reset')).toBeEnabled();
    expect(demoDb<{ n: string }>('SELECT count(*)::text AS n FROM customers')[0]!.n).toBe(
      customersBefore,
    );
  });

  test('C/D6 Seed-Nützlichkeit: Registry enthält alle Pflicht-Szenarien (inkl. voucher.situation); Heute zeigt heutige Termine, fällige und überfällige Rückgabe; Touren zeigen die heutige Tour (3 Stopps) und die Tour morgen; Kalender zeigt Termine; nur example.com/example.invalid; keine Mail verlässt die Whitelist', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const registry = demoDb<{ seed_key: string; entity_type: string; entity_id: string }>(
      'SELECT seed_key, entity_type, entity_id FROM demo_seed_entities',
    );
    const byKey = new Map(registry.map((row) => [row.seed_key, row]));
    for (const key of REQUIRED_SEED_KEYS) expect(byKey.has(key), `Seed-Key ${key}`).toBe(true);
    const resolve = (key: string) => byKey.get(key)!.entity_id;
    const apiRegistry = await demoApi<{
      expectedDatasetVersion: number;
      entities: { seedKey: string }[];
    }>('GET', '/staff/demo/seed-entities', { cookie: adminCookie });
    expect(apiRegistry.status).toBe(200);
    expect(apiRegistry.data.expectedDatasetVersion).toBe(EXPECTED_DATASET_VERSION);
    expect(apiRegistry.data.entities.map((entity) => entity.seedKey).sort()).toEqual(
      [...byKey.keys()].sort(),
    );
    const processNumber = (key: string) =>
      demoDb<{ process_number: string }>('SELECT process_number FROM processes WHERE id = $1', [
        resolve(key),
      ])[0]!.process_number;

    // Heute: überfällige Rückgabe (gestern), Rückgabe heute fällig, Lieferung heute.
    await loginDemoAdmin(page);
    const overdueCard = page.locator('.overdue-card');
    await expect(overdueCard.getByRole('heading', { name: 'Überfällige Rückgaben' })).toBeVisible();
    await expect(overdueCard).toContainText(processNumber('process.return.overdue'));
    await expect(overdueCard.locator('.badge', { hasText: 'Überfällig' }).first()).toBeVisible();
    const todayCard = page.locator('.card', {
      has: page.getByRole('heading', { name: 'Heutige Termine' }),
    });
    await expect(todayCard).toContainText(processNumber('process.return.due'));
    await expect(todayCard).toContainText(processNumber('process.booking.accepted.delivery'));
    await expect(todayCard).toContainText('Rückgabe');
    await expect(todayCard).toContainText('Lieferung');

    // Touren: heute 3 Stopps (nicht gestartet), morgen geplant.
    await page.goto('/touren');
    await expect(page.getByRole('heading', { name: 'Touren', exact: true })).toBeVisible();
    const todayTour = page.getByTestId(`tour-row-${resolve('tour.today.multi_stop')}`);
    await expect(todayTour).toBeVisible();
    await expect(todayTour).toContainText('3 Stopps');
    await expect(todayTour).toContainText('Tour Dana Demo');
    await page.getByRole('button', { name: 'Folgetag' }).click();
    const tomorrowTour = page.getByTestId(`tour-row-${resolve('tour.future.planned')}`);
    await expect(tomorrowTour).toBeVisible();
    await expect(tomorrowTour).toContainText('1 Stopp');
    expect(
      demoDb<{ status: string; planning_status: string }>(
        'SELECT status, planning_status FROM tours WHERE id = $1',
        [resolve('tour.future.planned')],
      )[0],
    ).toMatchObject({ planning_status: 'planned' });

    // Kalender (Tagesansicht heute): Termine des Seeds als Chips.
    await gotoCalendarDay(page, berlinTodayIso());
    for (const key of [
      'appointment.delivery.today',
      'appointment.delivery.today_second',
      'appointment.return.due_today',
    ]) {
      await expect(page.getByTestId(`chip-${resolve(key)}`), key).toBeVisible();
    }

    // Synthetische Daten: alle Kunden-E-Mails unter example.com/example.invalid, kein Telefon.
    const customers = demoDb<{ email: string | null; phone: string | null }>(
      'SELECT email, phone FROM customers',
    );
    expect(customers.length).toBeGreaterThan(0);
    for (const customer of customers) {
      expect(customer.email, 'Kunden-E-Mail').toMatch(/@example\.(com|invalid)$/);
      expect(customer.phone ?? '', 'Kein Telefon im Seed').toBe('');
    }
    // Outbox: nichts außerhalb der Whitelist verlassen (blocked), keine Sendungen in der Senke.
    const deliveries = demoDb<{
      status: string;
      recipient_email: string;
      blocked_reason: string | null;
      subject: string;
    }>('SELECT status, recipient_email, blocked_reason, subject FROM mail_deliveries');
    expect(deliveries.length).toBeGreaterThan(0);
    for (const delivery of deliveries) {
      expect(['blocked', 'pending'], delivery.recipient_email).toContain(delivery.status);
      if (!delivery.recipient_email.toLowerCase().endsWith(DEMO_MAIL_WHITELIST)) {
        expect(delivery.status, delivery.recipient_email).toBe('blocked');
        expect(delivery.blocked_reason).toBe('DEMO_NOT_WHITELISTED');
      }
    }
    expect(deliveries.some((delivery) => delivery.status === 'blocked')).toBe(true);
    expect(
      demoDb(`SELECT id FROM integration_jobs WHERE type = 'mail.send' AND status <> 'succeeded'`),
      'keine wartenden Versandjobs für blockierte Mails',
    ).toHaveLength(0);
    expect(await sinkMails(), 'SMTP-Senke seit Spec-Beginn').toEqual([]);
  });

  test('C/D7 Reset löscht keine Staff-/Trainingsdaten: zweiter Mitarbeiter mit Rolle und Rechten, Sessions und bekannte Geräte bleiben erhalten (DB-Zähler vor/nach gleich), Security-Audit um genau die Reset-Events ergänzt', async () => {
    expect(staffBefore, 'Snapshot aus D4').not.toBeNull();
    const after = staffSnapshot();
    expect(after.userIds).toEqual(staffBefore!.userIds);
    expect(after.roleIds).toEqual(staffBefore!.roleIds);
    expect(after.userRoles).toEqual(staffBefore!.userRoles);
    expect(after.rolePermissions).toEqual(staffBefore!.rolePermissions);
    expect(after.pushSubscriptions).toEqual(staffBefore!.pushSubscriptions);
    // Alle vor dem Reset bekannten Geräte und aktiven Sessions existieren weiter (spätere
    // Logins der Spec legen neue Geräte/Sessions an – daher Teilmengen-, kein Gleichheitsvergleich).
    for (const id of staffBefore!.deviceIds) expect(after.deviceIds, `Gerät ${id}`).toContain(id);
    for (const id of staffBefore!.sessionIds)
      expect(after.sessionIds, `Session ${id}`).toContain(id);
    expect(after.userIds).toContain(traineeId);
    expect(after.userIds).toContain(adminId);
    expect(staffBefore!.deviceIds.length).toBeGreaterThan(0);

    const permissions = demoDb<{ permission_key: string }>(
      `SELECT rp.permission_key FROM staff_user_roles ur
         JOIN staff_role_permissions rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1 ORDER BY rp.permission_key`,
      [traineeId],
    ).map((row) => row.permission_key);
    expect(permissions).toEqual([...TRAINEE_PERMISSIONS].sort());
    const traineeMe = await demoApi<{ permissions: string[]; user: { firstName: string } }>(
      'GET',
      '/auth/me',
      { cookie: traineeCookie },
    );
    expect(traineeMe.status, 'Session des zweiten Mitarbeiters nach dem Reset').toBe(200);
    expect(traineeMe.data.permissions).toEqual(expect.arrayContaining(TRAINEE_PERMISSIONS));
    expect(traineeMe.data.permissions).not.toContain('demo.manage');
    const traineePage = traineeContext!.pages()[0]!;
    await traineePage.goto('/einstellungen');
    await expect(traineePage.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
    await expect(traineePage.getByTestId('demo-badge')).toHaveCount(1);
    await expect(traineePage.getByTestId('settings-link-demo')).toHaveCount(0);

    // Security-Audit bleibt vollständig (nur ergänzt, nie gelöscht).
    const securityAfter = Number(
      demoDb<{ n: string }>('SELECT count(*)::text AS n FROM staff_security_events')[0]!.n,
    );
    expect(securityAfter).toBeGreaterThanOrEqual(securityEventsBefore + 2);
    expect(
      demoDb(`SELECT id FROM staff_security_events WHERE type = 'session.created'`).length,
    ).toBeGreaterThan(0);
    // Mitarbeiter-Stammdaten unverändert (kein Konto gesperrt/deaktiviert).
    expect(
      demoDb<{ status: string }>('SELECT status FROM staff_users WHERE id = ANY($1::uuid[])', [
        [adminId, traineeId],
      ]).map((row) => row.status),
    ).toEqual(['active', 'active']);
  });
});

test.describe('Live-Gegentest (Projekt chromium, development ohne STAFF_DEMO_URL)', () => {
  test.skip(
    () => test.info().project.name !== LIVE_PROJECT,
    'Der Live-Gegentest läuft nur gegen Haupt-API/-Staff/-Web (Projekt chromium).',
  );

  test.beforeAll(() => {
    resetE2eDatabase();
  });

  test('A/Q-Live (D1/D2/D3-Live): kein Badge, kein Titel-Präfix, kein Wechsel-Button ohne STAFF_DEMO_URL (counterpart null), keine Demo-Karte/-Routen (404), kein Web-Banner', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /Anmeldung/ })).toBeVisible();
    await expect(page.getByTestId('demo-badge')).toHaveCount(0);
    await expect(page).not.toHaveTitle(TITLE_PREFIX);

    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
    await expect(page.getByTestId('demo-badge')).toHaveCount(0);
    await expect(page.getByTestId('switch-environment')).toHaveCount(0);
    await expect(page.getByTestId('demo-outdated-hint')).toHaveCount(0);
    await expect(page).not.toHaveTitle(TITLE_PREFIX);
    const me = await page.request.get('/api/auth/me');
    expect(me.status()).toBe(200);
    expect((await me.json()) as Record<string, unknown>).toMatchObject({
      environment: 'development',
      counterpart: null,
    });

    await page.goto('/einstellungen');
    await expect(page.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
    await expect(page.getByTestId('settings-demo-card')).toHaveCount(0);
    await expect(page.getByTestId('settings-link-demo')).toHaveCount(0);
    await page.goto('/einstellungen/demo');
    await expect(page.getByTestId('demo-not-available')).toBeVisible();
    await expect(page.getByTestId('demo-reset')).toHaveCount(0);
    // Demo-Routen existieren außerhalb der Demo nicht (Order §15).
    expect((await page.request.get('/api/staff/demo/status')).status()).toBe(404);
    expect(
      (
        await page.request.post('/api/staff/demo/reset', {
          data: { confirmation: RESET_CONFIRMATION },
        })
      ).status(),
    ).toBe(404);

    // Öffentliche Web-Instanz (development): kein Banner.
    await page.goto(`${WEB_ORIGIN}/`);
    await expect(page.locator('body')).toBeVisible();
    await expect(page.getByTestId('demo-banner')).toHaveCount(0);
  });
});
