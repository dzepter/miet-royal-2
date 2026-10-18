/**
 * Phase-11-E2E-Szenarien A–J und L (Order §73): Wiedermieter-Gutschein mit
 * dem MOCK-Buchhaltungsprovider (Projekt `chromium`). Szenario K (signierter
 * Lexware-Zahlungs-Webhook) liegt in voucher-lexware.spec.ts (Projekt `lexware`).
 *
 * Unabhängig: Basis-Seed zu Beginn (inkl. leerer vouchers/voucher_redemptions),
 * eigene Buchungen über die echten Phase-3/4/6/7/9-Wege (helpers/settlement.ts).
 * Worker nur über `mock-run-jobs`, Zahlung nur über `mock-set-paid`, Zeit nur
 * über `mock-expire-wait`. Ausschließlich synthetische Testdaten.
 *
 * Klartextcode: Der Code erscheint nirgends in UI/API (Order §§12/14). Für die
 * Angebots-Szenarien entschlüsselt die Spec die verschlüsselte Versandkopie
 * des in Szenario A automatisch erzeugten Gutscheins IN-PROCESS
 * (helpers/voucher.ts `revealVoucherCode`, Serverfunktion direkt importiert,
 * nur Testdatenbank) – kein Reveal-Script, kein stdout/stderr, keine
 * Produktroute, keine DB-Mutation, und zugleich der Nachweis, dass die
 * Versandkopie entschlüsselbar ist (Pflichttest 23; Phase-11-Finale F15).
 *
 * Reihenfolge (seriell, fachlich bedingt): A erzeugt den Gutschein, B löst ihn
 * ein, H reaktiviert ihn durch kostenloses Storno; C–G nutzen den dann wieder
 * aktiven Gutschein in Entwürfen; I verbraucht ihn endgültig; J (Schaden) und
 * L (Phase-12-Vorbereitung) prüfen unabhängig davon.
 */
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, resetE2eDatabase } from '../helpers/seed.ts';
import {
  berlinDayPlus,
  cancelViaUi,
  cleanMachine,
  ensureInitialStock,
  expireWait,
  formatEuro,
  issueAndReturn,
  login,
  openSettlement,
  runDueJobs,
  setPaid,
} from '../helpers/settlement.ts';
import {
  acceptPublicOffer,
  applyVoucherExpectError,
  applyVoucherViaApi,
  applyVoucherViaUi,
  allVouchers,
  bookingOfProcess,
  cancellationOfProcess,
  createCustomerViaUi,
  customerDetail,
  draftOfferForCustomer,
  draftOfferForProcess,
  euro,
  expectCustomerVoucherCard,
  expectNoCustomerVoucherCard,
  expectNoPlaintextCode,
  expectVoucherApplied,
  formatVoucherCode,
  LABEL_DELIVERY_PENDING,
  LABEL_STATUS_ACTIVE,
  LABEL_STATUS_REDEEMED,
  LABEL_STATUS_RESERVED,
  NEVER_SENT,
  offerOfProcess,
  openOfferPage,
  openPublicOffer,
  processDetail,
  redemptionsOfVoucher,
  removeVoucherViaUi,
  revealVoucherCode,
  sendOfferExpectError,
  sendOfferViaUi,
  unknownVoucherCode,
  VOUCHER_INVALID_MESSAGE,
  VOUCHER_NOT_COMBINABLE_MESSAGE,
  VOUCHER_RESERVED_ELSEWHERE,
  voucherById,
  vouchersOfCustomer,
  type VoucherDbRow,
} from '../helpers/voucher.ts';

test.describe.configure({ mode: 'serial' });

/** Seed-Listenpreise (Cent): 1×10 L = 75,00 €, Sirup 12,00 €/L, 6-L-Kanister 5,00 €. */
const MACHINE_1X10 = 7500;
const VOUCHER_ON_1X10 = 1500;
const MACHINE_AFTER_VOUCHER = MACHINE_1X10 - VOUCHER_ON_1X10;
const SYRUP = 1200;
const CANISTER = 500;
const DELIVERY = 4900;

const LABEL_TRANSFERRED = 'An Buchhaltung übertragen';
const LABEL_WAITING = 'Kundenrückmeldung abwarten';
/** Standardbeträge des Gutscheins auf eine 1×10-L-Maschine. */
const AMOUNTS_1X10 = {
  regularCents: MACHINE_1X10,
  discountCents: VOUCHER_ON_1X10,
  afterCents: MACHINE_AFTER_VOUCHER,
};

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

let staff: Page; // Erika (Admin – alle Rechte inkl. system.settings für die Mock-Steuerung)
let customerPage: Page;
/** Szenario A: Ursprungsvorgang, Kundin, automatisch erzeugter Gutschein + Klartext (nur Test). */
let processA = '';
let customerWanda = '';
let voucherA: VoucherDbRow;
let codeCompact = '';
let codeFormatted = '';
let maskedReference = '';
/** Szenario B: Vorgang mit eingelöstem Gutschein (Basis für H). */
let processB = '';

test.beforeAll(async ({ browser }) => {
  resetE2eDatabase();
  staff = await browser.newPage();
  customerPage = await browser.newPage();
});
test.afterAll(async () => {
  await staff.close();
  await customerPage.close();
});

const status = () => staff.getByTestId('settlement-status');

/** Mock-Worker laufen lassen und den Transfer-Endzustand prüfen. */
async function transferViaJobs() {
  await runDueJobs(staff);
  await expect(status()).toContainText(LABEL_TRANSFERRED);
  await expect(staff.getByTestId('settlement-locked-hint')).toBeVisible();
  await expect(staff.getByTestId('payment-status')).toContainText('Offen');
}

async function expectProcessVoucherLine(processId: string) {
  await staff.goto(`/vorgaenge/${processId}`);
  await expect(staff.getByRole('heading', { name: /^MR-\d{4}-\d{4,}$/ })).toBeVisible();
  const line = staff.getByTestId('process-voucher');
  await expect(line).toContainText('20-%-Wiedermieter-Gutschein erstellt');
  await expect(line).toContainText(LABEL_DELIVERY_PENDING);
  await expect(line).not.toContainText(NEVER_SENT);
  return line;
}

// ── A: Schadenfreie, bezahlte Abrechnung ⇒ Gutschein ──────────────────────

test('A: Schadenfreie Rückgabe + bezahlte Mock-Abrechnung + Reinigung abgeschlossen ⇒ genau ein 20-%-Gutschein: Status am Kunden, Versand ausstehend, kein Klartext', async () => {
  test.setTimeout(600_000);
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await ensureInitialStock(staff, 'sirup-kirsche', 'Sirup Kirsche', 10);
  await ensureInitialStock(staff, 'sirup-waldmeister', 'Sirup Waldmeister', 10);
  await ensureInitialStock(staff, 'strohhalme-25', 'Strohhalme (25 Stück)', 20);
  await ensureInitialStock(staff, 'becher-25', 'Becher (25 Stück)', 40);
  await ensureInitialStock(staff, 'mischkanister-6l', '6-L-Mischkanister', 10, { optional: true });

  ({ processId: processA } = await issueAndReturn(staff, customerPage, {
    firstName: 'Wanda',
    lastName: 'Wiedermieter',
    email: 'wanda@e2e.example',
    machineCodes: ['MR-10-01-01'],
  }));
  customerWanda = (await processDetail(staff, processA)).customerId;
  expect(allVouchers()).toHaveLength(0);

  await openSettlement(staff, processA);
  await expect(staff.getByTestId('mock-badge')).toContainText('MOCK');
  await transferViaJobs();
  // Übertragen, aber offen ⇒ kein Gutschein (§47).
  await expectNoCustomerVoucherCard(staff, customerWanda);

  // Bezahlt, aber Maschine noch in Reinigung (Nachtragsfenster offen) ⇒ noch kein Gutschein (§14).
  await openSettlement(staff, processA);
  await setPaid(staff);
  await expect(staff.getByTestId('payment-status')).toContainText('Bezahlt');
  await runDueJobs(staff);
  expect(allVouchers()).toHaveLength(0);
  await expectNoCustomerVoucherCard(staff, customerWanda);

  // Reinigung abschließen (Trigger B) ⇒ Job ⇒ Gutschein entsteht (§15).
  await cleanMachine(staff, 'MR-10-01-01');
  await openSettlement(staff, processA);
  await runDueJobs(staff);
  const created = vouchersOfCustomer(customerWanda);
  expect(created).toHaveLength(1);
  voucherA = created[0]!;
  expect(voucherA).toMatchObject({
    status: 'active',
    discount_percent: 20,
    delivery_status: 'pending',
    delivered_at: null,
    reserved_offer_id: null,
    origin_process_id: processA,
  });
  expect(voucherA.code_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(voucherA.code_suffix).toMatch(/^[A-Z2-9]{4}$/);
  expect(voucherA.delivery_code_ciphertext).not.toBeNull();
  // 12 Kalendermonate (grob: 365–366 Tage) ab Aktivierung.
  const validityDays =
    (Date.parse(voucherA.expires_at) - Date.parse(voucherA.activated_at)) / 86_400_000;
  expect(validityDays).toBeGreaterThanOrEqual(364);
  expect(validityDays).toBeLessThanOrEqual(367);
  maskedReference = `MR20-••••-••••-${voucherA.code_suffix}`;

  // Kundenprofil: Aktiv – gültig bis …, Versand ausstehend, maskierte Referenz.
  await expectCustomerVoucherCard(staff, customerWanda, {
    statusLabel: LABEL_STATUS_ACTIVE,
    maskedReference,
  });
  await expect(staff.getByTestId('customer-voucher-status')).toContainText(/gültig bis/);
  await expectProcessVoucherLine(processA);

  // „bezahlt“ erneut gemeldet + Jobs ⇒ weiterhin genau ein Gutschein (§48).
  await openSettlement(staff, processA);
  await setPaid(staff);
  await runDueJobs(staff);
  expect(allVouchers()).toHaveLength(1);
  expect(voucherById(voucherA.id).status).toBe('active');

  // Klartext NUR aus der Versandkopie, in-process im Testprozess (F15) – Hash passt.
  codeCompact = revealVoucherCode(voucherA);
  codeFormatted = formatVoucherCode(codeCompact);
  expect(sha256(codeCompact)).toBe(voucherA.code_hash);
  expect(codeCompact.slice(-4)).toBe(voucherA.code_suffix);
  expect(voucherA.code_hash).not.toBe(codeCompact);
  expectNoPlaintextCode(voucherA.delivery_code_ciphertext!, codeCompact);

  // Kein Klartext in UI-Texten und API-Antworten (§§12/25/26).
  await staff.goto(`/kunden/${customerWanda}`);
  await expect(staff.getByTestId('customer-voucher')).toBeVisible();
  expectNoPlaintextCode(await staff.content(), codeCompact);
  await expectProcessVoucherLine(processA);
  expectNoPlaintextCode(await staff.content(), codeCompact);
  const customerApi = await customerDetail(staff, customerWanda);
  expectNoPlaintextCode(customerApi.text, codeCompact);
  expect(customerApi.text).not.toContain(voucherA.code_hash);
  expect(customerApi.text).not.toContain('deliveryCodeCiphertext');
  expect(customerApi.voucher).toMatchObject({
    id: voucherA.id,
    status: 'active',
    deliveryStatus: 'pending',
    maskedReference,
  });
  const processApi = await processDetail(staff, processA);
  expectNoPlaintextCode(processApi.text, codeCompact);
  expect(processApi.text).not.toContain(voucherA.code_hash);
  expect(processApi.voucher?.id).toBe(voucherA.id);
});

// ── B: Einlösen im neuen Vorgang ──────────────────────────────────────────

test('B: Neuer Vorgang derselben Kundin → Entwurf → Code anwenden → 20 % nur auf Maschine → senden (reserviert) → online annehmen → eingelöst', async () => {
  test.setTimeout(300_000);
  let versionId: string;
  let offerId: string;
  ({
    processId: processB,
    offerId,
    versionId,
  } = await draftOfferForCustomer(staff, {
    customerId: customerWanda,
    eventDate: berlinDayPlus(30),
  }));
  // Eingabe in Kleinschreibung mit Bindestrichen – serverseitig normalisiert (§11/§30/§31).
  await applyVoucherViaUi(staff, codeFormatted.toLowerCase());
  await expectVoucherApplied(staff, AMOUNTS_1X10, maskedReference);
  await expect(
    staff.getByText(`Fester Angebotswert: ${euro(MACHINE_AFTER_VOUCHER)}`),
  ).toBeVisible();
  // Keine Besitzerinfos, kein Klartext auf der Angebotsseite.
  expectNoPlaintextCode(await staff.content(), codeCompact);
  // Entwurf reserviert NICHT (§28/§43).
  expect(voucherById(voucherA.id)).toMatchObject({ status: 'active', reserved_offer_id: null });
  const draftApi = await offerOfProcess(staff, processB);
  expect(draftApi.current.voucher).toMatchObject({
    voucherId: voucherA.id,
    discountPercent: 20,
    machineSubtotalBeforeVoucherCents: MACHINE_1X10,
    voucherDiscountCents: VOUCHER_ON_1X10,
    machineSubtotalAfterVoucherCents: MACHINE_AFTER_VOUCHER,
    maskedReference,
  });
  expect(draftApi.current.fixedTotalCents).toBe(MACHINE_AFTER_VOUCHER);
  expectNoPlaintextCode(draftApi.text, codeCompact);

  // Senden ⇒ Reservierung am Offer, Gültigkeit gekappt (§28/§31).
  const path = await sendOfferViaUi(staff);
  expect(voucherById(voucherA.id)).toMatchObject({
    status: 'reserved',
    reserved_offer_id: offerId,
  });
  const sentApi = await offerOfProcess(staff, processB);
  expect(sentApi.current.id).toBe(versionId);
  expect(sentApi.current.effectiveStatus).toBe('sent');
  expect(Date.parse(sentApi.current.expiresAt!)).toBeLessThanOrEqual(
    Date.parse(voucherA.expires_at),
  );
  await expectCustomerVoucherCard(staff, customerWanda, { statusLabel: LABEL_STATUS_RESERVED });

  // Öffentliches Angebot: regulär / Gutschein 20 % / nach Gutschein – kein Klartext.
  const publicHtml = await openPublicOffer(customerPage, path);
  expectNoPlaintextCode(publicHtml, codeCompact);
  await expect(customerPage.getByTestId('offer-machine-regular')).toHaveText(euro(MACHINE_1X10));
  await expect(customerPage.getByTestId('offer-voucher-discount')).toHaveText(
    `-${euro(VOUCHER_ON_1X10)}`,
  );
  await expect(customerPage.getByTestId('offer-machine-after-voucher')).toHaveText(
    euro(MACHINE_AFTER_VOUCHER),
  );

  // Annahme verbraucht (§34): redeemed, Redemption, Buchungs-Snapshot ohne Klartext (§37).
  await acceptPublicOffer(customerPage);
  expect(voucherById(voucherA.id)).toMatchObject({ status: 'redeemed', reserved_offer_id: null });
  const redemptions = redemptionsOfVoucher(voucherA.id);
  expect(redemptions).toHaveLength(1);
  const booking = bookingOfProcess(processB);
  expect(redemptions[0]).toMatchObject({
    offer_id: offerId,
    booking_id: booking.id,
    process_id: processB,
    reactivated_at: null,
    final_consumption_reason: null,
  });
  expect(redemptions[0]!.remaining_validity_seconds).toBeGreaterThan(0);
  expect(booking.voucher_id).toBe(voucherA.id);
  expect(booking.voucher_snapshot).toMatchObject({
    voucherId: voucherA.id,
    voucherDiscountCents: VOUCHER_ON_1X10,
  });
  expectNoPlaintextCode(JSON.stringify(booking.voucher_snapshot), codeCompact);
  expectNoPlaintextCode(JSON.stringify(booking.totals_snapshot), codeCompact);
  expect(booking.totals_snapshot).toMatchObject({ voucherDiscountCents: VOUCHER_ON_1X10 });

  await expectCustomerVoucherCard(staff, customerWanda, { statusLabel: LABEL_STATUS_REDEEMED });
  // Angenommene Version zeigt den Gutschein weiterhin – ohne „entfernen“.
  await openOfferPage(staff, processB);
  await expect(staff.getByTestId('voucher-applied')).toBeVisible();
  await expect(staff.getByTestId('voucher-remove')).toHaveCount(0);
  await expect(staff.getByTestId('voucher-code-input')).toHaveCount(0);
});

// ── H: Kostenloses Storno ⇒ Reaktivierung ─────────────────────────────────

test('H: Kostenloses Storno (30 Tage, 0 %) ⇒ DERSELBE Gutschein reaktiviert, Restgültigkeit wiederhergestellt, erneut nutzbar; Folgevorgang setzt ihn nicht automatisch ein', async () => {
  test.setTimeout(300_000);
  const before = voucherById(voucherA.id);
  expect(before.status).toBe('redeemed');
  await cancelViaUi(staff, processB, {
    days: 30,
    percent: 0,
    baseCents: MACHINE_1X10,
    feeCents: 0,
  });
  await expect(
    staff.getByTestId('process-cancellation').getByTestId('cancellation-finance-status'),
  ).toContainText('Storniert – ohne Rechnung');

  // Derselbe Gutschein (ID/Hash unverändert) wieder aktiv (§40/§82/§84).
  const after = voucherById(voucherA.id);
  expect(after).toMatchObject({
    status: 'active',
    reserved_offer_id: null,
    code_hash: before.code_hash,
  });
  expect(after.version).toBeGreaterThan(before.version);
  expect(allVouchers()).toHaveLength(1);
  // Restgültigkeit: neues expires_at = Stornozeitpunkt + gespeicherte Restdauer (§40/§86).
  const redemption = redemptionsOfVoucher(voucherA.id)[0]!;
  const cancellation = cancellationOfProcess(processB);
  expect(redemption.cancellation_id).toBe(cancellation.id);
  expect(redemption.reactivated_at).not.toBeNull();
  const expected =
    Date.parse(cancellation.created_at) + redemption.remaining_validity_seconds * 1000;
  expect(Math.abs(Date.parse(after.expires_at) - expected)).toBeLessThan(5_000);
  // Reservierungs-/Einlösezeit ging verloren (nur wenige Sekunden) – nicht mehr.
  expect(Math.abs(Date.parse(after.expires_at) - Date.parse(before.expires_at))).toBeLessThan(
    10 * 60_000,
  );
  await expectCustomerVoucherCard(staff, customerWanda, {
    statusLabel: LABEL_STATUS_ACTIVE,
    maskedReference,
  });

  // Folgevorgang aus dem Storno: Gutschein NICHT automatisch eingesetzt (§46/§96) …
  await staff.goto(`/vorgaenge/${processB}`);
  await staff.getByTestId('process-cancellation').getByTestId('follow-up-create').click();
  await staff.waitForURL(
    (url) => /\/vorgaenge\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.includes(processB),
  );
  const followUpId = /\/vorgaenge\/([0-9a-f-]{36})/.exec(staff.url())![1]!;
  await draftOfferForProcess(staff, followUpId, { eventDate: berlinDayPlus(30) });
  await expect(staff.getByTestId('voucher-section')).toBeVisible();
  await expect(staff.getByTestId('voucher-applied')).toHaveCount(0);
  await expect(staff.getByText(`Fester Angebotswert: ${euro(MACHINE_1X10)}`)).toBeVisible();
  // … aber erneut verwendbar (kompakte Form ohne Bindestriche, §31/§88).
  await applyVoucherViaUi(staff, codeCompact);
  await expectVoucherApplied(staff, AMOUNTS_1X10, maskedReference);
  await removeVoucherViaUi(staff);
  expect(voucherById(voucherA.id).status).toBe('active');
});

// ── C: Fremder Kunde ⇒ neutral ────────────────────────────────────────────

test('C: Fremder Kunde: gültiger Code eines anderen Kunden ⇒ neutrale Meldung; API-Antwort identisch zu unbekanntem und fehlerhaft geformtem Code', async () => {
  test.setTimeout(180_000);
  const foreignId = await createCustomerViaUi(staff, {
    firstName: 'Fritz',
    lastName: 'Fremd',
    email: 'fritz@e2e.example',
  });
  const { versionId } = await draftOfferForCustomer(staff, { customerId: foreignId });
  await applyVoucherExpectError(staff, codeFormatted, VOUCHER_INVALID_MESSAGE);
  await expect(staff.getByTestId('voucher-error')).not.toContainText(/Wiedermieter|Kund|reserv/);
  // Bei Fehlschlag bleibt die EIGENE Eingabe im Feld stehen – vor der
  // Klartextprüfung leeren (die Seite selbst gibt den Code nirgends aus).
  await staff.getByTestId('voucher-code-input').fill('');
  expectNoPlaintextCode(await staff.content(), codeCompact);

  // API: fremd / unbekannt / fehlerhaft geformt ⇒ gleicher Status, gleiche Fehlermeldung (§55).
  const foreign = await applyVoucherViaApi(staff, versionId, codeFormatted);
  const unknown = await applyVoucherViaApi(staff, versionId, unknownVoucherCode());
  const malformed = await applyVoucherViaApi(staff, versionId, 'ABC-123');
  for (const response of [foreign, unknown, malformed]) {
    expect(response.status).toBe(400);
    const body = JSON.parse(response.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('VALIDATION');
    expect(body.error.message).toBe(VOUCHER_INVALID_MESSAGE);
    expectNoPlaintextCode(response.body, codeCompact);
    expect(response.body).not.toMatch(/abgelaufen|eingelöst|reserviert|Kunde/);
  }
  // Der Gutschein der Kundin bleibt unberührt; der fremde Kunde hat keinen.
  expect(voucherById(voucherA.id)).toMatchObject({ status: 'active', reserved_offer_id: null });
  expect(vouchersOfCustomer(foreignId)).toHaveLength(0);
  await expectNoCustomerVoucherCard(staff, foreignId);
});

// ── D: Nur Maschinenmiete ─────────────────────────────────────────────────

test('D: Gutschein + Lieferung + Kommission + Kaufkanister ⇒ 20 % NUR auf die Maschinenmiete', async () => {
  test.setTimeout(180_000);
  const { processId } = await draftOfferForCustomer(staff, {
    customerId: customerWanda,
    delivery: { street: 'Teststraße 4', postalCode: '55129', city: 'Mainz', priceEuro: '49,00' },
    extraSyrup: { name: 'Sirup Waldmeister', liters: 2 },
    purchaseCanisters: 2,
  });
  const fixedWithout = MACHINE_1X10 + DELIVERY + 2 * CANISTER;
  await expect(staff.getByText(`Fester Angebotswert: ${euro(fixedWithout)}`)).toBeVisible();
  await applyVoucherViaUi(staff, codeFormatted);
  await expectVoucherApplied(staff, AMOUNTS_1X10, maskedReference);
  // Lieferung, Kaufartikel und Kommissionsmaximum unverändert (§24/§60–62).
  const fixedWith = MACHINE_AFTER_VOUCHER + DELIVERY + 2 * CANISTER;
  await expect(staff.getByText(`Fester Angebotswert: ${euro(fixedWith)}`)).toBeVisible();
  await expect(staff.getByText(/Kommissionsartikel .* maximal/)).toContainText(euro(2 * SYRUP));
  const api = await offerOfProcess(staff, processId);
  expect(api.current.fixedTotalCents).toBe(fixedWith);
  expect(api.current.voucher).toMatchObject({
    machineSubtotalBeforeVoucherCents: MACHINE_1X10,
    voucherDiscountCents: VOUCHER_ON_1X10,
    machineSubtotalAfterVoucherCents: MACHINE_AFTER_VOUCHER,
  });
  await removeVoucherViaUi(staff);
  await expect(staff.getByText(`Fester Angebotswert: ${euro(fixedWithout)}`)).toBeVisible();
});

// ── E: Manueller Rabatt nicht kombinierbar ────────────────────────────────

test('E: Manueller Rabatt und Gutschein schließen sich in beide Richtungen aus', async () => {
  test.setTimeout(180_000);
  const { versionId } = await draftOfferForCustomer(staff, { customerId: customerWanda });
  await staff.getByLabel('Art').selectOption({ label: 'Prozent' });
  await staff.getByLabel('Prozent (z. B. 10)').fill('10');
  await staff.getByRole('button', { name: 'Rabatt setzen' }).click();
  await expect(staff.getByText(/Rabatt: -7,50/)).toBeVisible();
  // Rabatt gesetzt ⇒ Gutschein abgelehnt (§71).
  await applyVoucherExpectError(staff, codeFormatted, VOUCHER_NOT_COMBINABLE_MESSAGE);
  await staff.getByRole('button', { name: 'Rabatt entfernen' }).click();
  await expect(staff.getByText(/Rabatt: -7,50/)).toHaveCount(0);
  // Gutschein gesetzt ⇒ Rabattbedienung blockiert (§75/§76), API lehnt ab.
  await applyVoucherViaUi(staff, codeFormatted);
  await expectVoucherApplied(staff, AMOUNTS_1X10);
  await expect(staff.getByTestId('discount-blocked-by-voucher')).toContainText(
    VOUCHER_NOT_COMBINABLE_MESSAGE,
  );
  await expect(staff.getByLabel('Prozent (z. B. 10)')).toHaveCount(0);
  for (const discount of [
    { type: 'percent', value: 1000, reason: null },
    { type: 'fixed', value: 500, reason: null },
  ]) {
    const response = await staff.request.post(`/api/staff/offer-versions/${versionId}/discount`, {
      data: { discount },
    });
    expect(response.status()).toBe(400);
    expect(await response.text()).toContain(VOUCHER_NOT_COMBINABLE_MESSAGE);
  }
  await removeVoucherViaUi(staff);
});

// ── F: Sonderpreis nicht kombinierbar ─────────────────────────────────────

test('F: Maschinen-Sonderpreis und Gutschein schließen sich in beide Richtungen aus', async () => {
  test.setTimeout(180_000);
  const { versionId } = await draftOfferForCustomer(staff, { customerId: customerWanda });
  const specialInput = staff.getByLabel('Sonderpreis (EUR)').first();
  await specialInput.fill('50,00');
  await staff.getByRole('button', { name: 'Setzen', exact: true }).first().click();
  await expect(staff.locator('.badge', { hasText: 'Sonderpreis' })).toBeVisible();
  // Sonderpreis gesetzt ⇒ Gutschein abgelehnt (§73).
  await applyVoucherExpectError(staff, codeFormatted, VOUCHER_NOT_COMBINABLE_MESSAGE);
  await staff.getByRole('button', { name: 'Zurücksetzen' }).click();
  await expect(staff.locator('.badge', { hasText: 'Sonderpreis' })).toHaveCount(0);
  // Gutschein gesetzt ⇒ Sonderpreisbedienung weg (§77), API lehnt ab.
  await applyVoucherViaUi(staff, codeFormatted);
  await expectVoucherApplied(staff, AMOUNTS_1X10);
  await expect(staff.getByLabel('Sonderpreis (EUR)')).toHaveCount(0);
  const response = await staff.request.post(
    `/api/staff/offer-versions/${versionId}/special-price`,
    { data: { lineKey: 'machine', unitPriceCents: 5000 } },
  );
  expect(response.status()).toBe(400);
  expect(await response.text()).toContain(VOUCHER_NOT_COMBINABLE_MESSAGE);
  await removeVoucherViaUi(staff);
});

// ── G: Zwei parallele Angebote ────────────────────────────────────────────

test('G: Zwei parallele Angebote: beide Entwürfe ok, erster Versand reserviert, zweiter blockiert (409), Ablehnung gibt frei', async () => {
  test.setTimeout(300_000);
  const first = await draftOfferForCustomer(staff, { customerId: customerWanda });
  await applyVoucherViaUi(staff, codeFormatted);
  const second = await draftOfferForCustomer(staff, { customerId: customerWanda });
  await applyVoucherViaUi(staff, codeFormatted);
  expect(voucherById(voucherA.id)).toMatchObject({ status: 'active', reserved_offer_id: null });

  await openOfferPage(staff, first.processId);
  await sendOfferViaUi(staff);
  expect(voucherById(voucherA.id)).toMatchObject({
    status: 'reserved',
    reserved_offer_id: first.offerId,
  });
  await expectCustomerVoucherCard(staff, customerWanda, { statusLabel: LABEL_STATUS_RESERVED });

  await openOfferPage(staff, second.processId);
  await sendOfferExpectError(staff, VOUCHER_RESERVED_ELSEWHERE);
  expect(voucherById(voucherA.id)).toMatchObject({
    status: 'reserved',
    reserved_offer_id: first.offerId,
  });
  expect((await offerOfProcess(staff, second.processId)).current.effectiveStatus).toBe('draft');

  // Erstes Angebot abgelehnt ⇒ Reservierung frei (§32/§47).
  await openOfferPage(staff, first.processId);
  await staff.getByRole('button', { name: 'Als abgelehnt markieren' }).click();
  await expect(staff.locator('p.error')).toHaveCount(0);
  await expect(staff.getByRole('button', { name: 'Als abgelehnt markieren' })).toHaveCount(0);
  expect(voucherById(voucherA.id)).toMatchObject({ status: 'active', reserved_offer_id: null });
  await expectCustomerVoucherCard(staff, customerWanda, { statusLabel: LABEL_STATUS_ACTIVE });
  await openOfferPage(staff, second.processId);
  await removeVoucherViaUi(staff);
});

// ── I: Kostenpflichtiges Storno ⇒ verbraucht ──────────────────────────────

test('I: Kostenpflichtiges Storno (10 Tage, 50 %): Gutschein bleibt verbraucht, Stornobasis = regulärer Listenpreis, bezahlte Stornorechnung erzeugt keinen neuen Gutschein', async () => {
  test.setTimeout(300_000);
  const { processId, offerId } = await draftOfferForCustomer(staff, {
    customerId: customerWanda,
    eventDate: berlinDayPlus(10),
  });
  await applyVoucherViaUi(staff, codeFormatted);
  const path = await sendOfferViaUi(staff);
  await openPublicOffer(customerPage, path);
  await acceptPublicOffer(customerPage);
  expect(voucherById(voucherA.id).status).toBe('redeemed');
  const redemptions = redemptionsOfVoucher(voucherA.id);
  expect(redemptions).toHaveLength(2);
  const latest = redemptions.find((entry) => entry.offer_id === offerId)!;
  expect(latest).toBeDefined();

  // Stornobasis = regulärer Maschinen-Listenpreis VOR Gutschein (§42/§93/§94).
  await cancelViaUi(staff, processId, {
    days: 10,
    percent: 50,
    baseCents: MACHINE_1X10,
    feeCents: 3750,
  });
  const after = voucherById(voucherA.id);
  expect(after).toMatchObject({ status: 'redeemed', reserved_offer_id: null });
  const consumed = redemptionsOfVoucher(voucherA.id).find((entry) => entry.id === latest.id)!;
  expect(consumed.final_consumption_reason).toBe('paid_cancellation');
  expect(consumed.reactivated_at).toBeNull();
  expect(consumed.cancellation_id).toBe(cancellationOfProcess(processId).id);
  await expectCustomerVoucherCard(staff, customerWanda, { statusLabel: LABEL_STATUS_REDEEMED });

  // Stornorechnung übertragen und bezahlt ⇒ KEIN neuer Gutschein (§5/§41/§16).
  await staff.goto(`/vorgaenge/${processId}`);
  const cancellation = staff.getByTestId('process-cancellation');
  await expect(cancellation).toContainText(formatEuro(3750));
  await runDueJobs(staff);
  await expect(cancellation.getByTestId('cancellation-finance-status')).toContainText(
    'Stornorechnung offen',
  );
  await setPaid(staff);
  await expect(cancellation.getByTestId('cancellation-finance-status')).toContainText(
    'Stornorechnung bezahlt',
  );
  await runDueJobs(staff);
  expect(allVouchers()).toHaveLength(1);
  expect(voucherById(voucherA.id).status).toBe('redeemed');
});

// ── J: Schaden ⇒ kein Gutschein ───────────────────────────────────────────

test('J: Dokumentierter Schaden + bezahlte Abrechnung + Reinigung abgeschlossen ⇒ KEIN Gutschein', async () => {
  test.setTimeout(600_000);
  const { processId } = await issueAndReturn(
    staff,
    customerPage,
    {
      firstName: 'Dora',
      lastName: 'Delle',
      email: 'dora@e2e.example',
      machineCodes: ['MR-10-01-02'],
    },
    { damage: { slot: 1, description: 'Delle am Gehäuse (E2E)' } },
  );
  const customerDora = (await processDetail(staff, processId)).customerId;
  await openSettlement(staff, processId);
  const clarification = staff.getByTestId('clarification-item');
  await clarification.getByTestId('clarification-charge-amount').fill('120,00');
  await clarification.getByTestId('clarification-charge').click();
  await staff.getByTestId('notice-review').click();
  await expect(staff.getByTestId('notice-preview')).toBeVisible();
  await staff.getByTestId('notice-send').click();
  await expect(status()).toContainText(LABEL_WAITING);
  await expireWait(staff);
  await transferViaJobs();
  await setPaid(staff);
  await expect(staff.getByTestId('payment-status')).toContainText('Bezahlt');
  await runDueJobs(staff);
  await cleanMachine(staff, 'MR-10-01-02');
  await openSettlement(staff, processId);
  await runDueJobs(staff);

  expect(vouchersOfCustomer(customerDora)).toHaveLength(0);
  expect(allVouchers()).toHaveLength(1); // weiterhin nur Wandas Gutschein
  await expectNoCustomerVoucherCard(staff, customerDora);
  await staff.goto(`/vorgaenge/${processId}`);
  await expect(staff.locator('.badge', { hasText: 'Abgeschlossen' }).first()).toBeVisible();
  await expect(staff.getByTestId('process-voucher')).toHaveCount(0);
  expect((await processDetail(staff, processId)).voucher).toBeNull();
});

// ── L: Phase-12-Vorbereitung ──────────────────────────────────────────────

test('L: Phase-12-Vorbereitung: Versand ausstehend, verschlüsselte Kopie vorhanden, nur Hash in der DB, kein Klartext in UI/API/Snapshots', async () => {
  test.setTimeout(120_000);
  const row = voucherById(voucherA.id);
  expect(row).toMatchObject({ delivery_status: 'pending', delivered_at: null });
  expect(row.delivery_code_ciphertext).not.toBeNull();
  expect(row.delivery_code_ciphertext!.length).toBeGreaterThan(40);
  expectNoPlaintextCode(row.delivery_code_ciphertext!, codeCompact);
  expect(row.code_hash).toBe(sha256(codeCompact));
  expect(row.code_hash).not.toContain(codeCompact);
  // Kein Klartext in irgendeiner Gutschein-/Einlösungsspalte.
  expectNoPlaintextCode(JSON.stringify(row), codeCompact);
  expectNoPlaintextCode(JSON.stringify(redemptionsOfVoucher(voucherA.id)), codeCompact);

  // API-Antworten: weder Klartext noch Hash noch Versandkopie (§§25–29, 125).
  for (const text of [
    (await customerDetail(staff, customerWanda)).text,
    (await processDetail(staff, processA)).text,
    (await processDetail(staff, processB)).text,
    (await offerOfProcess(staff, processB)).text,
  ]) {
    expectNoPlaintextCode(text, codeCompact);
    expect(text).not.toContain(row.code_hash);
    expect(text).not.toContain(row.delivery_code_ciphertext!);
    expect(text).not.toContain('deliveryCodeCiphertext');
    expect(text).not.toContain('codeHash');
  }
  // UI: Versand ausstehend, nie „gesendet“; kein Klartext (§15/§97/§98).
  await expectCustomerVoucherCard(staff, customerWanda, {
    statusLabel: LABEL_STATUS_REDEEMED,
    deliveryLabel: LABEL_DELIVERY_PENDING,
    maskedReference,
  });
  expectNoPlaintextCode(await staff.content(), codeCompact);
  const line = await expectProcessVoucherLine(processA);
  await expect(line).toContainText(maskedReference);
  expectNoPlaintextCode(await staff.content(), codeCompact);
});
