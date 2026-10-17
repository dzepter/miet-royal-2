/**
 * Gemeinsame Hilfsfunktionen der Phase-8-Offline-Integrationstests (Lease, Paket,
 * Mutation/Sync, Security-Events) – als Fabrik, damit jede Testdatei ihren
 * eigenen TestContext nutzt.
 */
import { createHash, randomUUID } from 'node:crypto';
import { staffSecurityEvents } from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import { expect } from 'vitest';
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateHandoverTables } from './handover-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { resetWarehouse } from './warehouse-helpers.ts';

export const DEVICE = '0f6a9d2e-1b3c-4d5e-8f70-1234567890ab';
export const DEVICE_B = '9f6a9d2e-1b3c-4d5e-8f70-1234567890cd';

export interface MutationInput {
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

/** Alle fachlichen Tabellen leeren (wie beforeEach in offline-core). */
export async function truncateOfflineWorld(ctx: TestContext): Promise<void> {
  await truncateHandoverTables(ctx.pool);
  await resetWarehouse(ctx.pool);
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  await ctx.pool.query('TRUNCATE offline_mutation_receipts, offline_access_leases CASCADE');
}

export function offlineHelpers(ctx: () => TestContext) {
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
    const admin = await bootstrapAdmin(ctx());
    const session = await login(ctx().app, ADMIN_EMAIL, ADMIN_PASSWORD);
    return { admin, cookie: session.cookie };
  }

  async function staffWith(adminId: string, keys: readonly PermissionKey[], suffix: string) {
    return createStaffWithPermissions(ctx(), adminId, {
      firstName: 'Offline',
      lastName: suffix,
      email: `offline-${suffix.toLowerCase()}@test.example`,
      password: `offline-passwort-${suffix}-1`,
      permissionKeys: keys,
    });
  }

  async function lease(cookie: string, deviceId = DEVICE, environment = 'development') {
    return ctx().app.inject({
      method: 'POST',
      url: '/staff/offline/lease',
      headers: { cookie },
      payload: { deviceId, environment },
    });
  }

  async function pkg(cookie: string, extra: Record<string, unknown> = {}, deviceId = DEVICE) {
    return ctx().app.inject({
      method: 'POST',
      url: '/staff/offline/package',
      headers: { cookie },
      payload: { deviceId, environment: 'development', includeDocuments: true, ...extra },
    });
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
              input.base ?? {
                processStatus: 'open',
                appointmentId: null,
                appointmentVersion: null,
              },
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
    const response = await ctx().app.inject({
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
    return {
      response,
      id: body.clientMutationId,
      json: response.json() as Record<string, unknown>,
    };
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
    return (await ctx().db.select().from(staffSecurityEvents)).filter((e) => e.type === type);
  }

  return {
    OPERATIVE,
    adminSession,
    staffWith,
    lease,
    pkg,
    mutation,
    sync,
    packageFor,
    securityEvents,
  };
}
