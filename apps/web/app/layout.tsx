import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Miet-Royal 2.0 – Entwicklungsstand',
  description: 'Technische Basis der neuen Miet-Royal-Website (Phase 0, kein Inhalt).',
  robots: { index: false, follow: false },
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
          background: '#fafafa',
          color: '#1a1a1a',
        }}
      >
        {children}
      </body>
    </html>
  );
}
