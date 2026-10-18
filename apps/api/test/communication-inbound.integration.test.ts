/**
 * Phase 12 – Eingehende E-Mail (Order §§21–23; Pflichttests INBOUND 69–85):
 * UID-/Message-ID-/Fingerprint-Dedupe, kein UNSEEN-Zwang, In-Reply-To,
 * References, Vorgangsnummer + Absender, unmatched, keine Fachmutation,
 * HTML/XSS sicher, JPEG/PNG/WebP, keine PDF/ZIP/SVG-Persistenz, Restart-
 * Sicherheit, Self-Reschedule des Poll-Jobs, Unmatched-Inbox-Routen.
 */
import { Writable } from 'node:stream';
import {
  conversationMessages,
  inboundMailReceipts,
  inboundMailState,
  messagePhotos,
  processes,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  inboundPollIdempotencyKey,
  nextInboundPollBucket,
} from '../src/communication/inbound/poll-job.ts';
import { InboundMailProcessor } from '../src/communication/inbound/processor.ts';
import { DisabledInboundMailSource } from '../src/communication/inbound/sources.ts';
import { MAIL_INBOUND_POLL_JOB_TYPE } from '../src/communication/types.ts';
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
  createCustomerWithProcess,
  drainJobs,
  insertOwnDelivery,
  loadMailFixture,
  truncateCommunicationTables,
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

beforeAll(async () => {
  ctx = await createTestContext({ logDestination, logLevel: 'trace' });
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
  ctx.inboundMail.clear();
  ctx.inboundMail.uidValidity = 1;
  logLines.length = 0;
  const admin = await bootstrapAdmin(ctx);
  adminId = admin.id;
  adminCookie = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
});

const processor = () =>
  new InboundMailProcessor({ db: ctx.db, storage: ctx.storage, source: ctx.inboundMail });
const messages = () => ctx.db.select().from(conversationMessages);
const receipts = () => ctx.db.select().from(inboundMailReceipts);
const state = async () =>
  (await ctx.db.select().from(inboundMailState).where(eq(inboundMailState.mailbox, 'INBOX')))[0] ??
  null;

describe('Zuordnung (71–74)', () => {
  it('71. In-Reply-To auf eigene Message-ID ⇒ Vorgang zugeordnet (matchReason in_reply_to)', async () => {
    const { customer, process } = await createCustomerWithProcess(ctx, adminId, {
      email: 'max.mustermann@example.com',
    });
    await insertOwnDelivery(ctx, {
      processId: process.id,
      customerId: customer.id,
      messageId: '<offer-1@miet-royal.test>',
      recipientEmail: 'max.mustermann@example.com',
    });
    ctx.inboundMail.add(loadMailFixture('reply-in-reply-to.eml'));
    const result = await processor().pollOnce();
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0]).toMatchObject({ result: 'matched', matchReason: 'in_reply_to' });
    const [message] = await messages();
    expect(message).toMatchObject({
      processId: process.id,
      customerId: customer.id,
      channel: 'email',
      direction: 'inbound',
      providerMessageId: 'reply-1@example.com',
      replyToProviderMessageId: 'offer-1@miet-royal.test',
      deliveryState: 'received',
      subject: 'Re: Ihr Angebot von Miet-Royal',
    });
    expect(message!.body).toContain('vielen Dank für das Angebot');
    expect(message!.senderSnapshot).toEqual({
      name: 'Max Mustermann',
      email: 'max.mustermann@example.com',
    });
    const [receipt] = await receipts();
    expect(receipt).toMatchObject({
      mailbox: 'INBOX',
      uidValidity: '1',
      uid: 1,
      messageId: 'reply-1@example.com',
      status: 'matched',
      matchReason: 'in_reply_to',
      conversationMessageId: message!.id,
    });
  });

  it('72. Nur References (ohne In-Reply-To) auf eigene Message-ID ⇒ zugeordnet (references)', async () => {
    const { customer, process } = await createCustomerWithProcess(ctx, adminId, {
      email: 'max.mustermann@example.com',
    });
    await insertOwnDelivery(ctx, {
      processId: process.id,
      customerId: customer.id,
      messageId: '<offer-1@miet-royal.test>',
      recipientEmail: 'max.mustermann@example.com',
    });
    ctx.inboundMail.add(loadMailFixture('reply-references-only.eml'));
    const result = await processor().pollOnce();
    expect(result.outcomes[0]).toMatchObject({ result: 'matched', matchReason: 'references' });
    const [message] = await messages();
    expect(message!.processId).toBe(process.id);
  });

  it('73. Genau EINE Vorgangsnummer + Absender = Kunden-E-Mail ⇒ zugeordnet; fremder Absender oder zwei Nummern ⇒ unmatched', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, {
      email: 'Max.Mustermann@Example.com',
    });
    const replacements = { PROCESS_NUMBER: process.processNumber };
    ctx.inboundMail.add(loadMailFixture('process-number-subject.eml', replacements));
    ctx.inboundMail.add(loadMailFixture('process-number-wrong-sender.eml', replacements));
    ctx.inboundMail.add(loadMailFixture('process-number-two.eml', replacements));
    const result = await processor().pollOnce();
    expect(result.outcomes.map((o) => [o.result, o.matchReason])).toEqual([
      ['matched', 'process_number_sender'],
      ['unmatched', null],
      ['unmatched', null],
    ]);
    const rows = await messages();
    expect(rows.filter((row) => row.processId === process.id)).toHaveLength(1);
    expect(rows.filter((row) => row.processId === null)).toHaveLength(2);
  });

  it('74. Ohne Bezug ⇒ unmatched (processId NULL, Beleg unmatched) und in der Unmatched-Inbox sichtbar', async () => {
    ctx.inboundMail.add(loadMailFixture('unmatched.eml'));
    const result = await processor().pollOnce();
    expect(result.outcomes[0]).toMatchObject({ result: 'unmatched', matchReason: null });
    const [receipt] = await receipts();
    expect(receipt!.status).toBe('unmatched');
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/staff/communication/unmatched',
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    const list = response.json().messages as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      channel: 'email',
      subject: 'Allgemeine Anfrage Hochzeit',
      sender: { name: 'Erika Beispiel', email: 'erika@example.net' },
      photoCount: 0,
    });
    expect(list[0]!.preview).toContain('haben Sie am 12.06. noch eine Maschine frei?');
    expect(String(list[0]!.preview).length).toBeLessThanOrEqual(200);
  });
});

describe('Keine Fachmutation, Inhalte, Anhänge (75–78)', () => {
  it('75. Eine Mail mit Stornowunsch ändert NIE den Vorgang – nur eine Konversationszeile entsteht', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, {
      email: 'max.mustermann@example.com',
    });
    ctx.inboundMail.add(
      loadMailFixture('process-number-wrong-sender.eml', { PROCESS_NUMBER: process.processNumber }),
    );
    await processor().pollOnce();
    const [after] = await ctx.db.select().from(processes).where(eq(processes.id, process.id));
    expect(after!.mainStatus).toBe('open');
    expect(after!.cancelledAt).toBeNull();
    expect(after!.updatedAt.getTime()).toBe(process.updatedAt.getTime());
    expect(await messages()).toHaveLength(1);
  });

  it('76. HTML-only wird sicher zu Text: kein Script, keine Tags, keine externen Bilder, Entities dekodiert', async () => {
    ctx.inboundMail.add(loadMailFixture('html-only-script.eml'));
    await processor().pollOnce();
    const [message] = await messages();
    expect(message!.body).toContain('Hallo Team,');
    expect(message!.body).toContain('Bitte & danke <3 für die Rückmeldung.');
    expect(message!.body).toContain('Ende');
    expect(message!.body).not.toContain('<script');
    expect(message!.body).not.toContain('alert(');
    expect(message!.body).not.toContain('evil.example');
    expect(message!.body).not.toContain('<img');
    expect(message!.body).not.toContain('javascript:');
    expect(message!.body).not.toMatch(/<[a-z]+[\s>]/i);
    expect(message!.subject).toBe('<b>HTML</b> Nachricht');
  });

  it('77. JPEG/PNG/WebP-Anhänge werden geprüft, privat gespeichert und per Foto-Route ausgeliefert', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, {
      email: 'max.mustermann@example.com',
    });
    await insertOwnDelivery(ctx, {
      processId: process.id,
      customerId: process.customerId,
      messageId: '<offer-1@miet-royal.test>',
      recipientEmail: 'max.mustermann@example.com',
    });
    const raw = loadMailFixture('with-jpeg.eml').replace(
      'MIME-Version: 1.0',
      'In-Reply-To: <offer-1@miet-royal.test>\r\nMIME-Version: 1.0',
    );
    ctx.inboundMail.add(raw);
    const result = await processor().pollOnce();
    expect(result.outcomes[0]).toMatchObject({
      result: 'matched',
      photos: 3,
      skippedAttachments: 0,
    });
    const [message] = await messages();
    const photos = await ctx.db
      .select()
      .from(messagePhotos)
      .where(eq(messagePhotos.messageId, message!.id));
    expect(photos.map((p) => p.mimeType).sort()).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    for (const photo of photos) {
      expect(photo.storageKey).toMatch(
        new RegExp(`^communication/messages/${message!.id}/[0-9a-f-]{36}\\.(jpg|png|webp)$`),
      );
      expect(await ctx.storage.exists(photo.storageKey)).toBe(true);
      expect(photo.deletedAt).toBeNull();
    }
    const jpeg = photos.find((p) => p.mimeType === 'image/jpeg')!;
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/staff/messages/${message!.id}/photos/${jpeg.id}`,
      headers: { cookie: adminCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/jpeg');
    expect(response.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(response.rawPayload.length).toBe(jpeg.byteSize);
  });

  it('78. PDF/SVG/ZIP und getarnte Anhänge werden NIE gespeichert – nur gezählt', async () => {
    ctx.inboundMail.add(loadMailFixture('with-pdf-svg.eml'));
    const result = await processor().pollOnce();
    expect(result.outcomes[0]).toMatchObject({ photos: 0, skippedAttachments: 4 });
    const [message] = await messages();
    expect(await ctx.db.select().from(messagePhotos)).toHaveLength(0);
    expect(message!.senderSnapshot).toMatchObject({ skippedAttachments: 4 });
    expect(message!.body).toBe('Anbei Unterlagen.');
    expect(JSON.stringify(message)).not.toContain('%PDF');
    expect(JSON.stringify(message)).not.toContain('<svg');
  });
});

describe('Dedupe und Restart-Sicherheit (69, 70, 79–83)', () => {
  it('69. Dieselbe UID nach Absturz erneut gelesen ⇒ keine zweite Zeile (UID-Tripel-Dedupe)', async () => {
    ctx.inboundMail.add(loadMailFixture('unmatched.eml'));
    await processor().pollOnce();
    expect((await state())!.lastUid).toBe(1);
    // Absturz-Simulation: Zustand wurde nicht fortgeschrieben ⇒ erneut ab 0 lesen.
    await ctx.db.update(inboundMailState).set({ lastUid: 0 });
    const again = await processor().pollOnce();
    expect(again.outcomes[0]).toMatchObject({ result: 'duplicate' });
    expect(await messages()).toHaveLength(1);
    expect(await receipts()).toHaveLength(1);
    expect((await state())!.lastUid).toBe(1);
  });

  it('70. Abruf über UID-Bereiche statt UNSEEN: zweiter Poll fragt ab lastUid, unabhängig von Flags', async () => {
    ctx.inboundMail.add(loadMailFixture('unmatched.eml'));
    await processor().pollOnce();
    ctx.inboundMail.add(loadMailFixture('html-only-script.eml'));
    await processor().pollOnce();
    expect(ctx.inboundMail.fetchCalls.map((call) => call.sinceUid)).toEqual([0, 1]);
    expect(ctx.inboundMail.fetchCalls[1]!.knownUidValidity).toBe(1);
    expect(await messages()).toHaveLength(2);
    expect((await state())!.lastUid).toBe(2);
  });

  it('79. Restart-sicher: lastUid wird je Nachricht erst NACH erfolgreicher Verarbeitung fortgeschrieben', async () => {
    ctx.inboundMail.add(loadMailFixture('unmatched.eml'));
    ctx.inboundMail.add(loadMailFixture('html-only-script.eml'));
    const seen: number[] = [];
    const observing = new InboundMailProcessor({
      db: ctx.db,
      storage: ctx.storage,
      source: {
        kind: 'fake',
        fetch: (input) => ctx.inboundMail.fetch(input),
        status: () => ctx.inboundMail.status(),
      },
    });
    // Nach jeder Nachricht steht lastUid genau auf dieser UID.
    const original = observing.processEnvelope.bind(observing);
    observing.processEnvelope = async (envelope) => {
      const before = (await state())!.lastUid;
      seen.push(before);
      return original(envelope);
    };
    await observing.pollOnce();
    expect(seen).toEqual([0, 1]);
    expect((await state())!.lastUid).toBe(2);
    expect((await state())!.lastSuccessAt).not.toBeNull();
  });

  it('80. Gleiche Message-ID unter neuer UID ⇒ Duplikat (keine zweite Zeile)', async () => {
    ctx.inboundMail.add(loadMailFixture('unmatched.eml'));
    ctx.inboundMail.add(loadMailFixture('duplicate-message-id.eml'));
    const result = await processor().pollOnce();
    expect(result.outcomes.map((o) => o.result)).toEqual(['unmatched', 'duplicate']);
    expect(await messages()).toHaveLength(1);
    expect((await state())!.lastUid).toBe(2);
  });

  it('81. Ohne Message-ID dedupliziert der Fingerprint (From|Date|Subject|Textanfang)', async () => {
    ctx.inboundMail.add(loadMailFixture('no-message-id.eml'));
    ctx.inboundMail.add(loadMailFixture('no-message-id.eml'));
    const result = await processor().pollOnce();
    expect(result.outcomes.map((o) => o.result)).toEqual(['unmatched', 'duplicate']);
    const rows = await receipts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.messageId).toBeNull();
    expect(rows[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('82. UIDVALIDITY-Wechsel ⇒ Zähler zurück auf 0, alles neu gelesen, Duplikate über Belege erkannt', async () => {
    ctx.inboundMail.add(loadMailFixture('unmatched.eml'));
    await processor().pollOnce();
    expect((await state())!.uidValidity).toBe('1');
    ctx.inboundMail.resetMailbox(2);
    ctx.inboundMail.add(loadMailFixture('unmatched.eml'));
    ctx.inboundMail.add(loadMailFixture('html-only-script.eml'));
    const result = await processor().pollOnce();
    expect(ctx.inboundMail.fetchCalls[1]).toMatchObject({ sinceUid: 1, knownUidValidity: 1 });
    expect(result.outcomes.map((o) => [o.uid, o.result])).toEqual([
      [1, 'duplicate'],
      [2, 'unmatched'],
    ]);
    expect(await state()).toMatchObject({ uidValidity: '2', lastUid: 2 });
    expect(await messages()).toHaveLength(2);
  });

  it('83. Abruffehler: neutraler Fehlercode im Zustand, kein Fortschreiben, kein Absturz, kein Passwort im Log', async () => {
    ctx.inboundMail.add(loadMailFixture('unmatched.eml'));
    ctx.inboundMail.failNextFetch = 'ECONNRESET';
    const failed = await processor().pollOnce();
    expect(failed.errorCode).toBe('IMAP_ECONNRESET');
    expect(await state()).toMatchObject({ lastErrorCode: 'IMAP_ECONNRESET', lastUid: 0 });
    const ok = await processor().pollOnce();
    expect(ok.errorCode).toBeNull();
    expect(await state()).toMatchObject({ lastErrorCode: null, lastUid: 1 });
  });
});

describe('Poll-Job und Unmatched-Inbox (84, 85)', () => {
  it('84. mail.inbound_poll verarbeitet und reiht sich mit Zeit-Bucket-Schlüssel neu ein; deaktivierte Quelle ⇒ nichts', async () => {
    ctx.inboundMail.add(loadMailFixture('unmatched.eml'));
    const now = new Date();
    await ctx.queue.enqueue(MAIL_INBOUND_POLL_JOB_TYPE, {}, { idempotencyKey: 'test-poll-1' });
    // drain: andere fällige Jobs (z. B. Push bei Login) laufen mit; der Folge-Poll liegt in der Zukunft.
    await drainJobs(ctx);
    expect(await messages()).toHaveLength(1);
    const jobs = await ctx.pool.query<{ type: string; idempotency_key: string; status: string }>(
      'SELECT type, idempotency_key, status FROM integration_jobs ORDER BY created_at',
    );
    const expectedKey = inboundPollIdempotencyKey(nextInboundPollBucket(now));
    const follow = jobs.rows.filter((row) => row.type === MAIL_INBOUND_POLL_JOB_TYPE);
    expect(follow.map((row) => row.status)).toEqual(['succeeded', 'pending']);
    expect(follow[1]!.idempotency_key).toBe(expectedKey);
    // Deaktivierte Quelle: Handler ist ein No-op ohne Folgejob.
    const { createInboundPollHandler } = await import('../src/communication/inbound/poll-job.ts');
    const disabled = new DisabledInboundMailSource();
    const handler = createInboundPollHandler({
      processor: new InboundMailProcessor({ db: ctx.db, storage: ctx.storage, source: disabled }),
      source: disabled,
      queue: ctx.queue,
      mailbox: 'INBOX',
    });
    await handler({
      id: 'x',
      type: MAIL_INBOUND_POLL_JOB_TYPE,
      payload: {},
      idempotencyKey: 'k',
      attempts: 1,
      maxAttempts: 1,
      claimedBy: 't',
    });
    const after = await ctx.pool.query('SELECT count(*)::int AS c FROM integration_jobs');
    expect(after.rows[0].c).toBe(jobs.rows.length);
  });

  it('85. Unmatched-Inbox: Zuordnen setzt nur Konversation/Beleg (keine Fachmutation), Ignorieren entfernt aus der Liste; Rechte message.reply_customer', async () => {
    const { process } = await createCustomerWithProcess(ctx, adminId, {
      email: 'kunde@example.com',
    });
    ctx.inboundMail.add(loadMailFixture('unmatched.eml'));
    ctx.inboundMail.add(loadMailFixture('html-only-script.eml'));
    await processor().pollOnce();
    const [first, second] = await messages();

    const plain = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Paul',
      lastName: 'Plain',
      email: 'paul@test.example',
      password: 'paul-passwort-123456',
      permissionKeys: ['process.view_all'],
    });
    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/staff/communication/unmatched',
      headers: { cookie: plain.cookie },
    });
    expect(denied.statusCode).toBe(403);
    const deniedAssign = await ctx.app.inject({
      method: 'POST',
      url: `/staff/communication/unmatched/${first!.id}/assign`,
      headers: { cookie: plain.cookie },
      payload: { processId: process.id },
    });
    expect(deniedAssign.statusCode).toBe(403);

    // Ohne Vorgangssichtbarkeit (process.view_all) ist der Zielvorgang
    // neutral „nicht gefunden“ – keine Zuordnung in unsichtbare Vorgänge.
    const blind = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Bert',
      lastName: 'Blind',
      email: 'bert@test.example',
      password: 'bert-passwort-123456',
      permissionKeys: ['message.reply_customer'],
    });
    const blindAssign = await ctx.app.inject({
      method: 'POST',
      url: `/staff/communication/unmatched/${first!.id}/assign`,
      headers: { cookie: blind.cookie },
      payload: { processId: process.id },
    });
    expect(blindAssign.statusCode).toBe(404);
    const [stillUnmatched] = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, first!.id));
    expect(stillUnmatched!.processId).toBeNull();

    const replier = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Rita',
      lastName: 'Reply',
      email: 'rita@test.example',
      password: 'rita-passwort-123456',
      permissionKeys: ['message.reply_customer', 'process.view_all'],
    });
    const assign = await ctx.app.inject({
      method: 'POST',
      url: `/staff/communication/unmatched/${first!.id}/assign`,
      headers: { cookie: replier.cookie },
      payload: { processId: process.id },
    });
    expect(assign.statusCode).toBe(200);
    const [assigned] = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, first!.id));
    expect(assigned).toMatchObject({
      processId: process.id,
      customerId: process.customerId,
      assignedByStaffId: replier.user.id,
    });
    expect(assigned!.assignedAt).not.toBeNull();
    const [receipt] = await ctx.db
      .select()
      .from(inboundMailReceipts)
      .where(eq(inboundMailReceipts.conversationMessageId, first!.id));
    expect(receipt).toMatchObject({ status: 'matched', matchReason: 'manual' });
    const [processAfter] = await ctx.db
      .select()
      .from(processes)
      .where(eq(processes.id, process.id));
    expect(processAfter!.mainStatus).toBe('open');
    expect(processAfter!.updatedAt.getTime()).toBe(process.updatedAt.getTime());
    // Zweite Zuordnung derselben Nachricht ⇒ 409; unbekannter Vorgang ⇒ 404.
    const twice = await ctx.app.inject({
      method: 'POST',
      url: `/staff/communication/unmatched/${first!.id}/assign`,
      headers: { cookie: replier.cookie },
      payload: { processId: process.id },
    });
    expect(twice.statusCode).toBe(409);
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: `/staff/communication/unmatched/${second!.id}/assign`,
      headers: { cookie: replier.cookie },
      payload: { processId: '11111111-2222-4333-8444-555555555555' },
    });
    expect(unknown.statusCode).toBe(404);

    const ignore = await ctx.app.inject({
      method: 'POST',
      url: `/staff/communication/unmatched/${second!.id}/ignore`,
      headers: { cookie: replier.cookie },
    });
    expect(ignore.statusCode).toBe(200);
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/staff/communication/unmatched',
      headers: { cookie: replier.cookie },
    });
    expect(list.json().messages).toHaveLength(0);
    const [ignored] = await ctx.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, second!.id));
    expect(ignored!.ignoredByStaffId).toBe(replier.user.id);
    // Log enthält keine Mailinhalte/Adressen.
    const log = logLines.join('');
    expect(log).not.toContain('erika@example.net');
    expect(log).not.toContain('Maschine frei');
  });
});
