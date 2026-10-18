/**
 * Härtung Review A (Phase 12, Order §§9/44 „Duplicate Email nach Timeout“) –
 * Regressionstests mit ECHTEM Nodemailer gegen einen lokalen Mini-SMTP-Server
 * (kein TLS, nur 127.0.0.1):
 *  RA-1 Timeout bzw. Verbindungsabbruch NACH vollständig übertragenem DATA ⇒
 *       outcome `unknown` (Zustellung unklar, kein automatischer Retry). Nur
 *       nachweislich vor der Sitzung entstandene Fehler (Verbindung abgelehnt,
 *       Greeting-Timeout, DNS, TLS-Aufbau) sowie 4xx-Antworten sind transient.
 *  RA-INJ (kein Fund) Header-/Recipient-Injection über den Anzeigenamen bzw.
 *       In-Reply-To erzeugt keinen zweiten Empfänger und keinen Zusatz-Header.
 */
import { createServer, type Server } from 'node:net';
import { simpleParser } from 'mailparser';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpMailGateway, classifySmtpError } from '../src/communication/mail/gateways.ts';
import type { OutboundMailMessage } from '../src/communication/types.ts';
import {
  REVIEW_SMTP_CONFIG as SMTP_CONFIG,
  localTransport,
  startMiniSmtp,
  stopMiniSmtp,
  type MiniSmtp,
} from './communication-test-smtp.ts';

function message(overrides: Partial<OutboundMailMessage> = {}): OutboundMailMessage {
  return {
    messageId: '<review-a-1@miet-royal.test>',
    to: { email: 'kunde@example.org', name: 'Max Mustermann' },
    from: { email: 'noreply@miet-royal.test', name: 'Miet-Royal Mainz' },
    replyTo: null,
    subject: 'Rückgabeprotokoll – Vorgang MR-2026-0001',
    text: 'Hallo,\n\nText\n',
    html: '<p>Hallo</p>',
    inReplyTo: null,
    references: [],
    attachments: [],
    ...overrides,
  };
}

let mini: MiniSmtp | null = null;
const extraServers: Server[] = [];
afterEach(async () => {
  await stopMiniSmtp(mini);
  mini = null;
  for (const server of extraServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Server, der Verbindungen annimmt und nie grüßt bzw. sofort wieder schließt. */
async function rawServer(mode: 'silent' | 'close'): Promise<number> {
  const server = createServer((socket) => {
    socket.on('error', () => undefined);
    if (mode === 'close') socket.destroy();
  });
  extraServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

/** Freier, sicher geschlossener Port (Verbindung wird abgelehnt). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('Härtung Review A – SMTP-Ergebnisklassifikation nach angenommenem DATA (RA-1, Order §9)', () => {
  it('RA-1a Timeout NACH vollständig übertragenem DATA ⇒ unknown (kein Retry), Server hat die Nachricht', async () => {
    mini = await startMiniSmtp();
    mini.afterData.push('stall');
    const gateway = new SmtpMailGateway(SMTP_CONFIG, { transport: localTransport(mini.port) });
    const outcome = await gateway.send(message());
    expect(mini.received).toHaveLength(1);
    expect(mini.received[0]).toContain('review-a-1@miet-royal.test');
    expect(outcome).toEqual({ outcome: 'unknown', code: 'SMTP_ETIMEDOUT' });
  });

  it('RA-1b Verbindungsabbruch NACH vollständig übertragenem DATA ⇒ unknown', async () => {
    mini = await startMiniSmtp();
    mini.afterData.push('close');
    const gateway = new SmtpMailGateway(SMTP_CONFIG, { transport: localTransport(mini.port) });
    const outcome = await gateway.send(message());
    expect(mini.received).toHaveLength(1);
    expect(outcome).toEqual({ outcome: 'unknown', code: 'SMTP_ECONNECTION' });
  });

  it('RA-1c Nodemailer 10.1.6 meldet Timeout/Abbruch mit command=CONN, timeoutType=SOCKET_TIMEOUT – classifySmtpError ⇒ unknown', async () => {
    mini = await startMiniSmtp();
    mini.afterData.push('stall');
    const transport = localTransport(mini.port);
    const error = await transport
      .sendMail({
        messageId: '<review-a-2@miet-royal.test>',
        from: { name: 'A', address: 'noreply@miet-royal.test' },
        to: { name: 'B', address: 'kunde@example.org' },
        subject: 's',
        text: 't',
        html: '<p>t</p>',
        attachments: [],
      })
      .then(() => null)
      .catch(
        (e: unknown) =>
          e as { code?: string; command?: string; responseCode?: number; timeoutType?: string },
      );
    expect(error).not.toBeNull();
    expect(error?.code).toBe('ETIMEDOUT');
    expect(error?.command).toBe('CONN');
    expect(error?.timeoutType).toBe('SOCKET_TIMEOUT');
    expect(error?.responseCode).toBeUndefined();
    expect(classifySmtpError(error)).toEqual({ outcome: 'unknown', code: 'SMTP_ETIMEDOUT' });
  });

  it('RA-1d Kontrolle: normaler Versand ⇒ sent, genau eine Nachricht beim Server', async () => {
    mini = await startMiniSmtp();
    const gateway = new SmtpMailGateway(SMTP_CONFIG, { transport: localTransport(mini.port) });
    const outcome = await gateway.send(message());
    expect(outcome).toEqual({ outcome: 'sent', providerCode: 'SMTP_250' });
    expect(mini.received).toHaveLength(1);
  });

  it('RA-1f vor der Sitzung (echter Nodemailer): Verbindung abgelehnt bzw. kein Greeting ⇒ transient (sicher wiederholbar)', async () => {
    const refused = new SmtpMailGateway(SMTP_CONFIG, {
      transport: localTransport(await closedPort()),
    });
    expect(await refused.send(message())).toEqual({
      outcome: 'transient_error',
      code: 'SMTP_ESOCKET',
    });
    // Wie in production: Greeting-Timeout kürzer als Socket-Timeout (gateways.ts: 30 s / 60 s).
    const silent = new SmtpMailGateway(SMTP_CONFIG, {
      transport: localTransport(await rawServer('silent'), {
        greetingTimeout: 300,
        socketTimeout: 2000,
      }),
    });
    expect(await silent.send(message())).toEqual({
      outcome: 'transient_error',
      code: 'SMTP_ETIMEDOUT',
    });
  });

  it('RA-1g Abbruch ohne Greeting ist von einem Abbruch nach DATA nicht unterscheidbar (ECONNECTION/CONN) ⇒ konservativ unknown', async () => {
    const closing = new SmtpMailGateway(SMTP_CONFIG, {
      transport: localTransport(await rawServer('close')),
    });
    expect(await closing.send(message())).toEqual({
      outcome: 'unknown',
      code: 'SMTP_ECONNECTION',
    });
  });

  it('RA-1h Klassifikation der Nodemailer-Fehlerfelder: nur positiv erkannte Aufbaufehler und 4xx sind transient', () => {
    const transient = [
      { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'CONNECT_TIMEOUT' },
      { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'GREETING_TIMEOUT' },
      { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'UPGRADE_TIMEOUT' },
      { code: 'EDNS', command: 'CONN', originalCode: 'ENOTFOUND' },
      { code: 'ESOCKET', command: 'CONN', originalCode: 'ECONNREFUSED', syscall: 'connect' },
      { code: 'ESOCKET', command: 'CONN', originalCode: 'EHOSTUNREACH' },
      { code: 'ESOCKET', command: 'CONN', originalCode: 'CERT_HAS_EXPIRED' },
      { code: 'ETLS', command: 'CONN' },
      { responseCode: 421, code: 'ECONNECTION', command: 'CONN' },
      { responseCode: 451, command: 'DATA' },
      { code: 'ETIMEDOUT', command: 'EHLO' },
    ];
    for (const error of transient) {
      expect(classifySmtpError(error).outcome, JSON.stringify(error)).toBe('transient_error');
    }
    const unknown = [
      { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'SOCKET_TIMEOUT' },
      { code: 'ETIMEDOUT', command: 'CONN' },
      { code: 'ECONNECTION', command: 'CONN' },
      { code: 'ESOCKET', command: 'CONN', originalCode: 'ECONNRESET', syscall: 'read' },
      { code: 'ESOCKET', command: 'CONN', originalCode: 'EPIPE', syscall: 'write' },
      { code: 'EPROTOCOL', command: 'CONN' },
      { code: 'ESTREAM', command: 'API' },
      { code: 'ETIMEDOUT', command: 'DATA' },
      new Error('boom'),
      'kein Fehlerobjekt',
    ];
    for (const error of unknown) {
      expect(classifySmtpError(error).outcome, JSON.stringify(error)).toBe('unknown');
    }
    expect(classifySmtpError({ responseCode: 550, command: 'RCPT TO' }).outcome).toBe(
      'permanent_error',
    );
    expect(classifySmtpError({ code: 'EENVELOPE', command: 'API' }).outcome).toBe(
      'permanent_error',
    );
  });
});

describe('Härtung Review A – Recipient-/Header-Injection über Anzeigenamen (kein Fund)', () => {
  const names = [
    'Evil, Second <evil@attacker.example>',
    'Max Bcc: evil@attacker.example',
    'Max\u0085Bcc: evil@attacker.example',
    '"Max" <evil@attacker.example>, other@attacker.example',
    '=?utf-8?q?evil?= <evil@attacker.example>',
  ];
  for (const name of names) {
    it(`RA-INJ Anzeigename ${JSON.stringify(name)} ⇒ genau ein Empfänger, kein Bcc-Header`, async () => {
      mini = await startMiniSmtp();
      const gateway = new SmtpMailGateway(SMTP_CONFIG, { transport: localTransport(mini.port) });
      const outcome = await gateway.send(
        message({
          to: { email: 'kunde@example.org', name },
          subject: `Betreff ${name}`,
        }),
      );
      expect(outcome.outcome).toBe('sent');
      expect(mini.received).toHaveLength(1);
      const parsed = await simpleParser(Buffer.from(mini.received[0]!, 'utf8'));
      const to = Array.isArray(parsed.to) ? parsed.to : parsed.to === undefined ? [] : [parsed.to];
      const addresses = to.flatMap((entry) => entry.value.map((v) => v.address));
      expect(addresses).toEqual(['kunde@example.org']);
      expect(parsed.bcc).toBeUndefined();
      expect(parsed.cc).toBeUndefined();
      expect(parsed.headers.has('bcc')).toBe(false);
    });
  }

  it('RA-INJ-IRT CRLF/Bcc im In-Reply-To wird von Nodemailer neutralisiert', async () => {
    mini = await startMiniSmtp();
    const gateway = new SmtpMailGateway(SMTP_CONFIG, { transport: localTransport(mini.port) });
    const evil = 'x@example.com>\r\nBcc: evil@attacker.example\r\nX-Evil: <y';
    const outcome = await gateway.send(message({ inReplyTo: evil, references: [evil] }));
    expect(outcome.outcome).toBe('sent');
    const parsed = await simpleParser(Buffer.from(mini.received[0]!, 'utf8'));
    expect(parsed.headers.has('bcc')).toBe(false);
    expect(parsed.headers.has('x-evil')).toBe(false);
  });
});
