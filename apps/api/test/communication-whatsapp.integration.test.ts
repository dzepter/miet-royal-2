/**
 * Phase 12 – WhatsApp Business Cloud API (Order §§26–28, 39; Pflichttests
 * WHATSAPP 97–116 + SECURITY WhatsApp Signature/Spoof, Secrets, Demo-Isolation):
 * Production wählt den offiziellen Gateway (Graph-Vertrag über injizierten
 * fetch verifiziert), Demo den Mock; Verify-Challenge; Signatur gültig/
 * ungültig/fehlend; Raw-Body-Treue; Text; Dedupe; Bilder über media_fetch;
 * Dokumente ignoriert; Zuordnung (Reply-Kontext, Telefon eindeutig, mehrere
 * Vorgänge ⇒ unmatched); Service-Fenster offen/geschlossen; Rechte; Secrets
 * nie in Antworten/Logs; Demo-Isolation (Mock sendet keinen echten Request).
 */
import { Writable } from 'node:stream';
import { loadConfig } from '@mietroyal/config';
import {
  conversationMessages,
  messagePhotos,
  processes,
  whatsappContacts,
  whatsappEvents,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { WHATSAPP_WINDOW_CLOSED_MESSAGE } from '../src/communication/types.ts';
import {
  CloudApiWhatsAppGateway,
  createWhatsAppGateway,
  FakeWhatsAppGateway,
  MockWhatsAppGateway,
  WHATSAPP_MOCK_LABEL,
} from '../src/communication/whatsapp/gateways.ts';
import { whatsappStatusSummary } from '../src/communication/whatsapp/status.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import {
  completeProcess,
  createCustomerWithProcess,
  drainJobs,
  postWhatsAppWebhook,
  truncateCommunicationTables,
  whatsappMessagePayload,
  whatsappStatusPayload,
} from './communication-helpers.ts';
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';

let ctx: TestContext;
let adminId: string;
let adminCookie: string;
const logLines: string[] = [];
const logDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});

const WA_ID = '4917612345678';
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 0xff, 0xd9,
]);

beforeAll(async () => {
  ctx = await createTestContext({ whatsapp: true, logDestination, logLevel: 'trace' });
});
afterAll(async () => {
  // Nichts in der geteilten Test-DB zurücklassen (Statusroute anderer Tests erwartet leeren Poller-Zustand).
  await truncateCommunicationTables(ctx.pool);
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateCommunicationTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  ctx.whatsapp.reset();
  logLines.length = 0;
  const admin = await bootstrapAdmin(ctx);
  adminId = admin.id;
  adminCookie = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
});

const messages = () => ctx.db.select().from(conversationMessages);
const events = () => ctx.db.select().from(whatsappEvents);
const reply = (processId: string, body: string, cookie = adminCookie) =>
  ctx.app.inject({
    method: 'POST',
    url: `/staff/processes/${processId}/conversation/reply`,
    headers: { cookie },
    payload: { channel: 'whatsapp', body },
  });

describe('Gateway-Wahl und Graph-Vertrag (97, 98, 116)', () => {
  it('97. production + WHATSAPP_ENABLED ⇒ offizieller Cloud-API-Gateway mit festem Host; Request entspricht dem Graph-Vertrag (verifiziert 2026-10-18)', async () => {
    const config = loadConfig({
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pw@db.example/prod',
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: '/var/lib/mietroyal',
      AUTH_SECRET_KEY: 'production-auth-secret-key-with-32-chars!!',
      COMMUNICATION_PAYLOAD_KEY: 'production-communication-key-with-32-chars',
      WHATSAPP_ENABLED: 'true',
      WHATSAPP_ACCESS_TOKEN: 'EAAG-prod-token-never-logged',
      WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
      WHATSAPP_BUSINESS_ACCOUNT_ID: '987654321098765',
      WHATSAPP_APP_SECRET: 'prod-app-secret-0123456789abcdef',
      WHATSAPP_VERIFY_TOKEN: 'prod-verify-token-0123456789abcdef',
    });
    expect(config.whatsapp).toMatchObject({
      mode: 'live',
      baseUrl: 'https://graph.facebook.com',
      graphApiVersion: 'v25.0',
    });
    const requests: { url: string; init: RequestInit }[] = [];
    const fetchFake = async (url: string, init?: RequestInit) => {
      requests.push({ url, init: init ?? {} });
      return new Response(
        JSON.stringify({
          messaging_product: 'whatsapp',
          contacts: [{ input: WA_ID, wa_id: WA_ID }],
          messages: [{ id: 'wamid.HBgL' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const gateway = createWhatsAppGateway(config, { fetch: fetchFake });
    expect(gateway.kind).toBe('cloud_api');
    expect(gateway).toBeInstanceOf(CloudApiWhatsAppGateway);
    const outcome = await gateway.sendText({
      to: WA_ID,
      text: 'Hallo',
      replyToProviderMessageId: 'wamid.ctx',
    });
    expect(outcome).toEqual({ outcome: 'accepted', providerMessageId: 'wamid.HBgL' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://graph.facebook.com/v25.0/123456789012345/messages');
    expect(requests[0]!.init.method).toBe('POST');
    const headers = requests[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer EAAG-prod-token-never-logged');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(requests[0]!.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: WA_ID,
      type: 'text',
      text: { preview_url: false, body: 'Hallo' },
      context: { message_id: 'wamid.ctx' },
    });

    // Fehlerklassifikation über echte Graph-Antworten.
    const errorGateway = (status: number, code: number) =>
      createWhatsAppGateway(config, {
        fetch: async () =>
          new Response(JSON.stringify({ error: { message: 'x', type: 'OAuthException', code } }), {
            status,
          }),
      });
    expect(await errorGateway(400, 131047).sendText({ to: WA_ID, text: 'x' })).toEqual({
      outcome: 'permanent_error',
      code: 'WINDOW_CLOSED',
    });
    expect((await errorGateway(400, 130429).sendText({ to: WA_ID, text: 'x' })).outcome).toBe(
      'transient_error',
    );
    expect((await errorGateway(401, 190).sendText({ to: WA_ID, text: 'x' })).outcome).toBe(
      'permanent_error',
    );
    // Ohne Konfiguration in production: disabled, nie Mock.
    const disabled = createWhatsAppGateway(
      loadConfig({
        APP_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pw@db.example/prod',
        STORAGE_DRIVER: 'fs',
        STORAGE_FS_ROOT: '/var/lib/mietroyal',
        AUTH_SECRET_KEY: 'production-auth-secret-key-with-32-chars!!',
        COMMUNICATION_PAYLOAD_KEY: 'production-communication-key-with-32-chars',
      }),
    );
    expect(disabled.kind).toBe('disabled');
  });

  it('98. demo ⇒ MockWhatsAppGateway („DEMO / simuliert“), Webhook neutral 404; 116. Demo-Isolation: Mock sendet nie einen echten Request', async () => {
    const config = loadConfig({
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://user:pw@db.example/demo',
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: '/var/lib/mietroyal-demo',
      AUTH_SECRET_KEY: 'demo-auth-secret-key-with-32-chars-xxxxx',
      COMMUNICATION_PAYLOAD_KEY: 'demo-communication-key-with-32-chars-xxxx',
    });
    expect(config.whatsapp.mode).toBe('mock');
    expect(config.whatsapp.accessToken).toBeNull();
    const gateway = createWhatsAppGateway(config, {
      fetch: async () => {
        throw new Error('Mock darf nie fetch aufrufen');
      },
    });
    expect(gateway).toBeInstanceOf(MockWhatsAppGateway);
    expect((gateway as MockWhatsAppGateway).label).toBe(WHATSAPP_MOCK_LABEL);
    const outcome = await gateway.sendText({ to: WA_ID, text: 'Demo' });
    expect(outcome.outcome).toBe('accepted');
    expect((outcome as { providerMessageId: string }).providerMessageId).toMatch(/^mock-/);
    // Demo lehnt echte Zugangsdaten ab.
    expect(() =>
      loadConfig({
        APP_ENV: 'demo',
        DATABASE_URL: 'postgresql://user:pw@db.example/demo',
        STORAGE_DRIVER: 'fs',
        STORAGE_FS_ROOT: '/var/lib/mietroyal-demo',
        AUTH_SECRET_KEY: 'demo-auth-secret-key-with-32-chars-xxxxx',
        COMMUNICATION_PAYLOAD_KEY: 'demo-communication-key-with-32-chars-xxxx',
        WHATSAPP_ACCESS_TOKEN: 'echt',
      }),
    ).toThrow(/WHATSAPP_\*/);
    // Status-Zusammenfassung kennzeichnet den Mock.
    const summary = await whatsappStatusSummary(ctx.db, config);
    expect(summary).toMatchObject({ mode: 'mock', label: WHATSAPP_MOCK_LABEL, eventsLast24h: 0 });
    // Webhook ohne Live-Konfiguration: neutral 404 (Mock-App aus demo-Config).
    const demoApp = buildApp({ config, rateLimitEnabled: false });
    await demoApp.ready();
    const verify = await demoApp.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1',
    });
    expect(verify.statusCode).toBe(404);
    await demoApp.close();
    // production verweigert injizierte Fake-/Mock-Gateways.
    const prodConfig = loadConfig({
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pw@db.example/prod',
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: '/var/lib/mietroyal',
      AUTH_SECRET_KEY: 'production-auth-secret-key-with-32-chars!!',
      COMMUNICATION_PAYLOAD_KEY: 'production-communication-key-with-32-chars',
    });
    expect(() =>
      buildApp({ config: prodConfig, whatsappGateway: new FakeWhatsAppGateway() }),
    ).toThrow(/production/);
    expect(() =>
      buildApp({ config: prodConfig, whatsappGateway: new MockWhatsAppGateway() }),
    ).toThrow(/production/);
  });
});

describe('Webhook: Verify, Signatur, Raw Body (99–102)', () => {
  it('99. Verify-Challenge: richtiger Token ⇒ 200 text/plain mit hub.challenge; falscher Token/Modus ⇒ 403', async () => {
    const token = ctx.whatsappSecrets!.verifyToken;
    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1158201444`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/plain');
    expect(ok.body).toBe('1158201444');
    const wrong = await ctx.app.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=falsch&hub.challenge=1',
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.body).not.toContain(token);
    const wrongMode = await ctx.app.inject({
      method: 'GET',
      url: `/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=1`,
    });
    expect(wrongMode.statusCode).toBe(403);
    const missing = await ctx.app.inject({ method: 'GET', url: '/webhooks/whatsapp' });
    expect(missing.statusCode).toBe(403);
  });

  it('100. Gültige Signatur ⇒ 200 und Verarbeitung; 101. ungültige/fehlende Signatur ⇒ 401 neutral, nichts persistiert', async () => {
    const payload = whatsappMessagePayload({
      id: 'wamid.sig-1',
      from: WA_ID,
      text: 'Hallo Miet-Royal',
    });
    const bad = await postWhatsAppWebhook(ctx, payload, { secret: 'falsches-secret-0123456789' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('REJECTED');
    expect(bad.body).not.toContain('Signatur');
    const missing = await postWhatsAppWebhook(ctx, payload, { signature: null });
    expect(missing.statusCode).toBe(401);
    const garbage = await postWhatsAppWebhook(ctx, payload, { signature: 'sha256=nope' });
    expect(garbage.statusCode).toBe(401);
    expect(await events()).toHaveLength(0);
    expect(await messages()).toHaveLength(0);
    const ok = await postWhatsAppWebhook(ctx, payload);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ received: true, messages: 1, statuses: 0 });
    expect(await events()).toHaveLength(1);
    expect(await messages()).toHaveLength(1);
  });

  it('102. Signatur über die ROHEN Bytes: Unicode/Whitespace-Varianten gelten nur mit ihrer eigenen Signatur', async () => {
    const payload = whatsappMessagePayload({
      id: 'wamid.raw-1',
      from: WA_ID,
      text: 'Grüße 🎉 mit   Leerzeichen',
    });
    const compact = JSON.stringify(payload);
    const pretty = JSON.stringify(payload, null, 2) + '\n';
    // Signatur des kompakten Bodys passt nicht zum pretty-printed Body.
    const { signWhatsAppBody } = await import('../src/communication/whatsapp/webhook-service.ts');
    const compactSig = signWhatsAppBody(
      ctx.whatsappSecrets!.appSecret,
      Buffer.from(compact, 'utf8'),
    );
    const mismatch = await postWhatsAppWebhook(ctx, pretty, { signature: compactSig });
    expect(mismatch.statusCode).toBe(401);
    const ok = await postWhatsAppWebhook(ctx, pretty);
    expect(ok.statusCode).toBe(200);
    const [message] = await messages();
    expect(message!.body).toBe('Grüße 🎉 mit   Leerzeichen');
    // Kein JSON ⇒ 400 nach gültiger Signatur; zu groß ⇒ 413.
    const notJson = await postWhatsAppWebhook(ctx, 'kein json');
    expect(notJson.statusCode).toBe(400);
    const huge = await postWhatsAppWebhook(
      ctx,
      JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024 + 10) }),
    );
    expect(huge.statusCode).toBe(413);
  });
});

describe('Eingehend: Text, Dedupe, Bilder, Dokumente (103–106)', () => {
  it('103. Textnachricht ⇒ Konversationszeile (inbound, whatsapp, Absender-Snapshot ohne Mehr), Kontakt mit lastInboundAt', async () => {
    const ts = Math.floor(Date.now() / 1000) - 60;
    const response = await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({
        id: 'wamid.t-1',
        from: WA_ID,
        text: 'Hallo!',
        timestamp: ts,
        profileName: 'Max M.',
      }),
    );
    expect(response.statusCode).toBe(200);
    const [message] = await messages();
    expect(message).toMatchObject({
      channel: 'whatsapp',
      direction: 'inbound',
      processId: null,
      body: 'Hallo!',
      providerMessageId: 'wamid.t-1',
      deliveryState: 'received',
      senderSnapshot: { phone: WA_ID, name: 'Max M.' },
    });
    expect(message!.receivedAt?.getTime()).toBe(ts * 1000);
    const [contact] = await ctx.db.select().from(whatsappContacts);
    expect(contact).toMatchObject({ waId: WA_ID, profileName: 'Max M.', customerId: null });
    expect(contact!.lastInboundAt?.getTime()).toBe(ts * 1000);
    const [event] = await events();
    expect(event).toMatchObject({
      providerMessageId: 'wamid.t-1',
      eventType: 'message',
      status: 'processed',
      resultCode: 'unmatched',
      conversationMessageId: message!.id,
    });
  });

  it('104. Dedupe: dieselbe Message-ID zweimal ⇒ genau eine Zeile, zweite Zustellung 200', async () => {
    const payload = whatsappMessagePayload({ id: 'wamid.dup-1', from: WA_ID, text: 'Einmal' });
    expect((await postWhatsAppWebhook(ctx, payload)).statusCode).toBe(200);
    const second = await postWhatsAppWebhook(ctx, payload);
    expect(second.statusCode).toBe(200);
    expect(await messages()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it('105. Bild ⇒ Job whatsapp.media_fetch lädt über den Gateway, prüft Magic Bytes und speichert privat als message_photos; Fehlerfälle enden ohne Datei', async () => {
    ctx.whatsapp.media.set('media-ok', { mimeType: 'image/jpeg', bytes: JPEG });
    const response = await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({
        id: 'wamid.img-1',
        from: WA_ID,
        type: 'image',
        mediaId: 'media-ok',
      }),
    );
    expect(response.statusCode).toBe(200);
    const [message] = await messages();
    expect(message!.body).toBe('[Bild]');
    const jobs = await ctx.pool.query<{ type: string; idempotency_key: string }>(
      "SELECT type, idempotency_key FROM integration_jobs WHERE type = 'whatsapp.media_fetch'",
    );
    expect(jobs.rows).toEqual([
      { type: 'whatsapp.media_fetch', idempotency_key: 'whatsapp.media_fetch:wamid.img-1' },
    ]);
    await drainJobs(ctx);
    expect(ctx.whatsapp.mediaCalls).toEqual(['media-ok']);
    const photos = await ctx.db
      .select()
      .from(messagePhotos)
      .where(eq(messagePhotos.messageId, message!.id));
    expect(photos).toHaveLength(1);
    expect(photos[0]).toMatchObject({ mimeType: 'image/jpeg', byteSize: JPEG.length });
    expect(await ctx.storage.exists(photos[0]!.storageKey)).toBe(true);
    const bytes = await ctx.app.inject({
      method: 'GET',
      url: `/staff/messages/${message!.id}/photos/${photos[0]!.id}`,
      headers: { cookie: adminCookie },
    });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/jpeg');

    // Getarnt (PDF-Bytes als JPEG) und falscher Typ ⇒ nie gespeichert; 429 ⇒ Retry, danach ok.
    ctx.whatsapp.media.set('media-bad', {
      mimeType: 'image/jpeg',
      bytes: new TextEncoder().encode('%PDF-1.4'),
    });
    ctx.whatsapp.media.set('media-svg', {
      mimeType: 'image/svg+xml',
      bytes: new TextEncoder().encode('<svg/>'),
    });
    ctx.whatsapp.media.set('media-slow', {
      mimeType: 'image/png',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    });
    for (const [id, mediaId] of [
      ['wamid.img-2', 'media-bad'],
      ['wamid.img-3', 'media-svg'],
    ] as const) {
      await postWhatsAppWebhook(
        ctx,
        whatsappMessagePayload({ id, from: WA_ID, type: 'image', mediaId }),
      );
    }
    await drainJobs(ctx);
    expect(await ctx.db.select().from(messagePhotos)).toHaveLength(1);
    const failedBodies = (await messages()).filter((m) => m.providerMessageId !== 'wamid.img-1');
    expect(failedBodies.map((m) => m.body).sort()).toEqual([
      '[Bild konnte nicht geladen werden: MEDIA_MAGIC_MISMATCH]',
      '[Bild konnte nicht geladen werden: MEDIA_TYPE_UNSUPPORTED]',
    ]);
    // 429 beim ersten Versuch ⇒ Job bleibt pending (Retry), kein Foto, Hinweistext unverändert.
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({
        id: 'wamid.img-4',
        from: WA_ID,
        type: 'image',
        mediaId: 'media-slow',
      }),
    );
    ctx.whatsapp.mediaOutcomes.push({ outcome: 'transient_error', code: 'HTTP_429' });
    await drainJobs(ctx);
    const retry = await ctx.pool.query<{ status: string; idempotency_key: string }>(
      "SELECT status, idempotency_key FROM integration_jobs WHERE type = 'whatsapp.media_fetch' ORDER BY created_at",
    );
    expect(retry.rows.map((row) => row.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'pending',
    ]);
    expect(await ctx.db.select().from(messagePhotos)).toHaveLength(1);
    // Retry später: Job wieder fällig machen und erneut laufen lassen ⇒ Foto gespeichert.
    await ctx.pool.query(
      "UPDATE integration_jobs SET run_at = now() WHERE status = 'pending' AND type = 'whatsapp.media_fetch'",
    );
    await drainJobs(ctx);
    expect(await ctx.db.select().from(messagePhotos)).toHaveLength(2);
  });

  it('106. Dokument/Audio/Sticker/Location ⇒ nur Hinweiszeile ohne Inhalt, keine Medien, kein Job', async () => {
    for (const [id, type] of [
      ['wamid.doc-1', 'document'],
      ['wamid.aud-1', 'audio'],
      ['wamid.stk-1', 'sticker'],
      ['wamid.loc-1', 'location'],
    ] as const) {
      expect(
        (await postWhatsAppWebhook(ctx, whatsappMessagePayload({ id, from: WA_ID, type })))
          .statusCode,
      ).toBe(200);
    }
    const rows = await messages();
    expect(rows.map((row) => row.body).sort()).toEqual([
      '[Nicht unterstützter Nachrichtentyp: audio]',
      '[Nicht unterstützter Nachrichtentyp: document]',
      '[Nicht unterstützter Nachrichtentyp: location]',
      '[Nicht unterstützter Nachrichtentyp: sticker]',
    ]);
    expect(JSON.stringify(rows)).not.toContain('x.pdf');
    expect(await ctx.db.select().from(messagePhotos)).toHaveLength(0);
    const jobs = await ctx.pool.query(
      "SELECT count(*)::int AS c FROM integration_jobs WHERE type LIKE 'whatsapp.%'",
    );
    expect(jobs.rows[0].c).toBe(0);
    expect((await events()).map((e) => e.status)).toEqual([
      'ignored',
      'ignored',
      'ignored',
      'ignored',
    ]);
  });
});

describe('Zuordnung (107–109)', () => {
  it('107. Reply-Kontext auf eine eigene Nachricht ⇒ deren Vorgang', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, {
      phone: '+49 176 12345678',
    });
    // Eingang ⇒ zugeordnet über Telefon; Staff antwortet; Kunde antwortet mit Kontext auf unsere Nachricht.
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.in-1', from: WA_ID, text: 'Hallo' }),
    );
    expect((await reply(process.id, 'Guten Tag!')).statusCode).toBe(201);
    await drainJobs(ctx);
    const outbound = (await messages()).find((m) => m.direction === 'outbound')!;
    expect(outbound.deliveryState).toBe('sent');
    expect(outbound.providerMessageId).toMatch(/^wamid\.fake\./);
    // Zweiter Vorgang desselben Kunden ⇒ Telefon-Zuordnung wäre mehrdeutig; Kontext entscheidet.
    const second = await (
      await import('./crm-helpers.ts')
    )
      .processServiceFor(ctx)
      .createProcess(adminId, {
        customerId: process.customerId,
      });
    expect(second.id).not.toBe(process.id);
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({
        id: 'wamid.in-2',
        from: WA_ID,
        text: 'Danke!',
        contextId: outbound.providerMessageId!,
      }),
    );
    const replyRow = (await messages()).find((m) => m.providerMessageId === 'wamid.in-2')!;
    expect(replyRow.processId).toBe(process.id);
    expect(replyRow.replyToProviderMessageId).toBe(outbound.providerMessageId);
    const event = (await events()).find((e) => e.providerMessageId === 'wamid.in-2')!;
    expect(event.resultCode).toBe('reply_context');
  });

  it('108. Telefon eindeutig (Kunde + genau ein aktiver Vorgang) ⇒ zugeordnet; abgeschlossene Vorgänge zählen nicht', async () => {
    const { customer, process } = await createCustomerWithProcess(ctx, adminId, {
      phone: '0176 12345678',
    });
    // Ein zusätzlicher ABGESCHLOSSENER Vorgang stört die Eindeutigkeit nicht.
    const old = await (
      await import('./crm-helpers.ts')
    )
      .processServiceFor(ctx)
      .createProcess(adminId, {
        customerId: customer.id,
      });
    await completeProcess(ctx, old.id);
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.ph-1', from: WA_ID, text: 'Hallo' }),
    );
    const [message] = await messages();
    expect(message).toMatchObject({ processId: process.id, customerId: customer.id });
    const [contact] = await ctx.db.select().from(whatsappContacts);
    expect(contact!.customerId).toBe(customer.id);
    expect((await events())[0]!.resultCode).toBe('phone_unique_process');
    // Vorgang bleibt fachlich unverändert.
    const [after] = await ctx.db.select().from(processes).where(eq(processes.id, process.id));
    expect(after!.updatedAt.getTime()).toBe(process.updatedAt.getTime());
  });

  it('109. Mehrere aktive Vorgänge oder mehrere Kunden mit der Nummer ⇒ unmatched (Kunde bleibt vermerkt, wenn eindeutig)', async () => {
    const { customer } = await createCustomerWithProcess(ctx, adminId, { phone: '+4917612345678' });
    await (
      await import('./crm-helpers.ts')
    )
      .processServiceFor(ctx)
      .createProcess(adminId, { customerId: customer.id });
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.amb-1', from: WA_ID, text: 'Hallo' }),
    );
    const [first] = await messages();
    expect(first).toMatchObject({ processId: null, customerId: customer.id });
    // Zweiter Kunde mit derselben Nummer ⇒ auch Kunde nicht eindeutig.
    await createCustomerWithProcess(ctx, adminId, { phone: '+4917612345678', firstName: 'Moritz' });
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.amb-2', from: WA_ID, text: 'Nochmal' }),
    );
    const second = (await messages()).find((m) => m.providerMessageId === 'wamid.amb-2')!;
    expect(second).toMatchObject({ processId: null, customerId: null });
    // Unmatched-Inbox listet beide mit Kanal whatsapp.
    const inbox = await ctx.app.inject({
      method: 'GET',
      url: '/staff/communication/unmatched',
      headers: { cookie: adminCookie },
    });
    expect(inbox.json().messages).toHaveLength(2);
    expect(inbox.json().messages[0]).toMatchObject({
      channel: 'whatsapp',
      sender: { phone: WA_ID },
    });
  });
});

describe('Staff-Antwort, Service-Fenster, Rechte, Status (110–115)', () => {
  it('110. Innerhalb von 24 h: Antwort wird eingereiht und über whatsapp.send gesendet (Empfänger = wa_id der letzten Kundennachricht, kein freies Feld)', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, { phone: '+4917612345678' });
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.w-1', from: WA_ID, text: 'Frage' }),
    );
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/conversation/reply`,
      headers: { cookie: adminCookie },
      payload: { channel: 'whatsapp', body: 'Antwort', to: '4900000000000' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ channel: 'whatsapp', deliveryState: 'queued' });
    expect(ctx.whatsapp.sendCalls).toHaveLength(0); // nie im Request, nur im Job
    await drainJobs(ctx);
    expect(ctx.whatsapp.sendCalls).toEqual([
      { to: WA_ID, text: 'Antwort', replyToProviderMessageId: 'wamid.w-1' },
    ]);
    const outbound = (await messages()).find((m) => m.direction === 'outbound')!;
    expect(outbound).toMatchObject({
      deliveryState: 'sent',
      processId: process.id,
      createdByStaffId: adminId,
    });
    expect(outbound.sentAt).not.toBeNull();
    // Status-Webhooks spiegeln delivered/read; Rückschritte werden ignoriert.
    await postWhatsAppWebhook(
      ctx,
      whatsappStatusPayload({ id: outbound.providerMessageId!, status: 'read' }),
    );
    await postWhatsAppWebhook(
      ctx,
      whatsappStatusPayload({ id: outbound.providerMessageId!, status: 'delivered' }),
    );
    const [after] = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, outbound.id));
    expect(after!.deliveryState).toBe('read');
    const statusEvents = (await events()).filter((e) => e.eventType.startsWith('status.'));
    expect(statusEvents.map((e) => e.eventType).sort()).toEqual([
      'status.delivered',
      'status.read',
    ]);
    // Liste meldet Fenster offen.
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${process.id}/conversation`,
      headers: { cookie: adminCookie },
    });
    expect(list.json().whatsapp).toMatchObject({ available: true, windowOpen: true, mode: 'live' });
    expect(list.json().canReplyWhatsApp).toBe(true);
  });

  it('111. Außerhalb des 24-h-Fensters ⇒ 409 mit festem Hinweistext, nichts eingereiht; nie Templates/automatische Nachrichten', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, { phone: '+4917612345678' });
    const old = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.old-1', from: WA_ID, text: 'Alt', timestamp: old }),
    );
    const response = await reply(process.id, 'Zu spät');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toBe(WHATSAPP_WINDOW_CLOSED_MESSAGE);
    expect((await messages()).filter((m) => m.direction === 'outbound')).toHaveLength(0);
    const jobs = await ctx.pool.query(
      "SELECT count(*)::int AS c FROM integration_jobs WHERE type = 'whatsapp.send'",
    );
    expect(jobs.rows[0].c).toBe(0);
    expect(ctx.whatsapp.sendCalls).toHaveLength(0);
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${process.id}/conversation`,
      headers: { cookie: adminCookie },
    });
    expect(list.json().whatsapp).toMatchObject({ available: true, windowOpen: false });
    // Neue Kundennachricht öffnet das Fenster wieder.
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.new-1', from: WA_ID, text: 'Neu' }),
    );
    expect((await reply(process.id, 'Jetzt geht es')).statusCode).toBe(201);
    // Ohne jede Kundennachricht im Vorgang ⇒ 409 (kein Empfänger).
    const other = await createCustomerWithProcess(ctx, adminId, { phone: '+4915112345678' });
    expect((await reply(other.process.id, 'Hallo?')).statusCode).toBe(409);
  });

  it('112. Rechte: whatsapp.reply nötig (message.reply_customer reicht nicht), Vorgangssichtbarkeit nötig', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, { phone: '+4917612345678' });
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.r-1', from: WA_ID, text: 'Hi' }),
    );
    const mailOnly = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Mia',
      lastName: 'Mail',
      email: 'mia@test.example',
      password: 'mia-passwort-123456',
      permissionKeys: ['process.view_all', 'message.reply_customer'],
    });
    expect((await reply(process.id, 'x', mailOnly.cookie)).statusCode).toBe(403);
    const waNoView = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Wanda',
      lastName: 'WA',
      email: 'wanda@test.example',
      password: 'wanda-passwort-123456',
      permissionKeys: ['whatsapp.reply'],
    });
    expect((await reply(process.id, 'x', waNoView.cookie)).statusCode).toBe(403);
    const waFull = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Willi',
      lastName: 'WA',
      email: 'willi@test.example',
      password: 'willi-passwort-123456',
      permissionKeys: ['process.view_all', 'whatsapp.reply'],
    });
    expect((await reply(process.id, 'x', waFull.cookie)).statusCode).toBe(201);
    expect(
      (await reply('11111111-2222-4333-8444-555555555555', 'x', waFull.cookie)).statusCode,
    ).toBe(404);
  });

  it('113. Sendefehler: permanent ⇒ failed mit Code (Ereigniszeile), transient ⇒ Retry; Fenster-Fehler des Providers ⇒ failed WINDOW_CLOSED', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, { phone: '+4917612345678' });
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.e-1', from: WA_ID, text: 'Hi' }),
    );
    ctx.whatsapp.sendOutcomes.push({ outcome: 'permanent_error', code: 'WINDOW_CLOSED' });
    const first = await reply(process.id, 'Eins');
    await drainJobs(ctx);
    const firstRow = (await messages()).find((m) => m.id === first.json().messageId)!;
    expect(firstRow.deliveryState).toBe('failed');
    const result = (await events()).find((e) => e.providerMessageId === `outbound:${firstRow.id}`)!;
    expect(result).toMatchObject({
      eventType: 'send_result',
      status: 'failed',
      resultCode: 'WINDOW_CLOSED',
    });

    ctx.whatsapp.sendOutcomes.push({ outcome: 'transient_error', code: 'GRAPH_130429' });
    const second = await reply(process.id, 'Zwei');
    await drainJobs(ctx);
    const secondRow = (await messages()).find((m) => m.id === second.json().messageId)!;
    expect(secondRow.deliveryState).toBe('queued');
    const job = await ctx.pool.query<{ status: string; attempts: number }>(
      'SELECT status, attempts FROM integration_jobs WHERE idempotency_key = $1',
      [`whatsapp.send:${secondRow.id}`],
    );
    expect(job.rows[0]).toMatchObject({ status: 'pending', attempts: 1 });
    await ctx.pool.query(
      "UPDATE integration_jobs SET run_at = now() WHERE status = 'pending' AND type = 'whatsapp.send'",
    );
    await drainJobs(ctx);
    const secondAfter = (await messages()).find((m) => m.id === secondRow.id)!;
    expect(secondAfter.deliveryState).toBe('sent');
    expect(ctx.whatsapp.sendCalls).toHaveLength(3);
  });

  it('114. Secrets erscheinen nie in Antworten oder Logs (Token, App-Secret, Verify-Token, Nummern nur maskiert)', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, { phone: '+4917612345678' });
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.s-1', from: WA_ID, text: 'Geheim?' }),
    );
    const bad = await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.s-2', from: WA_ID }),
      {
        secret: 'anderes-secret-0123456789',
      },
    );
    await reply(process.id, 'Antwort');
    await drainJobs(ctx);
    const list = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${process.id}/conversation`,
      headers: { cookie: adminCookie },
    });
    const outputs = [bad.body, list.body, logLines.join('')].join('\n');
    expect(outputs).not.toContain('test-whatsapp-access-token-never-real');
    expect(outputs).not.toContain(ctx.whatsappSecrets!.appSecret);
    expect(outputs).not.toContain(ctx.whatsappSecrets!.verifyToken);
    const log = logLines.join('');
    expect(log).not.toContain('Geheim?');
    expect(log).not.toContain(WA_ID);
    expect(log).not.toContain('Antwort');
    // Status-Zusammenfassung ohne Nummern/Secrets.
    const summary = await whatsappStatusSummary(ctx.db, ctx.config);
    expect(summary).toMatchObject({ mode: 'live', label: null, contactsWithOpenWindow: 1 });
    expect(summary.eventsLast24h).toBeGreaterThanOrEqual(2);
    expect(summary.lastInboundAt).toBeInstanceOf(Date);
    expect(JSON.stringify(summary)).not.toContain(WA_ID);
  });

  it('115. Statuses für unbekannte Nachrichten werden als Events gespeichert (ignored), failed-Status setzt failed', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, { phone: '+4917612345678' });
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.st-1', from: WA_ID, text: 'Hi' }),
    );
    const unknown = await postWhatsAppWebhook(
      ctx,
      whatsappStatusPayload({ id: 'wamid.unbekannt', status: 'delivered' }),
    );
    expect(unknown.statusCode).toBe(200);
    expect((await events()).find((e) => e.providerMessageId === 'wamid.unbekannt')).toMatchObject({
      status: 'ignored',
      resultCode: 'UNKNOWN_MESSAGE',
    });
    await reply(process.id, 'Hallo');
    await drainJobs(ctx);
    const outbound = (await messages()).find((m) => m.direction === 'outbound')!;
    await postWhatsAppWebhook(
      ctx,
      whatsappStatusPayload({
        id: outbound.providerMessageId!,
        status: 'failed',
        errorCode: 131026,
      }),
    );
    const [after] = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, outbound.id));
    expect(after!.deliveryState).toBe('failed');
    expect((await events()).find((e) => e.eventType === 'status.failed')).toMatchObject({
      resultCode: 'GRAPH_131026',
    });
  });
});
