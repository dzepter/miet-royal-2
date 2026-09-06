/**
 * Phase-6-Pflichttests 88–101 (Order §67): IDOR (Assignment, Override,
 * Handover, Lieferschein, Foto, Signatur, Dokument), QR umgeht
 * machine.assign nicht, keine Client-Fälschung von Override-Bedarf,
 * Unterzeichner oder issued-Status, keine Signaturen/Fotos/Telefonnummern
 * in Logs oder Fehlermeldungen, Umgebungs-/Storage-Isolation.
 */
import { assertConfigsIsolated, loadConfig } from '@mietroyal/config';
import { appointments } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { maskLoggedPath } from '../src/app.ts';
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
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { machineByCode, resetWarehouse } from './warehouse-helpers.ts';
import {
  PNG_1X1,
  handoverServicesFor,
  initializeAllInventory,
  readyHandover,
  scheduledBooking,
  truncateHandoverTables,
} from './handover-helpers.ts';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await destroyTestContext(ctx);
});
beforeEach(async () => {
  await truncateHandoverTables(ctx.pool);
  await resetWarehouse(ctx.pool);
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
});

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  const effective = await ctx.auth.effectivePermissions(admin.id);
  return { admin, cookie: session.cookie, effective };
}

async function staffWith(adminId: string, keys: string[], suffix: string) {
  return createStaffWithPermissions(ctx, adminId, {
    firstName: 'Test',
    lastName: suffix,
    email: `test.${suffix.toLowerCase()}@test.example`,
    password: `${suffix.toLowerCase()}-passwort-1234`,
    permissionKeys: keys,
  });
}

describe('88.–94. IDOR', () => {
  it('88./90./91. Fremde Zuordnungen/Buchungen sind über die URL nicht erreichbar; ohne Recht 403, unbekannt neutral 404', async () => {
    const { admin, cookie } = await adminSession();
    const { handover, assignments } = handoverServicesFor(ctx);
    const a = await scheduledBooking(ctx, admin.id);
    const b = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(a.bookingId, admin.id);
    await handover.ensureForBooking(b.bookingId, admin.id);
    const slotB = (await assignments.slotsForBooking(b.bookingId))[0]!;
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    // Slot von B unter Buchung A adressiert → 404 (kein Effekt).
    const cross = await ctx.app.inject({
      method: 'POST',
      url: `/staff/handover/${a.bookingId}/slots/${slotB.id}/assign`,
      headers: { cookie },
      payload: { machineId: machine.id },
    });
    expect(cross.statusCode).toBe(404);
    expect((await assignments.slotsForBooking(b.bookingId))[0]!.machine).toBeNull();
    // Lieferschein-Position von B unter Buchung A → 404.
    const itemB = (await handover.detail(b.bookingId)).deliveryNote.items[0]!;
    const crossItem = await ctx.app.inject({
      method: 'PATCH',
      url: `/staff/handover/${a.bookingId}/items/${itemB.id}`,
      headers: { cookie },
      payload: { actualQuantity: 0 },
    });
    expect(crossItem.statusCode).toBe(404);
    // Ohne Vorgangssicht/Recht: 403; unbekannte Buchung: neutrales 404.
    const outsider = await staffWith(admin.id, ['machine.view'], 'Outsider');
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: `/staff/handover/${a.bookingId}`,
      headers: { cookie: outsider.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
    const unknown = await ctx.app.inject({
      method: 'GET',
      url: `/staff/handover/00000000-0000-4000-8000-000000000000`,
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.body).not.toContain(a.bookingId);
  });

  it('89. Die Override-Liste ist nur mit machine.override_block erreichbar', async () => {
    const { admin, cookie } = await adminSession();
    const viewer = await staffWith(
      admin.id,
      ['process.view_all', 'machine.view', 'handover.view'],
      'Viewer',
    );
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/staff/machine-overrides',
          headers: { cookie: viewer.cookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await ctx.app.inject({
          method: 'GET',
          url: '/staff/machine-overrides',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('R2. Fotos werden auf echte Bildbytes geprüft – kein Fremdinhalt im privaten Storage', async () => {
    const { admin, cookie, effective } = await adminSession();
    const { handover, assignments } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    await assignments.assign(admin.id, effective, slot.id, machine.id, null);
    const url = `/staff/handover/${world.bookingId}/machines/${slot.id}/photos`;
    const png = PNG_1X1.toString('base64');
    const mismatched = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { cookie },
      payload: { mimeType: 'image/jpeg', dataBase64: png },
    });
    expect(mismatched.statusCode).toBe(400);
    const garbage = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { cookie },
      payload: { mimeType: 'image/png', dataBase64: Buffer.from('kein bild').toString('base64') },
    });
    expect(garbage.statusCode).toBe(400);
    const accepted = await ctx.app.inject({
      method: 'POST',
      url,
      headers: { cookie },
      payload: { mimeType: 'image/png', dataBase64: png },
    });
    expect(accepted.statusCode).toBe(200);
    expect((await handover.detail(world.bookingId)).machines[0]!.photos).toHaveLength(1);
  });

  it('92./93./94. Foto, Signatur und Dokument sind ohne Recht gesperrt', async () => {
    const { admin } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    await initializeAllInventory(ctx, admin.id);
    const world = await scheduledBooking(ctx, admin.id);
    await readyHandover(ctx, admin.id, world.bookingId, ['MR-10-01-01']);
    const detail = await handover.finalize(admin.id, world.bookingId);
    const photoId = detail.machines[0]!.photos[0]!.id;
    const outsider = await staffWith(
      admin.id,
      ['process.view_all', 'machine.view', 'inventory.view'],
      'Fremd',
    );
    const photo = await ctx.app.inject({
      method: 'GET',
      url: `/staff/handover/photos/${photoId}`,
      headers: { cookie: outsider.cookie },
    });
    expect(photo.statusCode).toBe(403);
    const signature = await ctx.app.inject({
      method: 'GET',
      url: `/staff/handover/${world.bookingId}/signatures/customer`,
      headers: { cookie: outsider.cookie },
    });
    expect(signature.statusCode).toBe(403);
    const document = await ctx.app.inject({
      method: 'GET',
      url: `/staff/documents/${detail.handover.protocolDocumentId}`,
      headers: { cookie: outsider.cookie },
    });
    expect(document.statusCode).toBe(403);
    expect(document.body).not.toContain('%PDF');
  });
});

describe('95.–98. Keine Client-Fälschungen', () => {
  it('95. Der QR-Resolver (machine.view) umgeht machine.assign nicht', async () => {
    const { admin } = await adminSession();
    const { handover, assignments } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const scanner = await staffWith(
      admin.id,
      ['process.view_all', 'machine.view', 'handover.view'],
      'Scanner',
    );
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    const resolved = await ctx.app.inject({
      method: 'GET',
      url: `/staff/machines/qr/${machine.qrToken}`,
      headers: { cookie: scanner.cookie },
    });
    expect(resolved.statusCode).toBe(200);
    const assign = await ctx.app.inject({
      method: 'POST',
      url: `/staff/handover/${world.bookingId}/slots/${slot.id}/assign`,
      headers: { cookie: scanner.cookie },
      payload: { machineId: resolved.json().machineId },
    });
    expect(assign.statusCode).toBe(403);
    expect((await assignments.slotsForBooking(world.bookingId))[0]!.machine).toBeNull();
  });

  it('96. Der Server berechnet den Override-Bedarf selbst – ein unnötiger Client-Override wird ignoriert, ein nötiger nie umgangen', async () => {
    const { admin, cookie } = await adminSession();
    const { handover, assignments, machineService } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id, { machineQuantity: 2 });
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slots = await assignments.slotsForBooking(world.bookingId);
    const fine = await machineByCode(ctx.db, 'MR-10-01-01');
    const withOverride = await ctx.app.inject({
      method: 'POST',
      url: `/staff/handover/${world.bookingId}/slots/${slots[0]!.id}/assign`,
      headers: { cookie },
      payload: { machineId: fine.id, override: { confirmed: true, reason: 'unnötig' } },
    });
    expect(withOverride.statusCode).toBe(200);
    expect(withOverride.json().slot.override).toBeNull();
    expect(await assignments.listOverrides()).toHaveLength(0);
    // Problemmaschine ohne Override, auch mit „overrideRequired: false“ im Body → 400 (strict) bzw. 409.
    const repair = await machineByCode(ctx.db, 'MR-10-01-02');
    await machineService.setStatus(repair.id, 'repair');
    const faked = await ctx.app.inject({
      method: 'POST',
      url: `/staff/handover/${world.bookingId}/slots/${slots[1]!.id}/assign`,
      headers: { cookie },
      payload: { machineId: repair.id, overrideRequired: false },
    });
    expect(faked.statusCode).toBe(400);
    const plain = await ctx.app.inject({
      method: 'POST',
      url: `/staff/handover/${world.bookingId}/slots/${slots[1]!.id}/assign`,
      headers: { cookie },
      payload: { machineId: repair.id },
    });
    expect(plain.statusCode).toBe(409);
  });

  it('97./98. Unterzeichner und issued-Status sind nicht vom Client setzbar', async () => {
    const { admin, cookie } = await adminSession();
    const { handover, assignments } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    const slot = (await assignments.slotsForBooking(world.bookingId))[0]!;
    const spoof = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/handover/${world.bookingId}/signatures/staff`,
      headers: { cookie },
      payload: {
        dataBase64: PNG_1X1.toString('base64'),
        signerUserId: '00000000-0000-4000-8000-000000000000',
      },
    });
    expect(spoof.statusCode).toBe(400);
    for (const url of [
      `/staff/handover/${world.bookingId}/slots/${slot.id}/issue`,
      `/staff/handover/${world.bookingId}/issue`,
    ]) {
      const response = await ctx.app.inject({
        method: 'POST',
        url,
        headers: { cookie },
        payload: {},
      });
      expect(response.statusCode, url).toBe(404);
    }
    const machine = await machineByCode(ctx.db, 'MR-10-01-01');
    const rented = await ctx.app.inject({
      method: 'POST',
      url: `/staff/machines/${machine.id}/status`,
      headers: { cookie },
      payload: { status: 'rented' },
    });
    expect(rented.statusCode).toBe(400);
    expect((await assignments.slotsForBooking(world.bookingId))[0]!.status).toBe('open');
  });
});

describe('99.–101. Datenminimierung und Isolation', () => {
  it('99. Fehlermeldungen und Logpfade enthalten weder Signaturdaten noch Fotos noch Telefonnummern', async () => {
    const { admin, cookie } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    const bogus = Buffer.from('kein-png-' + 'x'.repeat(200)).toString('base64');
    const response = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/handover/${world.bookingId}/signatures/customer`,
      headers: { cookie },
      payload: { dataBase64: bogus },
    });
    expect([400, 409]).toContain(response.statusCode);
    expect(response.body).not.toContain(bogus.slice(0, 40));
    await handover.setRepresentative(admin.id, world.bookingId, {
      firstName: 'Paula',
      lastName: 'Proxy',
      phone: '+49 6131 987654',
    });
    const badRecipient = await ctx.app.inject({
      method: 'PUT',
      url: `/staff/handover/${world.bookingId}/recipient`,
      headers: { cookie },
      payload: { kind: 'other', name: '', phone: '+49 6131 987654' },
    });
    expect(badRecipient.statusCode).toBe(400);
    expect(badRecipient.body).not.toContain('987654');
    // Request-Log: nur Pfad, nie Query/Body; Foto-/Signatur-Bytes stehen im Body.
    expect(maskLoggedPath(`/staff/handover/${world.bookingId}/signatures/customer?debug=abc`)).toBe(
      `/staff/handover/${world.bookingId}/signatures/customer`,
    );
  });

  it('100./101. Demo/Production inkl. Storage kollidieren weiterhin nicht unbemerkt', () => {
    const base = {
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://prod:SYNTH@db-prod.internal:5432/mietroyal_prod',
      AUTH_SECRET_KEY: '1'.repeat(64),
      STORAGE_DRIVER: 's3',
      STORAGE_S3_ENDPOINT: 'https://s3.synthetic.example',
      STORAGE_S3_REGION: 'eu-central-1',
      STORAGE_S3_BUCKET: 'mietroyal-prod-documents',
      STORAGE_S3_ACCESS_KEY_ID: 'SYNTH-PROD',
      STORAGE_S3_SECRET_ACCESS_KEY: 'SYNTH-prod-secret',
    };
    const production = loadConfig(base);
    const demo = loadConfig({
      ...base,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://demo:SYNTH@db-demo.internal:5432/mietroyal_demo',
      AUTH_SECRET_KEY: '2'.repeat(64),
      STORAGE_S3_BUCKET: 'mietroyal-demo-documents',
      STORAGE_S3_ACCESS_KEY_ID: 'SYNTH-DEMO',
      STORAGE_S3_SECRET_ACCESS_KEY: 'SYNTH-demo-secret',
    });
    expect(() => assertConfigsIsolated(production, demo)).not.toThrow();
    const collidingStorage = loadConfig({
      ...base,
      APP_ENV: 'demo',
      DATABASE_URL: 'postgresql://demo:SYNTH@db-demo.internal:5432/mietroyal_demo',
      AUTH_SECRET_KEY: '2'.repeat(64),
    });
    expect(() => assertConfigsIsolated(production, collidingStorage)).toThrow();
  });
});

describe('R11./R13. Sichtbarkeit der Ausgabe-Liste, Unterschrift-Struktur', () => {
  it('R11. Die Ausgabe-Liste unterliegt der Vorgangssichtbarkeit: ohne process.view_all kein Zugriff', async () => {
    const { admin, cookie } = await adminSession();
    const world = await scheduledBooking(ctx, admin.id);
    const limited = await staffWith(admin.id, ['handover.view'], 'Liste');
    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/staff/handover/day',
      headers: { cookie: limited.cookie },
    });
    expect(denied.statusCode).toBe(403);
    const outbound = (
      await ctx.db
        .select()
        .from(appointments)
        .where(eq(appointments.id, world.outboundAppointmentId))
    )[0]!;
    const day = outbound.startAt!.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/staff/handover/day?date=${day}`,
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { entries: { bookingId: string }[] };
    expect(body.entries.some((entry) => entry.bookingId === world.bookingId)).toBe(true);
  });

  it('R13. Eine nicht darstellbare „PNG“-Unterschrift wird abgelehnt, ein echtes PNG angenommen', async () => {
    const { admin, cookie } = await adminSession();
    const { handover } = handoverServicesFor(ctx);
    const world = await scheduledBooking(ctx, admin.id);
    await handover.ensureForBooking(world.bookingId, admin.id);
    await handover.setRecipient(world.bookingId, { kind: 'customer' });
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(120),
    ]);
    const url = `/staff/handover/${world.bookingId}/signatures/customer`;
    const rejected = await ctx.app.inject({
      method: 'PUT',
      url,
      headers: { cookie },
      payload: { dataBase64: fake.toString('base64') },
    });
    expect(rejected.statusCode).toBe(400);
    const accepted = await ctx.app.inject({
      method: 'PUT',
      url,
      headers: { cookie },
      payload: { dataBase64: PNG_1X1.toString('base64') },
    });
    expect(accepted.statusCode).toBe(200);
  });
});
