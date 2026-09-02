/**
 * Zentrale Geschäftslogik von Miet-Royal 2.0 (eine autoritative
 * Implementierung je Fachregel – CLAUDE.md). Phase 3: Preisengine,
 * Angebotsgültigkeit und Rabatt-Schwellenregeln. Phase 4: Termin-,
 * Vertretungs-, Konflikt- und Überfälligkeitsregeln (scheduling.ts).
 */
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
