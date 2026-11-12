/**
 * Phase-17-E2E (Auftrag §14, §15, §28, §34) – interne Link-QA aller veröffentlichten Seiten gegen
 * den PRODUCTION-Build der Website (Projekt `seo`, Port 3112).
 *
 * SEO-L1 jeder interne Link löst auf (200, höchstens ein 308-Hop auf 200) · SEO-L2 kein Link auf
 * 404/410 · SEO-L3 keine Links auf Vorschau, Token-Platzhalter, `undefined`/`null` · SEO-L4 keine
 * http://-Links außer dem eigenen Origin · SEO-L5 keine leeren tel:/mailto:/#-Links · SEO-L6 externe
 * Links und target=_blank mit rel=noopener · SEO-L7 Brotkrume nur auf Regions-/Secondary-Offer-
 * Seiten, letzte Position aria-current="page" · SEO-L8 Startseite verlinkt Slush, Konfigurator,
 * Kontakt; CTA-Texte bleiben „Slush konfigurieren“/„Unverbindlich anfragen“ (nie „buchen“); keine
 * exakte Abholadresse auf den Seiten.
 *
 * Daten: Basis-Seed + apps/api/scripts/e2e-website-seed.ts (alle Standardseiten veröffentlicht).
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { resetE2eDatabase } from '../helpers/seed.ts';
import {
  SEO_WEB_ORIGIN,
  fetchBootstrap,
  indexablePaths,
  ownLocationPath,
  type SeoBootstrap,
} from '../helpers/seo.ts';
import {
  expectNoExactPickupAddress,
  expectNoForbiddenPublicText,
  seedWebsite,
} from '../helpers/website.ts';

test.describe.configure({ mode: 'serial' });

const NO_REDIRECT = { maxRedirects: 0 } as const;
const LEGAL_PATHS = new Set(['/impressum', '/datenschutz']);

let bootstrap: SeoBootstrap;

interface LinkInfo {
  href: string;
  rel: string | null;
  target: string | null;
  text: string;
}

async function pageLinks(page: Page, path: string): Promise<LinkInfo[]> {
  const response = await page.goto(path, { timeout: 60_000 });
  expect(response?.status(), `GET ${path}`).toBe(200);
  return page.locator('a').evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: anchor.getAttribute('href') ?? '',
      rel: anchor.getAttribute('rel'),
      target: anchor.getAttribute('target'),
      text: (anchor.textContent ?? '').trim(),
    })),
  );
}

function isInternal(href: string): boolean {
  return /^\/(?!\/)/.test(href);
}

/** Alle Links aller indexierbaren Seiten, je Seite gesammelt. */
async function collectAllLinks(page: Page): Promise<Map<string, LinkInfo[]>> {
  const result = new Map<string, LinkInfo[]>();
  for (const path of indexablePaths(bootstrap)) result.set(path, await pageLinks(page, path));
  return result;
}

/** Status eines internen Ziels mit höchstens einem 308-Hop. */
async function resolveInternal(
  request: APIRequestContext,
  href: string,
): Promise<{ status: number; hops: number; final: string }> {
  let path = href;
  let hops = 0;
  for (;;) {
    const response = await request.get(path, NO_REDIRECT);
    const status = response.status();
    if (status < 300 || status >= 400 || hops >= 2) return { status, hops, final: path };
    path = ownLocationPath(response.headers()['location'], SEO_WEB_ORIGIN);
    hops += 1;
  }
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  resetE2eDatabase();
  seedWebsite('main');
  bootstrap = await fetchBootstrap();
});

test('SEO-L1/L2 Alle internen Links aller veröffentlichten Seiten lösen auf 200 auf (höchstens ein 308-Hop) – kein Link auf 404 oder 410', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const links = await collectAllLinks(page);
  const internal = new Map<string, string[]>();
  for (const [path, list] of links) {
    for (const link of list) {
      if (!isInternal(link.href)) continue;
      const sources = internal.get(link.href) ?? [];
      sources.push(path);
      internal.set(link.href, sources);
    }
  }
  expect(internal.size, 'interne Links gefunden').toBeGreaterThan(10);
  const broken: string[] = [];
  for (const [href, sources] of internal) {
    const resolved = await resolveInternal(request, href);
    if (resolved.status !== 200 || resolved.hops > 1) {
      broken.push(
        `${href} ⇒ ${resolved.status} nach ${resolved.hops} Hop(s) (auf ${sources.join(', ')})`,
      );
    }
    expect([404, 410], `${href}: kein Link auf 404/410`).not.toContain(resolved.status);
  }
  expect(broken, 'Links ohne 200').toEqual([]);
});

test('SEO-L3 Kein Link auf Vorschau, Token-Platzhalter, undefined/null oder Entwürfe; SEO-L4 keine http://-Links außer eigenem Origin', async ({
  page,
}) => {
  const links = await collectAllLinks(page);
  const published = new Set(indexablePaths(bootstrap));
  for (const [path, list] of links) {
    for (const link of list) {
      expect(link.href, `${path}: ${link.href}`).not.toMatch(
        /\/vorschau|\{token\}|\[token\]|undefined|null|\/angebot\/|\/dokument\/|\/kontakt\/.+/,
      );
      if (/^http:\/\//i.test(link.href)) {
        expect(new URL(link.href).origin, `${path}: http-Link ${link.href}`).toBe(SEO_WEB_ORIGIN);
      }
      if (isInternal(link.href)) {
        const target = new URL(link.href, SEO_WEB_ORIGIN).pathname.replace(/\/+$/, '') || '/';
        // Jeder interne CMS-Link zeigt auf eine veröffentlichte Seite oder eine App-Seite.
        const app =
          target === '/konto' || target.startsWith('/konto/') || target === '/konfigurator';
        expect(
          app || published.has(target),
          `${path}: Link auf Entwurf/Unbekanntes ${target}`,
        ).toBe(true);
      }
    }
  }
});

test('SEO-L5 Keine leeren tel:/mailto:/#-Links; SEO-L6 externe Links und target=_blank tragen rel=noopener', async ({
  page,
}) => {
  const links = await collectAllLinks(page);
  let external = 0;
  for (const [path, list] of links) {
    for (const link of list) {
      expect(link.href, `${path}: leerer Link`).not.toBe('');
      expect(link.href, `${path}: href="#"`).not.toBe('#');
      if (link.href.startsWith('tel:')) {
        expect(link.href, `${path}: Telefonlink`).toMatch(/^tel:\+?[0-9]{6,20}$/);
        expect(link.text.length, `${path}: Telefonlink mit Text`).toBeGreaterThan(0);
      }
      if (link.href.startsWith('mailto:')) {
        expect(link.href, `${path}: Maillink`).toMatch(
          /^mailto:[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/,
        );
        expect(link.text.length, `${path}: Maillink mit Text`).toBeGreaterThan(0);
      }
      if (/^https?:\/\//i.test(link.href) && new URL(link.href).origin !== SEO_WEB_ORIGIN) {
        external += 1;
        expect(link.href, `${path}: externer Link nur https`).toMatch(/^https:\/\//);
        expect(link.rel ?? '', `${path}: rel=noopener für ${link.href}`).toContain('noopener');
      }
      if (link.target === '_blank') {
        expect(link.rel ?? '', `${path}: target=_blank braucht rel=noopener`).toContain('noopener');
      }
      expect(link.href, `${path}: kein javascript:/data:`).not.toMatch(/^(javascript|data):/i);
    }
  }
  // Instagram ist im Seed nicht gepflegt (Redaktionsnotiz) – dann gibt es keine externen Links.
  if (bootstrap.settings?.instagramUrl === null) expect(external).toBe(0);
});

test('SEO-L7 Brotkrume nur auf Regions- und Secondary-Offer-Seiten (letzte Position aria-current="page", Trennzeichen rein per CSS) – nirgends sonst', async ({
  page,
}) => {
  for (const entry of bootstrap.pages) {
    await page.goto(entry.path, { timeout: 60_000 });
    const nav = page.locator('nav[aria-label="Brotkrumen"]');
    if (entry.pageType === 'region' || entry.pageType === 'secondary_offer') {
      await expect(nav, `${entry.path}: Brotkrume`).toBeVisible();
      await expect(nav).toHaveAttribute('data-testid', 'site-breadcrumbs');
      const items = nav.locator('li');
      expect(await items.count()).toBe(entry.pageType === 'region' ? 3 : 2);
      await expect(items.first().getByRole('link')).toHaveText('Start');
      await expect(items.first().getByRole('link')).toHaveAttribute('href', '/');
      const current = items.last().locator('[aria-current="page"]');
      await expect(current).toHaveText(entry.title);
      await expect(items.last().getByRole('link')).toHaveCount(0);
      // Kein Trennzeichen als Text (nur CSS), kein versteckter SEO-Pfad.
      const texts = await items.allInnerTexts();
      for (const text of texts) expect(text).not.toMatch(/[›>/|]/);
      await expect(nav).toBeInViewport();
    } else {
      await expect(nav, `${entry.path}: keine Brotkrume`).toHaveCount(0);
    }
  }
  await page.goto('/konfigurator', { timeout: 60_000 });
  await expect(page.locator('nav[aria-label="Brotkrumen"]')).toHaveCount(0);
});

test('SEO-L8 Startseite verlinkt /slushmaschine-mieten, /konfigurator und /kontakt; CTAs heißen „Slush konfigurieren“/„Unverbindlich anfragen“ und nie „buchen“; keine exakte Abholadresse', async ({
  page,
}) => {
  const links = await pageLinks(page, '/');
  const hrefs = new Set(links.map((link) => link.href.split(/[?#]/)[0]));
  for (const required of ['/slushmaschine-mieten', '/konfigurator', '/kontakt']) {
    expect(hrefs.has(required), `Startseite verlinkt ${required}`).toBe(true);
  }
  for (const link of links) {
    expect(link.text, `Linktext „${link.text}“`).not.toMatch(/buchen/i);
    if (link.text === 'Slush konfigurieren') expect(link.href).toBe('/konfigurator');
    if (link.text === 'Unverbindlich anfragen') {
      expect(['/konfigurator', '/kontakt']).toContain(link.href);
    }
  }
  await expect(page.getByTestId('site-cta-configure')).toHaveText('Slush konfigurieren');
  await expect(page.getByTestId('hero-primary-cta')).toHaveAttribute('href', '/konfigurator');

  for (const path of indexablePaths(bootstrap)) {
    await page.goto(path, { timeout: 60_000 });
    await expectNoExactPickupAddress(page, path);
    if (!LEGAL_PATHS.has(path)) await expectNoForbiddenPublicText(page, path);
  }
});
