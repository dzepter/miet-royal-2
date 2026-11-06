import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  cmsEntries,
  cmsRevisions,
  customers,
  inquiries,
  inquirySelections,
  machineBlocks,
  machines,
  processes,
  products,
  publicInquirySubmissions,
} from '@mietroyal/database';
import { berlinDateTimeToUtc } from '@mietroyal/domain';
import { CMS_PRIVACY_PATH } from '@mietroyal/validation/cms';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELIVERY_WINDOW_ORDER_MESSAGE,
  NONEXISTENT_LOCAL_TIME_MESSAGE,
  PRIVACY_NOT_PUBLISHED_MESSAGE,
} from '../src/public/website-inquiry.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  login,
  type TestContext,
} from './auth-helpers.ts';
import { publishCmsForTests, publishPrivacyForTests } from './cms-helpers.ts';
import {
  createStaffWithPermissions,
  createTestCustomer,
  processServiceFor,
} from './crm-helpers.ts';
import { loginPortalCustomerSession } from './portal-auth-helpers.ts';
import {
  berlinDateInDays,
  countRows,
  inquiryBody,
  postInquiry,
  resetPublicWorld,
} from './public-helpers.ts';
import { resetWarehouse } from './warehouse-helpers.ts';

/**
 * Phase 16 (PUBLIC, Design §3.3/§3.4/§11.2/§11.3): Website-Anfrage ⇒ genau EIN Vorgang
 * (source website, created_by NULL), atomar in einer Transaktion, idempotent über
 * clientMutationId, Kundenzuordnung (Portal-Session, eindeutige E-Mail, Dublette),
 * Datenschutz-Nachweis fail-closed, keine PII im Log, kein Verfügbarkeits-Reject,
 * Cross-Site-Schutz, Staff-Hinweis. Namen laufen als „PI<n>“.
 */

let ctx: TestContext;
let adminId: string;
let logBuffer = '';
let privacyRevisionId: string;

beforeAll(async () => {
  const sink = new PassThrough();
  sink.on('data', (chunk: Buffer) => {
    logBuffer += chunk.toString('utf8');
  });
  ctx = await createTestContext({ logDestination: sink, logLevel: 'trace' });
});

afterAll(async () => {
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await resetPublicWorld(ctx.pool);
  adminId = (await bootstrapAdmin(ctx)).id;
  privacyRevisionId = (await publishPrivacyForTests(ctx.db)).revisionId;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Kalendertag nach `dateIso` (kalendarisch, TZ-unabhängig). */
function dayAfter(dateIso: string): string {
  return new Date(Date.parse(`${dateIso}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

const MR_NUMBER = /^MR-\d{4}-\d{4,}$/;

async function created(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await postInquiry(ctx, body, headers);
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { processNumber: string; receivedAt: string };
}

async function processByNumber(processNumber: string) {
  const [process] = await ctx.db
    .select()
    .from(processes)
    .where(eq(processes.processNumber, processNumber));
  if (process === undefined) throw new Error('Vorgang fehlt');
  return process;
}

async function productId(slug: string): Promise<string> {
  const [row] = await ctx.db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.slug, slug));
  return row!.id;
}

describe('Phase 16 – Website-Anfrage (POST /public/inquiries)', () => {
  it('PI1. Abholung, Privatperson: genau ein Vorgang (source website, created_by NULL), Kunde neu, Anfrage + Auswahl, Submission mit Snapshot und Datenschutz-Revision', async () => {
    const body = inquiryBody({
      extras: { cups25: 2, straws25: 0 },
      canisters: 1,
      syrups: {
        free: [{ slug: 'sirup-kirsche', liters: 2 }],
        extra: [{ slug: 'sirup-wassermelone', liters: 3 }],
      },
    });
    const before = await countRows(ctx.pool, 'processes');
    const result = await created(body);
    expect(result.processNumber).toMatch(MR_NUMBER);
    expect(Number.isNaN(Date.parse(result.receivedAt))).toBe(false);
    expect(await countRows(ctx.pool, 'processes')).toBe(before + 1);

    const process = await processByNumber(result.processNumber);
    expect(process.source).toBe('website');
    expect(process.createdBy).toBeNull();
    expect(process.eventDate).toBe(body.event.date);

    const [customer] = await ctx.db
      .select()
      .from(customers)
      .where(eq(customers.id, process.customerId));
    expect(customer).toMatchObject({
      type: 'private',
      firstName: 'Paula',
      lastName: 'Publikum',
      email: 'paula.publikum@test.example',
      phone: '0171 5550101',
      phoneNormalized: '491715550101',
    });

    const [inquiry] = await ctx.db
      .select()
      .from(inquiries)
      .where(eq(inquiries.processId, process.id));
    expect(inquiry).toMatchObject({
      eventDate: body.event.date,
      guestCount: 80,
      occasion: 'birthday',
      machineProductId: await productId('slush-2x10'),
      fulfillment: 'pickup',
      deliveryStreet: null,
      createdBy: null,
    });
    const date = body.event.date as string;
    expect(inquiry!.eventStart?.toISOString()).toBe(berlinDateTimeToUtc(date, 18, 0).toISOString());
    expect(inquiry!.eventEnd?.toISOString()).toBe(berlinDateTimeToUtc(date, 23, 0).toISOString());
    const selections = await ctx.db
      .select()
      .from(inquirySelections)
      .where(eq(inquirySelections.inquiryId, inquiry!.id));
    const bySlug = new Map<string, { role: string; quantity: number }[]>();
    for (const selection of selections) {
      const [product] = await ctx.db
        .select()
        .from(products)
        .where(eq(products.id, selection.productId));
      bySlug.set(product!.slug, [
        ...(bySlug.get(product!.slug) ?? []),
        { role: selection.role, quantity: selection.quantity },
      ]);
    }
    expect(Object.fromEntries(bySlug)).toEqual({
      'sirup-kirsche': [{ role: 'free', quantity: 2 }],
      'sirup-wassermelone': [{ role: 'extra', quantity: 3 }],
      'becher-25': [{ role: 'extra', quantity: 2 }],
      'mischkanister-6l': [{ role: 'extra', quantity: 1 }],
    });

    const [submission] = await ctx.db
      .select()
      .from(publicInquirySubmissions)
      .where(eq(publicInquirySubmissions.processId, process.id));
    expect(submission).toMatchObject({
      clientMutationId: body.clientMutationId,
      customerId: customer!.id,
      inquiryId: inquiry!.id,
      customerMatch: 'new_customer',
      privacyRevisionId,
      contactSnapshot: {
        type: 'private',
        firstName: 'Paula',
        lastName: 'Publikum',
        email: 'paula.publikum@test.example',
        phone: '0171 5550101',
      },
    });
    expect(submission!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(submission!.privacyAcknowledgedAt.toISOString()).toBe(result.receivedAt);
    // Keine Mail, kein Angebot: die Website erzeugt nur die Anfrage.
    expect(await countRows(ctx.pool, 'offers')).toBe(0);
    expect(await countRows(ctx.pool, 'mail_deliveries')).toBe(0);
  });

  it('PI2. Organisation: Kunde Typ organization mit Organisationsname + Ansprechpartner; E-Mail normalisiert; ohne Telefon', async () => {
    const result = await created(
      inquiryBody({
        contact: {
          type: 'organization',
          organizationName: '  TSV Teststadt e. V. ',
          contactPerson: 'Otto Organisator',
          email: '  Vorstand@TSV-Test.TEST.example ',
        },
      }),
    );
    const process = await processByNumber(result.processNumber);
    const [customer] = await ctx.db
      .select()
      .from(customers)
      .where(eq(customers.id, process.customerId));
    expect(customer).toMatchObject({
      type: 'organization',
      organizationName: 'TSV Teststadt e. V.',
      contactPerson: 'Otto Organisator',
      email: 'vorstand@tsv-test.test.example',
      phone: null,
      firstName: null,
      lastName: null,
    });
  });

  it('PI3. Zeiten Europe/Berlin: Ende ≤ Beginn ⇒ Ende am Folgetag (kein 400); nur Beginn bzw. ohne Zeiten erlaubt', async () => {
    const date = berlinDateInDays(30);
    const overnight = await created(
      inquiryBody({
        event: { date, startTime: '20:00', endTime: '02:00', guests: 30, occasion: 'party' },
      }),
    );
    const [inquiry] = await ctx.db
      .select()
      .from(inquiries)
      .where(eq(inquiries.processId, (await processByNumber(overnight.processNumber)).id));
    expect(inquiry!.eventStart?.toISOString()).toBe(berlinDateTimeToUtc(date, 20, 0).toISOString());
    const nextDay = new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(inquiry!.eventEnd?.toISOString()).toBe(berlinDateTimeToUtc(nextDay, 2, 0).toISOString());

    const noTimes = await created(
      inquiryBody({ event: { date, guests: 30, occasion: 'wedding' } }),
    );
    const [plain] = await ctx.db
      .select()
      .from(inquiries)
      .where(eq(inquiries.processId, (await processByNumber(noTimes.processNumber)).id));
    expect(plain!.eventStart).toBeNull();
    expect(plain!.eventEnd).toBeNull();
  });

  it('PI4. Lieferung: Adresse und Zeitfenster am Veranstaltungstag gespeichert, KEIN Lieferpreis (kein Angebot, keine Preisposition)', async () => {
    const date = berlinDateInDays(20);
    const result = await created(
      inquiryBody({
        event: { date, guests: 60, occasion: 'company_event' },
        fulfillment: {
          type: 'delivery',
          street: 'Musterweg 12',
          postalCode: '55116',
          city: 'Mainz',
          windowFrom: '09:00',
          windowTo: '11:30',
        },
      }),
    );
    const [inquiry] = await ctx.db
      .select()
      .from(inquiries)
      .where(eq(inquiries.processId, (await processByNumber(result.processNumber)).id));
    expect(inquiry).toMatchObject({
      fulfillment: 'delivery',
      deliveryStreet: 'Musterweg 12',
      deliveryPostalCode: '55116',
      deliveryCity: 'Mainz',
    });
    expect(inquiry!.deliveryWindowFrom?.toISOString()).toBe(
      berlinDateTimeToUtc(date, 9, 0).toISOString(),
    );
    expect(inquiry!.deliveryWindowTo?.toISOString()).toBe(
      berlinDateTimeToUtc(date, 11, 30).toISOString(),
    );
    expect(await countRows(ctx.pool, 'offers')).toBe(0);
    expect(await countRows(ctx.pool, 'offer_line_items')).toBe(0);
  });

  it('PI5. Retry mit gleicher clientMutationId und gleichem Inhalt ⇒ 200 mit denselben Werten, kein zweiter Vorgang', async () => {
    const body = inquiryBody();
    const first = await created(body);
    const retry = await postInquiry(ctx, body);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual(first);
    // Auch mit anders geschriebener UUID (Großbuchstaben) und umsortierten Feldern.
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    const upper = await postInquiry(ctx, {
      ...reordered,
      clientMutationId: body.clientMutationId.toUpperCase(),
    });
    expect(upper.statusCode).toBe(200);
    expect(upper.json()).toEqual(first);
    expect(await countRows(ctx.pool, 'processes')).toBe(1);
    expect(await countRows(ctx.pool, 'customers')).toBe(1);
    expect(await countRows(ctx.pool, 'public_inquiry_submissions')).toBe(1);
  });

  it('PI6. Doppelklick: zwei parallele Requests mit derselben ID ⇒ genau ein Vorgang (einmal 201, einmal 200)', async () => {
    const body = inquiryBody();
    const [a, b] = await Promise.all([postInquiry(ctx, body), postInquiry(ctx, body)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().processNumber).toBe(b.json().processNumber);
    expect(await countRows(ctx.pool, 'processes')).toBe(1);
    expect(await countRows(ctx.pool, 'inquiries')).toBe(1);
    expect(await countRows(ctx.pool, 'public_inquiry_submissions')).toBe(1);
  });

  it('PI7. Gleiche ID, anderer Inhalt ⇒ 409 PUBLIC_INQUIRY_CONFLICT mit gespeicherter Vorgangsnummer, nichts Neues', async () => {
    const body = inquiryBody();
    const first = await created(body);
    const changed = await postInquiry(ctx, {
      ...body,
      event: { ...body.event, guests: 81 },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toMatchObject({
      code: 'PUBLIC_INQUIRY_CONFLICT',
      processNumber: first.processNumber,
    });
    expect(await countRows(ctx.pool, 'processes')).toBe(1);
  });

  it('PI8. Ohne veröffentlichte Datenschutzhinweise (nie veröffentlicht, nur Entwurf, ungültiger/leerer Rechtstext) ⇒ 409 PRIVACY_NOT_PUBLISHED, nichts gespeichert', async () => {
    await ctx.pool.query(
      'TRUNCATE public_inquiry_submissions, cms_preview_access, cms_revision_media, cms_revisions, cms_entries CASCADE',
    );
    const expectBlocked = async () => {
      const response = await postInquiry(ctx, inquiryBody());
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toMatchObject({
        code: 'PRIVACY_NOT_PUBLISHED',
        message: PRIVACY_NOT_PUBLISHED_MESSAGE,
      });
      expect(await countRows(ctx.pool, 'processes')).toBe(0);
      expect(await countRows(ctx.pool, 'customers')).toBe(0);
    };
    await expectBlocked();
    await publishCmsForTests(
      ctx.db,
      { kind: 'page', pageType: 'legal', path: CMS_PRIVACY_PATH },
      {
        content: { title: 'Datenschutz', blocks: [{ type: 'text', body: 'Entwurf.' }] },
        metaTitle: 'Datenschutz',
        publish: false,
      },
    );
    await expectBlocked();
    // Veröffentlichter, aber leerer Rechtstext (am Schema vorbei gespeichert) ⇒ fail-closed.
    const [entry] = await ctx.db
      .select({ id: cmsEntries.id })
      .from(cmsEntries)
      .where(eq(cmsEntries.path, CMS_PRIVACY_PATH));
    const [empty] = await ctx.db
      .insert(cmsRevisions)
      .values({
        entryId: entry!.id,
        revisionNumber: 2,
        content: { title: 'Datenschutz', blocks: [] },
      })
      .returning({ id: cmsRevisions.id });
    await ctx.db
      .update(cmsEntries)
      .set({ draftRevisionId: empty!.id, publishedRevisionId: empty!.id, publishedAt: new Date() })
      .where(eq(cmsEntries.id, entry!.id));
    await expectBlocked();
    // Nach echter Veröffentlichung: Revision wird am Anfrage-Nachweis gespeichert.
    const published = await publishPrivacyForTests(ctx.db);
    const result = await created(inquiryBody());
    const [submission] = await ctx.db
      .select()
      .from(publicInquirySubmissions)
      .where(
        eq(publicInquirySubmissions.processId, (await processByNumber(result.processNumber)).id),
      );
    expect(submission!.privacyRevisionId).toBe(published.revisionId);
  });

  it('PI9. Genau EIN aktiver Kunde mit der E-Mail (Groß-/Kleinschreibung egal) ⇒ dieser Kunde, Stammdaten unverändert; Staff sieht Abweichungen', async () => {
    const existing = await createTestCustomer(ctx, adminId, {
      firstName: 'Petra',
      lastName: 'Bestand',
      email: 'paula.publikum@test.example',
      phone: '06131 000111',
    });
    const before = (await ctx.db.select().from(customers).where(eq(customers.id, existing.id)))[0]!;
    const result = await created(
      inquiryBody({
        contact: {
          type: 'private',
          firstName: 'Paula',
          lastName: 'Publikum',
          email: ' PAULA.Publikum@Test.Example ',
          phone: '0171 5550101',
        },
      }),
    );
    const process = await processByNumber(result.processNumber);
    expect(process.customerId).toBe(existing.id);
    expect(await countRows(ctx.pool, 'customers')).toBe(1);
    const after = (await ctx.db.select().from(customers).where(eq(customers.id, existing.id)))[0]!;
    expect(after).toEqual(before);
    const [submission] = await ctx.db
      .select()
      .from(publicInquirySubmissions)
      .where(eq(publicInquirySubmissions.processId, process.id));
    expect(submission!.customerMatch).toBe('email_unique');

    const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const hint = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${process.id}/website-submission`,
      headers: { cookie: session.cookie },
    });
    expect(hint.statusCode).toBe(200);
    expect(hint.json()).toEqual({
      submittedAt: result.receivedAt,
      customerMatch: 'email_unique',
      duplicateWarning: false,
      contactSnapshot: {
        type: 'private',
        firstName: 'Paula',
        lastName: 'Publikum',
        email: 'paula.publikum@test.example',
        phone: '0171 5550101',
      },
      differences: ['firstName', 'lastName', 'phone'],
      privacy: { acknowledgedAt: result.receivedAt, revisionNumber: 1 },
    });
  });

  it('PI10. Mehrere aktive Kunden mit derselben E-Mail ⇒ neuer Kunde + new_customer_email_ambiguous (Dublettenwarnung), nichts zusammengeführt; gelöschte Kunden zählen nicht', async () => {
    const email = 'gemeinsam@test.example';
    const a = await createTestCustomer(ctx, adminId, {
      firstName: 'Anna',
      lastName: 'Eins',
      email,
    });
    const b = await createTestCustomer(ctx, adminId, {
      firstName: 'Berta',
      lastName: 'Zwei',
      email,
    });
    const result = await created(
      inquiryBody({
        contact: { type: 'private', firstName: 'Clara', lastName: 'Drei', email },
      }),
    );
    const process = await processByNumber(result.processNumber);
    expect([a.id, b.id]).not.toContain(process.customerId);
    expect(await countRows(ctx.pool, 'customers')).toBe(3);
    const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const hint = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${process.id}/website-submission`,
      headers: { cookie: session.cookie },
    });
    expect(hint.json()).toMatchObject({
      customerMatch: 'new_customer_email_ambiguous',
      duplicateWarning: true,
      differences: [],
    });

    // Einer der beiden gelöscht ⇒ genau ein aktiver Treffer ⇒ email_unique.
    await ctx.db.update(customers).set({ deletedAt: new Date() }).where(eq(customers.id, a.id));
    const second = await created(
      inquiryBody({ contact: { type: 'private', firstName: 'Clara', lastName: 'Drei', email } }),
    );
    // Neuer Kunde aus dem ersten Lauf ist ebenfalls aktiv ⇒ wieder zwei aktive Treffer.
    const [secondSubmission] = await ctx.db
      .select()
      .from(publicInquirySubmissions)
      .where(
        eq(publicInquirySubmissions.processId, (await processByNumber(second.processNumber)).id),
      );
    expect(secondSubmission!.customerMatch).toBe('new_customer_email_ambiguous');
    await ctx.db.update(customers).set({ deletedAt: new Date() }).where(eq(customers.id, b.id));
    await ctx.db
      .update(customers)
      .set({ deletedAt: new Date() })
      .where(eq(customers.id, secondSubmission!.customerId));
    const third = await created(
      inquiryBody({ contact: { type: 'private', firstName: 'Clara', lastName: 'Drei', email } }),
    );
    const thirdProcess = await processByNumber(third.processNumber);
    expect(thirdProcess.customerId).toBe(process.customerId);
  });

  it('PI11. Gültige Portal-Session bindet genau diesen Kunden (auch bei anderer E-Mail), Stammdaten unverändert; ungültiges Cookie ⇒ anonym', async () => {
    const portalCustomer = await createTestCustomer(ctx, adminId, {
      firstName: 'Konto',
      lastName: 'Kundin',
      email: 'konto.kundin@test.example',
    });
    const before = (
      await ctx.db.select().from(customers).where(eq(customers.id, portalCustomer.id))
    )[0]!;
    const portal = await loginPortalCustomerSession(ctx, portalCustomer.id);
    const result = await created(inquiryBody(), { cookie: portal.cookie });
    const process = await processByNumber(result.processNumber);
    expect(process.customerId).toBe(portalCustomer.id);
    const after = (
      await ctx.db.select().from(customers).where(eq(customers.id, portalCustomer.id))
    )[0]!;
    expect(after).toEqual(before);
    const [submission] = await ctx.db
      .select()
      .from(publicInquirySubmissions)
      .where(eq(publicInquirySubmissions.processId, process.id));
    expect(submission!.customerMatch).toBe('portal_session');

    const bogus = await created(inquiryBody(), {
      cookie: `${portal.cookie.split('=')[0]}=${'A'.repeat(43)}`,
    });
    const anonymous = await processByNumber(bogus.processNumber);
    expect(anonymous.customerId).not.toBe(portalCustomer.id);
  });

  it('PI12. ≥ 250 Gäste ⇒ normale Anfrage (201), nur interner Hinweis', async () => {
    const result = await created(
      inquiryBody({ event: { date: berlinDateInDays(50), guests: 400, occasion: 'festival' } }),
    );
    const process = await processByNumber(result.processNumber);
    const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const inquiry = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${process.id}/inquiry`,
      headers: { cookie: session.cookie },
    });
    expect(inquiry.statusCode).toBe(200);
    expect(inquiry.json().inquiry.notes).toEqual([
      'Großveranstaltung – individuelles Angebot / persönliche Prüfung',
    ]);
  });

  it('PI13. Kein Verfügbarkeits-Reject: alle Maschinen des Typs gesperrt/außer Betrieb ⇒ trotzdem 201', async () => {
    const machineProductId = await productId('slush-1x8');
    const date = berlinDateInDays(15);
    try {
      const rows = await ctx.db
        .update(machines)
        .set({ status: 'out_of_service' })
        .where(eq(machines.productId, machineProductId))
        .returning({ id: machines.id });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        await ctx.db.insert(machineBlocks).values({
          machineId: row.id,
          startsAt: berlinDateTimeToUtc(date, 0, 0),
          endsAt: berlinDateTimeToUtc(date, 23, 59),
          reason: 'Test: komplett belegt',
          createdBy: adminId,
        });
      }
      await created(
        inquiryBody({
          event: { date, guests: 20, occasion: 'club' },
          machineSlug: 'slush-1x8',
          syrups: { free: [{ slug: 'sirup-kirsche', liters: 1 }], extra: [] },
        }),
      );
    } finally {
      await resetWarehouse(ctx.pool);
    }
  });

  it('PI14. Atomar: Fehler nach Kunden-/Vorgangsanlage ⇒ nichts gespeichert (kein Kunde, kein Vorgang, keine Anfrage)', async () => {
    await ctx.pool.query(`
      CREATE OR REPLACE FUNCTION phase16_test_fail_submission() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'test failure'; END; $$ LANGUAGE plpgsql`);
    await ctx.pool.query(`
      CREATE TRIGGER phase16_test_fail_submission BEFORE INSERT ON public_inquiry_submissions
      FOR EACH ROW EXECUTE FUNCTION phase16_test_fail_submission()`);
    try {
      const response = await postInquiry(ctx, inquiryBody());
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('INTERNAL_ERROR');
      expect(await countRows(ctx.pool, 'customers')).toBe(0);
      expect(await countRows(ctx.pool, 'processes')).toBe(0);
      expect(await countRows(ctx.pool, 'inquiries')).toBe(0);
      expect(await countRows(ctx.pool, 'inquiry_selections')).toBe(0);
    } finally {
      await ctx.pool.query(
        'DROP TRIGGER IF EXISTS phase16_test_fail_submission ON public_inquiry_submissions',
      );
      await ctx.pool.query('DROP FUNCTION IF EXISTS phase16_test_fail_submission()');
    }
    expect((await postInquiry(ctx, inquiryBody())).statusCode).toBe(201);
  });

  it('PI15. Server prüft alles erneut: Vergangenheit, unbekannte/inaktive Maschine, Gratis-Kontingent, Kanisterlimit, Datenschutz-Haken, unbekannte Felder ⇒ 400 mit Feldpfad, ohne Werte; nichts gespeichert', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        inquiryBody({ event: { date: berlinDateInDays(-1), guests: 10, occasion: 'party' } }),
        'body.event.date',
      ],
      [
        inquiryBody({ event: { date: '2027-02-31', guests: 10, occasion: 'party' } }),
        'body.event.date',
      ],
      [inquiryBody({ machineSlug: 'gibt-es-nicht' }), 'body.machineSlug'],
      [
        inquiryBody({ syrups: { free: [{ slug: 'sirup-kirsche', liters: 3 }], extra: [] } }),
        'body.syrups.free',
      ],
      [inquiryBody({ canisters: 5 }), 'body.canisters'],
      [
        inquiryBody({ syrups: { free: [{ slug: 'becher-25', liters: 1 }], extra: [] } }),
        'body.syrups.free.0.slug',
      ],
      [inquiryBody({ privacyAcknowledged: false }), 'body.privacyAcknowledged'],
      [inquiryBody({ priceCents: 1 }), 'body'],
      [
        inquiryBody({
          contact: { type: 'private', firstName: 'A', lastName: 'B', email: 'kein-at' },
        }),
        'body.contact.email',
      ],
      [
        inquiryBody({
          fulfillment: { type: 'delivery', street: 'X 1', postalCode: '5511', city: 'Mainz' },
        }),
        'body.fulfillment.postalCode',
      ],
    ];
    for (const [body, path] of cases) {
      const response = await postInquiry(ctx, body);
      expect(response.statusCode, path).toBe(400);
      const error = response.json().error;
      expect(error.code, path).toBe('VALIDATION_ERROR');
      expect(
        (error.issues as Array<{ path: string }>).some(
          (issue) =>
            issue.path === path ||
            issue.path.startsWith(`${path}.`) ||
            (path === 'body' && issue.path === 'body'),
        ),
        `${path}: ${JSON.stringify(error.issues)}`,
      ).toBe(true);
      expect(response.body).not.toContain('paula.publikum');
      expect(response.body).not.toContain('kein-at');
    }
    // Deaktivierte Maschine ⇒ ebenfalls 400.
    await ctx.db.update(products).set({ active: false }).where(eq(products.slug, 'slush-2x10'));
    const inactive = await postInquiry(ctx, inquiryBody());
    expect(inactive.statusCode).toBe(400);
    expect(await countRows(ctx.pool, 'processes')).toBe(0);
    expect(await countRows(ctx.pool, 'customers')).toBe(0);
  });

  it('PI16. Keine PII im Log (E-Mail, Telefon, Namen, Straße) – weder bei Erfolg noch bei Fehlern', async () => {
    const pii = {
      firstName: 'Lieselotte',
      lastName: 'Logfrei',
      email: 'lieselotte.logfrei@test.example',
      phone: '0151 98765432',
      street: 'Geheimgasse 77',
    };
    logBuffer = '';
    const body = inquiryBody({
      contact: {
        type: 'private',
        firstName: pii.firstName,
        lastName: pii.lastName,
        email: pii.email,
        phone: pii.phone,
      },
      fulfillment: { type: 'delivery', street: pii.street, postalCode: '55122', city: 'Mainz' },
    });
    await created(body);
    await postInquiry(ctx, body); // Wiederholung
    await postInquiry(ctx, { ...body, event: { ...body.event, guests: 1 } }); // 409
    await postInquiry(ctx, { ...body, clientMutationId: randomUUID(), canisters: 99 }); // 400
    await postInquiry(ctx, { ...body, clientMutationId: 'keine-uuid' }); // 400
    expect(logBuffer.length).toBeGreaterThan(0); // Log-Sink ist aktiv (Request-Logs)
    for (const value of Object.values(pii)) {
      expect(logBuffer).not.toContain(value);
    }
    expect(logBuffer).not.toContain('lieselotte');
  });

  it('PI17. Cross-Site-POST ⇒ 403 CSRF_REJECTED (nichts gespeichert); keine CORS-Header', async () => {
    const crossSite = await postInquiry(ctx, inquiryBody(), {
      'sec-fetch-site': 'cross-site',
      origin: 'https://evil.example',
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json().error.code).toBe('CSRF_REJECTED');
    const sameSite = await postInquiry(ctx, inquiryBody(), { 'sec-fetch-site': 'same-site' });
    expect(sameSite.statusCode).toBe(403);
    expect(await countRows(ctx.pool, 'processes')).toBe(0);
    const ok = await postInquiry(ctx, inquiryBody(), { 'sec-fetch-site': 'same-origin' });
    expect(ok.statusCode).toBe(201);
    expect(ok.headers['access-control-allow-origin']).toBeUndefined();
    expect(ok.headers['cache-control']).toBe('no-store');
  });

  it('PI18. Staff-Hinweis: Recht wie die Inquiry-Ansicht (inquiry.view + process.view_all), 404 ohne Website-Anfrage', async () => {
    const result = await created(inquiryBody());
    const process = await processByNumber(result.processNumber);
    const viewer = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Vera',
      lastName: 'Viewer',
      email: 'vera.viewer@test.example',
      password: 'viewer-passwort-123',
      permissionKeys: ['inquiry.view', 'process.view_all'],
    });
    const noInquiry = await createStaffWithPermissions(ctx, adminId, {
      firstName: 'Nora',
      lastName: 'Ohne',
      email: 'nora.ohne@test.example',
      password: 'viewer-passwort-123',
      permissionKeys: ['process.view_all'],
    });
    const url = `/staff/processes/${process.id}/website-submission`;
    const allowed = await ctx.app.inject({
      method: 'GET',
      url,
      headers: { cookie: viewer.cookie },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().customerMatch).toBe('new_customer');
    const denied = await ctx.app.inject({
      method: 'GET',
      url,
      headers: { cookie: noInquiry.cookie },
    });
    expect(denied.statusCode).toBe(403);
    const anonymous = await ctx.app.inject({ method: 'GET', url });
    expect(anonymous.statusCode).toBe(401);
    // Vorgang ohne Website-Anfrage (Staff-Anlage) ⇒ 404.
    const customer = await createTestCustomer(ctx, adminId);
    const staffProcess = await processServiceFor(ctx).createProcess(adminId, {
      customerId: customer.id,
    });
    expect(staffProcess.createdBy).toBe(adminId); // Staff-Pfad unverändert
    expect(staffProcess.source).toBe('staff_manual');
    const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
    const none = await ctx.app.inject({
      method: 'GET',
      url: `/staff/processes/${staffProcess.id}/website-submission`,
      headers: { cookie: session.cookie },
    });
    expect(none.statusCode).toBe(404);
  });

  it('PI19. Submission-Zeile unveränderlich (UPDATE verboten), Löschen bleibt dem Demo-Reset vorbehalten', async () => {
    await created(inquiryBody());
    await expect(
      ctx.pool.query(`UPDATE public_inquiry_submissions SET customer_match = 'new_customer'`),
    ).rejects.toThrow(/unveränderlich/);
  });

  it('PI21. Wiederholung nach Mitternacht (Eventdatum inzwischen vergangen): gleiche ID + gleicher Inhalt ⇒ 200 mit denselben Werten, anderer Inhalt ⇒ 409; neue ID ⇒ 400 (Review inquiry-1)', async () => {
    const eventDate = berlinDateInDays(10);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(berlinDateTimeToUtc(eventDate, 23, 59));
    const body = inquiryBody({
      event: {
        date: eventDate,
        startTime: '18:00',
        endTime: '23:30',
        guests: 40,
        occasion: 'party',
      },
    });
    const first = await created(body);
    // Antwort ging verloren; „Erneut senden“ erst nach Mitternacht (Berlin).
    vi.setSystemTime(berlinDateTimeToUtc(dayAfter(eventDate), 0, 1));
    const retry = await postInquiry(ctx, body);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json()).toEqual(first);
    const changed = await postInquiry(ctx, { ...body, event: { ...body.event, guests: 41 } });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toMatchObject({
      code: 'PUBLIC_INQUIRY_CONFLICT',
      processNumber: first.processNumber,
    });
    // Eine NEUE Anfrage mit dem inzwischen vergangenen Datum bleibt abgelehnt.
    const fresh = await postInquiry(ctx, { ...body, clientMutationId: randomUUID() });
    expect(fresh.statusCode).toBe(400);
    expect(fresh.json().error.issues).toEqual([
      { path: 'body.event.date', message: 'Das Datum darf nicht in der Vergangenheit liegen.' },
    ]);
    expect(await countRows(ctx.pool, 'processes')).toBe(1);
    expect(await countRows(ctx.pool, 'public_inquiry_submissions')).toBe(1);
  });

  it('PI22. Uhrzeit in der Sommerzeit-Lücke (28.03.2027, 02:00–02:59) ⇒ 400 am jeweiligen Feld, ohne Werte; gespeichertes Ende liegt immer nach dem Beginn (Review inquiry-2)', async () => {
    const gap = '2027-03-28';
    const cases: Array<[Record<string, unknown>, Record<string, unknown>, string[]]> = [
      [
        { date: gap, startTime: '02:30', endTime: '03:15' },
        { type: 'pickup' },
        ['body.event.startTime'],
      ],
      [
        { date: gap, startTime: '01:00', endTime: '02:15' },
        { type: 'pickup' },
        ['body.event.endTime'],
      ],
      // Ende ≤ Beginn ⇒ Folgetag – und der Folgetag ist der Umstellungstag.
      [
        { date: '2027-03-27', startTime: '22:00', endTime: '02:30' },
        { type: 'pickup' },
        ['body.event.endTime'],
      ],
      [
        { date: gap },
        {
          type: 'delivery',
          street: 'Musterweg 12',
          postalCode: '55116',
          city: 'Mainz',
          windowFrom: '02:00',
          windowTo: '02:45',
        },
        ['body.fulfillment.windowFrom', 'body.fulfillment.windowTo'],
      ],
    ];
    for (const [event, fulfillment, paths] of cases) {
      const response = await postInquiry(
        ctx,
        inquiryBody({ event: { guests: 30, occasion: 'party', ...event }, fulfillment }),
      );
      expect(response.statusCode, JSON.stringify(event)).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
      expect(response.json().error.issues).toEqual(
        paths.map((path) => ({ path, message: NONEXISTENT_LOCAL_TIME_MESSAGE })),
      );
      expect(response.body).not.toContain('02:');
    }
    expect(await countRows(ctx.pool, 'processes')).toBe(0);

    // Gültig am Umstellungstag: 01:30–03:15 (real 45 Minuten).
    const spring = await created(
      inquiryBody({
        event: { date: gap, startTime: '01:30', endTime: '03:15', guests: 30, occasion: 'party' },
      }),
    );
    // Rückstellung 31.10.2027: 02:30–02:10 ⇒ Ende am Folgetag, positiv.
    const autumn = await created(
      inquiryBody({
        event: {
          date: '2027-10-31',
          startTime: '02:30',
          endTime: '02:10',
          guests: 30,
          occasion: 'party',
        },
      }),
    );
    for (const result of [spring, autumn]) {
      const [inquiry] = await ctx.db
        .select()
        .from(inquiries)
        .where(eq(inquiries.processId, (await processByNumber(result.processNumber)).id));
      expect(inquiry!.eventEnd!.getTime()).toBeGreaterThan(inquiry!.eventStart!.getTime());
    }
    const [springInquiry] = await ctx.db
      .select()
      .from(inquiries)
      .where(eq(inquiries.processId, (await processByNumber(spring.processNumber)).id));
    expect(springInquiry!.eventStart!.toISOString()).toBe('2027-03-28T00:30:00.000Z');
    expect(springInquiry!.eventEnd!.toISOString()).toBe('2027-03-28T01:15:00.000Z');
  });

  it('PI23. Wunsch-Lieferzeitfenster am Veranstaltungstag: Ende ≤ Beginn ⇒ 400 an body.fulfillment.windowTo (keine Folgetag-Regel); nur Ende ⇒ am Eventdatum gespeichert (Review inquiry-3)', async () => {
    const date = berlinDateInDays(25);
    const delivery = {
      type: 'delivery',
      street: 'Musterweg 12',
      postalCode: '55116',
      city: 'Mainz',
    };
    for (const [windowFrom, windowTo] of [
      ['16:00', '10:00'],
      ['10:00', '10:00'],
    ]) {
      const response = await postInquiry(
        ctx,
        inquiryBody({ fulfillment: { ...delivery, windowFrom, windowTo } }),
      );
      expect(response.statusCode, `${windowFrom}-${windowTo}`).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
      expect(response.json().error.issues).toEqual([
        { path: 'body.fulfillment.windowTo', message: DELIVERY_WINDOW_ORDER_MESSAGE },
      ]);
      expect(response.body).not.toContain(windowFrom);
      expect(response.body).not.toContain('Musterweg');
    }
    expect(await countRows(ctx.pool, 'processes')).toBe(0);
    // Veranstaltungszeiten behalten die Folgetag-Regel (PI3); Lieferfenster nur „bis“.
    const onlyEnd = await created(
      inquiryBody({
        event: { date, startTime: '20:00', endTime: '01:00', guests: 30, occasion: 'party' },
        fulfillment: { ...delivery, windowTo: '12:00' },
      }),
    );
    const [inquiry] = await ctx.db
      .select()
      .from(inquiries)
      .where(eq(inquiries.processId, (await processByNumber(onlyEnd.processNumber)).id));
    expect(inquiry!.deliveryWindowFrom).toBeNull();
    expect(inquiry!.deliveryWindowTo?.toISOString()).toBe(
      berlinDateTimeToUtc(date, 12, 0).toISOString(),
    );
    expect(inquiry!.eventEnd?.toISOString()).toBe(
      berlinDateTimeToUtc(dayAfter(date), 1, 0).toISOString(),
    );
  });

  it('PI24. Maschinen-Slug als Sirup ⇒ 400 am Sirupfeld (nicht body.machineSlug), nichts gespeichert (Review pricing-4)', async () => {
    for (const role of ['free', 'extra'] as const) {
      const syrups = { free: [], extra: [], [role]: [{ slug: 'slush-2x10', liters: 1 }] };
      const response = await postInquiry(ctx, inquiryBody({ syrups }));
      expect(response.statusCode, role).toBe(400);
      expect(response.json().error.issues).toEqual([
        {
          path: `body.syrups.${role}.0.slug`,
          message: 'Diese Sirupsorte ist gerade nicht wählbar.',
        },
      ]);
    }
    expect(await countRows(ctx.pool, 'processes')).toBe(0);
  });
});

describe('Phase 16 – Rate-Limit der Website-Anfrage', () => {
  it('PI20. 5 Anfragen je Minute und IP, die sechste ⇒ 429', async () => {
    const limited = await createTestContext({ rateLimitEnabled: true });
    try {
      await resetPublicWorld(limited.pool);
      await publishPrivacyForTests(limited.db);
      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push((await postInquiry(limited, inquiryBody())).statusCode);
      }
      expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
      expect(statuses[5]).toBe(429);
    } finally {
      await destroyTestContext(limited);
    }
  });
});
