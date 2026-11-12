import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { resolve } from 'node:path';
import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './seed.ts';
import { API_ORIGIN, WEB_ORIGIN } from './website.ts';

/**
 * Phase 17 (E2E-SEO, Design D15): Helfer der SEO-/Redirect-/A11y-Specs (`seo-*.spec.ts`,
 * Projekt `seo`) und der Spec „Indexierung aus“ (`website-seo-disabled.spec.ts`, Projekt
 * `chromium`).
 *
 * - Projekt `seo` läuft gegen den PRODUCTION-Build der Website (Port 3112,
 *   `WEB_INDEXING_ENABLED=true`) an der Haupt-API 3101. Deren konfigurierte öffentliche Basis
 *   (`MAIL_PUBLIC_WEB_BASE_URL`) ist `http://127.0.0.1:3100` – Canonicals, Sitemap-URLs, og:url
 *   und JSON-LD-URLs MÜSSEN darauf zeigen, obwohl die Anfragen über 3112 kommen (Beleg „keine
 *   Host-Ableitung“, Auftrag §4/§28 C7).
 * - Staff-API direkt (Port 3101, Cookie-Session nach `POST /auth/login`): Seiten zurückziehen,
 *   Regionsseiten anlegen, Entwürfe speichern/veröffentlichen, Produkte (de)aktivieren – wie die
 *   Phase-16-Specs, nur ohne Staff-UI. Kein Request trägt Browser-Header (CSRF-Hook passiert).
 * - Keine Tokens, Passwörter oder Inhalte in Ausgaben.
 */

export const SEO_WEB_PORT = 3112;
export const SEO_WEB_ORIGIN = `http://127.0.0.1:${SEO_WEB_PORT}`;
/** Konfigurierte öffentliche Basis der Haupt-API (MAIL_PUBLIC_WEB_BASE_URL) – NICHT der Request-Host. */
export const SEO_PUBLIC_BASE = WEB_ORIGIN;
export const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/** Preisartiger Freitext (Auftrag §23/§28 M5): „60 €“, „€ 60“, „EUR“, „Euro“. */
export const PRICE_TEXT_PATTERN = /\d\s?€|€\s?\d|\bEUR\b|\bEuro\b/;

/** Verbotene Typen/Schlüssel strukturierter Daten (Auftrag §13/§29). */
export const FORBIDDEN_JSONLD_TYPES = [
  'LocalBusiness',
  'FAQPage',
  'Review',
  'AggregateRating',
  'Product',
  'Offer',
  'PostalAddress',
  'OpeningHoursSpecification',
  'Rating',
] as const;
export const FORBIDDEN_JSONLD_KEYS = [
  'address',
  'streetAddress',
  'postalCode',
  'geo',
  'openingHours',
  'openingHoursSpecification',
  'priceRange',
  'aggregateRating',
  'review',
  'offers',
  'hasOfferCatalog',
] as const;

// ── Staff-API (Cookie-Session, ohne Staff-UI) ────────────────────────────

/**
 * Anmeldung an der Haupt-API (Admin des Basis-Seeds). Das Login-Limit (10/min je IP+E-Mail)
 * ist gewolltes Produktverhalten: bei 429 wird nur gepollt (kein fester Sleep), wie
 * helpers/staff-login.ts.
 */
export async function staffApi(
  playwright: PlaywrightWorkerArgs['playwright'],
  email = ADMIN_EMAIL,
  password = ADMIN_PASSWORD,
): Promise<APIRequestContext> {
  const api = await playwright.request.newContext({ baseURL: API_ORIGIN });
  const last: { response: APIResponse | null } = { response: null };
  await expect
    .poll(
      async () => {
        last.response = await api.post('/auth/login', { data: { email, password } });
        return last.response.status();
      },
      { message: 'API-Login (Rate-Limit)', timeout: 75_000, intervals: [1_000, 5_000, 10_000] },
    )
    .not.toBe(429);
  expect(last.response?.status(), 'POST /auth/login').toBe(200);
  return api;
}

export interface StaffEntryDetail {
  id: string;
  kind: string;
  pageType: string | null;
  path: string | null;
  status: string;
  canUnpublish: boolean;
  draft: {
    revisionId: string;
    revisionNumber: number;
    content: { title?: string; blocks: unknown[] };
    metaTitle: string | null;
    metaDescription: string | null;
  };
  published: { revisionId: string; revisionNumber: number } | null;
}

async function json<T>(response: APIResponse, label: string, status = 200): Promise<T> {
  expect(response.status(), `${label}: Status`).toBe(status);
  return (await response.json()) as T;
}

export function getEntry(api: APIRequestContext, entryId: string): Promise<StaffEntryDetail> {
  return api
    .get(`/staff/cms/entries/${entryId}`)
    .then((response) => json<StaffEntryDetail>(response, `GET /staff/cms/entries/${entryId}`));
}

/** Seite zurückziehen (nur region/secondary_offer; Recht cms.publish). */
export async function unpublishEntry(
  api: APIRequestContext,
  entryId: string,
): Promise<StaffEntryDetail> {
  const response = await api.post(`/staff/cms/entries/${entryId}/unpublish`, { data: {} });
  return json<StaffEntryDetail>(response, 'POST …/unpublish');
}

/** Neue Regionsseite als Entwurf (Recht cms.edit) – leer, nie veröffentlicht. */
export async function createRegionDraft(
  api: APIRequestContext,
  regionSlug: string,
  title: string,
): Promise<StaffEntryDetail> {
  const response = await api.post('/staff/cms/entries', { data: { regionSlug, title } });
  return json<StaffEntryDetail>(response, 'POST /staff/cms/entries', 201);
}

export async function saveDraft(
  api: APIRequestContext,
  entryId: string,
  input: {
    baseRevisionId: string;
    content: unknown;
    metaTitle: string | null;
    metaDescription: string | null;
  },
): Promise<StaffEntryDetail> {
  const response = await api.put(`/staff/cms/entries/${entryId}/draft`, {
    data: { ...input, editorNote: null },
  });
  return json<StaffEntryDetail>(response, 'PUT …/draft');
}

export async function publishEntry(
  api: APIRequestContext,
  entryId: string,
  revisionId: string,
): Promise<StaffEntryDetail> {
  const response = await api.post(`/staff/cms/entries/${entryId}/publish`, {
    data: { revisionId },
  });
  return json<StaffEntryDetail>(response, 'POST …/publish');
}

/** Vorschau-Zugang (Recht cms.edit|cms.publish) – liefert NUR den Fragment-Token (nie ausgeben). */
export async function previewToken(api: APIRequestContext, entryId: string): Promise<string> {
  const response = await api.post(`/staff/cms/entries/${entryId}/preview`, { data: {} });
  const access = await json<{ url: string }>(response, 'POST …/preview', 201);
  const token = /#token=([^&]+)/.exec(access.url)?.[1] ?? '';
  expect(token.length, 'Vorschau-Token vorhanden').toBeGreaterThan(10);
  return token;
}

export interface StaffProduct {
  id: string;
  slug: string;
  active?: boolean;
}

export async function staffProducts(api: APIRequestContext): Promise<StaffProduct[]> {
  const response = await api.get('/staff/products');
  return (await json<{ products: StaffProduct[] }>(response, 'GET /staff/products')).products;
}

export async function setProductActive(
  api: APIRequestContext,
  productId: string,
  active: boolean,
): Promise<void> {
  const response = await api.post(`/staff/products/${productId}/active`, { data: { active } });
  expect(response.status(), `POST /staff/products/${productId}/active`).toBe(200);
}

// ── Öffentliche API ──────────────────────────────────────────────────────

export interface SeoBootstrapPage {
  path: string;
  pageType: string;
  title: string;
  metaDescription: string | null;
  publishedAt: string;
}

export interface SeoBootstrap {
  environment: string;
  settings: {
    businessName: string;
    tagline: string | null;
    phone: string | null;
    email: string | null;
    instagramUrl: string | null;
    logo: unknown | null;
    footerNote: string | null;
  } | null;
  pages: SeoBootstrapPage[];
  reviews: { mode: string };
  pickupArea: string;
  publicBaseUrl: string | null;
}

/** `GET /public/site/settings` direkt an der API (ohne IP-Limit, no-store). */
export async function fetchBootstrap(apiOrigin = API_ORIGIN): Promise<SeoBootstrap> {
  const response = await fetch(`${apiOrigin}/public/site/settings`, {
    headers: { connection: 'close', accept: 'application/json' },
  });
  expect(response.status, 'GET /public/site/settings').toBe(200);
  return (await response.json()) as SeoBootstrap;
}

/** Veröffentlichte Pfade des Bootstraps plus `/konfigurator` – die erwartete Sitemap-Menge. */
export function indexablePaths(bootstrap: SeoBootstrap): string[] {
  return [...bootstrap.pages.map((page) => page.path), '/konfigurator'];
}

// ── Sitemap ──────────────────────────────────────────────────────────────

export interface SitemapUrl {
  loc: string;
  lastmod: string | null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Minimaler Sitemap-Parser (urlset/url/loc/lastmod) – ohne externe Bibliothek. */
export function parseSitemap(xml: string): SitemapUrl[] {
  expect(xml.trimStart().startsWith('<?xml'), 'Sitemap beginnt mit XML-Deklaration').toBe(true);
  expect(xml.includes('<urlset'), 'Sitemap enthält <urlset>').toBe(true);
  const urls: SitemapUrl[] = [];
  for (const match of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const inner = match[1] ?? '';
    const loc = /<loc>([\s\S]*?)<\/loc>/.exec(inner)?.[1];
    expect(loc, 'jeder <url>-Eintrag hat <loc>').toBeDefined();
    const lastmod = /<lastmod>([\s\S]*?)<\/lastmod>/.exec(inner)?.[1] ?? null;
    urls.push({ loc: decodeXml(loc!.trim()), lastmod: lastmod === null ? null : lastmod.trim() });
  }
  return urls;
}

export async function loadSitemap(
  request: APIRequestContext,
  origin = SEO_WEB_ORIGIN,
): Promise<{ urls: SitemapUrl[]; xml: string; headers: Record<string, string> }> {
  const response = await request.get(`${origin}/sitemap.xml`, { maxRedirects: 0 });
  expect(response.status(), 'GET /sitemap.xml').toBe(200);
  const xml = await response.text();
  return { urls: parseSitemap(xml), xml, headers: response.headers() };
}

/** Pfade (ohne Basis) der Sitemap-Einträge. */
export function sitemapPaths(urls: SitemapUrl[], base = SEO_PUBLIC_BASE): string[] {
  return urls.map((entry) => {
    expect(entry.loc.startsWith(`${base}/`), `Sitemap-URL ${entry.loc} beginnt mit ${base}/`).toBe(
      true,
    );
    return entry.loc.slice(base.length);
  });
}

// ── Rohes HTML (Crawler-Sicht ohne JavaScript) ───────────────────────────

/** Attributwert eines Tags unabhängig von der Attributreihenfolge. */
function tagAttribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

/** Canonical-Hrefs aus rohem HTML. */
export function rawCanonicals(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = match[0];
    if (tagAttribute(tag, 'rel') !== 'canonical') continue;
    const href = tagAttribute(tag, 'href');
    if (href !== undefined) found.push(href);
  }
  return found;
}

/** Inhalte aller `<meta name="robots">` aus rohem HTML. */
export function rawRobots(html: string): string[] {
  const found: string[] = [];
  for (const match of html.matchAll(/<meta\b[^>]*>/g)) {
    const tag = match[0];
    if (tagAttribute(tag, 'name') !== 'robots') continue;
    found.push(tagAttribute(tag, 'content') ?? '');
  }
  return found;
}

/** Inhalt eines `<meta property="…">` aus rohem HTML (erstes Vorkommen). */
export function rawMetaProperty(html: string, property: string): string | null {
  for (const match of html.matchAll(/<meta\b[^>]*>/g)) {
    const tag = match[0];
    if (tagAttribute(tag, 'property') === property) return tagAttribute(tag, 'content') ?? '';
  }
  return null;
}

// ── Seiten-Metadaten (DOM) ───────────────────────────────────────────────

export function attributeValues(
  page: Page,
  selector: string,
  attribute: string,
): Promise<string[]> {
  return page
    .locator(selector)
    .evaluateAll((elements, name) => elements.map((el) => el.getAttribute(name) ?? ''), attribute);
}

export function robotsMetas(page: Page): Promise<string[]> {
  return attributeValues(page, 'meta[name="robots"]', 'content');
}

export function canonicalHrefs(page: Page): Promise<string[]> {
  return attributeValues(page, 'link[rel="canonical"]', 'href');
}

export async function metaProperty(page: Page, property: string): Promise<string | null> {
  const values = await attributeValues(page, `meta[property="${property}"]`, 'content');
  expect(values.length, `höchstens ein <meta property="${property}">`).toBeLessThanOrEqual(1);
  return values[0] ?? null;
}

export async function metaName(page: Page, name: string): Promise<string | null> {
  const values = await attributeValues(page, `meta[name="${name}"]`, 'content');
  expect(values.length, `höchstens ein <meta name="${name}">`).toBeLessThanOrEqual(1);
  return values[0] ?? null;
}

export interface JsonLdScript {
  raw: string;
  data: Record<string, unknown>;
}

/** Alle `<script type="application/ld+json">` einer Seite – Rohtext + geparst (JSON.parse). */
export async function jsonLdScripts(page: Page): Promise<JsonLdScript[]> {
  const raws = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((elements) => elements.map((el) => el.textContent ?? ''));
  return raws.map((raw) => {
    const data = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof data, 'JSON-LD ist ein Objekt').toBe('object');
    return { raw, data };
  });
}

/** Alle `@type`-Werte (rekursiv). */
export function collectJsonLdTypes(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdTypes(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === '@type') {
        for (const type of Array.isArray(child) ? child : [child]) {
          if (typeof type === 'string') out.add(type);
        }
      } else {
        collectJsonLdTypes(child, out);
      }
    }
  }
  return out;
}

/** Alle Schlüssel (rekursiv). */
export function collectJsonLdKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdKeys(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.add(key);
      collectJsonLdKeys(child, out);
    }
  }
  return out;
}

// ── Responsive / Tastatur ────────────────────────────────────────────────

export interface OverflowMetrics {
  inner: number;
  html: number;
  body: number;
}

/** Kein horizontaler Überlauf des Dokuments (Auftrag §21/§30); liefert die Messwerte. */
export async function expectNoHorizontalOverflow(
  page: Page,
  label: string,
): Promise<OverflowMetrics> {
  const metrics = await page.evaluate(() => ({
    inner: window.innerWidth,
    html: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(metrics.html, `${label}: documentElement.scrollWidth ≤ innerWidth`).toBeLessThanOrEqual(
    metrics.inner,
  );
  expect(metrics.body, `${label}: body.scrollWidth ≤ innerWidth`).toBeLessThanOrEqual(
    metrics.inner,
  );
  return metrics;
}

/** Test-ID des fokussierten Elements (oder des nächsten Vorfahren mit Test-ID). */
export function focusedTestId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    return active.closest<HTMLElement>('[data-testid]')?.dataset.testid ?? null;
  });
}

/**
 * Mit Tab (nur Tastatur; `backwards` ⇒ Shift+Tab) zum Element mit der Test-ID wandern;
 * fokussiert zählt auch ein Nachfahre (z. B. der Radio-Knopf in einem Label mit Test-ID).
 */
export async function tabTo(
  page: Page,
  testId: string,
  maxPresses = 60,
  backwards = false,
): Promise<void> {
  const key = backwards ? 'Shift+Tab' : 'Tab';
  for (let presses = 0; presses < maxPresses; presses += 1) {
    if ((await focusedTestId(page)) === testId) return;
    await page.keyboard.press(key);
  }
  expect(await focusedTestId(page), `per ${key} erreichbar: ${testId}`).toBe(testId);
}

// ── robots.txt ───────────────────────────────────────────────────────────

export interface RobotsGroup {
  allow: string[];
  disallow: string[];
  sitemaps: string[];
}

/** `User-Agent: *`-Gruppe einer robots.txt (Allow/Disallow-Präfixe, Sitemap-Zeilen). */
export function parseRobots(text: string): RobotsGroup {
  const group: RobotsGroup = { allow: [], disallow: [], sitemaps: [] };
  let inStar = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === 'user-agent') inStar = value === '*';
    else if (key === 'sitemap') group.sitemaps.push(value);
    else if (inStar && key === 'allow' && value !== '') group.allow.push(value);
    else if (inStar && key === 'disallow' && value !== '') group.disallow.push(value);
  }
  return group;
}

/**
 * Darf ein Pfad laut `User-Agent: *` gecrawlt werden? Längste passende Regel gewinnt,
 * bei Gleichstand Allow (Google-Regel; einfache Präfixprüfung ohne Wildcards).
 */
export function robotsAllows(group: RobotsGroup, path: string): boolean {
  const longest = (rules: string[]) =>
    rules
      .filter((rule) => path.startsWith(rule))
      .reduce((max, rule) => Math.max(max, rule.length), -1);
  const allow = longest(group.allow);
  const disallow = longest(group.disallow);
  if (disallow < 0) return true;
  return allow >= disallow;
}

// ── Redirect-Matrix (docs/REDIRECT_MATRIX.md) ────────────────────────────

export type MatrixResult = '200' | '308' | '308-slash' | '410' | '404';

export interface MatrixRow {
  /** Altpfad genau wie dokumentiert (mit Platzhaltern). */
  documented: string;
  /** Anfragbarer Pfad (Platzhalter ersetzt). */
  path: string;
  result: MatrixResult;
  target: string | null;
  tests: string;
}

const MATRIX_PLACEHOLDERS: Record<string, string> = {
  '/?p=<id>': '/?p=25',
  '/?s=<suche>': '/?s=slush',
  '/wp-content/uploads/*': '/wp-content/uploads/2026/01/bild.jpg',
};

/** Tabellenzeilen der Matrix (beide Tabellen) – Quelle für SEO-R1/R5/R8. */
export function redirectMatrixRows(): MatrixRow[] {
  const markdown = readFileSync(resolve(REPO_ROOT, 'docs/REDIRECT_MATRIX.md'), 'utf8');
  const rows: MatrixRow[] = [];
  for (const line of markdown.split('\n')) {
    const match = /^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|\s*$/.exec(line);
    if (match === null) continue;
    const documented = match[1]!;
    const resultText = match[2]!.trim();
    const targetText = match[3]!.trim();
    const result: MatrixResult =
      resultText === '308 (Slash)'
        ? '308-slash'
        : resultText === '308'
          ? '308'
          : resultText === '410'
            ? '410'
            : resultText === '404'
              ? '404'
              : '200';
    expect(['200', '308', '308 (Slash)', '410', '404'], `Ergebnis ${documented}`).toContain(
      resultText,
    );
    const targetMatch = /^`([^`]+)`$/.exec(targetText);
    rows.push({
      documented,
      path: MATRIX_PLACEHOLDERS[documented] ?? documented,
      result,
      target: targetMatch === null ? null : targetMatch[1]!,
      tests: match[5]!.trim(),
    });
  }
  return rows;
}

// ── Location-Prüfung ─────────────────────────────────────────────────────

/**
 * Location eines Redirects: relativ (genau ein führender `/`, kein `//`, kein `\`) oder absolut
 * auf dem eigenen Origin – nie ein fremder Host. Liefert Pfad + Query.
 */
export function ownLocationPath(location: string | undefined, ownOrigin: string): string {
  expect(location, 'Location-Header vorhanden').toBeDefined();
  const value = location!;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    expect(url.origin, `Location ${value} bleibt auf dem eigenen Origin`).toBe(ownOrigin);
    return `${url.pathname}${url.search}`;
  }
  expect(value, `Location ${value} ist relativ mit genau einem führenden /`).toMatch(
    /^\/(?![/\\])/,
  );
  expect(value, 'Location ohne Zeilenumbruch').not.toMatch(/[\r\n]/);
  return value;
}

// ── Rohe HTTP-Anfragen (Host-Header-Poisoning) ───────────────────────────

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** `node:http` direkt – erlaubt einen gefälschten `Host`-/`X-Forwarded-*`-Header. */
export function rawRequest(
  origin: string,
  path: string,
  headers: Record<string, string>,
  method: 'GET' | 'HEAD' = 'GET',
): Promise<RawResponse> {
  const url = new URL(origin);
  return new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: Number(url.port),
        path,
        method,
        headers: { connection: 'close', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}
