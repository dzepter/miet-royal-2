import tls from 'node:tls';

/**
 * Phase 12 (E2E): minimaler IMAP4rev1-Server mit IMPLIZITEM TLS (wie Port
 * 993) für die echte `ImapInboundMailSource` (ImapFlow) der E2E-API –
 * Grundlage der Inbound-Szenarien (I/J). Nur Loopback, nur Tests.
 *
 * Unterstützt genau das, was ImapFlow für „verbinden → INBOX read-only öffnen
 * → `UID FETCH n:* (UID BODY.PEEK[])` → abmelden“ braucht: CAPABILITY,
 * LOGIN / AUTHENTICATE PLAIN (Zugangsdaten werden geprüft), LIST "" "" (Trenner),
 * LIST "" "<name>", SELECT/EXAMINE (EXISTS, UIDVALIDITY, UIDNEXT, FLAGS),
 * UID FETCH/FETCH mit UID/FLAGS/RFC822.SIZE/BODY.PEEK[], NOOP, CHECK, CLOSE,
 * LOGOUT. Keine Schreibkommandos (STORE/EXPUNGE/COPY/APPEND ⇒ NO): die API
 * darf Mails weder löschen noch markieren (Order §21) – jeder Versuch steht
 * in `commands`.
 *
 * Nachrichten legt die Spec über die HTTP-Steuerung ab (communication-
 * fakes.ts: `POST /imap/messages`); `POST /imap/uidvalidity` simuliert einen
 * Mailbox-Reset (neue UIDVALIDITY).
 */

export interface ImapMessage {
  uid: number;
  raw: Buffer;
  flags: string[];
  internalDate: Date;
}

export interface ImapMailbox {
  uidValidity: number;
  messages: ImapMessage[];
  nextUid: number;
}

export interface ImapCommandRecord {
  at: string;
  /** Kommando ohne Argumente (Zugangsdaten werden nie aufgezeichnet). */
  command: string;
  authenticated: boolean;
}

export interface ImapFake {
  readonly mailboxes: Map<string, ImapMailbox>;
  readonly commands: ImapCommandRecord[];
  readonly logins: { at: string; user: string; ok: boolean }[];
  append(folder: string, raw: Buffer, flags?: string[]): number;
  setUidValidity(folder: string, uidValidity: number): void;
  clear(): void;
  close(): Promise<void>;
}

export interface ImapFakeOptions {
  port: number;
  host: string;
  key: Buffer;
  cert: Buffer;
  user: string;
  password: string;
}

const CAPABILITIES = 'IMAP4rev1 AUTH=PLAIN';

/** IMAP-Argumente: Atome, "quoted strings" (mit \-Escapes), (Listen) als Rohtext. */
function parseArguments(input: string): string[] {
  const args: string[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index]!;
    if (char === ' ') {
      index += 1;
      continue;
    }
    if (char === '"') {
      let value = '';
      index += 1;
      while (index < input.length && input[index] !== '"') {
        if (input[index] === '\\' && index + 1 < input.length) index += 1;
        value += input[index];
        index += 1;
      }
      index += 1;
      args.push(value);
      continue;
    }
    if (char === '(') {
      let depth = 0;
      let value = '';
      while (index < input.length) {
        const c = input[index]!;
        if (c === '(') depth += 1;
        if (c === ')') depth -= 1;
        value += c;
        index += 1;
        if (depth === 0) break;
      }
      args.push(value);
      continue;
    }
    let value = '';
    while (index < input.length && input[index] !== ' ') {
      // BODY.PEEK[...] als ein Atom (inkl. Leerzeichen in eckigen Klammern).
      if (input[index] === '[') {
        const close = input.indexOf(']', index);
        value += input.slice(index, close + 1);
        index = close + 1;
        continue;
      }
      value += input[index];
      index += 1;
    }
    args.push(value);
  }
  return args;
}

/** Sequenz-/UID-Menge (`1:*`, `3`, `2,5:7`) gegen die vorhandenen Werte auflösen. */
function resolveSet(set: string, values: number[]): number[] {
  if (values.length === 0) return [];
  const max = Math.max(...values);
  const selected = new Set<number>();
  for (const part of set.split(',')) {
    const [rawFrom, rawTo] = part.split(':');
    const from = rawFrom === '*' ? max : Number(rawFrom);
    const to = rawTo === undefined ? from : rawTo === '*' ? max : Number(rawTo);
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    const hits = values.filter((value) => value >= low && value <= high);
    // RFC 3501: `n:*` mit n > höchstem Wert liefert den höchsten Wert.
    if (hits.length === 0 && (rawFrom === '*' || rawTo === '*')) selected.add(max);
    for (const hit of hits) selected.add(hit);
  }
  return [...selected].sort((a, b) => a - b);
}

function imapDate(date: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getUTCDate())}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

export function startImapFake(options: ImapFakeOptions): Promise<ImapFake> {
  const mailboxes = new Map<string, ImapMailbox>();
  const commands: ImapCommandRecord[] = [];
  const logins: { at: string; user: string; ok: boolean }[] = [];
  const mailbox = (folder: string): ImapMailbox => {
    const key = folder.toUpperCase() === 'INBOX' ? 'INBOX' : folder;
    let box = mailboxes.get(key);
    if (box === undefined) {
      box = { uidValidity: 1, messages: [], nextUid: 1 };
      mailboxes.set(key, box);
    }
    return box;
  };
  mailbox('INBOX');

  const server = tls.createServer(
    { key: options.key, cert: options.cert, minVersion: 'TLSv1.2' },
    (socket) => {
      let authenticated = false;
      let selected: ImapMailbox | null = null;
      let pendingAuthTag: string | null = null;
      let buffer = '';
      const write = (text: string | Buffer) => {
        if (!socket.destroyed) socket.write(text);
      };
      const line = (text: string) => write(`${text}\r\n`);

      const login = (tag: string, user: string, password: string) => {
        const ok = user === options.user && password === options.password;
        logins.push({ at: new Date().toISOString(), user, ok });
        if (ok) {
          authenticated = true;
          line(`${tag} OK [CAPABILITY ${CAPABILITIES}] Logged in`);
        } else {
          line(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
        }
      };

      const fetchMessages = (tag: string, byUid: boolean, set: string, items: string) => {
        if (selected === null) {
          line(`${tag} BAD No mailbox selected`);
          return;
        }
        const box = selected;
        const values = byUid ? box.messages.map((m) => m.uid) : box.messages.map((_, i) => i + 1);
        const wanted = items.toUpperCase();
        for (const value of resolveSet(set, values)) {
          const seq = byUid ? box.messages.findIndex((m) => m.uid === value) + 1 : value;
          const message = box.messages[seq - 1];
          if (message === undefined) continue;
          const parts: (string | Buffer)[] = [`UID ${message.uid}`];
          if (wanted.includes('FLAGS')) parts.push(`FLAGS (${message.flags.join(' ')})`);
          if (wanted.includes('RFC822.SIZE')) parts.push(`RFC822.SIZE ${message.raw.length}`);
          if (wanted.includes('INTERNALDATE')) {
            parts.push(`INTERNALDATE "${imapDate(message.internalDate)}"`);
          }
          const head = `* ${seq} FETCH (${parts.join(' ')}`;
          if (wanted.includes('BODY.PEEK[]') || wanted.includes('BODY[]')) {
            write(`${head} BODY[] {${message.raw.length}}\r\n`);
            write(message.raw);
            write(')\r\n');
          } else {
            line(`${head})`);
          }
        }
        line(`${tag} OK ${byUid ? 'UID FETCH' : 'FETCH'} completed`);
      };

      const handle = (raw: string) => {
        if (pendingAuthTag !== null) {
          const tag = pendingAuthTag;
          pendingAuthTag = null;
          const parts = Buffer.from(raw.trim(), 'base64').toString('utf8').split('\u0000');
          login(tag, parts[1] ?? '', parts[2] ?? '');
          return;
        }
        const space = raw.indexOf(' ');
        if (space < 0) {
          line('* BAD Missing command');
          return;
        }
        const tag = raw.slice(0, space);
        const rest = raw.slice(space + 1);
        const args = parseArguments(rest);
        let command = (args.shift() ?? '').toUpperCase();
        if (command === 'UID') command = `UID ${(args.shift() ?? '').toUpperCase()}`;
        commands.push({ at: new Date().toISOString(), command, authenticated });
        switch (command) {
          case 'CAPABILITY':
            line(`* CAPABILITY ${CAPABILITIES}`);
            line(`${tag} OK CAPABILITY completed`);
            return;
          case 'NOOP':
          case 'CHECK':
            line(`${tag} OK ${command} completed`);
            return;
          case 'LOGIN':
            login(tag, args[0] ?? '', args[1] ?? '');
            return;
          case 'AUTHENTICATE': {
            if ((args[0] ?? '').toUpperCase() !== 'PLAIN') {
              line(`${tag} NO Unsupported mechanism`);
              return;
            }
            if (args[1] !== undefined && args[1] !== '') {
              const parts = Buffer.from(args[1], 'base64').toString('utf8').split('\u0000');
              login(tag, parts[1] ?? '', parts[2] ?? '');
            } else {
              pendingAuthTag = tag;
              line('+ ');
            }
            return;
          }
          case 'LOGOUT':
            line('* BYE Logging out');
            line(`${tag} OK LOGOUT completed`);
            socket.end();
            return;
          default:
            break;
        }
        if (!authenticated) {
          line(`${tag} NO Not authenticated`);
          return;
        }
        switch (command) {
          case 'LIST':
          case 'LSUB': {
            const pattern = args[1] ?? '';
            if (pattern === '') {
              line(`* ${command} (\\Noselect) "/" ""`);
            } else {
              for (const name of mailboxes.keys()) {
                if (
                  pattern === '*' ||
                  pattern === '%' ||
                  pattern.toUpperCase() === name.toUpperCase()
                ) {
                  line(`* ${command} (\\HasNoChildren) "/" "${name}"`);
                }
              }
            }
            line(`${tag} OK ${command} completed`);
            return;
          }
          case 'SELECT':
          case 'EXAMINE': {
            const name = args[0] ?? '';
            const key = name.toUpperCase() === 'INBOX' ? 'INBOX' : name;
            const box = mailboxes.get(key);
            if (box === undefined) {
              line(`${tag} NO [NONEXISTENT] Mailbox does not exist`);
              return;
            }
            selected = box;
            line('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)');
            line('* OK [PERMANENTFLAGS ()] Read-only fake');
            line(`* ${box.messages.length} EXISTS`);
            line('* 0 RECENT');
            line(`* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid`);
            line(`* OK [UIDNEXT ${box.nextUid}] Predicted next UID`);
            line(
              `${tag} OK [${command === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${command} completed`,
            );
            return;
          }
          case 'CLOSE':
          case 'UNSELECT':
            selected = null;
            line(`${tag} OK ${command} completed`);
            return;
          case 'FETCH':
          case 'UID FETCH':
            fetchMessages(tag, command === 'UID FETCH', args[0] ?? '', args.slice(1).join(' '));
            return;
          default:
            // Schreibende/unbekannte Kommandos (STORE, EXPUNGE, COPY, APPEND, …) gibt es hier nicht.
            line(`${tag} NO ${command} not supported by the E2E fake`);
        }
      };

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let newline = buffer.indexOf('\r\n');
        while (newline >= 0) {
          const current = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 2);
          handle(current);
          newline = buffer.indexOf('\r\n');
        }
      });
      socket.on('error', () => undefined);
      line(`* OK [CAPABILITY ${CAPABILITIES}] Miet-Royal E2E-IMAP (nur Tests) bereit`);
    },
  );
  server.on('tlsClientError', () => undefined);

  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(options.port, options.host, () => {
      server.off('error', rejectPromise);
      resolvePromise({
        mailboxes,
        commands,
        logins,
        append(folder, raw, flags = []) {
          const box = mailbox(folder);
          const uid = box.nextUid;
          box.nextUid += 1;
          box.messages.push({ uid, raw, flags, internalDate: new Date() });
          return uid;
        },
        setUidValidity(folder, uidValidity) {
          const box = mailbox(folder);
          box.uidValidity = uidValidity;
        },
        clear() {
          mailboxes.clear();
          mailbox('INBOX');
          commands.length = 0;
          logins.length = 0;
        },
        close() {
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}
