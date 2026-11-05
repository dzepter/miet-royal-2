import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';

/**
 * Phase 15 (Review R4, Gruppe C – Doku): Hop-Zahl und X-Forwarded-For hinter dem
 * Next-Rewrite. Die Doku empfahl für nginx → Next → API `API_TRUST_PROXY_HOPS=2` –
 * damit übernimmt die API einen vom Client gefälschten Eintrag (IP-Limits umgehbar).
 * Der Next-Rewrite reicht `X-Forwarded-For` unverändert weiter und hängt selbst
 * nichts an (mit `next start` 16.3.3 gegen einen Echo-Server geprüft, siehe Bericht);
 * hier wird die API-Seite exakt so simuliert (Socket = Next, Header von nginx).
 * Prüft (1) die dokumentierte Semantik an der echten App (Fastify `trustProxy` aus
 * app.ts) und (2) dass die Doku sie richtig wiedergibt. Läuft gegen mietroyal_test6.
 */

const IP_ROUTE = '/__review-r4/ip';
const NEXT_SOCKET = '10.0.0.2';
const NGINX_SOCKET = '10.0.0.1';
const REAL_CLIENT = '198.51.100.7';
const SPOOFED = '203.0.113.66';
/** Client schickt einen gefälschten Eintrag; nginx hängt `$proxy_add_x_forwarded_for` die echte IP an. */
const XFF_AFTER_NGINX = `${SPOOFED}, ${REAL_CLIENT}`;

const contexts = new Map<number, TestContext>();

beforeAll(async () => {
  for (const hops of [0, 1, 2]) {
    contexts.set(
      hops,
      await createTestContext({
        env: { API_TRUST_PROXY_HOPS: String(hops) },
        beforeReady: (app) => {
          app.get(IP_ROUTE, async (request) => ({ ip: request.ip }));
        },
      }),
    );
  }
});

afterAll(async () => {
  for (const ctx of contexts.values()) await destroyTestContext(ctx);
});

async function ipSeen(
  hops: number,
  remoteAddress: string,
  xForwardedFor: string | undefined,
): Promise<string> {
  const ctx = contexts.get(hops)!;
  const response = await ctx.app.inject({
    method: 'GET',
    url: IP_ROUTE,
    remoteAddress,
    headers: xForwardedFor === undefined ? {} : { 'x-forwarded-for': xForwardedFor },
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { ip: string }).ip;
}

describe('Phase 15 – Review R4 (Hop-Zahl/X-Forwarded-For, Doku)', () => {
  it('R4. Semantik an der echten App: API_TRUST_PROXY_HOPS=1 ⇒ rechtester Eintrag (von nginx angehängte echte IP) – für nginx → Next → API UND nginx → API; 2 ⇒ gefälschter Eintrag; 0 ⇒ nur Socket (alle teilen ein Limit); direkt erreichbares Next mit 1 ⇒ fälschbar', async () => {
    // nginx → Next → API (Next hängt nichts an, Socket der API = Next).
    expect(await ipSeen(1, NEXT_SOCKET, XFF_AFTER_NGINX)).toBe(REAL_CLIENT);
    // nginx → API direkt (Socket = nginx) – derselbe Wert ist richtig.
    expect(await ipSeen(1, NGINX_SOCKET, XFF_AFTER_NGINX)).toBe(REAL_CLIENT);
    // Rotierende Fälschungen ändern nichts an der erkannten IP.
    for (const fake of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) {
      expect(await ipSeen(1, NEXT_SOCKET, `${fake}, ${REAL_CLIENT}`)).toBe(REAL_CLIENT);
    }
    // Frühere Doku-Angabe „nginx → Next → API = 2“: die API nimmt den gefälschten Eintrag.
    expect(await ipSeen(2, NEXT_SOCKET, XFF_AFTER_NGINX)).toBe(SPOOFED);
    // 0: X-Forwarded-For wird ignoriert – jede Anfrage trägt die Next-IP (ein gemeinsames Limit).
    expect(await ipSeen(0, NEXT_SOCKET, XFF_AFTER_NGINX)).toBe(NEXT_SOCKET);
    // Next direkt erreichbar (kein nginx): der rechteste Eintrag stammt vom Client ⇒ fälschbar.
    expect(await ipSeen(1, NEXT_SOCKET, SPOOFED)).toBe(SPOOFED);
    // Ohne Header: Socket-Adresse.
    expect(await ipSeen(1, NEXT_SOCKET, undefined)).toBe(NEXT_SOCKET);
  });

  it('R4. Doku DEPLOYMENT_NOTES: keine Empfehlung „nginx → Next → API = 2“/„nur Next → API = 1“ mehr; stattdessen API_TRUST_PROXY_HOPS=1, Proxy hängt die Client-IP an ($proxy_add_x_forwarded_for), Next/API nie direkt erreichbar, Next-Rewrite hängt nichts an', () => {
    const notes = readFileSync(
      fileURLToPath(new URL('../../../docs/DEPLOYMENT_NOTES.md', import.meta.url)),
      'utf8',
    );
    const flat = notes.replace(/\s+/g, ' ');
    // Boolesche Prüfungen – die Fehlermeldung nennt die Regel, nicht das ganze Dokument.
    const checks = {
      'veraltet: nginx → Next → API = `2`': !/→ API = `2`/.test(flat),
      'veraltet: nur Next-Server → API = `1`': !/nur Next-Server → API = `1`/.test(flat),
      'Empfehlung API_TRUST_PROXY_HOPS=1': flat.includes('API_TRUST_PROXY_HOPS=1'),
      'Proxy hängt Client-IP an': flat.includes('$proxy_add_x_forwarded_for'),
      'Next/API nie direkt erreichbar': /NIE direkt (aus dem Internet )?erreichbar/.test(flat),
      'Next-Rewrite hängt nichts an': /hängt (selbst )?nichts an/.test(flat),
      // Zweite Verteidigungslinie (Gruppe B, DB-Drossel) ist genannt.
      'DB-Drossel genannt': flat.includes('PORTAL_LINK_THROTTLE_MAX'),
    };
    expect(checks).toEqual(Object.fromEntries(Object.keys(checks).map((key) => [key, true])));
  });
});
