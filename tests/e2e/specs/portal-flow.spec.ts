/**
 * Phase-15-E2E-Szenarien A–M, O, P (Order §66) – Kundenportal /konto der
 * Web-Instanz (3100, Same-Origin-Proxy /api → Haupt-API 3101, APP_ENV
 * development ⇒ Cookie `mr_customer_session`). Szenario N (Demo-Portal + Reset)
 * liegt in portal-demo.spec.ts (Projekt `demo-communication`).
 *
 * A Magic Login (Mail aus der SMTP-Senke, Fragment-Link, Token nie in URL/Storage,
 *   HttpOnly-Session, Einmal-Link)
 * B No Enumeration (unbekannt/doppelt/gelöscht ⇒ identische neutrale Antwort, kein Link)
 * C Active Booking (Snapshot-Ansicht, exakter Termin vs. Fenster, Abholadresse +
 *   Navigation, Anrufen, keine internen Daten, no-store)
 * D Multiple Current Bookings (Liste nach Eventdatum)
 * E Documents (angenommenes Angebot, AB, Lieferschein, Übergabeprotokoll; private PDFs)
 * F Customer Chat + Photo + Staff Reply (Kanal Portal) + Mail-Hinweis ohne Chattext
 *   (+ Push „Neue Kundennachricht – MR-…“ ohne Nachrichtentext)
 * G „Unterwegs“ ohne GPS/ETA/Fahrer (aktive Tour, nächster Stopp beim Kunden)
 * H Profile Reauth (Mutation blockiert ⇒ Bestätigungslink ⇒ speichern; Snapshot bleibt)
 * I Email Change + Session Revoke (Link an neue Adresse, alle Sessions widerrufen,
 *   Login nur noch mit neuer Adresse)
 * J Free Cancellation (0 €, Bestätigungsmail, danach nicht mehr im Dashboard)
 * K Paid Cancellation Fee (50 %, Basis reguläre Maschinenmiete, „Rechnung folgt“)
 * L Cancellation Blocked (Übergabe abgeschlossen ⇒ Kundentext + Anrufen, 409)
 * M No Active Booking → „Neue Anfrage starten“ (konfigurierte URL)
 * O 30-Day Session / no sliding (Zeitverschiebung der Session-Zeile)
 * P IDOR mit zwei Customers (Buchung/Dokument/Nachricht/Foto/Storno ⇒ 404) + Logout
 *
 * Daten: Basis-Seed + apps/api/scripts/e2e-portal-seed.ts (echte Fachservices:
 * Annahmepfad, Terminplanung, AB-Freigabe, Übergabe-Finalisierung, Tour-Start).
 * Anmeldung AUSSCHLIESSLICH über den Link der echten Mail aus der SMTP-Senke
 * (helpers/portal.ts) – keine Reveal-Route, kein stdout, keine Datei, kein
 * Lesen von secret_payload_ciphertext; Tokens werden nur boolesch verglichen.
 * Einzige Datenbank-Schreibhilfe: reine Zeitverschiebung von Session-Zeilen
 * (H: Reauth-Frische abgelaufen; O: 30-Tage-Grenze).
 *
 * Zeit: G legt eine Lieferung HEUTE (Europe/Berlin) an (todayWindow) – Lauf nicht
 * zwischen ≈ 23:00 und 00:02 Uhr Berlin starten (Seed bricht dann mit „Resttag zu
 * kurz“ ab).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectPushCount } from '../helpers/communication-ops.ts';
import { runDueJobsViaApi } from '../helpers/jobs.ts';
import {
  clearSink,
  expectMailCount,
  expectMietRoyalMail,
  linkFromMail,
  mailsMatching,
  waitForMail,
} from '../helpers/mail.ts';
import {
  PORTAL_COOKIE_DEV,
  PORTAL_SUBJECT,
  PORTAL_TEXT,
  activePortalSession,
  bookingSnapshots,
  customerRow,
  euroText,
  expectNoForbiddenKeys,
  expectTokenNotInBrowser,
  germanDate,
  loginViaMagicLink,
  magicLinks,
  openMagicLink,
  outboxTo,
  portalApiGet,
  portalApiPost,
  portalCookie,
  portalSessions,
  requestMagicLinkMail,
  seedPortal,
  sha256Hex,
  shiftPortalSession,
  tokenOfLink,
  type PortalSeedResult,
  type PortalSeededBooking,
} from '../helpers/portal.ts';
import {
  clearPushRequests,
  createPushSubscriptionKeys,
  registerPushSubscription,
  type PushSubscriptionKeys,
} from '../helpers/push.ts';
import { ADMIN_EMAIL, ADMIN_PASSWORD, WEB_ORIGIN, resetE2eDatabase } from '../helpers/seed.ts';
import { PNG_1X1, login } from '../helpers/settlement.ts';
import { todayWindow } from '../helpers/tours.ts';
import { queryTestDb } from '../helpers/voucher.ts';

test.describe.configure({ mode: 'serial' });

const DOMAIN = 'portal-e2e.test';
const UNKNOWN_EMAIL = `niemand@${DOMAIN}`;
const DUPLICATE_EMAIL = `doppelt@${DOMAIN}`;
const TRASHED_EMAIL = `geloescht@${DOMAIN}`;
const HANNA_NEW_EMAIL = `hanna.neu@${DOMAIN}`;
/** Konfiguration der Haupt-API (playwright.config.ts PORTAL_E2E_ENV). */
const NEW_INQUIRY_URL = 'https://anfrage.miet-royal.example/neue-anfrage';
const PHONE_TEL = 'tel:+496131000000';
/** Synthetische Abholadresse des Basis-Seeds (scripts/e2e-seed.ts). */
const PICKUP_ADDRESS = 'Teststraße 1, 55129 Mainz-Hechtsheim (SYNTHETISCH)';
const INTERNAL_NOTE = 'INTERN-PORTAL-E2E: Kundin zahlt erfahrungsgemäß spät';
/** Fahrer der aktiven Tour (Szenario G) und sein Live-Standort – beides nie im Portal. */
const DRIVER = {
  firstName: 'Fridolin',
  lastName: 'Fernfahrt',
  email: `fridolin.fernfahrt@${DOMAIN}`,
  password: 'e2e-fridolin-passwort-1',
};
const DRIVER_POINT = { latitude: 49.96123, longitude: 8.27456 };
const CUSTOMER_MESSAGE = 'Hallo Miet-Royal, passt der Stellplatz auf dem Foto für die Maschine?';
const STAFF_REPLY = 'Ja, der Stellplatz passt – bis zum Event! (Antwort-E2E-7319)';

const CUSTOMERS = {
  anna: { firstName: 'Anna', lastName: 'Aktiv', email: `anna.aktiv@${DOMAIN}` },
  bernd: { firstName: 'Bernd', lastName: 'Bekannt', email: `bernd.bekannt@${DOMAIN}` },
  dup1: { firstName: 'Doris', lastName: 'Doppelt', email: DUPLICATE_EMAIL },
  dup2: { firstName: 'Dirk', lastName: 'Doppelt', email: DUPLICATE_EMAIL },
  trashed: { firstName: 'Gisela', lastName: 'Gelöscht', email: TRASHED_EMAIL, trashed: true },
  dora: { firstName: 'Dora', lastName: 'Zweifach', email: `dora.zweifach@${DOMAIN}` },
  erna: { firstName: 'Erna', lastName: 'Dokument', email: `erna.dokument@${DOMAIN}` },
  gerd: { firstName: 'Gerd', lastName: 'Geliefert', email: `gerd.geliefert@${DOMAIN}` },
  hanna: { firstName: 'Hanna', lastName: 'Profil', email: `hanna.profil@${DOMAIN}` },
  jonas: { firstName: 'Jonas', lastName: 'Kostenfrei', email: `jonas.kostenfrei@${DOMAIN}` },
  karla: { firstName: 'Karla', lastName: 'Gebühr', email: `karla.gebuehr@${DOMAIN}` },
  mia: { firstName: 'Mia', lastName: 'Neuanfrage', email: `mia.neuanfrage@${DOMAIN}` },
  olaf: { firstName: 'Olaf', lastName: 'Ablauf', email: `olaf.ablauf@${DOMAIN}` },
} as const;
type CustomerKey = keyof typeof CUSTOMERS;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

let staff: Page; // Admin Erika (Mock-Jobs, Kommunikation, Push)
let annaPage: Page; // Kundin A (A, C, F, P)
let ernaPage: Page; // Kundin E (E, L, P)
let hannaPage: Page; // Kundin H/I
let seed: PortalSeedResult;
let pushKeys: PushSubscriptionKeys;
let annaMessageId = '';
let annaPhotoId = '';

const runJobs = () => runDueJobsViaApi(staff);
const customerId = (key: CustomerKey): string => {
  const found = seed.customers[key];
  if (found === undefined) throw new Error(`Seed-Kunde ${key} fehlt`);
  return found.id;
};
const booking = (key: string): PortalSeededBooking => {
  const found = seed.bookings[key];
  if (found === undefined) throw new Error(`Seed-Buchung ${key} fehlt`);
  return found;
};
const bookingUrl = (key: string) => `${WEB_ORIGIN}/konto/buchung/${booking(key).bookingId}`;

async function customerPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

async function login15(page: Page, key: CustomerKey): Promise<void> {
  await loginViaMagicLink(page, CUSTOMERS[key].email, { runJobs });
}

interface CancellationDbRow {
  canceler_type: string;
  canceler_staff_id: string | null;
  fee_cents: number;
  fee_percent: number;
  base_cents: number;
}

function cancellationsOf(processId: string): CancellationDbRow[] {
  return queryTestDb<CancellationDbRow>(
    `SELECT canceler_type::text AS canceler_type, canceler_staff_id, fee_cents, fee_percent, base_cents
       FROM cancellations WHERE process_id = $1`,
    [processId],
  );
}

function mainStatusOf(processId: string): string {
  return queryTestDb<{ main_status: string }>(
    'SELECT main_status::text AS main_status FROM processes WHERE id = $1',
    [processId],
  )[0]!.main_status;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  resetE2eDatabase();
  await clearSink();
  await clearPushRequests();
  // G: Lieferung HEUTE im Fenster (jetzt + 30 … + 90 min, Berlin) – nächster Stopp der aktiven Tour.
  const deliveryWindow = todayWindow(30, 90);
  seed = seedPortal({
    adminEmail: ADMIN_EMAIL,
    customers: Object.entries(CUSTOMERS).map(([key, customer]) => ({ key, ...customer })),
    bookings: [
      {
        key: 'anna',
        customer: 'anna',
        eventInDays: 30,
        plannedAppointments: true,
        internalNote: INTERNAL_NOTE,
      },
      // D: zuerst das spätere Event (kleinere Vorgangsnummer), dann das frühere.
      { key: 'doraLater', customer: 'dora', eventInDays: 40 },
      { key: 'doraSooner', customer: 'dora', eventInDays: 20 },
      {
        key: 'erna',
        customer: 'erna',
        eventInDays: 2,
        machineSlug: 'slush-1x10',
        approveOrderConfirmation: true,
        issuedMachineCode: 'MR-10-01-01',
      },
      {
        key: 'gerd',
        customer: 'gerd',
        fulfillment: 'delivery',
        eventInDays: 1,
        activeTour: {
          windowStart: deliveryWindow.startAt.toISOString(),
          windowEnd: deliveryWindow.endAt.toISOString(),
          driver: DRIVER,
          location: DRIVER_POINT,
        },
      },
      { key: 'hanna', customer: 'hanna', eventInDays: 30 },
      { key: 'jonas', customer: 'jonas', eventInDays: 30 },
      { key: 'karla', customer: 'karla', eventInDays: 10 },
      { key: 'olaf', customer: 'olaf', eventInDays: 30 },
    ],
    inquiries: [{ key: 'mia', customer: 'mia', sendOffer: true }],
  });
  expect(seed.copiedDocuments, 'Dokumente im Storage der E2E-API').toBeGreaterThanOrEqual(10);

  staff = await browser.newPage();
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  annaPage = await customerPage(browser);
  ernaPage = await customerPage(browser);
  hannaPage = await customerPage(browser);
});

test.afterAll(async () => {
  for (const page of [staff, annaPage, ernaPage, hannaPage]) {
    await page?.context().close();
  }
});

// ── A ─────────────────────────────────────────────────────────────────────

test('A. Magic Login: Anmeldelink nur aus der Mail (Fragment #token=), Token weder in URL noch Storage, HttpOnly-Session (SameSite=Strict), Einmal-Link', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const anna = CUSTOMERS.anna;
  // Ohne Session führt /konto zur Anmeldung.
  await annaPage.goto(`${WEB_ORIGIN}/konto`);
  await annaPage.waitForURL(`${WEB_ORIGIN}/konto/anmelden`);

  const { link, mail } = await requestMagicLinkMail(annaPage, anna.email, { runJobs });
  expectMietRoyalMail(mail);
  expect(mail.text).toContain('15 Minuten gültig');
  expect(new URL(link).pathname).toBe('/konto/anmelden');
  const token = tokenOfLink(link);
  // Datenbank: nur der SHA-256-Hash, 15 Minuten gültig; Outbox-Kontext ohne Token.
  const links = magicLinks(customerId('anna'));
  expect(links).toHaveLength(1);
  expect(links[0]!.purpose).toBe('login');
  expect(links[0]!.token_hash === sha256Hex(token), 'token_hash = sha256(token)').toBe(true);
  expect(JSON.stringify(links).includes(token), 'Klartexttoken in der DB').toBe(false);
  expect(Date.parse(links[0]!.expires_at) - Date.parse(links[0]!.created_at)).toBe(15 * MINUTE_MS);
  const outbox = outboxTo(anna.email).filter((row) => row.kind === 'customer_portal_magic_link');
  expect(outbox).toHaveLength(1);
  expect(outbox[0]!.status).toBe('sent');
  expect(JSON.stringify(outbox[0]!.context).includes(token), 'Token im Mail-Kontext').toBe(false);

  // Link öffnen: Fragment sofort entfernt, Token nur im RAM; „Kundenbereich öffnen“ (POST).
  await openMagicLink(annaPage, link);
  await annaPage.waitForURL(bookingUrl('anna')); // genau eine Buchung ⇒ direkt zur Buchung
  await expect(annaPage.getByTestId('portal-booking-view')).toBeVisible();
  await expectTokenNotInBrowser(annaPage, token);

  const session = activePortalSession(customerId('anna'));
  expect(session.created_at).toBe(session.authenticated_at);
  expect(session.reauthenticated_at).toBe(session.authenticated_at);
  const cookie = await portalCookie(annaPage);
  expect(cookie, `Cookie ${PORTAL_COOKIE_DEV}`).not.toBeNull();
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe('Strict');
  expect(cookie!.path).toBe('/');
  expect(cookie!.value === token, 'Sessiontoken ≠ Magic-Link-Token').toBe(false);
  expect(sha256Hex(cookie!.value) === session.token_hash, 'Cookie ↔ Session-Hash').toBe(true);
  expect(magicLinks(customerId('anna'))[0]!.consumed_at).not.toBeNull();
  // Kein Token in Client-Storage – auch nicht nach Navigation im Portal.
  await expectTokenNotInBrowser(annaPage, cookie!.value);

  // Einmal-Link: derselbe Link auf einem zweiten Gerät ⇒ ungültig, keine Session.
  const replay = await customerPage(browser);
  await openMagicLink(replay, link, { expect: 'invalid' });
  expect(await portalCookie(replay)).toBeNull();
  await replay.context().close();
  expect(portalSessions(customerId('anna'))).toHaveLength(1);
});

// ── B ─────────────────────────────────────────────────────────────────────

test('B. No Enumeration: unbekannte, doppelte und gelöschte Adresse ⇒ identische neutrale Antwort ohne Link; eindeutige Adresse ⇒ Link', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await customerPage(browser);
  for (const email of [UNKNOWN_EMAIL, DUPLICATE_EMAIL, TRASHED_EMAIL]) {
    await page.goto(`${WEB_ORIGIN}/konto/anmelden`);
    await page.getByTestId('portal-login-email').fill(email);
    await page.getByTestId('portal-login-submit').click();
    await expect(page.getByTestId('portal-login-neutral')).toContainText(
      PORTAL_TEXT.MAGIC_LINK_REQUESTED,
    );
  }
  // API über den Same-Origin-Proxy: Status + Body byte-identisch – auch für die eindeutige Adresse.
  const responses: string[] = [];
  for (const email of [UNKNOWN_EMAIL, DUPLICATE_EMAIL, TRASHED_EMAIL, CUSTOMERS.bernd.email]) {
    const response = await page.request.post(`${WEB_ORIGIN}/api/portal/auth/request`, {
      data: { email },
    });
    responses.push(`${response.status()}|${await response.text()}`);
  }
  expect(new Set(responses).size, 'identische Antworten').toBe(1);
  expect(responses[0]).toBe(`202|${JSON.stringify({ message: PORTAL_TEXT.MAGIC_LINK_REQUESTED })}`);

  await runJobs();
  // Eindeutige Adresse ⇒ genau ein Link; alle anderen ⇒ nichts (weder Outbox noch Senke).
  const bernd = await waitForMail({ to: CUSTOMERS.bernd.email, subject: PORTAL_SUBJECT.login });
  expect(new URL(linkFromMail(bernd, '/konto/anmelden')).hash.startsWith('#token=')).toBe(true);
  for (const email of [UNKNOWN_EMAIL, DUPLICATE_EMAIL, TRASHED_EMAIL]) {
    await expectMailCount({ to: email }, 0);
    expect(outboxTo(email), `Outbox an ${email}`).toHaveLength(0);
  }
  for (const key of ['dup1', 'dup2', 'trashed'] as const) {
    expect(magicLinks(customerId(key)), `Magic Links ${key}`).toHaveLength(0);
  }
  expect(customerRow(customerId('trashed')).deleted_at).not.toBeNull();
  expect(magicLinks(customerId('bernd'))).toHaveLength(1);
  await page.context().close();
});

// ── C ─────────────────────────────────────────────────────────────────────

test('C. Active Booking: Snapshot-Ansicht (Maschine, Event, Preis), exakter Termin vs. Zeitfenster, Abholadresse + Navigation, Anrufen, keine internen Daten, no-store', async () => {
  test.setTimeout(90_000);
  const anna = booking('anna');
  const response = await annaPage.goto(bookingUrl('anna'));
  // Nie cachebar. Hinweis: der E2E-Web-Server ist `next dev` – dort überschreibt Next den
  // konfigurierten Wert (`private, no-store, max-age=0`, next.config.ts) durch
  // „no-cache, must-revalidate“; der Produktions-Build liefert no-store (WEB-Smoke).
  expect(response?.headers()['cache-control']).toMatch(/no-store|no-cache/);
  expect(response?.headers()['x-robots-tag']).toContain('noindex');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  // Kein Kontodatum im ausgelieferten HTML (Daten nur per Fetch, kein SSG/ISR).
  const html = (await response?.text()) ?? '';
  expect(html.includes(anna.processNumber), 'Vorgangsnummer im HTML').toBe(false);
  expect(html.includes(CUSTOMERS.anna.email), 'E-Mail im HTML').toBe(false);

  const view = annaPage.getByTestId('portal-booking-view');
  await expect(view).toBeVisible();
  await expect(annaPage.getByTestId('portal-process-number')).toHaveText(anna.processNumber);
  const state = annaPage.getByTestId('portal-state-label');
  await expect(state).toHaveAttribute('data-state', 'active');
  await expect(state).toContainText('Bestätigte Buchung');
  await expect(annaPage.getByTestId('portal-event-date')).toHaveText(germanDate(anna.eventDate));

  // Maschine/Extras/Preis aus dem unveränderlichen Snapshot.
  const snapshot = queryTestDb<{
    items_snapshot: { kind: string; description: string }[];
    totals_snapshot: { fixedTotalCents: number };
  }>('SELECT items_snapshot, totals_snapshot FROM bookings WHERE id = $1', [anna.bookingId])[0]!;
  const machine = snapshot.items_snapshot.find((item) => item.kind === 'machine')!;
  await expect(annaPage.getByTestId('portal-items-machine')).toContainText(machine.description);
  await expect(annaPage.getByTestId('portal-agreed-price')).toHaveText(
    euroText(snapshot.totals_snapshot.fixedTotalCents),
  );

  // Termine: Abholung exakt (Vortag 10:00), Rückgabe als Fenster (Folgetag 10:00–12:00).
  const pickup = annaPage.locator('[data-testid="portal-appointment"][data-kind="pickup"]');
  await expect(pickup).toHaveAttribute('data-timing', 'exact');
  const dayBefore = new Date(Date.parse(`${anna.eventDate}T00:00:00Z`) - DAY_MS)
    .toISOString()
    .slice(0, 10);
  const dayAfter = new Date(Date.parse(`${anna.eventDate}T00:00:00Z`) + DAY_MS)
    .toISOString()
    .slice(0, 10);
  await expect(pickup.getByTestId('portal-appointment-time')).toContainText(
    `${germanDate(dayBefore)}, 10:00 Uhr`,
  );
  const giveBack = annaPage.locator('[data-testid="portal-appointment"][data-kind="return"]');
  await expect(giveBack).toHaveAttribute('data-timing', 'window');
  await expect(giveBack.getByTestId('portal-appointment-time')).toContainText(
    `${germanDate(dayAfter)}, 10:00–12:00 Uhr`,
  );

  // Abholung: kanonische Abholadresse + Navigation nur mit Adresse (kein Name, keine Vorgangsnummer).
  await expect(annaPage.getByTestId('portal-pickup-address')).toHaveText(PICKUP_ADDRESS);
  const navigation = annaPage.getByTestId('portal-navigation');
  await expect(navigation).toHaveText(/Navigation öffnen/);
  const navHref = (await navigation.getAttribute('href')) ?? '';
  expect(navHref).toMatch(/^https:\/\//);
  expect(decodeURIComponent(navHref.replace(/\+/g, ' '))).toContain('Teststraße 1');
  for (const forbidden of [anna.processNumber, 'Anna', 'Aktiv', anna.bookingId, 'key=']) {
    expect(navHref.includes(forbidden), `Navigation enthält ${forbidden}`).toBe(false);
  }
  // Kein Rechnungsstatus ohne Rechnung, kein „Unterwegs“ bei Selbstabholung.
  await expect(annaPage.getByTestId('portal-invoice-status')).toHaveCount(0);
  await expect(annaPage.getByTestId('portal-travel-status')).toHaveCount(0);
  // Anrufen (konfigurierte Nummer), kein WhatsApp-Button.
  await expect(annaPage.getByTestId('portal-call').first()).toHaveAttribute('href', PHONE_TEL);
  const text = await view.innerText();
  expect(text).not.toContain('WhatsApp');
  expect(text).not.toContain('INTERN');

  // DTO: keine internen Schlüssel/Notizen/IDs (Deep-Scan), keine Historie-Route.
  const detail = await portalApiGet<Record<string, unknown>>(
    annaPage,
    `/bookings/${anna.bookingId}`,
  );
  expect(detail.status).toBe(200);
  expect(detail.headers['cache-control']).toContain('no-store');
  expectNoForbiddenKeys(detail.data, 'GET /portal/bookings/:id');
  expect(JSON.stringify(detail.data).includes(INTERNAL_NOTE)).toBe(false);
  expect(JSON.stringify(detail.data).includes(machine.description)).toBe(true);
  const list = await portalApiGet<{ bookings: { bookingId: string }[] }>(annaPage, '/bookings');
  expectNoForbiddenKeys(list.data, 'GET /portal/bookings');
  expect(list.data.bookings.map((entry) => entry.bookingId)).toEqual([anna.bookingId]);
  const me = await portalApiGet(annaPage, '/me');
  expectNoForbiddenKeys(me.data, 'GET /portal/me');
  expect(
    (await portalApiGet(annaPage, '/bookings?history=1')).data,
    'kein Historie-Parameter',
  ).toEqual(list.data);
});

// ── D ─────────────────────────────────────────────────────────────────────

test('D. Multiple Current Bookings: Liste „Aktuelle Buchungen“ nach Eventdatum (dann Vorgangsnummer), Auswahl öffnet die Buchung', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await customerPage(browser);
  await login15(page, 'dora');
  await page.waitForURL(`${WEB_ORIGIN}/konto`);
  const sooner = booking('doraSooner');
  const later = booking('doraLater');
  expect(later.processNumber < sooner.processNumber, 'späteres Event hat kleinere Nummer').toBe(
    true,
  );
  await expect(page.getByRole('heading', { name: 'Aktuelle Buchungen' })).toBeVisible();
  const items = page.getByTestId('portal-booking-list').getByTestId('portal-booking-item');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).getByTestId('portal-process-number')).toHaveText(sooner.processNumber);
  await expect(items.nth(0)).toContainText(germanDate(sooner.eventDate));
  await expect(items.nth(1).getByTestId('portal-process-number')).toHaveText(later.processNumber);
  await expect(items.nth(1)).toContainText(germanDate(later.eventDate));
  for (const index of [0, 1]) {
    await expect(items.nth(index).getByTestId('portal-state-label')).toHaveAttribute(
      'data-state',
      'active',
    );
  }
  const api = await portalApiGet<{ bookings: { bookingId: string }[] }>(page, '/bookings');
  expect(api.data.bookings.map((entry) => entry.bookingId)).toEqual([
    sooner.bookingId,
    later.bookingId,
  ]);

  await items.nth(1).getByTestId('portal-booking-open').click();
  await page.waitForURL(`${WEB_ORIGIN}/konto/buchung/${later.bookingId}`);
  await expect(page.getByTestId('portal-process-number')).toHaveText(later.processNumber);
  await page.getByTestId('portal-nav-home').click();
  await page.waitForURL(`${WEB_ORIGIN}/konto`);
  await expect(page.getByTestId('portal-booking-item')).toHaveCount(2);
  await page.context().close();
});

// ── E ─────────────────────────────────────────────────────────────────────

test('E. Documents: angenommenes Angebot, Auftragsbestätigung, Lieferschein, Übergabeprotokoll – private PDFs (no-store, nosniff, sicherer Dateiname), kein Storage-Key', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const erna = booking('erna');
  await login15(ernaPage, 'erna');
  await ernaPage.waitForURL(bookingUrl('erna'));
  const items = ernaPage.getByTestId('portal-document-item');
  await expect(items).toHaveCount(4);
  const types = await items.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-type')),
  );
  expect([...types].sort()).toEqual([
    'delivery_note',
    'handover_protocol',
    'offer',
    'order_confirmation',
  ]);
  const documentsList = ernaPage.getByTestId('portal-documents');
  for (const label of [
    'Angebot (angenommen)',
    'Auftragsbestätigung',
    'Lieferschein',
    'Übergabeprotokoll',
  ]) {
    await expect(documentsList).toContainText(label);
  }

  const dbDocuments = queryTestDb<{ id: string; type: string; sha256: string }>(
    `SELECT id, type::text AS type, sha256 FROM documents WHERE process_id = $1 AND finalized_at IS NOT NULL`,
    [erna.processId],
  );
  const api = await portalApiGet<{ documents: { id: string; type: string }[] }>(
    ernaPage,
    `/bookings/${erna.bookingId}/documents`,
  );
  expect(api.status).toBe(200);
  expectNoForbiddenKeys(api.data, 'GET /portal/bookings/:id/documents');
  expect(api.data.documents.map((d) => d.id).sort()).toEqual(dbDocuments.map((d) => d.id).sort());

  const links = ernaPage.getByTestId('portal-document-link');
  await expect(links).toHaveCount(4);
  const anonymous = await customerPage(browser);
  for (let index = 0; index < 4; index += 1) {
    const link = links.nth(index);
    await expect(link).toHaveAttribute('target', '_blank');
    const href = (await link.getAttribute('href')) ?? '';
    expect(href).toMatch(
      new RegExp(`^/api/portal/bookings/${erna.bookingId}/documents/[0-9a-f-]{36}$`),
    );
    const documentId = href.split('/').pop()!;
    const expected = dbDocuments.find((d) => d.id === documentId);
    expect(expected, `Dokument ${documentId} gehört zur Buchung`).toBeDefined();
    const response = await ernaPage.request.get(`${WEB_ORIGIN}${href}`);
    expect(response.status()).toBe(200);
    const headers = response.headers();
    expect(headers['content-type']).toContain('application/pdf');
    expect(headers['cache-control']).toContain('no-store');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-disposition']).toMatch(/^inline; filename="[a-z0-9-]+\.pdf"$/);
    const body = await response.body();
    expect(body.subarray(0, 4).toString('latin1')).toBe('%PDF');
    expect(sha256Hex(body), 'Bytes = finalisiertes Dokument').toBe(expected!.sha256);
    // Ohne Session: 401, keine Bytes.
    const denied = await anonymous.request.get(`${WEB_ORIGIN}${href}`);
    expect(denied.status()).toBe(401);
    expect((await denied.body()).subarray(0, 4).toString('latin1')).not.toBe('%PDF');
  }
  await anonymous.context().close();
});

// ── F ─────────────────────────────────────────────────────────────────────

test('F. Customer Chat + Photo + Staff Reply + Mail Notice: Kunde schreibt Text + Foto, Staff sieht „Portal“ (Push ohne Text), antwortet im Kanal Portal, Kunde sieht die Antwort, Mail-Hinweis ohne Chattext', async () => {
  test.setTimeout(180_000);
  const anna = booking('anna');
  pushKeys = createPushSubscriptionKeys();
  await registerPushSubscription(staff, pushKeys, 'E2E-Erika-Portal');
  await clearPushRequests();

  // Kunde: Text + Foto im Portal.
  await annaPage.goto(bookingUrl('anna'));
  await expect(annaPage.getByTestId('portal-messages-empty')).toBeVisible();
  await annaPage.getByTestId('portal-message-body').fill(CUSTOMER_MESSAGE);
  await annaPage
    .getByTestId('portal-message-photo')
    .setInputFiles({ name: 'stellplatz.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(annaPage.getByTestId('portal-message-photo-count')).toHaveText('1 Bild ausgewählt');
  await annaPage.getByTestId('portal-message-send').click();
  const own = annaPage.locator('[data-testid="portal-message-item"][data-from="customer"]');
  await expect(own).toHaveCount(1);
  await expect(own).toContainText(CUSTOMER_MESSAGE);
  await expect(own.getByTestId('portal-message-photo-image')).toBeVisible();

  const messages = queryTestDb<{ id: string; channel: string; direction: string }>(
    `SELECT id, channel::text AS channel, direction::text AS direction FROM conversation_messages
      WHERE process_id = $1 AND is_system_event = false ORDER BY created_at ASC`,
    [anna.processId],
  );
  expect(messages).toEqual([expect.objectContaining({ channel: 'portal', direction: 'inbound' })]);
  annaMessageId = messages[0]!.id;
  const photos = queryTestDb<{ id: string; mime_type: string }>(
    'SELECT id, mime_type FROM message_photos WHERE message_id = $1',
    [annaMessageId],
  );
  expect(photos).toHaveLength(1);
  expect(photos[0]!.mime_type).toBe('image/png');
  annaPhotoId = photos[0]!.id;
  // Foto-Route: private Bytes, no-store, nosniff.
  const photo = await annaPage.request.get(
    `${WEB_ORIGIN}/api/portal/bookings/${anna.bookingId}/messages/${annaMessageId}/photos/${annaPhotoId}`,
  );
  expect(photo.status()).toBe(200);
  expect(photo.headers()['content-type']).toContain('image/png');
  expect(photo.headers()['cache-control']).toContain('no-store');
  expect(photo.headers()['x-content-type-options']).toBe('nosniff');
  expect(Buffer.compare(await photo.body(), PNG_1X1)).toBe(0);

  // Interne Benachrichtigung: Push „Neue Kundennachricht – MR-…“ ohne Nachrichtentext/Foto.
  await runJobs();
  const [push] = await expectPushCount(pushKeys, `Neue Kundennachricht – ${anna.processNumber}`, 1);
  expect(push!.plaintext.includes('Stellplatz'), 'Push enthält Nachrichtentext').toBe(false);
  expect(push!.payload.body).toBe('Im Kundenportal eingegangen – in Miet-Royal prüfen');
  expect(push!.payload.url).toContain(`/vorgaenge/${anna.processId}/kommunikation`);

  // Staff: Nachricht mit Badge „Portal“, Hinweis „Kundenportal aktiv“, Antwort im Kanal Portal.
  await staff.goto(`/vorgaenge/${anna.processId}/kommunikation`);
  const inbound = staff.locator('[data-testid="conversation-message"][data-channel="portal"]');
  await expect(inbound).toHaveCount(1);
  await expect(inbound.getByTestId('conversation-channel-badge')).toHaveText('Portal');
  await expect(inbound.getByTestId('conversation-body')).toHaveText(CUSTOMER_MESSAGE);
  await expect(inbound.getByTestId('conversation-photos')).toBeVisible();
  await expect(staff.getByTestId('portal-active-hint')).toBeVisible();
  await staff.getByTestId('reply-channel-portal').check();
  await staff.getByTestId('reply-body').fill(STAFF_REPLY);
  await expect(staff.getByTestId('reply-submit')).toHaveText('Im Kundenportal antworten');
  await staff.getByTestId('reply-submit').click();
  await expect(staff.getByTestId('reply-success')).toContainText(
    'Antwort im Kundenportal veröffentlicht',
  );
  await expect(
    staff.locator(
      '[data-testid="conversation-message"][data-channel="portal"][data-direction="outbound"]',
    ),
  ).toContainText(STAFF_REPLY);

  // Mail-Hinweis: fester Text + Link /konto – ohne Chattext.
  await runJobs();
  const noticeFilter = {
    to: CUSTOMERS.anna.email,
    subject: PORTAL_SUBJECT.replyNotice(anna.processNumber),
  };
  const notice = await waitForMail(noticeFilter);
  expectMietRoyalMail(notice);
  expect(notice.text).toContain(PORTAL_TEXT.REPLY_NOTICE);
  expect(linkFromMail(notice, '/konto')).toBe(`${WEB_ORIGIN}/konto`);
  for (const fragment of ['Stellplatz', 'Antwort-E2E-7319']) {
    expect(notice.text.includes(fragment), `Mailtext enthält ${fragment}`).toBe(false);
    expect(notice.html.includes(fragment), `Mail-HTML enthält ${fragment}`).toBe(false);
  }
  await expectMailCount(noticeFilter, 1);

  // Kunde sieht die Antwort (ohne Mitarbeitername).
  await annaPage.reload();
  const reply = annaPage.locator('[data-testid="portal-message-item"][data-from="miet_royal"]');
  await expect(reply).toHaveCount(1);
  await expect(reply).toContainText(STAFF_REPLY);
  await expect(reply).toContainText('Miet-Royal');
  await expect(annaPage.getByTestId('portal-messages')).not.toContainText('Erika');
  const api = await portalApiGet<{ messages: unknown[]; canSend: boolean }>(
    annaPage,
    `/bookings/${anna.bookingId}/messages`,
  );
  expect(api.data.canSend).toBe(true);
  expect(api.data.messages).toHaveLength(2);
  expectNoForbiddenKeys(api.data, 'GET /portal/bookings/:id/messages');
  expect(JSON.stringify(api.data).includes('Erika')).toBe(false);
});

// ── G ─────────────────────────────────────────────────────────────────────

test('G. „Unterwegs“ ohne GPS/ETA/Fahrer: aktive Tour mit nächstem Stopp beim Kunden ⇒ Badge „Unterwegs“; keine Koordinaten, keine ETA/Minuten, kein Fahrername', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const gerd = booking('gerd');
  const page = await customerPage(browser);
  await login15(page, 'gerd');
  await page.waitForURL(bookingUrl('gerd'));
  const badge = page.getByTestId('portal-travel-status');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText(/Unterwegs/);
  const address = page.getByTestId('portal-delivery-address');
  await expect(address).toContainText('Lieferweg 12');
  await expect(address).toContainText('55129 Mainz');

  const text = await page.locator('body').innerText();
  for (const forbidden of [
    DRIVER.firstName,
    DRIVER.lastName,
    '49.96',
    '49,96',
    '8.274',
    '8,274',
    'ETA',
    'Ankunft',
    'voraussichtlich',
  ]) {
    expect(text.includes(forbidden), `Seite enthält ${forbidden}`).toBe(false);
  }
  const deliverySection = page.locator('section[aria-labelledby="portal-delivery-title"]');
  expect(/\d+\s*(min|Min\.|Minute)/.test(await deliverySection.innerText())).toBe(false);
  await expect(page.locator('iframe, canvas')).toHaveCount(0);

  const status = await portalApiGet(page, `/bookings/${gerd.bookingId}/travel-status`);
  expect(status.status).toBe(200);
  expect(status.data).toEqual({ status: 'en_route' });
  const detail = await portalApiGet<{ travelStatus: string }>(page, `/bookings/${gerd.bookingId}`);
  expect(detail.data.travelStatus).toBe('en_route');
  expectNoForbiddenKeys(detail.data, 'GET /portal/bookings/:id (Lieferung)');
  const json = JSON.stringify(detail.data);
  for (const forbidden of [DRIVER.firstName, DRIVER.lastName, '49.96', '8.274']) {
    expect(json.includes(forbidden), `DTO enthält ${forbidden}`).toBe(false);
  }
  // Andere Buchungen (nicht nächster Stopp, Selbstabholung) sind nie „Unterwegs“.
  expect(
    (await portalApiGet(annaPage, `/bookings/${booking('anna').bookingId}/travel-status`)).data,
  ).toEqual({ status: 'none' });
  await page.context().close();
});

// ── H ─────────────────────────────────────────────────────────────────────

test('H. Profile Reauth: Mutation ohne frische Bestätigung blockiert ⇒ Bestätigungslink (Mail, sessiongebunden) ⇒ speichern; Sessionablauf unverändert, Buchungs-Snapshot unverändert', async () => {
  test.setTimeout(180_000);
  const hannaId = customerId('hanna');
  await login15(hannaPage, 'hanna');
  await hannaPage.waitForURL(bookingUrl('hanna'));
  const fresh = activePortalSession(hannaId);
  expect(fresh.reauthenticated_at).toBe(fresh.authenticated_at);
  // Reine Zeitverschiebung: Login-Bestätigung liegt 20 min zurück (> 15 min Frische).
  shiftPortalSession(fresh.id, 20 * MINUTE_MS, { onlyReauth: true });
  const session = activePortalSession(hannaId);
  const snapshotsBefore = bookingSnapshots(booking('hanna').bookingId);
  const phoneBefore = customerRow(hannaId).phone;

  await hannaPage.getByTestId('portal-nav-profile').click();
  await hannaPage.waitForURL(`${WEB_ORIGIN}/konto/profil`);
  await expect(hannaPage.getByTestId('portal-profile-hint')).toContainText(
    PORTAL_TEXT.PROFILE_HINT,
  );
  await expect(hannaPage.getByTestId('portal-profile-email')).toHaveText(CUSTOMERS.hanna.email);
  await expect(hannaPage.getByTestId('portal-profile-firstName')).toHaveValue('Hanna');
  await hannaPage.getByTestId('portal-profile-phone').fill('0171 2223344');
  await hannaPage.getByTestId('portal-profile-billingCity').fill('Mainz');
  await hannaPage.getByTestId('portal-profile-save').click();
  await expect(hannaPage.getByTestId('portal-reauth-panel')).toBeVisible();
  await expect(hannaPage.getByTestId('portal-profile-saved')).toHaveCount(0);
  expect(customerRow(hannaId).phone).toBe(phoneBefore);

  // Bestätigungslink anfordern ⇒ Mail an die aktuelle Adresse.
  const filter = { to: CUSTOMERS.hanna.email, subject: PORTAL_SUBJECT.reauth };
  const before = (await mailsMatching(filter)).length;
  await hannaPage.getByTestId('portal-reauth-request').click();
  await expect(hannaPage.getByTestId('portal-reauth-sent')).toBeVisible();
  await runJobs();
  const mail = await waitForMail(filter, { count: before + 1 });
  expectMietRoyalMail(mail);
  const link = linkFromMail(mail, '/konto/profil/bestaetigen');
  const token = tokenOfLink(link);
  const reauthLinks = magicLinks(hannaId).filter((row) => row.purpose === 'reauth');
  expect(reauthLinks).toHaveLength(1);
  expect(reauthLinks[0]!.session_id).toBe(session.id);
  expect(reauthLinks[0]!.token_hash === sha256Hex(token)).toBe(true);

  await hannaPage.goto('about:blank'); // frischer Seitenaufruf wie ein Klick in der Mail
  await hannaPage.goto(link);
  await expect(hannaPage.getByTestId('portal-reauth-page')).toBeVisible();
  await expectTokenNotInBrowser(hannaPage, token);
  await hannaPage.getByTestId('portal-reauth-confirm').click();
  await expect(hannaPage.getByTestId('portal-reauth-done')).toBeVisible();
  await expect.poll(() => new URL(hannaPage.url()).search).toBe('');
  expect(new URL(hannaPage.url()).pathname).toBe('/konto/profil');

  const confirmed = activePortalSession(hannaId);
  expect(confirmed.id).toBe(session.id);
  expect(confirmed.expires_at, 'Reauth verlängert die Session nicht').toBe(session.expires_at);
  expect(confirmed.created_at).toBe(session.created_at);
  expect(Date.parse(confirmed.reauthenticated_at)).toBeGreaterThan(
    Date.parse(session.reauthenticated_at),
  );

  // Jetzt speichern.
  await hannaPage.getByTestId('portal-profile-phone').fill('0171 2223344');
  await hannaPage.getByTestId('portal-profile-billingCity').fill('Mainz');
  await hannaPage.getByTestId('portal-profile-save').click();
  await expect(hannaPage.getByTestId('portal-profile-saved')).toBeVisible();
  expect(customerRow(hannaId).phone ?? '').toContain('2223344');
  expect(bookingSnapshots(booking('hanna').bookingId), 'Snapshot unverändert').toBe(
    snapshotsBefore,
  );

  // Der Bestätigungslink ist einmalig.
  await hannaPage.goto('about:blank'); // frischer Seitenaufruf wie ein Klick in der Mail
  await hannaPage.goto(link);
  await hannaPage.getByTestId('portal-reauth-confirm').click();
  await expect(hannaPage.getByTestId('portal-error')).toBeVisible();
});

// ── I ─────────────────────────────────────────────────────────────────────

test('I. Email Change + Session Revoke: Link an die NEUE Adresse, alte bleibt bis zur Bestätigung aktiv; danach alle Sessions widerrufen, Login nur noch mit neuer Adresse', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const hannaId = customerId('hanna');
  const oldEmail = CUSTOMERS.hanna.email;
  const snapshotsBefore = bookingSnapshots(booking('hanna').bookingId);
  // Zweites Gerät mit eigener Session.
  const second = await customerPage(browser);
  await login15(second, 'hanna');
  expect(portalSessions(hannaId).filter((row) => row.revoked_at === null)).toHaveLength(2);

  // Wechsel anstoßen (Reauth aus H ist noch frisch).
  await hannaPage.goto(`${WEB_ORIGIN}/konto/profil`);
  await hannaPage.getByTestId('portal-email-change-input').fill(HANNA_NEW_EMAIL);
  await hannaPage.getByTestId('portal-email-change-submit').click();
  await expect(hannaPage.getByTestId('portal-email-change-sent')).toBeVisible();
  await runJobs();
  const mail = await waitForMail({ to: HANNA_NEW_EMAIL, subject: PORTAL_SUBJECT.emailChange });
  expectMietRoyalMail(mail);
  expect(mail.text).toContain('Bis zur Bestätigung bleibt deine bisherige Adresse aktiv.');
  const link = linkFromMail(mail, '/konto/profil/e-mail-bestaetigen');
  const token = tokenOfLink(link);
  await expectMailCount({ to: oldEmail, subject: PORTAL_SUBJECT.emailChange }, 0);
  const pending = magicLinks(hannaId).filter((row) => row.purpose === 'email_change');
  expect(pending).toHaveLength(1);
  expect(pending[0]!.proposed_email).toBe(HANNA_NEW_EMAIL);

  // Bis zur Bestätigung gilt die alte Adresse.
  expect(customerRow(hannaId).email).toBe(oldEmail);
  await hannaPage.reload();
  await expect(hannaPage.getByTestId('portal-profile-email')).toHaveText(oldEmail);

  // Bestätigung auf einem dritten Gerät (ohne Session – Gerätewechsel).
  const device = await customerPage(browser);
  await device.goto('about:blank'); // frischer Seitenaufruf wie ein Klick in der Mail
  await device.goto(link);
  await expect(device.getByTestId('portal-email-change-page')).toBeVisible();
  await expectTokenNotInBrowser(device, token);
  await device.getByTestId('portal-email-change-confirm').click();
  await expect(device.getByTestId('portal-email-changed')).toContainText(PORTAL_TEXT.EMAIL_CHANGED);
  expect(customerRow(hannaId).email).toBe(HANNA_NEW_EMAIL);
  expect(
    portalSessions(hannaId).every((row) => row.revoked_at !== null),
    'alle Sessions widerrufen',
  ).toBe(true);
  expect(
    magicLinks(hannaId).filter((row) => row.consumed_at === null && row.revoked_at === null),
    'keine offenen Links',
  ).toHaveLength(0);
  expect(bookingSnapshots(booking('hanna').bookingId), 'Snapshot unverändert').toBe(
    snapshotsBefore,
  );

  // Beide angemeldeten Geräte sind abgemeldet.
  for (const page of [hannaPage, second]) {
    await page.goto(`${WEB_ORIGIN}/konto`);
    await page.waitForURL(`${WEB_ORIGIN}/konto/anmelden`);
    expect((await portalApiGet(page, '/me')).status).toBe(401);
  }
  // Einmal-Link.
  await device.goto('about:blank'); // frischer Seitenaufruf wie ein Klick in der Mail
  await device.goto(link);
  await device.getByTestId('portal-email-change-confirm').click();
  await expect(device.getByTestId('portal-error')).toBeVisible();
  await device.context().close();
  await second.context().close();

  // Alte Adresse: neutrale Antwort, aber kein Link mehr.
  const oldLinksBefore = outboxTo(oldEmail).filter(
    (row) => row.kind === 'customer_portal_magic_link',
  ).length;
  await hannaPage.getByTestId('portal-login-email').fill(oldEmail);
  await hannaPage.getByTestId('portal-login-submit').click();
  await expect(hannaPage.getByTestId('portal-login-neutral')).toContainText(
    PORTAL_TEXT.MAGIC_LINK_REQUESTED,
  );
  await runJobs();
  expect(
    outboxTo(oldEmail).filter((row) => row.kind === 'customer_portal_magic_link'),
  ).toHaveLength(oldLinksBefore);
  // Neue Adresse: Login funktioniert.
  await loginViaMagicLink(hannaPage, HANNA_NEW_EMAIL, { runJobs });
  await hannaPage.waitForURL(bookingUrl('hanna'));
  await expect(hannaPage.getByTestId('portal-process-number')).toHaveText(
    booking('hanna').processNumber,
  );
});

// ── J ─────────────────────────────────────────────────────────────────────

test('J. Free Cancellation: ≥ 15 Tage ⇒ „Stornogebühr: 0,00 €“, bewusste Bestätigung, Storno als Kunde, Bestätigungsmail; danach nicht mehr im Dashboard', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const jonas = booking('jonas');
  const page = await customerPage(browser);
  await login15(page, 'jonas');
  await page.waitForURL(bookingUrl('jonas'));

  const preview = await portalApiGet<Record<string, unknown>>(
    page,
    `/bookings/${jonas.bookingId}/cancellation/preview`,
  );
  expect(Object.keys(preview.data).sort()).toEqual([
    'allowed',
    'baseCents',
    'blockedMessage',
    'eventDate',
    'feeCents',
    'feePercent',
    'remainingDays',
  ]);
  expect(preview.data).toMatchObject({
    allowed: true,
    feePercent: 0,
    feeCents: 0,
    baseCents: 12_000,
    blockedMessage: null,
    eventDate: jonas.eventDate,
  });

  await page.getByTestId('portal-cancel-open').click();
  const dialog = page.getByTestId('portal-cancel-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('portal-cancellation-fee')).toHaveText('Stornogebühr: 0,00 €');
  await expect(dialog).toContainText('Die Stornierung ist für dich kostenfrei.');
  await expect(dialog.getByTestId('portal-cancel-confirm')).toHaveText(
    'Buchung verbindlich stornieren',
  );
  await dialog.getByTestId('portal-cancel-confirm').click();
  const cancelled = page.getByTestId('portal-cancelled-view');
  await expect(cancelled).toContainText('Buchung storniert');
  await expect(cancelled.getByTestId('portal-cancellation-fee')).toHaveText('0,00 €');
  await expect(page.getByTestId('portal-invoice-follows')).toHaveCount(0);
  await expect(page.getByTestId('portal-state-label')).toHaveAttribute(
    'data-state',
    'cancelled_free',
  );
  await expect(page.getByTestId('portal-cancel-section')).toHaveCount(0);
  await expect(page.getByTestId('portal-messages-closed')).toBeVisible();

  expect(cancellationsOf(jonas.processId)).toEqual([
    {
      canceler_type: 'customer',
      canceler_staff_id: null,
      fee_cents: 0,
      fee_percent: 0,
      base_cents: 12_000,
    },
  ]);
  expect(mainStatusOf(jonas.processId)).toBe('cancelled');
  // Doppelklick/Wiederholung: idempotent – keine zweite Stornierung.
  const again = await portalApiPost(page, `/bookings/${jonas.bookingId}/cancellation`, {
    confirm: true,
  });
  expect(again.status).toBe(200);
  expect(cancellationsOf(jonas.processId)).toHaveLength(1);

  // Automatische Stornobestätigung (genau eine Mail).
  await runJobs();
  const filter = {
    to: CUSTOMERS.jonas.email,
    subject: PORTAL_SUBJECT.cancellation(jonas.processNumber),
  };
  const mail = await waitForMail(filter);
  expectMietRoyalMail(mail);
  await runJobs();
  await expectMailCount(filter, 1);

  // 0-€-Storno: danach nicht mehr in der Übersicht ⇒ „Neue Anfrage starten“.
  await page.goto(`${WEB_ORIGIN}/konto`);
  await expect(page.getByTestId('portal-no-booking')).toBeVisible();
  expect((await portalApiGet<{ bookings: unknown[] }>(page, '/bookings')).data.bookings).toEqual(
    [],
  );
  await page.context().close();
});

// ── K ─────────────────────────────────────────────────────────────────────

test('K. Paid Cancellation Fee: 7–14 Tage ⇒ 50 % der regulären Maschinenmiete, exakte Gebühr vor der Bestätigung, „Rechnung folgt“, sichtbar bis bezahlt', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const karla = booking('karla');
  const page = await customerPage(browser);
  await login15(page, 'karla');
  await page.waitForURL(bookingUrl('karla'));

  const preview = await portalApiGet<{
    allowed: boolean;
    feePercent: number;
    baseCents: number;
    feeCents: number;
    remainingDays: number;
  }>(page, `/bookings/${karla.bookingId}/cancellation/preview`);
  expect(preview.data).toMatchObject({
    allowed: true,
    feePercent: 50,
    baseCents: 12_000,
    feeCents: 6_000,
  });
  expect(preview.data.remainingDays).toBeGreaterThanOrEqual(7);
  expect(preview.data.remainingDays).toBeLessThanOrEqual(14);
  expectNoForbiddenKeys(preview.data, 'Storno-Vorschau');

  await page.getByTestId('portal-cancel-open').click();
  const dialog = page.getByTestId('portal-cancel-dialog');
  await expect(dialog.getByTestId('portal-cancellation-fee')).toHaveText('Stornogebühr: 60,00 €');
  await expect(dialog).toContainText('Reguläre Maschinenmiete: 120,00 €');
  await expect(dialog).toContainText('Stornosatz 50 %');
  await expect(dialog).toContainText(germanDate(karla.eventDate));
  await expect(dialog).toContainText('Die Rechnung folgt.');
  await dialog.getByTestId('portal-cancel-confirm').click();

  const cancelled = page.getByTestId('portal-cancelled-view');
  await expect(cancelled).toContainText('Buchung storniert');
  await expect(cancelled.getByTestId('portal-cancellation-fee')).toHaveText('60,00 €');
  await expect(cancelled).toContainText('(50 %)');
  await expect(page.getByTestId('portal-invoice-follows')).toContainText('Rechnung folgt');
  await expect(page.getByTestId('portal-state-label')).toHaveAttribute(
    'data-state',
    'cancelled_fee',
  );
  expect(cancellationsOf(karla.processId)).toEqual([
    {
      canceler_type: 'customer',
      canceler_staff_id: null,
      fee_cents: 6_000,
      fee_percent: 50,
      base_cents: 12_000,
    },
  ]);

  await runJobs();
  const filter = {
    to: CUSTOMERS.karla.email,
    subject: PORTAL_SUBJECT.cancellation(karla.processNumber),
  };
  const mail = await waitForMail(filter);
  expect(mail.text).toContain('60,00');
  await expectMailCount(filter, 1);

  // Kostenpflichtig storniert + finanziell offen ⇒ bleibt sichtbar (einzige Buchung ⇒ direkt dorthin).
  await page.goto(`${WEB_ORIGIN}/konto`);
  await page.waitForURL(bookingUrl('karla'));
  await expect(page.getByTestId('portal-state-label')).toContainText('Storniert – Stornogebühr');
  await expect(page.getByTestId('portal-cancelled-view')).toBeVisible();
  const invoice = page.getByTestId('portal-invoice-status');
  await expect(invoice).toBeVisible();
  expect(['preparing', 'open']).toContain(await invoice.getAttribute('data-status'));
  const detail = await portalApiGet(page, `/bookings/${karla.bookingId}`);
  expectNoForbiddenKeys(detail.data, 'stornierte Buchung');
  await page.context().close();
});

// ── L ─────────────────────────────────────────────────────────────────────

test('L. Cancellation Blocked: Übergabe abgeschlossen ⇒ kein Online-Storno, verständlicher Kundentext + Anrufen, API 409 ohne interne Gründe', async () => {
  test.setTimeout(90_000);
  const erna = booking('erna');
  await ernaPage.goto(bookingUrl('erna'));
  const section = ernaPage.getByTestId('portal-cancel-section');
  await expect(section).toBeVisible();
  await expect(section.getByTestId('portal-cancel-unavailable')).toHaveText(
    PORTAL_TEXT.CANCELLATION_BLOCKED,
  );
  await expect(section.getByTestId('portal-call')).toHaveAttribute('href', PHONE_TEL);
  await expect(ernaPage.getByTestId('portal-cancel-open')).toHaveCount(0);

  const preview = await portalApiGet<Record<string, unknown>>(
    ernaPage,
    `/bookings/${erna.bookingId}/cancellation/preview`,
  );
  expect(preview.status).toBe(200);
  expect(preview.data).toMatchObject({
    allowed: false,
    blockedMessage: PORTAL_TEXT.CANCELLATION_BLOCKED,
  });
  const attempt = await portalApiPost<{ error: { code: string; message: string } }>(
    ernaPage,
    `/bookings/${erna.bookingId}/cancellation`,
    { confirm: true },
  );
  expect(attempt.status).toBe(409);
  expect(attempt.data.error.code).toBe('PORTAL_CANCELLATION_BLOCKED');
  expect(attempt.data.error.message).toBe(PORTAL_TEXT.CANCELLATION_BLOCKED);
  for (const internal of ['Übergabe', 'ausgegeben', 'Rückgabe', 'Maschine']) {
    expect(JSON.stringify(preview.data).includes(internal), `Vorschau: ${internal}`).toBe(false);
    expect(JSON.stringify(attempt.data).includes(internal), `409: ${internal}`).toBe(false);
  }
  expect(cancellationsOf(erna.processId)).toHaveLength(0);
  expect(mainStatusOf(erna.processId)).toBe('open');
  const detail = await portalApiGet<{ canCancelOnline: boolean; portalState: string }>(
    ernaPage,
    `/bookings/${erna.bookingId}`,
  );
  expect(detail.data).toMatchObject({ canCancelOnline: false, portalState: 'active' });
});

// ── M ─────────────────────────────────────────────────────────────────────

test('M. No Active Booking → Neue Anfrage: nur Anfrage + versendetes Angebot ⇒ keine Portalbuchung, Hauptaktion „Neue Anfrage starten“ (konfigurierte URL)', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const page = await customerPage(browser);
  await login15(page, 'mia');
  await page.waitForURL(`${WEB_ORIGIN}/konto`);
  const card = page.getByTestId('portal-no-booking');
  await expect(card).toBeVisible();
  await expect(card).toContainText('Aktuell liegt keine laufende Buchung für dich vor.');
  const action = page.getByTestId('portal-new-inquiry');
  await expect(action).toHaveText('Neue Anfrage starten');
  await expect(action).toHaveAttribute('href', NEW_INQUIRY_URL);
  await expect(action).toHaveAttribute('rel', 'noreferrer');
  await expect(page.getByTestId('portal-booking-list')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(seed.inquiries['mia']!.processNumber);
  const list = await portalApiGet<{ bookings: unknown[] }>(page, '/bookings');
  expect(list.data.bookings).toEqual([]);
  const me = await portalApiGet<{ links: { newInquiryUrl: string; phoneNumber: string } }>(
    page,
    '/me',
  );
  expect(me.data.links).toEqual({ newInquiryUrl: NEW_INQUIRY_URL, phoneNumber: '+49 6131 000000' });
  // Anfrage-Vorgang ist keine Buchung (auch nicht per Direktaufruf).
  expect((await portalApiGet(page, `/bookings/${seed.inquiries['mia']!.processId}`)).status).toBe(
    404,
  );
  await page.context().close();
});

// ── O ─────────────────────────────────────────────────────────────────────

test('O. 30-Day Session / no sliding: Ablauf exakt 30 Tage nach Login, Aktivität (last_seen) verschiebt ihn nicht, danach Anmeldung nötig', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const olafId = customerId('olaf');
  const page = await customerPage(browser);
  await login15(page, 'olaf');
  await page.waitForURL(bookingUrl('olaf'));
  const initial = activePortalSession(olafId);
  expect(Date.parse(initial.expires_at) - Date.parse(initial.created_at)).toBe(30 * DAY_MS);
  const cookie = await portalCookie(page);
  expect(cookie).not.toBeNull();
  expect(Math.abs(cookie!.expires * 1000 - Date.parse(initial.expires_at))).toBeLessThan(5_000);

  // Zeitverschiebung: Login liegt 30 Tage minus 2 Minuten zurück (Ablauf in ≈ 2 min).
  shiftPortalSession(initial.id, 30 * DAY_MS - 2 * MINUTE_MS, { clearLastSeen: true });
  const aged = activePortalSession(olafId);
  expect(Date.parse(aged.expires_at) - Date.parse(aged.created_at)).toBe(30 * DAY_MS);
  expect(Date.parse(aged.expires_at) - Date.now()).toBeLessThan(2 * MINUTE_MS + 5_000);

  // Aktivität kurz vor Ablauf: Seiten + /me (touch) ⇒ last_seen_at gesetzt, expires_at unverändert.
  await page.goto(`${WEB_ORIGIN}/konto`);
  await page.waitForURL(bookingUrl('olaf'));
  await expect(page.getByTestId('portal-booking-view')).toBeVisible();
  const me = await portalApiGet<{ session: { expiresAt: string } }>(page, '/me');
  expect(me.status).toBe(200);
  expect(Date.parse(me.data.session.expiresAt)).toBe(Date.parse(aged.expires_at));
  const active = activePortalSession(olafId);
  expect(active.last_seen_at, 'Aktivität protokolliert').not.toBeNull();
  expect(active.expires_at, 'kein Sliding').toBe(aged.expires_at);
  expect(active.created_at).toBe(aged.created_at);
  const cookieAfter = await portalCookie(page);
  expect(cookieAfter!.expires).toBe(cookie!.expires);

  // Weitere 3 Minuten ⇒ 30 Tage überschritten: Session ungültig trotz frischer Aktivität.
  shiftPortalSession(initial.id, 3 * MINUTE_MS);
  await page.goto(`${WEB_ORIGIN}/konto`);
  await page.waitForURL(`${WEB_ORIGIN}/konto/anmelden`);
  const denied = await portalApiGet<{ error: { code: string } }>(page, '/me');
  expect(denied.status).toBe(401);
  expect(denied.data.error.code).toBe('PORTAL_UNAUTHENTICATED');
  expect(await portalCookie(page), 'Cookie gelöscht').toBeNull();
  expect(portalSessions(olafId)).toHaveLength(1);
  await page.context().close();
});

// ── P ─────────────────────────────────────────────────────────────────────

test('P. IDOR mit zwei Customers: fremde Buchung/Dokumente/Nachrichten/Fotos/Storno ⇒ neutral 404; Client-IDs abgelehnt; Staff-Session ist keine Portal-Session; Logout', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const anna = booking('anna');
  const erna = booking('erna');
  expect(annaMessageId).not.toBe('');
  const ernaDocument = queryTestDb<{ id: string }>(
    `SELECT id FROM documents WHERE process_id = $1 AND type = 'offer'`,
    [erna.processId],
  )[0]!.id;
  const notFound = async (
    page: Page,
    path: string,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown,
  ) => {
    const response =
      method === 'GET'
        ? await portalApiGet(page, path)
        : await portalApiPost(page, path, body ?? {});
    expect(response.status, `${method} ${path}`).toBe(404);
    expect(response.data).toMatchObject({ error: { code: 'NOT_FOUND' } });
  };

  // Anna (Session A) gegen Ernas Buchung.
  for (const path of [
    `/bookings/${erna.bookingId}`,
    `/bookings/${erna.bookingId}/documents`,
    `/bookings/${erna.bookingId}/documents/${ernaDocument}`,
    `/bookings/${erna.bookingId}/messages`,
    `/bookings/${erna.bookingId}/travel-status`,
    `/bookings/${erna.bookingId}/cancellation/preview`,
    // Fremdes Dokument über die EIGENE Buchung.
    `/bookings/${anna.bookingId}/documents/${ernaDocument}`,
    // Ungültige ID ⇒ ebenfalls neutral 404.
    '/bookings/kein-uuid',
  ]) {
    await notFound(annaPage, path);
  }
  await notFound(annaPage, `/bookings/${erna.bookingId}/messages`, 'POST', { body: 'IDOR-Test' });
  await notFound(annaPage, `/bookings/${erna.bookingId}/cancellation`, 'POST', { confirm: true });
  expect(cancellationsOf(erna.processId)).toHaveLength(0);
  expect(
    queryTestDb('SELECT id FROM conversation_messages WHERE process_id = $1', [erna.processId]),
  ).toHaveLength(0);

  // Erna (Session E) gegen Annas Nachricht/Foto (auch über die eigene Buchung).
  for (const path of [
    `/bookings/${anna.bookingId}/messages`,
    `/bookings/${anna.bookingId}/messages/${annaMessageId}/photos/${annaPhotoId}`,
    `/bookings/${erna.bookingId}/messages/${annaMessageId}/photos/${annaPhotoId}`,
  ]) {
    await notFound(ernaPage, path);
  }
  // UI: fremde Buchung ⇒ neutrale Karte ohne Daten.
  await annaPage.goto(bookingUrl('erna'));
  await expect(annaPage.getByTestId('portal-booking-not-available')).toBeVisible();
  await expect(annaPage.locator('body')).not.toContainText(erna.processNumber);
  // Listen nur eigene Buchungen.
  expect(
    (
      await portalApiGet<{ bookings: { bookingId: string }[] }>(annaPage, '/bookings')
    ).data.bookings.map((entry) => entry.bookingId),
  ).toEqual([anna.bookingId]);

  // Client sendet nie Autorität: customerId/senderCustomerId ⇒ 400 (strict).
  const forged = await portalApiPost(annaPage, `/bookings/${anna.bookingId}/messages`, {
    body: 'Absender gefälscht',
    customerId: customerId('erna'),
  });
  expect(forged.status).toBe(400);
  const forgedProfile = await annaPage.request.patch(`${WEB_ORIGIN}/api/portal/profile`, {
    data: { customerId: customerId('erna'), firstName: 'Gekapert' },
  });
  expect([400, 403]).toContain(forgedProfile.status());
  expect(customerRow(customerId('erna')).email).toBe(CUSTOMERS.erna.email);
  expect(
    queryTestDb<{ first_name: string }>('SELECT first_name FROM customers WHERE id = $1', [
      customerId('erna'),
    ])[0]!.first_name,
  ).toBe('Erna');

  // Ohne Session bzw. mit Staff-Session: 401.
  const anonymous = await customerPage(browser);
  expect((await portalApiGet(anonymous, `/bookings/${anna.bookingId}`)).status).toBe(401);
  await anonymous.context().close();
  const staffAsCustomer = await staff.request.get(`${WEB_ORIGIN}/api/portal/me`);
  expect(staffAsCustomer.status()).toBe(401);

  // Logout: Session widerrufen, Cookie gelöscht, zurück zur Anmeldung.
  const annaSession = activePortalSession(customerId('anna'));
  await annaPage.goto(bookingUrl('anna'));
  await annaPage.getByTestId('portal-logout').click();
  await annaPage.waitForURL(`${WEB_ORIGIN}/konto/anmelden`);
  expect(await portalCookie(annaPage)).toBeNull();
  expect(
    portalSessions(customerId('anna')).find((row) => row.id === annaSession.id)!.revoked_at,
  ).not.toBeNull();
  await annaPage.goto(bookingUrl('anna'));
  await annaPage.waitForURL(`${WEB_ORIGIN}/konto/anmelden`);
});
