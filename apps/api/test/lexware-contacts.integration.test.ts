/**
 * Phase-10-Pflichttests Kontakte 25–37 und Rechnungsadresse 38–42 (Order
 * §§16–20, §33, §58; Vertrag §5): Privat/Firma, USt-ID nur wenn vorhanden,
 * Mapping, Wiederverwendung, Aktualisierung aus dem Kundenstamm, Snapshot
 * überschreibt nicht, starke Identität, Mehrdeutigkeit blockiert, kein
 * Auto-Merge, paralleles Create, Timeout-Recovery, fremde Organisation.
 */
import { lexwareContactMappings } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ContactSyncService } from '../src/lexware/contact-sync-service.ts';
import {
  buildInvoiceBody,
  buildProviderSnapshot,
  transferMarkerFor,
} from '../src/lexware/invoice-builder.ts';
import type { AccountingPayload } from '../src/accounting/gateway.ts';
import { CustomerService } from '../src/crm/customer-service.ts';
import { createTestContext, destroyTestContext, type TestContext } from './auth-helpers.ts';
import { createStaffWithPermissions, createTestCustomer } from './crm-helpers.ts';
import {
  failNext,
  fakeRequests,
  jsonGet,
  jsonPost,
  readyLexware,
  resetLexwareWorld,
  taxConfigFor,
  transferRowForSettlement,
} from './lexware-test-helpers.ts';
import { adminSession, settledReturn, settlementViewFor } from './settlement-helpers.ts';

let ctx: TestContext;
let contacts: ContactSyncService;
let orgId: string;

beforeAll(async () => {
  ctx = await createTestContext({ lexware: true });
  contacts = ctx.transfersFor().lexwareDeps!.contacts;
  orgId = ctx.lexwareFake!.organizationId;
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await resetLexwareWorld(ctx);
});

async function mappingOf(customerId: string) {
  const rows = await ctx.db
    .select()
    .from(lexwareContactMappings)
    .where(eq(lexwareContactMappings.customerId, customerId));
  return rows[0] ?? null;
}

interface ContactView {
  mapping: {
    lexwareContactId: string | null;
    status: string;
    contactVersion: number | null;
  } | null;
  candidates: { contactId: string; displayName: string; reason: string }[];
  deeplink: string | null;
}

describe('Kontakt anlegen/verknüpfen (Tests 25–37)', () => {
  it('25./28. Privatkunde ⇒ person-Kontakt über POST /v1/contacts, Mapping linked mit Version und Organisation', async () => {
    const { admin } = await adminSession(ctx);
    const customer = await createTestCustomer(ctx, admin.id, {
      firstName: 'Paula',
      lastName: 'Privat',
      email: 'Paula.Privat@test.example',
      phone: '0171 1234567',
    });
    const result = await contacts.resolveForTransfer(customer.id, orgId);
    expect(result.status).toBe('created');
    const body = ctx.lexwareFake!.lastContactBody as Record<string, unknown>;
    expect(body).toMatchObject({
      version: 0,
      roles: { customer: {} },
      person: { firstName: 'Paula', lastName: 'Privat' },
      emailAddresses: { business: ['paula.privat@test.example'] },
      phoneNumbers: { business: ['0171 1234567'] },
    });
    expect(body.company).toBeUndefined();
    expect(body.addresses).toBeUndefined();
    const mapping = await mappingOf(customer.id);
    expect(mapping).toMatchObject({
      syncStatus: 'linked',
      organizationId: orgId,
      contactVersion: 1,
    });
    expect(mapping!.lexwareContactId).toBeTruthy();
    expect(ctx.lexwareFake!.contacts.size).toBe(1);
  });

  it('26./27. Firma ⇒ company-Kontakt mit Ansprechpartner und Adresse; vatRegistrationId nur wenn USt-ID vorhanden', async () => {
    const { admin } = await adminSession(ctx);
    const service = new CustomerService(ctx.db);
    const firma = await createTestCustomer(ctx, admin.id, {
      type: 'organization',
      organizationName: 'Eventwerk GmbH',
      email: 'buchhaltung@eventwerk.example',
    });
    await service.updateCustomer(admin.id, firma.id, {
      type: 'organization',
      organizationName: 'Eventwerk GmbH',
      contactPerson: 'Frau Meier',
      email: 'buchhaltung@eventwerk.example',
      billingStreet: 'Industriestr. 5',
      billingPostalCode: '55120',
      billingCity: 'Mainz',
    });
    expect((await contacts.resolveForTransfer(firma.id, orgId)).status).toBe('created');
    let body = ctx.lexwareFake!.lastContactBody as Record<string, unknown>;
    expect(body).toMatchObject({
      company: { name: 'Eventwerk GmbH', contactPersons: [{ lastName: 'Frau Meier' }] },
      addresses: {
        billing: [{ street: 'Industriestr. 5', zip: '55120', city: 'Mainz', countryCode: 'DE' }],
      },
    });
    expect((body.company as Record<string, unknown>).vatRegistrationId).toBeUndefined();
    expect(body.person).toBeUndefined();

    const mitUst = await createTestCustomer(ctx, admin.id, {
      type: 'organization',
      organizationName: 'Steuer AG',
      email: 'rechnung@steuer-ag.example',
    });
    await service.updateCustomer(admin.id, mitUst.id, {
      type: 'organization',
      organizationName: 'Steuer AG',
      email: 'rechnung@steuer-ag.example',
      vatId: 'DE123456789',
    });
    expect((await contacts.resolveForTransfer(mitUst.id, orgId)).status).toBe('created');
    body = ctx.lexwareFake!.lastContactBody as Record<string, unknown>;
    expect(body.company).toMatchObject({ name: 'Steuer AG', vatRegistrationId: 'DE123456789' });
    expect((body.company as Record<string, unknown>).contactPersons).toBeUndefined();
  });

  it('29./30. Zweiter Lauf nutzt das Mapping (kein zweiter Create); Kundenstamm-Änderung ⇒ PUT mit Version, unverändert ⇒ kein PUT', async () => {
    const { admin } = await adminSession(ctx);
    const customer = await createTestCustomer(ctx, admin.id, {
      firstName: 'Rita',
      lastName: 'Reuse',
      email: 'rita.reuse@test.example',
    });
    const first = await contacts.resolveForTransfer(customer.id, orgId);
    expect(first.status).toBe('created');
    const second = await contacts.resolveForTransfer(customer.id, orgId);
    expect(second.status).toBe('linked');
    expect(fakeRequests(ctx, 'POST', '/v1/contacts')).toHaveLength(1);
    expect(fakeRequests(ctx, 'PUT', '/v1/contacts')).toHaveLength(0);
    expect(ctx.lexwareFake!.contacts.size).toBe(1);

    await new CustomerService(ctx.db).updateCustomer(admin.id, customer.id, {
      type: 'private',
      firstName: 'Rita',
      lastName: 'Reuse-Neu',
      email: 'rita.reuse@test.example',
      billingStreet: 'Neue Str. 1',
      billingPostalCode: '55116',
      billingCity: 'Mainz',
    });
    const third = await contacts.resolveForTransfer(customer.id, orgId);
    expect(third.status).toBe('linked');
    expect(fakeRequests(ctx, 'PUT', '/v1/contacts')).toHaveLength(1);
    const contact = [...ctx.lexwareFake!.contacts.values()][0]!;
    expect(contact.person?.lastName).toBe('Reuse-Neu');
    expect(contact.addresses?.billing?.[0]?.street).toBe('Neue Str. 1');
    expect(contact.version).toBe(2);
    expect((await mappingOf(customer.id))!.contactVersion).toBe(2);
    // Unverändert ⇒ Hash gleich ⇒ kein weiterer PUT.
    await contacts.resolveForTransfer(customer.id, orgId);
    expect(fakeRequests(ctx, 'PUT', '/v1/contacts')).toHaveLength(1);
  });

  it('32. Eindeutige starke Übereinstimmung (E-Mail + Name) ⇒ vorhandener Kontakt verknüpft, kein Create', async () => {
    const { admin } = await adminSession(ctx);
    const seeded = ctx.lexwareFake!.seedContact({
      person: { firstName: 'Klara', lastName: 'Kommerz' },
      email: 'KLARA.kommerz@test.example',
      version: 3,
    });
    const customer = await createTestCustomer(ctx, admin.id, {
      firstName: 'Klara',
      lastName: 'Kommerz',
      email: 'klara.kommerz@test.example',
    });
    const result = await contacts.resolveForTransfer(customer.id, orgId);
    expect(result.status).toBe('linked');
    expect(result.status === 'linked' && result.lexwareContactId).toBe(seeded.id);
    expect(fakeRequests(ctx, 'POST', '/v1/contacts')).toHaveLength(0);
    expect((await mappingOf(customer.id))!.lexwareContactId).toBe(seeded.id);
  });

  it('33./34. Mehrere Kandidaten bzw. E-Mail ohne Namensübereinstimmung ⇒ review_required, kein Merge, kein Create', async () => {
    const { admin } = await adminSession(ctx);
    ctx.lexwareFake!.seedContact({
      person: { firstName: 'Klara', lastName: 'Kommerz' },
      email: 'klara.kommerz@test.example',
    });
    ctx.lexwareFake!.seedContact({
      person: { firstName: 'Klara', lastName: 'Kommerz' },
      email: 'klara.kommerz@test.example',
    });
    const zweideutig = await createTestCustomer(ctx, admin.id, {
      firstName: 'Klara',
      lastName: 'Kommerz',
      email: 'klara.kommerz@test.example',
    });
    const result = await contacts.resolveForTransfer(zweideutig.id, orgId);
    expect(result.status).toBe('review_required');
    expect(result.status === 'review_required' && result.candidates).toHaveLength(2);
    expect(await mappingOf(zweideutig.id)).toMatchObject({
      syncStatus: 'review_required',
      lexwareContactId: null,
    });

    ctx.lexwareFake!.seedContact({
      person: { firstName: 'Otto', lastName: 'Anders' },
      email: 'shared@test.example',
    });
    const widerspruch = await createTestCustomer(ctx, admin.id, {
      firstName: 'Nina',
      lastName: 'Neu',
      email: 'shared@test.example',
    });
    const second = await contacts.resolveForTransfer(widerspruch.id, orgId);
    expect(second.status).toBe('review_required');
    expect(second.status === 'review_required' && second.candidates[0]?.reason).toBe('email');
    expect(fakeRequests(ctx, 'POST', '/v1/contacts')).toHaveLength(0);
    expect(ctx.lexwareFake!.contacts.size).toBe(3);
  });

  it('35. Paralleles Create für denselben Kunden ⇒ genau ein Lexware-Kontakt, ein Mapping', async () => {
    const { admin } = await adminSession(ctx);
    const customer = await createTestCustomer(ctx, admin.id, {
      firstName: 'Para',
      lastName: 'Llel',
      email: 'para.llel@test.example',
    });
    const other = ctx.transfersFor('worker-2').lexwareDeps!.contacts;
    const results = await Promise.all([
      contacts.resolveForTransfer(customer.id, orgId),
      other.resolveForTransfer(customer.id, orgId),
      contacts.resolveForTransfer(customer.id, orgId),
    ]);
    expect(ctx.lexwareFake!.contacts.size).toBe(1);
    expect(fakeRequests(ctx, 'POST', '/v1/contacts')).toHaveLength(1);
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 'created')).toHaveLength(1);
    expect(statuses.every((s) => s === 'created' || s === 'in_progress' || s === 'linked')).toBe(
      true,
    );
    const mapping = await mappingOf(customer.id);
    expect(mapping!.syncStatus).toBe('linked');
    // Danach: alle sehen das Mapping.
    expect((await other.resolveForTransfer(customer.id, orgId)).status).toBe('linked');
  });

  it('36. Timeout nach dem Contact-Create ⇒ create_unknown; nächster Lauf findet den Kontakt exakt und verbindet (kein Duplikat)', async () => {
    const { admin } = await adminSession(ctx);
    const customer = await createTestCustomer(ctx, admin.id, {
      firstName: 'Tim',
      lastName: 'Timeout',
      email: 'tim.timeout@test.example',
    });
    await failNext(ctx, { match: '^POST /v1/contacts$', mode: 'after_create' });
    const first = await contacts.resolveForTransfer(customer.id, orgId);
    expect(first.status).toBe('create_unknown');
    expect(await mappingOf(customer.id)).toMatchObject({
      syncStatus: 'create_unknown',
      lexwareContactId: null,
    });
    expect(ctx.lexwareFake!.contacts.size).toBe(1);
    const second = await contacts.resolveForTransfer(customer.id, orgId);
    expect(second.status).toBe('linked');
    expect(ctx.lexwareFake!.contacts.size).toBe(1);
    // Der verschluckte Create wird vom Fake nicht protokolliert; danach keine weitere Anlage.
    expect(fakeRequests(ctx, 'POST', '/v1/contacts')).toHaveLength(0);
    expect((await mappingOf(customer.id))!.syncStatus).toBe('linked');
  });

  it('37. Kontakt einer fremden Organisation wird nie verknüpft (Auto-Suche und manuelles Link)', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const foreign = ctx.lexwareFake!.seedContact({
      person: { firstName: 'Fremd', lastName: 'Org' },
      email: 'fremd.org@test.example',
    });
    foreign.organizationId = 'andere-organisation';
    const customer = await createTestCustomer(ctx, admin.id, {
      firstName: 'Fremd',
      lastName: 'Org',
      email: 'fremd.org@test.example',
    });
    const result = await contacts.resolveForTransfer(customer.id, orgId);
    expect(result.status).toBe('created');
    expect(result.status === 'created' && result.lexwareContactId).not.toBe(foreign.id);
    const link = await jsonPost<{ error: { code: string } }>(
      ctx.app,
      cookie,
      `/staff/customers/${customer.id}/lexware-contact/link`,
      { lexwareContactId: foreign.id },
    );
    expect(link.status).toBe(409);
    expect(link.body.error.code).toBe('CONTACT_ORGANIZATION_MISMATCH');
  });
});

describe('Klärungsrouten und Blocker', () => {
  it('Mehrdeutiger Kontakt blockiert den Transfer (CONTACT_REVIEW_REQUIRED); Admin wählt Kandidat ⇒ Retry gelingt', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const a = ctx.lexwareFake!.seedContact({
      person: { firstName: 'Klara', lastName: 'Kommerz' },
      email: 'klara.kommerz@test.example',
    });
    ctx.lexwareFake!.seedContact({
      person: { firstName: 'Klara', lastName: 'Kommerz' },
      email: 'klara.kommerz@test.example',
    });
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    expect(await ctx.jobs.runOnce()).toBe('processed');
    let current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.status).toBe('transfer_failed');
    expect(current.settlement.lastTransferErrorCode).toBe('CONTACT_REVIEW_REQUIRED');
    expect(current.settlement.accounting.blockers.map((b) => b.code)).toEqual([
      'CONTACT_REVIEW_REQUIRED',
    ]);
    expect(current.settlement.accounting.blockers[0]?.label).toBe('Lexware-Kontakt prüfen');
    expect(current.settlement.customerId).toBe(world.customerId);
    expect(fakeRequests(ctx, 'POST', '/v1/invoices')).toHaveLength(0);

    const contactView = await jsonGet<ContactView>(
      ctx.app,
      cookie,
      `/staff/customers/${world.customerId}/lexware-contact`,
    );
    expect(contactView.status).toBe(200);
    expect(contactView.body.mapping?.status).toBe('review_required');
    expect(contactView.body.candidates).toHaveLength(2);
    expect(contactView.body.deeplink).toBeNull();

    const linked = await jsonPost<ContactView>(
      ctx.app,
      cookie,
      `/staff/customers/${world.customerId}/lexware-contact/link`,
      { lexwareContactId: a.id },
    );
    expect(linked.status).toBe(200);
    expect(linked.body.mapping).toMatchObject({ status: 'linked', lexwareContactId: a.id });
    expect(linked.body.deeplink).toBe(`https://app.lexware.de/permalink/contacts/view/${a.id}`);
    // Zweiter Kunde mit demselben Kontakt ⇒ 409 CONTACT_ALREADY_MAPPED.
    const other = await createTestCustomer(ctx, admin.id, { email: 'other@test.example' });
    const conflict = await jsonPost<{ error: { code: string } }>(
      ctx.app,
      cookie,
      `/staff/customers/${other.id}/lexware-contact/link`,
      { lexwareContactId: a.id },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('CONTACT_ALREADY_MAPPED');

    current = await settlementViewFor(ctx.app, cookie, world.processId);
    expect(current.settlement.accounting.blockers).toEqual([]);
    expect(current.settlement.accounting.canRetry).toBe(true);
    const retry = await jsonPost<{ outcome: string }>(
      ctx.app,
      cookie,
      `/staff/settlements/${view.settlement.id}/transfer`,
      { version: current.settlement.version },
    );
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe('succeeded');
    expect(ctx.lexwareFake!.contacts.size).toBe(2);
    const invoice = [...ctx.lexwareFake!.invoices.values()][0]!;
    expect(invoice.address.contactId).toBe(a.id);
  });

  it('Create-Route legt neuen Kontakt an; bereits verknüpft ⇒ 409; unsichtbarer Kunde ⇒ 404; nur system.settings', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const customer = await createTestCustomer(ctx, admin.id, {
      firstName: 'Neu',
      lastName: 'Anlage',
      email: 'neu.anlage@test.example',
    });
    const created = await jsonPost<ContactView>(
      ctx.app,
      cookie,
      `/staff/customers/${customer.id}/lexware-contact/create`,
    );
    expect(created.status).toBe(200);
    expect(created.body.mapping?.status).toBe('linked');
    const again = await jsonPost<{ error: { code: string } }>(
      ctx.app,
      cookie,
      `/staff/customers/${customer.id}/lexware-contact/create`,
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONTACT_ALREADY_LINKED');

    await new CustomerService(ctx.db).moveToTrash(admin.id, customer.id);
    const gone = await jsonGet<{ error: { code: string } }>(
      ctx.app,
      cookie,
      `/staff/customers/${customer.id}/lexware-contact`,
    );
    expect(gone.status).toBe(404);

    const viewer = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Leser',
      lastName: 'Nur',
      email: 'leser@test.example',
      password: 'leser-passwort-12345',
      permissionKeys: ['settlement.view'],
    });
    const other = await createTestCustomer(ctx, admin.id, { email: 'zwei@test.example' });
    const readable = await jsonGet<ContactView>(
      ctx.app,
      viewer.cookie,
      `/staff/customers/${other.id}/lexware-contact`,
    );
    expect(readable.status).toBe(200);
    expect(readable.body.mapping).toBeNull();
    const forbidden = await jsonPost<{ error: { code: string } }>(
      ctx.app,
      viewer.cookie,
      `/staff/customers/${other.id}/lexware-contact/create`,
    );
    expect(forbidden.status).toBe(403);
  });
});

describe('Rechnungsadresse aus dem Snapshot (Tests 38–42)', () => {
  it('38./39./40. Beleg trägt contactId + Adresse aus dem eingefrorenen Snapshot; fehlende Straße wird weggelassen', async () => {
    const { admin } = await adminSession(ctx);
    await taxConfigFor(ctx).applySyntheticDefaults(admin.id);
    const tax = await taxConfigFor(ctx).load();
    const payload: AccountingPayload = {
      schemaVersion: 1,
      kind: 'settlement',
      sourceId: '00000000-0000-0000-0000-000000000001',
      processId: '00000000-0000-0000-0000-000000000002',
      processNumber: 'MR-2026-0001',
      bookingId: '00000000-0000-0000-0000-000000000003',
      eventDate: '2026-11-01',
      customer: {
        customerId: '00000000-0000-0000-0000-000000000004',
        displayName: 'Kommerz, Klara',
        companyName: null,
        email: 'klara.kommerz@test.example',
        billingAddress: { street: 'Alte Str. 9', postalCode: '55116', city: 'Mainz' },
      },
      lines: [
        {
          id: 'l1',
          type: 'machine_rental',
          description: 'Slush 2×10 l',
          quantity: 1,
          unit: 'Stück',
          unitPriceCents: 7500,
          amountCents: 7500,
          direction: 'charge',
        },
      ],
      totals: { chargesCents: 7500, creditsCents: 0, amountDueCents: 7500, overpaymentCents: 0 },
      tax: null,
      idempotencyKey: 'settlement-transfer:00000000-0000-0000-0000-000000000001',
      createdAt: '2026-10-17T10:00:00.000Z',
    };
    const snapshot = buildProviderSnapshot({
      payload,
      taxConfig: tax,
      transferMarker: transferMarkerFor(payload.idempotencyKey),
      now: new Date('2026-10-17T10:00:00.000Z'),
    });
    const body = buildInvoiceBody(snapshot, payload, 'c0ffee00-0000-4000-8000-000000000000');
    expect(body.address).toEqual({
      contactId: 'c0ffee00-0000-4000-8000-000000000000',
      name: 'Kommerz, Klara',
      street: 'Alte Str. 9',
      zip: '55116',
      city: 'Mainz',
      countryCode: 'DE',
    });
    const ohneStrasse = buildInvoiceBody(
      buildProviderSnapshot({
        payload: {
          ...payload,
          customer: {
            ...payload.customer,
            companyName: 'Eventwerk GmbH',
            billingAddress: { street: null, postalCode: null, city: 'Mainz' },
          },
        },
        taxConfig: tax,
        transferMarker: snapshot.transferMarker,
        now: new Date('2026-10-17T10:00:00.000Z'),
      }),
      payload,
      'c0ffee00-0000-4000-8000-000000000000',
    );
    expect(ohneStrasse.address).toEqual({
      contactId: 'c0ffee00-0000-4000-8000-000000000000',
      name: 'Eventwerk GmbH',
      city: 'Mainz',
      countryCode: 'DE',
    });
  });

  it('41./42. Kundenänderung nach der Buchung: Kontakt wird aktualisiert, die Rechnung trägt die eingefrorenen Daten; spätere Änderung ändert alte Belege nicht', async () => {
    const { admin, cookie } = await adminSession(ctx);
    await readyLexware(ctx, admin.id);
    const { world, view } = await settledReturn(ctx, admin.id, cookie);
    // Kundenstamm NACH der Buchung ändern (Snapshot bleibt wie zur Annahme).
    await new CustomerService(ctx.db).updateCustomer(admin.id, world.customerId, {
      type: 'private',
      firstName: 'Klara',
      lastName: 'Kommerz',
      email: 'klara.kommerz@test.example',
      billingStreet: 'Neue Str. 1',
      billingPostalCode: '55116',
      billingCity: 'Mainz',
    });
    expect(await ctx.jobs.runOnce()).toBe('processed');
    const row = await transferRowForSettlement(ctx, view.settlement.id);
    expect(row!.status).toBe('succeeded');
    const invoice = [...ctx.lexwareFake!.invoices.values()][0]!;
    const contact = [...ctx.lexwareFake!.contacts.values()][0]!;
    // Kontakt = heutiger Kundenstamm (mit Adresse), Beleg = eingefrorener Snapshot (ohne Straße).
    expect(contact.addresses?.billing?.[0]?.street).toBe('Neue Str. 1');
    expect(invoice.address.contactId).toBe(contact.id);
    expect(invoice.address.street).toBeUndefined();
    expect(invoice.address.name).toBe('Kommerz, Klara');
    const snapshot = (row!.snapshot as AccountingPayload).customer;
    expect(snapshot.billingAddress.street).toBeNull();
    // Weitere Änderung danach: Beleg und Snapshot unverändert.
    await new CustomerService(ctx.db).updateCustomer(admin.id, world.customerId, {
      type: 'private',
      firstName: 'Klara',
      lastName: 'Umgezogen',
      email: 'klara.kommerz@test.example',
    });
    const later = await transferRowForSettlement(ctx, view.settlement.id);
    expect((later!.snapshot as AccountingPayload).customer.displayName).toBe('Kommerz, Klara');
    expect([...ctx.lexwareFake!.invoices.values()][0]!.address.name).toBe('Kommerz, Klara');
  });
});
