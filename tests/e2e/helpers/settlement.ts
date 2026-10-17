import { expect, type Dialog, type Locator, type Page } from '@playwright/test';
import { acceptedBooking, type AcceptedBookingOptions } from './booking.ts';

/**
 * Phase-9-Helfer (Abrechnung/Storno): Ausgabe + Rückgabe über die echte
 * Staff-UI (Muster return-flow.spec.ts), Abrechnungsseite, Storno-Dialog und
 * Mock-Steuerung. Ausschließlich additiv – bestehende Specs bleiben unberührt.
 * Zeit-Vorspulen nur über `mock-expire-wait`, Worker nur über `mock-run-jobs`,
 * Zahlungsstatus nur über `mock-set-paid`.
 */

/** 1×1-PNG (Testpixel) für Fotos/Unterschriften. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
/** Kleinstes gültiges JPEG (1×1) – Beweisfoto Reinigung/Schaden. */
export const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

export async function login(page: Page, email: string, password: string, firstName: string) {
  await page.goto('/login');
  await page.getByLabel('E-Mail').fill(email);
  await page.getByLabel('Passwort', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Heute' })).toBeVisible();
  await expect(page.getByText(new RegExp(`Willkommen, ${firstName}`))).toBeVisible();
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Aktueller Berliner Kalendertag (YYYY-MM-DD). */
export function berlinTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Berliner Kalendertag heute + N Tage (reine Kalenderarithmetik). */
export function berlinDayPlus(days: number): string {
  const [y, m, d] = berlinTodayIso().split('-').map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

/** datetime-local-Wert für „Berliner Tag + Uhrzeit“. */
export function fillAt(dayIso: string, hour: number, minute = 0): string {
  return `${dayIso}T${pad(hour)}:${pad(minute)}`;
}

/** Kalender öffnen (Tagesansicht) und zum Berliner Zieltag blättern. */
export async function gotoCalendarDay(page: Page, dayIso: string) {
  await page.goto('/kalender');
  await expect(page.getByRole('heading', { name: 'Kalender' })).toBeVisible();
  await page.getByRole('button', { name: 'Tag', exact: true }).click();
  await page.getByRole('button', { name: 'Heute', exact: true }).click();
  const toUtc = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1);
  };
  const diff = Math.round((toUtc(dayIso) - toUtc(berlinTodayIso())) / 86_400_000);
  for (let i = 0; i < Math.abs(diff); i += 1) {
    await page.getByLabel(diff > 0 ? 'Weiter' : 'Zurück').click();
  }
  await expect(page.getByTestId(`day-${dayIso}`)).toBeVisible();
}

/** Betrag wie die Staff-UI (`formatCents`, de-DE): „1.234,56 €“. */
export function formatEuro(cents: number): string {
  return `${new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)} €`;
}

/**
 * Browser-Dialoge (confirm/prompt) während `action` automatisch bestätigen –
 * der Listener wird danach wieder entfernt (kein Nachwirken auf andere Dialoge).
 */
export async function withDialogAccept<T>(page: Page, action: () => Promise<T>): Promise<T> {
  const handler = (dialog: Dialog) => {
    void dialog.accept('E2E').catch(() => undefined);
  };
  page.on('dialog', handler);
  try {
    return await action();
  } finally {
    page.off('dialog', handler);
  }
}

export type AppointmentRow = 'Abholung / Ausgabe' | 'Lieferung' | 'Rückgabe';

/** Terminzeit im Terminplanungs-Preview setzen (Berlin-Wanduhrzeit). */
export async function setAppointmentTime(
  staff: Page,
  processId: string,
  row: AppointmentRow,
  start: string,
) {
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

/**
 * Anfangsbestand erfassen (mit Freigabe), falls der Artikel noch nie gezählt
 * wurde. `optional`: Artikel ohne Lagerzeile (z. B. Kaufartikel) überspringen.
 */
export async function ensureInitialStock(
  staff: Page,
  slug: string,
  productName: string,
  amount: number,
  options: { optional?: boolean } = {},
) {
  await staff.goto('/lager');
  await expect(staff.getByTestId('inventory-sirup-kirsche')).toBeVisible();
  const row = staff.getByTestId(`inventory-${slug}`);
  if (options.optional === true && (await row.count()) === 0) return;
  await expect(row).toBeVisible();
  if ((await row.getByText(/Noch nicht initial erfasst/).count()) === 0) return;
  await row.getByLabel(`Anfangsbestand ${productName}`).fill(String(amount));
  await row.getByRole('button', { name: 'Anfangsbestand erfassen' }).click();
  await expect(staff.getByRole('heading', { name: 'Inventur' })).toBeVisible();
  await staff.getByRole('button', { name: 'Bestandskorrektur freigeben' }).click();
  await expect(staff.getByText('Inventur freigegeben – Bestand wurde angepasst.')).toBeVisible();
}

/** Maschine nach einer Rückgabe reinigen → 🟢 Einsatzbereit (für die Wiederverwendung). */
export async function cleanMachine(staff: Page, machineCode: string) {
  await staff.goto('/maschinen');
  await staff.getByTestId(`machine-${machineCode}`).getByRole('link').first().click();
  await expect(staff.locator('.badge', { hasText: 'Reinigung' })).toBeVisible();
  await staff.getByTestId('clean-complete-button').click();
  await expect(staff.getByText('Maschine ist gereinigt und einsatzbereit.')).toBeVisible();
  await expect(staff.locator('.badge', { hasText: 'Einsatzbereit' })).toBeVisible();
}

export async function wizardNext(staff: Page) {
  await staff.getByTestId('wizard-next').click();
}

async function clickDiagram(svg: Locator, fx: number, fy: number) {
  const box = (await svg.boundingBox())!;
  await svg.click({ position: { x: box.width * fx, y: box.height * fy } });
}

/** Unterschrift mit der Maus zeichnen (Pointer-Events) und übernehmen. */
export async function sign(staff: Page, label: 'Kunde' | 'Mitarbeiter') {
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

/** Maschine über den Vorschlag zuweisen und als vorbereitet markieren (🟠 Reserviert). */
export async function assignAndPrepare(staff: Page, slotNo: number, machineCode: string) {
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

export interface IssueOptions {
  firstName: string;
  lastName: string;
  email: string;
  /** Zuzuweisende Maschinen (Anzahl = Maschinenanzahl der Buchung). */
  machineCodes: string[];
  machineLabel?: '1×10 L' | '2×10 L';
  /** Zusatzpositionen im Lieferschein-Entwurf (aktueller Preis eingefroren). */
  additions?: { name: string; quantity: number }[];
  /** Weitere Buchungsoptionen (Eventdatum, Lieferung, Rabatt, Kaufartikel …). */
  booking?: Partial<
    Pick<
      AcceptedBookingOptions,
      'eventDate' | 'delivery' | 'discountPercent' | 'expectedDiscountEuro' | 'purchaseCanisters'
    >
  >;
}

/**
 * Buchung anlegen (helpers/booking.ts), Termine setzen, Maschinen
 * zuweisen/vorbereiten und die Übergabe komplett abschließen (Phase-6-Wege)
 * → Maschinen sind ausgegeben.
 */
export async function issueBooking(
  staff: Page,
  customerPage: Page,
  options: IssueOptions,
): Promise<{ processId: string; processNumber: string }> {
  const { processId, processNumber } = await acceptedBooking(staff, customerPage, {
    firstName: options.firstName,
    lastName: options.lastName,
    email: options.email,
    machineLabel: options.machineLabel ?? '1×10 L',
    guestCount: 30,
    freeSyrupLiters: 1,
    confirmOrder: true,
    ...(options.machineCodes.length > 1 ? { machineQuantity: options.machineCodes.length } : {}),
    ...(options.booking ?? {}),
  });
  const outboundRow: AppointmentRow =
    options.booking?.delivery !== undefined ? 'Lieferung' : 'Abholung / Ausgabe';
  await setAppointmentTime(staff, processId, outboundRow, fillAt(berlinDayPlus(1), 9));
  await setAppointmentTime(staff, processId, 'Rückgabe', fillAt(berlinDayPlus(3), 11));
  await staff.goto(`/vorgaenge/${processId}/ausgabe`);
  for (const [index, code] of options.machineCodes.entries()) {
    await assignAndPrepare(staff, index + 1, code);
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
  await wizardNext(staff); // 1 Vorgang
  await wizardNext(staff); // 2 Maschinen
  await wizardNext(staff); // 3 Artikel
  for (let slot = 1; slot <= options.machineCodes.length; slot += 1) {
    const check = staff.getByTestId(`check-${slot}`);
    await check.getByRole('button', { name: 'Maschine gemeinsam geprüft' }).click();
    await expect(check).toContainText('✓ Maschine gemeinsam geprüft');
    await staff
      .getByTestId(`photo-input-${slot}`)
      .setInputFiles({ name: 'gesamtfoto.png', mimeType: 'image/png', buffer: PNG_1X1 });
    await expect(check.locator('img.photo-thumb')).toHaveCount(1);
  }
  await wizardNext(staff); // 4 → 5
  await staff.getByRole('button', { name: 'Übernehmen', exact: true }).click();
  await expect(staff.getByText('Empfangsperson gespeichert.')).toBeVisible();
  await wizardNext(staff); // 5 → 6
  await wizardNext(staff); // 6 → 7
  await sign(staff, 'Kunde');
  await expect(staff.getByText(/✓ Unterschrieben von/)).toBeVisible();
  await wizardNext(staff);
  await sign(staff, 'Mitarbeiter');
  await expect(staff.getByText(/✓ Unterschrieben von Erika E2E/)).toBeVisible();
  await wizardNext(staff);
  await staff.getByTestId('finalize-button').click();
  await expect(staff.getByText(/✓ Übergabe abgeschlossen am/)).toBeVisible();
  return { processId, processNumber };
}

export interface ReturnOptions {
  /** Anzahl Maschinen-Slots. */
  slots: number;
  /** Kommissionsrückgabe: Artikelname (Zeilentext) + ungeöffnet zurück. */
  commission?: { name: string; unopenedBack: number };
  /** Slots mit mangelhafter Rückgabevorbereitung (75-€-Fakt + Pflichtfoto). */
  cleanupSlots?: number[];
  /** Schaden an einem Slot (mittel, mit Foto). */
  damage?: { slot: number; description: string };
  /** Fehlteil Deckel an einem Slot (physische Rückgabe möglich). */
  missingLid?: { slot: number; note: string };
}

/**
 * Rückgabe über den echten Rückgabe-Wizard (Phase 7) bis zur Finalisierung;
 * liefert den Link zum Rückgabeprotokoll.
 */
export async function returnBooking(
  staff: Page,
  processId: string,
  options: ReturnOptions,
): Promise<string> {
  await staff.goto(`/vorgaenge/${processId}/rueckgabe`);
  const start = staff.getByTestId('return-start');
  const stepOne = staff.getByRole('heading', { name: '1. Vorgang und Rückgabeperson' });
  await expect(start.or(stepOne).first()).toBeVisible();
  if ((await start.count()) > 0) {
    await start.click();
    await expect(staff.getByText('Rückgabe begonnen.')).toBeVisible();
  }
  await expect(stepOne).toBeVisible();
  await staff.getByTestId('returner-save').click();
  await expect(staff.getByText('Rückgabeperson übernommen.')).toBeVisible();
  await wizardNext(staff);
  await expect(staff.getByRole('heading', { name: '2. Maschinen bestätigen' })).toBeVisible();
  await wizardNext(staff);

  // 3 Zubehör
  await expect(staff.getByRole('heading', { name: '3. Zubehör prüfen' })).toBeVisible();
  for (let slot = 1; slot <= options.slots; slot += 1) {
    if (options.missingLid?.slot === slot) {
      const accessory = staff.getByTestId(`accessory-${slot}`);
      await accessory.getByRole('button', { name: 'Fehlteil erfassen' }).click();
      const form = staff.getByTestId(`missing-form-${slot}`);
      await form.locator('#missing-type').selectOption('lid');
      await form.locator('#missing-qty').fill('1');
      await form.locator('#missing-note').fill(options.missingLid.note);
      await staff.getByTestId('missing-save').click();
      await expect(staff.getByText(/Fehlteil erfasst/)).toBeVisible();
      await expect(accessory).toContainText('1 × Deckel');
    } else {
      await staff.getByTestId(`accessory-complete-${slot}`).click();
      await expect(staff.getByTestId(`accessory-${slot}`)).toContainText('✓ Zubehör vollständig');
    }
  }
  await wizardNext(staff);

  // 4 Rückgabevorbereitung
  await expect(
    staff.getByRole('heading', { name: '4. Rückgabevorbereitung des Kunden' }),
  ).toBeVisible();
  for (let slot = 1; slot <= options.slots; slot += 1) {
    if (options.cleanupSlots?.includes(slot) === true) {
      await staff.getByTestId(`clean-emptied-${slot}`).uncheck();
      await staff.getByTestId(`cleanliness-confirm-${slot}`).click();
      await expect(staff.getByTestId(`cleanup-fact-${slot}`)).toContainText(
        'Reinigungsgebühr-Fakt: 75,00 €',
      );
      await staff
        .getByTestId(`cleanup-photo-input-${slot}`)
        .setInputFiles({ name: 'reinigung.jpg', mimeType: 'image/jpeg', buffer: JPEG_1X1 });
      await expect(staff.getByText('Beweisfoto gespeichert.')).toBeVisible();
      await expect(staff.getByTestId(`cleanup-fact-${slot}`)).toContainText('1 vorhanden');
    } else {
      await staff.getByTestId(`cleanliness-confirm-${slot}`).click();
      await expect(staff.getByTestId(`cleanliness-${slot}`)).toContainText(
        'Ordnungsgemäß vorbereitet',
      );
    }
  }
  await wizardNext(staff);

  // 5 Kommission
  await expect(staff.getByRole('heading', { name: '5. Kommissionsrückgabe' })).toBeVisible();
  if (options.commission !== undefined) {
    const row = staff.locator('[data-testid^="return-item-"]', {
      hasText: options.commission.name,
    });
    await expect(row).toContainText('Kommission');
    await row.getByLabel('Ungeöffnet zurück').fill(String(options.commission.unopenedBack));
    await row.getByRole('button', { name: 'Übernehmen' }).click();
    await expect(staff.getByText('Rückgabemenge übernommen.')).toBeVisible();
  }
  await wizardNext(staff);

  // 6 Schäden
  await expect(staff.getByRole('heading', { name: '6. Schäden dokumentieren' })).toBeVisible();
  if (options.damage !== undefined) {
    await staff.getByTestId(`damage-add-${options.damage.slot}`).click();
    const form = staff.getByTestId(`damage-form-${options.damage.slot}`);
    await staff.getByTestId('damage-diagram-view-left').click();
    await clickDiagram(staff.getByTestId('damage-diagram-svg'), 0.4, 0.3);
    await expect(staff.getByTestId('damage-diagram-marker-0')).toBeVisible();
    await form.locator('#damage-severity').selectOption('medium');
    await form.locator('#damage-description').fill(options.damage.description);
    await staff.getByTestId('damage-save').click();
    await expect(staff.getByText(/Schaden gespeichert/)).toBeVisible();
    await staff
      .locator('input[data-testid^="damage-photo-input-"]')
      .setInputFiles({ name: 'schaden.jpg', mimeType: 'image/jpeg', buffer: JPEG_1X1 });
    await expect(staff.getByText('Schadensfoto gespeichert.')).toBeVisible();
    await expect(staff.getByTestId('wizard-next')).toBeEnabled();
  }
  await wizardNext(staff);

  // 7 Zusammenfassung → 8/9 Unterschriften → 10 Abschluss
  await expect(staff.getByRole('heading', { name: '7. Zusammenfassung' })).toBeVisible();
  const withoutComplaint =
    options.cleanupSlots === undefined &&
    options.damage === undefined &&
    options.missingLid === undefined;
  if (withoutComplaint) {
    await expect(staff.getByTestId('return-summary')).toContainText('Rückgabe ohne Beanstandung');
  } else {
    await expect(staff.getByTestId('return-summary')).not.toContainText(
      'Rückgabe ohne Beanstandung',
    );
  }
  await wizardNext(staff);
  await expect(
    staff.getByRole('heading', { name: '8. Unterschrift Kunde / Vertreter' }),
  ).toBeVisible();
  await sign(staff, 'Kunde');
  await expect(staff.getByText(/✓ Unterschrieben von/)).toBeVisible();
  await wizardNext(staff);
  await expect(staff.getByRole('heading', { name: '9. Unterschrift Mitarbeiter' })).toBeVisible();
  await sign(staff, 'Mitarbeiter');
  await expect(staff.getByText(/✓ Unterschrieben von Erika E2E/)).toBeVisible();
  await wizardNext(staff);
  await expect(staff.getByRole('heading', { name: '10. Rückgabe abschließen' })).toBeVisible();
  const finalize = staff.getByTestId('finalize-button');
  await expect(finalize).toBeEnabled();
  await finalize.click();
  await expect(staff.getByText(/✓ Rückgabe abgeschlossen am/)).toBeVisible();
  const final = staff.getByTestId('wizard-final');
  await expect(final.getByRole('link', { name: 'Rückgabeprotokoll' })).toHaveCount(1);
  return (await final.getByRole('link', { name: 'Rückgabeprotokoll' }).getAttribute('href'))!;
}

/** Ausgabe + Rückgabe in einem Zug (Standard: eine Maschine, ohne Beanstandung). */
export async function issueAndReturn(
  staff: Page,
  customerPage: Page,
  issue: IssueOptions,
  ret: Omit<ReturnOptions, 'slots'> = {},
): Promise<{ processId: string; processNumber: string; returnDocHref: string }> {
  const { processId, processNumber } = await issueBooking(staff, customerPage, issue);
  const returnDocHref = await returnBooking(staff, processId, {
    slots: issue.machineCodes.length,
    ...ret,
  });
  return { processId, processNumber, returnDocHref };
}

/** Abrechnungsseite öffnen (Daten geladen: Status sichtbar). */
export async function openSettlement(staff: Page, processId: string) {
  await staff.goto(`/vorgaenge/${processId}/abrechnung`);
  await expect(staff.getByTestId('settlement-page')).toBeVisible();
  await expect(staff.getByTestId('settlement-status')).toBeVisible();
}

/** Mock-Steuerung „fällige Jobs ausführen“ (Abrechnungsseite). */
export async function runDueJobs(staff: Page) {
  await staff.getByTestId('mock-run-jobs').click();
}

/** Mock-Steuerung „Wartefrist ablaufen lassen“ (Zeit-Vorspulen ausschließlich hierüber). */
export async function expireWait(staff: Page) {
  await staff.getByTestId('mock-expire-wait').click();
}

/** Mock-Steuerung „Zahlung als bezahlt markieren“. */
export async function setPaid(staff: Page) {
  await staff.getByTestId('mock-set-paid').click();
}

export interface CancellationExpectation {
  /** Verbleibende Kalendertage (Europe/Berlin). */
  days: number;
  percent: 0 | 50 | 100;
  /** Basis = regulärer Listenpreis der Maschinenmiete. */
  baseCents: number;
  feeCents: number;
}

/**
 * Storno über die Vorgangsseite: „Mehr“ → „Buchung stornieren“ → Vorschau
 * prüfen (Tage/Satz/Basis/Gebühr) → bestätigen. Danach Status „Storniert“.
 */
export async function cancelViaUi(
  staff: Page,
  processId: string,
  expected: CancellationExpectation,
) {
  await staff.goto(`/vorgaenge/${processId}`);
  await staff.getByTestId('process-more').click();
  await staff.getByTestId('cancel-booking').click();
  const preview = staff.getByTestId('cancellation-preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId('cancellation-days')).toContainText(
    new RegExp(`\\b${expected.days}\\b`),
  );
  await expect(preview.getByTestId('cancellation-percent')).toContainText(
    new RegExp(`\\b${expected.percent}\\s?%`),
  );
  await expect(preview.getByTestId('cancellation-base')).toContainText(
    formatEuro(expected.baseCents),
  );
  await expect(preview.getByTestId('cancellation-fee')).toContainText(
    formatEuro(expected.feeCents),
  );
  await preview.getByTestId('cancellation-confirm').click();
  await expect(staff.locator('.badge', { hasText: 'Storniert' }).first()).toBeVisible();
  await expect(staff.getByTestId('process-cancellation')).toBeVisible();
}
