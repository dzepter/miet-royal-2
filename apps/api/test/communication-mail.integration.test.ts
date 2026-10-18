/**
 * Phase 12 (mail) – Pflichttests OUTBOUND 1–16 (Order §42) plus Security-
 * Anteile (Production FakeMail blockiert, Statusroute ohne Secrets,
 * system.settings, Vorgangssichtbarkeit, Resend-Regeln, Anhänge transient).
 * Versand ausschließlich über den FakeMailGateway (nichts verlässt das System).
 */
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { ConfigError, loadConfig } from '@mietroyal/config';
import { integrationJobs, mailDeliveries, type MailDeliveryRow } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createCommunicationContext } from '../src/communication/context.ts';
import { createOutboundMailGateway, FakeMailGateway } from '../src/communication/mail/gateways.ts';
import { MailOutboxService, mailSendJobKey } from '../src/communication/mail/outbox.ts';
import { MailSendProcessor, type MailSendJobDeps } from '../src/communication/mail/send-job.ts';
import { PayloadCrypto } from '../src/communication/payload-crypto.ts';
import { MAIL_SEND_JOB_TYPE, MAIL_SIGNATURE } from '../src/communication/types.ts';
import {
  createTestContext,
  destroyTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import {
  createStaffWithPermissions,
  createTestCustomer,
  processServiceFor,
  truncateCrmTables,
} from './crm-helpers.ts';
import { adminSession } from './settlement-helpers.ts';

const PUBLIC_BASE = 'https://web.test.example';
const SMTP_PASSWORD = 'smtp-password-super-secret-XYZ';
const OFFER_TOKEN = 'offer-token-SECRET-abcdefghijklmnop1234';

let ctx: TestContext;
const logLines: string[] = [];
const logDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});
const logText = () => logLines.join('');

beforeAll(async () => {
  ctx = await createTestContext({
    logDestination,
    logLevel: 'trace',
    env: {
      MAIL_ENABLED: 'true',
      MAIL_SMTP_HOST: 'smtp.test.example',
      MAIL_SMTP_USER: 'mailer@miet-royal.test',
      MAIL_SMTP_PASSWORD: SMTP_PASSWORD,
      MAIL_FROM_NAME: 'Miet-Royal Mainz',
      MAIL_FROM_ADDRESS: 'noreply@miet-royal.test',
      MAIL_PUBLIC_WEB_BASE_URL: PUBLIC_BASE,
    },
  });
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await ctx.pool.query('TRUNCATE mail_deliveries, integration_jobs, documents CASCADE');
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  ctx.mailGateway.reset();
  logLines.length = 0;
});

async function world() {
  const { admin, cookie } = await adminSession(ctx);
  const customer = await createTestCustomer(ctx, admin.id, { email: 'kunde@example.org' });
  const process = await processServiceFor(ctx).createProcess(admin.id, { customerId: customer.id });
  return { admin, cookie, customer, process };
}

function offerInput(processId: string, customerId: string, key = `offer:${randomUUID()}`) {
  return {
    kind: 'offer' as const,
    processId,
    customerId,
    recipient: { email: 'Kunde@Example.org', name: 'Max Mustermann' },
    context: {
      salutation: 'Hallo Max,',
      processNumber: 'MR-2026-0001',
      eventDate: '2026-11-20',
      validUntil: '2026-11-01T10:00:00Z',
    },
    secrets: { offerToken: OFFER_TOKEN },
    idempotencyKey: key,
  };
}

async function row(id: string): Promise<MailDeliveryRow> {
  const rows = await ctx.db.select().from(mailDeliveries).where(eq(mailDeliveries.id, id));
  if (rows[0] === undefined) throw new Error('Zustellung fehlt');
  return rows[0];
}

/** Nur Mail-Jobs (andere Phase-12-Module reihen z. B. Push-Jobs beim Login ein). */
async function jobs() {
  return ctx.db.select().from(integrationJobs).where(eq(integrationJobs.type, MAIL_SEND_JOB_TYPE));
}

async function drain(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const outcome = await ctx.jobs.runOnce();
    if (outcome === 'idle') break;
  }
}

/** Alle Text-/JSON-Spalten nach einem Klartext durchsuchen (nur Test). */
async function tablesContaining(needle: string): Promise<string[]> {
  const columns = await ctx.pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type IN ('text', 'character varying', 'jsonb', 'json')`,
  );
  const hits: string[] = [];
  for (const column of columns.rows) {
    const result = await ctx.pool.query(
      `SELECT 1 FROM "${column.table_name}" WHERE "${column.column_name}"::text ILIKE $1 LIMIT 1`,
      [`%${needle}%`],
    );
    if (result.rowCount !== null && result.rowCount > 0)
      hits.push(`${column.table_name}.${column.column_name}`);
  }
  return hits;
}

function productionEnv(extra: Record<string, string> = {}) {
  return {
    APP_ENV: 'production',
    DATABASE_URL: ctx.config.databaseUrl,
    AUTH_SECRET_KEY: '1'.repeat(64),
    COMMUNICATION_PAYLOAD_KEY: 'c1'.repeat(32),
    STORAGE_DRIVER: 'fs',
    STORAGE_FS_ROOT: ctx.config.storage.driver === 'fs' ? ctx.config.storage.fsRoot : '/tmp/x',
    LOG_LEVEL: 'error',
    ...extra,
  };
}

describe('Konfiguration (Tests 1–2: Production SMTP, fail-closed)', () => {
  it('1. Production-SMTP-Konfiguration: nur vollständig + TLS; localhost/Whitelist/http-Basis-URL abgelehnt; ohne MAIL_* ⇒ disabled', () => {
    const off = loadConfig(productionEnv());
    expect(off.mail.enabled).toBe(false);
    expect(createOutboundMailGateway(off).kind).toBe('disabled');
    expect(() => loadConfig(productionEnv({ MAIL_ENABLED: 'true' }))).toThrow(ConfigError);
    expect(() =>
      loadConfig(
        productionEnv({
          MAIL_ENABLED: 'true',
          MAIL_SMTP_HOST: 'localhost',
          MAIL_SMTP_USER: 'u',
          MAIL_SMTP_PASSWORD: 'p',
          MAIL_FROM_ADDRESS: 'noreply@miet-royal.test',
        }),
      ),
    ).toThrow(/localhost/);
    expect(() => loadConfig(productionEnv({ MAIL_DEMO_WHITELIST: 'x@example.org' }))).toThrow(
      /nur demo/,
    );
    const full = loadConfig(
      productionEnv({
        MAIL_ENABLED: 'true',
        MAIL_SMTP_HOST: 'smtp.provider.example',
        MAIL_SMTP_PORT: '587',
        MAIL_SMTP_SECURE: 'false',
        MAIL_SMTP_USER: 'u',
        MAIL_SMTP_PASSWORD: 'p',
        MAIL_FROM_ADDRESS: 'noreply@miet-royal.test',
        MAIL_PUBLIC_WEB_BASE_URL: 'https://miet-royal.example',
      }),
    );
    expect(full.mail).toMatchObject({
      enabled: true,
      smtp: { host: 'smtp.provider.example', port: 587, tls: 'starttls' },
    });
    expect(createOutboundMailGateway(full).kind).toBe('smtp');
    expect(() =>
      loadConfig(
        productionEnv({
          MAIL_ENABLED: 'true',
          MAIL_SMTP_HOST: 'smtp.provider.example',
          MAIL_SMTP_USER: 'u',
          MAIL_SMTP_PASSWORD: 'p',
          MAIL_FROM_ADDRESS: 'a@b.de',
          MAIL_PUBLIC_WEB_BASE_URL: 'http://miet-royal.example',
        }),
      ),
    ).toThrow(/HTTPS/);
  });

  it('2. fail-closed: production ohne Mailadapter ⇒ Einreihen blockiert (MAIL_NOT_CONFIGURED), kein Job, nichts gesendet', async () => {
    const { process, customer } = await world();
    const config = loadConfig(productionEnv());
    const communication = createCommunicationContext(
      { ...config, auth: ctx.config.auth },
      ctx.db,
      ctx.queue,
      { storage: ctx.storage },
    );
    expect(communication.mailGateway.kind).toBe('disabled');
    const result = await communication.outbox.enqueueAndSchedule(
      offerInput(process.id, customer.id),
    );
    expect(result).toMatchObject({ status: 'blocked', deduplicated: false });
    expect(await row(result.deliveryId)).toMatchObject({
      status: 'blocked',
      blockedReason: 'MAIL_NOT_CONFIGURED',
    });
    expect(await jobs()).toHaveLength(0);
    expect(ctx.mailGateway.sent).toHaveLength(0);
  });

  it('185ff. Production FakeMail blockiert: buildApp und createCommunicationContext lehnen ein Fake-Gateway ab', async () => {
    const config = { ...loadConfig(productionEnv()), auth: ctx.config.auth };
    expect(() =>
      buildApp({
        config,
        pool: ctx.pool,
        mailGateway: new FakeMailGateway(),
        storage: ctx.storage,
        jobQueue: ctx.queue,
      }),
    ).toThrow(/production/);
    expect(() =>
      createCommunicationContext(config, ctx.db, ctx.queue, {
        gateway: new FakeMailGateway(),
        storage: ctx.storage,
      }),
    ).toThrow(/production/);
    // development/test: Fake erlaubt (so läuft dieser Kontext).
    expect(ctx.communication.mailGateway.kind).toBe('fake');
  });
});

describe('Outbox-Kern (Tests 3–9, 16)', () => {
  it('5./16. Stabile Message-ID beim Einreihen; Kontext ohne Secrets; Token in KEINER DB-Spalte im Klartext', async () => {
    const { process, customer } = await world();
    const result = await ctx.communication.outbox.enqueueAndSchedule(
      offerInput(process.id, customer.id),
    );
    expect(result.status).toBe('pending');
    expect(result.messageId).toBe(`<${result.deliveryId}@miet-royal.test>`);
    const stored = await row(result.deliveryId);
    expect(stored).toMatchObject({
      status: 'pending',
      kind: 'offer',
      templateKind: 'offer',
      // Härtung RA-8: Angebotsvorlage v2 (ohne „PDF im Anhang“).
      templateVersion: 2,
      recipientEmail: 'kunde@example.org',
      recipientName: 'Max Mustermann',
      messageId: result.messageId,
      subject: 'Dein Angebot von Miet-Royal – Vorgang MR-2026-0001',
    });
    expect(stored.secretPayloadCiphertext).toMatch(/^v2:[0-9a-f]{12}:/);
    expect(JSON.stringify(stored)).not.toContain(OFFER_TOKEN);
    expect(await tablesContaining(OFFER_TOKEN)).toEqual([]);
    expect(await tablesContaining(OFFER_TOKEN.slice(12))).toEqual([]);
    // Job mit stabilem Schlüssel.
    expect((await jobs()).map((j) => j.idempotencyKey)).toEqual([
      mailSendJobKey(result.deliveryId),
    ]);
  });

  it('6. Idempotenz: gleicher Schlüssel ⇒ dieselbe Zustellung (deduplicated), eine Zeile, ein Job, eine Mail', async () => {
    const { process, customer } = await world();
    const input = offerInput(process.id, customer.id, 'offer:version-1');
    const first = await ctx.communication.outbox.enqueueAndSchedule(input);
    const second = await ctx.communication.outbox.enqueueAndSchedule(input);
    expect(second).toEqual({
      deliveryId: first.deliveryId,
      status: 'pending',
      deduplicated: true,
      // Härtung RA-15: echter Status der vorhandenen Zeile.
      existingStatus: 'pending',
      messageId: first.messageId,
    });
    expect(await ctx.db.select().from(mailDeliveries)).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
    await drain();
    await ctx.communication.outbox.enqueueAndSchedule(input);
    await drain();
    expect(ctx.mailGateway.sent).toHaveLength(1);
    // Einreihen in einer Transaktion des Aufrufers (executor) funktioniert ebenso.
    const inTx = await ctx.db.transaction((tx) =>
      ctx.communication.outbox.enqueue({ ...input, idempotencyKey: 'offer:version-2' }, tx),
    );
    expect(inTx.status).toBe('pending');
  });

  it('7./11./12./13. Erfolg ⇒ sent, sentAt, Providercode, Secret-Payload gelöscht; Mail hat text+html, Signatur, Link, keine Bilder; Listener läuft', async () => {
    const { process, customer } = await world();
    const seen: string[] = [];
    ctx.communication.addMailSentListener({ mailSent: async (d) => void seen.push(d.id) });
    const result = await ctx.communication.outbox.enqueueAndSchedule(
      offerInput(process.id, customer.id),
    );
    await drain();
    const sent = await row(result.deliveryId);
    expect(sent).toMatchObject({
      status: 'sent',
      providerCode: 'SMTP_250',
      attempts: 1,
      lastErrorCode: null,
      secretPayloadCiphertext: null,
    });
    expect(sent.sentAt).not.toBeNull();
    expect(seen).toEqual([result.deliveryId]);
    const message = ctx.mailGateway.sent[0]!;
    expect(message.messageId).toBe(result.messageId);
    expect(message.to).toEqual({ email: 'kunde@example.org', name: 'Max Mustermann' });
    expect(message.from).toEqual({ email: 'noreply@miet-royal.test', name: 'Miet-Royal Mainz' });
    expect(message.replyTo).toBe('noreply@miet-royal.test');
    expect(message.text.length).toBeGreaterThan(50);
    expect(message.html).toMatch(/^<!DOCTYPE html>/);
    expect(message.text).toContain(MAIL_SIGNATURE);
    expect(message.html).toContain('Mit freundlichen Grüßen<br>Miet-Royal Mainz');
    expect(message.text).toContain(`${PUBLIC_BASE}/angebot/${OFFER_TOKEN}`);
    expect(message.html).toContain(`href="${PUBLIC_BASE}/angebot/${OFFER_TOKEN}"`);
    expect(message.html).not.toMatch(/<img|<script|url\(/i);
    for (const url of message.html.match(/https?:\/\/[^\s"'<>]+/g) ?? [])
      expect(url.startsWith(PUBLIC_BASE)).toBe(true);
    // Erneuter Job-Lauf (at-least-once) ist ein No-op: keine zweite Mail.
    await new MailSendProcessor(deps()).process(result.deliveryId);
    expect(ctx.mailGateway.sent).toHaveLength(1);
  });

  it('8. Transient ⇒ retry mit Outbox-Backoff und NEUEM Job-Key; danach Erfolg mit DERSELBEN Message-ID; 8. Versuch ⇒ failed', async () => {
    const { process, customer } = await world();
    ctx.mailGateway.nextOutcomes({ outcome: 'transient_error', code: 'SMTP_421' });
    const result = await ctx.communication.outbox.enqueueAndSchedule(
      offerInput(process.id, customer.id),
    );
    const before = Date.now();
    await drain();
    const retry = await row(result.deliveryId);
    expect(retry).toMatchObject({
      status: 'retry',
      attempts: 1,
      lastErrorCode: 'SMTP_421',
      sentAt: null,
    });
    expect(retry.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(before + 60_000 - 1000);
    expect(retry.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60_000 + 1000);
    const retryJob = (await jobs()).find(
      (j) => j.idempotencyKey === mailSendJobKey(result.deliveryId, 1),
    );
    expect(retryJob).toBeDefined();
    expect(retryJob!.runAt.toISOString()).toBe(retry.nextAttemptAt!.toISOString());
    // Noch nicht fällig: nichts passiert.
    await drain();
    expect(await row(result.deliveryId)).toMatchObject({ status: 'retry', attempts: 1 });
    expect(ctx.mailGateway.attempts).toHaveLength(1);
    // Fällig machen ⇒ zweiter Versuch mit derselben Message-ID.
    await ctx.pool.query(`UPDATE integration_jobs SET run_at = now() WHERE idempotency_key = $1`, [
      mailSendJobKey(result.deliveryId, 1),
    ]);
    await ctx.pool.query(`UPDATE mail_deliveries SET next_attempt_at = now() WHERE id = $1`, [
      result.deliveryId,
    ]);
    await drain();
    expect(await row(result.deliveryId)).toMatchObject({
      status: 'sent',
      attempts: 2,
      messageId: result.messageId,
    });
    expect(ctx.mailGateway.attempts.map((m) => m.messageId)).toEqual([
      result.messageId,
      result.messageId,
    ]);
    // Erschöpfte Versuche ⇒ failed (kein weiterer Job).
    const second = await ctx.communication.outbox.enqueueAndSchedule(
      offerInput(process.id, customer.id),
    );
    await ctx.pool.query(`UPDATE mail_deliveries SET attempts = 7 WHERE id = $1`, [
      second.deliveryId,
    ]);
    ctx.mailGateway.nextOutcomes({ outcome: 'transient_error' });
    const jobsBefore = (await jobs()).length;
    await drain();
    expect(await row(second.deliveryId)).toMatchObject({ status: 'failed', attempts: 8 });
    expect((await jobs()).length).toBe(jobsBefore);
  });

  it('9. Permanent ⇒ failed (neutraler Code), Fehler-Listener informiert, kein Retry-Job', async () => {
    const { process, customer } = await world();
    const failed: string[] = [];
    ctx.communication.addMailFailedListener({
      mailFailed: async (d, r) => void failed.push(`${d.id}:${r.status}:${r.errorCode}`),
    });
    ctx.mailGateway.nextOutcomes({ outcome: 'permanent_error', code: 'SMTP_550' });
    const result = await ctx.communication.outbox.enqueueAndSchedule(
      offerInput(process.id, customer.id),
    );
    await drain();
    expect(await row(result.deliveryId)).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastErrorCode: 'SMTP_550',
    });
    expect(failed).toEqual([`${result.deliveryId}:failed:SMTP_550`]);
    expect(await jobs()).toHaveLength(1);
  });

  it('10. Unbekanntes Ergebnis ⇒ outcome_unknown, KEIN automatischer Retry; manueller Resend ⇒ neue Zustellung mit NEUER Message-ID', async () => {
    const { process, customer, cookie } = await world();
    ctx.mailGateway.nextOutcomes({ outcome: 'unknown', code: 'SMTP_ETIMEDOUT' });
    const result = await ctx.communication.outbox.enqueueAndSchedule(
      offerInput(process.id, customer.id, 'offer:unknown'),
    );
    await drain();
    expect(await row(result.deliveryId)).toMatchObject({
      status: 'outcome_unknown',
      lastErrorCode: 'SMTP_ETIMEDOUT',
    });
    expect(await jobs()).toHaveLength(1);
    // Gateway-Ausnahme zählt ebenfalls als unbekannt.
    ctx.mailGateway.nextOutcomes({ outcome: 'throw' });
    const crashed = await ctx.communication.outbox.enqueueAndSchedule(
      offerInput(process.id, customer.id),
    );
    await drain();
    expect(await row(crashed.deliveryId)).toMatchObject({
      status: 'outcome_unknown',
      lastErrorCode: 'GATEWAY_EXCEPTION',
    });
    const resend = await ctx.app.inject({
      method: 'POST',
      url: `/staff/communication/deliveries/${result.deliveryId}/resend`,
      headers: { cookie },
    });
    expect(resend.statusCode).toBe(200);
    const body = resend.json() as { deliveryId: string; messageId: string; status: string };
    expect(body.deliveryId).not.toBe(result.deliveryId);
    expect(body.messageId).not.toBe(result.messageId);
    expect(body.status).toBe('pending');
    const copy = await row(body.deliveryId);
    expect(copy).toMatchObject({
      kind: 'offer',
      recipientEmail: 'kunde@example.org',
      // Härtung RA-3: deterministischer Resend-Schlüssel je QUELLE (zweiter Resend ⇒ 409).
      idempotencyKey: `offer:unknown:resend:${result.deliveryId}`,
    });
    expect(copy.secretPayloadCiphertext).not.toBe(
      (await row(result.deliveryId)).secretPayloadCiphertext,
    );
    await drain();
    expect(await row(body.deliveryId)).toMatchObject({ status: 'sent' });
    expect(ctx.mailGateway.sent[0]!.text).toContain(OFFER_TOKEN);
    // Alte Zustellung bleibt unverändert.
    expect(await row(result.deliveryId)).toMatchObject({
      status: 'outcome_unknown',
      messageId: result.messageId,
    });
    // Resend nur für failed/outcome_unknown/konfigurationsbedingte Blockaden.
    const pending = await ctx.communication.outbox.enqueue(offerInput(process.id, customer.id));
    for (const id of [pending.deliveryId, body.deliveryId]) {
      const denied = await ctx.app.inject({
        method: 'POST',
        url: `/staff/communication/deliveries/${id}/resend`,
        headers: { cookie },
      });
      expect(denied.statusCode).toBe(409);
    }
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: `/staff/communication/deliveries/${randomUUID()}/resend`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('3./4. Secrets erscheinen weder in API-Antworten noch im Log (trace); SMTP-Passwort nirgends', async () => {
    const { process, customer, cookie } = await world();
    const result = await ctx.communication.outbox.enqueueAndSchedule(
      offerInput(process.id, customer.id),
    );
    await drain();
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/staff/communication/deliveries',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain(result.deliveryId);
    expect(list.body).not.toContain(OFFER_TOKEN);
    expect(list.body).not.toMatch(/secretPayload|ciphertext|"context"|"html"|"text"/);
    const status = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${process.id}/communication-status`,
      headers: { cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.body).not.toContain(OFFER_TOKEN);
    expect(status.json()).toMatchObject({
      mailConfigured: true,
      deliveries: [
        { kind: 'offer', status: 'sent', statusLabel: 'E-Mail gesendet', kindLabel: 'Angebot' },
      ],
    });
    const admin = await ctx.app.inject({
      method: 'GET',
      url: '/staff/communication/status',
      headers: { cookie },
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.body).not.toContain(SMTP_PASSWORD);
    expect(admin.json()).toMatchObject({
      mail: {
        enabled: true,
        gateway: 'fake',
        smtpHost: 'smtp.test.example',
        smtpPort: 465,
        smtpTls: 'implicit',
        fromAddress: 'noreply@miet-royal.test',
      },
    });
    const log = logText();
    expect(log.length).toBeGreaterThan(0);
    expect(log).not.toContain(OFFER_TOKEN);
    expect(log).not.toContain(SMTP_PASSWORD);
    expect(log).not.toContain(ctx.config.communication.payloadKey);
    expect(log).not.toContain('Angebot online ansehen');
    // Eine geloggte Config würde redigiert.
    ctx.app.log.info({ config: ctx.config, mail: ctx.config.mail }, 'config dump');
    expect(logText()).toContain('config dump');
    expect(logText()).not.toContain(SMTP_PASSWORD);
    expect(logText()).not.toContain(ctx.config.communication.payloadKey);
  });
});

function deps(overrides: Partial<MailSendJobDeps> = {}): MailSendJobDeps {
  const c = ctx.communication;
  return {
    db: ctx.db,
    config: ctx.config,
    crypto: c.crypto,
    gateway: ctx.mailGateway,
    queue: ctx.queue,
    documents: c.documents,
    invoiceFiles: c.invoiceFileFetcher,
    sentListeners: c.mailSentListeners,
    failedListeners: c.mailFailedListeners,
    ...overrides,
  };
}

describe('Demo (Tests 14–15: [DEMO], Whitelist)', () => {
  function demoOutbox(whitelist: string) {
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
      MAIL_DEMO_WHITELIST: whitelist,
      MAIL_PUBLIC_WEB_BASE_URL: 'https://demo.miet-royal.test',
    });
    const gateway = new FakeMailGateway();
    const crypto = new PayloadCrypto(config);
    const outbox = new MailOutboxService(ctx.db, config, crypto, gateway, ctx.queue);
    const processor = new MailSendProcessor(deps({ config, crypto, gateway }));
    return { config, gateway, outbox, processor };
  }

  it('14. Demo: JEDE Mail trägt „[DEMO] “ im Betreff (Outbox-Zeile und Versand)', async () => {
    const { process, customer } = await world();
    const demo = demoOutbox('@example.org');
    const result = await demo.outbox.enqueueAndSchedule(offerInput(process.id, customer.id));
    expect(result.status).toBe('pending');
    expect((await row(result.deliveryId)).subject).toMatch(/^\[DEMO\] /);
    await demo.processor.process(result.deliveryId);
    expect(demo.gateway.sent[0]!.subject).toMatch(/^\[DEMO\] Dein Angebot/);
    expect(demo.gateway.sent[0]!.html).toContain('[DEMO]');
  });

  it('15. Demo-Whitelist: nicht freigegebene Empfänger werden blockiert (kein Job, keine Mail); Vollmatch und @domain erlaubt', async () => {
    const { process, customer } = await world();
    const demo = demoOutbox('tester@miet-royal.test,@example.org');
    const blocked = await demo.outbox.enqueueAndSchedule({
      ...offerInput(process.id, customer.id),
      recipient: { email: 'echter.kunde@kunde-domain.de' },
    });
    expect(blocked.status).toBe('blocked');
    expect(await row(blocked.deliveryId)).toMatchObject({
      status: 'blocked',
      blockedReason: 'DEMO_NOT_WHITELISTED',
    });
    expect(await jobs()).toHaveLength(0);
    // Ein Job-Lauf auf einer blockierten Zeile ist ein No-op.
    expect(await demo.processor.process(blocked.deliveryId)).toEqual({
      outcome: 'noop',
      status: 'blocked',
    });
    expect(demo.gateway.attempts).toHaveLength(0);
    const ok = await demo.outbox.enqueueAndSchedule({
      ...offerInput(process.id, customer.id),
      recipient: { email: 'Tester@Miet-Royal.test' },
    });
    expect(ok.status).toBe('pending');
    const domain = await demo.outbox.enqueueAndSchedule({
      ...offerInput(process.id, customer.id),
      recipient: { email: 'irgendwer@example.org' },
    });
    expect(domain.status).toBe('pending');
    // Keine Blockade außerhalb von demo (development-Kontext mit Fake).
    const dev = await ctx.communication.outbox.enqueue({
      ...offerInput(process.id, customer.id),
      recipient: { email: 'echter.kunde@kunde-domain.de' },
    });
    expect(dev.status).toBe('pending');
  });
});

describe('Härtung: Claims, Secrets, Empfänger, Anhänge', () => {
  it('kein/ungültiger Empfänger ⇒ blocked NO_RECIPIENT/INVALID_RECIPIENT; CRLF im Namen wird bereinigt', async () => {
    const { process, customer } = await world();
    const none = await ctx.communication.outbox.enqueue({
      ...offerInput(process.id, customer.id),
      recipient: { email: '  ' },
    });
    expect(await row(none.deliveryId)).toMatchObject({
      status: 'blocked',
      blockedReason: 'NO_RECIPIENT',
    });
    const invalid = await ctx.communication.outbox.enqueue({
      ...offerInput(process.id, customer.id),
      recipient: { email: 'a@b.de, c@d.de' },
    });
    expect(await row(invalid.deliveryId)).toMatchObject({
      status: 'blocked',
      blockedReason: 'INVALID_RECIPIENT',
    });
    const crlf = await ctx.communication.outbox.enqueue({
      ...offerInput(process.id, customer.id),
      recipient: { email: 'kunde@example.org', name: 'Max\r\nBcc: evil@example.org' },
    });
    expect((await row(crlf.deliveryId)).recipientName).toBe('Max Bcc: evil@example.org');
  });

  it('Secret-Payload nicht entschlüsselbar ⇒ blocked SECRET_UNDECRYPTABLE (Zeile bleibt, kein Versand)', async () => {
    const { process, customer } = await world();
    const result = await ctx.communication.outbox.enqueueAndSchedule(
      offerInput(process.id, customer.id),
    );
    const foreign = new PayloadCrypto({
      ...ctx.config,
      communication: { payloadKey: 'x'.repeat(40), payloadKeyPrevious: null },
    });
    await ctx.db
      .update(mailDeliveries)
      .set({
        secretPayloadCiphertext: foreign.encrypt(
          '{"offerToken":"x"}',
          'mail-secret-payload',
          result.deliveryId,
        ),
      })
      .where(eq(mailDeliveries.id, result.deliveryId));
    await drain();
    expect(await row(result.deliveryId)).toMatchObject({
      status: 'blocked',
      blockedReason: 'SECRET_UNDECRYPTABLE',
    });
    expect(ctx.mailGateway.attempts).toHaveLength(0);
  });

  // Phase 12 Härtung (RA-2): eine seit > 15 min hängende `sending`-Zeile wird nicht
  // erneut versendet (Absturz nach SMTP-Annahme möglich), sondern outcome_unknown.
  it('Claim: `sending` < 15 min ⇒ No-op; > 15 min ⇒ outcome_unknown (SENDING_STALE) ohne erneuten Versand; danach No-op', async () => {
    const { process, customer } = await world();
    const result = await ctx.communication.outbox.enqueue(offerInput(process.id, customer.id));
    const processor = new MailSendProcessor(deps());
    await ctx.db
      .update(mailDeliveries)
      .set({ status: 'sending', sendingSince: new Date() })
      .where(eq(mailDeliveries.id, result.deliveryId));
    expect(await processor.process(result.deliveryId)).toEqual({
      outcome: 'noop',
      status: 'sending',
    });
    await ctx.db
      .update(mailDeliveries)
      .set({ sendingSince: new Date(Date.now() - 20 * 60 * 1000) })
      .where(eq(mailDeliveries.id, result.deliveryId));
    expect(await processor.process(result.deliveryId)).toEqual({
      outcome: 'outcome_unknown',
      errorCode: 'SENDING_STALE',
    });
    expect(await processor.process(result.deliveryId)).toEqual({
      outcome: 'noop',
      status: 'outcome_unknown',
    });
    expect(ctx.mailGateway.attempts).toHaveLength(0);
  });

  it('Anhänge: Dokument aus dem Speicher (SHA-256 geprüft), Lexware-Rechnung transient über InvoiceFileFetcher – nichts wird persistiert', async () => {
    const { process, customer } = await world();
    const pdf = Buffer.from('%PDF-1.4 test');
    const document = await ctx.communication.documents.createFinalDocument({
      type: 'offer',
      processId: process.id,
      storageKey: `offers/${randomUUID()}.pdf`,
      bytes: pdf,
    });
    const invoiceBytes = new Uint8Array(Buffer.from('%PDF-1.4 invoice'));
    const fetched: string[] = [];
    ctx.communication.setInvoiceFileFetcher({
      fetch: async (id) => {
        fetched.push(id);
        return invoiceBytes;
      },
    });
    try {
      const result = await ctx.communication.outbox.enqueueAndSchedule({
        ...offerInput(process.id, customer.id),
        kind: 'invoice_delivery',
        context: { processNumber: 'MR-2026-0001', invoiceNumber: 'RE-1' },
        secrets: {},
        attachments: [
          { kind: 'document', documentId: document.id, filename: 'Angebot.pdf' },
          {
            kind: 'lexware_invoice',
            lexwareInvoiceId: 'lex-invoice-1',
            filename: 'Rechnung-RE-1.pdf',
          },
        ],
      });
      await drain();
      expect(await row(result.deliveryId)).toMatchObject({ status: 'sent' });
      const message = ctx.mailGateway.sent[0]!;
      expect(message.attachments.map((a) => a.filename)).toEqual([
        'Angebot.pdf',
        'Rechnung-RE-1.pdf',
      ]);
      expect(Buffer.from(message.attachments[0]!.content).equals(pdf)).toBe(true);
      expect(Buffer.from(message.attachments[1]!.content).equals(Buffer.from(invoiceBytes))).toBe(
        true,
      );
      expect(fetched).toEqual(['lex-invoice-1']);
      // Rechnung nie im Dokumentenspeicher/DB.
      expect(
        await ctx.pool.query(
          `SELECT 1 FROM documents WHERE storage_key ILIKE '%invoice%' OR storage_key ILIKE '%rechnung%'`,
        ),
      ).toMatchObject({ rowCount: 0 });
      expect(await tablesContaining('lex-invoice-1')).toEqual(['mail_deliveries.attachments']);
      // Ohne Rechnungsabruf: retry (transient), nicht blocked/failed.
      ctx.communication.setInvoiceFileFetcher(null);
      const second = await ctx.communication.outbox.enqueueAndSchedule({
        ...offerInput(process.id, customer.id),
        kind: 'invoice_delivery',
        context: { processNumber: 'MR-2026-0001', invoiceNumber: 'RE-2' },
        secrets: {},
        attachments: [
          { kind: 'lexware_invoice', lexwareInvoiceId: 'lex-invoice-2', filename: 'Rechnung.pdf' },
        ],
      });
      await drain();
      expect(await row(second.deliveryId)).toMatchObject({
        status: 'retry',
        lastErrorCode: 'ATTACHMENT_UNAVAILABLE',
      });
    } finally {
      ctx.communication.setInvoiceFileFetcher(null);
    }
  });
});

describe('Rechte und Sichtbarkeit (SECURITY: Settings Permission, IDOR)', () => {
  it('Admin-Routen nur mit system.settings; mail/check liefert nur ok/code; Vorgangsstatus nur mit process.view_all und sichtbarem Vorgang', async () => {
    const { admin, cookie, process } = await world();
    const staff = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Nina',
      lastName: 'Normal',
      email: 'nina@test.example',
      password: 'nina-passwort-123',
      permissionKeys: ['process.view_all'],
    });
    for (const [method, url] of [
      ['GET', '/staff/communication/status'],
      ['POST', '/staff/communication/mail/check'],
      ['GET', '/staff/communication/deliveries'],
      ['POST', `/staff/communication/deliveries/${randomUUID()}/resend`],
    ] as const) {
      expect(
        (await ctx.app.inject({ method, url, headers: { cookie: staff.cookie } })).statusCode,
        url,
      ).toBe(403);
      expect((await ctx.app.inject({ method, url })).statusCode, url).toBe(401);
    }
    const check = await ctx.app.inject({
      method: 'POST',
      url: '/staff/communication/mail/check',
      headers: { cookie },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toEqual({ ok: true, code: null, gateway: 'fake' });
    ctx.mailGateway.verifyResult = { ok: false, code: 'SMTP_535' };
    expect(
      (
        await ctx.app.inject({
          method: 'POST',
          url: '/staff/communication/mail/check',
          headers: { cookie },
        })
      ).json(),
    ).toEqual({ ok: false, code: 'SMTP_535', gateway: 'fake' });
    // Vorgangsstatus: sichtbarer Vorgang 200, fremde/unbekannte ID neutral 404, ohne Recht 403.
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/staff/processes/${process.id}/communication-status`,
          headers: { cookie: staff.cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/staff/processes/${randomUUID()}/communication-status`,
          headers: { cookie: staff.cookie },
        })
      ).statusCode,
    ).toBe(404);
    const noRights = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Ole',
      lastName: 'Ohne',
      email: 'ole@test.example',
      password: 'ole-passwort-123',
      permissionKeys: [],
    });
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: `/staff/processes/${process.id}/communication-status`,
          headers: { cookie: noRights.cookie },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('Statusroute mit Push/IMAP konfiguriert: öffentlicher VAPID-Key ja, privater Key und IMAP-Passwort nie', async () => {
    const { cookie } = await world();
    const config = loadConfig({
      APP_ENV: 'development',
      DATABASE_URL: ctx.config.databaseUrl,
      LOG_LEVEL: 'info',
      MAIL_IMAP_ENABLED: 'true',
      MAIL_IMAP_HOST: 'imap.test.example',
      MAIL_IMAP_USER: 'imap-user',
      MAIL_IMAP_PASSWORD: 'imap-password-SECRET-123',
      PUSH_VAPID_PUBLIC_KEY: 'vapid-public-key-test',
      PUSH_VAPID_PRIVATE_KEY: 'vapid-private-key-SECRET-456',
      PUSH_VAPID_SUBJECT: 'mailto:admin@miet-royal.test',
    });
    const app = buildApp({
      config,
      pool: ctx.pool,
      mailAdapter: ctx.mail,
      rateLimitEnabled: false,
      storage: ctx.storage,
      jobQueue: ctx.queue,
      mailGateway: new FakeMailGateway(),
      logDestination,
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/staff/communication/status',
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        mail: { enabled: false, gateway: 'fake' },
        imap: { configured: true, host: 'imap.test.example', folder: 'INBOX', lastPollAt: null },
        whatsapp: {
          mode: 'mock',
          label: 'DEMO / simuliert',
          eventsLast24h: 0,
          contactsWithOpenWindow: 0,
        },
        push: { enabled: true, vapidPublicKey: 'vapid-public-key-test', activeDevices: 0 },
      });
      expect(response.body).not.toContain('imap-password-SECRET-123');
      expect(response.body).not.toContain('vapid-private-key-SECRET-456');
      expect(response.body).not.toContain('imap-user');
      app.log.info({ config }, 'config dump 2');
      expect(logText()).toContain('config dump 2');
      expect(logText()).not.toContain('imap-password-SECRET-123');
      expect(logText()).not.toContain('vapid-private-key-SECRET-456');
    } finally {
      await app.close();
    }
  });
});
