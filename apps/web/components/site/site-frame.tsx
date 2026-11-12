import Link from 'next/link';
import type { ReactNode } from 'react';
import { phoneHref } from '../../lib/site-format';
import {
  CONFIGURATOR_PATH,
  PORTAL_PATH,
  PRIMARY_CTA_LABEL,
  footerLegalLinks,
  isCurrentNavItem,
  pagesOfType,
  publishedPathSet,
  safeInstagramUrl,
  visibleNavItems,
} from '../../lib/site-nav';
import type { PublicSiteBootstrap, PublicSiteSettings } from '../../lib/site-types';
import { MobileNav } from './mobile-nav';
import { SiteImage } from './site-image';
import styles from './site.module.css';

/**
 * Phase 16 (WEB, Design §5 „Struktur/Navigation“): Rahmen der öffentlichen Website
 * (Kopf mit Navigation und dominantem CTA „Slush konfigurieren“, Fußbereich mit Kontakt aus
 * den veröffentlichten Einstellungen). NUR auf Website-Seiten – nicht auf /konto, Token-Seiten
 * oder der Vorschau-Einlöseseite. Links auf nicht veröffentlichte Seiten werden ausgeblendet;
 * Instagram nur als normaler Link, wenn gepflegt; Impressum/Datenschutz nur, wenn veröffentlicht.
 * Ohne erreichbare API (bootstrap null) bleiben Start, Konfigurator und Kundenbereich.
 */
export function SiteFrame({
  bootstrap,
  settingsOverride,
  currentPath,
  banner,
  children,
}: {
  bootstrap: PublicSiteBootstrap | null;
  /** Nur Vorschau der Website-Einstellungen: Entwurf statt veröffentlichter Einstellungen. */
  settingsOverride?: PublicSiteSettings | null | undefined;
  currentPath: string;
  /** Optionaler Hinweis oberhalb des Kopfs (z. B. Vorschau-Banner). */
  banner?: ReactNode;
  children: ReactNode;
}) {
  const settings =
    settingsOverride !== undefined ? settingsOverride : (bootstrap?.settings ?? null);
  const pages = bootstrap?.pages ?? [];
  const published = publishedPathSet(pages);
  const navItems = visibleNavItems(published);
  const businessName = settings?.businessName ?? 'Miet-Royal';
  const legalLinks = footerLegalLinks(published);
  const secondaryOffers = pagesOfType(pages, 'secondary_offer');
  const regions = pagesOfType(pages, 'region');
  const instagram = safeInstagramUrl(settings?.instagramUrl);
  const phone = settings?.phone?.trim() ?? '';
  const tel = phone === '' ? null : phoneHref(phone);
  const email = settings?.email?.trim() ?? '';
  const siteLinks = navItems.filter(
    (item) => item.href !== '/' && item.href !== PORTAL_PATH && item.href !== '/kontakt',
  );

  // Marken-Link ohne jeden Text (dekoratives Logo, kein Slogan) bekommt einen expliziten Namen.
  const brandNeedsLabel =
    settings?.logo !== null &&
    settings?.logo !== undefined &&
    (settings.logo.decorative || settings.logo.alt.trim() === '') &&
    !settings.tagline;
  return (
    <div className={styles.site} data-testid="site-frame">
      <a href="#inhalt" className={styles.skipLink}>
        Zum Inhalt springen
      </a>
      {banner}
      <header className={styles.header} data-testid="site-header">
        <div className={`${styles.container} ${styles.headerInner}`}>
          <Link
            href="/"
            prefetch={false}
            className={styles.brand}
            // Phase 17 (A11y, WCAG 2.5.3 „Label in Name“): Hat der Link sichtbaren Text
            // (Wortmarke und/oder Slogan) oder ein Logo mit Alt-Text, ist dieser Text sein
            // zugänglicher Name – ein abweichendes `aria-label` meldet Lighthouse/axe als
            // `label-content-name-mismatch`. Nur ein dekoratives Logo ohne Slogan braucht den Namen.
            aria-label={brandNeedsLabel ? `${businessName} – Startseite` : undefined}
            data-testid="site-brand"
          >
            {settings?.logo ? (
              <SiteImage image={settings.logo} sizes="12rem" priority className={styles.logo} />
            ) : (
              <span className={styles.wordmark}>{businessName}</span>
            )}
            {settings?.tagline ? (
              <span className={styles.brandTagline}>{settings.tagline}</span>
            ) : null}
          </Link>
          <nav aria-label="Hauptnavigation" className={styles.nav} data-testid="site-nav">
            <ul className={styles.navList}>
              {navItems.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    prefetch={false}
                    className={styles.navLink}
                    aria-current={isCurrentNavItem(currentPath, item.href) ? 'page' : undefined}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <Link
            href={CONFIGURATOR_PATH}
            prefetch={false}
            className={`${styles.button} ${styles.buttonSmall} ${styles.headerCta}`}
            data-testid="site-cta-configure"
          >
            {PRIMARY_CTA_LABEL}
          </Link>
          <MobileNav items={navItems} ctaHref={CONFIGURATOR_PATH} ctaLabel={PRIMARY_CTA_LABEL} />
        </div>
      </header>

      <main id="inhalt" className={styles.main} tabIndex={-1}>
        {children}
      </main>

      <footer className={styles.footer} data-testid="site-footer">
        <div className={styles.container}>
          <div className={styles.footerGrid}>
            <div>
              <p className={styles.footerBrand}>{businessName}</p>
              {settings?.tagline ? <p>{settings.tagline}</p> : null}
              {settings?.footerNote ? <p className={styles.small}>{settings.footerNote}</p> : null}
            </div>
            {tel !== null || email !== '' || instagram !== null ? (
              <div>
                <h2 className={styles.footerHeading}>Kontakt</h2>
                <ul className={styles.footerList} data-testid="site-footer-contact">
                  {tel !== null ? (
                    <li>
                      <a href={tel}>{phone}</a>
                    </li>
                  ) : null}
                  {email !== '' ? (
                    <li>
                      <a href={`mailto:${email}`}>{email}</a>
                    </li>
                  ) : null}
                  {instagram !== null ? (
                    <li>
                      <a href={instagram} rel="noopener noreferrer" data-testid="site-instagram">
                        Instagram
                      </a>
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}
            <div>
              <h2 className={styles.footerHeading}>Website</h2>
              <ul className={styles.footerList}>
                <li>
                  <Link href={CONFIGURATOR_PATH} prefetch={false}>
                    {PRIMARY_CTA_LABEL}
                  </Link>
                </li>
                {siteLinks.map((item) => (
                  <li key={item.href}>
                    <Link href={item.href} prefetch={false}>
                      {item.label}
                    </Link>
                  </li>
                ))}
                {published.has('/kontakt') ? (
                  <li>
                    <Link href="/kontakt" prefetch={false}>
                      Kontakt
                    </Link>
                  </li>
                ) : null}
                <li>
                  <Link href={PORTAL_PATH} prefetch={false}>
                    Kundenbereich
                  </Link>
                </li>
              </ul>
            </div>
            {secondaryOffers.length > 0 || regions.length > 0 ? (
              <div>
                <h2 className={styles.footerHeading}>Mehr von uns</h2>
                <ul className={styles.footerList}>
                  {secondaryOffers.map((page) => (
                    <li key={page.path}>
                      <Link href={page.path} prefetch={false}>
                        {page.title}
                      </Link>
                    </li>
                  ))}
                  {regions.map((page) => (
                    <li key={page.path}>
                      <Link href={page.path} prefetch={false}>
                        {page.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
          <div className={styles.footerBottom}>
            {legalLinks.length > 0 ? (
              <ul className={styles.footerInline} data-testid="site-footer-legal">
                {legalLinks.map((item) => (
                  <li key={item.href}>
                    <Link href={item.href} prefetch={false}>
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </footer>
    </div>
  );
}
