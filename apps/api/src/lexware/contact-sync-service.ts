import { createHash } from 'node:crypto';
import {
  customers,
  lexwareContactMappings,
  type Customer,
  type DatabaseExecutor,
  type DatabaseTransaction,
  type LexwareContactMappingRow,
} from '@mietroyal/database';
import { eq, sql } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import { normalizeEmailAddress } from '../crm/normalize.ts';
import type { LexwareClient, LexwareContact } from './client.ts';
import { lexwareContactDeeplink, type LexwareContext } from './context.ts';
import { LexwareApiError } from './errors.ts';

/**
 * Kunde ↔ Lexware-Kontakt (Order §§16–19, §33, §58; Vertrag §5).
 *
 * Ebenen strikt getrennt: Der Lexware-KONTAKT wird ausschließlich aus dem
 * AKTUELLEN Kundenstamm (`customers`) gepflegt; die RECHNUNGSADRESSE eines
 * Belegs kommt aus dem eingefrorenen Accounting-Snapshot (invoice-builder).
 * Nie wird ein alter Booking-Snapshot in den Kontakt zurückgeschrieben.
 *
 * Nebenläufigkeit: Die Mapping-Entscheidung läuft in einer KURZEN Transaktion
 * unter `pg_advisory_xact_lock` je Kunde; HTTP-Aufrufe laufen außerhalb.
 * Ein laufender Contact-Create ist über `pendingIdentity.claimedAt`
 * beansprucht (zweiter Aufrufer ⇒ `in_progress`, transient). Ein Create ohne
 * Antwort bleibt `create_unknown`: der nächste Lauf sucht exakt – eindeutig
 * ⇒ verbinden, mehrere ⇒ Prüfung, keiner ⇒ erneuter Create (Order §33).
 */

export const CONTACT_CREATE_CLAIM_MS = 2 * 60 * 1000;

export type ContactSyncErrorReason =
  | 'CONTACT_ALREADY_MAPPED'
  | 'CONTACT_ALREADY_LINKED'
  | 'CONTACT_NOT_FOUND'
  | 'CONTACT_ORGANIZATION_MISMATCH'
  | 'CONTACT_CREATE_UNKNOWN'
  | 'LEXWARE_NOT_CONFIGURED';

export class ContactSyncError extends AuthError {
  readonly reason: ContactSyncErrorReason;

  constructor(
    reason: ContactSyncErrorReason,
    message: string,
    code: 'CONFLICT' | 'NOT_FOUND' = 'CONFLICT',
  ) {
    super(code, message);
    this.name = 'ContactSyncError';
    this.reason = reason;
  }
}

export interface ContactCandidate {
  contactId: string;
  displayName: string;
  email: string | null;
  /** email_and_name | email | name | already_mapped */
  reason: string;
}

export type ContactResolution =
  | { status: 'linked'; lexwareContactId: string; contactVersion: number | null }
  | { status: 'created'; lexwareContactId: string; contactVersion: number | null }
  | { status: 'review_required'; candidates: ContactCandidate[] }
  | { status: 'create_unknown' }
  | { status: 'in_progress' };

export interface ContactMappingView {
  mapping: {
    lexwareContactId: string | null;
    status: LexwareContactMappingRow['syncStatus'];
    contactVersion: number | null;
    linkedAt: string | null;
    lastSyncedAt: string | null;
  } | null;
  candidates: ContactCandidate[];
  deeplink: string | null;
}

/** Normalisierte Identität des Kunden (für Suche, Vergleich und Kontakt-Body). */
export interface ContactIdentity {
  kind: 'person' | 'company';
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  vatId: string | null;
  street: string | null;
  zip: string | null;
  city: string | null;
}

export function normalizeName(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function text(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

export function contactIdentityFromCustomer(customer: Customer): ContactIdentity {
  const kind = customer.type === 'organization' ? 'company' : 'person';
  return {
    kind,
    firstName: text(customer.firstName),
    lastName: text(customer.lastName),
    companyName: text(customer.organizationName),
    contactPerson: text(customer.contactPerson),
    email: normalizeEmailAddress(customer.email),
    phone: text(customer.phone),
    vatId: text(customer.vatId),
    street: text(customer.billingStreet),
    zip: text(customer.billingPostalCode),
    city: text(customer.billingCity),
  };
}

/** Kontakt-Body (nur dokumentierte Felder, docs/LEXWARE_API_NOTES.md) – ohne `version`. */
export function contactBodyFromIdentity(identity: ContactIdentity): Record<string, unknown> {
  const body: Record<string, unknown> = { roles: { customer: {} } };
  if (identity.kind === 'company') {
    const company: Record<string, unknown> = { name: identity.companyName ?? 'Organisation' };
    if (identity.vatId !== null) company.vatRegistrationId = identity.vatId;
    if (identity.contactPerson !== null) {
      company.contactPersons = [{ lastName: identity.contactPerson, primary: true }];
    }
    body.company = company;
  } else {
    const person: Record<string, unknown> = { lastName: identity.lastName ?? 'Unbekannt' };
    if (identity.firstName !== null) person.firstName = identity.firstName;
    body.person = person;
  }
  if (identity.street !== null && identity.zip !== null && identity.city !== null) {
    body.addresses = {
      billing: [
        { street: identity.street, zip: identity.zip, city: identity.city, countryCode: 'DE' },
      ],
    };
  }
  if (identity.email !== null) body.emailAddresses = { business: [identity.email] };
  if (identity.phone !== null) body.phoneNumbers = { business: [identity.phone] };
  return body;
}

export function contactBodyHash(body: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function contactEmails(contact: LexwareContact): string[] {
  const out: string[] = [];
  for (const list of Object.values(contact.emailAddresses ?? {})) {
    for (const email of list) {
      const normalized = normalizeEmailAddress(email);
      if (normalized !== null) out.push(normalized);
    }
  }
  for (const person of contact.company?.contactPersons ?? []) {
    const normalized = normalizeEmailAddress(person.emailAddress);
    if (normalized !== null) out.push(normalized);
  }
  return out;
}

function contactNameMatches(identity: ContactIdentity, contact: LexwareContact): boolean {
  if (identity.kind === 'company') {
    return (
      contact.company !== undefined &&
      identity.companyName !== null &&
      normalizeName(contact.company.name) === normalizeName(identity.companyName)
    );
  }
  return (
    contact.person !== undefined &&
    identity.lastName !== null &&
    normalizeName(contact.person.lastName) === normalizeName(identity.lastName) &&
    normalizeName(contact.person.firstName) === normalizeName(identity.firstName)
  );
}

/** Starker Treffer (Order §17): exakte normalisierte E-Mail UND passende Person/Organisation. */
export function isStrongMatch(identity: ContactIdentity, contact: LexwareContact): boolean {
  if (identity.email === null) return false;
  if (!contactEmails(contact).includes(identity.email)) return false;
  return contactNameMatches(identity, contact);
}

export function contactDisplayName(contact: LexwareContact): string {
  if (contact.company?.name !== undefined) return contact.company.name;
  const person = contact.person;
  if (person === undefined) return contact.id;
  return `${person.lastName ?? ''}, ${person.firstName ?? ''}`.replace(/^, |, $/g, '');
}

function candidateOf(identity: ContactIdentity, contact: LexwareContact, reason?: string) {
  const emailHit = identity.email !== null && contactEmails(contact).includes(identity.email);
  const nameHit = contactNameMatches(identity, contact);
  return {
    contactId: contact.id,
    displayName: contactDisplayName(contact),
    email: contactEmails(contact)[0] ?? null,
    reason:
      reason ??
      (emailHit && nameHit ? 'email_and_name' : emailHit ? 'email' : nameHit ? 'name' : 'search'),
  } satisfies ContactCandidate;
}

function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return (error as { code?: unknown }).code === '23505' || cause?.code === '23505';
}

type Plan =
  | { kind: 'update'; mapping: LexwareContactMappingRow; customer: Customer }
  | { kind: 'search'; mapping: LexwareContactMappingRow | null; customer: Customer }
  | { kind: 'review'; candidates: ContactCandidate[] }
  | { kind: 'in_progress' };

export class ContactSyncService {
  constructor(readonly lexware: LexwareContext) {}

  private get client(): LexwareClient {
    const client = this.lexware.client;
    if (client === null) {
      throw new ContactSyncError(
        'LEXWARE_NOT_CONFIGURED',
        'Buchhaltungsintegration nicht konfiguriert',
      );
    }
    return client;
  }

  async getMapping(
    customerId: string,
    executor: DatabaseExecutor = this.lexware.db,
  ): Promise<LexwareContactMappingRow | null> {
    const rows = await executor
      .select()
      .from(lexwareContactMappings)
      .where(eq(lexwareContactMappings.customerId, customerId));
    return rows[0] ?? null;
  }

  async view(customerId: string): Promise<ContactMappingView> {
    const mapping = await this.getMapping(customerId);
    const candidates = Array.isArray(mapping?.candidates)
      ? (mapping.candidates as ContactCandidate[])
      : [];
    return {
      mapping:
        mapping === null
          ? null
          : {
              lexwareContactId: mapping.lexwareContactId,
              status: mapping.syncStatus,
              contactVersion: mapping.contactVersion,
              linkedAt: mapping.linkedAt?.toISOString() ?? null,
              lastSyncedAt: mapping.lastSyncedAt?.toISOString() ?? null,
            },
      candidates,
      deeplink:
        mapping?.lexwareContactId === null || mapping === null
          ? null
          : lexwareContactDeeplink(this.lexware.appBaseUrl, mapping.lexwareContactId),
    };
  }

  /** Kurze Transaktion mit Kunden-Lock (kein HTTP darin). */
  private async locked<T>(
    customerId: string,
    fn: (tx: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return this.lexware.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`lexware-contact:${customerId}`}))`,
      );
      return fn(tx);
    });
  }

  private async customerById(customerId: string, executor: DatabaseExecutor): Promise<Customer> {
    const rows = await executor.select().from(customers).where(eq(customers.id, customerId));
    const customer = rows[0];
    if (customer === undefined) throw new AuthError('NOT_FOUND', 'Kunde nicht gefunden.');
    return customer;
  }

  /**
   * Kontakt für einen Transfer auflösen (Vertrag §5). Ergebnis `linked`/
   * `created` liefert die Kontakt-ID; `review_required`, `create_unknown`
   * und `in_progress` sind Blocker (permanent bzw. transient).
   */
  async resolveForTransfer(
    customerId: string,
    organizationId: string,
    now = new Date(),
  ): Promise<ContactResolution> {
    const plan = await this.locked(customerId, async (tx): Promise<Plan> => {
      const mapping = await this.getMapping(customerId, tx);
      const customer = await this.customerById(customerId, tx);
      if (mapping === null) return { kind: 'search', mapping: null, customer };
      if (mapping.organizationId !== organizationId) {
        // Mapping einer anderen Organisation gilt hier nicht (fremde Kontakt-ID nie verwenden).
        return { kind: 'review', candidates: [] };
      }
      switch (mapping.syncStatus) {
        case 'linked':
          return { kind: 'update', mapping, customer };
        case 'review_required':
          return {
            kind: 'review',
            candidates: Array.isArray(mapping.candidates)
              ? (mapping.candidates as ContactCandidate[])
              : [],
          };
        case 'create_unknown': {
          const pending = (mapping.pendingIdentity ?? {}) as { claimedAt?: unknown };
          const claimedAt =
            typeof pending.claimedAt === 'string' ? Date.parse(pending.claimedAt) : Number.NaN;
          if (Number.isFinite(claimedAt) && now.getTime() - claimedAt < CONTACT_CREATE_CLAIM_MS) {
            return { kind: 'in_progress' };
          }
          return { kind: 'search', mapping, customer };
        }
        default:
          return { kind: 'review', candidates: [] };
      }
    });

    if (plan.kind === 'in_progress') return { status: 'in_progress' };
    if (plan.kind === 'review') return { status: 'review_required', candidates: plan.candidates };
    if (plan.kind === 'update') {
      return this.updateLinked(plan.mapping, plan.customer, organizationId, now);
    }
    return this.searchOrCreate(plan.customer, organizationId, now);
  }

  // ── Mapping vorhanden: Kontakt aus aktuellem Kundenstamm aktualisieren ──

  private async updateLinked(
    mapping: LexwareContactMappingRow,
    customer: Customer,
    organizationId: string,
    now: Date,
  ): Promise<ContactResolution> {
    const contactId = mapping.lexwareContactId;
    if (contactId === null) return { status: 'review_required', candidates: [] };
    const identity = contactIdentityFromCustomer(customer);
    const body = contactBodyFromIdentity(identity);
    const hash = contactBodyHash(body);
    if (mapping.lastSyncedHash === hash) {
      return {
        status: 'linked',
        lexwareContactId: contactId,
        contactVersion: mapping.contactVersion,
      };
    }
    let remote: LexwareContact;
    try {
      remote = (await this.client.getContact(contactId)).data;
    } catch (error) {
      if (error instanceof LexwareApiError && error.kind === 'not_found') {
        await this.locked(customer.id, async (tx) => {
          await tx
            .update(lexwareContactMappings)
            .set({ syncStatus: 'review_required', candidates: [], updatedAt: now })
            .where(eq(lexwareContactMappings.id, mapping.id));
        });
        return { status: 'review_required', candidates: [] };
      }
      throw error;
    }
    if (remote.organizationId !== undefined && remote.organizationId !== organizationId) {
      return { status: 'review_required', candidates: [] };
    }
    const version = await this.putContact(contactId, remote, body);
    await this.locked(customer.id, async (tx) => {
      await tx
        .update(lexwareContactMappings)
        .set({ contactVersion: version, lastSyncedHash: hash, lastSyncedAt: now, updatedAt: now })
        .where(eq(lexwareContactMappings.id, mapping.id));
    });
    this.lexware.logger.info(
      { lexware: { action: 'contact_update', customerId: customer.id, contactId } },
      'Lexware-Kontakt aus Kundenstamm aktualisiert',
    );
    return { status: 'linked', lexwareContactId: contactId, contactVersion: version };
  }

  /** PUT mit Optimistic Locking; 409 ⇒ Stand lesen und genau einmal erneut. */
  private async putContact(
    contactId: string,
    remote: LexwareContact,
    body: Record<string, unknown>,
  ): Promise<number> {
    const merged = (current: LexwareContact): Record<string, unknown> => ({
      ...body,
      // Vorhandene Rollen (z. B. vendor) nie entfernen, Kundenrolle sicherstellen.
      roles: { ...(current.roles ?? {}), customer: {} },
      version: current.version,
    });
    try {
      const result = (await this.client.updateContact(contactId, merged(remote))).data;
      return result.version ?? remote.version + 1;
    } catch (error) {
      if (!(error instanceof LexwareApiError && error.kind === 'conflict')) throw error;
      const fresh = (await this.client.getContact(contactId)).data;
      const result = (await this.client.updateContact(contactId, merged(fresh))).data;
      return result.version ?? fresh.version + 1;
    }
  }

  // ── Kein Mapping: Suche, starker Treffer, sonst Create ──

  private async searchCandidates(identity: ContactIdentity): Promise<LexwareContact[]> {
    const byId = new Map<string, LexwareContact>();
    const queries: { email?: string; name?: string }[] = [];
    if (identity.email !== null && identity.email.length >= 3)
      queries.push({ email: identity.email });
    const name = identity.kind === 'company' ? identity.companyName : identity.lastName;
    if (name !== null && name.trim().length >= 3) queries.push({ name: name.trim() });
    for (const query of queries) {
      const page = (await this.client.searchContacts({ ...query, size: 250 })).data;
      for (const contact of page.content) {
        if (contact.archived === true) continue;
        byId.set(contact.id, contact);
      }
    }
    return [...byId.values()];
  }

  private async searchOrCreate(
    customer: Customer,
    organizationId: string,
    now: Date,
  ): Promise<ContactResolution> {
    const identity = contactIdentityFromCustomer(customer);
    const found = (await this.searchCandidates(identity)).filter(
      (contact) =>
        contact.organizationId === undefined || contact.organizationId === organizationId,
    );
    const strong = found.filter((contact) => isStrongMatch(identity, contact));
    if (strong.length === 1 && strong[0] !== undefined) {
      const contact = strong[0];
      const linked = await this.linkWithin(customer.id, contact, organizationId, now, null);
      if (!linked) {
        return this.markReview(customer.id, organizationId, now, [
          candidateOf(identity, contact, 'already_mapped'),
        ]);
      }
      // Direkt aus dem aktuellen Kundenstamm nachziehen.
      const mapping = await this.getMapping(customer.id);
      if (mapping !== null) return this.updateLinked(mapping, customer, organizationId, now);
      return { status: 'linked', lexwareContactId: contact.id, contactVersion: contact.version };
    }
    if (found.length > 0) {
      return this.markReview(
        customer.id,
        organizationId,
        now,
        found.slice(0, 20).map((contact) => candidateOf(identity, contact)),
      );
    }
    return this.create(customer, identity, organizationId, now);
  }

  private async markReview(
    customerId: string,
    organizationId: string,
    now: Date,
    candidates: ContactCandidate[],
  ): Promise<ContactResolution> {
    await this.locked(customerId, async (tx) => {
      await tx
        .insert(lexwareContactMappings)
        .values({
          customerId,
          organizationId,
          lexwareContactId: null,
          syncStatus: 'review_required',
          candidates,
          pendingIdentity: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: lexwareContactMappings.customerId,
          set: {
            organizationId,
            lexwareContactId: null,
            syncStatus: 'review_required',
            candidates,
            pendingIdentity: null,
            updatedAt: now,
          },
        });
    });
    this.lexware.logger.warn(
      { lexware: { action: 'contact_review', customerId, candidates: candidates.length } },
      'Lexware-Kontakt mehrdeutig – manuelle Prüfung erforderlich',
    );
    return { status: 'review_required', candidates };
  }

  /** Mapping `linked` schreiben; false bei Unique-Verletzung (Kontakt gehört zu anderem Kunden). */
  private async linkWithin(
    customerId: string,
    contact: LexwareContact,
    organizationId: string,
    now: Date,
    actorId: string | null,
  ): Promise<boolean> {
    try {
      await this.locked(customerId, async (tx) => {
        await tx
          .insert(lexwareContactMappings)
          .values({
            customerId,
            organizationId,
            lexwareContactId: contact.id,
            contactVersion: contact.version,
            syncStatus: 'linked',
            candidates: null,
            pendingIdentity: null,
            linkedAt: now,
            linkedBy: actorId,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: lexwareContactMappings.customerId,
            set: {
              organizationId,
              lexwareContactId: contact.id,
              contactVersion: contact.version,
              syncStatus: 'linked',
              candidates: null,
              pendingIdentity: null,
              lastSyncedHash: null,
              linkedAt: now,
              linkedBy: actorId,
              updatedAt: now,
            },
          });
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  private async create(
    customer: Customer,
    identity: ContactIdentity,
    organizationId: string,
    now: Date,
  ): Promise<ContactResolution> {
    const body = contactBodyFromIdentity(identity);
    const hash = contactBodyHash(body);
    const pendingIdentity = {
      email: identity.email,
      name: identity.kind === 'company' ? identity.companyName : identity.lastName,
      claimedAt: now.toISOString(),
    };
    // Claim VOR dem Create (Unknown-Outcome-Recovery, Order §33/§58).
    await this.locked(customer.id, async (tx) => {
      await tx
        .insert(lexwareContactMappings)
        .values({
          customerId: customer.id,
          organizationId,
          lexwareContactId: null,
          syncStatus: 'create_unknown',
          candidates: null,
          pendingIdentity,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: lexwareContactMappings.customerId,
          set: {
            organizationId,
            lexwareContactId: null,
            syncStatus: 'create_unknown',
            candidates: null,
            pendingIdentity,
            updatedAt: now,
          },
        });
    });
    let created;
    try {
      created = (await this.client.createContact({ ...body, version: 0 })).data;
    } catch (error) {
      if (
        error instanceof LexwareApiError &&
        (error.kind === 'timeout' || error.kind === 'network')
      ) {
        // Ergebnis unbekannt: Claim freigeben, Status bleibt create_unknown.
        await this.locked(customer.id, async (tx) => {
          await tx
            .update(lexwareContactMappings)
            .set({ pendingIdentity: { ...pendingIdentity, claimedAt: null }, updatedAt: now })
            .where(eq(lexwareContactMappings.customerId, customer.id));
        });
        this.lexware.logger.warn(
          { lexware: { action: 'contact_create', customerId: customer.id, code: error.code } },
          'Lexware-Kontaktanlage ohne Antwort – Recovery beim nächsten Lauf',
        );
        return { status: 'create_unknown' };
      }
      // Permanenter/anderer Fehler vor einer Antwort: kein Pending-Zustand hinterlassen.
      await this.locked(customer.id, async (tx) => {
        await tx
          .delete(lexwareContactMappings)
          .where(eq(lexwareContactMappings.customerId, customer.id));
      });
      throw error;
    }
    await this.locked(customer.id, async (tx) => {
      await tx
        .update(lexwareContactMappings)
        .set({
          lexwareContactId: created.id,
          contactVersion: created.version ?? 1,
          syncStatus: 'linked',
          candidates: null,
          pendingIdentity: null,
          lastSyncedHash: hash,
          lastSyncedAt: now,
          linkedAt: now,
          updatedAt: now,
        })
        .where(eq(lexwareContactMappings.customerId, customer.id));
    });
    this.lexware.logger.info(
      { lexware: { action: 'contact_create', customerId: customer.id, contactId: created.id } },
      'Lexware-Kontakt angelegt',
    );
    return {
      status: 'created',
      lexwareContactId: created.id,
      contactVersion: created.version ?? 1,
    };
  }

  // ── Administrative Klärung (Routen) ──

  /** Vorhandenen Lexware-Kontakt bewusst verknüpfen (system.settings). */
  async link(
    actorId: string,
    customerId: string,
    lexwareContactId: string,
    organizationId: string,
    now = new Date(),
  ): Promise<ContactMappingView> {
    await this.customerById(customerId, this.lexware.db);
    let contact: LexwareContact;
    try {
      contact = (await this.client.getContact(lexwareContactId)).data;
    } catch (error) {
      if (error instanceof LexwareApiError && error.kind === 'not_found') {
        throw new ContactSyncError(
          'CONTACT_NOT_FOUND',
          'Lexware-Kontakt nicht gefunden.',
          'NOT_FOUND',
        );
      }
      throw error;
    }
    if (contact.organizationId !== undefined && contact.organizationId !== organizationId) {
      throw new ContactSyncError(
        'CONTACT_ORGANIZATION_MISMATCH',
        'Der Kontakt gehört zu einer anderen Lexware-Organisation.',
      );
    }
    const linked = await this.linkWithin(customerId, contact, organizationId, now, actorId);
    if (!linked) {
      throw new ContactSyncError(
        'CONTACT_ALREADY_MAPPED',
        'Dieser Lexware-Kontakt ist bereits einem anderen Kunden zugeordnet.',
      );
    }
    this.lexware.logger.info(
      { lexware: { action: 'contact_link', customerId, contactId: contact.id }, actorId },
      'Lexware-Kontakt manuell verknüpft',
    );
    return this.view(customerId);
  }

  /** Neuen Lexware-Kontakt aus dem aktuellen Kundenstamm anlegen (system.settings). */
  async createForCustomer(
    actorId: string,
    customerId: string,
    organizationId: string,
    now = new Date(),
  ): Promise<ContactMappingView> {
    const customer = await this.customerById(customerId, this.lexware.db);
    const existing = await this.getMapping(customerId);
    if (existing?.syncStatus === 'linked') {
      throw new ContactSyncError(
        'CONTACT_ALREADY_LINKED',
        'Für diesen Kunden ist bereits ein Lexware-Kontakt verknüpft.',
      );
    }
    const result = await this.create(
      customer,
      contactIdentityFromCustomer(customer),
      organizationId,
      now,
    );
    if (result.status === 'create_unknown') {
      throw new ContactSyncError(
        'CONTACT_CREATE_UNKNOWN',
        'Lexware hat nicht geantwortet – die Anlage wird beim nächsten Abgleich geprüft.',
      );
    }
    this.lexware.logger.info(
      { lexware: { action: 'contact_create_manual', customerId }, actorId },
      'Lexware-Kontakt manuell angelegt',
    );
    return this.view(customerId);
  }
}
