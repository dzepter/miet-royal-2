import { customers, processes, type Customer, type Database } from '@mietroyal/database';
import { and, asc, eq, gte, isNull, isNotNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import { normalizeEmailAddress, normalizePhoneNumber } from './normalize.ts';

export interface CustomerInput {
  type: 'private' | 'organization';
  firstName?: string | undefined;
  lastName?: string | undefined;
  organizationName?: string | undefined;
  contactPerson?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  billingStreet?: string | undefined;
  billingPostalCode?: string | undefined;
  billingCity?: string | undefined;
  billingCountry?: string | undefined;
  vatId?: string | undefined;
  department?: string | undefined;
  costCenter?: string | undefined;
  orderReference?: string | undefined;
}

export interface DuplicateWarning {
  customerId: string;
  displayName: string;
  reason: 'email' | 'phone' | 'name';
}

/** Wiederherstellungsfrist des Kunden-Papierkorbs (Phase-2-Vorgabe Nr. 11). */
const TRASH_RESTORE_DAYS = 30;

const trashCutoff = (now: Date): Date =>
  new Date(now.getTime() - TRASH_RESTORE_DAYS * 24 * 60 * 60 * 1000);

const clean = (value: string | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

function toRow(input: CustomerInput) {
  const email = normalizeEmailAddress(input.email);
  if (email !== null && !email.includes('@')) {
    throw new AuthError('VALIDATION', 'Bitte eine gültige E-Mail-Adresse angeben.');
  }
  const row = {
    type: input.type,
    firstName: clean(input.firstName),
    lastName: clean(input.lastName),
    organizationName: input.type === 'organization' ? clean(input.organizationName) : null,
    contactPerson: input.type === 'organization' ? clean(input.contactPerson) : null,
    email,
    phone: clean(input.phone),
    phoneNormalized: normalizePhoneNumber(input.phone),
    billingStreet: clean(input.billingStreet),
    billingPostalCode: clean(input.billingPostalCode),
    billingCity: clean(input.billingCity),
    billingCountry: clean(input.billingCountry),
    vatId: input.type === 'organization' ? clean(input.vatId) : null,
    department: input.type === 'organization' ? clean(input.department) : null,
    costCenter: input.type === 'organization' ? clean(input.costCenter) : null,
    orderReference: input.type === 'organization' ? clean(input.orderReference) : null,
  };

  // Keine unnötigen Pflichtfelder – nur das fachliche Minimum:
  if (input.type === 'private' && (row.firstName === null || row.lastName === null)) {
    throw new AuthError('VALIDATION', 'Vor- und Nachname sind erforderlich.');
  }
  if (input.type === 'organization' && row.organizationName === null) {
    throw new AuthError('VALIDATION', 'Der Organisations-/Firmenname ist erforderlich.');
  }
  return row;
}

export function customerDisplayName(customer: {
  type: 'private' | 'organization';
  firstName: string | null;
  lastName: string | null;
  organizationName: string | null;
}): string {
  if (customer.type === 'organization') return customer.organizationName ?? 'Organisation';
  return `${customer.lastName ?? ''}, ${customer.firstName ?? ''}`.replace(/^, |, $/g, '');
}

export class CustomerService {
  constructor(private readonly db: Database) {}

  /**
   * Einfache, nachvollziehbare Dublettenhinweise (Phase-2-Vorgabe Nr. 2):
   * gleiche E-Mail, gleiche Telefonnummer oder sehr ähnlicher Name/
   * Organisation (pg_trgm). NUR Warnung – niemals Blockade oder
   * automatische Zusammenführung.
   */
  async findDuplicates(input: CustomerInput, excludeId?: string): Promise<DuplicateWarning[]> {
    const email = normalizeEmailAddress(input.email);
    const phoneNormalized = normalizePhoneNumber(input.phone);
    const fullName = `${(input.firstName ?? '').trim()} ${(input.lastName ?? '').trim()}`.trim();
    const organizationName = (input.organizationName ?? '').trim();

    const matchers: SQL[] = [];
    if (email !== null) matchers.push(eq(customers.email, email));
    if (phoneNormalized !== null) matchers.push(eq(customers.phoneNormalized, phoneNormalized));
    if (fullName.length >= 4) {
      matchers.push(
        sql`similarity(coalesce(${customers.firstName},'') || ' ' || coalesce(${customers.lastName},''), ${fullName}) > 0.5`,
      );
    }
    if (organizationName.length >= 4) {
      matchers.push(
        sql`similarity(coalesce(${customers.organizationName},''), ${organizationName}) > 0.5`,
      );
    }
    if (matchers.length === 0) return [];

    const conditions = [isNull(customers.deletedAt), or(...matchers) as SQL];
    if (excludeId !== undefined) conditions.push(ne(customers.id, excludeId));
    const rows = await this.db
      .select()
      .from(customers)
      .where(and(...conditions))
      .limit(5);

    return rows.map((row) => ({
      customerId: row.id,
      displayName: customerDisplayName(row),
      reason:
        email !== null && row.email === email
          ? 'email'
          : phoneNormalized !== null && row.phoneNormalized === phoneNormalized
            ? 'phone'
            : 'name',
    }));
  }

  async createCustomer(
    _actorId: string,
    input: CustomerInput,
  ): Promise<{ customer: Customer; duplicates: DuplicateWarning[] }> {
    const row = toRow(input);
    // Warnen, nicht blockieren: die Dubletten werden mitgeliefert, der
    // Mitarbeiter entscheidet später bewusst über eine Zusammenführung.
    const duplicates = await this.findDuplicates(input);
    const inserted = await this.db.insert(customers).values(row).returning();
    const customer = inserted[0];
    if (customer === undefined) throw new AuthError('CONFLICT', 'Anlegen fehlgeschlagen.');
    return { customer, duplicates };
  }

  async updateCustomer(
    _actorId: string,
    customerId: string,
    input: CustomerInput,
  ): Promise<Customer> {
    const existing = await this.getActiveCustomer(customerId);
    const row = toRow({ ...input, type: existing.type });
    const updated = await this.db
      .update(customers)
      .set({ ...row, updatedAt: new Date() })
      .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
      .returning();
    const customer = updated[0];
    if (customer === undefined) throw new AuthError('NOT_FOUND', 'Kunde nicht gefunden.');
    return customer;
  }

  async getActiveCustomer(customerId: string): Promise<Customer> {
    const rows = await this.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)));
    const customer = rows[0];
    if (customer === undefined) throw new AuthError('NOT_FOUND', 'Kunde nicht gefunden.');
    return customer;
  }

  /** Kompakte Liste (Datenminimierung) inkl. Anzahl offener Vorgänge. */
  async listCustomers() {
    return this.db
      .select({
        id: customers.id,
        type: customers.type,
        firstName: customers.firstName,
        lastName: customers.lastName,
        organizationName: customers.organizationName,
        email: customers.email,
        phone: customers.phone,
        openProcessCount: sql<number>`(
          SELECT count(*)::int FROM ${processes}
          WHERE ${processes.customerId} = ${customers.id}
            AND ${processes.mainStatus} IN ('open', 'reopened')
        )`,
      })
      .from(customers)
      .where(isNull(customers.deletedAt))
      .orderBy(asc(customers.organizationName), asc(customers.lastName), asc(customers.firstName))
      .limit(200);
  }

  // ── Papierkorb (Phase-2-Vorgabe Nr. 11, bewusst klein) ──────────────────

  /**
   * Nur Kunden OHNE Vorgänge dürfen in den Papierkorb – Geschäftsvorgänge
   * werden niemals gelöscht. Kein Hard Delete; Wiederherstellung möglich
   * (Frist 30 Tage, siehe listTrash).
   */
  async moveToTrash(actorId: string, customerId: string): Promise<void> {
    // Transaktion mit Zeilensperre (FOR UPDATE): kollidiert mit dem
    // FOR-KEY-SHARE-Lock der Vorgangserstellung – kein Rennen „Kunde wird
    // gelöscht, während ihm gerade ein Vorgang angelegt wird“.
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
        .for('update');
      if (rows.length === 0) throw new AuthError('NOT_FOUND', 'Kunde nicht gefunden.');
      const related = await tx
        .select({ id: processes.id })
        .from(processes)
        .where(eq(processes.customerId, customerId))
        .limit(1);
      if (related.length > 0) {
        throw new AuthError(
          'CONFLICT',
          'Dieser Kunde hat Vorgänge und kann daher nicht gelöscht werden.',
        );
      }
      await tx
        .update(customers)
        .set({ deletedAt: new Date(), deletedBy: actorId, updatedAt: new Date() })
        .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)));
    });
  }

  /** Wiederherstellung nur innerhalb der 30-Tage-Frist. */
  async restoreFromTrash(customerId: string, now = new Date()): Promise<void> {
    const cutoff = trashCutoff(now);
    const restored = await this.db
      .update(customers)
      .set({ deletedAt: null, deletedBy: null, updatedAt: new Date() })
      .where(
        and(
          eq(customers.id, customerId),
          isNotNull(customers.deletedAt),
          gte(customers.deletedAt, cutoff),
        ),
      )
      .returning({ id: customers.id });
    if (restored.length === 0) {
      throw new AuthError(
        'NOT_FOUND',
        'Kein wiederherstellbarer Papierkorb-Eintrag gefunden (Frist: 30 Tage).',
      );
    }
  }

  /** Zeigt nur Einträge innerhalb der 30-Tage-Wiederherstellungsfrist. */
  async listTrash(now = new Date()) {
    return this.db
      .select({
        id: customers.id,
        type: customers.type,
        firstName: customers.firstName,
        lastName: customers.lastName,
        organizationName: customers.organizationName,
        deletedAt: customers.deletedAt,
      })
      .from(customers)
      .where(and(isNotNull(customers.deletedAt), gte(customers.deletedAt, trashCutoff(now))))
      .orderBy(asc(customers.deletedAt))
      .limit(200);
  }
}
