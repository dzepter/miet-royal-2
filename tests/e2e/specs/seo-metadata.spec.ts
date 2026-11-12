/**
 * Phase-17-E2E (Auftrag §3–§5, §9–§13, §16, §22, §28 C/M/S, §29) – Canonicals, Metadaten,
 * Sitemap und strukturierte Daten gegen den PRODUCTION-Build der Website (Projekt `seo`,
 * Port 3112, `WEB_INDEXING_ENABLED=true`, Haupt-API 3101 mit konfigurierter Basis
 * `http://127.0.0.1:3100`).
 *
 * Kern-Beleg „keine Host-Ableitung“: alle Anfragen laufen über Port 3112, jede absolute SEO-URL
 * (Canonical, og:url, Sitemap, JSON-LD) muss auf die KONFIGURIERTE Basis 3100 zeigen.
 *
 * SEO-C1 absolute Canonicals · SEO-C2 Konfigurator-Query ⇒ Canonical ohne Query · SEO-C3 Region
 * self-canonical (kein Duplicate auf Mainz) · SEO-C4 Vorschau/Portal/Token nie index (auch mit
 * echtem Vorschau-Token) · SEO-C5 Demo: website-demo.spec.ts (Projekt demo-communication) ·
 * SEO-C6 Indexierung aus: website-seo-disabled.spec.ts (Projekt chromium) · SEO-C7 Basis-Validierung
 * ist Unit (apps/web/lib/site-seo.test.ts); hier die E2E-Variante „Request-Host ≠ Basis“ ·
 * SEO-M1–M6 Title/Description/OpenGraph/Twitter/Preis-Guard/H1 · SEO-S1–S7 Sitemap ·
 * SEO-SD1–SD8 JSON-LD (WebSite, Organization, BreadcrumbList, Verbotsliste, Escaping).
 *
 * Daten: Basis-Seed + apps/api/scripts/e2e-website-seed.ts; S2/S4/S5/S7 verändern den Zustand über
 * die Staff-API (Entwurf, Zurückziehen, neue Regionsseite, Produkt-Aktivierung) – die nächste Spec
 * seedet neu. Vorschau-Tokens erscheinen nie in Ausgaben.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { berlinDayPlus } from '../helpers/settlement.ts';
import { resetE2eDatabase } from '../helpers/seed.ts';
import {
  FORBIDDEN_JSONLD_KEYS,
  FORBIDDEN_JSONLD_TYPES,
  PRICE_TEXT_PATTERN,
  SEO_PUBLIC_BASE,
  SEO_WEB_ORIGIN,
  canonicalHrefs,
  collectJsonLdKeys,
  collectJsonLdTypes,
  createRegionDraft,
  fetchBootstrap,
  getEntry,
  indexablePaths,
  jsonLdScripts,
  loadSitemap,
  metaName,
  metaProperty,
  parseRobots,
  previewToken,
  publishEntry,
  rawCanonicals,
  rawRequest,
  rawRobots,
  robotsAllows,
  robotsMetas,
  saveDraft,
  setProductActive,
  sitemapPaths,
  staffApi,
  staffProducts,
  unpublishEntry,
  type SeoBootstrap,
} from '../helpers/seo.ts';
import {
  EXACT_PICKUP_FRAGMENTS,
  entryIdOf,
  fetchCatalog,
  fillEvent,
  nextStep,
  openConfigurator,
  priceText,
  seedWebsite,
  type PublicCatalogDto,
  type WebsiteSeedResult,
} from '../helpers/website.ts';

test.describe.configure({ mode: 'serial' });

const NO_REDIRECT = { maxRedirects: 0 } as const;
const PRIVATE_PATHS = [
  '/vorschau',
  '/vorschau/seite',
  '/konto',
  '/konto/anmelden',
  '/angebot/ungueltigertoken',
  '/dokument/ungueltig',
  '/kontakt/ungueltigertoken',
] as const;
const REGION_PATHS = [
  '/slushmaschine-mieten/mainz',
  '/slushmaschine-mieten/wiesbaden',
  '/slushmaschine-mieten/bad-kreuznach',
] as const;

let seed: WebsiteSeedResult;
let api: APIRequestContext;
let bootstrap: SeoBootstrap;
let catalog: PublicCatalogDto;

function canonicalFor(path: string): string {
  return `${SEO_PUBLIC_BASE}${path}`;
}

/** Veröffentlichter Titel der Slush-Seite (Beschriftung der mittleren Brotkrume, D11). */
function slushTitle(): string {
  const slush = bootstrap.pages.find((entry) => entry.path === '/slushmaschine-mieten');
  expect(slush, 'Slush-Seite im Bootstrap').toBeDefined();
  return slush!.title;
}

async function open(page: Page, path: string): Promise<number> {
  const response = await page.goto(path, { timeout: 60_000 });
  return response?.status() ?? 0;
}

interface PageMeta {
  path: string;
  title: string;
  description: string | null;
  robots: string[];
  canonical: string[];
  og: Record<string, string | null>;
  twitter: Record<string, string | null>;
  h1: number;
}

async function collectMeta(page: Page, path: string): Promise<PageMeta> {
  expect(await open(page, path), `GET ${path}`).toBe(200);
  const og: Record<string, string | null> = {};
  for (const key of ['title', 'description', 'type', 'url', 'locale', 'site_name', 'image']) {
    og[key] = await metaProperty(page, `og:${key}`);
  }
  const twitter: Record<string, string | null> = {};
  for (const key of ['card', 'title', 'description', 'image']) {
    twitter[key] = await metaName(page, `twitter:${key}`);
  }
  return {
    path,
    title: await page.title(),
    description: await metaName(page, 'description'),
    robots: await robotsMetas(page),
    canonical: await canonicalHrefs(page),
    og,
    twitter,
    h1: await page.locator('h1').count(),
  };
}

function expectIndexable(meta: PageMeta): void {
  expect(meta.robots.length, `${meta.path}: robots-Meta vorhanden`).toBeGreaterThanOrEqual(1);
  for (const content of meta.robots) {
    expect(content, `${meta.path}: robots`).toMatch(/\bindex\b/);
    expect(content, `${meta.path}: robots`).not.toContain('noindex');
  }
  expect(meta.canonical, `${meta.path}: genau ein Canonical`).toEqual([canonicalFor(meta.path)]);
}

/** Erwartete E.164-Form aus der veröffentlichten Telefonnummer („+49 160 …“ ⇒ „+49160…“). */
function e164(phone: string | null): string | null {
  if (phone === null) return null;
  const digits = phone.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? digits : digits.startsWith('00') ? `+${digits.slice(2)}` : null;
}

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(300_000);
  resetE2eDatabase();
  seed = seedWebsite('main');
  api = await staffApi(playwright);
  bootstrap = await fetchBootstrap();
  catalog = await fetchCatalog();
  expect(bootstrap.publicBaseUrl, 'konfigurierte Basis der Haupt-API').toBe(SEO_PUBLIC_BASE);
  expect(bootstrap.pages.map((page) => page.path).sort()).toEqual(
    seed.entries
      .filter((entry) => entry.kind === 'page' && entry.isPublished)
      .map((entry) => entry.path!)
      .sort(),
  );
});

test.afterAll(async () => {
  await api?.dispose();
});

// ── Canonicals ──────────────────────────────────────────────────────────

test('SEO-C1 Canonical absolut auf die konfigurierte Basis (3100, nicht Request-Host 3112), genau EIN link[rel=canonical], robots index/follow, og:url = Canonical', async ({
  page,
  request,
}) => {
  for (const path of ['/', '/slushmaschine-mieten', '/kontakt', '/ueber-uns']) {
    const meta = await collectMeta(page, path);
    expectIndexable(meta);
    expect(meta.canonical[0]).not.toContain(String(new URL(SEO_WEB_ORIGIN).port));
    expect(meta.og['url'], `${path}: og:url`).toBe(canonicalFor(path));
    // Auch ohne JavaScript (Crawler-Sicht): Canonical steht im ausgelieferten HTML.
    const raw = await (await request.get(path, NO_REDIRECT)).text();
    expect(rawCanonicals(raw), `${path}: Canonical im HTML`).toEqual([canonicalFor(path)]);
    expect(rawRobots(raw).some((content) => /\bindex\b/.test(content))).toBe(true);
    expect(rawRobots(raw).some((content) => content.includes('noindex'))).toBe(false);
  }
});

test('SEO-C2 /konfigurator?maschine=<slug> wählt vor, Canonical bleibt /konfigurator ohne Query; ungültiger Slug wird ignoriert (200, kein eigener URL-Zustand)', async ({
  page,
}) => {
  // Hydratisiert öffnen (Eingaben vor der Hydration gingen verloren, helpers/website.ts).
  await openConfigurator(page, SEO_WEB_ORIGIN, '?maschine=slush-1x8');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    canonicalFor('/konfigurator'),
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
  expect(await metaProperty(page, 'og:url')).toBe(canonicalFor('/konfigurator'));
  // Die Vorauswahl wirkt (nach Schritt 1 ist die Maschine gewählt) – Canonical unverändert.
  await fillEvent(page, { date: berlinDayPlus(21), guests: 30 });
  await nextStep(page, 'machine');
  await expect(page.getByTestId('cfg-machine-slush-1x8').locator('input')).toBeChecked();

  for (const query of ['?maschine=gibt-es-nicht', '?maschine=%3Cscript%3E', '?maschine=']) {
    expect(await open(page, `/konfigurator${query}`), `GET /konfigurator${query}`).toBe(200);
    await expect(page.getByTestId('configurator')).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      canonicalFor('/konfigurator'),
    );
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute('content', /index/);
  }
});

test('SEO-C3 Regionsseiten sind self-canonical mit eigenem Titel, eigener Description und eigener H1 – kein Duplicate Canonical auf Mainz', async ({
  page,
}) => {
  const seen: Array<PageMeta & { h1Text: string }> = [];
  for (const path of REGION_PATHS) {
    const meta = await collectMeta(page, path);
    expectIndexable(meta);
    expect(meta.og['url']).toBe(canonicalFor(path));
    expect(meta.h1).toBe(1);
    seen.push({ ...meta, h1Text: await page.locator('h1').innerText() });
  }
  const distinct = (values: Array<string | null>) => new Set(values).size === values.length;
  expect(distinct(seen.map((meta) => meta.canonical[0]!)), 'Canonicals unterschiedlich').toBe(true);
  expect(distinct(seen.map((meta) => meta.title)), 'Titel unterschiedlich').toBe(true);
  expect(distinct(seen.map((meta) => meta.description)), 'Descriptions unterschiedlich').toBe(true);
  expect(distinct(seen.map((meta) => meta.h1Text)), 'H1 unterschiedlich').toBe(true);
});

test('SEO-C4 Vorschau, Portal und Token-Seiten sind nie indexierbar: noindex (Meta + X-Robots-Tag), kein Canonical, kein og:url, kein JSON-LD – auch mit echtem Vorschau-Token', async ({
  request,
  browser,
}) => {
  for (const path of PRIVATE_PATHS) {
    const response = await request.get(path, NO_REDIRECT);
    // 200 (Fehler-/Login-Darstellung) oder 404 – nie ein Redirect auf eine indexierbare Seite.
    expect([200, 401, 404], `GET ${path}: Status`).toContain(response.status());
    const html = await response.text();
    const robots = rawRobots(html);
    expect(robots.length, `${path}: robots-Meta`).toBeGreaterThanOrEqual(1);
    for (const content of robots) expect(content, `${path}: noindex`).toContain('noindex');
    expect(response.headers()['x-robots-tag'], `${path}: X-Robots-Tag`).toContain('noindex');
    expect(rawCanonicals(html), `${path}: kein Canonical`).toEqual([]);
    expect(html, `${path}: kein og:url`).not.toContain('property="og:url"');
    expect(html, `${path}: kein JSON-LD`).not.toContain('application/ld+json');
  }

  // Echte Vorschau (Fragment-Token über die Staff-API, eingelöst über die Web-Instanz 3112):
  // Brotkrume sichtbar (gleicher Renderer), aber weder Canonical noch JSON-LD, immer noindex.
  const token = await previewToken(api, entryIdOf(seed, '/slushmaschine-mieten/mainz'));
  const context = await browser.newContext();
  const preview = await context.newPage();
  const consumed = preview.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/public/cms/preview/consume',
    { timeout: 60_000 },
  );
  await preview.goto(`${SEO_WEB_ORIGIN}/vorschau#token=${token}`, { timeout: 60_000 });
  expect((await consumed).status(), 'POST /api/public/cms/preview/consume').toBe(200);
  await preview.waitForURL(`${SEO_WEB_ORIGIN}/vorschau/seite`, { timeout: 60_000 });
  await expect(preview.getByTestId('preview-banner')).toBeVisible({ timeout: 30_000 });
  await expect(preview.getByTestId('site-breadcrumbs')).toBeVisible();
  await expect(preview.locator('h1')).toHaveText('Slushmaschine mieten in Mainz');
  await expect(preview.locator('link[rel="canonical"]')).toHaveCount(0);
  await expect(preview.locator('script[type="application/ld+json"]')).toHaveCount(0);
  await expect(preview.locator('meta[property="og:url"]')).toHaveCount(0);
  for (const content of await robotsMetas(preview)) expect(content).toContain('noindex');
  const raw = await preview.request.get(`${SEO_WEB_ORIGIN}/vorschau/seite`);
  expect(raw.status()).toBe(200);
  expect(raw.headers()['x-robots-tag']).toContain('noindex');
  const rawHtml = await raw.text();
  expect(rawHtml).toContain('Slushmaschine mieten in Mainz');
  expect(rawCanonicals(rawHtml)).toEqual([]);
  expect(rawHtml).not.toContain('application/ld+json');
  await context.close();
});

test('SEO-C7 (E2E-Variante) Request-Host 3112 erzeugt keine Canonicals: alle indexierbaren Seiten tragen die konfigurierte Basis 3100, auch mit gefälschtem Host-Header', async ({
  page,
}) => {
  const requestHost = new URL(SEO_WEB_ORIGIN).host;
  for (const path of indexablePaths(bootstrap)) {
    const meta = await collectMeta(page, path);
    expectIndexable(meta);
    expect(meta.canonical[0]).not.toContain(requestHost);
    expect(meta.og['url']).toBe(canonicalFor(path));
  }
  const poisoned = await rawRequest(SEO_WEB_ORIGIN, '/', {
    Host: 'evil.example:443',
    'X-Forwarded-Host': 'evil.example',
    'X-Forwarded-Proto': 'https',
  });
  expect(poisoned.status).toBe(200);
  expect(rawCanonicals(poisoned.body)).toEqual([`${SEO_PUBLIC_BASE}/`]);
  expect(poisoned.body).not.toContain('evil.example');
});

// ── Meta/OpenGraph/Twitter ──────────────────────────────────────────────

test('SEO-M1 Titel aller indexierbaren Seiten sind eindeutig, nennen die Marke genau einmal (kein „Miet-Royal – Miet-Royal“)', async ({
  page,
}) => {
  const titles: string[] = [];
  for (const path of indexablePaths(bootstrap)) {
    const meta = await collectMeta(page, path);
    expect(meta.title.length, `${path}: Titel vorhanden`).toBeGreaterThan(0);
    expect(meta.title.match(/Miet-Royal/g)?.length, `${path}: Marke genau einmal`).toBe(1);
    expect(meta.title, `${path}: keine Markendoppelung`).not.toMatch(/Miet-Royal.*Miet-Royal/);
    expect(meta.og['title'], `${path}: og:title = Titel`).toBe(meta.title);
    titles.push(meta.title);
  }
  expect(new Set(titles).size, 'Titel eindeutig').toBe(titles.length);
});

test('SEO-M2 Jede indexierbare Seite hat eine nicht leere Meta-Description aus dem CMS (Konfigurator: feste Beschreibung); og:description entspricht ihr', async ({
  page,
}) => {
  const descriptions: string[] = [];
  const cmsDescriptions = new Map(
    bootstrap.pages.map((entry) => [entry.path, entry.metaDescription] as const),
  );
  for (const path of indexablePaths(bootstrap)) {
    const meta = await collectMeta(page, path);
    expect((meta.description ?? '').trim().length, `${path}: Description`).toBeGreaterThan(0);
    expect(meta.og['description'], `${path}: og:description`).toBe(meta.description);
    const cms = cmsDescriptions.get(path);
    if (cms !== undefined && cms !== null) {
      expect(meta.description, `${path}: Description = CMS-Meta-Beschreibung`).toBe(cms);
    }
    expect(meta.description).not.toMatch(PRICE_TEXT_PATTERN);
    descriptions.push(meta.description!);
  }
  expect(new Set(descriptions).size, 'Descriptions eindeutig').toBe(descriptions.length);
  await expect(page.locator('meta[name="keywords"]')).toHaveCount(0);
});

test('SEO-M3 OpenGraph: og:title/og:description/og:type=website/og:locale=de_DE/og:site_name/og:url; og:image nur als absolute veröffentlichte Medien-URL der Basis (laut robots crawlbar)', async ({
  page,
  request,
}) => {
  const siteName = bootstrap.settings?.businessName ?? 'Miet-Royal';
  const robotsGroup = parseRobots(await (await request.get('/robots.txt', NO_REDIRECT)).text());
  for (const path of indexablePaths(bootstrap)) {
    const meta = await collectMeta(page, path);
    expect(meta.og['type'], `${path}: og:type`).toBe('website');
    expect(meta.og['locale'], `${path}: og:locale`).toBe('de_DE');
    expect(meta.og['site_name'], `${path}: og:site_name`).toBe(siteName);
    expect(meta.og['url'], `${path}: og:url`).toBe(canonicalFor(path));
    expect(meta.og['title'], `${path}: og:title`).toBe(meta.title);
    expect(meta.og['description'], `${path}: og:description`).toBe(meta.description);
    const image = meta.og['image'] ?? null;
    if (image !== null) {
      // Kein erfundenes/fremdes Bild: nur eigene veröffentlichte Medien (nie Vorschau-Medien).
      expect(image, `${path}: og:image`).toMatch(
        new RegExp(
          `^${SEO_PUBLIC_BASE.replace(/[.]/g, '\\.')}/api/public/cms/media/[0-9a-f-]+/\\d+$`,
        ),
      );
      expect(image).not.toContain('/preview-media/');
      expect(robotsAllows(robotsGroup, new URL(image).pathname), `${path}: og:image crawlbar`).toBe(
        true,
      );
      await expect(page.locator('meta[property="og:image:width"]')).toHaveCount(1);
      await expect(page.locator('meta[property="og:image:height"]')).toHaveCount(1);
    } else {
      await expect(page.locator('meta[property^="og:image"]')).toHaveCount(0);
    }
    await expect(page.locator('meta[name="keywords"]')).toHaveCount(0);
  }
});

test('SEO-M4 Twitter Card: summary ohne Bild bzw. summary_large_image mit Bild, twitter:title = Titel', async ({
  page,
}) => {
  for (const path of indexablePaths(bootstrap)) {
    const meta = await collectMeta(page, path);
    const hasImage = meta.og['image'] !== null;
    expect(meta.twitter['card'], `${path}: twitter:card`).toBe(
      hasImage ? 'summary_large_image' : 'summary',
    );
    expect(meta.twitter['title'], `${path}: twitter:title`).toBe(meta.title);
    expect(meta.twitter['description'], `${path}: twitter:description`).toBe(meta.description);
    if (!hasImage) expect(meta.twitter['image'], `${path}: kein twitter:image`).toBeNull();
  }
});

test('SEO-M5 Kein preisartiger Text in Produktbeschreibungen (Startseite, Slush-Seite, Konfigurator-Maschinenwahl, Katalog-API) – Preis nur aus product_prices', async ({
  page,
}) => {
  const allProducts = [
    ...catalog.machines,
    ...catalog.syrups,
    ...catalog.accessories,
    ...(catalog.canister ? [catalog.canister] : []),
  ] as Array<{ slug: string; name: string; description?: string | null }>;
  expect(allProducts.length).toBeGreaterThan(0);
  for (const product of allProducts) {
    expect(product.name, `${product.slug}: Name`).not.toMatch(PRICE_TEXT_PATTERN);
    expect(product.description ?? '', `${product.slug}: Beschreibung`).not.toMatch(
      PRICE_TEXT_PATTERN,
    );
  }

  // Produktkarten (block-renderer.tsx ProductGridSection: product-card-<slug>, product-price-<slug>)
  // und „Zusätzlich erhältlich“ (IncludedItemsSection: included-price-<slug>): außer der
  // Preiszeile nirgends ein Preis.
  for (const path of ['/', '/slushmaschine-mieten']) {
    expect(await open(page, path)).toBe(200);
    const cards = page.locator('[data-testid^="product-card-"]');
    expect(await cards.count(), `${path}: Produktkarten`).toBeGreaterThan(0);
    for (const card of await cards.all()) {
      const testId = (await card.getAttribute('data-testid')) ?? '';
      const slug = testId.replace('product-card-', '');
      const text = await card.innerText();
      const priceLine = await page.getByTestId(`product-price-${slug}`).innerText();
      const withoutPrice = text.replace(priceLine, '');
      expect(withoutPrice, `${path} ${testId}: Beschreibung ohne Preis`).not.toMatch(
        PRICE_TEXT_PATTERN,
      );
    }
    for (const extras of await page.getByTestId('included-extras').all()) {
      let text = await extras.innerText();
      for (const price of await extras.locator('[data-testid^="included-price-"]').all()) {
        text = text.replace(await price.innerText(), '');
      }
      expect(text, `${path}: Zusatzartikel ohne Preistext`).not.toMatch(PRICE_TEXT_PATTERN);
    }
  }

  // Konfigurator, Schritt Maschine (configurator.tsx MachineStep: cfg-machine-<slug>).
  await openConfigurator(page, SEO_WEB_ORIGIN);
  await fillEvent(page, { date: berlinDayPlus(21), guests: 30 });
  await nextStep(page, 'machine');
  for (const machine of catalog.machines) {
    const label = page.getByTestId(`cfg-machine-${machine.slug}`);
    await expect(label).toBeVisible();
    // Geschützte Leerzeichen der Währungsformatierung normalisieren, dann die Preiszeile entfernen.
    const text = (await label.innerText()).replace(/\u00a0/g, ' ').replace(priceText(machine), '');
    expect(text, `cfg-machine-${machine.slug}: ohne Preistext`).not.toMatch(PRICE_TEXT_PATTERN);
  }
});

test('SEO-M6 Genau eine H1 auf jeder indexierbaren Seite, dem Konfigurator, der 404- und der 410-Seite', async ({
  page,
  request,
}) => {
  for (const path of indexablePaths(bootstrap)) {
    const meta = await collectMeta(page, path);
    expect(meta.h1, `${path}: genau eine H1`).toBe(1);
  }
  expect(await open(page, '/gibt-es-nicht')).toBe(404);
  await expect(page.getByTestId('site-not-found')).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  const gone = await request.get('/shop', NO_REDIRECT);
  expect(gone.status()).toBe(410);
  expect((await gone.text()).match(/<h1\b/g)?.length).toBe(1);
});

test('SEO-M-Favicon /favicon.ico antwortet 200 image/x-icon, Seiten tragen <link rel="icon">', async ({
  page,
  request,
}) => {
  const favicon = await request.get('/favicon.ico', NO_REDIRECT);
  expect(favicon.status()).toBe(200);
  expect(favicon.headers()['content-type']).toContain('image/x-icon');
  expect((await favicon.body()).length).toBeGreaterThan(0);
  expect(await open(page, '/')).toBe(200);
  const icons = await page.locator('link[rel="icon"]').count();
  expect(icons, 'link[rel="icon"] vorhanden').toBeGreaterThanOrEqual(1);
});

// ── Sitemap ─────────────────────────────────────────────────────────────

test('SEO-S1 Sitemap enthält genau die veröffentlichten Seiten des Bootstraps plus /konfigurator – alle URLs mit der konfigurierten Basis 3100', async ({
  request,
}) => {
  const sitemap = await loadSitemap(request);
  expect(sitemap.headers['content-type']).toContain('xml');
  for (const entry of sitemap.urls) {
    expect(entry.loc.startsWith(`${SEO_PUBLIC_BASE}/`), `URL ${entry.loc}`).toBe(true);
    expect(entry.loc).not.toContain(new URL(SEO_WEB_ORIGIN).host);
  }
  expect(sitemapPaths(sitemap.urls).sort()).toEqual(indexablePaths(bootstrap).sort());
  expect(sitemapPaths(sitemap.urls)[0], 'Startseite zuerst').toBe('/');
  const robotsResponse = await request.get('/robots.txt', NO_REDIRECT);
  expect(robotsResponse.status()).toBe(200);
  const robots = await robotsResponse.text();
  expect(robots).toMatch(/^User-Agent: \*$/m);
  expect(robots).toMatch(/^Allow: \/$/m);
  expect(robots).toMatch(/^Allow: \/api\/public\/cms\/media\/$/m);
  expect(robots).toMatch(/^Disallow: \/api\/$/m);
  expect(robots).toContain(`Sitemap: ${SEO_PUBLIC_BASE}/sitemap.xml`);
  expect(robots).not.toMatch(/token/i);
  // Nur /api/ gesperrt – Portal/Vorschau/Token bleiben crawlbar, damit ihr noindex wirkt (D7).
  expect(robots.match(/^Disallow:/gm)?.length).toBe(1);
  const group = parseRobots(robots);
  expect(group.sitemaps).toEqual([`${SEO_PUBLIC_BASE}/sitemap.xml`]);
  for (const path of ['/', '/konto', '/vorschau/seite', '/angebot/token', '/konfigurator']) {
    expect(robotsAllows(group, path), `robots erlaubt ${path}`).toBe(true);
  }
  for (const path of ['/api/public/site/settings', '/api/health', '/api/public/cms/preview/page']) {
    expect(robotsAllows(group, path), `robots sperrt ${path}`).toBe(false);
  }
  // Veröffentlichte Bild-URLs (og:image, Organization.logo) sind crawlbar (längste Regel gewinnt).
  expect(
    robotsAllows(group, '/api/public/cms/media/00000000-0000-4000-8000-000000000000/1600'),
  ).toBe(true);
});

test('SEO-S2 Entwürfe erscheinen nicht: geänderter, nicht veröffentlichter Entwurf lässt Sitemap, lastmod und öffentliche Seite unverändert; neue Regions-Seite als Entwurf fehlt (404)', async ({
  request,
  page,
}) => {
  const before = await loadSitemap(request);
  const faqId = entryIdOf(seed, '/faq');
  const faq = await getEntry(api, faqId);
  expect(await open(page, '/faq')).toBe(200);
  const heading = await page.locator('h1').innerText();
  await saveDraft(api, faqId, {
    baseRevisionId: faq.draft.revisionId,
    content: { ...faq.draft.content, title: `${faq.draft.content.title ?? 'FAQ'} (Entwurf S2)` },
    metaTitle: 'Entwurf S2 – nicht veröffentlichter Meta-Titel',
    metaDescription: faq.draft.metaDescription,
  });
  const after = await loadSitemap(request);
  expect(after.urls).toEqual(before.urls);
  expect(await open(page, '/faq')).toBe(200);
  await expect(page.locator('h1')).toHaveText(heading);
  expect(await page.title()).not.toContain('Entwurf S2');

  const draft = await createRegionDraft(api, 'ingelheim', 'Slushmaschine mieten in Ingelheim');
  expect(draft.status).toBe('never_published');
  const withDraft = await loadSitemap(request);
  expect(withDraft.urls).toEqual(before.urls);
  expect(sitemapPaths(withDraft.urls)).not.toContain('/slushmaschine-mieten/ingelheim');
  expect((await request.get('/slushmaschine-mieten/ingelheim', NO_REDIRECT)).status()).toBe(404);
});

test('SEO-S3 Keine Portal-, Vorschau-, Token-, API- oder Fehler-URLs in der Sitemap', async ({
  request,
}) => {
  const paths = sitemapPaths((await loadSitemap(request)).urls);
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    expect(path, `Sitemap-Pfad ${path}`).not.toMatch(
      /^\/(konto|vorschau|angebot|dokument|api)(\/|$)|^\/kontakt\/.+|token|\?|#|undefined|null/,
    );
    expect(path).toMatch(/^\/[a-z0-9/-]*$/);
  }
});

test('SEO-S4 Zurückgezogene Regionsseite (Wiesbaden) verschwindet sofort aus Sitemap und Bootstrap und antwortet mit 404', async ({
  request,
}) => {
  const path = '/slushmaschine-mieten/wiesbaden';
  expect(sitemapPaths((await loadSitemap(request)).urls)).toContain(path);
  await unpublishEntry(api, entryIdOf(seed, path));
  expect(sitemapPaths((await loadSitemap(request)).urls)).not.toContain(path);
  expect((await fetchBootstrap()).pages.map((entry) => entry.path)).not.toContain(path);
  const response = await request.get(path, NO_REDIRECT);
  expect(response.status()).toBe(404);
  expect(rawRobots(await response.text()).every((content) => content.includes('noindex'))).toBe(
    true,
  );
  bootstrap = await fetchBootstrap();
});

test('SEO-S5 Neue Regionsseite erst nach Veröffentlichung in der Sitemap – dann mit echtem lastmod, Self-Canonical, Brotkrume und BreadcrumbList', async ({
  request,
  page,
}) => {
  const path = '/slushmaschine-mieten/ingelheim';
  const entryId = (await api.get('/staff/cms/entries').then((response) => response.json())) as {
    entries: Array<{ id: string; path: string | null }>;
  };
  const entry = entryId.entries.find((candidate) => candidate.path === path);
  expect(entry, 'Entwurf aus S2').toBeDefined();
  const detail = await getEntry(api, entry!.id);
  expect(detail.published).toBeNull();
  expect(sitemapPaths((await loadSitemap(request)).urls)).not.toContain(path);

  const saved = await saveDraft(api, detail.id, {
    baseRevisionId: detail.draft.revisionId,
    content: {
      title: 'Slushmaschine mieten in Ingelheim',
      blocks: [
        {
          type: 'hero',
          heading: 'Slushmaschine mieten in Ingelheim',
          lead: 'Eiskalte Erfrischung für dein Fest in Ingelheim – abgeholt in Mainz-Hechtsheim oder individuell geliefert.',
        },
        {
          type: 'text',
          heading: 'Slush für Ingelheim am Rhein',
          body: 'Von Weinfest bis Kindergeburtstag: In Ingelheim und den Orten rundherum versorgen wir dich mit Slushmaschine, Sirup und Zubehör. Die Maschine holst du in Mainz-Hechtsheim ab, eine Lieferung prüfen wir für dich individuell.',
        },
      ],
    },
    metaTitle: 'Slushmaschine mieten in Ingelheim | Miet-Royal',
    metaDescription:
      'Slushmaschine mieten in Ingelheim: Abholung in Mainz-Hechtsheim, Lieferung auf Anfrage. Sirup, Becher und Strohhalme inklusive.',
  });
  // Weiterhin Entwurf: nicht in der Sitemap, öffentlich 404.
  expect(sitemapPaths((await loadSitemap(request)).urls)).not.toContain(path);
  expect((await request.get(path, NO_REDIRECT)).status()).toBe(404);

  const published = await publishEntry(api, detail.id, saved.draft.revisionId);
  expect(published.published?.revisionNumber).toBe(saved.draft.revisionNumber);
  const sitemap = await loadSitemap(request);
  expect(sitemapPaths(sitemap.urls)).toContain(path);
  bootstrap = await fetchBootstrap();
  const summary = bootstrap.pages.find((candidate) => candidate.path === path);
  expect(summary, 'Bootstrap kennt die neue Seite').toBeDefined();
  const sitemapEntry = sitemap.urls.find((candidate) => candidate.loc === canonicalFor(path));
  expect(sitemapEntry?.lastmod).toBe(new Date(summary!.publishedAt).toISOString());

  const meta = await collectMeta(page, path);
  expectIndexable(meta);
  expect(meta.title).toBe('Slushmaschine mieten in Ingelheim | Miet-Royal');
  await expect(page.getByTestId('site-breadcrumbs')).toBeVisible();
  const crumbs = await page.locator('nav[aria-label="Brotkrumen"] li').allInnerTexts();
  expect(crumbs).toEqual(['Start', slushTitle(), 'Slushmaschine mieten in Ingelheim']);
  const scripts = await jsonLdScripts(page);
  expect(scripts.map((script) => script.data['@type'])).toEqual(['BreadcrumbList']);
});

test('SEO-S6 lastmod nur aus echten Veröffentlichungszeitpunkten: gültiges ISO-Datum, ≥ 2026-01-01, nicht in der Zukunft, identisch mit publishedAt; Konfigurator ohne lastmod', async ({
  request,
}) => {
  const sitemap = await loadSitemap(request);
  const current = await fetchBootstrap();
  const publishedAt = new Map(
    current.pages.map((entry) => [canonicalFor(entry.path), entry.publishedAt] as const),
  );
  const now = Date.now() + 60_000;
  for (const entry of sitemap.urls) {
    if (entry.loc === canonicalFor('/konfigurator')) {
      expect(entry.lastmod, '/konfigurator ohne lastmod').toBeNull();
      continue;
    }
    expect(entry.lastmod, `${entry.loc}: lastmod`).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const time = Date.parse(entry.lastmod!);
    expect(Number.isNaN(time), `${entry.loc}: gültiges Datum`).toBe(false);
    expect(time).toBeGreaterThanOrEqual(Date.parse('2026-01-01T00:00:00Z'));
    expect(time).toBeLessThanOrEqual(now);
    const expected = publishedAt.get(entry.loc);
    expect(expected, `${entry.loc}: publishedAt im Bootstrap`).toBeDefined();
    expect(new Date(time).toISOString(), `${entry.loc}: lastmod = publishedAt`).toBe(
      new Date(expected!).toISOString(),
    );
  }
  // Nicht alle „jetzt“: die Ingelheim-Seite (S5) wurde später veröffentlicht als der Seed.
  const times = new Set(sitemap.urls.map((entry) => entry.lastmod).filter(Boolean));
  expect(times.size).toBeGreaterThanOrEqual(2);
});

test('SEO-S7 /konfigurator nur wenn nutzbar: mit Maschinen in Sitemap und indexierbar; ohne aktive Maschine weder Sitemap noch Index (noindex, kein Canonical) – danach wieder', async ({
  request,
  page,
}) => {
  expect(sitemapPaths((await loadSitemap(request)).urls)).toContain('/konfigurator');
  const meta = await collectMeta(page, '/konfigurator');
  expectIndexable(meta);

  const products = await staffProducts(api);
  const machines = catalog.machines.map((machine) => {
    const product = products.find((candidate) => candidate.slug === machine.slug);
    expect(product, `Staff-Produkt ${machine.slug}`).toBeDefined();
    return product!;
  });
  expect(machines.length).toBeGreaterThan(0);
  try {
    for (const machine of machines) await setProductActive(api, machine.id, false);
    expect((await fetchCatalog()).machines).toEqual([]);
    expect(sitemapPaths((await loadSitemap(request)).urls)).not.toContain('/konfigurator');
    expect(await open(page, '/konfigurator')).toBe(200);
    await expect(page.getByTestId('cfg-no-machines')).toBeVisible();
    for (const content of await robotsMetas(page)) expect(content).toContain('noindex');
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
    await expect(page.locator('meta[property="og:url"]')).toHaveCount(0);
  } finally {
    for (const machine of machines) await setProductActive(api, machine.id, true);
  }
  expect((await fetchCatalog()).machines.length).toBe(machines.length);
  expect(sitemapPaths((await loadSitemap(request)).urls)).toContain('/konfigurator');
  expectIndexable(await collectMeta(page, '/konfigurator'));
});

// ── Strukturierte Daten ─────────────────────────────────────────────────

test('SEO-SD1 Startseite: gültiges JSON-LD WebSite + Organization ausschließlich aus veröffentlichten Einstellungen (Name, URL, Telefon E.164, E-Mail; Logo/Instagram nur wenn gepflegt)', async ({
  page,
}) => {
  expect(await open(page, '/')).toBe(200);
  const scripts = await jsonLdScripts(page);
  expect(scripts.map((script) => script.data['@type']).sort()).toEqual(['Organization', 'WebSite']);
  const settings = bootstrap.settings!;
  const website = scripts.find((script) => script.data['@type'] === 'WebSite')!.data;
  expect(website).toEqual({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: settings.businessName,
    url: `${SEO_PUBLIC_BASE}/`,
    inLanguage: 'de',
  });
  const organization = scripts.find((script) => script.data['@type'] === 'Organization')!.data;
  const expected: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: settings.businessName,
    url: `${SEO_PUBLIC_BASE}/`,
  };
  const telephone = e164(settings.phone);
  if (telephone !== null) expected['telephone'] = telephone;
  if (settings.email !== null && settings.email.trim() !== '') expected['email'] = settings.email;
  if (settings.instagramUrl !== null) expected['sameAs'] = [settings.instagramUrl];
  if (settings.logo === null) {
    expect(organization['logo']).toBeUndefined();
  } else {
    expect(String(organization['logo'])).toMatch(
      new RegExp(`^${SEO_PUBLIC_BASE.replace(/[.]/g, '\\.')}/api/public/cms/media/`),
    );
    const robotsGroup = parseRobots(await (await page.request.get('/robots.txt')).text());
    expect(robotsAllows(robotsGroup, new URL(String(organization['logo'])).pathname)).toBe(true);
    expected['logo'] = organization['logo'];
  }
  expect(organization).toEqual(expected);
  // SEO-SD5: nur Felder aus dem Bootstrap – keine weiteren.
  expect(Object.keys(organization).sort()).toEqual(Object.keys(expected).sort());
  await expect(page.getByTestId('jsonld-website')).toHaveCount(1);
  await expect(page.getByTestId('jsonld-organization')).toHaveCount(1);
});

test('SEO-SD2 Regionsseite: BreadcrumbList entspricht exakt der sichtbaren Brotkrume (Namen, Reihenfolge, URLs mit Basis, letzte Position ohne item)', async ({
  page,
}) => {
  expect(await open(page, '/slushmaschine-mieten/mainz')).toBe(200);
  const nav = page.locator('nav[aria-label="Brotkrumen"]');
  await expect(nav).toBeVisible();
  const items = nav.locator('li');
  const names = await items.allInnerTexts();
  expect(names).toEqual(['Start', slushTitle(), 'Slushmaschine mieten in Mainz']);
  const hrefs = await nav
    .locator('a')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(hrefs).toEqual(['/', '/slushmaschine-mieten']);
  await expect(items.last().locator('[aria-current="page"]')).toHaveText(names[names.length - 1]!);

  const scripts = await jsonLdScripts(page);
  expect(scripts).toHaveLength(1);
  const breadcrumb = scripts[0]!.data;
  expect(breadcrumb['@type']).toBe('BreadcrumbList');
  const list = breadcrumb['itemListElement'] as Array<Record<string, unknown>>;
  expect(list.map((item) => item['name'])).toEqual(names);
  expect(list.map((item) => item['position'])).toEqual([1, 2, 3]);
  expect(list.slice(0, -1).map((item) => item['item'])).toEqual(
    hrefs.map((href) => canonicalFor(href!)),
  );
  expect(list[list.length - 1]!['item']).toBeUndefined();
  for (const item of list) expect(item['@type']).toBe('ListItem');

  // Secondary Offer: Start › Seitentitel.
  expect(await open(page, '/popcornmaschine-mieten')).toBe(200);
  const offerNames = await page.locator('nav[aria-label="Brotkrumen"] li').allInnerTexts();
  expect(offerNames[0]).toBe('Start');
  expect(offerNames).toHaveLength(2);
  const offerScripts = await jsonLdScripts(page);
  expect(offerScripts.map((script) => script.data['@type'])).toEqual(['BreadcrumbList']);
  expect(
    (offerScripts[0]!.data['itemListElement'] as Array<Record<string, unknown>>).map(
      (item) => item['name'],
    ),
  ).toEqual(offerNames);
});

test('SEO-SD3/SD4 Nirgends LocalBusiness/FAQPage/Review/AggregateRating/Product/Offer/PostalAddress, keine Öffnungszeiten/Preisspannen, keine exakte Abholadresse', async ({
  page,
}) => {
  let total = 0;
  for (const path of indexablePaths(bootstrap)) {
    expect(await open(page, path)).toBe(200);
    for (const script of await jsonLdScripts(page)) {
      total += 1;
      const types = collectJsonLdTypes(script.data);
      for (const forbidden of FORBIDDEN_JSONLD_TYPES) {
        expect(types.has(forbidden), `${path}: Typ ${forbidden}`).toBe(false);
      }
      const keys = collectJsonLdKeys(script.data);
      for (const forbidden of FORBIDDEN_JSONLD_KEYS) {
        expect(keys.has(forbidden), `${path}: Schlüssel ${forbidden}`).toBe(false);
      }
      for (const fragment of EXACT_PICKUP_FRAGMENTS) {
        expect(script.raw, `${path}: exakte Abholadresse (${fragment})`).not.toContain(fragment);
      }
      expect(script.raw).not.toMatch(/streetAddress|openingHours|priceRange/);
      expect(script.data['@context']).toBe('https://schema.org');
    }
  }
  expect(total, 'JSON-LD vorhanden').toBeGreaterThanOrEqual(3);
});

test('SEO-SD6 JSON-LD-Serialisierung: gültiges JSON, `<`/`>`/`&` als Unicode-Escapes – kein `</script>` kann das Element beenden', async ({
  page,
}) => {
  for (const path of ['/', '/slushmaschine-mieten/mainz', '/waffeleisen-mieten']) {
    expect(await open(page, path)).toBe(200);
    const scripts = await jsonLdScripts(page);
    expect(scripts.length, `${path}: JSON-LD`).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script.raw, `${path}: keine rohen < > &`).not.toMatch(/[<>&]/);
      expect(script.raw).not.toContain('</');
      expect(JSON.parse(script.raw)).toEqual(script.data);
    }
  }
});

test('SEO-SD7/SD8 Keine strukturierten Daten auf Vorschau, Portal, Token-Seiten, 404, 410 und Konfigurator – nur auf indexierbaren Inhaltsseiten', async ({
  request,
  page,
}) => {
  for (const path of [...PRIVATE_PATHS, '/gibt-es-nicht', '/shop', '/shop/']) {
    const html = await (await request.get(path, NO_REDIRECT)).text();
    expect(html, `${path}: kein JSON-LD`).not.toContain('application/ld+json');
  }
  expect(await open(page, '/konfigurator')).toBe(200);
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
  const withJsonLd: string[] = [];
  for (const path of indexablePaths(bootstrap)) {
    expect(await open(page, path)).toBe(200);
    if ((await page.locator('script[type="application/ld+json"]').count()) > 0) {
      withJsonLd.push(path);
    }
  }
  const allowed = new Set([
    '/',
    ...bootstrap.pages
      .filter((entry) => entry.pageType === 'region' || entry.pageType === 'secondary_offer')
      .map((entry) => entry.path),
  ]);
  for (const path of withJsonLd) expect(allowed.has(path), `${path}: JSON-LD erlaubt`).toBe(true);
  expect(withJsonLd).toContain('/');
});
