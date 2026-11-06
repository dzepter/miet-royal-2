import { execFileSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';
import { queryDatabase } from './communication-ops.ts';
import { DEMO_DATABASE_URL } from './demo-env.ts';
import { ADMIN_EMAIL, TEST_DATABASE_URL } from './seed.ts';

/**
 * Phase 16 (E2E): Helfer der Website-/CMS-/Konfigurator-Szenarien A–M
 * (website-flow.spec.ts und website-cms.spec.ts im Projekt `chromium`,
 * website-demo.spec.ts im Projekt `demo-communication`).
 *
 * - Inhalte: Kindprozess apps/api/scripts/e2e-website-seed.ts – echter CMS-Bootstrap
 *   (`runCmsBootstrap` mit den redaktionellen Standard-Einträgen, `publishDemo`), dazu für
 *   Szenario I zwei Mitarbeiter „nur cms.edit“ / „nur cms.publish“. Der Basis-Seed leert
 *   `staff_users … CASCADE` und damit alle CMS-Tabellen ⇒ jede Spec seedet in `beforeAll` neu.
 * - Rate-Limits der E2E-APIs sind aktiv (alle Browser-Requests kommen von 127.0.0.1):
 *   `POST /public/inquiries` 5/min + 20/h, `POST /public/configurator/preview` 60/min. Die
 *   Specs zählen ihre eigenen Requests (`RateWindow`) und warten VOR einem Absenden bzw. einem
 *   Konfigurator-Durchlauf nur dann, wenn das Minutenfenster sonst überliefe – ein 429 wäre
 *   gewolltes Produktverhalten, kein Fehler, und darf die Prüfungen nicht verfälschen.
 * - Datenbankzugriffe nur lesend (Zählungen/Zuordnungen), nie PII oder Tokens in Logs.
 */

const REPO_ROOT = `${import.meta.dirname}/../../..`;

export const WEB_ORIGIN = 'http://127.0.0.1:3100';
export const API_ORIGIN = 'http://127.0.0.1:3101';

/** Öffentlicher Abholbereich und synthetische exakte Abholadresse des Basis-Seeds (e2e-seed.ts). */
export const PICKUP_AREA = 'Mainz-Hechtsheim';
export const EXACT_PICKUP_FRAGMENTS = ['Teststraße 1', '55129'] as const;

/** Kundentexte des Konfigurators (apps/web/lib/configurator.ts CONFIGURATOR_TEXT) – 1:1. */
export const CFG_TEXT = {
  RECOMMENDATION_FALLBACK:
    'Wir prüfen persönlich, welche Maschine am besten zu deinem Event passt.',
  DELIVERY_NOTE: 'Lieferung wird individuell geprüft.',
  PICKUP_ADDRESS_NOTE: 'Die genaue Abholadresse teilen wir dir rechtzeitig mit.',
  UNASSIGNED_SYRUP: 'Sorte später abstimmen',
  PRIVACY_LABEL: 'Ich habe die Datenschutzhinweise zur Kenntnis genommen.',
  SUBMIT: 'Unverbindliches Angebot anfordern',
  RETRY: 'Erneut senden',
  UNCERTAIN:
    'Wir konnten nicht sicher feststellen, ob deine Anfrage angekommen ist. Sende sie bitte erneut – sie wird dabei nicht doppelt angelegt.',
  /** Lieferhinweis der Preview (apps/api/src/public/configurator.ts DELIVERY_PREVIEW_TEXT). */
  DELIVERY_PREVIEW: 'Lieferung wird individuell geprüft und angeboten.',
  /** Preis-Hinweis (Order §13). */
  PRICE_NOTE:
    'Die Übersicht basiert auf den aktuell hinterlegten Preisen. Verbindlich wird der Preis erst mit deinem schriftlichen Angebot.',
} as const;

/** Vorgegebene Hauptnavigation (Order §3). */
export const MAIN_NAV_LABELS = [
  'Start',
  'Slush',
  'Ablauf',
  'FAQ',
  'Über uns',
  'Kontakt',
  'Kundenbereich',
] as const;

// ── Seed (Kindprozess) ───────────────────────────────────────────────────

export interface WebsiteSeedUser {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  roleName: string;
  permissionKeys: string[];
}

/** Szenario I: synthetische Mitarbeiter mit genau EINEM CMS-Recht. */
export const CMS_EDITOR: WebsiteSeedUser = {
  firstName: 'Edda',
  lastName: 'Entwurf',
  email: 'cms.redaktion@e2e.example',
  password: 'e2e-cms-redaktion-passwort-1',
  roleName: 'E2E-Website-Redaktion',
  permissionKeys: ['cms.edit'],
};
export const CMS_PUBLISHER: WebsiteSeedUser = {
  firstName: 'Paul',
  lastName: 'Freigabe',
  email: 'cms.freigabe@e2e.example',
  password: 'e2e-cms-freigabe-passwort-1',
  roleName: 'E2E-Website-Freigabe',
  permissionKeys: ['cms.publish'],
};

export interface WebsiteSeedEntry {
  id: string;
  kind: 'site_settings' | 'page';
  pageType: string | null;
  path: string | null;
  isPublished: boolean;
}

export interface WebsiteSeedResult {
  created: number;
  skipped: number;
  published: number;
  invalid: unknown[];
  publishFailed: unknown[];
  entries: WebsiteSeedEntry[];
  users: Record<string, string>;
}

/**
 * CMS-Bootstrap (+ Veröffentlichung aller Standard-Einträge) gegen die Haupt- oder die
 * Demo-Datenbank. Der Kindprozess lädt die Konfiguration als development (nur DATABASE_URL
 * wird gebraucht); der Bootstrap selbst bekommt `appEnv` explizit (`demo` für die Demo-DB).
 */
export function seedWebsite(target: 'main' | 'demo' = 'main'): WebsiteSeedResult {
  const output = execFileSync(
    'pnpm',
    ['--filter', '@mietroyal/api', 'exec', 'tsx', 'scripts/e2e-website-seed.ts'],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
      env: {
        ...process.env,
        APP_ENV: 'development',
        DATABASE_URL: target === 'demo' ? DEMO_DATABASE_URL : TEST_DATABASE_URL,
        LOG_LEVEL: 'error',
        E2E_WEBSITE_TARGET: target,
        E2E_WEBSITE_ADMIN_EMAIL: ADMIN_EMAIL,
        E2E_WEBSITE_USERS: JSON.stringify(target === 'main' ? [CMS_EDITOR, CMS_PUBLISHER] : []),
      },
    },
  );
  const lines = output.toString('utf8').trim().split('\n');
  const result = JSON.parse(lines[lines.length - 1] ?? '{}') as WebsiteSeedResult;
  expect(result.invalid, 'ungültige Bootstrap-Einträge').toEqual([]);
  expect(result.publishFailed, 'nicht veröffentlichte Bootstrap-Einträge').toEqual([]);
  const unpublished = result.entries.filter((entry) => !entry.isPublished);
  expect(unpublished, 'alle Standard-Einträge veröffentlicht').toEqual([]);
  return result;
}

export function entryIdOf(seed: WebsiteSeedResult, path: string): string {
  const entry = seed.entries.find((candidate) => candidate.path === path);
  expect(entry, `CMS-Eintrag ${path}`).toBeDefined();
  return entry!.id;
}

/** Veröffentlichte Seitenpfade (ohne Website-Einstellungen). */
export function publishedPaths(seed: WebsiteSeedResult): string[] {
  return seed.entries
    .filter((entry) => entry.kind === 'page' && entry.isPublished && entry.path !== null)
    .map((entry) => entry.path!);
}

// ── Datenbank (nur lesen) ────────────────────────────────────────────────

export function mainDb<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return queryDatabase<T>(TEST_DATABASE_URL, sql, params);
}

export function websiteDemoDb<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): T[] {
  return queryDatabase<T>(DEMO_DATABASE_URL, sql, params);
}

export interface BusinessCounts {
  processes: number;
  inquiries: number;
  customers: number;
  submissions: number;
}

export function businessCounts(
  query: <T>(sql: string, params?: unknown[]) => T[] = mainDb,
): BusinessCounts {
  return query<BusinessCounts>(
    `SELECT (SELECT count(*)::int FROM processes) AS processes,
            (SELECT count(*)::int FROM inquiries) AS inquiries,
            (SELECT count(*)::int FROM customers) AS customers,
            (SELECT count(*)::int FROM public_inquiry_submissions) AS submissions`,
  )[0]!;
}

export interface WebsiteProcessRow {
  process_id: string;
  process_number: string;
  source: string;
  process_created_by: string | null;
  customer_id: string;
  inquiry_id: string;
  inquiry_created_by: string | null;
  event_date: string;
  guest_count: number;
  occasion: string;
  machine_slug: string;
  fulfillment: string;
  delivery_street: string | null;
  delivery_postal_code: string | null;
  delivery_city: string | null;
  /** Lieferfenster als „YYYY-MM-DD HH:MI“ in Europe/Berlin. */
  delivery_window_from: string | null;
  delivery_window_to: string | null;
  customer_email: string | null;
  customer_match: string;
  client_mutation_id: string;
  privacy_revision_id: string;
  privacy_path: string | null;
  privacy_is_published: boolean;
}

/** Vorgang + Anfrage + Website-Submission zu einer Vorgangsnummer (genau eine Zeile erwartet). */
export function websiteProcessByNumber(
  processNumber: string,
  query: <T>(sql: string, params?: unknown[]) => T[] = mainDb,
): WebsiteProcessRow[] {
  return query<WebsiteProcessRow>(
    `SELECT p.id AS process_id, p.process_number, p.source::text AS source,
            p.created_by AS process_created_by, p.customer_id,
            i.id AS inquiry_id, i.created_by AS inquiry_created_by,
            to_char(i.event_date, 'YYYY-MM-DD') AS event_date, i.guest_count,
            i.occasion::text AS occasion, pr.slug AS machine_slug,
            i.fulfillment::text AS fulfillment, i.delivery_street, i.delivery_postal_code,
            i.delivery_city,
            to_char(i.delivery_window_from AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') AS delivery_window_from,
            to_char(i.delivery_window_to AT TIME ZONE 'Europe/Berlin', 'YYYY-MM-DD HH24:MI') AS delivery_window_to,
            c.email AS customer_email,
            s.customer_match::text AS customer_match, s.client_mutation_id::text AS client_mutation_id,
            s.privacy_revision_id, e.path AS privacy_path,
            (e.published_revision_id = s.privacy_revision_id) AS privacy_is_published
       FROM processes p
       JOIN customers c ON c.id = p.customer_id
       JOIN inquiries i ON i.process_id = p.id
       JOIN products pr ON pr.id = i.machine_product_id
       JOIN public_inquiry_submissions s ON s.process_id = p.id
       JOIN cms_revisions r ON r.id = s.privacy_revision_id
       JOIN cms_entries e ON e.id = r.entry_id
      WHERE p.process_number = $1`,
    [processNumber],
  );
}

export interface SelectionRow {
  slug: string;
  role: string;
  quantity: number;
}

export function inquirySelections(
  inquiryId: string,
  query: <T>(sql: string, params?: unknown[]) => T[] = mainDb,
): SelectionRow[] {
  return query<SelectionRow>(
    `SELECT pr.slug, s.role::text AS role, s.quantity
       FROM inquiry_selections s JOIN products pr ON pr.id = s.product_id
      WHERE s.inquiry_id = $1 ORDER BY pr.slug, s.role`,
    [inquiryId],
  );
}

// ── Katalog (direkt an der API, ohne IP-Limit) ───────────────────────────

export interface CatalogProduct {
  slug: string;
  name: string;
  category: string;
  priceCents: number;
  billingMode: 'fixed' | 'commission';
  unitLabel: string;
}
export interface CatalogMachine extends CatalogProduct {
  containerCount: number;
  containerVolumeLiters: number;
}
export interface PublicCatalogDto {
  machines: CatalogMachine[];
  syrups: CatalogProduct[];
  accessories: CatalogProduct[];
  canister: (CatalogProduct & { maxPerContainer: number }) | null;
  included: {
    freeSyrupLitersPerContainer: number;
    cupsPerProcess: number;
    strawsPerProcess: number;
  };
  pickupArea: string;
  largeEventGuestThreshold: number;
  priceNote: string;
}

export async function fetchCatalog(apiOrigin = API_ORIGIN): Promise<PublicCatalogDto> {
  const response = await fetch(`${apiOrigin}/public/configurator/catalog`, {
    headers: { connection: 'close', accept: 'application/json' },
  });
  expect(response.status, 'GET /public/configurator/catalog').toBe(200);
  return (await response.json()) as PublicCatalogDto;
}

/** Betrag wie die Website (`formatPriceCents` ⇒ `euro`): „1.234,56 €“. */
export function euro(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}${whole},${String(abs % 100).padStart(2, '0')} €`;
}

/** Preiszeile wie `productPriceText` der Website – nur aus Katalogwerten. */
export function priceText(product: CatalogProduct): string {
  const price = euro(product.priceCents);
  if (product.category === 'machine') return `Mietpreis ${price}`;
  const unit = product.unitLabel.trim() === '' ? '' : ` je ${product.unitLabel.trim()}`;
  return product.billingMode === 'commission'
    ? `${price}${unit} · auf Kommission`
    : `${price}${unit} · Kaufartikel`;
}

// ── Rate-Limit-Budget (eigene Requests zählen, nur bei Bedarf warten) ────

/** Wartezeit dem laufenden Test bzw. Hook gutschreiben (wie helpers/staff-login.ts). */
function creditTimeout(waitMs: number): void {
  const info = test.info();
  if (info.timeout > 0) info.setTimeout(info.timeout + waitMs);
}

/**
 * Gleitendes Fenster über die eigenen Requests einer Route (alle Browserkontexte, die mit
 * `attach` angemeldet sind). `reserve(n)` wartet – nur wenn nötig – bis n weitere Requests
 * in das Fenster passen. Die API zählt je IP (alle Tests: 127.0.0.1); das Fenster ist mit
 * einer Reserve unter dem Produktlimit gewählt.
 */
export class RateWindow {
  private stamps: number[] = [];

  constructor(
    private readonly label: string,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly matches: (request: Request) => boolean,
  ) {}

  attach(context: BrowserContext): void {
    context.on('request', (request) => {
      if (this.matches(request)) this.stamps.push(Date.now());
    });
  }

  /** Requests ohne Browser (z. B. `page.request`) manuell zählen. */
  record(count = 1): void {
    for (let i = 0; i < count; i += 1) this.stamps.push(Date.now());
  }

  count(): number {
    const now = Date.now();
    this.stamps = this.stamps.filter((stamp) => now - stamp < this.windowMs);
    return this.stamps.length;
  }

  async reserve(needed: number): Promise<void> {
    const current = this.count();
    const excess = current + needed - this.limit;
    if (excess <= 0) return;
    const oldestBlocking = this.stamps[excess - 1] ?? Date.now();
    const waitMs = Math.max(0, oldestBlocking + this.windowMs + 1_500 - Date.now());
    console.warn(
      `[rate-window] ${this.label}: warte ${waitMs} ms (Fenster ${current}/${this.limit})`,
    );
    creditTimeout(waitMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

const isPost = (request: Request, pathname: string) =>
  request.method() === 'POST' && new URL(request.url()).pathname === pathname;

/** `POST /public/inquiries`: Produktlimit 5/min ⇒ höchstens 4 je Minute aus den Specs. */
export function inquiryWindow(): RateWindow {
  return new RateWindow('Anfragen', 4, 60_000, (request) =>
    isPost(request, '/api/public/inquiries'),
  );
}

/** `POST /public/configurator/preview`: Produktlimit 60/min ⇒ höchstens 45 je Minute. */
export function previewWindow(): RateWindow {
  return new RateWindow('Konfigurator-Übersicht', 45, 60_000, (request) =>
    isPost(request, '/api/public/configurator/preview'),
  );
}

// ── Konfigurator (data-testids aus apps/web/components/configurator) ─────

export interface EventInput {
  date: string;
  guests: number;
  occasionLabel?: string;
  startTime?: string;
  endTime?: string;
}

/**
 * Konfigurator öffnen und auf die HYDRATISIERTE Client-Komponente warten: der Wizard ist
 * serverseitig vorgerendert; Eingaben vor der Hydration gingen verloren (kontrollierte
 * Felder). Erst nach der Hydration läuft der Effekt der laufenden Übersicht (Debounce 350 ms) –
 * deren erste Antwort ist das Signal „bedienbar“.
 */
export async function openConfigurator(page: Page, origin = WEB_ORIGIN, query = ''): Promise<void> {
  const firstPreview = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/public/configurator/preview',
    { timeout: 60_000 },
  );
  await page.goto(`${origin}/konfigurator${query}`, { timeout: 60_000 });
  await expect(page.getByTestId('configurator')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('cfg-step-event')).toBeVisible();
  await firstPreview;
}

export async function nextStep(page: Page, expected: string): Promise<void> {
  await page.getByTestId('cfg-next').click();
  await expect(page.getByTestId(`cfg-step-${expected}`)).toBeVisible();
}

export async function fillEvent(page: Page, input: EventInput): Promise<void> {
  await page.getByTestId('cfg-date').fill(input.date);
  if (input.startTime !== undefined) await page.getByTestId('cfg-start-time').fill(input.startTime);
  if (input.endTime !== undefined) await page.getByTestId('cfg-end-time').fill(input.endTime);
  await page.getByTestId('cfg-guests').fill(String(input.guests));
  await page
    .getByTestId('cfg-occasion')
    .selectOption({ label: input.occasionLabel ?? 'Geburtstag' });
}

export async function chooseMachine(page: Page, slug: string): Promise<void> {
  await page.getByTestId(`cfg-machine-${slug}`).click();
  await expect(
    page.getByTestId(`cfg-machine-${slug}`).locator('input[type="radio"]'),
  ).toBeChecked();
}

export interface ContactInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
}

export async function fillPrivateContact(page: Page, contact: ContactInput): Promise<void> {
  await page.getByTestId('cfg-contact-private').click();
  await page.getByTestId('cfg-firstName').fill(contact.firstName);
  await page.getByTestId('cfg-lastName').fill(contact.lastName);
  await page.getByTestId('cfg-email').fill(contact.email);
  if (contact.phone !== undefined) await page.getByTestId('cfg-phone').fill(contact.phone);
}

/** Zusammenfassung: Datenschutz-Checkbox setzen; Absende-Knopf mit dem Pflichttext. */
export async function acknowledgePrivacy(page: Page): Promise<void> {
  await expect(page.getByTestId('cfg-privacy-label')).toContainText(CFG_TEXT.PRIVACY_LABEL);
  await expect(page.getByTestId('cfg-privacy-unavailable')).toHaveCount(0);
  await page.getByTestId('cfg-privacy').check();
  await expect(page.getByTestId('cfg-submit')).toHaveText(CFG_TEXT.SUBMIT);
  await expect(page.getByTestId('cfg-submit')).toBeEnabled();
}

/** Absenden und Bestätigung mit Vorgangsnummer abwarten. */
export async function submitAndConfirm(page: Page): Promise<string> {
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/public/inquiries',
  );
  await page.getByTestId('cfg-submit').click();
  const response = await answered;
  expect(response.status(), 'POST /api/public/inquiries').toBe(201);
  return confirmedProcessNumber(page);
}

export async function confirmedProcessNumber(page: Page): Promise<string> {
  await expect(page.getByTestId('cfg-confirmation')).toBeVisible({ timeout: 30_000 });
  const number = (await page.getByTestId('cfg-process-number').innerText()).trim();
  expect(number).toMatch(/^MR-\d{4}-\d{4,}$/);
  await expect(page.getByTestId('cfg-confirmation')).toContainText('unverbindlich');
  return number;
}

/** Sichtbarer Text der Seite enthält keine exakte Abholadresse (Order §5). */
export async function expectNoExactPickupAddress(page: Page, label: string): Promise<void> {
  const html = await page.content();
  for (const fragment of EXACT_PICKUP_FRAGMENTS) {
    expect(html.includes(fragment), `${label}: exakte Abholadresse (${fragment})`).toBe(false);
  }
}

// ── Testbild (echtes PNG, im Test erzeugt – kein Fremd-/Stockbild) ───────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Abstraktes Testmuster (Farbverlauf in den Markenfarben Creme/Bronze) als echtes RGB-PNG –
 * erzeugt im Test, zeigt nichts Reales.
 */
export function generateTestPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // Bit-Tiefe
  header[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const t = (x + y) / (width + height);
      row[1 + x * 3] = Math.round(255 - t * (255 - 123));
      row[2 + x * 3] = Math.round(252 - t * (252 - 84));
      row[3 + x * 3] = Math.round(242 - t * (242 - 38));
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Verbotene Inhalte (Order §2/§3/§5, kein Fake-Content) ────────────────

/** Muster, die auf der öffentlichen Website nie vorkommen dürfen. */
export const FORBIDDEN_PUBLIC_TEXT: readonly RegExp[] = [
  /verbindlich buchen/i,
  /jetzt buchen/i,
  /becher pro stunde/i,
  /zufriedene kunden/i,
  /\b\d[\d.]*\s*\+\s*(events|kunden|veranstaltungen|bewertungen)/i,
  /★/,
  /google/i,
  /whatsapp/i,
];

export async function expectNoForbiddenPublicText(page: Page, label: string): Promise<void> {
  const text = await page.locator('body').innerText();
  for (const pattern of FORBIDDEN_PUBLIC_TEXT) {
    expect(pattern.test(text), `${label}: verbotener Inhalt ${pattern}`).toBe(false);
  }
}
