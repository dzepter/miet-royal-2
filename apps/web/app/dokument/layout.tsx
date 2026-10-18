import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Phase 12 (UI): sicherer Dokumentlink – nie indexieren, Token nie per
 * Referer weitergeben (HTTP-Header zusätzlich in next.config.ts).
 */
export const metadata: Metadata = {
  title: 'Miet-Royal – Dokument',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default function DocumentLayout({ children }: { children: ReactNode }) {
  return children;
}
