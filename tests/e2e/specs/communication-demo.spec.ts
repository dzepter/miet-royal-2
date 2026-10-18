/**
 * Phase-12-E2E-Szenario T (Order §39/§43) – Demo-Isolation gegen eine EIGENE
 * Demo-API (Projekt `demo-communication`, playwright.config.ts): APP_ENV=demo,
 * eigene Datenbank `mietroyal_test_demo` (frisch je Lauf, Demo-Admin über den
 * Bootstrap-Weg: apps/api/scripts/e2e-demo-setup.ts), eigenes Storage, eigene
 * Schlüssel, Mail über den ECHTEN SmtpMailGateway an die gemeinsame Senke –
 * aber nur an die Whitelist `@demo.test` und immer mit „[DEMO]“; KEIN
 * WHATSAPP_* (Demo ⇒ MockWhatsAppGateway „DEMO / simuliert“), kein Web Push.
 *
 * Reine API-Tests (Node-fetch mit Session-Cookie; das Demo-Cookie ist
 * `Secure` und wird daher explizit mitgegeben) – keine Staff-Instanz nötig.
 * Fakten aus der Demo-Datenbank liest die Spec direkt (queryDatabase).
 */
import { expect, test } from '@playwright/test';
import { SMTP_SINK_PASSWORD, WHATSAPP_VERIFY_TOKEN } from '../fakes/constants.ts';
import { queryDatabase } from '../helpers/communication-ops.ts';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  DEMO_API_ORIGIN,
  DEMO_AUTH_SECRET_KEY,
  DEMO_COMMUNICATION_PAYLOAD_KEY,
  DEMO_DATABASE_URL,
} from '../helpers/demo-env.ts';
import { clearSink, expectMailCount, expectMietRoyalMail, waitForMail } from '../helpers/mail.ts';
import {
  clearWhatsAppFake,
  inboundWhatsAppPayload,
  postWhatsAppWebhook,
  // Haupt-API (Port 3101) – nur für den Gegencheck „Demo-Token gilt dort nicht“.
  WHATSAPP_API_ORIGIN as MAIN_API_ORIGIN,
  whatsappRequests,
} from '../helpers/whatsapp.ts';

test.describe.configure({ mode: 'serial' });

const BLOCKED_EMAIL = 'echter.kunde@kunden-extern.example';
const ALLOWED_EMAIL = 'dora.demo@demo.test';
const DEMO_WA_ID = '4915100009901';

let cookie = '';

async function demo<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T; text: string }> {
  const response = await fetch(`${DEMO_API_ORIGIN}${path}`, {
    method,
    headers: {
      connection: 'close',
      ...(cookie === '' ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: response.status, data: data as T, text };
}

function demoDb<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return queryDatabase<T>(DEMO_DATABASE_URL, sql, params);
}

async function runDemoJobs() {
  const result = await demo<{ processed: number; failed: number }>(
    'POST',
    '/staff/accounting/mock/run-due-jobs',
  );
  expect(result.status, 'Mock-Steuerung der Demo-API').toBe(200);
  return result.data;
}

async function demoProcess(email: string, lastName: string) {
  const customer = await demo<{ customer: { id: string } }>('POST', '/staff/customers', {
    type: 'private',
    firstName: 'Demo',
    lastName,
    email,
  });
  expect(customer.status).toBe(200);
  const process = await demo<{ process: { id: string; processNumber: string } }>(
    'POST',
    '/staff/processes',
    { customerId: customer.data.customer.id },
  );
  expect(process.status).toBe(200);
  return {
    customerId: customer.data.customer.id,
    processId: process.data.process.id,
    processNumber: process.data.process.processNumber,
  };
}

let allowed: { customerId: string; processId: string; processNumber: string };

test.beforeAll(async () => {
  await clearSink();
  await clearWhatsAppFake();
  const health = await demo<{ environment: string }>('GET', '/health');
  expect(health.data.environment).toBe('demo');
  const login = await fetch(`${DEMO_API_ORIGIN}/auth/login`, {
    method: 'POST',
    headers: { connection: 'close', 'content-type': 'application/json' },
    body: JSON.stringify({ email: DEMO_ADMIN_EMAIL, password: DEMO_ADMIN_PASSWORD }),
  });
  expect(login.status).toBe(200);
  const session = login.headers
    .getSetCookie()
    .find((value) => value.startsWith('mr_staff_session='));
  expect(session, 'Session-Cookie der Demo-API').toBeDefined();
  // Demo ≠ development: Session-Cookie nur über HTTPS (Secure).
  expect(session).toContain('Secure');
  cookie = session!.split(';')[0]!;
});

test('T. Demo-Mail: Status ohne Secrets; Empfänger außerhalb der Whitelist ⇒ blocked DEMO_NOT_WHITELISTED und KEINE Mail in der Senke; freigegebene Adresse ⇒ echte Zustellung mit Betreff „[DEMO] …“', async () => {
  test.setTimeout(120_000);
  const status = await demo<{
    environment: string;
    mail: { enabled: boolean; gateway: string; demoWhitelistCount: number };
    whatsapp: { mode: string; label: string | null };
    push: { enabled: boolean; vapidPublicKey: string | null };
  }>('GET', '/staff/communication/status');
  expect(status.status).toBe(200);
  expect(status.data).toMatchObject({
    environment: 'demo',
    mail: { enabled: true, gateway: 'smtp', demoWhitelistCount: 1 },
    whatsapp: { mode: 'mock', label: 'DEMO / simuliert' },
    push: { enabled: false, vapidPublicKey: null },
  });
  for (const secret of [
    SMTP_SINK_PASSWORD,
    DEMO_AUTH_SECRET_KEY,
    DEMO_COMMUNICATION_PAYLOAD_KEY,
    DEMO_ADMIN_PASSWORD,
  ]) {
    expect(status.text.includes(secret), 'Secret in der Status-Antwort').toBe(false);
  }

  // 1) Nicht freigegebene Adresse: Outbox blockiert, nichts verlässt die Demo.
  const blocked = await demoProcess(BLOCKED_EMAIL, 'Extern');
  const blockedReply = await demo<{ deliveryState: string; mailDeliveryId: string }>(
    'POST',
    `/staff/processes/${blocked.processId}/conversation/reply`,
    { channel: 'email', body: 'Hallo aus der Demo (darf nicht zugestellt werden).' },
  );
  expect(blockedReply.status).toBe(201);
  expect(blockedReply.data.deliveryState).toBe('blocked');
  await runDemoJobs();
  const blockedRows = demoDb<{ status: string; blocked_reason: string | null; attempts: number }>(
    'SELECT status, blocked_reason, attempts FROM mail_deliveries WHERE id = $1',
    [blockedReply.data.mailDeliveryId],
  );
  expect(blockedRows).toEqual([
    { status: 'blocked', blocked_reason: 'DEMO_NOT_WHITELISTED', attempts: 0 },
  ]);
  const deliveries = await demo<{
    deliveries: { id: string; status: string; statusLabel: string; blockedReason: string | null }[];
  }>('GET', `/staff/communication/deliveries?processId=${blocked.processId}`);
  expect(deliveries.data.deliveries).toEqual([
    expect.objectContaining({
      id: blockedReply.data.mailDeliveryId,
      status: 'blocked',
      statusLabel: 'Versand blockiert',
      blockedReason: 'DEMO_NOT_WHITELISTED',
    }),
  ]);
  await expectMailCount({ to: BLOCKED_EMAIL }, 0);

  // 2) Freigegebene Adresse (@demo.test): echte SMTP-Zustellung, Betreff mit „[DEMO]“.
  allowed = await demoProcess(ALLOWED_EMAIL, 'Erlaubt');
  const allowedReply = await demo<{ deliveryState: string; mailDeliveryId: string }>(
    'POST',
    `/staff/processes/${allowed.processId}/conversation/reply`,
    { channel: 'email', body: 'Hallo aus der Demo.' },
  );
  expect(allowedReply.status).toBe(201);
  expect(allowedReply.data.deliveryState).toBe('queued');
  await runDemoJobs();
  const mail = await waitForMail({
    to: ALLOWED_EMAIL,
    subject: `[DEMO] Nachricht von Miet-Royal – Vorgang ${allowed.processNumber}`,
  });
  expectMietRoyalMail(mail);
  expect(mail.subject.startsWith('[DEMO] ')).toBe(true);
  expect(mail.text).toContain('Hallo aus der Demo.');
  const sentRow = demoDb<{ status: string; message_id: string }>(
    'SELECT status, message_id FROM mail_deliveries WHERE id = $1',
    [allowedReply.data.mailDeliveryId],
  )[0]!;
  expect(sentRow.status).toBe('sent');
  expect(mail.messageId).toBe(sentRow.message_id);
  await expectMailCount({ to: ALLOWED_EMAIL }, 1);
  // Weiterhin nichts an die blockierte Adresse (auch nicht nach weiteren Läufen).
  await runDemoJobs();
  await expectMailCount({ to: BLOCKED_EMAIL }, 0);
});

test('T. Demo-WhatsApp: nur Mock „DEMO / simuliert“ – Webhook (Verify + POST) neutral 404, Staff-Antwort läuft über den Mock (kein Graph-Request); Demo-Kalender-Token gilt nicht in der Haupt-API', async () => {
  test.setTimeout(120_000);
  // Webhook existiert in demo nicht – auch nicht mit gültiger Signatur der Haupt-API.
  const verify = await fetch(
    `${DEMO_API_ORIGIN}/webhooks/whatsapp?${new URLSearchParams({
      'hub.mode': 'subscribe',
      'hub.verify_token': WHATSAPP_VERIFY_TOKEN,
      'hub.challenge': 'demo-challenge',
    }).toString()}`,
    { headers: { connection: 'close' } },
  );
  expect(verify.status).toBe(404);
  expect(await verify.text()).not.toContain('demo-challenge');
  const inbound = inboundWhatsAppPayload({ from: DEMO_WA_ID, text: 'Hallo Demo' });
  const posted = await postWhatsAppWebhook(inbound.payload, { apiOrigin: DEMO_API_ORIGIN });
  expect(posted.status).toBe(404);
  expect(demoDb('SELECT id FROM whatsapp_events')).toHaveLength(0);

  // Konversation zeigt den Demo-Modus; eine Kundennachricht kann in demo nur als
  // Fixture existieren (kein Webhook) – die Staff-Antwort geht an den Mock.
  demoDb(
    `INSERT INTO conversation_messages (process_id, customer_id, channel, direction,
       sender_snapshot, body, provider_message_id, delivery_state, received_at)
     VALUES ($1, $2, 'whatsapp', 'inbound', $3::jsonb, 'Hallo (Demo-Fixture)', $4, 'received', now())`,
    [
      allowed.processId,
      allowed.customerId,
      JSON.stringify({ name: 'Demo Kunde', phone: DEMO_WA_ID }),
      `wamid.DEMOFIXTURE${Date.now()}`,
    ],
  );
  demoDb(
    `INSERT INTO whatsapp_contacts (wa_id, customer_id, last_inbound_at, profile_name)
     VALUES ($1, $2, now(), 'Demo Kunde')
     ON CONFLICT (wa_id) DO UPDATE SET last_inbound_at = now()`,
    [DEMO_WA_ID, allowed.customerId],
  );
  const view = await demo<{
    canReplyWhatsApp: boolean;
    whatsapp: { mode: string; available: boolean; windowOpen: boolean };
  }>('GET', `/staff/processes/${allowed.processId}/conversation`);
  expect(view.data).toMatchObject({
    canReplyWhatsApp: true,
    whatsapp: { mode: 'mock', available: true, windowOpen: true },
  });
  await clearWhatsAppFake();
  const reply = await demo<{ messageId: string; channel: string }>(
    'POST',
    `/staff/processes/${allowed.processId}/conversation/reply`,
    { channel: 'whatsapp', body: 'Antwort aus der Demo (simuliert).' },
  );
  expect(reply.status).toBe(201);
  await runDemoJobs();
  const outbound = demoDb<{ delivery_state: string; provider_message_id: string | null }>(
    'SELECT delivery_state, provider_message_id FROM conversation_messages WHERE id = $1',
    [reply.data.messageId],
  );
  expect(outbound).toHaveLength(1);
  expect(outbound[0]!.delivery_state).toBe('sent');
  expect(outbound[0]!.provider_message_id).toMatch(/^mock-/);
  // Kein einziger Request am Graph-Fake (Demo kontaktiert nie WhatsApp).
  expect(await whatsappRequests()).toEqual([]);

  // Kalender: Demo-Token ist nur in der Demo gültig (getrennte DB/Token, Order §39).
  const feed = await demo<{ url: string; absolute: boolean }>('POST', '/staff/calendar/feed');
  expect(feed.status).toBe(200);
  const match = /\/public\/calendar\/([A-Za-z0-9_-]{43})\.ics$/.exec(feed.data.url);
  expect(match !== null, 'Feed-Pfad der Demo').toBe(true);
  const file = `${match![1]}.ics`;
  const demoFeed = await fetch(`${DEMO_API_ORIGIN}/public/calendar/${file}`, {
    headers: { connection: 'close' },
  });
  expect(demoFeed.status).toBe(200);
  const mainFeed = await fetch(`${MAIN_API_ORIGIN}/public/calendar/${file}`, {
    headers: { connection: 'close' },
  });
  expect(mainFeed.status).toBe(404);
});
