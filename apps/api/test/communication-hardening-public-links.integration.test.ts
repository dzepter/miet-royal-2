/**
 * Härtung Review A (Phase 12, Order §§13/20/33/38/44) – Regressionstests OHNE Fund:
 * Rate-Limits der öffentlichen Token-Routen greifen tatsächlich (rateLimitEnabled
 * = true wie in production), neutrale 404 für jede Tokenform, Request-Log maskiert
 * Token-Pfade (inkl. abschließendem Slash/Query) auf trace-Level. Betrieb hinter
 * Proxy: API_TRUST_PROXY_HOPS und Proxy-Log-Maskierung siehe docs/DEPLOYMENT_NOTES.md (H8).
 */
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';

let ctx: TestContext;
const logLines: string[] = [];
const logDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});

beforeAll(async () => {
  ctx = await createTestContext({ rateLimitEnabled: true, logDestination, logLevel: 'trace' });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});

const token = () => randomBytes(32).toString('base64url');

async function hammer(method: 'GET' | 'POST', url: string, times: number) {
  const codes: number[] = [];
  for (let i = 0; i < times; i += 1) {
    const response = await ctx.app.inject({
      method,
      url,
      remoteAddress: '203.0.113.7',
      ...(method === 'POST'
        ? { payload: { firstName: 'A', lastName: 'B', phone: '0170 1234567' } }
        : {}),
    });
    codes.push(response.statusCode);
  }
  return codes;
}

describe('Härtung Review A – öffentliche Token-Routen (kein Fund)', () => {
  it('RA-RL Rate-Limits greifen: documents 30/min, actions GET 60/min, actions POST 10/min, calendar 60/min', async () => {
    const documents = await hammer('GET', `/public/documents/${token()}`, 31);
    expect(documents.slice(0, 30).every((c) => c === 404)).toBe(true);
    expect(documents[30]).toBe(429);
    const actionsGet = await hammer('GET', `/public/actions/${token()}`, 61);
    expect(actionsGet[60]).toBe(429);
    const actionsPost = await hammer('POST', `/public/actions/${token()}`, 11);
    expect(actionsPost.slice(0, 10).every((c) => c === 404)).toBe(true);
    expect(actionsPost[10]).toBe(429);
    const calendar = await hammer('GET', `/public/calendar/${token()}.ics`, 61);
    expect(calendar[60]).toBe(429);
  });

  it('RA-LOG Token-Pfade erscheinen im trace-Log nur maskiert (auch mit Slash am Ende und Query)', async () => {
    logLines.length = 0;
    const secrets = [token(), token(), token(), token(), token()];
    const urls = [
      `/public/documents/${secrets[0]}`,
      `/public/actions/${secrets[1]}`,
      `/public/actions/${secrets[2]}/`,
      `/public/calendar/${secrets[3]}.ics?x=1`,
      `/public/offers/${secrets[4]}/pdf`,
    ];
    for (const url of urls) {
      await ctx.app.inject({ method: 'GET', url, remoteAddress: '198.51.100.9' });
    }
    const log = logLines.join('');
    expect(log).toContain('/public/actions/***');
    for (const secret of secrets) expect(log).not.toContain(secret);
  });
});
