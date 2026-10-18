'use client';

/**
 * Phase 12 (UI): Typen, Labels und API-Aufrufe der Kommunikationsbereiche
 * (Vorgang → Kommunikation, Kommunikationsstatus, Nicht zugeordnet,
 * Einstellungen → Kommunikation, Terminänderung, Gutscheinversand). Reine
 * Darstellung – Rechte, Empfänger, Service-Fenster und Versandregeln
 * entscheidet ausschließlich der Server. Nachrichtentexte sind IMMER
 * reiner Text (nie HTML rendern).
 */

import { apiFetch, type ApiResult } from './api';

// ── Konversation je Vorgang (GET /staff/processes/:id/conversation) ───────

export type ConversationChannel = 'email' | 'whatsapp' | 'portal';
export type ConversationDeliveryState =
  'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'blocked';

export interface ConversationSender {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  skippedAttachments?: number;
}

export interface ConversationPhoto {
  id: string;
  mimeType: string;
  byteSize: number;
  deleted: boolean;
}

export interface ConversationMessage {
  id: string;
  processId: string | null;
  customerId: string | null;
  channel: ConversationChannel;
  direction: 'inbound' | 'outbound';
  sender: ConversationSender;
  subject: string | null;
  body: string;
  bodyDeleted: boolean;
  isSystemEvent: boolean;
  deliveryState: ConversationDeliveryState;
  providerMessageId: string | null;
  mailDeliveryId: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  createdAt: string;
  createdByStaff: { id: string; firstName: string; lastName: string } | null;
  photos: ConversationPhoto[];
}

export interface ConversationView {
  messages: ConversationMessage[];
  canReplyEmail: boolean;
  canReplyWhatsApp: boolean;
  whatsapp: {
    mode: 'disabled' | 'live' | 'mock';
    /** true = es gibt eine WhatsApp-Kundennachricht in diesem Vorgang. */
    available: boolean;
    windowOpen: boolean;
    windowEndsAt: string | null;
  };
}

export const CHANNEL_LABELS: Record<ConversationChannel, string> = {
  email: 'E-Mail',
  whatsapp: 'WhatsApp',
  portal: 'Portal',
};

export const DELIVERY_STATE_LABELS: Record<ConversationDeliveryState, string> = {
  received: 'Empfangen',
  queued: 'Versand ausstehend',
  sent: 'Gesendet',
  delivered: 'Zugestellt',
  read: 'Gelesen',
  failed: 'Versand fehlgeschlagen',
  blocked: 'Versand blockiert',
};

/** Order §28 – exakt dieser Text (identisch mit der Server-Meldung). */
export const WHATSAPP_WINDOW_CLOSED_TEXT =
  'WhatsApp-Antwort derzeit nicht frei möglich. Bitte E-Mail oder Anruf nutzen.';
/** Order §28 – Kennzeichnung des Demo-/Entwicklungs-Mocks. */
export const WHATSAPP_MOCK_LABEL = 'DEMO / simuliert';
export const BODY_DELETED_TEXT = 'Inhalt gemäß Aufbewahrungsfrist gelöscht';
/** Server-Limit MANUAL_REPLY_MAX_CHARS (communication-conversation.ts). */
export const REPLY_MAX_CHARS = 5000;

export function fetchConversation(processId: string): Promise<ApiResult<ConversationView>> {
  return apiFetch<ConversationView>(`/staff/processes/${processId}/conversation`);
}

export function sendReply(
  processId: string,
  channel: 'email' | 'whatsapp',
  body: string,
): Promise<
  ApiResult<{
    messageId: string;
    channel: 'email' | 'whatsapp';
    deliveryState: string;
    mailDeliveryId?: string | null;
  }>
> {
  return apiFetch(`/staff/processes/${processId}/conversation/reply`, {
    method: 'POST',
    body: { channel, body },
  });
}

/** Foto-URL der API (nur per fetch mit Session-Cookie → Blob-URL, nie direkt als <img src>). */
export function messagePhotoPath(messageId: string, photoId: string): string {
  return `/api/staff/messages/${messageId}/photos/${photoId}`;
}

// ── Kompakter Kommunikationsstatus (GET /staff/processes/:id/communication-status) ─

export type MailDeliveryStatus =
  'pending' | 'sending' | 'sent' | 'retry' | 'failed' | 'blocked' | 'outcome_unknown';

export interface MailDeliverySummary {
  id: string;
  kind: string;
  kindLabel: string;
  status: MailDeliveryStatus;
  statusLabel: string;
  processId: string | null;
  recipientEmail: string;
  subject: string;
  attempts: number;
  nextAttemptAt: string | null;
  sentAt: string | null;
  lastErrorCode: string | null;
  blockedReason: string | null;
  resendable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProcessCommunicationStatus {
  mailConfigured: boolean;
  deliveries: MailDeliverySummary[];
}

/** Anzeige-Reihenfolge der Statuszeilen im Vorgang (Order §35); Unbekanntes hinten. */
const KIND_ORDER = [
  'offer',
  'order_confirmation',
  'reminder_7_days',
  'reminder_1_day',
  'appointment_changed',
  'handover_protocol',
  'return_protocol',
  'settlement_damage_missing_notice',
  'invoice_delivery',
  'cancellation_confirmation',
  'voucher_delivery',
  'manual_customer_reply',
];

export function sortDeliveriesByKind(deliveries: MailDeliverySummary[]): MailDeliverySummary[] {
  const rank = (kind: string) => {
    const index = KIND_ORDER.indexOf(kind);
    return index === -1 ? KIND_ORDER.length : index;
  };
  return [...deliveries].sort((a, b) => rank(a.kind) - rank(b.kind));
}

export function fetchProcessCommunicationStatus(
  processId: string,
): Promise<ApiResult<ProcessCommunicationStatus>> {
  return apiFetch<ProcessCommunicationStatus>(`/staff/processes/${processId}/communication-status`);
}

/** Badge-Klasse je Zustellstatus – Status steht immer zusätzlich als Text daneben. */
export function deliveryBadgeClass(status: MailDeliveryStatus): string {
  if (status === 'sent') return 'ok';
  if (status === 'failed' || status === 'blocked' || status === 'outcome_unknown') return 'locked';
  return '';
}

// ── Kundenkontakte aus dem Aktionslink (GET /staff/processes/:id/customer-contacts) ─

export interface CustomerContact {
  kind: 'pickup' | 'delivery';
  firstName: string;
  lastName: string;
  phone: string;
  updatedAt: string;
}

export const CONTACT_KIND_LABELS: Record<CustomerContact['kind'], string> = {
  pickup: 'Abholperson',
  delivery: 'Kontakt vor Ort (Lieferung)',
};

export function fetchCustomerContacts(
  processId: string,
): Promise<ApiResult<{ contacts: CustomerContact[] }>> {
  return apiFetch(`/staff/processes/${processId}/customer-contacts`);
}

// ── Nicht zugeordnet (GET /staff/communication/unmatched) ─────────────────

export interface UnmatchedMessage {
  id: string;
  channel: ConversationChannel;
  sender: ConversationSender;
  subject: string | null;
  preview: string;
  receivedAt: string | null;
  createdAt: string;
  photoCount: number;
  customerId: string | null;
}

export function fetchUnmatched(): Promise<ApiResult<{ messages: UnmatchedMessage[] }>> {
  return apiFetch('/staff/communication/unmatched');
}

export function assignUnmatched(
  messageId: string,
  processId: string,
): Promise<ApiResult<{ assigned: boolean; processId: string }>> {
  return apiFetch(`/staff/communication/unmatched/${messageId}/assign`, {
    method: 'POST',
    body: { processId },
  });
}

export function ignoreUnmatched(messageId: string): Promise<ApiResult<{ ignored: boolean }>> {
  return apiFetch(`/staff/communication/unmatched/${messageId}/ignore`, {
    method: 'POST',
    body: {},
  });
}

/** Absenderzeile ohne Rohdaten-Spielereien: Name, sonst E-Mail/Telefon. */
export function senderLabel(sender: ConversationSender): string {
  const name = (sender.name ?? '').trim();
  const address = (sender.email ?? sender.phone ?? '').trim();
  if (name !== '' && address !== '' && name !== address) return `${name} <${address}>`;
  if (name !== '') return name;
  if (address !== '') return address;
  return 'Unbekannter Absender';
}

// ── Admin: Einstellungen → Kommunikation (system.settings) ────────────────

export interface CommunicationAdminStatus {
  environment: 'development' | 'staging' | 'demo' | 'production' | string;
  mail: {
    enabled: boolean;
    gateway: 'smtp' | 'fake' | 'disabled' | string;
    smtpHost: string | null;
    smtpPort: number | null;
    smtpTls: 'implicit' | 'starttls' | string | null;
    fromName: string | null;
    fromAddress: string | null;
    replyAddress: string | null;
    publicWebBaseUrl: string | null;
    demoWhitelistCount: number;
  };
  imap: {
    configured: boolean;
    host: string | null;
    folder: string | null;
    lastPollAt: string | null;
    lastSuccessAt: string | null;
    lastErrorCode: string | null;
  };
  whatsapp: {
    mode: 'disabled' | 'live' | 'mock' | string;
    label?: string | null;
    lastInboundAt?: string | null;
    eventsLast24h?: number;
    contactsWithOpenWindow?: number;
  };
  push: { enabled: boolean; vapidPublicKey: string | null; activeDevices: number };
}

export function fetchCommunicationStatus(): Promise<ApiResult<CommunicationAdminStatus>> {
  return apiFetch<CommunicationAdminStatus>('/staff/communication/status');
}

export function checkSmtp(): Promise<
  ApiResult<{ ok: boolean; code: string | null; gateway: string }>
> {
  return apiFetch('/staff/communication/mail/check', { method: 'POST', body: {} });
}

export function fetchDeliveries(
  status: MailDeliveryStatus | '',
): Promise<ApiResult<{ deliveries: MailDeliverySummary[] }>> {
  const query = status === '' ? '' : `?status=${encodeURIComponent(status)}`;
  return apiFetch(`/staff/communication/deliveries${query}`);
}

export function resendDelivery(
  deliveryId: string,
): Promise<ApiResult<{ deliveryId: string; status: string; messageId: string }>> {
  return apiFetch(`/staff/communication/deliveries/${deliveryId}/resend`, {
    method: 'POST',
    body: {},
  });
}

export const MAIL_DELIVERY_STATUS_FILTER: { value: MailDeliveryStatus | ''; label: string }[] = [
  { value: '', label: 'Alle' },
  { value: 'pending', label: 'Versand ausstehend' },
  { value: 'sending', label: 'Wird gesendet' },
  { value: 'sent', label: 'E-Mail gesendet' },
  { value: 'retry', label: 'Erneuter Versuch geplant' },
  { value: 'failed', label: 'Versand fehlgeschlagen' },
  { value: 'blocked', label: 'Versand blockiert' },
  { value: 'outcome_unknown', label: 'Zustellung unklar' },
];

export const MAIL_GATEWAY_LABELS: Record<string, string> = {
  smtp: 'SMTP',
  fake: 'Test-Gateway (kein echter Versand)',
  disabled: 'Nicht konfiguriert',
};

export function smtpTlsLabel(tls: string | null): string {
  if (tls === 'implicit') return 'TLS (implizit)';
  if (tls === 'starttls') return 'STARTTLS';
  return '–';
}

export const WHATSAPP_MODE_LABELS: Record<string, string> = {
  live: 'Aktiv (Meta WhatsApp Business Cloud API)',
  mock: 'Simulation',
  disabled: 'Nicht konfiguriert',
};

/**
 * Verständliche Texte für neutrale Fehler-/Blockadecodes der Kommunikationsschicht
 * (UX_RULES „Technische Zustände“). Unbekannte Codes ⇒ allgemeiner Text; der Code
 * selbst erscheint nur auf der Admin-Seite als Diagnosehinweis.
 */
const MAIL_CODE_LABELS: Record<string, string> = {
  MAIL_NOT_CONFIGURED: 'E-Mail-Versand ist nicht konfiguriert.',
  DEMO_NOT_WHITELISTED: 'Demo: Empfänger steht nicht auf der Whitelist.',
  NO_RECIPIENT: 'Keine E-Mail-Adresse vorhanden.',
  INVALID_RECIPIENT: 'Die E-Mail-Adresse ist ungültig.',
  SECRET_UNDECRYPTABLE: 'Geschützte Versanddaten sind nicht lesbar.',
  PUBLIC_WEB_BASE_URL_MISSING: 'Öffentliche Web-Adresse für Kundenlinks fehlt.',
  HEADER_INJECTION: 'Ungültige Zeichen in Betreff oder Empfänger – nicht versendet.',
  SMTP_RECIPIENT_REJECTED: 'Der Mailserver hat den Empfänger abgelehnt.',
  SMTP_ETIMEDOUT: 'Zeitüberschreitung beim Mailserver.',
  GATEWAY_EXCEPTION: 'Unerwarteter Fehler beim Versand.',
  // Phase 12 Härtung (Review A/B): Prüfungen unmittelbar vor dem Versand.
  STALE_APPOINTMENT: 'Nicht versendet: Der Termin wurde inzwischen geändert oder storniert.',
  SUPERSEDED: 'Nicht versendet: Es gibt inzwischen eine neuere Angebotsversion.',
  SENDING_STALE: 'Versand unterbrochen – Zustellung unklar. Bitte prüfen und ggf. erneut senden.',
  PRE_SEND_CHECK_FAILED:
    'Prüfung vor dem Versand vorübergehend nicht möglich – neuer Versuch folgt.',
};

export function mailCodeLabel(code: string | null | undefined): string | null {
  if (code === null || code === undefined || code === '') return null;
  const known = MAIL_CODE_LABELS[code];
  if (known !== undefined) return known;
  if (/^SMTP_5\d\d$/.test(code)) return 'Der Mailserver hat die Nachricht dauerhaft abgelehnt.';
  if (/^SMTP_4\d\d$/.test(code)) return 'Der Mailserver ist vorübergehend nicht bereit.';
  if (/^(SMTP_)?E[A-Z]+$/.test(code)) return 'Verbindung zum Mailserver fehlgeschlagen.';
  if (code.startsWith('IMAP_')) return 'Abruf des Posteingangs fehlgeschlagen.';
  return 'Technischer Fehler – Details im Server-Log (ohne Inhalte).';
}

// ── Terminänderung (POST /staff/appointments/:id/inform-customer) ─────────

export function informCustomer(appointmentId: string): Promise<
  ApiResult<{
    informed: boolean;
    deliveryId: string;
    status: 'pending' | 'blocked';
    deduplicated: boolean;
  }>
> {
  return apiFetch(`/staff/appointments/${appointmentId}/inform-customer`, {
    method: 'POST',
    body: {},
  });
}

// ── Gutschein (POST /staff/customers/:id/send-voucher) ─────────────────────
// Kundengebunden (kein /vouchers-Pfad, Phase-11-Sicherheitstest F19): der
// Server prüft, dass der Gutschein zu diesem Kunden gehört.

export function sendVoucherNow(
  customerId: string,
  voucherId: string,
): Promise<ApiResult<{ queued: boolean; voucherId: string }>> {
  return apiFetch(`/staff/customers/${customerId}/send-voucher`, {
    method: 'POST',
    body: { voucherId },
  });
}

/** Order §15 – exakt dieser Text bei fehlender E-Mail-Adresse. */
export const VOUCHER_NO_EMAIL_TEXT = 'Gutschein erstellt – keine E-Mail-Adresse vorhanden.';

/** Versandproblem des Gutscheins als Klartext (nie Code/Hash des Gutscheins selbst). */
export function voucherProblemText(code: string | null | undefined): string | null {
  if (code === null || code === undefined || code === '') return null;
  if (code === 'NO_EMAIL') return VOUCHER_NO_EMAIL_TEXT;
  if (code === 'DELIVERY_COPY_UNDECRYPTABLE') {
    return 'Gutschein gültig – die Versandkopie ist nicht mehr lesbar, ein Mailversand ist nicht möglich. Bitte Admin informieren.';
  }
  if (code === 'MAIL_FAILED') return 'Gutschein gültig – der E-Mail-Versand ist fehlgeschlagen.';
  if (code === 'blocked') return 'Gutschein gültig – der E-Mail-Versand ist derzeit blockiert.';
  return 'Gutschein gültig – der E-Mail-Versand ist noch nicht erfolgt.';
}
