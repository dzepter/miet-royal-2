/**
 * Phase-7-E2E-Szenarien A–K (Order §80): Rückgabe-Liste, normale Rückgabe
 * ohne Beanstandung, Folgen (Reinigung/Lager/Termin/Vorgang/Protokoll),
 * Kommissionsrückgabe, Reinigungsfall mit Foto-Pflicht und 75-€-Fakt,
 * Schaden mit Schema/Foto im PDF, mehrere Maschinen → EIN PDF, Fehlteil mit
 * Follow-up, Reinigungsabschluss, nachträgliche Feststellung, bestehender
 * Schaden bei erneuter Ausgabe.
 *
 * Läuft unabhängig (Basis-Seed zu Beginn, eigene Buchungen über die echten
 * Phase-3/4/6-Wege). Ausschließlich synthetische Testdaten; Fotos und
 * Unterschriften sind Testpixel.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { acceptedBooking as acceptedBookingViaUi } from '../helpers/booking.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  backdateCleaning,
  resetE2eDatabase,
} from '../helpers/seed.ts';

/** 1×1-PNG (Testpixel) für Fotos/Unterschriften. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** Kleinstes gültiges JPEG (1×1) – erscheint im Rückgabeprotokoll. */
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

test.describe.configure({ mode: 'serial' });

let staff: Page;
let customerPage: Page;
let processB = '';
let numberB = '';
let processD = '';
let processJ = '';
let returnDocJ = '';

test.beforeAll(async ({ browser }) => {
  resetE2eDatabase();
  staff = await browser.newPage();
  customerPage = await browser.newPage();
});
test.afterAll(async () => {
  await staff.close();
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

function pdfText(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  let out = '';
  for (const match of raw.matchAll(/<([0-9a-fA-F]+)>/g)) {
    const hex = match[1]!;
    if (hex.length % 2 === 0) out += Buffer.from(hex, 'hex').toString('latin1');
  }
  return `${raw}\n${out}`;
}
async function fetchPdfBytes(href: string): Promise<Buffer> {
  const response = await staff.request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type'] ?? '').toContain('application/pdf');
  return response.body();
}

async function setTime(processId: string, row: 'Abholung / Ausgabe' | 'Rückgabe', start: string) {
  await staff.goto(`/vorgaenge/${processId}/termine`);
  await staff.locator('.entry-row', { hasText: row }).click();
  const card = staff.getByTestId('appointment-preview');
  await card.getByLabel('Beginn').fill(start);
  await card.getByLabel('Ende (optional, Zeitfenster)').fill('');
  staff.once('dialog', (dialog) => void dialog.accept());
  await card.getByRole('button', { name: 'Zeit speichern' }).click();
  await expect(
    staff.locator('.entry-row', { hasText: row }).getByText(`${start.slice(11)} Uhr`),
  ).toBeVisible();
  await card.getByLabel('Vorschau schließen').click();
}

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

async function stockOf(slug: string): Promise<number> {
  await staff.goto('/lager');
  const text = await staff.getByTestId(`inventory-${slug}`).innerText();
  const match = /Bestand:\s*(\d+)/.exec(text);
  expect(match).not.toBeNull();
  return Number(match![1]);
}

/**
 * Anzahl eingebetteter Bilder (codec-unabhängig: JPEG und PNG). PNG-Bilder mit
 * Alphakanal erzeugen zusätzlich ein SMask-XObject – das wird herausgerechnet.
 */
function imageObjectCount(bytes: Buffer): number {
  const text = bytes.toString('latin1');
  const images = (text.match(/\/Subtype\s*\/Image/g) ?? []).length;
  const masks = (text.match(/\/SMask\s+\d+\s+0\s+R/g) ?? []).length;
  return images - masks;
}
async function next() {
  await staff.getByTestId('wizard-next').click();
}
async function clickDiagram(svg: Locator, fx: number, fy: number) {
  const box = (await svg.boundingBox())!;
  await svg.click({ position: { x: box.width * fx, y: box.height * fy } });
}
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

/**
 * Buchung anlegen, Termine setzen, Maschinen zuweisen/vorbereiten und die
 * Übergabe komplett abschließen (Phase-6-Wege) → Maschinen sind ausgegeben.
 */
async function issuedBooking(
  firstName: string,
  lastName: string,
  email: string,
  machineCodes: string[],
  options: {
    machineLabel?: '1×10 L' | '2×10 L';
    additions?: { name: string; quantity: number }[];
  } = {},
): Promise<{ processId: string; processNumber: string }> {
  const { processId, processNumber } = await acceptedBookingViaUi(staff, customerPage, {
    firstName,
    lastName,
    email,
    machineLabel: options.machineLabel ?? '1×10 L',
    guestCount: 30,
    freeSyrupLiters: 1,
    confirmOrder: true,
    ...(machineCodes.length > 1 ? { machineQuantity: machineCodes.length } : {}),
  });
  await setTime(processId, 'Abholung / Ausgabe', fillAt(berlinDayPlus(1), 9));
  await setTime(processId, 'Rückgabe', fillAt(berlinDayPlus(3), 11));
  await staff.goto(`/vorgaenge/${processId}/ausgabe`);
  for (const [index, code] of machineCodes.entries()) {
    await assignViaSuggestion(index + 1, code);
  }
  for (const addition of options.additions ?? []) {
    const note = staff.getByTestId('delivery-note');
    const option = note.locator('#addition-product option', { hasText: addition.name });
    await note.locator('#addition-product').selectOption((await option.getAttribute('value'))!);
    await note.getByLabel('Zusatzmenge').fill(String(addition.quantity));
    await note.getByRole('button', { name: 'Zusatzposition hinzufügen' }).click();
    await expect(staff.getByText(/Zusatzposition mit aktuellem Preis gespeichert/)).toBeVisible();
  }
  await staff.goto(`/vorgaenge/${processId}/uebergabe`);
  await next(); // 1 Vorgang
  await next(); // 2 Maschinen
  await next(); // 3 Artikel
  for (let slot = 1; slot <= machineCodes.length; slot += 1) {
    const check = staff.getByTestId(`check-${slot}`);
    await check.getByRole('button', { name: 'Maschine gemeinsam geprüft' }).click();
    await expect(check).toContainText('✓ Maschine gemeinsam geprüft');
    await staff
      .getByTestId(`photo-input-${slot}`)
      .setInputFiles({ name: 'gesamtfoto.png', mimeType: 'image/png', buffer: PNG_1X1 });
    await expect(check.locator('img.photo-thumb')).toHaveCount(1);
  }
  await next(); // 4 → 5
  await staff.getByRole('button', { name: 'Übernehmen', exact: true }).click();
  await expect(staff.getByText('Empfangsperson gespeichert.')).toBeVisible();
  await next(); // 5 → 6
  await next(); // 6 → 7
  await sign('Kunde');
  await expect(staff.getByText(/✓ Unterschrieben von/)).toBeVisible();
  await next();
  await sign('Mitarbeiter');
  await expect(staff.getByText(/✓ Unterschrieben von Erika E2E/)).toBeVisible();
  await next();
  await staff.getByTestId('finalize-button').click();
  await expect(staff.getByText(/✓ Übergabe abgeschlossen am/)).toBeVisible();
  return { processId, processNumber };
}

/** Rückgabe-Wizard öffnen und starten (Schritt 1 sichtbar). */
async function openReturn(processId: string) {
  await staff.goto(`/vorgaenge/${processId}/rueckgabe`);
  const start = staff.getByTestId('return-start');
  const stepOne = staff.getByRole('heading', { name: '1. Vorgang und Rückgabeperson' });
  // Seite lädt zuerst („Lade …“) – auf einen der beiden Zustände warten.
  await expect(start.or(stepOne).first()).toBeVisible();
  if ((await start.count()) > 0) {
    await start.click();
    await expect(staff.getByText('Rückgabe begonnen.')).toBeVisible();
  }
  await expect(stepOne).toBeVisible();
}

/** Schritt 1–2: Rückgabeperson Kunde, Maschinen bestätigen. */
async function returnerAndMachines() {
  await staff.getByTestId('returner-save').click();
  await expect(staff.getByText('Rückgabeperson übernommen.')).toBeVisible();
  await next();
  await expect(staff.getByRole('heading', { name: '2. Maschinen bestätigen' })).toBeVisible();
  await next();
}

async function accessoriesComplete(slots: number) {
  await expect(staff.getByRole('heading', { name: '3. Zubehör prüfen' })).toBeVisible();
  for (let slot = 1; slot <= slots; slot += 1) {
    await staff.getByTestId(`accessory-complete-${slot}`).click();
    await expect(staff.getByTestId(`accessory-${slot}`)).toContainText('✓ Zubehör vollständig');
  }
  await next();
}

async function cleanlinessOk(slots: number) {
  await expect(
    staff.getByRole('heading', { name: '4. Rückgabevorbereitung des Kunden' }),
  ).toBeVisible();
  for (let slot = 1; slot <= slots; slot += 1) {
    await staff.getByTestId(`cleanliness-confirm-${slot}`).click();
    await expect(staff.getByTestId(`cleanliness-${slot}`)).toContainText(
      'Ordnungsgemäß vorbereitet',
    );
  }
  await next();
}

async function signAndFinalize(expectWithoutComplaint: boolean) {
  await expect(staff.getByRole('heading', { name: '7. Zusammenfassung' })).toBeVisible();
  if (expectWithoutComplaint) {
    await expect(staff.getByTestId('return-summary')).toContainText('Rückgabe ohne Beanstandung');
  } else {
    await expect(staff.getByTestId('return-summary')).not.toContainText(
      'Rückgabe ohne Beanstandung',
    );
  }
  await next();
  await expect(
    staff.getByRole('heading', { name: '8. Unterschrift Kunde / Vertreter' }),
  ).toBeVisible();
  await sign('Kunde');
  await expect(staff.getByText(/✓ Unterschrieben von/)).toBeVisible();
  await next();
  await expect(staff.getByRole('heading', { name: '9. Unterschrift Mitarbeiter' })).toBeVisible();
  await sign('Mitarbeiter');
  await expect(staff.getByText(/✓ Unterschrieben von Erika E2E/)).toBeVisible();
  await next();
  await expect(staff.getByRole('heading', { name: '10. Rückgabe abschließen' })).toBeVisible();
  const finalize = staff.getByTestId('finalize-button');
  await expect(finalize).toBeEnabled();
  await finalize.click();
  await expect(staff.getByText(/✓ Rückgabe abgeschlossen am/)).toBeVisible();
  const final = staff.getByTestId('wizard-final');
  await expect(final.getByRole('link', { name: 'Rückgabeprotokoll' })).toHaveCount(1);
  return (await final.getByRole('link', { name: 'Rückgabeprotokoll' }).getAttribute('href'))!;
}

// ── A/B/C ────────────────────────────────────────────────────────────────

test('A: Login → Rückgabeliste → ausgegebenen Vorgang öffnen → Maschinen sichtbar', async () => {
  test.setTimeout(300_000);
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await ensureInitialStock('sirup-kirsche', 'Sirup Kirsche', 10);
  await ensureInitialStock('sirup-waldmeister', 'Sirup Waldmeister', 10);
  await ensureInitialStock('strohhalme-25', 'Strohhalme (25 Stück)', 20);
  await ensureInitialStock('becher-25', 'Becher (25 Stück)', 40);
  ({ processId: processB, processNumber: numberB } = await issuedBooking(
    'Rita',
    'Rückgabe',
    'rita@e2e.example',
    ['MR-10-01-01'],
  ));
  await staff.getByRole('link', { name: 'Rückgabe', exact: true }).click();
  await expect(staff.getByRole('heading', { name: 'Rückgabe', exact: true })).toBeVisible();
  const card = staff.getByTestId(`return-${numberB}`);
  await expect(card).toContainText('Rückgabe, Rita');
  await expect(card).toContainText('MR-10-01-01');
  await expect(staff.getByRole('heading', { name: 'Rückgaben der kommenden Tage' })).toBeVisible();
  await card.click();
  await expect(staff.getByRole('heading', { name: 'Rückgabe', exact: true })).toBeVisible();
  await staff.getByTestId('return-start').click();
  await expect(staff.getByText('Rückgabe begonnen.')).toBeVisible();
  await expect(staff.getByText('Ausgegebene Maschinen: MR-10-01-01')).toBeVisible();
  // Schritt 1 ist erst nach Übernahme der Rückgabeperson abschließbar.
  await expect(staff.getByTestId('wizard-next')).toBeDisabled();
  await staff.getByTestId('returner-save').click();
  await expect(staff.getByText('Rückgabeperson übernommen.')).toBeVisible();
  await next();
  await expect(staff.getByRole('heading', { name: '2. Maschinen bestätigen' })).toBeVisible();
  await expect(staff.getByTestId('return-machine-1')).toContainText('MR-10-01-01');
  await expect(staff.getByTestId('return-machine-1')).toContainText('Vermietet');
});

test('B: Normale Rückgabe: Zubehör vollständig → entleert/gespült/nichts demontiert → Kommission → keine Schäden → unterschreiben → „Rückgabe ohne Beanstandung“ → finalisieren', async () => {
  test.setTimeout(180_000);
  await openReturn(processB);
  await returnerAndMachines();
  await accessoriesComplete(1);
  await cleanlinessOk(1);
  await expect(staff.getByRole('heading', { name: '5. Kommissionsrückgabe' })).toBeVisible();
  await next();
  await expect(staff.getByRole('heading', { name: '6. Schäden dokumentieren' })).toBeVisible();
  await expect(staff.getByTestId('damages-1')).toContainText('Kein neuer Schaden erfasst.');
  await next();
  const href = await signAndFinalize(true);
  const text = pdfText(await fetchPdfBytes(href));
  expect(text).toContain('Rückgabeprotokoll');
  expect(text).toContain('Rückgabe ohne Beanstandung.');
  expect(text).toContain('Maschine MR-10-01-01');
});

test('C: Danach: Maschine Reinigung → Standort Lager → Rückgabetermin erledigt → Vorgang weiterhin offen → Rückgabeprotokoll vorhanden', async () => {
  await staff.goto('/maschinen');
  await expect(staff.getByTestId('machine-MR-10-01-01')).toContainText('Reinigung');
  await staff.getByTestId('machine-MR-10-01-01').getByRole('link').first().click();
  await expect(staff.locator('.badge', { hasText: 'Reinigung' })).toBeVisible();
  await expect(staff.getByText('Standort: Lager')).toBeVisible();
  await expect(staff.getByTestId('cleaning-card')).toContainText('In Reinigung seit');

  await staff.goto(`/vorgaenge/${processB}/termine`);
  await expect(
    staff
      .locator('.entry-row', { hasText: 'Rückgabe' })
      .locator('.badge', { hasText: 'Abgeschlossen' }),
  ).toBeVisible();

  await staff.goto(`/vorgaenge/${processB}`);
  await expect(staff.locator('.badge', { hasText: 'Offen' }).first()).toBeVisible();
  const card = staff.getByTestId('process-return');
  await expect(card).toContainText('abgeschlossen am');
  await expect(card.getByRole('link', { name: 'Rückgabeprotokoll' })).toHaveCount(1);
  await expect(staff.getByText('Rückgabe abgeschlossen')).toBeVisible();
});

// ── D: Kommission ────────────────────────────────────────────────────────

test('D: Kommission: mehrere Extra-Sirupflaschen ausgegeben → ungeöffnete Rückgabe → chargeable korrekt → Bestand steigt', async () => {
  test.setTimeout(300_000);
  ({ processId: processD } = await issuedBooking(
    'Karl',
    'Kommission',
    'karl@e2e.example',
    ['MR-10-01-02'],
    {
      additions: [{ name: 'Waldmeister', quantity: 3 }],
    },
  ));
  const before = await stockOf('sirup-waldmeister');
  await openReturn(processD);
  await returnerAndMachines();
  await accessoriesComplete(1);
  await cleanlinessOk(1);
  await expect(staff.getByRole('heading', { name: '5. Kommissionsrückgabe' })).toBeVisible();
  const row = staff.locator('[data-testid^="return-item-"]', { hasText: 'Waldmeister' });
  await expect(row).toContainText('Kommission');
  await expect(row).toContainText('Ausgegeben: 3');
  await expect(row).toContainText('verbraucht/abrechenbar: 3');
  await row.getByLabel('Ungeöffnet zurück').fill('2');
  await row.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(staff.getByText('Rückgabemenge übernommen.')).toBeVisible();
  await expect(row).toContainText('verbraucht/abrechenbar: 1');
  await expect(row).toContainText('12,00 €');
  await next();
  await next();
  // Verbrauchte Kommission ist ein Fakt, keine Beanstandung (§41).
  const href = await signAndFinalize(true);
  const text = pdfText(await fetchPdfBytes(href));
  expect(text).toContain('ausgegeben 3');
  expect(text).toContain('ungeöffnet zurück 2');
  expect(text).toContain('verbraucht/abrechenbar 1');
  expect(text).not.toContain('Rechnungsnummer');
  expect(await stockOf('sirup-waldmeister')).toBe(before + 2);
});

// ── E: Reinigungsfall ────────────────────────────────────────────────────

test('E: Reinigungsfall: nicht ordentlich vorbereitet → Foto Pflicht → 75-€-Fakt sichtbar → Return finalisierbar', async () => {
  test.setTimeout(300_000);
  const { processId } = await issuedBooking('Rudi', 'Reinigung', 'rudi@e2e.example', [
    'MR-10-01-03',
  ]);
  await openReturn(processId);
  await returnerAndMachines();
  await accessoriesComplete(1);
  await expect(
    staff.getByRole('heading', { name: '4. Rückgabevorbereitung des Kunden' }),
  ).toBeVisible();
  await staff.getByTestId('clean-emptied-1').uncheck();
  await staff.getByTestId('cleanliness-confirm-1').click();
  const fact = staff.getByTestId('cleanup-fact-1');
  await expect(fact).toContainText('Reinigungsgebühr-Fakt: 75,00 €');
  await expect(fact).toContainText('nicht entleert');
  await expect(fact).toContainText('fehlt (Pflicht)');
  await expect(staff.getByTestId('wizard-next')).toBeDisabled();
  await staff
    .getByTestId('cleanup-photo-input-1')
    .setInputFiles({ name: 'reinigung.jpg', mimeType: 'image/jpeg', buffer: JPEG_1X1 });
  await expect(staff.getByText('Beweisfoto gespeichert.')).toBeVisible();
  await expect(fact).toContainText('1 vorhanden');
  await expect(staff.getByTestId('wizard-next')).toBeEnabled();
  await next();
  await next(); // Kommission
  await next(); // Schäden
  await expect(staff.getByTestId('return-summary')).toContainText('Reinigungsgebühr-Fakt 75,00 €');
  const href = await signAndFinalize(false);
  const text = pdfText(await fetchPdfBytes(href));
  expect(text).toContain('Reinigungsgebühr-Fakt: 75,00');
  expect(text).toContain('nicht entleert');
});

// ── F: Schaden ───────────────────────────────────────────────────────────

test('F: Schaden: Schema markieren → mittel → Beschreibung → Foto → Zusammenfassung → unterschreiben → Return-PDF enthält Schaden', async () => {
  test.setTimeout(300_000);
  const { processId } = await issuedBooking('Dora', 'Delle', 'dora@e2e.example', ['MR-10-01-04']);
  await openReturn(processId);
  await returnerAndMachines();
  await accessoriesComplete(1);
  await cleanlinessOk(1);
  await next(); // Kommission
  await expect(staff.getByRole('heading', { name: '6. Schäden dokumentieren' })).toBeVisible();
  await staff.getByTestId('damage-add-1').click();
  const form = staff.getByTestId('damage-form-1');
  await expect(staff.getByTestId('damage-save')).toBeDisabled();
  await staff.getByTestId('damage-diagram-view-left').click();
  const svg = staff.getByTestId('damage-diagram-svg');
  // Klick relativ zum Schema (scrollt in den sichtbaren Bereich).
  await clickDiagram(svg, 0.4, 0.3);
  await expect(staff.getByTestId('damage-diagram-marker-0')).toBeVisible();
  await expect(staff.getByTestId('damage-diagram-view-left')).toContainText('(1)');
  await form.locator('#damage-severity').selectOption('medium');
  await form.locator('#damage-description').fill('Delle links am Gehäuse');
  await staff.getByTestId('damage-save').click();
  await expect(staff.getByText(/Schaden gespeichert/)).toBeVisible();
  const damage = staff.locator('.conflict-box', { hasText: 'Delle links am Gehäuse' }).first();
  await expect(damage).toContainText('mittel');
  await expect(damage).toContainText('Mindestens ein Foto ist Pflicht.');
  await expect(staff.getByTestId('wizard-next')).toBeDisabled();
  await staff
    .locator('input[data-testid^="damage-photo-input-"]')
    .setInputFiles({ name: 'schaden.jpg', mimeType: 'image/jpeg', buffer: JPEG_1X1 });
  await expect(staff.getByText('Schadensfoto gespeichert.')).toBeVisible();
  await expect(staff.getByTestId('wizard-next')).toBeEnabled();
  await next();
  await expect(staff.getByTestId('return-summary')).toContainText('Delle links am Gehäuse');
  await expect(staff.getByTestId('return-summary')).toContainText(
    'finanzielle Klärung erforderlich',
  );
  const href = await signAndFinalize(false);
  const bytes = await fetchPdfBytes(href);
  const text = pdfText(bytes);
  expect(text).toContain('Neue Schäden: 1');
  expect(text).toContain('Schweregrad: mittel');
  expect(text).toContain('Delle links am Gehäuse');
  // Schadensfoto eingebettet: 2 Unterschriften + 1 Foto (codec-unabhängig gezählt).
  expect(imageObjectCount(bytes)).toBe(3);
});

// ── G: Mehrere Maschinen ─────────────────────────────────────────────────

test('G: Mehrere Maschinen: je Zubehör-/Reinigungsprüfung → Schaden nur an einer → EIN kombiniertes Rückgabe-PDF', async () => {
  test.setTimeout(360_000);
  const { processId } = await issuedBooking('Zwei', 'Maschinen', 'zwei@e2e.example', [
    'MR-10-01-05',
    'MR-10-01-06',
  ]);
  await openReturn(processId);
  await returnerAndMachines();
  await accessoriesComplete(2);
  await cleanlinessOk(2);
  await next(); // Kommission
  await staff.getByTestId('damage-add-2').click();
  const svg = staff.getByTestId('damage-diagram-svg');
  // Klick relativ zum Schema (scrollt in den sichtbaren Bereich).
  await clickDiagram(svg, 0.5, 0.5);
  await staff.locator('#damage-description').fill('Kratzer an Maschine zwei');
  await staff.getByTestId('damage-save').click();
  await expect(staff.getByText(/Schaden gespeichert/)).toBeVisible();
  await staff
    .locator('input[data-testid^="damage-photo-input-"]')
    .setInputFiles({ name: 'schaden.jpg', mimeType: 'image/jpeg', buffer: JPEG_1X1 });
  await expect(staff.getByText('Schadensfoto gespeichert.')).toBeVisible();
  await next();
  const href = await signAndFinalize(false);
  await expect(
    staff.getByTestId('wizard-final').getByRole('link', { name: 'Rückgabeprotokoll' }),
  ).toHaveCount(1);
  const text = pdfText(await fetchPdfBytes(href));
  expect(text).toContain('Maschine MR-10-01-05');
  expect(text).toContain('Maschine MR-10-01-06');
  expect(text).toContain('Kratzer an Maschine zwei');
  expect((text.match(/Neue Schäden: keine/g) ?? []).length).toBe(1);
  expect((text.match(/Neue Schäden: 1/g) ?? []).length).toBe(1);
});

// ── H: Fehlteil ──────────────────────────────────────────────────────────

test('H: Fehlteil: Deckel fehlt → im Protokoll → Return abschließbar → Follow-up offen → später „Erledigt“', async () => {
  test.setTimeout(300_000);
  const { processId } = await issuedBooking(
    'Fritz',
    'Fehlteil',
    'fritz@e2e.example',
    ['MR-10-02-01'],
    {
      machineLabel: '2×10 L',
    },
  );
  await openReturn(processId);
  await returnerAndMachines();
  await expect(staff.getByTestId('accessory-1')).toContainText(
    'Soll: 2 × Deckel, 2 × Tropfschalen',
  );
  await staff.getByRole('button', { name: 'Fehlteil erfassen' }).click();
  const form = staff.getByTestId('missing-form-1');
  await form.locator('#missing-type').selectOption('lid');
  await form.locator('#missing-qty').fill('1');
  await form.locator('#missing-note').fill('Deckel nicht mitgebracht');
  await staff.getByTestId('missing-save').click();
  await expect(staff.getByText(/Fehlteil erfasst/)).toBeVisible();
  await expect(staff.getByTestId('accessory-1')).toContainText('1 × Deckel');
  await expect(staff.getByTestId('accessory-complete-1')).toHaveCount(0);
  await next();
  await cleanlinessOk(1);
  await next(); // Kommission
  await next(); // Schäden
  await expect(staff.getByTestId('return-summary')).toContainText(
    'Fehlteil MR-10-02-01: 1 × Deckel',
  );
  const href = await signAndFinalize(false);
  const text = pdfText(await fetchPdfBytes(href));
  expect(text).toContain('Fehlteile: 1 × Deckel');
  expect(text).toContain('finanzielle Klärung später erforderlich');

  await staff.goto('/');
  await expect(staff.getByTestId('missing-items-warning')).toContainText('Offene Fehlteile: 1');
  await staff.getByTestId('missing-items-warning').getByRole('link').click();
  const cases = staff.getByTestId('open-missing-cases');
  await expect(cases).toContainText('1 × Deckel');
  await cases.getByRole('button', { name: 'Erledigt' }).click();
  await expect(staff.getByText('Fehlteil erledigt.')).toBeVisible();
  await expect(staff.getByTestId('open-missing-cases')).toHaveCount(0);
});

// ── I: Reinigung ─────────────────────────────────────────────────────────

test('I: Reinigung: Return abgeschlossen → Reinigung → „Gereinigt & einsatzbereit“ → grün Einsatzbereit', async () => {
  await staff.goto('/maschinen');
  await staff.getByTestId('machine-MR-10-01-01').getByRole('link').first().click();
  await expect(staff.getByTestId('cleaning-card')).toBeVisible();
  await expect(staff.getByTestId('cleaning-card')).not.toContainText('länger als 24 Stunden');
  // Zeitabhängige rote 24-h-Warnung (Order §53): Reinigungsbeginn 25 h zurücksetzen.
  backdateCleaning('MR-10-01-01', 25);
  await staff.reload();
  const overdueCard = staff.getByTestId('cleaning-card');
  await expect(overdueCard).toContainText('länger als 24 Stunden');
  await expect(overdueCard).toHaveClass(/cleaning-warning/);
  await staff.goto('/');
  const heuteWarning = staff.getByTestId('cleaning-warning');
  await expect(heuteWarning).toContainText('MR-10-01-01');
  await expect(heuteWarning).toHaveClass(/warning-red/);
  await staff.goto('/maschinen');
  await staff.getByTestId('machine-MR-10-01-01').getByRole('link').first().click();
  await staff.getByTestId('clean-complete-button').click();
  await expect(staff.getByText('Maschine ist gereinigt und einsatzbereit.')).toBeVisible();
  await expect(staff.locator('.badge', { hasText: 'Einsatzbereit' })).toBeVisible();
  await expect(staff.getByTestId('cleaning-card')).toHaveCount(0);
  await expect(staff.getByTestId('cleaned-meta')).toContainText('Zuletzt gereinigt am');
  await staff.goto('/maschinen');
  await expect(staff.getByTestId('machine-MR-10-01-01')).toContainText('🟢');
  await staff.goto('/');
  await expect(staff.getByTestId('cleaning-warning')).toHaveCount(0);
});

// ── J: Nachträgliche Feststellung ────────────────────────────────────────

test('J: post-return: Return final → Maschine noch Reinigung → späteren Schaden ergänzen → PDF unverändert → reinigen → weiterer Kundenschaden blockiert', async () => {
  test.setTimeout(180_000);
  processJ = processD; // MR-10-01-02 ist seit Szenario D in Reinigung
  await staff.goto(`/vorgaenge/${processJ}`);
  returnDocJ = (await staff
    .getByTestId('process-return')
    .getByRole('link', { name: 'Rückgabeprotokoll' })
    .getAttribute('href'))!;
  const before = await fetchPdfBytes(returnDocJ);

  await staff.goto('/maschinen');
  await staff.getByTestId('machine-MR-10-01-02').getByRole('link').first().click();
  await expect(staff.getByTestId('current-damages')).toContainText('Keine aktuellen Schäden.');
  await staff.getByTestId('post-return-damage-open').click();
  const svg = staff.getByTestId('finding-diagram-svg');
  // Klick relativ zum Schema (scrollt in den sichtbaren Bereich).
  await clickDiagram(svg, 0.3, 0.7);
  await staff.locator('#finding-severity').selectOption('light');
  await staff.locator('#finding-description').fill('Nachträglich entdeckter Kratzer');
  await staff
    .getByTestId('finding-photo-input')
    .setInputFiles({ name: 'nachtrag.jpg', mimeType: 'image/jpeg', buffer: JPEG_1X1 });
  await staff.getByTestId('finding-save').click();
  await expect(staff.getByText(/Nachträglicher Schaden dokumentiert/)).toBeVisible();
  await expect(staff.getByTestId('current-damages')).toContainText(
    'Nachträglich entdeckter Kratzer',
  );
  await expect(staff.getByTestId('current-damages')).toContainText('nachträglich festgestellt');

  const after = await fetchPdfBytes(returnDocJ);
  expect(after.equals(before)).toBe(true);

  const machineIdJ = staff.url().split('/maschinen/')[1]!.split(/[/?#]/)[0]!;
  await staff.getByTestId('clean-complete-button').click();
  await expect(staff.getByText('Maschine ist gereinigt und einsatzbereit.')).toBeVisible();
  await expect(staff.getByTestId('post-return-damage')).toHaveCount(0);
  // Keine Security-by-UI: der Server lehnt einen weiteren Kundenschaden zum alten Return ab.
  const blocked = await staff.request.post(`/api/staff/machines/${machineIdJ}/damages`, {
    data: {
      severity: 'light',
      description: 'Nach der Reinigung gemeldet',
      markers: [{ view: 'front', markerType: 'point', x: 0.5, y: 0.5, width: null, height: null }],
      photo: { mimeType: 'image/jpeg', dataBase64: JPEG_1X1.toString('base64') },
    },
  });
  expect(blocked.status()).toBe(409);
  await staff.reload();
  await expect(staff.getByTestId('current-damages')).toContainText(
    'Nachträglich entdeckter Kratzer',
  );
  await expect(staff.getByTestId('current-damages')).not.toContainText(
    'Nach der Reinigung gemeldet',
  );
});

// ── K: Bestehender Schaden bei erneuter Ausgabe ──────────────────────────

test('K: Bestehender Schaden: Maschine mit aktuellem Schaden erneut ausgeben → Handover zeigt bestehenden Schaden → alte Fotos nicht kundenöffentlich', async () => {
  test.setTimeout(300_000);
  const { processId } = await issuedBooking('Karla', 'Kunde', 'karla@e2e.example', ['MR-10-01-02']);
  await staff.goto(`/vorgaenge/${processId}/uebergabe`);
  const href = await staff
    .getByTestId('wizard-final')
    .getByRole('link', { name: 'Übergabeprotokoll' })
    .getAttribute('href');
  const bytes = await fetchPdfBytes(href!);
  const text = pdfText(bytes);
  expect(text).toContain('Bestehende Schäden');
  expect(text).toContain('leicht: Nachträglich entdeckter Kratzer');
  expect(text).toContain('Schweregrad: leicht');
  // Keine alten Schadensfotos im Kunden-PDF: nur die 2 Unterschriften (Gesamtfotos bleiben intern).
  expect(imageObjectCount(bytes)).toBe(2);
});
