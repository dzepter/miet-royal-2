import { customers, processes, staffUsers, type Database } from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { customerDisplayName } from './customer-service.ts';
import { dateSearchTerm, phoneSearchTerm } from './normalize.ts';
import { visibleProcessesWhere, type ProcessVisibilityContext } from './visibility.ts';

/**
 * Globale Suche (Phase-2-Vorgabe Nr. 14/15): Teiltreffer, case-tolerant,
 * Telefonnormalisierung, Tippfehlertoleranz über pg_trgm, beste Treffer
 * zuerst, gruppiert nach Vorgängen und Kunden. Berechtigungen und
 * Sichtbarkeitsregeln werden SERVERSEITIG angewandt – die Suche liefert
 * niemals Daten, auf die der Mitarbeiter keinen Zugriff hat.
 *
 * Abgeschlossene/stornierte Vorgänge sind standardmäßig ausgeblendet;
 * includeCompleted wendet die zentrale Sichtbarkeitsregel an (normale
 * Mitarbeitende: nur innerhalb der Sichtbarkeitsfrist; mit
 * process.view_completed: vollständig). Erweiterbar für spätere Felder
 * (Maschinen-ID usw.) über zusätzliche Matcher.
 */
export interface SearchOptions {
  effective: ReadonlySet<PermissionKey>;
  visibility: ProcessVisibilityContext;
  includeCompleted: boolean;
}

export interface SearchResults {
  customers: {
    id: string;
    displayName: string;
    email: string | null;
    phone: string | null;
  }[];
  processes: {
    id: string;
    processNumber: string;
    mainStatus: 'open' | 'completed' | 'reopened' | 'cancelled';
    eventDate: string | null;
    customerDisplayName: string;
  }[];
}

export class SearchService {
  constructor(private readonly db: Database) {}

  async search(rawQuery: string, options: SearchOptions): Promise<SearchResults> {
    const query = rawQuery.trim();
    if (query.length < 2) return { customers: [], processes: [] };

    const like = `%${query}%`;
    const phoneDigits = phoneSearchTerm(query);
    const isoDate = dateSearchTerm(query);

    const [customerResults, processResults] = await Promise.all([
      options.effective.has('customer.view')
        ? this.searchCustomers(query, like, phoneDigits)
        : Promise.resolve([]),
      options.effective.has('process.view_all')
        ? this.searchProcesses(query, like, phoneDigits, isoDate, options)
        : Promise.resolve([]),
    ]);
    return { customers: customerResults, processes: processResults };
  }

  private customerMatch(query: string, like: string, phoneDigits: string | null): SQL {
    const nameExpr = sql`coalesce(${customers.firstName},'') || ' ' || coalesce(${customers.lastName},'')`;
    const matchers: SQL[] = [
      sql`${nameExpr} ILIKE ${like}`,
      sql`coalesce(${customers.organizationName},'') ILIKE ${like}`,
      sql`coalesce(${customers.email},'') ILIKE ${like}`,
      // Tippfehlertoleranz (pg_trgm): %-Operator nutzt die GIN-Indexe,
      // similarity() > 0.3 hält die Schwelle explizit (GUC-unabhängig).
      sql`((${nameExpr}) % ${query} AND similarity(${nameExpr}, ${query}) > 0.3)`,
      sql`(coalesce(${customers.organizationName},'') % ${query} AND similarity(coalesce(${customers.organizationName},''), ${query}) > 0.3)`,
    ];
    if (phoneDigits !== null) {
      matchers.push(sql`${customers.phoneNormalized} LIKE ${`%${phoneDigits}%`}`);
    }
    return or(...matchers) as SQL;
  }

  private customerRank(query: string): SQL<number> {
    const nameExpr = sql`coalesce(${customers.firstName},'') || ' ' || coalesce(${customers.lastName},'')`;
    return sql<number>`GREATEST(
      similarity(${nameExpr}, ${query}),
      similarity(coalesce(${customers.organizationName},''), ${query}),
      similarity(coalesce(${customers.email},''), ${query})
    )`;
  }

  private async searchCustomers(query: string, like: string, phoneDigits: string | null) {
    const rows = await this.db
      .select({
        id: customers.id,
        type: customers.type,
        firstName: customers.firstName,
        lastName: customers.lastName,
        organizationName: customers.organizationName,
        email: customers.email,
        phone: customers.phone,
        rank: this.customerRank(query),
      })
      .from(customers)
      .where(and(isNull(customers.deletedAt), this.customerMatch(query, like, phoneDigits)))
      .orderBy(desc(this.customerRank(query)))
      .limit(15);
    return rows.map((row) => ({
      id: row.id,
      displayName: customerDisplayName(row),
      email: row.email,
      phone: row.phone,
    }));
  }

  private async searchProcesses(
    query: string,
    like: string,
    phoneDigits: string | null,
    isoDate: string | null,
    options: SearchOptions,
  ) {
    const nameExpr = sql`coalesce(${customers.firstName},'') || ' ' || coalesce(${customers.lastName},'')`;
    const matchers: SQL[] = [
      sql`${processes.processNumber} ILIKE ${like}`,
      sql`${nameExpr} ILIKE ${like}`,
      sql`coalesce(${customers.organizationName},'') ILIKE ${like}`,
      sql`coalesce(${customers.email},'') ILIKE ${like}`,
      sql`((${nameExpr}) % ${query} AND similarity(${nameExpr}, ${query}) > 0.3)`,
      sql`(coalesce(${customers.organizationName},'') % ${query} AND similarity(coalesce(${customers.organizationName},''), ${query}) > 0.3)`,
      // zuständiger Mitarbeiter
      sql`coalesce(${staffUsers.firstName},'') || ' ' || coalesce(${staffUsers.lastName},'') ILIKE ${like}`,
    ];
    if (phoneDigits !== null) {
      matchers.push(sql`${customers.phoneNormalized} LIKE ${`%${phoneDigits}%`}`);
    }
    if (isoDate !== null) {
      matchers.push(eq(processes.eventDate, isoDate));
    }

    // Standard: nur operativ offene Vorgänge (open + reopened, konsistent
    // zur Standardliste), zusätzlich durch die zentrale Sichtbarkeitsregel
    // gefiltert (reopened bleibt ohne process.view_completed unsichtbar).
    // Mit includeCompleted greift die Sichtbarkeitsregel vollständig.
    const statusFilter = options.includeCompleted
      ? visibleProcessesWhere(options.visibility)
      : (and(
          sql`${processes.mainStatus} IN ('open','reopened')`,
          visibleProcessesWhere(options.visibility),
        ) as SQL);

    const rank = sql<number>`GREATEST(
      similarity(${processes.processNumber}, ${query}),
      similarity(${nameExpr}, ${query}),
      similarity(coalesce(${customers.organizationName},''), ${query})
    )`;
    const openFirst = sql<number>`CASE WHEN ${processes.mainStatus} IN ('open','reopened') THEN 0 ELSE 1 END`;

    const rows = await this.db
      .select({
        id: processes.id,
        processNumber: processes.processNumber,
        mainStatus: processes.mainStatus,
        eventDate: processes.eventDate,
        type: customers.type,
        firstName: customers.firstName,
        lastName: customers.lastName,
        organizationName: customers.organizationName,
      })
      .from(processes)
      .innerJoin(customers, eq(processes.customerId, customers.id))
      .leftJoin(staffUsers, eq(processes.assignedUserId, staffUsers.id))
      .where(and(statusFilter, or(...matchers) as SQL))
      .orderBy(openFirst, desc(rank))
      .limit(15);

    return rows.map((row) => ({
      id: row.id,
      processNumber: row.processNumber,
      mainStatus: row.mainStatus,
      eventDate: row.eventDate,
      customerDisplayName: customerDisplayName(row),
    }));
  }
}
