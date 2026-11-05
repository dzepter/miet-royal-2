import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { customers } from './crm.ts';

/**
 * Phase 15 (Kundenportal, Order §3/§5/§8): Der Kunde selbst bleibt die Identität –
 * es gibt kein eigenes Portal-Konto. Diese beiden Tabellen tragen ausschließlich
 * die Portal-Authentifizierung (Magic Links und Sessions) und referenzieren
 * direkt `customers.id`. Tokens liegen NIE im Klartext in der Datenbank, sondern
 * ausschließlich als SHA-256-Hex (Order §6/§8). Beide Tabellen sind Business-Daten
 * der jeweiligen Umgebung und gehören in der Demo zur Reset-Löschliste (Order §46).
 */

/** Zweck eines Magic Links: Anmeldung, erneute Bestätigung einer Session, E-Mail-Wechsel. */
export const customerPortalMagicLinkPurpose = pgEnum('customer_portal_magic_link_purpose', [
  'login',
  'reauth',
  'email_change',
]);

/**
 * Portal-Session (Order §8): Lebensdauer ABSOLUT 30 Tage ab `created_at` – kein
 * Sliding Window; `last_seen_at` ist nur Diagnostik und verlängert nichts.
 * `reauthenticated_at` wird beim Login gesetzt (= `authenticated_at`) und durch
 * einen Reauth-Magic-Link erneuert; Profilmutationen verlangen eine Reauth, die
 * höchstens 15 Minuten alt ist (Order §32).
 */
export const customerPortalSessions = pgTable(
  'customer_portal_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    /** SHA-256 (hex) des Sessiontokens; der Klartext steht nur im HttpOnly-Cookie. */
    tokenHash: text('token_hash').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    authenticatedAt: timestamp('authenticated_at', { withTimezone: true }).notNull(),
    reauthenticatedAt: timestamp('reauthenticated_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Grobe, nicht identifizierende Gerätebezeichnung (z. B. „Safari auf iPhone“). */
    userAgentLabel: text('user_agent_label'),
  },
  (table) => [
    index('customer_portal_sessions_customer_idx').on(table.customerId),
    index('customer_portal_sessions_expires_idx').on(table.expiresAt),
    check(
      'customer_portal_sessions_expiry_check',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

/**
 * Magic Links (Order §5/§6): ≥ 32 Zufallsbytes base64url, hier nur der SHA-256-Hex.
 * One-time (`consumed_at`), 15 Minuten gültig (`expires_at`), widerrufbar
 * (`revoked_at`). `session_id` bindet Reauth- und E-Mail-Wechsel-Links an die
 * anfordernde Session; `proposed_email` trägt beim E-Mail-Wechsel die bereits
 * normalisierte neue Adresse – `customers.email` ändert sich erst beim Consume (Order §34).
 */
export const customerPortalMagicLinks = pgTable(
  'customer_portal_magic_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    purpose: customerPortalMagicLinkPurpose('purpose').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    sessionId: uuid('session_id').references(() => customerPortalSessions.id),
    proposedEmail: text('proposed_email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('customer_portal_magic_links_customer_idx').on(table.customerId, table.purpose),
    index('customer_portal_magic_links_expires_idx').on(table.expiresAt),
    // Reauth und E-Mail-Wechsel sind immer sessiongebunden; ein E-Mail-Wechsel trägt immer die neue Adresse.
    check(
      'customer_portal_magic_links_purpose_check',
      sql`(${table.purpose} = 'login' AND ${table.sessionId} IS NULL AND ${table.proposedEmail} IS NULL) OR (${table.purpose} = 'reauth' AND ${table.sessionId} IS NOT NULL AND ${table.proposedEmail} IS NULL) OR (${table.purpose} = 'email_change' AND ${table.sessionId} IS NOT NULL AND ${table.proposedEmail} IS NOT NULL)`,
    ),
  ],
);

export type CustomerPortalSessionRow = typeof customerPortalSessions.$inferSelect;
export type CustomerPortalMagicLinkRow = typeof customerPortalMagicLinks.$inferSelect;
export type CustomerPortalMagicLinkPurpose =
  (typeof customerPortalMagicLinkPurpose.enumValues)[number];
