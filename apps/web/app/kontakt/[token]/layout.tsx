import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Phase 12 (UI): Kunden-Aktionslink – nie indexieren, Token nie per Referer
 * weitergeben (HTTP-Header zusätzlich in next.config.ts).
 * Phase 16 (WEB, Design §5): von `app/kontakt/layout.tsx` hierher verschoben – gilt nur noch
 * für `/kontakt/<token>`; die öffentliche Kontaktseite `/kontakt` hat eigene Metadaten.
 */
export const metadata: Metadata = {
  title: 'Miet-Royal – Kontakt für deinen Termin',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default function ContactLayout({ children }: { children: ReactNode }) {
  return children;
}
