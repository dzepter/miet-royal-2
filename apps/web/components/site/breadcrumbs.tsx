import Link from 'next/link';
import type { BreadcrumbItem } from '../../lib/site-nav';
import styles from './site.module.css';

/**
 * Phase 17 (WEB-META, Design D11, Auftrag §14): sichtbare Brotkrume (Regions- und
 * Secondary-Offer-Seiten) – `<nav aria-label="Brotkrumen">` mit `<ol>`, letzte Position als
 * `aria-current="page"` ohne Link, Trennzeichen rein per CSS (kein Text im DOM), mobil
 * umbrechend, Touchziele mindestens 44 px hoch. Auch in der Vorschau sichtbar (gleicher
 * Renderer); die zugehörige `BreadcrumbList` (JSON-LD) kommt nur auf indexierbaren Seiten dazu.
 */
export function Breadcrumbs({ items }: { items: readonly BreadcrumbItem[] }) {
  if (items.length === 0) return null;
  const last = items.length - 1;
  return (
    <nav aria-label="Brotkrumen" className={styles.breadcrumbs} data-testid="site-breadcrumbs">
      <div className={styles.container}>
        <ol className={styles.breadcrumbList}>
          {items.map((item, index) => (
            <li key={item.href}>
              {index === last ? (
                <span aria-current="page">{item.name}</span>
              ) : (
                <Link href={item.href} prefetch={false}>
                  {item.name}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </div>
    </nav>
  );
}
