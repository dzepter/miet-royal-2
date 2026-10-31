/**
 * Phase 14 – Live-Trainingssperren (Order §56–§66, §97–§100; Design §4.5, §4.7 T99–T118).
 *
 * Eine development-App (Testkontext) und je eine production-/staging-/demo-App
 * laufen auf DEMSELBEN Pool (`env-app-helpers`): Sperren werden ausschließlich
 * in production erzwungen. Fixtures entstehen über die echten Fachpfade; die
 * Sperre greift serverseitig NACH Rechten/Sichtbarkeit und VOR der Fachaktion.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { staffTrainingClearances, tours } from '@mietroyal/database';
import { eq } from 'drizzle-orm';
import { TRAINING_FEATURE_KEYS } from '../src/training/features.ts';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  bootstrapAdmin,
  createTestContext,
  destroyTestContext,
  login,
  type TestContext,
} from './auth-helpers.ts';
import { commerceServices, createCommerceWorld } from './commerce-helpers.ts';
import { createStaffWithPermissions } from './crm-helpers.ts';
import { createEnvApp, withEnvApp } from './env-app-helpers.ts';
import { scheduledBooking } from './handover-helpers.ts';
import { finalizedReturn, settlementRowFor } from './settlement-helpers.ts';
import { apiFor, createTour, todayBerlin } from './tours-helpers.ts';
import {
  FEATURE_DEFINITIONS,
  apiOn,
  clearanceRows,
  definitionTitle,
  enableAllGates,
  expectTrainingRequired,
  resetGateWorld,
  securityEventsOfType,
  setDefinitionActive,
  setRequirement,
} from './training-gate-helpers.ts';
import { inventoryServiceFor } from './warehouse-helpers.ts';

let ctx: TestContext;
let prod: FastifyInstance;

const FEATURE = 'inventory.stocktake_approve';
const DEFINITION = FEATURE_DEFINITIONS[FEATURE]!;
const STAFF = {
  firstName: 'Lara',
  lastName: 'Lager',
  email: 'lara.lager@test.example',
  password: 'lara-passwort-12345',
};

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
  return { admin, cookie: session.cookie };
}

/** Lagermitarbeiterin mit genau dem Fachrecht der gegateten Aktion. */
async function approver(adminId: string) {
  return createStaffWithPermissions(ctx, adminId, {
    ...STAFF,
    permissionKeys: ['inventory.approve_adjustment'],
  });
}

/** Inventur mit Differenz (Bestand „noch nicht erfasst“) ⇒ wartet auf Freigabe. */
async function pendingStocktake(adminId: string, itemIndex = 0): Promise<string> {
  const inventory = inventoryServiceFor(ctx);
  const items = await inventory.listItems();
  const item = items[itemIndex];
  if (item === undefined) throw new Error('Lagerartikel fehlt');
  const stocktake = await inventory.createStocktake(adminId, [
    { itemId: item.itemId, countedStock: 7 },
  ]);
  expect(stocktake.status).toBe('pending_approval');
  return stocktake.id;
}

const approveUrl = (stocktakeId: string) => `/staff/inventory/stocktakes/${stocktakeId}/approve`;

async function grantClearance(
  cookie: string,
  input: Record<string, unknown>,
  app: FastifyInstance = prod,
) {
  return apiOn(app, cookie)('POST', '/staff/training/admin/clearances', input);
}

describe('T99–T106: Sperre, Freigabe, Override, Ablauf, Widerruf (production)', () => {
  it('T99. Gate standardmäßig aus – ohne Sperrzeile ist die Freigabe in production erlaubt', async () => {
    const { admin, cookie } = await adminSession();
    const staff = await approver(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    const overview = await apiOn(prod, cookie)('GET', '/staff/training/admin/gates');
    expect(overview.status).toBe(200);
    expect(overview.body.enforced).toBe(true);
    expect(overview.body.features).toHaveLength(8);
    for (const feature of overview.body.features) expect(feature.requirement).toBeNull();
    const result = await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId));
    expect(result.status).toBe(200);
    expect(result.body.stocktake.status).toBe('approved');
  });

  it('T100/T101/T110. Permission allein reicht nicht: aktive Sperre ohne Freigabe ⇒ 403 TRAINING_REQUIRED mit Feature, Übung und Titel', async () => {
    const { admin } = await adminSession();
    const staff = await approver(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    await setRequirement(ctx.db, FEATURE, DEFINITION, true);
    const title = await definitionTitle(ctx.db, DEFINITION);
    const result = await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId));
    expectTrainingRequired(result, FEATURE, title);
    // Fachaktion ist nicht passiert.
    const view = await inventoryServiceFor(ctx).stocktakeById(stocktakeId);
    expect(view.status).toBe('pending_approval');
  });

  it('T102. Bestätigtes Demo-Training (verified_demo) ⇒ Aktion erlaubt', async () => {
    const { admin, cookie } = await adminSession();
    const staff = await approver(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    await setRequirement(ctx.db, FEATURE, DEFINITION, true);
    const granted = await grantClearance(cookie, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'verified_demo',
    });
    expect(granted.status).toBe(201);
    expect(granted.body.clearance).toMatchObject({
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'verified_demo',
      reason: null,
      validUntil: null,
      active: true,
    });
    const result = await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId));
    expect(result.status).toBe(200);
  });

  it('T103. Override mit Begründung ⇒ Aktion erlaubt', async () => {
    const { admin, cookie } = await adminSession();
    const staff = await approver(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    await setRequirement(ctx.db, FEATURE, DEFINITION, true);
    const granted = await grantClearance(cookie, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'override',
      reason: 'Einarbeitung durch Lagerleitung erfolgt',
    });
    expect(granted.status).toBe(201);
    expect(granted.body.clearance.source).toBe('override');
    const result = await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId));
    expect(result.status).toBe(200);
  });

  it('T104. Override ohne Begründung wird blockiert (400 VALIDATION, auch per Datenbank-Constraint)', async () => {
    const { admin, cookie } = await adminSession();
    const staff = await approver(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    await setRequirement(ctx.db, FEATURE, DEFINITION, true);
    for (const reason of [undefined, null, '', '   ']) {
      const denied = await grantClearance(cookie, {
        userId: staff.user.id,
        definitionKey: DEFINITION,
        source: 'override',
        ...(reason === undefined ? {} : { reason }),
      });
      expect(denied.status).toBe(400);
      expect(denied.body.error.code).toBe('VALIDATION');
      expect(denied.body.error.message).toBe(
        'Für einen Override ist eine Begründung erforderlich.',
      );
    }
    expect(await clearanceRows(ctx.db, staff.user.id)).toHaveLength(0);
    // Datenbank-Backstop: ein Override ohne Begründung ist auch per INSERT unmöglich.
    await expect(
      ctx.db.insert(staffTrainingClearances).values({
        userId: staff.user.id,
        definitionKey: DEFINITION,
        source: 'override',
        reason: null,
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    expectTrainingRequired(
      await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId)),
      FEATURE,
      await definitionTitle(ctx.db, DEFINITION),
    );
  });

  it('T105. Abgelaufener Override blockiert wieder', async () => {
    const { admin, cookie } = await adminSession();
    const staff = await approver(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    await setRequirement(ctx.db, FEATURE, DEFINITION, true);
    const pastUntil = await grantClearance(cookie, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'override',
      reason: 'Befristet',
      validUntil: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(pastUntil.status).toBe(400);
    expect(pastUntil.body.error.code).toBe('VALIDATION');
    const granted = await grantClearance(cookie, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'override',
      reason: 'Befristet bis Schulung',
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(granted.status).toBe(201);
    // Zeit vorspulen: Gültigkeit liegt jetzt in der Vergangenheit.
    await ctx.db
      .update(staffTrainingClearances)
      .set({
        validFrom: new Date(Date.now() - 2 * 3_600_000),
        validUntil: new Date(Date.now() - 3_600_000),
      })
      .where(eq(staffTrainingClearances.id, granted.body.clearance.id));
    expectTrainingRequired(
      await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId)),
      FEATURE,
      await definitionTitle(ctx.db, DEFINITION),
    );
    const list = await apiOn(prod, cookie)(
      'GET',
      `/staff/training/admin/clearances?userId=${staff.user.id}`,
    );
    expect(list.status).toBe(200);
    expect(list.body.clearances).toHaveLength(1);
    expect(list.body.clearances[0].active).toBe(false);
  });

  it('T106. Widerruf wirkt sofort – gleiche Session, nächste Anfrage 403', async () => {
    const { admin, cookie } = await adminSession();
    const staff = await approver(admin.id);
    const first = await pendingStocktake(admin.id, 0);
    const second = await pendingStocktake(admin.id, 1);
    await setRequirement(ctx.db, FEATURE, DEFINITION, true);
    const granted = await grantClearance(cookie, {
      userId: staff.user.id,
      definitionKey: DEFINITION,
      source: 'override',
      reason: 'Vorübergehend',
    });
    expect(granted.status).toBe(201);
    expect((await apiOn(prod, staff.cookie)('POST', approveUrl(first))).status).toBe(200);
    const revoked = await apiOn(prod, cookie)(
      'POST',
      `/staff/training/admin/clearances/${granted.body.clearance.id}/revoke`,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ revoked: true, clearance: { active: false } });
    expect(revoked.body.clearance.revokedAt).not.toBeNull();
    expectTrainingRequired(
      await apiOn(prod, staff.cookie)('POST', approveUrl(second)),
      FEATURE,
      await definitionTitle(ctx.db, DEFINITION),
    );
  });
});

describe('T107–T110: Erzwingung nur in production', () => {
  it('T107. demo erzwingt keine Sperre (und kennt keine Admin-Gate-Routen)', async () => {
    const { admin, cookie } = await adminSession();
    const staff = await approver(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    await setRequirement(ctx.db, FEATURE, DEFINITION, true);
    await withEnvApp(ctx, 'demo', async (demo) => {
      const result = await apiOn(demo, staff.cookie)('POST', approveUrl(stocktakeId));
      expect(result.status).toBe(200);
      const gates = await apiOn(demo, cookie)('GET', '/staff/training/admin/gates');
      expect(gates.status).toBe(404);
      const put = await apiOn(demo, cookie)('PUT', `/staff/training/admin/gates/${FEATURE}`, {
        definitionKey: DEFINITION,
        enabled: true,
      });
      expect(put.status).toBe(404);
    });
  });

  it('T108. development erzwingt keine Sperre', async () => {
    const { admin } = await adminSession();
    const staff = await approver(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    await setRequirement(ctx.db, FEATURE, DEFINITION, true);
    const result = await apiOn(ctx.app, staff.cookie)('POST', approveUrl(stocktakeId));
    expect(result.status).toBe(200);
  });

  it('T109. staging erzwingt keine Sperre (Konfiguration sichtbar, enforced=false)', async () => {
    const { admin, cookie } = await adminSession();
    const staff = await approver(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    await setRequirement(ctx.db, FEATURE, DEFINITION, true);
    await withEnvApp(ctx, 'staging', async (staging) => {
      const gates = await apiOn(staging, cookie)('GET', '/staff/training/admin/gates');
      expect(gates.status).toBe(200);
      expect(gates.body.enforced).toBe(false);
      expect(
        gates.body.features.find((f: { featureKey: string }) => f.featureKey === FEATURE)
          .requirement.enabled,
      ).toBe(true);
      const result = await apiOn(staging, staff.cookie)('POST', approveUrl(stocktakeId));
      expect(result.status).toBe(200);
    });
  });

  it('T110. production erzwingt die Sperre', async () => {
    const { admin } = await adminSession();
    const staff = await approver(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    await setRequirement(ctx.db, FEATURE, DEFINITION, true);
    expectTrainingRequired(
      await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId)),
      FEATURE,
      await definitionTitle(ctx.db, DEFINITION),
    );
  });
});

describe('T111–T112: Systemadmin', () => {
  it('T111. Systemadmin hat keinen automatischen Bypass', async () => {
    const { admin, cookie } = await adminSession();
    const stocktakeId = await pendingStocktake(admin.id);
    await setRequirement(ctx.db, FEATURE, DEFINITION, true);
    expectTrainingRequired(
      await apiOn(prod, cookie)('POST', approveUrl(stocktakeId)),
      FEATURE,
      await definitionTitle(ctx.db, DEFINITION),
    );
  });

  it('T112. Bewusster Systemadmin-Override über denselben auditierten Weg ist möglich', async () => {
    const { admin, cookie } = await adminSession();
    const stocktakeId = await pendingStocktake(admin.id);
    await setRequirement(ctx.db, FEATURE, DEFINITION, true);
    const granted = await grantClearance(cookie, {
      userId: admin.id,
      definitionKey: DEFINITION,
      source: 'override',
      reason: 'Admin-Freigabe für Notfallkorrektur',
    });
    expect(granted.status).toBe(201);
    expect((await apiOn(prod, cookie)('POST', approveUrl(stocktakeId))).status).toBe(200);
    const events = await securityEventsOfType(ctx.db, 'training.override_granted');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorUserId: admin.id, targetUserId: admin.id });
    expect(events[0]!.details).toMatchObject({
      clearanceId: granted.body.clearance.id,
      definitionKey: DEFINITION,
      source: 'override',
    });
    expect(JSON.stringify(events[0]!.details)).not.toContain('Notfallkorrektur');
  });
});

/** Gate-Aufrufe statisch je Routendatei zählen (ohne Importzeilen). */
function gateCallsByFile(): Record<string, number> {
  const routesDir = fileURLToPath(new URL('../src/routes/', import.meta.url));
  const counts: Record<string, number> = {};
  for (const file of readdirSync(routesDir).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(`${routesDir}${file}`, 'utf8');
    const calls = source
      .split('\n')
      .filter((line) => !line.includes('import '))
      .join('\n')
      .match(/requireTrainingGate\(/g);
    if (calls !== null) counts[file] = calls.length;
  }
  return counts;
}

describe('T113–T114: Verwaltung und Lese-Routen werden nie gegated', () => {
  it('T113. training.manage-Routen, Mitarbeiter-/Rechteverwaltung bleiben bei aktiven Sperren erreichbar (dynamisch + statisch)', async () => {
    const { admin, cookie } = await adminSession();
    await enableAllGates(ctx.db, admin.id);
    const api = apiOn(prod, cookie);
    expect((await api('GET', '/staff/training/admin/gates')).status).toBe(200);
    const put = await api('PUT', `/staff/training/admin/gates/${FEATURE}`, {
      definitionKey: DEFINITION,
      enabled: true,
    });
    expect(put.status).toBe(200);
    expect((await api('GET', '/staff/training/admin/clearances')).status).toBe(200);
    const granted = await api('POST', '/staff/training/admin/clearances', {
      userId: admin.id,
      definitionKey: 'offer_send',
      source: 'verified_demo',
    });
    expect(granted.status).toBe(201);
    expect(
      (await api('POST', `/staff/training/admin/clearances/${granted.body.clearance.id}/revoke`))
        .status,
    ).toBe(200);
    expect((await api('GET', '/staff/users')).status).toBe(200);
    expect((await api('GET', '/staff/roles')).status).toBe(200);
    expect((await api('GET', '/staff/permissions')).status).toBe(200);
    expect((await api('GET', '/staff/security-events')).status).toBe(200);
    expect((await api('GET', '/auth/me')).status).toBe(200);

    // Statisch: genau die 8 Zielaktionen (releaseRoute deckt vier Settlement-Routen ab).
    expect(gateCallsByFile()).toEqual({
      'commerce.ts': 1,
      'handover.ts': 1,
      'returns.ts': 2,
      'settlement.ts': 1,
      'tours.ts': 2,
      'warehouse.ts': 1,
    });
    const routesDir = fileURLToPath(new URL('../src/routes/', import.meta.url));
    const usedKeys = new Set<string>();
    for (const file of readdirSync(routesDir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(`${routesDir}${file}`, 'utf8');
      for (const match of source.matchAll(/requireTrainingGate\([^;]*?'([a-z_.]+)'/gs)) {
        usedKeys.add(match[1]!);
      }
    }
    expect([...usedKeys].sort()).toEqual([...TRAINING_FEATURE_KEYS].sort());
    const sync = readFileSync(
      fileURLToPath(new URL('../src/offline/sync-service.ts', import.meta.url)),
      'utf8',
    );
    expect(sync.match(/this\.trainingGate\.assert\(/g)).toHaveLength(1);
  });

  it('T114. demo.manage-Routen bleiben ohne Gate (demo kennt keine Erzwingung, Status-Route erreichbar)', async () => {
    const { admin, cookie } = await adminSession();
    await enableAllGates(ctx.db, admin.id);
    await withEnvApp(ctx, 'demo', async (demo) => {
      const status = await apiOn(demo, cookie)('GET', '/staff/demo/status');
      expect(status.status).toBe(200);
      expect(status.body.environment).toBe('demo');
    });
    const routesDir = fileURLToPath(new URL('../src/routes/', import.meta.url));
    for (const file of ['demo.ts', 'staff-admin.ts', 'auth.ts', 'training-gates.ts']) {
      expect(readFileSync(`${routesDir}${file}`, 'utf8')).not.toContain('requireTrainingGate');
    }
  });
});

describe('T115–T116: inaktive/inkonsistente Definition', () => {
  it('T115. Inaktive oder unbekannte Übung ist kein Gate-Ziel (409 / 404); Deaktivieren bleibt möglich', async () => {
    const { cookie } = await adminSession();
    const api = apiOn(prod, cookie);
    await setDefinitionActive(ctx.db, DEFINITION, false);
    const inactive = await api('PUT', `/staff/training/admin/gates/${FEATURE}`, {
      definitionKey: DEFINITION,
      enabled: true,
    });
    expect(inactive.status).toBe(409);
    expect(inactive.body.error.code).toBe('TRAINING_DEFINITION_INACTIVE');
    const unknown = await api('PUT', `/staff/training/admin/gates/${FEATURE}`, {
      definitionKey: 'gibt_es_nicht',
      enabled: true,
    });
    expect(unknown.status).toBe(404);
    const unknownFeature = await api('PUT', '/staff/training/admin/gates/unbekannt.feature', {
      definitionKey: DEFINITION,
      enabled: true,
    });
    expect(unknownFeature.status).toBe(404);
    // Admin-Recovery (§98): eine Sperre auf eine inzwischen inaktive Übung darf deaktiviert werden.
    const disabled = await api('PUT', `/staff/training/admin/gates/${FEATURE}`, {
      definitionKey: DEFINITION,
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.feature.requirement.enabled).toBe(false);
    expect(await securityEventsOfType(ctx.db, 'training.gate_enabled')).toHaveLength(0);
  });

  it('T116. Inkonsistente Sperre (aktiv, Übung per SQL inaktiv) blockiert fail-closed – auch mit Freigabe; Deaktivieren hebt sie auf', async () => {
    const { admin, cookie } = await adminSession();
    const staff = await approver(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    const api = apiOn(prod, cookie);
    const enabled = await api('PUT', `/staff/training/admin/gates/${FEATURE}`, {
      definitionKey: DEFINITION,
      enabled: true,
    });
    expect(enabled.status).toBe(200);
    expect(
      (
        await grantClearance(cookie, {
          userId: staff.user.id,
          definitionKey: DEFINITION,
          source: 'verified_demo',
        })
      ).status,
    ).toBe(201);
    await setDefinitionActive(ctx.db, DEFINITION, false);
    const blocked = await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('TRAINING_CONFIGURATION_INVALID');
    expect(blocked.body.error.message).not.toContain('TRAINING_');
    expect(blocked.body.error.details).toMatchObject({
      featureKey: FEATURE,
      requiredTrainingKey: DEFINITION,
    });
    const overview = await api('GET', '/staff/training/admin/gates');
    const feature = overview.body.features.find(
      (f: { featureKey: string }) => f.featureKey === FEATURE,
    );
    expect(feature.definition).toMatchObject({ key: DEFINITION, active: false });
    const disabled = await api('PUT', `/staff/training/admin/gates/${FEATURE}`, {
      definitionKey: DEFINITION,
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    expect((await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId))).status).toBe(200);
  });
});

describe('T117–T118: direkter API-Aufruf umgeht das Gate nicht', () => {
  it('T117. Alle 8 Zielaktionen und der Offline-Sync (finalize/clean) antworten in production mit TRAINING_REQUIRED', async () => {
    const { admin, cookie } = await adminSession();
    await enableAllGates(ctx.db, admin.id);
    const api = apiOn(prod, cookie);
    const titleOf = (feature: string) => definitionTitle(ctx.db, FEATURE_DEFINITIONS[feature]!);

    // Angebot senden
    const world = await createCommerceWorld(ctx, admin.id);
    const { versionId } = await commerceServices(ctx).offers.createOffer(admin.id, world.processId);
    expectTrainingRequired(
      await api('POST', `/staff/offer-versions/${versionId}/send`),
      'offer.send',
      await titleOf('offer.send'),
    );

    // Übergabe / Rückgabe abschließen (sichtbare Buchung; Gate greift vor der Fachprüfung)
    const booking = await scheduledBooking(ctx, admin.id);
    expectTrainingRequired(
      await api('POST', `/staff/handover/${booking.bookingId}/finalize`, {}),
      'handover.finalize',
      await titleOf('handover.finalize'),
    );
    expectTrainingRequired(
      await api('POST', `/staff/returns/${booking.bookingId}/finalize`),
      'return.finalize',
      await titleOf('return.finalize'),
    );

    // Tour starten / übernehmen (Tour über die development-App angelegt)
    const tour = await createTour(apiFor(ctx.app, cookie), {
      tourDate: todayBerlin(),
      assignedUserId: admin.id,
    });
    expectTrainingRequired(
      await api('POST', `/staff/tours/${tour.id}/start`, {}),
      'tour.start',
      await titleOf('tour.start'),
    );
    expectTrainingRequired(
      await api('POST', `/staff/tours/${tour.id}/takeover`, {}),
      'tour.takeover',
      await titleOf('tour.takeover'),
    );
    const [tourRow] = await ctx.db.select().from(tours).where(eq(tours.id, tour.id));
    expect(tourRow?.status).toBe('draft');

    // Reinigung abschließen / Lagerzählung freigeben
    expectTrainingRequired(
      await api('POST', `/staff/machines/${randomUUID()}/clean-complete`),
      'machine.clean_complete',
      await titleOf('machine.clean_complete'),
    );
    expectTrainingRequired(
      await api('POST', approveUrl(randomUUID())),
      'inventory.stocktake_approve',
      await titleOf('inventory.stocktake_approve'),
    );

    // Abrechnung: vier Freigabe-Routen, eine Sperre (finalisierte Rückgabe über die dev-App)
    const settled = await finalizedReturn(ctx, admin.id, cookie);
    const settlement = await settlementRowFor(ctx, settled.processId);
    expect(settlement).not.toBeNull();
    for (const path of ['notice/approve-and-send', 'customer-response', 'release', 'end-wait']) {
      expectTrainingRequired(
        await api('POST', `/staff/settlements/${settlement!.id}/${path}`, {
          version: settlement!.version,
        }),
        'settlement.release',
        await titleOf('settlement.release'),
      );
    }
    expect((await settlementRowFor(ctx, settled.processId))!.status).toBe(settlement!.status);

    // Offline-Sync: dieselben Fachaktionen werden nach der Rechteprüfung gesperrt (dauerhafte Ablehnung).
    const syncOn = async (
      type: string,
      contextId: string,
      payload: unknown,
      base: unknown,
      feature: string,
    ) => {
      const now = new Date().toISOString();
      const result = await api('POST', '/staff/offline/sync', {
        deviceId: randomUUID(),
        environment: 'production',
        clientTime: now,
        mutation: {
          clientMutationId: randomUUID(),
          type,
          contextKind: type.startsWith('machine.') ? 'machine' : 'booking',
          contextId,
          createdAt: now,
          baseVersion: JSON.stringify(base),
          payload,
          media: [],
        },
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        status: 'rejected',
        code: 'TRAINING_REQUIRED',
        message: `Für diese Funktion ist zuerst das Training ‚${await titleOf(feature)}‘ erforderlich.`,
      });
      expect(result.body.details.server).toBe(result.body.message);
      expect(result.body.details.action).toBeTruthy();
    };
    const bookingBase = { processStatus: 'open', appointmentId: null, appointmentVersion: null };
    const capturedAt = new Date().toISOString();
    await syncOn(
      'handover.finalize',
      booking.bookingId,
      { capturedAt, expectedSlots: [] },
      bookingBase,
      'handover.finalize',
    );
    await syncOn(
      'return.finalize',
      booking.bookingId,
      { capturedAt, expectedMachines: [] },
      bookingBase,
      'return.finalize',
    );
    await syncOn(
      'machine.clean_complete',
      randomUUID(),
      { expectedCleaningSince: null },
      { machineUpdatedAt: null },
      'machine.clean_complete',
    );
  });

  it('T118. Verständlicher Text ohne Technikcodes; Übungsantwort trägt Titel und Keys für die UI', async () => {
    const { admin } = await adminSession();
    const staff = await approver(admin.id);
    const stocktakeId = await pendingStocktake(admin.id);
    await setRequirement(ctx.db, FEATURE, DEFINITION, true);
    const result = await apiOn(prod, staff.cookie)('POST', approveUrl(stocktakeId));
    expect(result.status).toBe(403);
    const message: string = result.body.error.message;
    expect(message).toMatch(/^Für diese Funktion ist zuerst das Training ‚.+‘ erforderlich\.$/);
    expect(message).not.toMatch(/TRAINING_|403|FORBIDDEN|inventory\./);
    expect(result.body.error.details.title).toBe(await definitionTitle(ctx.db, DEFINITION));
  });
});
