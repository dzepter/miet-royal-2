/**
 * Phase-15-E2E-Szenario N (Order §66, §45–§48) – Demo-Portal + Reset im Projekt
 * `demo-communication`: Demo-WEB-Instanz (3108, WEB_APP_ENV=demo ⇒ Banner) →
 * Same-Origin-Proxy → Demo-API (3106, APP_ENV=demo, eigene Datenbank
 * `mietroyal_test_demo`, Cookie `__Host-mr_customer_session`, Mail nur an die
 * Whitelist `@demo.test` mit „[DEMO]“-Betreff, Links auf die Demo-Web-Instanz).
 *
 * Ablauf: kanonischer Demo-Datensatz (Reset) ⇒ nicht gelisteter Seed-Kunde:
 * neutrale Antwort, Mail `blocked` (nie in der Senke) ⇒ Whitelist-Übungskunde
 * (Kunde von `process.settlement.review`) meldet sich über den Link der
 * „[DEMO]“-Mail an ⇒ Buchung sichtbar, Banner bleibt ⇒ ein zweiter, offener
 * Link wird vor dem Reset angefordert ⇒ Demo-Reset ⇒ Portal-Sessions und Magic
 * Links gelöscht, die Seite führt zur Anmeldung, der alte Link ist ungültig und
 * schreibt nichts in den neuen Datensatz ⇒ frischer Login funktioniert wieder.
 *
 * Magic-Link-Tokens ausschließlich aus der SMTP-Senke (helpers/portal.ts); Demo-
 * Datenbank nur lesend; Reset ausschließlich über POST /staff/demo/reset mit
 * Pflichtbestätigung (helpers/training.ts).
 */
import { expect, test, type Page } from '@playwright/test';
import { DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, DEMO_WEB_ORIGIN } from '../helpers/demo-env.ts';
import { clearSink, expectMailCount, expectMietRoyalMail } from '../helpers/mail.ts';
import {
  PORTAL_COOKIE_HOST,
  PORTAL_SUBJECT,
  PORTAL_TEXT,
  openMagicLink,
  portalCookie,
  requestMagicLinkMail,
} from '../helpers/portal.ts';
import {
  customerEmailOfProcess,
  demoApi,
  demoApiLogin,
  demoDb,
  processNumberOf,
  resetDemoViaApi,
  runDemoJobs,
  seedEntityId,
} from '../helpers/training.ts';

test.describe.configure({ mode: 'serial' });

const BANNER_TEXT = 'DEMO – keine echten Kundendaten';
const DEMO_LOGIN_SUBJECT = `[DEMO] ${PORTAL_SUBJECT.login}`;

let adminCookie = '';

const runJobs = () => runDemoJobs(adminCookie);

/**
 * Nach einem Reset: warten, bis das Reset-Gate Portal-Mutationen wieder zulässt
 * (Gate-Cache ≤ 1 s). Logout ohne Session ist eine harmlose Mutation (204).
 */
async function waitForPortalGateOpen(): Promise<void> {
  await expect
    .poll(async () => (await demoApi('POST', '/portal/auth/logout')).status, {
      message: 'Portal-Mutationen nach dem Demo-Reset wieder offen',
      timeout: 15_000,
    })
    .toBe(204);
}

function portalTableCounts(): { sessions: number; links: number } {
  const rows = demoDb<{ sessions: string; links: string }>(
    `SELECT (SELECT count(*) FROM customer_portal_sessions)::text AS sessions,
            (SELECT count(*) FROM customer_portal_magic_links)::text AS links`,
  );
  return { sessions: Number(rows[0]!.sessions), links: Number(rows[0]!.links) };
}

async function expectBanner(page: Page): Promise<void> {
  const banner = page.getByTestId('demo-banner');
  await expect(banner).toHaveCount(1);
  await expect(banner).toBeVisible();
  await expect(banner).toHaveText(BANNER_TEXT);
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await clearSink();
  const health = await demoApi<{ environment: string }>('GET', '/health');
  expect(health.data.environment).toBe('demo');
  adminCookie = await demoApiLogin(DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD);
  // Kanonischer Demo-Datensatz (Übungskunden mit Whitelist-Adresse und Buchung).
  await resetDemoViaApi(adminCookie);
  await waitForPortalGateOpen();
});

test('N. Demo Portal + Reset: Banner, Magic Link nur an Whitelist mit „[DEMO]“, Login über die Demo-Web-Instanz; nach dem Demo-Reset ist die Session ungültig (Anmeldung) und alte Links schreiben nicht in den neuen Datensatz', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const processId = seedEntityId('process.settlement.review');
  const processNumber = processNumberOf(processId);
  const practiceEmail = customerEmailOfProcess(processId);
  expect(practiceEmail.endsWith('@demo.test'), 'Übungskunde mit Whitelist-Adresse').toBe(true);
  const blockedEmail = customerEmailOfProcess(seedEntityId('process.offer.sent'));
  expect(blockedEmail.endsWith('@demo.test'), 'Gegenprobe: nicht gelistete Adresse').toBe(false);
  expect(portalTableCounts()).toEqual({ sessions: 0, links: 0 });

  const context = await browser.newContext();
  const page = await context.newPage();

  // Banner auf der Anmeldeseite des Demo-Portals.
  await page.goto(`${DEMO_WEB_ORIGIN}/konto`);
  await page.waitForURL(`${DEMO_WEB_ORIGIN}/konto/anmelden`);
  await expectBanner(page);

  // Nicht gelistete Adresse: identische neutrale Antwort, Mail blockiert (nie in der Senke).
  await page.getByTestId('portal-login-email').fill(blockedEmail);
  await page.getByTestId('portal-login-submit').click();
  await expect(page.getByTestId('portal-login-neutral')).toContainText(
    PORTAL_TEXT.MAGIC_LINK_REQUESTED,
  );
  await runJobs();
  const blocked = demoDb<{ status: string; blocked_reason: string | null; subject: string }>(
    `SELECT status::text AS status, blocked_reason, subject FROM mail_deliveries
      WHERE kind = 'customer_portal_magic_link' AND lower(recipient_email) = lower($1)`,
    [blockedEmail],
  );
  expect(blocked).toHaveLength(1);
  expect(blocked[0]).toMatchObject({ status: 'blocked', subject: DEMO_LOGIN_SUBJECT });
  await expectMailCount({ to: blockedEmail }, 0);

  // Whitelist-Übungskunde: „[DEMO]“-Mail mit Link auf die Demo-Web-Instanz.
  const first = await requestMagicLinkMail(page, practiceEmail, {
    origin: DEMO_WEB_ORIGIN,
    runJobs,
    subject: DEMO_LOGIN_SUBJECT,
  });
  expect(first.mail.subject).toBe(DEMO_LOGIN_SUBJECT);
  expectMietRoyalMail(first.mail);
  expect(new URL(first.link).origin).toBe(DEMO_WEB_ORIGIN);
  await openMagicLink(page, first.link);
  await expectBanner(page);
  await expect(
    page.getByTestId('portal-process-number').filter({ hasText: processNumber }),
  ).toBeVisible();
  const cookie = await portalCookie(page, PORTAL_COOKIE_HOST);
  expect(cookie, `Cookie ${PORTAL_COOKIE_HOST}`).not.toBeNull();
  expect(cookie!.secure).toBe(true);
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe('Strict');
  expect(cookie!.path).toBe('/');
  expect(cookie!.domain).toBe('127.0.0.1'); // Host-only (kein Domain-Attribut)
  expect(portalTableCounts().sessions).toBe(1);

  // Zweiter, offener Anmeldelink (anderes Gerät) – wird vor dem Reset angefordert.
  const otherDevice = await (await browser.newContext()).newPage();
  const pending = await requestMagicLinkMail(otherDevice, practiceEmail, {
    origin: DEMO_WEB_ORIGIN,
    runJobs,
    subject: DEMO_LOGIN_SUBJECT,
  });
  expect(portalTableCounts().links).toBeGreaterThanOrEqual(2);

  // Demo-Reset: Portal-Sessions und Magic Links gehören zur Reset-Grenze.
  const reset = await resetDemoViaApi(adminCookie);
  expect(reset.deleted['customer_portal_sessions']).toBeGreaterThanOrEqual(1);
  expect(reset.deleted['customer_portal_magic_links']).toBeGreaterThanOrEqual(2);
  await waitForPortalGateOpen();
  expect(portalTableCounts()).toEqual({ sessions: 0, links: 0 });

  // Alte Session: die Seite führt zur Anmeldung (Cookie wird verworfen).
  await page.reload();
  await page.waitForURL(`${DEMO_WEB_ORIGIN}/konto/anmelden`);
  await expectBanner(page);
  expect(await portalCookie(page, PORTAL_COOKIE_HOST), 'Cookie gelöscht').toBeNull();

  // Alter Link aus der Zeit vor dem Reset: ungültig, keine Session im neuen Datensatz.
  await openMagicLink(otherDevice, pending.link, { expect: 'invalid' });
  expect(portalTableCounts()).toEqual({ sessions: 0, links: 0 });
  await otherDevice.context().close();

  // Neuer Datensatz: frische Anmeldung funktioniert wieder.
  const fresh = await requestMagicLinkMail(page, practiceEmail, {
    origin: DEMO_WEB_ORIGIN,
    runJobs,
    subject: DEMO_LOGIN_SUBJECT,
  });
  await openMagicLink(page, fresh.link);
  await expect(
    page
      .getByTestId('portal-process-number')
      .filter({ hasText: processNumberOf(seedEntityId('process.settlement.review')) }),
  ).toBeVisible();
  expect(portalTableCounts().sessions).toBe(1);
  await context.close();
});
