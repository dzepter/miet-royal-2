/**
 * Phase 12 – Kommunikation (Order §§6, 13, 20, 21, 24, 26, 29, 33).
 *
 * Zentrale, dauerhafte Outbox für E-Mail (`mail_deliveries`), Konversationen
 * (`conversation_messages`, `message_photos`), eingehende Mail-Belege
 * (`inbound_mail_receipts`), WhatsApp-Ereignisse (`whatsapp_events`), Web-Push
 * (`push_subscriptions`, `push_deliveries`), private Kalender-Feeds
 * (`calendar_feed_tokens`), Kunden-Aktions-/Dokument-Links
 * (`customer_action_tokens`), Kontaktänderungen (`booking_customer_contacts`)
 * und die Bindung von Erinnerungen an Terminversionen (`appointment_reminders`).
 *
 * Sicherheitsregeln: Kein Klartext-Geheimnis (Angebots-Token, Aktions-Token,
 * Dokument-Token, Gutschein-Code) in Klartextspalten – nur Hashes bzw. die
 * verschlüsselte `secret_payload`-Spalte (AES-256-GCM, Communication-Key).
 * Keine Secrets, Endpunkte oder Schlüssel in Logs.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bookings, documents } from './commerce.ts';
import { customers, processes } from './crm.ts';
import { appointments } from './scheduling.ts';
import { staffSessions, staffUsers } from './staff-auth.ts';

// ── E-Mail-Outbox (Order §6/§9) ─────────────────────────────────────────

export const mailDeliveryKind = pgEnum('mail_delivery_kind', [
  'offer',
  'order_confirmation',
  'handover_protocol',
  'return_protocol',
  'settlement_damage_missing_notice',
  'cancellation_confirmation',
  'reminder_7_days',
  'reminder_1_day',
  'appointment_changed',
  'voucher_delivery',
  'invoice_delivery',
  'manual_customer_reply',
]);

export const mailDeliveryStatus = pgEnum('mail_delivery_status', [
  'pending',
  'sending',
  'sent',
  'retry',
  'failed',
  'blocked',
  'outcome_unknown',
]);

export const mailDeliveries = pgTable(
  'mail_deliveries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    kind: mailDeliveryKind('kind').notNull(),
    processId: uuid('process_id').references(() => processes.id),
    customerId: uuid('customer_id').references(() => customers.id),
    bookingId: uuid('booking_id').references(() => bookings.id),
    /** Eingefrorener Empfänger (Adresse + Anzeigename) – nie aus dem Live-Kunden nachgeladen. */
    recipientEmail: text('recipient_email').notNull(),
    recipientName: text('recipient_name'),
    subject: text('subject').notNull(),
    templateKind: text('template_kind').notNull(),
    templateVersion: integer('template_version').notNull().default(1),
    /** Nicht-geheime Render-Daten (Namen, Nummern, Daten, Beträge, Linkpfade ohne Token). */
    context: jsonb('context').notNull().default({}),
    /**
     * Geheime Render-Daten (Angebots-/Aktions-/Dokument-Token, Gutschein-Code) –
     * AES-256-GCM mit Communication-Key, AAD = env|purpose|delivery-id; wird
     * nach erfolgreichem Versand gelöscht (Order §7/§15).
     */
    secretPayloadCiphertext: text('secret_payload_ciphertext'),
    /** Anhänge als Referenzen (documentId bzw. Lexware-Mapping) – nie Bytes (Order §16). */
    attachments: jsonb('attachments').notNull().default([]),
    status: mailDeliveryStatus('status').notNull().default('pending'),
    /** Fachlicher Idempotenzschlüssel je Zustellung (z. B. `offer:<versionId>`). */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /** Stabile RFC-5322-Message-ID (`<id@domain>`), vor dem ersten Versuch festgelegt. */
    messageId: text('message_id').notNull().unique(),
    /** Antwort-Bezug auf eine frühere eigene Mail (In-Reply-To), optional. */
    inReplyToMessageId: text('in_reply_to_message_id'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    sendingSince: timestamp('sending_since', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** Neutraler Providercode (z. B. SMTP-Antwortcode), nie Rohantwort mit Daten. */
    providerCode: text('provider_code'),
    lastErrorCode: text('last_error_code'),
    blockedReason: text('blocked_reason'),
    /** Konversationseintrag, der diese Mail als Ereignis spiegelt. */
    conversationMessageId: uuid('conversation_message_id'),
    createdBy: uuid('created_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('mail_deliveries_process_idx').on(table.processId),
    index('mail_deliveries_status_next_idx').on(table.status, table.nextAttemptAt),
    check('mail_deliveries_attempts_check', sql`${table.attempts} >= 0`),
  ],
);

// ── Kunden-Aktions-/Dokument-Links (Order §13/§20) ──────────────────────

export const customerActionPurpose = pgEnum('customer_action_purpose', [
  'pickup_contact_update',
  'delivery_contact_update',
  'document_view',
]);

export const customerActionTokens = pgTable(
  'customer_action_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    purpose: customerActionPurpose('purpose').notNull(),
    /** SHA-256 des 32-Byte-Tokens (base64url) – nie der Klartext. */
    tokenHash: text('token_hash').notNull().unique(),
    processId: uuid('process_id')
      .notNull()
      .references(() => processes.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    bookingId: uuid('booking_id').references(() => bookings.id),
    appointmentId: uuid('appointment_id').references(() => appointments.id),
    /** Genau ein unveränderliches Dokument (purpose document_view). */
    documentId: uuid('document_id').references(() => documents.id),
    /** Kontakt-Links: exakt 1 h vor Terminbeginn (Order §20); Dokument-Links: feste Frist. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    useCount: integer('use_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('customer_action_tokens_process_idx').on(table.processId),
    check(
      'customer_action_tokens_document_purpose_check',
      sql`(${table.purpose} = 'document_view') = (${table.documentId} IS NOT NULL)`,
    ),
  ],
);

export const bookingContactKind = pgEnum('booking_contact_kind', ['pickup', 'delivery']);

/** Vom Kunden per Aktions-Link gepflegte Abholperson / Kontakt vor Ort (ein aktueller Stand je Art). */
export const bookingCustomerContacts = pgTable(
  'booking_customer_contacts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    kind: bookingContactKind('kind').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    phone: text('phone').notNull(),
    updatedViaTokenId: uuid('updated_via_token_id').references(() => customerActionTokens.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('booking_customer_contacts_booking_kind_idx').on(table.bookingId, table.kind),
  ],
);

// ── Erinnerungen an Terminversion binden (Order §17–§19) ────────────────

export const appointmentReminderKind = pgEnum('appointment_reminder_kind', [
  'reminder_7_days',
  'reminder_1_day',
  'push_1_hour',
]);

export const appointmentReminders = pgTable(
  'appointment_reminders',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    appointmentId: uuid('appointment_id')
      .notNull()
      .references(() => appointments.id),
    kind: appointmentReminderKind('kind').notNull(),
    /** Fingerprint der Terminversion (kind|startAt|endAt|assignee) – alte Jobs werden no-op. */
    fingerprint: text('fingerprint').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    mailDeliveryId: uuid('mail_delivery_id').references(() => mailDeliveries.id),
    pushDeliveryId: uuid('push_delivery_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('appointment_reminders_unique_idx').on(
      table.appointmentId,
      table.kind,
      table.fingerprint,
    ),
  ],
);

// ── Konversationen (Order §24/§25) ──────────────────────────────────────

export const conversationChannel = pgEnum('conversation_channel', ['email', 'whatsapp', 'portal']);
export const conversationDirection = pgEnum('conversation_direction', ['inbound', 'outbound']);
export const conversationDeliveryState = pgEnum('conversation_delivery_state', [
  'received',
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'blocked',
]);

export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Null = noch nicht zugeordnet (Order §22/§27). */
    processId: uuid('process_id').references(() => processes.id),
    customerId: uuid('customer_id').references(() => customers.id),
    channel: conversationChannel('channel').notNull(),
    direction: conversationDirection('direction').notNull(),
    /** Absender-Snapshot ohne Secrets: { name?, email?, phone?, displayName }. */
    senderSnapshot: jsonb('sender_snapshot').notNull().default({}),
    subject: text('subject'),
    /** Nur Text (HTML wird sicher zu Text konvertiert; nie Raw-HTML). */
    body: text('body').notNull(),
    providerMessageId: text('provider_message_id'),
    replyToProviderMessageId: text('reply_to_provider_message_id'),
    /** Verweis auf eine eigene Outbox-Zustellung (automatische Mails als kompakte Ereignisse). */
    mailDeliveryId: uuid('mail_delivery_id').references(() => mailDeliveries.id),
    /** Automatische Systemnachricht (Angebot, AB, Protokoll …) vs. echte Kommunikation. */
    isSystemEvent: boolean('is_system_event').notNull().default(false),
    deliveryState: conversationDeliveryState('delivery_state').notNull().default('received'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    createdByStaffId: uuid('created_by_staff_id').references(() => staffUsers.id),
    /** Zuordnung durch Mitarbeitende (Order §22). */
    assignedByStaffId: uuid('assigned_by_staff_id').references(() => staffUsers.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    ignoredAt: timestamp('ignored_at', { withTimezone: true }),
    ignoredByStaffId: uuid('ignored_by_staff_id').references(() => staffUsers.id),
    /** Retention (Order §25): Text 12 Monate nach Vorgangsabschluss. */
    bodyDeletedAt: timestamp('body_deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('conversation_messages_process_idx').on(table.processId, table.createdAt),
    index('conversation_messages_unmatched_idx')
      .on(table.createdAt)
      .where(sql`${table.processId} IS NULL AND ${table.ignoredAt} IS NULL`),
    uniqueIndex('conversation_messages_provider_idx')
      .on(table.channel, table.providerMessageId)
      .where(sql`${table.providerMessageId} IS NOT NULL`),
  ],
);

/** Eingehende Bilder (JPEG/PNG/WebP), privat gespeichert; bei Vorgangsabschluss gelöscht. */
export const messagePhotos = pgTable(
  'message_photos',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    messageId: uuid('message_id')
      .notNull()
      .references(() => conversationMessages.id),
    storageKey: text('storage_key').notNull().unique(),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('message_photos_message_idx').on(table.messageId)],
);

// ── Eingehende E-Mail (Order §21) ───────────────────────────────────────

export const inboundMailStatus = pgEnum('inbound_mail_status', [
  'matched',
  'unmatched',
  'ignored',
  'rejected',
]);

export const inboundMailReceipts = pgTable(
  'inbound_mail_receipts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    mailbox: text('mailbox').notNull(),
    uidValidity: text('uid_validity').notNull(),
    uid: integer('uid').notNull(),
    /** RFC-5322-Message-ID (normalisiert), falls vorhanden. */
    messageId: text('message_id'),
    /** SHA-256 über From|Date|Subject|Body-Präfix als Fallback-Dedupe. */
    fingerprint: text('fingerprint').notNull(),
    fromAddress: text('from_address'),
    subject: text('subject'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    status: inboundMailStatus('status').notNull(),
    matchReason: text('match_reason'),
    conversationMessageId: uuid('conversation_message_id').references(
      () => conversationMessages.id,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('inbound_mail_receipts_uid_idx').on(table.mailbox, table.uidValidity, table.uid),
    uniqueIndex('inbound_mail_receipts_message_id_idx')
      .on(table.messageId)
      .where(sql`${table.messageId} IS NOT NULL`),
    uniqueIndex('inbound_mail_receipts_fingerprint_idx').on(table.fingerprint),
  ],
);

/** Zustand des IMAP-Pollers je Mailbox (UIDVALIDITY + letzter verarbeiteter UID). */
export const inboundMailState = pgTable('inbound_mail_state', {
  mailbox: text('mailbox').primaryKey(),
  uidValidity: text('uid_validity'),
  lastUid: integer('last_uid').notNull().default(0),
  lastPollAt: timestamp('last_poll_at', { withTimezone: true }),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── WhatsApp (Order §26/§27) ────────────────────────────────────────────

export const whatsappEventStatus = pgEnum('whatsapp_event_status', [
  'queued',
  'processed',
  'ignored',
  'failed',
]);

export const whatsappEvents = pgTable(
  'whatsapp_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Meta-Nachrichten-ID (wamid) bzw. Status-Ereignis-ID – Dedupe. */
    providerMessageId: text('provider_message_id').notNull(),
    eventType: text('event_type').notNull(),
    phoneNumberId: text('phone_number_id').notNull(),
    /** Verschlüsselte Nutzlast ist nicht nötig – nur IDs/Typ; Inhalt landet in conversation_messages. */
    status: whatsappEventStatus('status').notNull().default('queued'),
    resultCode: text('result_code'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    conversationMessageId: uuid('conversation_message_id').references(
      () => conversationMessages.id,
    ),
  },
  (table) => [
    uniqueIndex('whatsapp_events_provider_idx').on(table.providerMessageId, table.eventType),
  ],
);

/** Letzte eingehende Kundennachricht je Nummer – Grundlage des 24-h-Service-Fensters (Order §28). */
export const whatsappContacts = pgTable('whatsapp_contacts', {
  /** wa_id (Ziffern ohne Plus). */
  waId: text('wa_id').primaryKey(),
  customerId: uuid('customer_id').references(() => customers.id),
  lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
  profileName: text('profile_name'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Web Push (Order §29–§31) ────────────────────────────────────────────

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id),
    sessionId: uuid('session_id').references(() => staffSessions.id),
    /** Capability-URL – nie loggen (RFC 8030 §8.3). */
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgentLabel: text('user_agent_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    disabledReason: text('disabled_reason'),
  },
  (table) => [
    uniqueIndex('push_subscriptions_endpoint_idx').on(table.endpoint),
    index('push_subscriptions_user_idx').on(table.userId),
  ],
);

export const pushDeliveryStatus = pgEnum('push_delivery_status', [
  'pending',
  'sent',
  'failed',
  'skipped',
]);

/** Fachliche Push-Zustellung je Empfänger (ein Eintrag je Idempotenzschlüssel). */
export const pushDeliveries = pgTable(
  'push_deliveries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    kind: text('kind').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id),
    /** Fachlicher Schlüssel, z. B. `appointment_1h:<appointmentId>:<fingerprint>:<userId>`. */
    idempotencyKey: text('idempotency_key').notNull().unique(),
    /** Datenminimierte Nutzlast: { title, body, url } ohne Kundendaten. */
    payload: jsonb('payload').notNull(),
    status: pushDeliveryStatus('status').notNull().default('pending'),
    subscriptionsTargeted: integer('subscriptions_targeted').notNull().default(0),
    subscriptionsSucceeded: integer('subscriptions_succeeded').notNull().default(0),
    lastErrorCode: text('last_error_code'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('push_deliveries_user_idx').on(table.userId, table.createdAt)],
);

// ── Privater Kalender-Feed (Order §33) ──────────────────────────────────

export const calendarFeedTokens = pgTable('calendar_feed_tokens', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => staffUsers.id),
  /** SHA-256 des 32-Byte-Tokens – Klartext nur bei Erzeugung. */
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  regeneratedAt: timestamp('regenerated_at', { withTimezone: true }),
  lastAccessAt: timestamp('last_access_at', { withTimezone: true }),
});

export type MailDeliveryRow = typeof mailDeliveries.$inferSelect;
export type ConversationMessageRow = typeof conversationMessages.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;
export type CustomerActionTokenRow = typeof customerActionTokens.$inferSelect;
