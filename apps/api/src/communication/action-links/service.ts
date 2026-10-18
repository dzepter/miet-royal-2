/**
 * Kunden-Aktionslinks (Phase 12, Order §20): Single-Purpose-Links
 * „Abholperson ändern“ (pickup_contact_update) bzw. „Kontakt vor Ort ändern“
 * (delivery_contact_update) – kein Portal, kein Login.
 *
 * Sicherheitsregeln:
 * - Token = 32 zufällige Bytes (base64url); in `customer_action_tokens` liegt
 *   NUR der SHA-256-Hash. Der Klartext existiert nur in der Ausgabe von
 *   `issue()` und – verschlüsselt – in der Secret-Payload der Erinnerungsmail.
 * - Der Lookup bindet den Zweck mit ein: ein Pickup-Token wirkt nie auf den
 *   Lieferkontakt (und umgekehrt).
 * - Gültig bis EXAKT 1 h vor Terminbeginn (`expires_at` bei Ausgabe; zusätzlich
 *   serverseitiger Cutoff gegen den AKTUELLEN Terminbeginn – ein vorgezogener
 *   Termin verkürzt die Frist sofort, ein verschobener verlängert sie nicht).
 * - Unbekannt / abgelaufen / widerrufen / falscher Zweck / Termin storniert /
 *   Vorgang storniert ⇒ immer dasselbe neutrale Ergebnis (`null` ⇒ 404).
 * - Je Termin und Zweck genau EIN aktiver Token: eine erneute Ausgabe
 *   widerruft ältere Tokens.
 * - Kontakt: ein aktueller Stand je Buchung und Art (UNIQUE booking+kind);
 *   eine Änderung überschreibt vollständig – es gibt keine Historie und keine
 *   Kopie der alten Telefonnummer an anderer Stelle (Pflichttest 65).
 * - Telefon ist Pflicht (Abholperson/Kontakt vor Ort muss erreichbar sein);
 *   normalisiert über crm/normalize.ts, 6–20 Ziffern.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  appointments,
  bookingCustomerContacts,
  bookings,
  customerActionTokens,
  processes,
  type Database,
  type DatabaseExecutor,
} from '@mietroyal/database';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { AuthError } from '../../auth/service.ts';
import { normalizePhoneNumber } from '../../crm/normalize.ts';

export type CustomerActionPurpose = 'pickup_contact_update' | 'delivery_contact_update';
export type BookingContactKind = 'pickup' | 'delivery';

/** Serverseitiger Cutoff: ab genau 1 h vor Terminbeginn ist der Link unbrauchbar (Order §20). */
export const ACTION_LINK_CUTOFF_MS = 60 * 60 * 1000;
export const ACTION_TOKEN_BYTES = 32;
const NAME_MIN = 1;
const NAME_MAX = 80;
const PHONE_DIGITS_MIN = 6;
const PHONE_DIGITS_MAX = 20;

export function contactKindForPurpose(purpose: CustomerActionPurpose): BookingContactKind {
  return purpose === 'pickup_contact_update' ? 'pickup' : 'delivery';
}

export function purposeForAppointmentKind(kind: 'pickup' | 'delivery'): CustomerActionPurpose {
  return kind === 'pickup' ? 'pickup_contact_update' : 'delivery_contact_update';
}

export function hashActionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Zeitpunkt, ab dem der Link für einen Termin mit `startAt` nicht mehr gilt. */
export function actionLinkExpiryFor(startAt: Date): Date {
  return new Date(startAt.getTime() - ACTION_LINK_CUTOFF_MS);
}

export interface CustomerContactView {
  firstName: string;
  lastName: string;
  phone: string;
}

/** Öffentliche Sicht (Datenminimierung): nur Zweck, Vorgangsnummer, Termin, aktueller Kontakt. */
export interface CustomerActionView {
  purpose: CustomerActionPurpose;
  processNumber: string;
  appointmentAt: string;
  appointmentEndAt: string | null;
  current: CustomerContactView | null;
}

export interface CustomerContactInput {
  firstName: string;
  lastName: string;
  phone: string;
}

export interface IssuedActionToken {
  tokenId: string;
  /** Klartext – nur für die (verschlüsselte) Mail-Payload; nie speichern/loggen. */
  token: string;
  expiresAt: Date;
}

interface ResolvedToken {
  tokenId: string;
  purpose: CustomerActionPurpose;
  bookingId: string;
  processNumber: string;
  appointmentStartAt: Date;
  appointmentEndAt: Date | null;
}

/** Steuerzeichen/Zeilenumbrüche in Namen sind nie zulässig (Header-/Log-Hygiene). */
function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Zeilenumbrüche/Steuerzeichen im Rohwert sind nie ein Name (Header-/Log-Hygiene).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) return null;
  return trimmed;
}

/** Telefon: Pflicht, normalisierte Ziffernform (+<Ziffern>), 6–20 Ziffern. */
export function normalizeContactPhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.trim().length > 60) return null;
  const digits = normalizePhoneNumber(value);
  if (digits === null) return null;
  if (digits.length < PHONE_DIGITS_MIN || digits.length > PHONE_DIGITS_MAX) return null;
  return `+${digits}`;
}

export function validateContactInput(body: unknown): CustomerContactInput {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const firstName = cleanName(record['firstName']);
  const lastName = cleanName(record['lastName']);
  const phone = normalizeContactPhone(record['phone']);
  const problems: string[] = [];
  if (firstName === null) problems.push('Vorname (1–80 Zeichen) ist erforderlich.');
  if (lastName === null) problems.push('Nachname (1–80 Zeichen) ist erforderlich.');
  if (phone === null) problems.push('Telefonnummer (6–20 Ziffern) ist erforderlich.');
  if (firstName === null || lastName === null || phone === null) {
    throw new AuthError('VALIDATION', problems.join(' '));
  }
  return { firstName, lastName, phone };
}

export class CustomerActionLinkService {
  constructor(
    private readonly db: Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Neuen Token ausgeben; ältere aktive Tokens desselben Termins/Zwecks
   * werden widerrufen (genau ein aktiver Link). Läuft optional in der
   * Transaktion des Aufrufers (Reminder-Scan).
   */
  async issue(
    input: {
      purpose: CustomerActionPurpose;
      processId: string;
      customerId: string;
      bookingId: string;
      appointmentId: string;
      expiresAt: Date;
    },
    executor: DatabaseExecutor = this.db,
  ): Promise<IssuedActionToken> {
    const now = this.now();
    await executor
      .update(customerActionTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(customerActionTokens.appointmentId, input.appointmentId),
          eq(customerActionTokens.purpose, input.purpose),
          isNull(customerActionTokens.revokedAt),
        ),
      );
    const token = randomBytes(ACTION_TOKEN_BYTES).toString('base64url');
    const inserted = await executor
      .insert(customerActionTokens)
      .values({
        purpose: input.purpose,
        tokenHash: hashActionToken(token),
        processId: input.processId,
        customerId: input.customerId,
        bookingId: input.bookingId,
        appointmentId: input.appointmentId,
        expiresAt: input.expiresAt,
        createdAt: now,
      })
      .returning({ id: customerActionTokens.id });
    const row = inserted[0];
    if (row === undefined) throw new Error('Aktions-Token konnte nicht angelegt werden.');
    return { tokenId: row.id, token, expiresAt: input.expiresAt };
  }

  /**
   * Hash-Lookup mit Zweck; alle Fehlerfälle liefern `null` (neutral). Prüft
   * Widerruf, Ablauf, Cutoff gegen den aktuellen Terminbeginn, Terminstatus
   * und Vorgangsstatus.
   */
  private async resolveInternal(
    token: string,
    purpose: CustomerActionPurpose | null,
  ): Promise<ResolvedToken | null> {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
    const now = this.now();
    const rows = await this.db
      .select({
        tokenId: customerActionTokens.id,
        purpose: customerActionTokens.purpose,
        bookingId: customerActionTokens.bookingId,
        appointmentId: customerActionTokens.appointmentId,
        expiresAt: customerActionTokens.expiresAt,
        revokedAt: customerActionTokens.revokedAt,
        appointmentStartAt: appointments.startAt,
        appointmentEndAt: appointments.endAt,
        appointmentStatus: appointments.status,
        processNumber: processes.processNumber,
        processStatus: processes.mainStatus,
      })
      .from(customerActionTokens)
      .innerJoin(appointments, eq(appointments.id, customerActionTokens.appointmentId))
      .innerJoin(processes, eq(processes.id, customerActionTokens.processId))
      .where(eq(customerActionTokens.tokenHash, hashActionToken(token)));
    const row = rows[0];
    if (row === undefined) return null;
    if (row.purpose === 'document_view') return null;
    if (purpose !== null && row.purpose !== purpose) return null;
    if (row.bookingId === null || row.appointmentId === null) return null;
    if (row.revokedAt !== null) return null;
    if (row.expiresAt.getTime() <= now.getTime()) return null;
    if (row.appointmentStatus !== 'scheduled' || row.appointmentStartAt === null) return null;
    // Cutoff gegen den AKTUELLEN Terminbeginn (Reschedule nach vorn verkürzt sofort).
    if (actionLinkExpiryFor(row.appointmentStartAt).getTime() <= now.getTime()) return null;
    if (row.processStatus === 'cancelled') return null;
    return {
      tokenId: row.tokenId,
      purpose: row.purpose,
      bookingId: row.bookingId,
      processNumber: row.processNumber,
      appointmentStartAt: row.appointmentStartAt,
      appointmentEndAt: row.appointmentEndAt,
    };
  }

  async currentContact(
    bookingId: string,
    kind: BookingContactKind,
  ): Promise<CustomerContactView | null> {
    const rows = await this.db
      .select({
        firstName: bookingCustomerContacts.firstName,
        lastName: bookingCustomerContacts.lastName,
        phone: bookingCustomerContacts.phone,
      })
      .from(bookingCustomerContacts)
      .where(
        and(
          eq(bookingCustomerContacts.bookingId, bookingId),
          eq(bookingCustomerContacts.kind, kind),
        ),
      );
    return rows[0] ?? null;
  }

  /** Öffentliche Sicht; `purpose` optional (die Route kennt den Zweck nicht vorab). */
  async resolve(
    token: string,
    purpose: CustomerActionPurpose | null = null,
  ): Promise<CustomerActionView | null> {
    const resolved = await this.resolveInternal(token, purpose);
    if (resolved === null) return null;
    const current = await this.currentContact(
      resolved.bookingId,
      contactKindForPurpose(resolved.purpose),
    );
    return {
      purpose: resolved.purpose,
      processNumber: resolved.processNumber,
      appointmentAt: resolved.appointmentStartAt.toISOString(),
      appointmentEndAt: resolved.appointmentEndAt?.toISOString() ?? null,
      current,
    };
  }

  /**
   * Kontakt setzen/überschreiben. Rückgabe `null` ⇒ Link unbrauchbar (404);
   * Validierungsfehler werfen AuthError VALIDATION (nur nach erfolgreicher
   * Token-Auflösung – ein ungültiger Link bleibt neutral).
   */
  async submit(
    token: string,
    body: unknown,
    purpose: CustomerActionPurpose | null = null,
  ): Promise<CustomerActionView | null> {
    const resolved = await this.resolveInternal(token, purpose);
    if (resolved === null) return null;
    const input = validateContactInput(body);
    const kind = contactKindForPurpose(resolved.purpose);
    const now = this.now();
    await this.db.transaction(async (tx) => {
      await tx
        .insert(bookingCustomerContacts)
        .values({
          bookingId: resolved.bookingId,
          kind,
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          updatedViaTokenId: resolved.tokenId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [bookingCustomerContacts.bookingId, bookingCustomerContacts.kind],
          set: {
            firstName: input.firstName,
            lastName: input.lastName,
            phone: input.phone,
            updatedViaTokenId: resolved.tokenId,
            updatedAt: now,
          },
        });
      await tx
        .update(customerActionTokens)
        .set({ lastUsedAt: now, useCount: sql`${customerActionTokens.useCount} + 1` })
        .where(eq(customerActionTokens.id, resolved.tokenId));
    });
    return {
      purpose: resolved.purpose,
      processNumber: resolved.processNumber,
      appointmentAt: resolved.appointmentStartAt.toISOString(),
      appointmentEndAt: resolved.appointmentEndAt?.toISOString() ?? null,
      current: { firstName: input.firstName, lastName: input.lastName, phone: input.phone },
    };
  }

  /** Staff-Sicht: aktuelle Kontakte eines Vorgangs (Buchung über den Vorgang). */
  async contactsForProcess(processId: string): Promise<
    {
      kind: BookingContactKind;
      firstName: string;
      lastName: string;
      phone: string;
      updatedAt: string;
    }[]
  > {
    const rows = await this.db
      .select({
        kind: bookingCustomerContacts.kind,
        firstName: bookingCustomerContacts.firstName,
        lastName: bookingCustomerContacts.lastName,
        phone: bookingCustomerContacts.phone,
        updatedAt: bookingCustomerContacts.updatedAt,
      })
      .from(bookingCustomerContacts)
      .innerJoin(bookings, eq(bookings.id, bookingCustomerContacts.bookingId))
      .where(eq(bookings.processId, processId));
    return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
  }
}
