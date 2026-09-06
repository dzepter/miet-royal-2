/**
 * Phase-6-E2E-Szenarien A–I (Order §68): Maschinenzuweisung, Vorbereitung,
 * Override, QR, Lieferschein-Entwurf, geführte Übergabe, Finalisierung,
 * zwei Maschinen, Risikohinweis nach Sperre und Lagerblocker.
 *
 * A Bestätigter Vorgang → Ausgabe-Bereich → Vorbereitung → Maschine wählen
 *   → vorbereitet (🟠 Reserviert) · ohne handover.view kein Zugang.
 * B Problematische Maschine → starke Warnung → Override nur mit Pflichtgrund
 *   → Admin-Override-Liste.
 * C QR-Identifier auflösen → richtige Maschine; ungültiger Identifier abgelehnt.
 * D Lieferschein-Entwurf: Ist-Menge, Zusatzposition mit eingefrorenem Preis,
 *   Vorschau-PDF; Buchungs-Snapshot bleibt unverändert.
 * E Geführte Übergabe (Tablet-Wizard) bis zum Abschluss.
 * F Nach der Übergabe: Vermietet beim Kunden, finale PDFs, Abholtermin
 *   abgeschlossen, Rückgabe offen, Lieferschein nicht mehr editierbar.
 * G Zwei Maschinen → beide geprüft/fotografiert → EIN Protokoll, EIN Lieferschein.
 * H Maschine nach Vorbereitung gesperrt → Risikohinweis → Geprüft →
 *   bewusste erneute Bestätigung.
 * I Unzureichender Bestand → verständlicher Blocker → Wareneingang → Abschluss;
 *   genau eine Ausgabe-Bewegung.
 *
 * Läuft bewusst NACH warehouse-flow (alphabetische Reihenfolge, geteilte
 * Testdatenbank): der Becher-Bestand aus Phase 5 wird weiterverwendet, alle
 * anderen Artikel werden hier initial erfasst. Ausschließlich synthetische
 * Testdaten; Unterschriften/Fotos sind Testpixel.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const ADMIN_EMAIL = 'admin@e2e.example';
const ADMIN_PASSWORD = 'e2e-admin-passwort-1';
const SELLER_EMAIL = 'verkauf@e2e.example';
const SELLER_PASSWORD = 'e2e-verkauf-passwort-1';
const WEB_ORIGIN = 'http://127.0.0.1:3100';
const STAFF_ORIGIN = 'http://127.0.0.1:3102';

/** 1×1-PNG (Testpixel) für Gesamtfotos. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test.describe.configure({ mode: 'serial' });

let staff: Page; // Erika (Admin)
let viktor: Page; // Viktor (Verkauf – kein handover.view)
let customerPage: Page;
let processA = '';
let numberA = '';
let qrToken03 = '';

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

/** Sichtbarer Text eines unkomprimierten pdfkit-Dokuments (Hex-Strings). */
function pdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  let out = '';
  for (const match of raw.matchAll(/<([0-9a-fA-F]+)>/g)) {
    const hex = match[1]!;
    if (hex.length % 2 === 0) out += Buffer.from(hex, 'hex').toString('latin1');
  }
  return `${raw}\n${out}`;
}

/** Privates Dokument über die authentifizierte Staff-Session laden. */
async function fetchPdf(href: string): Promise<string> {
  const response = await staff.request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type'] ?? '').toContain('application/pdf');
  return pdfText(await response.body());
}

/**
 * Kunde + Vorgang + 1×10-Anfrage (1 L Gratis-Sirup Kirsche) + Angebot +
 * Online-Annahme + AB-Freigabe/-Versand – ausschließlich echte Wege. Die
 * Maschinenanzahl (>1) wird über den Angebots-Entwurf gesetzt (Staff-API,
 * gleiche Session), da die Angebotsmaske dafür kein Feld hat.
 */
async function acceptedBooking(
  firstName: string,
  lastName: string,
  email: string,
  options: { machineQuantity?: number } = {},
): Promise<{ processId: string; processNumber: string }> {
  await staff.goto('/kunden');
  await staff.getByRole('button', { name: 'Kunde anlegen' }).click();
  await staff.getByLabel('Vorname').fill(firstName);
  await staff.getByLabel('Nachname').fill(lastName);
  await staff.getByLabel('E-Mail (optional)').fill(email);
  await staff.getByRole('button', { name: 'Kunde anlegen' }).click();
  await expect(staff.getByRole('heading', { name: `${firstName} ${lastName}` })).toBeVisible();
  await staff.getByRole('button', { name: 'Vorgang anlegen' }).click();
  const numberHeading = staff.getByRole('heading', { name: /^MR-\d{4}-\d{4,}$/ });
  await expect(numberHeading).toBeVisible();
  const processNumber = (await numberHeading.innerText()).trim();
  const processId = /\/vorgaenge\/([0-9a-f-]{36})/.exec(staff.url())![1]!;

  await staff.goto(`/vorgaenge/${processId}/anfrage`);
  const eventDate = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString().slice(0, 10);
  await staff.getByLabel('Eventdatum').fill(eventDate);
  await staff.getByLabel('Gästezahl (exakt)').fill('30');
  await staff.getByLabel('Anlass').selectOption({ label: 'Geburtstag' });
  await staff.getByLabel('Gewünschter Maschinentyp').selectOption({ label: '1×10 L' });
  await staff.getByLabel('Sirup Kirsche – gratis (L)').fill('1');
  await staff.getByRole('button', { name: 'Anfrage speichern' }).click();
  await expect(staff.getByText('Anfrage gespeichert.')).toBeVisible();

  await staff.goto(`/vorgaenge/${processId}/angebot`);
  await staff.getByRole('button', { name: 'Angebot erstellen (aus Anfrage)' }).click();
  await expect(staff.getByRole('heading', { name: /Version 1/ })).toBeVisible();
  if (options.machineQuantity !== undefined) {
    const offer = (await (
      await staff.request.get(`/api/staff/processes/${processId}/offer`)
    ).json()) as {
      offer: { versions: { id: string; status: string }[] } | null;
    };
    const draft = offer.offer?.versions.find((version) => version.status === 'draft');
    expect(draft).toBeDefined();
    const patched = await staff.request.patch(`/api/staff/offer-versions/${draft!.id}`, {
      data: { machineQuantity: options.machineQuantity },
    });
    expect(patched.ok()).toBe(true);
    await staff.reload();
    await expect(staff.getByRole('heading', { name: /Version 1/ })).toBeVisible();
  }
  await staff.getByRole('button', { name: 'Angebot versenden' }).click();
  const link = staff.getByTestId('public-offer-link');
  await expect(link).toBeVisible();
  const path = (await link.innerText()).trim();

  await customerPage.goto(`${WEB_ORIGIN}${path}`);
  await customerPage.getByRole('button', { name: 'Angebot verbindlich annehmen' }).click();
  await expect(customerPage.getByRole('heading', { name: 'Vielen Dank!' })).toBeVisible();

  // Auftragsbestätigung freigeben + versenden (echter Phase-3-Weg).
  await staff.goto(`/vorgaenge/${processId}/angebot`);
  await expect(staff.getByRole('heading', { name: 'Auftragsbestätigung' })).toBeVisible();
  await staff.getByRole('button', { name: 'Auftragsbestätigung freigeben' }).click();
  await expect(staff.getByText('Freigegeben')).toBeVisible();
  await staff.getByRole('button', { name: 'Auftragsbestätigung versenden' }).click();
  await expect(staff.getByText('Versendet', { exact: true })).toBeVisible();
  return { processId, processNumber };
}

/** Terminzeit im Terminplanungs-Preview setzen (Berlin-Wanduhrzeit). */
async function setTime(processId: string, row: 'Abholung / Ausgabe' | 'Rückgabe', start: string) {
  await staff.goto(`/vorgaenge/${processId}/termine`);
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

/** Anfangsbestand erfassen (mit Freigabe), falls der Artikel noch nie gezählt wurde. */
async function ensureInitialStock(slug: string, productName: string, amount: number) {
  await staff.goto('/lager');
  const row = staff.getByTestId(`inventory-${slug}`);
  await expect(row).toBeVisible();
  if ((await row.getByText(/Noch nicht initial erfasst/).count()) === 0) return;
  await row.getByLabel(`Anfangsbestand ${productName}`).fill(String(amount));
  await row.getByRole('button', { name: 'Anfangsbestand erfassen' }).click();
  await expect(staff.getByRole('heading', { name: 'Inventur' })).toBeVisible();
  await staff.getByRole('button', { name: 'Bestandskorrektur freigeben' }).click();
  await expect(staff.getByText('Inventur freigegeben – Bestand wurde angepasst.')).toBeVisible();
}

async function next() {
  await staff.getByTestId('wizard-next').click();
}

async function uploadPhoto(slotNo: number) {
  await staff
    .getByTestId(`photo-input-${slotNo}`)
    .setInputFiles({ name: 'gesamtfoto.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(staff.getByTestId(`check-${slotNo}`).locator('img.photo-thumb')).toHaveCount(1);
}

/** Unterschrift mit der Maus zeichnen (Pointer-Events) und übernehmen. */
async function sign(label: 'Kunde' | 'Mitarbeiter') {
  const padLocator: Locator = staff.getByTestId(`signature-${label}`);
  const canvas = padLocator.getByLabel(`Unterschrift ${label}`);
  const box = (await canvas.boundingBox())!;
  await staff.mouse.move(box.x + 40, box.y + 110);
  await staff.mouse.down();
  await staff.mouse.move(box.x + 160, box.y + 150, { steps: 8 });
  await staff.mouse.move(box.x + 320, box.y + 80, { steps: 8 });
  await staff.mouse.up();
  await padLocator.getByRole('button', { name: 'Unterschrift übernehmen' }).click();
}

async function assignViaSuggestion(slotNo: number, machineCode: string) {
  const slot = staff.getByTestId(`slot-${slotNo}`);
  await slot.getByRole('button', { name: 'Maschine wählen' }).click();
  await staff
    .getByTestId(`suggest-${machineCode}`)
    .getByRole('button', { name: 'Wählen', exact: true })
    .click();
  await expect(staff.getByText(`Maschine ${machineCode} zugewiesen.`)).toBeVisible();
  await slot.getByRole('button', { name: 'Als vorbereitet markieren' }).click();
  await expect(slot).toContainText('Vorbereitet');
}

// ── Szenario A: Ausgabe-Bereich → Vorbereitung → Maschine → Reserviert ───

test('A: Bestätigter Vorgang → Ausgabe-Bereich → Maschine wählen → vorbereitet (Reserviert)', async () => {
  test.setTimeout(240_000);
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  ({ processId: processA, processNumber: numberA } = await acceptedBooking(
    'Hanna',
    'Handover',
    'hanna@e2e.example',
  ));

  // Vorgang: prominente nächste Aktion + Ausgabe-Abschnitt.
  await staff.goto(`/vorgaenge/${processA}`);
  await expect(staff.getByRole('link', { name: 'Maschinen zuweisen' })).toBeVisible();
  await expect(staff.getByTestId('process-handover')).toContainText('noch nicht zugewiesen');

  // AUSGABE-Bereich: bestätigt, aber noch ohne Zeit.
  await staff.getByRole('link', { name: 'Ausgabe', exact: true }).click();
  await expect(staff.getByRole('heading', { name: 'Ausgabe' })).toBeVisible();
  await expect(
    staff.getByRole('heading', { name: 'Bestätigt, aber noch ohne Zeit' }),
  ).toBeVisible();
  await expect(staff.getByTestId(`issue-${numberA}`)).toContainText('Noch nicht vorbereitet');

  // Mietzeitraum planen: Abholung +1d 09:00, Rückgabe +3d 11:00.
  await setTime(processA, 'Abholung / Ausgabe', fillAt(berlinDayPlus(1), 9));
  await setTime(processA, 'Rückgabe', fillAt(berlinDayPlus(3), 11));

  await staff.goto('/ausgabe');
  await staff.getByLabel('Tag').fill(berlinDayPlus(1));
  const card = staff.getByTestId(`issue-${numberA}`);
  await expect(card).toContainText('09:00 Uhr');
  await expect(card).toContainText('Handover, Hanna');
  await card.click();

  // Vorbereitung: Vorschlag → Maschine wählen → als vorbereitet markieren.
  await expect(
    staff.getByRole('heading', { name: `Ausgabe vorbereiten – ${numberA}` }),
  ).toBeVisible();
  const slot = staff.getByTestId('slot-1');
  await expect(slot).toContainText('Keine Maschine zugewiesen');
  await slot.getByRole('button', { name: 'Maschine wählen' }).click();
  const suggestion = staff.getByTestId('machine-suggestion');
  await expect(suggestion).toBeVisible();
  await expect(suggestion.locator('.badge', { hasText: 'Bevorzugt' })).toHaveCount(1);
  await expect(suggestion.getByTestId('suggest-MR-10-01-01')).toContainText('Bevorzugt');
  await expect(suggestion.getByTestId('suggest-MR-10-01-01')).toContainText('Kaufdatum unbekannt');
  await expect(suggestion.getByTestId('suggest-MR-10-01-06')).toBeVisible();
  await suggestion
    .getByTestId('suggest-MR-10-01-01')
    .getByRole('button', { name: 'Wählen', exact: true })
    .click();
  await expect(staff.getByText('Maschine MR-10-01-01 zugewiesen.')).toBeVisible();
  await expect(slot).toContainText('MR-10-01-01');
  await expect(slot).toContainText('Zugewiesen');

  await slot.getByRole('button', { name: 'Als vorbereitet markieren' }).click();
  await expect(staff.getByText('Als vorbereitet markiert (🟠 Reserviert).')).toBeVisible();
  await expect(slot).toContainText('Vorbereitet');
  await expect(slot).toContainText('Reserviert');

  // Maschine ist 🟠 Reserviert – ausschließlich über den Fachprozess.
  await staff.goto('/maschinen');
  await expect(staff.getByTestId('machine-MR-10-01-01')).toContainText('Reserviert');

  await staff.goto('/ausgabe');
  await staff.getByLabel('Tag').fill(berlinDayPlus(1));
  await expect(staff.getByTestId(`issue-${numberA}`)).toContainText('Vorbereitet');

  // Ohne handover.view: kein Navigationseintrag, kein Zugang.
  await login(viktor, SELLER_EMAIL, SELLER_PASSWORD, 'Viktor');
  await expect(viktor.getByRole('link', { name: 'Ausgabe', exact: true })).toHaveCount(0);
  await viktor.goto('/ausgabe');
  await expect(
    viktor.getByText('Dir fehlt das Recht, den Ausgabe-Bereich einzusehen.'),
  ).toBeVisible();
});

// ── Szenario B: Override ─────────────────────────────────────────────────

test('B: Problematische Maschine → starke Warnung → Override nur mit Pflichtgrund → protokolliert', async () => {
  test.setTimeout(120_000);
  await staff.goto('/maschinen');
  await staff.getByRole('link', { name: 'MR-10-01-02' }).click();
  await staff.getByLabel('Neuer Status').selectOption({ label: '🟡 Reinigung' });
  await staff.getByRole('button', { name: 'Status speichern' }).click();
  await expect(staff.locator('.badge', { hasText: 'Reinigung' })).toBeVisible();

  await staff.goto(`/vorgaenge/${processA}/ausgabe`);
  const slot = staff.getByTestId('slot-1');
  await slot.getByRole('button', { name: 'Maschine wechseln' }).click();
  const entry = staff.getByTestId('suggest-MR-10-01-02');
  await expect(entry).toContainText('Reinigung');
  await entry.getByRole('button', { name: 'Trotzdem wählen …' }).click();

  const dialog = staff.getByTestId('override-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Starke Warnung – Maschine MR-10-01-02');
  const confirm = dialog.getByRole('button', { name: 'Trotzdem zuordnen (bewusst bestätigen)' });
  await expect(confirm).toBeDisabled(); // Grund ist Pflicht
  await dialog.getByLabel('Grund (Pflicht)').fill('Reinigung ist bis zur Abholung erledigt (E2E)');
  await confirm.click();
  await expect(staff.getByText('Maschine MR-10-01-02 mit Override zugewiesen.')).toBeVisible();
  await expect(slot).toContainText('MR-10-01-02');
  await expect(slot).toContainText('Override: Reinigung ist bis zur Abholung erledigt (E2E)');
  await expect(slot).toContainText('Erika E2E');
  await expect(slot).toContainText('Zugewiesen'); // Wechsel setzt die Vorbereitung zurück

  // Die vorher reservierte Maschine ist sauber wieder einsatzbereit.
  await staff.goto('/maschinen');
  await expect(staff.getByTestId('machine-MR-10-01-01')).toContainText('Einsatzbereit');

  // Override-Liste für Admin (Maschine, Vorgang, Grund, Mitarbeiter).
  await staff.goto('/maschinen/overrides');
  const row = staff.getByTestId('override-MR-10-01-02');
  await expect(row).toContainText(numberA);
  await expect(row).toContainText('Grund: Reinigung ist bis zur Abholung erledigt (E2E)');
  await expect(row).toContainText('Erika E2E');
});

// ── Szenario C: QR ───────────────────────────────────────────────────────

test('C: QR-Identifier auflösen → richtige Maschine; ungültiger Identifier wird abgelehnt', async () => {
  test.setTimeout(120_000);
  await staff.goto('/maschinen');
  await staff.getByRole('link', { name: 'MR-10-01-03' }).click();
  qrToken03 = (await staff.getByTestId('qr-token').innerText()).trim();
  expect(qrToken03).toMatch(/^[0-9a-f]{48,128}$/);

  await staff.goto(`/vorgaenge/${processA}/ausgabe`);
  const slot = staff.getByTestId('slot-1');
  await slot.getByRole('button', { name: 'Maschine wechseln' }).click();
  await staff.getByRole('button', { name: '📷 QR scannen' }).click();
  const scanner = staff.getByTestId('qr-scanner');
  await expect(scanner).toBeVisible();
  const input = scanner.getByLabel('QR-Identifier oder gescannte Adresse');

  // Ungültiger Identifier: neutrale Ablehnung, keine Zuordnung.
  await input.fill('0'.repeat(64));
  await scanner.getByRole('button', { name: 'Auflösen' }).click();
  await expect(scanner.locator('.error')).toBeVisible();
  await expect(slot).toContainText('MR-10-01-02');

  // Gescannte QR-Adresse → richtige Maschine wird zugeordnet.
  await input.fill(`${STAFF_ORIGIN}/qr/${qrToken03}`);
  await scanner.getByRole('button', { name: 'Auflösen' }).click();
  await expect(staff.getByText('Maschine MR-10-01-03 zugewiesen.')).toBeVisible();
  await expect(slot).toContainText('MR-10-01-03');
  await expect(slot).not.toContainText('Override:');
  await slot.getByRole('button', { name: 'Als vorbereitet markieren' }).click();
  await expect(slot).toContainText('Vorbereitet');

  await staff.goto('/maschinen');
  await expect(staff.getByTestId('machine-MR-10-01-02')).toContainText('Reinigung');
  await expect(staff.getByTestId('machine-MR-10-01-03')).toContainText('Reserviert');
});

// ── Szenario D: Lieferschein-Entwurf ─────────────────────────────────────

test('D: Lieferschein-Entwurf: Ist-Menge, Zusatzposition mit eingefrorenem Preis, Vorschau – Snapshot unverändert', async () => {
  test.setTimeout(120_000);
  await staff.goto(`/vorgaenge/${processA}/angebot`);
  const fixedTotal = (await staff.getByText(/Fester Angebotswert:/).innerText()).trim();

  await staff.goto(`/vorgaenge/${processA}/ausgabe`);
  const note = staff.getByTestId('delivery-note');
  await expect(note).toContainText('Lieferschein (Entwurf)');
  await expect(note).toContainText('Kirsche'); // inklusive (1 L je Behälter)
  await expect(note).toContainText('Becher');
  // Inklusive Positionen sind auf das gebuchte Kontingent begrenzt (mehr nur
  // als Zusatzposition) – weniger ist erlaubt: der Kunde möchte keine Strohhalme.
  const strawsInput = note.getByLabel(/^Ausgabemenge .*Strohhalme/);
  await expect(strawsInput).toHaveValue('1');
  await strawsInput.fill('2');
  await note
    .locator('.list-row', { hasText: 'Strohhalme' })
    .getByRole('button', { name: 'Speichern' })
    .click();
  await expect(staff.locator('.error')).toContainText('Inklusive Positionen');
  await strawsInput.fill('0');
  await note
    .locator('.list-row', { hasText: 'Strohhalme' })
    .getByRole('button', { name: 'Speichern' })
    .click();
  await expect(staff.getByText('Ausgabemenge gespeichert.')).toBeVisible();
  await expect(note.locator('.list-row', { hasText: 'Strohhalme' }).first()).toContainText(
    'Soll: 1 25er-Pack',
  );

  // Zusatzposition (nur Sirup/Becher/Strohhalme/Kanister) mit aktuellem Listenpreis.
  const option = note.locator('#addition-product option', { hasText: 'Waldmeister' });
  await note.locator('#addition-product').selectOption((await option.getAttribute('value'))!);
  await note.getByLabel('Zusatzmenge').fill('2');
  await note.getByRole('button', { name: 'Zusatzposition hinzufügen' }).click();
  await expect(
    staff.getByText(
      'Zusatzposition mit aktuellem Preis gespeichert – die Buchung bleibt unverändert.',
    ),
  ).toBeVisible();
  await expect(note).toContainText('Zusatzpositionen: 2 × Sirup Waldmeister (12,00 €)');
  const waldmeisterRow = note.locator('.list-row', { hasText: 'Sirup Waldmeister' });
  await expect(waldmeisterRow).toContainText('Kommission');
  await expect(waldmeisterRow).toContainText('nachträglich vereinbart');
  await expect(note.locator('#addition-product option', { hasText: '1×10' })).toHaveCount(0);

  // Vorschau-PDF (Entwurf) über die private Session.
  const previewHref = await note
    .getByRole('link', { name: 'Lieferschein-Vorschau (PDF)' })
    .getAttribute('href');
  const previewText = await fetchPdf(previewHref!);
  expect(previewText).toContain('Lieferschein (Entwurf)');
  expect(previewText).toContain('Waldmeister');
  expect(previewText).toContain('MR-10-01-03');

  // Buchungs-Snapshot bleibt unverändert.
  await staff.goto(`/vorgaenge/${processA}/angebot`);
  await expect(staff.getByText(/Fester Angebotswert:/)).toHaveText(fixedTotal);
  await expect(staff.locator('table', { hasText: 'Waldmeister' })).toHaveCount(0);
});

// ── Szenario E: Geführte Übergabe ────────────────────────────────────────

test('E: Geführte Übergabe: Maschine scannen, gemeinsam prüfen, Pflichtfoto, Empfänger, Unterschriften, Abschluss', async () => {
  test.setTimeout(240_000);
  // Bestände ehrlich erfassen (kein erfundener Bestand): Sirup + Strohhalme.
  await ensureInitialStock('sirup-kirsche', 'Sirup Kirsche', 5);
  await ensureInitialStock('sirup-waldmeister', 'Sirup Waldmeister', 5);
  await ensureInitialStock('strohhalme-25', 'Strohhalme (25 Stück)', 5);
  await ensureInitialStock('becher-25', 'Becher (25 Stück)', 40);

  await staff.goto(`/vorgaenge/${processA}`);
  await staff.getByRole('link', { name: 'Übergabe starten' }).click();
  await expect(staff.getByRole('heading', { name: `Übergabe – ${numberA}` })).toBeVisible();

  // 1 Vorgang prüfen
  await expect(staff.getByRole('heading', { name: '1. Vorgang prüfen' })).toBeVisible();
  await expect(staff.getByText('Handover, Hanna')).toBeVisible();
  await next();

  // 2 Maschine per QR bestätigen
  await expect(
    staff.getByRole('heading', { name: '2. Maschinen bestätigen / scannen' }),
  ).toBeVisible();
  await expect(staff.getByTestId('wizard-slot-1')).toContainText('MR-10-01-03');
  await staff.getByRole('button', { name: '📷 Scannen zur Bestätigung' }).click();
  const scanner = staff.getByTestId('qr-scanner');
  await scanner.getByLabel('QR-Identifier oder gescannte Adresse').fill(qrToken03);
  await scanner.getByRole('button', { name: 'Auflösen' }).click();
  await expect(staff.getByText('Maschine MR-10-01-03 bestätigt.')).toBeVisible();
  await next();

  // 3 Artikel
  await expect(staff.getByRole('heading', { name: '3. Ausgegebene Artikel prüfen' })).toBeVisible();
  await expect(staff.getByTestId('wizard-stock-warning')).toHaveCount(0);
  await expect(staff.locator('.list-row', { hasText: 'Strohhalme' })).toHaveCount(0);
  await next();

  // 4 Aktive Prüfung + Pflichtfoto je Maschine
  await expect(
    staff.getByRole('heading', { name: '4. Jede Maschine gemeinsam prüfen + Gesamtfoto' }),
  ).toBeVisible();
  const check = staff.getByTestId('check-1');
  await expect(staff.getByTestId('wizard-next')).toBeDisabled();
  await check.getByRole('button', { name: 'Maschine gemeinsam geprüft' }).click();
  await expect(check).toContainText('✓ Maschine gemeinsam geprüft');
  await expect(staff.getByTestId('wizard-next')).toBeDisabled(); // Foto ist Pflicht
  await uploadPhoto(1);
  await next();

  // 5 Empfänger (Kunde selbst)
  await expect(
    staff.getByRole('heading', { name: '5. Kunde oder Vertreter bestimmen' }),
  ).toBeVisible();
  await expect(staff.getByTestId('wizard-next')).toBeDisabled();
  await expect(
    staff.getByText('Kein Ausweis, keine Ausweisnummer, kein Ausweisfoto.'),
  ).toBeVisible();
  await staff.getByRole('button', { name: 'Übernehmen', exact: true }).click();
  await expect(staff.getByText('Empfangsperson gespeichert.')).toBeVisible();
  await expect(staff.getByText(/Aktuell:/)).toContainText('Handover, Hanna');
  await next();

  // 6 Zusammenfassung ohne Blocker
  await expect(staff.getByRole('heading', { name: '6. Zusammenfassung' })).toBeVisible();
  const summaryBlockers = staff.getByTestId('wizard-blockers');
  await expect(summaryBlockers).toContainText('Unterschrift');
  await expect(summaryBlockers).not.toContainText('Lagerbestand');
  await expect(summaryBlockers).not.toContainText('Maschine');
  await next();

  // 7 Unterschrift Kunde
  await expect(
    staff.getByRole('heading', { name: '7. Unterschrift Kunde / Vertreter' }),
  ).toBeVisible();
  await expect(staff.getByTestId('wizard-next')).toBeDisabled();
  await sign('Kunde');
  await expect(staff.getByText(/✓ Unterschrieben von Handover, Hanna/)).toBeVisible();
  await next();

  // 8 Unterschrift Mitarbeiter (Unterzeichner aus der Session)
  await expect(staff.getByRole('heading', { name: '8. Unterschrift Mitarbeiter' })).toBeVisible();
  await sign('Mitarbeiter');
  await expect(staff.getByText(/✓ Unterschrieben von Erika E2E/)).toBeVisible();
  await next();

  // 9 Abschluss
  await expect(staff.getByRole('heading', { name: '9. Übergabe abschließen' })).toBeVisible();
  const finalize = staff.getByTestId('finalize-button');
  await expect(finalize).toBeEnabled();
  await finalize.click();
  await expect(staff.getByText(/✓ Übergabe abgeschlossen am/)).toBeVisible();
  const final = staff.getByTestId('wizard-final');
  await expect(final.getByRole('link', { name: 'Lieferschein' })).toHaveCount(1);
  await expect(final.getByRole('link', { name: 'Übergabeprotokoll' })).toHaveCount(1);
});

// ── Szenario F: Zustand nach der Übergabe ────────────────────────────────

test('F: Danach: Maschine Vermietet beim Kunden, Dokumente final, Abholtermin abgeschlossen, Rückgabe offen', async () => {
  test.setTimeout(120_000);
  await staff.goto('/maschinen');
  await staff.getByRole('link', { name: 'MR-10-01-03' }).click();
  await expect(staff.locator('.badge', { hasText: 'Vermietet' })).toBeVisible();
  await expect(staff.getByText(`Standort: Kunde – ${numberA}`)).toBeVisible();

  await staff.goto(`/vorgaenge/${processA}/termine`);
  await expect(staff.locator('.entry-row', { hasText: 'Abholung / Ausgabe' })).toContainText(
    'Intern abgeschlossen',
  );
  await expect(staff.locator('.entry-row', { hasText: 'Rückgabe' })).not.toContainText(
    'Intern abgeschlossen',
  );

  // Vorgang: abgeschlossen, Dokumente privat über die Session abrufbar.
  await staff.goto(`/vorgaenge/${processA}`);
  await expect(staff.getByText('Übergabe abgeschlossen').first()).toBeVisible();
  const section = staff.getByTestId('process-handover');
  await expect(section).toContainText('Ausgegeben');
  const noteHref = await section.getByRole('link', { name: 'Lieferschein' }).getAttribute('href');
  const protocolHref = await section
    .getByRole('link', { name: 'Übergabeprotokoll' })
    .getAttribute('href');
  const noteText = await fetchPdf(noteHref!);
  expect(noteText).toContain('MR-10-01-03');
  expect(noteText).toContain('Waldmeister');
  expect(noteText).not.toContain('Entwurf');
  const protocolText = await fetchPdf(protocolHref!);
  expect(protocolText).toContain('MR-10-01-03');
  expect(protocolText).toContain('Handover, Hanna');
  expect(protocolText).toContain('Erika E2E');

  // Lieferschein final: keine Bearbeitung mehr, Zuordnung ausgegeben.
  await staff.goto(`/vorgaenge/${processA}/ausgabe`);
  await expect(staff.getByTestId('delivery-note')).toContainText('Lieferschein (final)');
  await expect(staff.getByLabel(/^Ausgabemenge/)).toHaveCount(0);
  await expect(staff.getByRole('button', { name: 'Zusatzposition hinzufügen' })).toHaveCount(0);
  await expect(staff.getByTestId('slot-1')).toContainText('Ausgegeben');
  await expect(staff.getByRole('button', { name: 'Maschine wechseln' })).toHaveCount(0);
});

// ── Szenario G: Zwei Maschinen → EIN Protokoll ───────────────────────────

test('G: Zwei Maschinen → beide geprüft/fotografiert → EIN Übergabeprotokoll, EIN Lieferschein', async () => {
  test.setTimeout(300_000);
  const { processId } = await acceptedBooking('Gitta', 'Gemeinsam', 'gitta@e2e.example', {
    machineQuantity: 2,
  });
  await setTime(processId, 'Abholung / Ausgabe', fillAt(berlinDayPlus(2), 10));
  await setTime(processId, 'Rückgabe', fillAt(berlinDayPlus(4), 12));

  await staff.goto(`/vorgaenge/${processId}/ausgabe`);
  await expect(staff.getByTestId('slot-2')).toBeVisible();
  await assignViaSuggestion(1, 'MR-10-01-04');
  await assignViaSuggestion(2, 'MR-10-01-05');

  await staff.goto(`/vorgaenge/${processId}/uebergabe`);
  await next();
  await expect(staff.getByTestId('wizard-slot-1')).toContainText('MR-10-01-04');
  await expect(staff.getByTestId('wizard-slot-2')).toContainText('MR-10-01-05');
  await next();
  await next();
  for (const slotNo of [1, 2]) {
    const check = staff.getByTestId(`check-${slotNo}`);
    await check.getByRole('button', { name: 'Maschine gemeinsam geprüft' }).click();
    await expect(check).toContainText('✓ Maschine gemeinsam geprüft');
    await uploadPhoto(slotNo);
  }
  await next();

  // Sonstiger Vertreter (vom Mitarbeiter bestätigt) – kein Ausweis.
  await staff.getByLabel(/Sonstiger Vertreter/).check();
  await staff.getByLabel('Name', { exact: true }).fill('Gustav Gast');
  await staff.getByRole('button', { name: 'Übernehmen', exact: true }).click();
  await expect(staff.getByText(/Aktuell:/)).toContainText('Gustav Gast');
  await next();
  await expect(staff.getByTestId('wizard-blockers')).not.toContainText('Lagerbestand');
  await expect(staff.getByTestId('wizard-blockers')).not.toContainText('Maschine');
  await next();
  await sign('Kunde');
  await expect(staff.getByText(/✓ Unterschrieben von Gustav Gast/)).toBeVisible();
  await next();
  await sign('Mitarbeiter');
  await next();
  await staff.getByTestId('finalize-button').click();
  await expect(staff.getByText(/✓ Übergabe abgeschlossen am/)).toBeVisible();

  const final = staff.getByTestId('wizard-final');
  await expect(final.getByRole('link', { name: 'Übergabeprotokoll' })).toHaveCount(1);
  await expect(final.getByRole('link', { name: 'Lieferschein' })).toHaveCount(1);
  const protocolText = await fetchPdf(
    (await final.getByRole('link', { name: 'Übergabeprotokoll' }).getAttribute('href'))!,
  );
  expect(protocolText).toContain('MR-10-01-04');
  expect(protocolText).toContain('MR-10-01-05');
  expect(protocolText).toContain('Gustav Gast');

  await staff.goto('/maschinen');
  await expect(staff.getByTestId('machine-MR-10-01-04')).toContainText('Vermietet');
  await expect(staff.getByTestId('machine-MR-10-01-05')).toContainText('Vermietet');
});

// ── Szenario H: Sperre nach Vorbereitung → Risikohinweis ────────────────

test('H: Maschine nach Vorbereitung gesperrt → Risikohinweis → Geprüft → bewusste erneute Bestätigung', async () => {
  test.setTimeout(240_000);
  const { processId, processNumber } = await acceptedBooking(
    'Hilde',
    'Hindernis',
    'hilde@e2e.example',
  );
  await setTime(processId, 'Abholung / Ausgabe', fillAt(berlinDayPlus(5), 9));
  await setTime(processId, 'Rückgabe', fillAt(berlinDayPlus(6), 11));
  await staff.goto(`/vorgaenge/${processId}/ausgabe`);
  await assignViaSuggestion(1, 'MR-10-01-06');
  await expect(staff.getByTestId('slot-1-warning')).toHaveCount(0);

  // Sperre im Mietzeitraum → die zugewiesene Maschine wird problematisch.
  await staff.goto('/maschinen');
  await staff.getByRole('link', { name: 'MR-10-01-06' }).click();
  await staff.getByLabel('Sperre von').fill(fillAt(berlinDayPlus(5), 8));
  await staff.getByLabel('Sperre bis').fill(fillAt(berlinDayPlus(6), 18));
  await staff.getByLabel('Grund (Pflicht)').fill('Wartung (E2E)');
  await staff.getByRole('button', { name: 'Sperre setzen' }).click();
  await expect(staff.getByText('Sperre angelegt.')).toBeVisible();

  // Der Übergabe-Wizard zeigt die geänderte Problemlage – ohne erneute
  // bewusste Bestätigung geht es nicht weiter.
  await staff.goto(`/vorgaenge/${processId}/uebergabe`);
  await next();
  await expect(staff.getByTestId('wizard-slot-1')).toContainText('Problemlage geändert');

  // Risikohinweis für Admin (keine automatische Neuzuweisung).
  await staff.goto('/maschinen/risiken');
  const risk = staff.getByTestId('risk-MR-10-01-06');
  await expect(risk).toBeVisible();
  await expect(risk).toContainText(processNumber);
  await expect(risk).toContainText(/Sperre|gesperrt/i);
  await staff.goto('/');
  await expect(staff.getByTestId('risk-incidents-link')).toContainText('1 zugewiesene Maschine');
  await staff.goto('/maschinen/risiken');
  await staff.getByTestId('risk-MR-10-01-06').getByRole('button', { name: 'Geprüft' }).click();
  await expect(staff.getByTestId('risk-MR-10-01-06')).toHaveCount(0);
  await expect(staff.getByText('Keine offenen Hinweise.')).toBeVisible();

  // Vorbereitung zeigt den Hinweis; erneute bewusste Bestätigung mit Grund.
  await staff.goto(`/vorgaenge/${processId}/ausgabe`);
  const slot = staff.getByTestId('slot-1');
  await expect(staff.getByTestId('slot-1-warning')).toContainText(/Sperre|gesperrt/i);
  await slot.getByRole('button', { name: 'Maschine wechseln' }).click();
  await staff
    .getByTestId('suggest-MR-10-01-06')
    .getByRole('button', { name: 'Trotzdem wählen …' })
    .click();
  const dialog = staff.getByTestId('override-dialog');
  await expect(dialog).toContainText(/Sperre|gesperrt/i);
  await dialog
    .getByLabel('Grund (Pflicht)')
    .fill('Wartung wird vor der Abholung abgeschlossen (E2E)');
  await dialog.getByRole('button', { name: 'Trotzdem zuordnen (bewusst bestätigen)' }).click();
  await expect(staff.getByText('Maschine MR-10-01-06 mit Override zugewiesen.')).toBeVisible();
  await expect(slot).toContainText('Override: Wartung wird vor der Abholung abgeschlossen (E2E)');
  await expect(slot).toContainText('Vorbereitet'); // gleiche Maschine bleibt vorbereitet
});

// ── Szenario I: Lagerblocker ─────────────────────────────────────────────

test('I: Unzureichender Bestand blockiert verständlich → Wareneingang → Abschluss; genau eine Ausgabe-Bewegung', async () => {
  test.setTimeout(300_000);
  const { processId } = await acceptedBooking('Ines', 'Inventar', 'ines@e2e.example');
  await setTime(processId, 'Abholung / Ausgabe', fillAt(berlinDayPlus(7), 9));
  await setTime(processId, 'Rückgabe', fillAt(berlinDayPlus(8), 11));
  await staff.goto(`/vorgaenge/${processId}/ausgabe`);
  await assignViaSuggestion(1, 'MR-10-01-01');

  // Zusatzposition Strohhalme (50 Packs) übersteigt den Bestand.
  const note = staff.getByTestId('delivery-note');
  await expect(staff.getByTestId('stock-warning')).toHaveCount(0);
  const option = note.locator('#addition-product option', { hasText: 'Strohhalme' });
  await note.locator('#addition-product').selectOption((await option.getAttribute('value'))!);
  await note.getByLabel('Zusatzmenge').fill('50');
  await note.getByRole('button', { name: 'Zusatzposition hinzufügen' }).click();
  await expect(
    staff.getByText(
      'Zusatzposition mit aktuellem Preis gespeichert – die Buchung bleibt unverändert.',
    ),
  ).toBeVisible();
  const warning = staff.getByTestId('stock-warning');
  await expect(warning).toContainText('Lagerbestand prüfen');
  await expect(warning).toContainText('Strohhalme');
  await expect(warning).toContainText('benötigt 51');

  // Reservierung/Vorbereitung ist trotzdem möglich – nur der Abschluss blockiert.
  await staff.goto(`/vorgaenge/${processId}/uebergabe`);
  await next();
  await next();
  await expect(staff.getByTestId('wizard-stock-warning')).toContainText('Lagerbestand prüfen');
  await next();
  const check = staff.getByTestId('check-1');
  await check.getByRole('button', { name: 'Maschine gemeinsam geprüft' }).click();
  await expect(check).toContainText('✓ Maschine gemeinsam geprüft');
  await uploadPhoto(1);
  await next();
  await staff.getByRole('button', { name: 'Übernehmen', exact: true }).click();
  await expect(staff.getByText(/Aktuell:/)).toContainText('Inventar, Ines');
  await next();
  await expect(staff.getByTestId('wizard-blockers')).toContainText('Lagerbestand prüfen');
  await next();
  await sign('Kunde');
  await expect(staff.getByText(/✓ Unterschrieben von Inventar, Ines/)).toBeVisible();
  await next();
  await sign('Mitarbeiter');
  await next();
  const finalize = staff.getByTestId('finalize-button');
  await expect(finalize).toBeDisabled();
  await expect(staff.getByTestId('wizard-blockers')).toContainText('Strohhalme');
  await expect(
    staff.getByRole('link', { name: 'Wareneingang erfassen / Inventur prüfen' }),
  ).toBeVisible();

  // Wareneingang im Lager, dann zurück in die Übergabe: alle erledigten
  // Schritte bleiben serverseitig erledigt, nur der Blocker ist weg.
  await staff.goto('/lager');
  const straws = staff.getByTestId('inventory-strohhalme-25');
  await straws.getByLabel('Menge hinzufügen Strohhalme (25 Stück)').fill('60');
  await straws.getByRole('button', { name: 'Menge hinzufügen' }).click();
  await expect(staff.getByText('Wareneingang gebucht.')).toBeVisible();

  await staff.goto(`/vorgaenge/${processId}/uebergabe`);
  for (let step = 0; step < 8; step += 1) await next();
  await expect(staff.getByRole('heading', { name: '9. Übergabe abschließen' })).toBeVisible();
  await staff.getByRole('button', { name: 'Erneut prüfen' }).click();
  await expect(staff.getByTestId('wizard-blockers')).toHaveCount(0);
  await expect(finalize).toBeEnabled();
  await finalize.click();
  await expect(staff.getByText(/✓ Übergabe abgeschlossen am/)).toBeVisible();

  // Genau EINE Ausgabe-Bewegung (−51 Packs) und exakter Bestand.
  await staff.goto('/lager/bewegungen');
  await expect(
    staff
      .locator('.list-row', { hasText: 'Ausgabe' })
      .filter({ hasText: 'Strohhalme' })
      .filter({ hasText: '-51' }),
  ).toHaveCount(1);
  await staff.goto('/lager');
  // 5 (Anfangsbestand) − 0 (A) − 1 (G) + 60 − 51 (I) = 13
  await expect(
    staff.getByTestId('inventory-strohhalme-25').getByText(/Bestand: 13 × 25er-Pack/),
  ).toBeVisible();
});
