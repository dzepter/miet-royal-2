import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page, type Response } from '@playwright/test';
import { E2E_STORAGE_ROOT } from './jobs.ts';
import { linkFromMail, mailsMatching, waitForMail, type SinkMail } from './mail.ts';
import { TEST_DATABASE_URL, WEB_ORIGIN } from './seed.ts';
import { queryTestDb } from './voucher.ts';

/**
 * Phase 15 (E2E): Helfer der Kundenportal-Szenarien A–P (portal-flow.spec.ts,
 * Projekt `chromium`) und N (portal-demo.spec.ts, Projekt `demo-communication`).
 *
 * - Testdaten: Kindprozess apps/api/scripts/e2e-portal-seed.ts (echte
 *   Fachservices der API, Sicherheitsstopp auf mietroyal_test*, Ausgabe nur
 *   IDs/Vorgangsnummern – nie Tokens).
 * - Anmeldung AUSSCHLIESSLICH über die echte Magic-Link-Mail aus der SMTP-Senke:
 *   Formular /konto/anmelden ⇒ Job `mail.send` (runDueJobs) ⇒ Mail in der
 *   Senke ⇒ Link (Fragment `#token=`) im Browser öffnen ⇒ „Kundenbereich
 *   öffnen“. Keine Reveal-Route, kein stdout, keine Datei, keine Debug-API,
 *   kein Lesen von `secret_payload_ciphertext`. Das Token lebt nur in einer
 *   Variablen des Testprozesses (Fehlermeldungen zeigen es nie: Vergleiche
 *   laufen über boolesche Ausdrücke).
 * - Datenbank-Lesezugriffe nur gegen die Testdatenbank (queryTestDb); die
 *   einzige Schreibhilfe ist `shiftPortalSession` (reine Zeitverschiebung einer
 *   Session-Zeile für Szenario O/H, created_at/expires_at konsistent).
 */

const REPO_ROOT = `${import.meta.dirname}/../../..`;

/** Kundentexte der API (apps/api/src/portal/types.ts PORTAL_MESSAGES) – 1:1. */
export const PORTAL_TEXT = {
  MAGIC_LINK_REQUESTED:
    'Wenn die E-Mail-Adresse bei uns hinterlegt ist, erhältst du gleich einen Anmeldelink.',
  TOKEN_INVALID: 'Dieser Anmeldelink ist ungültig oder abgelaufen. Bitte fordere einen neuen an.',
  CANCELLATION_BLOCKED:
    'Diese Buchung kann nicht mehr online storniert werden. Bitte kontaktiere uns.',
  PROFILE_HINT:
    'Änderungen gelten für zukünftige Anfragen. Deine bereits bestätigte Buchung bleibt unverändert.',
  EMAIL_CHANGED: 'E-Mail-Adresse geändert. Bitte melde dich mit deiner neuen Adresse erneut an.',
  REPLY_NOTICE: 'Du hast eine neue Nachricht von Miet-Royal.',
} as const;

/** Betreffzeilen der Portal-Mails (apps/api/src/communication/mail/templates/index.ts). */
export const PORTAL_SUBJECT = {
  login: 'Dein Anmeldelink für den Miet-Royal Kundenbereich',
  reauth: 'Bestätige deine Änderung im Miet-Royal Kundenbereich',
  emailChange: 'Bestätige deine neue E-Mail-Adresse für den Miet-Royal Kundenbereich',
  replyNotice: (processNumber: string) =>
    `Neue Nachricht von Miet-Royal – Vorgang ${processNumber}`,
  cancellation: (processNumber: string) => `Stornobestätigung – Vorgang ${processNumber}`,
} as const;

/** Portal-Session-Cookie der development-API (außerhalb development `__Host-…`). */
export const PORTAL_COOKIE_DEV = 'mr_customer_session';
export const PORTAL_COOKIE_HOST = '__Host-mr_customer_session';

/**
 * Verbotene Schlüssel in Portal-Antworten (Design §0 / Order §51) – der
 * Deep-Scan prüft jede gelesene Portal-JSON-Antwort.
 */
export const FORBIDDEN_PORTAL_KEYS = [
  'assignedUserId',
  'assigned_user_id',
  'internalNote',
  'internal_note',
  'note',
  'notes',
  'discountReason',
  'specialPrices',
  'approvedBy',
  'discountApprovedBy',
  'staffUserId',
  'createdByStaffId',
  'cancelerStaffId',
  'storageKey',
  'storage_key',
  'accountingReference',
  'externalReference',
  'lexwareInvoiceId',
  'providerMessageId',
  'lastTransferErrorCode',
  'attentionCode',
  'releasedResources',
  'riskIncidents',
  'standardUnitPriceCents',
  'priceSource',
  'productId',
  'listPriceCents',
  'tokenHash',
  'token_hash',
  'onsiteContactPhone',
  'phoneNormalized',
  // Szenario G: kein GPS, keine ETA, kein Fahrer.
  'latitude',
  'longitude',
  'eta',
  'etaAt',
  'plannedArrivalAt',
  'driver',
  'driverName',
  'effectiveDriverName',
  'liveLocation',
] as const;

/** Alle Objektschlüssel einer JSON-Struktur (rekursiv). */
export function collectJsonKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectJsonKeys(entry, into);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      collectJsonKeys(entry, into);
    }
  }
  return into;
}

export function expectNoForbiddenKeys(value: unknown, label: string): void {
  const keys = collectJsonKeys(value);
  const leaked = FORBIDDEN_PORTAL_KEYS.filter((key) => keys.has(key));
  expect(leaked, `verbotene Schlüssel in ${label}`).toEqual([]);
}

/** Betrag wie die Web-App (`euro` in apps/web/lib/portal.ts): „1.234,56 €“. */
export function euroText(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}${whole},${String(abs % 100).padStart(2, '0')} €`;
}

/** ISO-Tag ⇒ „TT.MM.JJJJ“ (formatDate der Web-App für reine Daten). */
export function germanDate(dateIso: string): string {
  const [y, m, d] = dateIso.split('-');
  return `${d}.${m}.${y}`;
}

// ── Seed (Kindprozess) ───────────────────────────────────────────────────

export interface PortalSeedCustomer {
  key: string;
  firstName: string;
  lastName: string;
  email: string;
  trashed?: boolean;
}

export interface PortalSeedBooking {
  key: string;
  customer: string;
  fulfillment?: 'pickup' | 'delivery';
  eventInDays: number;
  machineSlug?: string;
  plannedAppointments?: boolean;
  approveOrderConfirmation?: boolean;
  issuedMachineCode?: string;
  internalNote?: string;
  activeTour?: {
    windowStart: string;
    windowEnd: string;
    driver: { firstName: string; lastName: string; email: string; password: string };
    location: { latitude: number; longitude: number };
  };
}

export interface PortalSeedInput {
  adminEmail: string;
  customers: PortalSeedCustomer[];
  bookings?: PortalSeedBooking[];
  inquiries?: { key: string; customer: string; sendOffer?: boolean }[];
}

export interface PortalSeededBooking {
  bookingId: string;
  processId: string;
  processNumber: string;
  customerId: string;
  eventDate: string;
}

export interface PortalSeedResult {
  customers: Record<string, { id: string; email: string }>;
  bookings: Record<string, PortalSeededBooking>;
  inquiries: Record<string, { processId: string; processNumber: string }>;
  tours: Record<string, { tourId: string; driverId: string }>;
  copiedDocuments: number;
}

export function seedPortal(
  input: PortalSeedInput,
  options: { databaseUrl?: string; storageRoot?: string } = {},
): PortalSeedResult {
  const output = execFileSync(
    'pnpm',
    ['--filter', '@mietroyal/api', 'exec', 'tsx', 'scripts/e2e-portal-seed.ts'],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      env: {
        ...process.env,
        APP_ENV: 'development',
        TEST_DATABASE_URL: options.databaseUrl ?? TEST_DATABASE_URL,
        LOG_LEVEL: 'error',
        E2E_PORTAL_INPUT: JSON.stringify({
          ...input,
          storageRoot: resolve(options.storageRoot ?? E2E_STORAGE_ROOT),
        }),
      },
    },
  );
  const lines = output.toString('utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '{}') as PortalSeedResult;
}

// ── Magic Link (nur über die echte Mail aus der SMTP-Senke) ──────────────

export interface MagicLinkOptions {
  /** Web-Instanz (Default: Haupt-Web 3100). */
  origin?: string;
  /** Fällige Jobs (mail.send) der passenden API ausführen. */
  runJobs: () => Promise<unknown>;
  /** Betreff (Demo: „[DEMO] …“). */
  subject?: string;
}

/**
 * Anmeldelink über das Formular anfordern (neutraler Text), Versandjob
 * ausführen und den Link (`…/konto/anmelden#token=…`) aus der NEUEN Mail der
 * Senke lesen. Der Link (Token!) erscheint nie in einer Fehlermeldung.
 */
/** Wartezeit aus `retry-after` (Sekunden) eines 429 – begrenzt auf 65 s. */
function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers()['retry-after'] ?? '30');
  return Math.min(65, Math.max(1, Number.isFinite(seconds) ? seconds : 30)) * 1000 + 500;
}

const RATE_LIMITED_TEXT = 'Zu viele Versuche. Bitte warte einen Moment.';
const MAX_RATE_LIMIT_ATTEMPTS = 3;

/**
 * Anmeldelink über das Formular /konto/anmelden anfordern und den neutralen
 * Text abwarten. Die Portal-Auth-Routen sind auch im E2E rate-limitiert (alle
 * Testkunden teilen sich 127.0.0.1): ein 429 zeigt den Kundentext „Zu viele
 * Versuche …“; der Helfer wartet dann wie ein Mensch `retry-after` ab und sendet
 * erneut (höchstens drei Versuche).
 */
export async function submitLoginRequest(
  page: Page,
  email: string,
  origin = WEB_ORIGIN,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    await page.goto(`${origin}/konto/anmelden`);
    await expect(page.getByTestId('portal-login-form')).toBeVisible();
    await page.getByTestId('portal-login-email').fill(email);
    const answered = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/portal/auth/request') &&
        response.request().method() === 'POST',
    );
    await page.getByTestId('portal-login-submit').click();
    const response = await answered;
    if (response.status() === 429 && attempt < MAX_RATE_LIMIT_ATTEMPTS) {
      await expect(page.getByTestId('portal-error')).toContainText(RATE_LIMITED_TEXT);
      await page.waitForTimeout(retryAfterMs(response));
      continue;
    }
    expect(response.status(), 'POST /portal/auth/request').toBe(202);
    await expect(page.getByTestId('portal-login-neutral')).toContainText(
      PORTAL_TEXT.MAGIC_LINK_REQUESTED,
    );
    return;
  }
}

/**
 * Anmeldelink über das Formular anfordern (neutraler Text), Versandjob
 * ausführen und den Link (`…/konto/anmelden#token=…`) aus der NEUEN Mail der
 * Senke lesen. Der Link (Token!) erscheint nie in einer Fehlermeldung.
 */
export async function requestMagicLinkMail(
  page: Page,
  email: string,
  options: MagicLinkOptions,
): Promise<{ link: string; mail: SinkMail }> {
  const origin = options.origin ?? WEB_ORIGIN;
  const filter = { to: email, subject: options.subject ?? PORTAL_SUBJECT.login };
  const before = (await mailsMatching(filter)).length;
  await submitLoginRequest(page, email, origin);
  await options.runJobs();
  const mail = await waitForMail(filter, { count: before + 1 });
  const link = linkFromMail(mail, '/konto/anmelden');
  expect(new URL(link).origin, 'Link zeigt auf die konfigurierte Web-Basis').toBe(origin);
  return { link, mail };
}

/** Token aus dem Fragment eines Portal-Links (nur Testprozess). */
export function tokenOfLink(link: string): string {
  const hash = new URL(link).hash;
  expect(hash.startsWith('#token='), 'Fragment #token=').toBe(true);
  return decodeURIComponent(hash.slice('#token='.length));
}

/**
 * Prüft nach dem Laden einer Fragment-Seite, dass das Token weder in der
 * Adresszeile noch im Web Storage, in nicht-HttpOnly-Cookies oder im
 * History-State steht (Order §6/§7). Ergebnis nur als Boolean.
 */
export async function expectTokenNotInBrowser(page: Page, token: string): Promise<void> {
  // Boolesch – der Wert (Token!) darf nie in der Reporter-Ausgabe erscheinen.
  expect(new URL(page.url()).hash === '', 'Fragment aus der Adresszeile entfernt').toBe(true);
  const leaked = await page.evaluate((secret) => {
    const parts: string[] = [window.location.href, document.cookie];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i) ?? '';
        parts.push(key, storage.getItem(key) ?? '');
      }
    }
    try {
      parts.push(JSON.stringify(window.history.state ?? null));
    } catch {
      parts.push('');
    }
    return parts.some((part) => part.includes(secret));
  }, token);
  expect(leaked, 'Token in URL/Storage/Cookie/History').toBe(false);
}

/**
 * Link aus der Mail öffnen und „Kundenbereich öffnen“ klicken. Prüft vorher die
 * Fragment-Entfernung und den leeren Client-Storage.
 */
export async function openMagicLink(
  page: Page,
  link: string,
  options: { expect: 'success' | 'invalid' } = { expect: 'success' },
): Promise<void> {
  const token = tokenOfLink(link);
  expect(/^[A-Za-z0-9_-]{43}$/.test(token), 'Token: 32 Byte base64url (43 Zeichen)').toBe(true);
  for (let attempt = 1; ; attempt += 1) {
    // Wie ein Klick in der Mail: frischer Seitenaufruf (sonst wäre ein Wechsel nur des
    // Fragments auf derselben Seite eine Fragment-Navigation ohne Neuladen).
    await page.goto('about:blank');
    await page.goto(link);
    await expect(page.getByTestId('portal-login-token-card')).toBeVisible();
    await expectTokenNotInBrowser(page, token);
    const answered = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/portal/auth/consume') &&
        response.request().method() === 'POST',
    );
    await page.getByTestId('portal-login-open').click();
    const response = await answered;
    if (response.status() === 429 && attempt < MAX_RATE_LIMIT_ATTEMPTS) {
      // Rate-Limit (10/min je IP) vor dem Verbrauch: Token bleibt gültig; die Seite hat es
      // verworfen ⇒ nach `retry-after` den Link aus der Mail erneut öffnen.
      await expect(page.getByTestId('portal-error')).toContainText(RATE_LIMITED_TEXT);
      await page.waitForTimeout(retryAfterMs(response));
      continue;
    }
    if (options.expect === 'success') {
      expect(response.status(), 'POST /portal/auth/consume').toBe(200);
      await page.waitForURL(
        (url) => url.pathname.startsWith('/konto') && !url.pathname.startsWith('/konto/anmelden'),
      );
    } else {
      expect(response.status(), 'POST /portal/auth/consume').toBe(401);
      await expect(page.getByTestId('portal-error')).toContainText(PORTAL_TEXT.TOKEN_INVALID);
      await expect(page.getByTestId('portal-login-form')).toBeVisible();
    }
    await expectTokenNotInBrowser(page, token);
    return;
  }
}

/** Kompletter Login: Anforderung ⇒ Mail ⇒ Link ⇒ Kundenbereich. */
export async function loginViaMagicLink(
  page: Page,
  email: string,
  options: MagicLinkOptions,
): Promise<void> {
  const { link } = await requestMagicLinkMail(page, email, options);
  await openMagicLink(page, link);
}

// ── Datenbank (Testdatenbank) ────────────────────────────────────────────

export const sha256Hex = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

export interface PortalSessionDbRow {
  id: string;
  customer_id: string;
  token_hash: string;
  created_at: string;
  authenticated_at: string;
  reauthenticated_at: string;
  last_seen_at: string | null;
  expires_at: string;
  revoked_at: string | null;
}

export function portalSessions(customerId: string): PortalSessionDbRow[] {
  return queryTestDb<PortalSessionDbRow>(
    `SELECT id, customer_id, token_hash, created_at, authenticated_at, reauthenticated_at,
            last_seen_at, expires_at, revoked_at
       FROM customer_portal_sessions WHERE customer_id = $1 ORDER BY created_at ASC`,
    [customerId],
  );
}

export function activePortalSession(customerId: string): PortalSessionDbRow {
  const rows = portalSessions(customerId).filter((row) => row.revoked_at === null);
  expect(rows, 'genau eine aktive Portal-Session').toHaveLength(1);
  return rows[0]!;
}

export interface MagicLinkDbRow {
  id: string;
  purpose: string;
  session_id: string | null;
  token_hash: string;
  consumed_at: string | null;
  revoked_at: string | null;
  expires_at: string;
  created_at: string;
  proposed_email: string | null;
}

export function magicLinks(customerId: string): MagicLinkDbRow[] {
  return queryTestDb<MagicLinkDbRow>(
    `SELECT id, purpose::text AS purpose, session_id, token_hash, consumed_at, revoked_at, expires_at,
            created_at, proposed_email
       FROM customer_portal_magic_links WHERE customer_id = $1 ORDER BY created_at ASC`,
    [customerId],
  );
}

export function customerRow(customerId: string): {
  email: string | null;
  phone: string | null;
  deleted_at: string | null;
} {
  const rows = queryTestDb<{
    email: string | null;
    phone: string | null;
    deleted_at: string | null;
  }>('SELECT email, phone, deleted_at FROM customers WHERE id = $1', [customerId]);
  expect(rows, 'Kundenzeile').toHaveLength(1);
  return rows[0]!;
}

/** Unveränderliche Snapshots der Buchung (Order §17) als JSON-Text. */
export function bookingSnapshots(bookingId: string): string {
  const rows = queryTestDb<Record<string, unknown>>(
    `SELECT customer_snapshot, event_snapshot, totals_snapshot, items_snapshot, delivery_snapshot
       FROM bookings WHERE id = $1`,
    [bookingId],
  );
  expect(rows, 'Buchungszeile').toHaveLength(1);
  return JSON.stringify(rows[0]);
}

/** Outbox-Zeilen an eine Adresse (nur Metadaten, nie das Secret). */
export function outboxTo(email: string): { kind: string; status: string; context: unknown }[] {
  return queryTestDb<{ kind: string; status: string; context: unknown }>(
    `SELECT kind::text AS kind, status::text AS status, context FROM mail_deliveries
      WHERE lower(recipient_email) = lower($1) ORDER BY created_at ASC`,
    [email],
  );
}

/**
 * Reine Zeitverschiebung einer Portal-Session (Szenarien H/O): created_at,
 * authenticated_at, reauthenticated_at und expires_at werden um dasselbe
 * Intervall verschoben (Abstand bleibt exakt 30 Tage, Check expires_at >
 * created_at gilt weiter); optional last_seen_at zurücksetzen. Nur
 * Testdatenbank; keine fachliche Mutation.
 */
export function shiftPortalSession(
  sessionId: string,
  shiftMs: number,
  options: { clearLastSeen?: boolean; onlyReauth?: boolean } = {},
): void {
  const interval = `${Math.round(shiftMs / 1000)} seconds`;
  if (options.onlyReauth === true) {
    queryTestDb(
      `UPDATE customer_portal_sessions
          SET reauthenticated_at = reauthenticated_at - $2::interval
        WHERE id = $1`,
      [sessionId, interval],
    );
    return;
  }
  queryTestDb(
    `UPDATE customer_portal_sessions
        SET created_at = created_at - $2::interval,
            authenticated_at = authenticated_at - $2::interval,
            reauthenticated_at = reauthenticated_at - $2::interval,
            expires_at = expires_at - $2::interval
            ${options.clearLastSeen === true ? ', last_seen_at = NULL' : ''}
      WHERE id = $1`,
    [sessionId, interval],
  );
}

/** Portal-Cookie des Browserkontexts (Name je Umgebung). */
export async function portalCookie(page: Page, name = PORTAL_COOKIE_DEV) {
  const cookies = await page.context().cookies();
  return cookies.find((cookie) => cookie.name === name) ?? null;
}

/** GET gegen die Portal-API über die Web-Instanz (Cookies des Kontexts). */
export async function portalApiGet<T = unknown>(
  page: Page,
  path: string,
  origin = WEB_ORIGIN,
): Promise<{ status: number; data: T; headers: Record<string, string> }> {
  const response = await page.request.get(`${origin}/api/portal${path}`);
  const data: unknown = await response.json().catch(() => null);
  return { status: response.status(), data: data as T, headers: response.headers() };
}

/** POST gegen die Portal-API über die Web-Instanz (Cookies des Kontexts). */
export async function portalApiPost<T = unknown>(
  page: Page,
  path: string,
  body: unknown,
  origin = WEB_ORIGIN,
): Promise<{ status: number; data: T }> {
  const response = await page.request.post(`${origin}/api/portal${path}`, { data: body });
  const data: unknown = await response.json().catch(() => null);
  return { status: response.status(), data: data as T };
}
