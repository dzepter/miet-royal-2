import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Miet-Royal Staff',
  description: 'Mitarbeiter-App von Miet-Royal 2.0 (Phase 0, Platzhalter).',
  robots: { index: false, follow: false },
};

// Mobile-first: die Staff-App wird später als PWA auf Handy und Tablet
// genutzt (ARCHITECTURE.md). Phase 0 stellt nur sicher, dass die Shell
// responsiv startet.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, sans-serif',
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f4f5f7',
          color: '#1a1a1a',
          padding: '1rem',
        }}
      >
        {children}
      </body>
    </html>
  );
}
