import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkApiOriginMismatch,
  decideOriginMismatch,
  loadCatalog,
  loadPreviewPage,
  loadSiteBootstrap,
  loadSitePage,
  normalizeOrigin,
  originHost,
} from './site-api.ts';

/**
 * Phase 16 (WEB, Design §5/§11.2.10, §11.3 „WEB“): serverseitige Lesezugriffe (no-store,
 * Timeout, neutrale Fehler) und der Build-/Laufzeit-Origin-Vergleich (fail-closed).
 */

type Call = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const BOOTSTRAP = {
  environment: 'development',
  settings: null,
  pages: [{ path: '/faq', pageType: 'faq', title: 'FAQ', metaDescription: null }],
  reviews: { mode: 'disabled' },
  pickupArea: 'Mainz-Hechtsheim',
};

describe('SSR-Lesezugriffe der Website (Phase 16)', () => {
  it('W-A1. Bootstrap: GET <origin>/public/site/settings, no-store, accept JSON, mit Abbruchsignal', async () => {
    const calls: Call[] = [];
    const result = await loadSiteBootstrap({
      origin: 'http://api.test',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(BOOTSTRAP);
      },
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0]?.url, 'http://api.test/public/site/settings');
    assert.equal(calls[0]?.init.cache, 'no-store');
    assert.equal(calls[0]?.init.method, 'GET');
    assert.ok(calls[0]?.init.signal instanceof AbortSignal);
    assert.deepEqual(calls[0]?.init.headers, { accept: 'application/json' });
  });

  it('W-A2. Seite: Pfad wird kodiert; 404 ⇒ not_found; ungültiger Pfad ⇒ not_found OHNE Anfrage', async () => {
    const calls: Call[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ error: { code: 'NOT_FOUND' } }, 404);
    };
    assert.deepEqual(
      await loadSitePage('/slushmaschine-mieten/mainz', { origin: 'http://api.test', fetchImpl }),
      { ok: false, reason: 'not_found' },
    );
    assert.equal(
      calls[0]?.url,
      'http://api.test/public/site/page?path=%2Fslushmaschine-mieten%2Fmainz',
    );
    for (const bad of ['/../etc', '/FAQ', 'faq', '/faq?x=1', '/a//b', `/${'a'.repeat(205)}`]) {
      assert.deepEqual(await loadSitePage(bad, { origin: 'http://api.test', fetchImpl }), {
        ok: false,
        reason: 'not_found',
      });
    }
    assert.equal(calls.length, 1);
  });

  it('W-A3. Fehler werden nie geworfen: Netzfehler, 5xx, kein JSON, falsche Form ⇒ unavailable; 401 ⇒ unauthorized', async () => {
    const origin = 'http://api.test';
    assert.deepEqual(
      await loadSiteBootstrap({
        origin,
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
      { ok: false, reason: 'unavailable' },
    );
    assert.deepEqual(
      await loadSiteBootstrap({ origin, fetchImpl: async () => jsonResponse({}, 503) }),
      { ok: false, reason: 'unavailable' },
    );
    assert.deepEqual(
      await loadSiteBootstrap({
        origin,
        fetchImpl: async () => new Response('<html>', { status: 200 }),
      }),
      { ok: false, reason: 'unavailable' },
    );
    assert.deepEqual(
      await loadCatalog({ origin, fetchImpl: async () => jsonResponse({ machines: 'x' }) }),
      { ok: false, reason: 'unavailable' },
    );
    assert.deepEqual(
      await loadPreviewPage('mr_cms_preview=abcdefghijklmnopqrstuvwxyz', {
        origin,
        fetchImpl: async () => jsonResponse({ error: { code: 'CMS_PREVIEW_INVALID' } }, 401),
      }),
      { ok: false, reason: 'unauthorized' },
    );
  });

  it('W-A4. Timeout bricht die Anfrage ab (Seite bleibt bedienbar)', async () => {
    const started = Date.now();
    const result = await loadSiteBootstrap({
      origin: 'http://api.test',
      timeoutMs: 30,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    assert.deepEqual(result, { ok: false, reason: 'unavailable' });
    assert.ok(Date.now() - started < 1000);
  });

  it('W-A5. Vorschau: Cookie-Header nur, wenn vorhanden – ohne Cookie keine Anfrage', async () => {
    const calls: Call[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({
        preview: {
          revisionId: 'r',
          revisionNumber: 3,
          expiresAt: '2026-11-06T12:00:00Z',
          entryKind: 'page',
        },
        page: null,
        settings: null,
      });
    };
    assert.deepEqual(await loadPreviewPage(null, { origin: 'http://api.test', fetchImpl }), {
      ok: false,
      reason: 'unauthorized',
    });
    assert.equal(calls.length, 0);
    const result = await loadPreviewPage('mr_cms_preview=abcdefghijklmnop', {
      origin: 'http://api.test',
      fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0]?.url, 'http://api.test/public/cms/preview/page');
    assert.deepEqual(calls[0]?.init.headers, {
      accept: 'application/json',
      cookie: 'mr_cms_preview=abcdefghijklmnop',
    });
    assert.equal(calls[0]?.init.cache, 'no-store');
  });
});

describe('Build-/Laufzeit-Origin (Phase 16, Design §11.2.10)', () => {
  it('W-O1. Vergleich normalisiert (Schluss-Slash, Groß/Klein des Hosts); Abweichung ⇒ true', () => {
    assert.equal(normalizeOrigin('http://127.0.0.1:3101/'), 'http://127.0.0.1:3101');
    assert.equal(normalizeOrigin(' HTTP://API.Example:8080 '), 'http://api.example:8080');
    assert.equal(decideOriginMismatch('http://127.0.0.1:3101', 'http://127.0.0.1:3101/'), false);
    assert.equal(decideOriginMismatch('http://API.example', 'http://api.example'), false);
    assert.equal(decideOriginMismatch('http://127.0.0.1:3101', 'http://127.0.0.1:3106'), true);
    assert.equal(
      decideOriginMismatch('https://api.live.example', 'https://api.demo.example'),
      true,
    );
    // Ohne Build-Wert (kein Next-Build, z. B. Unit-Test) keine Aussage.
    assert.equal(decideOriginMismatch(undefined, 'http://127.0.0.1:3101'), false);
    assert.equal(decideOriginMismatch('', 'http://127.0.0.1:3101'), false);
  });

  it('W-O2. Abweichung wird EINMAL je Hostpaar gemeldet – nur Hostnamen, keine Ports/Pfade/URLs', () => {
    const messages: string[] = [];
    const report = (message: string) => messages.push(message);
    const options = {
      build: 'https://api.live.example:8443/intern',
      runtime: 'https://api.demo.example:9443/x',
      report,
    };
    assert.equal(checkApiOriginMismatch(options), true);
    assert.equal(checkApiOriginMismatch(options), true);
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /api\.live\.example/);
    assert.match(messages[0] ?? '', /api\.demo\.example/);
    assert.doesNotMatch(messages[0] ?? '', /8443|9443|intern|https:/);
    assert.equal(
      checkApiOriginMismatch({ build: 'http://a.test', runtime: 'http://a.test/', report }),
      false,
    );
    assert.equal(messages.length, 1);
    assert.equal(originHost('kein url'), '(ungültig)');
  });
});
