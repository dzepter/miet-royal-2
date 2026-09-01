import { createHash, randomBytes } from 'node:crypto';
import {
  bookings,
  customers,
  documents,
  inquiries,
  inquirySelections,
  offerAccessTokens,
  offerLineItems,
  offers,
  offerVersions,
  offerVersionSelections,
  orderConfirmations,
  processes,
  type Booking,
  type Database,
  type DatabaseTransaction,
  type Offer,
  type OfferVersion,
} from '@mietroyal/database';
import type { AppConfig } from '@mietroyal/config';
import {
  discountNeedsApproval,
  discountNeedsReason,
  offerExpiresAt,
  priceOffer,
  PricingError,
  type PricingResult,
  type PricingSelection,
  type SpecialPriceEntry,
} from '@mietroyal/domain';
import { renderOfferPdf, formatEuro, type PdfLineItem } from '@mietroyal/documents';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { AuthError } from '../auth/service.ts';
import { customerDisplayName } from '../crm/customer-service.ts';
import type { DocumentService } from './document-service.ts';
import type { OfferDeliveryGateway } from './delivery-gateway.ts';
import { ProductService } from './product-service.ts';
import { TermsService } from './terms-service.ts';

/**
 * Angebot mit Versionierung (Phase-3-Vorgaben Nr. 20–28):
 * - versendete Versionen sind unveränderbar; Änderungen erzeugen die
 *   nächste Version, die alte wird ungültig (superseded);
 * - nur die aktuelle, versendete, nicht abgelaufene Version ist annehmbar;
 * - die Annahme ist serverseitig atomar (Zeilensperren) und idempotent;
 * - alle Preise kommen aus der EINEN zentralen Preisengine
 *   (@mietroyal/domain), nie aus dem Client.
 */

export interface DraftInput {
  machineProductId?: string | null | undefined;
  machineQuantity?: number | undefined;
  fulfillment?: 'pickup' | 'delivery' | undefined;
  deliveryStreet?: string | null | undefined;
  deliveryPostalCode?: string | null | undefined;
  deliveryCity?: string | null | undefined;
  deliveryPriceCents?: number | null | undefined;
  selections?:
    readonly { productId: string; role: 'free' | 'extra'; quantity: number }[] | undefined;
}

export type EffectiveOfferStatus =
  'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'recheck_requested' | 'superseded';

export function effectiveStatus(version: OfferVersion, now: Date): EffectiveOfferStatus {
  if (version.supersededAt !== null && version.status !== 'accepted') return 'superseded';
  if (version.status === 'sent' && version.expiresAt !== null && now >= version.expiresAt) {
    return 'expired';
  }
  return version.status;
}

const TOKEN_BYTES = 32;

/** Eventzeiten (ISO) als Berlin-Zeitraum für Kundendokumente (§26/§31). */
function eventTimeLabelFrom(startIso: unknown, endIso: unknown): string | null {
  const format = (value: unknown): string | null => {
    if (typeof value !== 'string' || value === '') return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleTimeString('de-DE', {
      timeZone: 'Europe/Berlin',
      hour: '2-digit',
      minute: '2-digit',
    });
  };
  const start = format(startIso);
  const end = format(endIso);
  if (start === null && end === null) return null;
  return `${start ?? '–'} bis ${end ?? '–'} Uhr`;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class OfferService {
  private readonly productService: ProductService;
  private readonly termsService: TermsService;

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly documentService: DocumentService,
    private readonly gateway: OfferDeliveryGateway,
  ) {
    this.productService = new ProductService(db);
    this.termsService = new TermsService(db, config);
  }

  // ── Laden ────────────────────────────────────────────────────────────────

  async getOfferForProcess(processId: string) {
    const offerRows = await this.db.select().from(offers).where(eq(offers.processId, processId));
    const offer = offerRows[0];
    if (offer === undefined) return null;
    return this.offerDetail(offer);
  }

  private async offerDetail(offer: Offer) {
    const versions = await this.db
      .select()
      .from(offerVersions)
      .where(eq(offerVersions.offerId, offer.id))
      .orderBy(asc(offerVersions.versionNumber));
    const now = new Date();
    const detailed = [];
    for (const version of versions) {
      const lineItems = await this.db
        .select()
        .from(offerLineItems)
        .where(eq(offerLineItems.offerVersionId, version.id))
        .orderBy(asc(offerLineItems.position));
      const selections = await this.db
        .select()
        .from(offerVersionSelections)
        .where(eq(offerVersionSelections.offerVersionId, version.id));
      detailed.push({
        ...version,
        effectiveStatus: effectiveStatus(version, now),
        lineItems,
        selections,
      });
    }
    return { offer, versions: detailed };
  }

  async getVersion(versionId: string): Promise<OfferVersion> {
    const rows = await this.db.select().from(offerVersions).where(eq(offerVersions.id, versionId));
    const version = rows[0];
    if (version === undefined) throw new AuthError('NOT_FOUND', 'Angebotsversion nicht gefunden.');
    return version;
  }

  private async offerById(offerId: string): Promise<Offer> {
    const rows = await this.db.select().from(offers).where(eq(offers.id, offerId));
    const offer = rows[0];
    if (offer === undefined) throw new AuthError('NOT_FOUND', 'Angebot nicht gefunden.');
    return offer;
  }

  /** Vorgangs-ID zu einer Version – für die Sichtbarkeitsprüfung der Routen. */
  async processIdForVersion(versionId: string): Promise<string> {
    const version = await this.getVersion(versionId);
    const offer = await this.offerById(version.offerId);
    return offer.processId;
  }

  /** Vorgangs-ID zu einem Angebot – für die Sichtbarkeitsprüfung der Routen. */
  async processIdForOffer(offerId: string): Promise<string> {
    const offer = await this.offerById(offerId);
    return offer.processId;
  }

  // ── Anlegen / Entwurf ────────────────────────────────────────────────────

  /** Angebot (V1-Entwurf) anlegen – initialisiert aus der Anfrage. */
  async createOffer(
    actorId: string,
    processId: string,
  ): Promise<{ offerId: string; versionId: string }> {
    const processRows = await this.db.select().from(processes).where(eq(processes.id, processId));
    const process = processRows[0];
    if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    if (process.mainStatus === 'completed' || process.mainStatus === 'cancelled') {
      throw new AuthError('CONFLICT', 'Der Vorgang ist für die Bearbeitung gesperrt.');
    }
    const existing = await this.db
      .select({ id: offers.id })
      .from(offers)
      .where(eq(offers.processId, processId));
    if (existing.length > 0) {
      throw new AuthError('CONFLICT', 'Für diesen Vorgang existiert bereits ein Angebot.');
    }

    const inquiryRows = await this.db
      .select()
      .from(inquiries)
      .where(eq(inquiries.processId, processId));
    const inquiry = inquiryRows[0];

    return this.db.transaction(async (tx) => {
      const offerInserted = await tx
        .insert(offers)
        .values({ processId, createdBy: actorId })
        .returning();
      const offer = offerInserted[0];
      if (offer === undefined) throw new AuthError('CONFLICT', 'Anlegen fehlgeschlagen.');
      const versionInserted = await tx
        .insert(offerVersions)
        .values({
          offerId: offer.id,
          versionNumber: 1,
          status: 'draft',
          machineProductId: inquiry?.machineProductId ?? null,
          machineQuantity: 1,
          fulfillment: inquiry?.fulfillment ?? 'pickup',
          deliveryStreet: inquiry?.deliveryStreet ?? null,
          deliveryPostalCode: inquiry?.deliveryPostalCode ?? null,
          deliveryCity: inquiry?.deliveryCity ?? null,
          createdBy: actorId,
        })
        .returning();
      const version = versionInserted[0];
      if (version === undefined) throw new AuthError('CONFLICT', 'Anlegen fehlgeschlagen.');
      await tx.update(offers).set({ currentVersionId: version.id }).where(eq(offers.id, offer.id));

      // Auswahl aus der Anfrage übernehmen.
      if (inquiry !== undefined) {
        const selections = await tx
          .select()
          .from(inquirySelections)
          .where(eq(inquirySelections.inquiryId, inquiry.id));
        for (const selection of selections) {
          await tx.insert(offerVersionSelections).values({
            offerVersionId: version.id,
            productId: selection.productId,
            role: selection.role,
            quantity: selection.quantity,
          });
        }
      }
      await this.recomputeDraft(tx, version.id);
      return { offerId: offer.id, versionId: version.id };
    });
  }

  private assertDraft(version: OfferVersion): void {
    if (version.status !== 'draft') {
      throw new AuthError(
        'CONFLICT',
        'Diese Angebotsversion ist eingefroren – Änderungen erfordern eine neue Version.',
      );
    }
  }

  /**
   * Version innerhalb einer Transaktion sperren und den Entwurfsstatus
   * UNTER der Sperre erneut prüfen: Ein zeitgleich abgeschlossener Versand
   * kann eine eingefrorene Version so niemals nachträglich mutieren.
   */
  private async lockDraft(tx: DatabaseTransaction, versionId: string): Promise<OfferVersion> {
    const rows = await tx
      .select()
      .from(offerVersions)
      .where(eq(offerVersions.id, versionId))
      .for('update');
    const version = rows[0];
    if (version === undefined) throw new AuthError('NOT_FOUND', 'Angebotsversion nicht gefunden.');
    this.assertDraft(version);
    return version;
  }

  /**
   * Rabatt entfernen, wenn sich die Maschinen-Zwischensumme geändert hat:
   * Ein fester EUR-Rabatt „driftet“ sonst still in höhere Schwellenbereiche
   * (>10 %/>20 %), ohne dass die Stufenrechte erneut geprüft würden. Der
   * Rabatt muss danach – rechtegeprüft – neu gesetzt werden.
   */
  private async clearDriftedDiscount(
    tx: DatabaseTransaction,
    locked: OfferVersion,
    newSubtotalCents: number,
  ): Promise<void> {
    if (locked.discountType === null) return;
    if (locked.machineSubtotalCents === newSubtotalCents) return;
    await tx
      .update(offerVersions)
      .set({
        discountType: null,
        discountValue: null,
        discountReason: null,
        discountApprovedBy: null,
        discountApprovedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(offerVersions.id, locked.id));
    await this.recomputeDraft(tx, locked.id);
  }

  async updateDraft(actorId: string, versionId: string, input: DraftInput): Promise<void> {
    const version = await this.getVersion(versionId);
    this.assertDraft(version);

    if (input.machineProductId !== null && input.machineProductId !== undefined) {
      const machine = await this.productService.getProduct(input.machineProductId);
      if (machine.category !== 'machine' || !machine.active) {
        throw new AuthError('VALIDATION', 'Bitte einen aktiven Maschinentyp wählen.');
      }
    }
    if (input.selections !== undefined) {
      for (const selection of input.selections) {
        const product = await this.productService.getProduct(selection.productId);
        if (!product.active) {
          throw new AuthError('VALIDATION', `„${product.name}“ ist deaktiviert und nicht wählbar.`);
        }
      }
    }
    if (input.deliveryPriceCents !== null && input.deliveryPriceCents !== undefined) {
      if (!Number.isInteger(input.deliveryPriceCents) || input.deliveryPriceCents < 0) {
        throw new AuthError(
          'VALIDATION',
          'Der Lieferpreis muss ein nicht-negativer Cent-Betrag sein.',
        );
      }
    }

    await this.db.transaction(async (tx) => {
      const locked = await this.lockDraft(tx, versionId);
      await tx
        .update(offerVersions)
        .set({
          ...(input.machineProductId === undefined
            ? {}
            : { machineProductId: input.machineProductId }),
          ...(input.machineQuantity === undefined
            ? {}
            : { machineQuantity: input.machineQuantity }),
          ...(input.fulfillment === undefined ? {} : { fulfillment: input.fulfillment }),
          ...(input.deliveryStreet === undefined ? {} : { deliveryStreet: input.deliveryStreet }),
          ...(input.deliveryPostalCode === undefined
            ? {}
            : { deliveryPostalCode: input.deliveryPostalCode }),
          ...(input.deliveryCity === undefined ? {} : { deliveryCity: input.deliveryCity }),
          ...(input.deliveryPriceCents === undefined
            ? {}
            : { deliveryPriceCents: input.deliveryPriceCents }),
          // Jede inhaltliche Änderung invalidiert eine erteilte Rabattfreigabe.
          discountApprovedBy: null,
          discountApprovedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(offerVersions.id, versionId));
      if (input.selections !== undefined) {
        await tx
          .delete(offerVersionSelections)
          .where(eq(offerVersionSelections.offerVersionId, versionId));
        for (const selection of input.selections) {
          await tx.insert(offerVersionSelections).values({
            offerVersionId: versionId,
            productId: selection.productId,
            role: selection.role,
            quantity: selection.quantity,
          });
        }
      }
      const result = await this.recomputeDraft(tx, versionId);
      await this.clearDriftedDiscount(tx, locked, result.machineSubtotalCents);
    });
  }

  /**
   * Entwurf neu aus der Anfrage übernehmen (§40): Maschine, Abwicklung,
   * Lieferadresse und Sirup-/Extra-Auswahl werden aus der aktuellen Anfrage
   * kopiert; der manuelle Lieferpreis bleibt bestehen. Ein bestehender
   * Rabatt wird bei geänderter Zwischensumme entfernt (Stufenrechte).
   */
  async syncDraftFromInquiry(actorId: string, versionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const locked = await this.lockDraft(tx, versionId);
      const offerRows = await tx.select().from(offers).where(eq(offers.id, locked.offerId));
      const offer = offerRows[0];
      if (offer === undefined) throw new AuthError('NOT_FOUND', 'Angebot nicht gefunden.');
      const inquiryRows = await tx
        .select()
        .from(inquiries)
        .where(eq(inquiries.processId, offer.processId));
      const inquiry = inquiryRows[0];
      if (inquiry === undefined) {
        throw new AuthError('VALIDATION', 'Für diesen Vorgang existiert keine Anfrage.');
      }
      await tx
        .update(offerVersions)
        .set({
          machineProductId: inquiry.machineProductId,
          fulfillment: inquiry.fulfillment,
          deliveryStreet: inquiry.deliveryStreet,
          deliveryPostalCode: inquiry.deliveryPostalCode,
          deliveryCity: inquiry.deliveryCity,
          discountApprovedBy: null,
          discountApprovedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(offerVersions.id, versionId));
      await tx
        .delete(offerVersionSelections)
        .where(eq(offerVersionSelections.offerVersionId, versionId));
      const selections = await tx
        .select()
        .from(inquirySelections)
        .where(eq(inquirySelections.inquiryId, inquiry.id));
      for (const selection of selections) {
        await tx.insert(offerVersionSelections).values({
          offerVersionId: versionId,
          productId: selection.productId,
          role: selection.role,
          quantity: selection.quantity,
        });
      }
      const result = await this.recomputeDraft(tx, versionId);
      await this.clearDriftedDiscount(tx, locked, result.machineSubtotalCents);
    });
  }

  // ── Preisberechnung (zentral) ───────────────────────────────────────────

  private async pricingResultFor(
    executor: DatabaseTransaction | Database,
    version: OfferVersion,
    at: Date,
  ): Promise<PricingResult> {
    const selections = await executor
      .select()
      .from(offerVersionSelections)
      .where(eq(offerVersionSelections.offerVersionId, version.id));

    const machine =
      version.machineProductId === null
        ? null
        : {
            product: await this.productService.pricingProduct(version.machineProductId, at),
            quantity: version.machineQuantity,
          };
    const pricingSelections: PricingSelection[] = [];
    for (const selection of selections) {
      pricingSelections.push({
        product: await this.productService.pricingProduct(selection.productId, at),
        role: selection.role,
        quantity: selection.quantity,
      });
    }
    const cups = await this.productService.pricingProductBySlug('becher-25', at).catch(() => null);
    const straws = await this.productService
      .pricingProductBySlug('strohhalme-25', at)
      .catch(() => null);

    const specialPrices = (version.specialPrices ?? []) as SpecialPriceEntry[];
    try {
      return priceOffer({
        machine,
        cupsProduct: cups,
        strawsProduct: straws,
        selections: pricingSelections,
        fulfillment: version.fulfillment,
        deliveryPriceCents: version.deliveryPriceCents,
        discount:
          version.discountType === null || version.discountValue === null
            ? null
            : { type: version.discountType, value: version.discountValue },
        specialPrices,
      });
    } catch (error) {
      if (error instanceof PricingError) throw new AuthError('VALIDATION', error.message);
      throw error;
    }
  }

  /** Entwurf neu durchrechnen und Positionen + Vorschau-Summen speichern. */
  private async recomputeDraft(tx: DatabaseTransaction, versionId: string): Promise<PricingResult> {
    const rows = await tx.select().from(offerVersions).where(eq(offerVersions.id, versionId));
    const version = rows[0];
    if (version === undefined) throw new AuthError('NOT_FOUND', 'Angebotsversion nicht gefunden.');
    const result = await this.pricingResultFor(tx, version, new Date());
    await tx.delete(offerLineItems).where(eq(offerLineItems.offerVersionId, versionId));
    let position = 1;
    for (const item of result.lineItems) {
      await tx.insert(offerLineItems).values({
        offerVersionId: versionId,
        position: position++,
        kind: item.kind,
        billingMode: item.billingMode,
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        standardUnitPriceCents: item.standardUnitPriceCents,
        agreedUnitPriceCents: item.agreedUnitPriceCents,
        totalCents: item.totalCents,
        priceSource: item.priceSource,
        productId: item.productId,
        productSnapshot: item.productSnapshot,
        specialPriceBy: item.specialPriceBy,
        specialPriceAt: item.specialPriceAt === null ? null : new Date(item.specialPriceAt),
      });
    }
    await tx
      .update(offerVersions)
      .set({
        machineSubtotalCents: result.machineSubtotalCents,
        discountCents: result.discountCents,
        fixedTotalCents: result.fixedTotalCents,
        updatedAt: new Date(),
      })
      .where(eq(offerVersions.id, versionId));
    return result;
  }

  // ── Rabatte & Sonderpreise (§18/§19) ────────────────────────────────────

  async setDiscount(
    actorId: string,
    versionId: string,
    effective: ReadonlySet<PermissionKey>,
    input: { type: 'percent' | 'fixed'; value: number; reason?: string | null | undefined } | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const locked = await this.lockDraft(tx, versionId);

      if (input !== null) {
        // Probeberechnung UNTER der Sperre – der geprüfte Stand ist genau
        // der Stand, der anschließend gespeichert wird (kein TOCTOU).
        const probe = await this.pricingResultFor(
          tx,
          {
            ...locked,
            discountType: input.type,
            discountValue: input.value,
          },
          new Date(),
        );
        const bp = probe.discountEffectiveBp;
        const reason = input.reason?.trim() ?? '';
        if (discountNeedsReason(bp)) {
          if (reason === '') {
            throw new AuthError(
              'VALIDATION',
              'Für Rabatte über 10 % ist ein interner Grund Pflicht.',
            );
          }
          if (!effective.has('discount.over_10_with_reason')) {
            throw new AuthError('FORBIDDEN', 'Dafür fehlt dir das Recht für Rabatte über 10 %.');
          }
        } else if (
          !effective.has('discount.up_to_10') &&
          !effective.has('discount.over_10_with_reason')
        ) {
          throw new AuthError('FORBIDDEN', 'Dafür fehlt dir das Rabatt-Recht.');
        }
        if (
          discountNeedsApproval(bp) &&
          !effective.has('discount.over_20_request') &&
          !effective.has('discount.over_20_approve')
        ) {
          throw new AuthError(
            'FORBIDDEN',
            'Rabatte über 20 % dürfen nur mit dem entsprechenden Recht beantragt werden.',
          );
        }
      }

      await tx
        .update(offerVersions)
        .set({
          discountType: input?.type ?? null,
          discountValue: input?.value ?? null,
          discountReason: input?.reason?.trim() || null,
          discountApprovedBy: null,
          discountApprovedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(offerVersions.id, versionId));
      await this.recomputeDraft(tx, versionId);
    });
  }

  /** Freigabe für Rabatte über 20 % (discount.over_20_approve). */
  async approveDiscount(actorId: string, versionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockDraft(tx, versionId);
      await tx
        .update(offerVersions)
        .set({ discountApprovedBy: actorId, discountApprovedAt: new Date(), updatedAt: new Date() })
        .where(eq(offerVersions.id, versionId));
    });
  }

  async setSpecialPrice(
    actorId: string,
    versionId: string,
    effective: ReadonlySet<PermissionKey>,
    input: { lineKey: string; unitPriceCents: number | null },
  ): Promise<void> {
    if (input.lineKey === 'delivery') {
      // Der Lieferpreis wird ohnehin manuell festgelegt (offer.change_price)
      // – ein Sonderpreis darauf wäre ein stiller No-Op und wird abgelehnt.
      throw new AuthError(
        'VALIDATION',
        'Der Lieferpreis wird direkt manuell festgelegt – Sonderpreise gibt es dafür nicht.',
      );
    }

    await this.db.transaction(async (tx) => {
      const locked = await this.lockDraft(tx, versionId);
      const existing = ((locked.specialPrices ?? []) as SpecialPriceEntry[]).filter(
        (entry) => entry.lineKey !== input.lineKey,
      );

      if (input.unitPriceCents !== null) {
        if (!Number.isInteger(input.unitPriceCents) || input.unitPriceCents < 0) {
          throw new AuthError(
            'VALIDATION',
            'Der Sonderpreis muss ein nicht-negativer Cent-Betrag sein.',
          );
        }
        if (input.unitPriceCents === 0 && !effective.has('offer.apply_special_price_zero')) {
          throw new AuthError(
            'FORBIDDEN',
            '0-EUR-Sonderpreise erfordern eine eigene Berechtigung.',
          );
        }
        // Standardpreis der Ziel-Position ermitteln (aus aktueller Berechnung).
        const probe = await this.pricingResultFor(
          tx,
          { ...locked, specialPrices: existing },
          new Date(),
        );
        const target = probe.lineItems.find((item) => item.lineKey === input.lineKey);
        if (target === undefined) {
          throw new AuthError('NOT_FOUND', 'Die Position für den Sonderpreis existiert nicht.');
        }
        if (target.billingMode === 'included') {
          throw new AuthError('VALIDATION', 'Inklusiv-Positionen haben keinen Sonderpreis.');
        }
        existing.push({
          lineKey: input.lineKey,
          unitPriceCents: input.unitPriceCents,
          previousStandardCents: target.standardUnitPriceCents,
          byUserId: actorId,
          at: new Date().toISOString(),
        });
      }

      await tx
        .update(offerVersions)
        .set({
          specialPrices: existing,
          discountApprovedBy: null,
          discountApprovedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(offerVersions.id, versionId));
      const result = await this.recomputeDraft(tx, versionId);
      // Ein Maschinen-Sonderpreis ändert die Rabatt-Bezugsgröße:
      await this.clearDriftedDiscount(tx, locked, result.machineSubtotalCents);
    });
  }

  /** Höchster „resultierender Rabatt“ einer Sonderpreis-Position (§19). */
  private maxSpecialDiscountBp(result: PricingResult): number {
    let max = 0;
    for (const item of result.lineItems) {
      if (item.priceSource !== 'special') continue;
      if (item.standardUnitPriceCents <= 0) continue;
      if (item.agreedUnitPriceCents >= item.standardUnitPriceCents) continue;
      const bp = Math.ceil(
        ((item.standardUnitPriceCents - item.agreedUnitPriceCents) * 10000) /
          item.standardUnitPriceCents,
      );
      if (bp > max) max = bp;
    }
    return max;
  }

  // ── Versand (§22/§24) ───────────────────────────────────────────────────

  async send(
    actorId: string,
    versionId: string,
    effective: ReadonlySet<PermissionKey>,
    now = new Date(),
  ): Promise<{ token: string }> {
    // Production ohne echten Versandweg blockiert HIER – also VOR jedem
    // Einfrieren (§24: „nie so tun als versendet“). Kein Statuswechsel,
    // kein Token, kein finales PDF ohne konfigurierten Adapter.
    this.gateway.assertConfigured();

    const version = await this.getVersion(versionId);
    this.assertDraft(version);
    const offer = await this.offerById(version.offerId);
    if (offer.currentVersionId !== version.id) {
      throw new AuthError('CONFLICT', 'Nur die aktuelle Version kann versendet werden.');
    }
    if (version.machineProductId === null) {
      throw new AuthError('VALIDATION', 'Das Angebot benötigt einen gewählten Maschinentyp.');
    }

    const processRows = await this.db
      .select()
      .from(processes)
      .where(eq(processes.id, offer.processId));
    const process = processRows[0];
    if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    if (process.mainStatus === 'cancelled') {
      throw new AuthError('CONFLICT', 'Der Vorgang ist storniert.');
    }
    const inquiryRows = await this.db
      .select()
      .from(inquiries)
      .where(eq(inquiries.processId, offer.processId));
    const inquiry = inquiryRows[0];
    const eventDate = inquiry?.eventDate ?? null;
    if (eventDate === null) {
      throw new AuthError(
        'VALIDATION',
        'Für die Angebotsgültigkeit wird ein Eventdatum in der Anfrage benötigt.',
      );
    }
    const customerRows = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, process.customerId));
    const customer = customerRows[0];
    if (customer === undefined) throw new AuthError('NOT_FOUND', 'Kunde nicht gefunden.');
    if (customer.email === null) {
      throw new AuthError('VALIDATION', 'Für den Versand wird eine Kunden-E-Mail benötigt.');
    }

    const terms = await this.termsService.activeForSending();

    const expiresAt = offerExpiresAt(eventDate, now);
    const customerSnapshot = {
      id: customer.id,
      type: customer.type,
      displayName: customerDisplayName(customer),
      firstName: customer.firstName,
      lastName: customer.lastName,
      organizationName: customer.organizationName,
      contactPerson: customer.contactPerson,
      email: customer.email,
      phone: customer.phone,
      billingStreet: customer.billingStreet,
      billingPostalCode: customer.billingPostalCode,
      billingCity: customer.billingCity,
    };
    const eventSnapshot = {
      eventDate,
      eventStart: inquiry?.eventStart?.toISOString() ?? null,
      eventEnd: inquiry?.eventEnd?.toISOString() ?? null,
      guestCount: inquiry?.guestCount ?? null,
      occasion: inquiry?.occasion ?? null,
      fulfillment: version.fulfillment,
      deliveryStreet: version.deliveryStreet,
      deliveryPostalCode: version.deliveryPostalCode,
      deliveryCity: version.deliveryCity,
      deliveryWindowFrom: inquiry?.deliveryWindowFrom?.toISOString() ?? null,
      deliveryWindowTo: inquiry?.deliveryWindowTo?.toISOString() ?? null,
      collectionWindowFrom: inquiry?.collectionWindowFrom?.toISOString() ?? null,
      collectionWindowTo: inquiry?.collectionWindowTo?.toISOString() ?? null,
      onsiteContactName: inquiry?.onsiteContactName ?? null,
      onsiteContactPhone: inquiry?.onsiteContactPhone ?? null,
    };

    // Token je Versand rotieren: alter Link wird ungültig, der Kunde erhält
    // mit jeder versendeten Version einen frischen, nicht erratbaren Link.
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    await this.db.transaction(async (tx) => {
      // Gleiche Sperr-Reihenfolge wie accept/createNewVersion: erst das
      // Angebot, dann die Version – Versand, neue Version und Annahme
      // serialisieren sich damit vollständig.
      const offerRows = await tx.select().from(offers).where(eq(offers.id, offer.id)).for('update');
      const lockedOffer = offerRows[0];
      if (lockedOffer === undefined || lockedOffer.currentVersionId !== versionId) {
        throw new AuthError('CONFLICT', 'Nur die aktuelle Version kann versendet werden.');
      }
      const locked = await this.lockDraft(tx, versionId);
      if (locked.machineProductId === null) {
        throw new AuthError('VALIDATION', 'Das Angebot benötigt einen gewählten Maschinentyp.');
      }
      const result = await this.recomputeDraft(tx, versionId);

      // Freigabe-/Grundprüfung auf GENAU dem Stand, der eingefroren wird –
      // ein paralleles setDiscount/setSpecialPrice kann die >20-%-Freigabe
      // nicht mehr umgehen (kein TOCTOU).
      const needsApproval =
        discountNeedsApproval(result.discountEffectiveBp) ||
        discountNeedsApproval(this.maxSpecialDiscountBp(result));
      if (needsApproval && locked.discountApprovedBy === null) {
        if (effective.has('discount.over_20_approve')) {
          // Wer selbst freigeben darf, gibt mit dem Versand frei.
          await tx
            .update(offerVersions)
            .set({ discountApprovedBy: actorId, discountApprovedAt: now })
            .where(eq(offerVersions.id, versionId));
        } else {
          throw new AuthError(
            'CONFLICT',
            'Rabatte über 20 % erfordern vor dem Versand eine Freigabe (discount.over_20_approve).',
          );
        }
      }
      if (result.discountEffectiveBp > 1000 && (locked.discountReason ?? '').trim() === '') {
        throw new AuthError('VALIDATION', 'Für Rabatte über 10 % ist ein interner Grund Pflicht.');
      }

      await tx
        .update(offerVersions)
        .set({
          status: 'sent',
          sentAt: now,
          sentBy: actorId,
          expiresAt,
          customerSnapshot,
          eventSnapshot,
          termsVersionId: terms.id,
          updatedAt: now,
        })
        .where(eq(offerVersions.id, versionId));
      await tx
        .update(offerAccessTokens)
        .set({ revokedAt: now })
        .where(and(eq(offerAccessTokens.offerId, offer.id), isNull(offerAccessTokens.revokedAt)));
      await tx.insert(offerAccessTokens).values({
        offerId: offer.id,
        tokenHash: hashToken(token),
      });
    });

    // Finales Angebots-PDF (immutable) erzeugen.
    const sentVersion = await this.getVersion(versionId);
    await this.createOfferDocument(
      process.processNumber,
      process.id,
      sentVersion,
      terms.content,
      terms.label,
    );

    // Fachlicher Versand über den Phase-3-Adapter (Outbox in Dev/Test;
    // Production ohne echten Adapter wurde bereits VOR dem Einfrieren
    // durch assertConfigured() blockiert).
    const link = `/angebot/${token}`;
    await this.gateway.deliver({
      kind: 'offer',
      offerVersionId: versionId,
      recipient: customer.email,
      subject: `Ihr Miet-Royal-Angebot ${process.processNumber} (Version ${version.versionNumber})`,
      body:
        `Guten Tag ${customerDisplayName(customer)},\n\n` +
        `Ihr Angebot ${process.processNumber} (Version ${version.versionNumber}) ist online abrufbar:\n` +
        `${link}\n\nFester Angebotswert: ${formatEuro(sentVersion.fixedTotalCents ?? 0)}\n` +
        `Gültig bis: ${expiresAt.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}\n`,
    });

    return { token };
  }

  private async createOfferDocument(
    processNumber: string,
    processId: string,
    version: OfferVersion,
    termsContent: string,
    termsLabel: string,
  ): Promise<void> {
    const lineItems = await this.db
      .select()
      .from(offerLineItems)
      .where(eq(offerLineItems.offerVersionId, version.id))
      .orderBy(asc(offerLineItems.position));
    const snapshot = (version.customerSnapshot ?? {}) as Record<string, unknown>;
    const eventSnapshot = (version.eventSnapshot ?? {}) as Record<string, unknown>;
    const pdfItems: PdfLineItem[] = lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      agreedUnitPriceCents: item.agreedUnitPriceCents,
      totalCents: item.totalCents,
      billingMode: item.billingMode,
    }));
    const commissionMax = lineItems
      .filter((item) => item.billingMode === 'commission')
      .reduce((sum, item) => sum + item.totalCents, 0);
    const bytes = await renderOfferPdf({
      processNumber,
      versionNumber: version.versionNumber,
      customerName: String(snapshot.displayName ?? ''),
      customerAddressLines: [
        String(snapshot.billingStreet ?? '') || null,
        [snapshot.billingPostalCode, snapshot.billingCity].filter(Boolean).join(' ') || null,
      ].filter((line): line is string => line !== null),
      eventDateLabel: String(eventSnapshot.eventDate ?? '–'),
      eventTimeLabel: eventTimeLabelFrom(eventSnapshot.eventStart, eventSnapshot.eventEnd),
      fulfillmentLabel:
        version.fulfillment === 'pickup' ? 'Selbstabholung' : 'Lieferung (individuell geprüft)',
      lineItems: pdfItems,
      machineSubtotalCents: version.machineSubtotalCents ?? 0,
      discountCents: version.discountCents ?? 0,
      // Der Rabattgrund ist INTERN (§18) und erscheint nie im Kundendokument.
      discountLabel: null,
      fixedTotalCents: version.fixedTotalCents ?? 0,
      commissionMaxCents: commissionMax,
      validUntilLabel:
        version.expiresAt === null
          ? null
          : version.expiresAt.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }),
      termsLabel,
      termsContent,
      createdAtLabel: new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }),
    });
    await this.documentService.createFinalDocument({
      type: 'offer',
      processId,
      offerVersionId: version.id,
      storageKey: `documents/offers/${version.id}-v${version.versionNumber}.pdf`,
      bytes,
    });
  }

  /**
   * PDF-Vorschau (§40): rendert den AKTUELLEN Stand einer Version on-the-fly
   * (ohne Speicherung, ohne Finalisierung). Finale PDFs entstehen nur beim
   * Versand/bei der Freigabe und sind immutable.
   */
  async renderPreviewPdf(versionId: string): Promise<Buffer> {
    const version = await this.getVersion(versionId);
    const offer = await this.offerById(version.offerId);
    const processRows = await this.db
      .select()
      .from(processes)
      .where(eq(processes.id, offer.processId));
    const process = processRows[0];
    if (process === undefined) throw new AuthError('NOT_FOUND', 'Vorgang nicht gefunden.');
    const customerRows = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, process.customerId));
    const customer = customerRows[0];
    const inquiryRows = await this.db
      .select()
      .from(inquiries)
      .where(eq(inquiries.processId, offer.processId));
    const inquiry = inquiryRows[0];
    const lineItems = await this.db
      .select()
      .from(offerLineItems)
      .where(eq(offerLineItems.offerVersionId, version.id))
      .orderBy(asc(offerLineItems.position));
    const pdfItems: PdfLineItem[] = lineItems.map((item) => ({
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      agreedUnitPriceCents: item.agreedUnitPriceCents,
      totalCents: item.totalCents,
      billingMode: item.billingMode,
    }));
    return renderOfferPdf({
      processNumber: `${process.processNumber} (VORSCHAU)`,
      versionNumber: version.versionNumber,
      customerName: customer === undefined ? '' : customerDisplayName(customer),
      customerAddressLines: [],
      eventDateLabel: inquiry?.eventDate ?? '–',
      eventTimeLabel: eventTimeLabelFrom(
        inquiry?.eventStart?.toISOString() ?? null,
        inquiry?.eventEnd?.toISOString() ?? null,
      ),
      fulfillmentLabel:
        version.fulfillment === 'pickup' ? 'Selbstabholung' : 'Lieferung (individuell geprüft)',
      lineItems: pdfItems,
      machineSubtotalCents: version.machineSubtotalCents ?? 0,
      discountCents: version.discountCents ?? 0,
      // Der Rabattgrund ist INTERN (§18) und erscheint nie im Kundendokument.
      discountLabel: null,
      fixedTotalCents: version.fixedTotalCents ?? 0,
      commissionMaxCents: lineItems
        .filter((item) => item.billingMode === 'commission')
        .reduce((sum, item) => sum + item.totalCents, 0),
      validUntilLabel: null,
      termsLabel: null,
      termsContent: null,
      createdAtLabel: new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }),
    });
  }

  // ── Neue Version (§21) ──────────────────────────────────────────────────

  async createNewVersion(
    actorId: string,
    offerId: string,
    changeNote: string | null,
  ): Promise<{ versionId: string; versionNumber: number }> {
    return this.db.transaction(async (tx) => {
      const offerRows = await tx.select().from(offers).where(eq(offers.id, offerId)).for('update');
      const offer = offerRows[0];
      if (offer === undefined) throw new AuthError('NOT_FOUND', 'Angebot nicht gefunden.');
      if (offer.currentVersionId === null) {
        throw new AuthError('CONFLICT', 'Das Angebot hat keine aktuelle Version.');
      }
      const currentRows = await tx
        .select()
        .from(offerVersions)
        .where(eq(offerVersions.id, offer.currentVersionId))
        .for('update');
      const current = currentRows[0];
      if (current === undefined)
        throw new AuthError('NOT_FOUND', 'Angebotsversion nicht gefunden.');
      if (current.status === 'accepted') {
        throw new AuthError(
          'CONFLICT',
          'Das Angebot wurde verbindlich angenommen und kann nicht mehr geändert werden.',
        );
      }
      if (current.status === 'draft') {
        throw new AuthError(
          'CONFLICT',
          'Die aktuelle Version ist noch ein Entwurf – bitte diesen bearbeiten.',
        );
      }

      const inserted = await tx
        .insert(offerVersions)
        .values({
          offerId,
          versionNumber: current.versionNumber + 1,
          status: 'draft',
          machineProductId: current.machineProductId,
          machineQuantity: current.machineQuantity,
          fulfillment: current.fulfillment,
          deliveryStreet: current.deliveryStreet,
          deliveryPostalCode: current.deliveryPostalCode,
          deliveryCity: current.deliveryCity,
          deliveryPriceCents: current.deliveryPriceCents,
          discountType: current.discountType,
          discountValue: current.discountValue,
          discountReason: current.discountReason,
          specialPrices: current.specialPrices,
          changeNote,
          createdBy: actorId,
        })
        .returning();
      const next = inserted[0];
      if (next === undefined) throw new AuthError('CONFLICT', 'Anlegen fehlgeschlagen.');

      const selections = await tx
        .select()
        .from(offerVersionSelections)
        .where(eq(offerVersionSelections.offerVersionId, current.id));
      for (const selection of selections) {
        await tx.insert(offerVersionSelections).values({
          offerVersionId: next.id,
          productId: selection.productId,
          role: selection.role,
          quantity: selection.quantity,
        });
      }

      // Alte Version wird SOFORT ungültig (nur die aktuelle Version ist
      // annehmbar); Historie bleibt vollständig erhalten.
      await tx
        .update(offerVersions)
        .set({ supersededAt: new Date(), updatedAt: new Date() })
        .where(eq(offerVersions.id, current.id));
      await tx
        .update(offers)
        .set({ currentVersionId: next.id, updatedAt: new Date() })
        .where(eq(offers.id, offerId));
      await this.recomputeDraft(tx, next.id);
      return { versionId: next.id, versionNumber: next.versionNumber };
    });
  }

  /** Ablehnung wird intern vermerkt (Kunde meldet sich außerhalb des Systems). */
  async markDeclined(versionId: string): Promise<void> {
    // Bedingtes Update statt Read-then-Write: eine zeitgleiche Annahme
    // (Status → accepted) kann so nie von einer Ablehnung überschrieben werden.
    const updated = await this.db
      .update(offerVersions)
      .set({ status: 'declined', declinedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(offerVersions.id, versionId), eq(offerVersions.status, 'sent')))
      .returning({ id: offerVersions.id });
    if (updated.length === 0) {
      throw new AuthError('CONFLICT', 'Nur versendete Angebote können abgelehnt werden.');
    }
  }

  // ── Öffentlicher Zugang (§25/§26) ───────────────────────────────────────

  private async tokenRow(token: string) {
    const rows = await this.db
      .select()
      .from(offerAccessTokens)
      .where(eq(offerAccessTokens.tokenHash, hashToken(token)));
    const row = rows[0];
    if (row === undefined || row.revokedAt !== null) return null;
    return row;
  }

  /** Öffentliche Angebotsansicht – neutral null bei ungültigem Token. */
  async publicView(token: string, now = new Date()) {
    const access = await this.tokenRow(token);
    if (access === null) return null;
    const offer = await this.offerById(access.offerId);
    if (offer.currentVersionId === null) return null;
    const version = await this.getVersion(offer.currentVersionId);
    const status = effectiveStatus(version, now);
    if (version.status === 'draft') return null;

    const processRows = await this.db
      .select({ processNumber: processes.processNumber })
      .from(processes)
      .where(eq(processes.id, offer.processId));
    const lineItems = await this.db
      .select()
      .from(offerLineItems)
      .where(eq(offerLineItems.offerVersionId, version.id))
      .orderBy(asc(offerLineItems.position));
    const terms =
      version.termsVersionId === null
        ? null
        : await this.termsService.byId(version.termsVersionId).catch(() => null);
    return {
      processNumber: processRows[0]?.processNumber ?? '',
      versionNumber: version.versionNumber,
      status,
      customerSnapshot: version.customerSnapshot,
      eventSnapshot: version.eventSnapshot,
      lineItems: lineItems.map((item) => ({
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        agreedUnitPriceCents: item.agreedUnitPriceCents,
        totalCents: item.totalCents,
        billingMode: item.billingMode,
      })),
      machineSubtotalCents: version.machineSubtotalCents,
      discountCents: version.discountCents,
      fixedTotalCents: version.fixedTotalCents,
      commissionMaxCents: lineItems
        .filter((item) => item.billingMode === 'commission')
        .reduce((sum, item) => sum + item.totalCents, 0),
      expiresAt: version.expiresAt,
      acceptedAt: version.acceptedAt,
      termsVersionId: version.termsVersionId,
      terms:
        terms === null
          ? null
          : { label: terms.label, content: terms.content, isTest: terms.isTest },
      offerVersionId: version.id,
    };
  }

  /** Dokument-ID des finalen Angebots-PDFs für den öffentlichen Abruf. */
  async publicDocumentId(token: string): Promise<string | null> {
    const access = await this.tokenRow(token);
    if (access === null) return null;
    const offer = await this.offerById(access.offerId);
    if (offer.currentVersionId === null) return null;
    const rows = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.offerVersionId, offer.currentVersionId));
    return rows[0]?.id ?? null;
  }

  /** „Erneute Prüfung anfragen“ nach Ablauf (§23) – keine neue Version. */
  async requestRecheck(token: string, now = new Date()): Promise<void> {
    const access = await this.tokenRow(token);
    if (access === null) throw new AuthError('NOT_FOUND', 'Angebot nicht gefunden.');
    const offer = await this.offerById(access.offerId);
    if (offer.currentVersionId === null)
      throw new AuthError('NOT_FOUND', 'Angebot nicht gefunden.');
    const version = await this.getVersion(offer.currentVersionId);
    if (effectiveStatus(version, now) !== 'expired') {
      throw new AuthError(
        'CONFLICT',
        'Nur abgelaufene Angebote können zur erneuten Prüfung angefragt werden.',
      );
    }
    // Bedingtes Update: Ein Rennen mit einer (Grenzfall-)Annahme darf einen
    // accepted-Status niemals überschreiben – abgelaufen ist gespeichert 'sent'.
    const updated = await this.db
      .update(offerVersions)
      .set({ status: 'recheck_requested', recheckRequestedAt: now, updatedAt: now })
      .where(and(eq(offerVersions.id, version.id), eq(offerVersions.status, 'sent')))
      .returning({ id: offerVersions.id });
    if (updated.length === 0) {
      throw new AuthError(
        'CONFLICT',
        'Nur abgelaufene Angebote können zur erneuten Prüfung angefragt werden.',
      );
    }
  }

  // ── Verbindliche Annahme (§28) ──────────────────────────────────────────

  async accept(token: string, now = new Date()): Promise<{ bookingId: string }> {
    const access = await this.tokenRow(token);
    if (access === null) throw new AuthError('NOT_FOUND', 'Angebot nicht gefunden.');

    return this.db.transaction(async (tx) => {
      // Angebot + aktuelle Version sperren: Annahme, Ablauf, neue Version
      // und Doppelklicks werden hier serialisiert.
      const offerRows = await tx
        .select()
        .from(offers)
        .where(eq(offers.id, access.offerId))
        .for('update');
      const offer = offerRows[0];
      if (offer === undefined || offer.currentVersionId === null) {
        throw new AuthError('NOT_FOUND', 'Angebot nicht gefunden.');
      }
      const versionRows = await tx
        .select()
        .from(offerVersions)
        .where(eq(offerVersions.id, offer.currentVersionId))
        .for('update');
      const version = versionRows[0];
      if (version === undefined) throw new AuthError('NOT_FOUND', 'Angebot nicht gefunden.');

      // Token-Widerruf UNTER der Sperre erneut prüfen: Im Rennen mit dem
      // Versand einer neuen Version (der alte Token wird dort widerrufen)
      // darf der alte Link niemals die neue Version annehmen.
      const freshToken = await tx
        .select({ revokedAt: offerAccessTokens.revokedAt })
        .from(offerAccessTokens)
        .where(eq(offerAccessTokens.id, access.id));
      if (freshToken[0] === undefined || freshToken[0].revokedAt !== null) {
        throw new AuthError('NOT_FOUND', 'Angebot nicht gefunden.');
      }

      // Idempotenz: bereits angenommen → dieselbe Buchung zurückgeben.
      if (version.status === 'accepted') {
        const existing = await tx
          .select({ id: bookings.id })
          .from(bookings)
          .where(eq(bookings.offerVersionId, version.id));
        const booking = existing[0];
        if (booking !== undefined) return { bookingId: booking.id };
      }

      if (version.status !== 'sent' || version.supersededAt !== null) {
        throw new AuthError('CONFLICT', 'Diese Angebotsversion ist nicht mehr gültig.');
      }
      if (version.expiresAt !== null && now >= version.expiresAt) {
        throw new AuthError(
          'CONFLICT',
          'Das Angebot ist abgelaufen und kann nicht mehr angenommen werden.',
        );
      }
      const processRows = await tx
        .select()
        .from(processes)
        .where(eq(processes.id, offer.processId));
      const process = processRows[0];
      if (process === undefined || process.mainStatus === 'cancelled') {
        throw new AuthError('CONFLICT', 'Der Vorgang ist storniert.');
      }
      if (version.customerSnapshot === null || version.eventSnapshot === null) {
        throw new AuthError('CONFLICT', 'Erforderliche Angebotsdaten fehlen.');
      }

      // Kunden-Snapshot zum Annahmezeitpunkt einfrieren (§28/§30).
      const customerRows = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, process.customerId));
      const customer = customerRows[0];
      if (customer === undefined) throw new AuthError('CONFLICT', 'Kunde nicht gefunden.');
      const lineItems = await tx
        .select()
        .from(offerLineItems)
        .where(eq(offerLineItems.offerVersionId, version.id))
        .orderBy(asc(offerLineItems.position));

      const bookingInserted = await tx
        .insert(bookings)
        .values({
          processId: offer.processId,
          offerId: offer.id,
          offerVersionId: version.id,
          customerId: customer.id,
          customerSnapshot: {
            id: customer.id,
            type: customer.type,
            displayName: customerDisplayName(customer),
            firstName: customer.firstName,
            lastName: customer.lastName,
            organizationName: customer.organizationName,
            contactPerson: customer.contactPerson,
            email: customer.email,
            phone: customer.phone,
            billingStreet: customer.billingStreet,
            billingPostalCode: customer.billingPostalCode,
            billingCity: customer.billingCity,
          },
          eventSnapshot: version.eventSnapshot,
          itemsSnapshot: lineItems.map((item) => ({
            position: item.position,
            kind: item.kind,
            billingMode: item.billingMode,
            description: item.description,
            quantity: item.quantity,
            unit: item.unit,
            standardUnitPriceCents: item.standardUnitPriceCents,
            agreedUnitPriceCents: item.agreedUnitPriceCents,
            totalCents: item.totalCents,
            priceSource: item.priceSource,
            productId: item.productId,
            productSnapshot: item.productSnapshot,
          })),
          totalsSnapshot: {
            machineSubtotalCents: version.machineSubtotalCents,
            discountCents: version.discountCents,
            fixedTotalCents: version.fixedTotalCents,
          },
          fulfillment: version.fulfillment,
          deliverySnapshot:
            version.fulfillment === 'delivery'
              ? {
                  street: version.deliveryStreet,
                  postalCode: version.deliveryPostalCode,
                  city: version.deliveryCity,
                  deliveryPriceCents: version.deliveryPriceCents,
                }
              : null,
          termsVersionId: version.termsVersionId,
          acceptedAt: now,
        })
        .returning({ id: bookings.id });
      const booking = bookingInserted[0];
      if (booking === undefined) throw new AuthError('CONFLICT', 'Buchung fehlgeschlagen.');

      await tx
        .update(offerVersions)
        .set({ status: 'accepted', acceptedAt: now, updatedAt: now })
        .where(eq(offerVersions.id, version.id));

      // Auftragsbestätigung automatisch VORBEREITEN (Freigabe durch
      // Mitarbeiter folgt, §31).
      await tx.insert(orderConfirmations).values({ bookingId: booking.id, status: 'prepared' });

      return { bookingId: booking.id };
    });
  }

  async bookingForProcess(processId: string): Promise<Booking | null> {
    const rows = await this.db.select().from(bookings).where(eq(bookings.processId, processId));
    return rows[0] ?? null;
  }
}
