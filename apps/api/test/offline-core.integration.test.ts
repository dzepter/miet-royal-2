/**
 * Phase-8-Integrationstests (Order §§82–91): Lease (72 h, Widerruf,
 * Berechtigung), Statusendpunkt ohne Aktivitätsverlängerung, Arbeitspaket
 * (Rechte, Horizont, Kontaktdaten-Minimierung, Maschinenbasis mit QR-Hash,
 * Dokumente, Vertretung, Environment-ID), Sync-Orchestrator (Übergabe/
 * Rückgabe/Reinigung über die bestehenden Domainservices, Quittungen,
 * Idempotenz, Konflikte, Rechte, Uhrzeit-Plausibilität, Environment-Mismatch,
 * Cross-User-Schutz).
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  deliveryNoteItems,
  documents,
  handovers,
  inventoryMovements,
  machineDamages,
  machines,
  missingAccessoryCases,
  offlineAccessLeases,
  offlineMutationReceipts,
  processes,
  rentalReturns,
  returnInventoryItems,
  returnPhotos,
  staffSecurityEvents,
  staffSessions,
} from '@mietroyal/database';
import { berlinDateOf, berlinDateTimeToUtc } from '@mietroyal/domain';
import type { PermissionKey } from '@mietroyal/permissions';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminVisibilityCtx,
  createStaffWithPermissions,
  processServiceFor,
  truncateCrmTables,
} from './crm-helpers.ts';
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
import { truncateCommerceTables } from './commerce-helpers.ts';
import {
  DAYS,
  handoverServicesFor,
  initializeAllInventory,
  pngBytes,
  scheduledBooking,
  truncateHandoverTables,
} from './handover-helpers.ts';
import { issuedBooking, jpegBytes, readyReturn, startedReturn } from './return-helpers.ts';
import {
  schedulingServiceFor,
  substitutionServiceFor,
  truncateSchedulingTables,
} from './scheduling-helpers.ts';
import { machineByCode, resetWarehouse } from './warehouse-helpers.ts';

let ctx: TestContext;
const DEVICE = '0f6a9d2e-1b3c-4d5e-8f70-1234567890ab';
const DEVICE_B = '9f6a9d2e-1b3c-4d5e-8f70-1234567890cd';

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
  await ctx.pool.query('TRUNCATE offline_mutation_receipts, offline_access_leases CASCADE');
});

const OPERATIVE: PermissionKey[] = [
  'process.view_all',
  'handover.view',
  'handover.prepare',
  'handover.perform',
  'delivery_note.edit',
  'machine.view',
  'machine.assign',
  'machine.clean_complete',
  'return.view',
  'return.perform',
  'return.complete',
  'return.mark_cleanup_issue',
  'missing_item.create',
  'damage.document',
  'calendar.view',
];

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie };
}

async function staffWith(adminId: string, keys: readonly PermissionKey[], suffix: string) {
  return createStaffWithPermissions(ctx, adminId, {
    firstName: 'Offline',
    lastName: suffix,
    email: `offline-${suffix.toLowerCase()}@test.example`,
    password: `offline-passwort-${suffix}-1`,
    permissionKeys: keys,
  });
}

async function lease(cookie: string, deviceId = DEVICE, environment = 'development') {
  return ctx.app.inject({
    method: 'POST',
    url: '/staff/offline/lease',
    headers: { cookie },
    payload: { deviceId, environment },
  });
}

async function pkg(cookie: string, extra: Record<string, unknown> = {}, deviceId = DEVICE) {
  return ctx.app.inject({
    method: 'POST',
    url: '/staff/offline/package',
    headers: { cookie },
    payload: { deviceId, environment: 'development', includeDocuments: true, ...extra },
  });
}

interface MutationInput {
  id?: string;
  type: string;
  contextKind?: 'booking' | 'machine';
  contextId: string;
  payload: unknown;
  base?: Record<string, unknown> | null;
  media?: {
    mediaId: string;
    purpose: string;
    mimeType: string;
    bytes: Uint8Array;
    sha256?: string;
  }[];
  createdAt?: string;
  clientTime?: string;
}

function mutation(input: MutationInput) {
  return {
    clientMutationId: input.id ?? randomUUID(),
    type: input.type,
    contextKind: input.contextKind ?? (input.type.startsWith('machine.') ? 'machine' : 'booking'),
    contextId: input.contextId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    baseVersion:
      input.base === null
        ? null
        : JSON.stringify(
            input.base ?? { processStatus: 'open', appointmentId: null, appointmentVersion: null },
          ),
    payload: input.payload,
    media: (input.media ?? []).map((m) => ({
      mediaId: m.mediaId,
      purpose: m.purpose,
      mimeType: m.mimeType,
      sha256: m.sha256 ?? createHash('sha256').update(m.bytes).digest('hex'),
      dataBase64: Buffer.from(m.bytes).toString('base64'),
    })),
  };
}

async function sync(
  cookie: string,
  input: MutationInput,
  options: { deviceId?: string; environment?: string; clientTime?: string } = {},
) {
  const body = mutation(input);
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/staff/offline/sync',
    headers: { cookie },
    payload: {
      deviceId: options.deviceId ?? DEVICE,
      environment: options.environment ?? 'development',
      clientTime: options.clientTime ?? new Date().toISOString(),
      mutation: body,
    },
  });
  return { response, id: body.clientMutationId, json: response.json() as Record<string, unknown> };
}

async function packageFor(cookie: string) {
  expect((await lease(cookie)).statusCode).toBe(200);
  const response = await pkg(cookie);
  expect(response.statusCode).toBe(200);
  return response.json() as {
    environment: string;
    horizonFrom: string;
    horizonTo: string;
    truncated: boolean;
    bookings: {
      bookingId: string;
      processId: string;
      relevance: string[];
      customer: { name: string; phone: string | null; deliveryAddressLines: string[] };
      appointments: {
        id: string;
        kind: string;
        version: number;
        assignedUserId: string | null;
        effectiveAssigneeId: string | null;
      }[];
      handover: Record<string, unknown> | null;
      return: Record<string, unknown> | null;
      returnStartable: boolean;
      returnSeed: {
        machines: { assignmentId: string; machineId: string }[];
        items: { deliveryNoteItemId: string; issuedQuantity: number; kind: string }[];
      } | null;
      existingDamages: Record<string, { description: string }[]>;
      candidateMachines: Record<
        string,
        {
          machineId: string;
          situationFingerprint: string;
          overrideRequired: boolean;
          hardBlocked: boolean;
        }[]
      >;
      documents: { id: string; type: string; sha256: string }[];
    }[];
    machines: {
      machineId: string;
      machineCode: string;
      qrHash: string;
      status: string;
      cleaningSince: string | null;
      currentDamages: { description: string }[];
    }[];
    inventory: unknown[] | null;
    documents: {
      id: string;
      type: string;
      bookingId: string;
      dataBase64: string;
      sha256: string;
      byteSize: number;
    }[];
    permissions: string[];
    lease: { leaseId: string; expiresAt: string };
  };
}

async function securityEvents(type: string) {
  return (await ctx.db.select().from(staffSecurityEvents)).filter((e) => e.type === type);
}

describe('Offline-Lease und Status (Order §§8, 39, 78; Tests 12/13/100/103)', () => {
  it('stellt ein 72-h-Lease nur mit operativen Rechten aus, verlängert mit neuem Secret und widerruft', async () => {
    const { admin } = await adminSession();
    // Ohne operatives Recht (handover.view/return.view/machine.view) kein Offlinebetrieb.
    const office = await staffWith(admin.id, ['process.view_all', 'offer.view'], 'Office');
    const denied = await lease(office.cookie);
    expect(denied.statusCode).toBe(403);
    expect(await ctx.db.select().from(offlineAccessLeases)).toHaveLength(0);

    const staff = await staffWith(admin.id, [...OPERATIVE, 'employee.manage'], 'Lease');
    const first = await lease(staff.cookie);
    expect(first.statusCode).toBe(200);
    const grant = first.json() as {
      leaseId: string;
      leaseSecret: string;
      issuedAt: string;
      expiresAt: string;
      permissions: string[];
      environment: string;
      deviceId: string;
    };
    expect(grant.environment).toBe('development');
    expect(grant.deviceId).toBe(DEVICE);
    expect(Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt)).toBe(72 * 3_600_000);
    expect(grant.leaseSecret.length).toBeGreaterThan(30);
    expect(grant.permissions).toContain('handover.perform');
    expect(grant.permissions).not.toContain('employee.manage');
    // Secret liegt serverseitig nur verschlüsselt (AUTH_SECRET_KEY).
    const rows = await ctx.db.select().from(offlineAccessLeases);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.leaseSecretEncrypted).not.toContain(grant.leaseSecret);
    expect(await securityEvents('offline.lease_issued')).toHaveLength(1);

    const second = await lease(staff.cookie);
    const renewed = second.json() as { leaseId: string; leaseSecret: string; issuedAt: string };
    expect(renewed.leaseId).toBe(grant.leaseId);
    expect(renewed.leaseSecret).not.toBe(grant.leaseSecret);
    expect(await ctx.db.select().from(offlineAccessLeases)).toHaveLength(1);
    expect(await securityEvents('offline.lease_renewed')).toHaveLength(1);

    const secret = await ctx.app.inject({
      method: 'GET',
      url: `/staff/offline/lease/secret?deviceId=${DEVICE}&environment=development`,
      headers: { cookie: staff.cookie },
    });
    expect(secret.statusCode).toBe(200);
    expect((secret.json() as { leaseSecret: string }).leaseSecret).toBe(renewed.leaseSecret);
    // Fremdes Gerät bekommt kein Secret (Test 103: Lease nicht frei übertragbar).
    const other = await ctx.app.inject({
      method: 'GET',
      url: `/staff/offline/lease/secret?deviceId=${DEVICE_B}&environment=development`,
      headers: { cookie: staff.cookie },
    });
    expect(other.statusCode).toBe(404);
    // Fremder Benutzer (operative Rechte, aber keine eigene Lease) bekommt für dieses Gerät
    // weder Paket noch Secret (Test 98: Lease ist an Benutzer × Gerät gebunden).
    const stranger = await staffWith(admin.id, OPERATIVE, 'Stranger');
    const stolen = await pkg(stranger.cookie, {}, DEVICE);
    expect(stolen.statusCode).toBe(409);
    expect((stolen.json() as { error: { code: string } }).error.code).toBe(
      'OFFLINE_LEASE_REQUIRED',
    );
    const strangerSecret = await ctx.app.inject({
      method: 'GET',
      url: `/staff/offline/lease/secret?deviceId=${DEVICE}&environment=development`,
      headers: { cookie: stranger.cookie },
    });
    expect(strangerSecret.statusCode).toBe(404);

    const revoke = await ctx.app.inject({
      method: 'POST',
      url: '/staff/offline/lease/revoke',
      headers: { cookie: staff.cookie },
      payload: { deviceId: DEVICE, environment: 'development' },
    });
    expect((revoke.json() as { revoked: boolean }).revoked).toBe(true);
    expect(await securityEvents('offline.lease_revoked')).toHaveLength(1);
    const afterRevoke = await pkg(staff.cookie);
    expect(afterRevoke.statusCode).toBe(409);
    expect((afterRevoke.json() as { error: { code: string } }).error.code).toBe(
      'OFFLINE_LEASE_REQUIRED',
    );
    const noSecret = await ctx.app.inject({
      method: 'GET',
      url: `/staff/offline/lease/secret?deviceId=${DEVICE}&environment=development`,
      headers: { cookie: staff.cookie },
    });
    expect(noSecret.statusCode).toBe(404);
    // Erneuter Widerruf ohne aktives Lease: false, kein weiteres Ereignis.
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/staff/offline/lease/revoke',
      headers: { cookie: staff.cookie },
      payload: { deviceId: DEVICE, environment: 'development' },
    });
    expect((again.json() as { revoked: boolean }).revoked).toBe(false);
    // Neue Ausstellung nach Widerruf: neues Lease (partieller Unique-Index nur für aktive).
    expect((await lease(staff.cookie)).statusCode).toBe(200);
    expect(await ctx.db.select().from(offlineAccessLeases)).toHaveLength(2);
  });

  it('Statusabfrage verlängert die Aktivität NICHT und meldet den Sperrzustand', async () => {
    const { admin } = await adminSession();
    const staff = await staffWith(admin.id, OPERATIVE, 'Status');
    const sessionOf = async () =>
      (
        await ctx.db.select().from(staffSessions).where(eq(staffSessions.userId, staff.user.id))
      )[0]!;
    const setActivity = async (at: Date) =>
      ctx.db
        .update(staffSessions)
        .set({ lastActivityAt: at })
        .where(eq(staffSessions.userId, staff.user.id));

    // Ohne Session: 401 (Konnektivität nur authentifiziert prüfbar).
    expect((await ctx.app.inject({ method: 'GET', url: '/staff/offline/status' })).statusCode).toBe(
      401,
    );

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000);
    await setActivity(fiveMinutesAgo);
    const online = await ctx.app.inject({
      method: 'GET',
      url: '/staff/offline/status',
      headers: { cookie: staff.cookie },
    });
    expect(online.statusCode).toBe(200);
    expect(online.headers['cache-control']).toBe('no-store');
    const status = online.json() as {
      online: boolean;
      appLocked: boolean;
      environment: string;
      serverTime: string;
    };
    expect(status.online).toBe(true);
    expect(status.appLocked).toBe(false);
    expect(status.environment).toBe('development');
    expect(Math.abs(Date.parse(status.serverTime) - Date.now())).toBeLessThan(10_000);
    expect((await sessionOf()).lastActivityAt.getTime()).toBe(fiveMinutesAgo.getTime());

    // 15-Minuten-App-Sperre: Status meldet sie, hebt sie aber nicht auf.
    const sixteenMinutesAgo = new Date(Date.now() - 16 * 60_000);
    await setActivity(sixteenMinutesAgo);
    const locked = await ctx.app.inject({
      method: 'GET',
      url: '/staff/offline/status',
      headers: { cookie: staff.cookie },
    });
    expect(locked.statusCode).toBe(200);
    expect((locked.json() as { appLocked: boolean }).appLocked).toBe(true);
    expect((await sessionOf()).lastActivityAt.getTime()).toBe(sixteenMinutesAgo.getTime());
    // Gesperrt: fachliche Offline-Endpunkte sind nicht erreichbar.
    const lockedPackage = await pkg(staff.cookie);
    expect(lockedPackage.statusCode).toBe(401);
    expect((lockedPackage.json() as { error: { code: string } }).error.code).toBe('APP_LOCKED');
    // Entsperren über den normalen Re-Auth-Weg; /auth/me liefert die Umgebungs-ID (§16).
    const unlock = await ctx.app.inject({
      method: 'POST',
      url: '/auth/unlock',
      headers: { cookie: staff.cookie },
      payload: { password: 'offline-passwort-Status-1' },
    });
    expect(unlock.statusCode).toBe(200);
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: staff.cookie },
    });
    expect((me.json() as { environment: string; appLocked: boolean }).environment).toBe(
      'development',
    );
    expect((me.json() as { appLocked: boolean }).appLocked).toBe(false);
  });

  it('lehnt eine fremde Umgebung hart ab (Order §76; Tests 26/32/101/102)', async () => {
    const { admin } = await adminSession();
    const staff = await staffWith(admin.id, OPERATIVE, 'Env');
    const foreignLease = await lease(staff.cookie, DEVICE, 'production');
    expect(foreignLease.statusCode).toBe(409);
    expect((foreignLease.json() as { error: { code: string } }).error.code).toBe(
      'ENVIRONMENT_MISMATCH',
    );
    expect(await ctx.db.select().from(offlineAccessLeases)).toHaveLength(0);

    expect((await lease(staff.cookie)).statusCode).toBe(200);
    const foreignPackage = await pkg(staff.cookie, { environment: 'demo' });
    expect(foreignPackage.statusCode).toBe(409);
    expect((foreignPackage.json() as { error: { code: string } }).error.code).toBe(
      'ENVIRONMENT_MISMATCH',
    );
    const foreignSync = await sync(
      staff.cookie,
      { type: 'handover.recipient', contextId: randomUUID(), payload: { kind: 'customer' } },
      { environment: 'production' },
    );
    expect(foreignSync.response.statusCode).toBe(409);
    expect((foreignSync.json as { error: { code: string } }).error.code).toBe(
      'ENVIRONMENT_MISMATCH',
    );
    expect(await ctx.db.select().from(offlineMutationReceipts)).toHaveLength(0);
    const foreignSecret = await ctx.app.inject({
      method: 'GET',
      url: `/staff/offline/lease/secret?deviceId=${DEVICE}&environment=demo`,
      headers: { cookie: staff.cookie },
    });
    expect(foreignSecret.statusCode).toBe(409);
    // Jeder Mismatch ist ein Security-Event ohne Fachdaten.
    const events = await securityEvents('offline.environment_mismatch');
    expect(events.length).toBe(4);
    for (const event of events) {
      expect(JSON.stringify(event.details)).not.toContain('leaseSecret');
      expect(event.targetUserId).toBe(staff.user.id);
    }
    // Ungültige Umgebungs-ID scheitert bereits am Schema.
    expect((await lease(staff.cookie, DEVICE, 'prod')).statusCode).toBe(400);
  });

  it('deaktivierter Benutzer wird beim Onlinekontakt sofort blockiert (Test 100)', async () => {
    const { admin } = await adminSession();
    const staff = await staffWith(admin.id, OPERATIVE, 'Disabled');
    expect((await lease(staff.cookie)).statusCode).toBe(200);
    await ctx.admin.setUserStatus(admin.id, staff.user.id, 'disabled');
    const calls = [
      ctx.app.inject({
        method: 'GET',
        url: '/staff/offline/status',
        headers: { cookie: staff.cookie },
      }),
      ctx.app.inject({
        method: 'GET',
        url: `/staff/offline/lease/secret?deviceId=${DEVICE}&environment=development`,
        headers: { cookie: staff.cookie },
      }),
      pkg(staff.cookie),
    ];
    for (const response of await Promise.all(calls)) {
      expect(response.statusCode).toBe(401);
    }
    const blockedSync = await sync(staff.cookie, {
      type: 'handover.recipient',
      contextId: randomUUID(),
      payload: { kind: 'customer', name: null, phone: null },
    });
    expect(blockedSync.response.statusCode).toBe(401);
    expect(await ctx.db.select().from(offlineMutationReceipts)).toHaveLength(0);
  });
});

describe('Arbeitspaket (Order §§9–13, 54, 56; Tests 15–31)', () => {
  it('enthält nur berechtigte, operativ relevante Vorgänge mit minimalen Kontaktdaten', async () => {
    const { admin } = await adminSession();
    await initializeAllInventory(ctx, admin.id, 20);
    const today = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 2 * 3_600_000),
      to: new Date(Date.now() + 2 * DAYS),
    });
    const soon = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 2 * DAYS),
      to: new Date(Date.now() + 5 * DAYS),
    });
    const far = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 10 * DAYS),
      to: new Date(Date.now() + 12 * DAYS),
    });
    // Horizontgrenze (§9: heute ±3 Berliner Kalendertage): Tag +3 drin, Tag +4 draußen.
    const berlinNoon = (offsetDays: number) =>
      berlinDateTimeToUtc(berlinDateOf(new Date(Date.now() + offsetDays * DAYS)), 12);
    const edgeIn = await scheduledBooking(ctx, admin.id, {
      from: berlinNoon(3),
      to: berlinNoon(5),
    });
    const edgeOut = await scheduledBooking(ctx, admin.id, {
      from: berlinNoon(4),
      to: berlinNoon(6),
    });
    // Alter, nie ausgegebener Vorgang außerhalb des Horizonts: nicht relevant (Test 19).
    const stale = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() - 6 * DAYS),
      to: new Date(Date.now() - 4 * DAYS),
    });
    const overdue = await issuedBooking(ctx, admin.id, {
      machineCodes: ['MR-10-01-02'],
      from: new Date(Date.now() - 4 * DAYS),
      to: new Date(Date.now() - 1 * DAYS),
      skipInventoryInit: true,
    });

    // Admin-/Finanzrechte werden nie in den Offline-Snapshot übernommen (§26/§75, Test 21).
    const staff = await staffWith(
      admin.id,
      [...OPERATIVE, 'employee.manage', 'system.settings', 'settlement.view'],
      'Pack',
    );
    const result = await packageFor(staff.cookie);
    expect(result.environment).toBe('development');
    expect(result.truncated).toBe(false);
    expect(result.horizonFrom).toBe(berlinDateOf(new Date(Date.now() - 3 * DAYS)));
    expect(result.horizonTo).toBe(berlinDateOf(new Date(Date.now() + 3 * DAYS)));
    expect(result.permissions).toContain('handover.perform');
    expect(result.permissions).not.toContain('system.settings');
    expect(result.permissions).not.toContain('settlement.view');
    expect(result.permissions).not.toContain('employee.manage');
    const ids = result.bookings.map((b) => b.bookingId);
    expect(ids).toContain(today.bookingId);
    expect(ids).toContain(soon.bookingId);
    expect(ids).toContain(edgeIn.bookingId);
    expect(ids).not.toContain(edgeOut.bookingId);
    expect(ids).not.toContain(far.bookingId);
    expect(ids).not.toContain(stale.bookingId);
    expect(ids).toContain(overdue.bookingId);
    // Notwendige Kontaktinformationen (Name, operative Telefonnummer), keine E-Mail (Test 20).
    const todaySnapshot = result.bookings.find((b) => b.bookingId === today.bookingId)!;
    expect(todaySnapshot.customer.name.trim().length).toBeGreaterThan(0);
    expect(todaySnapshot.customer.phone).toBe('0171 9998877');
    expect(todaySnapshot.customer.deliveryAddressLines).toEqual([]); // Abholung: keine Lieferadresse
    expect(todaySnapshot.relevance).toContain('handover');
    expect(todaySnapshot.handover).not.toBeNull();
    expect(Object.keys(todaySnapshot.candidateMachines)).toHaveLength(1);
    const overdueSnapshot = result.bookings.find((b) => b.bookingId === overdue.bookingId)!;
    expect(overdueSnapshot.relevance).toContain('return');
    expect(overdueSnapshot.relevance).toContain('overdue');
    expect(overdueSnapshot.returnStartable).toBe(true);
    expect(overdueSnapshot.returnSeed?.machines).toHaveLength(1);
    expect(overdueSnapshot.appointments.some((a) => a.kind === 'return' && a.version >= 1)).toBe(
      true,
    );

    const raw = JSON.stringify(result);
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('totp');
    expect(raw).not.toMatch(/"customerEmail":"[^"]+"/);
    expect(raw).not.toContain('klara.kommerz@test.example');
    expect(raw).not.toContain('qrToken');
    expect(result.machines).toHaveLength(11);
    for (const machine of result.machines) {
      expect(machine.qrHash).toMatch(/^[0-9a-f]{64}$/);
      const row = await machineByCode(ctx.db, machine.machineCode);
      expect(machine.qrHash).toBe(
        createHash('sha256').update(row.qrToken.toLowerCase()).digest('hex'),
      );
      expect(raw).not.toContain(row.qrToken); // Rohtoken nirgends im Paket (Test 28)
    }
    expect(result.inventory).toBeNull(); // kein inventory.view
    expect(result.documents.map((d) => d.type).sort()).toEqual([
      'delivery_note',
      'handover_protocol',
    ]);
    expect(result.documents.every((d) => d.bookingId === overdue.bookingId)).toBe(true);
    // Dokumentreferenzen im Snapshot + Integrität der Bytes (Test 23).
    expect(overdueSnapshot.documents.map((d) => d.type).sort()).toEqual([
      'delivery_note',
      'handover_protocol',
    ]);
    for (const doc of result.documents) {
      const bytes = Buffer.from(doc.dataBase64, 'base64');
      expect(bytes.length).toBe(doc.byteSize);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(doc.sha256);
      expect(overdueSnapshot.documents.find((d) => d.id === doc.id)?.sha256).toBe(doc.sha256);
    }
    // Lease protokolliert den Paketabruf (nur Betriebsinformation).
    const leaseRow = (await ctx.db.select().from(offlineAccessLeases))[0]!;
    expect(leaseRow.packageSeq).toBe(1);
    expect(leaseRow.lastPackageAt).not.toBeNull();
    // Antworten der API sind nie cachebar (§4).
    const response = await pkg(staff.cookie, { includeDocuments: false });
    expect(response.headers['cache-control']).toBe('no-store');
    expect((response.json() as { documents: unknown[] }).documents).toHaveLength(0);
  });

  it('liefert ohne machine.view keine Maschinenbasis und ohne handover.view keine Übergabesicht (Tests 15/30)', async () => {
    const { admin } = await adminSession();
    await issuedBooking(ctx, admin.id, {
      machineCodes: ['MR-10-01-01'],
      to: new Date(Date.now() + 1 * DAYS),
    });
    const returnOnly = await staffWith(
      admin.id,
      ['process.view_all', 'return.view', 'return.perform'],
      'ReturnOnly',
    );
    const result = await packageFor(returnOnly.cookie);
    expect(result.machines).toHaveLength(0);
    expect(result.bookings).toHaveLength(1);
    expect(result.bookings[0]!.handover).toBeNull();
    expect(result.bookings[0]!.returnStartable).toBe(true);
    expect(result.documents).toHaveLength(0); // Lieferschein/Übergabeprotokoll nur mit handover.view

    // Nur machine.view: QR-Maschinenbasis, aber keinerlei Vorgangs-/Kundendaten (Tests 15/31).
    const machineOnly = await staffWith(admin.id, ['machine.view'], 'MachineOnly');
    const base = await packageFor(machineOnly.cookie);
    expect(base.machines).toHaveLength(11);
    expect(base.bookings).toHaveLength(0);
    expect(base.documents).toHaveLength(0);
    const rawBase = JSON.stringify(base);
    expect(rawBase).not.toContain('Klara');
    expect(rawBase).not.toContain('0171 9998877');
  });

  it('respektiert die Vertretungslogik und schließt unsichtbare Vorgänge aus (Tests 19/25/97/98)', async () => {
    const { admin } = await adminSession();
    const staffA = await staffWith(admin.id, OPERATIVE, 'Original');
    const staffB = await staffWith(admin.id, OPERATIVE, 'Vertretung');
    const visible = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * DAYS),
      to: new Date(Date.now() + 2 * DAYS),
    });
    // Termin an A zugewiesen, A wird aktuell von B vertreten ⇒ effektiv B (Phase 2/4).
    const scheduling = schedulingServiceFor(ctx);
    const outbound = await scheduling.byId(visible.outboundAppointmentId);
    await scheduling.assign(
      admin.id,
      outbound.id,
      { userId: staffA.user.id, expectedVersion: outbound.version },
      await ctx.auth.effectivePermissions(admin.id),
    );
    await substitutionServiceFor(ctx).create(admin.id, {
      originalUserId: staffA.user.id,
      substituteUserId: staffB.user.id,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: new Date(Date.now() + 3 * DAYS),
    });
    // Abgeschlossener Vorgang außerhalb der Sichtbarkeitsfrist: ohne process.view_completed unsichtbar.
    const hidden = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 1 * DAYS),
      to: new Date(Date.now() + 2 * DAYS),
    });
    await processServiceFor(ctx).complete(hidden.processId, adminVisibilityCtx());
    await ctx.db
      .update(processes)
      .set({ completedAt: new Date(Date.now() - 30 * DAYS) })
      .where(eq(processes.id, hidden.processId));

    const result = await packageFor(staffA.cookie);
    const ids = result.bookings.map((b) => b.bookingId);
    expect(ids).toContain(visible.bookingId);
    expect(ids).not.toContain(hidden.bookingId);
    const snapshot = result.bookings.find((b) => b.bookingId === visible.bookingId)!;
    const appointment = snapshot.appointments.find((a) => a.id === outbound.id)!;
    expect(appointment.assignedUserId).toBe(staffA.user.id);
    expect(appointment.effectiveAssigneeId).toBe(staffB.user.id);
    // Bewusst geöffneter unsichtbarer Vorgang wird still ausgelassen (keine Existenz-Orakel).
    const extra = await pkg(staffA.cookie, { extraBookingIds: [hidden.bookingId] });
    expect(extra.statusCode).toBe(200);
    expect(
      (extra.json() as { bookings: { bookingId: string }[] }).bookings.map((b) => b.bookingId),
    ).not.toContain(hidden.bookingId);

    // Einzel-Snapshot (IDOR, Tests 97/98): unsichtbar ⇒ 404; ohne Vorgangsrecht ⇒ 404.
    const own = await ctx.app.inject({
      method: 'GET',
      url: `/staff/offline/bookings/${visible.bookingId}`,
      headers: { cookie: staffA.cookie },
    });
    expect(own.statusCode).toBe(200);
    expect((own.json() as { booking: { bookingId: string } }).booking.bookingId).toBe(
      visible.bookingId,
    );
    const invisible = await ctx.app.inject({
      method: 'GET',
      url: `/staff/offline/bookings/${hidden.bookingId}`,
      headers: { cookie: staffA.cookie },
    });
    expect(invisible.statusCode).toBe(404);
    const machineOnly = await staffWith(admin.id, ['machine.view'], 'NoProcess');
    const forbidden = await ctx.app.inject({
      method: 'GET',
      url: `/staff/offline/bookings/${visible.bookingId}`,
      headers: { cookie: machineOnly.cookie },
    });
    expect(forbidden.statusCode).toBe(404);
    // Mit process.view_completed (Admin) bleibt der alte Vorgang sichtbar.
    const adminCookie = (await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD)).cookie;
    const asAdmin = await ctx.app.inject({
      method: 'GET',
      url: `/staff/offline/bookings/${hidden.bookingId}`,
      headers: { cookie: adminCookie },
    });
    expect(asAdmin.statusCode).toBe(200);
  });
});

describe('Sync: Offline-Ausgabe (Order §§15–17, 20–21, 28, 32–33; Tests 33–47, 69–91)', () => {
  it('finalisiert genau einmal: Fotos, Unterschriften, Abschluss, Replays und Zweitgerät', async () => {
    const { admin } = await adminSession();
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 3_600_000),
      to: new Date(Date.now() + 2 * DAYS),
    });
    const staff = await staffWith(admin.id, OPERATIVE, 'Handover');
    const before = await packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    const slots = snapshot.handover!.slots as { id: string; machine: null }[];
    expect(slots).toHaveLength(1);
    const slotId = slots[0]!.id;
    const candidates = snapshot.candidateMachines[slotId]!;
    const candidate = candidates.find((c) => !c.overrideRequired && !c.hardBlocked)!;
    const outbound = snapshot.appointments.find((a) => a.kind !== 'return')!;
    const base = {
      processStatus: 'open',
      appointmentId: outbound.id,
      appointmentVersion: outbound.version,
    };
    const bookingId = world.bookingId;

    // Offline gewählte Maschine (§16) + Vorbereitung
    const assign = await sync(staff.cookie, {
      type: 'handover.assign',
      contextId: bookingId,
      base: { ...base, expectedMachineId: null },
      payload: {
        assignmentId: slotId,
        machineId: candidate.machineId,
        override: null,
        situationFingerprint: candidate.situationFingerprint,
      },
    });
    expect(assign.json.status).toBe('applied');
    const prepare = await sync(staff.cookie, {
      type: 'handover.prepare',
      contextId: bookingId,
      base: { ...base, expectedMachineId: candidate.machineId },
      payload: { assignmentId: slotId },
    });
    expect(prepare.json.status).toBe('applied');
    const recipient = await sync(staff.cookie, {
      type: 'handover.recipient',
      contextId: bookingId,
      base,
      payload: { kind: 'customer', name: null, phone: null },
    });
    expect(recipient.json.status).toBe('applied');
    const check = await sync(staff.cookie, {
      type: 'handover.check_machine',
      contextId: bookingId,
      base,
      payload: { assignmentId: slotId, machineId: candidate.machineId },
    });
    expect(check.json.status).toBe('applied');
    // Gesamtfoto: Replay derselben Mutation UND dieselben Bytes unter neuer ID ⇒ ein Fachobjekt.
    const photoId = randomUUID();
    const photoInput: MutationInput = {
      id: randomUUID(),
      type: 'handover.photo',
      contextId: bookingId,
      base,
      payload: { assignmentId: slotId, machineId: candidate.machineId, mediaId: photoId },
      media: [
        { mediaId: photoId, purpose: 'handover_photo', mimeType: 'image/png', bytes: pngBytes() },
      ],
    };
    const photo = await sync(staff.cookie, photoInput);
    expect(photo.json.status).toBe('applied');
    const photoReplay = await sync(staff.cookie, photoInput);
    expect(photoReplay.json.deduplicated).toBe(true);
    expect(photoReplay.json.resultRef).toEqual(photo.json.resultRef);
    const sameBytes = randomUUID();
    const dupPhoto = await sync(staff.cookie, {
      type: 'handover.photo',
      contextId: bookingId,
      base,
      payload: { assignmentId: slotId, machineId: candidate.machineId, mediaId: sameBytes },
      media: [
        { mediaId: sameBytes, purpose: 'handover_photo', mimeType: 'image/png', bytes: pngBytes() },
      ],
    });
    expect(dupPhoto.json.status).toBe('applied');
    expect(dupPhoto.json.resultRef).toEqual(photo.json.resultRef);
    for (const role of ['customer', 'staff'] as const) {
      const sig = randomUUID();
      const signature = await sync(staff.cookie, {
        type: 'handover.signature',
        contextId: bookingId,
        base,
        payload: { role, mediaId: sig },
        media: [
          {
            mediaId: sig,
            purpose: 'handover_signature',
            mimeType: 'image/png',
            bytes: pngBytes(),
          },
        ],
      });
      expect(signature.json.status).toBe('applied');
    }
    // Erfasst vor 30 Minuten (offline), Mutation im selben Moment erstellt – so wie der Client es tut.
    const capturedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const finalizeInput: MutationInput = {
      id: randomUUID(),
      type: 'handover.finalize',
      contextId: bookingId,
      base,
      createdAt: capturedAt,
      payload: {
        capturedAt,
        expectedSlots: [{ assignmentId: slotId, machineId: candidate.machineId }],
      },
    };
    // Zwei Geräte schließen GLEICHZEITIG ab (§67): genau einer gewinnt, der andere sieht
    // „bereits abgeschlossen“ – nie zwei scheinbare Erfolge (Kontext-Serialisierung).
    const concurrentInput: MutationInput = { ...finalizeInput, id: randomUUID() };
    const [firstOutcome, secondOutcome] = await Promise.all([
      sync(staff.cookie, finalizeInput),
      sync(staff.cookie, concurrentInput, { deviceId: DEVICE_B }),
    ]);
    const outcomes = [firstOutcome, secondOutcome];
    expect(outcomes.filter((r) => r.json.status === 'applied')).toHaveLength(1);
    const loser = outcomes.find((r) => r.json.status === 'conflict')!;
    expect(loser.json.code).toBe('ALREADY_FINALIZED');
    const winnerInput = firstOutcome.json.status === 'applied' ? finalizeInput : concurrentInput;
    const winnerDevice = firstOutcome.json.status === 'applied' ? DEVICE : DEVICE_B;
    const issuesAfterFirst = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.kind, 'issue'));
    expect(issuesAfterFirst.length).toBeGreaterThan(0);
    const replay = await sync(staff.cookie, winnerInput, { deviceId: winnerDevice });
    expect(replay.json.status).toBe('applied');
    expect(replay.json.deduplicated).toBe(true);
    // „Erneut anwenden“ des Verlierers: erneute Bewertung über den Domainservice, kein Force (Test 90/91).
    const loserInput = winnerInput === finalizeInput ? concurrentInput : finalizeInput;
    const loserDevice = winnerDevice === DEVICE ? DEVICE_B : DEVICE;
    const retried = await sync(staff.cookie, loserInput, { deviceId: loserDevice });
    expect(retried.json.status).toBe('conflict');
    expect(retried.json.code).toBe('ALREADY_FINALIZED');

    // Serverzustand: genau eine Finalisierung, eine Lagerausgabe, Maschine vermietet, PDFs serverseitig.
    const handoverRows = await ctx.db
      .select()
      .from(handovers)
      .where(eq(handovers.bookingId, bookingId));
    expect(handoverRows[0]!.status).toBe('finalized');
    expect(handoverRows[0]!.actualIssueAt?.toISOString()).toBe(capturedAt);
    const docs = await ctx.db.select().from(documents).where(eq(documents.bookingId, bookingId));
    expect(docs.map((d) => d.type).sort()).toEqual(['delivery_note', 'handover_protocol']);
    const issuesAfterReplay = await ctx.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.kind, 'issue'));
    expect(issuesAfterReplay).toHaveLength(issuesAfterFirst.length); // Replay bucht nicht erneut (Test 44)
    const machineRows = await ctx.db
      .select()
      .from(machines)
      .where(eq(machines.id, candidate.machineId));
    expect(machineRows[0]!.status).toBe('rented');

    // Zweites Gerät (§67): eigener Abschluss → Konflikt, keine zweite Finalisierung.
    const second = await sync(
      staff.cookie,
      { ...finalizeInput, id: randomUUID() },
      { deviceId: DEVICE_B },
    );
    expect(second.json.status).toBe('conflict');
    expect(second.json.code).toBe('ALREADY_FINALIZED');
    expect(
      await ctx.db.select().from(documents).where(eq(documents.bookingId, bookingId)),
    ).toHaveLength(2);
    expect(
      await ctx.db.select().from(inventoryMovements).where(eq(inventoryMovements.kind, 'issue')),
    ).toHaveLength(issuesAfterFirst.length); // Zweitgerät bucht nicht erneut (Test 44)
    const receipts = await ctx.db.select().from(offlineMutationReceipts);
    expect(receipts.filter((r) => r.status === 'applied').length).toBeGreaterThanOrEqual(8);
    expect(receipts.filter((r) => r.status === 'conflict')).toHaveLength(2);
    expect(receipts.filter((r) => r.status === 'processing')).toHaveLength(0);
    // Quittungen enthalten nur technische Metadaten (§63).
    for (const receipt of receipts) {
      const text = JSON.stringify(receipt);
      expect(text).not.toContain('dataBase64');
      expect(text).not.toContain('Kunde');
    }
    // Nach dem Sync spiegelt das Paket den Serverstand (final, keine Kandidaten mehr).
    const after = await packageFor(staff.cookie);
    const synced = after.bookings.find((b) => b.bookingId === bookingId);
    expect(synced?.returnStartable).toBe(true);
    expect((synced?.handover as { handover: { status: string } }).handover.status).toBe(
      'finalized',
    );
    expect(Object.keys(synced?.candidateMachines ?? {})).toHaveLength(0);
  });

  it('erkennt Storno, Neuzuweisung, Terminänderung und Uhrzeit-Unplausibilität als Konflikt (Tests 81–85, 69)', async () => {
    const { admin } = await adminSession();
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 3_600_000),
      to: new Date(Date.now() + 2 * DAYS),
    });
    const staff = await staffWith(admin.id, OPERATIVE, 'Conflict');
    const before = await packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    const slotId = (snapshot.handover!.slots as { id: string }[])[0]!.id;
    const outbound = snapshot.appointments.find((a) => a.kind !== 'return')!;
    const base = {
      processStatus: 'open',
      appointmentId: outbound.id,
      appointmentVersion: outbound.version,
    };
    const services = handoverServicesFor(ctx);
    const effective = await ctx.auth.effectivePermissions(admin.id);
    const machineA = await machineByCode(ctx.db, 'MR-10-01-01');
    const machineB = await machineByCode(ctx.db, 'MR-10-01-02');
    await services.assignments.assign(admin.id, effective, slotId, machineA.id, null);

    // Serverseitig inzwischen andere Maschine → Prüfung mit alter Maschine ist ein Konflikt.
    await services.assignments.assign(admin.id, effective, slotId, machineB.id, null);
    const stale = await sync(staff.cookie, {
      type: 'handover.check_machine',
      contextId: world.bookingId,
      base,
      payload: { assignmentId: slotId, machineId: machineA.id },
    });
    expect(stale.json.status).toBe('conflict');
    expect(stale.json.code).toBe('MACHINE_REASSIGNED');
    // Offline gewählte Zuweisung gegen veraltete Basis → Konflikt, kein stilles Überschreiben (Test 87).
    const staleAssign = await sync(staff.cookie, {
      type: 'handover.assign',
      contextId: world.bookingId,
      base: { ...base, expectedMachineId: null },
      payload: {
        assignmentId: slotId,
        machineId: machineA.id,
        override: null,
        situationFingerprint: null,
      },
    });
    expect(staleAssign.json.status).toBe('conflict');
    expect(staleAssign.json.code).toBe('MACHINE_REASSIGNED');
    // Offline gewählte Maschine ist inzwischen an einen ANDEREN Vorgang ausgegeben → harter
    // Konflikt, keine Zuweisung (Test 82).
    await issuedBooking(ctx, admin.id, {
      machineCodes: ['MR-10-01-03'],
      to: new Date(Date.now() + 3 * DAYS),
      skipInventoryInit: true,
    });
    const rentedElsewhere = await machineByCode(ctx.db, 'MR-10-01-03');
    const unavailable = await sync(staff.cookie, {
      type: 'handover.assign',
      contextId: world.bookingId,
      base: { ...base, expectedMachineId: machineB.id },
      payload: {
        assignmentId: slotId,
        machineId: rentedElsewhere.id,
        override: null,
        situationFingerprint: null,
      },
    });
    expect(unavailable.json.status).toBe('conflict');
    expect(unavailable.json.code).toBe('MACHINE_UNAVAILABLE');
    expect((await services.handover.detail(world.bookingId)).slots[0]!.machine?.id).toBe(
      machineB.id,
    );
    // Problemlage laut Paket stimmt nicht mehr (anderer Fingerprint) → SITUATION_CHANGED (§49).
    const situation = await sync(staff.cookie, {
      type: 'handover.assign',
      contextId: world.bookingId,
      base: { ...base, expectedMachineId: machineB.id },
      payload: {
        assignmentId: slotId,
        machineId: machineA.id,
        override: null,
        situationFingerprint: 'f'.repeat(64),
      },
    });
    expect(situation.json.status).toBe('conflict');
    expect(situation.json.code).toBe('SITUATION_CHANGED');

    // Terminänderung → Finalisierung erkennt geänderte Version.
    const scheduling = schedulingServiceFor(ctx);
    await scheduling.reschedule(admin.id, outbound.id, {
      startAt: new Date(Date.now() + 2 * 3_600_000),
      endAt: null,
      expectedVersion: outbound.version,
    });
    const staleFinalize = await sync(staff.cookie, {
      type: 'handover.finalize',
      contextId: world.bookingId,
      base,
      payload: { capturedAt: new Date().toISOString(), expectedSlots: [] },
    });
    expect(staleFinalize.json.status).toBe('conflict');
    expect(staleFinalize.json.code).toBe('APPOINTMENT_CHANGED');

    // Uhrzeit-Plausibilität (§69): Gerätezeit 3 h daneben → „Gerätezeit prüfen“, nicht still übernehmen.
    const skewed = await sync(
      staff.cookie,
      {
        type: 'handover.finalize',
        contextId: world.bookingId,
        payload: { capturedAt: new Date().toISOString(), expectedSlots: [] },
      },
      { clientTime: new Date(Date.now() + 3 * 3_600_000).toISOString() },
    );
    expect(skewed.json.status).toBe('conflict');
    expect(skewed.json.code).toBe('CLOCK_IMPLAUSIBLE');
    // Unvollständiger Serverstand (Blocker) → kein Abschluss, Konflikt zur Prüfung.
    const current = await services.handover.detail(world.bookingId);
    const currentAppointment = current.handover.appointment!;
    const freshBase = {
      processStatus: 'open',
      appointmentId: currentAppointment.id,
      appointmentVersion: outbound.version + 1,
    };
    const blocked = await sync(staff.cookie, {
      type: 'handover.finalize',
      contextId: world.bookingId,
      base: freshBase,
      payload: {
        capturedAt: new Date().toISOString(),
        expectedSlots: [{ assignmentId: slotId, machineId: machineB.id }],
      },
    });
    expect(blocked.json.status).toBe('conflict');
    expect(blocked.json.code).toBe('SERVER_STATE_CHANGED');
    expect((await services.handover.detail(world.bookingId)).handover.status).toBe('draft');

    // Storno während offline (Test 83): Konflikt, keine Fachwirkung.
    await processServiceFor(ctx).cancel(world.processId, adminVisibilityCtx());
    const cancelled = await sync(staff.cookie, {
      type: 'handover.recipient',
      contextId: world.bookingId,
      base,
      payload: { kind: 'customer', name: null, phone: null },
    });
    expect(cancelled.json.status).toBe('conflict');
    expect(cancelled.json.code).toBe('PROCESS_CANCELLED');
    const receipts = await ctx.db.select().from(offlineMutationReceipts);
    expect(receipts.every((r) => r.status === 'conflict')).toBe(true);
    expect(receipts.every((r) => r.errorCode !== null && r.resultRef === null)).toBe(true);
  });

  it('weist Mengenkonflikte ab und erlaubt den Retry einer Konflikt-Mutation nach Korrektur (§64; Tests 47/64)', async () => {
    const { admin } = await adminSession();
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 3_600_000),
      to: new Date(Date.now() + 2 * DAYS),
      selections: [{ slug: 'sirup-kirsche', role: 'extra', quantity: 3 }],
    });
    const staff = await staffWith(admin.id, OPERATIVE, 'Qty');
    const before = await packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    const items = snapshot.handover!.deliveryNote as {
      items: { id: string; kind: string; actualQuantity: number }[];
    };
    const item = items.items.find((i) => i.kind === 'commission')!;
    const id = randomUUID();
    const conflict = await sync(staff.cookie, {
      id,
      type: 'handover.item_quantity',
      contextId: world.bookingId,
      payload: {
        itemId: item.id,
        actualQuantity: 2,
        expectedPreviousQuantity: item.actualQuantity + 5,
      },
    });
    expect(conflict.json.status).toBe('conflict');
    expect(conflict.json.code).toBe('QUANTITY_CHANGED');
    const retry = await sync(staff.cookie, {
      id,
      type: 'handover.item_quantity',
      contextId: world.bookingId,
      payload: {
        itemId: item.id,
        actualQuantity: 2,
        expectedPreviousQuantity: item.actualQuantity,
      },
    });
    expect(retry.json.status).toBe('applied');
    expect(retry.json.deduplicated).toBe(false);
    const persisted = await ctx.db
      .select()
      .from(deliveryNoteItems)
      .where(eq(deliveryNoteItems.id, item.id));
    expect(persisted[0]!.actualQuantity).toBe(2); // Menge serverseitig übernommen (Test 40)
    const receipt = await ctx.db
      .select()
      .from(offlineMutationReceipts)
      .where(eq(offlineMutationReceipts.clientMutationId, id));
    expect(receipt[0]!.status).toBe('applied');
    expect(receipt[0]!.errorCode).toBeNull();
  });
});

describe('Sync: Offline-Rückgabe und Reinigung (Order §§18–25, 28; Tests 48–68)', () => {
  it('führt eine komplette Offline-Rückgabe mit Schaden, Foto und Kommission genau einmal aus', async () => {
    const { admin } = await adminSession();
    const world = await issuedBooking(ctx, admin.id, {
      machineCodes: ['MR-10-01-01'],
      selections: [{ slug: 'sirup-kirsche', role: 'extra', quantity: 3 }],
      to: new Date(Date.now() + 1 * DAYS),
    });
    const staff = await staffWith(admin.id, OPERATIVE, 'Return');
    const before = await packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    expect(snapshot.returnStartable).toBe(true);
    const seed = snapshot.returnSeed!;
    const machine = seed.machines[0]!;
    const commission = seed.items.find((i) => i.kind === 'commission')!;
    const returnAppointment = snapshot.appointments.find((a) => a.kind === 'return')!;
    const base = {
      processStatus: 'open',
      appointmentId: returnAppointment.id,
      appointmentVersion: returnAppointment.version,
    };
    const bookingId = world.bookingId;
    const common = { assignmentId: machine.assignmentId, machineId: machine.machineId };

    // Rückgabe-Schritte vor dem Start: Abhängigkeit nicht erfüllt, kein stilles Anlegen.
    const early = await sync(staff.cookie, {
      type: 'return.returner',
      contextId: bookingId,
      base,
      payload: { kind: 'customer', firstName: null, lastName: null, phone: null },
    });
    expect(early.json.status).toBe('conflict');
    expect(early.json.code).toBe('DEPENDENCY_NOT_APPLIED');

    const startInput: MutationInput = {
      id: randomUUID(),
      type: 'return.start',
      contextId: bookingId,
      base,
      payload: {},
    };
    const start = await sync(staff.cookie, startInput);
    expect(start.json.status).toBe('applied');
    expect((await sync(staff.cookie, startInput)).json.deduplicated).toBe(true);
    // Zweiter Start unter neuer ID bleibt idempotent (eine Rückgabe).
    expect((await sync(staff.cookie, { ...startInput, id: randomUUID() })).json.status).toBe(
      'applied',
    );
    expect(
      await ctx.db.select().from(rentalReturns).where(eq(rentalReturns.bookingId, bookingId)),
    ).toHaveLength(1);
    expect(
      (
        await sync(staff.cookie, {
          type: 'return.returner',
          contextId: bookingId,
          base,
          payload: { kind: 'customer', firstName: null, lastName: null, phone: null },
        })
      ).json.status,
    ).toBe('applied');
    expect(
      (
        await sync(staff.cookie, {
          type: 'return.accessory',
          contextId: bookingId,
          base,
          payload: common,
        })
      ).json.status,
    ).toBe('applied');
    expect(
      (
        await sync(staff.cookie, {
          type: 'return.cleanliness',
          contextId: bookingId,
          base,
          payload: { ...common, emptied: true, rinsedTwice: true, nothingDismantled: true },
        })
      ).json.status,
    ).toBe('applied');
    // Kommissionsrückgabe: nur ungeöffnete Menge; > ausgegeben wird serverseitig abgelehnt (Test 53).
    const tooMany = await sync(staff.cookie, {
      type: 'return.item_quantity',
      contextId: bookingId,
      base,
      payload: {
        deliveryNoteItemId: commission.deliveryNoteItemId,
        returnedUnopenedQuantity: commission.issuedQuantity + 1,
        expectedIssuedQuantity: commission.issuedQuantity,
      },
    });
    expect(tooMany.json.status).toBe('rejected');
    const changedIssue = await sync(staff.cookie, {
      type: 'return.item_quantity',
      contextId: bookingId,
      base,
      payload: {
        deliveryNoteItemId: commission.deliveryNoteItemId,
        returnedUnopenedQuantity: 1,
        expectedIssuedQuantity: commission.issuedQuantity + 1,
      },
    });
    expect(changedIssue.json.status).toBe('conflict');
    expect(changedIssue.json.code).toBe('QUANTITY_CHANGED');
    expect(
      (
        await sync(staff.cookie, {
          type: 'return.item_quantity',
          contextId: bookingId,
          base,
          payload: {
            deliveryNoteItemId: commission.deliveryNoteItemId,
            returnedUnopenedQuantity: 1,
            expectedIssuedQuantity: commission.issuedQuantity,
          },
        })
      ).json.status,
    ).toBe('applied');
    expect(commission.issuedQuantity).toBeGreaterThanOrEqual(1);
    const persistedItem = (
      await ctx.db
        .select()
        .from(returnInventoryItems)
        .where(eq(returnInventoryItems.deliveryNoteItemId, commission.deliveryNoteItemId))
    )[0]!;
    expect(persistedItem.returnedUnopenedQuantity).toBe(1); // Test 52
    // Schaden mit Marker + Foto über die Mutations-Referenz (§29 Abhängigkeit).
    const damageId = randomUUID();
    const damage = await sync(staff.cookie, {
      id: damageId,
      type: 'return.damage',
      contextId: bookingId,
      base,
      payload: {
        ...common,
        severity: 'light',
        description: 'Kratzer am Gehäuse',
        markers: [{ view: 'front', markerType: 'point', x: 0.4, y: 0.6 }],
        clientDamageId: randomUUID(),
      },
    });
    expect(damage.json.status).toBe('applied');
    expect(typeof (damage.json.resultRef as { damageId: string }).damageId).toBe('string');
    // Foto zu einem Schaden, dessen Mutation nie angewendet wurde → Abhängigkeit nicht erfüllt.
    const orphanMedia = randomUUID();
    const orphan = await sync(staff.cookie, {
      type: 'return.damage_photo',
      contextId: bookingId,
      base,
      payload: { damageMutationId: randomUUID(), damageId: null, mediaId: orphanMedia },
      media: [
        {
          mediaId: orphanMedia,
          purpose: 'return_damage_photo',
          mimeType: 'image/jpeg',
          bytes: jpegBytes(),
        },
      ],
    });
    expect(orphan.json.status).toBe('conflict');
    expect(orphan.json.code).toBe('DEPENDENCY_NOT_APPLIED');
    const damagePhotoMedia = randomUUID();
    const damagePhotoInput: MutationInput = {
      id: randomUUID(),
      type: 'return.damage_photo',
      contextId: bookingId,
      base,
      payload: { damageMutationId: damageId, damageId: null, mediaId: damagePhotoMedia },
      media: [
        {
          mediaId: damagePhotoMedia,
          purpose: 'return_damage_photo',
          mimeType: 'image/jpeg',
          bytes: jpegBytes(),
        },
      ],
    };
    const damagePhoto = await sync(staff.cookie, damagePhotoInput);
    expect(damagePhoto.json.status).toBe('applied');
    expect((await sync(staff.cookie, damagePhotoInput)).json.deduplicated).toBe(true);
    for (const role of ['customer', 'staff'] as const) {
      const sig = randomUUID();
      expect(
        (
          await sync(staff.cookie, {
            type: 'return.signature',
            contextId: bookingId,
            base,
            payload: { role, mediaId: sig },
            media: [
              {
                mediaId: sig,
                purpose: 'return_signature',
                mimeType: 'image/png',
                bytes: pngBytes(),
              },
            ],
          })
        ).json.status,
      ).toBe('applied');
    }
    const capturedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const finalizeInput: MutationInput = {
      id: randomUUID(),
      type: 'return.finalize',
      contextId: bookingId,
      base,
      payload: { capturedAt, expectedMachines: [common] },
    };
    expect((await sync(staff.cookie, finalizeInput)).json.status).toBe('applied');
    expect((await sync(staff.cookie, finalizeInput)).json.deduplicated).toBe(true);

    const ret = (
      await ctx.db.select().from(rentalReturns).where(eq(rentalReturns.bookingId, bookingId))
    )[0]!;
    expect(ret.status).toBe('finalized');
    expect(ret.actualReturnAt?.toISOString()).toBe(capturedAt);
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('cleaning');
    expect(
      await ctx.db.select().from(inventoryMovements).where(eq(inventoryMovements.kind, 'return')),
    ).toHaveLength(1);
    expect(
      await ctx.db
        .select()
        .from(documents)
        .where(and(eq(documents.bookingId, bookingId), eq(documents.type, 'return_protocol'))),
    ).toHaveLength(1);
    expect(await ctx.db.select().from(machineDamages)).toHaveLength(1);
    // Zweitgerät (§67): eigener Abschluss → Konflikt „bereits abgeschlossen“.
    const second = await sync(
      staff.cookie,
      { ...finalizeInput, id: randomUUID() },
      { deviceId: DEVICE_B },
    );
    expect(second.json.status).toBe('conflict');
    expect(second.json.code).toBe('ALREADY_FINALIZED');
    expect(
      await ctx.db.select().from(inventoryMovements).where(eq(inventoryMovements.kind, 'return')),
    ).toHaveLength(1); // Zweitgerät bucht nicht erneut (Test 61)
    // Bestehende Schäden der Maschine liegen im nächsten Paket (Test 24).
    const after = await packageFor(staff.cookie);
    const damaged = after.machines.find((m) => m.machineCode === 'MR-10-01-01')!;
    expect(damaged.status).toBe('cleaning');
    expect(damaged.currentDamages.map((d) => d.description)).toEqual(['Kratzer am Gehäuse']);
    // Abgeschlossener Vorgang ist nicht mehr automatisch relevant – bewusst geöffnet (§10,
    // extraBookingIds) liefert er Schäden und das Rückgabeprotokoll.
    expect(after.bookings.map((b) => b.bookingId)).not.toContain(bookingId);
    const extra = (
      await pkg(staff.cookie, { extraBookingIds: [bookingId] })
    ).json() as typeof after;
    const afterSnapshot = extra.bookings.find((b) => b.bookingId === bookingId)!;
    expect(afterSnapshot.relevance).toEqual(['extra']);
    expect(afterSnapshot.returnStartable).toBe(false);
    expect((afterSnapshot.return as { return: { status: string } }).return.status).toBe(
      'finalized',
    );
    expect(afterSnapshot.existingDamages[machine.machineId]?.map((d) => d.description)).toEqual([
      'Kratzer am Gehäuse',
    ]);
    expect(afterSnapshot.documents.map((d) => d.type).sort()).toEqual([
      'delivery_note',
      'handover_protocol',
      'return_protocol',
    ]);
  });

  it('Fehlteil und Reinigungs-Beweisfoto offline: genau einmal, Foto-Duplikat per Hash erkannt (Tests 54/57)', async () => {
    const { admin } = await adminSession();
    const world = await issuedBooking(ctx, admin.id, {
      machineCodes: ['MR-10-01-02'],
      to: new Date(Date.now() + 1 * DAYS),
    });
    const staff = await staffWith(admin.id, OPERATIVE, 'Missing');
    const before = await packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    const machine = snapshot.returnSeed!.machines[0]!;
    const returnAppointment = snapshot.appointments.find((a) => a.kind === 'return')!;
    const base = {
      processStatus: 'open',
      appointmentId: returnAppointment.id,
      appointmentVersion: returnAppointment.version,
    };
    const bookingId = world.bookingId;
    const common = { assignmentId: machine.assignmentId, machineId: machine.machineId };
    expect(
      (await sync(staff.cookie, { type: 'return.start', contextId: bookingId, base, payload: {} }))
        .json.status,
    ).toBe('applied');
    // Fehlteil (Deckel) offline erfasst – genau ein Fall auch bei Replay (Test 54).
    const missingInput: MutationInput = {
      id: randomUUID(),
      type: 'return.missing_item',
      contextId: bookingId,
      base,
      payload: { ...common, accessoryType: 'lid', missingQuantity: 1, description: null },
    };
    expect((await sync(staff.cookie, missingInput)).json.status).toBe('applied');
    expect((await sync(staff.cookie, missingInput)).json.deduplicated).toBe(true);
    expect(await ctx.db.select().from(missingAccessoryCases)).toHaveLength(1);
    // Beanstandete Sauberkeit ⇒ Reinigungsfall; Beweisfoto offline (Test 57), Duplikat per SHA-256.
    expect(
      (
        await sync(staff.cookie, {
          type: 'return.cleanliness',
          contextId: bookingId,
          base,
          payload: { ...common, emptied: false, rinsedTwice: false, nothingDismantled: true },
        })
      ).json.status,
    ).toBe('applied');
    const webp = randomUUID();
    const wrongFormat = await sync(staff.cookie, {
      type: 'return.cleanup_photo',
      contextId: bookingId,
      base,
      payload: { ...common, mediaId: webp },
      media: [
        {
          mediaId: webp,
          purpose: 'return_cleanup_photo',
          mimeType: 'image/webp',
          bytes: jpegBytes(),
        },
      ],
    });
    expect(wrongFormat.json.status).toBe('rejected');
    expect(wrongFormat.json.code).toBe('VALIDATION');
    const photoId = randomUUID();
    const photoInput: MutationInput = {
      id: randomUUID(),
      type: 'return.cleanup_photo',
      contextId: bookingId,
      base,
      payload: { ...common, mediaId: photoId },
      media: [
        {
          mediaId: photoId,
          purpose: 'return_cleanup_photo',
          mimeType: 'image/jpeg',
          bytes: jpegBytes(),
        },
      ],
    };
    expect((await sync(staff.cookie, photoInput)).json.status).toBe('applied');
    expect((await sync(staff.cookie, photoInput)).json.deduplicated).toBe(true);
    const sameBytesOtherId = randomUUID();
    const dup = await sync(staff.cookie, {
      type: 'return.cleanup_photo',
      contextId: bookingId,
      base,
      payload: { ...common, mediaId: sameBytesOtherId },
      media: [
        {
          mediaId: sameBytesOtherId,
          purpose: 'return_cleanup_photo',
          mimeType: 'image/jpeg',
          bytes: jpegBytes(),
        },
      ],
    });
    expect(dup.json.status).toBe('applied');
    expect(await ctx.db.select().from(returnPhotos)).toHaveLength(1);
    const view = await handoverServicesFor(ctx).returns.detail(bookingId);
    const rm = view.machines[0]!;
    expect(rm.cleanupRequired).toBe(true);
    expect(rm.cleanupPhotos).toHaveLength(1);
    expect(rm.missingCases).toHaveLength(1);
    expect(rm.accessoryComplete).toBe(false);
  });

  it('Reinigungsabschluss offline: unverändert → erfolgreich; anderer Zyklus/Status → Konflikt (Tests 65–68)', async () => {
    const { admin } = await adminSession();
    const { world, services } = await startedReturn(ctx, admin.id, {
      machineCodes: ['MR-10-01-01'],
    });
    await readyReturn(ctx, admin.id, services, world.bookingId);
    await services.returns.finalize(admin.id, world.bookingId);
    const staff = await staffWith(admin.id, OPERATIVE, 'Cleaning');
    const before = await packageFor(staff.cookie);
    const machine = before.machines.find((m) => m.machineCode === 'MR-10-01-01')!;
    expect(machine.status).toBe('cleaning');
    expect(machine.cleaningSince).not.toBeNull();

    const wrongCycle = await sync(staff.cookie, {
      type: 'machine.clean_complete',
      contextId: machine.machineId,
      base: { machineUpdatedAt: null },
      payload: { expectedCleaningSince: new Date(0).toISOString() },
    });
    expect(wrongCycle.json.status).toBe('conflict');
    expect(wrongCycle.json.code).toBe('CLEANING_CYCLE_CHANGED');
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('cleaning');

    const input: MutationInput = {
      id: randomUUID(),
      type: 'machine.clean_complete',
      contextId: machine.machineId,
      base: { machineUpdatedAt: null },
      payload: { expectedCleaningSince: machine.cleaningSince },
    };
    expect((await sync(staff.cookie, input)).json.status).toBe('applied');
    expect((await machineByCode(ctx.db, 'MR-10-01-01')).status).toBe('ready');
    expect((await sync(staff.cookie, input)).json.deduplicated).toBe(true);
    const again = await sync(staff.cookie, { ...input, id: randomUUID() });
    expect(again.json.status).toBe('conflict');
    expect(again.json.code).toBe('NOT_IN_CLEANING');
    // Ohne machine.clean_complete keine Wirkung (Rechte je Mutation frisch, Test 86).
    const viewer = await staffWith(admin.id, ['machine.view'], 'Viewer');
    expect((await lease(viewer.cookie, DEVICE_B)).statusCode).toBe(200);
    const denied = await sync(
      viewer.cookie,
      { ...input, id: randomUUID() },
      { deviceId: DEVICE_B },
    );
    expect(denied.json.status).toBe('rejected');
    expect(denied.json.code).toBe('PERMISSION_REVOKED');
  });
});

describe('Sync-Sicherheit (Order §§21, 62, 74, 75; Tests 86, 99, 104–108)', () => {
  it('entzogene Rechte, fremde Mutations-IDs, manipulierte Typen und Medien werden abgelehnt', async () => {
    const { admin } = await adminSession();
    const { world } = await startedReturn(ctx, admin.id, { machineCodes: ['MR-10-01-01'] });
    const staff = await staffWith(admin.id, OPERATIVE, 'Security');
    await packageFor(staff.cookie);
    // Finanzaktion als Offline-Mutation (Test 105): strukturell unmöglich (strict Schema).
    const finance = await ctx.app.inject({
      method: 'POST',
      url: '/staff/offline/sync',
      headers: { cookie: staff.cookie },
      payload: {
        deviceId: DEVICE,
        environment: 'development',
        clientTime: new Date().toISOString(),
        mutation: mutation({
          type: 'settlement.discount',
          contextId: world.bookingId,
          payload: { amountCents: 1 },
        }),
      },
    });
    expect(finance.statusCode).toBe(400);
    // Force-/Override-Flag auf Request-Ebene existiert nicht (Test 91).
    const forced = await ctx.app.inject({
      method: 'POST',
      url: '/staff/offline/sync',
      headers: { cookie: staff.cookie },
      payload: {
        deviceId: DEVICE,
        environment: 'development',
        clientTime: new Date().toISOString(),
        force: true,
        mutation: mutation({
          type: 'return.returner',
          contextId: world.bookingId,
          payload: { kind: 'customer', firstName: null, lastName: null, phone: null },
        }),
      },
    });
    expect(forced.statusCode).toBe(400);
    // Manipulierte Media-Zuordnung: Hash passt nicht zu den Bytes (Test 107).
    const mediaId = randomUUID();
    const tampered = await sync(staff.cookie, {
      type: 'return.signature',
      contextId: world.bookingId,
      payload: { role: 'customer', mediaId },
      media: [
        {
          mediaId,
          purpose: 'return_signature',
          mimeType: 'image/png',
          bytes: pngBytes(),
          sha256: 'f'.repeat(64),
        },
      ],
    });
    expect(tampered.json.status).toBe('rejected');
    expect(tampered.json.code).toBe('MEDIA_HASH_MISMATCH');
    // Unterschrift-/Fotobytes und Kontaktdaten tauchen weder in der Antwort noch in Quittungen
    // oder Security-Events auf (Tests 93–95).
    const bytesB64 = Buffer.from(pngBytes()).toString('base64').slice(0, 32);
    expect(tampered.response.body).not.toContain(bytesB64);
    expect(tampered.response.body).not.toContain('dataBase64');
    const leakRows = [
      ...(await ctx.db.select().from(offlineMutationReceipts)).map((r) =>
        JSON.stringify({ m: r.message, e: r.errorCode, r: r.resultRef }),
      ),
      ...(await ctx.db.select().from(staffSecurityEvents)).map((e) => JSON.stringify(e.details)),
    ].join('\n');
    expect(leakRows).not.toContain(bytesB64);
    expect(leakRows).not.toContain('0171 9998877');
    expect(leakRows).not.toContain('Klara');
    // Gültiger Typ auf fremder Payload vertauscht (Test 106): strukturell abgelehnt.
    const swapped = await sync(staff.cookie, {
      type: 'return.finalize',
      contextId: world.bookingId,
      payload: { role: 'customer', mediaId },
    });
    expect(swapped.json.status).toBe('rejected');
    expect(swapped.json.code).toBe('VALIDATION');
    // Medienzweck passt nicht zur Aktion (Test 107).
    const wrongPurpose = await sync(staff.cookie, {
      type: 'return.signature',
      contextId: world.bookingId,
      payload: { role: 'customer', mediaId },
      media: [
        { mediaId, purpose: 'return_cleanup_photo', mimeType: 'image/png', bytes: pngBytes() },
      ],
    });
    expect(wrongPurpose.json.status).toBe('rejected');
    expect(wrongPurpose.json.code).toBe('VALIDATION');
    // Fehlende Medienreferenz.
    const missing = await sync(staff.cookie, {
      type: 'return.signature',
      contextId: world.bookingId,
      payload: { role: 'staff', mediaId: randomUUID() },
    });
    expect(missing.json.status).toBe('rejected');
    // Kontextart passt nicht zum Typ.
    const wrongKind = await sync(staff.cookie, {
      type: 'return.returner',
      contextKind: 'machine',
      contextId: world.bookingId,
      payload: { kind: 'customer', firstName: null, lastName: null, phone: null },
    });
    expect(wrongKind.json.status).toBe('rejected');
    expect(wrongKind.json.code).toBe('VALIDATION');
    // Fremder Vorgang/unsichtbare Buchung: neutraler Konflikt, keine Wirkung.
    const unknown = await sync(staff.cookie, {
      type: 'return.returner',
      contextId: randomUUID(),
      payload: { kind: 'customer', firstName: null, lastName: null, phone: null },
    });
    expect(unknown.json.status).toBe('conflict');
    expect(unknown.json.code).toBe('NOT_VISIBLE');
    // Gültige Mutation eines Benutzers …
    const own = await sync(staff.cookie, {
      type: 'return.returner',
      contextId: world.bookingId,
      payload: { kind: 'customer', firstName: null, lastName: null, phone: null },
    });
    expect(own.json.status).toBe('applied');
    // … kann von einem ANDEREN Benutzer nicht wiederverwendet werden (Test 99/108).
    const other = await staffWith(admin.id, OPERATIVE, 'Other');
    expect((await lease(other.cookie, DEVICE_B)).statusCode).toBe(200);
    const foreign = await sync(
      other.cookie,
      {
        id: own.id,
        type: 'return.returner',
        contextId: world.bookingId,
        payload: { kind: 'customer', firstName: null, lastName: null, phone: null },
      },
      { deviceId: DEVICE_B },
    );
    expect(foreign.json.status).toBe('rejected');
    expect(foreign.json.code).toBe('FORBIDDEN');
    const ownReceipt = await ctx.db
      .select()
      .from(offlineMutationReceipts)
      .where(eq(offlineMutationReceipts.clientMutationId, own.id));
    expect(ownReceipt[0]!.staffUserId).toBe(staff.user.id);
    expect(ownReceipt[0]!.status).toBe('applied');
    // Rechte inzwischen entzogen (Test 86/104): serverseitige Prüfung ist unabhängig vom Offline-Snapshot.
    await ctx.admin.setUserRoles(admin.id, staff.user.id, []);
    const revoked = await sync(staff.cookie, {
      type: 'return.returner',
      contextId: world.bookingId,
      payload: { kind: 'customer', firstName: null, lastName: null, phone: null },
    });
    expect(revoked.json.status).toBe('rejected');
    expect(revoked.json.code).toBe('PERMISSION_REVOKED');
    // Auch das Paket spiegelt die entzogenen Rechte (kein eingefrorener Snapshot).
    const stripped = await pkg(staff.cookie);
    expect(stripped.statusCode).toBe(200);
    const strippedJson = stripped.json() as { permissions: string[]; bookings: unknown[] };
    expect(strippedJson.permissions).toEqual([]);
    expect(strippedJson.bookings).toHaveLength(0);
  });

  it('Erfassungszeit-Plausibilität, Basisstand-Pflicht und Mutations-ID-Wiederverwendung (§§33, 63, 69)', async () => {
    const { admin } = await adminSession();
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 3_600_000),
      to: new Date(Date.now() + 2 * DAYS),
    });
    const staff = await staffWith(admin.id, OPERATIVE, 'Clock');
    const before = await packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    const outbound = snapshot.appointments.find((a) => a.kind !== 'return')!;
    const base = {
      processStatus: 'open',
      appointmentId: outbound.id,
      appointmentVersion: outbound.version,
    };
    // Getragene Erfassungszeit in der Zukunft oder älter als die Lease → „Gerätezeit prüfen“.
    for (const capturedAt of [
      new Date(Date.now() + 24 * 3_600_000).toISOString(),
      new Date(Date.now() - 4 * DAYS).toISOString(),
    ]) {
      const result = await sync(staff.cookie, {
        type: 'handover.finalize',
        contextId: world.bookingId,
        base,
        payload: { capturedAt, expectedSlots: [] },
      });
      expect(result.json.status).toBe('conflict');
      expect(result.json.code).toBe('CLOCK_IMPLAUSIBLE');
    }
    // Rückdatierte Erfassungszeit (innerhalb des 72-h-Fensters, aber abweichend von der
    // Erstellzeit) ist eine Zeitkorrektur und verlangt wie online `handover.correct_actual_time`.
    const backdated = await sync(staff.cookie, {
      type: 'handover.finalize',
      contextId: world.bookingId,
      base,
      payload: {
        capturedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
        expectedSlots: [],
      },
    });
    expect(backdated.json.status).toBe('rejected');
    expect(backdated.json.code).toBe('PERMISSION_REVOKED');
    // Erstellzeit der Mutation außerhalb der Toleranz ebenfalls.
    const createdLate = await sync(staff.cookie, {
      type: 'handover.finalize',
      contextId: world.bookingId,
      base,
      createdAt: new Date(Date.now() + 3_600_000).toISOString(),
      payload: { capturedAt: new Date().toISOString(), expectedSlots: [] },
    });
    expect(createdLate.json.code).toBe('CLOCK_IMPLAUSIBLE');
    // Ohne Basisstand keine Fachmutation (Konfliktprüfungen §33 nicht abschaltbar).
    const noBase = await sync(staff.cookie, {
      type: 'handover.recipient',
      contextId: world.bookingId,
      base: null,
      payload: { kind: 'customer', name: null, phone: null },
    });
    expect(noBase.json.status).toBe('rejected');
    expect(noBase.json.code).toBe('VALIDATION');
    const badBase = await sync(staff.cookie, {
      type: 'handover.recipient',
      contextId: world.bookingId,
      base: { foo: 'bar' },
      payload: { kind: 'customer', name: null, phone: null },
    });
    expect(badBase.json.status).toBe('rejected');
    // Mutations-ID einer Konflikt-Quittung nicht für eine andere Aktion wiederverwendbar (§63).
    const id = randomUUID();
    const first = await sync(staff.cookie, {
      id,
      type: 'handover.finalize',
      contextId: world.bookingId,
      base,
      payload: {
        capturedAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        expectedSlots: [],
      },
    });
    expect(first.json.status).toBe('conflict');
    const reused = await sync(staff.cookie, {
      id,
      type: 'handover.recipient',
      contextId: world.bookingId,
      base,
      payload: { kind: 'customer', name: null, phone: null },
    });
    expect(reused.json.status).toBe('rejected');
    const receipt = await ctx.db
      .select()
      .from(offlineMutationReceipts)
      .where(eq(offlineMutationReceipts.clientMutationId, id));
    expect(receipt[0]!.operationType).toBe('handover.finalize');
    expect(receipt[0]!.status).toBe('conflict');

    // Zweiphasige Quittung (§28): „processing“ = Fachmutation läuft/lief ohne Abschluss.
    const recipientInput = (id2: string): MutationInput => ({
      id: id2,
      type: 'handover.recipient',
      contextId: world.bookingId,
      base,
      payload: { kind: 'customer', name: null, phone: null },
    });
    const processingRow = (id2: string, processedAt: Date) => ({
      clientMutationId: id2,
      staffUserId: staff.user.id,
      deviceId: DEVICE,
      appEnv: 'development' as const,
      operationType: 'handover.recipient',
      contextKind: 'booking',
      contextId: world.bookingId,
      status: 'processing' as const,
      resultRef: null,
      errorCode: null,
      message: null,
      clientCreatedAt: processedAt,
      processedAt,
    });
    // (a) frisch reserviert (anderer Prozess arbeitet): 503, Client wiederholt später.
    const fresh = randomUUID();
    await ctx.db.insert(offlineMutationReceipts).values(processingRow(fresh, new Date()));
    const busy = await sync(staff.cookie, recipientInput(fresh));
    expect(busy.response.statusCode).toBe(503);
    expect(busy.response.headers['retry-after']).toBe('5');
    expect((busy.json as { error: { code: string } }).error.code).toBe('SYNC_IN_PROGRESS');
    // (b) abgebrochen (älter als 2 min), Wirkung nachweislich NICHT vorhanden (Empfänger noch
    // nicht gesetzt): Crash-Recovery findet nichts ⇒ normale Ausführung, genau einmal.
    const stale = randomUUID();
    await ctx.db
      .insert(offlineMutationReceipts)
      .values(processingRow(stale, new Date(Date.now() - 5 * 60_000)));
    const executed = await sync(staff.cookie, recipientInput(stale));
    expect(executed.json.status).toBe('applied');
    expect(executed.json.deduplicated).toBe(false);
    // (b2) abgebrochen, Wirkung bereits vorhanden (Empfänger = Kunde): als übernommen quittiert.
    const staleApplied = randomUUID();
    await ctx.db
      .insert(offlineMutationReceipts)
      .values(processingRow(staleApplied, new Date(Date.now() - 5 * 60_000)));
    const recovered = await sync(staff.cookie, recipientInput(staleApplied));
    expect(recovered.json.status).toBe('applied');
    expect(recovered.json.deduplicated).toBe(true);
    // (c) nach abgeschlossener Verarbeitung bleibt keine „processing“-Quittung zurück.
    const ok = await sync(staff.cookie, recipientInput(randomUUID()));
    expect(ok.json.status).toBe('applied');
    const remaining = (await ctx.db.select().from(offlineMutationReceipts)).filter(
      (r) => r.clientMutationId !== fresh, // die simulierte fremde Reservierung bleibt bestehen
    );
    expect(remaining.map((r) => r.status)).not.toContain('processing');
  });

  it('Mitarbeiter-Identität der Unterschrift kommt aus der Session, nicht aus dem Client (§21)', async () => {
    const { admin } = await adminSession();
    await initializeAllInventory(ctx, admin.id, 20);
    const world = await scheduledBooking(ctx, admin.id, {
      from: new Date(Date.now() + 3_600_000),
      to: new Date(Date.now() + 2 * DAYS),
    });
    const staff = await staffWith(admin.id, OPERATIVE, 'Signer');
    const before = await packageFor(staff.cookie);
    const snapshot = before.bookings.find((b) => b.bookingId === world.bookingId)!;
    const outbound = snapshot.appointments.find((a) => a.kind !== 'return')!;
    const base = {
      processStatus: 'open',
      appointmentId: outbound.id,
      appointmentVersion: outbound.version,
    };
    const sig = randomUUID();
    const signed = await sync(staff.cookie, {
      type: 'handover.signature',
      contextId: world.bookingId,
      base,
      payload: { role: 'staff', mediaId: sig },
      media: [
        { mediaId: sig, purpose: 'handover_signature', mimeType: 'image/png', bytes: pngBytes() },
      ],
    });
    expect(signed.json.status).toBe('applied');
    const detail = await handoverServicesFor(ctx).handover.detail(world.bookingId);
    expect(detail.signatures.staff?.signerName).toBe('Offline Signer');
    expect(detail.signatures.customer).toBeNull();
    // Ein zusätzlicher Name im Payload wird strukturell abgelehnt (strict Schema).
    const spoofed = await sync(staff.cookie, {
      type: 'handover.signature',
      contextId: world.bookingId,
      base,
      payload: { role: 'staff', mediaId: sig, signerName: 'Admin' },
      media: [
        { mediaId: sig, purpose: 'handover_signature', mimeType: 'image/png', bytes: pngBytes() },
      ],
    });
    expect(spoofed.json.status).toBe('rejected');
    expect(spoofed.json.code).toBe('VALIDATION');
    expect(
      (await handoverServicesFor(ctx).handover.detail(world.bookingId)).signatures.staff
        ?.signerName,
    ).toBe('Offline Signer');
  });
});
