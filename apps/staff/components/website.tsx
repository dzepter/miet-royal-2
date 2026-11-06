'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { hasPermission, type Me } from '../lib/api';
import { CMS_STATUS_LABELS, type CmsEntryStatus } from '../lib/cms';

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
