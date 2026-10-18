/**
 * Phase 12 (Order §21/§23): Verarbeitung eingehender E-Mails.
 *
 * Ablauf je Poll:
 *  1. Zustand der Mailbox laden (`inbound_mail_state`: UIDVALIDITY, lastUid).
 *  2. Quelle fragen (UID > lastUid; bei UIDVALIDITY-Wechsel ab 1).
 *  3. Je Nachricht: parsen (mailparser), deduplizieren (UID-Tripel,
 *     Message-ID, Fingerprint), zuordnen (In-Reply-To/References ⇒
 *     mail_deliveries.message_id; sonst genau EINE Vorgangsnummer + Absender
 *     = Kunden-E-Mail; sonst unmatched), Bilder prüfen/speichern, Beleg +
 *     Konversationszeile in EINER Transaktion schreiben.
 *  4. lastUid erst NACH erfolgreicher Verarbeitung der Nachricht fortschreiben
 *     (Restart-sicher: nach einem Absturz werden Nachrichten erneut gelesen und
 *     über die Belege dedupliziert).
 *
 * Härtung RA-10 (Poison Message): Steuerzeichen werden vor dem Speichern
 * entfernt; scheitert eine Nachricht dennoch NICHT wiederholbar (Datenfehler
 * der DB – SQLSTATE-Klasse 22/23 – oder unlesbares MIME), wird sie mit einem
 * Beleg `rejected` / matchReason `quarantined:<code>` übersprungen und lastUid
 * fortgeschrieben (Mail bleibt im Postfach; geloggt wird nur der Code).
 * Wiederholbare Fehler (DB/Storage nicht erreichbar) werfen weiter – der Poll
 * bleibt an dieser UID stehen und versucht es erneut.
 * Härtung RA-6: Fingerprint-Dedupe nur ohne Message-ID (siehe content.ts).
 * Härtung H7: hochgeladene Fotos werden bei JEDEM Fehlschlag wieder gelöscht.
 *
 * Eine Mail autorisiert NIE eine Fachaktion – hier entstehen ausschließlich
 * Konversationszeilen, Belege und Fotos.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  customers,
  inboundMailReceipts,
  inboundMailState,
  mailDeliveries,
  processes,
  type Database,
} from '@mietroyal/database';
import type { JobRunnerLogger, StorageProvider } from '@mietroyal/integrations';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { simpleParser, type ParsedMail } from 'mailparser';
import { normalizeEmailAddress } from '../../crm/normalize.ts';
import {
  ConversationService,
  photoStorageKey,
  type SenderSnapshot,
} from '../conversation/conversation-service.ts';
import type { InboundMailEnvelope, InboundMailSource } from '../types.ts';
import {
  acceptImageAttachment,
  chooseInboundBody,
  extractProcessNumbers,
  imageExtensionFor,
  inboundMailFingerprint,
  inboundMessageIdFingerprint,
  INBOUND_MAIL_PHOTO_MAX_BYTES,
  normalizeMessageId,
  parseMessageIdList,
  stripControlChars,
  truncateBody,
  type AllowedImageMime,
} from './content.ts';

export const INBOUND_POLL_LIMIT = 50;

export type InboundMatchReason = 'in_reply_to' | 'references' | 'process_number_sender';

/** Härtung RA-10: Beleg-Grund einer übersprungenen (nicht verarbeitbaren) Nachricht. */
export const INBOUND_QUARANTINE_REASON_PREFIX = 'quarantined:';

/** Nicht wiederholbarer Verarbeitungsfehler einer einzelnen Nachricht (Poison Message). */
export class InboundPoisonMessageError extends Error {
  constructor(readonly code: string) {
    super(`Eingehende Nachricht nicht verarbeitbar (${code}).`);
    this.name = 'InboundPoisonMessageError';
  }
}

export interface InboundMessageOutcome {
  uid: number;
  result: 'matched' | 'unmatched' | 'duplicate' | 'quarantined';
  matchReason: InboundMatchReason | null;
  conversationMessageId: string | null;
  photos: number;
  skippedAttachments: number;
}

export interface InboundPollResult {
  mailbox: string;
  uidValidity: number | null;
  fetched: number;
  outcomes: InboundMessageOutcome[];
  lastUid: number;
  errorCode: string | null;
}

interface ParsedInbound {
  messageId: string | null;
  inReplyTo: string[];
  references: string[];
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  date: Date | null;
  body: string;
  attachments: { contentType: string; content: Buffer }[];
}

export class InboundMailProcessor {
  private readonly conversations: ConversationService;

  constructor(
    private readonly deps: {
      db: Database;
      storage: StorageProvider;
      source: InboundMailSource;
      logger?: JobRunnerLogger;
      now?: () => Date;
    },
  ) {
    this.conversations = new ConversationService(deps.db, deps.storage);
  }

  private now(): Date {
    return this.deps.now === undefined ? new Date() : this.deps.now();
  }

  /** Ein Abruf: liest neue Nachrichten und verarbeitet sie der Reihe nach. */
  async pollOnce(mailbox = 'INBOX', limit = INBOUND_POLL_LIMIT): Promise<InboundPollResult> {
    const db = this.deps.db;
    const stateRows = await db
      .select()
      .from(inboundMailState)
      .where(eq(inboundMailState.mailbox, mailbox));
    const state = stateRows[0] ?? null;
    const knownUidValidity =
      state === null || state.uidValidity === null ? null : Number(state.uidValidity);
    let sinceUid = state?.lastUid ?? 0;
    const pollAt = this.now();

    let fetched: { uidValidity: number; messages: InboundMailEnvelope[] };
    try {
      fetched = await this.deps.source.fetch({ sinceUid, knownUidValidity, limit });
    } catch (error) {
      const code = errorCodeOf(error);
      await this.upsertState(mailbox, { lastPollAt: pollAt, lastErrorCode: code });
      this.deps.logger?.warn({ mailbox, code }, 'mail.inbound_poll: Abruf fehlgeschlagen');
      return {
        mailbox,
        uidValidity: knownUidValidity,
        fetched: 0,
        outcomes: [],
        lastUid: sinceUid,
        errorCode: code,
      };
    }

    // UIDVALIDITY-Wechsel: Mailbox wurde neu aufgebaut ⇒ UIDs beginnen neu.
    if (knownUidValidity !== null && knownUidValidity !== fetched.uidValidity) {
      sinceUid = 0;
      this.deps.logger?.warn(
        { mailbox, previous: knownUidValidity, current: fetched.uidValidity },
        'mail.inbound_poll: UIDVALIDITY geändert – Zähler zurückgesetzt',
      );
    }
    await this.upsertState(mailbox, {
      uidValidity: String(fetched.uidValidity),
      lastUid: sinceUid,
      lastPollAt: pollAt,
      lastErrorCode: null,
    });

    const outcomes: InboundMessageOutcome[] = [];
    let lastUid = sinceUid;
    for (const envelope of fetched.messages.sort((a, b) => a.uid - b.uid)) {
      if (envelope.uid <= lastUid) continue;
      const current = { ...envelope, uidValidity: fetched.uidValidity };
      let outcome: InboundMessageOutcome;
      try {
        outcome = await this.processEnvelope(current);
      } catch (error) {
        // Wiederholbar (DB/Storage weg …): werfen, lastUid bleibt – nächster Poll versucht es erneut.
        const poisonCode = nonRetryableInboundCode(error);
        if (poisonCode === null) throw error;
        outcome = await this.quarantine(current, poisonCode);
      }
      outcomes.push(outcome);
      lastUid = envelope.uid;
      // Erst nach erfolgreicher Verarbeitung fortschreiben (Restart-Sicherheit).
      await this.upsertState(mailbox, { lastUid, lastSuccessAt: this.now(), lastErrorCode: null });
      this.deps.logger?.info(
        {
          mailbox,
          uid: envelope.uid,
          result: outcome.result,
          matchReason: outcome.matchReason,
          conversationMessageId: outcome.conversationMessageId,
          photos: outcome.photos,
          skippedAttachments: outcome.skippedAttachments,
        },
        'mail.inbound_poll: Nachricht verarbeitet',
      );
    }
    if (fetched.messages.length === 0) {
      await this.upsertState(mailbox, { lastSuccessAt: this.now() });
    }
    return {
      mailbox,
      uidValidity: fetched.uidValidity,
      fetched: fetched.messages.length,
      outcomes,
      lastUid,
      errorCode: null,
    };
  }

  private async upsertState(
    mailbox: string,
    patch: Partial<{
      uidValidity: string;
      lastUid: number;
      lastPollAt: Date;
      lastSuccessAt: Date;
      lastErrorCode: string | null;
    }>,
  ): Promise<void> {
    const values = { ...patch, updatedAt: this.now() };
    await this.deps.db
      .insert(inboundMailState)
      .values({ mailbox, ...values })
      .onConflictDoUpdate({ target: inboundMailState.mailbox, set: values });
  }

  /**
   * Härtung RA-10: nicht verarbeitbare Nachricht überspringen – Beleg `rejected`
   * (matchReason `quarantined:<code>`, ohne Inhalt/Absender/Betreff), damit
   * lastUid fortgeschrieben werden kann und alle folgenden Mails ankommen.
   */
  private async quarantine(
    envelope: InboundMailEnvelope,
    code: string,
  ): Promise<InboundMessageOutcome> {
    const uidValidity = String(envelope.uidValidity);
    await this.deps.db
      .insert(inboundMailReceipts)
      .values({
        mailbox: envelope.mailbox,
        uidValidity,
        uid: envelope.uid,
        messageId: null,
        fingerprint: createHash('sha256')
          .update(`quarantine|${envelope.mailbox}|${uidValidity}|${envelope.uid}`, 'utf8')
          .digest('hex'),
        fromAddress: null,
        subject: null,
        receivedAt: this.now(),
        status: 'rejected',
        matchReason: `${INBOUND_QUARANTINE_REASON_PREFIX}${code}`,
        conversationMessageId: null,
      })
      .onConflictDoNothing();
    // Nur neutrale Codes/IDs – nie Inhalt, Absender oder Fehlermeldung (Order §38).
    this.deps.logger?.warn(
      { mailbox: envelope.mailbox, uid: envelope.uid, code },
      'mail.inbound_poll: Nachricht nicht verarbeitbar – übersprungen (Quarantäne)',
    );
    return {
      uid: envelope.uid,
      result: 'quarantined',
      matchReason: null,
      conversationMessageId: null,
      photos: 0,
      skippedAttachments: 0,
    };
  }

  /** Eine Nachricht verarbeiten (idempotent über die Belege). */
  async processEnvelope(envelope: InboundMailEnvelope): Promise<InboundMessageOutcome> {
    const db = this.deps.db;
    const uidValidity = String(envelope.uidValidity);
    const base = { uid: envelope.uid, photos: 0, skippedAttachments: 0 };

    // Dedupe 1: UID-Tripel (gleiche Nachricht nach Absturz erneut gelesen).
    const byUid = await db
      .select({ id: inboundMailReceipts.id })
      .from(inboundMailReceipts)
      .where(
        and(
          eq(inboundMailReceipts.mailbox, envelope.mailbox),
          eq(inboundMailReceipts.uidValidity, uidValidity),
          eq(inboundMailReceipts.uid, envelope.uid),
        ),
      );
    if (byUid.length > 0) {
      return { ...base, result: 'duplicate', matchReason: null, conversationMessageId: null };
    }

    const parsed = await this.parse(envelope.raw);
    // Härtung RA-6: mit Message-ID entscheidet NUR die Message-ID (der gespeicherte
    // Fingerprint ist dann ein eigener Namensraum je Message-ID und kollidiert nie);
    // ohne Message-ID: Inhalts-Fingerprint über den GESAMTEN Text, alle Anhänge und
    // Date (fehlt Date: zusätzlich Mailbox/UIDVALIDITY/UID ⇒ nur exakte Duplikate).
    const fingerprint =
      parsed.messageId === null
        ? inboundMailFingerprint({
            from: parsed.fromEmail,
            date: parsed.date,
            subject: parsed.subject,
            body: parsed.body,
            attachmentSha256: parsed.attachments.map((attachment) =>
              createHash('sha256').update(attachment.content).digest('hex'),
            ),
            uidFallback: { mailbox: envelope.mailbox, uidValidity, uid: envelope.uid },
          })
        : inboundMessageIdFingerprint(parsed.messageId);

    // Dedupe 2/3: Message-ID bzw. (nur ohne Message-ID) Fingerprint – z. B. Kopie in
    // zweiter Mailbox, Re-Delivery.
    const duplicateWhere =
      parsed.messageId === null
        ? eq(inboundMailReceipts.fingerprint, fingerprint)
        : eq(inboundMailReceipts.messageId, parsed.messageId);
    const duplicates = await db
      .select({ id: inboundMailReceipts.id })
      .from(inboundMailReceipts)
      .where(duplicateWhere);
    if (duplicates.length > 0) {
      return { ...base, result: 'duplicate', matchReason: null, conversationMessageId: null };
    }

    const match = await this.match(parsed);

    // Bilder: prüfen und VOR der Transaktion unter dem Schlüssel der (vorab
    // erzeugten) Nachrichten-ID hochladen; alles andere nur zählen.
    const messageId = randomUUID();
    const photos: {
      storageKey: string;
      mimeType: AllowedImageMime;
      byteSize: number;
      sha256: string;
    }[] = [];
    let skippedAttachments = 0;
    const discardUploadedPhotos = async () => {
      for (const photo of photos) {
        await this.deps.storage.delete(photo.storageKey).catch(() => undefined);
      }
    };
    try {
      for (const attachment of parsed.attachments) {
        const mime = acceptImageAttachment(
          attachment.contentType,
          attachment.content,
          INBOUND_MAIL_PHOTO_MAX_BYTES,
        );
        if (mime === null) {
          skippedAttachments += 1;
          continue;
        }
        const storageKey = photoStorageKey(messageId, imageExtensionFor(mime));
        await this.deps.storage.put(storageKey, new Uint8Array(attachment.content), {
          contentType: mime,
        });
        photos.push({
          storageKey,
          mimeType: mime,
          byteSize: attachment.content.length,
          sha256: createHash('sha256').update(attachment.content).digest('hex'),
        });
      }
    } catch (error) {
      // Härtung H7: Teil-Uploads nicht verwaisen lassen (Storage-Fehler ⇒ wiederholbar).
      await discardUploadedPhotos();
      throw error;
    }

    const sender: SenderSnapshot = {
      ...(parsed.fromName === null ? {} : { name: parsed.fromName }),
      ...(parsed.fromEmail === null ? {} : { email: parsed.fromEmail }),
      ...(skippedAttachments > 0 ? { skippedAttachments } : {}),
    };
    const receivedAt = parsed.date ?? this.now();

    try {
      await db.transaction(async (tx) => {
        await this.conversations.createInbound(
          {
            id: messageId,
            processId: match.processId,
            customerId: match.customerId,
            channel: 'email',
            sender,
            subject: parsed.subject,
            body: truncateBody(parsed.body),
            providerMessageId: parsed.messageId,
            replyToProviderMessageId: parsed.inReplyTo[0] ?? null,
            receivedAt,
          },
          tx,
        );
        for (const photo of photos) {
          await this.conversations.registerPhoto({ messageId, ...photo }, tx);
        }
        await tx.insert(inboundMailReceipts).values({
          mailbox: envelope.mailbox,
          uidValidity,
          uid: envelope.uid,
          messageId: parsed.messageId,
          fingerprint,
          fromAddress: parsed.fromEmail,
          subject: parsed.subject,
          receivedAt,
          status: match.processId === null ? 'unmatched' : 'matched',
          matchReason: match.reason,
          conversationMessageId: messageId,
        });
      });
    } catch (error) {
      // Härtung H7: bei JEDEM Fehlschlag die vorab hochgeladenen Fotos wieder löschen –
      // die Transaktion ist zurückgerollt, ohne Löschung blieben sie verwaist.
      await discardUploadedPhotos();
      // Unique-Verletzung (paralleler Poll/Race) ⇒ Duplikat.
      if (isUniqueViolation(error)) {
        return { ...base, result: 'duplicate', matchReason: null, conversationMessageId: null };
      }
      throw error;
    }

    return {
      ...base,
      result: match.processId === null ? 'unmatched' : 'matched',
      matchReason: match.reason,
      conversationMessageId: messageId,
      photos: photos.length,
      skippedAttachments,
    };
  }

  private async parse(raw: Uint8Array): Promise<ParsedInbound> {
    let mail: ParsedMail;
    try {
      mail = await simpleParser(Buffer.from(raw), {
        // Eigener, sicherer Tag-Stripper (kein Link-/Bild-Text aus mailparser).
        skipHtmlToText: true,
        skipTextToHtml: true,
        skipImageLinks: true,
      });
    } catch {
      // Unlesbares MIME ist nicht wiederholbar (Härtung RA-10 ⇒ Quarantäne).
      throw new InboundPoisonMessageError('MIME_UNPARSEABLE');
    }
    // Härtung RA-10: Steuerzeichen (v. a. NUL) aus allen gespeicherten Feldern entfernen.
    const from = mail.from?.value[0];
    const fromEmail = normalizeEmailAddress(
      stripControlChars(from?.address ?? '', 'single_line').replace(/\s+/g, ''),
    );
    const fromName = stripControlChars(from?.name ?? '', 'single_line').trim();
    const subject =
      typeof mail.subject === 'string' ? stripControlChars(mail.subject, 'single_line').trim() : '';
    const body = chooseInboundBody({
      text: mail.text ?? null,
      html: typeof mail.html === 'string' ? mail.html : null,
    });
    return {
      messageId: normalizeMessageId(mail.messageId ?? null),
      inReplyTo: parseMessageIdList(mail.inReplyTo ?? null),
      references: parseMessageIdList(mail.references ?? null),
      fromEmail,
      fromName: fromName === '' ? null : fromName.slice(0, 200),
      subject: subject === '' ? null : subject.slice(0, 500),
      date: mail.date instanceof Date && !Number.isNaN(mail.date.getTime()) ? mail.date : null,
      body,
      attachments: (mail.attachments ?? [])
        .filter((attachment) => Buffer.isBuffer(attachment.content))
        .map((attachment) => ({
          contentType: attachment.contentType,
          content: attachment.content,
        })),
    };
  }

  /** Zuordnung in fester Reihenfolge (Order §21). */
  private async match(parsed: ParsedInbound): Promise<{
    processId: string | null;
    customerId: string | null;
    reason: InboundMatchReason | null;
  }> {
    const db = this.deps.db;
    // 1) In-Reply-To / References gegen eigene Outbox-Message-IDs.
    for (const [ids, reason] of [
      [parsed.inReplyTo, 'in_reply_to'],
      [parsed.references, 'references'],
    ] as const) {
      if (ids.length === 0) continue;
      const candidates = ids.flatMap((id) => [id, `<${id}>`]);
      const rows = await db
        .select({ processId: mailDeliveries.processId, customerId: mailDeliveries.customerId })
        .from(mailDeliveries)
        .where(inArray(mailDeliveries.messageId, candidates));
      const hit = rows.find((row) => row.processId !== null);
      if (hit !== undefined && hit.processId !== null) {
        const customerId = hit.customerId ?? (await this.customerOf(hit.processId));
        return { processId: hit.processId, customerId, reason };
      }
    }
    // 2) Genau EINE Vorgangsnummer in Betreff/Text UND Absender = Kunden-E-Mail.
    const numbers = extractProcessNumbers(parsed.subject, parsed.body);
    if (numbers.length === 1 && parsed.fromEmail !== null) {
      const rows = await db
        .select({
          processId: processes.id,
          customerId: processes.customerId,
          email: customers.email,
        })
        .from(processes)
        .innerJoin(customers, eq(customers.id, processes.customerId))
        .where(and(eq(processes.processNumber, numbers[0] as string), isNull(customers.deletedAt)));
      const row = rows[0];
      if (row !== undefined && normalizeEmailAddress(row.email) === parsed.fromEmail) {
        return {
          processId: row.processId,
          customerId: row.customerId,
          reason: 'process_number_sender',
        };
      }
    }
    return { processId: null, customerId: null, reason: null };
  }

  private async customerOf(processId: string): Promise<string | null> {
    const rows = await this.deps.db
      .select({ customerId: processes.customerId })
      .from(processes)
      .where(eq(processes.id, processId));
    return rows[0]?.customerId ?? null;
  }
}

/** SQLSTATE eines pg-/Drizzle-Fehlers (direkt oder als `cause`) oder null. */
function sqlStateOf(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/**
 * Härtung RA-10: neutraler Code, wenn der Fehler an DIESER Nachricht liegt und
 * eine Wiederholung nie hilft (Poison Message) – sonst null (wiederholbar:
 * Verbindungsabbruch, Sperren, Storage). Nur positiv erkannte Datenfehler:
 * SQLSTATE-Klasse 22 (data exception, z. B. 22021 NUL-Byte) und 23
 * (Integrität, außer 23505 – das ist ein Duplikat).
 */
export function nonRetryableInboundCode(error: unknown): string | null {
  if (error instanceof InboundPoisonMessageError) return error.code;
  const state = sqlStateOf(error);
  if (state === null) return null;
  if (state.startsWith('22') || (state.startsWith('23') && state !== '23505')) {
    return `PG_${state}`;
  }
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return (error as { code?: unknown }).code === '23505' || cause?.code === '23505';
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code))
    return code.startsWith('IMAP_') ? code : `IMAP_${code}`;
  return 'IMAP_ERROR';
}
