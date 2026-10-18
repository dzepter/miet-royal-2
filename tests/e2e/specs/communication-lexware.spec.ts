/**
 * Phase-12-E2E-Szenario F (Order §§3/16/43): Lexware-Rechnung per E-Mail.
 * Läuft NUR im Playwright-Projekt `lexware` (zweite API-/Staff-Instanz gegen
 * den Lexware-Contract-Fake, Mail über den echten SmtpMailGateway an die
 * lokale SMTP-Senke – siehe playwright.config.ts). Nie gegen echte Konten.
 *
 * Kernaussagen: Nach erfolgreicher Rechnung reiht die API GENAU EINE
 * Rechnungsmail ein; das PDF wird beim Versand transient direkt aus Lexware
 * geladen (GET /v1/invoices/{id}/file) und nie gespeichert – keine
 * documents-Zeile, keine Datei im Storage-Verzeichnis, keine Bytes in der
 * Outbox. Scheitert der Abruf, bleibt die Rechnung gültig und der Vorgang
 * abgeschlossen; nur der Versandstatus wartet (Retry).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { E2E_STORAGE_ROOT, releaseMailRetries, singleMailDelivery } from '../helpers/jobs.ts';
import {
  applySyntheticTax,
  checkLexwareConnection,
  failNext,
  fakeInvoices,
  fakeRequestLog,
  LEXWARE_FAKE_API_KEY,
  LEXWARE_FAKE_ORIGIN,
  resetFake,
  resetLexwareE2eState,
} from '../helpers/lexware.ts';
import {
  clearSink,
  expectMailCount,
  expectMietRoyalMail,
  pdfAttachment,
  waitForMail,
} from '../helpers/mail.ts';
import { ADMIN_EMAIL, ADMIN_PASSWORD, resetE2eDatabase } from '../helpers/seed.ts';
import {
  ensureInitialStock,
  issueAndReturn,
  login,
  openSettlement,
  runDueJobs,
} from '../helpers/settlement.ts';
import { queryTestDb } from '../helpers/voucher.ts';

test.describe.configure({ mode: 'serial' });

const F_EMAIL = 'fiona.faktura@e2e.example';
const LABEL_TRANSFERRED = 'An Buchhaltung übertragen';

let staff: Page;
let customerPage: Page;

test.beforeAll(async ({ browser }) => {
  resetE2eDatabase();
  resetLexwareE2eState();
  await resetFake();
  await clearSink();
  staff = await browser.newPage();
  customerPage = await browser.newPage();
});
test.afterAll(async () => {
  await staff.close();
  await customerPage.close();
});

/** Alle Dateien unterhalb des Storage-Verzeichnisses der E2E-APIs (relativ, sortiert). */
function storageFiles(root = E2E_STORAGE_ROOT, prefix = ''): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries
    .flatMap((name) => {
      const path = join(root, name);
      return statSync(path).isDirectory()
        ? storageFiles(path, `${prefix}${name}/`)
        : [`${prefix}${name}`];
    })
    .sort();
}

function documentCount(): number {
  return Number(queryTestDb<{ n: string }>('SELECT count(*)::text AS n FROM documents')[0]!.n);
}

test('F. Lexware-Rechnung per E-Mail: PDF transient aus Lexware geladen und gemailt, kein Storage (keine documents-Zeile, keine Datei, keine Bytes in der Outbox); Abruffehler ⇒ Rechnung gültig, Versand wartet; genau eine Mail', async () => {
  test.setTimeout(600_000);
  await login(staff, ADMIN_EMAIL, ADMIN_PASSWORD, 'Erika');
  await ensureInitialStock(staff, 'sirup-kirsche', 'Sirup Kirsche', 10);
  await ensureInitialStock(staff, 'sirup-waldmeister', 'Sirup Waldmeister', 10);
  await ensureInitialStock(staff, 'strohhalme-25', 'Strohhalme (25 Stück)', 20);
  await ensureInitialStock(staff, 'becher-25', 'Becher (25 Stück)', 40);
  await ensureInitialStock(staff, 'mischkanister-6l', '6-L-Mischkanister', 10, { optional: true });
  await checkLexwareConnection(staff);
  await applySyntheticTax(staff);

  const { processId, processNumber } = await issueAndReturn(staff, customerPage, {
    firstName: 'Fiona',
    lastName: 'Faktura',
    email: F_EMAIL,
    machineCodes: ['MR-10-01-01'],
  });
  await openSettlement(staff, processId);
  // Ein Job-Lauf: Lexware-Transfer (Rechnung) ⇒ invoice.delivery ⇒ mail.send. Der erste
  // Dateiabruf bei Lexware scheitert (503). Die Übergabe-/Rückgabeprotokollmails desselben
  // Vorgangs gehen im selben Lauf raus (eigene, bereits gespeicherte Dokumente).
  await failNext({ match: '^GET /v1/invoices/[^/]+/file$', status: 503, times: 1 });
  const filesBefore = storageFiles();
  const documentsBefore = documentCount();
  await runDueJobs(staff);

  // Order §3: Rechnung gültig, Abrechnung übertragen, Versand wartet (Retry).
  await expect(staff.getByTestId('settlement-status')).toContainText(LABEL_TRANSFERRED);
  await expect(staff.getByTestId('accounting-invoice-status')).toContainText('Rechnung: erstellt');
  await expect(staff.getByTestId('invoice-delivery-status')).toContainText('Versand: Ausstehend');
  const invoice = (await fakeInvoices()).find(
    (entry) => entry.remark?.includes(processNumber) === true,
  );
  expect(invoice).toBeDefined();
  expect(invoice!.voucherStatus).toBe('open');
  const retrying = singleMailDelivery(processId, 'invoice_delivery');
  expect(retrying).toMatchObject({
    status: 'retry',
    attempts: 1,
    last_error_code: 'ATTACHMENT_UNAVAILABLE',
    recipient_email: F_EMAIL,
  });
  // Nur eine Referenz auf die Lexware-Rechnung – nie Bytes (Order §16).
  expect(retrying.attachments).toEqual([
    {
      kind: 'lexware_invoice',
      lexwareInvoiceId: invoice!.id,
      filename: expect.stringMatching(/^Rechnung-.+\.pdf$/),
    },
  ]);
  await expectMailCount({ to: F_EMAIL, subject: /^Rechnung / }, 0);
  await staff.goto(`/vorgaenge/${processId}`);
  await expect(staff.locator('.badge', { hasText: 'Abgeschlossen' }).first()).toBeVisible();

  // Retry fällig ⇒ PDF erneut transient geladen ⇒ Mail zugestellt.
  releaseMailRetries(retrying.id);
  await openSettlement(staff, processId);
  await runDueJobs(staff);
  await expect(staff.getByTestId('invoice-delivery-status')).toContainText('Versand: Versendet');
  const mail = await waitForMail({ to: F_EMAIL, subject: /^Rechnung / });
  expectMietRoyalMail(mail);
  expect(mail.subject).toContain(processNumber);
  expect(mail.subject).toContain(invoice!.voucherNumber!);
  expect(mail.messageId).toBe(retrying.message_id);
  expect(mail.attachments).toHaveLength(1);
  const attachment = pdfAttachment(mail, /^Rechnung-.+\.pdf$/);
  // Anhang = exakt die Datei aus Lexware (Fake), direkt abgefragt.
  const original = await fetch(`${LEXWARE_FAKE_ORIGIN}/v1/invoices/${invoice!.id}/file`, {
    headers: {
      authorization: `Bearer ${LEXWARE_FAKE_API_KEY}`,
      accept: '*/*',
      connection: 'close',
    },
  });
  expect(original.ok).toBe(true);
  expect(attachment.content.equals(Buffer.from(await original.arrayBuffer()))).toBe(true);
  const fileRequests = (await fakeRequestLog()).filter(
    (request) => request.path === `/v1/invoices/${invoice!.id}/file`,
  );
  // 503 (erster Versuch) + 200 (Retry) + 200 (Vergleich oben).
  expect(fileRequests.map((request) => request.status)).toEqual([503, 200, 200]);

  // Kein Storage: keine neue documents-Zeile, keine neue Datei, keine Bytes in der Outbox.
  expect(documentCount()).toBe(documentsBefore);
  expect(storageFiles()).toEqual(filesBefore);
  const sent = singleMailDelivery(processId, 'invoice_delivery');
  expect(sent).toMatchObject({ status: 'sent', attempts: 2 });
  expect(JSON.stringify(sent)).not.toContain('%PDF');
  expect(JSON.stringify(sent).length).toBeLessThan(4_000);

  // Status gespiegelt (Abrechnung + Mapping) und automatisch nie doppelt.
  const mirrored = queryTestDb<{ settlement: string | null; mapping: string }>(
    `SELECT s.invoice_delivery_status AS settlement, m.delivery_status AS mapping
       FROM settlements s
       JOIN accounting_transfers t ON t.settlement_id = s.id
       JOIN lexware_invoice_mappings m ON m.accounting_transfer_id = t.id
      WHERE s.process_id = $1`,
    [processId],
  );
  expect(mirrored).toEqual([{ settlement: 'sent', mapping: 'sent' }]);
  await runDueJobs(staff);
  await expectMailCount({ to: F_EMAIL, subject: /^Rechnung / }, 1);
  await staff.goto(`/vorgaenge/${processId}`);
  const row = staff.locator(
    '[data-testid="communication-status-row"][data-kind="invoice_delivery"]',
  );
  await expect(row).toHaveAttribute('data-status', 'sent');
});
