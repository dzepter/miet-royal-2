/**
 * Phase-16-E2E (Order §26) – neue öffentliche Website + Slush-Konfigurator auf der
 * Web-Instanz 3100 (Same-Origin-Proxy /api → Haupt-API 3101, APP_ENV development,
 * Bewertungs-Provider `disabled`). CMS-Redaktion (H–J) liegt in website-cms.spec.ts,
 * die Demo-Umgebung (K) in website-demo.spec.ts (Projekt `demo-communication`).
 *
 * A Startseite Desktop + mobil (390×844): Hauptnavigation, Mobile-Menü, dominanter CTA
 *   „Slush konfigurieren“ → /konfigurator, kein Fake-Content (keine Zähler/Statistiken,
 *   keine Bewertungen ohne Provider, kein „verbindlich buchen“, keine exakte Abholadresse)
 * B Slush-Seite: Preise == aktueller Backend-Preis (Katalog + Staff-Produkt-API);
 *   Preisänderung über die Staff-API (price.manage) ⇒ neue Preise ohne CMS-Änderung
 * C Konfigurator Abholung „Mainz-Hechtsheim“ – kompletter Flow ⇒ Vorgangsnummer, genau EIN
 *   neuer Vorgang (source website) mit Anfrage; Kasten „Website-Anfrage“ im Staff
 * D Konfigurator Lieferung: Adresse + Zeitfenster, „individuell geprüft“, nirgends ein
 *   Lieferpreis
 * E Großevent ≥ 250 Gäste: deutlicher Hinweis, Absenden trotzdem möglich
 * F Sirup/Zubehör: 1 L Gratis-Sirup je Behälter, freie Verteilung + „Sorte später
 *   abstimmen“, 25 Becher + 25 Strohhalme inklusive, Kommission mit Einheitspreis, Kanister
 *   nicht vorausgewählt und höchstens 2 je Behälter (Plus gesperrt, Server prüft erneut)
 * G Doppelklick ⇒ genau ein Vorgang; Netzabbruch NACH der Serververarbeitung ⇒ „Erneut
 *   senden“ ⇒ dieselbe Vorgangsnummer, weiterhin genau ein Vorgang
 * M Regression: öffentlicher Angebotslink (/angebot/[token]) – hier aus der Website-Anfrage
 *   von C erstellt – funktioniert weiter (Annahme), /kontakt/[token] bleibt noindex
 * L Regression: Kundenportal-Login (/konto, Magic Link aus der SMTP-Senke) und Anzeige
 *   einer aktiven Buchung
 *
 * Daten: Basis-Seed + apps/api/scripts/e2e-website-seed.ts (echter CMS-Bootstrap inkl.
 * Veröffentlichung, damit auch /datenschutz – Voraussetzung jeder Anfrage). Rate-Limits
 * der API sind aktiv: Anfragen (5/min, 20/h) und Übersicht (60/min) werden gezählt und nur
 * bei Bedarf abgewartet (helpers/website.ts `RateWindow`). Diese Spec sendet höchstens
 * 9 Anfragen je Lauf. Keine PII/Tokens in Konsolenausgaben.
 */
import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
  type Request,
} from '@playwright/test';
import { runDueJobsViaApi } from '../helpers/jobs.ts';
import { clearSink } from '../helpers/mail.ts';
import { germanDate, loginViaMagicLink, seedPortal } from '../helpers/portal.ts';
import { ADMIN_EMAIL, ADMIN_PASSWORD, resetE2eDatabase } from '../helpers/seed.ts';
import { berlinDayPlus, login } from '../helpers/settlement.ts';
import {
  CFG_TEXT,
  MAIN_NAV_LABELS,
  PICKUP_AREA,
  WEB_ORIGIN,
  acknowledgePrivacy,
  businessCounts,
  chooseMachine,
  confirmedProcessNumber,
  euro,
  expectNoExactPickupAddress,
  expectNoForbiddenPublicText,
  fetchCatalog,
  fillEvent,
  fillPrivateContact,
  inquirySelections,
  inquiryWindow,
  mainDb,
  nextStep,
  openConfigurator,
  previewWindow,
  priceText,
  publishedPaths,
  seedWebsite,
  submitAndConfirm,
  websiteProcessByNumber,
  type PublicCatalogDto,
  type WebsiteProcessRow,
  type WebsiteSeedResult,
} from '../helpers/website.ts';

test.describe.configure({ mode: 'serial' });

const DOMAIN = 'website-e2e.test';
const NAV_HREFS = [
  '/',
  '/slushmaschine-mieten',
  '/ablauf',
  '/faq',
  '/ueber-uns',
  '/kontakt',
  '/konto',
];
const LEGAL_PATHS = new Set(['/impressum', '/datenschutz']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MUTATION_ID_KEY = 'mr-konfigurator-anfrage-id';

let seed: WebsiteSeedResult;
let staff: Page;
let catalog: PublicCatalogDto;
let processC: WebsiteProcessRow | null = null;
const inquiries = inquiryWindow();
const previews = previewWindow();

/** Neuer, isolierter Besucher (eigener sessionStorage), dessen Requests gezählt werden. */
async function newVisitor(browser: Browser, options: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext(options);
  inquiries.attach(context);
  previews.attach(context);
  return context.newPage();
}

function isInquiryPost(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/api/public/inquiries';
}

function machine(slug: string) {
  const found = catalog.machines.find((candidate) => candidate.slug === slug);
  expect(found, `Maschine ${slug} im Katalog`).toBeDefined();
  return found!;
}

function product(slug: string) {
  const found = [
    ...catalog.syrups,
    ...catalog.accessories,
    ...(catalog.canister ? [catalog.canister] : []),
  ].find((candidate) => candidate.slug === slug);
  expect(found, `Produkt ${slug} im Katalog`).toBeDefined();
  return found!;
}

function onlyRow(processNumber: string): WebsiteProcessRow {
  const rows = websiteProcessByNumber(processNumber);
  expect(rows, `genau ein Vorgang ${processNumber} mit Anfrage + Website-Submission`).toHaveLength(
    1,
  );
  return rows[0]!;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  resetE2eDatabase();
  await clearSink();
  seed = seedWebsite('main');
  catalog = await fetchCatalog();
  staff = await browser.newPage();
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
});

test.afterAll(async () => {
  await staff?.context().close();
});

// ── A ─────────────────────────────────────────────────────────────────────

test('A1. Startseite Desktop: veröffentlichte Startseite mit Hauptnavigation (Start, Slush, Ablauf, FAQ, Über uns, Kontakt, Kundenbereich), dominantem CTA „Slush konfigurieren“ → /konfigurator, ohne Fake-Content', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const page = await newVisitor(browser);
  const foreignRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol.startsWith('http') && url.origin !== WEB_ORIGIN)
      foreignRequests.push(url.host);
  });
  const response = await page.goto(`${WEB_ORIGIN}/`, { timeout: 60_000 });
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId('site-frame')).toBeVisible();
  await expect(page.getByTestId('cms-page')).toBeVisible();
  await expect(page.getByTestId('site-fallback-home')).toHaveCount(0);
  await expect(page.locator('h1')).toHaveCount(1);

  const nav = page.getByTestId('site-nav');
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('link')).toHaveText([...MAIN_NAV_LABELS]);
  const hrefs = await nav
    .getByRole('link')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(hrefs).toEqual(NAV_HREFS);
  await expect(nav.getByRole('link', { name: 'Start' })).toHaveAttribute('aria-current', 'page');
  // Desktop: kein Menü-Knopf, kein ausgeklapptes Mobile-Menü.
  await expect(page.getByTestId('site-menu-button')).toBeHidden();
  await expect(page.getByTestId('site-mobile-nav')).toBeHidden();

  // Dominanter CTA im Kopf + Hero-Primär-CTA, beide → /konfigurator; nie „buchen“.
  const cta = page.getByTestId('site-cta-configure');
  await expect(cta).toBeVisible();
  await expect(cta).toHaveText('Slush konfigurieren');
  await expect(cta).toHaveAttribute('href', '/konfigurator');
  await expect(page.getByTestId('hero-primary-cta')).toHaveText('Slush konfigurieren');
  await expect(page.getByTestId('hero-primary-cta')).toHaveAttribute('href', '/konfigurator');

  // Kein Fake-Content: keine Zähler/Statistiken/Sterne, keine Bewertungs-Sektion ohne Provider,
  // kein „verbindlich buchen“, keine exakte Abholadresse, keine Fremd-Requests (Google o. Ä.).
  await expectNoForbiddenPublicText(page, 'Startseite');
  await expect(page.getByTestId('reviews-section')).toHaveCount(0);
  await expectNoExactPickupAddress(page, 'Startseite');
  // Maschinenpreise nur aus dem Katalog (Produktraster der Startseite).
  for (const entry of catalog.machines) {
    await expect(page.getByTestId(`product-price-${entry.slug}`)).toHaveText(priceText(entry));
  }
  // Fußbereich: Rechtstexte nur, weil veröffentlicht; Kundenbereich verlinkt.
  await expect(page.getByTestId('site-footer-legal').getByRole('link')).toHaveText([
    'Impressum',
    'Datenschutz',
  ]);

  // Jede Navigationsseite ist erreichbar (CMS-Seiten mit genau einer H1, ohne Fake-Content).
  for (const [index, href] of NAV_HREFS.entries()) {
    if (href === '/' || href === '/konto') continue;
    const label = MAIN_NAV_LABELS[index]!;
    await page.getByTestId('site-nav').getByRole('link', { name: label }).click();
    await page.waitForURL(`${WEB_ORIGIN}${href}`, { timeout: 60_000 });
    await expect(page.getByTestId('cms-page')).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByTestId('site-nav').getByRole('link', { name: label })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoForbiddenPublicText(page, href);
    await expectNoExactPickupAddress(page, href);
  }
  // Alle übrigen veröffentlichten Seiten (Rechtstexte, sekundäre Angebote, Regionen): erreichbar,
  // keine exakte Abholadresse, kein „verbindlich buchen“ (Rechtstexte dürfen Dritte nennen).
  for (const path of publishedPaths(seed)) {
    if (NAV_HREFS.includes(path)) continue;
    const pageResponse = await page.goto(`${WEB_ORIGIN}${path}`, { timeout: 60_000 });
    expect(pageResponse?.status(), `GET ${path}`).toBe(200);
    await expect(page.getByTestId('cms-page')).toBeVisible();
    await expect(page.locator('h1')).toHaveCount(1);
    await expectNoExactPickupAddress(page, path);
    if (LEGAL_PATHS.has(path)) {
      expect(/verbindlich buchen/i.test(await page.locator('body').innerText())).toBe(false);
    } else {
      await expectNoForbiddenPublicText(page, path);
    }
  }
  // Kundenbereich bleibt das Portal (ohne Website-Rahmen).
  await page.goto(`${WEB_ORIGIN}/`);
  await page.getByTestId('site-nav').getByRole('link', { name: 'Kundenbereich' }).click();
  await page.waitForURL(/\/konto(\/anmelden)?$/, { timeout: 60_000 });
  await expect(page.getByTestId('site-frame')).toHaveCount(0);

  // CTA führt in den Konfigurator.
  await page.goto(`${WEB_ORIGIN}/`);
  await page.getByTestId('site-cta-configure').click();
  await page.waitForURL(`${WEB_ORIGIN}/konfigurator`, { timeout: 60_000 });
  await expect(page.getByTestId('configurator')).toBeVisible();
  expect(foreignRequests, 'Requests an fremde Hosts').toEqual([]);
  await page.context().close();
});

test('A2. Startseite mobil (390×844): Menü-Knopf mit aria-expanded, Escape schließt, Navigation per Menü, CTA als volle Zeile, kein horizontales Scrollen', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await newVisitor(browser, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(`${WEB_ORIGIN}/`, { timeout: 60_000 });
  await expect(page.getByTestId('cms-page')).toBeVisible();
  // Desktop-Navigation ausgeblendet, Menü-Knopf sichtbar, Panel zu.
  await expect(page.getByTestId('site-nav')).toBeHidden();
  const menuButton = page.getByTestId('site-menu-button');
  await expect(menuButton).toBeVisible();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('site-mobile-nav')).toBeHidden();

  // Dominanter CTA bleibt sichtbar (schmal: volle Zeile) und passt in den Viewport.
  const cta = page.getByTestId('site-cta-configure');
  await expect(cta).toBeVisible();
  const box = await cta.boundingBox();
  expect(box, 'CTA-Box').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'horizontales Scrollen auf 390 px').toBeLessThanOrEqual(0);

  // Menü öffnen: alle Navigationspunkte + CTA; Escape schließt und fokussiert den Knopf.
  // (Erster Klick ggf. vor der Hydration des Client-Menüs ⇒ bis zur Reaktion wiederholen.)
  await expect(async () => {
    await menuButton.click();
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  const panel = page.getByTestId('site-mobile-nav');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('listitem')).toHaveText([...MAIN_NAV_LABELS]);
  await expect(panel.getByRole('link', { name: 'Slush konfigurieren' })).toHaveAttribute(
    'href',
    '/konfigurator',
  );
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await expect(menuButton).toBeFocused();

  // Navigation über das Menü: FAQ öffnen ⇒ Seite gewechselt, Menü geschlossen.
  await menuButton.click();
  await panel.getByRole('link', { name: 'FAQ' }).click();
  await page.waitForURL(`${WEB_ORIGIN}/faq`, { timeout: 60_000 });
  await expect(page.getByTestId('site-mobile-nav')).toBeHidden();
  await expect(page.getByTestId('cms-page')).toBeVisible();
  await expectNoForbiddenPublicText(page, 'FAQ mobil');

  // CTA aus dem mobilen Menü ⇒ Konfigurator (mobil bedienbar, erster Schritt).
  await page.getByTestId('site-menu-button').click();
  await page
    .getByTestId('site-mobile-nav')
    .getByRole('link', { name: 'Slush konfigurieren' })
    .click();
  await page.waitForURL(`${WEB_ORIGIN}/konfigurator`, { timeout: 60_000 });
  await expect(page.getByTestId('cfg-step-event')).toBeVisible();
  const cfgOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(cfgOverflow, 'horizontales Scrollen im Konfigurator (390 px)').toBeLessThanOrEqual(0);
  await page.context().close();
});

// ── B ─────────────────────────────────────────────────────────────────────

test('B. Slush-Seite zeigt die aktuellen Backend-Preise (Katalog = Staff-Produkt-API); Preisänderung mit price.manage erscheint ohne CMS-Änderung', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const page = await newVisitor(browser);
  // Vier aktive Maschinentypen; Katalogpreise == ProductService-Preise der Staff-API.
  expect(catalog.machines.map((entry) => entry.slug).sort()).toEqual([
    'slush-1x10',
    'slush-1x8',
    'slush-2x10',
    'slush-2x8',
  ]);
  const productsResponse = await staff.request.get('/api/staff/products');
  expect(productsResponse.status()).toBe(200);
  const staffProducts = (
    (await productsResponse.json()) as {
      products: { id: string; slug: string; currentPriceCents: number }[];
    }
  ).products;
  const staffPrice = (slug: string) => {
    const found = staffProducts.find((entry) => entry.slug === slug);
    expect(found, `Staff-Produkt ${slug}`).toBeDefined();
    return found!;
  };
  for (const entry of [...catalog.machines, ...catalog.syrups, ...catalog.accessories]) {
    expect(entry.priceCents, `Katalogpreis ${entry.slug}`).toBe(
      staffPrice(entry.slug).currentPriceCents,
    );
  }

  await page.goto(`${WEB_ORIGIN}/slushmaschine-mieten`, { timeout: 60_000 });
  await expect(page.getByTestId('product-grid')).toBeVisible();
  for (const entry of catalog.machines) {
    await expect(page.getByTestId(`product-card-${entry.slug}`)).toContainText(entry.name);
    await expect(page.getByTestId(`product-price-${entry.slug}`)).toHaveText(priceText(entry));
  }
  for (const entry of [...catalog.syrups, ...catalog.accessories]) {
    await expect(page.getByTestId(`included-price-${entry.slug}`)).toHaveText(priceText(entry));
  }
  expect(catalog.canister).not.toBeNull();
  await expect(page.getByTestId(`included-price-${catalog.canister!.slug}`)).toHaveText(
    priceText(catalog.canister!),
  );
  await expect(page.getByTestId('included-free')).toContainText('1 L Sirup je Maschinenbehälter');
  await expect(page.getByTestId('included-free')).toContainText(
    '25 Becher und 25 Strohhalme je Mietvorgang',
  );
  await expectNoExactPickupAddress(page, 'Slush-Seite');

  // Preis ändern (Admin mit price.manage, bestehende Produkt-Route) – CMS bleibt unberührt.
  const cmsBefore = mainDb<{ published_revision_id: string; version: number }>(
    'SELECT published_revision_id, version FROM cms_entries WHERE path = $1',
    ['/slushmaschine-mieten'],
  );
  const revisionsBefore = mainDb<{ n: number }>('SELECT count(*)::int AS n FROM cms_revisions')[0]!
    .n;
  const target = staffPrice('slush-1x8');
  const newPriceCents = target.currentPriceCents + 450;
  const change = await staff.request.post(`/api/staff/products/${target.id}/price`, {
    data: { priceCents: newPriceCents },
  });
  expect(change.status()).toBe(200);

  const updated = await fetchCatalog();
  const updatedMachine = updated.machines.find((entry) => entry.slug === 'slush-1x8')!;
  expect(updatedMachine.priceCents).toBe(newPriceCents);
  await page.reload();
  await expect(page.getByTestId('product-price-slush-1x8')).toHaveText(
    `Mietpreis ${euro(newPriceCents)}`,
  );
  // Startseite (anderes CMS-Produktraster) ebenfalls neu; andere Preise unverändert.
  await page.goto(`${WEB_ORIGIN}/`);
  await expect(page.getByTestId('product-price-slush-1x8')).toHaveText(
    `Mietpreis ${euro(newPriceCents)}`,
  );
  await expect(page.getByTestId('product-price-slush-2x8')).toHaveText(
    priceText(machine('slush-2x8')),
  );
  expect(
    mainDb('SELECT published_revision_id, version FROM cms_entries WHERE path = $1', [
      '/slushmaschine-mieten',
    ]),
  ).toEqual(cmsBefore);
  expect(mainDb<{ n: number }>('SELECT count(*)::int AS n FROM cms_revisions')[0]!.n).toBe(
    revisionsBefore,
  );
  catalog = updated; // Folgeszenarien vergleichen mit dem aktuellen Stand
  await page.context().close();
});

// ── C ─────────────────────────────────────────────────────────────────────

test('C. Konfigurator Abholung: Event → Maschine → Sirup & Zubehör → Abholung „Mainz-Hechtsheim“ → Kontakt → Zusammenfassung + Datenschutz ⇒ Vorgangsnummer; genau EIN neuer Vorgang (source website) mit Anfrage, Kasten „Website-Anfrage“ im Staff', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await newVisitor(browser);
  await previews.reserve(15);
  const eventDate = berlinDayPlus(30);
  const contact = { firstName: 'Clara', lastName: 'Abholung', email: `clara.abholung@${DOMAIN}` };
  const before = businessCounts();

  await openConfigurator(page);
  await expect(page.getByTestId('cfg-progress-event')).toHaveAttribute('aria-current', 'step');
  await expect(page.getByTestId('cfg-summary')).toContainText(CFG_TEXT.PRICE_NOTE);
  await fillEvent(page, { date: eventDate, guests: 40, startTime: '18:00', endTime: '23:30' });
  await expect(page.getByTestId('cfg-large-event')).toHaveCount(0);
  await nextStep(page, 'machine');

  // Maschine: keine gepflegte Empfehlungsregel ⇒ Fallback-Text, freie Wahl aus 4 Typen,
  // Preise aus dem Katalog, keine Bestände/Verfügbarkeit.
  await expect(page.getByTestId('cfg-recommendation')).toHaveText(CFG_TEXT.RECOMMENDATION_FALLBACK);
  await expect(page.getByTestId('cfg-recommended-badge')).toHaveCount(0);
  for (const entry of catalog.machines) {
    await expect(page.getByTestId(`cfg-machine-${entry.slug}`)).toContainText(priceText(entry));
  }
  const machineText = await page.getByTestId('cfg-step-machine').innerText();
  expect(/verfügbar|bestand|auf lager|ausgebucht/i.test(machineText), 'Bestand/Verfügbarkeit').toBe(
    false,
  );
  const chosen = machine('slush-2x8');
  await chooseMachine(page, chosen.slug);
  await expect(page.getByTestId('cfg-fixed')).toContainText(chosen.name);
  await expect(page.getByTestId('cfg-fixed-total')).toContainText(euro(chosen.priceCents));
  await nextStep(page, 'syrup');

  // Sirup: 2 Behälter ⇒ 2 L gratis; 1 L Kirsche, 1 L bleibt „Sorte später abstimmen“.
  await expect(page.getByTestId('cfg-free-syrup')).toContainText('Inklusive: 2 L Sirup');
  await page.getByTestId('cfg-free-sirup-kirsche-plus').click();
  await expect(page.getByTestId('cfg-free-sirup-kirsche')).toHaveValue('1');
  await expect(page.getByTestId('cfg-free-open')).toHaveText(
    `Noch offen: 1 L – ${CFG_TEXT.UNASSIGNED_SYRUP}`,
  );
  await expect(page.getByTestId('cfg-included-list')).toContainText(CFG_TEXT.UNASSIGNED_SYRUP);
  await nextStep(page, 'fulfillment');

  // Abholung: nur der öffentliche Bereich, nie die exakte Adresse.
  const pickup = page.getByTestId('cfg-fulfillment-pickup');
  await expect(pickup.locator('input[type="radio"]')).toBeChecked();
  await expect(pickup).toContainText(`Selbst abholen in ${PICKUP_AREA}`);
  await expect(pickup).toContainText(CFG_TEXT.PICKUP_ADDRESS_NOTE);
  await expectNoExactPickupAddress(page, 'Konfigurator Abholung');
  await nextStep(page, 'contact');
  await fillPrivateContact(page, contact);
  await nextStep(page, 'summary');

  await expect(page.getByTestId('cfg-summary-event')).toContainText(germanDate(eventDate));
  await expect(page.getByTestId('cfg-summary-event')).toContainText('18:00 bis 23:30 Uhr');
  await expect(page.getByTestId('cfg-summary-machine')).toContainText(chosen.name);
  await expect(page.getByTestId('cfg-summary-syrup')).toContainText('Kirsche 1 L');
  await expect(page.getByTestId('cfg-summary-fulfillment')).toContainText(
    `Selbst abholen in ${PICKUP_AREA}`,
  );
  await expect(page.getByTestId('cfg-summary-contact')).toContainText('Clara Abholung');
  await expectNoExactPickupAddress(page, 'Zusammenfassung');
  await expectNoForbiddenPublicText(page, 'Zusammenfassung');
  await acknowledgePrivacy(page);
  await inquiries.reserve(1);
  const processNumber = await submitAndConfirm(page);
  await expectNoExactPickupAddress(page, 'Bestätigung');

  // Genau EIN neuer Vorgang mit Anfrage und Website-Submission.
  const after = businessCounts();
  expect(after).toEqual({
    processes: before.processes + 1,
    inquiries: before.inquiries + 1,
    customers: before.customers + 1,
    submissions: before.submissions + 1,
  });
  const row = onlyRow(processNumber);
  expect(row.source).toBe('website');
  expect(row.process_created_by, 'kein künstlicher Website-Mitarbeiter').toBeNull();
  expect(row.inquiry_created_by).toBeNull();
  expect(row.event_date).toBe(eventDate);
  expect(row.guest_count).toBe(40);
  expect(row.occasion).toBe('birthday');
  expect(row.machine_slug).toBe(chosen.slug);
  expect(row.fulfillment).toBe('pickup');
  expect(row.customer_match).toBe('new_customer');
  expect(row.customer_email).toBe(contact.email);
  expect(row.privacy_path).toBe('/datenschutz');
  expect(row.privacy_is_published).toBe(true);
  expect(inquirySelections(row.inquiry_id)).toEqual([
    { slug: 'sirup-kirsche', role: 'free', quantity: 1 },
  ]);

  // Staff-API + Staff-UI (Inquiry-Ansicht): Kasten „Website-Anfrage“.
  const submission = await staff.request.get(
    `/api/staff/processes/${row.process_id}/website-submission`,
  );
  expect(submission.status()).toBe(200);
  const view = (await submission.json()) as {
    customerMatch: string;
    duplicateWarning: boolean;
    privacy: { revisionNumber: number };
  };
  expect(view.customerMatch).toBe('new_customer');
  expect(view.duplicateWarning).toBe(false);
  expect(view.privacy.revisionNumber).toBe(1);
  await staff.goto(`/vorgaenge/${row.process_id}/anfrage`);
  const box = staff.getByTestId('website-submission');
  await expect(box).toBeVisible();
  await expect(box.getByRole('heading', { name: 'Website-Anfrage' })).toBeVisible();
  await expect(staff.getByTestId('website-submission-privacy')).toContainText('Revision 1');
  await expect(staff.getByTestId('website-submission-duplicate')).toHaveCount(0);
  processC = row;
  await page.context().close();
});

// ── D ─────────────────────────────────────────────────────────────────────

test('D. Konfigurator Lieferung: Adresse + optionales Zeitfenster, Hinweis „individuell geprüft“, nirgends ein Lieferpreis (Übersicht, Zusammenfassung, Bestätigung)', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await newVisitor(browser);
  await previews.reserve(15);
  const eventDate = berlinDayPlus(35);
  const before = businessCounts();

  await openConfigurator(page);
  await fillEvent(page, { date: eventDate, guests: 80, occasionLabel: 'Firmenfeier' });
  await nextStep(page, 'machine');
  const chosen = machine('slush-1x10');
  await chooseMachine(page, chosen.slug);
  await expect(page.getByTestId('cfg-fixed-total')).toContainText(euro(chosen.priceCents));
  await nextStep(page, 'syrup');
  await expect(page.getByTestId('cfg-free-syrup')).toContainText('Inklusive: 1 L Sirup');
  await nextStep(page, 'fulfillment');

  await page.getByTestId('cfg-fulfillment-delivery').click();
  await expect(page.getByTestId('cfg-fulfillment-delivery')).toContainText(CFG_TEXT.DELIVERY_NOTE);
  await expect(page.getByTestId('cfg-delivery-note')).toContainText(CFG_TEXT.DELIVERY_NOTE);
  await page.getByTestId('cfg-street').fill('Lieferweg 7');
  await page.getByTestId('cfg-postalCode').fill('55116');
  await page.getByTestId('cfg-city').fill('Mainz');
  await page.getByTestId('cfg-window-from').fill('14:00');
  await page.getByTestId('cfg-window-to').fill('16:00');
  // Laufende Übersicht: Lieferung nur als Text, kein Betrag; Summe = nur die Maschine.
  await expect(page.getByTestId('cfg-delivery-text')).toHaveText(CFG_TEXT.DELIVERY_PREVIEW);
  await expect(page.getByTestId('cfg-fixed-total')).toContainText(euro(chosen.priceCents));
  await expect(page.getByTestId('cfg-fixed')).not.toContainText(/liefer/i);
  const noteText = await page.getByTestId('cfg-delivery-note').innerText();
  expect(/€|\d+\s*(km|euro)/i.test(noteText), 'Lieferhinweis ohne Preis/Formel').toBe(false);
  await nextStep(page, 'contact');

  // Organisation statt Privatperson (Telefon optional).
  await page.getByTestId('cfg-contact-organization').click();
  await page.getByTestId('cfg-organizationName').fill('Lieferverein Rheinhessen e. V.');
  await page.getByTestId('cfg-contactPerson').fill('Dora Liefer');
  await page.getByTestId('cfg-email').fill(`dora.liefer@${DOMAIN}`);
  await nextStep(page, 'summary');

  const fulfillmentSummary = page.getByTestId('cfg-summary-fulfillment');
  await expect(fulfillmentSummary).toContainText('Lieferung (wird individuell geprüft)');
  await expect(fulfillmentSummary).toContainText('Lieferweg 7, 55116 Mainz');
  await expect(fulfillmentSummary).toContainText('am Veranstaltungstag 14:00 bis 16:00 Uhr');
  expect((await fulfillmentSummary.innerText()).includes('€'), 'Betrag bei der Lieferung').toBe(
    false,
  );
  await expect(page.getByTestId('cfg-summary-contact')).toContainText(
    'Lieferverein Rheinhessen e. V.',
  );
  // Alle Beträge der Übersicht sind Katalogbeträge – kein zusätzlicher (Liefer-)Betrag.
  const overviewAmounts = (await page.getByTestId('cfg-summary').innerText()).match(
    /\d{1,3}(\.\d{3})*,\d{2} €/g,
  );
  expect(new Set(overviewAmounts ?? [])).toEqual(new Set([euro(chosen.priceCents)]));
  await acknowledgePrivacy(page);
  await inquiries.reserve(1);
  const processNumber = await submitAndConfirm(page);
  const confirmation = await page.getByTestId('cfg-confirmation').innerText();
  expect(confirmation.includes('€'), 'Betrag in der Bestätigung').toBe(false);

  expect(businessCounts().processes).toBe(before.processes + 1);
  const row = onlyRow(processNumber);
  expect(row.source).toBe('website');
  expect(row.fulfillment).toBe('delivery');
  expect([row.delivery_street, row.delivery_postal_code, row.delivery_city]).toEqual([
    'Lieferweg 7',
    '55116',
    'Mainz',
  ]);
  expect(row.delivery_window_from).toBe(`${eventDate} 14:00`);
  expect(row.delivery_window_to).toBe(`${eventDate} 16:00`);
  expect(row.machine_slug).toBe(chosen.slug);

  // Staff: Hinweis zum Lieferfenster am Veranstaltungstag.
  await staff.goto(`/vorgaenge/${row.process_id}/anfrage`);
  await expect(staff.getByTestId('website-submission')).toBeVisible();
  await expect(staff.getByTestId('website-submission-window')).toBeVisible();
  await page.context().close();
});

// ── E ─────────────────────────────────────────────────────────────────────

test('E. Großevent ab 250 Gästen: deutlicher, freundlicher Hinweis (Schritt 1 + Zusammenfassung), Absenden trotzdem möglich ⇒ Vorgang entsteht', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await newVisitor(browser);
  await previews.reserve(15);
  expect(catalog.largeEventGuestThreshold).toBe(250);
  const before = businessCounts();

  await openConfigurator(page);
  await fillEvent(page, { date: berlinDayPlus(40), guests: 249, occasionLabel: 'Festival' });
  await expect(page.getByTestId('cfg-large-event')).toHaveCount(0);
  await page.getByTestId('cfg-guests').fill('300');
  const notice = page.getByTestId('cfg-large-event');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Großes Event');
  await expect(notice).toContainText('Ab 250 Gästen');
  await expect(notice).toContainText('Du kannst deine Anfrage ganz normal absenden.');
  await nextStep(page, 'machine');
  // Keine Empfehlungsregel ⇒ persönlicher Fallback, nie eine Ablehnung.
  await expect(page.getByTestId('cfg-recommendation')).toHaveText(CFG_TEXT.RECOMMENDATION_FALLBACK);
  await chooseMachine(page, 'slush-2x10');
  await nextStep(page, 'syrup');
  await nextStep(page, 'fulfillment');
  await nextStep(page, 'contact');
  await fillPrivateContact(page, {
    firstName: 'Gustav',
    lastName: 'Großevent',
    email: `gustav.grossevent@${DOMAIN}`,
    phone: '+49 6131 123456',
  });
  await nextStep(page, 'summary');
  await expect(page.getByTestId('cfg-large-event')).toBeVisible();
  await expect(page.getByTestId('cfg-summary-event')).toContainText('300');
  await acknowledgePrivacy(page);
  await inquiries.reserve(1);
  const processNumber = await submitAndConfirm(page);

  expect(businessCounts().processes).toBe(before.processes + 1);
  const row = onlyRow(processNumber);
  expect(row.guest_count).toBe(300);
  expect(row.occasion).toBe('festival');
  expect(row.machine_slug).toBe('slush-2x10');
  await page.context().close();
});

// ── F ─────────────────────────────────────────────────────────────────────

test('F. Sirup & Zubehör: 1 L Gratis-Sirup je Behälter frei verteilbar + „Sorte später abstimmen“, 25 Becher/Strohhalme inklusive, Kommission mit Einheitspreis, Kanister nicht vorausgewählt und höchstens 2 je Behälter', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await newVisitor(browser);
  await previews.reserve(30);
  const before = businessCounts();
  const syrupSlugs = catalog.syrups.map((entry) => entry.slug).sort();
  expect(syrupSlugs).toEqual([
    'sirup-blaue-himbeere',
    'sirup-kirsche',
    'sirup-waldmeister',
    'sirup-wassermelone',
  ]);
  const canister = catalog.canister!;
  expect(canister.maxPerContainer).toBe(2);
  const cups = product('becher-25');
  const straws = product('strohhalme-25');
  const melon = product('sirup-wassermelone');

  await openConfigurator(page);
  await fillEvent(page, { date: berlinDayPlus(45), guests: 60 });
  await nextStep(page, 'machine');
  await chooseMachine(page, 'slush-1x10');
  await nextStep(page, 'syrup');

  // 1 Behälter ⇒ 1 L gratis; nach Verteilung sind alle Plus-Knöpfe gesperrt.
  await expect(page.getByTestId('cfg-free-syrup')).toContainText(
    'Inklusive: 1 L Sirup (1 L je Maschinenbehälter)',
  );
  await expect(page.getByTestId('cfg-free-open')).toContainText(
    `Noch offen: 1 L – ${CFG_TEXT.UNASSIGNED_SYRUP}`,
  );
  await page.getByTestId('cfg-free-sirup-kirsche-plus').click();
  await expect(page.getByTestId('cfg-free-sirup-kirsche')).toHaveValue('1');
  await expect(page.getByTestId('cfg-free-open')).toHaveCount(0);
  for (const slug of syrupSlugs) {
    await expect(page.getByTestId(`cfg-free-${slug}-plus`)).toBeDisabled();
  }
  // 25 Becher + 25 Strohhalme automatisch inklusive (einmal je Mietvorgang).
  await expect(page.getByTestId('cfg-included')).toContainText(
    '25 Becher und 25 Strohhalme sind inklusive – einmal je Mietvorgang.',
  );
  // Kommission mit Einheitspreis aus dem Katalog.
  const commission = page.getByTestId('cfg-commission');
  await expect(commission).toContainText(priceText(melon));
  await expect(commission).toContainText(priceText(cups));
  await expect(commission).toContainText(priceText(straws));
  await page.getByTestId('cfg-extra-sirup-wassermelone-plus').click();
  await page.getByTestId('cfg-extra-sirup-wassermelone-plus').click();
  await page.getByTestId('cfg-cups-plus').click();
  await page.getByTestId('cfg-straws-plus').click();
  await expect(page.getByTestId('cfg-extra-sirup-wassermelone')).toHaveValue('2');

  // Kanister: empfohlen, NICHT vorausgewählt, höchstens 2 je Behälter (1 Behälter ⇒ 2).
  const canisterBox = page.getByTestId('cfg-canister');
  await expect(canisterBox).toContainText('empfohlen');
  await expect(page.getByTestId('cfg-canisters')).toHaveValue('0');
  await expect(canisterBox).toContainText('höchstens 2 für deine Maschine');
  await expect(canisterBox).toContainText(priceText(canister));
  await page.getByTestId('cfg-canisters-plus').click();
  await page.getByTestId('cfg-canisters-plus').click();
  await expect(page.getByTestId('cfg-canisters')).toHaveValue('2');
  await expect(page.getByTestId('cfg-canisters-plus')).toBeDisabled();

  // Laufende Übersicht (Server): Kanister fest mit Summe, Kommission „je …“, Inklusive 25/25.
  const machine1x10 = machine('slush-1x10');
  await expect(page.getByTestId('cfg-fixed')).toContainText(euro(2 * canister.priceCents));
  await expect(page.getByTestId('cfg-fixed-total')).toContainText(
    euro(machine1x10.priceCents + 2 * canister.priceCents),
  );
  const commissionList = page.getByTestId('cfg-commission-list');
  await expect(commissionList).toContainText(`je ${euro(melon.priceCents)}`);
  await expect(commissionList).toContainText(`je ${euro(cups.priceCents)}`);
  await expect(commissionList).toContainText(`je ${euro(straws.priceCents)}`);
  await expect(commissionList).toContainText('Wassermelone');
  await expect(commissionList).toContainText('2 × 1-L-Flasche');
  await expect(commissionList).toContainText(
    'Kommission – Abrechnung nach tatsächlichem Verbrauch',
  );
  const included = page.getByTestId('cfg-included-list');
  await expect(included).toContainText('Becher');
  await expect(included).toContainText('Strohhalme');
  await expect(included).toContainText('25');
  await expect(included).toContainText('1 L');

  // Größere Maschine (2 Behälter) ⇒ 2 L gratis (1 L offen) und Kanister höchstens 4.
  await page.getByTestId('cfg-back').click();
  await expect(page.getByTestId('cfg-step-machine')).toBeVisible();
  await chooseMachine(page, 'slush-2x10');
  await nextStep(page, 'syrup');
  await expect(page.getByTestId('cfg-free-syrup')).toContainText('Inklusive: 2 L Sirup');
  await expect(page.getByTestId('cfg-free-open')).toHaveText(
    `Noch offen: 1 L – ${CFG_TEXT.UNASSIGNED_SYRUP}`,
  );
  await expect(page.getByTestId('cfg-canister')).toContainText('höchstens 4 für deine Maschine');
  await page.getByTestId('cfg-canisters-plus').click();
  await page.getByTestId('cfg-canisters-plus').click();
  await expect(page.getByTestId('cfg-canisters')).toHaveValue('4');
  await expect(page.getByTestId('cfg-canisters-plus')).toBeDisabled();
  await expect(page.getByTestId('cfg-included-list')).toContainText(CFG_TEXT.UNASSIGNED_SYRUP);

  // Der Server prüft unabhängig vom Browser: zu viele Kanister / zu viel Gratis-Sirup ⇒ Hinweis.
  previews.record(1);
  const overLimit = await page.request.post(`${WEB_ORIGIN}/api/public/configurator/preview`, {
    data: {
      machineSlug: 'slush-2x10',
      canisters: 5,
      syrups: { free: [{ slug: 'sirup-kirsche', liters: 3 }], extra: [] },
    },
  });
  expect(overLimit.status()).toBe(200);
  const overLimitBody = (await overLimit.json()) as {
    issues: { code: string }[];
    quota: { freeSyrupLiters: number; canisterMax: number };
  };
  expect(overLimitBody.quota).toMatchObject({ freeSyrupLiters: 2, canisterMax: 4 });
  expect(overLimitBody.issues.map((issue) => issue.code).sort()).toEqual([
    'CANISTER_LIMIT_EXCEEDED',
    'FREE_SYRUP_BUDGET_EXCEEDED',
  ]);

  await nextStep(page, 'fulfillment');
  await nextStep(page, 'contact');
  await fillPrivateContact(page, {
    firstName: 'Fiona',
    lastName: 'Sirup',
    email: `fiona.sirup@${DOMAIN}`,
  });
  await nextStep(page, 'summary');
  const syrupSummary = page.getByTestId('cfg-summary-syrup');
  await expect(syrupSummary).toContainText('Kirsche 1 L');
  await expect(syrupSummary).toContainText('Wassermelone 2 L');
  await expect(syrupSummary).toContainText('1 × 25 Becher');
  await expect(syrupSummary).toContainText('1 × 25 Strohhalme');
  await expect(syrupSummary).toContainText('4 Stück');
  await acknowledgePrivacy(page);
  await inquiries.reserve(1);
  const processNumber = await submitAndConfirm(page);

  expect(businessCounts().processes).toBe(before.processes + 1);
  const row = onlyRow(processNumber);
  expect(row.machine_slug).toBe('slush-2x10');
  expect(inquirySelections(row.inquiry_id)).toEqual([
    { slug: 'becher-25', role: 'extra', quantity: 1 },
    { slug: 'mischkanister-6l', role: 'extra', quantity: 4 },
    { slug: 'sirup-kirsche', role: 'free', quantity: 1 },
    { slug: 'sirup-wassermelone', role: 'extra', quantity: 2 },
    { slug: 'strohhalme-25', role: 'extra', quantity: 1 },
  ]);
  await page.context().close();
});

// ── G ─────────────────────────────────────────────────────────────────────

/** Kurzer, gültiger Durchlauf bis zur Zusammenfassung (Datenschutz bestätigt). */
async function readyToSubmit(page: Page, email: string): Promise<void> {
  await openConfigurator(page);
  await fillEvent(page, { date: berlinDayPlus(50), guests: 25, occasionLabel: 'Party' });
  await nextStep(page, 'machine');
  await chooseMachine(page, 'slush-1x8');
  await nextStep(page, 'syrup');
  await nextStep(page, 'fulfillment');
  await nextStep(page, 'contact');
  await fillPrivateContact(page, { firstName: 'Greta', lastName: 'Gleich', email });
  await nextStep(page, 'summary');
  await acknowledgePrivacy(page);
}

function mutationIdOf(body: string | null): string {
  const parsed = JSON.parse(body ?? '{}') as { clientMutationId?: string };
  return parsed.clientMutationId ?? '';
}

test('G1. Doppelklick auf „Unverbindliches Angebot anfordern“ ⇒ genau ein Vorgang; erneutes Senden desselben Payloads liefert dieselbe Vorgangsnummer', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await newVisitor(browser);
  await previews.reserve(12);
  await readyToSubmit(page, `greta.doppelklick@${DOMAIN}`);
  const bodies: (string | null)[] = [];
  page.on('request', (request) => {
    if (isInquiryPost(request)) bodies.push(request.postData());
  });
  const before = businessCounts();
  await inquiries.reserve(3);
  await page.getByTestId('cfg-submit').dblclick();
  const processNumber = await confirmedProcessNumber(page);

  expect(bodies.length, 'Anfrage-Requests beim Doppelklick').toBeGreaterThanOrEqual(1);
  expect(bodies.length).toBeLessThanOrEqual(2);
  const mutationId = mutationIdOf(bodies[0]!);
  expect(UUID.test(mutationId), 'clientMutationId ist eine UUID').toBe(true);
  expect(bodies.every((body) => mutationIdOf(body) === mutationId)).toBe(true);
  expect(businessCounts()).toEqual({
    processes: before.processes + 1,
    inquiries: before.inquiries + 1,
    customers: before.customers + 1,
    submissions: before.submissions + 1,
  });
  const row = onlyRow(processNumber);
  expect(row.client_mutation_id).toBe(mutationId);
  // Nach Erfolg ist die Idempotenz-ID gelöscht (sessionStorage hält nie Kontaktdaten).
  expect(await page.evaluate((key) => sessionStorage.getItem(key), MUTATION_ID_KEY)).toBeNull();

  // Wiederholung desselben Payloads (wie ein Browser-Retry) ⇒ 200, gleiche Nummer, nichts Neues.
  inquiries.record(1);
  const replay = await page.request.post(`${WEB_ORIGIN}/api/public/inquiries`, {
    data: JSON.parse(bodies[0]!) as unknown,
  });
  expect(replay.status()).toBe(200);
  expect(((await replay.json()) as { processNumber: string }).processNumber).toBe(processNumber);
  expect(businessCounts().processes).toBe(before.processes + 1);
  await page.context().close();
});

test('G2. Netzabbruch NACH der Serververarbeitung ⇒ Formular gesperrt, „Erneut senden“ mit identischem Payload ⇒ dieselbe Vorgangsnummer, weiterhin genau ein Vorgang', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const page = await newVisitor(browser);
  await previews.reserve(12);
  const email = `greta.netzabbruch@${DOMAIN}`;
  await readyToSubmit(page, email);
  const bodies: (string | null)[] = [];
  page.on('request', (request) => {
    if (isInquiryPost(request)) bodies.push(request.postData());
  });
  let serverStatus = 0;
  let serverNumber = '';
  // Der Request erreicht die API (route.fetch), die Antwort geht aber „im Netz verloren“.
  // `route.fetch` übernimmt nur die vorläufigen Header des Browsers; `Sec-Fetch-Site` setzt
  // Chromium erst im Netzwerkstack – es wird hier so ergänzt, wie der Browser es sendet
  // (Same-Origin-Fetch), damit der globale CSRF-Schutz den Originalrequest sieht.
  await page.route(
    '**/api/public/inquiries',
    async (route) => {
      const response = await route.fetch({
        headers: { ...route.request().headers(), 'sec-fetch-site': 'same-origin' },
      });
      serverStatus = response.status();
      serverNumber = ((await response.json()) as { processNumber?: string }).processNumber ?? '';
      await route.abort('connectionreset');
    },
    { times: 1 },
  );
  const before = businessCounts();
  await inquiries.reserve(2);
  await page.getByTestId('cfg-submit').click();

  const failure = page.getByTestId('cfg-error');
  await expect(failure).toContainText(CFG_TEXT.UNCERTAIN);
  await expect(page.getByTestId('cfg-retry')).toHaveText(CFG_TEXT.RETRY);
  expect(serverStatus, 'Server hat die erste Anfrage verarbeitet').toBe(201);
  expect(serverNumber).toMatch(/^MR-\d{4}-\d{4,}$/);
  expect(businessCounts().processes).toBe(before.processes + 1);
  // Unklarer Ausgang: Formular gesperrt, sessionStorage hält NUR die UUID (keine Kontaktdaten).
  await expect(page.getByTestId('cfg-submit')).toBeDisabled();
  await expect(page.getByTestId('cfg-privacy')).toBeDisabled();
  const stored = await page.evaluate((key) => {
    const values: string[] = [];
    for (const storage of [sessionStorage, localStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const name = storage.key(i) ?? '';
        values.push(`${name}=${storage.getItem(name) ?? ''}`);
      }
    }
    return { id: sessionStorage.getItem(key), all: values.join('\n') };
  }, MUTATION_ID_KEY);
  expect(UUID.test(stored.id ?? ''), 'Idempotenz-ID im sessionStorage').toBe(true);
  expect(stored.all.includes(email), 'E-Mail im Web Storage').toBe(false);
  expect(stored.all.includes('Greta'), 'Name im Web Storage').toBe(false);

  const retried = page.waitForResponse(
    (response) => isInquiryPost(response.request()) && response.request().method() === 'POST',
  );
  await page.getByTestId('cfg-retry').click();
  expect((await retried).status(), 'Wiederholung ⇒ 200 (bereits verarbeitet)').toBe(200);
  const processNumber = await confirmedProcessNumber(page);
  expect(processNumber).toBe(serverNumber);
  expect(bodies).toHaveLength(2);
  expect(bodies[1] === bodies[0], 'identischer Payload beim erneuten Senden').toBe(true);
  expect(mutationIdOf(bodies[0]!)).toBe(stored.id);

  expect(businessCounts()).toEqual({
    processes: before.processes + 1,
    inquiries: before.inquiries + 1,
    customers: before.customers + 1,
    submissions: before.submissions + 1,
  });
  const row = onlyRow(processNumber);
  expect(row.client_mutation_id).toBe(stored.id);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), MUTATION_ID_KEY)).toBeNull();
  await page.context().close();
});

// ── M ─────────────────────────────────────────────────────────────────────

test('M. Regression: Angebot aus der Website-Anfrage (C) ⇒ öffentlicher Angebotslink /angebot/[token] funktioniert (privat, noindex) inkl. Annahme; /kontakt/[token] bleibt noindex', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  expect(processC, 'Vorgang aus Szenario C').not.toBeNull();
  await staff.goto(`/vorgaenge/${processC!.process_id}/angebot`);
  await staff.getByRole('button', { name: 'Angebot erstellen (aus Anfrage)' }).click();
  await expect(staff.getByRole('heading', { name: /Version 1/ })).toBeVisible();
  await expect(
    staff.getByText(`Fester Angebotswert: ${euro(machine('slush-2x8').priceCents)}`),
  ).toBeVisible();
  await staff.getByRole('button', { name: 'Angebot versenden' }).click();
  const link = staff.getByTestId('public-offer-link');
  await expect(link).toBeVisible();
  const offerPath = (await link.innerText()).trim();
  expect(offerPath).toMatch(/^\/angebot\/[A-Za-z0-9_-]{20,}$/);

  const customer = await newVisitor(browser);
  const response = await customer.goto(`${WEB_ORIGIN}${offerPath}`, { timeout: 60_000 });
  expect(response?.status()).toBe(200);
  // Token-Seite: nie cachen/indexieren, kein Referer (next dev ersetzt Cache-Control ggf. durch no-cache).
  const headers = response?.headers() ?? {};
  expect(headers['x-robots-tag']).toContain('noindex');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['cache-control']).toMatch(/no-store|no-cache/);
  await expect(customer.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(customer.getByRole('heading', { name: 'Miet-Royal-Angebot' })).toBeVisible();
  await expect(customer.getByRole('heading', { name: 'Positionen' })).toBeVisible();
  await expect(customer.getByTestId('site-frame')).toHaveCount(0);
  await customer.getByRole('button', { name: 'Angebot verbindlich annehmen' }).click();
  await expect(customer.getByRole('heading', { name: 'Vielen Dank!' })).toBeVisible();
  const booking = mainDb<{ n: number }>(
    'SELECT count(*)::int AS n FROM bookings WHERE process_id = $1',
    [processC!.process_id],
  );
  expect(booking[0]!.n).toBe(1);

  // /kontakt/[token]: Token-Header unverändert (noindex, no-store, no-referrer), neutrale Seite.
  const contactToken = await customer.goto(`${WEB_ORIGIN}/kontakt/${'Q'.repeat(43)}`, {
    timeout: 60_000,
  });
  const contactHeaders = contactToken?.headers() ?? {};
  expect(contactHeaders['x-robots-tag']).toContain('noindex');
  expect(contactHeaders['referrer-policy']).toBe('no-referrer');
  expect(contactHeaders['cache-control']).toMatch(/no-store|no-cache/);
  await expect(customer.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(customer.getByTestId('site-frame')).toHaveCount(0);
  // Die neue Website-Seite /kontakt bekommt KEINE Token-Header (eigene CMS-Seite).
  const contactPage = await customer.goto(`${WEB_ORIGIN}/kontakt`, { timeout: 60_000 });
  expect(contactPage?.status()).toBe(200);
  expect(contactPage?.headers()['x-robots-tag']).toBeUndefined();
  await expect(customer.getByTestId('site-frame')).toBeVisible();
  await customer.context().close();
});

// ── L ─────────────────────────────────────────────────────────────────────

test('L. Regression: Kundenportal-Login über den Magic Link (/konto) und Anzeige der aktiven Buchung funktionieren weiterhin – ohne Website-Rahmen', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const lena = { firstName: 'Lena', lastName: 'Langzeit', email: `lena.portal@${DOMAIN}` };
  const portal = seedPortal({
    adminEmail: ADMIN_EMAIL,
    customers: [{ key: 'lena', ...lena }],
    bookings: [{ key: 'lena', customer: 'lena', eventInDays: 30 }],
  });
  const booked = portal.bookings.lena;
  expect(booked, 'Seed-Buchung').toBeDefined();
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page.goto(`${WEB_ORIGIN}/konto`, { timeout: 60_000 });
  expect(response?.headers()['x-robots-tag']).toContain('noindex');
  await page.waitForURL(`${WEB_ORIGIN}/konto/anmelden`);
  await expect(page.getByTestId('site-frame')).toHaveCount(0);

  await loginViaMagicLink(page, lena.email, { runJobs: () => runDueJobsViaApi(staff) });
  await page.waitForURL(`${WEB_ORIGIN}/konto/buchung/${booked!.bookingId}`);
  await expect(page.getByTestId('portal-booking-view')).toBeVisible();
  await expect(page.getByTestId('portal-process-number')).toHaveText(booked!.processNumber);
  await expect(page.getByTestId('portal-state-label')).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('portal-event-date')).toHaveText(germanDate(booked!.eventDate));
  await expect(page.getByTestId('site-frame')).toHaveCount(0);
  await context.close();
});
