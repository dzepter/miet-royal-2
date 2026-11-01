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
  transpilePackages: ['@mietroyal/offline', '@mietroyal/domain'],
  allowedDevOrigins: ['127.0.0.1'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/:path*` }];
  },
};

export default nextConfig;
