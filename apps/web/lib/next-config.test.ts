import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import nextConfig from '../next.config.ts';

/**
 * Phase 16 (WEB, Design §11.3 „WEB“): Header-Matrix aus `next.config.ts`.
 * Neu: `/vorschau`, `/vorschau/:path*`, `/angebot/:token`; unverändert: `/kontakt/:token`,
 * `/dokument/:token`, `/konto`, `/konto/:path*`; die öffentliche Kontaktseite `/kontakt`
 * bekommt KEINE Token-Header. Dazu der Build-Origin (`env.MR_BUILD_API_ORIGIN`).
 */

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };

async function rules(): Promise<HeaderRule[]> {
  assert.ok(typeof nextConfig.headers === 'function');
  return (await nextConfig.headers()) as HeaderRule[];
}

function headerMap(rule: HeaderRule | undefined): Record<string, string> {
  assert.ok(rule !== undefined, 'Regel fehlt');
  return Object.fromEntries(rule.headers.map((header) => [header.key, header.value]));
}

/** Vereinfachter path-to-regexp-Abgleich für die hier verwendeten Muster. */
function matches(source: string, path: string): boolean {
  const pattern = source
    .split('/')
    .map((segment) => {
      if (segment === ':path*') return '(?:/.*)?';
      if (segment.startsWith(':')) return '/[^/]+';
      return segment === '' ? '' : `/${segment}`;
    })
    .join('');
  return new RegExp(`^${pattern}$`).test(path);
}

describe('next.config.ts – Header-Matrix (Phase 16)', () => {
  it('W-H1. Token-Seiten: /kontakt/:token, /dokument/:token und NEU /angebot/:token mit identischen Token-Headern', async () => {
    const all = await rules();
    const kontakt = headerMap(all.find((rule) => rule.source === '/kontakt/:token'));
    const dokument = headerMap(all.find((rule) => rule.source === '/dokument/:token'));
    const angebot = headerMap(all.find((rule) => rule.source === '/angebot/:token'));
    for (const headers of [kontakt, dokument, angebot]) {
      assert.equal(headers['Cache-Control'], 'private, no-store, max-age=0');
      assert.equal(headers['X-Robots-Tag'], 'noindex, nofollow, noarchive');
      assert.equal(headers['Referrer-Policy'], 'no-referrer');
      assert.equal(headers['X-Frame-Options'], 'DENY');
      assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    }
    assert.deepEqual(angebot, dokument);
  });

  it('W-H2. Portal /konto und /konto/:path* unverändert (noindex, nocache, no-store, no-referrer, DENY)', async () => {
    const all = await rules();
    for (const source of ['/konto', '/konto/:path*']) {
      const headers = headerMap(all.find((rule) => rule.source === source));
      assert.equal(headers['Cache-Control'], 'private, no-store, max-age=0');
      assert.equal(headers['X-Robots-Tag'], 'noindex, nofollow, nocache');
      assert.equal(headers['Referrer-Policy'], 'no-referrer');
      assert.equal(headers['X-Frame-Options'], 'DENY');
      assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    }
  });

  it('W-H3. Vorschau /vorschau und /vorschau/:path*: no-store, noindex + noarchive, no-referrer, DENY, nosniff', async () => {
    const all = await rules();
    for (const source of ['/vorschau', '/vorschau/:path*']) {
      const headers = headerMap(all.find((rule) => rule.source === source));
      assert.match(headers['Cache-Control'] ?? '', /no-store/);
      assert.match(headers['Cache-Control'] ?? '', /private/);
      assert.match(headers['X-Robots-Tag'] ?? '', /noindex/);
      assert.match(headers['X-Robots-Tag'] ?? '', /noarchive/);
      assert.equal(headers['Referrer-Policy'], 'no-referrer');
      assert.equal(headers['X-Frame-Options'], 'DENY');
      assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    }
    assert.ok(all.some((rule) => matches(rule.source, '/vorschau/seite')));
  });

  it('W-H4. Öffentliche Website-Seiten (/kontakt, /, /konfigurator, /faq, Regionen) bekommen KEINE Token-/Portal-Header', async () => {
    const all = await rules();
    for (const path of [
      '/kontakt',
      '/',
      '/konfigurator',
      '/faq',
      '/slushmaschine-mieten',
      '/slushmaschine-mieten/mainz',
      '/datenschutz',
    ]) {
      const hit = all.filter((rule) => matches(rule.source, path));
      assert.deepEqual(
        hit.map((rule) => rule.source),
        [],
        `${path} darf keine Header-Regel treffen`,
      );
    }
    // Gegenprobe des Abgleichs: Token-Pfade werden getroffen.
    assert.ok(all.some((rule) => matches(rule.source, '/kontakt/abcdefghijklmnop')));
    assert.ok(all.some((rule) => matches(rule.source, '/angebot/abcdefghijklmnop')));
    assert.ok(all.some((rule) => matches(rule.source, '/konto/profil')));
  });

  it('W-H5. Rewrite /api/:path* bleibt; Build-Origin ist als env.MR_BUILD_API_ORIGIN = Rewrite-Ziel abgelegt', async () => {
    assert.ok(typeof nextConfig.rewrites === 'function');
    const rewrites = (await nextConfig.rewrites()) as Array<{
      source: string;
      destination: string;
    }>;
    assert.equal(rewrites.length, 1);
    assert.equal(rewrites[0]?.source, '/api/:path*');
    const origin = nextConfig.env?.MR_BUILD_API_ORIGIN;
    assert.equal(typeof origin, 'string');
    assert.equal(rewrites[0]?.destination, `${origin}/:path*`);
    assert.equal(nextConfig.poweredByHeader, false);
  });
});

describe('next.config.ts – Redirect-Verfahren (Phase 17)', () => {
  it('SEO-W-H6. skipTrailingSlashRedirect aktiv (Proxy normalisiert in EINEM Hop); keine redirects()-Funktion, kein trailingSlash – ein Verfahren (308 im Proxy)', () => {
    assert.equal(nextConfig.skipTrailingSlashRedirect, true);
    assert.equal(nextConfig.redirects, undefined);
    assert.equal(nextConfig.trailingSlash, undefined);
  });
});
