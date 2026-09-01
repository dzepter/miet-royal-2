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
  allowedDevOrigins: ['127.0.0.1'],
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/:path*` }];
  },
};

export default nextConfig;
