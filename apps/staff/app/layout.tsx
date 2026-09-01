import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Miet-Royal Staff',
  description: 'Mitarbeiter-App von Miet-Royal 2.0.',
  robots: { index: false, follow: false },
};

// Mobile-first: die Staff-App wird später als PWA auf Handy und Tablet
// genutzt (ARCHITECTURE.md).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
