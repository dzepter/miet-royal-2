/**
 * Phase-12-E2E-Szenarien A–E (Order §43) – Kommunikation über die ECHTE
 * Mail-Kette: Fachaktion ⇒ Outbox (`mail_deliveries`) ⇒ Job `mail.send`
 * (Mock-Steuerung „fällige Jobs ausführen“) ⇒ `SmtpMailGateway` (Nodemailer,
 * implizites TLS mit Zertifikatsprüfung, AUTH) ⇒ lokale SMTP-Senke
 * (fakes/smtp-sink.ts). Kein Fake in der API, kein echter Provider.
 * Szenario F (Lexware-Rechnungsmail) liegt in communication-lexware.spec.ts
 * (Projekt `lexware`); G–T folgen (E2E-Agent 2) auf denselben Fakes – „Z.“
 * ist der Smoke dieser Fakes (WhatsApp-Graph, Web Push).
 *
 * Unabhängig: Basis-Seed + leere Senke zu Beginn, eigene Vorgänge über die
 * echten Staff-/Web-Wege (helpers/booking.ts, settlement.ts, voucher.ts).
 * Zeitverschiebung nur für Mail-Retries (`releaseMailRetries`: next_attempt_at/
 * run_at auf „jetzt“) – keine fachliche Mutation. Klartext-Geheimnisse
 * (Angebots-/Dokument-Token, Gutscheincode) existieren nur in Variablen der
 * Spec und werden ausschließlich boolesch verglichen.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { expect, test, type Page } from '@playwright/test';
import {
  MAIL_REPLY_ADDRESS,
  PUSH_VAPID_PRIVATE_KEY,
  PUSH_VAPID_PUBLIC_KEY,
  SMTP_SINK_PASSWORD,
  SMTP_SINK_PORT,
  SMTP_SINK_USER,
  TEST_CA_FILE,
  WHATSAPP_ACCESS_TOKEN,
  WHATSAPP_APP_SECRET,
  WHATSAPP_GRAPH_FAKE_ORIGIN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_VERIFY_TOKEN,
} from '../fakes/constants.ts';
import {
  enqueueInboundPoll,
  runDueJobsViaApi,
  releaseMailRetries,
  singleMailDelivery,
} from '../helpers/jobs.ts';
import {
  clearImap,
  clearSink,
  deliverInboundMail,
  expectMailCount,
  expectMietRoyalMail,
  failNextSmtp,
  imapCommands,
  linkFromMail,
  pdfAttachment,
  smtpRejections,
  voucherCodeFromMail,
  waitForMail,
  type SinkMail,
} from '../helpers/mail.ts';
import {
  clearPushRequests,
  createPushSubscriptionKeys,
  decryptPush,
  pushRequests,
  registerPushSubscription,
  verifyVapid,
} from '../helpers/push.ts';
import { ADMIN_EMAIL, ADMIN_PASSWORD, resetE2eDatabase, WEB_ORIGIN } from '../helpers/seed.ts';
import {
  berlinDayPlus,
  cleanMachine,
  ensureInitialStock,
  issueAndReturn,
  issueBooking,
  login,
  openSettlement,
  PNG_1X1,
  returnBooking,
  runDueJobs,
  setPaid,
} from '../helpers/settlement.ts';
import {
  acceptPublicOffer,
  applyVoucherViaUi,
  createCustomerViaUi,
  customerDetail,
  draftOfferForCustomer,
  expectCustomerVoucherCard,
  expectNoPlaintextCode,
  expectVoucherApplied,
  formatVoucherCode,
  LABEL_DELIVERY_PENDING,
  LABEL_DELIVERY_SENT,
  LABEL_STATUS_ACTIVE,
  openPublicOffer,
  processDetail,
  queryTestDb,
  revealVoucherCode,
  sendOfferViaUi,
  voucherById,
  vouchersOfCustomer,
} from '../helpers/voucher.ts';
import {
  clearWhatsAppFake,
  inboundWhatsAppPayload,
  postWhatsAppWebhook,
  registerWhatsAppMedia,
  whatsappRequests,
  whatsappVerifyChallenge,
} from '../helpers/whatsapp.ts';

test.describe.configure({ mode: 'serial' });

const A_EMAIL = 'anja.angebot@e2e.example';
const C_EMAIL = 'carl.protokoll@e2e.example';
const D_EMAIL = 'dora.delle@e2e.example';

const LABEL_TRANSFERRED = 'An Buchhaltung übertragen';
const LABEL_WAITING = 'Kundenrückmeldung abwarten';
const NOTICE_QUEUED_TEXT =
  'Kundeninformation freigegeben – das Wartefenster beginnt mit bestätigtem Mailversand.';
const DAY_MS = 24 * 3_600_000;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

let staff: Page; // Erika (Admin – system.settings für die Mock-Steuerung)
let customerPage: Page;
let processA = '';
let numberA = '';
let processC = '';
let numberC = '';
let customerC = '';

test.beforeAll(async ({ browser }) => {
  resetE2eDatabase();
  await clearSink();
  staff = await browser.newPage();
  customerPage = await browser.newPage();
});
test.afterAll(async () => {
  await staff.close();
  await customerPage.close();
});

const status = () => staff.getByTestId('settlement-status');

/** Kommunikationsstatus-Zeile einer Mailart auf der Vorgangsseite (Order §35). */
async function expectCommunicationRow(
  processId: string,
  kind: string,
  expected: { status: string; label: string },
) {
  await staff.goto(`/vorgaenge/${processId}`);
  const row = staff.locator(`[data-testid="communication-status-row"][data-kind="${kind}"]`);
  await expect(row).toHaveAttribute('data-status', expected.status);
  await expect(row).toContainText(expected.label);
}

/** Bytes eines Staff-Dokuments (`/api/staff/documents/<id>`). */
async function documentBytes(pathOrId: string): Promise<Buffer> {
  const path = pathOrId.startsWith('/') ? pathOrId : `/api/staff/documents/${pathOrId}`;
  const response = await staff.request.get(path);
  expect(response.ok(), `Dokument ${path}`).toBe(true);
  return response.body();
}

function expectAttachmentEquals(mail: SinkMail, bytes: Buffer) {
  expect(bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
  expect(
    mail.attachments.some((attachment) => attachment.content.equals(bytes)),
    'Mailanhang ist byte-identisch mit dem finalen Dokument',
  ).toBe(true);
}

// ── A: Angebotsmail + Annahme ─────────────────────────────────────────────

test('A. Angebot per E-Mail: Versand eingereiht → mail.send → echte SMTP-Zustellung (TLS + AUTH) → Link aus der Mail öffnet das Angebot → Annahme; genau eine Mail, Token nie im Klartext in der DB', async () => {
  test.setTimeout(300_000);
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await ensureInitialStock(staff, 'sirup-kirsche', 'Sirup Kirsche', 10);
  await ensureInitialStock(staff, 'sirup-waldmeister', 'Sirup Waldmeister', 10);
  await ensureInitialStock(staff, 'strohhalme-25', 'Strohhalme (25 Stück)', 20);
  await ensureInitialStock(staff, 'becher-25', 'Becher (25 Stück)', 40);
  await ensureInitialStock(staff, 'mischkanister-6l', '6-L-Mischkanister', 10, { optional: true });

  const customerId = await createCustomerViaUi(staff, {
    firstName: 'Anja',
    lastName: 'Angebot',
    email: A_EMAIL,
  });
  ({ processId: processA, processNumber: numberA } = await draftOfferForCustomer(staff, {
    customerId,
    eventDate: berlinDayPlus(30),
  }));
  const path = await sendOfferViaUi(staff);
  const token = path.slice('/angebot/'.length);
  expect(token.length).toBeGreaterThanOrEqual(20);
  await expect(
    staff.getByText('Angebot zum E-Mail-Versand eingeplant.', { exact: false }),
  ).toBeVisible();

  // Vor dem Job: eingereiht, nicht zugestellt; Token nur verschlüsselt in der Outbox.
  const queued = singleMailDelivery(processA, 'offer');
  expect(queued).toMatchObject({ status: 'pending', recipient_email: A_EMAIL, attempts: 0 });
  expect(queued.secret_payload_ciphertext).not.toBeNull();
  expect(JSON.stringify(queued).includes(token), 'Offer-Token im Klartext in der Outbox').toBe(
    false,
  );
  await expectMailCount({ to: A_EMAIL }, 0);

  await runDueJobsViaApi(staff);
  const mail = await waitForMail({
    to: A_EMAIL,
    subject: `Dein Angebot von Miet-Royal – Vorgang ${numberA}`,
  });
  expectMietRoyalMail(mail);
  // Echte SMTP-Sitzung: AUTH mit den Server-Zugangsdaten, Umschlag = eingefrorener Empfänger.
  expect(mail.authUser).toBe(SMTP_SINK_USER);
  expect(mail.envelopeFrom).toBe('service@miet-royal.test');
  expect(mail.to.map((entry) => entry.address)).toEqual([A_EMAIL]);
  expect(mail.replyTo).toBe(MAIL_REPLY_ADDRESS);
  // Stabile Message-ID aus der Outbox (Order §9); Inhalt: Vorgang, Gültigkeit, Link.
  expect(mail.messageId).toBe(queued.message_id);
  expect(mail.text).toContain(numberA);
  expect(mail.text).toMatch(/gültig bis/);
  const link = linkFromMail(mail, '/angebot/');
  expect(link === `${WEB_ORIGIN}${path}`, 'Link aus der Mail = öffentlicher Angebotslink').toBe(
    true,
  );

  // Nach dem Versand: sent, Geheimnis-Payload gelöscht, neutraler Providercode.
  const sent = singleMailDelivery(processA, 'offer');
  expect(sent).toMatchObject({ status: 'sent', attempts: 1, provider_code: 'SMTP_250' });
  expect(sent.sent_at).not.toBeNull();
  expect(sent.secret_payload_ciphertext).toBeNull();
  // Token weder in Outbox noch in den Zugangs-Token (nur Hash, Order §11).
  const tokens = queryTestDb(
    'SELECT t.* FROM offer_access_tokens t JOIN offers o ON o.id = t.offer_id WHERE o.process_id = $1',
    [processA],
  );
  expect(tokens.length).toBeGreaterThan(0);
  expect(JSON.stringify(tokens).includes(token), 'Offer-Token im Klartext in der DB').toBe(false);
  expect(JSON.stringify(sent).includes(token)).toBe(false);
  await expectCommunicationRow(processA, 'offer', { status: 'sent', label: 'E-Mail gesendet' });

  // Kunde öffnet den Link AUS DER MAIL und nimmt verbindlich an.
  await customerPage.goto(link);
  await expect(customerPage.getByRole('heading', { name: 'Miet-Royal-Angebot' })).toBeVisible();
  await acceptPublicOffer(customerPage);

  // Genau einmal (Order §42 Nr. 17): weitere Job-Läufe senden nichts nach.
  await runDueJobsViaApi(staff);
  await expectMailCount({ to: A_EMAIL, subject: 'Dein Angebot' }, 1);
});

// ── B: Auftragsbestätigung mit PDF ───────────────────────────────────────

test('B. Auftragsbestätigung per E-Mail: freigeben → versenden (eingeplant) → mail.send → „Versendet“; PDF-Anhang byte-identisch mit der finalen AB', async () => {
  test.setTimeout(180_000);
  await staff.goto(`/vorgaenge/${processA}/angebot`);
  await expect(staff.getByRole('heading', { name: 'Auftragsbestätigung' })).toBeVisible();
  await staff.getByRole('button', { name: 'Auftragsbestätigung freigeben' }).click();
  await expect(staff.getByTestId('confirmation-status')).toHaveText('Freigegeben');
  await staff.getByRole('button', { name: 'Auftragsbestätigung versenden' }).click();
  await expect(staff.getByTestId('confirmation-status')).toHaveText('Versand eingeplant');
  await expectMailCount({ to: A_EMAIL, subject: 'Auftragsbestätigung' }, 0);

  const confirmation = (await (
    await staff.request.get(`/api/staff/processes/${processA}/confirmation`)
  ).json()) as { confirmation: { id: string; status: string; documentId: string | null } };
  expect(confirmation.confirmation.status).toBe('queued');
  expect(confirmation.confirmation.documentId).not.toBeNull();
  const outbox = singleMailDelivery(processA, 'order_confirmation');
  expect(outbox.status).toBe('pending');
  expect(outbox.attachments).toEqual([
    expect.objectContaining({ kind: 'document', documentId: confirmation.confirmation.documentId }),
  ]);

  await runDueJobsViaApi(staff);
  await staff.reload();
  await expect(staff.getByTestId('confirmation-status')).toHaveText('Versendet');
  const mail = await waitForMail({
    to: A_EMAIL,
    subject: `Auftragsbestätigung – Vorgang ${numberA}`,
  });
  expectMietRoyalMail(mail);
  expect(mail.attachments).toHaveLength(1);
  pdfAttachment(mail, /\.pdf$/i);
  expectAttachmentEquals(mail, await documentBytes(confirmation.confirmation.documentId!));
  expect(mail.messageId).toBe(outbox.message_id);
  expect(singleMailDelivery(processA, 'order_confirmation').status).toBe('sent');
  await expectCommunicationRow(processA, 'order_confirmation', {
    status: 'sent',
    label: 'E-Mail gesendet',
  });
  await expectMailCount({ to: A_EMAIL, subject: 'Auftragsbestätigung' }, 1);
});

// ── C: Übergabe-/Rückgabeprotokoll ───────────────────────────────────────

test('C. Übergabe- und Rückgabeprotokoll per E-Mail mit finalen PDF-Anhängen; temporärer SMTP-Fehler ⇒ Rückgabe bleibt final, Mail im Retry, danach zugestellt', async () => {
  test.setTimeout(600_000);
  ({ processId: processC, processNumber: numberC } = await issueBooking(staff, customerPage, {
    firstName: 'Carl',
    lastName: 'Protokoll',
    email: C_EMAIL,
    machineCodes: ['MR-10-01-01'],
  }));
  customerC = (await processDetail(staff, processC)).customerId;

  // Übergabe final ⇒ genau eine Outbox-Zeile, versendet erst im Job (nie im Finalisierungs-Request).
  const handoverOutbox = singleMailDelivery(processC, 'handover_protocol');
  expect(handoverOutbox.status).toBe('pending');
  await expectMailCount({ to: C_EMAIL, subject: 'Übergabeprotokoll' }, 0);
  await runDueJobsViaApi(staff);
  const handoverMail = await waitForMail({
    to: C_EMAIL,
    subject: `Übergabeprotokoll – Vorgang ${numberC}`,
  });
  expectMietRoyalMail(handoverMail);
  const packetsResponse = await staff.request.get(
    `/api/staff/processes/${processC}/delivery-packets`,
  );
  expect(packetsResponse.ok()).toBe(true);
  const { packets } = (await packetsResponse.json()) as {
    packets: { kind: string; status: string; documentIds: string[] }[];
  };
  const handoverPacket = packets.find((packet) => packet.kind === 'handover_completed');
  expect(handoverPacket?.status).toBe('sent');
  // Lieferschein + Übergabeprotokoll – je byte-identisch mit dem finalen Dokument.
  expect(handoverPacket!.documentIds).toHaveLength(2);
  expect(handoverMail.attachments).toHaveLength(2);
  for (const documentId of handoverPacket!.documentIds) {
    expectAttachmentEquals(handoverMail, await documentBytes(documentId));
  }

  // Rückgabe: der Mailserver lehnt den ersten Versuch temporär ab (451).
  await failNextSmtp({ stage: 'data', code: 451, recipient: C_EMAIL });
  const returnDocHref = await returnBooking(staff, processC, { slots: 1 });
  await runDueJobsViaApi(staff);
  const retrying = singleMailDelivery(processC, 'return_protocol');
  expect(retrying).toMatchObject({ status: 'retry', attempts: 1, last_error_code: 'SMTP_451' });
  expect(retrying.next_attempt_at).not.toBeNull();
  expect(
    (await smtpRejections()).some(
      (rejection) => rejection.code === 451 && rejection.rcptTo.includes(C_EMAIL),
    ),
  ).toBe(true);
  await expectMailCount({ to: C_EMAIL, subject: 'Rückgabeprotokoll' }, 0);
  // Order §3: Rückgabe bleibt final (Abrechnung existiert, Protokoll abrufbar), Mail „Retry“.
  await openSettlement(staff, processC);
  expect((await documentBytes(returnDocHref)).subarray(0, 4).toString('latin1')).toBe('%PDF');
  await expectCommunicationRow(processC, 'return_protocol', {
    status: 'retry',
    label: 'Erneuter Versuch geplant',
  });

  // Retry fällig ⇒ zugestellt, Anhang = finales Rückgabeprotokoll.
  releaseMailRetries(retrying.id);
  await runDueJobsViaApi(staff);
  const returnMail = await waitForMail({
    to: C_EMAIL,
    subject: `Rückgabeprotokoll – Vorgang ${numberC}`,
  });
  expectMietRoyalMail(returnMail);
  expect(returnMail.attachments).toHaveLength(1);
  expectAttachmentEquals(returnMail, await documentBytes(returnDocHref));
  // Stabile Message-ID über den Retry hinweg (Order §9).
  expect(returnMail.messageId).toBe(retrying.message_id);
  expect(singleMailDelivery(processC, 'return_protocol')).toMatchObject({
    status: 'sent',
    attempts: 2,
  });
  const after = (await (
    await staff.request.get(`/api/staff/processes/${processC}/delivery-packets`)
  ).json()) as { packets: { kind: string; status: string }[] };
  expect(after.packets.find((packet) => packet.kind === 'return_completed')?.status).toBe('sent');
  await expectCommunicationRow(processC, 'return_protocol', {
    status: 'sent',
    label: 'E-Mail gesendet',
  });
  await expectMailCount({ to: C_EMAIL, subject: 'Rückgabeprotokoll' }, 1);
  await expectMailCount({ to: C_EMAIL, subject: 'Übergabeprotokoll' }, 1);
});

// ── D: Schaden-Vorinformation, 24 h erst nach Sende-Erfolg ───────────────

interface SettlementTimes {
  notice_sent_at: string | null;
  wait_until: string | null;
}

function settlementTimes(processId: string): SettlementTimes {
  const rows = queryTestDb<SettlementTimes>(
    'SELECT notice_sent_at, wait_until FROM settlements WHERE process_id = $1',
    [processId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

test('D. Schaden-Vorinformation: permanenter SMTP-Fehler ⇒ kein Wartefenster; temporärer Fehler ⇒ Retry, weiterhin kein Fenster; erst der bestätigte Versand startet die 24 h; Mail mit Positionen, Summe und Dokumentlink', async () => {
  test.setTimeout(600_000);
  const { processId, processNumber, returnDocHref } = await issueAndReturn(
    staff,
    customerPage,
    {
      firstName: 'Dora',
      lastName: 'Delle',
      email: D_EMAIL,
      machineCodes: ['MR-10-01-02'],
    },
    { damage: { slot: 1, description: 'Kratzer an der Front (E2E-Kommunikation)' } },
  );
  await openSettlement(staff, processId);
  // Übergabe-/Rückgabeprotokollmails dieses Vorgangs zuerst zustellen (nicht Teil von D).
  await runDueJobs(staff);
  await waitForMail({ to: D_EMAIL, subject: 'Rückgabeprotokoll' });
  const clarification = staff.getByTestId('clarification-item');
  await clarification.getByTestId('clarification-charge-amount').fill('120,00');
  await clarification.getByTestId('clarification-charge').click();
  await expect(staff.getByTestId('settlement-line-damage_charge')).toContainText('120,00');

  // 1) Permanenter Fehler (550): Versand scheitert ⇒ KEIN Wartefenster.
  await failNextSmtp({ stage: 'data', code: 550, recipient: D_EMAIL });
  await staff.getByTestId('notice-review').click();
  await expect(staff.getByTestId('notice-preview')).toBeVisible();
  await staff.getByTestId('notice-send').click();
  await expect(staff.getByText(NOTICE_QUEUED_TEXT)).toBeVisible();
  await expect(status()).not.toContainText(LABEL_WAITING);
  expect(settlementTimes(processId)).toEqual({ notice_sent_at: null, wait_until: null });
  await runDueJobs(staff);
  const failed = singleMailDelivery(processId, 'settlement_damage_missing_notice');
  expect(failed).toMatchObject({ status: 'failed', last_error_code: 'SMTP_550' });
  expect(settlementTimes(processId)).toEqual({ notice_sent_at: null, wait_until: null });
  await expect(status()).not.toContainText(LABEL_WAITING);
  await expect(staff.getByTestId('settlement-wait-hint')).toHaveCount(0);
  await expectMailCount({ to: D_EMAIL, subject: 'Information zur Rückgabe' }, 0);

  // 2) Erneut freigeben; der Server lehnt temporär ab (451) ⇒ Retry, weiterhin kein Fenster.
  await staff.getByTestId('notice-review').click();
  await expect(staff.getByTestId('notice-failed')).toContainText(
    'Versand fehlgeschlagen – das Wartefenster hat nicht begonnen.',
  );
  await failNextSmtp({ stage: 'data', code: 451, recipient: D_EMAIL });
  await staff.getByTestId('notice-send').click();
  await expect(staff.getByText(NOTICE_QUEUED_TEXT)).toBeVisible();
  await runDueJobs(staff);
  const notices = queryTestDb<{ id: string; status: string; attempts: number; message_id: string }>(
    `SELECT id, status, attempts, message_id FROM mail_deliveries
      WHERE process_id = $1 AND kind = 'settlement_damage_missing_notice' ORDER BY created_at`,
    [processId],
  );
  expect(notices).toHaveLength(2);
  expect(notices[1]).toMatchObject({ status: 'retry', attempts: 1 });
  expect(notices[1]!.message_id).not.toBe(failed.message_id);
  expect(settlementTimes(processId)).toEqual({ notice_sent_at: null, wait_until: null });
  await expect(status()).not.toContainText(LABEL_WAITING);
  await expectMailCount({ to: D_EMAIL, subject: 'Information zur Rückgabe' }, 0);
  const lastRejection = (await smtpRejections()).filter((r) => r.rcptTo.includes(D_EMAIL)).at(-1)!;
  expect(lastRejection.code).toBe(451);

  // 3) Retry fällig ⇒ zugestellt ⇒ JETZT beginnt das 24-h-Fenster (ab Versandzeit).
  releaseMailRetries(notices[1]!.id);
  await runDueJobs(staff);
  await expect(status()).toContainText(LABEL_WAITING);
  await expect(staff.getByTestId('settlement-wait-hint')).toContainText(
    'Automatische Freigabe frühestens ab',
  );
  const sent = queryTestDb<{ status: string; sent_at: string }>(
    'SELECT status, sent_at FROM mail_deliveries WHERE id = $1',
    [notices[1]!.id],
  )[0]!;
  expect(sent.status).toBe('sent');
  const times = settlementTimes(processId);
  expect(times.notice_sent_at).not.toBeNull();
  expect(Date.parse(times.notice_sent_at!)).toBe(Date.parse(sent.sent_at));
  expect(Date.parse(times.notice_sent_at!)).toBeGreaterThan(Date.parse(lastRejection.receivedAt));
  expect(Date.parse(times.wait_until!) - Date.parse(times.notice_sent_at!)).toBe(DAY_MS);

  // Mailinhalt (Order §12): Vorgang, Position + Betrag, Gesamtsumme, Dokumentlink, kein Drohtext.
  const [mail] = await expectMailCount(
    { to: D_EMAIL, subject: `Information zur Rückgabe – Vorgang ${processNumber}` },
    1,
  );
  expectMietRoyalMail(mail!);
  expect(mail!.messageId).toBe(notices[1]!.message_id);
  expect(mail!.text).toContain(processNumber);
  expect(mail!.text).toMatch(/120,00\s€/);
  expect(mail!.text).toMatch(/Gesamtsumme: 120,00\s€/);
  expect(mail!.text).not.toMatch(/Frist|Mahnung|Inkasso|Anwalt|rechtliche Schritte/i);
  const link = linkFromMail(mail!, '/dokument/');
  const documentToken = new URL(link).pathname.slice('/dokument/'.length);
  // Dokument-Token nur als Hash in der DB.
  expect(
    JSON.stringify(queryTestDb('SELECT * FROM customer_action_tokens')).includes(documentToken),
    'Dokument-Token im Klartext in der DB',
  ).toBe(false);
  // Der Link öffnet GENAU das finale Rückgabeprotokoll (öffentlich, ohne Login).
  await customerPage.goto(link);
  await expect(customerPage.getByTestId('document-page')).toBeVisible();
  const publicPdf = await customerPage.request.get(
    `${WEB_ORIGIN}/api/public/documents/${encodeURIComponent(documentToken)}`,
  );
  expect(publicPdf.ok()).toBe(true);
  expect((await publicPdf.body()).equals(await documentBytes(returnDocHref))).toBe(true);

  // Weitere Job-Läufe: keine zweite Information, Frist unverändert (Order §12).
  await runDueJobs(staff);
  await expectMailCount({ to: D_EMAIL, subject: 'Information zur Rückgabe' }, 1);
  expect(settlementTimes(processId)).toEqual(times);
});

// ── E: Gutscheinmail ─────────────────────────────────────────────────────

test('E. Gutscheinmail: Staff sieht nie den Klartext; erster Versuch temporär abgelehnt ⇒ pending mit verschlüsselter Kopie; nach Zustellung Kopie gelöscht, Hash bleibt; Code aus der Mail einlösbar', async () => {
  test.setTimeout(600_000);
  // Abrechnung aus C übertragen und bezahlt, dann Reinigung abschließen (Phase-11-Trigger).
  await openSettlement(staff, processC);
  await runDueJobs(staff);
  await expect(status()).toContainText(LABEL_TRANSFERRED);
  await setPaid(staff);
  await expect(staff.getByTestId('payment-status')).toContainText('Bezahlt');
  await runDueJobs(staff);
  expect(vouchersOfCustomer(customerC)).toHaveLength(0);

  await failNextSmtp({ stage: 'data', code: 421, recipient: C_EMAIL });
  await cleanMachine(staff, 'MR-10-01-01');
  await openSettlement(staff, processC);
  await runDueJobs(staff);
  const created = vouchersOfCustomer(customerC);
  expect(created).toHaveLength(1);
  const voucher = created[0]!;
  // Zustellung im Retry: Gutschein gültig + pending, Versandkopie (verschlüsselt) vorhanden.
  expect(voucher).toMatchObject({
    status: 'active',
    delivery_status: 'pending',
    delivered_at: null,
    delivery_problem_code: null,
  });
  expect(voucher.delivery_code_ciphertext).not.toBeNull();
  const retrying = singleMailDelivery(processC, 'voucher_delivery');
  expect(retrying).toMatchObject({ status: 'retry', last_error_code: 'SMTP_421' });
  expect(retrying.secret_payload_ciphertext).not.toBeNull();
  await expectMailCount({ to: C_EMAIL, subject: 'Dein Gutschein' }, 0);

  // Nur im Testprozess: Versandkopie entschlüsseln (Nachweis „entschlüsselbar“, Hash passt).
  const code = revealVoucherCode(voucher);
  expect(sha256(code) === voucher.code_hash, 'Hash der Versandkopie').toBe(true);
  expectNoPlaintextCode(JSON.stringify(voucher), code);
  expectNoPlaintextCode(JSON.stringify(retrying), code);

  /** Kein Klartext in UI und Staff-API (Kunde, Vorgang, Outbox, Konversation). */
  const expectNoCodeForStaff = async () => {
    await staff.goto(`/kunden/${customerC}`);
    await expect(staff.getByTestId('customer-voucher')).toBeVisible();
    expectNoPlaintextCode(await staff.content(), code);
    await staff.goto(`/vorgaenge/${processC}`);
    await expect(staff.getByTestId('process-voucher')).toBeVisible();
    expectNoPlaintextCode(await staff.content(), code);
    expectNoPlaintextCode((await customerDetail(staff, customerC)).text, code);
    expectNoPlaintextCode((await processDetail(staff, processC)).text, code);
    for (const path of [
      `/api/staff/communication/deliveries?processId=${processC}`,
      '/api/staff/outbox',
      `/api/staff/processes/${processC}/communication-status`,
      `/api/staff/processes/${processC}/conversation`,
    ]) {
      const response = await staff.request.get(path);
      expect(response.ok(), path).toBe(true);
      expectNoPlaintextCode(await response.text(), code);
    }
  };
  await expectCustomerVoucherCard(staff, customerC, {
    statusLabel: LABEL_STATUS_ACTIVE,
    deliveryLabel: LABEL_DELIVERY_PENDING,
  });
  await expectNoCodeForStaff();

  // Retry fällig ⇒ Gutscheinmail zugestellt; Code steht NUR in der Mail.
  releaseMailRetries(retrying.id);
  await runDueJobsViaApi(staff);
  const mail = await waitForMail({ to: C_EMAIL, subject: 'Dein Gutschein von Miet-Royal' });
  expectMietRoyalMail(mail);
  expect(voucherCodeFromMail(mail) === code, 'Mailcode = Versandkopie').toBe(true);
  expect(mail.messageId).toBe(retrying.message_id);
  // Inhalt (Order §15): 20 %, Maschinenmiete, einmalig, kundengebunden, nicht kombinierbar, gültig bis.
  expect(mail.text).toContain('20 % Rabatt auf die Maschinenmiete');
  expect(mail.text).toContain('einmalig einlösbar und an dich als Kunde gebunden');
  expect(mail.text).toContain('nicht mit anderen Rabatten oder Sonderpreisen kombinierbar');
  expect(mail.text).toMatch(/gültig bis \d{2}\.\d{2}\.\d{4}/);

  // markDelivered: sent, delivered_at, Versandkopie gelöscht, Hash unverändert (Order §15).
  const after = voucherById(voucher.id);
  expect(after.delivery_status).toBe('sent');
  expect(after.delivered_at).not.toBeNull();
  expect(after.delivery_code_ciphertext).toBeNull();
  expect(after.code_hash).toBe(voucher.code_hash);
  const sentOutbox = singleMailDelivery(processC, 'voucher_delivery');
  expect(sentOutbox).toMatchObject({ status: 'sent', attempts: 2 });
  expect(sentOutbox.secret_payload_ciphertext).toBeNull();
  expectNoPlaintextCode(JSON.stringify(sentOutbox), code);
  await expectCustomerVoucherCard(staff, customerC, {
    statusLabel: LABEL_STATUS_ACTIVE,
    deliveryLabel: LABEL_DELIVERY_SENT,
  });
  await expectNoCodeForStaff();

  // Der Code AUS DER MAIL ist einlösbar: neues Angebot → anwenden → senden → annehmen.
  const draft = await draftOfferForCustomer(staff, {
    customerId: customerC,
    eventDate: berlinDayPlus(45),
  });
  await applyVoucherViaUi(staff, formatVoucherCode(code));
  await expectVoucherApplied(staff, { regularCents: 7500, discountCents: 1500, afterCents: 6000 });
  const path = await sendOfferViaUi(staff);
  expect(voucherById(voucher.id)).toMatchObject({
    status: 'reserved',
    reserved_offer_id: draft.offerId,
  });
  await openPublicOffer(customerPage, path);
  await acceptPublicOffer(customerPage);
  expect(voucherById(voucher.id).status).toBe('redeemed');
  // Genau EINE Gutscheinmail (kein erneuter automatischer Versand).
  await runDueJobsViaApi(staff);
  await expectMailCount({ to: C_EMAIL, subject: 'Dein Gutschein' }, 1);
});

// ── Z: Fakes-Smoke (Grundlage der Szenarien G–T) ─────────────────────────

test('Z. Kommunikations-Fakes (Smoke): Admin-Status ohne Secrets, SMTP-Check über TLS, WhatsApp-Verify/Signatur/Graph-Fake/Medien über HTTPS, Web Push an den Fake (VAPID, aes128gcm), IMAP-Eingang read-only', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // Admin-Status (system.settings): echte Konfiguration, keine Secrets.
  const statusResponse = await staff.request.get('/api/staff/communication/status');
  expect(statusResponse.ok()).toBe(true);
  const statusText = await statusResponse.text();
  const communicationStatus = JSON.parse(statusText) as {
    mail: {
      enabled: boolean;
      gateway: string;
      smtpHost: string;
      smtpPort: number;
      smtpTls: string;
    };
    whatsapp: { mode: string };
    push: { enabled: boolean; vapidPublicKey: string };
  };
  expect(communicationStatus.mail).toMatchObject({
    enabled: true,
    gateway: 'smtp',
    smtpHost: '127.0.0.1',
    smtpPort: SMTP_SINK_PORT,
    smtpTls: 'implicit',
  });
  expect(communicationStatus.whatsapp.mode).toBe('live');
  expect(communicationStatus.push).toMatchObject({
    enabled: true,
    vapidPublicKey: PUSH_VAPID_PUBLIC_KEY,
  });
  for (const secret of [
    SMTP_SINK_PASSWORD,
    WHATSAPP_ACCESS_TOKEN,
    WHATSAPP_APP_SECRET,
    WHATSAPP_VERIFY_TOKEN,
    PUSH_VAPID_PRIVATE_KEY,
  ]) {
    expect(statusText.includes(secret), 'Secret in der Status-Antwort').toBe(false);
  }
  const check = await staff.request.post('/api/staff/communication/mail/check');
  expect(check.ok()).toBe(true);
  expect(await check.json()).toMatchObject({ ok: true, gateway: 'smtp' });

  // WhatsApp: Verify-Challenge, Signaturprüfung, signierter Webhook, Graph-Fake, Medien (HTTPS).
  expect(await whatsappVerifyChallenge('e2e-challenge-42')).toEqual({
    status: 200,
    body: 'e2e-challenge-42',
  });
  expect((await whatsappVerifyChallenge('x', 'falsches-verify-token-123')).status).toBe(403);
  const inbound = inboundWhatsAppPayload({ from: '4915100000099', text: 'Hallo (E2E-Smoke)' });
  expect((await postWhatsAppWebhook(inbound.payload, { signature: 'sha256=00' })).status).toBe(401);
  const accepted = await postWhatsAppWebhook(inbound.payload);
  expect(accepted.status).toBe(200);
  expect(JSON.parse(accepted.body)).toMatchObject({ received: true, messages: 1 });
  await clearWhatsAppFake();
  const graph = await fetch(
    `${WHATSAPP_GRAPH_FAKE_ORIGIN}/v25.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        'content-type': 'application/json',
        connection: 'close',
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: '4915100000099', type: 'text' }),
    },
  );
  expect(graph.status).toBe(200);
  expect(((await graph.json()) as { messages: { id: string }[] }).messages[0]!.id).toMatch(
    /^wamid\./,
  );
  await registerWhatsAppMedia('e2e-media-1', 'image/png', PNG_1X1);
  const meta = (await (
    await fetch(`${WHATSAPP_GRAPH_FAKE_ORIGIN}/v25.0/e2e-media-1`, {
      headers: { authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, connection: 'close' },
    })
  ).json()) as { url: string; mime_type: string };
  expect(meta.mime_type).toBe('image/png');
  const media = await new Promise<Buffer>((resolveMedia, rejectMedia) => {
    httpsGet(
      meta.url,
      {
        ca: readFileSync(TEST_CA_FILE),
        headers: { authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolveMedia(Buffer.concat(chunks)));
      },
    ).on('error', rejectMedia);
  });
  expect(media.equals(PNG_1X1)).toBe(true);
  expect((await whatsappRequests()).map((request) => request.endpoint)).toEqual([
    'messages',
    'media_meta',
    'media_download',
  ]);

  // Web Push: Gerät des Admins registrieren; Anmeldung von einem neuen Gerät ⇒ Admin-Push.
  await clearPushRequests();
  const keys = createPushSubscriptionKeys();
  await registerPushSubscription(staff, keys);
  // „Neues Gerät“ = neue Geräte-Kennung (aus dem User-Agent abgeleitet, auth/device.ts).
  const otherDevice = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0',
  });
  const otherPage = await otherDevice.newPage();
  await login(otherPage, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await otherDevice.close();
  await runDueJobsViaApi(staff);
  await expect.poll(async () => (await pushRequests(keys)).length).toBe(1);
  const [push] = await pushRequests(keys);
  expect(push!.status).toBe(201);
  expect(push!.headers.ttl).toBe('3600');
  expect(push!.headers.contentEncoding).toBe('aes128gcm');
  verifyVapid(push!);
  const payload = JSON.parse(decryptPush(push!, keys)) as { title: string; url: string };
  expect(payload).toMatchObject({ title: 'Neue Anmeldung', url: '/mitarbeiter' });

  // IMAP: Mail in die Fake-INBOX ⇒ mail.inbound_poll (ImapFlow, TLS, read-only) ⇒ „Nicht zugeordnet“.
  await clearImap();
  await deliverInboundMail(
    [
      'From: Fremde Person <fremd.smoke@e2e.example>',
      'To: antwort@miet-royal.test',
      'Subject: Frage zum Termin (E2E-Smoke)',
      'Message-ID: <smoke-inbound-1@e2e.example>',
      'Date: Sun, 18 Oct 2026 10:00:00 +0000',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Hallo, ist der Termin noch aktuell?',
      '',
    ].join('\r\n'),
  );
  enqueueInboundPoll();
  await runDueJobsViaApi(staff);
  const unmatched = (await (
    await staff.request.get('/api/staff/communication/unmatched')
  ).json()) as { messages: { channel: string; subject: string | null }[] };
  expect(
    unmatched.messages.filter(
      (message) =>
        message.channel === 'email' && message.subject === 'Frage zum Termin (E2E-Smoke)',
    ),
  ).toHaveLength(1);
  const imapLog = await imapCommands();
  expect(imapLog.logins.length).toBeGreaterThan(0);
  expect(imapLog.logins.every((entry) => entry.ok)).toBe(true);
  const sent = imapLog.commands.map((entry) => entry.command);
  expect(sent).toContain('EXAMINE');
  expect(sent).toContain('UID FETCH');
  // Keine Mail löschen/markieren (Order §21).
  expect(sent.some((command) => /STORE|EXPUNGE|COPY|MOVE|APPEND/.test(command))).toBe(false);
});
