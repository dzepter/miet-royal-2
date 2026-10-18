/**
 * Phase 12 (Inbound, Order §21): Quellen für eingehende E-Mail.
 *
 * - `ImapInboundMailSource`: ImapFlow, Mailbox read-only, Abruf per UID-
 *   Bereich `${sinceUid+1}:*` (bei UIDVALIDITY-Wechsel ab 1), RFC-822-Quelle;
 *   niemals \Seen setzen, niemals löschen, kein UNSEEN-Zwang.
 * - `FakeInboundMailSource`: Tests (Nachrichten aus Fixtures).
 * - `DisabledInboundMailSource`: kein IMAP konfiguriert.
 * Zugangsdaten existieren nur im Config-Objekt – nie im Log (Order §38).
 */
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '@mietroyal/config';
import { ImapFlow } from 'imapflow';
import type { InboundMailEnvelope, InboundMailSource } from '../types.ts';

export const IMAP_CONNECT_TIMEOUT_MS = 20_000;

type ImapConfig = NonNullable<AppConfig['mail']['imap']>;

/** Neutraler Fehlercode für Status/State (nie Serverantwort oder Zugangsdaten). */
export function imapErrorCode(error: unknown): string {
  const err = error as { code?: unknown; authenticationFailed?: unknown; responseStatus?: unknown };
  if (err?.authenticationFailed === true) return 'IMAP_AUTH_FAILED';
  if (typeof err?.code === 'string' && err.code !== '') {
    if (/^E[A-Z]+$/.test(err.code)) return `IMAP_${err.code}`;
    return 'IMAP_ERROR';
  }
  if (typeof err?.responseStatus === 'string') return 'IMAP_RESPONSE_ERROR';
  return 'IMAP_ERROR';
}

export class ImapInboundMailSource implements InboundMailSource {
  readonly kind = 'imap' as const;

  constructor(private readonly imap: ImapConfig) {}

  private client(verifyOnly: boolean): ImapFlow {
    return new ImapFlow({
      host: this.imap.host,
      port: this.imap.port,
      secure: this.imap.tls === 'implicit',
      // STARTTLS-Pflicht: Zugangsdaten gehen nie im Klartext über die Leitung.
      ...(this.imap.tls === 'starttls' ? { doSTARTTLS: true } : {}),
      auth: { user: this.imap.user, pass: this.imap.password },
      logger: false,
      connectionTimeout: IMAP_CONNECT_TIMEOUT_MS,
      verifyOnly,
      clientInfo: { name: 'Miet-Royal', vendor: 'Miet-Royal Mainz' },
    });
  }

  async fetch(input: {
    sinceUid: number;
    knownUidValidity: number | null;
    limit: number;
  }): Promise<{ uidValidity: number; messages: InboundMailEnvelope[] }> {
    const client = this.client(false);
    await client.connect();
    try {
      const mailbox = await client.mailboxOpen(this.imap.folder, { readOnly: true });
      const uidValidity = Number(mailbox.uidValidity);
      const startUid =
        input.knownUidValidity !== null && input.knownUidValidity !== uidValidity
          ? 1
          : input.sinceUid + 1;
      const messages: InboundMailEnvelope[] = [];
      if (mailbox.exists === 0 || startUid >= mailbox.uidNext) {
        return { uidValidity, messages };
      }
      for await (const message of client.fetch(
        `${startUid}:*`,
        { uid: true, source: true },
        { uid: true },
      )) {
        // `N:*` liefert bei N > höchster UID die höchste Nachricht erneut – filtern.
        if (message.uid < startUid) continue;
        if (message.source === undefined) continue;
        messages.push({
          mailbox: this.imap.folder,
          uidValidity,
          uid: message.uid,
          raw: new Uint8Array(message.source),
        });
        if (messages.length >= input.limit) break;
      }
      messages.sort((a, b) => a.uid - b.uid);
      return { uidValidity, messages };
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async status(): Promise<{ ok: boolean; code: string | null }> {
    const client = this.client(true);
    try {
      await client.connect();
      return { ok: true, code: null };
    } catch (error) {
      return { ok: false, code: imapErrorCode(error) };
    } finally {
      await client.logout().catch(() => undefined);
    }
  }
}

export class DisabledInboundMailSource implements InboundMailSource {
  readonly kind = 'disabled' as const;
  async fetch(): Promise<{ uidValidity: number; messages: InboundMailEnvelope[] }> {
    return { uidValidity: 0, messages: [] };
  }
  async status(): Promise<{ ok: boolean; code: string | null }> {
    return { ok: false, code: 'IMAP_NOT_CONFIGURED' };
  }
}

/**
 * Test-Quelle: Nachrichten werden in UID-Reihenfolge eingestellt; `fetch`
 * verhält sich wie ein IMAP-Server (UID > sinceUid, Limit, UIDVALIDITY).
 * `failNextFetch` simuliert Verbindungsfehler; `uidValidity` kann für
 * Mailbox-Neuaufbau-Tests umgestellt werden (UIDs beginnen dann wieder bei 1).
 */
export class FakeInboundMailSource implements InboundMailSource {
  readonly kind = 'fake' as const;
  readonly mailbox: string;
  uidValidity = 1;
  failNextFetch: string | null = null;
  readonly fetchCalls: { sinceUid: number; knownUidValidity: number | null; limit: number }[] = [];
  private nextUid = 1;
  private readonly messages: InboundMailEnvelope[] = [];

  constructor(mailbox = 'INBOX') {
    this.mailbox = mailbox;
  }

  /** Nachricht einstellen; liefert die vergebene UID. */
  add(raw: Uint8Array | string, uid?: number): number {
    const assigned = uid ?? this.nextUid;
    this.nextUid = Math.max(this.nextUid, assigned + 1);
    this.messages.push({
      mailbox: this.mailbox,
      uidValidity: this.uidValidity,
      uid: assigned,
      raw: typeof raw === 'string' ? new TextEncoder().encode(raw) : raw,
    });
    return assigned;
  }

  /** Mailbox-Neuaufbau simulieren: neue UIDVALIDITY, alle UIDs neu ab 1. */
  resetMailbox(uidValidity: number): void {
    this.uidValidity = uidValidity;
    this.nextUid = 1;
    this.messages.length = 0;
  }

  clear(): void {
    this.messages.length = 0;
    this.fetchCalls.length = 0;
    this.nextUid = 1;
  }

  async fetch(input: {
    sinceUid: number;
    knownUidValidity: number | null;
    limit: number;
  }): Promise<{ uidValidity: number; messages: InboundMailEnvelope[] }> {
    this.fetchCalls.push({ ...input });
    if (this.failNextFetch !== null) {
      const code = this.failNextFetch;
      this.failNextFetch = null;
      const error = new Error('Fake IMAP fetch failed') as Error & { code: string };
      error.code = code;
      throw error;
    }
    const startUid =
      input.knownUidValidity !== null && input.knownUidValidity !== this.uidValidity
        ? 1
        : input.sinceUid + 1;
    const messages = this.messages
      .filter((message) => message.uid >= startUid)
      .sort((a, b) => a.uid - b.uid)
      .slice(0, input.limit);
    return { uidValidity: this.uidValidity, messages };
  }

  async status(): Promise<{ ok: boolean; code: string | null }> {
    return { ok: true, code: null };
  }
}

/** Quelle nach Konfiguration (IMAP konfiguriert ⇒ ImapFlow, sonst Disabled). */
export function createInboundMailSource(config: AppConfig): InboundMailSource {
  if (config.mail.imap === null) return new DisabledInboundMailSource();
  return new ImapInboundMailSource(config.mail.imap);
}

/** Eindeutige ID für Fixture-Mails ohne Message-ID (Tests). */
export function fakeMessageId(): string {
  return `<${randomUUID()}@fake.miet-royal.test>`;
}
