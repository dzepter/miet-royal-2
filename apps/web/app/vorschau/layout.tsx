import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Phase 16 (WEB, Design §2.4.5): CMS-Vorschau – nie indexieren/archivieren, kein Referer
 * (HTTP-Header Cache-Control no-store, X-Robots-Tag, Referrer-Policy, X-Frame-Options
 * zusätzlich in next.config.ts).
 */
export const metadata: Metadata = {
  title: 'Vorschau – Miet-Royal',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default function PreviewLayout({ children }: { children: ReactNode }) {
  return children;
}
