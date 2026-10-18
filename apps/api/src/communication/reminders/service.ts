/**
 * Kunden-Erinnerungen (Phase 12, Order §§17–19): 7-Tage- und 1-Tag-Mail vor
 * dem ERSTEN kundenrelevanten Übergabetermin einer Buchung (Pickup oder
 * Delivery; geplante Zeit = startAt bzw. Fensterbeginn).
 *
 * Zeitlogik: dueAt = startAt − 7 bzw. − 1 KALENDERTAG(E) in Europe/Berlin bei
 * gleicher Wanduhrzeit (`addBerlinCalendarDays`; kein 7 × 24 h-DST-Fehler).
 * Fällig, wenn dueAt ≤ now UND now < startAt UND Termin geplant (scheduled)
 * UND Vorgang offen (nicht storniert/abgeschlossen).
 *
 * KEIN Nachholen: Entstand die Buchung erst nach dueAt (booking.createdAt >
 * dueAt) oder liegt dueAt mehr als REMINDER_TOLERANCE_MS (6 h) zurück, wird
 * keine Mail gesendet. In beiden Fällen wird die `appointment_reminders`-
 * Zeile trotzdem angelegt (mailDeliveryId NULL, sentAt NULL = „übersprungen“),
 * damit jeder weitere Scan sofort idempotent ist.
 *
 * Fingerprint = sha256(appointmentId|kind|startAt-ISO). UNIQUE (appointment,
 * kind, fingerprint): ein Reschedule erzeugt einen neuen Fingerprint – die
 * alte Zeile bleibt (no-op, gesendete Mails werden nie wiederholt); der neue
 * Termin bekommt seine Mail, sofern sein dueAt noch offen ist.
 *
 * Idempotenz gegen parallele Scanner: Die Reminder-Zeile wird ZUERST in einer
 * Transaktion mit ON CONFLICT DO NOTHING angelegt; nur wer die Zeile bekommt,
 * reiht die Mail (Outbox-Key `reminder:<kind>:<fingerprint>`) ein. Der
 * `mail.send`-Job wird nach Commit geplant.
 *
 * Inhalt (Kontext ohne Geheimnisse): Vorgangsnummer, Eventdatum, Terminart,
 * Termin (+ Fensterende), Adresse (pickup: Betriebsadresse aus der Einstellung
 * `pickup_exact_address` – die der Kunde bereits mit der AB erhalten hat;
 * delivery: Lieferadresse aus dem Buchungs-Snapshot), Rückgabetermin soweit
 * geplant. Die 1-Tag-Mail trägt zusätzlich den Aktionslink (Token nur in der
 * verschlüsselten Secret-Payload).
 */
import { createHash } from 'node:crypto';
import {
  appointmentReminders,
  appointments,
  bookings,
  processes,
  type Appointment,
  type Database,
  type MailDeliveryRow,
} from '@mietroyal/database';
import { addBerlinCalendarDays } from '@mietroyal/domain';
import type { JobRunnerLogger } from '@mietroyal/integrations';
import { and, eq, gt, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { AuthError } from '../../auth/service.ts';
import { getPickupExactAddress } from '../../crm/settings-service.ts';
import {
  actionLinkExpiryFor,
  purposeForAppointmentKind,
  type CustomerActionLinkService,
} from '../action-links/service.ts';
import type { MailOutboxService } from '../mail/outbox.ts';
import type { MailPreSendGuard, MailSentListener } from '../mail/send-job.ts';
import type { ReminderMailContext } from '../mail/templates/contexts.ts';
import type { MailDeliveryStatus } from '../types.ts';

export type ReminderKind = 'reminder_7_days' | 'reminder_1_day';

/** Fälligkeit, die länger zurückliegt, wird nicht nachgeholt (Order §17). */
export const REMINDER_TOLERANCE_MS = 6 * 60 * 60 * 1000;

export const REMINDER_OFFSET_DAYS: Record<ReminderKind, number> = {
  reminder_7_days: -7,
  reminder_1_day: -1,
};

export function reminderFingerprint(
  appointmentId: string,
  kind: ReminderKind,
  startAt: Date,
): string {
  return createHash('sha256')
    .update(`${appointmentId}|${kind}|${startAt.toISOString()}`)
    .digest('hex');
}

export function reminderDueAt(kind: ReminderKind, startAt: Date): Date {
  return addBerlinCalendarDays(startAt, REMINDER_OFFSET_DAYS[kind]);
}

export function reminderIdempotencyKey(kind: ReminderKind, fingerprint: string): string {
  return `reminder:${kind}:${fingerprint}`;
}

/**
 * Härtung B7/RA-5: Blockiercode einer Erinnerung/Terminänderungsmail, deren
 * Termin sich seit dem Einreihen geändert hat (verschoben, storniert,
 * Vorgang storniert/abgeschlossen) – sie wird nie mehr versendet.
 */
export const MAIL_BLOCKED_STALE_APPOINTMENT = 'STALE_APPOINTMENT';

/** `reminder:<kind>:<fingerprint>` (+ optional `:resend:<id>` eines manuellen Resends). */
const REMINDER_KEY_PATTERN = /^reminder:(reminder_7_days|reminder_1_day):([0-9a-f]{64})(?::|$)/;
const REMINDER_SENDABLE_PROCESS_STATUSES: readonly string[] = ['open', 'reopened'];

export interface ReminderScanSummary {
  enqueued: number;
  skipped: number;
}

export interface ReminderServiceDeps {
  db: Database;
  outbox: MailOutboxService;
  actionLinks: CustomerActionLinkService;
  logger?: JobRunnerLogger | undefined;
}

function snapshotString(snapshot: unknown, key: string): string | null {
  if (typeof snapshot !== 'object' || snapshot === null) return null;
  const value = (snapshot as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Anrede aus dem eingefrorenen Kunden-Snapshot (nie aus dem Live-Kunden). */
export function salutationFor(customerSnapshot: unknown): string {
  const name = snapshotString(customerSnapshot, 'displayName');
  return name === null ? 'Hallo,' : `Hallo ${name},`;
}

export function deliveryAddressFor(deliverySnapshot: unknown): string | null {
  const street = snapshotString(deliverySnapshot, 'street');
  const postalCode = snapshotString(deliverySnapshot, 'postalCode');
  const city = snapshotString(deliverySnapshot, 'city');
  const line2 = [postalCode, city].filter((v) => v !== null).join(' ');
  const lines = [street, line2 === '' ? null : line2].filter((v) => v !== null);
  return lines.length === 0 ? null : lines.join('\n');
}

export class ReminderService {
  constructor(private readonly deps: ReminderServiceDeps) {}

  /** Idempotenter Scan – darf beliebig oft laufen (Order §32). */
  async scanDue(now = new Date()): Promise<ReminderScanSummary> {
    const { db } = this.deps;
    const summary: ReminderScanSummary = { enqueued: 0, skipped: 0 };
    // Kandidaten: geplante Pickup-/Delivery-Termine in der Zukunft mit offenem Vorgang.
    const candidates = await db
      .select({
        appointment: appointments,
        bookingCreatedAt: bookings.createdAt,
        processStatus: processes.mainStatus,
      })
      .from(appointments)
      .innerJoin(bookings, eq(bookings.id, appointments.bookingId))
      .innerJoin(processes, eq(processes.id, appointments.processId))
      .where(
        and(
          inArray(appointments.kind, ['pickup', 'delivery']),
          eq(appointments.status, 'scheduled'),
          isNotNull(appointments.startAt),
          gt(appointments.startAt, now),
          inArray(processes.mainStatus, ['open', 'reopened']),
        ),
      );

    for (const candidate of candidates) {
      const appointment = candidate.appointment;
      const startAt = appointment.startAt;
      if (startAt === null) continue;
      for (const kind of ['reminder_7_days', 'reminder_1_day'] as const) {
        const dueAt = reminderDueAt(kind, startAt);
        if (dueAt.getTime() > now.getTime()) continue;
        const fingerprint = reminderFingerprint(appointment.id, kind, startAt);
        const skipReason =
          candidate.bookingCreatedAt.getTime() > dueAt.getTime()
            ? 'BOOKING_AFTER_DUE'
            : now.getTime() - dueAt.getTime() > REMINDER_TOLERANCE_MS
              ? 'DUE_TOO_OLD'
              : null;
        try {
          const outcome = await this.processOne(
            appointment,
            kind,
            fingerprint,
            dueAt,
            skipReason,
            now,
          );
          if (outcome === 'enqueued') summary.enqueued += 1;
          if (outcome === 'skipped') summary.skipped += 1;
        } catch (error) {
          this.deps.logger?.error(
            {
              reminder: {
                appointmentId: appointment.id,
                kind,
                errorCode: error instanceof Error ? error.name : 'Error',
              },
            },
            'reminder.scan: Termin übersprungen',
          );
        }
      }
    }
    return summary;
  }

  private async processOne(
    appointment: Appointment,
    kind: ReminderKind,
    fingerprint: string,
    dueAt: Date,
    skipReason: string | null,
    now: Date,
  ): Promise<'enqueued' | 'skipped' | 'noop'> {
    const { db, outbox, actionLinks } = this.deps;
    const result = await db.transaction(async (tx) => {
      const claimed = await tx
        .insert(appointmentReminders)
        .values({
          appointmentId: appointment.id,
          kind,
          fingerprint,
          dueAt,
          createdAt: now,
        })
        .onConflictDoNothing({
          target: [
            appointmentReminders.appointmentId,
            appointmentReminders.kind,
            appointmentReminders.fingerprint,
          ],
        })
        .returning({ id: appointmentReminders.id });
      const reminderRow = claimed[0];
      if (reminderRow === undefined) return { outcome: 'noop' as const, deliveryId: null };
      if (skipReason !== null) {
        this.deps.logger?.info(
          { reminder: { appointmentId: appointment.id, kind, status: 'skipped', skipReason } },
          'reminder.scan: nicht nachgeholt',
        );
        return { outcome: 'skipped' as const, deliveryId: null };
      }

      const bookingRows = await tx
        .select({
          booking: bookings,
          processNumber: processes.processNumber,
          processEventDate: processes.eventDate,
        })
        .from(bookings)
        .innerJoin(processes, eq(processes.id, bookings.processId))
        .where(eq(bookings.id, appointment.bookingId));
      const found = bookingRows[0];
      if (found === undefined) return { outcome: 'skipped' as const, deliveryId: null };
      const { booking, processNumber } = found;
      const startAt = appointment.startAt!;
      const appointmentKind = appointment.kind as 'pickup' | 'delivery';

      // Rückgabetermin derselben Buchung, soweit geplant.
      const returnRows = await tx
        .select({ startAt: appointments.startAt })
        .from(appointments)
        .where(
          and(
            eq(appointments.bookingId, booking.id),
            eq(appointments.kind, 'return'),
            eq(appointments.status, 'scheduled'),
            isNotNull(appointments.startAt),
          ),
        );
      const returnAt = returnRows[0]?.startAt ?? null;

      const address =
        appointmentKind === 'pickup'
          ? await getPickupExactAddress(tx)
          : deliveryAddressFor(booking.deliverySnapshot);
      const eventDate =
        snapshotString(booking.eventSnapshot, 'eventDate') ?? found.processEventDate ?? null;

      const context: ReminderMailContext = {
        salutation: salutationFor(booking.customerSnapshot),
        processNumber,
        eventDate: eventDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(eventDate) ? eventDate : null,
        appointmentKind,
        appointmentAt: startAt.toISOString(),
        windowEnd: appointment.endAt?.toISOString() ?? null,
        address: address === null || address.trim() === '' ? null : address.slice(0, 500),
        returnAt: returnAt?.toISOString() ?? null,
      };

      // 1-Tag-Mail: Aktionslink (Token nur in der verschlüsselten Payload).
      let secrets: Record<string, string> | undefined;
      if (kind === 'reminder_1_day') {
        const expiresAt = actionLinkExpiryFor(startAt);
        if (expiresAt.getTime() > now.getTime()) {
          const issued = await actionLinks.issue(
            {
              purpose: purposeForAppointmentKind(appointmentKind),
              processId: appointment.processId,
              customerId: booking.customerId,
              bookingId: booking.id,
              appointmentId: appointment.id,
              expiresAt,
            },
            tx,
          );
          secrets = { actionToken: issued.token };
        }
      }

      const email = snapshotString(booking.customerSnapshot, 'email') ?? '';
      const enqueued = await outbox.enqueue(
        {
          kind,
          processId: appointment.processId,
          customerId: booking.customerId,
          bookingId: booking.id,
          recipient: { email, name: snapshotString(booking.customerSnapshot, 'displayName') },
          context: context as unknown as Record<string, unknown>,
          ...(secrets === undefined ? {} : { secrets }),
          idempotencyKey: reminderIdempotencyKey(kind, fingerprint),
        },
        tx,
      );
      await tx
        .update(appointmentReminders)
        .set({ mailDeliveryId: enqueued.deliveryId })
        .where(eq(appointmentReminders.id, reminderRow.id));
      return {
        outcome: 'enqueued' as const,
        deliveryId: enqueued.status === 'pending' ? enqueued.deliveryId : null,
      };
    });
    if (result.deliveryId !== null) await outbox.scheduleSend(result.deliveryId);
    return result.outcome;
  }

  /**
   * Pre-Send-Guard (Härtung B7/RA-5): Unmittelbar vor dem Versand (auch beim
   * Retry nach transientem SMTP-Fehler) gelten dieselben Bedingungen wie beim
   * Scan: Termin geplant, Vorgang offen/wieder geöffnet, Termin noch nicht
   * begonnen UND der Fingerprint der Reminder-Zeile passt zum AKTUELLEN
   * startAt (sonst wurde verschoben – die neue Zeit bekommt ggf. ihre eigene
   * Erinnerung). Andernfalls ⇒ blocked STALE_APPOINTMENT. Ohne zuordenbare
   * Reminder-Zeile ist die Erinnerung nicht prüfbar ⇒ ebenfalls blockiert.
   */
  preSendGuard(): MailPreSendGuard {
    return {
      check: async (delivery, { now }) => {
        if (delivery.kind !== 'reminder_7_days' && delivery.kind !== 'reminder_1_day') return null;
        const match = REMINDER_KEY_PATTERN.exec(delivery.idempotencyKey);
        if (match === null || match[1] !== delivery.kind) return MAIL_BLOCKED_STALE_APPOINTMENT;
        const kind = delivery.kind;
        const rows = await this.deps.db
          .select({
            fingerprint: appointmentReminders.fingerprint,
            appointment: appointments,
            processStatus: processes.mainStatus,
          })
          .from(appointmentReminders)
          .innerJoin(appointments, eq(appointments.id, appointmentReminders.appointmentId))
          .innerJoin(processes, eq(processes.id, appointments.processId))
          .where(
            and(
              eq(appointmentReminders.kind, kind),
              eq(appointmentReminders.fingerprint, match[2]!),
            ),
          );
        const row = rows[0];
        if (row === undefined) return MAIL_BLOCKED_STALE_APPOINTMENT;
        const { appointment } = row;
        const startAt = appointment.startAt;
        if (
          appointment.status !== 'scheduled' ||
          startAt === null ||
          startAt.getTime() <= now.getTime() ||
          !REMINDER_SENDABLE_PROCESS_STATUSES.includes(row.processStatus) ||
          reminderFingerprint(appointment.id, kind, startAt) !== row.fingerprint
        ) {
          return MAIL_BLOCKED_STALE_APPOINTMENT;
        }
        return null;
      },
    };
  }

  /** Nach bestätigtem Versand: `sentAt` an der Reminder-Zeile setzen (idempotent). */
  sentListener(): MailSentListener {
    return {
      mailSent: async (delivery: MailDeliveryRow) => {
        if (delivery.kind !== 'reminder_7_days' && delivery.kind !== 'reminder_1_day') return;
        await this.deps.db
          .update(appointmentReminders)
          .set({ sentAt: delivery.sentAt ?? new Date() })
          .where(
            and(
              eq(appointmentReminders.mailDeliveryId, delivery.id),
              isNull(appointmentReminders.sentAt),
            ),
          );
      },
    };
  }
}

// ── Terminänderung (Order §19) ───────────────────────────────────────────

export function appointmentChangedIdempotencyKey(appointmentId: string, version: number): string {
  return `appointment_changed:${appointmentId}:${version}`;
}

/** Schlüssel inkl. Suffix eines Retrys (`:retry:<id>`) oder manuellen Resends (`:resend:<id>`). */
const APPOINTMENT_CHANGED_KEY_PREFIX = /^appointment_changed:([0-9a-f-]{36}):(\d+)(?::|$)/;

export interface InformCustomerResult {
  deliveryId: string;
  status: 'pending' | 'blocked';
  deduplicated: boolean;
  /** Status der bereits bestehenden Zustellung bei Dedupe (null = neu angelegt). */
  existingStatus: MailDeliveryStatus | null;
}

/**
 * Bewusste Staff-Aktion „Kunden über Terminänderung informieren“: nur wenn
 * `customerInfoRequiredAt` gesetzt ist. Der VORHERIGE Termin ist der dem
 * Kunden zuletzt mitgeteilte (`customerKnownStartAt`, serverseitig bei der
 * Verschiebung festgehalten); Client-Daten werden NIE als „vorheriger Termin“
 * übernommen. Fehlt er (Altbestand vor Phase 12), nennt die Mail nur den
 * neuen Termin. Key `appointment_changed:<id>:<version>`:
 * Doppelklick ⇒ dieselbe Zustellung; eine erneute Verschiebung (neue Version)
 * ⇒ neue Mail möglich.
 */
export class AppointmentCustomerInfoService {
  constructor(
    private readonly db: Database,
    private readonly outbox: MailOutboxService,
  ) {}

  async informCustomer(actorId: string, appointmentId: string): Promise<InformCustomerResult> {
    const rows = await this.db
      .select({
        appointment: appointments,
        booking: bookings,
        processNumber: processes.processNumber,
        processStatus: processes.mainStatus,
      })
      .from(appointments)
      .innerJoin(bookings, eq(bookings.id, appointments.bookingId))
      .innerJoin(processes, eq(processes.id, appointments.processId))
      .where(eq(appointments.id, appointmentId));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Termin nicht gefunden.');
    const { appointment, booking } = row;
    if (appointment.customerInfoRequiredAt === null) {
      throw new AuthError('CONFLICT', 'Für diesen Termin ist keine Kundeninformation offen.');
    }
    if (appointment.status !== 'scheduled' || row.processStatus === 'cancelled') {
      throw new AuthError(
        'CONFLICT',
        'Der Termin ist storniert oder abgeschlossen – keine Terminänderungsmail möglich.',
      );
    }
    // Nach failed/blocked entsteht eine neue Zustellung (`…:retry:<vorherige>`);
    // eine laufende, gesendete oder unklare Zustellung wird nicht dupliziert.
    const result = await this.outbox.enqueueRetryingFailed({
      kind: 'appointment_changed',
      processId: appointment.processId,
      customerId: booking.customerId,
      bookingId: booking.id,
      recipient: {
        email: snapshotString(booking.customerSnapshot, 'email') ?? '',
        name: snapshotString(booking.customerSnapshot, 'displayName'),
      },
      context: {
        salutation: salutationFor(booking.customerSnapshot),
        processNumber: row.processNumber,
        appointmentKind: appointment.kind,
        oldAt: appointment.customerKnownStartAt?.toISOString() ?? null,
        newAt: appointment.startAt?.toISOString() ?? null,
      },
      idempotencyKey: appointmentChangedIdempotencyKey(appointment.id, appointment.version),
      createdBy: actorId,
    });
    if (result.status === 'pending' && result.existingStatus === null) {
      await this.outbox.scheduleSend(result.deliveryId);
    }
    return {
      deliveryId: result.deliveryId,
      status: result.status,
      deduplicated: result.deduplicated,
      existingStatus: result.existingStatus,
    };
  }

  /**
   * Pre-Send-Guard (Härtung B7): dieselbe Bedingung wie beim Auslösen
   * (`informCustomer`) – Termin noch geplant und Vorgang nicht storniert,
   * sonst blocked STALE_APPOINTMENT. Eine erneute Verschiebung blockiert
   * NICHT (der Sent-Listener behandelt abweichende Versionen ausdrücklich).
   */
  preSendGuard(): MailPreSendGuard {
    return {
      check: async (delivery) => {
        if (delivery.kind !== 'appointment_changed') return null;
        const match = APPOINTMENT_CHANGED_KEY_PREFIX.exec(delivery.idempotencyKey);
        if (match === null) return MAIL_BLOCKED_STALE_APPOINTMENT;
        const rows = await this.db
          .select({ status: appointments.status, processStatus: processes.mainStatus })
          .from(appointments)
          .innerJoin(processes, eq(processes.id, appointments.processId))
          .where(eq(appointments.id, match[1]!));
        const row = rows[0];
        if (row === undefined || row.status !== 'scheduled' || row.processStatus === 'cancelled') {
          return MAIL_BLOCKED_STALE_APPOINTMENT;
        }
        return null;
      },
    };
  }

  /** Nach bestätigtem Versand: Kunde informiert, offene Kundeninformation abräumen (idempotent). */
  sentListener(): MailSentListener {
    return {
      mailSent: async (delivery: MailDeliveryRow) => {
        if (delivery.kind !== 'appointment_changed') return;
        const match = APPOINTMENT_CHANGED_KEY_PREFIX.exec(delivery.idempotencyKey);
        if (match === null) return;
        const appointmentId = match[1]!;
        const version = Number(match[2]);
        const informedAt = delivery.sentAt ?? new Date();
        // „Kunde informiert“ immer vermerken; die offene Kundeninformation nur
        // abräumen, wenn der Termin seit der Mail nicht erneut geändert wurde
        // (gleiche Version) – sonst bleibt sie für die neue Änderung offen.
        // Der Kunde kennt jetzt die in der Mail genannte Zeit (context.newAt).
        const mailedNewAtRaw = (delivery.context as Record<string, unknown> | null)?.['newAt'];
        const mailedNewAt = typeof mailedNewAtRaw === 'string' ? new Date(mailedNewAtRaw) : null;
        await this.db
          .update(appointments)
          .set({
            customerInformedAt: informedAt,
            customerKnownStartAt: mailedNewAt,
            customerKnownEndAt: null,
          })
          .where(and(eq(appointments.id, appointmentId), ne(appointments.version, version)));
        await this.db
          .update(appointments)
          .set({
            customerInformedAt: informedAt,
            customerKnownStartAt: null,
            customerKnownEndAt: null,
          })
          .where(and(eq(appointments.id, appointmentId), eq(appointments.version, version)));
        await this.db
          .update(appointments)
          .set({ customerInfoRequiredAt: null })
          .where(
            and(
              eq(appointments.id, appointmentId),
              eq(appointments.version, version),
              isNotNull(appointments.customerInfoRequiredAt),
            ),
          );
      },
    };
  }
}
