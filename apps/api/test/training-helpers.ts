/**
 * Phase 14 (Training, Design §4.7): Test-Hilfen – Demo-Kontext mit Mail-
 * Whitelist, vollständige Leerung des Trainingsfortschritts (der Katalog
 * bleibt – er wird beim Start der App synchronisiert), Mitarbeiter mit exakt
 * den nötigen Rechten, API-Aufrufe und Katalogvarianten für die
 * Update-Stabilitätstests (T70/T71/T84/T88).
 */
import {
  trainingAttemptEvents,
  trainingAttempts,
  type TrainingAttempt,
  type TrainingAttemptEvent,
} from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import {
  TRAINING_CATALOG,
  type TrainingCatalog,
  type TrainingDefinitionSpec,
  type TrainingPathSpec,
} from '../src/training/catalog.ts';
import {
  TrainingCatalogService,
  type TrainingCatalogSyncResult,
} from '../src/training/catalog-sync.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  login,
  truncateAuthTables,
  type TestContext,
} from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateCommunicationTables } from './communication-helpers.ts';
import { createStaffWithPermissions, truncateCrmTables } from './crm-helpers.ts';
import { truncateHandoverTables } from './handover-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { truncateSettlementTables } from './settlement-helpers.ts';
import { resetWarehouse } from './warehouse-helpers.ts';

/** Demo-Whitelist der Tests: nur `@example.com` darf tatsächlich (über den Fake) versendet werden. */
export const TRAINING_DEMO_WHITELIST = '@example.com';

export async function createTrainingDemoContext(
  options: { logDestination?: NodeJS.WritableStream } = {},
): Promise<TestContext> {
  return createTestContext({
    appEnv: 'demo',
    env: { MAIL_DEMO_WHITELIST: TRAINING_DEMO_WHITELIST },
    ...(options.logDestination === undefined
      ? {}
      : { logDestination: options.logDestination, logLevel: 'trace' as const }),
  });
}

/**
 * Business-, Staff- und Trainingsfortschritt leeren. `training_definitions`,
 * `training_paths`, `training_path_items` bleiben (Katalog, beim App-Start
 * synchronisiert); Versuche/Zuweisungen fallen mit den Staff-Tabellen (FK).
 */
export async function resetTrainingWorld(pool: pg.Pool): Promise<void> {
  // Demo-Zustand/Registry eines vorherigen Resets (T85/T86) ebenfalls leeren.
  await pool.query('TRUNCATE demo_seed_entities, demo_dataset_state CASCADE');
  await pool.query(
    'TRUNCATE tour_delay_incidents, tour_live_locations, tour_stops, tours, geocoding_cache CASCADE',
  );
  await truncateCommunicationTables(pool);
  await truncateSettlementTables(pool);
  await truncateHandoverTables(pool);
  await resetWarehouse(pool);
  await truncateSchedulingTables(pool);
  await truncateCrmTables(pool);
  await truncateAuthTables(pool);
  await truncateCommerceTables(pool);
  await pool.query(
    'TRUNCATE training_attempt_events, training_attempts, training_assignments CASCADE',
  );
}

export async function adminSession(ctx: TestContext) {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  if (session.statusCode !== 200)
    throw new Error(`Admin-Login fehlgeschlagen: ${session.statusCode}`);
  return { admin, cookie: session.cookie };
}

let traineeCounter = 0;

/** Mitarbeiter mit exakt diesen Rechten (eigene Rolle) – eingeloggt. */
export async function trainee(
  ctx: TestContext,
  adminId: string,
  permissionKeys: readonly PermissionKey[],
  label = 'Trainee',
) {
  traineeCounter += 1;
  return createStaffWithPermissions(ctx, adminId, {
    firstName: label,
    lastName: `Test${traineeCounter}`,
    email: `${label.toLowerCase()}-${traineeCounter}@example.com`,
    password: `${label.toLowerCase()}-passwort-12345`,
    permissionKeys,
  });
}

export interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export type Api = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  payload?: unknown,
) => Promise<ApiResult>;

export function apiFor(app: FastifyInstance, cookie: string): Api {
  return async (method, url, payload) => {
    const response = await app.inject({
      method,
      url,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: response.statusCode, body: response.body === '' ? null : response.json() };
  };
}

export const startAttempt = (api: Api, definitionKey: string) =>
  api('POST', '/staff/training/attempts', { definitionKey });

export const checkAttempt = (api: Api, attemptId: string) =>
  api('POST', `/staff/training/attempts/${attemptId}/check`, {});

export const trainingMe = (api: Api) => api('GET', '/staff/training/me');

/** Versuch starten – erwartet 201 und liefert die ID. */
export async function startedAttemptId(api: Api, definitionKey: string): Promise<string> {
  const result = await startAttempt(api, definitionKey);
  if (result.status !== 201) {
    throw new Error(
      `Versuch starten fehlgeschlagen: ${result.status} ${JSON.stringify(result.body)}`,
    );
  }
  return result.body.attempt.id as string;
}

export async function attemptRow(ctx: TestContext, attemptId: string): Promise<TrainingAttempt> {
  const rows = await ctx.db
    .select()
    .from(trainingAttempts)
    .where(eq(trainingAttempts.id, attemptId));
  const row = rows[0];
  if (row === undefined) throw new Error(`Versuch ${attemptId} fehlt`);
  return row;
}

export async function eventsOf(
  ctx: TestContext,
  attemptId: string,
): Promise<TrainingAttemptEvent[]> {
  return ctx.db
    .select()
    .from(trainingAttemptEvents)
    .where(eq(trainingAttemptEvents.attemptId, attemptId))
    .orderBy(asc(trainingAttemptEvents.occurredAt), asc(trainingAttemptEvents.id));
}

export async function attemptsOfUser(ctx: TestContext, userId: string): Promise<TrainingAttempt[]> {
  return ctx.db
    .select()
    .from(trainingAttempts)
    .where(eq(trainingAttempts.userId, userId))
    .orderBy(asc(trainingAttempts.startedAt));
}

export interface MutableTrainingCatalog {
  definitions: TrainingDefinitionSpec[];
  paths: TrainingPathSpec[];
}

/** Tiefe Kopie des Code-Katalogs mit Änderung (Version/Titel/aktiv/Reihenfolge). */
export function catalogVariant(mutate: (catalog: MutableTrainingCatalog) => void): TrainingCatalog {
  const clone = JSON.parse(JSON.stringify(TRAINING_CATALOG)) as MutableTrainingCatalog;
  mutate(clone);
  return clone;
}

export async function syncCatalog(
  ctx: TestContext,
  catalog?: TrainingCatalog,
): Promise<TrainingCatalogSyncResult> {
  return new TrainingCatalogService(ctx.db).sync(catalog);
}
