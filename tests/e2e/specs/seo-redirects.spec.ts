/**
 * Phase-17-E2E (Auftrag §6–§8, §17, §28 R1–R9) – Legacy-Redirects, 410, 404 und kanonischer Host
 * gegen den PRODUCTION-Build der Website (Projekt `seo`, Port 3112, Haupt-API 3101).
 *
 * Datenbasis jeder Zeile: docs/REDIRECT_MATRIX.md (beide Tabellen werden zur Laufzeit geparst –
 * jede dokumentierte Alt-URL wird geprüft, mit und ohne Schluss-Slash sowie in einer
 * Großschreib-Variante).
 *
 * SEO-R1 genau EIN permanenter Redirect (308) je Alt-URL · SEO-R2 kein Redirect-Loop · SEO-R3 keine
 * Redirect-Kette · SEO-R4 Query/Host-Header erzeugen kein externes Ziel · SEO-R5 410-Pfade echter
 * HTTP 410 · SEO-R6 410-Seite noindex (Meta + X-Robots-Tag), Links, HEAD · SEO-R7 unveröffentlichte
 * CMS-Seite ⇒ 404 · SEO-R8 404 noindex · SEO-R9 www-/Host-Regel dokumentiert, kein Hostname im
 * Web-Code, Host-Header-Poisoning wirkungslos. Zusätzlich: API-Durchreichung und statische Assets
 * bleiben vom Proxy unberührt.
 *
 * Daten: Basis-Seed + apps/api/scripts/e2e-website-seed.ts (alle Standardseiten veröffentlicht);
 * R7 zieht die Regionsseite Mainz über die Staff-API zurück (die nächste Spec seedet neu).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { resetE2eDatabase } from '../helpers/seed.ts';
import {
  REPO_ROOT,
  SEO_PUBLIC_BASE,
  SEO_WEB_ORIGIN,
  ownLocationPath,
  rawCanonicals,
  rawRequest,
  redirectMatrixRows,
  staffApi,
  unpublishEntry,
  type MatrixRow,
} from '../helpers/seo.ts';
import { entryIdOf, seedWebsite, type WebsiteSeedResult } from '../helpers/website.ts';

test.describe.configure({ mode: 'serial' });

const GONE_HEADLINE = 'Diese Seite gibt es nicht mehr.';
const NOT_FOUND_TITLE = '<title>Seite nicht gefunden – Miet-Royal</title>';
const NO_REDIRECT = { maxRedirects: 0 } as const;
/** Legacy-Tabellen-Redirects: öffentliche Alt-URLs, cachebar (lib/legacy-routes.ts). */
const LEGACY_CACHE = 'public, max-age=3600';
/** Slash-Normalisierung (auch Token-/Portal-Pfade): nie cachen. */
const SLASH_CACHE = 'private, no-store';

let seed: WebsiteSeedResult;
let api: APIRequestContext;
let rows: MatrixRow[];

/** `/buchung/` ⇒ `/Buchung/` (erster Buchstabe groß). */
function capitalized(path: string): string {
  return path.replace(/^\/([a-z])/, (_match, letter: string) => `/${letter.toUpperCase()}`);
}

function withoutSlash(path: string): string {
  return path.endsWith('/') && path !== '/' ? path.replace(/\/+$/, '') : path;
}

function withSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

/** Einziger 308-Hop: Status, Cache-Control (exakt, wenn angegeben), eigene Location ⇒ Pfad (+ Query). */
async function expectSingleRedirect(
  response: APIResponse,
  label: string,
  cacheControl?: string,
): Promise<string> {
  expect(response.status(), `${label}: Status 308`).toBe(308);
  const headers = response.headers();
  expect(headers['cache-control'], `${label}: cache-control vorhanden`).toBeTruthy();
  if (cacheControl !== undefined) {
    expect(headers['cache-control'], `${label}: cache-control`).toBe(cacheControl);
  }
  return ownLocationPath(headers['location'], SEO_WEB_ORIGIN);
}

/** Alle Quelldateien (ohne Tests) unter den Produktverzeichnissen von apps/web. */
function webSourceFiles(): string[] {
  const roots = ['apps/web/app', 'apps/web/lib', 'apps/web/components'].map((dir) =>
    resolve(REPO_ROOT, dir),
  );
  const files: string[] = [resolve(REPO_ROOT, 'apps/web/proxy.ts')];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|css|mjs|js)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(full);
    }
  };
  roots.forEach(walk);
  return files;
}

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(300_000);
  resetE2eDatabase();
  seed = seedWebsite('main');
  api = await staffApi(playwright);
  rows = redirectMatrixRows();
  // Die Matrix ist die verbindliche Liste – sie darf nicht leer oder verkürzt sein.
  expect(rows.filter((row) => row.result === '308').map((row) => row.documented)).toEqual(
    expect.arrayContaining([
      '/maschinen-zubehoer/',
      '/buchung/',
      '/uber-uns/',
      '/kontaktformular/',
      '/metform-form/contact-form/',
      '/book-appointment/',
      '/mein-konto/',
      '/my-bookings/',
      '/sitemap_index.xml',
    ]),
  );
  expect(rows.filter((row) => row.result === '410').length).toBeGreaterThanOrEqual(12);
  expect(rows.filter((row) => row.result === '308-slash').map((row) => row.documented)).toEqual(
    expect.arrayContaining(['/ablauf/', '/impressum/', '/datenschutz/', '/konto/']),
  );
});

test.afterAll(async () => {
  await api?.dispose();
});

// ── SEO-R1 ──────────────────────────────────────────────────────────────

test('SEO-R1 Jede 308-Zeile der Redirect-Matrix antwortet mit genau EINEM 308 (mit/ohne Schluss-Slash, Großschreibung), eigener Location und passendem Cache-Control (Legacy public 1 h, Slash private no-store)', async ({
  request,
}) => {
  test.setTimeout(240_000);
  for (const row of rows.filter((candidate) => candidate.result === '308')) {
    const base = withoutSlash(row.path);
    const variants = [base, withSlash(base), capitalized(withSlash(base)), capitalized(base)];
    for (const variant of new Set(variants)) {
      const response = await request.get(variant, NO_REDIRECT);
      const location = await expectSingleRedirect(response, `GET ${variant}`, LEGACY_CACHE);
      expect(location, `GET ${variant} ⇒ ${row.target}`).toBe(row.target);
    }
  }
  // Gleiche Pfade der Alt-Seite: nur Slash-Normalisierung, Schreibweise bleibt (Next-Routen sind
  // case-sensitive – `/Ablauf` ist eine andere Adresse und endet als 404, siehe Matrix).
  for (const row of rows.filter((candidate) => candidate.result === '308-slash')) {
    const base = withoutSlash(row.path);
    expect(row.target, `Ziel der Slash-Zeile ${row.documented}`).toBe(base);
    for (const variant of [withSlash(base), capitalized(withSlash(base))]) {
      const response = await request.get(variant, NO_REDIRECT);
      const location = await expectSingleRedirect(response, `GET ${variant}`, SLASH_CACHE);
      expect(location, `GET ${variant} ⇒ ohne Schluss-Slash`).toBe(withoutSlash(variant));
    }
  }
});

// ── SEO-R2 ──────────────────────────────────────────────────────────────

test('SEO-R2 Kein Redirect-Loop: jedes Redirect-Ziel antwortet mit 200, nie mit einem weiteren 3xx', async ({
  request,
}) => {
  test.setTimeout(240_000);
  const targets = new Set<string>();
  for (const row of rows) {
    if (row.result === '308') targets.add(row.target!);
    if (row.result === '308-slash') targets.add(withoutSlash(row.path));
  }
  expect(targets.size).toBeGreaterThanOrEqual(6);
  for (const target of targets) {
    const response = await request.get(target, NO_REDIRECT);
    expect(response.status(), `GET ${target} (Ziel) ohne weiteren Redirect`).toBe(200);
    expect(response.headers()['location'], `GET ${target}: keine Location`).toBeUndefined();
  }
  // Manuell verfolgte Kette: nach höchstens 2 Hops muss ein 200 stehen – tatsächlich nach 1.
  for (const row of rows.filter((candidate) => candidate.result === '308')) {
    let path = withSlash(withoutSlash(row.path));
    let hops = 0;
    let status = 0;
    while (hops <= 2) {
      const response = await request.get(path, NO_REDIRECT);
      status = response.status();
      if (status < 300 || status >= 400) break;
      path = ownLocationPath(response.headers()['location'], SEO_WEB_ORIGIN);
      hops += 1;
    }
    expect(hops, `${row.documented}: genau ein Hop`).toBe(1);
    expect(status, `${row.documented}: Endstatus`).toBe(200);
  }
});

// ── SEO-R3 ──────────────────────────────────────────────────────────────

test('SEO-R3 Keine Redirect-Kette: /ueber-uns/ ⇒ /ueber-uns, /uber-uns/ direkt ⇒ /ueber-uns, Slash-Normalisierung behält die Query und ist private/no-store (auch Token-/Portal-Pfade)', async ({
  request,
}) => {
  const ueberUns = await request.get('/ueber-uns/', NO_REDIRECT);
  expect(await expectSingleRedirect(ueberUns, 'GET /ueber-uns/', SLASH_CACHE)).toBe('/ueber-uns');
  expect((await request.get('/ueber-uns', NO_REDIRECT)).status()).toBe(200);

  // Alt-Schreibweise in EINEM Hop auf die neue Schreibweise (kein Zwischenziel /uber-uns).
  const uberUns = await request.get('/uber-uns/', NO_REDIRECT);
  expect(await expectSingleRedirect(uberUns, 'GET /uber-uns/', LEGACY_CACHE)).toBe('/ueber-uns');

  // Query bleibt bei reiner Slash-Normalisierung erhalten (Next kodiert sie ggf. neu).
  const ablauf = await request.get('/ablauf/?a=1', NO_REDIRECT);
  const ablaufLocation = await expectSingleRedirect(ablauf, 'GET /ablauf/?a=1', SLASH_CACHE);
  const ablaufUrl = new URL(ablaufLocation, SEO_WEB_ORIGIN);
  expect(ablaufUrl.pathname).toBe('/ablauf');
  expect(ablaufUrl.searchParams.get('a')).toBe('1');
  expect((await request.get(ablaufLocation, NO_REDIRECT)).status()).toBe(200);

  const konfigurator = await request.get('/konfigurator/?maschine=slush-1x8', NO_REDIRECT);
  const konfiguratorLocation = await expectSingleRedirect(
    konfigurator,
    'GET /konfigurator/?maschine=slush-1x8',
  );
  const konfiguratorUrl = new URL(konfiguratorLocation, SEO_WEB_ORIGIN);
  expect(konfiguratorUrl.pathname).toBe('/konfigurator');
  expect(konfiguratorUrl.searchParams.get('maschine')).toBe('slush-1x8');
  expect((await request.get(konfiguratorLocation, NO_REDIRECT)).status()).toBe(200);

  // Token-/Portal-Pfade mit Schluss-Slash: ein 308 auf den Pfad ohne Slash, NIE cachebar
  // (Token-URL und Location gehören in keinen gemeinsamen Cache).
  const tokenPath = '/angebot/abcdefghijklmnopqrstuvwxyz0123456789';
  const token = await request.get(`${tokenPath}/`, NO_REDIRECT);
  expect(await expectSingleRedirect(token, `GET ${tokenPath}/`, SLASH_CACHE)).toBe(tokenPath);
  const konto = await request.get('/konto/', NO_REDIRECT);
  expect(await expectSingleRedirect(konto, 'GET /konto/', SLASH_CACHE)).toBe('/konto');
  expect(konto.headers()['x-robots-tag'], '/konto/: Portal-Header bleibt').toContain('noindex');
});

// ── SEO-R4 ──────────────────────────────────────────────────────────────

test('SEO-R4 Query, Doppel-Slash, Backslash, Prozentkodierung und gefälschte Host-Header erzeugen kein externes Redirect-Ziel', async ({
  request,
}) => {
  // Legacy-Redirects verwerfen die Query vollständig.
  const buchung = await request.get('/buchung/?next=https://evil.example', NO_REDIRECT);
  expect(await expectSingleRedirect(buchung, 'GET /buchung/?next=…', LEGACY_CACHE)).toBe(
    '/konfigurator',
  );
  const uberUns = await request.get('/uber-uns/?url=//evil.example', NO_REDIRECT);
  expect(await expectSingleRedirect(uberUns, 'GET /uber-uns/?url=…', LEGACY_CACHE)).toBe(
    '/ueber-uns',
  );

  // Slash-Normalisierung: Pfad bleibt /ablauf, der Query-Wert wandert nur als Query mit.
  const ablauf = await request.get('/ablauf/?x=//evil.example', NO_REDIRECT);
  const ablaufLocation = await expectSingleRedirect(ablauf, 'GET /ablauf/?x=//evil.example');
  expect(new URL(ablaufLocation, SEO_WEB_ORIGIN).pathname).toBe('/ablauf');

  // Fehlgeformte Pfade: entweder 404 oder ein Redirect, dessen Location relativ (genau ein
  // führender `/`) bzw. auf dem eigenen Origin bleibt – nie `//host`, nie fremder Host. Mehrfach-
  // Slashes normalisiert Next selbst VOR dem Proxy (akzeptierte Ausnahme: dort sind zwei Hops
  // möglich, z. B. `/buchung//` ⇒ `/buchung/` ⇒ `/konfigurator`); geprüft wird hier nur der Host.
  const attempts = [
    '//evil.example/',
    '///evil.example/',
    '/\\evil.example/',
    '/%5Cevil.example/',
    '/buchung/%2F%2Fevil.example',
    '/%2F%2Fevil.example/',
    '/buchung//',
    '/buchung/..%2F%2Fevil.example/',
  ];
  for (const attempt of attempts) {
    const response = await request.get(`${SEO_WEB_ORIGIN}${attempt}`, NO_REDIRECT);
    const status = response.status();
    const location = response.headers()['location'];
    if (status >= 300 && status < 400) {
      const path = ownLocationPath(location, SEO_WEB_ORIGIN);
      expect(path, `GET ${attempt}: Location ohne Protokoll-relativen Host`).not.toMatch(/^\/\//);
      expect(new URL(path, SEO_WEB_ORIGIN).host, `GET ${attempt}: eigener Host`).toBe(
        new URL(SEO_WEB_ORIGIN).host,
      );
    } else {
      expect([200, 404], `GET ${attempt}: Status`).toContain(status);
      expect(location, `GET ${attempt}: keine Location ohne Redirect`).toBeUndefined();
    }
  }

  // WordPress-Shortlinks/Suche: Startseite ohne Redirect (Matrix „200“).
  for (const row of rows.filter((candidate) => candidate.result === '200')) {
    const response = await request.get(row.path, NO_REDIRECT);
    expect(response.status(), `GET ${row.path}`).toBe(200);
  }

  // Host-Header-Poisoning (Auftrag §8): die Location wird nie aus Host-/Forwarded-Headern gebaut.
  const poisoned = await rawRequest(SEO_WEB_ORIGIN, '/buchung/', {
    Host: 'evil.example',
    'X-Forwarded-Host': 'evil.example',
    'X-Forwarded-Proto': 'https',
    Forwarded: 'host=evil.example;proto=https',
  });
  expect(poisoned.status, 'Host-Poisoning: Status').toBe(308);
  const poisonedLocation = String(poisoned.headers['location'] ?? '');
  expect(poisonedLocation, 'Host-Poisoning: fremder Host fehlt in der Location').not.toContain(
    'evil.example',
  );
  const poisonedUrl = new URL(poisonedLocation, SEO_WEB_ORIGIN);
  expect(['127.0.0.1', 'localhost'], 'Host-Poisoning: eigener Host').toContain(
    poisonedUrl.hostname,
  );
  expect(poisonedUrl.pathname).toBe('/konfigurator');
});

// ── SEO-R5 ──────────────────────────────────────────────────────────────

test('SEO-R5 Jede 410-Zeile der Matrix liefert echten HTTP 410 (beide Schreibweisen) als text/html; Unterpfade bleiben 404', async ({
  request,
}) => {
  test.setTimeout(180_000);
  for (const row of rows.filter((candidate) => candidate.result === '410')) {
    const base = withoutSlash(row.path);
    for (const variant of new Set([base, withSlash(base), capitalized(withSlash(base))])) {
      const response = await request.get(variant, NO_REDIRECT);
      expect(response.status(), `GET ${variant}`).toBe(410);
      expect(response.headers()['content-type'], `GET ${variant}: content-type`).toBe(
        'text/html; charset=utf-8',
      );
      expect(response.headers()['location'], `GET ${variant}: keine Location`).toBeUndefined();
    }
  }
  // 410 nur für exakte Pfade – ein Unterpfad ist keine bekannte Alt-URL (404, noindex, s. R8).
  const sub = await request.get('/shop/irgendwas', NO_REDIRECT);
  expect(sub.status()).toBe(404);
});

// ── SEO-R6 ──────────────────────────────────────────────────────────────

test('SEO-R6 410-Seite: noindex als Meta und X-Robots-Tag, Links auf Start/Slush/Kontakt, verständlicher Text, kein Script; HEAD ebenfalls 410', async ({
  request,
  page,
}) => {
  const response = await request.get('/shop/', NO_REDIRECT);
  expect(response.status()).toBe(410);
  const headers = response.headers();
  expect(headers['x-robots-tag']).toContain('noindex');
  expect(headers['cache-control']).toContain('max-age');
  expect(headers['x-content-type-options']).toBe('nosniff');
  const html = await response.text();
  expect(html).toContain('<meta name="robots" content="noindex');
  expect(html).toContain('<html lang="de">');
  expect(html).toContain(GONE_HEADLINE);
  expect(html).toContain('href="/"');
  expect(html).toContain('href="/slushmaschine-mieten"');
  expect(html).toContain('href="/kontakt"');
  expect(html).toContain('href="/konfigurator"');
  expect(html.match(/<h1\b/g)?.length, 'genau eine H1').toBe(1);
  expect(html).not.toContain('<script');
  expect(html).not.toMatch(/https?:\/\//);
  expect(html).not.toContain('rel="canonical"');
  expect(html).not.toContain('application/ld+json');
  expect(html).not.toMatch(/buchen/i);

  const head = await request.head('/shop/', NO_REDIRECT);
  expect(head.status(), 'HEAD /shop/').toBe(410);
  expect(head.headers()['x-robots-tag']).toContain('noindex');

  // Ohne Slash identisch; im Browser gerendert: Überschrift und Links sichtbar.
  const plain = await request.get('/warenkorb', NO_REDIRECT);
  expect(plain.status()).toBe(410);
  expect(await plain.text()).toContain(GONE_HEADLINE);
  const rendered = await page.goto('/shop', { timeout: 60_000 });
  expect(rendered?.status()).toBe(410);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(GONE_HEADLINE);
  await expect(page.getByRole('link', { name: 'Zur Startseite' })).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: 'Slushmaschine mieten' })).toHaveAttribute(
    'href',
    '/slushmaschine-mieten',
  );
  await expect(page.getByRole('link', { name: 'Kontakt' })).toHaveAttribute('href', '/kontakt');
});

// ── SEO-R7 ──────────────────────────────────────────────────────────────

test('SEO-R7 Zurückgezogene CMS-Seite (Region Mainz) antwortet mit echtem 404 – noindex, „Seite nicht gefunden“, kein Canonical, nicht in der Sitemap', async ({
  request,
  page,
}) => {
  const path = '/slushmaschine-mieten/mainz';
  expect((await request.get(path, NO_REDIRECT)).status(), 'vor dem Zurückziehen').toBe(200);
  const detail = await unpublishEntry(api, entryIdOf(seed, path));
  expect(detail.published).toBeNull();

  const response = await request.get(path, NO_REDIRECT);
  expect(response.status(), `GET ${path} nach dem Zurückziehen`).toBe(404);
  const html = await response.text();
  expect(html).toContain('noindex');
  expect(html).toContain(NOT_FOUND_TITLE);
  expect(rawCanonicals(html), 'kein Canonical auf der 404').toEqual([]);
  expect(html).not.toContain('application/ld+json');
  const apiPage = await request.get(`/api/public/site/page?path=${encodeURIComponent(path)}`);
  expect(apiPage.status(), 'Seiten-API').toBe(404);
  const sitemap = await (await request.get('/sitemap.xml', NO_REDIRECT)).text();
  expect(sitemap).not.toContain(`${SEO_PUBLIC_BASE}${path}<`);

  const rendered = await page.goto(path, { timeout: 60_000 });
  expect(rendered?.status()).toBe(404);
  await expect(page.getByTestId('site-not-found')).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveTitle('Seite nicht gefunden – Miet-Royal');
  await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute('content', /noindex/);
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
});

// ── SEO-R8 ──────────────────────────────────────────────────────────────

test('SEO-R8 404-Seite: Status 404, noindex, Titel „Seite nicht gefunden“, Navigation zu Start/Konfigurator; alle 404-Zeilen der Matrix', async ({
  request,
  page,
}) => {
  test.setTimeout(180_000);
  const notFoundPaths = [
    '/gibt-es-nicht',
    '/shop/irgendwas',
    '/slushmaschine-mieten/gibt-es-nicht',
    '/Ablauf',
    '/wp-content/uploads/2026/01/bild.jpg',
  ];
  for (const row of rows.filter((candidate) => candidate.result === '404')) {
    if (row.path.endsWith('/') && row.path !== '/') {
      // `/wp-json/`, `/tag/`: zuerst die allgemeine Slash-Normalisierung, dann 404.
      const redirect = await request.get(row.path, NO_REDIRECT);
      expect(await expectSingleRedirect(redirect, `GET ${row.path}`, SLASH_CACHE)).toBe(
        withoutSlash(row.path),
      );
      notFoundPaths.push(withoutSlash(row.path));
    } else {
      notFoundPaths.push(row.path);
    }
  }
  for (const path of new Set(notFoundPaths)) {
    const response = await request.get(path, NO_REDIRECT);
    expect(response.status(), `GET ${path}`).toBe(404);
    const html = await response.text();
    expect(html, `${path}: noindex`).toContain('noindex');
    expect(html, `${path}: Titel`).toContain(NOT_FOUND_TITLE);
    expect(rawCanonicals(html), `${path}: kein Canonical`).toEqual([]);
    expect(html, `${path}: kein JSON-LD`).not.toContain('application/ld+json');
  }

  const rendered = await page.goto('/gibt-es-nicht', { timeout: 60_000 });
  expect(rendered?.status()).toBe(404);
  await expect(page.getByTestId('site-not-found')).toBeVisible();
  await expect(page).toHaveTitle('Seite nicht gefunden – Miet-Royal');
  await expect(page.locator('h1')).toHaveCount(1);
  await expect(page.getByTestId('site-nav')).toBeVisible();
  const notFound = page.getByTestId('site-not-found');
  await expect(notFound.getByRole('link', { name: 'Zur Startseite' })).toHaveAttribute('href', '/');
  await expect(notFound.getByRole('link', { name: 'Slush konfigurieren' })).toHaveAttribute(
    'href',
    '/konfigurator',
  );
  const robots = await page
    .locator('meta[name="robots"]')
    .evaluateAll((elements) => elements.map((el) => el.getAttribute('content') ?? ''));
  expect(robots.length).toBeGreaterThanOrEqual(1);
  for (const content of robots) expect(content).toContain('noindex');
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
  // Kein technischer Fehlercode in der Oberfläche (CLAUDE.md UX).
  expect(await notFound.innerText()).not.toMatch(/\b404\b|NOT_FOUND|Error/);
});

// ── SEO-R9 ──────────────────────────────────────────────────────────────

test('SEO-R9 Kanonischer Host www.miet-royal.de ist dokumentiert (Reverse-Proxy), kein Hostname im Web-Code; gefälschte Host-Header ändern den Canonical nicht', async () => {
  const matrix = readFileSync(resolve(REPO_ROOT, 'docs/REDIRECT_MATRIX.md'), 'utf8');
  expect(matrix).toContain('www.miet-royal.de');
  expect(matrix).toContain('Kanonischer Host');
  expect(matrix).toContain('DEPLOYMENT_NOTES');
  const architecture = readFileSync(resolve(REPO_ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  expect(architecture).toContain('www.miet-royal.de');

  // Kein Hostname im Produktcode der Website (Host-Regel liegt ausschließlich im Proxy/der Doku).
  const offenders = webSourceFiles().filter((file) =>
    /miet-royal\.de/i.test(readFileSync(file, 'utf8')),
  );
  expect(offenders, 'Dateien mit Hostnamen miet-royal.de').toEqual([]);
  // Der Proxy baut die Location nie aus Request-Headern.
  const proxySource = readFileSync(resolve(REPO_ROOT, 'apps/web/proxy.ts'), 'utf8');
  expect(proxySource).not.toMatch(/request\.headers|x-forwarded|request\.url\b/);

  // Host-Header-Poisoning: Canonical/og:url bleiben die konfigurierte Basis, nicht der Host-Header.
  const poisoned = await rawRequest(SEO_WEB_ORIGIN, '/kontakt', {
    Host: 'evil.example',
    'X-Forwarded-Host': 'evil.example',
    'X-Forwarded-Proto': 'https',
  });
  expect(poisoned.status).toBe(200);
  expect(rawCanonicals(poisoned.body)).toEqual([`${SEO_PUBLIC_BASE}/kontakt`]);
  expect(poisoned.body).toContain(`property="og:url" content="${SEO_PUBLIC_BASE}/kontakt"`);
  expect(poisoned.body).not.toContain('evil.example');
});

// ── Unberührt vom Proxy ─────────────────────────────────────────────────

test('SEO-R-Durchreichung: /api/* bleibt der API-Rewrite (health 200), statische Assets, favicon.ico und robots/sitemap sind erreichbar, /robots.txt/ wird normalisiert', async ({
  request,
}) => {
  const health = await request.get('/api/health', NO_REDIRECT);
  expect(health.status()).toBe(200);
  expect(health.headers()['content-type']).toContain('application/json');
  const logo = await request.get('/google-maps-logo-gray.svg', NO_REDIRECT);
  expect(logo.status()).toBe(200);
  expect(logo.headers()['content-type']).toContain('image/svg+xml');
  const robots = await request.get('/robots.txt', NO_REDIRECT);
  expect(robots.status()).toBe(200);
  expect(robots.headers()['content-type']).toContain('text/plain');
  const robotsSlash = await request.get('/robots.txt/', NO_REDIRECT);
  expect(await expectSingleRedirect(robotsSlash, 'GET /robots.txt/', SLASH_CACHE)).toBe(
    '/robots.txt',
  );
  const favicon = await request.get('/favicon.ico', NO_REDIRECT);
  expect(favicon.status(), 'GET /favicon.ico').toBe(200);
  expect(favicon.headers()['content-type']).toContain('image/x-icon');
  const sitemap = await request.get('/sitemap.xml', NO_REDIRECT);
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()['content-type']).toContain('xml');
});
