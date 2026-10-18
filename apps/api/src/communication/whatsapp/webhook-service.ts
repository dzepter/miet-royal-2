/**
 * Phase 12 (Order §§26, 27): WhatsApp-Webhook – Verify-Challenge, Signatur
 * über die ROHEN Bytes (X-Hub-Signature-256 = sha256=HMAC-SHA256(App Secret,
 * Body)), Größenlimit 3 MB, Dedupe über whatsapp_events (UNIQUE
 * provider_message_id + event_type), Verarbeitung idempotent im Request.
 * Härtung (Review B): Event-Zeile + Verarbeitung in EINER Transaktion (B1 –
 * Fehler ⇒ Rollback ⇒ Metas Wiederholung verarbeitet neu), Events einer
 * fremden `metadata.phone_number_id` ⇒ `ignored` PHONE_NUMBER_MISMATCH (B13),
 * `last_inbound_at` nur vorwärts (GREATEST, B2).
 *
 * Eingehend werden nur Text und Bilder übernommen (Bilder asynchron über den
 * Job `whatsapp.media_fetch`); alle anderen Typen erzeugen nur eine Hinweis-
 * zeile ohne Inhalt. Statuses (sent/delivered/read/failed) spiegeln den
 * Zustellstatus eigener Nachrichten. Zuordnung: (1) Reply-Kontext auf eine
 * eigene Nachricht, (2) wa_id gegen customers.phone_normalized – genau EIN
 * Kunde UND genau EIN aktiver Vorgang, sonst unmatched.
 * Eine WhatsApp-Nachricht autorisiert NIE Fachaktionen.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '@mietroyal/config';
import {
  conversationMessages,
  customers,
  processes,
  whatsappContacts,
  whatsappEvents,
  type Database,
  type DatabaseExecutor,
} from '@mietroyal/database';
import type { JobQueue, JobRunnerLogger } from '@mietroyal/integrations';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { normalizePhoneNumber } from '../../crm/normalize.ts';
import type { ConversationService, SenderSnapshot } from '../conversation/conversation-service.ts';
import { truncateBody } from '../inbound/content.ts';
import { WHATSAPP_MEDIA_FETCH_JOB_TYPE } from '../types.ts';

export const WHATSAPP_WEBHOOK_BODY_LIMIT = 3 * 1024 * 1024;
export const WHATSAPP_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Härtung B1: Eine `queued`-Eventzeile ohne Ergebnis, die älter ist als diese
 * Karenz, stammt aus einem Absturz VOR der transaktionalen Verarbeitung
 * (Altbestand) und wird bei Metas Wiederholung erneut verarbeitet.
 */
export const WHATSAPP_QUEUED_EVENT_GRACE_MS = 2 * 60 * 1000;
/** Aktive Vorgänge für die Telefon-Zuordnung: alles außer abgeschlossen/storniert. */
export const WHATSAPP_ACTIVE_PROCESS_STATUSES = ['open', 'reopened'] as const;

export type WhatsAppMatchReason = 'reply_context' | 'phone_unique_process' | null;

export interface WhatsAppInboundOutcome {
  providerMessageId: string;
  result: 'matched' | 'unmatched' | 'duplicate' | 'ignored';
  matchReason: WhatsAppMatchReason;
  conversationMessageId: string | null;
  type: string;
}

export interface WhatsAppWebhookResult {
  messages: WhatsAppInboundOutcome[];
  statuses: { providerMessageId: string; status: string; applied: boolean; duplicate: boolean }[];
}

interface ParsedInboundMessage {
  id: string;
  from: string;
  type: string;
  timestamp: Date;
  text: string | null;
  mediaId: string | null;
  contextId: string | null;
  profileName: string | null;
  phoneNumberId: string;
}

interface ParsedStatus {
  id: string;
  status: string;
  timestamp: Date;
  phoneNumberId: string;
  errorCode: number | null;
}

const STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

/** Signaturprüfung über die unveränderten Bytes; konstante Zeit, keine Details nach außen. */
export function verifyWhatsAppSignature(
  appSecret: string,
  rawBody: Buffer,
  header: string | undefined,
): boolean {
  if (header === undefined || !header.startsWith('sha256=')) return false;
  const provided = header.slice('sha256='.length).trim();
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return timingSafeEqual(Buffer.from(provided.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'));
}

export function signWhatsAppBody(appSecret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

/** Verify-Token-Vergleich in konstanter Zeit. */
export function verifyTokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function asString(value: unknown, max = 512): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : null;
}

function parseTimestamp(value: unknown, fallback: Date): Date {
  const seconds =
    typeof value === 'string'
      ? Number.parseInt(value, 10)
      : typeof value === 'number'
        ? value
        : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  return new Date(seconds * 1000);
}

/** Defensive Extraktion der Nachrichten/Status aus dem Meta-Payload. */
export function parseWhatsAppPayload(
  body: unknown,
  now: Date,
): { messages: ParsedInboundMessage[]; statuses: ParsedStatus[] } {
  const messages: ParsedInboundMessage[] = [];
  const statuses: ParsedStatus[] = [];
  const root = body as { object?: unknown; entry?: unknown } | null;
  if (root === null || typeof root !== 'object' || root.object !== 'whatsapp_business_account') {
    return { messages, statuses };
  }
  const entries = Array.isArray(root.entry) ? root.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray((entry as { changes?: unknown })?.changes)
      ? ((entry as { changes: unknown[] }).changes as unknown[])
      : [];
    for (const change of changes) {
      const value = (change as { field?: unknown; value?: unknown })?.value as
        | {
            metadata?: { phone_number_id?: unknown };
            contacts?: unknown;
            messages?: unknown;
            statuses?: unknown;
          }
        | undefined;
      if (value === undefined || value === null || typeof value !== 'object') continue;
      const phoneNumberId = asString(value.metadata?.phone_number_id, 64) ?? 'unknown';
      const profileByWaId = new Map<string, string>();
      for (const contact of Array.isArray(value.contacts) ? value.contacts : []) {
        const waId = asString((contact as { wa_id?: unknown })?.wa_id, 32);
        const name = asString((contact as { profile?: { name?: unknown } })?.profile?.name, 200);
        if (waId !== null && name !== null) profileByWaId.set(waId, name);
      }
      for (const raw of Array.isArray(value.messages) ? value.messages : []) {
        const message = raw as Record<string, unknown>;
        const id = asString(message.id, 256);
        const from = asString(message.from, 32);
        const type = asString(message.type, 32) ?? 'unknown';
        if (id === null || from === null || !/^\d{5,20}$/.test(from)) continue;
        const text =
          type === 'text'
            ? asString((message.text as { body?: unknown } | undefined)?.body, 20_000)
            : null;
        const mediaId =
          type === 'image'
            ? asString((message.image as { id?: unknown } | undefined)?.id, 128)
            : null;
        const contextId = asString((message.context as { id?: unknown } | undefined)?.id, 256);
        messages.push({
          id,
          from,
          type,
          timestamp: parseTimestamp(message.timestamp, now),
          text,
          mediaId,
          contextId,
          profileName: profileByWaId.get(from) ?? null,
          phoneNumberId,
        });
      }
      for (const raw of Array.isArray(value.statuses) ? value.statuses : []) {
        const status = raw as Record<string, unknown>;
        const id = asString(status.id, 256);
        const name = asString(status.status, 32);
        if (id === null || name === null) continue;
        const errors = Array.isArray(status.errors) ? status.errors : [];
        const firstError = errors[0] as { code?: unknown } | undefined;
        statuses.push({
          id,
          status: name,
          timestamp: parseTimestamp(status.timestamp, now),
          phoneNumberId,
          errorCode: typeof firstError?.code === 'number' ? firstError.code : null,
        });
      }
    }
  }
  return { messages, statuses };
}

/** Kandidaten für customers.phone_normalized (Ziffernform mit Länderkennung; Variante 49→0). */
export function phoneCandidatesForWaId(waId: string): string[] {
  const digits = waId.replace(/\D/g, '');
  const candidates = new Set<string>();
  if (digits === '') return [];
  candidates.add(digits);
  const normalized = normalizePhoneNumber(digits);
  if (normalized !== null) candidates.add(normalized);
  if (digits.startsWith('49') && digits.length > 4) candidates.add(`0${digits.slice(2)}`);
  return [...candidates];
}

export class WhatsAppWebhookService {
  private readonly conversations: ConversationService;

  constructor(
    private readonly deps: {
      db: Database;
      config: AppConfig;
      queue: JobQueue;
      conversations: ConversationService;
      logger?: JobRunnerLogger;
      now?: () => Date;
    },
  ) {
    this.conversations = deps.conversations;
  }

  private now(): Date {
    return this.deps.now === undefined ? new Date() : this.deps.now();
  }

  get live(): boolean {
    return (
      this.deps.config.whatsapp.mode === 'live' && this.deps.config.whatsapp.appSecret !== null
    );
  }

  verifySignature(rawBody: Buffer, header: string | undefined): boolean {
    const secret = this.deps.config.whatsapp.appSecret;
    if (secret === null) return false;
    return verifyWhatsAppSignature(secret, rawBody, header);
  }

  verifyChallenge(query: { mode?: string; token?: string; challenge?: string }): string | null {
    const expected = this.deps.config.whatsapp.verifyToken;
    if (expected === null) return null;
    if (query.mode !== 'subscribe' || !verifyTokenMatches(expected, query.token)) return null;
    return query.challenge ?? '';
  }

  /** Verarbeitung eines (bereits signaturgeprüften) Payloads. */
  async process(body: unknown): Promise<WhatsAppWebhookResult> {
    const parsed = parseWhatsAppPayload(body, this.now());
    const result: WhatsAppWebhookResult = { messages: [], statuses: [] };
    for (const message of parsed.messages) {
      result.messages.push(await this.processMessage(message));
    }
    for (const status of parsed.statuses) {
      result.statuses.push(await this.processStatus(status));
    }
    return result;
  }

  /** Härtung B13: Webhook für eine andere Nummer derselben Meta-App? (null-Konfiguration ⇒ keine Prüfung möglich) */
  private phoneNumberMismatch(phoneNumberId: string): boolean {
    const expected = this.deps.config.whatsapp.phoneNumberId;
    return expected !== null && phoneNumberId !== expected;
  }

  private async processMessage(message: ParsedInboundMessage): Promise<WhatsAppInboundOutcome> {
    const now = this.now();
    const base = { providerMessageId: message.id, type: message.type };
    const wantsMedia = message.type === 'image' && message.mediaId !== null;

    // Härtung B1: Event-Zeile und Verarbeitung in EINER Transaktion. Scheitert
    // die Verarbeitung (DB-Fehler, Absturz), wird auch die Event-Zeile
    // zurückgerollt ⇒ Metas Wiederholung (nach Nicht-200) verarbeitet neu,
    // statt als Duplikat verworfen zu werden. Parallele Zustellungen derselben
    // Nachricht warten am UNIQUE-Index auf den Commit der ersten.
    const outcome = await this.deps.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(whatsappEvents)
        .values({
          providerMessageId: message.id,
          eventType: 'message',
          phoneNumberId: message.phoneNumberId,
          status: 'queued',
          receivedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: whatsappEvents.id });
      let event = inserted[0];
      if (event === undefined) {
        const existing = await tx
          .select({
            id: whatsappEvents.id,
            status: whatsappEvents.status,
            receivedAt: whatsappEvents.receivedAt,
            conversationMessageId: whatsappEvents.conversationMessageId,
          })
          .from(whatsappEvents)
          .where(
            and(
              eq(whatsappEvents.providerMessageId, message.id),
              eq(whatsappEvents.eventType, 'message'),
            ),
          )
          .for('update');
        const row = existing[0];
        // Erneut verarbeitet werden nur Altzustände ohne Ergebnis: `failed` bzw.
        // `queued` ohne Konversationszeile nach Karenz (vor der Transaktion
        // entstanden). Alles andere ist ein echtes Duplikat.
        const reprocess =
          row !== undefined &&
          (row.status === 'failed' ||
            (row.status === 'queued' &&
              row.conversationMessageId === null &&
              row.receivedAt.getTime() < now.getTime() - WHATSAPP_QUEUED_EVENT_GRACE_MS));
        if (row === undefined || !reprocess) {
          return {
            result: {
              ...base,
              result: 'duplicate',
              matchReason: null,
              conversationMessageId: null,
            },
            // Absturz nach Commit vor dem Media-Job: Metas Wiederholung holt ihn nach (Key dedupliziert).
            mediaFor:
              wantsMedia && row?.status === 'processed'
                ? (row.conversationMessageId ?? null)
                : null,
          } satisfies { result: WhatsAppInboundOutcome; mediaFor: string | null };
        }
        event = { id: row.id };
      }

      if (this.phoneNumberMismatch(message.phoneNumberId)) {
        await tx
          .update(whatsappEvents)
          .set({ status: 'ignored', resultCode: 'PHONE_NUMBER_MISMATCH', processedAt: now })
          .where(eq(whatsappEvents.id, event.id));
        return {
          result: { ...base, result: 'ignored', matchReason: null, conversationMessageId: null },
          mediaFor: null,
        } satisfies { result: WhatsAppInboundOutcome; mediaFor: string | null };
      }

      // Kontakt pflegen (24-h-Fenster beginnt mit JEDER Kundennachricht).
      // Härtung B2: last_inbound_at springt nie zurück (verspätete/umsortierte Zustellung).
      const match = await this.match(message, tx);
      await tx
        .insert(whatsappContacts)
        .values({
          waId: message.from,
          customerId: match.customerId,
          lastInboundAt: message.timestamp,
          profileName: message.profileName,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: whatsappContacts.waId,
          set: {
            lastInboundAt: sql`GREATEST(${whatsappContacts.lastInboundAt}, excluded.last_inbound_at)`,
            updatedAt: now,
            ...(message.profileName === null ? {} : { profileName: message.profileName }),
            ...(match.customerId === null ? {} : { customerId: match.customerId }),
          },
        });

      const sender: SenderSnapshot = {
        phone: message.from,
        ...(message.profileName === null ? {} : { name: message.profileName }),
      };
      const supported = message.type === 'text' || message.type === 'image';
      const body =
        message.type === 'text'
          ? truncateBody(message.text ?? '')
          : message.type === 'image'
            ? '[Bild]'
            : `[Nicht unterstützter Nachrichtentyp: ${message.type}]`;

      // Idempotent: Konversationszeile je providerMessageId genau einmal.
      const existingMessage = await tx
        .select({ id: conversationMessages.id })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.channel, 'whatsapp'),
            eq(conversationMessages.providerMessageId, message.id),
          ),
        );
      const created =
        existingMessage[0] ??
        (await this.conversations.createInbound(
          {
            processId: match.processId,
            customerId: match.customerId,
            channel: 'whatsapp',
            sender,
            subject: null,
            body,
            providerMessageId: message.id,
            replyToProviderMessageId: message.contextId,
            receivedAt: message.timestamp,
          },
          tx,
        ));
      await tx
        .update(whatsappEvents)
        .set({
          status: supported ? 'processed' : 'ignored',
          resultCode: supported
            ? (match.reason ?? 'unmatched')
            : `UNSUPPORTED_${message.type.toUpperCase()}`,
          processedAt: now,
          conversationMessageId: created.id,
        })
        .where(eq(whatsappEvents.id, event.id));
      return {
        result: {
          ...base,
          result: supported ? (match.processId === null ? 'unmatched' : 'matched') : 'ignored',
          matchReason: match.reason,
          conversationMessageId: created.id,
        },
        mediaFor: wantsMedia ? created.id : null,
      } satisfies { result: WhatsAppInboundOutcome; mediaFor: string | null };
    });

    // Media-Job erst NACH dem Commit (Key je wamid ⇒ Wiederholungen deduplizieren).
    if (outcome.mediaFor !== null && message.mediaId !== null) {
      await this.deps.queue.enqueue(
        WHATSAPP_MEDIA_FETCH_JOB_TYPE,
        { messageId: outcome.mediaFor, mediaId: message.mediaId },
        { idempotencyKey: `${WHATSAPP_MEDIA_FETCH_JOB_TYPE}:${message.id}`, maxAttempts: 5 },
      );
    }
    const result = outcome.result;
    if (result.result !== 'duplicate') {
      this.deps.logger?.info(
        {
          channel: 'whatsapp',
          conversationMessageId: result.conversationMessageId,
          type: message.type,
          result: result.result,
          matchReason: result.matchReason,
        },
        'whatsapp.webhook: Nachricht verarbeitet',
      );
    }
    return result;
  }

  private async match(
    message: ParsedInboundMessage,
    db: DatabaseExecutor,
  ): Promise<{ processId: string | null; customerId: string | null; reason: WhatsAppMatchReason }> {
    // 1) Antwort auf eine eigene Nachricht ⇒ deren Vorgang.
    if (message.contextId !== null) {
      const rows = await db
        .select({
          processId: conversationMessages.processId,
          customerId: conversationMessages.customerId,
        })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.channel, 'whatsapp'),
            eq(conversationMessages.providerMessageId, message.contextId),
          ),
        );
      const hit = rows.find((row) => row.processId !== null);
      if (hit !== undefined && hit.processId !== null) {
        return { processId: hit.processId, customerId: hit.customerId, reason: 'reply_context' };
      }
    }
    // 2) Telefonnummer ⇒ genau ein Kunde ⇒ genau ein aktiver Vorgang.
    const candidates = phoneCandidatesForWaId(message.from);
    if (candidates.length === 0) return { processId: null, customerId: null, reason: null };
    const customerRows = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(inArray(customers.phoneNormalized, candidates), isNull(customers.deletedAt)));
    if (customerRows.length !== 1) return { processId: null, customerId: null, reason: null };
    const customerId = customerRows[0]!.id;
    const processRows = await db
      .select({ id: processes.id })
      .from(processes)
      .where(
        and(
          eq(processes.customerId, customerId),
          inArray(processes.mainStatus, [...WHATSAPP_ACTIVE_PROCESS_STATUSES]),
        ),
      );
    if (processRows.length !== 1) return { processId: null, customerId, reason: null };
    return { processId: processRows[0]!.id, customerId, reason: 'phone_unique_process' };
  }

  private async processStatus(
    status: ParsedStatus,
  ): Promise<{ providerMessageId: string; status: string; applied: boolean; duplicate: boolean }> {
    const now = this.now();
    const eventType = `status.${status.status}`;
    // Härtung B1: Event-Zeile und Statusübernahme atomar (Rollback ⇒ Metas Retry wirkt).
    return this.deps.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(whatsappEvents)
        .values({
          providerMessageId: status.id,
          eventType,
          phoneNumberId: status.phoneNumberId,
          status: 'queued',
          receivedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: whatsappEvents.id });
      const event = inserted[0];
      if (event === undefined)
        return {
          providerMessageId: status.id,
          status: status.status,
          applied: false,
          duplicate: true,
        };

      // Härtung B13: Status einer anderen Nummer derselben App ⇒ ignoriert.
      if (this.phoneNumberMismatch(status.phoneNumberId)) {
        await tx
          .update(whatsappEvents)
          .set({ status: 'ignored', resultCode: 'PHONE_NUMBER_MISMATCH', processedAt: now })
          .where(eq(whatsappEvents.id, event.id));
        return {
          providerMessageId: status.id,
          status: status.status,
          applied: false,
          duplicate: false,
        };
      }

      const rows = await tx
        .select({ id: conversationMessages.id, deliveryState: conversationMessages.deliveryState })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.channel, 'whatsapp'),
            eq(conversationMessages.direction, 'outbound'),
            eq(conversationMessages.providerMessageId, status.id),
          ),
        );
      const target = rows[0];
      let applied = false;
      if (target !== undefined) {
        const next =
          status.status === 'failed'
            ? 'failed'
            : (STATUS_RANK[status.status] ?? 0) > 0
              ? status.status
              : null;
        const currentRank = STATUS_RANK[target.deliveryState] ?? 0;
        const nextRank = next === null ? 0 : (STATUS_RANK[next] ?? 0);
        if (
          next === 'failed' ||
          (next !== null && nextRank > currentRank && target.deliveryState !== 'failed')
        ) {
          await tx
            .update(conversationMessages)
            .set({ deliveryState: next as 'sent' | 'delivered' | 'read' | 'failed' })
            .where(eq(conversationMessages.id, target.id));
          applied = true;
        }
      }
      await tx
        .update(whatsappEvents)
        .set({
          status: target === undefined ? 'ignored' : 'processed',
          resultCode:
            status.errorCode === null
              ? target === undefined
                ? 'UNKNOWN_MESSAGE'
                : status.status
              : `GRAPH_${status.errorCode}`,
          processedAt: now,
          conversationMessageId: target?.id ?? null,
        })
        .where(eq(whatsappEvents.id, event.id));
      return { providerMessageId: status.id, status: status.status, applied, duplicate: false };
    });
  }
}
