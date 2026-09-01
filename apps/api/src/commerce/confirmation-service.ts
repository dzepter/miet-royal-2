import {
  bookings,
  orderConfirmations,
  processes,
  type Booking,
  type Database,
  type DatabaseTransaction,
  type OrderConfirmation,
} from '@mietroyal/database';
import type { AppConfig } from '@mietroyal/config';
import { renderOrderConfirmationPdf, type PdfLineItem } from '@mietroyal/documents';
import { eq } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import { getPickupExactAddress } from '../crm/settings-service.ts';
import type { DocumentService } from './document-service.ts';
import type { OfferDeliveryGateway } from './delivery-gateway.ts';

/**
 * Auftragsbestätigung (Phase-3-Vorgaben Nr. 31–33/35): nach Annahme
 * automatisch vorbereitet, vom Mitarbeiter FREIZUGEBEN, danach fachlicher
 * Versand über den Adapter. Bei Selbstabholung braucht die AB die
 * konfigurierte exakte Abholadresse (pickup_exact_address) – sonst wird
 * die Freigabe mit einem verständlichen Konfigurationsfehler blockiert.
 * Die exakte Adresse erscheint erst hier, NIE im öffentlichen Angebot.
 */

/** Transporthinweise bei Selbstabholung (Vorgabe Nr. 32). */
export function transportNotes(machineSnapshot: {
  name?: unknown;
  carryPersons?: unknown;
  weightGrams?: unknown;
}): string[] {
  const notes = [
    'Maschine immer aufrecht transportieren.',
    'Maschine gegen Umkippen sichern.',
    'Nur im Kofferraum oder auf der Ladefläche transportieren – NICHT auf der Rückbank, NICHT im Fußraum.',
  ];
  const carry = machineSnapshot.carryPersons;
  if (typeof carry === 'number' && carry > 0) {
    notes.push(
      carry === 1
        ? 'Eine Person zum Tragen ausreichend.'
        : `${carry} Personen zum Tragen erforderlich.`,
    );
  }
  const weight = machineSnapshot.weightGrams;
  if (typeof weight === 'number' && weight > 0) {
    const kilos = Math.round(weight / 100) / 10;
    notes.push(`Gewicht: ca. ${String(kilos).replace('.', ',')} kg.`);
  }
  return notes;
}

function berlinDateTime(iso: unknown): string | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

function berlinTime(iso: unknown): string | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface BookingSnapshotItem {
  description: string;
  quantity: number;
  unit: string;
  agreedUnitPriceCents: number;
  totalCents: number;
  billingMode: 'fixed' | 'commission' | 'included';
  kind: string;
  productSnapshot?: Record<string, unknown> | null;
}

export class OrderConfirmationService {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly documentService: DocumentService,
    private readonly gateway: OfferDeliveryGateway,
  ) {}

  async byBookingId(bookingId: string): Promise<OrderConfirmation | null> {
    const rows = await this.db
      .select()
      .from(orderConfirmations)
      .where(eq(orderConfirmations.bookingId, bookingId));
    return rows[0] ?? null;
  }

  async byId(id: string): Promise<OrderConfirmation> {
    const rows = await this.db
      .select()
      .from(orderConfirmations)
      .where(eq(orderConfirmations.id, id));
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Auftragsbestätigung nicht gefunden.');
    return row;
  }

  /** Vorgangs-ID zur AB – für die zentrale Sichtbarkeitsprüfung der Routen. */
  async processIdFor(confirmationId: string): Promise<string> {
    const confirmation = await this.byId(confirmationId);
    const booking = await this.bookingById(confirmation.bookingId);
    return booking.processId;
  }

  private async bookingById(bookingId: string): Promise<Booking> {
    const rows = await this.db.select().from(bookings).where(eq(bookings.id, bookingId));
    const booking = rows[0];
    if (booking === undefined) throw new AuthError('NOT_FOUND', 'Buchung nicht gefunden.');
    return booking;
  }

  /** Prüfvorschau: Was fehlt für die Freigabe? (UI-Hinweise, Vorgabe Nr. 41). */
  async readinessFor(confirmation: OrderConfirmation): Promise<{ blockers: string[] }> {
    const booking = await this.bookingById(confirmation.bookingId);
    const blockers: string[] = [];
    if (booking.fulfillment === 'pickup') {
      const address = await getPickupExactAddress(this.db);
      if (address === null) {
        blockers.push(
          'Die exakte Abholadresse (pickup_exact_address) ist nicht konfiguriert. Ohne sie kann keine Selbstabhol-AB freigegeben werden.',
        );
      }
    }
    return { blockers };
  }

  /**
   * AB-PDF-Bytes aus dem Buchungs-Snapshot bauen (Freigabe UND Vorschau).
   * `pickupAddress === null` bei Selbstabholung ist nur in der Vorschau
   * zulässig und wird dort als Konfigurationslücke markiert – nie erfunden.
   */
  private async renderPdf(
    confirmation: OrderConfirmation,
    booking: Booking,
    pickupAddress: string | null,
    now: Date,
  ): Promise<Buffer> {
    const processRows = await this.db
      .select({ processNumber: processes.processNumber, id: processes.id })
      .from(processes)
      .where(eq(processes.id, booking.processId));
    const process = processRows[0];
    if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');

    const customer = booking.customerSnapshot as Record<string, unknown>;
    const event = booking.eventSnapshot as Record<string, unknown>;
    const items = booking.itemsSnapshot as BookingSnapshotItem[];
    const totals = booking.totalsSnapshot as Record<string, unknown>;
    const delivery = (booking.deliverySnapshot ?? {}) as Record<string, unknown>;
    const machineItem = items.find((item) => item.kind === 'machine');

    const pdfItems: PdfLineItem[] = items.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      agreedUnitPriceCents: item.agreedUnitPriceCents,
      totalCents: item.totalCents,
      billingMode: item.billingMode,
    }));

    // Eventzeiten + Zeitfenster aus dem Snapshot (Vorgabe Nr. 31: „Zeiten“).
    const start = berlinTime(event.eventStart);
    const end = berlinTime(event.eventEnd);
    const eventTimeLabel =
      start === null && end === null ? null : `${start ?? '–'} bis ${end ?? '–'} Uhr`;
    const scheduleLines: string[] = [];
    const deliveryFrom = berlinDateTime(event.deliveryWindowFrom);
    const deliveryTo = berlinDateTime(event.deliveryWindowTo);
    if (deliveryFrom !== null || deliveryTo !== null) {
      scheduleLines.push(`Lieferfenster: ${deliveryFrom ?? '–'} bis ${deliveryTo ?? '–'}`);
    }
    const collectionFrom = berlinDateTime(event.collectionWindowFrom);
    const collectionTo = berlinDateTime(event.collectionWindowTo);
    if (collectionFrom !== null || collectionTo !== null) {
      scheduleLines.push(`Abholfenster: ${collectionFrom ?? '–'} bis ${collectionTo ?? '–'}`);
    }

    const deliveryAddressLines: string[] = [];
    if (booking.fulfillment === 'delivery') {
      const street = String(delivery.street ?? '');
      const cityLine = [delivery.postalCode, delivery.city].filter(Boolean).join(' ');
      if (street !== '') deliveryAddressLines.push(`Lieferadresse: ${street}`);
      if (cityLine !== '') deliveryAddressLines.push(cityLine);
    }

    return renderOrderConfirmationPdf({
      processNumber: process.processNumber,
      customerName: String(customer.displayName ?? ''),
      customerAddressLines: [
        String(customer.billingStreet ?? '') || null,
        [customer.billingPostalCode, customer.billingCity].filter(Boolean).join(' ') || null,
      ].filter((line): line is string => line !== null),
      eventDateLabel: String(event.eventDate ?? '–'),
      eventTimeLabel,
      fulfillmentLabel: booking.fulfillment === 'pickup' ? 'Selbstabholung' : 'Lieferung',
      deliveryAddressLines,
      scheduleLines,
      pickupAddress:
        booking.fulfillment === 'pickup'
          ? (pickupAddress ?? 'NICHT KONFIGURIERT (pickup_exact_address fehlt)')
          : null,
      transportNotes:
        booking.fulfillment === 'pickup'
          ? transportNotes((machineItem?.productSnapshot ?? {}) as Record<string, unknown>)
          : [],
      lineItems: pdfItems,
      machineSubtotalCents: Number(totals.machineSubtotalCents ?? 0),
      // Interner Rabattgrund bleibt intern – Kundendokument nur mit Betrag.
      discountCents: Number(totals.discountCents ?? 0),
      discountLabel: null,
      fixedTotalCents: Number(totals.fixedTotalCents ?? 0),
      commissionMaxCents: items
        .filter((item) => item.billingMode === 'commission')
        .reduce((sum, item) => sum + item.totalCents, 0),
      acceptedAtLabel: booking.acceptedAt.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }),
      createdAtLabel: now.toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }),
    });
  }

  /**
   * Prüfvorschau als PDF (Vorgabe Nr. 41 „ansehen“): rendert den aktuellen
   * Stand on-the-fly, ohne Speicherung/Finalisierung. Eine fehlende
   * Abholadresse wird sichtbar markiert statt erfunden.
   */
  async renderPreviewPdf(confirmationId: string, now = new Date()): Promise<Buffer> {
    const confirmation = await this.byId(confirmationId);
    const booking = await this.bookingById(confirmation.bookingId);
    const pickupAddress =
      booking.fulfillment === 'pickup' ? await getPickupExactAddress(this.db) : null;
    return this.renderPdf(confirmation, booking, pickupAddress, now);
  }

  /**
   * Freigabe: erzeugt das finale AB-PDF (immutable) und setzt den Status.
   * Zeile wird gesperrt und der Status UNTER der Sperre geprüft – parallele
   * Freigaben (Doppelklick) erzeugen nie zwei finale AB-PDFs.
   */
  async approve(actorId: string, confirmationId: string, now = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const confirmation = await this.lockConfirmation(tx, confirmationId);
      if (confirmation.status !== 'prepared') {
        throw new AuthError('CONFLICT', 'Diese Auftragsbestätigung ist bereits freigegeben.');
      }
      const booking = await this.bookingById(confirmation.bookingId);

      let pickupAddress: string | null = null;
      if (booking.fulfillment === 'pickup') {
        pickupAddress = await getPickupExactAddress(this.db);
        if (pickupAddress === null) {
          // Keine Adresse erfinden – klare Konfigurationsblockade (Nr. 33).
          throw new AuthError(
            'CONFLICT',
            'Freigabe nicht möglich: Die exakte Abholadresse (pickup_exact_address) ist nicht konfiguriert.',
          );
        }
      }

      const bytes = await this.renderPdf(confirmation, booking, pickupAddress, now);
      const document = await this.documentService.createFinalDocument({
        type: 'order_confirmation',
        processId: booking.processId,
        bookingId: booking.id,
        storageKey: `documents/order-confirmations/${confirmation.id}-${now.getTime()}.pdf`,
        bytes,
      });

      await tx
        .update(orderConfirmations)
        .set({
          status: 'approved',
          approvedBy: actorId,
          approvedAt: now,
          documentId: document.id,
          updatedAt: now,
        })
        .where(eq(orderConfirmations.id, confirmationId));
    });
  }

  /** Fachlicher Versand über den Phase-3-Adapter (nach Freigabe, serialisiert). */
  async send(confirmationId: string, now = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const confirmation = await this.lockConfirmation(tx, confirmationId);
      if (confirmation.status !== 'approved') {
        throw new AuthError('CONFLICT', 'Die Auftragsbestätigung muss zuerst freigegeben werden.');
      }
      const booking = await this.bookingById(confirmation.bookingId);
      const processRows = await this.db
        .select({ processNumber: processes.processNumber })
        .from(processes)
        .where(eq(processes.id, booking.processId));
      const customer = booking.customerSnapshot as Record<string, unknown>;
      const recipient = String(customer.email ?? '');
      if (recipient === '') {
        throw new AuthError('CONFLICT', 'Für den Versand fehlt die Kunden-E-Mail im Snapshot.');
      }
      const processNumber = processRows[0]?.processNumber ?? '';
      // Kein „anbei“: Der Adapter transportiert derzeit keine Anhänge; der
      // echte Mail-Adapter (spätere Phase) hängt das finale AB-PDF an.
      await this.gateway.deliver({
        kind: 'order_confirmation',
        orderConfirmationId: confirmation.id,
        recipient,
        subject: `Ihre Miet-Royal-Auftragsbestätigung ${processNumber}`,
        body:
          `Guten Tag ${String(customer.displayName ?? '')},\n\n` +
          `Ihre Auftragsbestätigung für Vorgang ${processNumber} wurde freigegeben. ` +
          `Sie erhalten das Dokument von Miet-Royal.\n`,
      });
      await tx
        .update(orderConfirmations)
        .set({ status: 'sent', sentAt: now, updatedAt: now })
        .where(eq(orderConfirmations.id, confirmationId));
    });
  }

  private async lockConfirmation(
    tx: DatabaseTransaction,
    confirmationId: string,
  ): Promise<OrderConfirmation> {
    // FOR NO KEY UPDATE statt FOR UPDATE: serialisiert Freigabe/Versand
    // untereinander, kollidiert aber nicht mit dem FK-KEY-SHARE-Lock des
    // Outbox-Inserts (der über eine eigene Pool-Verbindung läuft).
    const rows = await tx
      .select()
      .from(orderConfirmations)
      .where(eq(orderConfirmations.id, confirmationId))
      .for('no key update');
    const row = rows[0];
    if (row === undefined) throw new AuthError('NOT_FOUND', 'Auftragsbestätigung nicht gefunden.');
    return row;
  }
}
