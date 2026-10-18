import { randomUUID } from 'node:crypto';
import tls from 'node:tls';

/**
 * Phase 12 (E2E): minimale SMTP-Senke mit IMPLIZITEM TLS (wie Port 465) für
 * den echten `SmtpMailGateway` (Nodemailer, rejectUnauthorized: true) der
 * E2E-API. Kein Relay, keine Zustellung – jede angenommene Nachricht wird
 * roh (RFC 822) im Speicher abgelegt und über die HTTP-Steuerung abgefragt
 * (communication-fakes.ts).
 *
 * Unterstützt: EHLO/HELO, AUTH PLAIN/LOGIN (Zugangsdaten werden geprüft –
 * falsch ⇒ 535), MAIL FROM, RCPT TO, DATA bis `<CRLF>.<CRLF>` (Dot-Unstuffing),
 * RSET, NOOP, VRFY, QUIT. Kein PIPELINING, kein STARTTLS (bereits TLS).
 *
 * Fehlerpfade (Steuerung `POST /smtp/fail-next`): die nächste(n) passende(n)
 * Nachricht(en) werden an einer Stufe (`mail` | `rcpt` | `data`) mit dem
 * gewünschten Code beantwortet (4xx temporär ⇒ Retry, 5xx permanent ⇒
 * failed) oder – `mode: 'drop'` – nach vollständigem DATA ohne Antwort
 * getrennt (Zustellung unklar). Abgelehnte Versuche landen in `rejections`.
 */

export interface SinkMessage {
  id: string;
  receivedAt: string;
  mailFrom: string;
  rcptTo: string[];
  authUser: string | null;
  raw: Buffer;
}

export interface SinkRejection {
  receivedAt: string;
  stage: SmtpFailureStage;
  code: number;
  mailFrom: string | null;
  rcptTo: string[];
  mode: 'reply' | 'drop';
}

export type SmtpFailureStage = 'mail' | 'rcpt' | 'data';

export interface SmtpFailure {
  stage: SmtpFailureStage;
  /** SMTP-Antwortcode 400–599 (bei `mode: 'drop'` nur informativ). */
  code: number;
  /** Anzahl betroffener Nachrichten (Standard 1). */
  times: number;
  /** Nur Nachrichten an diesen Empfänger (rcpt/data; Groß-/Kleinschreibung egal). */
  recipient: string | null;
  mode: 'reply' | 'drop';
}

export interface SmtpSinkOptions {
  port: number;
  host: string;
  key: Buffer;
  cert: Buffer;
  user: string;
  password: string;
}

export interface SmtpSink {
  readonly messages: SinkMessage[];
  readonly rejections: SinkRejection[];
  readonly failures: SmtpFailure[];
  clear(): void;
  close(): Promise<void>;
}

interface Session {
  greeted: boolean;
  authUser: string | null;
  auth:
    | { state: 'none' }
    | { state: 'plain' }
    | { state: 'login-user' }
    | { state: 'login-pass'; user: string };
  mailFrom: string | null;
  rcptTo: string[];
  inData: boolean;
  data: Buffer;
  pending: string;
}

const DATA_END = Buffer.from('\r\n.\r\n', 'latin1');

function decodeBase64(value: string): string {
  return Buffer.from(value.trim(), 'base64').toString('utf8');
}

/** `<adresse>` aus `MAIL FROM:<…> SIZE=…` / `RCPT TO:<…>`. */
function parsePath(argument: string): string | null {
  const match = /^\s*<([^>]*)>/.exec(argument);
  if (match === null) return null;
  return match[1]!.trim();
}

function unstuff(raw: Buffer): Buffer {
  // Zeilen, die mit ".." beginnen, verlieren den ersten Punkt (RFC 5321 §4.5.2).
  const text = raw.toString('latin1').replace(/(^|\r\n)\.\./g, '$1.');
  return Buffer.from(text, 'latin1');
}

export function startSmtpSink(options: SmtpSinkOptions): Promise<SmtpSink> {
  const messages: SinkMessage[] = [];
  const rejections: SinkRejection[] = [];
  const failures: SmtpFailure[] = [];

  /** Nächste passende Fehlerinjektion verbrauchen (oder null). */
  function takeFailure(stage: SmtpFailureStage, recipients: string[]): SmtpFailure | null {
    const index = failures.findIndex(
      (failure) =>
        failure.stage === stage &&
        (failure.recipient === null ||
          recipients.some((r) => r.toLowerCase() === failure.recipient!.toLowerCase())),
    );
    if (index < 0) return null;
    const failure = failures[index]!;
    failure.times -= 1;
    if (failure.times <= 0) failures.splice(index, 1);
    return failure;
  }

  const server = tls.createServer(
    { key: options.key, cert: options.cert, minVersion: 'TLSv1.2' },
    (socket) => {
      const session: Session = {
        greeted: false,
        authUser: null,
        auth: { state: 'none' },
        mailFrom: null,
        rcptTo: [],
        inData: false,
        data: Buffer.alloc(0),
        pending: '',
      };
      const reply = (line: string) => {
        if (!socket.destroyed) socket.write(`${line}\r\n`);
      };
      const resetTransaction = () => {
        session.mailFrom = null;
        session.rcptTo = [];
        session.inData = false;
        session.data = Buffer.alloc(0);
      };
      const reject = (stage: SmtpFailureStage, failure: SmtpFailure) => {
        rejections.push({
          receivedAt: new Date().toISOString(),
          stage,
          code: failure.code,
          mailFrom: session.mailFrom,
          rcptTo: [...session.rcptTo],
          mode: failure.mode,
        });
      };

      const checkCredentials = (user: string, password: string) => {
        if (user === options.user && password === options.password) {
          session.authUser = user;
          reply('235 2.7.0 Authentication successful');
        } else {
          reply('535 5.7.8 Authentication credentials invalid');
        }
        session.auth = { state: 'none' };
      };

      const finishData = (content: Buffer) => {
        const failure = takeFailure('data', session.rcptTo);
        if (failure !== null) {
          reject('data', failure);
          if (failure.mode === 'drop') {
            // Nachricht vollständig empfangen, aber keine Antwort: Zustellung unklar.
            socket.destroy();
            return;
          }
          reply(`${failure.code} ${failure.code >= 500 ? '5' : '4'}.3.0 E2E-Senke: abgelehnt`);
          resetTransaction();
          return;
        }
        const id = randomUUID();
        messages.push({
          id,
          receivedAt: new Date().toISOString(),
          mailFrom: session.mailFrom ?? '',
          rcptTo: [...session.rcptTo],
          authUser: session.authUser,
          raw: unstuff(content),
        });
        reply(`250 2.0.0 Ok: queued as ${id}`);
        resetTransaction();
      };

      const handleLine = (line: string) => {
        // AUTH-Dialog (Base64-Zeilen ohne Kommando).
        if (session.auth.state === 'plain') {
          const parts = decodeBase64(line).split('\u0000');
          checkCredentials(parts[1] ?? '', parts[2] ?? '');
          return;
        }
        if (session.auth.state === 'login-user') {
          session.auth = { state: 'login-pass', user: decodeBase64(line) };
          reply('334 UGFzc3dvcmQ6');
          return;
        }
        if (session.auth.state === 'login-pass') {
          checkCredentials(session.auth.user, decodeBase64(line));
          return;
        }

        const space = line.indexOf(' ');
        const verb = (space < 0 ? line : line.slice(0, space)).toUpperCase();
        const argument = space < 0 ? '' : line.slice(space + 1);
        switch (verb) {
          case 'EHLO':
            session.greeted = true;
            resetTransaction();
            socket.write(
              [
                '250-localhost Miet-Royal E2E-Senke',
                '250-AUTH PLAIN LOGIN',
                '250-8BITMIME',
                '250-SMTPUTF8',
                '250 SIZE 52428800',
                '',
              ].join('\r\n'),
            );
            return;
          case 'HELO':
            session.greeted = true;
            resetTransaction();
            reply('250 localhost');
            return;
          case 'AUTH': {
            const [mechanism = '', initial] = argument.trim().split(/\s+/);
            if (session.authUser !== null) {
              reply('503 5.5.1 Already authenticated');
              return;
            }
            if (mechanism.toUpperCase() === 'PLAIN') {
              if (initial !== undefined && initial !== '') {
                const parts = decodeBase64(initial).split('\u0000');
                checkCredentials(parts[1] ?? '', parts[2] ?? '');
              } else {
                session.auth = { state: 'plain' };
                reply('334 ');
              }
              return;
            }
            if (mechanism.toUpperCase() === 'LOGIN') {
              if (initial !== undefined && initial !== '') {
                session.auth = { state: 'login-pass', user: decodeBase64(initial) };
                reply('334 UGFzc3dvcmQ6');
              } else {
                session.auth = { state: 'login-user' };
                reply('334 VXNlcm5hbWU6');
              }
              return;
            }
            reply('504 5.5.4 Unrecognized authentication type');
            return;
          }
          case 'MAIL': {
            if (!session.greeted) {
              reply('503 5.5.1 EHLO first');
              return;
            }
            if (session.authUser === null) {
              reply('530 5.7.0 Authentication required');
              return;
            }
            const address = /^FROM:/i.test(argument) ? parsePath(argument.slice(5)) : null;
            if (address === null) {
              reply('501 5.5.4 Syntax: MAIL FROM:<address>');
              return;
            }
            resetTransaction();
            session.mailFrom = address;
            const failure = takeFailure('mail', []);
            if (failure !== null) {
              reject('mail', failure);
              reply(`${failure.code} ${failure.code >= 500 ? '5' : '4'}.7.0 E2E-Senke: abgelehnt`);
              session.mailFrom = null;
              return;
            }
            reply('250 2.1.0 Ok');
            return;
          }
          case 'RCPT': {
            if (session.mailFrom === null) {
              reply('503 5.5.1 Need MAIL command');
              return;
            }
            const address = /^TO:/i.test(argument) ? parsePath(argument.slice(3)) : null;
            if (address === null || address === '') {
              reply('501 5.5.4 Syntax: RCPT TO:<address>');
              return;
            }
            const failure = takeFailure('rcpt', [address]);
            if (failure !== null) {
              rejections.push({
                receivedAt: new Date().toISOString(),
                stage: 'rcpt',
                code: failure.code,
                mailFrom: session.mailFrom,
                rcptTo: [address],
                mode: 'reply',
              });
              reply(`${failure.code} ${failure.code >= 500 ? '5' : '4'}.1.1 E2E-Senke: abgelehnt`);
              return;
            }
            session.rcptTo.push(address);
            reply('250 2.1.5 Ok');
            return;
          }
          case 'DATA':
            if (session.rcptTo.length === 0) {
              reply('503 5.5.1 Need RCPT command');
              return;
            }
            session.inData = true;
            session.data = Buffer.alloc(0);
            reply('354 End data with <CR><LF>.<CR><LF>');
            return;
          case 'RSET':
            resetTransaction();
            reply('250 2.0.0 Ok');
            return;
          case 'NOOP':
            reply('250 2.0.0 Ok');
            return;
          case 'VRFY':
            reply('252 2.0.0 Cannot VRFY user');
            return;
          case 'QUIT':
            reply('221 2.0.0 Bye');
            socket.end();
            return;
          case '':
            return;
          default:
            reply('502 5.5.2 Command not recognized');
        }
      };

      const consume = (chunk: Buffer) => {
        let rest: Buffer = chunk;
        while (rest.length > 0 && !socket.destroyed) {
          if (session.inData) {
            session.data = Buffer.concat([session.data, rest]);
            let contentEnd: number;
            let restStart: number;
            if (session.data.subarray(0, 3).toString('latin1') === '.\r\n') {
              // Leere Nachricht: DATA-Inhalt beginnt direkt mit ".\r\n".
              contentEnd = 0;
              restStart = 3;
            } else {
              const index = session.data.indexOf(DATA_END);
              if (index === -1) return; // weitere DATA-Bytes abwarten (alles liegt in session.data)
              contentEnd = index + 2; // abschließendes CRLF gehört zur Nachricht
              restStart = index + DATA_END.length;
            }
            const content = session.data.subarray(0, contentEnd);
            rest = session.data.subarray(restStart);
            session.inData = false;
            session.data = Buffer.alloc(0);
            finishData(content);
            continue;
          }
          session.pending += rest.toString('latin1');
          rest = Buffer.alloc(0);
          let newline = session.pending.indexOf('\r\n');
          while (newline >= 0 && !session.inData) {
            const line = session.pending.slice(0, newline);
            session.pending = session.pending.slice(newline + 2);
            handleLine(Buffer.from(line, 'latin1').toString('utf8'));
            newline = session.pending.indexOf('\r\n');
          }
          if (session.inData && session.pending !== '') {
            // Bereits mitgelesene DATA-Bytes (Client wartet sonst nie – nur der Vollständigkeit halber).
            rest = Buffer.from(session.pending, 'latin1');
            session.pending = '';
          }
        }
      };

      socket.on('data', consume);
      socket.on('error', () => undefined);
      reply('220 localhost ESMTP Miet-Royal E2E-Senke (nur Tests)');
    },
  );
  server.on('tlsClientError', () => undefined);

  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(options.port, options.host, () => {
      server.off('error', rejectPromise);
      resolvePromise({
        messages,
        rejections,
        failures,
        clear() {
          messages.length = 0;
          rejections.length = 0;
          failures.length = 0;
        },
        close() {
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}
