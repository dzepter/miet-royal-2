/**
 * Härtung Review A (Phase 12, Order §§7–9/16/24/44) – Regressionstests zur Mail-Outbox:
 *  RA-1e Timeout nach DATA ⇒ outcome_unknown, KEIN automatischer Folgejob/zweiter Versand.
 *  RA-3  Resend idempotent: je Quelle genau eine Resend-Zustellung (paralleler Doppelklick ⇒
 *        eine Mail, 409); Resend einer Resend-Zustellung bleibt möglich; überholte Quelle ⇒ 409.
 *  RA-4  Rewrap erfasst failed/outcome_unknown/blocked ⇒ nach Entfernen des Vorgängerschlüssels
 *        bleibt „erneut senden“ möglich.
 *  RA-14 Automatische Mails eines Vorgangs erscheinen als Systemereignis in der Konversation
 *        (Order §24), idempotent, mit Zustellstatus; Staff-Antworten werden nicht doppelt gezeigt.
 *  RA-15 Dedupe liefert den echten Status (existingStatus); bewusste Wiederholung nach
 *        failed legt eine neue Zustellung `<key>:retry:<vorherige>` an.
 *  RA-13-K (kein Fund) Resend einer DEMO_NOT_WHITELISTED-Zustellung bleibt blockiert.
 * Kein echter Provider: lokaler Mini-SMTP-Server (127.0.0.1) bzw. FakeMailGateway.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@mietroyal/config';
import {
  conversationMessages,
  integrationJobs,
  mailDeliveries,
  type MailDeliveryRow,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConversationService } from '../src/communication/conversation/conversation-service.ts';
import { FakeMailGateway, SmtpMailGateway } from '../src/communication/mail/gateways.ts';
import { MailOutboxService } from '../src/communication/mail/outbox.ts';
import { MailSendProcessor } from '../src/communication/mail/send-job.ts';
import { PayloadCrypto } from '../src/communication/payload-crypto.ts';
import { rewrapCommunicationSecrets } from '../src/communication/rewrap.ts';
import type { MailEnqueueInput, OutboundMailGateway } from '../src/communication/types.ts';
import {
  createTestContext,
  destroyTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { createTestCustomer, processServiceFor, truncateCrmTables } from './crm-helpers.ts';
import {
  REVIEW_SMTP_CONFIG,
  localTransport,
  startMiniSmtp,
  stopMiniSmtp,
  type MiniSmtp,
} from './communication-test-smtp.ts';
import { adminSession } from './settlement-helpers.ts';

const MINUTES = 60_000;

let ctx: TestContext;
let mini: MiniSmtp | null = null;

beforeAll(async () => {
  ctx = await createTestContext({
    env: {
      MAIL_ENABLED: 'true',
      MAIL_SMTP_HOST: 'smtp.test.example',
      MAIL_SMTP_USER: 'mailer@miet-royal.test',
      MAIL_SMTP_PASSWORD: 'smtp-password-review-a',
      MAIL_FROM_NAME: 'Miet-Royal Mainz',
      MAIL_FROM_ADDRESS: 'noreply@miet-royal.test',
      MAIL_PUBLIC_WEB_BASE_URL: 'https://web.test.example',
    },
  });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE mail_deliveries, conversation_messages, integration_jobs CASCADE');
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  ctx.mailGateway.reset();
});
afterEach(async () => {
  await stopMiniSmtp(mini);
  mini = null;
});

function processorWith(gateway: OutboundMailGateway, now?: () => Date, crypto?: PayloadCrypto) {
  const c = ctx.communication;
  return new MailSendProcessor({
    db: c.db,
    config: c.config,
    crypto: crypto ?? c.crypto,
    gateway,
    queue: c.queue,
    documents: c.documents,
    invoiceFiles: () => null,
    sentListeners: () => [],
    failedListeners: () => [],
    ...(now === undefined ? {} : { now }),
  });
}

function returnProtocolInput(key = `return_protocol:${randomUUID()}`): MailEnqueueInput {
  return {
    kind: 'return_protocol',
    recipient: { email: 'kunde@example.org', name: 'Max Mustermann' },
    context: {
      salutation: 'Hallo Max,',
      processNumber: 'MR-2026-0001',
      returnAt: '2026-10-18T10:00:00Z',
    },
    idempotencyKey: key,
  };
}

function offerInput(key = `review-a-offer:${randomUUID()}`): MailEnqueueInput {
  return {
    kind: 'offer',
    recipient: { email: 'kunde@example.org', name: 'Max Mustermann' },
    context: {
      salutation: 'Hallo Max,',
      processNumber: 'MR-2026-0001',
      eventDate: '2026-11-20',
      validUntil: '2026-11-01T10:00:00Z',
    },
    secrets: { offerToken: 'offer-token-review-a-abcdefghijklmnop' },
    idempotencyKey: key,
  };
}

async function row(id: string): Promise<MailDeliveryRow> {
  const rows = await ctx.db.select().from(mailDeliveries).where(eq(mailDeliveries.id, id));
  if (rows[0] === undefined) throw new Error('Zustellung fehlt');
  return rows[0];
}

async function drain(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if ((await ctx.jobs.runOnce()) === 'idle') break;
  }
}

async function failedDelivery(input: MailEnqueueInput = returnProtocolInput()) {
  const enqueued = await ctx.communication.outbox.enqueue(input);
  ctx.mailGateway.nextOutcomes({ outcome: 'permanent_error', code: 'SMTP_550' });
  await processorWith(ctx.mailGateway).process(enqueued.deliveryId);
  expect((await row(enqueued.deliveryId)).status).toBe('failed');
  ctx.mailGateway.reset();
  return enqueued;
}

describe('Härtung Review A – kein Doppelversand nach Timeout (RA-1e, Order §§9/44)', () => {
  it('RA-1e Timeout nach DATA ⇒ outcome_unknown, kein Folgejob, kein zweiter automatischer Versand; nur manueller Resend mit neuer Message-ID', async () => {
    mini = await startMiniSmtp();
    mini.afterData.push('stall', 'ok');
    const smtp = new SmtpMailGateway(REVIEW_SMTP_CONFIG, { transport: localTransport(mini.port) });
    const enqueued = await ctx.communication.outbox.enqueue(returnProtocolInput());

    const first = await processorWith(smtp).process(enqueued.deliveryId);
    expect(first).toEqual({ outcome: 'outcome_unknown', errorCode: 'SMTP_ETIMEDOUT' });
    expect(await row(enqueued.deliveryId)).toMatchObject({
      status: 'outcome_unknown',
      lastErrorCode: 'SMTP_ETIMEDOUT',
      nextAttemptAt: null,
    });
    const followUps = await ctx.db
      .select()
      .from(integrationJobs)
      .where(eq(integrationJobs.idempotencyKey, `mail.send:${enqueued.deliveryId}:1`));
    expect(followUps).toHaveLength(0);

    // Auch später: kein Claim (outcome_unknown ist Endzustand ohne Automatik).
    const later = new Date(Date.now() + 2 * MINUTES);
    const second = await processorWith(smtp, () => later).process(enqueued.deliveryId);
    expect(second).toEqual({ outcome: 'noop', status: 'outcome_unknown' });
    expect(mini.received).toHaveLength(1);

    // Bewusstes „erneut senden“ (Admin): neue Zustellung, NEUE Message-ID.
    const resent = await ctx.communication.outbox.resend(enqueued.deliveryId, null);
    expect(resent.messageId).not.toBe(enqueued.messageId);
    expect(await processorWith(smtp).process(resent.deliveryId)).toEqual({
      outcome: 'sent',
      errorCode: null,
    });
    expect(mini.received).toHaveLength(2);
    expect(mini.received[1]).toContain(resent.messageId.slice(1, -1));
  });
});

describe('Härtung Review A – Resend idempotent (RA-3, Order §§9/16)', () => {
  it('RA-3 zwei parallele POST /resend auf dieselbe Quelle ⇒ eine neue Zustellung (200) + 409, genau eine Mail', async () => {
    const { cookie } = await adminSession(ctx);
    const failed = await failedDelivery();
    const responses = await Promise.all(
      [0, 1].map(() =>
        ctx.app.inject({
          method: 'POST',
          url: `/staff/communication/deliveries/${failed.deliveryId}/resend`,
          headers: { cookie },
        }),
      ),
    );
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const ok = responses.find((r) => r.statusCode === 200)!;
    const resentId = (ok.json() as { deliveryId: string }).deliveryId;
    expect((await row(resentId)).idempotencyKey).toBe(
      `${(await row(failed.deliveryId)).idempotencyKey}:resend:${failed.deliveryId}`,
    );
    await drain();
    expect(ctx.mailGateway.sent).toHaveLength(1);
    // Dritter Versuch (sequenziell) bleibt 409; die Liste zeigt die Quelle nicht mehr als resendable.
    const third = await ctx.app.inject({
      method: 'POST',
      url: `/staff/communication/deliveries/${failed.deliveryId}/resend`,
      headers: { cookie },
    });
    expect(third.statusCode).toBe(409);
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/staff/communication/deliveries',
      headers: { cookie },
    });
    const source = (
      list.json() as {
        deliveries: { id: string; resendable: boolean; resentDeliveryId: string | null }[];
      }
    ).deliveries.find((d) => d.id === failed.deliveryId)!;
    expect(source).toMatchObject({ resendable: false, resentDeliveryId: resentId });
  });

  it('RA-3b Resend einer gescheiterten Resend-Zustellung bleibt möglich (neue Quelle)', async () => {
    const failed = await failedDelivery();
    const firstResend = await ctx.communication.outbox.resend(failed.deliveryId, null);
    ctx.mailGateway.nextOutcomes({ outcome: 'permanent_error', code: 'SMTP_550' });
    await processorWith(ctx.mailGateway).process(firstResend.deliveryId);
    expect((await row(firstResend.deliveryId)).status).toBe('failed');
    const secondResend = await ctx.communication.outbox.resend(firstResend.deliveryId, null);
    expect(secondResend).toMatchObject({ status: 'pending', deduplicated: false });
    await expect(ctx.communication.outbox.resend(failed.deliveryId, null)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('RA-3c überholte Quelle: neuere Zustellung desselben Fachobjekts versendet ⇒ alte gescheiterte nicht mehr resendbar (409)', async () => {
    const entityId = randomUUID();
    const failed = await failedDelivery(returnProtocolInput(`return_protocol:${entityId}`));
    const retry = await ctx.communication.outbox.enqueueRetryingFailed(
      returnProtocolInput(`return_protocol:${entityId}`),
    );
    expect(retry.deduplicated).toBe(false);
    await processorWith(ctx.mailGateway).process(retry.deliveryId);
    expect((await row(retry.deliveryId)).status).toBe('sent');
    await expect(ctx.communication.outbox.resend(failed.deliveryId, null)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('neuere Zustellung'),
    });
  });
});

describe('Härtung Review A – Dedupe-Status und bewusste Wiederholung (RA-15)', () => {
  it('RA-15 enqueue mit vorhandenem Schlüssel liefert den echten Status; enqueueRetryingFailed legt nach failed eine Retry-Zustellung an', async () => {
    const key = `return_protocol:${randomUUID()}`;
    const failed = await failedDelivery(returnProtocolInput(key));
    const again = await ctx.communication.outbox.enqueue(returnProtocolInput(key));
    expect(again).toMatchObject({
      deliveryId: failed.deliveryId,
      deduplicated: true,
      existingStatus: 'failed',
    });
    const retry = await ctx.communication.outbox.enqueueRetryingFailed(returnProtocolInput(key));
    expect(retry).toMatchObject({ status: 'pending', deduplicated: false, existingStatus: null });
    expect((await row(retry.deliveryId)).idempotencyKey).toBe(`${key}:retry:${failed.deliveryId}`);
    // Doppelklick ⇒ dieselbe (laufende) Retry-Zeile, keine dritte.
    const twice = await ctx.communication.outbox.enqueueRetryingFailed(returnProtocolInput(key));
    expect(twice).toMatchObject({
      deliveryId: retry.deliveryId,
      deduplicated: true,
      existingStatus: 'pending',
    });
    // Unklare Zustellung wird NIE automatisch wiederholt.
    ctx.mailGateway.nextOutcomes({ outcome: 'unknown', code: 'SMTP_ETIMEDOUT' });
    await processorWith(ctx.mailGateway).process(retry.deliveryId);
    const unknown = await ctx.communication.outbox.enqueueRetryingFailed(returnProtocolInput(key));
    expect(unknown).toMatchObject({
      deliveryId: retry.deliveryId,
      deduplicated: true,
      existingStatus: 'outcome_unknown',
    });
  });
});

describe('Härtung Review A – Key-Rotation / Rewrap (RA-4, Order §§7/8)', () => {
  const KEY_A = 'review-a-communication-key-A-0123456789abcdef';
  const KEY_B = 'review-a-communication-key-B-0123456789abcdef';
  const cryptoFor = (current: string, previous: string | null) =>
    new PayloadCrypto({
      appEnv: ctx.config.appEnv,
      auth: ctx.config.auth,
      communication: { payloadKey: current, payloadKeyPrevious: previous },
    });
  const outboxFor = (crypto: PayloadCrypto) =>
    new MailOutboxService(ctx.db, ctx.config, crypto, ctx.mailGateway, ctx.queue);

  it('RA-4 failed/outcome_unknown-Zustellungen werden neu gekapselt ⇒ nach Abschluss der Rotation bleibt Resend möglich', async () => {
    const outboxA = outboxFor(cryptoFor(KEY_A, null));
    const pending = await outboxA.enqueue(offerInput());
    const failed = await outboxA.enqueue(offerInput());
    const unknown = await outboxA.enqueue(offerInput());
    ctx.mailGateway.nextOutcomes(
      { outcome: 'permanent_error', code: 'SMTP_550' },
      { outcome: 'unknown', code: 'SMTP_ETIMEDOUT' },
    );
    await processorWith(ctx.mailGateway, undefined, cryptoFor(KEY_A, null)).process(
      failed.deliveryId,
    );
    await processorWith(ctx.mailGateway, undefined, cryptoFor(KEY_A, null)).process(
      unknown.deliveryId,
    );
    expect((await row(failed.deliveryId)).status).toBe('failed');
    expect((await row(unknown.deliveryId)).status).toBe('outcome_unknown');

    const result = await rewrapCommunicationSecrets(ctx.db, cryptoFor(KEY_B, KEY_A));
    expect(result.mailDeliveries).toEqual({
      scanned: 3,
      current: 0,
      rewrapped: 3,
      undecryptable: 0,
    });
    const cryptoB = cryptoFor(KEY_B, null);
    for (const id of [pending.deliveryId, failed.deliveryId, unknown.deliveryId]) {
      expect(cryptoB.inspect((await row(id)).secretPayloadCiphertext!).current).toBe(true);
    }
    // Status bleibt unverändert (keine „blocked“-Umdeutung einer unklaren Zustellung).
    expect((await row(unknown.deliveryId)).status).toBe('outcome_unknown');

    // Vorgängerschlüssel entfernt ⇒ Resend funktioniert weiterhin.
    const outboxB = outboxFor(cryptoB);
    expect((await outboxB.resend(failed.deliveryId, null)).status).toBe('pending');
    expect((await outboxB.resend(unknown.deliveryId, null)).status).toBe('pending');
  });

  it('RA-4b nicht entschlüsselbare failed-Zustellung: gezählt, Status bleibt failed (pending/retry würden blocked)', async () => {
    const foreign = outboxFor(cryptoFor('completely-foreign-key-0123456789abcdefgh', null));
    const failed = await foreign.enqueue(offerInput());
    ctx.mailGateway.nextOutcomes({ outcome: 'permanent_error', code: 'SMTP_550' });
    await processorWith(
      ctx.mailGateway,
      undefined,
      cryptoFor('completely-foreign-key-0123456789abcdefgh', null),
    ).process(failed.deliveryId);
    const result = await rewrapCommunicationSecrets(ctx.db, cryptoFor(KEY_B, KEY_A));
    expect(result.mailDeliveries).toMatchObject({ scanned: 1, undecryptable: 1 });
    expect((await row(failed.deliveryId)).status).toBe('failed');
  });
});

describe('Härtung Review A – Konversation zeigt automatische Mails (RA-14, Order §24)', () => {
  async function processWorld() {
    const { admin, cookie } = await adminSession(ctx);
    const customer = await createTestCustomer(ctx, admin.id, { email: 'kunde@example.org' });
    const process = await processServiceFor(ctx).createProcess(admin.id, {
      customerId: customer.id,
    });
    return { admin, cookie, customer, process };
  }

  async function conversation(processId: string, cookie: string) {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${processId}/conversation`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    return (
      response.json() as {
        messages: {
          isSystemEvent: boolean;
          direction: string;
          deliveryState: string;
          mailDeliveryId: string | null;
          subject: string | null;
        }[];
      }
    ).messages;
  }

  it('RA-14 versendete Transaktionsmail eines Vorgangs erscheint genau einmal als Systemereignis (sent)', async () => {
    const { cookie, customer, process } = await processWorld();
    const enqueued = await ctx.communication.outbox.enqueueAndSchedule({
      ...returnProtocolInput(),
      processId: process.id,
      customerId: customer.id,
    });
    await drain();
    expect((await row(enqueued.deliveryId)).status).toBe('sent');
    const messages = await conversation(process.id, cookie);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      isSystemEvent: true,
      direction: 'outbound',
      deliveryState: 'sent',
      mailDeliveryId: enqueued.deliveryId,
      subject: 'Rückgabeprotokoll – Vorgang MR-2026-0001',
    });
    // Listener-Wiederholung (Job-Retry) erzeugt kein zweites Ereignis.
    await processorWith(ctx.mailGateway).process(enqueued.deliveryId, { rerunListeners: true });
    const sent = (await row(enqueued.deliveryId)) as MailDeliveryRow;
    for (const listener of ctx.communication.mailSentListeners()) await listener.mailSent(sent);
    expect(await conversation(process.id, cookie)).toHaveLength(1);
  });

  it('RA-14b gescheiterte Mail erscheint als Ereignis mit Status failed; unklare bleibt queued', async () => {
    const { cookie, customer, process } = await processWorld();
    ctx.mailGateway.nextOutcomes(
      { outcome: 'permanent_error', code: 'SMTP_550' },
      { outcome: 'unknown', code: 'SMTP_ETIMEDOUT' },
    );
    const failed = await ctx.communication.outbox.enqueueAndSchedule({
      ...returnProtocolInput(),
      processId: process.id,
      customerId: customer.id,
    });
    await drain();
    const unknown = await ctx.communication.outbox.enqueueAndSchedule({
      ...returnProtocolInput(),
      processId: process.id,
      customerId: customer.id,
    });
    await drain();
    const messages = await conversation(process.id, cookie);
    const byDelivery = new Map(messages.map((m) => [m.mailDeliveryId, m]));
    expect(byDelivery.get(failed.deliveryId)).toMatchObject({
      isSystemEvent: true,
      deliveryState: 'failed',
    });
    expect(byDelivery.get(unknown.deliveryId)).toMatchObject({
      isSystemEvent: true,
      deliveryState: 'queued',
    });
  });

  it('RA-14c Staff-Antwort (manual_customer_reply) wird nicht zusätzlich als Systemereignis gespiegelt; Mails ohne Vorgang erzeugen kein Ereignis', async () => {
    const { admin, cookie, process } = await processWorld();
    const reply = await new ConversationService(ctx.db, ctx.storage).replyByEmail(
      ctx.communication.outbox,
      { processId: process.id, body: 'Hallo zurück', staffUserId: admin.id, appEnv: 'development' },
    );
    await ctx.communication.outbox.enqueueAndSchedule(returnProtocolInput());
    await drain();
    const messages = await conversation(process.id, cookie);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      isSystemEvent: false,
      deliveryState: 'sent',
      mailDeliveryId: reply.mailDeliveryId,
    });
    const events = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.isSystemEvent, true));
    expect(events).toHaveLength(0);
  });
});

describe('Härtung Review A – Demo-Resend (kein Fund)', () => {
  it('RA-13-K Resend einer DEMO_NOT_WHITELISTED-Zustellung bleibt blockiert; Staff-Antwort blockiert, [DEMO]-Betreff', async () => {
    const config = loadConfig({
      APP_ENV: 'demo',
      DATABASE_URL: ctx.config.databaseUrl,
      AUTH_SECRET_KEY: '2'.repeat(64),
      COMMUNICATION_PAYLOAD_KEY: 'd2'.repeat(32),
      STORAGE_DRIVER: 'fs',
      STORAGE_FS_ROOT: ctx.config.storage.driver === 'fs' ? ctx.config.storage.fsRoot : '/tmp/x',
      MAIL_ENABLED: 'true',
      MAIL_SMTP_HOST: 'smtp.demo.example',
      MAIL_SMTP_USER: 'u',
      MAIL_SMTP_PASSWORD: 'p',
      MAIL_FROM_ADDRESS: 'demo@miet-royal.test',
      MAIL_DEMO_WHITELIST: 'tester@miet-royal.test',
      MAIL_PUBLIC_WEB_BASE_URL: 'https://demo.miet-royal.test',
    });
    const gateway = new FakeMailGateway();
    const outbox = new MailOutboxService(
      ctx.db,
      config,
      new PayloadCrypto(config),
      gateway,
      ctx.queue,
    );
    const blocked = await outbox.enqueue({
      ...returnProtocolInput('ra13-k'),
      recipient: { email: 'echter.kunde@example.org', name: 'Echter Kunde' },
    });
    expect(blocked.status).toBe('blocked');
    const resent = await outbox.resend(blocked.deliveryId, null);
    expect(resent.status).toBe('blocked');
    expect((await row(resent.deliveryId)).blockedReason).toBe('DEMO_NOT_WHITELISTED');

    const { admin } = await adminSession(ctx);
    const customer = await createTestCustomer(ctx, admin.id, { email: 'echter.kunde@example.org' });
    const process = await processServiceFor(ctx).createProcess(admin.id, {
      customerId: customer.id,
    });
    const reply = await new ConversationService(ctx.db, ctx.storage).replyByEmail(outbox, {
      processId: process.id,
      body: 'Hallo aus der Demo',
      staffUserId: admin.id,
      appEnv: 'demo',
    });
    expect(reply.deliveryState).toBe('blocked');
    expect((await row(reply.mailDeliveryId)).subject?.startsWith('[DEMO] ')).toBe(true);
    expect(gateway.attempts).toHaveLength(0);
  });
});
