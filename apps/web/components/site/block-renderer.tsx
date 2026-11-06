import Link from 'next/link';
import type { ReactNode } from 'react';
import { reviewsSectionVisible } from '../../lib/reviews';
import { SITE_BLOCK_LABELS, contactDetailsPlan, visibleBlocks } from '../../lib/site-blocks';
import {
  formatNumber,
  isMachine,
  machineCapacityText,
  productPriceText,
  textParagraphs,
} from '../../lib/site-format';
import { CONFIGURATOR_PATH, pagesOfType, regionHrefForArea } from '../../lib/site-nav';
import type {
  ContactDetailsBlock,
  CtaBlock,
  FaqBlock,
  FeaturesBlock,
  GalleryBlock,
  HeroBlock,
  ImageBlock,
  IncludedItemsBlock,
  ProductGridBlock,
  PublicBlock,
  PublicSitePageSummary,
  PublicSiteSettings,
  ReviewMode,
  ServiceAreasBlock,
  SitePageType,
  StepsBlock,
  TextBlock,
} from '../../lib/site-types';
import { ReviewsSection } from './reviews-section';
import { SiteImage } from './site-image';
import { SiteLink } from './site-link';
import styles from './site.module.css';

/**
 * Phase 16 (WEB, Design §5 „Renderer“): EIN Block-Renderer für alle Blocktypen – gemeinsam für
 * öffentliche Seiten und `/vorschau/seite` (Order §9: Vorschau = echter Renderer).
 * Texte nur als React-Text (Absätze an Leerzeilen), kein `dangerouslySetInnerHTML`.
 * Preise ausschließlich aus dem Seiten-DTO (serverseitig aus products/product_prices).
 */

export interface BlockContext {
  pages: readonly PublicSitePageSummary[];
  published: ReadonlySet<string>;
  settings: PublicSiteSettings | null;
  reviewsMode: ReviewMode;
  pickupArea: string;
  /** Seitentitel – H1, wenn kein Hero-Block am Anfang steht. */
  title: string;
  /** Seitentyp (öffentlich und Vorschau) – steuert kontextabhängige Blöcke (Kontakt). */
  pageType: SitePageType | null;
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {textParagraphs(text).map((lines, index) => (
        <p key={index}>
          {lines.map((line, lineIndex) => (
            <span key={lineIndex}>
              {lineIndex > 0 ? <br /> : null}
              {line}
            </span>
          ))}
        </p>
      ))}
    </>
  );
}

function Section({
  block,
  index,
  children,
  tone,
}: {
  block: PublicBlock;
  index: number;
  children: ReactNode;
  tone?: 'sand' | undefined;
}) {
  return (
    <section
      className={`${styles.block} ${tone === 'sand' ? styles.blockSand : ''}`}
      data-block={block.type}
      data-block-label={SITE_BLOCK_LABELS[block.type]}
      data-testid={`cms-block-${block.type}`}
      data-index={index}
    >
      <div className={styles.container}>{children}</div>
    </section>
  );
}

function BlockHeading({
  heading,
  intro,
}: {
  heading?: string | undefined;
  intro?: string | undefined;
}) {
  return (
    <>
      {heading ? <h2 className={styles.h2}>{heading}</h2> : null}
      {intro ? <p className={styles.intro}>{intro}</p> : null}
    </>
  );
}

function HeroSection({ block, ctx }: { block: HeroBlock; ctx: BlockContext }) {
  return (
    <section className={styles.hero} data-block="hero" data-testid="cms-block-hero">
      <div className={`${styles.container} ${block.image ? styles.heroGrid : ''}`}>
        <div>
          <h1 className={styles.h1}>{block.heading}</h1>
          {block.lead ? <p className={styles.lead}>{block.lead}</p> : null}
          {block.primaryCta || block.secondaryCta ? (
            <div className={styles.buttonRow}>
              {block.primaryCta ? (
                <SiteLink
                  href={block.primaryCta.href}
                  published={ctx.published}
                  className={styles.button}
                  testId="hero-primary-cta"
                >
                  {block.primaryCta.label}
                </SiteLink>
              ) : null}
              {block.secondaryCta ? (
                <SiteLink
                  href={block.secondaryCta.href}
                  published={ctx.published}
                  className={styles.buttonSecondary}
                  testId="hero-secondary-cta"
                >
                  {block.secondaryCta.label}
                </SiteLink>
              ) : null}
            </div>
          ) : null}
        </div>
        {block.image ? (
          <div className={styles.heroMedia}>
            <SiteImage image={block.image} sizes="(min-width: 56rem) 34rem, 100vw" priority />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function TextSection({ block, index }: { block: TextBlock; index: number }) {
  return (
    <Section block={block} index={index}>
      {block.heading ? <h2 className={styles.h2}>{block.heading}</h2> : null}
      <div className={styles.prose}>
        <Paragraphs text={block.body} />
      </div>
    </Section>
  );
}

function FeaturesSection({ block, index }: { block: FeaturesBlock; index: number }) {
  return (
    <Section block={block} index={index}>
      <BlockHeading heading={block.heading} intro={block.intro} />
      <ul className={`${styles.cardGrid} ${styles.plainListReset}`}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex} className={styles.card}>
            <h3 className={styles.h3}>{item.title}</h3>
            <p className={styles.muted}>{item.text}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function StepsSection({ block, index }: { block: StepsBlock; index: number }) {
  return (
    <Section block={block} index={index} tone="sand">
      <BlockHeading heading={block.heading} intro={block.intro} />
      <ol className={styles.steps}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex} className={styles.step}>
            <div>
              <h3 className={styles.h3}>{item.title}</h3>
              <p>{item.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function ProductGridSection({ block, index }: { block: ProductGridBlock; index: number }) {
  return (
    <Section block={block} index={index}>
      <BlockHeading heading={block.heading} intro={block.intro} />
      <ul className={`${styles.cardGrid} ${styles.plainListReset}`} data-testid="product-grid">
        {block.products.map((product) => {
          const machine = isMachine(product) ? product : null;
          return (
            <li
              key={product.slug}
              className={styles.productCard}
              data-testid={`product-card-${product.slug}`}
            >
              <h3 className={styles.productName}>{product.name}</h3>
              {machine !== null ? (
                <p className={styles.productMeta}>{machineCapacityText(machine)}</p>
              ) : null}
              {product.description ? (
                <p className={styles.productMeta}>{product.description}</p>
              ) : null}
              <p className={styles.price} data-testid={`product-price-${product.slug}`}>
                {productPriceText(product)}
              </p>
              {machine !== null ? (
                <Link
                  href={`${CONFIGURATOR_PATH}?maschine=${encodeURIComponent(machine.slug)}`}
                  prefetch={false}
                  className={`${styles.buttonSecondary} ${styles.buttonSmall}`}
                >
                  Mit dieser Maschine anfragen
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className={styles.priceNote}>
        Aktuell hinterlegte Preise. Verbindlich wird der Preis erst mit deinem schriftlichen
        Angebot.
      </p>
    </Section>
  );
}

function IncludedItemsSection({ block, index }: { block: IncludedItemsBlock; index: number }) {
  const { included, syrups, accessories, canister } = block;
  const commission = [...syrups, ...accessories].filter(
    (item) => item.billingMode === 'commission',
  );
  return (
    <Section block={block} index={index} tone="sand">
      <BlockHeading heading={block.heading} intro={block.intro} />
      <div className={styles.includedGrid}>
        <div className={styles.card} data-testid="included-free">
          <h3 className={styles.h3}>Inklusive</h3>
          <ul className={styles.plainList}>
            <li>
              {formatNumber(included.freeSyrupLitersPerContainer)} L Sirup je Maschinenbehälter
            </li>
            <li>
              {included.cupsPerProcess} Becher und {included.strawsPerProcess} Strohhalme je
              Mietvorgang
            </li>
            {syrups.length > 0 ? (
              <li>
                Sorten: {syrups.map((syrup) => syrup.name.replace(/^Sirup\s+/i, '')).join(', ')}
              </li>
            ) : null}
          </ul>
        </div>
        {commission.length > 0 || canister !== null ? (
          <div className={styles.card} data-testid="included-extras">
            <h3 className={styles.h3}>Zusätzlich erhältlich</h3>
            <ul className={styles.plainList}>
              {commission.map((item) => (
                <li key={item.slug} className={styles.listRow}>
                  <span>{item.name}</span>
                  <span className={styles.listValue} data-testid={`included-price-${item.slug}`}>
                    {productPriceText(item)}
                  </span>
                </li>
              ))}
              {canister !== null ? (
                <li className={styles.listRow}>
                  <span>
                    {canister.name} <span className={styles.muted}>(empfohlen)</span>
                  </span>
                  <span
                    className={styles.listValue}
                    data-testid={`included-price-${canister.slug}`}
                  >
                    {productPriceText(canister)}
                  </span>
                </li>
              ) : null}
            </ul>
            {commission.length > 0 ? (
              <p className={`${styles.muted} ${styles.small}`}>
                Kommission: Berechnet wird, was geöffnet wurde – ungeöffnete Ware kannst du
                zurückgeben.
              </p>
            ) : null}
            {canister !== null ? (
              <p className={`${styles.muted} ${styles.small}`}>
                Mischkanister: höchstens {canister.maxPerContainer} je Maschinenbehälter.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </Section>
  );
}

function ImageSection({ block, index }: { block: ImageBlock; index: number }) {
  return (
    <Section block={block} index={index}>
      <figure className={styles.figure}>
        <SiteImage image={block.image} sizes="(min-width: 72rem) 68rem, 100vw" />
        {block.caption ? (
          <figcaption className={styles.figcaption}>{block.caption}</figcaption>
        ) : null}
      </figure>
    </Section>
  );
}

function GallerySection({ block, index }: { block: GalleryBlock; index: number }) {
  return (
    <Section block={block} index={index}>
      <BlockHeading heading={block.heading} />
      <ul className={`${styles.gallery} ${styles.plainListReset}`}>
        {block.images.map((image) => (
          <li key={image.mediaId} className={styles.figure}>
            <SiteImage image={image} sizes="(min-width: 48rem) 22rem, 100vw" />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function FaqSection({ block, index }: { block: FaqBlock; index: number }) {
  return (
    <Section block={block} index={index}>
      <BlockHeading heading={block.heading} />
      <div className={styles.faqList}>
        {block.items.map((item, itemIndex) => (
          <details key={itemIndex} className={styles.faqItem}>
            <summary>{item.question}</summary>
            <div className={styles.faqAnswer}>
              <Paragraphs text={item.answer} />
            </div>
          </details>
        ))}
      </div>
    </Section>
  );
}

function ServiceAreasSection({
  block,
  index,
  ctx,
}: {
  block: ServiceAreasBlock;
  index: number;
  ctx: BlockContext;
}) {
  return (
    <Section block={block} index={index}>
      <BlockHeading heading={block.heading} intro={block.intro} />
      <ul className={styles.chips}>
        {block.areas.map((area, areaIndex) => {
          const href = regionHrefForArea(area, ctx.pages);
          return (
            <li key={areaIndex} className={styles.chip}>
              {href !== null ? (
                <Link href={href} prefetch={false}>
                  {area}
                </Link>
              ) : (
                area
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function SecondaryOffersSection({
  block,
  index,
  ctx,
}: {
  block: { type: 'secondary_offers'; heading?: string; intro?: string };
  index: number;
  ctx: BlockContext;
}) {
  const offers = pagesOfType(ctx.pages, 'secondary_offer');
  return (
    <Section block={block} index={index}>
      <BlockHeading heading={block.heading} intro={block.intro} />
      <ul className={`${styles.cardGrid} ${styles.plainListReset}`}>
        {offers.map((page) => (
          <li key={page.path} className={styles.card}>
            <h3 className={styles.h3}>
              <Link href={page.path} prefetch={false}>
                {page.title}
              </Link>
            </h3>
            {page.metaDescription ? <p className={styles.muted}>{page.metaDescription}</p> : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ContactDetailsSection({
  block,
  index,
  ctx,
}: {
  block: ContactDetailsBlock;
  index: number;
  ctx: BlockContext;
}) {
  // Review content_ux-2: auf Popcorn-/Waffel-Seiten (secondary_offer) weder Abholzeile noch
  // Konfigurator-Knopf – nur Telefon/E-Mail aus den Einstellungen.
  const plan = contactDetailsPlan({
    pageType: ctx.pageType,
    settings: ctx.settings,
    pickupArea: ctx.pickupArea,
  });
  return (
    <Section block={block} index={index}>
      <BlockHeading heading={block.heading} intro={block.intro} />
      {plan.emptyText === null ? (
        <ul className={styles.contactList} data-testid="contact-details">
          {plan.phone !== null ? (
            <li>
              <span className={styles.contactLabel}>Telefon</span>
              <a className={styles.contactValue} href={plan.phone.href}>
                {plan.phone.text}
              </a>
            </li>
          ) : null}
          {plan.email !== null ? (
            <li>
              <span className={styles.contactLabel}>E-Mail</span>
              <a className={styles.contactValue} href={plan.email.href}>
                {plan.email.text}
              </a>
            </li>
          ) : null}
          {plan.instagram !== null ? (
            <li>
              <span className={styles.contactLabel}>Instagram</span>
              <a className={styles.contactValue} href={plan.instagram} rel="noopener noreferrer">
                Zu unserem Instagram-Profil
              </a>
            </li>
          ) : null}
          {plan.pickupArea !== null ? (
            <li data-testid="contact-pickup">
              <span className={styles.contactLabel}>Abholung</span>
              <span className={styles.contactValue}>{plan.pickupArea}</span>
            </li>
          ) : null}
        </ul>
      ) : (
        <p className={styles.muted} data-testid="contact-details-empty">
          {plan.emptyText}
        </p>
      )}
      {plan.inquiryCta !== null ? (
        <div className={styles.buttonRow}>
          <Link
            href={plan.inquiryCta.href}
            prefetch={false}
            className={styles.button}
            data-testid="contact-inquiry-cta"
          >
            {plan.inquiryCta.label}
          </Link>
        </div>
      ) : null}
    </Section>
  );
}

function CtaSection({ block, ctx }: { block: CtaBlock; ctx: BlockContext }) {
  return (
    <section className={styles.ctaBand} data-block="cta" data-testid="cms-block-cta">
      <div className={styles.container}>
        <h2 className={styles.h2}>{block.heading}</h2>
        {block.text ? <p>{block.text}</p> : null}
        <div className={styles.buttonRow}>
          <SiteLink
            href={block.primary.href}
            published={ctx.published}
            className={styles.buttonOnDark}
          >
            {block.primary.label}
          </SiteLink>
          {block.secondary ? (
            <SiteLink
              href={block.secondary.href}
              published={ctx.published}
              className={styles.buttonSecondary}
            >
              {block.secondary.label}
            </SiteLink>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Ein Block ⇒ Darstellung. `switch` über alle Typen; `never` sichert Vollständigkeit. */
function renderBlock(block: PublicBlock, index: number, ctx: BlockContext): ReactNode {
  switch (block.type) {
    case 'hero':
      return <HeroSection key={index} block={block} ctx={ctx} />;
    case 'text':
      return <TextSection key={index} block={block} index={index} />;
    case 'features':
      return <FeaturesSection key={index} block={block} index={index} />;
    case 'steps':
      return <StepsSection key={index} block={block} index={index} />;
    case 'product_grid':
      return <ProductGridSection key={index} block={block} index={index} />;
    case 'included_items':
      return <IncludedItemsSection key={index} block={block} index={index} />;
    case 'image':
      return <ImageSection key={index} block={block} index={index} />;
    case 'gallery':
      return <GallerySection key={index} block={block} index={index} />;
    case 'faq':
      return <FaqSection key={index} block={block} index={index} />;
    case 'reviews':
      return reviewsSectionVisible(ctx.reviewsMode) ? (
        <Section key={index} block={block} index={index}>
          <ReviewsSection
            mode={ctx.reviewsMode}
            heading={block.heading ?? 'Das sagen unsere Kundinnen und Kunden'}
            intro={block.intro}
          />
        </Section>
      ) : null;
    case 'service_areas':
      return <ServiceAreasSection key={index} block={block} index={index} ctx={ctx} />;
    case 'secondary_offers':
      return <SecondaryOffersSection key={index} block={block} index={index} ctx={ctx} />;
    case 'contact_details':
      return <ContactDetailsSection key={index} block={block} index={index} ctx={ctx} />;
    case 'cta':
      return <CtaSection key={index} block={block} ctx={ctx} />;
    default: {
      const unknown: never = block;
      void unknown;
      return null;
    }
  }
}

/**
 * Seiteninhalt: H1 = Hero-Überschrift (wenn erster Block) oder Seitentitel; danach alle
 * darstellbaren Blöcke in Reihenfolge.
 */
export function CmsBlocks({ blocks, ctx }: { blocks: readonly PublicBlock[]; ctx: BlockContext }) {
  const shown = visibleBlocks(blocks, {
    reviewsMode: ctx.reviewsMode,
    pages: ctx.pages,
    settings: ctx.settings,
  });
  const heroFirst = shown[0]?.type === 'hero';
  return (
    <div data-testid="cms-page">
      {heroFirst ? null : (
        <header className={styles.pageHeader}>
          <div className={styles.container}>
            <h1 className={styles.h1}>{ctx.title}</h1>
          </div>
        </header>
      )}
      {shown.map((block, index) => renderBlock(block, index, ctx))}
    </div>
  );
}
