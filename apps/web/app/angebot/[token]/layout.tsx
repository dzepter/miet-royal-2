import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Phase 16 (WEB, Design §1.7/§5): öffentlicher Angebotslink – nie indexieren, Token nie per
 * Referer weitergeben (HTTP-Header wie /dokument/:token zusätzlich in next.config.ts). Die
 * Seite selbst bleibt unverändert (Client-Komponente, Daten nur per Fetch).
 */
export const metadata: Metadata = {
  title: 'Miet-Royal – Angebot',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default function OfferLayout({ children }: { children: ReactNode }) {
  return children;
}
