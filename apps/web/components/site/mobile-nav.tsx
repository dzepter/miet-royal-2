'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { isCurrentNavItem, type SiteNavItem } from '../../lib/site-nav';
import styles from './site.module.css';

/**
 * Phase 16 (WEB, Design §5 „Navigation“): Mobile-Menü – Knopf mit `aria-expanded`/
 * `aria-controls`, schließt bei Escape (Fokus zurück auf den Knopf), bei Linkklick und
 * Seitenwechsel. Ohne JavaScript bleibt die Navigation im Fußbereich erreichbar.
 */
export function MobileNav({
  items,
  ctaHref,
  ctaLabel,
}: {
  items: SiteNavItem[];
  ctaHref: string;
  ctaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [lastPath, setLastPath] = useState(pathname);

  // Seitenwechsel ⇒ Menü schließen (State-Abgleich während des Renderns, ohne Effekt-Kaskade).
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.menuButton}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        data-testid="site-menu-button"
      >
        <span className={styles.menuIcon} aria-hidden="true" />
        {open ? 'Schließen' : 'Menü'}
      </button>
      <div id={panelId} className={styles.mobilePanel} hidden={!open} data-testid="site-mobile-nav">
        <nav aria-label="Hauptnavigation (mobil)" className={styles.container}>
          <ul className={styles.mobileList}>
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  prefetch={false}
                  className={styles.mobileLink}
                  aria-current={isCurrentNavItem(pathname, item.href) ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <Link
            href={ctaHref}
            prefetch={false}
            className={styles.button}
            onClick={() => setOpen(false)}
          >
            {ctaLabel}
          </Link>
        </nav>
      </div>
    </>
  );
}
