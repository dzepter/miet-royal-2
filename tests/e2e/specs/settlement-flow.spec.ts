/**
 * Phase-9-E2E-Szenarien A–M (Order §98): Abrechnung nach Rückgabe,
 * Reinigungsgebühr, Schaden mit Kundeninformation und 24-h-Wartefenster,
 * Kundenrückmeldung, Fehlteil, Anzahlung, Kaution, Storno (0 %/50 %/100 %),
 * Storno-Race (UI-Teil) und Folgevorgang.
 *
 * Läuft unabhängig (Basis-Seed zu Beginn, eigene Buchungen über die echten
 * Phase-3/4/6/7-Wege). Zeit-Vorspulen ausschließlich über `mock-expire-wait`,
 * Worker ausschließlich über `mock-run-jobs`, Zahlungsstatus über
 * `mock-set-paid` (Mock-Steuerung der Abrechnungsseite, nur Nicht-Production).
 * Ausschließlich synthetische Testdaten; Fotos/Unterschriften sind Testpixel.
 */
import { expect, test, type Page } from '@playwright/test';
import { acceptedBooking } from '../helpers/booking.ts';
import { ADMIN_EMAIL, ADMIN_PASSWORD, resetE2eDatabase } from '../helpers/seed.ts';
import {
  assignAndPrepare,
  berlinDayPlus,
  berlinTodayIso,
  cancelViaUi,
  cleanMachine,
  ensureInitialStock,
  expireWait,
  fillAt,
  formatEuro,
  gotoCalendarDay,
  issueAndReturn,
  issueBooking,
  login,
  openSettlement,
  returnBooking,
  runDueJobs,
  setAppointmentTime,
  setPaid,
  withDialogAccept,
} from '../helpers/settlement.ts';

test.describe.configure({ mode: 'serial' });

/** Seed-Listenpreise (Cent): 1×10 L = 75,00 €, Sirup 12,00 €, 6-L-Kanister 5,00 €. */
const MACHINE_1X10 = 7500;
const SYRUP = 1200;
const CANISTER = 500;
const CLEANUP_FEE = 7500;

const LABEL_TRANSFERRED = 'An Buchhaltung übertragen';
const LABEL_WAITING = 'Kundenrückmeldung abwarten';
const LABEL_CLARIFICATION = 'Klärung erforderlich';
const LABEL_NOTICE_REQUIRED = 'Kundeninformation erforderlich';
/** Vor dem Worker-Lauf: bereit oder (optional) „Übertragung geplant“. */
const READY_OR_PLANNED = /Bereit zur Buchhaltung|Übertragung geplant/;

let staff: Page; // Erika (Admin – alle Rechte inkl. system.settings für die Mock-Steuerung)
let customerPage: Page;
let processC = '';
let numberC = '';
let processI = '';
let numberI = '';

test.beforeAll(async ({ browser }) => {
  resetE2eDatabase();
  staff = await browser.newPage();
  customerPage = await browser.newPage();
});
test.afterAll(async () => {
  await staff.close();
  await customerPage.close();
});

const line = (type: string) => staff.getByTestId(`settlement-line-${type}`);
const status = () => staff.getByTestId('settlement-status');

/** Mock-Worker laufen lassen und den Transfer-Endzustand prüfen; liefert die Referenz. */
async function transferViaJobs(): Promise<string> {
  await runDueJobs(staff);
  await expect(status()).toContainText(LABEL_TRANSFERRED);
  await expect(staff.getByTestId('settlement-locked-hint')).toBeVisible();
  await expect(staff.getByTestId('payment-status')).toContainText('Offen');
  const reference = (await staff.getByTestId('accounting-reference').innerText()).trim();
  expect(reference.length).toBeGreaterThan(0);
  return reference;
}

/** Nach dem Transfer: keine Bearbeitung mehr (Lock, §41). */
async function expectLocked() {
  await expect(staff.getByTestId('settlement-locked-hint')).toBeVisible();
  await expect(staff.getByTestId('line-edit')).toHaveCount(0);
  await expect(staff.getByTestId('line-remove')).toHaveCount(0);
  await expect(staff.getByTestId('manual-charge-form')).toHaveCount(0);
  await expect(staff.getByTestId('clarification-charge')).toHaveCount(0);
  await expect(staff.getByTestId('transfer-now')).toHaveCount(0);
  await expect(staff.getByTestId('retry-transfer')).toHaveCount(0);
}

async function expectProcessCompleted(processId: string) {
  await staff.goto(`/vorgaenge/${processId}`);
  await expect(staff.locator('.badge', { hasText: 'Abgeschlossen' }).first()).toBeVisible();
  await expect(staff.getByTestId('process-settlement')).toContainText(LABEL_TRANSFERRED);
}

// ── A: Normale Abrechnung ────────────────────────────────────────────────

test('A: Normale Abrechnung: Return finalisieren → Abrechnung mit Miete/Kommission/Kaufartikel/Lieferung/Rabatt → keine Blocker → Mock-Transfer → Vorgang abgeschlossen', async () => {
  test.setTimeout(480_000);
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await ensureInitialStock(staff, 'sirup-kirsche', 'Sirup Kirsche', 10);
  await ensureInitialStock(staff, 'sirup-waldmeister', 'Sirup Waldmeister', 10);
  await ensureInitialStock(staff, 'strohhalme-25', 'Strohhalme (25 Stück)', 20);
  await ensureInitialStock(staff, 'becher-25', 'Becher (25 Stück)', 40);
  await ensureInitialStock(staff, 'mischkanister-6l', '6-L-Mischkanister', 10, { optional: true });

  // Lieferung 49,00 €, 10 % Rabatt (7,50 €), 2 Kaufkanister, 3 Extra-Sirup (Kommission).
  const { processId, processNumber } = await issueAndReturn(
    staff,
    customerPage,
    {
      firstName: 'Anna',
      lastName: 'Abrechnung',
      email: 'anna@e2e.example',
      machineCodes: ['MR-10-01-01'],
      additions: [{ name: 'Waldmeister', quantity: 3 }],
      booking: {
        delivery: {
          street: 'Teststraße 2',
          postalCode: '55129',
          city: 'Mainz',
          priceEuro: '49,00',
        },
        discountPercent: 10,
        expectedDiscountEuro: '7,50',
        purchaseCanisters: 2,
      },
    },
    { commission: { name: 'Waldmeister', unopenedBack: 2 } },
  );

  // Vorgang: ABRECHNUNG-Karte erscheint erst nach finalisierter Rückgabe.
  await staff.goto(`/vorgaenge/${processId}`);
  const card = staff.getByTestId('process-settlement');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('settlement-status')).toContainText(READY_OR_PLANNED);
  await card.getByTestId('settlement-open').click();
  await expect(staff).toHaveURL(new RegExp(`/vorgaenge/${processId}/abrechnung$`));
  await expect(staff.getByTestId('settlement-page')).toBeVisible();

  // Positionen aus den eingefrorenen Fakten (Buchungs-Snapshot, Lieferschein, Phase 7).
  await expect(line('machine_rental')).toContainText(formatEuro(MACHINE_1X10));
  await expect(line('delivery')).toContainText(formatEuro(4900));
  await expect(line('purchase')).toContainText(formatEuro(2 * CANISTER));
  await expect(line('commission_consumption')).toContainText(formatEuro(1 * SYRUP));
  await expect(line('discount')).toContainText(formatEuro(750));
  await expect(line('cleanup_fee')).toHaveCount(0);
  await expect(line('damage_charge')).toHaveCount(0);
  // Keine Blocker: keine offenen Klärungen, keine Kundeninformation.
  await expect(staff.getByTestId('clarification-item')).toHaveCount(0);
  await expect(staff.getByTestId('notice-review')).toHaveCount(0);
  await expect(status()).toContainText(READY_OR_PLANNED);
  const due = MACHINE_1X10 + 4900 + 2 * CANISTER + SYRUP - 750;
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(formatEuro(due));
  await expect(staff.getByTestId('mock-badge')).toContainText('MOCK');

  // Mock-Transfer über den Worker; Zahlungsstatus simuliert (open → paid).
  await transferViaJobs();
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(formatEuro(due));
  await expectLocked();
  await setPaid(staff);
  await expect(staff.getByTestId('payment-status')).toContainText('Bezahlt');

  // Vorgang ist operativ abgeschlossen (bestehende Prozesslogik).
  await expectProcessCompleted(processId);
  await expect(staff.getByRole('heading', { name: processNumber })).toBeVisible();
});

// ── B: Reinigungsgebühr ──────────────────────────────────────────────────

test('B: Cleanup: 75 EUR je betroffener Maschine → keine Schaden-Kundeninfo → transferierbar', async () => {
  test.setTimeout(480_000);
  const { processId } = await issueAndReturn(
    staff,
    customerPage,
    {
      firstName: 'Bruno',
      lastName: 'Besen',
      email: 'bruno@e2e.example',
      machineCodes: ['MR-10-01-02', 'MR-10-01-03'],
    },
    { cleanupSlots: [1, 2] },
  );
  await openSettlement(staff, processId);
  await expect(line('cleanup_fee')).toHaveCount(2);
  await expect(line('cleanup_fee').nth(0)).toContainText(formatEuro(CLEANUP_FEE));
  await expect(line('cleanup_fee').nth(1)).toContainText(formatEuro(CLEANUP_FEE));
  await expect(line('cleanup_fee').nth(0)).toContainText('Reinigungsgebühr');
  await expect(line('machine_rental')).toContainText(formatEuro(2 * MACHINE_1X10));
  // Reinigung allein löst KEINE Kundeninformation aus (§24).
  await expect(staff.getByTestId('clarification-item')).toHaveCount(0);
  await expect(staff.getByTestId('notice-review')).toHaveCount(0);
  await expect(staff.getByTestId('notice-send')).toHaveCount(0);
  await expect(staff.getByTestId('settlement-wait-hint')).toHaveCount(0);
  await expect(status()).toContainText(READY_OR_PLANNED);
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(
    formatEuro(2 * MACHINE_1X10 + 2 * CLEANUP_FEE),
  );
  await transferViaJobs();
  await expectProcessCompleted(processId);
});

// ── C: Schaden → Kundeninformation → Warten ──────────────────────────────

test('C: Schaden: Klärung → Betrag festlegen → Kundeninformation prüfen → Testversand → „Kundenrückmeldung abwarten“', async () => {
  test.setTimeout(480_000);
  ({ processId: processC, processNumber: numberC } = await issueAndReturn(
    staff,
    customerPage,
    {
      firstName: 'Carla',
      lastName: 'Chaos',
      email: 'carla@e2e.example',
      machineCodes: ['MR-10-01-04'],
    },
    { damage: { slot: 1, description: 'Delle links am Gehäuse' } },
  ));
  await openSettlement(staff, processC);
  await expect(status()).toContainText(LABEL_CLARIFICATION);
  const clarification = staff.getByTestId('clarification-item');
  await expect(clarification).toHaveCount(1);
  await expect(clarification).toContainText('Schadenkosten');
  await expect(clarification).toContainText('Delle links am Gehäuse');
  // Kein automatischer Betrag: vor dem Entscheid keine Schadenposition, kein Transfer.
  await expect(line('damage_charge')).toHaveCount(0);
  await expect(staff.getByTestId('transfer-now')).toHaveCount(0);
  await expect(staff.getByTestId('notice-review')).toHaveCount(0);

  await clarification.getByTestId('clarification-charge-amount').fill('120,00');
  await clarification.getByTestId('clarification-charge').click();
  // Schadenkosten-Klärung erledigt; als offener Punkt bleibt nur noch
  // „Kundeninformation prüfen“ (Order §69) – ohne Betragseingabe.
  await expect(staff.getByTestId('clarification-item')).toHaveCount(1);
  await expect(staff.getByTestId('clarification-item')).toContainText('Kundeninformation');
  await expect(staff.getByTestId('clarification-charge')).toHaveCount(0);
  await expect(line('damage_charge')).toContainText(formatEuro(12000));
  await expect(status()).toContainText(LABEL_NOTICE_REQUIRED);

  // Kundeninformation prüfen → EINE kombinierte Information → Freigeben und senden.
  const review = staff.getByTestId('notice-review');
  await expect(review).toContainText('Kundeninformation prüfen');
  await review.click();
  const preview = staff.getByTestId('notice-preview');
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId('notice-body')).toContainText(numberC);
  await expect(preview.getByTestId('notice-body')).toContainText('120,00');
  await expect(preview.getByTestId('notice-body')).not.toContainText('MwSt');
  await expect(preview.getByTestId('notice-total')).toContainText(formatEuro(12000));
  const send = staff.getByTestId('notice-send');
  await expect(send).toContainText('Freigeben und senden');
  await send.click();

  // Wartezustand ohne Countdown; Auto-Transfer ist erst nach Ablauf fällig.
  await expect(status()).toContainText(LABEL_WAITING);
  const hint = staff.getByTestId('settlement-wait-hint');
  await expect(hint).toContainText(LABEL_WAITING);
  await expect(hint).toContainText('Automatische Freigabe frühestens ab');
  await expect(staff.getByTestId('notice-send')).toHaveCount(0);
  await expect(staff.getByTestId('transfer-now')).toHaveCount(0);
  await runDueJobs(staff);
  await expect(status()).toContainText(LABEL_WAITING);
  await expect(staff.getByTestId('settlement-locked-hint')).toHaveCount(0);
});

// ── D: 24 h ohne Rückmeldung → Worker → genau ein Transfer → Lock ────────

test('D: 24H: Zeit vorspulen → keine Rückmeldung → Worker → genau ein Mock-Transfer → gesperrt', async () => {
  test.setTimeout(180_000);
  await openSettlement(staff, processC);
  await expect(status()).toContainText(LABEL_WAITING);
  await expireWait(staff);
  const reference = await transferViaJobs();
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(
    formatEuro(MACHINE_1X10 + 12000),
  );
  await expectLocked();

  // Zweiter Worker-Lauf: kein zweiter Transfer – Referenz und Status unverändert.
  await runDueJobs(staff);
  await expect(status()).toContainText(LABEL_TRANSFERRED);
  await expect(staff.getByTestId('accounting-reference')).toHaveText(reference);
  await staff.reload();
  await expect(staff.getByTestId('settlement-page')).toBeVisible();
  await expect(status()).toContainText(LABEL_TRANSFERRED);
  await expect(staff.getByTestId('accounting-reference')).toHaveText(reference);
  await expectLocked();
  await expectProcessCompleted(processC);
});

// ── E: Kundenrückmeldung ─────────────────────────────────────────────────

test('E: Kundenrückmeldung: markieren → Auto-Transfer blockiert → Betrag ändern → „Jetzt an Buchhaltung übertragen“ → kein zweiter Mailversand', async () => {
  test.setTimeout(480_000);
  const { processId } = await issueAndReturn(
    staff,
    customerPage,
    {
      firstName: 'Emil',
      lastName: 'Einwand',
      email: 'emil@e2e.example',
      machineCodes: ['MR-10-01-05'],
    },
    { damage: { slot: 1, description: 'Kratzer an der Front' } },
  );
  await openSettlement(staff, processId);
  const clarification = staff.getByTestId('clarification-item');
  await clarification.getByTestId('clarification-charge-amount').fill('80,00');
  await clarification.getByTestId('clarification-charge').click();
  await expect(line('damage_charge')).toContainText(formatEuro(8000));
  await staff.getByTestId('notice-review').click();
  await expect(staff.getByTestId('notice-preview')).toBeVisible();
  await staff.getByTestId('notice-send').click();
  await expect(status()).toContainText(LABEL_WAITING);
  await expect(staff.getByTestId('notice-send')).toHaveCount(0);

  // Frist ablaufen lassen (Mock), dann Kundenrückmeldung eingegangen →
  // der fällige Auto-Transfer bleibt aus (Worker prüft erneut, §80).
  await expireWait(staff);
  await withDialogAccept(staff, async () => {
    await staff.getByTestId('customer-response').click();
  });
  await expect(status()).not.toContainText(LABEL_WAITING);
  await runDueJobs(staff);
  await expect(status()).not.toContainText(LABEL_TRANSFERRED);
  await expect(staff.getByTestId('settlement-locked-hint')).toHaveCount(0);

  // Betrag ändern (vor Buchhaltung erlaubt): keine zweite Information, neue Summe sichtbar.
  const damageLine = line('damage_charge');
  await damageLine.getByTestId('line-edit').click();
  await damageLine.getByTestId('line-amount-input').fill('60,00');
  await damageLine.getByTestId('line-save').click();
  await expect(line('damage_charge')).toContainText(formatEuro(6000));
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(
    formatEuro(MACHINE_1X10 + 6000),
  );
  await expect(staff.getByTestId('notice-send')).toHaveCount(0);

  // Wie berechnet freigeben → bewusst manuell übertragen (nie still automatisch).
  const release = staff.getByTestId('release-as-calculated');
  await expect(release).toContainText('Wie berechnet freigeben');
  await release.click();
  await expect(status()).toContainText('Bereit zur Buchhaltung');
  await runDueJobs(staff);
  await expect(status()).toContainText('Bereit zur Buchhaltung');
  const transferNow = staff.getByTestId('transfer-now');
  await expect(transferNow).toContainText('Jetzt an Buchhaltung übertragen');
  await transferNow.click();
  await staff.getByTestId('transfer-confirm').click();
  await expect(status()).toContainText(LABEL_TRANSFERRED);
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(
    formatEuro(MACHINE_1X10 + 6000),
  );
  await expectLocked();
  // Genau EIN Versand je Abrechnung: kein erneutes Angebot „Freigeben und senden“.
  await expect(staff.getByTestId('notice-send')).toHaveCount(0);
  await expectProcessCompleted(processId);
});

// ── F: Fehlteil → Teil später gebracht → keine Belastung ─────────────────

test('F: Fehlteil: Klärung offen → Teil später gebracht → Fall erledigen → keine Belastung', async () => {
  test.setTimeout(480_000);
  const { processId } = await issueAndReturn(
    staff,
    customerPage,
    {
      firstName: 'Frieda',
      lastName: 'Fehlteil',
      email: 'frieda@e2e.example',
      machineCodes: ['MR-10-01-06'],
    },
    { missingLid: { slot: 1, note: 'Deckel nicht mitgebracht' } },
  );
  await openSettlement(staff, processId);
  await expect(status()).toContainText(LABEL_CLARIFICATION);
  const clarification = staff.getByTestId('clarification-item');
  await expect(clarification).toHaveCount(1);
  await expect(clarification).toContainText('Fehlteil');
  await expect(line('missing_item_charge')).toHaveCount(0);
  await expect(staff.getByTestId('transfer-now')).toHaveCount(0);

  // Teil wird später gebracht: Phase-7-Fall erledigen („Erledigt“ in „Heute“).
  await staff.goto('/');
  await expect(staff.getByTestId('missing-items-warning')).toContainText('Offene Fehlteile: 1');
  await staff.getByTestId('missing-items-warning').getByRole('link').click();
  const cases = staff.getByTestId('open-missing-cases');
  await expect(cases).toContainText('1 × Deckel');
  await cases.getByRole('button', { name: 'Erledigt' }).click();
  await expect(staff.getByText('Fehlteil erledigt.')).toBeVisible();

  // Abrechnung: Klärung automatisch erledigt, keine Fehlteilposition, kein Blocker.
  await openSettlement(staff, processId);
  await expect(staff.getByTestId('clarification-item')).toHaveCount(0);
  await expect(line('missing_item_charge')).toHaveCount(0);
  await expect(status()).toContainText(READY_OR_PLANNED);
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(formatEuro(MACHINE_1X10));
  await transferViaJobs();
  await expect(line('missing_item_charge')).toHaveCount(0);
  await expectProcessCompleted(processId);
});

// ── G: Anzahlung ─────────────────────────────────────────────────────────

test('G: Anzahlung: vor der Rückgabe erfasst → reduziert den offenen Betrag → Payload/Transfer korrekt', async () => {
  test.setTimeout(480_000);
  await cleanMachine(staff, 'MR-10-01-01');
  const { processId } = await issueBooking(staff, customerPage, {
    firstName: 'Gerda',
    lastName: 'Geld',
    email: 'gerda@e2e.example',
    machineCodes: ['MR-10-01-01'],
  });

  // „Zahlungen / Kaution“ auf der Vorgangsseite – auch VOR der Rückgabe.
  await staff.goto(`/vorgaenge/${processId}`);
  const payments = staff.getByTestId('payments-section');
  await expect(payments).toBeVisible();
  await expect(staff.getByTestId('process-settlement')).toHaveCount(0);
  const advance = payments.getByTestId('advance-form');
  await advance.getByTestId('advance-amount').fill('50,00');
  await advance.getByTestId('advance-received-at').fill(berlinTodayIso());
  await advance.getByTestId('advance-reference').fill('E2E-ANZ-1');
  await advance.getByTestId('advance-submit').click();
  const item = payments.getByTestId('advance-item');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(formatEuro(5000));
  await expect(item).toContainText('E2E-ANZ-1');

  await returnBooking(staff, processId, { slots: 1 });
  await openSettlement(staff, processId);
  await expect(line('advance_payment_credit')).toContainText(formatEuro(5000));
  await expect(staff.getByTestId('settlement-gross')).toContainText(formatEuro(MACHINE_1X10));
  await expect(staff.getByTestId('settlement-credits')).toContainText(formatEuro(5000));
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(
    formatEuro(MACHINE_1X10 - 5000),
  );
  await expect(staff.getByTestId('settlement-overpayment-hint')).toHaveCount(0);
  // Transfer (eingefrorener Payload): Credit und offener Betrag bleiben nach dem Transfer gleich.
  await transferViaJobs();
  await expect(line('advance_payment_credit')).toContainText(formatEuro(5000));
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(
    formatEuro(MACHINE_1X10 - 5000),
  );
  await expectLocked();
});

// ── H: Kaution ───────────────────────────────────────────────────────────

test('H: Kaution: gehalten → Rechnung unverändert → Teil anwenden → Credit sichtbar → Rest bleibt gehalten', async () => {
  test.setTimeout(480_000);
  await cleanMachine(staff, 'MR-10-01-02');
  const { processId } = await issueBooking(staff, customerPage, {
    firstName: 'Hugo',
    lastName: 'Hinterlegt',
    email: 'hugo@e2e.example',
    machineCodes: ['MR-10-01-02'],
  });

  // Kaution 100,00 € vor der Rückgabe erfassen (held) – kein Umsatz.
  await staff.goto(`/vorgaenge/${processId}`);
  const payments = staff.getByTestId('payments-section');
  const depositForm = payments.getByTestId('deposit-form');
  await depositForm.getByTestId('deposit-amount').fill('100,00');
  await depositForm.getByTestId('deposit-received-at').fill(berlinTodayIso());
  await depositForm.getByTestId('deposit-submit').click();
  const deposit = payments.getByTestId('deposit-item');
  await expect(deposit).toHaveCount(1);
  await expect(deposit.getByTestId('deposit-held-remaining')).toContainText(formatEuro(10000));

  // Nach der Rückgabe: gehaltene Kaution reduziert die Rechnung NICHT.
  await returnBooking(staff, processId, { slots: 1 });
  await openSettlement(staff, processId);
  await expect(line('deposit_applied_credit')).toHaveCount(0);
  await expect(staff.getByTestId('settlement-credits')).toContainText(formatEuro(0));
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(formatEuro(MACHINE_1X10));

  // Bewusst 30,00 € anwenden → Credit sichtbar, Rest 70,00 € bleibt gehalten.
  await staff.goto(`/vorgaenge/${processId}`);
  const depositAfter = staff.getByTestId('payments-section').getByTestId('deposit-item');
  await depositAfter.getByTestId('deposit-apply-amount').fill('30,00');
  await depositAfter.getByTestId('deposit-apply').click();
  await expect(depositAfter.getByTestId('deposit-held-remaining')).toContainText(formatEuro(7000));
  await expect(depositAfter.getByTestId('deposit-release')).toBeVisible();

  await openSettlement(staff, processId);
  await expect(line('deposit_applied_credit')).toContainText(formatEuro(3000));
  await expect(staff.getByTestId('settlement-credits')).toContainText(formatEuro(3000));
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(
    formatEuro(MACHINE_1X10 - 3000),
  );
  await transferViaJobs();
  await expect(staff.getByTestId('settlement-amount-due')).toContainText(
    formatEuro(MACHINE_1X10 - 3000),
  );
  // Rest bleibt gehalten – keine automatische Auszahlung.
  await staff.goto(`/vorgaenge/${processId}`);
  await expect(
    staff.getByTestId('payments-section').getByTestId('deposit-held-remaining'),
  ).toContainText(formatEuro(7000));
});

// ── I: Kostenloses Storno (≥ 15 Tage) ────────────────────────────────────

test('I: Kostenloses Storno 15+ Tage: Vorschau 0 % → bestätigen → Termine/Assignments frei → „Storniert – ohne Rechnung“', async () => {
  test.setTimeout(360_000);
  await cleanMachine(staff, 'MR-10-01-03');
  ({ processId: processI, processNumber: numberI } = await acceptedBooking(staff, customerPage, {
    firstName: 'Ida',
    lastName: 'Immerfrei',
    email: 'ida@e2e.example',
    machineLabel: '1×10 L',
    guestCount: 30,
    freeSyrupLiters: 1,
    confirmOrder: true,
    eventDate: berlinDayPlus(20),
  }));
  // Termine geplant und Maschine vorbereitet (🟠 Reserviert) – wird durch den Storno frei.
  const pickupDay = berlinDayPlus(19);
  await setAppointmentTime(staff, processI, 'Abholung / Ausgabe', fillAt(pickupDay, 9));
  await setAppointmentTime(staff, processI, 'Rückgabe', fillAt(berlinDayPlus(21), 11));
  await staff.goto(`/vorgaenge/${processI}/ausgabe`);
  await assignAndPrepare(staff, 1, 'MR-10-01-03');
  await staff.goto('/maschinen');
  await expect(staff.getByTestId('machine-MR-10-01-03')).toContainText('Reserviert');

  await cancelViaUi(staff, processI, {
    days: 20,
    percent: 0,
    baseCents: MACHINE_1X10,
    feeCents: 0,
  });
  const cancellation = staff.getByTestId('process-cancellation');
  await expect(cancellation.getByTestId('cancellation-finance-status')).toContainText(
    'Storniert – ohne Rechnung',
  );
  await expect(staff.getByTestId('cancel-booking')).toHaveCount(0);
  await expect(staff.getByTestId('process-settlement')).toHaveCount(0);

  // Ressourcen sofort frei: keine aktiven Termine (Vorgang + operativer Kalender),
  // Assignment gelöst, Maschine einsatzbereit.
  await staff.goto(`/vorgaenge/${processI}/termine`);
  await expect(staff.getByRole('heading', { name: 'Terminplanung' })).toBeVisible();
  await expect(staff.locator('.entry-row').filter({ hasNotText: 'Storniert' })).toHaveCount(0);
  await gotoCalendarDay(staff, pickupDay);
  await expect(staff.locator('.calendar-chip', { hasText: 'Ida Immerfrei' })).toHaveCount(0);
  await staff.goto('/ausgabe');
  await staff.getByLabel('Tag').fill(pickupDay);
  await expect(staff.getByRole('heading', { name: 'Ausgabe' })).toBeVisible();
  await expect(staff.getByTestId(`issue-${numberI}`)).toHaveCount(0);
  await staff.goto('/maschinen');
  await expect(staff.getByTestId('machine-MR-10-01-03')).toContainText('Einsatzbereit');
  // Suchbar und als Storniert gekennzeichnet.
  await staff.getByRole('link', { name: 'Suche' }).click();
  await staff.getByRole('searchbox').fill('Immerfrei');
  await expect(staff.getByRole('link', { name: numberI })).toBeVisible();
});

// ── J: 50 % Storno (10 Tage) ─────────────────────────────────────────────

test('J: 50 % Storno (10 Tage): Basis regulärer Preis → Mock-Transfer → „Stornorechnung offen“ → bezahlt', async () => {
  test.setTimeout(360_000);
  const { processId } = await acceptedBooking(staff, customerPage, {
    firstName: 'Jonas',
    lastName: 'Jetztnicht',
    email: 'jonas@e2e.example',
    machineLabel: '1×10 L',
    guestCount: 30,
    freeSyrupLiters: 1,
    confirmOrder: true,
    eventDate: berlinDayPlus(10),
  });
  await cancelViaUi(staff, processId, {
    days: 10,
    percent: 50,
    baseCents: MACHINE_1X10,
    feeCents: 3750,
  });
  const cancellation = staff.getByTestId('process-cancellation');
  await expect(cancellation.getByTestId('cancellation-finance-status')).toContainText(
    /Stornorechnung/,
  );
  await expect(cancellation).toContainText(formatEuro(3750));

  // Mock-Transfer über den Worker (Mock-Steuerung auf der Vorgangsseite des Stornos).
  await runDueJobs(staff);
  await expect(cancellation.getByTestId('cancellation-finance-status')).toContainText(
    'Stornorechnung offen',
  );
  const reference = cancellation.getByTestId('cancellation-reference');
  await expect(reference).toBeVisible();
  expect((await reference.innerText()).trim().length).toBeGreaterThan(0);
  await setPaid(staff);
  await expect(cancellation.getByTestId('cancellation-finance-status')).toContainText(
    'Stornorechnung bezahlt',
  );
  // Vorgang bleibt storniert (nie abgeschlossen).
  await expect(staff.locator('.badge', { hasText: 'Storniert' }).first()).toBeVisible();
  await expect(staff.locator('.badge', { hasText: 'Abgeschlossen' })).toHaveCount(0);
});

// ── K: 100 % Storno (2 Tage) ─────────────────────────────────────────────

test('K: 100 % Storno (2 Tage): Rabatt/Lieferung/Extras ändern die Basis nicht', async () => {
  test.setTimeout(360_000);
  const { processId } = await acceptedBooking(staff, customerPage, {
    firstName: 'Kurt',
    lastName: 'Kurzfristig',
    email: 'kurt@e2e.example',
    machineLabel: '1×10 L',
    guestCount: 30,
    freeSyrupLiters: 1,
    confirmOrder: true,
    eventDate: berlinDayPlus(2),
    // Rabatt 10 % (−7,50 €), Lieferung 49,00 €, 2 Kaufkanister: alles OHNE Einfluss auf die Basis.
    discountPercent: 10,
    expectedDiscountEuro: '7,50',
    delivery: { street: 'Teststraße 3', postalCode: '55129', city: 'Mainz', priceEuro: '49,00' },
    purchaseCanisters: 2,
  });
  await cancelViaUi(staff, processId, {
    days: 2,
    percent: 100,
    baseCents: MACHINE_1X10,
    feeCents: MACHINE_1X10,
  });
  const cancellation = staff.getByTestId('process-cancellation');
  await expect(cancellation.getByTestId('cancellation-finance-status')).toContainText(
    /Stornorechnung/,
  );
  await expect(cancellation).toContainText(formatEuro(MACHINE_1X10));
  await runDueJobs(staff);
  await expect(cancellation.getByTestId('cancellation-finance-status')).toContainText(
    'Stornorechnung offen',
  );
});

// ── L: Storno vs. Ausgabe (UI-Teil) ──────────────────────────────────────

test('L: Storno-Race (UI-Teil): nach Storno keine Ausgabe/Übergabe mehr anbietbar, Status „Storniert“', async () => {
  test.setTimeout(360_000);
  const { processId, processNumber } = await acceptedBooking(staff, customerPage, {
    firstName: 'Lars',
    lastName: 'Letzteminute',
    email: 'lars@e2e.example',
    machineLabel: '1×10 L',
    guestCount: 30,
    freeSyrupLiters: 1,
    confirmOrder: true,
    eventDate: berlinDayPlus(20),
  });
  await setAppointmentTime(staff, processId, 'Abholung / Ausgabe', fillAt(berlinDayPlus(1), 9));
  await setAppointmentTime(staff, processId, 'Rückgabe', fillAt(berlinDayPlus(3), 11));
  await staff.goto(`/vorgaenge/${processId}/ausgabe`);
  await assignAndPrepare(staff, 1, 'MR-10-01-03');
  await staff.goto(`/vorgaenge/${processId}`);
  await expect(staff.getByRole('link', { name: 'Übergabe starten' })).toBeVisible();

  await cancelViaUi(staff, processId, {
    days: 20,
    percent: 0,
    baseCents: MACHINE_1X10,
    feeCents: 0,
  });
  // Genau EIN gültiger Zustand: storniert – keine Übergabe mehr anbietbar.
  await expect(staff.getByRole('link', { name: 'Übergabe starten' })).toHaveCount(0);
  await expect(staff.getByRole('link', { name: 'Maschinen zuweisen' })).toHaveCount(0);
  await expect(staff.getByRole('link', { name: 'Ausgabe vorbereiten' })).toHaveCount(0);
  await expect(staff.getByTestId('return-action')).toHaveCount(0);
  await staff.goto('/ausgabe');
  await staff.getByLabel('Tag').fill(berlinDayPlus(1));
  await expect(staff.getByRole('heading', { name: 'Ausgabe' })).toBeVisible();
  await expect(staff.getByTestId(`issue-${processNumber}`)).toHaveCount(0);
  await staff.goto('/maschinen');
  await expect(staff.getByTestId('machine-MR-10-01-03')).toContainText('Einsatzbereit');
  await expect(staff.getByTestId('machine-MR-10-01-03')).not.toContainText('Vermietet');
});

// ── M: Folgevorgang aus Storno ───────────────────────────────────────────

test('M: Folgevorgang aus Storno: neue Nummer, Kunde übernommen, Buchung frisch/leer, Verknüpfung in beide Richtungen', async () => {
  test.setTimeout(120_000);
  await staff.goto(`/vorgaenge/${processI}`);
  await staff.getByTestId('process-cancellation').getByTestId('follow-up-create').click();
  await staff.waitForURL(
    (url) => /\/vorgaenge\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.includes(processI),
  );
  const heading = staff.getByRole('heading', { name: /^MR-\d{4}-\d{4,}$/ });
  await expect(heading).toBeVisible();
  const newNumber = (await heading.innerText()).trim();
  expect(newNumber).not.toBe(numberI);
  const newId = /\/vorgaenge\/([0-9a-f-]{36})/.exec(staff.url())![1]!;
  expect(newId).not.toBe(processI);

  // Kunde übernommen, kein Eventdatum, keine Buchung, offener Vorgang.
  await expect(staff.getByText(/Kunde:/).first()).toContainText('Immerfrei');
  await expect(staff.getByText(/Event:\s*–/)).toBeVisible();
  await expect(staff.locator('.badge', { hasText: 'Offen' }).first()).toBeVisible();
  await expect(staff.getByRole('link', { name: 'Anfrage erfassen' })).toBeVisible();
  await expect(staff.getByTestId('process-handover')).toHaveCount(0);
  await expect(staff.getByTestId('process-cancellation')).toHaveCount(0);
  const previous = staff.getByTestId('process-relation-previous');
  await expect(previous).toContainText(numberI);

  // Rückverknüpfung: der stornierte Vorgang zeigt den Folgevorgang; nur EIN Folgevorgang.
  await previous.click();
  await expect(staff).toHaveURL(new RegExp(`/vorgaenge/${processI}$`));
  await expect(staff.getByTestId('process-relation-follow-up')).toContainText(newNumber);
  await expect(staff.getByTestId('follow-up-create')).toHaveCount(0);
  await expect(staff.locator('.badge', { hasText: 'Storniert' }).first()).toBeVisible();
});
