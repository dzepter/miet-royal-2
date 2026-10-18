/**
 * Zentrale Geschäftslogik von Miet-Royal 2.0 (eine autoritative
 * Implementierung je Fachregel – CLAUDE.md). Phase 3: Preisengine,
 * Angebotsgültigkeit und Rabatt-Schwellenregeln. Phase 4: Termin-,
 * Vertretungs-, Konflikt- und Überfälligkeitsregeln (scheduling.ts).
 * Phase 8: operative Übergabe-/Rückgabe-Blocker und Reinigungsregeln
 * (operations.ts) – eine Implementierung für Server und Offline-Projektion.
 * Phase 9: Abrechnungs-Summen, Kommissionsregel, 24-h-Fenster und Storno-
 * Berechnung (settlement.ts). Phase 11: Wiedermieter-Gutschein – 20 %-Regel,
 * Kalendermonats-Gültigkeit, Code-Normalisierung (voucher.ts).
 */
export * from './operations.ts';
export * from './scheduling.ts';
export {
  CANISTER_SLUG,
  CANISTERS_PER_CONTAINER_LIMIT,
  DISCOUNT_APPROVAL_THRESHOLD_BP,
  DISCOUNT_REASON_THRESHOLD_BP,
  FREE_CUPS_PACKS_PER_RENTAL,
  FREE_STRAWS_PACKS_PER_RENTAL,
  LARGE_EVENT_GUEST_THRESHOLD,
  LARGE_EVENT_NOTE,
  OFFER_VALIDITY_FAR_DAYS,
  OFFER_VALIDITY_NEAR_DAYS,
  OFFER_VALIDITY_THRESHOLD_DAYS,
  PricingError,
  daysUntilEventBerlin,
  discountNeedsApproval,
  discountNeedsReason,
  offerExpiresAt,
  offerValidityDays,
  priceOffer,
  type BillingMode,
  type LineItemKind,
  type PricedLineItem,
  type PriceSource,
  type PricingInput,
  type PricingProduct,
  type PricingResult,
  type PricingSelection,
  type SpecialPriceEntry,
} from './pricing.ts';
export * from './settlement.ts';
export * from './voucher.ts';
