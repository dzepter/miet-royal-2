import { createHash } from 'node:crypto';
import {
  appointmentConflictSuppressions,
  type Appointment,
  type Database,
} from '@mietroyal/database';
import { appointmentsOverlap } from '@mietroyal/domain';
import { inArray } from 'drizzle-orm';

/**
 * Zentrale, erweiterbare Konflikterkennung (Order §18/§21): Konflikte sind
 * WARNUNGEN, keine Blockaden – nichts wird automatisch abgelehnt. Phase 5
 * registriert später zusätzliche Provider (konkrete Maschine, gesperrte
 * Maschine, Kapazität) über registerConflictProvider, ohne die Engine zu
 * ändern. Es werden KEINE Maschinenkonflikte erfunden.
 *
 * Suppression (Order §20): "Konflikt gelöst" speichert nur einen
 * serverseitig berechneten Fingerprint (Konfliktart + betroffene Termine
 * + Zeiten + effektiver Mitarbeiter). Ändert sich Relevantes, entsteht ein
 * neuer Fingerprint und der Konflikt darf wieder erscheinen. Bewusst ohne
 * Audit-Event und ohne Historienoberfläche.
 */

export interface ConflictAppointment extends Appointment {
  effectiveAssigneeId: string | null;
}

export type ConflictSeverity = 'warning' | 'strong';

export interface DetectedConflict {
  type: string;
  severity: ConflictSeverity;
  appointmentIds: string[];
  reason: string;
  fingerprint: string;
}

export interface ConflictContext {
  appointments: readonly ConflictAppointment[];
}

export interface ConflictProvider {
  readonly key: string;
  /** Darf synchron ODER asynchron arbeiten (Phase-5-Provider lesen die DB). */
  detect(context: ConflictContext): DetectedConflict[] | Promise<DetectedConflict[]>;
}

/**
 * Serverseitiger Fingerprint – Clients können ihn nicht selbst wählen.
 * `extra` erlaubt Providern, zusätzlichen fachlichen Zustand einzurechnen
 * (z. B. Maschinenbestand/Sperren, Order §47): ändert sich der Zustand,
 * entsteht ein neuer Fingerprint und eine alte Suppression wirkt nicht mehr.
 */
export function conflictFingerprint(
  type: string,
  members: readonly ConflictAppointment[],
  extra?: unknown,
): string {
  const canonical = {
    type,
    members: members
      .map((appointment) => ({
        id: appointment.id,
        startAt: appointment.startAt?.toISOString() ?? null,
        endAt: appointment.endAt?.toISOString() ?? null,
        effectiveAssigneeId: appointment.effectiveAssigneeId,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    ...(extra === undefined ? {} : { extra }),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const CONFLICT_TYPE_LABELS: Record<string, string> = {
  staff_double_booking: 'Doppelbelegung',
  process_sequence: 'Reihenfolge',
};

export function conflictTypeLabel(type: string): string {
  return CONFLICT_TYPE_LABELS[type] ?? type;
}

/** Doppelbelegung desselben EFFEKTIVEN Mitarbeiters (Order §18). */
export const staffDoubleBookingProvider: ConflictProvider = {
  key: 'staff_double_booking',
  detect(context) {
    const conflicts: DetectedConflict[] = [];
    const active = context.appointments.filter(
      (appointment) =>
        appointment.status === 'scheduled' &&
        appointment.startAt !== null &&
        appointment.effectiveAssigneeId !== null,
    );
    for (let i = 0; i < active.length; i += 1) {
      for (let j = i + 1; j < active.length; j += 1) {
        const a = active[i]!;
        const b = active[j]!;
        if (a.effectiveAssigneeId !== b.effectiveAssigneeId) continue;
        if (!appointmentsOverlap(a, b)) continue;
        conflicts.push({
          type: 'staff_double_booking',
          severity: 'strong',
          appointmentIds: [a.id, b.id].sort(),
          reason:
            'Doppelbelegung: Derselbe Mitarbeiter ist für zwei zeitlich überlappende Termine eingeteilt.',
          fingerprint: conflictFingerprint('staff_double_booking', [a, b]),
        });
      }
    }
    return conflicts;
  },
};

/**
 * Fachlich eindeutig unlogische Reihenfolge im selben Vorgang (Order §18):
 * Die Rückgabe liegt VOR der Ausgabe/Lieferung derselben Buchung.
 */
export const processSequenceProvider: ConflictProvider = {
  key: 'process_sequence',
  detect(context) {
    const conflicts: DetectedConflict[] = [];
    const byBooking = new Map<string, ConflictAppointment[]>();
    for (const appointment of context.appointments) {
      if (appointment.status !== 'scheduled' || appointment.startAt === null) continue;
      const list = byBooking.get(appointment.bookingId) ?? [];
      list.push(appointment);
      byBooking.set(appointment.bookingId, list);
    }
    for (const list of byBooking.values()) {
      const outbound = list.find((a) => a.kind === 'pickup' || a.kind === 'delivery');
      const inbound = list.find((a) => a.kind === 'return');
      if (outbound?.startAt === null || outbound?.startAt === undefined) continue;
      if (inbound?.startAt === null || inbound?.startAt === undefined) continue;
      if (inbound.startAt.getTime() < outbound.startAt.getTime()) {
        conflicts.push({
          type: 'process_sequence',
          severity: 'warning',
          appointmentIds: [outbound.id, inbound.id].sort(),
          reason:
            'Unlogische Reihenfolge: Die Rückgabe liegt vor der Ausgabe/Lieferung dieses Vorgangs.',
          fingerprint: conflictFingerprint('process_sequence', [outbound, inbound]),
        });
      }
    }
    return conflicts;
  },
};

export class ConflictDetectionService {
  private readonly providers: ConflictProvider[] = [];

  constructor(private readonly db: Database) {
    this.registerProvider(staffDoubleBookingProvider);
    this.registerProvider(processSequenceProvider);
  }

  /** Erweiterungspunkt für Phase 5 (Maschinen-Provider, Order §21). */
  registerProvider(provider: ConflictProvider): void {
    if (this.providers.some((existing) => existing.key === provider.key)) {
      throw new Error(`ConflictProvider "${provider.key}" ist bereits registriert.`);
    }
    this.providers.push(provider);
  }

  async detectAll(context: ConflictContext): Promise<DetectedConflict[]> {
    const results = await Promise.all(this.providers.map((provider) => provider.detect(context)));
    return results.flat();
  }

  /** Erkennen + als "gelöst" markierte Konflikte (Suppression) ausblenden. */
  async detectVisible(context: ConflictContext): Promise<DetectedConflict[]> {
    const conflicts = await this.detectAll(context);
    if (conflicts.length === 0) return conflicts;
    const fingerprints = conflicts.map((conflict) => conflict.fingerprint);
    const suppressed = await this.db
      .select({ fingerprint: appointmentConflictSuppressions.fingerprint })
      .from(appointmentConflictSuppressions)
      .where(inArray(appointmentConflictSuppressions.fingerprint, fingerprints));
    const suppressedSet = new Set(suppressed.map((row) => row.fingerprint));
    return conflicts.filter((conflict) => !suppressedSet.has(conflict.fingerprint));
  }

  /**
   * "Konflikt gelöst" (Order §20): Der Client benennt nur Konfliktart und
   * betroffene Termin-IDs; der Server prüft, dass GENAU dieser Konflikt auf
   * dem AKTUELLEN Datenstand existiert, und speichert dessen serverseitig
   * berechneten Fingerprint. Kein Kommentar, kein Audit-Event.
   */
  async resolve(
    context: ConflictContext,
    type: string,
    appointmentIds: readonly string[],
  ): Promise<void> {
    const wanted = [...appointmentIds].sort().join('|');
    const conflicts = await this.detectAll(context);
    const match = conflicts.find(
      (conflict) => conflict.type === type && conflict.appointmentIds.join('|') === wanted,
    );
    if (match === undefined) {
      throw new Error('CONFLICT_NOT_FOUND');
    }
    await this.db
      .insert(appointmentConflictSuppressions)
      .values({ fingerprint: match.fingerprint })
      .onConflictDoNothing();
  }
}
