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
};

export default nextConfig;
