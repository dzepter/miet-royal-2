/**
 * Zentrale Kommunikationsschicht (Phase 12) – Verträge.
 *
 * Fachlogik ruft NIE Provider direkt (kein Nodemailer, ImapFlow, Graph-API,
 * web-push außerhalb der Gateways). Alle ausgehenden Nachrichten laufen über
 * die Outbox `mail_deliveries` und Jobs; Gateways sind je Umgebung
 * austauschbar (Real / Fake / Disabled / Demo-Whitelist). Diese Datei hält
 * nur Typen und Konstanten – keine Implementierung.
 */
import type { DatabaseExecutor } from '@mietroyal/database';

// ── Jobtypen (eine Stelle für API und Worker) ────────────────────────────────
export const MAIL_SEND_JOB_TYPE = 'mail.send';
export const MAIL_INBOUND_POLL_JOB_TYPE = 'mail.inbound_poll';
export const COMMUNICATION_SCAN_DUE_JOB_TYPE = 'communication.scan_due';
export const COMMUNICATION_CLEANUP_RETENTION_JOB_TYPE = 'communication.cleanup_retention';
export const WHATSAPP_SEND_JOB_TYPE = 'whatsapp.send';
export const WHATSAPP_MEDIA_FETCH_JOB_TYPE = 'whatsapp.media_fetch';
export const PUSH_SEND_JOB_TYPE = 'push.send';
export const VOUCHER_DELIVERY_JOB_TYPE = 'voucher.delivery';
export const INVOICE_DELIVERY_JOB_TYPE = 'invoice.delivery';

// ── Mail ─────────────────────────────────────────────────────────────────────
export type MailDeliveryKind =
  | 'offer'
  | 'order_confirmation'
  | 'handover_protocol'
  | 'return_protocol'
  | 'settlement_damage_missing_notice'
  | 'cancellation_confirmation'
  | 'reminder_7_days'
  | 'reminder_1_day'
  | 'appointment_changed'
  | 'voucher_delivery'
  | 'invoice_delivery'
  | 'manual_customer_reply';

export type MailDeliveryStatus =
  'pending' | 'sending' | 'sent' | 'retry' | 'failed' | 'blocked' | 'outcome_unknown';

/**
 * Anhänge werden NIE in der Outbox gespeichert, sondern beim Versand
 * aufgelöst: Dokumente aus dem Dokumentenspeicher (unveränderlich), die
 * Lexware-Rechnung transient über den Lexware-Client (nie persistiert).
 */
export type MailAttachmentRef =
  | { kind: 'document'; documentId: string; filename: string }
  | { kind: 'lexware_invoice'; lexwareInvoiceId: string; filename: string };

/**
 * Geheimnisse (Angebots-Token, Aktions-Token, Dokument-Token, Gutscheincode)
 * stehen nur in `secrets` und werden als eine AES-256-GCM-Payload
 * (Purpose `mail-secret-payload`, Entity = delivery id) gespeichert; die
 * Vorlage setzt sie erst beim Versand im Arbeitsspeicher ein.
 */
export interface MailEnqueueInput {
  kind: MailDeliveryKind;
  processId?: string | null;
  customerId?: string | null;
  bookingId?: string | null;
  recipient: { email: string; name?: string | null };
  /** Vorlagen-Kontext ohne Geheimnisse (JSON, wird in der Outbox gespeichert). */
  context: Record<string, unknown>;
  secrets?: Record<string, string>;
  attachments?: readonly MailAttachmentRef[];
  /** Fachlich eindeutig (z. B. `order_confirmation:<id>`), UNIQUE in mail_deliveries. */
  idempotencyKey: string;
  /** Threading: Message-ID der Nachricht, auf die geantwortet wird. */
  inReplyToMessageId?: string | null;
  conversationMessageId?: string | null;
  createdBy?: string | null;
}

export interface MailEnqueueResult {
  deliveryId: string;
  /**
   * `pending` (Versand folgt bzw. läuft), `blocked` (z. B. Demo-Whitelist, Mail
   * deaktiviert). Bei `deduplicated` grob: `blocked` nur für eine blockierte
   * Zeile – den tatsächlichen Status liefert `existingStatus`.
   */
  status: 'pending' | 'blocked';
  /** true, wenn der Idempotenzschlüssel bereits existierte (keine zweite Zustellung). */
  deduplicated: boolean;
  /**
   * Härtung RA-15: tatsächlicher Status der VORHANDENEN Zeile bei
   * `deduplicated` (z. B. sent, failed, outcome_unknown) – sonst null. Fach-
   * services dürfen eine gescheiterte Zustellung nie als „queued“ melden.
   */
  existingStatus: MailDeliveryStatus | null;
  messageId: string;
}

/**
 * Outbox-API für Fachservices. `enqueue` schreibt NUR die Zeile (gern in der
 * fachlichen Transaktion per `executor`); der Job `mail.send` wird nach
 * Commit über `scheduleSend` eingereiht (oder vom scan_due-Job als Backstop
 * für pending-Zeilen ohne Job).
 */
export interface MailOutbox {
  enqueue(input: MailEnqueueInput, executor?: DatabaseExecutor): Promise<MailEnqueueResult>;
  scheduleSend(deliveryId: string): Promise<void>;
}

export interface OutboundMailMessage {
  messageId: string;
  to: { email: string; name: string | null };
  from: { email: string; name: string };
  replyTo: string | null;
  subject: string;
  text: string;
  html: string;
  inReplyTo: string | null;
  references: readonly string[];
  attachments: readonly { filename: string; contentType: string; content: Uint8Array }[];
}

export type OutboundMailOutcome =
  | { outcome: 'sent'; providerCode: string | null }
  | { outcome: 'transient_error'; code: string }
  | { outcome: 'permanent_error'; code: string }
  /** Verbindung brach nach dem DATA-Kommando ab – Zustellung unbekannt (kein blindes Retry). */
  | { outcome: 'unknown'; code: string };

export interface OutboundMailGateway {
  readonly kind: 'smtp' | 'fake' | 'disabled';
  send(message: OutboundMailMessage): Promise<OutboundMailOutcome>;
  /** Admin-Statusprüfung (SMTP-Verbindung/Login) – nie Secrets im Ergebnis. */
  verify(): Promise<{ ok: boolean; code: string | null }>;
}

// ── Inbound Mail ─────────────────────────────────────────────────────────────
export interface InboundMailEnvelope {
  mailbox: string;
  uidValidity: number;
  uid: number;
  /** Rohe RFC-822-Bytes (werden mit mailparser verarbeitet). */
  raw: Uint8Array;
}

export interface InboundMailSource {
  readonly kind: 'imap' | 'fake' | 'disabled';
  /** Liefert Nachrichten mit UID > sinceUid (bei UIDVALIDITY-Wechsel ab 1). Niemals löschen/markieren. */
  fetch(input: {
    sinceUid: number;
    knownUidValidity: number | null;
    limit: number;
  }): Promise<{ uidValidity: number; messages: InboundMailEnvelope[] }>;
  status(): Promise<{ ok: boolean; code: string | null }>;
}

// ── WhatsApp ─────────────────────────────────────────────────────────────────
export interface WhatsAppOutboundText {
  /** E.164 ohne Plus (wa_id-Form), z. B. 4961311234567. */
  to: string;
  text: string;
  /** Kontext-Antwort (message_id der Kundennachricht), optional. */
  replyToProviderMessageId?: string | null;
}

export type WhatsAppSendOutcome =
  | { outcome: 'accepted'; providerMessageId: string }
  | { outcome: 'transient_error'; code: string }
  | { outcome: 'permanent_error'; code: string }
  /**
   * Phase 12 Härtung (B3): Request evtl. bereits bei Meta angekommen, aber
   * keine Antwort (Timeout/Abbruch/Verbindungsabbruch nach dem Senden) ⇒
   * Zustellung unklar ⇒ KEIN automatischer Retry (sonst Doppelnachricht).
   */
  | { outcome: 'unknown'; code: string };

export interface WhatsAppGateway {
  readonly kind: 'cloud_api' | 'fake' | 'mock' | 'disabled';
  sendText(message: WhatsAppOutboundText): Promise<WhatsAppSendOutcome>;
  /** Medien: Metadaten (URL 5 min gültig) + Download mit Bearer – nur Bilder. */
  fetchMedia(
    mediaId: string,
  ): Promise<
    | { outcome: 'ok'; mimeType: string; bytes: Uint8Array }
    | { outcome: 'transient_error'; code: string }
    | { outcome: 'permanent_error'; code: string }
  >;
}

// ── Push ─────────────────────────────────────────────────────────────────────
export type PushKind =
  | 'appointment_1h'
  | 'return_overdue'
  | 'machine_risk'
  | 'machine_risk_6h'
  | 'session_new_device_login'
  // Phase 12 (push): Vertretungsbeginn – kleiner Hinweis an die Vertretung (Order §31).
  | 'substitution_started'
  // Phase 12 (push): kurzfristige Neuzuweisung am Durchführungstag (Order §31, Phase-4-Feld assignmentNotifiedAt).
  | 'assignment_reassigned';

/** Datenminimierung: keine Kundennamen/Telefon/Adresse/Schäden/Beträge. */
export interface PushPayload {
  kind: PushKind;
  title: string;
  body: string;
  /** Relativer Staff-App-Pfad, den notificationclick öffnet. */
  url: string;
  tag: string;
}

export interface PushSubscriptionTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSendOutcome =
  | { outcome: 'sent' }
  | { outcome: 'gone' }
  | { outcome: 'transient_error'; code: string }
  | { outcome: 'permanent_error'; code: string };

export interface PushGateway {
  readonly kind: 'web_push' | 'fake' | 'disabled';
  send(target: PushSubscriptionTarget, payload: PushPayload): Promise<PushSendOutcome>;
}

// ── Fehlercodes ──────────────────────────────────────────────────────────────
export const MAIL_BLOCKED_DEMO_NOT_WHITELISTED = 'DEMO_NOT_WHITELISTED';
export const MAIL_BLOCKED_NOT_CONFIGURED = 'MAIL_NOT_CONFIGURED';
export const MAIL_BLOCKED_NO_RECIPIENT = 'NO_RECIPIENT';
export const MAIL_BLOCKED_SECRET_UNDECRYPTABLE = 'SECRET_UNDECRYPTABLE';
export const DEMO_SUBJECT_PREFIX = '[DEMO] ';
export const MAIL_SIGNATURE = 'Mit freundlichen Grüßen\nMiet-Royal Mainz';

export const WHATSAPP_WINDOW_CLOSED_MESSAGE =
  'WhatsApp-Antwort derzeit nicht frei möglich. Bitte E-Mail oder Anruf nutzen.';
