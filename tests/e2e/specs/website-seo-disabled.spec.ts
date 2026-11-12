/**
 * Phase-17-E2E (Auftrag §3, §9, §10, §28 C6) – Indexierung AUS ist der Default und fail-closed:
 * Web-Dev-Instanz 3100 (Projekt `chromium`, WEB_INDEXING_ENABLED nicht gesetzt) gegen die Haupt-API
 * 3101, deren Basis `MAIL_PUBLIC_WEB_BASE_URL=http://127.0.0.1:3100` sogar gültig wäre.
 *
 * SEO-C6 robots.txt bleibt crawlbar (`Allow: /`, `Disallow: /api/`), nennt aber KEINE Sitemap und
 * sperrt NICHT alles (Google: robots.txt hält nichts aus dem Index – noindex muss gelesen werden
 * können); Startseite, Slush, Konfigurator und Region sind noindex ohne Canonical, og:url und
 * JSON-LD; die Sitemap ist leer; Legacy-Redirects (308) und 410 funktionieren unabhängig vom
 * Indexierungs-Schalter. Dev-Server: Header-Prüfungen tolerant (kein Cache-Control-Vergleich).
 *
 * Daten: Basis-Seed + apps/api/scripts/e2e-website-seed.ts (alle Standardseiten veröffentlicht –
 * die Seiten SIND veröffentlicht, nur der Schalter fehlt).
 */
import { expect, test } from '@playwright/test';
import { resetE2eDatabase } from '../helpers/seed.ts';
import {
  canonicalHrefs,
  fetchBootstrap,
  jsonLdScripts,
  ownLocationPath,
  parseRobots,
  parseSitemap,
  rawCanonicals,
  rawRobots,
  robotsAllows,
  robotsMetas,
} from '../helpers/seo.ts';
import { WEB_ORIGIN, seedWebsite } from '../helpers/website.ts';

test.describe.configure({ mode: 'serial' });

const NO_REDIRECT = { maxRedirects: 0 } as const;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  resetE2eDatabase();
  seedWebsite('main');
  const bootstrap = await fetchBootstrap();
  expect(bootstrap.publicBaseUrl, 'Basis der API ist gesetzt – der Schalter fehlt').toBe(
    WEB_ORIGIN,
  );
  expect(bootstrap.pages.length).toBeGreaterThan(0);
});

test('SEO-C6 Indexierung aus: robots.txt ohne Sitemap-Zeile (crawlbar, nur /api/ gesperrt), alle Seiten noindex ohne Canonical/og:url/JSON-LD, leere Sitemap', async ({
  request,
  page,
}) => {
  test.setTimeout(240_000);
  const robotsResponse = await request.get(`${WEB_ORIGIN}/robots.txt`, NO_REDIRECT);
  expect(robotsResponse.status()).toBe(200);
  const robots = await robotsResponse.text();
  expect(robots).toMatch(/^User-Agent: \*$/m);
  expect(robots).toMatch(/^Allow: \/$/m);
  expect(robots).toMatch(/^Disallow: \/api\/$/m);
  expect(robots, 'kein „Disallow: /“ – noindex muss gelesen werden können').not.toMatch(
    /^Disallow: \/\s*$/m,
  );
  expect(robots, 'keine Sitemap-Zeile').not.toMatch(/^Sitemap:/m);
  expect(robots).not.toMatch(/^Allow: \/api\/public\/cms\/media\/$/m);
  expect(robots).not.toMatch(/token/i);
  const group = parseRobots(robots);
  expect(group.sitemaps).toEqual([]);
  expect(robotsAllows(group, '/')).toBe(true);
  expect(robotsAllows(group, '/konto')).toBe(true);
  expect(robotsAllows(group, '/api/public/site/settings')).toBe(false);

  const sitemapResponse = await request.get(`${WEB_ORIGIN}/sitemap.xml`, NO_REDIRECT);
  expect(sitemapResponse.status()).toBe(200);
  expect(parseSitemap(await sitemapResponse.text()), 'leere Sitemap').toEqual([]);

  for (const path of [
    '/',
    '/slushmaschine-mieten',
    '/konfigurator',
    '/slushmaschine-mieten/mainz',
  ]) {
    const response = await page.goto(`${WEB_ORIGIN}${path}`, { timeout: 90_000 });
    expect(response?.status(), `GET ${path}`).toBe(200);
    await expect(page.locator('h1')).toHaveCount(1);
    const robotsMeta = await robotsMetas(page);
    expect(robotsMeta.length, `${path}: robots-Meta`).toBeGreaterThanOrEqual(1);
    for (const content of robotsMeta) expect(content, `${path}: noindex`).toContain('noindex');
    expect(await canonicalHrefs(page), `${path}: kein Canonical`).toEqual([]);
    await expect(page.locator('meta[property="og:url"]'), `${path}: kein og:url`).toHaveCount(0);
    await expect(page.locator('meta[property^="og:image"]'), `${path}: kein og:image`).toHaveCount(
      0,
    );
    expect(await jsonLdScripts(page), `${path}: kein JSON-LD`).toEqual([]);
    // Crawler-Sicht ohne JavaScript: dasselbe im ausgelieferten HTML.
    const raw = await (await request.get(`${WEB_ORIGIN}${path}`, NO_REDIRECT)).text();
    expect(rawCanonicals(raw)).toEqual([]);
    expect(rawRobots(raw).every((content) => content.includes('noindex'))).toBe(true);
    expect(raw).not.toContain('application/ld+json');
  }
  // Brotkrume (UX) bleibt auf der Regionsseite sichtbar – nur ohne BreadcrumbList.
  await expect(page.getByTestId('site-breadcrumbs')).toBeVisible();
});

test('SEO-C6 Redirects und 410 funktionieren unabhängig vom Indexierungs-Schalter: /buchung/ ⇒ ein 308 /konfigurator, /ueber-uns/ ⇒ /ueber-uns, /shop/ ⇒ 410 noindex', async ({
  request,
}) => {
  const buchung = await request.get(`${WEB_ORIGIN}/buchung/`, NO_REDIRECT);
  expect(buchung.status()).toBe(308);
  expect(ownLocationPath(buchung.headers()['location'], WEB_ORIGIN)).toBe('/konfigurator');
  expect((await request.get(`${WEB_ORIGIN}/konfigurator`, NO_REDIRECT)).status()).toBe(200);

  const ueberUns = await request.get(`${WEB_ORIGIN}/ueber-uns/?a=1`, NO_REDIRECT);
  expect(ueberUns.status()).toBe(308);
  const location = new URL(ownLocationPath(ueberUns.headers()['location'], WEB_ORIGIN), WEB_ORIGIN);
  expect(location.pathname).toBe('/ueber-uns');
  expect(location.searchParams.get('a')).toBe('1');

  const gone = await request.get(`${WEB_ORIGIN}/shop/`, NO_REDIRECT);
  expect(gone.status()).toBe(410);
  expect(gone.headers()['x-robots-tag']).toContain('noindex');
  const html = await gone.text();
  expect(html).toContain('<meta name="robots" content="noindex');
  expect(html).toContain('Diese Seite gibt es nicht mehr.');
  expect(html).toContain('href="/kontakt"');
  expect((await request.head(`${WEB_ORIGIN}/shop`, NO_REDIRECT)).status()).toBe(410);

  const missing = await request.get(`${WEB_ORIGIN}/gibt-es-nicht`, NO_REDIRECT);
  expect(missing.status()).toBe(404);
  expect(await missing.text()).toContain('noindex');
});
