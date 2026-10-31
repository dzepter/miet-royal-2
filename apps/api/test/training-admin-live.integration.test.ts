/**
 * Phase 14 – Live-Trainingsverwaltung (Order §58, §59, §61, §62, §84; Design §4.4,
 * §4.7 T124–T130): Demo-Abschluss bestätigen, Sperren schalten, Overrides
 * vergeben/widerrufen, Audit – alles in einer production-App auf dem Pool des
 * Testkontexts. Keine Demo-Businessdaten erreichen Live (W2).
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffSecurityEvents, staffTrainingClearances } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  login,
  type TestContext,
} from './auth-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import { createEnvApp } from './env-app-helpers.ts';
import {
  FEATURE_DEFINITIONS,
  apiOn,
  clearanceRows,
  expectTrainingRequired,
  definitionTitle,
  resetGateWorld,
  securityEventsOfType,
} from './training-gate-helpers.ts';
import { inventoryServiceFor } from './warehouse-helpers.ts';

let ctx: TestContext;
let prod: FastifyInstance;

const FEATURE = 'inventory.stocktake_approve';
const DEFINITION = FEATURE_DEFINITIONS[FEATURE]!;
const GATES_URL = `/staff/training/admin/gates/${FEATURE}`;
const CLEARANCES_URL = '/staff/training/admin/clearances';

beforeAll(async () => {
  ctx = await createTestContext();
  prod = await createEnvApp(ctx, 'production');
});

afterAll(async () => {
  await prod.close();
  await destroyTestContext(ctx);
});

beforeEach(async () => {
  await resetGateWorld(ctx);
});

async function adminSession() {
  const admin = await bootstrapAdmin(ctx);
  const session = await login(ctx.app, ADMIN_EMAIL, ADMIN_PASSWORD);
  return { admin, cookie: session.cookie, api: apiOn(prod, session.cookie) };
}

async function trainee(adminId: string, suffix = 'Live') {
  return createStaffWithPermissions(ctx, adminId, {
    firstName: 'Mia',
    lastName: suffix,
    email: `mia.${suffix.toLowerCase()}@test.example`,
    password: `mia-passwort-${suffix}-12345`,
    permissionKeys: ['inventory.approve_adjustment', 'training.manage'],
  });
}

async function pendingStocktake(adminId: string, itemIndex = 0): Promise<string> {
  const inventory = inventoryServiceFor(ctx);
  const items = await inventory.listItems();
  const item = items[itemIndex];
  if (item === undefined) throw new Error('Lagerartikel fehlt');
  const stocktake = await inventory.createStocktake(adminId, [
    { itemId: item.itemId, countedStock: 3 },
  ]);
  return stocktake.id;
}

const approveUrl = (id: string) => `/staff/inventory/stocktakes/${id}/approve`;

describe('T124–T125: Demo-Abschluss im Live-System bestätigen', () => {
  it('T124. Admin bestätigt „Demo-Training bestätigt“ (verified_demo) – Liste, Audit, Sperre offen', async () => {
    const { admin, api } = await adminSession();
    const staff = await trainee(admin.id);
    expect((await api('PUT', GATES_URL, { definitionKey: DEFINITION, enabled: true })).status).toBe(
      200,
    );
    const stocktakeId = await pendingStocktake(admin.id);
    expectTrainingRequired(
      await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId)),
      FEATURE,
      await definitionTitle(ctx.db, DEFINITION),
    );
    const verified = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'verified_demo',
    });
    expect(verified.status).toBe(201);
    expect(verified.body.created).toBe(true);
    expect(verified.body.clearance).toMatchObject({
      userId: staff.user.id,
      user: { firstName: 'Mia', lastName: 'Live' },
      definitionKey: DEFINITION,
      definitionTitle: await definitionTitle(ctx.db, DEFINITION),
      source: 'verified_demo',
      reason: null,
      validUntil: null,
      grantedBy: admin.id,
      revokedAt: null,
      active: true,
    });
    const list = await api('GET', `${CLEARANCES_URL}?userId=${staff.user.id}`);
    expect(list.status).toBe(200);
    expect(list.body.clearances).toHaveLength(1);
    expect(list.body.clearances[0].id).toBe(verified.body.clearance.id);
    const all = await api('GET', CLEARANCES_URL);
    expect(all.body.clearances).toHaveLength(1);
    const events = await securityEventsOfType(ctx.db, 'training.demo_verified');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorUserId: admin.id, targetUserId: staff.user.id });
    expect((await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId))).status).toBe(200);
    // Unbekannte Übung / unbekannter Mitarbeiter ⇒ 404.
    expect(
      (
        await api('POST', CLEARANCES_URL, {
          userId: staff.user.id,
          definitionKey: 'unbekannte_uebung',
          source: 'verified_demo',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await api('POST', CLEARANCES_URL, {
          userId: '00000000-0000-4000-8000-000000000000',
          definitionKey: DEFINITION,
          source: 'verified_demo',
        })
      ).status,
    ).toBe(404);
  });

  it('T125. Keine Demo-Businessdaten: Freigabezeile trägt nur Meta-Spalten, Zusatzfelder werden abgelehnt', async () => {
    const { admin, api } = await adminSession();
    const staff = await trainee(admin.id);
    for (const extra of [
      { attemptId: '11111111-1111-4111-8111-111111111111' },
      { demoProcessId: 'MR-2026-0001' },
      { processNumber: 'MR-2026-0001', customerEmail: 'kunde@example.com' },
    ]) {
      const rejected = await api('POST', CLEARANCES_URL, {
        userId: staff.user.id,
        definitionKey: DEFINITION,
        source: 'verified_demo',
        ...extra,
      });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await clearanceRows(ctx.db, staff.user.id)).toHaveLength(0);
    const gateExtra = await api('PUT', GATES_URL, {
      definitionKey: DEFINITION,
      enabled: true,
      attemptId: '11111111-1111-4111-8111-111111111111',
    });
    expect(gateExtra.status).toBe(400);

    const verified = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'verified_demo',
    });
    expect(verified.status).toBe(201);
    const [row] = await ctx.db
      .select()
      .from(staffTrainingClearances)
      .where(eq(staffTrainingClearances.id, verified.body.clearance.id));
    expect(Object.keys(row!).sort()).toEqual(
      [
        'id',
        'userId',
        'definitionKey',
        'source',
        'reason',
        'validFrom',
        'validUntil',
        'grantedBy',
        'grantedAt',
        'revokedAt',
        'revokedBy',
      ].sort(),
    );
    const serialized = JSON.stringify(row);
    expect(serialized).not.toMatch(/MR-20|attempt|example\.com/);
  });
});

describe('T126–T127: Sperren aktivieren und deaktivieren', () => {
  it('T126. Sperre aktivieren – Antwort, Übersicht und genau ein Audit je Zustandswechsel', async () => {
    const { admin, api } = await adminSession();
    const enabled = await api('PUT', GATES_URL, { definitionKey: DEFINITION, enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.feature).toMatchObject({
      featureKey: FEATURE,
      title: 'Lagerzählung freigeben',
      requirement: { definitionKey: DEFINITION, enabled: true, configuredBy: admin.id },
      definition: { key: DEFINITION, active: true },
    });
    const overview = await api('GET', '/staff/training/admin/gates');
    expect(overview.body.definitions.map((d: { key: string }) => d.key)).toContain(DEFINITION);
    const feature = overview.body.features.find(
      (f: { featureKey: string }) => f.featureKey === FEATURE,
    );
    expect(feature.requirement.enabled).toBe(true);
    expect(await securityEventsOfType(ctx.db, 'training.gate_enabled')).toHaveLength(1);
    // Wiederholtes Aktivieren: kein zweites Audit.
    expect((await api('PUT', GATES_URL, { definitionKey: DEFINITION, enabled: true })).status).toBe(
      200,
    );
    expect(await securityEventsOfType(ctx.db, 'training.gate_enabled')).toHaveLength(1);
    // Andere Übung bei aktiver Sperre = neuer wirksamer Zustand ⇒ erneut auditiert.
    expect(
      (await api('PUT', GATES_URL, { definitionKey: 'machine_clean_complete', enabled: true }))
        .status,
    ).toBe(200);
    const events = await securityEventsOfType(ctx.db, 'training.gate_enabled');
    expect(events).toHaveLength(2);
    expect(events[1]!.details).toMatchObject({
      featureKey: FEATURE,
      definitionKey: 'machine_clean_complete',
      previousDefinitionKey: DEFINITION,
      previousEnabled: true,
    });
    const [requirement] = await ctx.pool
      .query('SELECT feature_key, definition_key, enabled FROM training_feature_requirements')
      .then((result) => result.rows as { feature_key: string; definition_key: string }[]);
    expect(requirement).toMatchObject({
      feature_key: FEATURE,
      definition_key: 'machine_clean_complete',
    });
  });

  it('T127. Sperre deaktivieren – Audit gate_disabled, Aktion wieder erlaubt, idempotent', async () => {
    const { admin, api } = await adminSession();
    const staff = await trainee(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    expect((await api('PUT', GATES_URL, { definitionKey: DEFINITION, enabled: true })).status).toBe(
      200,
    );
    expect((await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId))).status).toBe(403);
    const disabled = await api('PUT', GATES_URL, { definitionKey: DEFINITION, enabled: false });
    expect(disabled.status).toBe(200);
    expect(disabled.body.feature.requirement.enabled).toBe(false);
    expect(await securityEventsOfType(ctx.db, 'training.gate_disabled')).toHaveLength(1);
    expect(
      (await api('PUT', GATES_URL, { definitionKey: DEFINITION, enabled: false })).status,
    ).toBe(200);
    expect(await securityEventsOfType(ctx.db, 'training.gate_disabled')).toHaveLength(1);
    expect((await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId))).status).toBe(200);
    // Ohne training.manage: 403 FORBIDDEN (normale Rechteprüfung, kein Gate).
    const other = await createStaffWithPermissions(ctx, admin.id, {
      firstName: 'Ohne',
      lastName: 'Recht',
      email: 'ohne.recht@test.example',
      password: 'ohne-passwort-12345',
      permissionKeys: ['inventory.approve_adjustment'],
    });
    const forbidden = await apiOn(prod, other.cookie)('PUT', GATES_URL, {
      definitionKey: DEFINITION,
      enabled: true,
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
  });
});

describe('T128–T130: Override, Widerruf, Audit', () => {
  it('T128. Override vergeben – aktiv, Aktion erlaubt, Doppelklick dupliziert nicht', async () => {
    const { admin, api } = await adminSession();
    const staff = await trainee(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    expect((await api('PUT', GATES_URL, { definitionKey: DEFINITION, enabled: true })).status).toBe(
      200,
    );
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const granted = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'override',
      reason: 'Erfahrene Kraft, Training folgt nächste Woche',
      validUntil: until,
    });
    expect(granted.status).toBe(201);
    expect(granted.body.clearance).toMatchObject({
      source: 'override',
      reason: 'Erfahrene Kraft, Training folgt nächste Woche',
      validUntil: until,
      active: true,
    });
    const again = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'override',
      reason: 'Doppelklick',
    });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.clearance.id).toBe(granted.body.clearance.id);
    expect(await clearanceRows(ctx.db, staff.user.id)).toHaveLength(1);
    expect(await securityEventsOfType(ctx.db, 'training.override_granted')).toHaveLength(1);
    expect((await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId))).status).toBe(200);
  });

  it('T129. Override widerrufen – sofort gesperrt, idempotent, ein Audit; Demo-Bestätigung eigener Audit-Typ', async () => {
    const { admin, api } = await adminSession();
    const staff = await trainee(admin.id);
    const first = await pendingStocktake(admin.id, 0);
    const second = await pendingStocktake(admin.id, 1);
    expect((await api('PUT', GATES_URL, { definitionKey: DEFINITION, enabled: true })).status).toBe(
      200,
    );
    const granted = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'override',
      reason: 'Vorläufig',
    });
    expect(granted.status).toBe(201);
    expect((await apiOn(prod, staff.cookie)('POST', approveUrl(first))).status).toBe(200);
    const revokeUrl = `${CLEARANCES_URL}/${granted.body.clearance.id}/revoke`;
    const revoked = await api('POST', revokeUrl);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({
      revoked: true,
      clearance: { active: false, revokedBy: admin.id },
    });
    const again = await api('POST', revokeUrl);
    expect(again.status).toBe(200);
    expect(again.body.revoked).toBe(false);
    expect(await securityEventsOfType(ctx.db, 'training.override_revoked')).toHaveLength(1);
    expectTrainingRequired(
      await apiOn(prod, staff.cookie)('POST', approveUrl(second)),
      FEATURE,
      await definitionTitle(ctx.db, DEFINITION),
    );
    expect((await api('POST', `${CLEARANCES_URL}/${admin.id}/revoke`)).status).toBe(404);

    const verified = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'verified_demo',
    });
    expect(verified.status).toBe(201);
    expect(
      (await api('POST', `${CLEARANCES_URL}/${verified.body.clearance.id}/revoke`)).status,
    ).toBe(200);
    expect(await securityEventsOfType(ctx.db, 'training.demo_verification_revoked')).toHaveLength(
      1,
    );
  });

  it('T130. Audit: alle Gate-/Freigabe-Ereignistypen vorhanden, Details ohne Begründung und ohne Businessdaten', async () => {
    const { admin, api } = await adminSession();
    const staff = await trainee(admin.id);
    const reason = 'Geheime Begründung mit Kundenbezug Klara Kommerz';
    expect((await api('PUT', GATES_URL, { definitionKey: DEFINITION, enabled: true })).status).toBe(
      200,
    );
    expect(
      (await api('PUT', GATES_URL, { definitionKey: DEFINITION, enabled: false })).status,
    ).toBe(200);
    const verified = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'verified_demo',
    });
    const override = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'override',
      reason,
    });
    expect(verified.status).toBe(201);
    expect(override.status).toBe(201);
    expect(
      (await api('POST', `${CLEARANCES_URL}/${override.body.clearance.id}/revoke`)).status,
    ).toBe(200);
    expect(
      (await api('POST', `${CLEARANCES_URL}/${verified.body.clearance.id}/revoke`)).status,
    ).toBe(200);

    const events = (await ctx.db.select().from(staffSecurityEvents)).filter((event) =>
      event.type.startsWith('training.'),
    );
    const types = events.map((event) => event.type).sort();
    expect(types).toEqual(
      [
        'training.gate_enabled',
        'training.gate_disabled',
        'training.demo_verified',
        'training.override_granted',
        'training.override_revoked',
        'training.demo_verification_revoked',
      ].sort(),
    );
    const allowedKeys = new Set([
      'featureKey',
      'definitionKey',
      'previousDefinitionKey',
      'previousEnabled',
      'clearanceId',
      'source',
      'validUntil',
      'revokedAt',
    ]);
    for (const event of events) {
      expect(event.actorUserId).toBe(admin.id);
      const details = event.details as Record<string, unknown>;
      for (const key of Object.keys(details)) expect(allowedKeys.has(key)).toBe(true);
      expect(details).not.toHaveProperty('reason');
      const serialized = JSON.stringify(details);
      expect(serialized).not.toContain('Geheime');
      expect(serialized).not.toContain('Klara');
    }
    // Die Begründung liegt ausschließlich in der Freigabezeile.
    const rows = await clearanceRows(ctx.db, staff.user.id);
    expect(rows.find((row) => row.source === 'override')?.reason).toBe(reason);
    // Audit-Ansicht der Mitarbeiterverwaltung zeigt die Ereignisse (ohne Begründung).
    const view = await api('GET', `/staff/security-events?userId=${staff.user.id}`);
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).not.toContain('Geheime');
  });
});
