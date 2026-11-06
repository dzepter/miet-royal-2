import { createHash } from 'node:crypto';
import {
  cmsRevisions,
  customers,
  processes,
  publicInquirySubmissions,
  type Database,
  type DatabaseTransaction,
  type PublicInquiryCustomerMatch,
} from '@mietroyal/database';
import {
  PricingError,
  berlinDateOf,
  berlinDateTimeToUtc,
  berlinLocalTimeExists,
  priceOffer,
  resolvePricingInput,
} from '@mietroyal/domain';
import { RequestValidationError, type ValidationIssue } from '@mietroyal/validation';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { loadPublishedPrivacyRevision } from '../cms/published-content.ts';
import { InquiryService, type InquirySelectionInput } from '../commerce/inquiry-service.ts';
import { ProductService } from '../commerce/product-service.ts';
import { CustomerService, type CustomerInput } from '../crm/customer-service.ts';
import { isValidIsoDate, normalizeEmailAddress, normalizePhoneNumber } from '../crm/normalize.ts';
import { ProcessService } from '../crm/process-service.ts';
import { pricingErrorPath, resolveConfiguratorSelection } from './configurator.ts';
import type { PublicInquiryBody } from './schemas.ts';

/**
 * Phase 16 (PUBLIC, Design §3.3/§11.2): öffentliche Website-Anfrage ⇒ genau EIN
 * zentraler Vorgang (source = website, created_by NULL). Gesamter Kern in EINER
 * Transaktion über EINE Verbindung (Pool max = 1 funktioniert; kein `this.db` innerhalb):
 * Advisory-Lock je clientMutationId ⇒ Wiederholung erkennen ⇒ (nur neue Anfragen) Datum/
 * Zeiten prüfen ⇒ Datenschutz-Revision ⇒
 * Auswahl erneut prüfen (Preview ist keine Autorität) ⇒ Advisory-Lock je E-Mail ⇒ Kunde
 * bestimmen/anlegen ⇒ Vorgang ⇒ Anfrage + Auswahl ⇒ unveränderliche Submission-Zeile.
 * Keine Verfügbarkeitsprüfung, keine Ablehnung ab 250 Gästen, keine Mail, kein Job.
 * Fehler tragen nie Kontaktwerte.
 */

export const PRIVACY_NOT_PUBLISHED_MESSAGE =
  'Anfragen sind gerade nicht möglich. Bitte versuche es später erneut oder kontaktiere uns direkt.';
export const PUBLIC_INQUIRY_CONFLICT_MESSAGE = 'Deine Anfrage ist bereits bei uns eingegangen.';
/** Review inquiry-2: Uhrzeit in der Sommerzeit-Sprunglücke (z. B. 28.03.2027, 02:30). */
export const NONEXISTENT_LOCAL_TIME_MESSAGE =
  'Diese Uhrzeit gibt es am gewählten Tag wegen der Zeitumstellung nicht.';
/** Review inquiry-3: Wunsch-Lieferzeitfenster am Veranstaltungstag, Ende ≤ Beginn ⇒ 400. */
export const DELIVERY_WINDOW_ORDER_MESSAGE =
  'Das Ende des Wunsch-Lieferzeitfensters muss nach dem Beginn liegen.';
/** Sicherung (nicht erreichbar, solange die Uhrzeiten existieren): nie Ende ≤ Beginn speichern. */
export const EVENT_END_ORDER_MESSAGE = 'Das Ende muss nach dem Beginn liegen.';

export type PublicInquiryErrorCode = 'PUBLIC_INQUIRY_CONFLICT' | 'PRIVACY_NOT_PUBLISHED';

/** Fachliche 409-Fälle der Website-Anfrage (Route mappt auf die Fehlerantwort). */
export class PublicInquiryError extends Error {
  constructor(
    readonly code: PublicInquiryErrorCode,
    message: string,
    /** Nur bei PUBLIC_INQUIRY_CONFLICT: Vorgangsnummer der bereits gespeicherten Anfrage. */
    readonly processNumber: string | null = null,
  ) {
    super(message);
    this.name = 'PublicInquiryError';
  }
}

export interface PublicInquiryOutcome {
  /** `created` ⇒ 201; `replayed` ⇒ 200 (gleiche ID + gleicher Inhalt, kein zweiter Vorgang). */
  status: 'created' | 'replayed';
  processNumber: string;
  receivedAt: string;
}

/** Unveränderlicher Kontakt-Snapshot (genau die abgesendeten Felder, normalisiert wie im CRM). */
export type PublicInquiryContactSnapshot =
  | { type: 'private'; firstName: string; lastName: string; email: string; phone: string | null }
  | {
      type: 'organization';
      organizationName: string;
      contactPerson: string;
      email: string;
      phone: string | null;
    };

/** Kanonisches JSON: Objekt-Schlüssel sortiert, Arrays in Reihenfolge, `undefined` entfällt. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 über das kanonische JSON des validierten Bodys OHNE `clientMutationId`. */
export function publicInquiryPayloadHash(body: PublicInquiryBody): string {
  const { clientMutationId: _clientMutationId, ...rest } = body;
  return createHash('sha256').update(canonicalJson(rest), 'utf8').digest('hex');
}

export function contactSnapshotOf(
  contact: PublicInquiryBody['contact'],
): PublicInquiryContactSnapshot {
  const email = normalizeEmailAddress(contact.email) ?? '';
  const phone = contact.phone === undefined || contact.phone === '' ? null : contact.phone.trim();
  return contact.type === 'private'
    ? {
        type: 'private',
        firstName: contact.firstName.trim(),
        lastName: contact.lastName.trim(),
        email,
        phone,
      }
    : {
        type: 'organization',
        organizationName: contact.organizationName.trim(),
        contactPerson: contact.contactPerson.trim(),
        email,
        phone,
      };
}

function customerInputOf(snapshot: PublicInquiryContactSnapshot): CustomerInput {
  const phone = snapshot.phone === null ? {} : { phone: snapshot.phone };
  return snapshot.type === 'private'
    ? {
        type: 'private',
        firstName: snapshot.firstName,
        lastName: snapshot.lastName,
        email: snapshot.email,
        ...phone,
      }
    : {
        type: 'organization',
        organizationName: snapshot.organizationName,
        contactPerson: snapshot.contactPerson,
        email: snapshot.email,
        ...phone,
      };
}

function nextIsoDate(dateIso: string): string {
  const [year, month, day] = dateIso.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1)).toISOString().slice(0, 10);
}

function hourMinute(time: string): [number, number] {
  const [hour, minute] = time.split(':').map(Number);
  return [hour ?? 0, minute ?? 0];
}

/** Zeitfenster als timestamptz plus Feld-Issues (nur Pfad + Meldung, nie Werte). */
export interface BerlinTimeWindow {
  from: Date | null;
  to: Date | null;
  issues: ValidationIssue[];
}

/** „HH:MM“ an einem Berliner Kalendertag ⇒ Zeitpunkt; existiert die Uhrzeit nicht ⇒ Issue. */
function berlinTimeOn(
  dateIso: string,
  time: string,
  path: string,
  issues: ValidationIssue[],
): Date | null {
  const [hour, minute] = hourMinute(time);
  if (!berlinLocalTimeExists(dateIso, hour, minute)) {
    issues.push({ path: `body.${path}`, message: NONEXISTENT_LOCAL_TIME_MESSAGE });
    return null;
  }
  return berlinDateTimeToUtc(dateIso, hour, minute);
}

/**
 * Veranstaltungszeiten (Europe/Berlin ⇒ timestamptz). Ende ≤ Beginn ⇒ Ende am Folgetag
 * (Design §11.2 Nr. 7, kein 400). Uhrzeiten in der Sommerzeit-Sprunglücke des jeweiligen
 * Tages ⇒ Issue an `body.event.startTime`/`body.event.endTime` (Review inquiry-2); ein
 * berechnetes Ende ≤ Beginn wird nie zurückgegeben.
 */
export function eventTimeWindow(
  dateIso: string,
  startTime: string | undefined,
  endTime: string | undefined,
): BerlinTimeWindow {
  const issues: ValidationIssue[] = [];
  const from =
    startTime === undefined ? null : berlinTimeOn(dateIso, startTime, 'event.startTime', issues);
  let to: Date | null = null;
  if (endTime !== undefined) {
    const endDate =
      startTime !== undefined && endTime <= startTime ? nextIsoDate(dateIso) : dateIso;
    to = berlinTimeOn(endDate, endTime, 'event.endTime', issues);
  }
  if (issues.length === 0 && from !== null && to !== null && to.getTime() <= from.getTime()) {
    issues.push({ path: 'body.event.endTime', message: EVENT_END_ORDER_MESSAGE });
  }
  return issues.length === 0 ? { from, to, issues } : { from: null, to: null, issues };
}

/**
 * Wunsch-Lieferzeitfenster – beide Zeiten AM VERANSTALTUNGSTAG (Design §11.2 Nr. 7, „kein
 * anderes Datum erfinden“; Review inquiry-3): keine Folgetag-Regel, Ende ≤ Beginn ⇒ Issue an
 * `body.fulfillment.windowTo`; Uhrzeit in der Sprunglücke ⇒ Issue am jeweiligen Feld.
 */
export function deliveryTimeWindow(
  dateIso: string,
  windowFrom: string | undefined,
  windowTo: string | undefined,
): BerlinTimeWindow {
  const issues: ValidationIssue[] = [];
  const from =
    windowFrom === undefined
      ? null
      : berlinTimeOn(dateIso, windowFrom, 'fulfillment.windowFrom', issues);
  const to =
    windowTo === undefined ? null : berlinTimeOn(dateIso, windowTo, 'fulfillment.windowTo', issues);
  if (
    issues.length === 0 &&
    windowFrom !== undefined &&
    windowTo !== undefined &&
    (windowTo <= windowFrom || (from !== null && to !== null && to.getTime() <= from.getTime()))
  ) {
    issues.push({ path: 'body.fulfillment.windowTo', message: DELIVERY_WINDOW_ORDER_MESSAGE });
  }
  return issues.length === 0 ? { from, to, issues } : { from: null, to: null, issues };
}

function validationError(path: string, message: string): RequestValidationError {
  return new RequestValidationError([{ path: `body.${path}`, message }]);
}

/** Event- und Lieferzeiten prüfen (alle Feld-Issues gemeinsam ⇒ 400, ohne Werte). */
function validatedTimes(body: PublicInquiryBody): {
  eventTimes: BerlinTimeWindow;
  deliveryWindow: BerlinTimeWindow;
} {
  const eventTimes = eventTimeWindow(body.event.date, body.event.startTime, body.event.endTime);
  const deliveryWindow =
    body.fulfillment.type === 'delivery'
      ? deliveryTimeWindow(body.event.date, body.fulfillment.windowFrom, body.fulfillment.windowTo)
      : { from: null, to: null, issues: [] };
  const issues = [...eventTimes.issues, ...deliveryWindow.issues];
  if (issues.length > 0) throw new RequestValidationError(issues);
  return { eventTimes, deliveryWindow };
}

export class WebsiteInquiryService {
  private readonly customers: CustomerService;
  private readonly processes: ProcessService;
  private readonly inquiries: InquiryService;
  private readonly products: ProductService;

  constructor(private readonly db: Database) {
    this.customers = new CustomerService(db);
    this.processes = new ProcessService(db);
    this.inquiries = new InquiryService(db);
    this.products = new ProductService(db);
  }

  /**
   * Anfrage verarbeiten. `portalCustomerId` = Kunde einer gültigen Portal-Session (vom
   * Aufrufer VOR der Transaktion ermittelt, `touch: false`) oder null.
   */
  async submit(
    body: PublicInquiryBody,
    options: { portalCustomerId: string | null; now?: Date },
  ): Promise<PublicInquiryOutcome> {
    const now = options.now ?? new Date();
    // Vor jeder Verbindung NUR die deterministische Formatprüfung (Kalenderdatum real).
    // Alles, was von `now` abhängt oder früher erlaubt war (Vergangenheit, Zeitumstellung,
    // Lieferfenster), erst NACH der Wiederholungserkennung – eine gespeicherte Anfrage mit
    // derselben clientMutationId bekommt immer 200/409 (Review inquiry-1).
    if (!isValidIsoDate(body.event.date)) {
      throw validationError('event.date', 'Bitte ein gültiges Datum angeben.');
    }
    const payloadHash = publicInquiryPayloadHash(body);
    const snapshot = contactSnapshotOf(body.contact);

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`public-inquiry:${body.clientMutationId}`}))`,
      );
      const existing = await tx
        .select({
          payloadHash: publicInquirySubmissions.payloadHash,
          createdAt: publicInquirySubmissions.createdAt,
          processNumber: processes.processNumber,
        })
        .from(publicInquirySubmissions)
        .innerJoin(processes, eq(processes.id, publicInquirySubmissions.processId))
        .where(eq(publicInquirySubmissions.clientMutationId, body.clientMutationId));
      const previous = existing[0];
      if (previous !== undefined) {
        if (previous.payloadHash !== payloadHash) {
          throw new PublicInquiryError(
            'PUBLIC_INQUIRY_CONFLICT',
            PUBLIC_INQUIRY_CONFLICT_MESSAGE,
            previous.processNumber,
          );
        }
        return {
          status: 'replayed' as const,
          processNumber: previous.processNumber,
          receivedAt: previous.createdAt.toISOString(),
        };
      }

      // Nur neue Anfragen: Datum nicht in der Vergangenheit (Berlin), Zeiten existieren.
      if (body.event.date < berlinDateOf(now)) {
        throw validationError('event.date', 'Das Datum darf nicht in der Vergangenheit liegen.');
      }
      const { eventTimes, deliveryWindow } = validatedTimes(body);

      const privacy = await loadPublishedPrivacyRevision(tx);
      if (privacy === null) {
        throw new PublicInquiryError('PRIVACY_NOT_PUBLISHED', PRIVACY_NOT_PUBLISHED_MESSAGE);
      }

      const selectionInput = await this.validatedSelection(tx, body, now);

      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`public-inquiry-email:${snapshot.email}`}))`,
      );
      const { customerId, customerMatch } = await this.resolveCustomer(
        tx,
        snapshot,
        options.portalCustomerId,
      );

      const process = await this.processes.createProcessWithin(
        tx,
        null,
        { customerId, source: 'website', eventDate: body.event.date },
        now,
      );
      const delivery = body.fulfillment.type === 'delivery' ? body.fulfillment : null;
      const inquiryId = await this.inquiries.upsertWithin(tx, null, process.id, {
        eventDate: body.event.date,
        eventStart: eventTimes.from,
        eventEnd: eventTimes.to,
        guestCount: body.event.guests,
        occasion: body.event.occasion,
        machineProductId: selectionInput.machineProductId,
        fulfillment: body.fulfillment.type,
        deliveryStreet: delivery?.street ?? null,
        deliveryPostalCode: delivery?.postalCode ?? null,
        deliveryCity: delivery?.city ?? null,
        deliveryWindowFrom: deliveryWindow.from,
        deliveryWindowTo: deliveryWindow.to,
        selections: selectionInput.selections,
      });

      await tx.insert(publicInquirySubmissions).values({
        clientMutationId: body.clientMutationId,
        payloadHash,
        customerId,
        processId: process.id,
        inquiryId,
        customerMatch,
        contactSnapshot: snapshot,
        privacyRevisionId: privacy.revisionId,
        privacyAcknowledgedAt: now,
        createdAt: now,
      });
      return {
        status: 'created' as const,
        processNumber: process.processNumber,
        receivedAt: now.toISOString(),
      };
    });
  }

  /**
   * Auswahl serverseitig erneut prüfen – dieselbe Auflösung wie die Vorschau, Regeln
   * über `priceOffer` (Verstoß ⇒ 400 mit Feldpfad). Liefert die Anfrage-Auswahl per ID.
   */
  private async validatedSelection(
    tx: DatabaseTransaction,
    body: PublicInquiryBody,
    now: Date,
  ): Promise<{ machineProductId: string; selections: InquirySelectionInput[] }> {
    const resolved = await resolveConfiguratorSelection(
      tx,
      this.products,
      {
        machineSlug: body.machineSlug,
        syrups: body.syrups,
        extras: body.extras,
        canisters: body.canisters,
        fulfillment: body.fulfillment.type,
      },
      now,
    );
    if (resolved.issues.length > 0 || resolved.machine === null) {
      const issues: ValidationIssue[] = resolved.issues.map((issue) => ({
        path: `body.${issue.path}`,
        message: issue.message,
      }));
      throw new RequestValidationError(issues);
    }
    try {
      priceOffer(await resolvePricingInput(resolved.request, resolved.resolver));
    } catch (error) {
      if (error instanceof PricingError) {
        throw validationError(pricingErrorPath(error.code), error.message);
      }
      throw error;
    }
    const idOf = (slug: string): string => {
      const product = resolved.pricingProducts.get(slug);
      if (product === undefined) throw new Error('Produkt der Auswahl nicht aufgelöst.');
      return product.id;
    };
    return {
      machineProductId: resolved.machine.id,
      selections: resolved.request.selections.map((selection) => ({
        productId: idOf(selection.ref),
        role: selection.role,
        quantity: selection.quantity,
      })),
    };
  }

  /**
   * Kundenzuordnung (Order §16): 1. gültige Portal-Session ⇒ genau dieser (aktive) Kunde;
   * 2. anonym + genau EIN aktiver Kunde mit der normalisierten E-Mail ⇒ dieser, Stammdaten
   * bleiben unverändert; 3. kein Treffer ⇒ neuer Kunde; 4. mehrere ⇒ neuer Kunde mit
   * interner Dublettenwarnung. Keine öffentliche Aussage „E-Mail existiert bereits“.
   */
  private async resolveCustomer(
    tx: DatabaseTransaction,
    snapshot: PublicInquiryContactSnapshot,
    portalCustomerId: string | null,
  ): Promise<{ customerId: string; customerMatch: PublicInquiryCustomerMatch }> {
    if (portalCustomerId !== null) {
      const active = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, portalCustomerId), isNull(customers.deletedAt)));
      if (active[0] !== undefined) {
        return { customerId: active[0].id, customerMatch: 'portal_session' };
      }
      // Kunde inzwischen gelöscht ⇒ wie eine anonyme Anfrage behandeln (nichts erraten).
    }
    const matches = await this.customers.activeCustomerIdsByEmail(tx, snapshot.email, 2);
    if (matches.length === 1 && matches[0] !== undefined) {
      return { customerId: matches[0], customerMatch: 'email_unique' };
    }
    const created = await this.customers.createCustomerWithin(tx, customerInputOf(snapshot));
    return {
      customerId: created.id,
      customerMatch: matches.length === 0 ? 'new_customer' : 'new_customer_email_ambiguous',
    };
  }
}

// ── Staff-Hinweis (Design §3.4) ─────────────────────────────────────────────

export interface WebsiteSubmissionView {
  submittedAt: string;
  customerMatch: PublicInquiryCustomerMatch;
  duplicateWarning: boolean;
  contactSnapshot: PublicInquiryContactSnapshot;
  /** Feldnamen, in denen der Snapshot vom aktuellen CRM-Kunden abweicht. */
  differences: string[];
  privacy: { acknowledgedAt: string; revisionNumber: number };
}

/** Abweichungen Snapshot ↔ aktueller CRM-Kunde (nur Feldnamen; Telefon normalisiert verglichen). */
export function contactDifferences(
  snapshot: PublicInquiryContactSnapshot,
  customer: {
    type: 'private' | 'organization';
    firstName: string | null;
    lastName: string | null;
    organizationName: string | null;
    contactPerson: string | null;
    email: string | null;
    phoneNormalized: string | null;
  },
): string[] {
  const differences: string[] = [];
  if (snapshot.type !== customer.type) differences.push('type');
  if (snapshot.type === 'private') {
    if (snapshot.firstName !== (customer.firstName ?? '')) differences.push('firstName');
    if (snapshot.lastName !== (customer.lastName ?? '')) differences.push('lastName');
  } else {
    if (snapshot.organizationName !== (customer.organizationName ?? '')) {
      differences.push('organizationName');
    }
    if (snapshot.contactPerson !== (customer.contactPerson ?? ''))
      differences.push('contactPerson');
  }
  if (snapshot.email !== (customer.email ?? '')) differences.push('email');
  if (normalizePhoneNumber(snapshot.phone) !== customer.phoneNormalized) differences.push('phone');
  return differences;
}

/** Website-Anfrage eines Vorgangs für die Staff-Inquiry-Ansicht – `null` ohne Submission. */
export async function loadWebsiteSubmissionView(
  db: Database,
  processId: string,
): Promise<WebsiteSubmissionView | null> {
  const rows = await db
    .select({
      submission: publicInquirySubmissions,
      revisionNumber: cmsRevisions.revisionNumber,
      customer: customers,
    })
    .from(publicInquirySubmissions)
    .innerJoin(cmsRevisions, eq(cmsRevisions.id, publicInquirySubmissions.privacyRevisionId))
    .innerJoin(customers, eq(customers.id, publicInquirySubmissions.customerId))
    .where(eq(publicInquirySubmissions.processId, processId));
  const row = rows[0];
  if (row === undefined) return null;
  const snapshot = row.submission.contactSnapshot as PublicInquiryContactSnapshot;
  return {
    submittedAt: row.submission.createdAt.toISOString(),
    customerMatch: row.submission.customerMatch,
    duplicateWarning: row.submission.customerMatch === 'new_customer_email_ambiguous',
    contactSnapshot: snapshot,
    differences: contactDifferences(snapshot, row.customer),
    privacy: {
      acknowledgedAt: row.submission.privacyAcknowledgedAt.toISOString(),
      revisionNumber: row.revisionNumber,
    },
  };
}
