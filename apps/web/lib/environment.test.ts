import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_WEB_API_ORIGIN,
  decideDemoBanner,
  fetchApiEnvironment,
  readWebApiOrigin,
  readWebAppEnvironment,
  resolveDemoBanner,
} from './environment.ts';

/**
 * Phase 14 (Review F6, Web-Unit ohne Next/Browser): Entscheidung über den
 * Demo-Banner aus beiden Quellen (WEB_APP_ENV und /health der API), Fehler-
 * modus der /health-Abfrage und die Pflicht von WEB_APP_ENV außerhalb von
 * development (Meldung, kein Abbruch). Läuft mit `node --test` (pnpm test).
 */

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Web-Umgebung und Demo-Banner (Phase 14, Review F6)', () => {
  it('RF6. decideDemoBanner: Banner, wenn WEB_APP_ENV=demo ODER die API environment=demo meldet; sonst kein Banner', () => {
    assert.equal(decideDemoBanner({ webAppEnv: 'demo', apiEnvironment: null }), true);
    assert.equal(decideDemoBanner({ webAppEnv: 'demo', apiEnvironment: 'production' }), true);
    assert.equal(decideDemoBanner({ webAppEnv: 'production', apiEnvironment: 'demo' }), true);
    assert.equal(decideDemoBanner({ webAppEnv: 'development', apiEnvironment: 'demo' }), true);
    assert.equal(
      decideDemoBanner({ webAppEnv: 'production', apiEnvironment: 'production' }),
      false,
    );
    assert.equal(decideDemoBanner({ webAppEnv: 'development', apiEnvironment: null }), false);
    assert.equal(decideDemoBanner({ webAppEnv: 'staging', apiEnvironment: 'staging' }), false);
  });

  it('RF6b. fetchApiEnvironment: liest environment aus GET <origin>/health mit cache no-store; Nicht-2xx, Fehler, Nicht-JSON, fehlendes Feld und Timeout ⇒ null', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const ok: FetchLike = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse({ status: 'ok', version: '1', environment: 'demo' });
    };
    assert.equal(await fetchApiEnvironment('http://api.example', { fetchImpl: ok }), 'demo');
    assert.equal(calls[0]?.url, 'http://api.example/health');
    assert.equal(calls[0]?.init?.cache, 'no-store');
    assert.equal(calls[0]?.init?.method, 'GET');
    assert.ok(calls[0]?.init?.signal instanceof AbortSignal);

    const unavailable: FetchLike = async () => jsonResponse({ environment: 'demo' }, 503);
    assert.equal(await fetchApiEnvironment('http://api.example', { fetchImpl: unavailable }), null);

    const failing: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    assert.equal(await fetchApiEnvironment('http://api.example', { fetchImpl: failing }), null);

    const text: FetchLike = async () => new Response('<html>', { status: 200 });
    assert.equal(await fetchApiEnvironment('http://api.example', { fetchImpl: text }), null);

    const missingField: FetchLike = async () => jsonResponse({ status: 'ok' });
    assert.equal(
      await fetchApiEnvironment('http://api.example', { fetchImpl: missingField }),
      null,
    );

    // Timeout: die Abfrage endet mit dem Abbruchsignal, nie mit einer Ausnahme.
    const hanging: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const started = Date.now();
    assert.equal(
      await fetchApiEnvironment('http://api.example', { fetchImpl: hanging, timeoutMs: 30 }),
      null,
    );
    assert.ok(Date.now() - started < 1000);
  });

  it('RF6c. readWebAppEnvironment: fehlende Variable außerhalb von development ⇒ genau eine Fehlermeldung (kein Abbruch) und development; in development/test still; unbekannter Wert einmal gemeldet', () => {
    const messages: string[] = [];
    const report = (message: string) => {
      messages.push(message);
    };
    assert.equal(
      readWebAppEnvironment(undefined, { nodeEnv: 'development', report }),
      'development',
    );
    assert.equal(readWebAppEnvironment('', { nodeEnv: 'test', report }), 'development');
    assert.deepEqual(messages, []);

    assert.equal(
      readWebAppEnvironment(undefined, { nodeEnv: 'production', report }),
      'development',
    );
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /WEB_APP_ENV fehlt/);
    assert.match(messages[0] ?? '', /health/);
    assert.equal(readWebAppEnvironment('   ', { nodeEnv: 'production', report }), 'development');
    assert.equal(messages.length, 1, 'nur einmal je Prozess');

    assert.equal(readWebAppEnvironment(' demo ', { nodeEnv: 'production', report }), 'demo');
    assert.equal(readWebAppEnvironment('staging', { nodeEnv: 'production', report }), 'staging');
    assert.equal(readWebAppEnvironment('production', { report }), 'production');
    assert.equal(messages.length, 1);

    assert.equal(readWebAppEnvironment('Demo', { nodeEnv: 'production', report }), 'development');
    assert.equal(messages.length, 2);
    assert.match(messages[1] ?? '', /unbekannter Wert/);
    assert.equal(readWebAppEnvironment('prod', { nodeEnv: 'production', report }), 'development');
    assert.equal(messages.length, 2, 'unbekannter Wert nur einmal');
  });

  it('RF6d. resolveDemoBanner: WEB_APP_ENV=demo ⇒ Banner ohne API-Abfrage; sonst entscheidet /health (demo ⇒ Banner, Fehler ⇒ nur WEB_APP_ENV); readWebApiOrigin mit Default wie next.config.ts', async () => {
    assert.equal(readWebApiOrigin(undefined), DEFAULT_WEB_API_ORIGIN);
    assert.equal(readWebApiOrigin(''), 'http://127.0.0.1:3101');
    assert.equal(readWebApiOrigin(' https://api.example/ '), 'https://api.example');

    let fetchCalls = 0;
    const demoApi: FetchLike = async () => {
      fetchCalls += 1;
      return jsonResponse({ environment: 'demo' });
    };
    assert.equal(await resolveDemoBanner({ webAppEnv: 'demo', fetchImpl: demoApi }), true);
    assert.equal(fetchCalls, 0, 'WEB_APP_ENV=demo braucht keine API-Abfrage');
    assert.equal(
      await resolveDemoBanner({
        webAppEnv: 'production',
        apiOrigin: 'http://demo-api.example',
        fetchImpl: demoApi,
      }),
      true,
    );
    assert.equal(fetchCalls, 1);

    const liveApi: FetchLike = async () => jsonResponse({ environment: 'production' });
    assert.equal(await resolveDemoBanner({ webAppEnv: 'production', fetchImpl: liveApi }), false);
    assert.equal(await resolveDemoBanner({ webAppEnv: 'development', fetchImpl: liveApi }), false);

    const down: FetchLike = async () => {
      throw new Error('down');
    };
    assert.equal(await resolveDemoBanner({ webAppEnv: 'production', fetchImpl: down }), false);
    assert.equal(await resolveDemoBanner({ webAppEnv: 'demo', fetchImpl: down }), true);
  });
});
