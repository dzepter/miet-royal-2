/**
 * Härtung Review A (Phase 12, Order §§21/23/38/44 „IMAP Duplicate“, „Poison Message“):
 *  RA-6  Fingerprint-Dedupe nur noch OHNE Message-ID und über den GESAMTEN Inhalt inkl.
 *        Anhänge/Date (fehlt Date: inkl. UID) – verschiedene, legitime Mails bleiben erhalten.
 *  RA-7  (Hinweise, spec-konform) Zuordnung über MR-Nummer + Absender bzw. In-Reply-To.
 *  RA-10 NUL-/Steuerzeichen werden entfernt; eine dennoch nicht verarbeitbare Nachricht
 *        (Datenfehler, SQLSTATE 22/23) wird mit Beleg `rejected`/`quarantined:<code>`
 *        übersprungen, lastUid läuft weiter, folgende Mails kommen an; wiederholbare
 *        Fehler werfen weiter. Der Job-Runner speichert nur eine bereinigte Kurzmeldung.
 *  H7    Vor der Transaktion hochgeladene Fotos werden bei jedem Fehlschlag gelöscht.
 */
import {
  conversationMessages,
  inboundMailReceipts,
  inboundMailState,
  integrationJobs,
  messagePhotos,
} from '@mietroyal/database';
import { JobRunner, type JobRunnerLogger, type StorageProvider } from '@mietroyal/integrations';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chooseInboundBody,
  inboundMailFingerprint,
  stripControlChars,
} from '../src/communication/inbound/content.ts';
import { enqueueInboundPoll } from '../src/communication/inbound/poll-job.ts';
import {
  InboundMailProcessor,
  nonRetryableInboundCode,
} from '../src/communication/inbound/processor.ts';
import { MAIL_INBOUND_POLL_JOB_TYPE } from '../src/communication/types.ts';
import {
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import {
  createCustomerWithProcess,
  insertOwnDelivery,
  truncateCommunicationTables,
} from './communication-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';

let ctx: TestContext;
let adminId: string;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await truncateCommunicationTables(ctx.pool);
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateCommunicationTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  ctx.inboundMail.clear();
  ctx.inboundMail.uidValidity = 1;
  adminId = (await bootstrapAdmin(ctx)).id;
});

const processor = (
  overrides: { db?: TestContext['db']; storage?: StorageProvider; logger?: JobRunnerLogger } = {},
) =>
  new InboundMailProcessor({
    db: overrides.db ?? ctx.db,
    storage: overrides.storage ?? ctx.storage,
    source: ctx.inboundMail,
    ...(overrides.logger === undefined ? {} : { logger: overrides.logger }),
  });

const JPEG_A = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIf/9k=';
const JPEG_B = '/9j/4AAQSkZJRgABAgEASABIAAD/2wBDAP////////////////////////////////////////9k=';

function mailWithPhotos(messageId: string | null, jpegs: readonly string[]): string {
  return [
    'From: Max Mustermann <max.mustermann@example.com>',
    'To: Miet-Royal Mainz <buero@miet-royal.test>',
    'Subject: Fotos',
    'Date: Sat, 18 Oct 2026 11:00:00 +0200',
    ...(messageId === null ? [] : [`Message-ID: <${messageId}>`]),
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Siehe Anhang.',
    '',
    ...jpegs.flatMap((jpeg, index) => [
      '--b1',
      `Content-Type: image/jpeg; name="foto${index}.jpg"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="foto${index}.jpg"`,
      '',
      jpeg,
      '',
    ]),
    '--b1--',
    '',
  ].join('\r\n');
}

function plainMail(input: {
  from: string;
  subject: string;
  body: string;
  messageId?: string;
  date?: string | null;
  inReplyTo?: string;
  extraHeaders?: string[];
}): string {
  return [
    `From: ${input.from}`,
    'To: Miet-Royal Mainz <buero@miet-royal.test>',
    `Subject: ${input.subject}`,
    ...(input.date === null ? [] : [`Date: ${input.date ?? 'Sat, 18 Oct 2026 10:15:00 +0200'}`]),
    ...(input.messageId === undefined ? [] : [`Message-ID: <${input.messageId}>`]),
    ...(input.inReplyTo === undefined ? [] : [`In-Reply-To: <${input.inReplyTo}>`]),
    ...(input.extraHeaders ?? []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    input.body,
    '',
  ].join('\r\n');
}

async function mailboxState() {
  return (
    await ctx.db.select().from(inboundMailState).where(eq(inboundMailState.mailbox, 'INBOX'))
  )[0]!;
}

describe('Härtung Review A – Fingerprint-Dedupe verwirft keine legitimen Mails (RA-6, Order §21)', () => {
  it('RA-6a gleiche From/Date/Subject/Text, verschiedene Message-ID und verschiedene Fotos ⇒ beide Mails samt Fotos erhalten', async () => {
    ctx.inboundMail.add(mailWithPhotos('foto-1@example.com', [JPEG_A]));
    ctx.inboundMail.add(mailWithPhotos('foto-2@example.com', [JPEG_B]));
    const result = await processor().pollOnce();
    expect(result.outcomes.map((o) => o.result)).toEqual(['unmatched', 'unmatched']);
    expect(await ctx.db.select().from(conversationMessages)).toHaveLength(2);
    expect(await ctx.db.select().from(messagePhotos)).toHaveLength(2);
    const receipts = await ctx.db.select().from(inboundMailReceipts);
    expect(receipts.map((r) => r.messageId).sort()).toEqual([
      'foto-1@example.com',
      'foto-2@example.com',
    ]);
  });

  it('RA-6a2 inhaltsgleiche Mails ohne Anhang mit verschiedener Message-ID ⇒ beide erhalten; gleiche Message-ID ⇒ Duplikat', async () => {
    const mail = (id: string) =>
      plainMail({ from: 'max@example.com', subject: 'Danke', body: 'Danke!', messageId: id });
    ctx.inboundMail.add(mail('danke-1@example.com'));
    ctx.inboundMail.add(mail('danke-2@example.com'));
    ctx.inboundMail.add(mail('danke-1@example.com'));
    const result = await processor().pollOnce();
    expect(result.outcomes.map((o) => o.result)).toEqual(['unmatched', 'unmatched', 'duplicate']);
  });

  it('RA-6b ohne Date-Header: gleiche Antwort an zwei Tagen (verschiedene Message-ID) ⇒ beide erhalten', async () => {
    const mail = (id: string) =>
      plainMail({
        from: 'max.mustermann@example.com',
        subject: 'Re: Termin',
        body: 'Ja, passt.',
        messageId: id,
        date: null,
      });
    ctx.inboundMail.add(mail('ja-montag@example.com'));
    const first = await processor().pollOnce();
    ctx.inboundMail.add(mail('ja-dienstag@example.com'));
    const second = await processor().pollOnce();
    expect(first.outcomes.map((o) => o.result)).toEqual(['unmatched']);
    expect(second.outcomes.map((o) => o.result)).toEqual(['unmatched']);
    expect(await ctx.db.select().from(conversationMessages)).toHaveLength(2);
  });

  it('RA-6c ohne Message-ID: exakte Wiederzustellung (gleiches Date, gleicher Inhalt) ⇒ Duplikat; ohne Date nur exakt dieselbe UID', async () => {
    const withDate = plainMail({ from: 'max@example.com', subject: 'Hallo', body: 'Text' });
    ctx.inboundMail.add(withDate);
    ctx.inboundMail.add(withDate);
    const noDate = plainMail({ from: 'max@example.com', subject: 'Ja', body: 'Ja', date: null });
    ctx.inboundMail.add(noDate);
    ctx.inboundMail.add(noDate);
    const result = await processor().pollOnce();
    expect(result.outcomes.map((o) => o.result)).toEqual([
      'unmatched',
      'duplicate',
      'unmatched',
      'unmatched',
    ]);
  });

  it('RA-6d Fingerprint (Unit): gesamter Text, Anhänge und UID-Ersatz für fehlendes Date fließen ein', () => {
    const base = { from: 'a@x.test', date: new Date('2026-10-18T10:00:00Z'), subject: 'Hi' };
    const long = 'x'.repeat(600);
    expect(inboundMailFingerprint({ ...base, body: `${long}A` })).not.toBe(
      inboundMailFingerprint({ ...base, body: `${long}B` }),
    );
    expect(inboundMailFingerprint({ ...base, body: 'T', attachmentSha256: ['aa'] })).not.toBe(
      inboundMailFingerprint({ ...base, body: 'T', attachmentSha256: ['bb'] }),
    );
    const noDate = { ...base, date: null, body: 'Ja' };
    expect(
      inboundMailFingerprint({
        ...noDate,
        uidFallback: { mailbox: 'INBOX', uidValidity: '1', uid: 1 },
      }),
    ).not.toBe(
      inboundMailFingerprint({
        ...noDate,
        uidFallback: { mailbox: 'INBOX', uidValidity: '1', uid: 2 },
      }),
    );
  });
});

describe('Härtung Review A – Zuordnung (Hinweise, spec-konform nach Order §21)', () => {
  it('RA-7a gefälschter From-Header mit der Kundenadresse + MR-Nummer ⇒ dem Vorgang zugeordnet (Mail autorisiert nie Fachaktionen)', async () => {
    const victim = await createCustomerWithProcess(ctx, adminId, { email: 'opfer@example.com' });
    ctx.inboundMail.add(
      plainMail({
        from: 'Opfer <OPFER@Example.com>',
        subject: `Vorgang ${victim.process.processNumber}`,
        body: 'Bitte die Abholung an Herrn X übergeben, Telefon 0170 1234567.',
        messageId: 'spoof-1@attacker.example',
      }),
    );
    const result = await processor().pollOnce();
    expect(result.outcomes[0]).toMatchObject({
      result: 'matched',
      matchReason: 'process_number_sender',
    });
    const [message] = await ctx.db.select().from(conversationMessages);
    expect(message!.processId).toBe(victim.process.id);
  });

  it('RA-7b In-Reply-To auf eine bekannte Miet-Royal-Message-ID ⇒ Zuordnung ohne Absenderprüfung (Order §21 Regel 1)', async () => {
    const victim = await createCustomerWithProcess(ctx, adminId, { email: 'opfer@example.com' });
    await insertOwnDelivery(ctx, {
      processId: victim.process.id,
      customerId: victim.customer.id,
      messageId: '<0b7c7f0e-1111-4222-8333-944445555666@miet-royal.test>',
      recipientEmail: 'opfer@example.com',
    });
    ctx.inboundMail.add(
      plainMail({
        from: 'fremd@attacker.example',
        subject: 'Re: Angebot',
        body: 'Fremder Text',
        messageId: 'irt-1@attacker.example',
        inReplyTo: '0b7c7f0e-1111-4222-8333-944445555666@miet-royal.test',
      }),
    );
    const result = await processor().pollOnce();
    expect(result.outcomes[0]).toMatchObject({ result: 'matched', matchReason: 'in_reply_to' });
    const [message] = await ctx.db.select().from(conversationMessages);
    expect(message!.processId).toBe(victim.process.id);
  });

  it('RA-7c (kein Fund) zwei verschiedene MR-Nummern ⇒ unmatched; gleiche Nummer mehrfach ⇒ zugeordnet', async () => {
    const a = await createCustomerWithProcess(ctx, adminId, { email: 'a@example.com' });
    const b = await createCustomerWithProcess(ctx, adminId, { email: 'b@example.com' });
    ctx.inboundMail.add(
      plainMail({
        from: 'a@example.com',
        subject: `Vorgang ${a.process.processNumber}`,
        body: `Siehe auch ${b.process.processNumber}`,
        messageId: 'two-1@example.com',
      }),
    );
    ctx.inboundMail.add(
      plainMail({
        from: 'a@example.com',
        subject: `Re: Vorgang ${a.process.processNumber}`,
        body: `> Vorgang ${a.process.processNumber}\nDanke`,
        messageId: 'same-1@example.com',
        date: 'Sat, 18 Oct 2026 10:16:00 +0200',
      }),
    );
    const result = await processor().pollOnce();
    expect(result.outcomes.map((o) => o.result)).toEqual(['unmatched', 'matched']);
  });
});

describe('Härtung Review A – Poison Message im IMAP-Eingang (RA-10, Order §§21/38)', () => {
  const nulMail = [
    'From: =?utf-8?Q?Max=00Mustermann?= <max.mustermann@example.com>',
    'To: Miet-Royal Mainz <buero@miet-royal.test>',
    'Subject: =?utf-8?Q?Kaputt=00Betreff?=',
    'Date: Sat, 18 Oct 2026 10:15:00 +0200',
    'Message-ID: <nul-1@example.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Geheimer Kundentext SECRET-BODY-4711 mit NUL=00Byte und =07Glocke',
    '',
  ].join('\r\n');

  function okMail() {
    return plainMail({
      from: 'max.mustermann@example.com',
      subject: 'Normale Mail danach',
      body: 'Hallo',
      messageId: 'ok-after-nul@example.com',
    });
  }

  it('RA-10 NUL-/Steuerzeichen in Text, Betreff und Absendername werden entfernt – die Mail und alle folgenden kommen an', async () => {
    ctx.inboundMail.add(nulMail);
    ctx.inboundMail.add(okMail());
    const result = await processor().pollOnce();
    expect(result.outcomes.map((o) => o.result)).toEqual(['unmatched', 'unmatched']);
    expect((await mailboxState()).lastUid).toBe(2);
    const messages = await ctx.db.select().from(conversationMessages);
    expect(messages).toHaveLength(2);
    const poisoned = messages.find((m) => m.providerMessageId === 'nul-1@example.com')!;
    expect(poisoned.body).toBe('Geheimer Kundentext SECRET-BODY-4711 mit NULByte und Glocke');
    expect(poisoned.subject).toBe('Kaputt Betreff');
    expect(JSON.stringify(poisoned.senderSnapshot)).not.toMatch(/\\u0000/);
    for (const m of messages) expect(`${m.body}${m.subject}`).not.toContain('\u0000');
  });

  it('RA-10b über die Queue (wie im Worker): Poll-Job läuft durch, kein hängender processing-Job', async () => {
    ctx.inboundMail.add(nulMail);
    ctx.inboundMail.add(okMail());
    await enqueueInboundPoll(ctx.queue, ctx.inboundMail);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const jobs = await ctx.db
      .select()
      .from(integrationJobs)
      .where(eq(integrationJobs.type, MAIL_INBOUND_POLL_JOB_TYPE));
    expect(jobs.some((j) => j.status === 'processing')).toBe(false);
    expect(await ctx.db.select().from(conversationMessages)).toHaveLength(2);
  });

  /** db-Proxy: die Transaktion einer Nachricht scheitert mit dem gegebenen Fehler. */
  function failingTransactionDb(error: Error) {
    return new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') return async () => Promise.reject(error);
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
  }

  /** Speicher-Proxy: zeichnet Uploads/Löschungen auf, optional scheitert der n-te Upload. */
  function recordingStorage(failOnPut?: { nth: number; error: Error }) {
    const puts: string[] = [];
    const deletes: string[] = [];
    const storage: StorageProvider = new Proxy(ctx.storage, {
      get(target, prop, receiver) {
        if (prop === 'put') {
          return async (key: string, ...rest: unknown[]) => {
            if (failOnPut !== undefined && puts.length + 1 === failOnPut.nth) throw failOnPut.error;
            puts.push(key);
            return (target.put as (...args: unknown[]) => Promise<unknown>).call(
              target,
              key,
              ...rest,
            );
          };
        }
        if (prop === 'delete') {
          return async (key: string) => {
            deletes.push(key);
            return target.delete(key);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    }) as StorageProvider;
    return { storage, puts, deletes };
  }

  it('RA-10c/H7 nicht wiederholbarer Datenfehler (SQLSTATE 22021) ⇒ Quarantäne-Beleg, lastUid weiter, Fotos gelöscht, nur Code im Log', async () => {
    ctx.inboundMail.add(mailWithPhotos('poison-photo@example.com', [JPEG_A]));
    const logs: string[] = [];
    const logger: JobRunnerLogger = {
      info: (c, m) => logs.push(JSON.stringify(c) + m),
      warn: (c, m) => logs.push(JSON.stringify(c) + m),
      error: (c, m) => logs.push(JSON.stringify(c) + m),
    };
    const pgError = Object.assign(
      new Error('Failed query: insert …\nparams: Siehe Anhang. SECRET-PARAM'),
      { cause: Object.assign(new Error('invalid byte sequence'), { code: '22021' }) },
    );
    const { storage, puts, deletes } = recordingStorage();
    const result = await processor({
      db: failingTransactionDb(pgError),
      storage,
      logger,
    }).pollOnce();
    expect(result.outcomes.map((o) => o.result)).toEqual(['quarantined']);
    expect(puts).toHaveLength(1);
    expect(deletes).toEqual(puts);
    expect(await ctx.storage.exists(puts[0]!)).toBe(false);
    expect((await mailboxState()).lastUid).toBe(1);
    const [receipt] = await ctx.db.select().from(inboundMailReceipts);
    expect(receipt).toMatchObject({
      uid: 1,
      status: 'rejected',
      matchReason: 'quarantined:PG_22021',
      messageId: null,
      subject: null,
      fromAddress: null,
      conversationMessageId: null,
    });
    const log = logs.join('\n');
    expect(log).toContain('PG_22021');
    expect(log).not.toContain('SECRET-PARAM');
    expect(log).not.toContain('max.mustermann');

    // Die nächste (normale) Mail wird regulär verarbeitet; die quarantänierte nicht erneut.
    ctx.inboundMail.add(okMail());
    const next = await processor().pollOnce();
    expect(next.outcomes.map((o) => o.result)).toEqual(['unmatched']);
    expect((await mailboxState()).lastUid).toBe(2);
  });

  it('RA-10d wiederholbare Fehler (DB/Storage weg) werfen weiter: lastUid bleibt, Teil-Uploads gelöscht (H7)', async () => {
    ctx.inboundMail.add(mailWithPhotos('retry-photo@example.com', [JPEG_A, JPEG_B]));
    const storageDown = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const { storage, puts, deletes } = recordingStorage({ nth: 2, error: storageDown });
    await expect(processor({ storage }).pollOnce()).rejects.toThrow('socket hang up');
    expect(puts).toHaveLength(1);
    expect(deletes).toEqual(puts);
    expect((await mailboxState()).lastUid).toBe(0);
    expect(await ctx.db.select().from(inboundMailReceipts)).toHaveLength(0);

    const dbDown = Object.assign(new Error('Connection terminated'), { code: '57P01' });
    await expect(processor({ db: failingTransactionDb(dbDown) }).pollOnce()).rejects.toThrow(
      'Connection terminated',
    );
    expect((await mailboxState()).lastUid).toBe(0);
    // Danach (Infrastruktur wieder da) wird dieselbe Mail regulär verarbeitet.
    const recovered = await processor().pollOnce();
    expect(recovered.outcomes.map((o) => o.result)).toEqual(['unmatched']);
    expect(await ctx.db.select().from(messagePhotos)).toHaveLength(2);
  });

  it('RA-10e Klassifikation: nur SQLSTATE 22/23 (außer 23505) und unlesbares MIME sind Quarantäne', () => {
    const pg = (code: string) => Object.assign(new Error('x'), { code });
    expect(nonRetryableInboundCode(pg('22021'))).toBe('PG_22021');
    expect(nonRetryableInboundCode({ cause: pg('22P05') })).toBe('PG_22P05');
    expect(nonRetryableInboundCode(pg('23502'))).toBe('PG_23502');
    expect(nonRetryableInboundCode(pg('23505'))).toBeNull();
    expect(nonRetryableInboundCode(pg('57P01'))).toBeNull();
    expect(nonRetryableInboundCode(pg('40001'))).toBeNull();
    expect(nonRetryableInboundCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      null,
    );
    expect(nonRetryableInboundCode(new Error('unbekannt'))).toBeNull();
  });

  it('RA-10f Steuerzeichen-Bereinigung (Unit): mehrzeilig \\t/\\n bleiben, \\r ⇒ \\n; einzeilig ⇒ Leerzeichen', () => {
    expect(stripControlChars('a\u0000b\tc\r\nd\re\u0007f\u007f', 'multiline')).toBe('ab\tc\nd\nef');
    expect(stripControlChars('Betreff\u0000mit\r\nUmbruch', 'single_line')).toBe(
      'Betreff mit Umbruch',
    );
    expect(chooseInboundBody({ text: 'NUL\u0000weg' })).toBe('NULweg');
  });

  it('RA-10g Job-Runner: Fehler mit NUL-Byte und SQL-Parametern ⇒ markFailed gelingt, last_error nur Klasse/Code/erste Zeile', async () => {
    const runner = new JobRunner(ctx.queue, 'ra10-runner');
    runner.register('test.ra10_poison', async () => {
      const cause = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), {
        code: '22021',
      });
      throw Object.assign(
        new Error('Failed query: insert into "x" ("body") values ($1)\nparams: SECRET\u0000BODY'),
        { name: 'DrizzleQueryError', cause },
      );
    });
    await ctx.queue.enqueue('test.ra10_poison', {}, { idempotencyKey: 'ra10-poison-1' });
    expect(await runner.runOnce()).toBe('failed');
    const [job] = await ctx.db
      .select()
      .from(integrationJobs)
      .where(eq(integrationJobs.idempotencyKey, 'ra10-poison-1'));
    expect(job!.status).not.toBe('processing');
    expect(job!.lastError).toBe(
      'DrizzleQueryError [22021]: Failed query: insert into "x" ("body") values ($1)',
    );
  });
});
