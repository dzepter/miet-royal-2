/**
 * Phase 12 Härtung (Review B) – WhatsApp: Regressionstests zu den Funden
 *  B1  Eventzeile + Verarbeitung atomar – nach Absturz/DB-Fehler verarbeitet
 *      Metas Wiederholung die Nachricht (kein Verlust als „Duplikat“),
 *  B2  last_inbound_at springt bei verspäteter Zustellung nicht zurück,
 *  B3  Timeout NACH dem Absenden ⇒ outcome unknown ⇒ kein Auto-Retry (keine
 *      doppelte Staff-Antwort); Verbindungsfehler VOR dem Senden bleiben transient,
 *  B4  Media-Download nur von erlaubten Hosts, ohne Redirects, mit Byte-Limit,
 *  B5  media_fetch-Replay nach Abschluss/Retention lädt das Foto nicht erneut,
 *  B13 Webhook-Events einer fremden phone_number_id ⇒ ignoriert,
 * sowie die geprüften Punkte ohne Fund OK-1/OK-1b/OK-2.
 */
import {
  conversationMessages,
  messagePhotos,
  whatsappContacts,
  whatsappEvents,
} from '@mietroyal/database';
import type { ClaimedJob } from '@mietroyal/integrations';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConversationService } from '../src/communication/conversation/conversation-service.ts';
import {
  classifySendException,
  CloudApiWhatsAppGateway,
  WHATSAPP_OUTCOME_UNKNOWN,
  type FetchLike,
} from '../src/communication/whatsapp/gateways.ts';
import {
  createWhatsAppMediaFetchHandler,
  createWhatsAppSendHandler,
} from '../src/communication/whatsapp/jobs.ts';
import {
  signWhatsAppBody,
  WhatsAppWebhookService,
} from '../src/communication/whatsapp/webhook-service.ts';
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
import { truncateCrmTables } from './crm-helpers.ts';

let ctx: TestContext;
let adminId: string;
let adminCookie: string;

const WA_ID = '4917612345678';
const JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3, 0xff, 0xd9,
]);
const ACCESS_TOKEN = 'hardening-b-access-token-SECRET';

function job(payload: unknown, attempts = 1, maxAttempts = 6): ClaimedJob {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'test',
    payload,
    idempotencyKey: 'hardening-b',
    attempts,
    maxAttempts,
    claimedBy: 'hardening-b',
  };
}

beforeAll(async () => {
  ctx = await createTestContext({ whatsapp: true });
});
afterAll(async () => {
  await truncateCommunicationTables(ctx.pool);
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateCommunicationTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  ctx.whatsapp.reset();
  const admin = await bootstrapAdmin(ctx);
  adminId = admin.id;
  adminCookie = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
});

const messages = () => ctx.db.select().from(conversationMessages);
const events = () => ctx.db.select().from(whatsappEvents);

function graphGateway(fetchImpl: FetchLike) {
  return new CloudApiWhatsAppGateway(
    {
      baseUrl: 'https://graph.facebook.com',
      graphApiVersion: 'v26.0',
      phoneNumberId: '100000000000001',
      accessToken: ACCESS_TOKEN,
    },
    { fetch: fetchImpl },
  );
}

async function outboundRow(processId: string, customerId: string) {
  const [row] = await ctx.db
    .insert(conversationMessages)
    .values({
      processId,
      customerId,
      channel: 'whatsapp',
      direction: 'outbound',
      senderSnapshot: { name: 'Anna Admin', phone: WA_ID },
      body: 'Ihre Maschine ist bereit.',
      isSystemEvent: false,
      deliveryState: 'queued',
    })
    .returning();
  return row!;
}

describe('Härtung Review B – Signatur/Spoof (OK, kein Fund)', () => {
  it('OK-1 (Review B): Signatur nur über exakt die Rohbytes; umformatierter Body, falsche Länge, Präfix in Großbuchstaben, leerer/fehlender Header ⇒ 401', async () => {
    const payload = whatsappMessagePayload({ id: 'wamid.sig-1', from: WA_ID, text: 'Hi' });
    const raw = JSON.stringify(payload);
    const secret = ctx.whatsappSecrets!.appSecret;
    const good = signWhatsAppBody(secret, Buffer.from(raw, 'utf8'));
    // Signatur über die kompakte Form, Body aber mit Leerzeichen gesendet ⇒ abgelehnt.
    const pretty = JSON.stringify(payload, null, 2);
    expect((await postWhatsAppWebhook(ctx, pretty, { signature: good })).statusCode).toBe(401);
    // Kürzere/längere Signatur (timingSafeEqual nie mit ungleicher Länge erreicht).
    expect((await postWhatsAppWebhook(ctx, raw, { signature: good.slice(0, -2) })).statusCode).toBe(
      401,
    );
    expect((await postWhatsAppWebhook(ctx, raw, { signature: `${good}00` })).statusCode).toBe(401);
    expect(
      (await postWhatsAppWebhook(ctx, raw, { signature: good.replace('sha256=', 'SHA256=') }))
        .statusCode,
    ).toBe(401);
    expect((await postWhatsAppWebhook(ctx, raw, { signature: '' })).statusCode).toBe(401);
    expect((await postWhatsAppWebhook(ctx, raw, { signature: null })).statusCode).toBe(401);
    // Signatur mit falschem Secret ⇒ 401; Hex in Großbuchstaben (gültig) ⇒ 200.
    expect((await postWhatsAppWebhook(ctx, raw, { secret: 'x'.repeat(32) })).statusCode).toBe(401);
    const upper = `sha256=${good.slice('sha256='.length).toUpperCase()}`;
    expect((await postWhatsAppWebhook(ctx, raw, { signature: upper })).statusCode).toBe(200);
    expect(await messages()).toHaveLength(1);
  });

  it('OK-1b (Review B): Content-Type mit charset / text/plain bleiben Rohbytes (Signatur gültig ⇒ 200); > 3 MB ⇒ 413 ohne Verarbeitung', async () => {
    const raw = JSON.stringify(whatsappMessagePayload({ id: 'wamid.ct-1', from: WA_ID }));
    expect(
      (await postWhatsAppWebhook(ctx, raw, { contentType: 'application/json; charset=UTF-8' }))
        .statusCode,
    ).toBe(200);
    const raw2 = JSON.stringify(whatsappMessagePayload({ id: 'wamid.ct-2', from: WA_ID }));
    expect((await postWhatsAppWebhook(ctx, raw2, { contentType: 'text/plain' })).statusCode).toBe(
      200,
    );
    const huge = JSON.stringify({
      object: 'whatsapp_business_account',
      pad: 'x'.repeat(3 * 1024 * 1024),
    });
    expect((await postWhatsAppWebhook(ctx, huge)).statusCode).toBe(413);
    expect(await messages()).toHaveLength(2);
  });

  it('OK-2 (Review B): Verify-Challenge – falscher/zu kurzer/zu langer Token und falscher hub.mode ⇒ 403', async () => {
    const token = ctx.whatsappSecrets!.verifyToken;
    const get = (query: string) =>
      ctx.app.inject({ method: 'GET', url: `/webhooks/whatsapp?${query}` });
    expect((await get(`hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`)).body).toBe(
      '42',
    );
    expect(
      (await get(`hub.mode=subscribe&hub.verify_token=${token.slice(0, -1)}&hub.challenge=42`))
        .statusCode,
    ).toBe(403);
    expect(
      (await get(`hub.mode=subscribe&hub.verify_token=${token}x&hub.challenge=42`)).statusCode,
    ).toBe(403);
    expect(
      (await get(`hub.mode=unsubscribe&hub.verify_token=${token}&hub.challenge=42`)).statusCode,
    ).toBe(403);
    expect((await get(`hub.mode=subscribe&hub.challenge=42`)).statusCode).toBe(403);
  });
});

describe('Härtung Review B – Replay/Dedupe (B1)', () => {
  it('B1. DB-Fehler während der Verarbeitung ⇒ Rollback auch der Eventzeile ⇒ Metas Wiederholung verarbeitet die Nachricht (kein Verlust als Duplikat)', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, { phone: '0176 12345678' });
    const payload = whatsappMessagePayload({
      id: 'wamid.crash-1',
      from: WA_ID,
      text: 'Bitte zurückrufen',
    });
    // Verarbeitung scheitert beim Anlegen der Konversationszeile (z. B. DB-Ausfall).
    const real = new ConversationService(ctx.db, ctx.storage);
    let failures = 1;
    const flaky = Object.create(real) as ConversationService;
    flaky.createInbound = async (...args: Parameters<ConversationService['createInbound']>) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('connection terminated unexpectedly');
      }
      return real.createInbound(...args);
    };
    const service = new WhatsAppWebhookService({
      db: ctx.db,
      config: ctx.config,
      queue: ctx.queue,
      conversations: flaky,
    });
    await expect(service.process(payload)).rejects.toThrow(/connection terminated/);
    // Nichts bleibt halb stehen: keine Eventzeile, keine Nachricht, kein Kontakt.
    expect(await events()).toHaveLength(0);
    expect(await messages()).toHaveLength(0);
    expect(await ctx.db.select().from(whatsappContacts)).toHaveLength(0);

    // Metas Wiederholung (nach Nicht-200) über die echte Route ⇒ verarbeitet.
    const retry = await postWhatsAppWebhook(ctx, payload);
    expect(retry.statusCode).toBe(200);
    const [message] = await messages();
    expect(message!.processId).toBe(process.id);
    expect(message!.body).toBe('Bitte zurückrufen');
    const [event] = await events();
    expect(event!.status).toBe('processed');
    expect(event!.conversationMessageId).toBe(message!.id);
    // Weitere Wiederholung ⇒ echtes Duplikat (keine zweite Zeile).
    await postWhatsAppWebhook(ctx, payload);
    expect(await messages()).toHaveLength(1);
  });

  it('B1b. Altbestand: eine `queued`-Eventzeile ohne Ergebnis (Absturz vor der Härtung) wird nach der Karenz bei Metas Wiederholung verarbeitet; innerhalb der Karenz bleibt sie ein Duplikat', async () => {
    await createCustomerWithProcess(ctx, adminId, { phone: '0176 12345678' });
    await ctx.db.insert(whatsappEvents).values([
      {
        providerMessageId: 'wamid.legacy-old',
        eventType: 'message',
        phoneNumberId: '100000000000001',
        status: 'queued',
        receivedAt: new Date(Date.now() - 3 * 60_000),
      },
      {
        providerMessageId: 'wamid.legacy-fresh',
        eventType: 'message',
        phoneNumberId: '100000000000001',
        status: 'queued',
        receivedAt: new Date(Date.now() - 10_000),
      },
    ]);
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.legacy-old', from: WA_ID, text: 'alt' }),
    );
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.legacy-fresh', from: WA_ID, text: 'frisch' }),
    );
    const rows = await messages();
    expect(rows.map((row) => row.providerMessageId)).toEqual(['wamid.legacy-old']);
    const byId = new Map((await events()).map((event) => [event.providerMessageId, event]));
    expect(byId.get('wamid.legacy-old')!.status).toBe('processed');
    expect(byId.get('wamid.legacy-fresh')!.status).toBe('queued');
  });
});

describe('Härtung Review B – Zuordnung (B13)', () => {
  it('B13. metadata.phone_number_id ≠ WHATSAPP_PHONE_NUMBER_ID ⇒ 200 an Meta, Event `ignored` (PHONE_NUMBER_MISMATCH), keine Konversation/kein Kontakt; Status-Events ebenso', async () => {
    const { process, customer } = await createCustomerWithProcess(ctx, adminId, {
      phone: '0176 12345678',
    });
    expect(ctx.config.whatsapp.phoneNumberId).toBe('100000000000001');
    const response = await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({
        id: 'wamid.other-number',
        from: WA_ID,
        text: 'an die Testnummer',
        phoneNumberId: '999999999999999',
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(await messages()).toHaveLength(0);
    expect(await ctx.db.select().from(whatsappContacts)).toHaveLength(0);
    const [event] = await events();
    expect(event).toMatchObject({
      phoneNumberId: '999999999999999',
      status: 'ignored',
      resultCode: 'PHONE_NUMBER_MISMATCH',
      conversationMessageId: null,
    });

    // Status einer fremden Nummer ändert keine eigene Nachricht.
    const own = await outboundRow(process.id, customer.id);
    await ctx.db
      .update(conversationMessages)
      .set({ deliveryState: 'sent', providerMessageId: 'wamid.own-1' })
      .where(eq(conversationMessages.id, own.id));
    const status = whatsappStatusPayload({ id: 'wamid.own-1', status: 'read' }) as {
      entry: { changes: { value: { metadata: { phone_number_id: string } } }[] }[];
    };
    status.entry[0]!.changes[0]!.value.metadata.phone_number_id = '999999999999999';
    expect((await postWhatsAppWebhook(ctx, status)).statusCode).toBe(200);
    const [after] = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, own.id));
    expect(after!.deliveryState).toBe('sent');

    // Gegenprobe: die konfigurierte Nummer wird normal zugeordnet.
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.own-number', from: WA_ID, text: 'richtig' }),
    );
    const inbound = (await messages()).filter((row) => row.direction === 'inbound');
    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.processId).toBe(process.id);
  });
});

describe('Härtung Review B – Service-Window (B2)', () => {
  it('B2. Verspätet/umsortiert zugestellte ältere Nachricht setzt last_inbound_at NICHT zurück ⇒ Fenster bleibt offen, Staff-Antwort 201', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, { phone: '0176 12345678' });
    const now = Math.floor(Date.now() / 1000);
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.new', from: WA_ID, text: 'neu', timestamp: now - 600 }),
    );
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({
        id: 'wamid.old',
        from: WA_ID,
        text: 'alt',
        timestamp: now - 25 * 3600,
      }),
    );
    const [contact] = await ctx.db
      .select()
      .from(whatsappContacts)
      .where(eq(whatsappContacts.waId, WA_ID));
    expect(contact!.lastInboundAt!.getTime()).toBe((now - 600) * 1000);
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/staff/processes/${process.id}/conversation/reply`,
      headers: { cookie: adminCookie },
      payload: { channel: 'whatsapp', body: 'Antwort' },
    });
    expect(response.statusCode).toBe(201);
    // Eine neuere Nachricht schiebt das Fenster weiterhin vor.
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.newest', from: WA_ID, text: 'x', timestamp: now - 60 }),
    );
    const [moved] = await ctx.db
      .select()
      .from(whatsappContacts)
      .where(eq(whatsappContacts.waId, WA_ID));
    expect(moved!.lastInboundAt!.getTime()).toBe((now - 60) * 1000);
  });
});

describe('Härtung Review B – Cloud-API-Gateway (B3, B4)', () => {
  it('B3. Timeout/Abbruch NACH dem Absenden ⇒ outcome unknown ⇒ failed (OUTCOME_UNKNOWN) ohne Queue-Retry: dieselbe Staff-Antwort geht nie ein zweites Mal raus', async () => {
    const { process, customer } = await createCustomerWithProcess(ctx, adminId);
    const posts: string[] = [];
    const gateway = graphGateway(async (url, init) => {
      posts.push(`${init?.method} ${url} ${String(init?.body)}`);
      throw new DOMException('The operation was aborted', 'AbortError');
    });
    const row = await outboundRow(process.id, customer.id);
    const handler = createWhatsAppSendHandler({ db: ctx.db, storage: ctx.storage, gateway });
    await handler(job({ conversationMessageId: row.id }, 1));
    // Replay/zweiter Versuch: Zeile ist nicht mehr `queued` ⇒ kein zweiter POST.
    await handler(job({ conversationMessageId: row.id }, 2));
    expect(posts).toHaveLength(1);
    const [after] = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, row.id));
    expect(after!.deliveryState).toBe('failed');
    const result = (await events()).find((event) => event.eventType === 'send_result');
    expect(result).toMatchObject({ status: 'failed', resultCode: WHATSAPP_OUTCOME_UNKNOWN });
  });

  it('B3b. Verbindungsfehler VOR dem Senden (ECONNREFUSED/DNS) bleiben transient ⇒ Queue-Retry sendet genau einmal', async () => {
    expect(
      classifySendException(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
        }),
      ),
    ).toEqual({ outcome: 'transient_error', code: 'NETWORK' });
    expect(
      classifySendException(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }),
        }),
      ),
    ).toEqual({ outcome: 'transient_error', code: 'NETWORK' });
    // Verbindungsabbruch mitten im Request / unbekannter Fehler ⇒ unklar.
    expect(
      classifySendException(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }),
        }),
      ),
    ).toEqual({ outcome: 'unknown', code: WHATSAPP_OUTCOME_UNKNOWN });
    expect(classifySendException(new DOMException('aborted', 'AbortError'))).toEqual({
      outcome: 'unknown',
      code: WHATSAPP_OUTCOME_UNKNOWN,
    });

    const { process, customer } = await createCustomerWithProcess(ctx, adminId);
    let call = 0;
    const accepted: string[] = [];
    const gateway = graphGateway(async (url, init) => {
      call += 1;
      if (call === 1) {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        });
      }
      accepted.push(String(init?.body));
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.ok' }] }), { status: 200 });
    });
    const row = await outboundRow(process.id, customer.id);
    const handler = createWhatsAppSendHandler({ db: ctx.db, storage: ctx.storage, gateway });
    await expect(handler(job({ conversationMessageId: row.id }, 1))).rejects.toThrow(/NETWORK/);
    await handler(job({ conversationMessageId: row.id }, 2));
    expect(accepted).toHaveLength(1);
    const [after] = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, row.id));
    expect(after!.deliveryState).toBe('sent');
    expect(after!.providerMessageId).toBe('wamid.ok');
  });

  it('B4. Media-Download-URL auf fremdem Host (z. B. Metadaten-IP) ⇒ MEDIA_HOST_NOT_ALLOWED, der Bearer-Token verlässt Graph nicht', async () => {
    const seen: string[] = [];
    const gateway = graphGateway(async (url) => {
      seen.push(url);
      return new Response(
        JSON.stringify({
          url: 'https://169.254.169.254/latest/meta-data/',
          mime_type: 'image/jpeg',
        }),
        { status: 200 },
      );
    });
    expect(await gateway.fetchMedia('media-123')).toEqual({
      outcome: 'permanent_error',
      code: 'MEDIA_HOST_NOT_ALLOWED',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^https:\/\/graph\.facebook\.com\//);
  });

  it('B4b. Erlaubter Host: keine Redirects (redirect: error), Content-Length > 5 MB ⇒ abgelehnt ohne Lesen, Stream ohne Längenangabe wird nach 5 MB abgebrochen; gültiges Bild ⇒ ok', async () => {
    const MB = 1024 * 1024;
    const mediaUrl = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1';
    let read = 0;
    let mode: 'declared' | 'endless' | 'ok' = 'declared';
    const redirects: (RequestInit['redirect'] | undefined)[] = [];
    const gateway = graphGateway(async (url, init) => {
      redirects.push(init?.redirect);
      if (url.startsWith('https://graph.facebook.com/')) {
        return new Response(JSON.stringify({ url: mediaUrl, mime_type: 'image/jpeg' }), {
          status: 200,
        });
      }
      expect(url).toBe(mediaUrl);
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${ACCESS_TOKEN}`,
      );
      if (mode === 'ok') return new Response(JPEG, { status: 200 });
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = new Uint8Array(MB);
          chunk.set(JPEG.subarray(0, 4));
          read += chunk.length;
          controller.enqueue(chunk);
          if (read >= 50 * MB) controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: mode === 'declared' ? { 'content-length': String(10 * MB) } : {},
      });
    });
    expect(await gateway.fetchMedia('media-1')).toEqual({
      outcome: 'permanent_error',
      code: 'MEDIA_TOO_LARGE',
    });
    expect(read).toBeLessThanOrEqual(2 * MB); // nur Vorab-Puffer des Streams, kein Lesen
    mode = 'endless';
    read = 0;
    expect(await gateway.fetchMedia('media-2')).toEqual({
      outcome: 'permanent_error',
      code: 'MEDIA_TOO_LARGE',
    });
    expect(read).toBeLessThanOrEqual(8 * MB);
    mode = 'ok';
    const ok = await gateway.fetchMedia('media-3');
    expect(ok).toMatchObject({ outcome: 'ok', mimeType: 'image/jpeg' });
    expect(redirects.every((value) => value === 'error')).toBe(true);
  });
});

describe('Härtung Review B – Media-Fetch nach Retention (B5)', () => {
  it('B5. media_fetch-Wiederholung nach Vorgangsabschluss + Foto-Löschung lädt/speichert das Chatfoto NICHT erneut', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, { phone: '0176 12345678' });
    ctx.whatsapp.media.set('media-r', { mimeType: 'image/jpeg', bytes: JPEG });
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({ id: 'wamid.img-r', from: WA_ID, type: 'image', mediaId: 'media-r' }),
    );
    await drainJobs(ctx);
    const [message] = await messages();
    expect(message!.processId).toBe(process.id);
    await completeProcess(ctx, process.id);
    await ctx.scan.retention.cleanupPhotosForProcess(process.id);
    const calls = ctx.whatsapp.mediaCalls.length;

    const handler = createWhatsAppMediaFetchHandler({
      db: ctx.db,
      storage: ctx.storage,
      gateway: ctx.whatsapp,
    });
    await handler(job({ messageId: message!.id, mediaId: 'media-r' }));
    const photos = await ctx.db
      .select()
      .from(messagePhotos)
      .where(eq(messagePhotos.messageId, message!.id));
    expect(photos).toHaveLength(1);
    expect(photos[0]!.deletedAt).not.toBeNull();
    expect(await ctx.storage.exists(photos[0]!.storageKey)).toBe(false);
    expect(ctx.whatsapp.mediaCalls).toHaveLength(calls);
  });

  it('B5b. Bild einer Nachricht eines bereits abgeschlossenen Vorgangs (noch nie geladen) ⇒ kein Download', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, { phone: '0176 12345678' });
    ctx.whatsapp.media.set('media-late', { mimeType: 'image/jpeg', bytes: JPEG });
    await postWhatsAppWebhook(
      ctx,
      whatsappMessagePayload({
        id: 'wamid.img-late',
        from: WA_ID,
        type: 'image',
        mediaId: 'media-late',
      }),
    );
    const [message] = await messages();
    await completeProcess(ctx, process.id);
    await drainJobs(ctx);
    expect(ctx.whatsapp.mediaCalls).not.toContain('media-late');
    expect(
      await ctx.db.select().from(messagePhotos).where(eq(messagePhotos.messageId, message!.id)),
    ).toHaveLength(0);
  });
});
