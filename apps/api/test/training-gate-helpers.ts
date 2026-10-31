/**
 * Phase 14 (training gate): gemeinsame Bausteine der Gate-/Admin-Live-Tests
 * (T99–T118, T124–T130). Die Übungsdefinitionen sind ein Code-Katalog, den
 * Agent T1 beim Start synchronisiert; die Tests stellen die benötigten Keys
 * zusätzlich selbst sicher (Upsert nach `key`, nur `active` wird erzwungen),
 * damit sie unabhängig vom Startzeitpunkt des Katalog-Syncs laufen.
 */
import {
  staffSecurityEvents,
  staffTrainingClearances,
  trainingDefinitions,
  trainingFeatureRequirements,
  type Database,
} from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { truncateAuthTables, type TestContext } from './auth-helpers.ts';
import { truncateCommerceTables } from './commerce-helpers.ts';
import { truncateCrmTables } from './crm-helpers.ts';
import { truncateHandoverTables } from './handover-helpers.ts';
import { truncateSchedulingTables } from './scheduling-helpers.ts';
import { truncateSettlementTables } from './settlement-helpers.ts';
import { truncateTourTables } from './tours-helpers.ts';
import { resetWarehouse } from './warehouse-helpers.ts';

/** Katalog-Keys laut Design §4.2 (stabil; Titel wie im Katalog von T1). */
export const GATE_TEST_DEFINITIONS = [
  { key: 'offer_send', title: 'Angebot bearbeiten und versenden', evaluatorKey: 'offer_send' },
  { key: 'handover_complete', title: 'Übergabe abschließen', evaluatorKey: 'handover_complete' },
  { key: 'return_complete', title: 'Rückgabe abschließen', evaluatorKey: 'return_complete' },
  {
    key: 'tour_complete',
    title: 'Tour planen, starten und abschließen',
    evaluatorKey: 'tour_complete',
  },
  {
    key: 'communication_reply',
    title: 'Kundenkommunikation beantworten',
    evaluatorKey: 'communication_reply',
  },
  {
    key: 'settlement_review',
    title: 'Abrechnung prüfen (bis vor Buchhaltungsübertragung)',
    evaluatorKey: 'settlement_review',
  },
  {
    key: 'machine_clean_complete',
    title: 'Maschine reinigen',
    evaluatorKey: 'machine_clean_complete',
  },
  {
    key: 'inventory_stocktake_approve',
    title: 'Lagerzählung freigeben',
    evaluatorKey: 'inventory_stocktake_approve',
  },
] as const;

export type GateTestDefinitionKey = (typeof GATE_TEST_DEFINITIONS)[number]['key'];

/** Feature ⇒ Übung laut Design §4.5/§4.2 (für „alle 8 Sperren aktiv“). */
export const FEATURE_DEFINITIONS: Record<string, GateTestDefinitionKey> = {
  'offer.send': 'offer_send',
  'handover.finalize': 'handover_complete',
  'return.finalize': 'return_complete',
  'settlement.release': 'settlement_review',
  'tour.start': 'tour_complete',
  'tour.takeover': 'tour_complete',
  'machine.clean_complete': 'machine_clean_complete',
  'inventory.stocktake_approve': 'inventory_stocktake_approve',
};

/** Definitionen sicherstellen (idempotent) – T1 synchronisiert dieselben Keys beim Start. */
export async function ensureTrainingDefinitions(db: Database): Promise<void> {
  for (const definition of GATE_TEST_DEFINITIONS) {
    await db
      .insert(trainingDefinitions)
      .values({
        key: definition.key,
        title: definition.title,
        objective: `Testziel ${definition.key}`,
        instructions: `Testanleitung ${definition.key}`,
        evaluatorKey: definition.evaluatorKey,
        active: true,
      })
      .onConflictDoUpdate({
        target: trainingDefinitions.key,
        set: { active: true },
      });
  }
}

export async function definitionTitle(db: Database, key: string): Promise<string> {
  const [row] = await db
    .select({ title: trainingDefinitions.title })
    .from(trainingDefinitions)
    .where(eq(trainingDefinitions.key, key));
  if (row === undefined) throw new Error(`Übung ${key} fehlt`);
  return row.title;
}

export async function setDefinitionActive(db: Database, key: string, active: boolean) {
  await db.update(trainingDefinitions).set({ active }).where(eq(trainingDefinitions.key, key));
}

/** Alle Business-, Auth- und Trainings-Zuordnungstabellen leeren (Sperren/Freigaben hängen per FK an staff_users). */
export async function resetGateWorld(ctx: TestContext): Promise<void> {
  await truncateTourTables(ctx.pool);
  await truncateSettlementTables(ctx.pool);
  await truncateHandoverTables(ctx.pool);
  await resetWarehouse(ctx.pool);
  await truncateSchedulingTables(ctx.pool);
  await truncateCrmTables(ctx.pool);
  await truncateAuthTables(ctx.pool);
  await truncateCommerceTables(ctx.pool);
  await ctx.pool.query(
    'TRUNCATE training_feature_requirements, staff_training_clearances, offline_mutation_receipts, offline_access_leases CASCADE',
  );
  ctx.mailGateway.reset();
  await ensureTrainingDefinitions(ctx.db);
}

/** Sperre direkt in der Datenbank setzen (Fixture; die Admin-Route ist Gegenstand eigener Tests). */
export async function setRequirement(
  db: Database,
  featureKey: string,
  definitionKey: string,
  enabled: boolean,
  configuredBy: string | null = null,
): Promise<void> {
  await db
    .insert(trainingFeatureRequirements)
    .values({ featureKey, definitionKey, enabled, configuredBy })
    .onConflictDoUpdate({
      target: trainingFeatureRequirements.featureKey,
      set: { definitionKey, enabled, configuredBy, updatedAt: new Date() },
    });
}

export async function enableAllGates(db: Database, configuredBy: string | null = null) {
  for (const [featureKey, definitionKey] of Object.entries(FEATURE_DEFINITIONS)) {
    await setRequirement(db, featureKey, definitionKey, true, configuredBy);
  }
}

export async function clearanceRows(db: Database, userId: string) {
  return db
    .select()
    .from(staffTrainingClearances)
    .where(eq(staffTrainingClearances.userId, userId));
}

export async function securityEventsOfType(db: Database, type: string) {
  return (await db.select().from(staffSecurityEvents)).filter((event) => event.type === type);
}

export interface InjectResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** Kurzform für Aufrufe mit Session-Cookie (Body nur, wenn vorhanden). */
export function apiOn(app: FastifyInstance, cookie: string) {
  return async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<InjectResult> => {
    const response = await app.inject({
      method,
      url,
      headers: { cookie },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    return { status: response.statusCode, body: response.body === '' ? null : response.json() };
  };
}

/** Erwartet die Gate-Antwort 403 mit Code, deutschem Text und Details (§64/§66). */
export function expectTrainingRequired(result: InjectResult, featureKey: string, title: string) {
  expect(result.status).toBe(403);
  expect(result.body.error.code).toBe('TRAINING_REQUIRED');
  expect(result.body.error.message).toBe(
    `Für diese Funktion ist zuerst das Training ‚${title}‘ erforderlich.`,
  );
  expect(result.body.error.details).toMatchObject({
    featureKey,
    requiredTrainingKey: FEATURE_DEFINITIONS[featureKey],
    title,
  });
  expect(typeof result.body.error.correlationId).toBe('string');
}
