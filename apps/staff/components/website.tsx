'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { hasPermission, type Me } from '../lib/api';
import { CMS_STATUS_LABELS, seoScopeLabel, type CmsEntryStatus, type SeoWarning } from '../lib/cms';

/**
 * Phase 16 (STAFF): gemeinsame Bausteine des Bereichs „Website“ (Design §6).
 * Rechte steuern nur die Anzeige – jede Aktion prüft der Server erneut.
 */

export function canReadCms(me: Me | null): boolean {
  return hasPermission(me, 'cms.edit') || hasPermission(me, 'cms.publish');
}

export function WebsiteSubnav({ me }: { me: Me | null }) {
  const pathname = usePathname() ?? '';
  const links = [
    { href: '/website', label: 'Übersicht', show: true },
    { href: '/website/medien', label: 'Medien', show: true },
    {
      href: '/website/produkte',
      label: 'Produkte & Preise',
      show: hasPermission(me, 'product.view'),
    },
  ];
  return (
    <nav
      aria-label="Bereich Website"
      style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}
    >
      {links
        .filter((link) => link.show)
        .map((link) => {
          const active =
            link.href === '/website' ? pathname === '/website' : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`button-like${active ? ' primary' : ''}`}
              aria-current={active ? 'page' : undefined}
            >
              {link.label}
            </Link>
          );
        })}
    </nav>
  );
}

/** Status immer als Text (nie nur Farbe, UX_RULES). */
export function CmsStatusBadge({ status }: { status: CmsEntryStatus }) {
  const className =
    status === 'published' ? 'badge active' : status === 'never_published' ? 'badge' : 'badge warn';
  return (
    <span className={className} data-testid="cms-status">
      {CMS_STATUS_LABELS[status]}
    </span>
  );
}

export function CmsNoAccess({ title }: { title: string }) {
  return (
    <main className="page">
      <h1>{title}</h1>
      <p className="error" data-testid="website-not-available">
        Für den Bereich „Website“ brauchst du das Recht „Website-Inhalte bearbeiten“ oder
        „Website-Inhalte veröffentlichen“.
      </p>
    </main>
  );
}

/**
 * Phase 17 (STAFF, Design D12): Hinweise zur Suchmaschinen-Darstellung aus
 * `GET /staff/cms/seo-check`. Reine Redaktionshinweise – nichts wird blockiert, kein Score.
 * Farbe nie allein (UX_RULES): Textlabel „Hinweis“, Scope als Text. Ohne Hinweise wird nichts
 * gerendert. Je Zeile: Scope, Pfad, Meldung des Servers und – nur mit `entryId` und außerhalb
 * des eigenen Editors – ein Link „Bearbeiten“; Katalog-Hinweise verlinken `catalogHref`
 * (Phase 17, Review RC-5: die Produktverwaltung `/produkte`, in der Name, Beschreibung und
 * Verkaufseinheit geändert werden – nicht die Lesesicht, die das Produkt ausblendet).
 */
export function SeoWarningsBox({
  warnings,
  testId,
  title = 'Hinweise zur Suchmaschinen-Darstellung',
  intro,
  headingLevel = 2,
  currentEntryId,
  catalogHref,
}: {
  warnings: readonly SeoWarning[];
  testId: string;
  title?: string;
  /** Kurzer Satz unter der Überschrift (optional). */
  intro?: string;
  headingLevel?: 2 | 3;
  /** Eintrag, in dessen Editor der Kasten steht: kein Selbst-Link, kein Pfad je Zeile. */
  currentEntryId?: string;
  /** Ziel für Katalog-Hinweise (Scope „Produkte & Preise“: die Produktverwaltung); ohne Angabe kein Link. */
  catalogHref?: string | undefined;
}) {
  if (warnings.length === 0) return null;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const headingId = `${testId}-title`;
  return (
    <section className="conflict-box" data-testid={testId} aria-labelledby={headingId}>
      <Heading id={headingId} style={{ margin: 0, fontSize: '1rem' }}>
        <span className="badge warn">Hinweis</span> {title}
      </Heading>
      {intro !== undefined && (
        <p className="muted" style={{ margin: '0.25rem 0 0' }}>
          {intro}
        </p>
      )}
      <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>
        {warnings.map((warning, index) => {
          const ownEntry = warning.entryId !== null && warning.entryId === currentEntryId;
          const editHref =
            warning.entryId !== null && !ownEntry ? `/website/eintrag/${warning.entryId}` : null;
          const productsHref =
            editHref === null && warning.scope === 'catalog' ? (catalogHref ?? null) : null;
          return (
            <li
              key={`${warning.scope}-${warning.code}-${warning.entryId ?? ''}-${index}`}
              data-testid="cms-seo-warning"
              data-code={warning.code}
              data-scope={warning.scope}
              data-entry-id={warning.entryId ?? undefined}
            >
              <span className="badge">{seoScopeLabel(warning.scope)}</span>{' '}
              {warning.path !== null && !ownEntry && (
                <>
                  <code>{warning.path}</code>:{' '}
                </>
              )}
              {warning.message}
              {editHref !== null && (
                <>
                  {' '}
                  <Link href={editHref}>Bearbeiten</Link>
                </>
              )}
              {productsHref !== null && (
                <>
                  {' '}
                  <Link href={productsHref}>Produkte &amp; Preise öffnen</Link>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
