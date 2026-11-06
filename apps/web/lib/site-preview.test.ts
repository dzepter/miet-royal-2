import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PREVIEW_CONSUME_URL,
  PREVIEW_TEXT,
  consumeOutcomeMessage,
  consumePreviewToken,
  interpretConsumeResponse,
  previewBannerText,
  previewCookieHeader,
  readPreviewToken,
} from './site-preview.ts';

/**
 * Phase 16 (WEB, Order §9, Design §2.4/§11.3 „WEB“): Vorschau – Fragment-Parser, Cookie-
 * Weitergabe nur der Vorschau-Cookies, Auswertung des POST-Consume (neutrale Texte).
 */

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CMS-Vorschau im Web (Phase 16)', () => {
  it('W-P1. Fragment-Parser: #token=… (auch mit weiteren Parametern); ungültig/leer ⇒ null', () => {
    assert.equal(readPreviewToken(`#token=${TOKEN}`), TOKEN);
    assert.equal(readPreviewToken(`#a=1&token=${TOKEN}`), TOKEN);
    assert.equal(readPreviewToken(`token=${TOKEN}`), TOKEN);
    assert.equal(readPreviewToken('#token=kurz'), null);
    assert.equal(readPreviewToken('#token=<script>alert(1)</script>xxxxxxxx'), null);
    assert.equal(readPreviewToken('#'), null);
    assert.equal(readPreviewToken(''), null);
    assert.equal(readPreviewToken(null), null);
    assert.equal(readPreviewToken(undefined), null);
  });

  it('W-P2. Cookie-Header nur aus den Vorschau-Cookies und nur mit wohlgeformtem Wert', () => {
    const jar: Record<string, string> = {
      '__Host-mr_cms_preview': 'sessionTokenValue_1234567890',
      mr_customer_session: 'portalTokenValue_123456789',
      other: 'x',
    };
    assert.equal(
      previewCookieHeader((name) => jar[name]),
      '__Host-mr_cms_preview=sessionTokenValue_1234567890',
    );
    assert.equal(
      previewCookieHeader((name) => ({ mr_cms_preview: 'devSessionValue_1234567' })[name]),
      'mr_cms_preview=devSessionValue_1234567',
    );
    assert.equal(
      previewCookieHeader(() => undefined),
      null,
    );
    assert.equal(
      previewCookieHeader((name) =>
        name === 'mr_cms_preview' ? 'abc\r\nSet-Cookie: x=1;aaaaaaaaaa' : undefined,
      ),
      null,
    );
    assert.equal(
      previewCookieHeader((name) => (name === 'mr_cms_preview' ? 'kurz' : undefined)),
      null,
    );
  });

  it('W-P3. Consume: POST same-origin, no-store, no-referrer, Token nur im Body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const outcome = await consumePreviewToken(TOKEN, async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ path: '/faq', entryKind: 'page', expiresAt: '2026-11-06T12:30:00Z' });
    });
    assert.deepEqual(outcome, {
      kind: 'ok',
      path: '/faq',
      entryKind: 'page',
      expiresAt: '2026-11-06T12:30:00Z',
    });
    assert.equal(calls[0]?.url, PREVIEW_CONSUME_URL);
    assert.equal(calls[0]?.init.method, 'POST');
    assert.equal(calls[0]?.init.credentials, 'same-origin');
    assert.equal(calls[0]?.init.cache, 'no-store');
    assert.equal(calls[0]?.init.referrerPolicy, 'no-referrer');
    assert.equal(calls[0]?.init.body, JSON.stringify({ token: TOKEN }));
    assert.ok(!calls[0]?.url.includes(TOKEN));
  });

  it('W-P4. Consume-Fehler ⇒ neutrale Texte (ungültig/abgelaufen/verbraucht gleich, 429, DEMO_RESET, Netz)', async () => {
    assert.deepEqual(interpretConsumeResponse(401, { error: { code: 'CMS_PREVIEW_INVALID' } }), {
      kind: 'invalid',
    });
    assert.deepEqual(interpretConsumeResponse(400, null), { kind: 'invalid' });
    assert.deepEqual(interpretConsumeResponse(403, null), { kind: 'invalid' });
    assert.deepEqual(interpretConsumeResponse(429, null), { kind: 'rate_limited' });
    assert.deepEqual(interpretConsumeResponse(503, { error: { code: 'DEMO_RESET' } }), {
      kind: 'demo_reset',
    });
    assert.deepEqual(interpretConsumeResponse(503, null), { kind: 'unavailable' });
    assert.deepEqual(interpretConsumeResponse(200, { path: '/faq' }), { kind: 'unavailable' });
    assert.deepEqual(
      interpretConsumeResponse(200, { path: null, entryKind: 'site_settings', expiresAt: 'x' }),
      {
        kind: 'ok',
        path: null,
        entryKind: 'site_settings',
        expiresAt: 'x',
      },
    );
    assert.deepEqual(
      await consumePreviewToken(TOKEN, async () => {
        throw new Error('offline');
      }),
      { kind: 'unavailable' },
    );
    assert.equal(consumeOutcomeMessage({ kind: 'invalid' }), PREVIEW_TEXT.INVALID);
    assert.equal(consumeOutcomeMessage({ kind: 'demo_reset' }), PREVIEW_TEXT.DEMO_RESET);
    for (const text of Object.values(PREVIEW_TEXT)) {
      assert.doesNotMatch(text, /CMS_|401|token=/i);
    }
  });

  it('W-P5. Banner-Text nennt Revision und „nicht veröffentlicht“', () => {
    assert.equal(
      previewBannerText({ revisionNumber: 4, entryKind: 'page' }),
      'Vorschau – Entwurf (Revision 4), nicht veröffentlicht',
    );
    assert.equal(
      previewBannerText({ revisionNumber: 2, entryKind: 'site_settings' }),
      'Vorschau – Website-Einstellungen (Revision 2), nicht veröffentlicht',
    );
  });
});
