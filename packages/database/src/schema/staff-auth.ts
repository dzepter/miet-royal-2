import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  uniqueIndex,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Phase 1: Mitarbeiter-Authentifizierung, Sessions/Geräte und granulare
 * Berechtigungen (PERMISSIONS.md, DATA_MODEL.md: User, Permission,
 * RoleTemplate, UserPermission, DeviceSession).
 *
 * Sicherheitsgrundsätze:
 * - Passwörter nur als Argon2id-Hash.
 * - Session-/Reset-/Challenge-Tokens nur als SHA-256-Hash (ein DB-Leak
 *   liefert keine verwendbaren Tokens).
 * - TOTP-Secrets nur AES-256-GCM-verschlüsselt (Schlüssel: AUTH_SECRET_KEY
 *   aus der Umgebung, je Umgebung verschieden).
 * - Recovery-Codes nur als Hash.
 * - E-Mail wird beim Schreiben normalisiert (trim + lowercase); Unique-
 *   Constraint liegt auf der normalisierten Form.
 */

export const staffUserStatus = pgEnum('staff_user_status', ['active', 'locked', 'disabled']);
export const permissionOverrideEffect = pgEnum('permission_override_effect', ['allow', 'deny']);

export const staffUsers = pgTable(
  'staff_users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    /** Immer normalisiert (trim + lowercase) gespeichert. */
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    status: staffUserStatus('status').notNull().default('active'),
    /** Admin verlangt 2FA für dieses Konto. */
    totpRequired: boolean('totp_required').notNull().default(false),
    /** 2FA fertig eingerichtet und beim Login verlangt. */
    totpEnabled: boolean('totp_enabled').notNull().default(false),
    totpSecretEnc: text('totp_secret_enc'),
    /** Während des Setup-Flows, bis der erste Code bestätigt wurde. */
    totpPendingSecretEnc: text('totp_pending_secret_enc'),
    /**
     * Höchster bereits akzeptierter TOTP-Zeitschritt (RFC-6238-Counter).
     * Verhindert Replays desselben Codes innerhalb des Gültigkeitsfensters.
     */
    totpLastUsedStep: bigint('totp_last_used_step', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('staff_users_status_idx').on(table.status)],
);

export const staffSessions = pgTable(
  'staff_sessions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id),
    tokenHash: text('token_hash').notNull().unique(),
    /** Grober Gerätename/Browser zur Wiedererkennung – kein Fingerprinting. */
    deviceLabel: text('device_label').notNull(),
    /**
     * Phase-12-Finalisierung: SHA-256 des Geräte-Cookies `mr_staff_device`
     * der Anmeldung (nie Klartext, nie API-Feld). NULL = Session vor dem
     * Rollout. Dient nur dazu, Push-Abos desselben Mitarbeiters auf demselben
     * Gerät beim erneuten Login an die neue Session zu binden.
     */
    deviceTokenHash: text('device_token_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (table) => [
    index('staff_sessions_user_idx').on(table.userId, table.revokedAt),
    index('staff_sessions_user_device_idx')
      .on(table.userId, table.deviceTokenHash)
      .where(sql`${table.deviceTokenHash} IS NOT NULL`),
  ],
);

/**
 * Kurzlebige Login-Challenge zwischen Passwortprüfung und zweitem Faktor
 * (TOTP-Eingabe oder erzwungene TOTP-Einrichtung). Verhindert halbfertige
 * Sessions und Session-Fixation: Eine Session entsteht erst nach dem
 * vollständigen Login.
 */
export const staffLoginChallenges = pgTable(
  'staff_login_challenges',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id),
    tokenHash: text('token_hash').notNull().unique(),
    /** 'totp' (Code eingeben) oder 'totp_setup' (erzwungene Einrichtung). */
    purpose: text('purpose').notNull(),
    deviceLabel: text('device_label').notNull(),
    /**
     * Phase-12-Finalisierung: SHA-256 des serverseitig gesetzten
     * Geräte-Cookies (`mr_staff_device`) aus dem ersten Loginschritt – die
     * Geräteidentität bleibt über TOTP/Recovery/TOTP-Einrichtung erhalten.
     * Nie Klartext, nie vom Client im Body wählbar.
     */
    deviceTokenHash: text('device_token_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('staff_login_challenges_user_idx').on(table.userId)],
);

/**
 * Phase-12-Finalisierung: bekannte Geräte je Mitarbeiter. Geräteidentität ist
 * ein serverseitig erzeugter Zufallswert im HttpOnly-Cookie `mr_staff_device`
 * (≥ 32 Byte); gespeichert wird ausschließlich dessen SHA-256. Der User-Agent
 * (`displayLabel`) dient nur der Anzeige und entscheidet nie über „neues Gerät“.
 * UNIQUE(user_id, device_token_hash) macht den Erst-Login atomar: genau ein
 * `session.new_device_login` je Gerät und Mitarbeiter.
 */
export const staffKnownDevices = pgTable(
  'staff_known_devices',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id),
    deviceTokenHash: text('device_token_hash').notNull(),
    displayLabel: text('display_label').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('staff_known_devices_user_device_idx').on(table.userId, table.deviceTokenHash),
  ],
);

export const staffPasswordResetTokens = pgTable(
  'staff_password_reset_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('staff_password_reset_tokens_user_idx').on(table.userId)],
);

export const staffRecoveryCodes = pgTable(
  'staff_recovery_codes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id),
    codeHash: text('code_hash').notNull().unique(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('staff_recovery_codes_user_idx').on(table.userId)],
);

/** Frei benennbare Rollen-Vorlagen (keine fest programmierten Klassen). */
export const staffRoles = pgTable('staff_roles', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text('name').notNull().unique(),
  /**
   * Stabile Systemadmin-Eigenschaft (Phase-2-Finalisierung): Mitglieder
   * einer Systemrolle erhalten dynamisch ALLE Katalogrechte – auch künftig
   * neu eingeführte. Niemals über den frei änderbaren Anzeigenamen prüfen.
   */
  isSystemAdmin: boolean('is_system_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const staffRolePermissions = pgTable(
  'staff_role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => staffRoles.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key').notNull(),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionKey] })],
);

export const staffUserRoles = pgTable(
  'staff_user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id),
    roleId: uuid('role_id')
      .notNull()
      .references(() => staffRoles.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] })],
);

/**
 * Individuelle Allow-/Deny-Overrides, optional zeitlich befristet
 * (befristete Sonderrechte = Allow mit valid_from/valid_until).
 * Gültigkeit wird bei jeder Rechteberechnung gegen die aktuelle Zeit
 * geprüft – kein Background-Job nötig.
 */
export const staffUserPermissionOverrides = pgTable(
  'staff_user_permission_overrides',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => staffUsers.id),
    permissionKey: text('permission_key').notNull(),
    effect: permissionOverrideEffect('effect').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => staffUsers.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('staff_user_permission_overrides_user_idx').on(table.userId)],
);

/** Adminpflegbarer Erklärtext je Funktion (überschreibt den Katalog-Default). */
export const staffPermissionExplanations = pgTable('staff_permission_explanations', {
  permissionKey: text('permission_key').primaryKey(),
  explanation: text('explanation').notNull(),
  updatedBy: uuid('updated_by').references(() => staffUsers.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Bewusst kleines Security-Audit: nur sicherheitsrelevante Ereignisse,
 * kein Klick-Tracking, keine Navigationsüberwachung. `details` enthält
 * niemals Passwörter, Tokens oder Secrets.
 */
export const staffSecurityEvents = pgTable(
  'staff_security_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    type: text('type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => staffUsers.id),
    targetUserId: uuid('target_user_id').references(() => staffUsers.id),
    sessionId: uuid('session_id'),
    details: jsonb('details')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('staff_security_events_target_idx').on(table.targetUserId, table.createdAt),
    index('staff_security_events_created_idx').on(table.createdAt),
  ],
);

export type StaffUser = typeof staffUsers.$inferSelect;
export type NewStaffUser = typeof staffUsers.$inferInsert;
export type StaffSession = typeof staffSessions.$inferSelect;
export type StaffRole = typeof staffRoles.$inferSelect;
export type StaffUserPermissionOverride = typeof staffUserPermissionOverrides.$inferSelect;
export type StaffSecurityEvent = typeof staffSecurityEvents.$inferSelect;
