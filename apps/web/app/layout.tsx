import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { getDemoMode } from '../components/site/site-data';
import { DEMO_BANNER_TEXT } from '../lib/environment';
import { NOINDEX_ROBOTS } from '../lib/site-meta';

/**
 * Phase 16 (WEB, Design §1.7/§5/§11.2.9): schlanke Root-Metadaten – KEIN Titel-Template
 * (Portal-/Token-Titel bleiben unverändert; Website-Seiten setzen ihren Titel selbst).
 * Phase 17 (WEB-META, Design D2): `robots` ist hier IMMER noindex/nofollow – der fail-closed
 * Default für alles, was sich nicht ausdrücklich freigibt. Jede Website-Seite entscheidet selbst
 * über `seoContext` (index nur mit WEB_INDEXING_ENABLED=true, ohne Demo, mit gültiger
 * öffentlicher Basis, ohne Origin-Sperre und nur für veröffentlichte Inhalte). Token-Seiten,
 * /konto, /vorschau und die 404-Seite setzen `robots` in ihren Layouts/Metadaten immer noindex.
 */
export const metadata: Metadata = {
  title: 'Miet-Royal',
  robots: { ...NOINDEX_ROBOTS },
};

/**
 * Phase 14 (Design §3): fester Demo-Banner auf ALLEN öffentlichen Seiten der
 * Demo-Web-Instanz (`WEB_APP_ENV=demo` ODER die konfigurierte API meldet über
 * `/health` `environment: 'demo'`, Review F6) – Text + Rahmen, nie nur Farbe.
 */
function DemoBanner() {
  return (
    <div
      data-testid="demo-banner"
      role="status"
      aria-label={DEMO_BANNER_TEXT}
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        margin: 0,
        padding: '0.6rem 1rem',
        textAlign: 'center',
        fontWeight: 700,
        letterSpacing: '0.02em',
        background: '#fff7ed',
        color: '#7c2d12',
        borderBottom: '3px solid #b45309',
      }}
    >
      {DEMO_BANNER_TEXT}
    </div>
  );
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Zur Laufzeit (nicht zur Build-Zeit) aus der Umgebung des Web-Servers lesen:
  // die Demo-Instanz MUSS WEB_APP_ENV=demo setzen (docs/ENVIRONMENTS.md).
  // Review F6: zusätzlich zählt `environment: 'demo'` aus GET <WEB_API_ORIGIN>/health
  // (Timeout 1 s, no-store; Fehler ⇒ nur WEB_APP_ENV) – nie ausblenden bei WEB_APP_ENV=demo.
  // Phase 17: dieselbe je Request deduplizierte Entscheidung (`getDemoMode`, site-data.ts)
  // nutzen auch die Seiten-Metadaten (Demo ⇒ noindex), robots.txt und die Sitemap.
  await connection();
  const showDemoBanner = await getDemoMode();
  return (
    <html lang="de">
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, sans-serif',
          minHeight: '100vh',
          background: '#fafafa',
          color: '#1a1a1a',
        }}
      >
        {showDemoBanner && <DemoBanner />}
        {children}
      </body>
    </html>
  );
}
