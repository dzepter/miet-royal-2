/**
 * Phase-17-E2E (Auftrag §20, §21, §30) – Responsive- und Accessibility-Kernprüfungen gegen den
 * PRODUCTION-Build der Website (Projekt `seo`, Port 3112). Playwright-Prüfungen sind die
 * Hauptsache; der Axe-Scan ergänzt sie (kein Pixel-Screenshot-Test).
 *
 * SEO-A1 kein horizontaler Überlauf in 320×568, 360×800, 390×844, 768×1024, 1024×768, 1440×900 auf
 * Start, Slush, Konfigurator, Region, Kontakt, Portal-Login, 404, 410 · SEO-A2 Mobile-Navigation nur
 * per Tastatur (Tab, Enter, Tab in die Links, Escape ⇒ Fokus zurück, sichtbarer Fokus) · SEO-A3
 * Konfigurator nur per Tastatur bis zur Zusammenfassung (ohne Absenden) · SEO-A4 Fehlermeldungen
 * per aria-invalid/aria-describedby zugeordnet, Fehlerliste role=alert erhält den Fokus · SEO-A5
 * Skip-Link als erstes Tab-Ziel ⇒ Fokus auf main · SEO-A6 reduced-motion: keine Übergänge, Menü
 * funktioniert · SEO-A7 „Zoom 200 %“ als Viewport 640 px bei deviceScaleFactor 2 (entspricht einem
 * 1280-px-Fenster bei 200 %) sowie 320 px: kein Überlauf, Grundschrift ≥ 16 px · SEO-A8 Axe-Scan
 * (WCAG 2.0/2.1 A/AA + Best Practices): 0 Verstöße serious/critical, alle Funde im Protokoll ·
 * SEO-A9 keine modalen Dialoge auf der Website; das Mobile-Menü schließt per Escape mit Fokusrückgabe ·
 * SEO-A10 alle Bilder mit alt-Attribut · SEO-A11 genau ein main, jede nav mit aria-label · SEO-A12
 * html[lang="de"] überall (inkl. 404/410/Portal).
 *
 * Daten: Basis-Seed + apps/api/scripts/e2e-website-seed.ts. Keine Anfrage wird abgesendet.
 */
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { resetE2eDatabase } from '../helpers/seed.ts';
import { berlinDayPlus } from '../helpers/settlement.ts';
import {
  SEO_WEB_ORIGIN,
  expectNoHorizontalOverflow,
  fetchBootstrap,
  indexablePaths,
  tabTo,
  type SeoBootstrap,
} from '../helpers/seo.ts';
import { openConfigurator, seedWebsite, type WebsiteSeedResult } from '../helpers/website.ts';

test.describe.configure({ mode: 'serial' });

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
] as const;

/** Kernseiten (Auftrag §18/§30) inkl. Portal-Login, 404 und 410. */
const CORE_PAGES = [
  { path: '/', status: 200 },
  { path: '/slushmaschine-mieten', status: 200 },
  { path: '/konfigurator', status: 200 },
  { path: '/slushmaschine-mieten/mainz', status: 200 },
  { path: '/kontakt', status: 200 },
  { path: '/konto/anmelden', status: 200 },
  { path: '/gibt-es-nicht', status: 404 },
  { path: '/shop', status: 410 },
] as const;

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

let seed: WebsiteSeedResult;
let bootstrap: SeoBootstrap;

async function gotoSettled(page: Page, path: string, expectedStatus: number): Promise<void> {
  const response = await page.goto(`${SEO_WEB_ORIGIN}${path}`, {
    waitUntil: 'networkidle',
    timeout: 60_000,
  });
  expect(response?.status(), `GET ${path}`).toBe(expectedStatus);
}

async function mobilePage(browser: Browser, width = 360, height = 800): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
  });
  return context.newPage();
}

/** Sichtbarer Fokus des aktiven Elements (outline). */
async function expectVisibleFocus(page: Page, label: string): Promise<void> {
  const outline = await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    const style = getComputedStyle(active);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(outline, `${label}: aktives Element`).not.toBeNull();
  expect(outline!.style, `${label}: outline-style`).not.toBe('none');
  expect(outline!.width, `${label}: outline-width`).toBeGreaterThan(0);
}

/** Datum im Date-Feld rein per Tastatur: Ziffernfolge in der Segmentreihenfolge der Browser-Locale. */
async function typeDate(page: Page, iso: string): Promise<void> {
  const [year, month, day] = iso.split('-');
  const order = await page.evaluate(() =>
    new Intl.DateTimeFormat(navigator.language, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(2026, 0, 2))
      .filter((part) => part.type === 'day' || part.type === 'month' || part.type === 'year')
      .map((part) => part.type),
  );
  const digits = order
    .map((type) => (type === 'year' ? year : type === 'month' ? month : day))
    .join('');
  await page.keyboard.type(digits);
}

test.beforeAll(async () => {
  test.setTimeout(300_000);
  resetE2eDatabase();
  seed = seedWebsite('main');
  bootstrap = await fetchBootstrap();
  expect(seed.published).toBeGreaterThan(0);
});

// ── SEO-A1 ──────────────────────────────────────────────────────────────

test('SEO-A1 Kein horizontaler Überlauf (documentElement/body.scrollWidth ≤ innerWidth) in sechs Viewports auf allen Kernseiten inkl. 404/410', async ({
  browser,
}) => {
  test.setTimeout(600_000);
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({
      viewport,
      isMobile: viewport.width < 768,
      hasTouch: viewport.width < 768,
    });
    const page = await context.newPage();
    for (const core of CORE_PAGES) {
      await gotoSettled(page, core.path, core.status);
      const metrics = await expectNoHorizontalOverflow(
        page,
        `${viewport.width}×${viewport.height} ${core.path}`,
      );
      // Messwerte für den QA-Bericht (Viewport, Seite, scrollWidth html/body, innerWidth).
      console.log(
        `[overflow] ${viewport.width}x${viewport.height} ${core.path} html=${metrics.html} body=${metrics.body} inner=${metrics.inner}`,
      );
      // Hauptinhalt sichtbar: weder leer noch komplett außerhalb des Viewports.
      const main = page.locator('main').first();
      await expect(main, `${viewport.width}: main vorhanden`).toBeAttached();
      const box = await main.boundingBox();
      expect(box, `${viewport.width}: main gerendert`).not.toBeNull();
      expect(box!.x, `${viewport.width}: main beginnt im Viewport`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${viewport.width}: main endet im Viewport`).toBeLessThanOrEqual(
        viewport.width + 1,
      );
    }
    // Konfigurator-Folgeschritte (Maschine mit Produktkarten) im schmalen Viewport ebenfalls.
    if (viewport.width <= 390) {
      await openConfigurator(page, SEO_WEB_ORIGIN);
      await expectNoHorizontalOverflow(page, `${viewport.width}: Konfigurator Schritt 1`);
    }
    await context.close();
  }
});

// ── SEO-A2 ──────────────────────────────────────────────────────────────

test('SEO-A2 Mobile-Navigation (360×800) nur per Tastatur: Tab zum Menü-Knopf (Fokus sichtbar), Enter öffnet, Tab erreicht die Links, Escape schließt und fokussiert den Knopf', async ({
  browser,
}) => {
  const page = await mobilePage(browser);
  await gotoSettled(page, '/', 200);
  const button = page.getByTestId('site-menu-button');
  const panel = page.getByTestId('site-mobile-nav');
  await expect(button).toBeVisible();
  await expect(panel).toBeHidden();
  await tabTo(page, 'site-menu-button');
  await expectVisibleFocus(page, 'Menü-Knopf');
  // Enter öffnet (vor der Hydration wirkungslos ⇒ bis zur Reaktion wiederholen, kein Sleep).
  await expect(async () => {
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(panel).toBeVisible();
  await expect(button).toHaveText('Schließen');
  const panelId = await button.getAttribute('aria-controls');
  expect(panelId).toBeTruthy();
  await expect(page.locator(`[id="${panelId!}"]`)).toBeVisible();

  // Tab wandert in die Navigation; alle Menüpunkte und der CTA sind per Tab erreichbar.
  const linkCount = await panel.getByRole('link').count();
  expect(linkCount).toBeGreaterThanOrEqual(7);
  const reached: string[] = [];
  for (let presses = 0; presses < linkCount + 2; presses += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLAnchorElement &&
        active.closest('[data-testid="site-mobile-nav"]') !== null
        ? (active.textContent ?? '').trim()
        : null;
    });
    if (inside !== null) reached.push(inside);
  }
  expect(reached).toEqual(await panel.getByRole('link').allInnerTexts());
  await expectVisibleFocus(page, 'Menülink');

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();
  // Touchziele des Kopfbereichs mindestens 44 px hoch.
  for (const testId of ['site-menu-button', 'site-cta-configure']) {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box?.height ?? 0, `${testId}: Höhe ≥ 44 px`).toBeGreaterThanOrEqual(44);
  }
  await page.context().close();
});

// ── SEO-A3 ──────────────────────────────────────────────────────────────

test('SEO-A3 Konfigurator nur per Tastatur: alle Schritte bis zur Zusammenfassung (Datum, Gäste, Anlass, Maschine, Sirup, Abholung, Kontakt, Datenschutz-Checkbox) – ohne Maus, ohne Absenden', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openConfigurator(page, SEO_WEB_ORIGIN);
  const stepHeadingFocused = async (title: string) => {
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const active = document.activeElement;
            return active instanceof HTMLHeadingElement ? (active.textContent ?? '').trim() : null;
          }),
        { message: `Fokus auf Schrittüberschrift „${title}“` },
      )
      .toBe(title);
  };

  // Schritt 1: Event.
  await tabTo(page, 'cfg-date');
  await typeDate(page, berlinDayPlus(21));
  await expect(page.getByTestId('cfg-date')).toHaveValue(berlinDayPlus(21));
  await tabTo(page, 'cfg-guests');
  await page.keyboard.type('40');
  await expect(page.getByTestId('cfg-guests')).toHaveValue('40');
  await tabTo(page, 'cfg-occasion');
  await page.keyboard.press('ArrowDown');
  if ((await page.getByTestId('cfg-occasion').inputValue()) === '') {
    // Alternative Tastaturbedienung eines geschlossenen <select>: Anfangsbuchstabe tippen.
    const firstLabel = await page.locator('[data-testid="cfg-occasion"] option').nth(1).innerText();
    await page.keyboard.type(firstLabel.slice(0, 1));
  }
  await expect(page.getByTestId('cfg-occasion')).not.toHaveValue('');
  await tabTo(page, 'cfg-next');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('cfg-step-machine')).toBeVisible();
  await stepHeadingFocused('Maschine');

  // Schritt 2: Maschine (Radio per Leertaste).
  const firstMachine = page.locator('[data-testid^="cfg-machine-"]').first();
  const machineTestId = (await firstMachine.getAttribute('data-testid'))!;
  await tabTo(page, machineTestId);
  await page.keyboard.press('Space');
  await expect(firstMachine.locator('input[type="radio"]')).toBeChecked();
  await tabTo(page, 'cfg-next');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('cfg-step-syrup')).toBeVisible();
  await stepHeadingFocused('Sirup & Zubehör');

  // Schritt 3: Sirup & Zubehör – Mengenfeld per Tastatur erhöhen, dann weiter.
  const plus = page.locator('[data-testid$="-plus"]').first();
  const plusTestId = (await plus.getAttribute('data-testid'))!;
  // Kontingent kommt aus der laufenden Übersicht (Server) – erst dann ist „+“ bedienbar.
  await expect(plus).toBeEnabled({ timeout: 30_000 });
  await tabTo(page, plusTestId);
  await page.keyboard.press('Enter');
  const field = page.getByTestId(plusTestId.replace(/-plus$/, ''));
  await expect(field).not.toHaveValue('0');
  await tabTo(page, 'cfg-next');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('cfg-step-fulfillment')).toBeVisible();
  await stepHeadingFocused('Abholung oder Lieferung');

  // Schritt 4: Abholung (Standard) bleibt; Lieferung per Pfeiltaste erreichbar und zurück.
  await tabTo(page, 'cfg-fulfillment-pickup');
  await expect(page.getByTestId('cfg-fulfillment-pickup').locator('input')).toBeChecked();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('cfg-fulfillment-delivery').locator('input')).toBeChecked();
  await expect(page.getByTestId('cfg-delivery-fields')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('cfg-fulfillment-pickup').locator('input')).toBeChecked();
  await tabTo(page, 'cfg-next');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('cfg-step-contact')).toBeVisible();
  await stepHeadingFocused('Kontakt');

  // Schritt 5: Kontakt.
  await tabTo(page, 'cfg-firstName');
  await page.keyboard.type('Tabea');
  await tabTo(page, 'cfg-lastName');
  await page.keyboard.type('Tastatur');
  await tabTo(page, 'cfg-email');
  await page.keyboard.type('tabea.tastatur@website-e2e.test');
  await tabTo(page, 'cfg-next');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('cfg-step-summary')).toBeVisible();
  await stepHeadingFocused('Zusammenfassung');

  // Schritt 6: Zusammenfassung – Checkbox per Leertaste, Absende-Knopf erreichbar (nicht gedrückt).
  await expect(page.getByTestId('cfg-summary-contact')).toContainText('Tabea');
  await tabTo(page, 'cfg-privacy');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('cfg-privacy')).toBeChecked();
  await tabTo(page, 'cfg-submit');
  await expect(page.getByTestId('cfg-submit')).toBeEnabled();
  await expectVisibleFocus(page, 'Absende-Knopf');
  // Zurück zu einem früheren Schritt über die Schrittnavigation (Shift+Tab rückwärts).
  await tabTo(page, 'cfg-progress-event', 80, true);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('cfg-step-event')).toBeVisible();
  await expect(page.getByTestId('cfg-guests')).toHaveValue('40');
});

// ── SEO-A4 ──────────────────────────────────────────────────────────────

test('SEO-A4 Leeres Absenden von Schritt 1: Fehlerliste (role=alert) erhält den Fokus, Felder tragen aria-invalid und aria-describedby auf vorhandene Fehlermeldungen', async ({
  page,
}) => {
  await openConfigurator(page, SEO_WEB_ORIGIN);
  await tabTo(page, 'cfg-next');
  await page.keyboard.press('Enter');
  const errors = page.getByTestId('cfg-errors');
  await expect(errors).toBeVisible();
  await expect(errors).toHaveAttribute('role', 'alert');
  await expect(errors).toBeFocused();
  await expect(page.getByTestId('cfg-step-event')).toBeVisible();
  for (const field of ['cfg-date', 'cfg-guests', 'cfg-occasion']) {
    const input = page.getByTestId(field);
    await expect(input, `${field}: aria-invalid`).toHaveAttribute('aria-invalid', 'true');
    const describedBy = (await input.getAttribute('aria-describedby')) ?? '';
    const ids = describedBy.split(/\s+/).filter(Boolean);
    expect(ids, `${field}: aria-describedby`).toContain(`${field}-error`);
    for (const id of ids) {
      const message = page.locator(`[id="${id}"]`);
      await expect(message, `${field}: ${id} vorhanden`).toHaveCount(1);
      expect((await message.innerText()).trim().length, `${field}: Text in ${id}`).toBeGreaterThan(
        0,
      );
    }
    // Die Fehlerliste verlinkt das Feld.
    await expect(errors.locator(`a[href="#${field}"]`)).toHaveCount(1);
  }
  // Nach gültiger Eingabe verschwinden Fehler und aria-invalid.
  await page.getByTestId('cfg-date').fill(berlinDayPlus(21));
  await page.getByTestId('cfg-guests').fill('25');
  await page.getByTestId('cfg-occasion').selectOption({ index: 1 });
  await page.getByTestId('cfg-next').click();
  await expect(page.getByTestId('cfg-step-machine')).toBeVisible();
  await expect(page.getByTestId('cfg-errors')).toHaveCount(0);
});

// ── SEO-A5 ──────────────────────────────────────────────────────────────

test('SEO-A5 Skip-Link: erster Tab fokussiert „Zum Inhalt springen“ (sichtbar), Enter setzt den Hash #inhalt und den Fokus auf main', async ({
  page,
}) => {
  for (const path of ['/', '/slushmaschine-mieten/mainz']) {
    await gotoSettled(page, path, 200);
    await page.keyboard.press('Tab');
    const skip = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLAnchorElement)) return null;
      const rect = active.getBoundingClientRect();
      return { href: active.getAttribute('href'), text: active.textContent?.trim(), top: rect.top };
    });
    expect(skip?.href, `${path}: Skip-Link href`).toBe('#inhalt');
    expect(skip?.text, `${path}: Skip-Link Text`).toBe('Zum Inhalt springen');
    expect(skip?.top, `${path}: Skip-Link im Viewport sichtbar`).toBeGreaterThanOrEqual(0);
    await expectVisibleFocus(page, `${path}: Skip-Link`);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#inhalt');
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id ?? null), {
        message: `${path}: Fokus auf main#inhalt`,
      })
      .toBe('inhalt');
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('MAIN');
  }
});

// ── SEO-A6 ──────────────────────────────────────────────────────────────

test('SEO-A6 prefers-reduced-motion: keine Übergänge/Animationen auf Website-Elementen, Mobile-Menü funktioniert weiterhin', async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await gotoSettled(page, '/', 200);
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  );
  const button = page.getByTestId('site-menu-button');
  await expect(async () => {
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByTestId('site-mobile-nav')).toBeVisible();
  const motion = await page.evaluate(() => {
    const selectors = [
      '[data-testid="site-menu-button"]',
      '[data-testid="site-cta-configure"]',
      '[data-testid="site-mobile-nav"] a',
      '[data-testid="site-nav"] a',
      '[data-testid="hero-primary-cta"]',
    ];
    return selectors.flatMap((selector) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector)).map((element) => {
        const style = getComputedStyle(element);
        return {
          selector,
          transition: style.transitionDuration,
          animation: style.animationName,
          scroll: getComputedStyle(document.documentElement).scrollBehavior,
        };
      }),
    );
  });
  expect(motion.length).toBeGreaterThan(0);
  for (const entry of motion) {
    expect(
      entry.transition.split(',').every((value) => value.trim() === '0s'),
      `${entry.selector}: transition-duration 0s (ist ${entry.transition})`,
    ).toBe(true);
    expect(entry.animation, `${entry.selector}: keine Animation`).toBe('none');
  }
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('site-mobile-nav')).toBeHidden();
  await context.close();
});

// ── SEO-A7 ──────────────────────────────────────────────────────────────

test('SEO-A7 Zoom 200 %: Viewport 640×400 bei deviceScaleFactor 2 (≙ 1280-px-Fenster bei 200 %) und 320×568 – kein horizontaler Überlauf, Grundschrift ≥ 16 px, Inhalte sichtbar', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // Methode: Browser-Zoom 200 % entspricht einem halbierten CSS-Viewport bei verdoppelter
  // Gerätepixeldichte – genau das stellt deviceScaleFactor 2 mit 640 px Breite nach (kein
  // CSS `zoom`, das Media Queries nicht beeinflussen würde).
  for (const setup of [
    { viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 },
    { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2 },
  ]) {
    const context = await browser.newContext({ ...setup, isMobile: setup.viewport.width < 768 });
    const page = await context.newPage();
    for (const path of ['/', '/slushmaschine-mieten', '/konfigurator', '/kontakt']) {
      await gotoSettled(page, path, 200);
      const metrics = await expectNoHorizontalOverflow(
        page,
        `Zoom ${setup.viewport.width}: ${path}`,
      );
      const fontSize = await page.evaluate(() => {
        const frame = document.querySelector('[data-testid="site-frame"]');
        return Number.parseFloat(getComputedStyle(frame ?? document.body).fontSize);
      });
      expect(fontSize, `${path}: Grundschrift ≥ 16 px`).toBeGreaterThanOrEqual(16);
      console.log(
        `[zoom200] ${setup.viewport.width}x${setup.viewport.height}@${setup.deviceScaleFactor} ${path} html=${metrics.html} inner=${metrics.inner} font=${fontSize}px`,
      );
      await expect(page.locator('h1')).toBeVisible();
      await expect(page.getByTestId('site-cta-configure')).toBeInViewport();
    }
    await context.close();
  }
});

// ── SEO-A8 ──────────────────────────────────────────────────────────────

test('SEO-A8 Axe-Scan (WCAG 2.0/2.1 A/AA, Best Practices) auf Start, Slush, Konfigurator, Region, Kontakt, Portal-Login, 404, 410: keine Verstöße serious/critical; alle Funde im Protokoll', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const severe: string[] = [];
  for (const core of CORE_PAGES) {
    await gotoSettled(page, core.path, core.status);
    const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    // Plausibilität: der Scan hat die Seite wirklich geprüft (bestandene Regeln vorhanden).
    expect(results.passes.length, `${core.path}: Axe hat Regeln ausgewertet`).toBeGreaterThan(10);
    console.log(
      `[axe-summary] ${core.path} passes=${results.passes.length} violations=${results.violations.length} incomplete=${results.incomplete.length} inapplicable=${results.inapplicable.length} rules=${results.incomplete.map((rule) => rule.id).join(',')}`,
    );
    const summary = results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact ?? 'unbekannt',
      help: violation.help,
      nodes: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')),
    }));
    // Vollständige Fundliste (auch minor/moderate) für den Bericht.
    console.log(`[axe] ${core.path} ${JSON.stringify(summary)}`);
    for (const violation of summary) {
      if (violation.impact === 'serious' || violation.impact === 'critical') {
        severe.push(
          `${core.path}: ${violation.id} (${violation.impact}) ${violation.nodes.join(' | ')}`,
        );
      }
    }
  }
  expect(severe, 'Axe-Verstöße serious/critical').toEqual([]);
});

// ── SEO-A9 ──────────────────────────────────────────────────────────────

test('SEO-A9 Keine modalen Dialoge auf den Website-Seiten; das einzige Overlay (Mobile-Menü) schließt per Escape und gibt den Fokus zurück (390×844)', async ({
  browser,
  page,
}) => {
  for (const path of indexablePaths(bootstrap)) {
    await page.goto(`${SEO_WEB_ORIGIN}${path}`, { timeout: 60_000 });
    await expect(page.locator('dialog, [role="dialog"], [aria-modal="true"]')).toHaveCount(0);
  }
  const mobile = await mobilePage(browser, 390, 844);
  await gotoSettled(mobile, '/konfigurator', 200);
  const button = mobile.getByTestId('site-menu-button');
  await expect(async () => {
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await mobile.getByTestId('site-mobile-nav').getByRole('link').first().focus();
  await mobile.keyboard.press('Escape');
  await expect(mobile.getByTestId('site-mobile-nav')).toBeHidden();
  await expect(button).toBeFocused();
  await mobile.context().close();
});

// ── SEO-A10 ─────────────────────────────────────────────────────────────

test('SEO-A10 Jedes Bild hat ein alt-Attribut (leer nur dekorativ mit aria-hidden) – auf allen veröffentlichten Seiten, Konfigurator und 404', async ({
  page,
}) => {
  for (const path of [...indexablePaths(bootstrap), '/gibt-es-nicht']) {
    await page.goto(`${SEO_WEB_ORIGIN}${path}`, { timeout: 60_000 });
    const images = await page.locator('img').evaluateAll((elements) =>
      elements.map((img) => ({
        hasAlt: img.hasAttribute('alt'),
        alt: img.getAttribute('alt'),
        hidden: img.getAttribute('aria-hidden'),
        src: img.getAttribute('src') ?? '',
      })),
    );
    for (const image of images) {
      expect(image.hasAlt, `${path}: alt fehlt bei ${image.src}`).toBe(true);
      if (image.alt === '')
        expect(image.hidden, `${path}: dekoratives Bild aria-hidden`).toBe('true');
    }
  }
});

// ── SEO-A11 / SEO-A12 ───────────────────────────────────────────────────

test('SEO-A11 Genau ein main, jede nav mit aria-label, Überschriften beginnen mit H1; SEO-A12 html[lang="de"] auf allen Seiten inkl. Portal-Login, 404 und 410', async ({
  page,
  request,
}) => {
  const paths = [...indexablePaths(bootstrap), '/konto/anmelden', '/gibt-es-nicht'];
  for (const path of paths) {
    await page.goto(`${SEO_WEB_ORIGIN}${path}`, { timeout: 60_000 });
    await expect(page.locator('html'), `${path}: lang`).toHaveAttribute('lang', 'de');
    await expect(page.locator('main'), `${path}: genau ein main`).toHaveCount(1);
    const navs = await page
      .locator('nav')
      .evaluateAll((elements) =>
        elements.map(
          (nav) => nav.getAttribute('aria-label') ?? nav.getAttribute('aria-labelledby'),
        ),
      );
    for (const label of navs) expect(label, `${path}: nav mit aria-label`).toBeTruthy();
    expect(new Set(navs).size, `${path}: nav-Beschriftungen eindeutig`).toBe(navs.length);
    if (path !== '/konto/anmelden') {
      await expect(page.locator('h1'), `${path}: eine H1`).toHaveCount(1);
    }
  }
  // 410 (eigenständiges HTML aus dem Proxy): lang, main, nav mit aria-label, eine H1.
  const gone = await (await request.get('/shop', { maxRedirects: 0 })).text();
  expect(gone).toContain('<html lang="de">');
  expect(gone.match(/<main\b/g)?.length).toBe(1);
  expect(gone).toMatch(/<nav aria-label="[^"]+"/);
  expect(gone.match(/<h1\b/g)?.length).toBe(1);
});
