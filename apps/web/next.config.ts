import type { NextConfig } from 'next';

const API_ORIGIN = process.env.WEB_API_ORIGIN ?? 'http://127.0.0.1:3101';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  allowedDevOrigins: ['127.0.0.1'],
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
    return [
      { source: '/kontakt/:token', headers: tokenPageHeaders },
      { source: '/dokument/:token', headers: tokenPageHeaders },
    ];
  },
};

export default nextConfig;
