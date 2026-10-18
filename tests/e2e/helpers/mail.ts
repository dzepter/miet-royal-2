import { createRequire } from 'node:module';
import { expect } from '@playwright/test';
import { FAKES_CONTROL_ORIGIN } from '../fakes/constants.ts';

/**
 * Phase-12-Helfer: Mails aus der lokalen SMTP-Senke (fakes/smtp-sink.ts)
 * lesen und mit `mailparser` (vorhandene Abhängigkeit von apps/api) parsen.
 * Die E2E-API versendet über den ECHTEN SmtpMailGateway (Nodemailer, TLS
 * mit Test-CA) – der Versand passiert im Job `mail.send`, also nach
 * `runDueJobs`/`runDueJobsViaApi`.
 *
 * Die Senke ist EIN Prozess für alle Specs und beide API-Instanzen: Specs
 * leeren sie zu Beginn (`clearSink`) und filtern immer nach Empfänger
 * (+ Betreff). Mailinhalte (Codes, Token-Links) erscheinen nie in der
 * Reporter-Ausgabe: Prüfungen mit Klartext laufen über boolesche Vergleiche.
 */

interface MailparserAddress {
  value: { address?: string; name: string }[];
  text: string;
}

interface MailparserParsed {
  subject?: string;
  text?: string;
  html?: string | false;
  messageId?: string;
  inReplyTo?: string;
  references?: string | string[];
  from?: MailparserAddress;
  to?: MailparserAddress | MailparserAddress[];
  replyTo?: MailparserAddress;
  headers: Map<string, unknown>;
  attachments: { filename?: string; contentType: string; content: Buffer; size: number }[];
}

const requireFromApi = createRequire(`${import.meta.dirname}/../../../apps/api/package.json`);
const { simpleParser } = requireFromApi('mailparser') as {
  simpleParser: (source: Buffer) => Promise<MailparserParsed>;
};

export interface SinkAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  size: number;
}

export interface SinkMail {
  id: string;
  receivedAt: string;
  /** SMTP-Umschlag (RCPT TO / MAIL FROM) und angemeldeter SMTP-Benutzer. */
  envelopeTo: string[];
  envelopeFrom: string;
  authUser: string | null;
  subject: string;
  text: string;
  html: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: { address: string; name: string } | null;
  to: { address: string; name: string }[];
  replyTo: string | null;
  /** Kopfzeilen (Name klein geschrieben) als Text. */
  headers: Record<string, string>;
  attachments: SinkAttachment[];
  raw: Buffer;
}

async function control<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  const response = await fetch(`${FAKES_CONTROL_ORIGIN}${path}`, {
    method,
    // Keine Keep-Alive-Sockets (siehe helpers/lexware.ts control()).
    headers: {
      connection: 'close',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Fake-Steuerung ${method} ${path}: ${response.status}`);
  return (await response.json()) as T;
}

function headerText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null) {
    const text = (value as { text?: unknown; value?: unknown }).text;
    if (typeof text === 'string') return text;
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === 'string') return inner;
  }
  return JSON.stringify(value);
}

async function parse(entry: {
  id: string;
  receivedAt: string;
  mailFrom: string;
  rcptTo: string[];
  authUser: string | null;
  raw: string;
}): Promise<SinkMail> {
  const raw = Buffer.from(entry.raw, 'base64');
  const parsed = await simpleParser(raw);
  const toList = parsed.to === undefined ? [] : Array.isArray(parsed.to) ? parsed.to : [parsed.to];
  const headers: Record<string, string> = {};
  for (const [name, value] of parsed.headers) headers[name.toLowerCase()] = headerText(value);
  const references =
    parsed.references === undefined
      ? []
      : Array.isArray(parsed.references)
        ? parsed.references
        : [parsed.references];
  const from = parsed.from?.value[0];
  return {
    id: entry.id,
    receivedAt: entry.receivedAt,
    envelopeTo: entry.rcptTo,
    envelopeFrom: entry.mailFrom,
    authUser: entry.authUser,
    subject: parsed.subject ?? '',
    text: parsed.text ?? '',
    html: typeof parsed.html === 'string' ? parsed.html : '',
    messageId: parsed.messageId ?? null,
    inReplyTo: parsed.inReplyTo ?? null,
    references,
    from: from === undefined ? null : { address: from.address ?? '', name: from.name },
    to: toList.flatMap((list) =>
      list.value.map((address) => ({ address: address.address ?? '', name: address.name })),
    ),
    replyTo: parsed.replyTo?.value[0]?.address ?? null,
    headers,
    attachments: parsed.attachments.map((attachment) => ({
      filename: attachment.filename ?? '',
      contentType: attachment.contentType,
      content: attachment.content,
      size: attachment.size,
    })),
    raw,
  };
}

/** Alle bisher angenommenen Nachrichten (älteste zuerst), optional nur an `to`. */
export async function sinkMails(to?: string): Promise<SinkMail[]> {
  const query = to === undefined ? '' : `?to=${encodeURIComponent(to)}`;
  const { messages } = await control<{
    messages: {
      id: string;
      receivedAt: string;
      mailFrom: string;
      rcptTo: string[];
      authUser: string | null;
      raw: string;
    }[];
  }>('GET', `/smtp/messages${query}`);
  return Promise.all(messages.map(parse));
}

/** Senke leeren (Nachrichten, Ablehnungen, offene Fehlerinjektionen). */
export async function clearSink(): Promise<void> {
  await control('DELETE', '/smtp/messages');
}

export interface MailFilter {
  /** Empfänger (Umschlag, Groß-/Kleinschreibung egal). */
  to: string;
  subject?: string | RegExp;
}

function matches(mail: SinkMail, filter: MailFilter): boolean {
  const to = filter.to.toLowerCase();
  if (!mail.envelopeTo.some((address) => address.toLowerCase() === to)) return false;
  if (filter.subject === undefined) return true;
  return typeof filter.subject === 'string'
    ? mail.subject.includes(filter.subject)
    : filter.subject.test(mail.subject);
}

export async function mailsMatching(filter: MailFilter): Promise<SinkMail[]> {
  return (await sinkMails(filter.to)).filter((mail) => matches(mail, filter));
}

/**
 * Wartet, bis mindestens `count` passende Mails in der Senke liegen, und
 * liefert die NEUESTE. Der Versand selbst läuft synchron im Job `mail.send`
 * (runDueJobs); das Warten fängt nur Zeitversatz der HTTP-Abfrage ab.
 */
export async function waitForMail(
  filter: MailFilter,
  options: { count?: number; timeoutMs?: number } = {},
): Promise<SinkMail> {
  const count = options.count ?? 1;
  let found: SinkMail[] = [];
  await expect
    .poll(
      async () => {
        found = await mailsMatching(filter);
        return found.length;
      },
      {
        message: `Mail an ${filter.to}${filter.subject === undefined ? '' : ` (${String(filter.subject)})`}`,
        timeout: options.timeoutMs ?? 15_000,
      },
    )
    .toBeGreaterThanOrEqual(count);
  return found[found.length - 1]!;
}

/** Erwartet GENAU `count` passende Mails (z. B. „keine Doppelmail“). */
export async function expectMailCount(filter: MailFilter, count: number): Promise<SinkMail[]> {
  const found = await mailsMatching(filter);
  expect(found, `Anzahl Mails an ${filter.to}`).toHaveLength(count);
  return found;
}

/**
 * Absoluten Link mit dem Pfadpräfix (z. B. `/angebot/`) aus dem Textteil
 * lesen; prüft, dass derselbe Link auch im HTML steht. Der Link (Token!)
 * erscheint bei Fehlschlag nicht in der Ausgabe.
 */
export function linkFromMail(mail: SinkMail, pathPrefix: string): string {
  const links = [...mail.text.matchAll(/https?:\/\/[^\s<>"']+/g)].map((match) => match[0]);
  const link = links.find((candidate) => new URL(candidate).pathname.startsWith(pathPrefix));
  expect(link !== undefined, `Link ${pathPrefix}… im Mailtext`).toBe(true);
  expect(mail.html.includes(link!), 'Link auch im HTML-Teil').toBe(true);
  return link!;
}

/** Kompakter Gutscheincode (`MR20…`, 16 Zeichen) aus der Gutscheinmail – nur im Testprozess. */
export function voucherCodeFromMail(mail: SinkMail): string {
  const match = /MR20-([A-HJ-NP-Z2-9]{4})-([A-HJ-NP-Z2-9]{4})-([A-HJ-NP-Z2-9]{4})/.exec(mail.text);
  expect(match !== null, 'Gutscheincode (MR20-XXXX-XXXX-XXXX) im Mailtext').toBe(true);
  return `MR20${match![1]}${match![2]}${match![3]}`;
}

export interface SmtpFailureOptions {
  stage: 'mail' | 'rcpt' | 'data';
  /** 4xx ⇒ temporär (Retry), 5xx ⇒ permanent (failed). */
  code: number;
  times?: number;
  /** Nur Nachrichten an diesen Empfänger (rcpt/data). */
  recipient?: string;
  /** `drop`: nach DATA ohne Antwort trennen (Zustellung unklar). */
  mode?: 'reply' | 'drop';
}

/** Nächste passende Nachricht(en) in der Senke ablehnen lassen. */
export async function failNextSmtp(options: SmtpFailureOptions): Promise<void> {
  await control('POST', '/smtp/fail-next', options);
}

export interface SmtpRejection {
  receivedAt: string;
  stage: 'mail' | 'rcpt' | 'data';
  code: number;
  mailFrom: string | null;
  rcptTo: string[];
  mode: 'reply' | 'drop';
}

export async function smtpRejections(): Promise<SmtpRejection[]> {
  return (await control<{ rejections: SmtpRejection[] }>('GET', '/smtp/rejections')).rejections;
}

/** Signatur/Absender, die jede Miet-Royal-Mail trägt (Order §10). */
export function expectMietRoyalMail(mail: SinkMail): void {
  expect(mail.from?.address).toBe('service@miet-royal.test');
  expect(mail.from?.name).toBe('Miet-Royal Mainz');
  expect(mail.text).toContain('Mit freundlichen Grüßen');
  expect(mail.text).toContain('Miet-Royal Mainz');
  expect(mail.html).toContain('Mit freundlichen Grüßen');
  expect(mail.messageId).toMatch(/^<[^@\s]+@[^>\s]+>$/);
  // Kein Tracking (Order §9): keine Bilder/externen Ressourcen im HTML.
  expect(mail.html).not.toMatch(/<img\b/i);
  expect(mail.html).not.toMatch(/<link\b|<script\b/i);
}

/** Anhang mit Dateiname-Muster; prüft PDF-Signatur `%PDF`. */
export function pdfAttachment(mail: SinkMail, filename: RegExp): SinkAttachment {
  const attachment = mail.attachments.find((entry) => filename.test(entry.filename));
  expect(attachment, `Anhang ${String(filename)}`).toBeDefined();
  expect(attachment!.contentType).toBe('application/pdf');
  expect(attachment!.content.subarray(0, 4).toString('latin1')).toBe('%PDF');
  return attachment!;
}

// ── IMAP-Eingang (fakes/imap-server.ts) ────────────────────────────────

/** RFC-822-Rohmail in die INBOX des IMAP-Fakes legen; liefert die UID. */
export async function deliverInboundMail(raw: string | Buffer, folder = 'INBOX'): Promise<number> {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  return (
    await control<{ uid: number }>('POST', '/imap/messages', {
      raw: bytes.toString('base64'),
      folder,
    })
  ).uid;
}

export interface ImapMailboxState {
  folder: string;
  uidValidity: number;
  uidNext: number;
  messages: { uid: number; size: number; flags: string[] }[];
}

export async function imapMailboxes(): Promise<ImapMailboxState[]> {
  return (await control<{ mailboxes: ImapMailboxState[] }>('GET', '/imap/messages')).mailboxes;
}

/** Vom Client gesendete IMAP-Kommandos (ohne Argumente) + Anmeldungen. */
export async function imapCommands(): Promise<{
  commands: { at: string; command: string; authenticated: boolean }[];
  logins: { at: string; user: string; ok: boolean }[];
}> {
  return control('GET', '/imap/commands');
}

export async function clearImap(): Promise<void> {
  await control('DELETE', '/imap/messages');
}

/** Mailbox-Reset simulieren (neue UIDVALIDITY). */
export async function setImapUidValidity(uidValidity: number, folder = 'INBOX'): Promise<void> {
  await control('POST', '/imap/uidvalidity', { folder, uidValidity });
}
