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

// ── Phase 14 Final (Agent RULES) ─────────────────────────────────────────────

const VERIFIED_DEMO_PERMANENT_TEXT =
  'Eine bestätigte Demo-Übung läuft nicht ab – kein Ablaufdatum möglich.';
const USER_INACTIVE_TEXT = 'Der Mitarbeiter ist deaktiviert.';

async function loginTrainee(suffix: string) {
  return login(ctx.app, `mia.${suffix.toLowerCase()}@test.example`, `mia-passwort-${suffix}-12345`);
}

describe('Phase 14 Final §7: verified_demo ist unbefristet (VD1–VD5)', () => {
  it('VD1. verified_demo ohne validUntil ⇒ 201, validUntil null, aktiv, Sperre offen', async () => {
    const { admin, api } = await adminSession();
    const staff = await trainee(admin.id, 'Vd1');
    expect((await api('PUT', GATES_URL, { definitionKey: DEFINITION, enabled: true })).status).toBe(
      200,
    );
    const stocktakeId = await pendingStocktake(admin.id);
    const granted = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'verified_demo',
    });
    expect(granted.status).toBe(201);
    expect(granted.body.clearance).toMatchObject({
      source: 'verified_demo',
      validUntil: null,
      active: true,
    });
    const [row] = await clearanceRows(ctx.db, staff.user.id);
    expect(row!.validUntil).toBeNull();
    expect((await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId))).status).toBe(200);
  });

  it('VD2. verified_demo mit validUntil ⇒ 400 VALIDATION mit festem Text; keine Zeile, kein Audit (auch null/Vergangenheit/Zukunft)', async () => {
    const { admin, api } = await adminSession();
    const staff = await trainee(admin.id, 'Vd2');
    for (const validUntil of [
      new Date(Date.now() + 7 * 86_400_000).toISOString(),
      new Date(Date.now() - 60_000).toISOString(),
    ]) {
      const denied = await api('POST', CLEARANCES_URL, {
        userId: staff.user.id,
        definitionKey: DEFINITION,
        source: 'verified_demo',
        validUntil,
      });
      expect(denied.status).toBe(400);
      expect(denied.body.error.code).toBe('VALIDATION');
      expect(denied.body.error.message).toBe(VERIFIED_DEMO_PERMANENT_TEXT);
    }
    // `validUntil: null` ist ausdrücklich „unbefristet“ und bleibt erlaubt.
    const allowed = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'verified_demo',
      validUntil: null,
    });
    expect(allowed.status).toBe(201);
    expect(allowed.body.clearance.validUntil).toBeNull();
    expect(await clearanceRows(ctx.db, staff.user.id)).toHaveLength(1);
    expect(await securityEventsOfType(ctx.db, 'training.demo_verified')).toHaveLength(1);
  });

  it('VD3. Direkter DB-Insert verified_demo mit valid_until ⇒ CHECK staff_training_clearances_verified_demo_permanent_check (23514)', async () => {
    const { admin } = await adminSession();
    const staff = await trainee(admin.id, 'Vd3');
    await expect(
      ctx.db.insert(staffTrainingClearances).values({
        userId: staff.user.id,
        definitionKey: DEFINITION,
        source: 'verified_demo',
        reason: null,
        validUntil: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toMatchObject({
      cause: {
        code: '23514',
        constraint: 'staff_training_clearances_verified_demo_permanent_check',
      },
    });
    // Nachträgliches Befristen per UPDATE ist ebenso unmöglich.
    const [inserted] = await ctx.db
      .insert(staffTrainingClearances)
      .values({ userId: staff.user.id, definitionKey: DEFINITION, source: 'verified_demo' })
      .returning();
    await expect(
      ctx.db
        .update(staffTrainingClearances)
        .set({ validUntil: new Date(Date.now() + 86_400_000) })
        .where(eq(staffTrainingClearances.id, inserted!.id)),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    expect(await clearanceRows(ctx.db, staff.user.id)).toHaveLength(1);
  });

  it('VD4. Override ohne validUntil ⇒ 201 unbefristet und aktiv', async () => {
    const { admin, api } = await adminSession();
    const staff = await trainee(admin.id, 'Vd4');
    const granted = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'override',
      reason: 'Unbefristete Ausnahme',
    });
    expect(granted.status).toBe(201);
    expect(granted.body.clearance).toMatchObject({
      source: 'override',
      validUntil: null,
      active: true,
    });
  });

  it('VD5. Override mit Zukunftsdatum ⇒ 201, validUntil übernommen, aktiv; Vergangenheit ⇒ 400', async () => {
    const { admin, api } = await adminSession();
    const staff = await trainee(admin.id, 'Vd5');
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const granted = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'override',
      reason: 'Befristet bis zur Schulung',
      validUntil: until,
    });
    expect(granted.status).toBe(201);
    expect(granted.body.clearance).toMatchObject({
      source: 'override',
      validUntil: until,
      active: true,
    });
    const past = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: 'machine_clean_complete',
      source: 'override',
      reason: 'Befristet',
      validUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.status).toBe(400);
    expect(past.body.error.message).toBe('Das Ablaufdatum muss in der Zukunft liegen.');
  });
});

describe('Phase 14 Final §9: deaktivierte Mitarbeiter – Live-Freigaben (IU2–IU5)', () => {
  it('IU2. verified_demo an deaktivierten Mitarbeiter ⇒ 409 TRAINING_USER_INACTIVE „Der Mitarbeiter ist deaktiviert.“; keine Zeile, kein Audit; gesperrt (locked) bleibt zulässig', async () => {
    const { admin, api } = await adminSession();
    const disabled = await trainee(admin.id, 'Iu2a');
    const locked = await trainee(admin.id, 'Iu2b');
    await ctx.admin.setUserStatus(admin.id, disabled.user.id, 'disabled');
    await ctx.admin.setUserStatus(admin.id, locked.user.id, 'locked');
    const denied = await api('POST', CLEARANCES_URL, {
      userId: disabled.user.id,
      definitionKey: DEFINITION,
      source: 'verified_demo',
    });
    expect(denied.status).toBe(409);
    expect(denied.body.error).toMatchObject({
      code: 'TRAINING_USER_INACTIVE',
      message: USER_INACTIVE_TEXT,
      details: { userId: disabled.user.id, definitionKey: DEFINITION, source: 'verified_demo' },
    });
    expect(await clearanceRows(ctx.db, disabled.user.id)).toHaveLength(0);
    expect(await securityEventsOfType(ctx.db, 'training.demo_verified')).toHaveLength(0);
    const lockedGranted = await api('POST', CLEARANCES_URL, {
      userId: locked.user.id,
      definitionKey: DEFINITION,
      source: 'verified_demo',
    });
    expect(lockedGranted.status).toBe(201);
    expect(lockedGranted.body.clearance.user).toMatchObject({ lastName: 'Iu2b', status: 'locked' });
  });

  it('IU3. Override an deaktivierten Mitarbeiter ⇒ 409 TRAINING_USER_INACTIVE; keine Zeile, kein Audit', async () => {
    const { admin, api } = await adminSession();
    const staff = await trainee(admin.id, 'Iu3');
    await ctx.admin.setUserStatus(admin.id, staff.user.id, 'disabled');
    const denied = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'override',
      reason: 'Trotzdem',
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(denied.status).toBe(409);
    expect(denied.body.error.code).toBe('TRAINING_USER_INACTIVE');
    expect(denied.body.error.message).toBe(USER_INACTIVE_TEXT);
    expect(await clearanceRows(ctx.db, staff.user.id)).toHaveLength(0);
    expect(await securityEventsOfType(ctx.db, 'training.override_granted')).toHaveLength(0);
  });

  it('IU4. Historie bleibt: Freigaben eines deaktivierten Mitarbeiters bleiben lesbar (Liste, status disabled), Widerruf bleibt möglich – nichts wird gelöscht', async () => {
    const { admin, api } = await adminSession();
    const staff = await trainee(admin.id, 'Iu4');
    const verified = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'verified_demo',
    });
    const override = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: 'machine_clean_complete',
      source: 'override',
      reason: 'Vor der Deaktivierung',
    });
    expect(verified.status).toBe(201);
    expect(override.status).toBe(201);
    await ctx.admin.setUserStatus(admin.id, staff.user.id, 'disabled');
    const list = await api('GET', `${CLEARANCES_URL}?userId=${staff.user.id}`);
    expect(list.status).toBe(200);
    expect(list.body.clearances).toHaveLength(2);
    for (const clearance of list.body.clearances) {
      expect(clearance.user).toMatchObject({ lastName: 'Iu4', status: 'disabled' });
      expect(clearance.revokedAt).toBeNull();
    }
    const all = await api('GET', CLEARANCES_URL);
    expect(all.body.clearances.map((c: { id: string }) => c.id).sort()).toEqual(
      [verified.body.clearance.id, override.body.clearance.id].sort(),
    );
    const revoked = await api('POST', `${CLEARANCES_URL}/${override.body.clearance.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(true);
    expect(await clearanceRows(ctx.db, staff.user.id)).toHaveLength(2);
  });

  it('IU5. Reaktivierung: nicht widerrufene verified_demo gilt wieder im production-Gate; nach bewusstem Widerruf gesperrt', async () => {
    const { admin, api } = await adminSession();
    const staff = await trainee(admin.id, 'Iu5');
    expect((await api('PUT', GATES_URL, { definitionKey: DEFINITION, enabled: true })).status).toBe(
      200,
    );
    const verified = await api('POST', CLEARANCES_URL, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'verified_demo',
    });
    expect(verified.status).toBe(201);
    await ctx.admin.setUserStatus(admin.id, staff.user.id, 'disabled');
    // Deaktiviert: Sessions widerrufen – die Fachaktion ist schon an der Anmeldung zu Ende.
    const first = await pendingStocktake(admin.id, 0);
    expect((await apiOn(prod, staff.cookie)('POST', approveUrl(first))).status).toBe(401);
    expect((await loginTrainee('Iu5')).statusCode).not.toBe(200);
    await ctx.admin.setUserStatus(admin.id, staff.user.id, 'active');
    const session = await loginTrainee('Iu5');
    expect(session.statusCode).toBe(200);
    expect((await apiOn(prod, session.cookie)('POST', approveUrl(first))).status).toBe(200);
    expect(
      (await api('POST', `${CLEARANCES_URL}/${verified.body.clearance.id}/revoke`)).status,
    ).toBe(200);
    const second = await pendingStocktake(admin.id, 1);
    expectTrainingRequired(
      await apiOn(prod, session.cookie)('POST', approveUrl(second)),
      FEATURE,
      await definitionTitle(ctx.db, DEFINITION),
    );
  });
});
