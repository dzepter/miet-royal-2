import type { NextConfig } from 'next';

/**
 * Alle API-Aufrufe laufen über den Same-Origin-Proxy /api/* – dadurch
 * funktionieren HttpOnly-Cookies mit SameSite=Strict ohne CORS.
 * STAFF_API_ORIGIN zeigt auf die Fastify-API (Default: lokale Entwicklung).
 */
const apiOrigin = process.env.STAFF_API_ORIGIN ?? 'http://127.0.0.1:3001';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Phase 14 (E2E-Fix): optional eigenes Build-/Dev-Verzeichnis je Instanz (z. B. `.next/demo`
  // für die Demo-Staff-Instanz der E2E-Suite). `next dev` sperrt sein distDir – zwei Dev-Server
  // desselben Projekts brauchen daher getrennte Verzeichnisse. Ohne Variable bleibt `.next`.
  ...(process.env.STAFF_DIST_DIR === undefined ? {} : { distDir: process.env.STAFF_DIST_DIR }),
  // Phase 8: Offline-Kern und Fachregeln als Workspace-Pakete (reines TS) bündeln.
  transpilePackages: ['@mietroyal/offline', '@mietroyal/domain', '@mietroyal/validation'],
  allowedDevOrigins: ['127.0.0.1'],
  // Phase 19 (P19-F13, Phase-18-Restpunkt): Der Rewrite `/api/*` puffert Request-Bodies nur bis
  // `proxyClientMaxBodySize` (Next-Default 10 MiB) und reicht größere Bodies OHNE Fehler abgeschnitten
  // an die API weiter (siehe apps/web/next.config.ts). `POST /staff/offline/sync` erlaubt 12 MiB,
  // CMS-Medien 9 MiB – Puffer 13 MiB (Reserve) wie in apps/web; Test apps/api/test/staff-proxy-body-limit.test.ts.
  experimental: {
    proxyClientMaxBodySize: 13 * 1024 * 1024,
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/:path*` }];
  },
};

export default nextConfig;
