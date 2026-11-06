import Link from 'next/link';
import { CONFIGURATOR_PATH, PRIMARY_CTA_LABEL } from '../../lib/site-nav';
import styles from './site.module.css';

/**
 * Phase 16 (WEB, Design §5): einfache Zustandsseiten der Website – ohne Stacktrace, ohne
 * technische Codes (CLAUDE.md UX). Rendern innerhalb von `SiteFrame`.
 */

/** Startseite ohne veröffentlichten Inhalt (frische Umgebung, Demo nach Reset). */
export function FallbackHome({ businessName }: { businessName: string }) {
  return (
    <section className={styles.statusPage} data-testid="site-fallback-home">
      <div className={`${styles.container} ${styles.narrow}`}>
        <h1 className={`${styles.h1} ${styles.fallbackBrand}`}>{businessName}</h1>
        <p className={styles.lead}>Unsere neue Website wird gerade vorbereitet.</p>
        <div className={styles.buttonRow}>
          <Link href={CONFIGURATOR_PATH} prefetch={false} className={styles.button}>
            {PRIMARY_CTA_LABEL}
          </Link>
        </div>
      </div>
    </section>
  );
}

/** API nicht erreichbar: freundliche Meldung, Rest der Website bleibt bedienbar. */
export function SiteUnavailable({ title }: { title?: string | undefined }) {
  return (
    <section className={styles.statusPage} data-testid="site-unavailable">
      <div className={`${styles.container} ${styles.narrow}`}>
        <h1 className={styles.h1}>{title ?? 'Gleich wieder da'}</h1>
        <p className={styles.lead}>
          Diese Seite ist gerade nicht erreichbar. Bitte versuche es in ein paar Minuten noch
          einmal.
        </p>
        <p className={styles.muted}>
          Deine Anfrage kannst du auch später über den Konfigurator stellen – wir melden uns
          persönlich bei dir.
        </p>
      </div>
    </section>
  );
}

/** Seite nicht gefunden (inkl. nicht veröffentlichter CMS-Seiten). */
export function SiteNotFound() {
  return (
    <section className={styles.statusPage} data-testid="site-not-found">
      <div className={`${styles.container} ${styles.narrow}`}>
        <p className={styles.eyebrow}>Seite nicht gefunden</p>
        <h1 className={styles.h1}>Diese Seite gibt es nicht (mehr).</h1>
        <p className={styles.lead}>
          Vielleicht hat sich die Adresse geändert. Auf der Startseite findest du alles rund um
          unsere Slushmaschinen.
        </p>
        <div className={styles.buttonRow}>
          <Link href="/" prefetch={false} className={styles.buttonSecondary}>
            Zur Startseite
          </Link>
          <Link href={CONFIGURATOR_PATH} prefetch={false} className={styles.button}>
            {PRIMARY_CTA_LABEL}
          </Link>
        </div>
      </div>
    </section>
  );
}
