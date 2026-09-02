/**
 * Phase-4-E2E-Szenarien A–G (Order §48):
 * A Buchung → Terminplanung → Zeiten setzen → Termin im Kalender sichtbar.
 * B Offener Termin → Mitarbeiter zuweisen → Vorschau → verschieben →
 *   Bestätigungsdialog → neue Zeit sichtbar.
 * C Zwei überlappende Termine desselben Mitarbeiters → rotes Warnsymbol →
 *   Begründung → „Konflikt gelöst“ → Warnung verschwindet.
 * D Relevante Zeitänderung → Konflikt darf wieder erscheinen (neuer
 *   Fingerprint).
 * E Vertretung → Termine erscheinen bei „Meine Termine“ der Vertretung →
 *   Vertretung endet → Zuordnung fällt zurück.
 * F Überfällige Rückgabe ganz oben in „Heute“ → „Kunde kontaktiert“ →
 *   neue Rückgabezeit mit Bestätigung → nicht mehr überfällig.
 * G Same-Day-Umzuweisung → neuer Mitarbeiter meldet sich an → „Termin
 *   übernommen“ → Bestätigung sichtbar abgeschlossen.
 *
 * Nutzt die im Commerce-Spec angelegten, verbindlich angenommenen Buchungen
 * (Paula Partyfee, Willi Wechsel). Zeit-Eingaben der Staff-App gelten als
 * Europe-Berlin-Wanduhrzeit – die Erwartungen rechnen deshalb komplett in
 * Berliner Kalendertagen/Uhrzeiten. Ausschließlich synthetische Testdaten.
 */
import { expect, test, type Page } from '@playwright/test';

const ADMIN_EMAIL = 'admin@e2e.example';
const ADMIN_PASSWORD = 'e2e-admin-passwort-1';
const SELLER_EMAIL = 'verkauf@e2e.example';
const SELLER_PASSWORD = 'e2e-verkauf-passwort-1';

test.describe.configure({ mode: 'serial' });

let staff: Page; // Erika (Admin)
let viktor: Page; // Viktor (Verkauf, calendar.view)
let processIdPaula = '';

test.beforeAll(async ({ browser }) => {
  staff = await browser.newPage();
  viktor = await browser.newPage();
});
test.afterAll(async () => {
  await staff.close();
  await viktor.close();
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

/** Aktueller Berliner Kalendertag/Uhrzeit. */
function berlinNow(): { dayIso: string; hour: number; minute: number } {
  const text = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date());
  const match = /^(\d{4}-\d{2}-\d{2}),? (\d{2}):(\d{2})$/.exec(text.replace(', ', ' '));
  return { dayIso: match![1]!, hour: Number(match![2]), minute: Number(match![3]) };
}

/** Berliner Kalendertag heute + N Tage (reine Kalenderarithmetik). */
function berlinDayPlus(days: number): string {
  const [y, m, d] = berlinNow().dayIso.split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/** datetime-local-Wert für „Berliner Tag + Uhrzeit“. */
function fillAt(dayIso: string, hour: number, minute = 0): string {
  return `${dayIso}T${pad(hour)}:${pad(minute)}`;
}

/** Kalender öffnen, Tagesansicht, zum Berliner Zieltag blättern. */
async function gotoCalendarDay(page: Page, dayIso: string) {
  await page.goto('/kalender');
  await expect(page.getByRole('heading', { name: 'Kalender' })).toBeVisible();
  await page.getByRole('button', { name: 'Tag', exact: true }).click();
  await page.getByRole('button', { name: 'Heute', exact: true }).click();
  const toUtc = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
  };
  const diff = Math.round((toUtc(dayIso) - toUtc(berlinNow().dayIso)) / 86_400_000);
  for (let i = 0; i < Math.abs(diff); i += 1) {
    await page.getByLabel(diff > 0 ? 'Weiter' : 'Zurück').click();
  }
  await expect(page.getByTestId(`day-${dayIso}`)).toBeVisible();
}

/** Vorgang über die globale Suche öffnen; liefert die Vorgangs-ID. */
async function openProcessViaSearch(page: Page, namePart: string): Promise<string> {
  await page.getByRole('link', { name: 'Suche' }).click();
  await page.getByRole('searchbox').fill(namePart);
  await expect(page.getByRole('heading', { name: 'Vorgänge' })).toBeVisible();
  await page.getByRole('link', { name: /^MR-\d{4}-\d{4,}$/ }).click();
  await expect(page.getByRole('heading', { name: /^MR-\d{4}-\d{4,}$/ })).toBeVisible();
  const match = /\/vorgaenge\/([0-9a-f-]{36})/.exec(page.url());
  expect(match).not.toBeNull();
  return match![1]!;
}

const preview = () => staff.getByTestId('appointment-preview');

/** Zeit im Vorschau-Formular setzen (mit Bestätigungsdialog). */
async function saveTimeInPreview(
  page: Page,
  input: { start: string; end?: string; startLabel?: string; expectDialog?: RegExp },
) {
  const card = page.getByTestId('appointment-preview');
  await card.getByLabel(input.startLabel ?? 'Beginn').fill(input.start);
  await card.getByLabel('Ende (optional, Zeitfenster)').fill(input.end ?? '');
  page.once('dialog', (dialog) => {
    if (input.expectDialog !== undefined) expect(dialog.message()).toMatch(input.expectDialog);
    void dialog.accept();
  });
  await card
    .getByRole('button', {
      name:
        input.startLabel === 'Neue Rückgabezeit'
          ? 'Neue Rückgabezeit vereinbart'
          : 'Zeit speichern',
    })
    .click();
}

// ── Szenario A: Buchung → Terminplanung → Zeiten → Kalender ──────────────

test('A: Terminplanung zeigt Abholung + Rückgabe der bestätigten Buchung (ungeplant)', async () => {
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  processIdPaula = await openProcessViaSearch(staff, 'Partyfee');

  // AB ist versendet → „Nächste Aktion“ führt direkt in die Terminplanung.
  await staff.getByRole('link', { name: 'Terminplanung öffnen' }).click();
  await expect(staff.getByRole('heading', { name: 'Terminplanung' })).toBeVisible();

  // Selbstabholung → Abholung/Ausgabe + Rückgabe, beide ungeplant und ohne
  // Mitarbeiter; interner Standort ist die EXAKTE Abholadresse aus dem Seed.
  const pickupRow = staff.locator('.entry-row', { hasText: 'Abholung / Ausgabe' });
  const returnRow = staff.locator('.entry-row', { hasText: 'Rückgabe' });
  await expect(pickupRow).toBeVisible();
  await expect(returnRow).toBeVisible();
  await expect(pickupRow.locator('.badge', { hasText: 'Zeit festlegen' })).toBeVisible();
  await expect(pickupRow.locator('.badge', { hasText: 'Mitarbeiter zuweisen' })).toBeVisible();
  await expect(pickupRow.getByText(/Teststraße 1/)).toBeVisible();
});

test('A: Zeiten setzen (Fenster + exakte Zeit) → Termin im Kalender sichtbar', async () => {
  // Abholung: Zeitfenster morgen 10:00–12:00 (Europe/Berlin).
  await staff.locator('.entry-row', { hasText: 'Abholung / Ausgabe' }).click();
  await expect(
    preview().getByRole('heading', { name: /Abholung \/ Ausgabe · Paula Partyfee/ }),
  ).toBeVisible();
  await saveTimeInPreview(staff, {
    start: fillAt(berlinDayPlus(1), 10),
    end: fillAt(berlinDayPlus(1), 12),
    expectDialog: /Terminzeit wirklich ändern\?/,
  });
  const windowLabel = '10:00–12:00 Uhr';
  await expect(
    staff.locator('.entry-row', { hasText: 'Abholung / Ausgabe' }).getByText(windowLabel),
  ).toBeVisible();
  await expect(
    staff
      .locator('.entry-row', { hasText: 'Abholung / Ausgabe' })
      .locator('.badge', { hasText: 'Zeit festlegen' }),
  ).toHaveCount(0);
  await preview().getByLabel('Vorschau schließen').click();

  // Rückgabe: exakte Zeit in 3 Tagen, 11:00 – KEIN erfundenes Zeitfenster.
  await staff.locator('.entry-row', { hasText: 'Rückgabe' }).click();
  await saveTimeInPreview(staff, { start: fillAt(berlinDayPlus(3), 11) });
  await expect(
    staff.locator('.entry-row', { hasText: 'Rückgabe' }).getByText('11:00 Uhr'),
  ).toBeVisible();

  // Kalender (Tagesansicht, morgen): der Abhol-Termin ist sichtbar.
  await gotoCalendarDay(staff, berlinDayPlus(1));
  const chip = staff.locator('.calendar-chip', { hasText: 'Paula Partyfee' });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Abholung / Ausgabe');
  await expect(chip).toContainText(windowLabel);
});

// ── Szenario B: zuweisen → Vorschau → verschieben mit Bestätigung ────────

test('B: Mitarbeiter zuweisen und Termin mit Bestätigungsdialog verschieben', async () => {
  await staff.locator('.calendar-chip', { hasText: 'Paula Partyfee' }).click();
  await expect(preview()).toBeVisible();

  // Erstzuweisung (keine Umzuweisung → keine Übernahmebestätigung).
  await preview().getByLabel('Mitarbeiter zuweisen').selectOption({ label: 'E2E, Erika' });
  await preview().getByRole('button', { name: 'Zuweisen' }).click();
  await expect(preview().getByText('Mitarbeiter: Erika E2E')).toBeVisible();
  await expect(preview().getByText('Übernahmebestätigung ausstehend')).toHaveCount(0);

  // Verschieben auf übermorgen 10:00–12:00 – kurzer Bestätigungsdialog.
  await saveTimeInPreview(staff, {
    start: fillAt(berlinDayPlus(2), 10),
    end: fillAt(berlinDayPlus(2), 12),
    expectDialog: /Terminzeit wirklich ändern\?/,
  });

  // Neue Zeit liegt am neuen Tag im Kalender.
  await gotoCalendarDay(staff, berlinDayPlus(2));
  const moved = staff.locator('.calendar-chip', { hasText: 'Paula Partyfee' });
  await expect(moved).toBeVisible();
  await expect(moved).toContainText('10:00–12:00 Uhr');
});

// ── Szenario C: Doppelbelegung → Warnsymbol → Begründung → gelöst ────────

test('C: Überlappende Termine desselben Mitarbeiters erzeugen einen sichtbaren Konflikt', async () => {
  await openProcessViaSearch(staff, 'Wechsel');
  await staff.getByRole('link', { name: 'Terminplanung', exact: true }).click();
  await expect(staff.getByRole('heading', { name: 'Terminplanung' })).toBeVisible();

  // Willis Abholung: exakte Zeit übermorgen 10:30 – mitten in Paulas Fenster.
  await staff.locator('.entry-row', { hasText: 'Abholung / Ausgabe' }).click();
  await saveTimeInPreview(staff, { start: fillAt(berlinDayPlus(2), 10, 30) });
  await preview().getByLabel('Mitarbeiter zuweisen').selectOption({ label: 'E2E, Erika' });
  await preview().getByRole('button', { name: 'Zuweisen' }).click();
  await expect(preview().getByText('Mitarbeiter: Erika E2E')).toBeVisible();

  // Kalender: Warnsymbol + dezente rote Umrandung – Termin bleibt farblich normal.
  await gotoCalendarDay(staff, berlinDayPlus(2));
  const willi = staff.locator('.calendar-chip', { hasText: 'Willi Wechsel' });
  await expect(willi).toBeVisible();
  await expect(willi.locator('.conflict-icon')).toBeVisible();
  await expect(willi).toHaveClass(/chip-conflict-strong/);

  // Antippen → Begründung; „Konflikt gelöst“ entfernt die Warnung.
  await willi.click();
  await expect(
    preview().getByText(
      'Doppelbelegung: Derselbe Mitarbeiter ist für zwei zeitlich überlappende Termine eingeteilt.',
    ),
  ).toBeVisible();
  await preview().getByRole('button', { name: 'Konflikt gelöst' }).click();
  await expect(preview().getByText(/Doppelbelegung/)).toHaveCount(0);
  await expect(willi.locator('.conflict-icon')).toHaveCount(0);
});

// ── Szenario D: relevante Zeitänderung → Konflikt darf wieder erscheinen ─

test('D: Nach relevanter Zeitänderung erscheint der Konflikt erneut (neuer Fingerprint)', async () => {
  // Willis Abholung bleibt in Paulas Fenster, aber zu NEUER Zeit (11:00).
  await saveTimeInPreview(staff, {
    start: fillAt(berlinDayPlus(2), 11),
    expectDialog: /Terminzeit wirklich ändern\?/,
  });
  await expect(preview().getByText(/Doppelbelegung/)).toBeVisible();
  await expect(
    staff.locator('.calendar-chip', { hasText: 'Willi Wechsel' }).locator('.conflict-icon'),
  ).toBeVisible();
});

// ── Szenario E: Vertretung wirkt in „Meine Termine“ und endet sauber ─────

test('E: Vertretung anlegen → Termine bei der Vertretung → vorzeitig beenden', async () => {
  // Admin trägt die Vertretung Erika → Viktor ein (ab jetzt, 3 Tage).
  await staff.goto('/mitarbeiter');
  await expect(staff.getByRole('heading', { name: 'Vertretungen' })).toBeVisible();
  await staff.getByLabel('Ursprünglicher Mitarbeiter').selectOption({ label: 'E2E, Erika' });
  await staff.getByLabel('Vertretung', { exact: true }).selectOption({ label: 'Verkauf, Viktor' });
  const nowBerlin = berlinNow();
  await staff.getByLabel('Beginn').fill(fillAt(nowBerlin.dayIso, nowBerlin.hour, nowBerlin.minute));
  await staff.getByLabel('Ende', { exact: true }).fill(fillAt(berlinDayPlus(3), 23));
  await staff.getByRole('button', { name: 'Vertretung eintragen' }).click();
  const subRow = staff
    .locator('.list-row', { hasText: 'Erika E2E' })
    .filter({ hasText: 'Viktor Verkauf' });
  await expect(subRow.locator('.badge', { hasText: 'Aktiv' })).toBeVisible();

  // Viktor (nur calendar.view) sieht Erikas Termine jetzt unter „Meine Termine“.
  await login(viktor, SELLER_EMAIL, SELLER_PASSWORD, 'Viktor');
  await gotoCalendarDay(viktor, berlinDayPlus(2));
  const viktorChip = viktor.locator('.calendar-chip', { hasText: 'Paula Partyfee' });
  await expect(viktorChip).toBeVisible();

  // Vorschau weist die Vertretung aus.
  await viktorChip.click();
  await expect(
    viktor.getByTestId('appointment-preview').getByText('Mitarbeiter: Viktor Verkauf'),
  ).toBeVisible();
  await expect(
    viktor.getByTestId('appointment-preview').getByText('(Vertretung für Erika E2E)'),
  ).toBeVisible();

  // Ein Klick beendet die Vertretung vorzeitig – die Zuordnung fällt zurück.
  await subRow.getByRole('button', { name: 'Jetzt beenden' }).click();
  await expect(subRow.locator('.badge', { hasText: 'Beendet' })).toBeVisible();
  await gotoCalendarDay(viktor, berlinDayPlus(2));
  await expect(viktor.locator('.calendar-chip', { hasText: 'Paula Partyfee' })).toHaveCount(0);
});

// ── Szenario F: überfällige Rückgabe in „Heute“ → Kontakt → neue Zeit ────

test('F: Überfällige Rückgabe steht ganz oben in „Heute“ und wird sauber aufgelöst', async () => {
  // Rückgabezeit in die Vergangenheit legen (gestern) – Termin wird überfällig.
  await staff.goto(`/vorgaenge/${processIdPaula}/termine`);
  await staff.locator('.entry-row', { hasText: 'Rückgabe' }).click();
  await saveTimeInPreview(staff, {
    start: fillAt(berlinDayPlus(-1), 11),
    expectDialog: /Terminzeit wirklich ändern\?/,
  });
  await expect(
    staff
      .locator('.entry-row', { hasText: 'Rückgabe' })
      .locator('.badge', { hasText: 'Überfällig' }),
  ).toBeVisible();

  // „Heute“: Sektion „Überfällige Rückgaben“ steht ganz oben.
  await staff.goto('/');
  await expect(staff.getByRole('heading', { name: 'Überfällige Rückgaben' })).toBeVisible();
  const sections = staff.locator('main .card h2');
  await expect(sections.first()).toHaveText('Überfällige Rückgaben');
  const overdueRow = staff.locator('.overdue-card .entry-row', { hasText: 'Paula Partyfee' });
  await expect(overdueRow.locator('.badge', { hasText: 'Überfällig' })).toBeVisible();

  // „Kunde kontaktiert“ setzt Flag + Zeitstempel (minimal, keine Historie).
  await overdueRow.click();
  await preview().getByRole('button', { name: 'Kunde kontaktiert' }).click();
  await expect(preview().getByText(/Kunde kontaktiert: /)).toBeVisible();

  // „Neue Rückgabezeit vereinbart“ (morgen 11:00) mit Bestätigungsdialog.
  await saveTimeInPreview(staff, {
    start: fillAt(berlinDayPlus(1), 11),
    startLabel: 'Neue Rückgabezeit',
    expectDialog: /Neue Rückgabezeit verbindlich vereinbaren\?/,
  });
  // Termin ist nicht mehr überfällig; Kundeninformation ist vermerkt.
  await expect(staff.getByRole('heading', { name: 'Überfällige Rückgaben' })).toHaveCount(0);
  await expect(preview().getByText('Kundeninformation erforderlich')).toBeVisible();
  await expect(preview().getByText('Überfällig')).toHaveCount(0);
});

// ── Szenario G: Same-Day-Umzuweisung → „Termin übernommen“ ───────────────

test('G: Same-Day-Umzuweisung verlangt sichtbare Übernahmebestätigung', async () => {
  // Paulas Abholung auf HEUTE legen (Berlin-sicher: vor 23 Uhr +30 min,
  // sonst -30 min – nie über die Tagesgrenze).
  const nowBerlin = berlinNow();
  const total = nowBerlin.hour * 60 + nowBerlin.minute + (nowBerlin.hour < 23 ? 30 : -30);
  const sameDay = fillAt(nowBerlin.dayIso, Math.floor(total / 60), total % 60);
  const sameDayLabel = `${pad(Math.floor(total / 60))}:${pad(total % 60)} Uhr`;

  await staff.goto(`/vorgaenge/${processIdPaula}/termine`);
  await staff.locator('.entry-row', { hasText: 'Abholung / Ausgabe' }).click();
  await saveTimeInPreview(staff, { start: sameDay, expectDialog: /Terminzeit wirklich ändern\?/ });
  await expect(
    staff.locator('.entry-row', { hasText: 'Abholung / Ausgabe' }).getByText(sameDayLabel),
  ).toBeVisible();

  // Umzuweisung Erika → Viktor am selben Tag → Übernahmebestätigung ausstehend.
  await preview().getByLabel('Mitarbeiter zuweisen').selectOption({ label: 'Verkauf, Viktor' });
  await preview().getByRole('button', { name: 'Zuweisen' }).click();
  await expect(preview().getByText('Mitarbeiter: Viktor Verkauf')).toBeVisible();
  await expect(preview().getByText('Übernahmebestätigung ausstehend')).toBeVisible();

  // Viktor sieht den Termin heute inkl. Hinweis und bestätigt die Übernahme.
  await viktor.goto('/');
  const viktorRow = viktor.locator('.entry-row', { hasText: 'Paula Partyfee' });
  await expect(viktorRow.locator('.badge', { hasText: 'Übernahme ausstehend' })).toBeVisible();
  await viktorRow.click();
  const viktorPreview = viktor.getByTestId('appointment-preview');
  await viktorPreview.getByRole('button', { name: 'Termin übernommen' }).click();
  await expect(viktorPreview.getByText('Übernahmebestätigung ausstehend')).toHaveCount(0);
  await expect(viktorRow.locator('.badge', { hasText: 'Übernahme ausstehend' })).toHaveCount(0);

  // Auch der Admin sieht die abgeschlossene Übernahme (kein Badge mehr).
  await staff.reload();
  await staff.locator('.entry-row', { hasText: 'Abholung / Ausgabe' }).click();
  await expect(preview().getByText('Übernahmebestätigung ausstehend')).toHaveCount(0);
});
