/**
 * Phase 10 – LexwareClient, Fehlerklassifikation, Geldumrechnung und
 * Webhook-Signatur gegen den lokalen Contract-Fake (Order §§10/12/15/45/57;
 * Pflichttests 5/6 (kein Key in Fehlern/Logs), 18–24 (HTTP-Klassen),
 * 123–126 (Signatur), 137 (Body nicht geloggt)). Ohne Datenbank.
 */
import { createSign, generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LexwareClient, maskPath } from '../src/lexware/client.ts';
import { classifyStatus, extractViolations, LexwareApiError } from '../src/lexware/errors.ts';
import {
  basisPointsToPercentage,
  centsToDecimalString,
  centsToLexwareAmount,
  decimalToCents,
  grossFromNetCents,
  MoneyConversionError,
} from '../src/lexware/money.ts';
import { NoopLexwareThrottle } from '../src/lexware/rate-limiter.ts';
import { FakeLexwareServer } from '../src/lexware/testing/fake-server.ts';
import { LEXWARE_WEBHOOK_PUBLIC_KEY_PEM } from '../src/lexware/webhook-public-key.ts';
import { loadWebhookPublicKey, verifyLexwareSignature } from '../src/lexware/webhook-signature.ts';

let fake: FakeLexwareServer;
let baseUrl: string;
const logs: { level: string; obj: Record<string, unknown>; msg: string }[] = [];
const logger = {
  info: (obj: Record<string, unknown>, msg: string) => logs.push({ level: 'info', obj, msg }),
  warn: (obj: Record<string, unknown>, msg: string) => logs.push({ level: 'warn', obj, msg }),
};

function client(overrides: Partial<ConstructorParameters<typeof LexwareClient>[0]> = {}) {
  return new LexwareClient({
    baseUrl,
    apiKey: fake.apiKey,
    timeoutMs: 1_500,
    throttle: new NoopLexwareThrottle(),
    logger,
    ...overrides,
  });
}

beforeAll(async () => {
  fake = new FakeLexwareServer({ rateLimit: false });
  baseUrl = await fake.start();
});
afterAll(async () => {
  await fake.stop();
});
beforeEach(() => {
  fake.failures.length = 0;
  fake.revoked = false;
  fake.deniedScopes.clear();
  logs.length = 0;
});

describe('Geldumrechnung (§15)', () => {
  it('Cent ↔ Dezimal exakt, ohne Float-Rechnung', () => {
    expect(centsToDecimalString(12_345)).toBe('123.45');
    expect(centsToDecimalString(5)).toBe('0.05');
    expect(centsToDecimalString(-750)).toBe('-7.50');
    expect(centsToDecimalString(0)).toBe('0.00');
    expect(centsToLexwareAmount(1_999)).toBe(19.99);
    expect(decimalToCents('1337.00')).toBe(133_700);
    expect(decimalToCents('0.3')).toBe(30);
    expect(decimalToCents(19.99)).toBe(1_999);
    expect(decimalToCents('-0.5')).toBe(-50);
    expect(() => decimalToCents('1.234')).toThrow(MoneyConversionError);
    expect(() => decimalToCents(1.234)).toThrow(MoneyConversionError);
    expect(() => centsToDecimalString(1.5)).toThrow(MoneyConversionError);
    expect(basisPointsToPercentage(1900)).toBe(19);
    expect(basisPointsToPercentage(700)).toBe(7);
    expect(grossFromNetCents(10_000, 1900)).toBe(11_900);
    expect(grossFromNetCents(333, 1900)).toBe(396); // 396,27 ⇒ 396
    expect(grossFromNetCents(-5_000, 700)).toBe(-5_350);
  });
});

describe('Fehlerklassifikation (§12)', () => {
  it('ordnet Statuscodes zu und reduziert Details auf Feld/Verletzung', () => {
    expect(classifyStatus(400)).toBe('validation');
    expect(classifyStatus(401)).toBe('unauthorized');
    expect(classifyStatus(403)).toBe('forbidden');
    expect(classifyStatus(404)).toBe('not_found');
    expect(classifyStatus(409)).toBe('conflict');
    expect(classifyStatus(429)).toBe('rate_limited');
    expect(classifyStatus(503)).toBe('server');
    expect(new LexwareApiError('rate_limited', 'x').transient).toBe(true);
    expect(new LexwareApiError('validation', 'x').transient).toBe(false);
    expect(new LexwareApiError('unauthorized', 'x').code).toBe('LEXWARE_UNAUTHORIZED');
    expect(
      extractViolations({
        details: [
          {
            violation: 'NOTNULL',
            field: 'lineItems[0].unitPrice',
            message: 'Kunde Max Mustermann',
          },
        ],
      }),
    ).toEqual([{ field: 'lineItems[0].unitPrice', violation: 'NOTNULL' }]);
    expect(
      extractViolations({
        IssueList: [
          { i18nKey: 'missing_entity', source: 'company.name', type: 'validation_failure' },
        ],
      }),
    ).toEqual([{ field: 'company.name', violation: 'missing_entity' }]);
  });
});

describe('LexwareClient gegen den Contract-Fake', () => {
  it('7. Profile: Bearer-Auth, JSON, validierte Antwort; Logs ohne Key/Body', async () => {
    const result = await client().profile();
    expect(result.status).toBe(200);
    expect(result.data.organizationId).toBe(fake.organizationId);
    expect(result.data.taxType).toBe('net');
    expect(result.data.smallBusiness).toBe(false);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain(fake.apiKey);
    expect(serialized).toContain('/v1/profile');
    expect(serialized).not.toContain(fake.companyName);
  });

  it('21./5. 401 ⇒ unauthorized (kein Retry), Fehlertext ohne Key', async () => {
    const wrong = client({ apiKey: 'falsch-' + fake.apiKey });
    const error = await wrong.profile().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LexwareApiError);
    expect((error as LexwareApiError).kind).toBe('unauthorized');
    expect((error as LexwareApiError).transient).toBe(false);
    expect(String((error as Error).message)).not.toContain(fake.apiKey);
    expect(JSON.stringify(logs)).not.toContain('falsch-');
  });

  it('22. 403 ⇒ forbidden (Scope), 23./24. 400 ⇒ validation permanent, 404 ⇒ not_found', async () => {
    fake.deniedScopes.add('/v1/contacts');
    await expect(client().searchContacts({ email: 'abc' })).rejects.toMatchObject({
      kind: 'forbidden',
      transient: false,
    });
    fake.deniedScopes.clear();
    const invalid = await client()
      .createInvoice({}, true)
      .catch((e: unknown) => e);
    expect((invalid as LexwareApiError).kind).toBe('validation');
    expect((invalid as LexwareApiError).violations[0]?.field).toBe('voucherDate');
    await expect(client().getInvoice('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject(
      { kind: 'not_found' },
    );
  });

  it('18. 429 mit Retry-After ⇒ rate_limited + retryAfterMs; 19. 5xx ⇒ server (transient)', async () => {
    fake.failures.push({ match: 'GET /v1/profile', status: 429, times: 1, retryAfterSeconds: 3 });
    const limited = await client()
      .profile()
      .catch((e: unknown) => e);
    expect((limited as LexwareApiError).kind).toBe('rate_limited');
    expect((limited as LexwareApiError).retryAfterMs).toBe(3_000);
    expect((limited as LexwareApiError).transient).toBe(true);
    fake.failures.push({ match: 'GET /v1/profile', status: 503, times: 1 });
    await expect(client().profile()).rejects.toMatchObject({ kind: 'server', transient: true });
    // Danach wieder erfolgreich – der Client macht keine eigene Retry-Schleife.
    expect((await client().profile()).status).toBe(200);
  });

  it('20. Timeout ⇒ timeout (transient); nach Create verschluckte Antwort hat die Ressource trotzdem angelegt', async () => {
    fake.failures.push({ match: 'GET /v1/profile', status: 0, times: 1, mode: 'hang' });
    const started = Date.now();
    await expect(client({ timeoutMs: 300 }).profile()).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
    const contactBody = {
      version: 0,
      roles: { customer: {} },
      person: { lastName: 'Unknown' },
      emailAddresses: { business: ['unknown@example.test'] },
      addresses: { billing: [{ countryCode: 'DE' }] },
    };
    fake.failures.push({ match: 'POST /v1/contacts', status: 0, times: 1, mode: 'after_create' });
    await expect(client({ timeoutMs: 300 }).createContact(contactBody)).rejects.toMatchObject({
      kind: 'timeout',
    });
    const found = await client().searchContacts({ email: 'unknown@example.test' });
    expect(found.data.content).toHaveLength(1);
  });

  it('Contract: finalize=true ⇒ open mit Nummer/dueDate; ohne finalize ⇒ draft; Datei nur für finale Belege', async () => {
    const contact = await client().createContact({
      version: 0,
      roles: { customer: {} },
      company: { name: 'Beispiel GmbH' },
      addresses: { billing: [{ street: 'Weg 1', zip: '55116', city: 'Mainz', countryCode: 'DE' }] },
    });
    const invoice = {
      voucherDate: '2026-10-17T00:00:00.000+02:00',
      address: {
        contactId: contact.data.id,
        name: 'Beispiel GmbH',
        street: 'Alt 9',
        zip: '55116',
        city: 'Mainz',
        countryCode: 'DE',
      },
      lineItems: [
        {
          type: 'custom',
          name: 'Miete',
          quantity: 1,
          unitName: 'Stück',
          unitPrice: { currency: 'EUR', netAmount: 100, taxRatePercentage: 19 },
        },
      ],
      totalPrice: { currency: 'EUR' },
      taxConditions: { taxType: 'net' },
      shippingConditions: {
        shippingType: 'service',
        shippingDate: '2026-10-17T00:00:00.000+02:00',
      },
      remark: 'MR-Transfer: TEST',
    };
    const created = await client().createInvoice(invoice, true);
    const read = await client().getInvoice(created.data.id);
    expect(read.data.voucherStatus).toBe('open');
    expect(read.data.voucherNumber).toMatch(/^RE\d+/);
    expect(read.data.dueDate).toBeDefined();
    expect(read.data.totalPrice?.totalGrossAmount).toBe(119);
    const draft = await client().createInvoice(invoice, false);
    expect((await client().getInvoice(draft.data.id)).data.voucherStatus).toBe('draft');
    await expect(client().getInvoiceFile(draft.data.id)).rejects.toMatchObject({
      kind: 'conflict',
    });
    const file = await client().getInvoiceFile(created.data.id);
    expect(Buffer.from(file.data).toString('utf8')).toContain('%PDF');
    const payment = await client().getPayment(created.data.id);
    expect(payment.data.paymentStatus).toBe('openRevenue');
    expect(payment.data.voucherStatus).toBe('open');
    fake.setInvoicePaid(created.data.id);
    const paid = await client().getPayment(created.data.id);
    expect(paid.data.paymentStatus).toBe('balanced');
    expect(paid.data.paidDate).toBeDefined();
    const list = await client().voucherlist({
      voucherType: 'invoice',
      voucherStatus: 'paid',
      contactId: contact.data.id,
    });
    expect(list.data.content.map((e) => e.id)).toContain(created.data.id);
    // Fake lehnt read-only Felder und fremde Steuerart ab (keine „bequeme“ API).
    await expect(
      client().createInvoice({ ...invoice, voucherNumber: 'RE1' }, true),
    ).rejects.toMatchObject({ kind: 'validation' });
    await expect(
      client().createInvoice({ ...invoice, taxConditions: { taxType: 'gross' } }, true),
    ).rejects.toMatchObject({ kind: 'validation' });
    // Event-Subscriptions: Duplikat ⇒ 409, Löschen ⇒ 204.
    const sub = await client().createEventSubscription({
      eventType: 'payment.changed',
      callbackUrl: 'https://example.test/webhooks/lexware',
    });
    await expect(
      client().createEventSubscription({
        eventType: 'payment.changed',
        callbackUrl: 'https://example.test/webhooks/lexware',
      }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    expect((await client().listEventSubscriptions()).data.content).toHaveLength(1);
    expect((await client().deleteEventSubscription(sub.data.id)).status).toBe(204);
  });

  it('Rate-Limit-Simulation des Fakes: dritter Request in derselben Sekunde ⇒ 429', async () => {
    const limited = new FakeLexwareServer({ rateLimit: true });
    const url = await limited.start();
    try {
      const c = new LexwareClient({
        baseUrl: url,
        apiKey: limited.apiKey,
        timeoutMs: 1_000,
        throttle: new NoopLexwareThrottle(),
      });
      await c.profile();
      await c.profile();
      await expect(c.profile()).rejects.toMatchObject({ kind: 'rate_limited' });
    } finally {
      await limited.stop();
    }
  });

  it('maskPath maskiert UUIDs in Log-Pfaden', () => {
    expect(maskPath('/v1/invoices/9bb7c7c5-c7f9-41c1-abf9-82023f08bc43/file')).toBe(
      '/v1/invoices/:id/file',
    );
  });
});

describe('Webhook-Signatur (§45, Tests 123–126)', () => {
  it('gültige RSA-SHA512-Signatur über Rohbytes und kompakte Form; ungültige/fehlende abgelehnt', () => {
    const publicKey = loadWebhookPublicKey(fake.publicKeyPem);
    const signed = fake.signWebhook({
      eventType: 'payment.changed',
      resourceId: '9bb7c7c5-c7f9-41c1-abf9-82023f08bc43',
    });
    const raw = Buffer.from(signed.body, 'utf8');
    expect(verifyLexwareSignature(publicKey, raw, signed.signature)).toBe(true);
    // Pretty-printed Zustellung desselben JSON: kompakte Form verifiziert.
    const pretty = Buffer.from(JSON.stringify(JSON.parse(signed.body), null, 2), 'utf8');
    expect(verifyLexwareSignature(publicKey, pretty, signed.signature)).toBe(true);
    // Manipulierter Body ⇒ ungültig; fehlende/kaputte Signatur ⇒ ungültig.
    const tampered = Buffer.from(signed.body.replace('payment.changed', 'invoice.deleted'), 'utf8');
    expect(verifyLexwareSignature(publicKey, tampered, signed.signature)).toBe(false);
    expect(verifyLexwareSignature(publicKey, raw, undefined)).toBe(false);
    expect(verifyLexwareSignature(publicKey, raw, '')).toBe(false);
    expect(verifyLexwareSignature(publicKey, raw, 'nicht-base64!!')).toBe(false);
    // Fremder Schlüssel (anderer Absender) ⇒ ungültig.
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const signer = createSign('RSA-SHA512');
    signer.update(raw);
    signer.end();
    const foreign = signer.sign(other.privateKey).toString('base64');
    expect(verifyLexwareSignature(publicKey, raw, foreign)).toBe(false);
    // Offizieller Lexware-Schlüssel ist ein gültiger RSA-Public-Key.
    expect(loadWebhookPublicKey(LEXWARE_WEBHOOK_PUBLIC_KEY_PEM).asymmetricKeyType).toBe('rsa');
  });
});
