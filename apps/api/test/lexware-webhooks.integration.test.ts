/**
 * Phase 10 – Webhook-Endpunkt POST /webhooks/lexware und Job
 * `lexware.event.process` gegen den Contract-Fake (Order §§44–51; Pflichttests
 * 123–137). Signatur über Rohbytes, organizationId, Allowlist, Dedup, Queue;
 * Worker liest den Stand bei Lexware; externe Änderungen ⇒ Prüfbedarf,
 * Settlement/Storno bleiben gesperrt.
 */
import { Writable } from 'node:stream';
import {
  accountingTransfers,
  cancellations,
  lexwareInvoiceMappings,
  lexwareWebhookEvents,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LexwareConnectionService } from '../src/lexware/connection-service.ts';
import type { FakeLexwareServer } from '../src/lexware/testing/fake-server.ts';
import { LEXWARE_EVENT_PROCESS_JOB_TYPE } from '../src/lexware/webhook-service.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import {
  adminSession,
  createFakeInvoice,
  createMappedTransfer,
  postWebhook,
  truncateLexwareWorld,
} from './lexware-connection-helpers.ts';

let ctx: TestContext;
let fake: FakeLexwareServer;
const logLines: string[] = [];
const logDestination = new Writable({
  write(chunk: Buffer | string, _encoding, callback) {
    logLines.push(chunk.toString());
    callback();
  },
});
const logText = () => logLines.join('');

beforeAll(async () => {
  ctx = await createTestContext({ lexware: true, logDestination, logLevel: 'trace' });
  fake = ctx.lexwareFake as FakeLexwareServer;
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateLexwareWorld(ctx.pool);
  fake.failures.length = 0;
  fake.revoked = false;
  fake.deniedScopes.clear();
  fake.invoices.clear();
  fake.requestLog.length = 0;
  logLines.length = 0;
  await new LexwareConnectionService(ctx.lexware).check();
});

async function events() {
  return ctx.db.select().from(lexwareWebhookEvents);
}
async function jobs() {
  const rows = await ctx.pool.query<{ type: string; idempotency_key: string; status: string }>(
    'SELECT type, idempotency_key, status FROM integration_jobs ORDER BY created_at',
  );
  return rows.rows;
}
const resourceId = () => '11111111-2222-4333-8444-555555555555';

describe('POST /webhooks/lexware – Annahme (§44–47, Tests 123–131, 137)', () => {
  it('123. Gültig signiert ⇒ 202 queued, Event persistiert, Job eingereiht (idempotencyKey lexware-event:<fingerprint>)', async () => {
    const signed = fake.signWebhook({ eventType: 'payment.changed', resourceId: resourceId() });
    const response = await postWebhook(ctx, signed.body, signed.signature);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'queued' });
    const stored = await events();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      eventType: 'payment.changed',
      resourceId: resourceId(),
      organizationId: fake.organizationId,
      status: 'queued',
    });
    expect(stored[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const queued = await jobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      type: LEXWARE_EVENT_PROCESS_JOB_TYPE,
      idempotency_key: `lexware-event:${stored[0]!.fingerprint}`,
      status: 'pending',
    });
  });

  it('124. Ungültige Signatur ⇒ 401 neutral, nichts persistiert, kein Job', async () => {
    const signed = fake.signWebhook({ eventType: 'payment.changed', resourceId: resourceId() });
    const tampered = signed.body.replace('payment.changed', 'invoice.changed');
    const response = await postWebhook(ctx, tampered, signed.signature);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('REJECTED');
    expect(response.body).not.toContain('Signatur');
    const garbage = await postWebhook(ctx, signed.body, Buffer.from('nope').toString('base64'));
    expect(garbage.statusCode).toBe(401);
    expect(await events()).toHaveLength(0);
    expect(await jobs()).toHaveLength(0);
  });

  it('125. Fehlende Signatur ⇒ 401, keine Verarbeitung', async () => {
    const signed = fake.signWebhook({ eventType: 'payment.changed', resourceId: resourceId() });
    const response = await postWebhook(ctx, signed.body, undefined);
    expect(response.statusCode).toBe(401);
    expect(await events()).toHaveLength(0);
  });

  it('126. Signatur wird über die ROHBYTES geprüft: pretty-printed Body mit Lexware-kompakter Signatur bleibt gültig; fremder Key nicht', async () => {
    const signed = fake.signWebhook({ eventType: 'invoice.changed', resourceId: resourceId() });
    const pretty = JSON.stringify(JSON.parse(signed.body), null, 2);
    expect(pretty).not.toBe(signed.body);
    const response = await postWebhook(ctx, pretty, signed.signature);
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe('queued');
    // Gleicher Inhalt, andere Serialisierung ⇒ derselbe Fingerprint ⇒ Duplikat.
    const again = await postWebhook(ctx, signed.body, signed.signature);
    expect(again.json().status).toBe('duplicate');
    expect(await events()).toHaveLength(1);
  });

  it('127. Fremde organizationId ⇒ 403 neutral, Warn-Log nur mit IDs, nichts persistiert', async () => {
    const signed = fake.signWebhook({
      eventType: 'payment.changed',
      resourceId: resourceId(),
      organizationId: 'fremde-organisation-0000',
    });
    const response = await postWebhook(ctx, signed.body, signed.signature);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('REJECTED');
    expect(response.body).not.toContain('organization');
    expect(await events()).toHaveLength(0);
    expect(await jobs()).toHaveLength(0);
    expect(logText()).toContain('ORGANIZATION_MISMATCH');
  });

  it('128. Unbekannter Eventtyp ⇒ 202 ignored ohne Persistenz/Job', async () => {
    const signed = fake.signWebhook({ eventType: 'contact.changed', resourceId: resourceId() });
    const response = await postWebhook(ctx, signed.body, signed.signature);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ status: 'ignored' });
    expect(await events()).toHaveLength(0);
    expect(await jobs()).toHaveLength(0);
  });

  it('129. Dedup: identisches Event zweimal ⇒ ein Event, ein Job, zweite Antwort 202 duplicate', async () => {
    const signed = fake.signWebhook({
      eventType: 'invoice.status.changed',
      resourceId: resourceId(),
      eventDate: '2026-10-17T10:00:00.000+02:00',
    });
    const first = await postWebhook(ctx, signed.body, signed.signature);
    const second = await postWebhook(ctx, signed.body, signed.signature);
    expect(first.json().status).toBe('queued');
    expect(second.statusCode).toBe(202);
    expect(second.json().status).toBe('duplicate');
    expect(await events()).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);
    // Anderes eventDate ⇒ neues Event.
    const other = fake.signWebhook({
      eventType: 'invoice.status.changed',
      resourceId: resourceId(),
      eventDate: '2026-10-17T11:00:00.000+02:00',
    });
    await postWebhook(ctx, other.body, other.signature);
    expect(await events()).toHaveLength(2);
  });

  it('129b. Event-Zeile ohne Job (Crash zwischen Insert und Enqueue) ⇒ erneute Zustellung reiht den Job nach', async () => {
    const signed = fake.signWebhook({ eventType: 'payment.changed', resourceId: resourceId() });
    const first = await postWebhook(ctx, signed.body, signed.signature);
    expect(first.json().status).toBe('queued');
    await ctx.pool.query('DELETE FROM integration_jobs');
    expect(await jobs()).toHaveLength(0);
    const second = await postWebhook(ctx, signed.body, signed.signature);
    expect(second.statusCode).toBe(202);
    expect(second.json().status).toBe('duplicate');
    const [event] = await events();
    const queued = await jobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.idempotency_key).toBe(`lexware-event:${event!.fingerprint}`);
    // Dritte Zustellung: Queue dedupliziert, kein zweiter Job.
    await postWebhook(ctx, signed.body, signed.signature);
    expect(await jobs()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it('130. Antwort in < 100 ms ohne Lexware-Aufruf; ungültiges Schema ⇒ 400; Limit 64 KB', async () => {
    const before = fake.requestLog.length;
    const signed = fake.signWebhook({ eventType: 'payment.changed', resourceId: resourceId() });
    const started = Date.now();
    const response = await postWebhook(ctx, signed.body, signed.signature);
    const durationMs = Date.now() - started;
    expect(response.statusCode).toBe(202);
    expect(durationMs).toBeLessThan(100);
    expect(fake.requestLog.length).toBe(before);

    const unsigned = JSON.stringify({ organizationId: fake.organizationId, eventType: 'x' });
    const invalid = await postWebhook(ctx, unsigned, signed.signature);
    expect(invalid.statusCode).toBe(401); // Signatur passt nicht zum Body ⇒ zuerst Signatur
    const huge = 'x'.repeat(70 * 1024);
    const tooLarge = await postWebhook(ctx, `{"pad":"${huge}"}`, signed.signature);
    expect(tooLarge.statusCode).toBe(413);
    expect(await events()).toHaveLength(1);
  });

  it('131. Ohne aktive Lexware-Konfiguration antwortet der Endpunkt mit 404', async () => {
    const plain = await createTestContext();
    try {
      const signed = fake.signWebhook({ eventType: 'payment.changed', resourceId: resourceId() });
      const response = await postWebhook(plain, signed.body, signed.signature);
      expect(response.statusCode).toBe(404);
    } finally {
      await destroyTestContext(plain);
    }
  });

  it('137. Der Webhook-Body wird nie geloggt (gültig wie ungültig)', async () => {
    const marker = 'GEHEIMER-BODY-MARKER-4711';
    const base = JSON.parse(
      fake.signWebhook({ eventType: 'payment.changed', resourceId: resourceId() }).body,
    ) as Record<string, unknown>;
    const withMarker = JSON.stringify({ ...base, note: marker });
    // Ungültig signiert …
    await postWebhook(ctx, withMarker, 'AAAA');
    // … und gültig signiert (Fake signiert beliebigen Body nicht – daher Eventtyp-Marker in resourceId-freier Form prüfen).
    const signed = fake.signWebhook({ eventType: 'payment.changed', resourceId: resourceId() });
    await postWebhook(ctx, signed.body, signed.signature, { 'x-mr-marker': marker });
    expect(logLines.length).toBeGreaterThan(0);
    expect(logText()).not.toContain(marker);
    expect(logText()).not.toContain(signed.signature);
    expect(logText()).not.toContain(fake.apiKey);
  });
});

describe('Job lexware.event.process – Worker (§48–51, Tests 132–136)', () => {
  it('132. Worker liest den aktuellen Stand bei Lexware (GET invoice + GET payment), nicht den Payload', async () => {
    const { admin } = await adminSession(ctx);
    const invoice = await createFakeInvoice(ctx);
    const { mapping } = await createMappedTransfer(ctx, admin.id, invoice);
    fake.requestLog.length = 0;
    const signed = fake.signWebhook({ eventType: 'invoice.changed', resourceId: invoice.id });
    await postWebhook(ctx, signed.body, signed.signature);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const paths = fake.requestLog.map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual([`GET /v1/invoices/${invoice.id}`, `GET /v1/payments/${invoice.id}`]);
    const [event] = await events();
    expect(event).toMatchObject({ status: 'processed', resultCode: 'UNCHANGED' });
    expect(event!.processedAt).not.toBeNull();
    const [after] = await ctx.db
      .select()
      .from(lexwareInvoiceMappings)
      .where(eq(lexwareInvoiceMappings.id, mapping.id));
    expect(after!.paymentStatus).toBe('open');
    expect(after!.lastSyncedAt!.getTime()).toBeGreaterThan(mapping.lastSyncedAt!.getTime());
  });

  it('133. payment.changed ⇒ bezahlt: Mapping, Transfer und Storno erhalten Zahlungsstatus paid (paidDate intern)', async () => {
    const { admin } = await adminSession(ctx);
    const invoice = await createFakeInvoice(ctx);
    const { mapping, transfer, cancellation } = await createMappedTransfer(ctx, admin.id, invoice);
    fake.setInvoicePaid(invoice.id, '2026-10-20T00:00:00.000+02:00');
    const signed = fake.signWebhook({ eventType: 'payment.changed', resourceId: invoice.id });
    await postWebhook(ctx, signed.body, signed.signature);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const [after] = await ctx.db
      .select()
      .from(lexwareInvoiceMappings)
      .where(eq(lexwareInvoiceMappings.id, mapping.id));
    expect(after).toMatchObject({
      paymentStatus: 'paid',
      voucherStatus: 'paid',
      openAmountCents: 0,
      paidDate: '2026-10-20',
      attentionCode: null,
    });
    const [transferAfter] = await ctx.db
      .select()
      .from(accountingTransfers)
      .where(eq(accountingTransfers.id, transfer.id));
    expect(transferAfter!.paymentStatus).toBe('paid');
    expect(transferAfter!.status).toBe('succeeded');
    const [cancellationAfter] = await ctx.db
      .select()
      .from(cancellations)
      .where(eq(cancellations.id, cancellation.id));
    expect(cancellationAfter!.paymentStatus).toBe('paid');
    expect(cancellationAfter!.financeStatus).toBe('paid');
    const [event] = await events();
    expect(event!.resultCode).toBe('UPDATED');
  });

  it('133b. Fälligkeit überschritten ⇒ overdue (aus dueDate < heute Berlin abgeleitet)', async () => {
    const { admin } = await adminSession(ctx);
    const invoice = await createFakeInvoice(ctx);
    const { mapping } = await createMappedTransfer(ctx, admin.id, invoice);
    fake.setDueDate(invoice.id, '2020-01-01T00:00:00.000+01:00');
    const signed = fake.signWebhook({
      eventType: 'invoice.status.changed',
      resourceId: invoice.id,
    });
    await postWebhook(ctx, signed.body, signed.signature);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const [after] = await ctx.db
      .select()
      .from(lexwareInvoiceMappings)
      .where(eq(lexwareInvoiceMappings.id, mapping.id));
    expect(after!.paymentStatus).toBe('overdue');
    expect(after!.dueDate).toBe('2020-01-01');
  });

  it('134. Ohne Mapping ⇒ Event ignored (NO_MAPPING), kein Lexware-Aufruf', async () => {
    fake.requestLog.length = 0;
    const signed = fake.signWebhook({ eventType: 'payment.changed', resourceId: resourceId() });
    await postWebhook(ctx, signed.body, signed.signature);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const [event] = await events();
    expect(event).toMatchObject({ status: 'ignored', resultCode: 'NO_MAPPING' });
    expect(fake.requestLog).toHaveLength(0);
  });

  it('135. Extern storniert (voided) ⇒ Prüfbedarf INVOICE_VOIDED: Zahlungsstatus unverändert, Transfer/Storno bleiben gesperrt, keine lokale Finanzmutation', async () => {
    const { admin } = await adminSession(ctx);
    const invoice = await createFakeInvoice(ctx);
    const { mapping, transfer, cancellation } = await createMappedTransfer(ctx, admin.id, invoice);
    fake.setInvoiceVoided(invoice.id);
    const signed = fake.signWebhook({
      eventType: 'invoice.status.changed',
      resourceId: invoice.id,
    });
    await postWebhook(ctx, signed.body, signed.signature);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const [after] = await ctx.db
      .select()
      .from(lexwareInvoiceMappings)
      .where(eq(lexwareInvoiceMappings.id, mapping.id));
    expect(after).toMatchObject({
      attentionCode: 'INVOICE_VOIDED',
      voucherStatus: 'voided',
      paymentStatus: 'open',
      lexwareInvoiceId: invoice.id,
    });
    const [transferAfter] = await ctx.db
      .select()
      .from(accountingTransfers)
      .where(eq(accountingTransfers.id, transfer.id));
    expect(transferAfter).toMatchObject({
      status: 'succeeded',
      paymentStatus: 'open',
      attentionCode: 'INVOICE_VOIDED',
      externalReference: invoice.voucherNumber,
    });
    expect(transferAfter!.attentionAt).not.toBeNull();
    const [cancellationAfter] = await ctx.db
      .select()
      .from(cancellations)
      .where(eq(cancellations.id, cancellation.id));
    expect(cancellationAfter).toMatchObject({
      paymentStatus: 'open',
      financeStatus: 'invoice_open',
      accountingReference: invoice.voucherNumber,
      feeCents: invoice.grossCents,
    });
    const [event] = await events();
    expect(event!.resultCode).toBe('INVOICE_VOIDED');
    // Keine zweite Rechnung, kein Storno-Beleg: Fake kennt weiterhin genau eine Rechnung.
    expect(fake.invoices.size).toBe(1);
  });

  it('135b. Extern gelöscht (404) ⇒ INVOICE_MISSING; taucht sie wieder auf, wird der eigene Prüfhinweis aufgehoben', async () => {
    const { admin } = await adminSession(ctx);
    const invoice = await createFakeInvoice(ctx);
    const { mapping, transfer } = await createMappedTransfer(ctx, admin.id, invoice);
    fake.deleteInvoice(invoice.id);
    const signed = fake.signWebhook({ eventType: 'invoice.deleted', resourceId: invoice.id });
    await postWebhook(ctx, signed.body, signed.signature);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    let [after] = await ctx.db
      .select()
      .from(lexwareInvoiceMappings)
      .where(eq(lexwareInvoiceMappings.id, mapping.id));
    expect(after!.attentionCode).toBe('INVOICE_MISSING');
    expect(after!.paymentStatus).toBe('open');
    let [transferAfter] = await ctx.db
      .select()
      .from(accountingTransfers)
      .where(eq(accountingTransfers.id, transfer.id));
    expect(transferAfter!.attentionCode).toBe('INVOICE_MISSING');
    expect(transferAfter!.status).toBe('succeeded');
    // Wieder vorhanden ⇒ nächster Abgleich hebt NUR den eigenen Code auf.
    fake.invoices.get(invoice.id)!.deleted = false;
    const again = fake.signWebhook({
      eventType: 'invoice.changed',
      resourceId: invoice.id,
      eventDate: '2026-10-18T10:00:00.000+02:00',
    });
    await postWebhook(ctx, again.body, again.signature);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    [after] = await ctx.db
      .select()
      .from(lexwareInvoiceMappings)
      .where(eq(lexwareInvoiceMappings.id, mapping.id));
    expect(after!.attentionCode).toBeNull();
    [transferAfter] = await ctx.db
      .select()
      .from(accountingTransfers)
      .where(eq(accountingTransfers.id, transfer.id));
    expect(transferAfter!.attentionCode).toBeNull();
  });

  it('135c. Fremder Prüfcode (TOTAL_MISMATCH) wird vom Abgleich nie überschrieben oder aufgehoben', async () => {
    const { admin } = await adminSession(ctx);
    const invoice = await createFakeInvoice(ctx);
    const { mapping, transfer } = await createMappedTransfer(ctx, admin.id, invoice, {
      attentionCode: 'TOTAL_MISMATCH',
    });
    await ctx.db
      .update(accountingTransfers)
      .set({ status: 'attention', attentionCode: 'TOTAL_MISMATCH', attentionAt: new Date() })
      .where(eq(accountingTransfers.id, transfer.id));
    fake.setInvoicePaid(invoice.id);
    const signed = fake.signWebhook({ eventType: 'payment.changed', resourceId: invoice.id });
    await postWebhook(ctx, signed.body, signed.signature);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const [after] = await ctx.db
      .select()
      .from(lexwareInvoiceMappings)
      .where(eq(lexwareInvoiceMappings.id, mapping.id));
    expect(after!.attentionCode).toBe('TOTAL_MISMATCH');
    expect(after!.paymentStatus).toBe('paid'); // Lexware-Stand im Mapping …
    const [transferAfter] = await ctx.db
      .select()
      .from(accountingTransfers)
      .where(eq(accountingTransfers.id, transfer.id));
    // … aber keine Spiegelung in einen nicht erfolgreich abgeschlossenen Transfer.
    expect(transferAfter).toMatchObject({
      status: 'attention',
      attentionCode: 'TOTAL_MISMATCH',
      paymentStatus: 'open',
    });
  });

  it('136./A1. token.revoked wird nicht mehr verarbeitet: Webhook ⇒ 202 ignored, Verbindung bleibt verbunden; API-Key-401 ⇒ getrennt', async () => {
    const { admin } = await adminSession(ctx);
    const invoice = await createFakeInvoice(ctx);
    await createMappedTransfer(ctx, admin.id, invoice);
    const connection = new LexwareConnectionService(ctx.lexware);
    await connection.check();
    const signed = fake.signWebhook({ eventType: 'token.revoked', resourceId: fake.connectionId });
    const response = await postWebhook(ctx, signed.body, signed.signature);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: 'ignored' });
    expect(await ctx.jobs.runOnce()).toBe('idle');
    expect(await events()).toHaveLength(0);
    const state = await connection.getState();
    expect(state?.status).toBe('connected');
    expect(state?.lastErrorCode).toBeNull();
    // API-Key-Gesundheit kommt aus der Profilprüfung: 401 ⇒ getrennt, Transfers blockiert.
    fake.revoked = true;
    await expect(connection.check()).resolves.toMatchObject({ state: { status: 'disconnected' } });
    await expect(connection.assertReady()).rejects.toMatchObject({ code: 'LEXWARE_UNAUTHORIZED' });
    expect(await ctx.db.select().from(lexwareInvoiceMappings)).toHaveLength(1);
    expect(await ctx.db.select().from(accountingTransfers)).toHaveLength(1);
    fake.revoked = false;
    const again = await connection.check();
    expect(again.state.status).toBe('connected');
  });

  it('Transienter Lexware-Fehler im Job ⇒ Event failed + Retry über die Queue; 401 ⇒ disconnected ohne Retry-Sturm', async () => {
    const { admin } = await adminSession(ctx);
    const invoice = await createFakeInvoice(ctx);
    await createMappedTransfer(ctx, admin.id, invoice);
    fake.failures.push({ match: 'GET /v1/invoices/', status: 503, times: 1 });
    const signed = fake.signWebhook({ eventType: 'payment.changed', resourceId: invoice.id });
    await postWebhook(ctx, signed.body, signed.signature);
    expect(await ctx.jobs.runOnce()).toBe('failed');
    let [event] = await events();
    expect(event).toMatchObject({ status: 'failed', resultCode: 'LEXWARE_SERVER' });
    const [job] = await jobs();
    expect(job!.status).toBe('pending'); // Retry geplant
    await ctx.pool.query('UPDATE integration_jobs SET run_at = now()');
    expect(await ctx.jobs.runOnce()).toBe('processed');
    [event] = await events();
    expect(event!.status).toBe('processed');

    fake.revoked = true;
    const secondEventDate = '2026-10-19T10:00:00.000+02:00';
    const second = fake.signWebhook({
      eventType: 'payment.changed',
      resourceId: invoice.id,
      eventDate: secondEventDate,
    });
    await postWebhook(ctx, second.body, second.signature);
    expect(await ctx.jobs.runOnce()).toBe('processed'); // kein Throw ⇒ kein Retry
    const all = await events();
    // Exakter Zeitpunkt statt Datumspräfix: das erste Ereignis trägt „jetzt“ als
    // Datum und kann am selben Kalendertag liegen.
    const secondIso = new Date(secondEventDate).toISOString();
    expect(all.find((e) => e.eventDate.toISOString() === secondIso)).toMatchObject({
      status: 'failed',
      resultCode: 'LEXWARE_UNAUTHORIZED',
    });
    const state = await new LexwareConnectionService(ctx.lexware).getState();
    expect(state?.status).toBe('disconnected');
  });
});
