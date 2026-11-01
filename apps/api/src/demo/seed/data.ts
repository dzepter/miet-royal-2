/**
 * Phase 14 (Order §9/§13): synthetische Stammwerte und stabile Seed-Schlüssel
 * des kanonischen Demo-Datensatzes.
 *
 * - Namen sind erfunden (keine realen Personen), E-Mails ausschließlich unter
 *   den reservierten Beispieldomains example.com / example.invalid – oder, für
 *   die Kunden der Mail-Übungsszenarien, unter der konfigurierten Demo-
 *   Testdomain (`MAIL_DEMO_WHITELIST`, siehe `demoCustomerEmail`); Telefon
 *   nur dort, wo ein Fachflow sie zwingend verlangt (aktuell: nirgends).
 * - Adressen sind synthetisch; PLZ/Ort im Mainzer Umfeld, damit der Routing-
 *   Mock (Phase 13) deterministische Punkte liefert: „Robert-Koch“ ⇒ Depot,
 *   „Lieferweg“ ⇒ Kundenpunkt, „Am Markt 1, 55116 Mainz“ ist im Mock bewusst
 *   mehrdeutig (Geocoding-Prüfszenario für die Tourenplanung).
 * - Seed-Schlüssel folgen der Konvention `<bereich>.<szenario>[.<variante>]`
 *   (Design §2); Training/Admin-UI referenzieren Szenarien nur darüber.
 */

import type { AppConfig } from '@mietroyal/config';

/** Depot/Abholadresse (Setting `pickup_exact_address`) – klar als SYNTHETISCH markiert. */
export const DEMO_DEPOT_ADDRESS = 'Robert-Koch-Straße 1, 55129 Mainz (SYNTHETISCH)';

/** Mietbedingungen-Platzhalter, falls die Demo-DB noch keine Version hat (nie ein Rechtstext). */
export const DEMO_TERMS_LABEL = 'TEST-Platzhalter Demo v1';
export const DEMO_TERMS_CONTENT =
  'TEST – Platzhalter-Mietbedingungen der Demo-Umgebung. Kein echter Rechtstext.';

/** Synthetische Lieferadressen (Mock-Geocoding: Hausnummer + PLZ/Ort ⇒ aufgelöst). */
export const DEMO_ADDRESSES = {
  lieferweg12: { street: 'Lieferweg 12', postalCode: '55129', city: 'Mainz' },
  lieferweg34: { street: 'Lieferweg 34', postalCode: '55129', city: 'Mainz' },
  vereinsstrasse: { street: 'Vereinsstraße 10', postalCode: '55218', city: 'Ingelheim am Rhein' },
  /** Im Mock mehrdeutig (ohne eindeutigen Treffer) – Prüfszenario „Adresse prüfen“. */
  amMarkt: { street: 'Am Markt 1', postalCode: '55116', city: 'Mainz' },
  demoWerke: { street: 'Industriestraße 77', postalCode: '55120', city: 'Mainz' },
} as const;

export interface DemoCustomerSpec {
  key: string;
  type: 'private' | 'organization';
  firstName?: string;
  lastName?: string;
  organizationName?: string;
  contactPerson?: string;
  email: string;
  billingStreet: string;
  billingPostalCode: string;
  billingCity: string;
  vatId?: string;
  department?: string;
  orderReference?: string;
}

/**
 * Synthetische Kunden (alle E-Mails unter example.com / example.invalid; kein
 * Telefon). Die Kunden der Mail-Übungsszenarien erhalten im Seed über
 * `withDemoTestAddress` ggf. die konfigurierte Demo-Testdomain (Order §9).
 */
export const DEMO_CUSTOMERS = {
  privateBasic: {
    key: 'customer.private.basic',
    type: 'private',
    firstName: 'Lena',
    lastName: 'Beispiel',
    email: 'lena.beispiel@example.com',
    billingStreet: 'Musterweg 3',
    billingPostalCode: '55128',
    billingCity: 'Mainz',
  },
  orgBasic: {
    key: 'customer.org.basic',
    type: 'organization',
    organizationName: 'Musterverein Rheinhessen e. V.',
    contactPerson: 'Jonas Vorstand',
    email: 'verein@example.com',
    billingStreet: 'Vereinsstraße 10',
    billingPostalCode: '55218',
    billingCity: 'Ingelheim am Rhein',
    orderReference: 'Sommerfest',
  },
  privateRepeat: {
    key: 'customer.private.repeat',
    type: 'private',
    firstName: 'Tobias',
    lastName: 'Stammkunde',
    email: 'tobias.stammkunde@example.com',
    billingStreet: 'Wiederholungsgasse 8',
    billingPostalCode: '55122',
    billingCity: 'Mainz',
  },
  offerSent: {
    key: 'customer.private.offer_sent',
    type: 'private',
    firstName: 'Hannah',
    lastName: 'Testerin',
    email: 'hannah.testerin@example.com',
    billingStreet: 'Probeweg 5',
    billingPostalCode: '55131',
    billingCity: 'Mainz',
  },
  bookingPickup: {
    key: 'customer.private.booking_pickup',
    type: 'private',
    firstName: 'Omar',
    lastName: 'Beispielmann',
    email: 'omar.beispielmann@example.com',
    billingStreet: 'Fiktivstraße 21',
    billingPostalCode: '55127',
    billingCity: 'Mainz',
  },
  bookingDelivery: {
    key: 'customer.org.booking_delivery',
    type: 'organization',
    organizationName: 'Kita Sonnenschein (Demo)',
    contactPerson: 'Sandra Leitung',
    email: 'kita.sonnenschein@example.com',
    billingStreet: 'Lieferweg 12',
    billingPostalCode: '55129',
    billingCity: 'Mainz',
    department: 'Elternbeirat',
  },
  deliverySecond: {
    key: 'customer.private.delivery_second',
    type: 'private',
    firstName: 'Sofia',
    lastName: 'Musterfrau',
    email: 'sofia.musterfrau@example.invalid',
    billingStreet: 'Am Markt 1',
    billingPostalCode: '55116',
    billingCity: 'Mainz',
  },
  handoverReady: {
    key: 'customer.private.handover_ready',
    type: 'private',
    firstName: 'Felix',
    lastName: 'Platzhalter',
    email: 'felix.platzhalter@example.com',
    billingStreet: 'Lieferweg 34',
    billingPostalCode: '55129',
    billingCity: 'Mainz',
  },
  rentalActive: {
    key: 'customer.private.rental_active',
    type: 'private',
    firstName: 'Nadine',
    lastName: 'Erstmieter',
    email: 'nadine.erstmieter@example.com',
    billingStreet: 'Erstmietweg 2',
    billingPostalCode: '55126',
    billingCity: 'Mainz',
  },
  returnDue: {
    key: 'customer.private.return_due',
    type: 'private',
    firstName: 'Paul',
    lastName: 'Fiktiv',
    email: 'paul.fiktiv@example.invalid',
    billingStreet: 'Lieferweg 12',
    billingPostalCode: '55129',
    billingCity: 'Mainz',
  },
  returnOverdue: {
    key: 'customer.org.return_overdue',
    type: 'organization',
    organizationName: 'Sportverein Demo-Stadt 08 e. V.',
    contactPerson: 'Karim Kassenwart',
    email: 'sportverein@example.com',
    billingStreet: 'Sportplatzweg 1',
    billingPostalCode: '55130',
    billingCity: 'Mainz',
    orderReference: 'Vereinsturnier',
  },
  returnDamage: {
    key: 'customer.private.return_damage',
    type: 'private',
    firstName: 'Miriam',
    lastName: 'Demoperson',
    email: 'miriam.demoperson@example.com',
    billingStreet: 'Schadensweg 14',
    billingPostalCode: '55124',
    billingCity: 'Mainz',
  },
  returnMissing: {
    key: 'customer.private.return_missing',
    type: 'private',
    firstName: 'Jana',
    lastName: 'Beispielhaft',
    email: 'jana.beispielhaft@example.com',
    billingStreet: 'Fehlteilgasse 9',
    billingPostalCode: '55118',
    billingCity: 'Mainz',
  },
  settlementReview: {
    key: 'customer.org.settlement_review',
    type: 'organization',
    organizationName: 'Beispiel-Werke GmbH (Demo)',
    contactPerson: 'Dr. Petra Prüfung',
    email: 'einkauf@example.invalid',
    billingStreet: 'Industriestraße 77',
    billingPostalCode: '55120',
    billingCity: 'Mainz',
    vatId: 'DE000000000',
    department: 'Einkauf',
    orderReference: 'PO-DEMO-0815',
  },
  cleaningPending: {
    key: 'customer.private.cleaning_pending',
    type: 'private',
    firstName: 'Daniel',
    lastName: 'Probehalber',
    email: 'daniel.probehalber@example.com',
    billingStreet: 'Reinigungsring 6',
    billingPostalCode: '55129',
    billingCity: 'Mainz',
  },
} as const satisfies Record<string, DemoCustomerSpec>;

/**
 * Phase 14 (Order §9 „konfigurierte Demo-Testadresse“, §25/§78/§79; Review-Fix
 * F8): Kunden der Trainingsszenarien mit Mailabläufen – Kundeninformation der
 * Abrechnung (Belastung ⇒ Versand ⇒ Wartefenster) und Kommunikationsantworten –
 * brauchen in der Demo eine ERREICHBARE Adresse, sonst bleibt jede Mail
 * `blocked` (DEMO_NOT_WHITELISTED) und die Übung endet in einer Sackgasse.
 *
 * Regel: Enthält `MAIL_DEMO_WHITELIST` der Demo-Konfiguration mindestens einen
 * `@domain`-Eintrag, lautet die Adresse `<lokalteil>@<erste Whitelist-Domain>`
 * (Lokalteil wie bisher, z. B. `einkauf`); sonst bleibt die reservierte
 * Beispieldomain (example.com / example.invalid). Vollständige Whitelist-
 * Adressen (`tester@…`) werden NIE vergeben (sie gehören einem echten
 * Testpostfach und dürfen nicht mehrfach an Kunden gehen); andere reale
 * Domains nie. Außerhalb von `APP_ENV=demo` ist die Whitelist leer – der Seed
 * läuft dort ohnehin nicht.
 */
export function demoWhitelistDomain(config: Pick<AppConfig, 'appEnv' | 'mail'>): string | null {
  if (config.appEnv !== 'demo') return null;
  for (const entry of config.mail.demoWhitelist) {
    const normalized = entry.trim().toLowerCase();
    if (normalized.startsWith('@') && normalized.length > 1) return normalized.slice(1);
  }
  return null;
}

/** `<lokalteil>@<erste Whitelist-Domain>` oder `<lokalteil>@<fallbackDomain>` (Order §9). */
export function demoCustomerEmail(
  config: Pick<AppConfig, 'appEnv' | 'mail'>,
  localPart: string,
  fallbackDomain: string,
): string {
  return `${localPart}@${demoWhitelistDomain(config) ?? fallbackDomain}`;
}

/**
 * Kundenspezifikation mit Demo-Testadresse – NUR für die Mail-Übungsszenarien
 * (`DEMO_MAIL_EXERCISE_CUSTOMERS`); alle übrigen Kunden behalten ihre
 * Beispieldomain, damit die Demo auch blockierte Zustellungen zeigt.
 */
export function withDemoTestAddress(
  config: Pick<AppConfig, 'appEnv' | 'mail'>,
  spec: DemoCustomerSpec,
): DemoCustomerSpec {
  const at = spec.email.lastIndexOf('@');
  return {
    ...spec,
    email: demoCustomerEmail(config, spec.email.slice(0, at), spec.email.slice(at + 1)),
  };
}

/**
 * Kunden, deren Szenarien Mailabläufe üben (Order §78/§79): Lena Beispiel
 * (`conversation.email.unanswered` zu `process.inquiry.new`), Musterverein
 * (`conversation.email.inbound`/`.reply` zu `process.offer.draft`), Rückgabe mit
 * Schaden / Fehlteil (Kundeninformation bei Belastung) und Beispiel-Werke GmbH
 * (`process.settlement.review`). `process.offer.sent` bleibt bewusst auf der
 * Beispieldomain (eine sichtbar blockierte Angebotsmail je Seed).
 */
export const DEMO_MAIL_EXERCISE_CUSTOMERS: readonly DemoCustomerSpec[] = [
  DEMO_CUSTOMERS.privateBasic,
  DEMO_CUSTOMERS.orgBasic,
  DEMO_CUSTOMERS.returnDamage,
  DEMO_CUSTOMERS.returnMissing,
  DEMO_CUSTOMERS.settlementReview,
];

/** Stabile Seed-Schlüssel (Design §2) – Training/Admin-UI referenzieren nur diese. */
export const DEMO_SEED_KEYS = {
  // Kunden
  customerPrivateBasic: DEMO_CUSTOMERS.privateBasic.key,
  customerOrgBasic: DEMO_CUSTOMERS.orgBasic.key,
  customerPrivateRepeat: DEMO_CUSTOMERS.privateRepeat.key,
  // Vorgänge
  processInquiryNew: 'process.inquiry.new',
  processOfferDraft: 'process.offer.draft',
  processOfferSent: 'process.offer.sent',
  processBookingAcceptedPickup: 'process.booking.accepted.pickup',
  processBookingAcceptedDelivery: 'process.booking.accepted.delivery',
  processDeliverySecond: 'process.booking.accepted.delivery_second',
  processHandoverReady: 'process.handover.ready',
  processRentalActive: 'process.rental.active',
  processReturnDue: 'process.return.due',
  processReturnOverdue: 'process.return.overdue',
  processReturnDamage: 'process.return.damage',
  processReturnMissingPart: 'process.return.missing_part',
  processCleaningPending: 'process.cleaning.pending',
  processSettlementReview: 'process.settlement.review',
  processCompleted: 'process.completed',
  processRepeatSecond: 'process.repeat.second',
  // Termine
  appointmentDeliveryToday: 'appointment.delivery.today',
  appointmentDeliveryTodaySecond: 'appointment.delivery.today_second',
  appointmentDeliveryTomorrow: 'appointment.delivery.tomorrow',
  appointmentReturnUnplanned: 'appointment.return.unplanned',
  appointmentReturnPlanned: 'appointment.return.planned',
  appointmentReturnDueToday: 'appointment.return.due_today',
  appointmentReturnOverdue: 'appointment.return.overdue',
  // Kommunikation
  conversationEmailInbound: 'conversation.email.inbound',
  conversationEmailReply: 'conversation.email.reply',
  conversationEmailUnanswered: 'conversation.email.unanswered',
  // Touren
  tourTodayMultiStop: 'tour.today.multi_stop',
  tourFuturePlanned: 'tour.future.planned',
  // Lager
  inventoryStocktakeInitial: 'inventory.stocktake.initial',
  inventoryMovementIncoming: 'inventory.movement.incoming',
  inventoryItemLowStock: 'inventory.item.low_stock',
  // Maschinenzustände
  machineReadyBasic: 'machine.ready.basic',
  machineAssigned: 'machine.assigned',
  machineReserved: 'machine.reserved',
  machineRented: 'machine.rented',
  machineCleaning: 'machine.cleaning',
  machineCleaningOverdue: 'machine.cleaning.overdue',
  machineBlocked: 'machine.blocked',
  // Abrechnung
  settlementReview: 'settlement.review',
  settlementDamage: 'settlement.damage',
  settlementMissingPart: 'settlement.missing_part',
  // Gutschein-Situation (Phase 14, Order W1.1): synthetischer Fixture-Gutschein des
  // Wiedermieters – ausschließlich über die Demo-Seed-Fixture-Schicht (fixtures/voucher-fixture.ts).
  voucherSituation: 'voucher.situation',
} as const;

export type DemoSeedKeyName = (typeof DEMO_SEED_KEYS)[keyof typeof DEMO_SEED_KEYS];

/**
 * Pflicht-Szenarien (Order §10) – jeder dieser Schlüssel muss nach dem Seed in
 * der Registry stehen. „voucher.situation“ (Gutschein-Situation) entsteht seit
 * W1.1 als synthetischer Fixture-Gutschein (kein Mock-Transfer, kein
 * Zahlungsstatus „bezahlt“ – in der Demo gibt es keine Buchhaltungsübertragung).
 */
export const REQUIRED_DEMO_SEED_KEYS: readonly string[] = [
  DEMO_SEED_KEYS.customerPrivateBasic,
  DEMO_SEED_KEYS.customerOrgBasic,
  DEMO_SEED_KEYS.customerPrivateRepeat,
  DEMO_SEED_KEYS.processInquiryNew,
  DEMO_SEED_KEYS.processOfferDraft,
  DEMO_SEED_KEYS.processOfferSent,
  DEMO_SEED_KEYS.processBookingAcceptedPickup,
  DEMO_SEED_KEYS.processBookingAcceptedDelivery,
  DEMO_SEED_KEYS.processHandoverReady,
  DEMO_SEED_KEYS.processRentalActive,
  DEMO_SEED_KEYS.processReturnDue,
  DEMO_SEED_KEYS.processReturnOverdue,
  DEMO_SEED_KEYS.processReturnDamage,
  DEMO_SEED_KEYS.processReturnMissingPart,
  DEMO_SEED_KEYS.processCleaningPending,
  DEMO_SEED_KEYS.processSettlementReview,
  DEMO_SEED_KEYS.processCompleted,
  DEMO_SEED_KEYS.processRepeatSecond,
  DEMO_SEED_KEYS.appointmentReturnPlanned,
  DEMO_SEED_KEYS.appointmentReturnDueToday,
  DEMO_SEED_KEYS.appointmentReturnOverdue,
  DEMO_SEED_KEYS.conversationEmailInbound,
  DEMO_SEED_KEYS.conversationEmailReply,
  DEMO_SEED_KEYS.tourTodayMultiStop,
  DEMO_SEED_KEYS.tourFuturePlanned,
  DEMO_SEED_KEYS.inventoryStocktakeInitial,
  DEMO_SEED_KEYS.inventoryMovementIncoming,
  DEMO_SEED_KEYS.inventoryItemLowStock,
  DEMO_SEED_KEYS.machineReadyBasic,
  DEMO_SEED_KEYS.machineAssigned,
  DEMO_SEED_KEYS.machineReserved,
  DEMO_SEED_KEYS.machineRented,
  DEMO_SEED_KEYS.machineCleaning,
  DEMO_SEED_KEYS.machineBlocked,
  DEMO_SEED_KEYS.voucherSituation,
];

/**
 * Maschinenbelegung des kanonischen Datensatzes (11 Seed-Maschinen der
 * Migration 0010; Codes sind Stammdaten, der Seed wählt nie neue Codes).
 */
export const DEMO_MACHINES = {
  handoverReady: 'MR-10-01-01', // reserviert (Ausgabe vorbereitet)
  rentalActive: 'MR-10-01-02', // vermietet
  returnDue: 'MR-10-01-03', // vermietet, Rückgabe heute fällig
  returnOverdue: 'MR-10-01-04', // vermietet, Rückgabe überfällig
  returnDamage: 'MR-10-01-05', // Reinigung (> 24 h, Warnung) nach Rückgabe mit Schaden
  returnMissing: 'MR-10-01-06', // Reinigung nach Rückgabe mit Fehlteil
  settlementReview: 'MR-10-02-01', // Reinigung nach Rückgabe mit Schaden + Fehlteil + Reinigungsmangel
  blocked: 'MR-10-02-02', // Reparatur + manuelle Sperre mit Grund
  cleaningPending: 'MR-08-01-01', // Reinigung (frisch, keine Warnung)
  readyAfterCleaning: 'MR-08-01-02', // gereinigt & einsatzbereit (abgeschlossener Vorgang)
  assigned: 'MR-08-02-01', // zugeordnet (nicht vorbereitet), Status bleibt einsatzbereit
} as const;

/** Manuelle Sperre (Order §12/§13: Zeitraum + Pflichtgrund). */
export const DEMO_MACHINE_BLOCK_REASON =
  'Dichtung am Zapfhahn undicht – Ersatzteil bestellt (DEMO-Sperre, synthetisch)';

/** Lagerbestände der Erstinventur (ganze Lagereinheiten). */
export const DEMO_INITIAL_STOCK: Record<string, number> = {
  'sirup-wassermelone': 24,
  'sirup-kirsche': 24,
  'sirup-waldmeister': 18,
  'sirup-blaue-himbeere': 18,
  'becher-25': 30,
  'strohhalme-25': 30,
  'mischkanister-6l': 20,
};
/** Wareneingang nach der Inventur (Bewegung „incoming“). */
export const DEMO_INCOMING = { slug: 'becher-25', quantity: 20 } as const;
/** Mindestbestand ÜBER dem Bestand ⇒ Warnung „Mindestbestand unterschritten“. */
export const DEMO_LOW_STOCK = { slug: 'mischkanister-6l', minStock: 25 } as const;
/** Mindestbestände ohne Warnung. */
export const DEMO_MIN_STOCK: Record<string, number> = {
  'sirup-wassermelone': 6,
  'sirup-kirsche': 6,
  'becher-25': 10,
  'strohhalme-25': 10,
};
