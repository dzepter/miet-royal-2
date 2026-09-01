import type { PermissionKey } from '@mietroyal/permissions';
import type pg from 'pg';
import { CustomerService } from '../src/crm/customer-service.ts';
import { ProcessService } from '../src/crm/process-service.ts';
import { buildVisibilityContext, type ProcessVisibilityContext } from '../src/crm/visibility.ts';
import { createEmployeeWithPassword, login, type TestContext } from './auth-helpers.ts';

/** Sichtbarkeitskontext eines Admins (sieht alles) für direkte Service-Aufrufe. */
export function adminVisibilityCtx(): ProcessVisibilityContext {
  return buildVisibilityContext(new Set<PermissionKey>(['process.view_completed']), 7);
}

/** CRM-Tabellen leeren (vor den Auth-Tabellen aufrufen). */
export async function truncateCrmTables(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE process_notes, processes, customers, system_settings CASCADE');
}

/**
 * Mitarbeiter mit exakt den angegebenen Rechten anlegen (über eine eigene
 * Rolle) und direkt einloggen – für Berechtigungs-/Sichtbarkeitstests.
 */
export async function createStaffWithPermissions(
  ctx: TestContext,
  adminId: string,
  input: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
    permissionKeys: readonly PermissionKey[];
  },
) {
  const user = await createEmployeeWithPassword(ctx, adminId, {
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    password: input.password,
  });
  if (input.permissionKeys.length > 0) {
    const roleId = await ctx.admin.createRole(adminId, {
      name: `Testrolle ${input.email}`,
      permissionKeys: input.permissionKeys,
    });
    await ctx.admin.setUserRoles(adminId, user.id, [roleId]);
  }
  const session = await login(ctx.app, input.email, input.password);
  return { user, cookie: session.cookie };
}

export function customerServiceFor(ctx: TestContext): CustomerService {
  return new CustomerService(ctx.db);
}

export function processServiceFor(ctx: TestContext): ProcessService {
  return new ProcessService(ctx.db);
}

/** Synthetischer Privatkunde über den Service (Abkürzung für Vorgangs-Tests). */
export async function createTestCustomer(
  ctx: TestContext,
  actorId: string,
  overrides: Partial<{
    type: 'private' | 'organization';
    firstName: string;
    lastName: string;
    organizationName: string;
    email: string;
    phone: string;
  }> = {},
) {
  const service = customerServiceFor(ctx);
  const { customer } = await service.createCustomer(actorId, {
    type: overrides.type ?? 'private',
    firstName: overrides.firstName ?? 'Max',
    lastName: overrides.lastName ?? 'Mustermann',
    organizationName: overrides.organizationName,
    email: overrides.email,
    phone: overrides.phone,
  });
  return customer;
}
