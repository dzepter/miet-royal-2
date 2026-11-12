/**
 * Phase-16-E2E-Szenario K (Order §21/§26) – neue Website in der DEMO-Umgebung, Projekt
 * `demo-communication`: Demo-WEB-Instanz (3108, WEB_APP_ENV=demo ⇒ fester Banner) →
 * Same-Origin-Proxy → Demo-API (3106, APP_ENV=demo, eigene Datenbank `mietroyal_test_demo`,
 * `REVIEWS_PROVIDER=fake` ⇒ synthetische DEMO-Bewertungen, nie Google, kein Places-Key).
 *
 * K1 DEMO-Banner auf allen Website-Seiten der Demo-Web-Instanz (alle veröffentlichten
 *    CMS-Seiten, Konfigurator, 404); die Live-Web-Instanz (3100) zeigt keinen Banner
 * K2 Bewertungen nur als DEMO gekennzeichnet (Klick-zum-Laden, Attribution „DEMO – …“), nie
 *    „Google“; Live-API ohne Provider (404, Sektion fehlt); kein Request an Google-Hosts
 * K3 Website-Anfrage über die Demo-Web-Instanz ⇒ Vorgang/Anfrage/Kunde NUR in der Demo-DB,
 *    Live-DB unverändert
 *
 * Daten: Demo-DB frisch je Lauf (scripts/e2e-demo-setup.ts) + CMS-Bootstrap mit
 * Demo-Veröffentlichung (scripts/e2e-website-seed.ts, Ziel `demo`; idempotent, CMS-Inhalte
 * überleben Demo-Resets). Datenbanken nur lesend.
 */
import { expect, test, type Page } from '@playwright/test';
import { DEMO_API_ORIGIN, DEMO_WEB_ORIGIN } from '../helpers/demo-env.ts';
import { berlinDayPlus } from '../helpers/settlement.ts';
import {
  API_ORIGIN,
  PICKUP_AREA,
  WEB_ORIGIN,
  acknowledgePrivacy,
  businessCounts,
  chooseMachine,
  fillEvent,
  fillPrivateContact,
  mainDb,
  nextStep,
  openConfigurator,
  publishedPaths,
  seedWebsite,
  submitAndConfirm,
  websiteDemoDb,
  websiteProcessByNumber,
  type WebsiteSeedResult,
} from '../helpers/website.ts';

test.describe.configure({ mode: 'serial' });

const BANNER_TEXT = 'DEMO – keine echten Kundendaten';
const DEMO_ATTRIBUTION = 'DEMO – synthetische Beispielbewertungen';

let demoSeed: WebsiteSeedResult;

interface SiteBootstrap {
  environment: string;
  pages: { path: string; pageType: string }[];
  reviews: { mode: string };
}

async function getJson<T>(url: string): Promise<{ status: number; data: T; text: string }> {
  const response = await fetch(url, {
    headers: { connection: 'close', accept: 'application/json' },
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: response.status, data: data as T, text };
}

async function expectBanner(page: Page, label: string): Promise<void> {
  const banner = page.getByTestId('demo-banner');
  await expect(banner, `DEMO-Banner auf ${label}`).toHaveCount(1);
  await expect(banner).toBeVisible();
  await expect(banner).toHaveText(BANNER_TEXT);
}

/** Alle Requests der Seite außerhalb der Demo-Web-Instanz (Hosts, keine Pfade/Tokens). */
function trackForeignHosts(page: Page): string[] {
  const hosts: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.origin !== DEMO_WEB_ORIGIN) hosts.push(url.host);
  });
  return hosts;
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const health = await getJson<{ environment: string }>(`${DEMO_API_ORIGIN}/health`);
  expect(health.data.environment).toBe('demo');
  demoSeed = seedWebsite('demo');
});

test('K1. DEMO-Banner auf allen Website-Seiten der Demo-Web-Instanz (CMS-Seiten, Konfigurator, 404); Live-Web ohne Banner', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const settings = await getJson<SiteBootstrap>(`${DEMO_API_ORIGIN}/public/site/settings`);
  expect(settings.status).toBe(200);
  expect(settings.data.environment).toBe('demo');
  const published = settings.data.pages.map((page) => page.path).sort();
  expect(published).toEqual([...publishedPaths(demoSeed)].sort());
  expect(published).toContain('/datenschutz');

  const context = await browser.newContext();
  const page = await context.newPage();
  const foreign = trackForeignHosts(page);
  for (const path of [...published, '/konfigurator']) {
    const response = await page.goto(`${DEMO_WEB_ORIGIN}${path}`, { timeout: 90_000 });
    expect(response?.status(), `GET ${path}`).toBe(200);
    await expectBanner(page, path);
    await expect(page.getByTestId('site-frame')).toBeVisible();
  }
  const missing = await page.goto(`${DEMO_WEB_ORIGIN}/gibt-es-nicht`, { timeout: 90_000 });
  expect(missing?.status()).toBe(404);
  await expectBanner(page, '404');
  expect(foreign, 'Requests außerhalb der Demo-Web-Instanz').toEqual([]);

  // Gegenprobe: die Live-Web-Instanz trägt keinen Demo-Banner.
  await page.goto(`${WEB_ORIGIN}/`, { timeout: 90_000 });
  await expect(page.getByTestId('demo-banner')).toHaveCount(0);
  await context.close();
});

test('K2. Bewertungen in der Demo nur als DEMO gekennzeichnet (Fake-Provider, Klick-zum-Laden), nie „Google“; Live ohne Provider; kein Google-Request, kein Places-Key', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // Kein Places-Key in der Umgebung, die die Server erben (Demo würde mit Key nicht starten).
  expect(process.env.GOOGLE_PLACES_API_KEY ?? '', 'GOOGLE_PLACES_API_KEY im Testlauf').toBe('');
  const settings = await getJson<SiteBootstrap>(`${DEMO_API_ORIGIN}/public/site/settings`);
  expect(settings.data.reviews.mode).toBe('demo');
  const live = await getJson<SiteBootstrap>(`${API_ORIGIN}/public/site/settings`);
  expect(live.data.reviews.mode).toBe('disabled');
  const liveReviews = await getJson<{ error: { code: string } }>(`${API_ORIGIN}/public/reviews`);
  expect(liveReviews.status).toBe(404);
  expect(liveReviews.data.error.code).toBe('REVIEWS_DISABLED');

  const demoReviews = await getJson<{
    mode: string;
    attribution: string;
    placeUri: string | null;
    reviews: {
      authorName: string;
      text: string;
      authorUri: string | null;
      authorPhotoUri: string | null;
    }[];
  }>(`${DEMO_API_ORIGIN}/public/reviews`);
  expect(demoReviews.status).toBe(200);
  expect(demoReviews.data.mode).toBe('demo');
  expect(demoReviews.data.attribution).toBe(DEMO_ATTRIBUTION);
  expect(demoReviews.data.placeUri).toBeNull();
  expect(demoReviews.data.reviews.length).toBeGreaterThan(0);
  for (const review of demoReviews.data.reviews) {
    expect(review.text).toContain('DEMO');
    expect(review.authorUri).toBeNull();
    expect(review.authorPhotoUri).toBeNull();
  }
  expect(/google/i.test(demoReviews.text), '„Google“ in der Demo-Antwort').toBe(false);

  const context = await browser.newContext();
  const page = await context.newPage();
  const foreign = trackForeignHosts(page);
  await page.goto(`${DEMO_WEB_ORIGIN}/`, { timeout: 90_000 });
  await expectBanner(page, 'Startseite');
  const section = page.getByTestId('reviews-section');
  await expect(section).toBeVisible();
  await expect(section).toHaveAttribute('data-review-mode', 'demo');
  await expect(page.getByTestId('reviews-demo-badge')).toHaveText('DEMO');
  await expect(page.getByTestId('reviews-notice')).toContainText('DEMO');
  // Vor dem Klick wird nichts geladen.
  await expect(page.getByTestId('reviews-list')).toHaveCount(0);
  const loaded = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/public/reviews',
  );
  await page.getByTestId('reviews-load').click();
  expect((await loaded).status()).toBe(200);
  await expect(page.getByTestId('reviews-list')).toBeVisible();
  await expect(page.getByTestId('reviews-attribution')).toHaveText(`Quelle: ${DEMO_ATTRIBUTION}`);
  await expect(page.getByTestId('reviews-list')).toContainText('DEMO-Beispieltext');
  const sectionText = await section.innerText();
  expect(/google/i.test(sectionText), '„Google“ in der Demo-Bewertungssektion').toBe(false);
  await expect(section.locator('img')).toHaveCount(0);
  expect((await page.content()).toLowerCase().includes('googleapis')).toBe(false);
  expect(foreign, 'Requests außerhalb der Demo-Web-Instanz (z. B. Google)').toEqual([]);

  // Live-Web: ohne Provider keine Bewertungs-Sektion.
  await page.goto(`${WEB_ORIGIN}/`, { timeout: 90_000 });
  await expect(
    page.getByTestId('cms-page').or(page.getByTestId('site-fallback-home')),
  ).toBeVisible();
  await expect(page.getByTestId('reviews-section')).toHaveCount(0);
  await context.close();
});

test('K3. Website-Anfrage über die Demo-Web-Instanz ⇒ Vorgang/Anfrage/Kunde nur in der Demo-Datenbank, Live-Datenbank unverändert', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const email = `demo.website.anfrage@demo.test`;
  const liveBefore = businessCounts(mainDb);
  const demoBefore = businessCounts(websiteDemoDb);

  const context = await browser.newContext();
  const page = await context.newPage();
  await openConfigurator(page, DEMO_WEB_ORIGIN);
  await expectBanner(page, 'Konfigurator');
  await fillEvent(page, { date: berlinDayPlus(21), guests: 30 });
  await nextStep(page, 'machine');
  await chooseMachine(page, 'slush-1x8');
  await nextStep(page, 'syrup');
  await nextStep(page, 'fulfillment');
  await expect(page.getByTestId('cfg-fulfillment-pickup')).toContainText(
    `Selbst abholen in ${PICKUP_AREA}`,
  );
  await nextStep(page, 'contact');
  await fillPrivateContact(page, { firstName: 'Dina', lastName: 'Demoanfrage', email });
  await nextStep(page, 'summary');
  await acknowledgePrivacy(page);
  const processNumber = await submitAndConfirm(page);
  await expectBanner(page, 'Bestätigung');

  // Demo-DB: genau ein neuer Vorgang (source website) mit Anfrage und Submission.
  expect(businessCounts(websiteDemoDb)).toEqual({
    processes: demoBefore.processes + 1,
    inquiries: demoBefore.inquiries + 1,
    customers: demoBefore.customers + 1,
    submissions: demoBefore.submissions + 1,
  });
  const rows = websiteProcessByNumber(processNumber, websiteDemoDb);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.source).toBe('website');
  expect(rows[0]!.customer_email).toBe(email);
  expect(rows[0]!.privacy_path).toBe('/datenschutz');

  // Live-DB unverändert: keine Zeile, kein Kunde mit dieser Adresse, keine Submission der ID.
  expect(businessCounts(mainDb)).toEqual(liveBefore);
  expect(
    mainDb<{ n: number }>('SELECT count(*)::int AS n FROM customers WHERE lower(email) = $1', [
      email,
    ])[0]!.n,
  ).toBe(0);
  expect(
    mainDb<{ n: number }>(
      'SELECT count(*)::int AS n FROM public_inquiry_submissions WHERE client_mutation_id = $1',
      [rows[0]!.client_mutation_id],
    )[0]!.n,
  ).toBe(0);
  await context.close();
});

// ── Phase 17: SEO-C5 ──────────────────────────────────────────────────────

test('SEO-C5. Demo-Web ist nie indexierbar (auch mit gültiger Basis der Demo-API): robots.txt ohne Sitemap-Zeile, Seiten noindex ohne Canonical/og:url/JSON-LD, leere Sitemap', async ({
  request,
  page,
}) => {
  test.setTimeout(180_000);
  // Die Demo-API liefert eine gültige Basis (MAIL_PUBLIC_WEB_BASE_URL = Demo-Web) – Demo bleibt
  // trotzdem fail-closed noindex (Auftrag §3, Design D2).
  const settings = await getJson<SiteBootstrap & { publicBaseUrl: string | null }>(
    `${DEMO_API_ORIGIN}/public/site/settings`,
  );
  expect(settings.data.publicBaseUrl).toBe(DEMO_WEB_ORIGIN);

  const robotsResponse = await request.get(`${DEMO_WEB_ORIGIN}/robots.txt`, { maxRedirects: 0 });
  expect(robotsResponse.status()).toBe(200);
  const robots = await robotsResponse.text();
  expect(robots).toMatch(/^User-Agent: \*$/m);
  expect(robots).toMatch(/^Allow: \/$/m);
  expect(robots).toMatch(/^Disallow: \/api\/$/m);
  expect(robots, 'kein „Disallow: /“').not.toMatch(/^Disallow: \/\s*$/m);
  expect(robots, 'keine Sitemap-Zeile').not.toMatch(/^Sitemap:/m);

  const sitemap = await request.get(`${DEMO_WEB_ORIGIN}/sitemap.xml`, { maxRedirects: 0 });
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  expect(xml).toContain('<urlset');
  expect(xml, 'leere Sitemap').not.toContain('<url>');

  for (const path of ['/', '/konfigurator', '/slushmaschine-mieten/mainz']) {
    const response = await page.goto(`${DEMO_WEB_ORIGIN}${path}`, { timeout: 90_000 });
    expect(response?.status(), `GET ${path}`).toBe(200);
    await expectBanner(page, path);
    const robotsMeta = await page
      .locator('meta[name="robots"]')
      .evaluateAll((elements) => elements.map((el) => el.getAttribute('content') ?? ''));
    expect(robotsMeta.length, `${path}: robots-Meta`).toBeGreaterThanOrEqual(1);
    for (const content of robotsMeta) expect(content, `${path}: noindex`).toContain('noindex');
    await expect(page.locator('link[rel="canonical"]'), `${path}: kein Canonical`).toHaveCount(0);
    await expect(page.locator('meta[property="og:url"]'), `${path}: kein og:url`).toHaveCount(0);
    await expect(
      page.locator('script[type="application/ld+json"]'),
      `${path}: kein JSON-LD`,
    ).toHaveCount(0);
  }
});
