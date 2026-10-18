import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, type Page } from '@playwright/test';
import { WHATSAPP_BUSINESS_ACCOUNT_ID, WHATSAPP_PHONE_NUMBER_ID } from '../fakes/constants.ts';
import { decryptPush, pushRequests, type PushRequest, type PushSubscriptionKeys } from './push.ts';
import type { AppointmentRow } from './settlement.ts';
import { queryTestDb } from './voucher.ts';

/**
 * Phase-12-Helfer der Betriebs-Szenarien G–T (communication-ops.spec.ts,
 * communication-demo.spec.ts): Zeitwerte in Berliner Wanduhrzeit,
 * Termin-/Buchungszeilen, Termin-Zuweisung über die Vorschau, Kunden mit
 * Telefonnummer, RFC-822-Rohmails (inkl. Bildanhang), entschlüsselte Pushes,
 * ICS-Parser und WhatsApp-Status-Webhooks. Ausschließlich additiv.
 *
 * Zeitverschiebungen (nur Testdatenbank, reine Zeitstempel – keine fachliche
 * Mutation): `backdateBookingCreation` (Erinnerungen werden NIE nachgeholt –
 * eine Buchung, die nach dem Fälligkeitszeitpunkt entstand, bekommt keine
 * Mail; die Spec legt die Buchung daher „vor“ den Fälligkeitszeitpunkt),
 * `backdateRiskFollowUp` (6-h-Erinnerung) und `backdateProcessCompletion`
 * (12-Monats-Text-Retention).
 */

export const sha256Hex = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');

const BERLIN_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function berlinParts(date: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of BERLIN_PARTS.formatToParts(date)) parts[part.type] = part.value;
  return parts;
}

/** Zeitpunkt in `minutes` Minuten, auf die volle Minute abgerundet (datetime-local hat Minuten). */
export function minutesFromNow(minutes: number): Date {
  const at = Date.now() + minutes * 60_000;
  return new Date(Math.floor(at / 60_000) * 60_000);
}

/** datetime-local-Wert (Berliner Wanduhrzeit) eines Zeitpunkts, z. B. „2026-10-19T18:41“. */
export function berlinInput(date: Date): string {
  const p = berlinParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** ICS-Ortszeit `YYYYMMDDTHHMMSS` (DTSTART;TZID=Europe/Berlin). */
export function berlinIcsLocal(date: Date): string {
  const p = berlinParts(date);
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}

// ── Testdatenbank ─────────────────────────────────────────────────────

export interface AppointmentDbRow {
  id: string;
  process_id: string;
  booking_id: string;
  kind: 'pickup' | 'delivery' | 'return';
  status: string;
  start_at: string | null;
  end_at: string | null;
  version: number;
  assigned_user_id: string | null;
}

/** Genau ein Termin der Art für den Vorgang. */
export function appointmentOf(processId: string, kind: AppointmentDbRow['kind']): AppointmentDbRow {
  const rows = queryTestDb<AppointmentDbRow>(
    `SELECT id, process_id, booking_id, kind, status, start_at, end_at, version, assigned_user_id
       FROM appointments WHERE process_id = $1 AND kind = $2`,
    [processId, kind],
  );
  expect(rows, `Termin ${kind}`).toHaveLength(1);
  return rows[0]!;
}

/** Buchung „vor“ `days` Tagen entstanden (nur created_at; Erinnerungen holen nie nach). */
export function backdateBookingCreation(processId: string, days: number): void {
  queryTestDb(
    `UPDATE bookings SET created_at = now() - make_interval(days => $2::int) WHERE process_id = $1`,
    [processId, days],
  );
}

/** 6-h-Erinnerung eines offenen Maschinenrisikos sofort fällig (statt 6 h warten). */
export function backdateRiskFollowUp(processId: string): number {
  return queryTestDb<{ id: string }>(
    `UPDATE machine_risk_incidents
        SET admin_notification_due_at = admin_notification_due_at - interval '6 hours',
            follow_up_due_at = now() - interval '1 minute'
      WHERE process_id = $1 AND resolved_at IS NULL AND follow_up_sent_at IS NULL
      RETURNING id`,
    [processId],
  ).length;
}

/** Vorgangsabschluss um `months` Kalendermonate zurückdatieren (Text-Retention). */
export function backdateProcessCompletion(processId: string, months: number): void {
  const rows = queryTestDb<{ id: string }>(
    `UPDATE processes SET completed_at = completed_at - make_interval(months => $2::int)
      WHERE id = $1 AND main_status = 'completed' RETURNING id`,
    [processId, months],
  );
  expect(rows, 'abgeschlossener Vorgang').toHaveLength(1);
}

/** Einen Retention-Lauf (Fotos + 12-Monats-Text) sofort fällig einreihen (eindeutiger Schlüssel). */
export function enqueueRetentionRun(): void {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  queryTestDb(
    `INSERT INTO integration_jobs (type, payload, idempotency_key, max_attempts)
     VALUES ('communication.cleanup_retention', $1::jsonb, $2, 3)`,
    [
      JSON.stringify({ scope: 'backstop', day, textRetention: true }),
      `communication.cleanup_retention:e2e:${randomUUID()}`,
    ],
  );
}

/**
 * Parametrisierte Abfrage gegen eine BELIEBIGE E2E-Datenbank (z. B. die
 * Demo-Datenbank) – Muster wie `queryTestDb` (pg aus dem API-Workspace,
 * SQL/Parameter über die Umgebung, keine Shell).
 */
export function queryDatabase<T = Record<string, unknown>>(
  databaseUrl: string,
  sql: string,
  params: unknown[] = [],
): T[] {
  const script = [
    "const { Pool } = require('pg');",
    'const pool = new Pool({ connectionString: process.env.DATABASE_URL });',
    '(async () => {',
    '  const result = await pool.query(process.env.E2E_SQL, JSON.parse(process.env.E2E_PARAMS));',
    "  process.stdout.write(JSON.stringify(result.rows) + '\\n');",
    '  await pool.end();',
    '})().catch((e) => { console.error(e); process.exit(1); });',
  ].join('\n');
  const output = execFileSync('node', ['-e', script], {
    cwd: `${import.meta.dirname}/../../../apps/api`,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      E2E_SQL: sql,
      E2E_PARAMS: JSON.stringify(params),
    },
  });
  return JSON.parse(output.toString('utf8')) as T[];
}

// ── Staff-UI ──────────────────────────────────────────────────────────

/** Termin über die Vorschau („Mitarbeiter zuweisen“) einem Mitarbeiter zuweisen. */
export async function assignAppointmentViaUi(
  staff: Page,
  processId: string,
  row: AppointmentRow,
  assignee: { optionLabel: string; name: string },
): Promise<void> {
  await staff.goto(`/vorgaenge/${processId}/termine`);
  await staff.locator('.entry-row', { hasText: row }).click();
  const card = staff.getByTestId('appointment-preview');
  await card.getByLabel('Mitarbeiter zuweisen').selectOption({ label: assignee.optionLabel });
  await card.getByRole('button', { name: 'Zuweisen', exact: true }).click();
  await expect(card.getByText(`Mitarbeiter: ${assignee.name}`)).toBeVisible();
  await card.getByLabel('Vorschau schließen').click();
}

/** Kunde mit E-Mail UND Telefon über die Kundenliste anlegen; liefert die Kunden-ID. */
export async function createCustomerWithPhone(
  staff: Page,
  input: { firstName: string; lastName: string; email: string; phone: string },
): Promise<string> {
  await staff.goto('/kunden');
  await staff.getByRole('button', { name: 'Kunde anlegen' }).click();
  await staff.getByLabel('Vorname').fill(input.firstName);
  await staff.getByLabel('Nachname').fill(input.lastName);
  await staff.getByLabel('E-Mail (optional)').fill(input.email);
  await staff.getByLabel('Telefon (optional)').fill(input.phone);
  await staff.getByRole('button', { name: 'Kunde anlegen' }).click();
  await expect(
    staff.getByRole('heading', { name: `${input.firstName} ${input.lastName}` }),
  ).toBeVisible();
  await staff.waitForURL(/\/kunden\/[0-9a-f-]{36}$/);
  return /\/kunden\/([0-9a-f-]{36})/.exec(staff.url())![1]!;
}

/** Kundenseite → „Vorgang anlegen“ (ohne Anfrage/Angebot). */
export async function createProcessForCustomer(
  staff: Page,
  customerId: string,
): Promise<{ processId: string; processNumber: string }> {
  await staff.goto(`/kunden/${customerId}`);
  await expect(staff.getByRole('heading', { name: 'Stammdaten' })).toBeVisible();
  await staff.getByRole('button', { name: 'Vorgang anlegen' }).click();
  const numberHeading = staff.getByRole('heading', { name: /^MR-\d{4}-\d{4,}$/ });
  await expect(numberHeading).toBeVisible();
  const processNumber = (await numberHeading.innerText()).trim();
  const processId = /\/vorgaenge\/([0-9a-f-]{36})/.exec(staff.url())![1]!;
  return { processId, processNumber };
}

// ── RFC-822-Rohmails (Kundenantworten in die IMAP-INBOX) ──────────────

export interface RawMailInput {
  /** „Name <adresse>“. */
  from: string;
  to?: string;
  subject: string;
  /** Ohne spitze Klammern. */
  messageId: string;
  /** Message-ID der beantworteten Mail (mit Klammern, wie aus der Senke). */
  inReplyTo?: string;
  text: string;
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function base64Lines(content: Buffer): string {
  return (content.toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
}

/** Minimalmail wie von einem Mailprogramm (text/plain, optional multipart/mixed mit Anhängen). */
export function buildRawMail(input: RawMailInput): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to ?? 'antwort@miet-royal.test'}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Message-ID: <${input.messageId}>`,
    ...(input.inReplyTo === undefined
      ? []
      : [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`]),
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
  ];
  const textPart = [
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(input.text, 'utf8')),
  ];
  if (input.attachments === undefined || input.attachments.length === 0) {
    return [...headers, ...textPart, ''].join('\r\n');
  }
  const boundary = `e2e-${randomUUID()}`;
  const parts = [
    `--${boundary}`,
    ...textPart,
    ...input.attachments.flatMap((attachment) => [
      `--${boundary}`,
      `Content-Type: ${attachment.contentType}; name="${attachment.filename}"`,
      `Content-Disposition: attachment; filename="${attachment.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      base64Lines(attachment.content),
    ]),
    `--${boundary}--`,
    '',
  ];
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts].join(
    '\r\n',
  );
}

// ── Web Push (entschlüsselt) ───────────────────────────────────────────

export interface PushPayloadJson {
  kind: string;
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export interface DecryptedPush {
  request: PushRequest;
  payload: PushPayloadJson;
  /** Klartext-Nutzlast (für Datenminimierungs-Prüfungen). */
  plaintext: string;
}

/** Alle beim Fake eingegangenen Pushes eines Geräts, entschlüsselt (RFC 8291). */
export async function decryptedPushes(keys: PushSubscriptionKeys): Promise<DecryptedPush[]> {
  return (await pushRequests(keys)).map((request) => {
    const plaintext = decryptPush(request, keys);
    return { request, plaintext, payload: JSON.parse(plaintext) as PushPayloadJson };
  });
}

/** Pushes eines Geräts mit Titel (und optional Body-Teil). */
export async function pushesTitled(
  keys: PushSubscriptionKeys,
  title: string,
  bodyIncludes?: string,
): Promise<DecryptedPush[]> {
  return (await decryptedPushes(keys)).filter(
    (push) =>
      push.payload.title === title &&
      (bodyIncludes === undefined || push.payload.body.includes(bodyIncludes)),
  );
}

/** Erwartet GENAU `count` Pushes mit Titel/Body-Teil (kurzes Polling wegen HTTP-Versatz). */
export async function expectPushCount(
  keys: PushSubscriptionKeys,
  title: string,
  count: number,
  bodyIncludes?: string,
): Promise<DecryptedPush[]> {
  await expect
    .poll(async () => (await pushesTitled(keys, title, bodyIncludes)).length, {
      message: `Pushes „${title}“${bodyIncludes === undefined ? '' : ` (${bodyIncludes})`}`,
      timeout: 10_000,
    })
    .toBe(count);
  return pushesTitled(keys, title, bodyIncludes);
}

// ── ICS ──────────────────────────────────────────────────────────────

export interface ParsedIcs {
  /** Entfaltete Inhaltszeilen. */
  lines: string[];
  /** Je VEVENT: Name (inkl. Parameter, z. B. `DTSTART;TZID=Europe/Berlin`) → Wert. */
  events: Map<string, string>[];
}

/** Minimaler RFC-5545-Parser: CRLF-Zeilen, Entfaltung (CRLF + Leerzeichen/Tab), VEVENT-Blöcke. */
export function parseIcs(text: string): ParsedIcs {
  expect(text.includes('\r\n'), 'ICS mit CRLF-Zeilenenden').toBe(true);
  const lines = text
    .replace(/\r\n[ \t]/g, '')
    .split('\r\n')
    .filter((line) => line !== '');
  const events: Map<string, string>[] = [];
  let current: Map<string, string> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = new Map();
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current !== null) events.push(current);
      current = null;
      continue;
    }
    if (current === null) continue;
    const index = line.indexOf(':');
    current.set(line.slice(0, index), line.slice(index + 1));
  }
  return { lines, events };
}

// ── WhatsApp-Status-Webhook ─────────────────────────────────────────────

/** Offizielles Status-Ereignis (statuses[]) zu einer eigenen ausgehenden Nachricht. */
export function whatsappStatusPayload(
  wamid: string,
  status: 'sent' | 'delivered' | 'read',
  recipientId: string,
): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WHATSAPP_BUSINESS_ACCOUNT_ID,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '4961310000000',
                phone_number_id: WHATSAPP_PHONE_NUMBER_ID,
              },
              statuses: [
                {
                  id: wamid,
                  status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: recipientId,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
