/**
 * Phase-5-E2E-Szenarien A–H (Order §58):
 * A Maschinenliste (11 Maschinen) → Detail mit Status/Standort.
 * B Sperre setzen → Verfügbarkeitswarnung → Sperre aufheben.
 * C QR anzeigen → Identifier auflösen → richtige Maschine; unberechtigter
 *   Benutzer erhält keinen Zugriff.
 * D Kapazität: zwei überlappende 2×8-Buchungen (1 physische Maschine) →
 *   Warnung am Termin → blockiert nichts → Konflikt lösen → Maschinenlage
 *   ändern → Konflikt wird neu bewertet.
 * E Lager ohne erfundenen Bestand → Anfangsbestand erfassen → sichtbar.
 * F Wareneingang +Menge → Bestand exakt → Bewegung sichtbar.
 * G Inventur mit Differenz → Freigabe erforderlich → korrigieren →
 *   freigeben → Bestand exakt, genau eine Bewegung.
 * H Mindestbestand → Warnung → Wareneingang → Warnung verschwindet.
 * Ausschließlich synthetische Testdaten.
 */
import { expect, test, type Page } from '@playwright/test';

const ADMIN_EMAIL = 'admin@e2e.example';
const ADMIN_PASSWORD = 'e2e-admin-passwort-1';
const SELLER_EMAIL = 'verkauf@e2e.example';
const SELLER_PASSWORD = 'e2e-verkauf-passwort-1';
const WEB_ORIGIN = 'http://127.0.0.1:3100';

test.describe.configure({ mode: 'serial' });

let staff: Page; // Erika (Admin)
let viktor: Page; // Viktor (Verkauf – KEIN machine.view)
let customerPage: Page;
let qrToken = '';
let machineId = '';
let capacityProcessId = '';

test.beforeAll(async ({ browser }) => {
  staff = await browser.newPage();
  viktor = await browser.newPage();
  customerPage = await browser.newPage();
});
test.afterAll(async () => {
  await staff.close();
  await viktor.close();
  await customerPage.close();
});

async function login(page: Page, email: string, password: string, firstName: string) {
  await page.goto('/login');
  await page.getByLabel('E-Mail').fill(email);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Heute' })).toBeVisible();
  await expect(page.getByText(new RegExp(`Willkommen, ${firstName}`))).toBeVisible();
}

const pad = (value: number) => String(value).padStart(2, '0');

function berlinTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function berlinDayPlus(days: number): string {
  const [y, m, d] = berlinTodayIso().split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

function fillAt(dayIso: string, hour: number, minute = 0): string {
  return `${dayIso}T${pad(hour)}:${pad(minute)}`;
}

/** Kunde + Vorgang + 2×8-Anfrage + Angebot + Online-Annahme (echte Wege). */
async function acceptedBooking2x8(firstName: string, lastName: string, email: string) {
  await staff.getByRole('link', { name: 'Kunden', exact: true }).click();
  await staff.getByRole('button', { name: 'Kunde anlegen' }).click();
  await staff.getByLabel('Vorname').fill(firstName);
  await staff.getByLabel('Nachname').fill(lastName);
  await staff.getByLabel('E-Mail (optional)').fill(email);
  await staff.getByRole('button', { name: 'Kunde anlegen' }).click();
  await expect(staff.getByRole('heading', { name: `${firstName} ${lastName}` })).toBeVisible();
  await staff.getByRole('button', { name: 'Vorgang anlegen' }).click();
  await expect(staff.getByRole('heading', { name: /^MR-\d{4}-\d{4,}$/ })).toBeVisible();
  const processId = /\/vorgaenge\/([0-9a-f-]{36})/.exec(staff.url())![1]!;

  await staff.goto(`/vorgaenge/${processId}/anfrage`);
  const eventDate = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString().slice(0, 10);
  await staff.getByLabel('Eventdatum').fill(eventDate);
  await staff.getByLabel('Gästezahl (exakt)').fill('30');
  await staff.getByLabel('Anlass').selectOption({ label: 'Geburtstag' });
  await staff.getByLabel('Gewünschter Maschinentyp').selectOption({ label: '2×8 L' });
  await staff.getByRole('button', { name: 'Anfrage speichern' }).click();
  await expect(staff.getByText('Anfrage gespeichert.')).toBeVisible();

  await staff.goto(`/vorgaenge/${processId}/angebot`);
  await staff.getByRole('button', { name: 'Angebot erstellen (aus Anfrage)' }).click();
  await expect(staff.getByRole('heading', { name: /Version 1/ })).toBeVisible();
  await staff.getByRole('button', { name: 'Angebot versenden' }).click();
  const link = staff.getByTestId('public-offer-link');
  await expect(link).toBeVisible();
  const path = (await link.innerText()).trim();

  await customerPage.goto(`${WEB_ORIGIN}${path}`);
  await customerPage.getByRole('button', { name: 'Angebot verbindlich annehmen' }).click();
  await expect(customerPage.getByRole('heading', { name: 'Vielen Dank!' })).toBeVisible();
  return processId;
}

/** Terminzeit im Terminplanungs-Preview setzen (Berlin-Wanduhrzeit). */
async function setTime(row: 'Abholung / Ausgabe' | 'Rückgabe', start: string) {
  await staff.locator('.entry-row', { hasText: row }).click();
  const card = staff.getByTestId('appointment-preview');
  await card.getByLabel('Beginn').fill(start);
  await card.getByLabel('Ende (optional, Zeitfenster)').fill('');
  staff.once('dialog', (dialog) => void dialog.accept());
  await card.getByRole('button', { name: 'Zeit speichern' }).click();
  const timeLabel = `${start.slice(11)} Uhr`;
  await expect(staff.locator('.entry-row', { hasText: row }).getByText(timeLabel)).toBeVisible();
  await card.getByLabel('Vorschau schließen').click();
}

// ── Szenario A: Maschinenliste & Detail ──────────────────────────────────

test('A: Maschinenliste zeigt die 11 Maschinen; Detail zeigt Status und Standort', async () => {
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await staff.getByRole('link', { name: 'Maschinen & Lager' }).click();
  await expect(staff.getByRole('heading', { name: 'Maschinen' })).toBeVisible();
  await expect(staff.getByText('11 Maschinen')).toBeVisible();
  await expect(staff.getByTestId('machine-MR-08-02-01')).toBeVisible();
  await expect(staff.getByTestId('machine-MR-10-01-06')).toBeVisible();

  await staff.getByRole('link', { name: 'MR-10-01-01' }).click();
  await expect(staff.getByRole('heading', { name: 'MR-10-01-01' })).toBeVisible();
  machineId = /\/maschinen\/([0-9a-f-]{36})/.exec(staff.url())![1]!;
  await expect(staff.locator('.badge', { hasText: 'Einsatzbereit' })).toBeVisible();
  await expect(staff.getByText(/Standort: Lager/)).toBeVisible();
  await expect(staff.getByText('Kaufdatum: unbekannt')).toBeVisible();
  await expect(staff.getByText('Gewicht: unbekannt')).toBeVisible();
});

// ── Szenario B: Sperre → Warnung → Aufheben ──────────────────────────────

test('B: Sperre setzen → Verfügbarkeitswarnung sichtbar → Sperre aufheben', async () => {
  await staff.getByLabel('Sperre von').fill(fillAt(berlinDayPlus(1), 8));
  await staff.getByLabel('Sperre bis').fill(fillAt(berlinDayPlus(2), 18));
  await staff.getByLabel('Grund (Pflicht)').fill('Interne Nutzung (E2E)');
  await staff.getByRole('button', { name: 'Sperre setzen' }).click();
  await expect(staff.getByText('Sperre angelegt.')).toBeVisible();
  await expect(staff.getByText(/Grund: Interne Nutzung \(E2E\)/)).toBeVisible();

  // Verfügbarkeitshinweis am Maschinendetail (nächste 14 Tage).
  await staff.reload();
  await expect(staff.getByTestId('availability-warning')).toBeVisible();
  await expect(staff.getByTestId('availability-warning')).toContainText('MR-10-01-01: Gesperrt');

  await staff.getByRole('button', { name: 'Sperre aufheben' }).click();
  await expect(staff.getByText('Keine aktiven oder zukünftigen Sperren.')).toBeVisible();
  await staff.reload();
  await expect(staff.getByTestId('availability-warning')).toHaveCount(0);
});

// ── Szenario C: QR ───────────────────────────────────────────────────────

test('C: QR anzeigen und auflösen; unberechtigter Benutzer erhält keinen Zugriff', async () => {
  await expect(staff.getByRole('heading', { name: 'QR-Code' })).toBeVisible();
  qrToken = (await staff.getByTestId('qr-token').innerText()).trim();
  expect(qrToken).toMatch(/^[0-9a-f]{48,128}$/);
  // Basis-URL ist im E2E-Seed konfiguriert → druckbarer QR vorhanden.
  await expect(staff.getByAltText('QR-Code MR-10-01-01')).toBeVisible();

  // Auflösen über den QR-Einstieg: richtige Maschine öffnet sich.
  await staff.goto(`/qr/${qrToken}`);
  await expect(staff.getByRole('heading', { name: 'MR-10-01-01' })).toBeVisible();
  expect(staff.url()).toContain(`/maschinen/${machineId}`);

  // Unberechtigter Benutzer (kein machine.view): neutrale Ablehnung.
  await login(viktor, SELLER_EMAIL, SELLER_PASSWORD, 'Viktor');
  await expect(viktor.getByRole('link', { name: 'Maschinen & Lager' })).toHaveCount(0);
  await viktor.goto(`/qr/${qrToken}`);
  await expect(viktor.getByRole('heading', { name: 'QR-Code nicht gültig' })).toBeVisible();
  await expect(viktor.getByText('MR-10-01-01')).toHaveCount(0);
});

// ── Szenario D: Kapazitätswarnung im Terminbereich ───────────────────────

test('D: Überlappende Buchungen eines knappen Typs erzeugen eine lösbare Kapazitätswarnung', async () => {
  test.setTimeout(180_000);
  // Zwei bestätigte 2×8-Buchungen (nur 1 physische Maschine vorhanden).
  capacityProcessId = await acceptedBooking2x8('Kai', 'Kapazitaet', 'kai@e2e.example');
  const secondProcessId = await acceptedBooking2x8('Karla', 'Knapp', 'karla@e2e.example');

  // Mietzeiträume überlappend planen: [+1d..+3d] und [+2d..+4d].
  await staff.goto(`/vorgaenge/${capacityProcessId}/termine`);
  await setTime('Abholung / Ausgabe', fillAt(berlinDayPlus(1), 9));
  await setTime('Rückgabe', fillAt(berlinDayPlus(3), 11));
  await staff.goto(`/vorgaenge/${secondProcessId}/termine`);
  await setTime('Abholung / Ausgabe', fillAt(berlinDayPlus(2), 9));
  await setTime('Rückgabe', fillAt(berlinDayPlus(4), 11));

  // Warnung erscheint am Termin (rotes Warnsymbol, normale Farbe bleibt).
  await staff.goto(`/vorgaenge/${capacityProcessId}/termine`);
  await staff.locator('.entry-row', { hasText: 'Abholung / Ausgabe' }).click();
  const preview = staff.getByTestId('appointment-preview');
  await expect(preview.getByText(/Kapazitätswarnung/)).toBeVisible();
  await expect(preview.getByText(/2 Maschinen benötigt, aber nur 1/)).toBeVisible();

  // Die Warnung blockiert NICHTS: Zeit bleibt änderbar.
  await preview.getByLabel('Beginn').fill(fillAt(berlinDayPlus(1), 10));
  staff.once('dialog', (dialog) => void dialog.accept());
  await preview.getByRole('button', { name: 'Zeit speichern' }).click();
  await expect(preview.getByText(/Kapazitätswarnung/)).toBeVisible();

  // „Konflikt gelöst“ entfernt die Warnung.
  await preview.getByRole('button', { name: 'Konflikt gelöst' }).click();
  await expect(preview.getByText(/Kapazitätswarnung/)).toHaveCount(0);

  // Relevante Änderung der Maschinenlage: die einzige 2×8-Maschine geht in
  // Reparatur → neuer fachlicher Fingerprint → Konflikt wird neu bewertet.
  await staff.goto('/maschinen');
  await staff.getByRole('link', { name: 'MR-08-02-01' }).click();
  await staff.getByLabel('Neuer Status').selectOption({ label: '🔴 Reparatur' });
  await staff.getByRole('button', { name: 'Status speichern' }).click();
  await expect(staff.locator('.badge', { hasText: 'Reparatur' })).toBeVisible();

  await staff.goto(`/vorgaenge/${capacityProcessId}/termine`);
  await staff.locator('.entry-row', { hasText: 'Abholung / Ausgabe' }).click();
  await expect(
    staff.getByTestId('appointment-preview').getByText(/Kapazitätswarnung/),
  ).toBeVisible();

  // Aufräumen für nachfolgende Szenarien: Maschine wieder einsatzbereit.
  await staff.goto('/maschinen');
  await staff.getByRole('link', { name: 'MR-08-02-01' }).click();
  await staff.getByLabel('Neuer Status').selectOption({ label: '🟢 Einsatzbereit' });
  await staff.getByRole('button', { name: 'Status speichern' }).click();
  await expect(staff.locator('.badge', { hasText: 'Einsatzbereit' })).toBeVisible();
});

// ── Szenario E: Lager ohne erfundenen Bestand → Anfangsbestand ───────────

test('E: Lagerartikel ohne erfundenen Bestand; Anfangsbestand erfassen', async () => {
  await staff.goto('/lager');
  await expect(staff.getByRole('heading', { name: 'Lager' })).toBeVisible();
  const becher = staff.getByTestId('inventory-becher-25');
  await expect(becher).toBeVisible();
  await expect(becher.getByText(/Noch nicht initial erfasst/)).toBeVisible();
  await expect(becher.getByText(/Mindestbestand: nicht festgelegt/)).toBeVisible();

  await becher.getByLabel('Anfangsbestand Becher (25 Stück)').fill('8');
  await becher.getByRole('button', { name: 'Anfangsbestand erfassen' }).click();

  // Erstinventur → Freigabe erforderlich → freigeben.
  await expect(staff.getByRole('heading', { name: 'Inventur' })).toBeVisible();
  await expect(staff.getByText('Freigabe erforderlich')).toBeVisible();
  await staff.getByRole('button', { name: 'Bestandskorrektur freigeben' }).click();
  await expect(staff.getByText('Inventur freigegeben – Bestand wurde angepasst.')).toBeVisible();

  await staff.goto('/lager');
  await expect(
    staff.getByTestId('inventory-becher-25').getByText(/Bestand: 8 × 25er-Pack/),
  ).toBeVisible();
});

// ── Szenario F: Wareneingang ─────────────────────────────────────────────

test('F: Wareneingang +Menge erhöht den Bestand exakt; Bewegung für Admin sichtbar', async () => {
  const becher = staff.getByTestId('inventory-becher-25');
  await becher.getByLabel('Menge hinzufügen Becher (25 Stück)').fill('12');
  await becher.getByRole('button', { name: 'Menge hinzufügen' }).click();
  await expect(staff.getByText('Wareneingang gebucht.')).toBeVisible();
  await expect(
    staff.getByTestId('inventory-becher-25').getByText(/Bestand: 20 × 25er-Pack/),
  ).toBeVisible();

  await staff.getByRole('link', { name: 'Bewegungshistorie' }).click();
  await expect(staff.getByRole('heading', { name: 'Lagerbewegungen' })).toBeVisible();
  const incoming = staff.locator('.list-row', { hasText: 'Wareneingang' }).first();
  await expect(incoming).toContainText('+12');
  await expect(incoming).toContainText('→ 20');
});

// ── Szenario G: Inventur mit Differenz ───────────────────────────────────

test('G: Inventurdifferenz → Freigabe erforderlich → korrigieren → freigeben → genau eine Bewegung', async () => {
  await staff.goto('/lager');
  const becher = staff.getByTestId('inventory-becher-25');
  await becher.getByLabel('Inventur Becher (25 Stück)').fill('15');
  await becher.getByRole('button', { name: 'Artikel-Inventur' }).click();

  await expect(staff.getByRole('heading', { name: 'Inventur' })).toBeVisible();
  await expect(staff.getByText('Freigabe erforderlich')).toBeVisible();
  await expect(staff.getByText(/Systembestand: 20 × 25er-Pack/)).toBeVisible();
  await expect(staff.getByText(/Gezählt \(Ist\): 15 × 25er-Pack/)).toBeVisible();
  await expect(staff.getByText(/Differenz: -5 \(25 %\)/)).toBeVisible();

  // Admin korrigiert den Zählwert vor der Freigabe.
  await staff.getByLabel('Zählwert korrigieren Becher (25 Stück)').fill('16');
  await staff.getByRole('button', { name: 'Zählwert korrigieren' }).click();
  await expect(staff.getByText(/Gezählt \(Ist\): 16 × 25er-Pack/)).toBeVisible();
  await expect(staff.getByText(/Differenz: -4 \(20 %\)/)).toBeVisible();

  await staff.getByRole('button', { name: 'Bestandskorrektur freigeben' }).click();
  await expect(staff.getByText('Inventur freigegeben – Bestand wurde angepasst.')).toBeVisible();

  await staff.goto('/lager');
  await expect(
    staff.getByTestId('inventory-becher-25').getByText(/Bestand: 16 × 25er-Pack/),
  ).toBeVisible();

  // Genau EINE Inventurkorrektur-Bewegung.
  await staff.getByRole('link', { name: 'Bewegungshistorie' }).click();
  await expect(staff.locator('.list-row', { hasText: 'Inventurkorrektur' })).toHaveCount(1);
  await expect(staff.locator('.list-row', { hasText: 'Inventurkorrektur' })).toContainText('-4');
});

// ── Szenario H: Mindestbestand-Warnung ───────────────────────────────────

test('H: Mindestbestand setzen → Warnung erscheint → Wareneingang → Warnung verschwindet', async () => {
  await staff.goto('/lager');
  const becher = staff.getByTestId('inventory-becher-25');
  await becher.getByLabel('Mindestbestand Becher (25 Stück)').fill('25');
  await becher.getByRole('button', { name: 'Mindestbestand setzen' }).click();
  await expect(becher.getByText(/Mindestbestand: 25 × 25er-Pack/)).toBeVisible();
  await expect(becher.locator('.badge', { hasText: 'Unter Mindestbestand' })).toBeVisible();
  await expect(staff.getByTestId('low-stock-warning')).toContainText(
    'Lagerbestand niedrig: 1 Artikel',
  );

  // Kompakte Warnung auf „Heute“ (Order §48) – Überfällige bleiben oben.
  await staff.goto('/');
  await expect(staff.getByTestId('warehouse-warnings')).toContainText(
    'Lagerbestand niedrig: 1 Artikel',
  );

  // Wareneingang über den Grenzwert → Warnung verschwindet.
  await staff.goto('/lager');
  const becherAgain = staff.getByTestId('inventory-becher-25');
  await becherAgain.getByLabel('Menge hinzufügen Becher (25 Stück)').fill('20');
  await becherAgain.getByRole('button', { name: 'Menge hinzufügen' }).click();
  await expect(becherAgain.getByText(/Bestand: 36 × 25er-Pack/)).toBeVisible();
  await expect(becherAgain.locator('.badge', { hasText: 'Unter Mindestbestand' })).toHaveCount(0);
  await expect(staff.getByTestId('low-stock-warning')).toHaveCount(0);
});
