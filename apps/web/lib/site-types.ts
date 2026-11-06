/**
 * Phase 16 (WEB, Design §2.5/§3.1–§3.3/§4/§11.2): Spiegel der öffentlichen DTOs der API.
 *
 * Die Web-App hat bewusst KEINE Workspace-Abhängigkeiten (kein `@mietroyal/validation`,
 * kein `@mietroyal/domain`); die Typen hier folgen exakt den Verträgen aus
 * `apps/api/src/cms/public-site.ts`, `apps/api/src/public/catalog.ts`,
 * `apps/api/src/public/configurator.ts`, `apps/api/src/public/schemas.ts` und
 * `apps/api/src/reviews/types.ts`. Die API ist die einzige Autorität für Inhalte,
 * Preise und Regeln – das Web zeigt nur an (CLAUDE.md „Eine autoritative Implementierung“).
 *
 * Reine Typen + Konstanten (keine React-/Browser-Abhängigkeit), damit `node --test` sie lädt.
 */

// ── Seitentypen und Blöcke (Spiegel von `@mietroyal/validation/cms`) ─────────

export const SITE_PAGE_TYPES = [
  'home',
  'slush',
  'process',
  'faq',
  'about',
  'contact',
  'legal',
  'region',
  'secondary_offer',
] as const;
export type SitePageType = (typeof SITE_PAGE_TYPES)[number];

/**
 * Spiegel von `CMS_BLOCK_TYPES` (Reihenfolge wie dort). Ein Unit-Test vergleicht diese
 * Liste mit der Quelle in `packages/validation/src/cms.ts`.
 */
export const SITE_BLOCK_TYPES = [
  'hero',
  'text',
  'features',
  'steps',
  'product_grid',
  'included_items',
  'image',
  'gallery',
  'faq',
  'reviews',
  'service_areas',
  'secondary_offers',
  'contact_details',
  'cta',
] as const;
export type SiteBlockType = (typeof SITE_BLOCK_TYPES)[number];

export interface SiteCta {
  label: string;
  href: string;
}

/** Öffentliche Bildreferenz: nur opake Medien-ID und Varianten-URLs (nie Storage-Keys). */
export interface PublicImage {
  mediaId: string;
  /** Leer, wenn dekorativ. */
  alt: string;
  decorative: boolean;
  width: number;
  height: number;
  variants: Array<{ width: number; url: string }>;
}

export type PublicBillingMode = 'fixed' | 'commission';

export interface PublicProduct {
  slug: string;
  name: string;
  category: string;
  description: string | null;
  priceCents: number;
  billingMode: PublicBillingMode;
  unitLabel: string;
}

export interface PublicMachine extends PublicProduct {
  containerCount: number;
  containerVolumeLiters: number;
}

export interface PublicIncluded {
  freeSyrupLitersPerContainer: number;
  cupsPerProcess: number;
  strawsPerProcess: number;
}

export type PublicCanister = (PublicProduct & { maxPerContainer: number }) | null;

interface TitledItem {
  title: string;
  text: string;
}

export interface HeroBlock {
  type: 'hero';
  heading: string;
  lead?: string;
  image?: PublicImage;
  primaryCta?: SiteCta;
  secondaryCta?: SiteCta;
}
export interface TextBlock {
  type: 'text';
  heading?: string;
  body: string;
}
export interface FeaturesBlock {
  type: 'features';
  heading?: string;
  intro?: string;
  items: TitledItem[];
}
export interface StepsBlock {
  type: 'steps';
  heading?: string;
  intro?: string;
  items: TitledItem[];
}
export interface ProductGridBlock {
  type: 'product_grid';
  heading?: string;
  intro?: string;
  productSlugs?: string[];
  /** Serverseitig aufgelöst (aktive Produkte, aktueller Preis); Maschinen mit Behälterangaben. */
  products: Array<PublicProduct | PublicMachine>;
}
export interface IncludedItemsBlock {
  type: 'included_items';
  heading?: string;
  intro?: string;
  included: PublicIncluded;
  syrups: PublicProduct[];
  accessories: PublicProduct[];
  canister: PublicCanister;
}
export interface ImageBlock {
  type: 'image';
  image: PublicImage;
  caption?: string;
}
export interface GalleryBlock {
  type: 'gallery';
  heading?: string;
  images: PublicImage[];
}
export interface FaqBlock {
  type: 'faq';
  heading?: string;
  items: Array<{ question: string; answer: string }>;
}
export interface ReviewsBlock {
  type: 'reviews';
  heading?: string;
  intro?: string;
}
export interface ServiceAreasBlock {
  type: 'service_areas';
  heading?: string;
  intro?: string;
  areas: string[];
}
export interface SecondaryOffersBlock {
  type: 'secondary_offers';
  heading?: string;
  intro?: string;
}
export interface ContactDetailsBlock {
  type: 'contact_details';
  heading?: string;
  intro?: string;
}
export interface CtaBlock {
  type: 'cta';
  heading: string;
  text?: string;
  primary: SiteCta;
  secondary?: SiteCta;
}

export type PublicBlock =
  | HeroBlock
  | TextBlock
  | FeaturesBlock
  | StepsBlock
  | ProductGridBlock
  | IncludedItemsBlock
  | ImageBlock
  | GalleryBlock
  | FaqBlock
  | ReviewsBlock
  | ServiceAreasBlock
  | SecondaryOffersBlock
  | ContactDetailsBlock
  | CtaBlock;

// ── Seiten / Einstellungen (Design §2.5) ────────────────────────────────────

export interface PublicPage {
  path: string;
  pageType: SitePageType;
  revisionId: string;
  /** `null` nur in der Vorschau eines Entwurfs. */
  publishedAt: string | null;
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  blocks: PublicBlock[];
}

export interface PublicSiteSettings {
  businessName: string;
  tagline: string | null;
  phone: string | null;
  email: string | null;
  instagramUrl: string | null;
  logo: PublicImage | null;
  footerNote: string | null;
}

export interface PublicSitePageSummary {
  path: string;
  pageType: SitePageType;
  title: string;
  metaDescription: string | null;
}

export type ReviewMode = 'disabled' | 'google' | 'demo';

export interface PublicSiteBootstrap {
  environment: string;
  settings: PublicSiteSettings | null;
  /** Nur veröffentlichte Seiten. */
  pages: PublicSitePageSummary[];
  reviews: { mode: ReviewMode };
  /** Öffentliche Abholregion – nie die exakte Adresse. */
  pickupArea: string;
}

export interface PublicPreviewPage {
  preview: {
    revisionId: string;
    revisionNumber: number;
    expiresAt: string;
    entryKind: 'site_settings' | 'page';
  };
  page: PublicPage | null;
  settings: PublicSiteSettings | null;
}

// ── Konfigurator (Design §3.1–§3.3) ─────────────────────────────────────────

export interface PublicOccasion {
  value: string;
  label: string;
}

export interface PublicCatalog {
  asOf: string;
  machines: PublicMachine[];
  syrups: PublicProduct[];
  accessories: PublicProduct[];
  canister: PublicCanister;
  included: PublicIncluded;
  pickupArea: string;
  largeEventGuestThreshold: number;
  occasions: PublicOccasion[];
  priceNote: string;
}

export interface ConfiguratorPreviewRequest {
  guests?: number;
  machineSlug?: string;
  syrups?: {
    free: Array<{ slug: string; liters: number }>;
    extra: Array<{ slug: string; liters: number }>;
  };
  extras?: { cups25: number; straws25: number };
  canisters?: number;
  fulfillment?: 'pickup' | 'delivery';
}

export interface PublicConfiguratorPreview {
  recommendation: { machineSlug: string | null; message: string };
  largeEvent: boolean;
  quota: {
    freeSyrupLiters: number;
    assignedFreeLiters: number;
    unassignedFreeLiters: number;
    canisterMax: number;
  };
  fixed: Array<{ label: string; quantity: number; unitPriceCents: number; totalCents: number }>;
  fixedTotalCents: number;
  included: Array<{ label: string; quantity: number; unit: string }>;
  commission: Array<{ label: string; quantity: number; unitPriceCents: number; unit: string }>;
  delivery: { requested: boolean; text: string };
  issues: Array<{ code: string; message: string }>;
  priceNote: string;
}

export type InquiryFulfillment =
  | { type: 'pickup' }
  | {
      type: 'delivery';
      street: string;
      postalCode: string;
      city: string;
      windowFrom?: string;
      windowTo?: string;
    };

export type InquiryContact =
  | { type: 'private'; firstName: string; lastName: string; email: string; phone?: string }
  | {
      type: 'organization';
      organizationName: string;
      contactPerson: string;
      email: string;
      phone?: string;
    };

/** Body von `POST /public/inquiries` (strict – keine zusätzlichen Felder). */
export interface PublicInquiryRequest {
  clientMutationId: string;
  event: {
    date: string;
    startTime?: string;
    endTime?: string;
    guests: number;
    occasion: string;
  };
  machineSlug: string;
  syrups: {
    free: Array<{ slug: string; liters: number }>;
    extra: Array<{ slug: string; liters: number }>;
  };
  extras: { cups25: number; straws25: number };
  canisters: number;
  fulfillment: InquiryFulfillment;
  contact: InquiryContact;
  privacyAcknowledged: true;
}

export interface PublicInquiryResponse {
  processNumber: string;
  receivedAt: string;
}

// ── Bewertungen (Design §4/§11.2.6) ─────────────────────────────────────────

export interface PublicReview {
  authorName: string;
  authorUri: string | null;
  authorPhotoUri: string | null;
  rating: number;
  text: string;
  translated?: boolean;
  /** Nur Google, nur bei `translated`: Text in Originalsprache (optional aufklappbar). */
  originalText?: string | null;
  relativeTime: string | null;
  publishTime: string | null;
  reviewUri: string | null;
  flagUri: string | null;
}

export interface PublicReviewsResponse {
  mode: 'google' | 'demo';
  rating: number | null;
  total: number | null;
  placeUri: string | null;
  attribution: string;
  sortNote: string;
  /** Beschriftung übersetzter Bewertungen (nur google; additiv, ältere APIs liefern nichts). */
  translationNote?: string | null;
  /** Hinweis auf Googles Richtlinie zu Bewertungen (nur google). */
  policyNote?: string | null;
  /** Link zur Google-Richtlinie (nur google, nur https wird verlinkt). */
  policyUri?: string | null;
  reviews: PublicReview[];
}
