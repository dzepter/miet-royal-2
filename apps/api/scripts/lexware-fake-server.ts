/**
 * Startet den Lexware-Contract-Fake als eigenständigen Prozess (E2E/lokal).
 * Aufruf: LEXWARE_FAKE_PORT=4555 tsx scripts/lexware-fake-server.ts
 * Gibt API-Key, organizationId und Public Key auf stdout aus (nur Fake-Werte).
 */
import { readFileSync } from 'node:fs';
import { FakeLexwareServer } from '../src/lexware/testing/fake-server.ts';

const port = Number(process.env.LEXWARE_FAKE_PORT ?? 4555);
const fake = new FakeLexwareServer({
  organizationId:
    process.env.LEXWARE_FAKE_ORGANIZATION_ID ?? 'e2e-org-00000000-0000-4000-8000-000000000001',
  apiKey: process.env.LEXWARE_FAKE_API_KEY ?? 'e2e-fake-lexware-key',
  rateLimit: process.env.LEXWARE_FAKE_RATE_LIMIT !== '0',
  ...(process.env.LEXWARE_FAKE_PRIVATE_KEY_FILE === undefined
    ? {}
    : { privateKeyPem: readFileSync(process.env.LEXWARE_FAKE_PRIVATE_KEY_FILE, 'utf8') }),
});
const url = await fake.start(port);
console.log(JSON.stringify({ url, organizationId: fake.organizationId, apiKey: fake.apiKey }));
console.log(fake.publicKeyPem);
process.on('SIGTERM', () => void fake.stop().then(() => process.exit(0)));
process.on('SIGINT', () => void fake.stop().then(() => process.exit(0)));
