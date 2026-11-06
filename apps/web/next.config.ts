import type { NextConfig } from 'next';

const API_ORIGIN = process.env.WEB_API_ORIGIN ?? 'http://127.0.0.1:3101';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Phase 16 (WEB, Design §11.2.10): beim Build verwendeter API-Origin (Ziel des Rewrites unten,
  // ins routes-manifest gebacken). `lib/site-api.ts` vergleicht ihn zur Laufzeit mit
  // WEB_API_ORIGIN (SSR); bei Abweichung bleiben Konfigurator-Absenden, Vorschau und Bewertungen
  // gesperrt.
  // Nur serverseitig referenziert – nie in Client-Komponenten verwenden.
  env: { MR_BUILD_API_ORIGIN: API_ORIGIN },
  poweredByHeader: false,
  allowedDevOrigins: ['127.0.0.1'],
  // Phase 14 (E2E-Fix): optional eigenes Build-/Dev-Verzeichnis je Instanz (z. B. `.next/demo`
  // für die Demo-Web-Instanz der E2E-Suite mit WEB_APP_ENV=demo). `next dev` sperrt sein
  // distDir – zwei Dev-Server desselben Projekts brauchen getrennte Verzeichnisse.
  ...(process.env.WEB_DIST_DIR === undefined ? {} : { distDir: process.env.WEB_DIST_DIR }),
  // Phase 15 (Review R3): Der Rewrite `/api/*` klont den Request-Body und puffert ihn nur bis
  // `proxyClientMaxBodySize` (Next-Default 10 MiB); größere Bodies kommen OHNE Fehler abgeschnitten
  // bei der API an (Content-Length unverändert ⇒ Timeout statt sauberem 413). Kette:
  // Client-Vorprüfung 8 MiB Rohbytes (Base64-JSON ≈ 10,7 MiB) < API-Limit Portal-Chat 12 MiB
  // (PORTAL_CHAT_BODY_LIMIT) ≤ dieser Puffer 13 MiB (Reserve). Bytezahl statt '13mb' – eindeutig.
  experimental: {
    proxyClientMaxBodySize: 13 * 1024 * 1024,
  },
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
    // Phase 16 (WEB, Design §2.4.5): CMS-Vorschau (Entwürfe hinter einem Vorschau-Cookie) –
    // nie cachen, nie indexieren/archivieren, kein Referer, keine Einbettung.
    const previewPageHeaders = [
      { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
    ];
    return [
      { source: '/kontakt/:token', headers: tokenPageHeaders },
      { source: '/dokument/:token', headers: tokenPageHeaders },
      // Phase 16 (WEB, Design §1.7): Angebotslink wie /dokument/:token – auch wenn die neue
      // Website später indexierbar wird, bleibt der Token-Link privat, no-store und ohne Referer.
      { source: '/angebot/:token', headers: tokenPageHeaders },
      { source: '/konto', headers: portalPageHeaders },
      { source: '/konto/:path*', headers: portalPageHeaders },
      { source: '/vorschau', headers: previewPageHeaders },
      { source: '/vorschau/:path*', headers: previewPageHeaders },
    ];
  },
};

export default nextConfig;
