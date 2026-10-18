/**
 * Phase 12 (Härtung Review A): Test-Hilfen – lokaler Mini-SMTP-Server (nur
 * 127.0.0.1, kein TLS) und ein echter Nodemailer-Transport dorthin, damit die
 * Ergebnisklassifikation des SmtpMailGateway mit den ECHTEN Nodemailer-
 * Fehlerobjekten geprüft werden kann. Nur für Regressionstests.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { createTransport } from 'nodemailer';
import type { SmtpTransportLike } from '../src/communication/mail/gateways.ts';

export type AfterData = 'ok' | 'stall' | 'close';

export interface MiniSmtp {
  server: Server;
  port: number;
  received: string[];
  afterData: AfterData[];
}

/** Minimaler SMTP-Dialog: 220, EHLO, MAIL, RCPT, DATA, Body bis „.“, dann Verhalten je Nachricht. */
export async function startMiniSmtp(): Promise<MiniSmtp> {
  const state: MiniSmtp = {
    server: createServer(),
    port: 0,
    received: [],
    afterData: [],
  };
  state.server.on('connection', (socket: Socket) => {
    let buffer = '';
    let inData = false;
    socket.write('220 mini.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          state.received.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          const behaviour = state.afterData.shift() ?? 'ok';
          if (behaviour === 'ok') socket.write('250 2.0.0 queued\r\n');
          if (behaviour === 'close') socket.destroy();
          // 'stall': Nachricht angenommen, aber keine Antwort (Timeout beim Client).
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250-mini.test\r\n250 8BITMIME\r\n');
        else if (cmd === 'MAIL' || cmd === 'RCPT') socket.write('250 OK\r\n');
        else if (cmd === 'DATA') {
          socket.write('354 go ahead\r\n');
          inData = true;
        } else if (cmd === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else if (cmd === 'RSET' || cmd === 'NOOP') socket.write('250 OK\r\n');
        else socket.write('502 unknown\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  const address = state.server.address();
  state.port = typeof address === 'object' && address !== null ? address.port : 0;
  return state;
}

/** Echter Nodemailer-Transport ohne TLS (nur Test, nur 127.0.0.1) mit kurzem Socket-Timeout. */
export function localTransport(
  port: number,
  timeouts: { connectionTimeout?: number; greetingTimeout?: number; socketTimeout?: number } = {},
): SmtpTransportLike {
  return createTransport({
    host: '127.0.0.1',
    port,
    secure: false,
    ignoreTLS: true,
    connectionTimeout: timeouts.connectionTimeout ?? 2000,
    greetingTimeout: timeouts.greetingTimeout ?? 2000,
    socketTimeout: timeouts.socketTimeout ?? 700,
  }) as unknown as SmtpTransportLike;
}

export async function stopMiniSmtp(mini: MiniSmtp | null): Promise<void> {
  if (mini === null) return;
  await new Promise<void>((resolve) => mini.server.close(() => resolve()));
}

export const REVIEW_SMTP_CONFIG = {
  host: 'smtp.example.invalid',
  port: 465,
  tls: 'implicit' as const,
  user: 'u',
  password: 'p',
};
