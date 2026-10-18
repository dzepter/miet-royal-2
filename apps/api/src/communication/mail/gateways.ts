/**
 * Ausgehende Mail-Gateways (Phase 12, Order §§5/9/41):
 * - `SmtpMailGateway`: Nodemailer über SMTP, nur TLS (implizit oder STARTTLS-
 *   Pflicht), Zertifikatsprüfung ohne Abschaltmöglichkeit, stabile Message-ID
 *   aus der Outbox, Adressobjekte statt zusammengesetzter Header-Strings.
 * - `FakeMailGateway`: Tests – zeichnet auf, simuliert sent/transient/
 *   permanent/unknown je Aufruf. Darf in production NIE verdrahtet sein.
 * - `DisabledMailGateway`: Mail nicht konfiguriert – wirft nie, liefert
 *   permanent_error MAIL_NOT_CONFIGURED.
 *
 * Ergebnisklassifikation (Order §9, Härtung RA-1): Server antwortet 2xx ⇒
 * sent; 4xx ⇒ transient_error; 5xx ⇒ permanent_error. Fehler OHNE
 * Serverantwort sind nur dann transient, wenn nachweislich noch keine SMTP-
 * Sitzung bestand (Verbindungsaufbau, Greeting, DNS, TLS-Aufbau) – alles
 * andere (Socket-Timeout, Abbruch nach aufgebauter Sitzung, unbekannte
 * Fehler) ⇒ unknown (Zustellung unklar, kein automatischer Retry). Kein
 * Fehlerobjekt verlässt das Gateway – nur neutrale Codes.
 */
import type { AppConfig } from '@mietroyal/config';
import { createTransport } from 'nodemailer';
import {
  MAIL_BLOCKED_NOT_CONFIGURED,
  type OutboundMailGateway,
  type OutboundMailMessage,
  type OutboundMailOutcome,
} from '../types.ts';
import { containsHeaderInjection } from './templates/index.ts';

/** Schmale Transportsicht (Nodemailer-Transporter); in Tests ersetzbar. */
export interface SmtpTransportLike {
  sendMail(options: {
    messageId: string;
    from: { name: string; address: string };
    to: { name: string; address: string };
    replyTo?: string;
    subject: string;
    text: string;
    html: string;
    inReplyTo?: string;
    references?: string[];
    attachments: { filename: string; contentType: string; content: Buffer }[];
  }): Promise<{ response?: string; rejected?: unknown[] }>;
  verify(): Promise<true>;
}

export interface SmtpErrorLike {
  code?: unknown;
  command?: unknown;
  responseCode?: unknown;
  /** Nodemailer: CONNECT_TIMEOUT | GREETING_TIMEOUT | UPGRADE_TIMEOUT | SOCKET_TIMEOUT. */
  timeoutType?: unknown;
  /** Nodemailer: ursprünglicher Systemcode (z. B. ECONNREFUSED), wenn `code` ersetzt wurde. */
  originalCode?: unknown;
  syscall?: unknown;
}

const SMTP_TIMEOUT_MS = 30_000;

/*
 * Härtung RA-1 – verifiziert gegen Nodemailer 10.1.6 (dist/esm/smtp-connection):
 * Socket-Timeout, Socket-Fehler und Verbindungsabbruch melden IMMER
 * `command: 'CONN'` – auch NACH vollständig übertragenem DATA (der Server kann
 * die Nachricht angenommen haben). `command: 'DATA'` entsteht dort nie. Ein
 * Fehler ohne Serverantwort ist daher nur dann sicher wiederholbar, wenn er
 * nachweislich VOR dem Aufbau der SMTP-Sitzung entstand:
 * - `timeoutType` CONNECT_TIMEOUT/GREETING_TIMEOUT/UPGRADE_TIMEOUT (Aufbau,
 *   Greeting, STARTTLS) – SOCKET_TIMEOUT dagegen ist Inaktivität einer
 *   bestehenden Sitzung ⇒ unknown;
 * - EDNS (Namensauflösung), ETLS (TLS-Aufbau/STARTTLS), EPROXY;
 * - Socket-Fehler mit Verbindungsaufbau-Ursache (`originalCode`/`syscall`:
 *   ECONNREFUSED, EHOSTUNREACH, ENETUNREACH, ENOTFOUND, EAI_AGAIN, …, oder ein
 *   Zertifikatsfehler beim impliziten TLS-Handshake);
 * - lokale API-Fehler bzw. Fehler in Phasen vor MAIL FROM (EHLO, STARTTLS,
 *   AUTH): dort wurde von der Nachricht noch nichts übertragen.
 * Alles andere ohne Antwortcode (ECONNECTION/ESOCKET nach dem Greeting,
 * SOCKET_TIMEOUT, EPROTOCOL, unbekannte Fehler) ⇒ unknown. Ein Abbruch VOR
 * dem Greeting („Connection closed unexpectedly“) ist von einem Abbruch nach
 * DATA nicht unterscheidbar und gilt deshalb konservativ ebenfalls als unknown.
 */
const PRE_SESSION_TIMEOUTS = new Set(['CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'UPGRADE_TIMEOUT']);
const PRE_SESSION_CODES = new Set(['EDNS', 'ETLS', 'EPROXY']);
const CONNECT_FAILURE_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_FAIL',
  'EAI_NONAME',
  'EADDRNOTAVAIL',
]);
const CONNECT_SYSCALLS = new Set(['connect', 'getaddrinfo', 'lookup', 'querya', 'queryaaaa']);
const TLS_HANDSHAKE_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_|SELF_SIGNED_|UNABLE_TO_)/;
/** Kommandos vor MAIL FROM bzw. lokale API-Fehler – von der Nachricht ist nichts übertragen. */
const PRE_TRANSFER_COMMAND = /^(API|EHLO|HELO|LHLO|STARTTLS|AUTH\b.*)$/;

function upper(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value.toUpperCase() : null;
}

/** Positiver Nachweis: Fehler entstand vor der Nachrichtenübertragung (sicher wiederholbar). */
function failedBeforeTransfer(err: SmtpErrorLike): boolean {
  const code = upper(err.code);
  const command = upper(err.command);
  const timeoutType = upper(err.timeoutType);
  const originalCode = upper(err.originalCode);
  const syscall = typeof err.syscall === 'string' ? err.syscall.toLowerCase() : null;
  // ESTREAM (Quelle der Nachricht brach beim Übertragen ab) zählt nie als „vor der Übertragung“.
  if (command !== null && code !== 'ESTREAM' && PRE_TRANSFER_COMMAND.test(command)) return true;
  if (code === 'ETIMEDOUT' && timeoutType !== null) return PRE_SESSION_TIMEOUTS.has(timeoutType);
  if (code !== null && PRE_SESSION_CODES.has(code)) return true;
  if (code !== null && CONNECT_FAILURE_CODES.has(code)) return true;
  if (originalCode !== null) {
    if (CONNECT_FAILURE_CODES.has(originalCode)) return true;
    if (TLS_HANDSHAKE_CODE.test(originalCode)) return true;
  }
  return syscall !== null && CONNECT_SYSCALLS.has(syscall);
}

/** Aus einem Nodemailer-Fehler nur Code/Kommando/Antwortcode lesen – nie Rohantwort. */
export function classifySmtpError(
  error: unknown,
): Exclude<OutboundMailOutcome, { outcome: 'sent' }> {
  const err = (typeof error === 'object' && error !== null ? error : {}) as SmtpErrorLike;
  const responseCode = typeof err.responseCode === 'number' ? err.responseCode : null;
  const command = upper(err.command);
  const code = upper(err.code);

  if (responseCode !== null) {
    // Server hat geantwortet – das Ergebnis ist bekannt, auch nach DATA.
    if (responseCode >= 500) return { outcome: 'permanent_error', code: `SMTP_${responseCode}` };
    if (responseCode >= 400) return { outcome: 'transient_error', code: `SMTP_${responseCode}` };
    return { outcome: 'unknown', code: `SMTP_${responseCode}` };
  }
  if (code === 'EENVELOPE' || code === 'EMESSAGE') {
    // Lokal vor dem Versand abgelehnt (Adresse/Größe) – nichts übertragen.
    return { outcome: 'permanent_error', code: `SMTP_${code}` };
  }
  if (command === 'DATA') {
    // Verbindung nach gesendetem DATA abgebrochen (andere Transporte) – kein blindes Retry.
    return { outcome: 'unknown', code: `SMTP_${code ?? 'DATA_ABORTED'}` };
  }
  if (failedBeforeTransfer(err)) {
    return { outcome: 'transient_error', code: `SMTP_${code ?? 'ERROR'}` };
  }
  // Abbruch/Timeout einer bestehenden Sitzung oder unbekannter Fehler: Zustellung unklar.
  return { outcome: 'unknown', code: `SMTP_${code ?? 'ERROR'}` };
}

function hasInjection(message: OutboundMailMessage): boolean {
  return (
    containsHeaderInjection(message.subject) ||
    containsHeaderInjection(message.to.name ?? '') ||
    containsHeaderInjection(message.from.name) ||
    containsHeaderInjection(message.to.email) ||
    containsHeaderInjection(message.from.email) ||
    /[\s,;<>]/.test(message.to.email) ||
    message.attachments.some((a) => containsHeaderInjection(a.filename))
  );
}

export class SmtpMailGateway implements OutboundMailGateway {
  readonly kind = 'smtp' as const;
  private readonly transport: SmtpTransportLike;

  constructor(
    smtp: NonNullable<AppConfig['mail']['smtp']>,
    options: { transport?: SmtpTransportLike } = {},
  ) {
    this.transport =
      options.transport ??
      (createTransport({
        host: smtp.host,
        port: smtp.port,
        // implizites TLS (465) oder STARTTLS-Pflicht (587); Klartext gibt es nicht.
        secure: smtp.tls === 'implicit',
        requireTLS: smtp.tls === 'starttls',
        auth: { user: smtp.user, pass: smtp.password },
        // Ungültige Zertifikate werden NIE akzeptiert (keine Option dafür).
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
        connectionTimeout: SMTP_TIMEOUT_MS,
        greetingTimeout: SMTP_TIMEOUT_MS,
        socketTimeout: SMTP_TIMEOUT_MS * 2,
      }) as unknown as SmtpTransportLike);
  }

  async send(message: OutboundMailMessage): Promise<OutboundMailOutcome> {
    if (hasInjection(message)) return { outcome: 'permanent_error', code: 'HEADER_INJECTION' };
    try {
      const info = await this.transport.sendMail({
        messageId: message.messageId,
        from: { name: message.from.name, address: message.from.email },
        to: { name: message.to.name ?? '', address: message.to.email },
        ...(message.replyTo === null ? {} : { replyTo: message.replyTo }),
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.inReplyTo === null ? {} : { inReplyTo: message.inReplyTo }),
        ...(message.references.length === 0 ? {} : { references: [...message.references] }),
        attachments: message.attachments.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content: Buffer.from(a.content),
        })),
      });
      if (Array.isArray(info.rejected) && info.rejected.length > 0) {
        return { outcome: 'permanent_error', code: 'SMTP_RECIPIENT_REJECTED' };
      }
      // Nur der dreistellige Antwortcode wird übernommen – nie der Antworttext.
      const code = /^(\d{3})/.exec(info.response ?? '')?.[1] ?? null;
      return { outcome: 'sent', providerCode: code === null ? null : `SMTP_${code}` };
    } catch (error) {
      return classifySmtpError(error);
    }
  }

  async verify(): Promise<{ ok: boolean; code: string | null }> {
    try {
      await this.transport.verify();
      return { ok: true, code: null };
    } catch (error) {
      return { ok: false, code: classifySmtpError(error).code };
    }
  }
}

export class DisabledMailGateway implements OutboundMailGateway {
  readonly kind = 'disabled' as const;

  async send(): Promise<OutboundMailOutcome> {
    return { outcome: 'permanent_error', code: MAIL_BLOCKED_NOT_CONFIGURED };
  }

  async verify(): Promise<{ ok: boolean; code: string | null }> {
    return { ok: false, code: MAIL_BLOCKED_NOT_CONFIGURED };
  }
}

export type FakeMailBehaviour =
  | { outcome: 'sent'; providerCode?: string | null }
  | { outcome: 'transient_error'; code?: string }
  | { outcome: 'permanent_error'; code?: string }
  | { outcome: 'unknown'; code?: string }
  | { outcome: 'throw' };

/**
 * Contract-Fake für Tests: `sent` enthält alle Nachrichten, die als
 * zugestellt gemeldet wurden, `attempts` jeden Sendeversuch. `nextOutcomes`
 * legt das Verhalten der nächsten Aufrufe fest (Default: sent).
 */
export class FakeMailGateway implements OutboundMailGateway {
  readonly kind = 'fake' as const;
  readonly sent: OutboundMailMessage[] = [];
  readonly attempts: OutboundMailMessage[] = [];
  private readonly queue: FakeMailBehaviour[] = [];
  verifyResult: { ok: boolean; code: string | null } = { ok: true, code: null };

  nextOutcomes(...behaviours: FakeMailBehaviour[]): void {
    this.queue.push(...behaviours);
  }

  reset(): void {
    this.sent.length = 0;
    this.attempts.length = 0;
    this.queue.length = 0;
    this.verifyResult = { ok: true, code: null };
  }

  async send(message: OutboundMailMessage): Promise<OutboundMailOutcome> {
    this.attempts.push(message);
    if (hasInjection(message)) return { outcome: 'permanent_error', code: 'HEADER_INJECTION' };
    const behaviour = this.queue.shift() ?? { outcome: 'sent' };
    switch (behaviour.outcome) {
      case 'sent':
        this.sent.push(message);
        return { outcome: 'sent', providerCode: behaviour.providerCode ?? 'SMTP_250' };
      case 'transient_error':
        return { outcome: 'transient_error', code: behaviour.code ?? 'SMTP_421' };
      case 'permanent_error':
        return { outcome: 'permanent_error', code: behaviour.code ?? 'SMTP_550' };
      case 'unknown':
        return { outcome: 'unknown', code: behaviour.code ?? 'SMTP_ETIMEDOUT' };
      case 'throw':
        throw new Error('FakeMailGateway: simulierter Transportabsturz');
    }
  }

  async verify(): Promise<{ ok: boolean; code: string | null }> {
    return this.verifyResult;
  }
}

/**
 * Gateway-Wahl je Umgebung (Order §§5/39): SMTP nur bei vollständiger
 * Konfiguration (config.mail.enabled), sonst Disabled – in JEDER Umgebung.
 * Demo nutzt ebenfalls SMTP; die Whitelist greift in der Outbox. Ein Fake
 * entsteht hier nie (nur per Test-Injection; production lehnt ihn ab).
 */
export function createOutboundMailGateway(config: AppConfig): OutboundMailGateway {
  if (config.mail.enabled && config.mail.smtp !== null) {
    return new SmtpMailGateway(config.mail.smtp);
  }
  return new DisabledMailGateway();
}

/** Production darf nie mit einem Fake-Gateway starten (Pflichttest „Production FakeMail blockiert“). */
export function assertMailGatewayAllowed(config: AppConfig, gateway: OutboundMailGateway): void {
  if (config.appEnv === 'production' && gateway.kind === 'fake') {
    throw new Error(
      'FakeMailGateway ist in production nicht zulässig (Mail nur SMTP oder deaktiviert).',
    );
  }
}
