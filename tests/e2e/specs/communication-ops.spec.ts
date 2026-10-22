/**
 * Phase-12-E2E-Szenarien G–S (Order §43) – Betriebs-Kommunikation über die
 * ECHTEN Ketten der Haupt-API (Projekt `chromium`) gegen die lokalen Fakes
 * (fakes/communication-fakes.ts): SMTP-Senke (TLS + AUTH), IMAP-INBOX,
 * WhatsApp-Graph-Fake (signierte Webhooks), Web-Push-Dienst (VAPID,
 * aes128gcm). Kein Fake in der API, kein echter Provider.
 *
 * G/H  1-Tag-Erinnerungen (Abholung/Lieferung) + Kunden-Aktionslinks
 * I/J  IMAP-Eingang: Antwort (In-Reply-To) → Vorgang → Staff-Antwort;
 *      nicht zuordenbar → „Nicht zugeordnet“ → Zuordnung
 * K/L  WhatsApp-Eingang + Staff-Antwort; Service-Window geschlossen
 * M–Q  Web-Push-Regeln (1 h, überfällige Rückgabe, Maschinenrisiko + 6 h,
 *      neues Gerät, Vertretung)
 * R    privater ICS-Feed (Staff-Origin-Link, UID/SEQUENCE, Datenminimierung)
 * S    Retention (Chatfoto bei Abschluss, Text nach 12 Monaten)
 * T (Demo-Isolation) liegt in communication-demo.spec.ts (Projekt
 * `demo-communication`, eigene Demo-API).
 *
 * Unabhängig: Basis-Seed + leere Fakes zu Beginn, eigene Vorgänge über die
 * echten Staff-/Web-Wege. Zeitverschiebungen nur an Zeitstempeln der
 * Testdatenbank (helpers/communication-ops.ts): Buchungsanlage vor die
 * Erinnerungsfälligkeit (Erinnerungen werden nie nachgeholt), 6-h-Frist des
 * Maschinenrisikos, Abschlusszeitpunkt für die 12-Monats-Retention. Der
 * Scheduler (`communication.scan_due`) und der IMAP-Abruf werden wie vom
 * Worker eingereiht und über die Mock-Steuerung „fällige Jobs ausführen“
 * abgearbeitet. Klartext-Geheimnisse (Aktions-/Feed-Token) existieren nur in
 * Variablen der Spec und werden ausschließlich boolesch verglichen.
 */
import { existsSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { WHATSAPP_GRAPH_API_VERSION, WHATSAPP_PHONE_NUMBER_ID } from '../fakes/constants.ts';
import { acceptedBooking } from '../helpers/booking.ts';
import {
  appointmentOf,
  assignAppointmentViaUi,
  backdateBookingCreation,
  backdateProcessCompletion,
  backdateRiskFollowUp,
  berlinIcsLocal,
  berlinInput,
  buildRawMail,
  createCustomerWithPhone,
  createProcessForCustomer,
  enqueueRetentionRun,
  expectPushCount,
  minutesFromNow,
  parseIcs,
  sha256Hex,
  whatsappStatusPayload,
} from '../helpers/communication-ops.ts';
import {
  E2E_STORAGE_ROOT,
  enqueueInboundPoll,
  enqueueScanDue,
  mailDeliveries,
  runDueJobsViaApi,
  singleMailDelivery,
} from '../helpers/jobs.ts';
import {
  clearImap,
  clearSink,
  deliverInboundMail,
  expectMailCount,
  expectMietRoyalMail,
  linkFromMail,
  waitForMail,
} from '../helpers/mail.ts';
import {
  clearPushRequests,
  createPushSubscriptionKeys,
  pushRequests,
  registerPushSubscription,
  verifyVapid,
  type PushSubscriptionKeys,
} from '../helpers/push.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  resetE2eDatabase,
  SELLER_EMAIL,
  SELLER_PASSWORD,
  WEB_ORIGIN,
} from '../helpers/seed.ts';
import {
  berlinDayPlus,
  ensureInitialStock,
  fillAt,
  issueBooking,
  JPEG_1X1,
  login,
  openSettlement,
  PNG_1X1,
  returnBooking,
  runDueJobs,
  setAppointmentTime,
} from '../helpers/settlement.ts';
import { queryTestDb } from '../helpers/voucher.ts';
import {
  clearWhatsAppFake,
  inboundWhatsAppPayload,
  postWhatsAppWebhook,
  whatsappRequests,
} from '../helpers/whatsapp.ts';

test.describe.configure({ mode: 'serial' });

const G_EMAIL = 'gisela.gerber@e2e.example';
const H_EMAIL = 'hannes.hofmann@e2e.example';
const K_EMAIL = 'karl.klartext@e2e.example';
const K_WA_ID = '4915123456701';
const L_EMAIL = 'lotte.lange@e2e.example';
const L_WA_ID = '4915123456702';
const N_EMAIL = 'nora.neumann@e2e.example';
const O_EMAIL = 'otto.ostermann@e2e.example';
const S_EMAIL = 'sabine.speicher@e2e.example';
const ERIKA = { optionLabel: 'E2E, Erika', name: 'Erika E2E' };

const NOT_AVAILABLE = 'Dieser Link ist nicht verfügbar.';
const WINDOW_CLOSED =
  'WhatsApp-Antwort derzeit nicht frei möglich. Bitte E-Mail oder Anruf nutzen.';
const BODY_DELETED = 'Inhalt gemäß Aufbewahrungsfrist gelöscht';
const PICKUP_HINTS = [
  'Die Maschine bitte aufrecht transportieren und gegen Umkippen sichern.',
  'Transport im Kofferraum oder auf der Ladefläche – nicht auf dem Sitz oder im Fußraum.',
  'Bitte ausreichend Tragepersonen einplanen.',
];
const DELIVERY_HINTS = [
  'Bitte sorge dafür, dass der Aufstellort frei zugänglich ist.',
  'Eine Kontaktperson vor Ort sollte im Lieferzeitfenster erreichbar sein.',
];
const I_MESSAGE_ID = 'gisela-antwort-1@e2e.example';
const I_TEXT = 'Hallo, wir kommen zu zweit zum Tragen. Passt das so?';
const I_REPLY = 'Hallo Gisela, zwei Tragepersonen reichen völlig. Bis morgen!';
const J_SUBJECT = 'Frage zur Lieferung am Wochenende';
const J_TEXT = 'Guten Tag, liefert ihr auch samstags nach Mainz-Gonsenheim?';
const K_TEXT = 'Hallo, kann ich die Maschine schon um 9 Uhr abholen?';
const K_REPLY = 'Hallo Karl, 9 Uhr passt – bis dann!';
const L_TEXT = 'Hallo, ist mein Termin noch aktuell?';
const S_MESSAGE_ID = 'sabine-foto-1@e2e.example';
const S_TEXT = 'Hallo, anbei ein Foto vom Kratzer, den wir bei der Abholung bemerkt haben.';
/** Neues Gerät für Szenario P (Geräte-Kennung „Mac · Safari“, auth/device.ts). */
const MAC_SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const MAC_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

let staff: Page; // Erika (Admin)
let viktor: Page; // Viktor (Verkauf, calendar.view – Vertretung in Q)
let customerPage: Page;
let processG = '';
let numberG = '';
let reminderMessageIdG = '';
let processH = '';
let numberH = '';
let keysErika: PushSubscriptionKeys;
let keysViktor: PushSubscriptionKeys;

test.beforeAll(async ({ browser }) => {
  resetE2eDatabase();
  await clearSink();
  await clearImap();
  await clearPushRequests();
  await clearWhatsAppFake();
  staff = await browser.newPage();
  viktor = await browser.newPage();
  customerPage = await browser.newPage();
});
test.afterAll(async () => {
  await staff.close();
  await viktor.close();
  await customerPage.close();
});

/** Einen Scheduler-Lauf wie der Worker (communication.scan_due) einreihen und abarbeiten. */
async function scanDue() {
  enqueueScanDue();
  await runDueJobsViaApi(staff);
}

/** Kundin-/Kundenantwort in die IMAP-INBOX legen und einen Abruf ausführen. */
async function receiveMail(raw: string) {
  await deliverInboundMail(raw);
  enqueueInboundPoll();
  await runDueJobsViaApi(staff);
}

function receipt(messageId: string) {
  const rows = queryTestDb<{
    status: string;
    match_reason: string | null;
    conversation_message_id: string | null;
  }>(
    // Phase 12 (retention-final): Message-ID nur noch als SHA-256 der normalisierten ID.
    `SELECT status, match_reason, conversation_message_id FROM inbound_mail_receipts
      WHERE message_id_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [messageId],
  );
  expect(rows, `Eingangsbeleg ${messageId}`).toHaveLength(1);
  return rows[0]!;
}

function contactsOfBooking(processId: string) {
  return queryTestDb<{
    kind: string;
    first_name: string;
    last_name: string;
    phone: string;
    updated_via_token_id: string | null;
  }>(
    `SELECT c.kind, c.first_name, c.last_name, c.phone, c.updated_via_token_id
       FROM booking_customer_contacts c JOIN bookings b ON b.id = c.booking_id
      WHERE b.process_id = $1 ORDER BY c.kind`,
    [processId],
  );
}

function actionTokens(processId: string) {
  return queryTestDb<{
    id: string;
    purpose: string;
    token_hash: string;
    appointment_id: string;
    expires_at: string;
    revoked_at: string | null;
  }>(
    `SELECT id, purpose, token_hash, appointment_id, expires_at, revoked_at
       FROM customer_action_tokens WHERE process_id = $1 ORDER BY created_at`,
    [processId],
  );
}

/** Datenminimierung (Order §30/§34): keiner der Werte darf im Text vorkommen. */
function expectNoneOf(text: string, forbidden: readonly string[], what: string) {
  for (const value of forbidden) {
    expect(text.includes(value), `${what} enthält „${value}“`).toBe(false);
  }
}

/** Neutrale 404 des Aktionslinks (gleiche Antwort für jeden Fehlerfall). */
async function expectNeutralActionLink(token: string, method: 'GET' | 'POST') {
  const url = `${WEB_ORIGIN}/api/public/actions/${encodeURIComponent(token)}`;
  const response =
    method === 'GET'
      ? await customerPage.request.get(url)
      : await customerPage.request.post(url, {
          data: { firstName: 'Max', lastName: 'Mustermann', phone: '0151 9999 0000' },
        });
  expect(response.status()).toBe(404);
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body.error).toMatchObject({ code: 'NOT_FOUND', message: NOT_AVAILABLE });
}

// ── G: 1-Tag-Erinnerung Abholung + „Abholperson ändern“ ──────────────────

test('G. 1-Tag-Erinnerung zur Abholung per E-Mail (Transporthinweise, Abholadresse, Rückgabezeit) mit Link „Abholperson ändern“: Kundin pflegt die Abholperson auf /kontakt/<token>, Staff sieht sie im Vorgang; ab 1 h vor dem Termin neutral „Dieser Link ist nicht verfügbar.“', async () => {
  test.setTimeout(300_000);
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  ({ processId: processG, processNumber: numberG } = await acceptedBooking(staff, customerPage, {
    firstName: 'Gisela',
    lastName: 'Gerber',
    email: G_EMAIL,
    machineLabel: '1×10 L',
    confirmOrder: true,
  }));
  // Erinnerungen werden nie nachgeholt: Buchung „vor drei Tagen“ (nur created_at).
  backdateBookingCreation(processG, 3);
  // Abholung morgen zur selben Uhrzeit (≈ 23 h) ⇒ 1-Tag-Fälligkeit liegt ≈ 1 h zurück.
  const pickupAt = minutesFromNow(23 * 60);
  await setAppointmentTime(staff, processG, 'Abholung / Ausgabe', berlinInput(pickupAt));
  await setAppointmentTime(staff, processG, 'Rückgabe', fillAt(berlinDayPlus(3), 11));

  await scanDue();
  const subject = `Erinnerung für morgen: Abholung – Vorgang ${numberG}`;
  const mail = await waitForMail({ to: G_EMAIL, subject });
  reminderMessageIdG = mail.messageId!;
  expectMietRoyalMail(mail);
  expect(mail.text).toContain('Morgen steht die Abholung zu deiner Buchung an.');
  expect(mail.text).toContain(`Vorgang: ${numberG}`);
  expect(mail.text).toMatch(
    new RegExp(
      `Abholung: [A-Za-z]+, \\d{2}\\.\\d{2}\\.\\d{4}, ${berlinInput(pickupAt).slice(11)} Uhr`,
    ),
  );
  expect(mail.text).toContain('Abholadresse: Teststraße 1, 55129 Mainz-Hechtsheim (SYNTHETISCH)');
  expect(mail.text).toMatch(/Rückgabe: [A-Za-z]+, \d{2}\.\d{2}\.\d{4}, 11:00 Uhr/);
  expect(mail.text).toContain('HINWEISE ZUM TRANSPORT');
  for (const hint of PICKUP_HINTS) {
    expect(mail.text).toContain(hint);
    expect(mail.html).toContain(hint);
  }
  // Die 7-Tage-Erinnerung war vor der Buchung fällig ⇒ nicht nachgeholt.
  await expectMailCount({ to: G_EMAIL, subject: /^Erinnerung: / }, 0);
  const outbox = singleMailDelivery(processG, 'reminder_1_day');
  expect(outbox).toMatchObject({ status: 'sent', recipient_email: G_EMAIL, attempts: 1 });
  expect(outbox.secret_payload_ciphertext).toBeNull();
  expect(mail.messageId).toBe(outbox.message_id);

  // Aktionslink: Token nur als Hash, an Termin + Zweck gebunden, gültig bis exakt 1 h vorher.
  const link = linkFromMail(mail, '/kontakt/');
  expect(new URL(link).origin).toBe(WEB_ORIGIN);
  const token = decodeURIComponent(new URL(link).pathname.slice('/kontakt/'.length));
  const tokens = actionTokens(processG);
  expect(tokens).toHaveLength(1);
  expect(tokens[0]).toMatchObject({
    purpose: 'pickup_contact_update',
    appointment_id: appointmentOf(processG, 'pickup').id,
    revoked_at: null,
  });
  expect(tokens[0]!.token_hash === sha256Hex(token), 'Token nur als SHA-256 gespeichert').toBe(
    true,
  );
  expect(JSON.stringify(tokens).includes(token), 'Aktions-Token im Klartext in der DB').toBe(false);
  expect(
    JSON.stringify(mailDeliveries({ processId: processG })).includes(token),
    'Aktions-Token im Klartext in der Outbox',
  ).toBe(false);
  expect(Date.parse(tokens[0]!.expires_at)).toBe(pickupAt.getTime() - 3_600_000);

  // Kundin öffnet den Link AUS DER MAIL und trägt die Abholperson ein.
  await customerPage.goto(link);
  await expect(customerPage.getByTestId('contact-page')).toHaveAttribute(
    'data-purpose',
    'pickup_contact_update',
  );
  await expect(customerPage.getByRole('heading', { name: 'Abholperson ändern' })).toBeVisible();
  await expect(customerPage.getByTestId('contact-process-number')).toHaveText(numberG);
  await expect(customerPage.getByTestId('contact-appointment-kind')).toHaveText('Abholung');
  await customerPage.getByLabel('Vorname').fill('Paul');
  await customerPage.getByLabel('Nachname').fill('Packer');
  await customerPage.getByLabel('Telefonnummer').fill('0151 1111 2222');
  await customerPage.getByTestId('contact-submit').click();
  await expect(customerPage.getByTestId('contact-saved')).toContainText('Paul Packer');
  await expect(customerPage.getByTestId('contact-saved')).toContainText('+4915111112222');
  // Datenminimierung der öffentlichen Seite: keine weiteren Kundendaten.
  expectNoneOf(await customerPage.content(), ['Gerber', G_EMAIL, 'Teststraße'], 'Aktionsseite');

  // Staff sieht die Abholperson im Vorgang.
  await staff.goto(`/vorgaenge/${processG}`);
  const pickupContact = staff.locator(
    '[data-testid="process-customer-contact"][data-kind="pickup"]',
  );
  await expect(pickupContact).toContainText('Abholperson:');
  await expect(pickupContact).toContainText('Paul Packer');
  await expect(pickupContact).toContainText('+4915111112222');

  // Eine Änderung überschreibt (genau ein aktueller Kontakt, keine Historie).
  await customerPage.reload();
  await expect(customerPage.getByLabel('Vorname')).toHaveValue('Paul');
  await customerPage.getByLabel('Vorname').fill('Petra');
  await customerPage.getByLabel('Telefonnummer').fill('0151 3333 4444');
  await customerPage.getByTestId('contact-submit').click();
  await expect(customerPage.getByTestId('contact-saved')).toContainText('Petra Packer');
  await staff.reload();
  await expect(pickupContact).toContainText('Petra Packer');
  await expect(pickupContact).toContainText('+4915133334444');
  await expect(pickupContact).not.toContainText('Paul');
  const contacts = contactsOfBooking(processG);
  expect(contacts).toEqual([
    {
      kind: 'pickup',
      first_name: 'Petra',
      last_name: 'Packer',
      phone: '+4915133334444',
      updated_via_token_id: tokens[0]!.id,
    },
  ]);
  expect(JSON.stringify(queryTestDb('SELECT * FROM booking_customer_contacts'))).not.toContain(
    '4915111112222',
  );

  // Weitere Scans: keine zweite Erinnerung.
  await scanDue();
  await expectMailCount({ to: G_EMAIL, subject }, 1);

  // Cutoff: Termin auf < 1 h vorziehen ⇒ der Link ist sofort neutral unbrauchbar.
  await setAppointmentTime(staff, processG, 'Abholung / Ausgabe', berlinInput(minutesFromNow(50)));
  await customerPage.reload();
  await expect(customerPage.getByTestId('contact-not-available')).toContainText(NOT_AVAILABLE);
  await expect(customerPage.getByTestId('contact-form')).toHaveCount(0);
  await expectNeutralActionLink(token, 'POST');
  await expectNeutralActionLink(token, 'GET');
  // Gleiche Antwort wie für einen unbekannten Token (kein Orakel).
  await expectNeutralActionLink('A'.repeat(43), 'GET');
  expect(contactsOfBooking(processG).map((row) => row.first_name)).toEqual(['Petra']);
  // Die Verschiebung erzeugt keine neue 1-Tag-Mail (Fälligkeit der neuen Zeit liegt > 6 h zurück).
  await scanDue();
  await expectMailCount({ to: G_EMAIL, subject: /^Erinnerung/ }, 1);
});

// ── H: 1-Tag-Erinnerung Lieferung + „Kontakt vor Ort ändern“ ─────────────

test('H. 1-Tag-Erinnerung zur Lieferung mit Link „Kontakt vor Ort ändern“ (delivery_contact_update): Lieferadresse + Hinweise in der Mail, Kontakt vor Ort gespeichert und im Vorgang sichtbar; der Abhol-Link wirkt nie auf einen Lieferkontakt', async () => {
  test.setTimeout(300_000);
  ({ processId: processH, processNumber: numberH } = await acceptedBooking(staff, customerPage, {
    firstName: 'Hannes',
    lastName: 'Hofmann',
    email: H_EMAIL,
    machineLabel: '1×10 L',
    confirmOrder: true,
    delivery: { street: 'Lieferweg 7', postalCode: '55116', city: 'Mainz', priceEuro: '49,00' },
  }));
  backdateBookingCreation(processH, 3);
  const deliveryAt = minutesFromNow(23 * 60 + 5);
  await setAppointmentTime(staff, processH, 'Lieferung', berlinInput(deliveryAt));
  await setAppointmentTime(staff, processH, 'Rückgabe', fillAt(berlinDayPlus(3), 12));

  await scanDue();
  const mail = await waitForMail({
    to: H_EMAIL,
    subject: `Erinnerung für morgen: Lieferung – Vorgang ${numberH}`,
  });
  expectMietRoyalMail(mail);
  expect(mail.text).toContain('Morgen steht die Lieferung zu deiner Buchung an.');
  expect(mail.text).toContain('Lieferadresse: Lieferweg 7\n55116 Mainz');
  expect(mail.text).toMatch(/Rückgabe: [A-Za-z]+, \d{2}\.\d{2}\.\d{4}, 12:00 Uhr/);
  expect(mail.text).toContain('HINWEISE ZUR LIEFERUNG');
  for (const hint of DELIVERY_HINTS) expect(mail.text).toContain(hint);
  // Keine Selbstabholer-Transporthinweise, keine Abholadresse in der Liefermail.
  expect(mail.text).not.toContain(PICKUP_HINTS[0]);
  expect(mail.text).not.toContain('Abholadresse');
  expect(mail.text).toContain('Kontakt vor Ort ändern:');
  const link = linkFromMail(mail, '/kontakt/');
  const token = decodeURIComponent(new URL(link).pathname.slice('/kontakt/'.length));
  const tokens = actionTokens(processH);
  expect(tokens).toHaveLength(1);
  expect(tokens[0]).toMatchObject({
    purpose: 'delivery_contact_update',
    appointment_id: appointmentOf(processH, 'delivery').id,
  });
  expect(tokens[0]!.token_hash === sha256Hex(token), 'Token nur als SHA-256 gespeichert').toBe(
    true,
  );

  await customerPage.goto(link);
  await expect(customerPage.getByTestId('contact-page')).toHaveAttribute(
    'data-purpose',
    'delivery_contact_update',
  );
  await expect(customerPage.getByRole('heading', { name: 'Kontakt vor Ort ändern' })).toBeVisible();
  await expect(customerPage.getByTestId('contact-process-number')).toHaveText(numberH);
  await expect(customerPage.getByTestId('contact-appointment-kind')).toHaveText('Lieferung');
  // Pflichtfelder: ungültige Telefonnummer ⇒ Validierungsfehler, nichts gespeichert.
  await customerPage.getByLabel('Vorname').fill('Lena');
  await customerPage.getByLabel('Nachname').fill('Lieferkontakt');
  await customerPage.getByLabel('Telefonnummer').fill('12');
  await customerPage.getByTestId('contact-submit').click();
  await expect(customerPage.getByTestId('contact-error')).toContainText('Telefonnummer');
  expect(contactsOfBooking(processH)).toHaveLength(0);
  await customerPage.getByLabel('Telefonnummer').fill('06131 555666');
  await customerPage.getByTestId('contact-submit').click();
  await expect(customerPage.getByTestId('contact-saved')).toContainText('Lena Lieferkontakt');

  await staff.goto(`/vorgaenge/${processH}`);
  const deliveryContact = staff.locator(
    '[data-testid="process-customer-contact"][data-kind="delivery"]',
  );
  await expect(deliveryContact).toContainText('Kontakt vor Ort (Lieferung):');
  await expect(deliveryContact).toContainText('Lena Lieferkontakt');
  await expect(deliveryContact).toContainText('+496131555666');
  await expect(
    staff.locator('[data-testid="process-customer-contact"][data-kind="pickup"]'),
  ).toHaveCount(0);

  // Zweckbindung: Der Liefer-Link setzt NUR den Lieferkontakt seiner Buchung; der
  // Abholkontakt aus G (gesetzt über den Pickup-Link) bleibt unberührt und G hat keinen
  // Lieferkontakt.
  expect(contactsOfBooking(processH)).toEqual([
    {
      kind: 'delivery',
      first_name: 'Lena',
      last_name: 'Lieferkontakt',
      phone: '+496131555666',
      updated_via_token_id: tokens[0]!.id,
    },
  ]);
  const gContacts = contactsOfBooking(processG);
  expect(gContacts.map((row) => [row.kind, row.first_name])).toEqual([['pickup', 'Petra']]);
  const apiContacts = (await (
    await staff.request.get(`/api/staff/processes/${processH}/customer-contacts`)
  ).json()) as { contacts: { kind: string }[] };
  expect(apiContacts.contacts.map((contact) => contact.kind)).toEqual(['delivery']);
});

// ── I: Antwort per E-Mail → Vorgang → Staff-Antwort ──────────────────────

test('I. Eingehende E-Mail als Antwort auf eine echte Miet-Royal-Mail (In-Reply-To) → Vorgang → Kommunikation; Staff antwortet per E-Mail → Zustellung mit In-Reply-To/References auf die Kundenmail', async () => {
  test.setTimeout(180_000);
  const pickupBefore = appointmentOf(processG, 'pickup');
  await receiveMail(
    buildRawMail({
      from: `Gisela Gerber <${G_EMAIL}>`,
      subject: `Re: Erinnerung für morgen: Abholung – Vorgang ${numberG}`,
      messageId: I_MESSAGE_ID,
      inReplyTo: reminderMessageIdG,
      text: I_TEXT,
    }),
  );
  // Zuordnung über In-Reply-To auf die Message-ID der Erinnerungsmail (Order §21 Stufe 1).
  expect(receipt(I_MESSAGE_ID)).toMatchObject({ status: 'matched', match_reason: 'in_reply_to' });

  await staff.goto(`/vorgaenge/${processG}`);
  await staff.getByTestId('process-communication-open').click();
  await expect(staff).toHaveURL(new RegExp(`/vorgaenge/${processG}/kommunikation$`));
  await expect(
    staff.getByRole('heading', { name: new RegExp(`Kommunikation · ${numberG}`) }),
  ).toBeVisible();
  const inbound = staff.locator('[data-testid="conversation-message"][data-direction="inbound"]', {
    hasText: I_TEXT,
  });
  await expect(inbound).toHaveCount(1);
  await expect(inbound.getByTestId('conversation-channel-badge')).toHaveText('E-Mail');
  await expect(inbound.getByTestId('conversation-sender')).toContainText('Gisela Gerber');
  // Automatische Mails erscheinen kompakt als Ereignisse (Order §24).
  await expect(
    staff.getByTestId('conversation-event').filter({ hasText: 'Erinnerung für morgen' }),
  ).toHaveCount(1);

  // Staff-Antwort per E-Mail – kein Empfängerfeld, Server bestimmt die Kundenadresse.
  await expect(staff.getByTestId('reply-channel-email')).toBeChecked();
  await staff.getByTestId('reply-body').fill(I_REPLY);
  await staff.getByTestId('reply-submit').click();
  await expect(staff.getByTestId('reply-success')).toHaveText('Antwort wird per E-Mail gesendet.');
  await expectMailCount({ to: G_EMAIL, subject: 'Nachricht von Miet-Royal' }, 0);
  await runDueJobsViaApi(staff);
  const reply = await waitForMail({
    to: G_EMAIL,
    subject: `Nachricht von Miet-Royal – Vorgang ${numberG}`,
  });
  expectMietRoyalMail(reply);
  expect(reply.to.map((entry) => entry.address)).toEqual([G_EMAIL]);
  expect(reply.inReplyTo).toBe(`<${I_MESSAGE_ID}>`);
  expect(reply.references).toContain(`<${I_MESSAGE_ID}>`);
  expect(reply.text).toContain(I_REPLY);
  expect(singleMailDelivery(processG, 'manual_customer_reply')).toMatchObject({
    status: 'sent',
    message_id: reply.messageId,
  });

  await staff.reload();
  const outbound = staff.locator(
    '[data-testid="conversation-message"][data-direction="outbound"]',
    { hasText: I_REPLY },
  );
  await expect(outbound.getByTestId('conversation-delivery-state')).toHaveText('Gesendet');
  await expect(outbound.getByTestId('conversation-sender')).toHaveText('Miet-Royal (Erika E2E)');
  // Eine Mail ist nie Autorisierung einer Fachaktion: Termin unverändert.
  const pickupAfter = appointmentOf(processG, 'pickup');
  expect(pickupAfter).toEqual(pickupBefore);
});

// ── J: Nicht zugeordnet → Zuordnung ──────────────────────────────────────

test('J. Nicht zuordenbare E-Mail erscheint unter Mehr › Kommunikation › Nicht zugeordnet (Absender, Betreff, Vorschau) → „Vorgang zuordnen“ → Nachricht im Vorgang, Liste leer', async () => {
  test.setTimeout(180_000);
  await receiveMail(
    buildRawMail({
      from: 'Jana Unbekannt <jana.unbekannt@e2e.example>',
      subject: J_SUBJECT,
      messageId: 'jana-frage-1@e2e.example',
      text: J_TEXT,
    }),
  );
  expect(receipt('jana-frage-1@e2e.example')).toMatchObject({
    status: 'unmatched',
    match_reason: null,
  });

  await staff.goto('/');
  await staff.getByTestId('nav-communication').click();
  await expect(staff.getByRole('heading', { name: 'Nicht zugeordnete Nachrichten' })).toBeVisible();
  const item = staff.getByTestId('unmatched-item').filter({ hasText: J_SUBJECT });
  await expect(item).toHaveCount(1);
  await expect(item.getByTestId('unmatched-channel')).toHaveText('E-Mail');
  await expect(item.getByTestId('unmatched-sender')).toHaveText(
    'Jana Unbekannt <jana.unbekannt@e2e.example>',
  );
  await expect(item.getByTestId('unmatched-subject')).toHaveText(J_SUBJECT);
  await expect(item.getByTestId('unmatched-preview')).toContainText(J_TEXT);

  await item.getByTestId('unmatched-assign').click();
  await item.getByTestId('unmatched-search').fill(numberH);
  await item
    .locator('.list-row', { hasText: numberH })
    .getByTestId('unmatched-search-result')
    .click();
  const dialog = staff.getByTestId('unmatched-assign-dialog');
  await expect(dialog).toContainText(numberH);
  await dialog.getByTestId('unmatched-assign-confirm').click();
  const notice = staff.getByTestId('unmatched-notice');
  await expect(notice).toContainText(`Nachricht wurde Vorgang ${numberH} zugeordnet.`);
  await expect(staff.getByTestId('unmatched-item').filter({ hasText: J_SUBJECT })).toHaveCount(0);
  const unmatched = (await (
    await staff.request.get('/api/staff/communication/unmatched')
  ).json()) as { messages: { subject: string | null }[] };
  expect(unmatched.messages.filter((message) => message.subject === J_SUBJECT)).toHaveLength(0);

  await notice.getByRole('link', { name: 'Kommunikation öffnen' }).click();
  await expect(staff).toHaveURL(new RegExp(`/vorgaenge/${processH}/kommunikation$`));
  const assigned = staff.locator('[data-testid="conversation-message"][data-direction="inbound"]', {
    hasText: J_TEXT,
  });
  await expect(assigned).toHaveCount(1);
  await expect(assigned).toContainText(J_SUBJECT);
  const row = queryTestDb<{ process_id: string; assigned_by_staff_id: string | null }>(
    'SELECT process_id, assigned_by_staff_id FROM conversation_messages WHERE id = $1',
    [receipt('jana-frage-1@e2e.example').conversation_message_id],
  )[0]!;
  expect(row.process_id).toBe(processH);
  expect(row.assigned_by_staff_id).not.toBeNull();
});

// ── K: WhatsApp-Eingang + Staff-Antwort ──────────────────────────────────

test('K. WhatsApp-Eingang (signierter Webhook, Text) → eindeutiger Kunde + einziger aktiver Vorgang → Staff-Antwort per WhatsApp → Graph-Fake erhält den offiziellen Request (Bearer, messaging_product, to, context); Status-Webhook „delivered“ ⇒ „Zugestellt“', async () => {
  test.setTimeout(180_000);
  const customerK = await createCustomerWithPhone(staff, {
    firstName: 'Karl',
    lastName: 'Klartext',
    email: K_EMAIL,
    phone: '0151 2345 6701',
  });
  const { processId: processK } = await createProcessForCustomer(staff, customerK);
  await clearWhatsAppFake();
  const inbound = inboundWhatsAppPayload({ from: K_WA_ID, profileName: 'Karl K.', text: K_TEXT });
  const accepted = await postWhatsAppWebhook(inbound.payload);
  expect(accepted.status).toBe(200);
  const stored = queryTestDb<{ process_id: string | null; customer_id: string | null }>(
    `SELECT process_id, customer_id FROM conversation_messages
      WHERE channel = 'whatsapp' AND provider_message_id = $1`,
    [inbound.messageId],
  );
  expect(stored).toEqual([{ process_id: processK, customer_id: customerK }]);

  await staff.goto(`/vorgaenge/${processK}/kommunikation`);
  const message = staff.locator('[data-testid="conversation-message"][data-direction="inbound"]', {
    hasText: K_TEXT,
  });
  await expect(message).toHaveCount(1);
  await expect(message.getByTestId('conversation-channel-badge')).toHaveText('WhatsApp');
  await expect(staff.getByTestId('whatsapp-window-open')).toBeVisible();
  await expect(staff.getByTestId('reply-channel-whatsapp')).toBeChecked();
  await staff.getByTestId('reply-body').fill(K_REPLY);
  await expect(staff.getByTestId('reply-submit')).toHaveText('Per WhatsApp senden');
  await staff.getByTestId('reply-submit').click();
  await expect(staff.getByTestId('reply-success')).toHaveText(
    'Antwort wird per WhatsApp gesendet.',
  );
  // Versand nur im Job (nie im Request).
  expect((await whatsappRequests()).filter((r) => r.endpoint === 'messages')).toHaveLength(0);
  await runDueJobsViaApi(staff);
  const sent = (await whatsappRequests()).filter((r) => r.endpoint === 'messages');
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    method: 'POST',
    path: `/${WHATSAPP_GRAPH_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    authorized: true,
    status: 200,
  });
  expect(sent[0]!.body).toEqual({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: K_WA_ID,
    type: 'text',
    text: { preview_url: false, body: K_REPLY },
    context: { message_id: inbound.messageId },
  });

  await staff.reload();
  const outbound = staff.locator(
    '[data-testid="conversation-message"][data-direction="outbound"]',
    { hasText: K_REPLY },
  );
  await expect(outbound.getByTestId('conversation-channel-badge')).toHaveText('WhatsApp');
  await expect(outbound.getByTestId('conversation-delivery-state')).toHaveText('Gesendet');
  const wamid = queryTestDb<{ provider_message_id: string }>(
    `SELECT provider_message_id FROM conversation_messages
      WHERE process_id = $1 AND channel = 'whatsapp' AND direction = 'outbound'`,
    [processK],
  );
  expect(wamid).toHaveLength(1);
  expect(wamid[0]!.provider_message_id).toMatch(/^wamid\./);
  const status = await postWhatsAppWebhook(
    whatsappStatusPayload(wamid[0]!.provider_message_id, 'delivered', K_WA_ID),
  );
  expect(status.status).toBe(200);
  await staff.reload();
  await expect(outbound.getByTestId('conversation-delivery-state')).toHaveText('Zugestellt');
});

// ── L: WhatsApp außerhalb des 24-h-Fensters ──────────────────────────────

test('L. WhatsApp außerhalb des 24-h-Fensters (letzte Kundennachricht > 24 h alt): UI-Hinweis, WhatsApp-Kanal deaktiviert, API 409 mit derselben Meldung, kein Graph-Request, keine Antwortzeile', async () => {
  test.setTimeout(180_000);
  const customerL = await createCustomerWithPhone(staff, {
    firstName: 'Lotte',
    lastName: 'Lange',
    email: L_EMAIL,
    phone: '0151 2345 6702',
  });
  const { processId: processL } = await createProcessForCustomer(staff, customerL);
  const inbound = inboundWhatsAppPayload({
    from: L_WA_ID,
    text: L_TEXT,
    timestamp: new Date(Date.now() - 25 * 3_600_000),
  });
  expect((await postWhatsAppWebhook(inbound.payload)).status).toBe(200);
  await clearWhatsAppFake();

  await staff.goto(`/vorgaenge/${processL}/kommunikation`);
  await expect(
    staff.locator('[data-testid="conversation-message"][data-direction="inbound"]', {
      hasText: L_TEXT,
    }),
  ).toHaveCount(1);
  await expect(staff.getByTestId('whatsapp-window-closed')).toHaveText(WINDOW_CLOSED);
  await expect(staff.getByTestId('reply-channel-whatsapp')).toBeDisabled();
  await expect(staff.getByTestId('reply-channel-email')).toBeChecked();
  await expect(staff.getByTestId('whatsapp-window-open')).toHaveCount(0);

  const response = await staff.request.post(`/api/staff/processes/${processL}/conversation/reply`, {
    data: { channel: 'whatsapp', body: 'Diese Nachricht darf nicht hinausgehen.' },
  });
  expect(response.status()).toBe(409);
  expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
    WINDOW_CLOSED,
  );
  await runDueJobsViaApi(staff);
  expect((await whatsappRequests()).filter((r) => r.endpoint === 'messages')).toHaveLength(0);
  const view = (await (
    await staff.request.get(`/api/staff/processes/${processL}/conversation`)
  ).json()) as {
    messages: { direction: string }[];
    whatsapp: { available: boolean; windowOpen: boolean };
  };
  expect(view.whatsapp).toMatchObject({ available: true, windowOpen: false });
  expect(view.messages.filter((m) => m.direction === 'outbound')).toHaveLength(0);
});

// ── M: 1-h-Termin-Push ───────────────────────────────────────────────────

test('M. Termin in 1 Stunde: Web Push an die zuständige Person (echter WebPushGateway → Push-Fake, VAPID, aes128gcm); Nutzlast ohne Kundendaten, url = Staff-Pfad; genau einmal', async () => {
  test.setTimeout(180_000);
  keysErika = createPushSubscriptionKeys();
  await registerPushSubscription(staff, keysErika, 'E2E-Erika');
  // Die Abholung aus G beginnt in < 1 h – zuständig wird Erika.
  await assignAppointmentViaUi(staff, processG, 'Abholung / Ausgabe', ERIKA);
  const pickup = appointmentOf(processG, 'pickup');
  expect(pickup.assigned_user_id).not.toBeNull();
  const startsIn = Date.parse(pickup.start_at!) - Date.now();
  expect(startsIn).toBeGreaterThan(0);
  expect(startsIn).toBeLessThan(3_600_000);

  await clearPushRequests();
  await scanDue();
  const [push] = await expectPushCount(keysErika, 'Termin in 1 Stunde', 1);
  expect(push!.request.status).toBe(201);
  expect(push!.request.headers.contentEncoding).toBe('aes128gcm');
  verifyVapid(push!.request);
  expect(push!.payload).toMatchObject({
    kind: 'appointment_1h',
    title: 'Termin in 1 Stunde',
    body: `Abholung ${numberG}`,
    url: `/vorgaenge/${processG}/termine`,
  });
  expectNoneOf(
    push!.plaintext,
    ['Gisela', 'Gerber', G_EMAIL, 'Petra', 'Packer', '4915133334444', 'Teststraße', '€'],
    'Push-Nutzlast',
  );

  // Weitere Scans: kein zweiter Push für denselben Termin/dieselbe Zuständigkeit.
  await scanDue();
  await expectPushCount(keysErika, 'Termin in 1 Stunde', 1);
  const deliveries = queryTestDb<{ status: string }>(
    `SELECT status FROM push_deliveries WHERE kind = 'appointment_1h' AND idempotency_key LIKE $1`,
    [`push:appointment_1h:${pickup.id}:%`],
  );
  expect(deliveries).toEqual([{ status: 'sent' }]);
});

// ── N: Überfällige Rückgabe genau einmal ─────────────────────────────────

test('N. Überfällige Rückgabe: genau EIN Push „Rückgabe überfällig“ an Planung/Admin je Vorfall – zwei Scans ⇒ ein Push', async () => {
  test.setTimeout(240_000);
  const { processId: processN, processNumber: numberN } = await acceptedBooking(
    staff,
    customerPage,
    { firstName: 'Nora', lastName: 'Neumann', email: N_EMAIL, machineLabel: '1×10 L' },
  );
  // Rückgabe gestern 11:00 ⇒ überfällig.
  await setAppointmentTime(staff, processN, 'Rückgabe', fillAt(berlinDayPlus(-1), 11));
  await expect(
    staff
      .locator('.entry-row', { hasText: 'Rückgabe' })
      .locator('.badge', { hasText: 'Überfällig' }),
  ).toBeVisible();

  await clearPushRequests();
  await scanDue();
  const [push] = await expectPushCount(keysErika, 'Rückgabe überfällig', 1);
  verifyVapid(push!.request);
  expect(push!.payload).toMatchObject({
    kind: 'return_overdue',
    body: `${numberN} – in Miet-Royal prüfen`,
    url: `/vorgaenge/${processN}/termine`,
  });
  expectNoneOf(push!.plaintext, ['Nora', 'Neumann', N_EMAIL], 'Push-Nutzlast');

  await scanDue();
  await expectPushCount(keysErika, 'Rückgabe überfällig', 1);
  const incidents = queryTestDb<{ admin_notified_at: string | null; resolved_at: string | null }>(
    `SELECT i.admin_notified_at, i.resolved_at FROM appointment_overdue_incidents i
       JOIN appointments a ON a.id = i.appointment_id WHERE a.process_id = $1`,
    [processN],
  );
  expect(incidents).toHaveLength(1);
  expect(incidents[0]!.admin_notified_at).not.toBeNull();
  expect(incidents[0]!.resolved_at).toBeNull();
  // Genau eine fachliche Zustellung (nur Erika hat Planungs-/Admin-Rechte).
  expect(queryTestDb(`SELECT id FROM push_deliveries WHERE kind = 'return_overdue'`)).toHaveLength(
    1,
  );
});

// ── O: Maschinenrisiko + genau eine 6-h-Erinnerung ───────────────────────

test('O. Maschinenrisiko (Sperre nach Zuweisung): initial genau ein Push „Maschinenkonflikt“, nach 6 h (zurückdatiert) genau eine Erinnerung, danach keine weitere', async () => {
  test.setTimeout(300_000);
  const { processId: processO, processNumber: numberO } = await acceptedBooking(
    staff,
    customerPage,
    { firstName: 'Otto', lastName: 'Ostermann', email: O_EMAIL, machineLabel: '1×10 L' },
  );
  await setAppointmentTime(staff, processO, 'Abholung / Ausgabe', fillAt(berlinDayPlus(5), 9));
  await setAppointmentTime(staff, processO, 'Rückgabe', fillAt(berlinDayPlus(6), 11));
  await staff.goto(`/vorgaenge/${processO}/ausgabe`);
  await staff.getByTestId('slot-1').getByRole('button', { name: 'Maschine wählen' }).click();
  await staff
    .getByTestId('suggest-MR-10-01-06')
    .getByRole('button', { name: 'Wählen', exact: true })
    .click();
  await expect(staff.getByText('Maschine MR-10-01-06 zugewiesen.')).toBeVisible();
  // Sperre im Mietzeitraum ⇒ die zugewiesene Maschine wird zum Risiko.
  await staff.goto('/maschinen');
  await staff.getByRole('link', { name: 'MR-10-01-06' }).click();
  await staff.getByLabel('Sperre von').fill(fillAt(berlinDayPlus(5), 8));
  await staff.getByLabel('Sperre bis').fill(fillAt(berlinDayPlus(6), 18));
  await staff.getByLabel('Grund (Pflicht)').fill('Wartung (E2E-Kommunikation)');
  await staff.getByRole('button', { name: 'Sperre setzen' }).click();
  await expect(staff.getByText('Sperre angelegt.')).toBeVisible();
  await staff.goto('/maschinen/risiken');
  await expect(staff.getByTestId('risk-MR-10-01-06')).toContainText(numberO);

  await clearPushRequests();
  await scanDue();
  const [initial] = await expectPushCount(keysErika, 'Maschinenkonflikt', 1);
  verifyVapid(initial!.request);
  expect(initial!.payload).toMatchObject({
    kind: 'machine_risk',
    body: `${numberO} – in Miet-Royal prüfen`,
    url: `/vorgaenge/${processO}/termine`,
  });
  expectNoneOf(initial!.plaintext, ['Otto', 'Ostermann', 'Wartung', 'MR-10-01-06'], 'Push');
  // Vor Ablauf der 6 h: kein weiterer Push.
  await scanDue();
  await expectPushCount(keysErika, 'Maschinenkonflikt', 1);
  await expectPushCount(keysErika, 'Maschinenkonflikt weiterhin offen', 0);
  const before = queryTestDb<{ admin_notified_at: string | null; follow_up_due_at: string | null }>(
    `SELECT admin_notified_at, follow_up_due_at FROM machine_risk_incidents
      WHERE process_id = $1 AND resolved_at IS NULL`,
    [processO],
  );
  expect(before).toHaveLength(1);
  expect(Date.parse(before[0]!.follow_up_due_at!) - Date.parse(before[0]!.admin_notified_at!)).toBe(
    6 * 3_600_000,
  );

  // 6 h „vergehen“ (nur die Fälligkeitsfelder) ⇒ genau EINE Erinnerung.
  expect(backdateRiskFollowUp(processO)).toBe(1);
  await scanDue();
  const [followUp] = await expectPushCount(keysErika, 'Maschinenkonflikt weiterhin offen', 1);
  expect(followUp!.payload).toMatchObject({
    kind: 'machine_risk_6h',
    body: `${numberO} – in Miet-Royal prüfen`,
    url: `/vorgaenge/${processO}/termine`,
  });
  await scanDue();
  await expectPushCount(keysErika, 'Maschinenkonflikt weiterhin offen', 1);
  await expectPushCount(keysErika, 'Maschinenkonflikt', 1);
  const after = queryTestDb<{ follow_up_sent_at: string | null }>(
    'SELECT follow_up_sent_at FROM machine_risk_incidents WHERE process_id = $1',
    [processO],
  );
  expect(after).toHaveLength(1);
  expect(after[0]!.follow_up_sent_at).not.toBeNull();
});

// ── P: Neues Gerät ⇒ Admin-Security-Push ─────────────────────────────────

test('P. Neues Gerät = neuer serverseitiger Geräte-Cookie (nicht der User-Agent): genau ein Admin-Security-Push je Gerät (ohne Namen/Gerätedaten, url /mitarbeiter); derselbe Geräte-Cookie mit anderem Browser-Kennzeichen ⇒ bekannt, kein Push', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  await clearPushRequests();
  const since = queryTestDb<{ now: string }>(`SELECT now()::text AS now`)[0]!.now;
  const newDeviceEvents = () =>
    queryTestDb<{ n: number }>(
      `SELECT count(*)::int AS n FROM staff_security_events
        WHERE type = 'session.new_device_login' AND created_at >= $1::timestamptz`,
      [since],
    )[0]!.n;
  // Gerät A: frischer Browser ⇒ Server setzt mr_staff_device ⇒ neues Gerät.
  const deviceA = await browser.newContext({ userAgent: MAC_SAFARI_UA });
  await login(await deviceA.newPage(), ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  const deviceCookie = (await deviceA.cookies()).find((c) => c.name === 'mr_staff_device');
  expect(deviceCookie, 'Geräte-Cookie gesetzt').toBeDefined();
  expect(deviceCookie!.httpOnly).toBe(true);
  await deviceA.close();
  await runDueJobsViaApi(staff);
  const [push] = await expectPushCount(keysErika, 'Neue Anmeldung', 1);
  verifyVapid(push!.request);
  expect(push!.request.headers.ttl).toBe('3600');
  expect(push!.payload).toMatchObject({ kind: 'session_new_device_login', url: '/mitarbeiter' });
  expectNoneOf(push!.plaintext, ['Erika', 'E2E', 'Mac', 'Safari', ADMIN_EMAIL], 'Push-Nutzlast');
  // Der Klartext des Geräte-Cookies steht nirgends in der Datenbank.
  const plaintextHits = queryTestDb<{ n: number }>(
    `SELECT count(*)::int AS n FROM staff_known_devices WHERE device_token_hash = $1`,
    [deviceCookie!.value],
  );
  expect(plaintextHits[0]!.n).toBe(0);
  expect(newDeviceEvents()).toBe(1);

  // Dasselbe Gerät (gleicher Geräte-Cookie) mit ANDEREM Browser-Kennzeichen ⇒ bekannt ⇒ kein Push.
  const sameDevice = await browser.newContext({ userAgent: MAC_CHROME_UA });
  await sameDevice.addCookies([deviceCookie!]);
  await login(await sameDevice.newPage(), ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await sameDevice.close();
  await runDueJobsViaApi(staff);
  await scanDue();
  await expectPushCount(keysErika, 'Neue Anmeldung', 1);

  // Gleiches Browser-Kennzeichen, aber anderes Gerät (kein Geräte-Cookie) ⇒ neues Gerät ⇒ genau ein weiterer Push.
  const otherDevice = await browser.newContext({ userAgent: MAC_SAFARI_UA });
  await login(await otherDevice.newPage(), ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await otherDevice.close();
  await runDueJobsViaApi(staff);
  await scanDue();
  await expectPushCount(keysErika, 'Neue Anmeldung', 2);
  expect(newDeviceEvents()).toBe(2);
});

// ── Q: Vertretung bekommt den 1-h-Push ───────────────────────────────────

test('Q. Vertretung: der 1-h-Push geht an die Vertretung, nicht an die ursprünglich zuständige Person – auch für einen bereits benachrichtigten Termin; Hinweis „Vertretung aktiv“ an die Vertretung', async () => {
  test.setTimeout(240_000);
  await login(viktor, SELLER_EMAIL, SELLER_PASSWORD, 'Viktor');
  keysViktor = createPushSubscriptionKeys();
  await registerPushSubscription(viktor, keysViktor, 'E2E-Viktor');
  // Lieferung aus H: Erika zuständig, Beginn in 40 min.
  await assignAppointmentViaUi(staff, processH, 'Lieferung', ERIKA);
  await setAppointmentTime(staff, processH, 'Lieferung', berlinInput(minutesFromNow(40)));
  // Vertretung Erika → Viktor ab jetzt.
  await staff.goto('/mitarbeiter');
  await expect(staff.getByRole('heading', { name: 'Vertretungen' })).toBeVisible();
  await staff.getByLabel('Ursprünglicher Mitarbeiter').selectOption({ label: 'E2E, Erika' });
  await staff.getByLabel('Vertretung', { exact: true }).selectOption({ label: 'Verkauf, Viktor' });
  await staff.getByLabel('Beginn').fill(berlinInput(minutesFromNow(0)));
  await staff.getByLabel('Ende', { exact: true }).fill(fillAt(berlinDayPlus(1), 23));
  await staff.getByRole('button', { name: 'Vertretung eintragen' }).click();
  const subRow = staff
    .locator('.list-row', { hasText: 'Erika E2E' })
    .filter({ hasText: 'Viktor Verkauf' });
  await expect(subRow.locator('.badge', { hasText: 'Aktiv' })).toBeVisible();

  await clearPushRequests();
  await scanDue();
  const [toViktor] = await expectPushCount(
    keysViktor,
    'Termin in 1 Stunde',
    1,
    `Lieferung ${numberH}`,
  );
  verifyVapid(toViktor!.request);
  expect(toViktor!.payload.url).toBe(`/vorgaenge/${processH}/termine`);
  // Der in M an Erika gemeldete Termin geht jetzt (neue effektive Zuständigkeit) an Viktor.
  await expectPushCount(keysViktor, 'Termin in 1 Stunde', 1, `Abholung ${numberG}`);
  await expectPushCount(keysViktor, 'Vertretung aktiv', 1);
  // Erika (Original) bekommt KEINEN Terminhinweis.
  await expectPushCount(keysErika, 'Termin in 1 Stunde', 0);
  const delivery = appointmentOf(processH, 'delivery');
  const users = queryTestDb<{ email: string }>(
    `SELECT u.email FROM push_deliveries d JOIN staff_users u ON u.id = d.user_id
      WHERE d.kind = 'appointment_1h' AND d.idempotency_key LIKE $1`,
    [`push:appointment_1h:${delivery.id}:%`],
  );
  expect(users).toEqual([{ email: SELLER_EMAIL }]);

  await scanDue();
  await expectPushCount(keysViktor, 'Termin in 1 Stunde', 2);
  await expectPushCount(keysErika, 'Termin in 1 Stunde', 0);

  // Vertretung beenden (die Zuständigkeit fällt an Erika zurück).
  await subRow.getByRole('button', { name: 'Jetzt beenden' }).click();
  await expect(subRow.locator('.badge', { hasText: 'Beendet' })).toBeVisible();
});

// ── R: Privater ICS-Feed ─────────────────────────────────────────────────

const STAFF_FEED_PREFIX = 'http://127.0.0.1:3102/api/public/calendar/';

async function fetchFeed(url: string) {
  const response = await fetch(url, { headers: { connection: 'close' } });
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    text: await response.text(),
  };
}

test('R. Privater ICS-Feed: Einstellungen → Kalender → Link erzeugen (UI), Abruf über den Staff-Origin-Link ohne Login; VEVENT mit stabiler UID, SEQUENCE = Terminversion, Europe/Berlin; nach Verschiebung SEQUENCE erhöht; keine Kundendaten/Preise; Neu erzeugen ⇒ alter Link 404', async () => {
  test.setTimeout(180_000);
  await staff.goto('/konto');
  await staff.getByTestId('konto-link-calendar').click();
  await expect(staff.getByRole('heading', { name: 'Kalender', exact: true })).toBeVisible();
  await staff.getByTestId('calendar-feed-generate').click();
  const url = (await staff.getByTestId('calendar-feed-url').innerText()).trim();
  // Absoluter Link über den Staff-Origin (Proxy `/api`, Härtung B16).
  expect(url.startsWith(STAFF_FEED_PREFIX), 'Feed-Link über den Staff-Origin').toBe(true);
  expect(url.endsWith('.ics')).toBe(true);
  const token = url.slice(STAFF_FEED_PREFIX.length, -'.ics'.length);
  expect(/^[A-Za-z0-9_-]{43}$/.test(token), 'Token: 32 Zufallsbytes base64url').toBe(true);
  const stored = queryTestDb<{ token_hash: string }>('SELECT * FROM calendar_feed_tokens');
  expect(stored).toHaveLength(1);
  expect(stored[0]!.token_hash === sha256Hex(token), 'nur der Hash in der DB').toBe(true);
  expect(JSON.stringify(stored).includes(token)).toBe(false);

  const first = await fetchFeed(url);
  expect(first.status).toBe(200);
  expect(first.contentType).toContain('text/calendar');
  const ics = parseIcs(first.text);
  expect(ics.lines[0]).toBe('BEGIN:VCALENDAR');
  expect(ics.lines.at(-1)).toBe('END:VCALENDAR');
  expect(ics.lines).toContain('VERSION:2.0');
  expect(ics.lines).toContain('TZID:Europe/Berlin');
  const pickupG = appointmentOf(processG, 'pickup');
  const deliveryH = appointmentOf(processH, 'delivery');
  // Nur Erikas effektive operative Termine (G-Abholung, H-Lieferung) – keine fremden/unzugewiesenen.
  expect(ics.events.map((event) => event.get('UID')).sort()).toEqual(
    [`${pickupG.id}@miet-royal`, `${deliveryH.id}@miet-royal`].sort(),
  );
  const eventG = ics.events.find((event) => event.get('UID') === `${pickupG.id}@miet-royal`)!;
  expect(eventG.get('SUMMARY')).toBe(`Miet-Royal – Abholung ${numberG}`);
  expect(eventG.get('DTSTART;TZID=Europe/Berlin')).toBe(
    berlinIcsLocal(new Date(pickupG.start_at!)),
  );
  expect(eventG.get('SEQUENCE')).toBe(String(pickupG.version - 1));
  expect(eventG.get('URL')).toBe(`http://127.0.0.1:3102/vorgaenge/${processG}/termine`);
  const eventH = ics.events.find((event) => event.get('UID') === `${deliveryH.id}@miet-royal`)!;
  expect(eventH.get('SUMMARY')).toBe(`Miet-Royal – Lieferung ${numberH}`);
  expect(eventH.get('SEQUENCE')).toBe(String(deliveryH.version - 1));
  // Datenminimierung (Order §34): keine Kundennamen/Kontakte/Adressen/Preise, keine Alarme.
  expectNoneOf(
    first.text,
    [
      'Gisela',
      'Gerber',
      'Hannes',
      'Hofmann',
      G_EMAIL,
      H_EMAIL,
      'Petra',
      'Packer',
      'Lena',
      '4915133334444',
      '496131555666',
      'Lieferweg',
      'Teststraße',
      '€',
      'EUR',
      'VALARM',
      'LOCATION',
    ],
    'ICS-Feed',
  );

  // Verschiebung ⇒ gleiche UID, SEQUENCE + 1, neue Berliner Ortszeit.
  await setAppointmentTime(staff, processH, 'Lieferung', fillAt(berlinDayPlus(2), 10));
  const moved = appointmentOf(processH, 'delivery');
  expect(moved.version).toBe(deliveryH.version + 1);
  const second = parseIcs((await fetchFeed(url)).text);
  const movedEvent = second.events.find(
    (event) => event.get('UID') === `${deliveryH.id}@miet-royal`,
  )!;
  expect(movedEvent.get('SEQUENCE')).toBe(String(Number(eventH.get('SEQUENCE')) + 1));
  expect(movedEvent.get('DTSTART;TZID=Europe/Berlin')).toBe(
    `${berlinDayPlus(2).replace(/-/g, '')}T100000`,
  );

  // Neu erzeugen ⇒ alter Link sofort ungültig (neutral 404), neuer Link gültig.
  await staff.goto('/einstellungen/kalender');
  await staff.getByTestId('calendar-feed-regenerate').click();
  await staff
    .getByTestId('calendar-feed-regenerate-dialog')
    .getByTestId('calendar-feed-regenerate-confirm')
    .click();
  const newUrl = (await staff.getByTestId('calendar-feed-url').innerText()).trim();
  expect(newUrl.startsWith(STAFF_FEED_PREFIX)).toBe(true);
  expect(newUrl === url, 'neuer Link unterscheidet sich').toBe(false);
  const old = await fetchFeed(url);
  expect(old.status).toBe(404);
  expect(old.text).toContain('Dieser Kalender ist nicht verfügbar.');
  expect((await fetchFeed(newUrl)).status).toBe(200);
  // Read-only: keine schreibenden Methoden auf dem Feed.
  const put = await fetch(newUrl, { method: 'PUT', body: 'x', headers: { connection: 'close' } });
  expect(put.status).toBe(404);
});

// ── S: Retention ─────────────────────────────────────────────────────────

test('S. Retention: Chatfoto (eingehende Mail mit JPEG) wird beim Vorgangsabschluss gelöscht (UI-Hinweis, Foto nicht mehr ladbar, Datei weg), Fach-/Übergabefotos und Dokumente bleiben; 12 Monate nach Abschluss wird der Chattext geleert', async () => {
  test.setTimeout(600_000);
  await ensureInitialStock(staff, 'sirup-kirsche', 'Sirup Kirsche', 10);
  await ensureInitialStock(staff, 'sirup-waldmeister', 'Sirup Waldmeister', 10);
  await ensureInitialStock(staff, 'strohhalme-25', 'Strohhalme (25 Stück)', 20);
  await ensureInitialStock(staff, 'becher-25', 'Becher (25 Stück)', 40);
  await ensureInitialStock(staff, 'mischkanister-6l', '6-L-Mischkanister', 10, { optional: true });
  const { processId: processS, processNumber: numberS } = await issueBooking(staff, customerPage, {
    firstName: 'Sabine',
    lastName: 'Speicher',
    email: S_EMAIL,
    machineCodes: ['MR-10-01-01'],
  });
  await runDueJobsViaApi(staff);
  const handoverMail = await waitForMail({
    to: S_EMAIL,
    subject: `Übergabeprotokoll – Vorgang ${numberS}`,
  });

  // Kundin antwortet auf das Übergabeprotokoll mit einem Foto.
  await receiveMail(
    buildRawMail({
      from: `Sabine Speicher <${S_EMAIL}>`,
      subject: `Re: Übergabeprotokoll – Vorgang ${numberS}`,
      messageId: S_MESSAGE_ID,
      inReplyTo: handoverMail.messageId!,
      text: S_TEXT,
      attachments: [{ filename: 'kratzer.jpg', contentType: 'image/jpeg', content: JPEG_1X1 }],
    }),
  );
  expect(receipt(S_MESSAGE_ID)).toMatchObject({ status: 'matched', match_reason: 'in_reply_to' });
  const photos = queryTestDb<{
    id: string;
    message_id: string;
    storage_key: string;
    sha256: string;
    deleted_at: string | null;
  }>(
    `SELECT p.id, p.message_id, p.storage_key, p.sha256, p.deleted_at FROM message_photos p
       JOIN conversation_messages m ON m.id = p.message_id WHERE m.process_id = $1`,
    [processS],
  );
  expect(photos).toHaveLength(1);
  const photo = photos[0]!;
  expect(photo.deleted_at).toBeNull();
  expect(photo.sha256).toBe(sha256Hex(JPEG_1X1));
  const photoFile = `${E2E_STORAGE_ROOT}/${photo.storage_key}`;
  expect(existsSync(photoFile)).toBe(true);
  const photoPath = `/api/staff/messages/${photo.message_id}/photos/${photo.id}`;
  const photoResponse = await staff.request.get(photoPath);
  expect(photoResponse.status()).toBe(200);
  expect((await photoResponse.body()).equals(JPEG_1X1)).toBe(true);
  await staff.goto(`/vorgaenge/${processS}/kommunikation`);
  const message = staff.locator('[data-testid="conversation-message"][data-direction="inbound"]', {
    hasText: S_TEXT,
  });
  await expect(message.getByTestId('conversation-photo')).toBeVisible();

  // Fachfotos (Übergabe) und finale Dokumente des Vorgangs.
  const handoverPhotos = queryTestDb<{ id: string; storage_key: string }>(
    `SELECT hp.id, hp.storage_key FROM handover_photos hp
       JOIN handovers h ON h.id = hp.handover_id WHERE h.process_id = $1`,
    [processS],
  );
  expect(handoverPhotos.length).toBeGreaterThan(0);

  // Rückgabe → Abrechnung → Transfer ⇒ Vorgang abgeschlossen ⇒ Chatfoto gelöscht.
  await returnBooking(staff, processS, { slots: 1 });
  await runDueJobsViaApi(staff);
  await openSettlement(staff, processS);
  await runDueJobs(staff);
  await expect(staff.getByTestId('settlement-status')).toContainText('An Buchhaltung übertragen');
  const statusRow = queryTestDb<{ main_status: string; completed_at: string | null }>(
    'SELECT main_status, completed_at FROM processes WHERE id = $1',
    [processS],
  );
  expect(statusRow[0]).toMatchObject({ main_status: 'completed' });
  await runDueJobsViaApi(staff);
  await expect
    .poll(
      () =>
        queryTestDb<{ deleted_at: string | null }>(
          'SELECT deleted_at FROM message_photos WHERE id = $1',
          [photo.id],
        )[0]!.deleted_at,
      { message: 'Chatfoto beim Abschluss gelöscht', timeout: 15_000 },
    )
    .not.toBeNull();
  expect(existsSync(photoFile), 'Fotodatei im Storage gelöscht').toBe(false);
  expect((await staff.request.get(photoPath)).status()).toBe(404);
  await staff.goto(`/vorgaenge/${processS}/kommunikation`);
  await expect(message.getByTestId('conversation-photo-deleted')).toHaveText(
    'Foto gemäß Aufbewahrungsfrist gelöscht',
  );
  await expect(message.getByTestId('conversation-photo')).toHaveCount(0);
  // Der Text bleibt bis 12 Monate nach Abschluss.
  await expect(message.getByTestId('conversation-body')).toHaveText(S_TEXT);

  // Fach-/Übergabefotos und Dokumente bleiben vollständig erhalten.
  const documents = queryTestDb<{ id: string; type: string; storage_key: string }>(
    'SELECT id, type, storage_key FROM documents WHERE process_id = $1 ORDER BY created_at',
    [processS],
  );
  expect(documents.map((document) => document.type)).toEqual(
    expect.arrayContaining([
      'order_confirmation',
      'delivery_note',
      'handover_protocol',
      'return_protocol',
    ]),
  );
  const expectBusinessFilesIntact = async () => {
    for (const handoverPhoto of handoverPhotos) {
      expect(existsSync(`${E2E_STORAGE_ROOT}/${handoverPhoto.storage_key}`)).toBe(true);
      const response = await staff.request.get(`/api/staff/handover/photos/${handoverPhoto.id}`);
      expect(response.status(), 'Übergabefoto abrufbar').toBe(200);
      expect((await response.body()).equals(PNG_1X1)).toBe(true);
    }
    for (const document of documents) {
      expect(existsSync(`${E2E_STORAGE_ROOT}/${document.storage_key}`)).toBe(true);
      const response = await staff.request.get(`/api/staff/documents/${document.id}`);
      expect(response.status(), `Dokument ${document.type} abrufbar`).toBe(200);
      expect((await response.body()).subarray(0, 4).toString('latin1')).toBe('%PDF');
    }
  };
  await expectBusinessFilesIntact();

  // 12 Monate nach Abschluss (Abschlusszeitpunkt zurückdatiert) ⇒ Retention-Lauf leert den Chattext.
  backdateProcessCompletion(processS, 13);
  enqueueRetentionRun();
  await runDueJobsViaApi(staff);
  const texts = queryTestDb<{ body: string; body_deleted_at: string | null }>(
    'SELECT body, body_deleted_at FROM conversation_messages WHERE process_id = $1',
    [processS],
  );
  expect(texts.length).toBeGreaterThan(1);
  for (const row of texts) {
    expect(row.body).toBe('');
    expect(row.body_deleted_at).not.toBeNull();
  }
  await staff.goto(`/vorgaenge/${processS}/kommunikation`);
  await expect(staff.getByTestId('conversation-body-deleted').first()).toHaveText(BODY_DELETED);
  await expect(staff.getByTestId('conversation-list')).not.toContainText(S_TEXT);
  await expect(
    staff.getByTestId('conversation-event').filter({ hasText: BODY_DELETED }).first(),
  ).toBeVisible();
  // Nur dieser Vorgang: Kommunikation offener Vorgänge (G) bleibt unberührt.
  expect(
    queryTestDb<{ body: string }>(
      'SELECT body FROM conversation_messages WHERE process_id = $1 AND body_deleted_at IS NULL',
      [processG],
    ).some((row) => row.body.includes(I_TEXT)),
  ).toBe(true);
  await expectBusinessFilesIntact();
});

// ── U: Push nach Session-Ablauf automatisch wieder anbinden (Finalisierung, Auftrag P1–P10) ──

interface PushStubOptions {
  permission: 'granted' | 'default' | 'denied';
  sub: { endpoint: string; p256dh: string; auth: string };
}

/**
 * Init-Script (läuft vor jedem Dokument): Headless-Chromium hat keinen echten
 * Push-Dienst. Der Stub liefert über `PushManager.getSubscription()` eine
 * BESTEHENDE Browser-Subscription (Endpoint beim Push-Fake + Testschlüssel),
 * setzt `Notification.permission` und zählt verbotene Aufrufe
 * (`Notification.requestPermission`, `PushManager.subscribe`). Alles Übrige –
 * Login, App-Start, Service Worker, Staff-Proxy, API – ist echt.
 */
function installPushStub({ permission, sub }: PushStubOptions): void {
  const calls = { requestPermission: 0, subscribe: 0 };
  (window as unknown as { __pushStub: typeof calls }).__pushStub = calls;
  if (typeof Notification === 'undefined' || typeof PushManager === 'undefined') return;
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => permission });
  Notification.requestPermission = async () => {
    calls.requestPermission += 1;
    return permission;
  };
  const existing = {
    endpoint: sub.endpoint,
    expirationTime: null,
    options: {},
    getKey: () => null,
    unsubscribe: async () => true,
    toJSON: () => ({
      endpoint: sub.endpoint,
      expirationTime: null,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    }),
  };
  PushManager.prototype.getSubscription = async function getSubscription() {
    return existing as unknown as PushSubscription;
  };
  PushManager.prototype.subscribe = async function subscribe() {
    calls.subscribe += 1;
    throw new Error('subscribe() darf beim automatischen Wiederanbinden nie aufgerufen werden');
  };
}

const isPushRegisterRequest = (request: { url(): string; method(): string }) =>
  request.method() === 'POST' &&
  new URL(request.url()).pathname === '/api/staff/push/subscriptions';

function pushStubCalls(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __pushStub: { requestPermission: number; subscribe: number } })
        .__pushStub,
  );
}

function subscriptionRow(endpoint: string) {
  return queryTestDb<{
    session_id: string | null;
    disabled_at: string | null;
    disabled_reason: string | null;
  }>(
    `SELECT session_id, disabled_at::text, disabled_reason FROM push_subscriptions WHERE endpoint = $1`,
    [endpoint],
  )[0];
}

/** Frischer Browser ohne Geräte-Cookie meldet sich als Admin an ⇒ Admin-Push „Neue Anmeldung“. */
async function loginFromNewDevice(browser: Browser): Promise<void> {
  const context = await browser.newContext();
  await login(await context.newPage(), ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await context.close();
}

test('U. Push nach Session-Ablauf: App-Start mit erteilter Browserberechtigung und vorhandener Browser-Subscription bindet sie automatisch wieder an (ohne Klick, ohne Prompt); default/denied ⇒ nichts', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  // Eigene Admin-Seite für fällige Jobs (Test läuft auch isoliert); ihr Login ist ein neues
  // Gerät, liegt aber VOR der Registrierung von keysU.
  const ops = await browser.newContext();
  const opsPage = await ops.newPage();
  await login(opsPage, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  const pollWithJobs = <T>(read: () => T | Promise<T>) =>
    expect.poll(
      async () => {
        await runDueJobsViaApi(opsPage);
        return read();
      },
      { timeout: 30_000 },
    );
  const keysU = createPushSubscriptionKeys();
  const sub = { endpoint: keysU.endpoint, p256dh: keysU.p256dh, auth: keysU.auth };
  const context = await browser.newContext();
  await context.addInitScript(installPushStub, { permission: 'granted' as const, sub });
  const page = await context.newPage();
  await login(page, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  // Ein Browser mit Push-Abo hat seinen Service Worker längst registriert.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  const firstBind = page.waitForRequest(isPushRegisterRequest);
  await page.reload();
  expect((await (await firstBind).response())?.status()).toBe(200);
  const before = subscriptionRow(keysU.endpoint);
  expect(before).toMatchObject({ disabled_at: null });
  expect(await pushStubCalls(page)).toEqual({ requestPermission: 0, subscribe: 0 });

  // P1: Session läuft per Inaktivität ab ⇒ das Gerät gilt sofort als inaktiv (kein Push mehr;
  // ohne aktives Gerät legt die API keine Zustellung an) und die Statusprüfung deaktiviert die
  // Subscription technisch (`session_expired`).
  queryTestDb(
    `UPDATE staff_sessions SET last_activity_at = now() - interval '31 days' WHERE id = $1`,
    [before!.session_id],
  );
  await clearPushRequests();
  await loginFromNewDevice(browser);
  await runDueJobsViaApi(opsPage);
  expect(await pushRequests(keysU)).toHaveLength(0);
  const status = await opsPage.request.post('/api/staff/push/subscriptions/status', {
    data: { endpoint: keysU.endpoint },
  });
  expect(await status.json()).toEqual({ active: false });
  expect(subscriptionRow(keysU.endpoint)?.disabled_reason).toBe('session_expired');

  // P2/P4: erneuter Login im selben Browser ⇒ automatisches Wiederanbinden, kein Prompt, kein subscribe().
  const rebind = page.waitForRequest(isPushRegisterRequest);
  await login(page, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  expect((await (await rebind).response())?.status()).toBe(200);
  const after = subscriptionRow(keysU.endpoint);
  expect(after).toMatchObject({ disabled_at: null, disabled_reason: null });
  expect(after!.session_id).not.toBe(before!.session_id);
  expect(await pushStubCalls(page)).toEqual({ requestPermission: 0, subscribe: 0 });
  await page.goto('/einstellungen/benachrichtigungen');
  await expect(page.getByTestId('push-status')).toHaveText('Push ist auf diesem Gerät aktiv.');
  await expect(page.getByTestId('push-enable')).toHaveCount(0);

  // P3: Push kommt wieder an – ohne Klick in den Einstellungen.
  await clearPushRequests();
  await loginFromNewDevice(browser);
  await pollWithJobs(async () => (await pushRequests(keysU)).length).toBe(1);
  await expectPushCount(keysU, 'Neue Anmeldung', 1);
  await context.close();

  // P5/P6: Berechtigung default bzw. denied ⇒ kein automatischer Prompt, keine Registrierung.
  for (const permission of ['default', 'denied'] as const) {
    const keys = createPushSubscriptionKeys();
    const other = await browser.newContext();
    await other.addInitScript(installPushStub, {
      permission,
      sub: { endpoint: keys.endpoint, p256dh: keys.p256dh, auth: keys.auth },
    });
    const otherPage = await other.newPage();
    const registerCalls: string[] = [];
    otherPage.on('request', (request) => {
      if (isPushRegisterRequest(request)) registerCalls.push(request.url());
    });
    await login(otherPage, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
    await otherPage.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await otherPage.reload();
    await expect(otherPage.getByRole('heading', { name: 'Heute' })).toBeVisible();
    await otherPage.goto('/einstellungen/benachrichtigungen');
    if (permission === 'denied') {
      await expect(otherPage.getByTestId('push-denied')).toHaveText(
        'Push ist auf diesem Gerät im Browser nicht aktiviert.',
      );
    } else {
      await expect(otherPage.getByTestId('push-enable')).toHaveText(
        'Push-Benachrichtigungen aktivieren',
      );
    }
    expect(registerCalls, `keine automatische Registrierung bei ${permission}`).toEqual([]);
    expect(await pushStubCalls(otherPage)).toEqual({ requestPermission: 0, subscribe: 0 });
    expect(subscriptionRow(keys.endpoint)).toBeUndefined();
    await other.close();
  }
  await ops.close();
});
