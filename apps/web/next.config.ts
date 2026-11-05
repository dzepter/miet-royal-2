import type { NextConfig } from 'next';

const API_ORIGIN = process.env.WEB_API_ORIGIN ?? 'http://127.0.0.1:3101';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins: ['127.0.0.1'],
  // Phase 14 (E2E-Fix): optional eigenes Build-/Dev-Verzeichnis je Instanz (z. B. `.next/demo`
  // für die Demo-Web-Instanz der E2E-Suite mit WEB_APP_ENV=demo). `next dev` sperrt sein
  // distDir – zwei Dev-Server desselben Projekts brauchen getrennte Verzeichnisse.
  ...(process.env.WEB_DIST_DIR === undefined ? {} : { distDir: process.env.WEB_DIST_DIR }),
  // Same-Origin-Proxy zur API (wie in apps/staff): Browseranfragen laufen
  // über /api/* – kein Cross-Site-Verkehr, der CSRF-Schutz bleibt strikt,
  // und es liegen KEINE Storage-/API-Secrets im Frontend.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/:path*` }];
  },
  // Phase 12 (UI): Token-Seiten (Kontakt-Aktionslink, Dokumentlink) – nie cachen,
  // nie indexieren, Token nie per Referer an Dritte; keine Einbettung fremder Seiten.
  async headers() {
    const tokenPageHeaders = [
      { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
    ];
    // Phase 15 (portal): Kundenportal /konto – authentifizierte Seiten nie cachen
    // (kein Next-Cache/CDN mit Kontodaten), nie indexieren, kein Referer, keine
    // Einbettung (Order §50). Die Seiten selbst sind 'use client' und laden
    // Daten ausschließlich per Fetch; das HTML enthält keine Kontodaten.
    const portalPageHeaders = [
      { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow, nocache' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
    ];
    return [
      { source: '/kontakt/:token', headers: tokenPageHeaders },
      { source: '/dokument/:token', headers: tokenPageHeaders },
      { source: '/konto', headers: portalPageHeaders },
      { source: '/konto/:path*', headers: portalPageHeaders },
    ];
  },
};

export default nextConfig;
