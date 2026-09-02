import {
  staffSubstitutions,
  staffUsers,
  type Database,
  type StaffSubstitution,
} from '@mietroyal/database';
import { substitutionRangesOverlap, type SubstitutionLike } from '@mietroyal/domain';
import { and, eq, sql } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import { toSubstitutionLike } from './assignee.ts';

/**
 * Vertretungen (Order §12): Admin trägt Ursprung, Vertretung und Zeitraum
 * ein – sofort wirksam, vorzeitig beendbar. Nur aktive Mitarbeiter sind
 * wählbar; widersprüchlich überlappende Vertretungen desselben Ursprungs
 * werden abgelehnt (Advisory-Lock gegen Anlage-Races).
 */
export class SubstitutionService {
  constructor(private readonly db: Database) {}

  async list(): Promise<
    (StaffSubstitution & {
      originalName: string;
      substituteName: string;
    })[]
  > {
    const rows = await this.db.select().from(staffSubstitutions);
    const users = await this.db
      .select({
        id: staffUsers.id,
        firstName: staffUsers.firstName,
        lastName: staffUsers.lastName,
      })
      .from(staffUsers);
    const nameOf = (id: string) => {
      const user = users.find((row) => row.id === id);
      return user === undefined ? 'Unbekannt' : `${user.firstName} ${user.lastName}`;
    };
    return rows
      .map((row) => ({
        ...row,
        originalName: nameOf(row.originalUserId),
        substituteName: nameOf(row.substituteUserId),
      }))
      .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());
  }

  private async requireActiveUser(userId: string, label: string): Promise<void> {
    const rows = await this.db
      .select({ id: staffUsers.id, status: staffUsers.status })
      .from(staffUsers)
      .where(eq(staffUsers.id, userId));
    const user = rows[0];
    if (user === undefined) throw new AuthError('NOT_FOUND', `${label} wurde nicht gefunden.`);
    if (user.status !== 'active') {
      throw new AuthError('VALIDATION', `${label} ist nicht aktiv und kann nicht gewählt werden.`);
    }
  }

  async create(
    actorId: string,
    input: {
      originalUserId: string;
      substituteUserId: string;
      startsAt: Date;
      endsAt: Date;
    },
  ): Promise<StaffSubstitution> {
    if (input.originalUserId === input.substituteUserId) {
      throw new AuthError(
        'VALIDATION',
        'Ursprünglicher Mitarbeiter und Vertretung dürfen nicht identisch sein.',
      );
    }
    if (
      Number.isNaN(input.startsAt.getTime()) ||
      Number.isNaN(input.endsAt.getTime()) ||
      input.endsAt.getTime() <= input.startsAt.getTime()
    ) {
      throw new AuthError('VALIDATION', 'Das Ende der Vertretung muss nach dem Beginn liegen.');
    }
    await this.requireActiveUser(input.originalUserId, 'Der ursprüngliche Mitarbeiter');
    await this.requireActiveUser(input.substituteUserId, 'Die Vertretung');

    return this.db.transaction(async (tx) => {
      // Anlage-Race je Ursprungsmitarbeiter serialisieren.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`substitution:${input.originalUserId}`}))`,
      );
      const existing = await tx
        .select()
        .from(staffSubstitutions)
        .where(eq(staffSubstitutions.originalUserId, input.originalUserId));
      const candidate: SubstitutionLike = {
        originalUserId: input.originalUserId,
        substituteUserId: input.substituteUserId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        endedEarlyAt: null,
      };
      const overlapping = existing.some((row) =>
        substitutionRangesOverlap(toSubstitutionLike(row), candidate),
      );
      if (overlapping) {
        throw new AuthError(
          'CONFLICT',
          'Für diesen Mitarbeiter existiert bereits eine überlappende Vertretung.',
        );
      }
      const inserted = await tx
        .insert(staffSubstitutions)
        .values({
          originalUserId: input.originalUserId,
          substituteUserId: input.substituteUserId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          createdBy: actorId,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new AuthError('CONFLICT', 'Die Vertretung konnte nicht angelegt werden.');
      }
      return row;
    });
  }

  /** Vorzeitiges Ende – wirkt sofort (Order §12). */
  async endEarly(substitutionId: string, now = new Date()): Promise<void> {
    const updated = await this.db
      .update(staffSubstitutions)
      .set({ endedEarlyAt: now })
      .where(
        and(
          eq(staffSubstitutions.id, substitutionId),
          sql`${staffSubstitutions.endedEarlyAt} IS NULL`,
          sql`${staffSubstitutions.endsAt} > ${now}`,
        ),
      )
      .returning({ id: staffSubstitutions.id });
    if (updated.length === 0) {
      throw new AuthError(
        'CONFLICT',
        'Diese Vertretung ist bereits beendet oder wurde nicht gefunden.',
      );
    }
  }
}
