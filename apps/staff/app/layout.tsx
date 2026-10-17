import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { PwaRegister } from '../components/pwa-register';
import './globals.css';

export const metadata: Metadata = {
  title: 'Miet-Royal Staff',
  description: 'Mitarbeiter-App von Miet-Royal 2.0.',
  robots: { index: false, follow: false },
  // Phase 8: installierbare PWA (Manifest, Homescreen-Titel, iOS-Standalone).
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'MR Staff', statusBarStyle: 'default' },
};

// Mobile-first: die Staff-App wird als PWA auf Handy und Tablet genutzt
// (ARCHITECTURE.md); Theme-Farbe für die Browser-/Standalone-Leiste.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1f4e8c',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="de">
      <body>
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
