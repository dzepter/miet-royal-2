import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PortalShell } from '../../components/portal-shell';

/**
 * Phase 15 (Kundenportal, Design §5): Layout aller /konto-Seiten – nie
 * indexieren, kein Referer (Fragment-Tokens, Buchungs-IDs), HTTP-Header
 * zusätzlich in next.config.ts. Alle Seiten darunter sind Client-Komponenten
 * und laden Kontodaten ausschließlich per Fetch – im HTML steht nichts davon.
 */
export const metadata: Metadata = {
  title: 'Miet-Royal – Kundenbereich',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default function PortalLayout({ children }: { children: ReactNode }) {
  return <PortalShell>{children}</PortalShell>;
}
