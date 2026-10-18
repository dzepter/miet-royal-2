import { createHash, randomBytes } from 'node:crypto';
import {
  appointments,
  calendarFeedTokens,
  processes,
  staffUsers,
  type Database,
} from '@mietroyal/database';
import { and, eq, gte, isNotNull, lte, ne } from 'drizzle-orm';
import { getStaffAppBaseUrl } from '../../crm/settings-service.ts';
import { effectiveAssigneeForAppointment, loadSubstitutions } from '../../scheduling/assignee.ts';
import type { PermissionResolver } from '../push/recipients.ts';
import { buildIcsCalendar, type IcsAppointmentKind, type IcsEventInput } from './ics.ts';

/**
 * Privater read-only ICS-Feed je Mitarbeiter (Order §33/§34).
 * - Token: 32 zufällige Bytes (base64url, 43 Zeichen); gespeichert wird NUR
 *   der SHA-256-Hash. Klartext existiert einmalig in der Antwort der
 *   Erzeugung. Regenerate ersetzt den Hash ⇒ alter Link sofort ungültig.
 * - Inhalt: nur geplante Pickup/Delivery/Return-Termine, bei denen der
 *   Nutzer EFFEKTIV zuständig ist (inkl. Vertretung), −30 … +180 Tage.
 * - Keine Kundennamen/Telefon/Adressen/Preise/Schäden/Notizen – nur
 *   Terminart, Vorgangsnummer und Staff-App-Link.
 */

export const CALENDAR_FEED_TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const FEED_PAST_DAYS = 30;
export const FEED_FUTURE_DAYS = 180;
const DAY_MS = 86_400_000;
/** Same-Origin-Proxy der Staff-App zur API (apps/staff/next.config.ts: `/api/:path*`). */
export const CALENDAR_FEED_STAFF_PROXY_PREFIX = '/api';
/** Recht, ohne das der Feed nicht (mehr) ausgeliefert wird (Order §33; Härtung B12). */
export const CALENDAR_FEED_PERMISSION = 'calendar.view' as const;

export function hashCalendarFeedToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isWellFormedFeedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export interface CalendarFeedStatus {
  configured: boolean;
  createdAt: string | null;
  regeneratedAt: string | null;
  lastAccessAt: string | null;
}

export class CalendarFeedService {
  /**
   * `permissions`: effektive Rechte frisch aus der DB (StaffAuthService) –
   * ein Rechteentzug wirkt sofort auch auf bereits verteilte Feed-Links.
   */
  constructor(
    private readonly db: Database,
    private readonly permissions: PermissionResolver,
  ) {}

  /** Erzeugt/ersetzt den Feed-Token eines Users; liefert den Klartext genau einmal. */
  async issueToken(
    userId: string,
    now = new Date(),
  ): Promise<{ token: string; regenerated: boolean }> {
    const token = randomBytes(CALENDAR_FEED_TOKEN_BYTES).toString('base64url');
    const tokenHash = hashCalendarFeedToken(token);
    const existing = await this.db
      .select({ id: calendarFeedTokens.id })
      .from(calendarFeedTokens)
      .where(eq(calendarFeedTokens.userId, userId));
    const regenerated = existing.length > 0;
    await this.db
      .insert(calendarFeedTokens)
      .values({ userId, tokenHash })
      .onConflictDoUpdate({
        target: calendarFeedTokens.userId,
        set: { tokenHash, regeneratedAt: now, lastAccessAt: null },
      });
    return { token, regenerated };
  }

  async status(userId: string): Promise<CalendarFeedStatus> {
    const rows = await this.db
      .select()
      .from(calendarFeedTokens)
      .where(eq(calendarFeedTokens.userId, userId));
    const row = rows[0];
    if (row === undefined) {
      return { configured: false, createdAt: null, regeneratedAt: null, lastAccessAt: null };
    }
    return {
      configured: true,
      createdAt: row.createdAt.toISOString(),
      regeneratedAt: row.regeneratedAt?.toISOString() ?? null,
      lastAccessAt: row.lastAccessAt?.toISOString() ?? null,
    };
  }

  /**
   * Öffentlicher Feed-Pfad (relativ zur Staff-App) – die Route hängt ihn an
   * die Staff-Basis-URL. Phase 12 Härtung (B16): Die Staff-App leitet NUR
   * `/api/*` an die API weiter und streift dabei `/api` ab
   * (apps/staff/next.config.ts) – der Link muss daher `/api/public/calendar/…`
   * lauten; die API-Route selbst bleibt `/public/calendar/:file`.
   */
  static feedPath(token: string): string {
    return `${CALENDAR_FEED_STAFF_PROXY_PREFIX}/public/calendar/${token}.ics`;
  }

  /**
   * Token auflösen: unbekannt/ungültig/inaktiver Nutzer/ohne effektives Recht
   * `calendar.view` ⇒ null (neutral). Aktualisiert lastAccessAt – ohne den
   * Token zu loggen.
   */
  async resolveToken(
    token: string,
    now = new Date(),
  ): Promise<{ userId: string; displayName: string } | null> {
    if (!isWellFormedFeedToken(token)) return null;
    const tokenHash = hashCalendarFeedToken(token);
    const rows = await this.db
      .select({
        id: calendarFeedTokens.id,
        userId: calendarFeedTokens.userId,
        status: staffUsers.status,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
      })
      .from(calendarFeedTokens)
      .innerJoin(staffUsers, eq(staffUsers.id, calendarFeedTokens.userId))
      .where(eq(calendarFeedTokens.tokenHash, tokenHash));
    const row = rows[0];
    if (row === undefined || row.status !== 'active') return null;
    // Phase 12 Härtung (B12): Rechteentzug ⇒ Feed sofort neutral 404.
    const effective = await this.permissions.effectivePermissions(row.userId);
    if (!effective.has(CALENDAR_FEED_PERMISSION)) return null;
    await this.db
      .update(calendarFeedTokens)
      .set({ lastAccessAt: now })
      .where(eq(calendarFeedTokens.id, row.id));
    return { userId: row.userId, displayName: `${row.firstName} ${row.lastName}` };
  }

  /** Effektive operative Termine des Users im Feed-Zeitraum. */
  async eventsForUser(userId: string, now = new Date()): Promise<IcsEventInput[]> {
    const from = new Date(now.getTime() - FEED_PAST_DAYS * DAY_MS);
    const to = new Date(now.getTime() + FEED_FUTURE_DAYS * DAY_MS);
    const baseUrl = await getStaffAppBaseUrl(this.db);
    const substitutions = await loadSubstitutions(this.db);
    const rows = await this.db
      .select({ appointment: appointments, processNumber: processes.processNumber })
      .from(appointments)
      .innerJoin(processes, eq(processes.id, appointments.processId))
      .where(
        and(
          eq(appointments.status, 'scheduled'),
          isNotNull(appointments.startAt),
          gte(appointments.startAt, from),
          lte(appointments.startAt, to),
          ne(processes.mainStatus, 'cancelled'),
        ),
      )
      .orderBy(appointments.startAt);
    const events: IcsEventInput[] = [];
    for (const { appointment, processNumber } of rows) {
      if (appointment.startAt === null) continue;
      if (effectiveAssigneeForAppointment(appointment, substitutions, now) !== userId) continue;
      events.push({
        appointmentId: appointment.id,
        kind: appointment.kind as IcsAppointmentKind,
        processNumber,
        startAt: appointment.startAt,
        endAt: appointment.endAt,
        version: appointment.version,
        appUrl: `${baseUrl ?? ''}/vorgaenge/${appointment.processId}/termine`,
      });
    }
    return events;
  }

  async buildFeed(userId: string, displayName: string, now = new Date()): Promise<string> {
    const events = await this.eventsForUser(userId, now);
    return buildIcsCalendar({ displayName, events, now });
  }
}
