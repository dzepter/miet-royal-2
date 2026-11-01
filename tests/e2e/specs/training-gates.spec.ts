/**
 * Phase-14-E2E-Szenarien L–N (Order §109, §56–§66, §107) – Live-Trainings-
 * sperren in der PRODUCTION-Umgebung, Projekt `production-gates`
 * (playwright.config.ts): Production-API (APP_ENV=production, Port 3110,
 * eigene Datenbank `mietroyal_test_prod`, frisch je Lauf inkl. Live-Admin und
 * Mitarbeiterin „E2E-Live“ über scripts/e2e-prod-setup.ts, kein Lexware/
 * WhatsApp/Routing, Mail nur als nie angesprochener SMTP-Platzhalter – production
 * blockiert den Angebotsversand ohne SMTP-Weg hart, der Versandjob läuft hier
 * nie) und Production-Staff-Instanz (Port 3111 = baseURL).
 *
 * - L Production Gate blockiert: Admin aktiviert die Sperre `offer.send` ⇒
 *   Mitarbeiterin sieht beim Senden „Für diese Funktion ist zuerst das
 *   Training ‚Angebot bearbeiten und versenden‘ erforderlich.“, Angebot bleibt
 *   Entwurf, direkter API-Aufruf ⇒ 403 TRAINING_REQUIRED, `/training` zeigt
 *   die Sperre als „offen“.
 * - M Verified Demo erlaubt: Admin bestätigt das Demo-Training ⇒ Senden klappt,
 *   `/training` zeigt „freigegeben (Demo bestätigt)“.
 * - N Override/Widerruf: Widerruf der Bestätigung ⇒ sofort wieder gesperrt;
 *   Override ohne Begründung ⇒ Formularfehler, nichts gespeichert; Override
 *   mit Begründung ⇒ erlaubt; Widerruf ⇒ sofort wieder gesperrt; Audit ohne
 *   Begründungstext.
 *
 * Login im Browser: Session-/Gerätecookies sind in production `Secure`/
 * `__Host-`; Chromium akzeptiert sie auf http://127.0.0.1 (vertrauenswürdiger
 * Loopback). Rate-Limits der Auth-Endpunkte sind aktiv – genau zwei Logins
 * (Admin, Mitarbeiterin), Cookies werden wiederverwendet. Angebotsdaten
 * (Kunde, Vorgang, Anfrage) legt der Admin über die Staff-UI an (Muster
 * commerce-flow.spec.ts); Fakten liest die Spec direkt aus der Datenbank.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { queryDatabase } from '../helpers/communication-ops.ts';
import {
  PROD_ADMIN_EMAIL,
  PROD_ADMIN_FIRST_NAME,
  PROD_ADMIN_PASSWORD,
  PROD_API_ORIGIN,
  PROD_DATABASE_URL,
  PROD_STAFF_EMAIL,
  PROD_STAFF_FIRST_NAME,
  PROD_STAFF_PASSWORD,
} from '../helpers/prod-env.ts';
import { login } from '../helpers/settlement.ts';

test.describe.configure({ mode: 'serial' });

const PROD_PROJECT = 'production-gates';

/** Servertexte (apps/api/src/training/gate-service.ts, gate-admin-service.ts; UI zeigt sie unverändert). */
const GATE_TEXT =
  'Für diese Funktion ist zuerst das Training ‚Angebot bearbeiten und versenden‘ erforderlich.';
const OVERRIDE_REASON_TEXT = 'Für einen Override ist eine Begründung erforderlich.';
const OVERRIDE_REASON = 'Einarbeitung durch die Teamleitung begleitet (E2E-Override)';

function prodDb<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return queryDatabase<T>(PROD_DATABASE_URL, sql, params);
}

/** Aufruf der Staff-API aus dem Browserkontext (Same-Origin-Proxy; Secure-Cookie reist mit). */
async function browserApi<T = unknown>(
  page: Page,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const response = await fetch(`/api${path}`, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      return { status: response.status, data: data as T };
    },
    { method, path, body },
  );
}

/** Kunde + Vorgang anlegen (Muster commerce-flow.spec.ts); liefert die Vorgangs-ID. */
async function createProcess(page: Page, firstName: string, lastName: string, email: string) {
  await page.goto('/kunden');
  await page.getByRole('button', { name: 'Kunde anlegen' }).click();
  await page.getByLabel('Vorname').fill(firstName);
  await page.getByLabel('Nachname').fill(lastName);
  await page.getByLabel('E-Mail (optional)').fill(email);
  await page.getByRole('button', { name: 'Kunde anlegen' }).click();
  await expect(page.getByRole('heading', { name: `${firstName} ${lastName}` })).toBeVisible();
  await page.getByRole('button', { name: 'Vorgang anlegen' }).click();
  await expect(page.getByRole('heading', { name: /^MR-\d{4}-\d{4,}$/ })).toBeVisible();
  const match = /\/vorgaenge\/([0-9a-f-]{36})/.exec(page.url());
  expect(match).not.toBeNull();
  return match![1]!;
}

/** Anfrage erfassen (Eventdatum in 30 Tagen, 40 Gäste, 2×10-Maschine, 2 L Kirsche gratis). */
async function fillInquiry(page: Page, processId: string) {
  await page.goto(`/vorgaenge/${processId}/anfrage`);
  await expect(page.getByRole('heading', { name: 'Anfrage' })).toBeVisible();
  const eventDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await page.getByLabel('Eventdatum').fill(eventDate);
  await page.getByLabel('Gästezahl (exakt)').fill('40');
  await page.getByLabel('Anlass').selectOption({ label: 'Geburtstag' });
  await page.getByLabel('Gewünschter Maschinentyp').selectOption({ label: '2×10 L' });
  await page.getByLabel('Sirup Kirsche – gratis (L)').fill('2');
  await page.getByRole('button', { name: 'Anfrage speichern' }).click();
  await expect(page.getByText('Anfrage gespeichert.')).toBeVisible();
}

/** Angebotsentwurf aus der Anfrage (Version 1) – durch die Mitarbeiterin. */
async function createOfferDraft(page: Page, processId: string): Promise<string> {
  await page.goto(`/vorgaenge/${processId}/angebot`);
  await page.getByRole('button', { name: 'Angebot erstellen (aus Anfrage)' }).click();
  await expect(page.getByRole('heading', { name: /Version 1/ })).toBeVisible();
  const rows = prodDb<{ id: string; status: string }>(
    `SELECT v.id, v.status FROM offer_versions v JOIN offers o ON o.id = v.offer_id
      WHERE o.process_id = $1 ORDER BY v.version_number DESC LIMIT 1`,
    [processId],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe('draft');
  return rows[0]!.id;
}

function offerStatus(versionId: string): string {
  return prodDb<{ status: string }>('SELECT status FROM offer_versions WHERE id = $1', [
    versionId,
  ])[0]!.status;
}

/** Versand über die UI: blockiert (Sperrtext in `offer-error`, kein Link) … */
async function expectSendBlocked(page: Page, processId: string, versionId: string) {
  await page.goto(`/vorgaenge/${processId}/angebot`);
  await expect(page.getByRole('heading', { name: /Version 1/ })).toBeVisible();
  await page.getByRole('button', { name: 'Angebot versenden' }).click();
  const error = page.getByTestId('offer-error');
  await expect(error).toBeVisible();
  await expect(error).toHaveText(GATE_TEXT);
  await expect(page.getByTestId('public-offer-link')).toHaveCount(0);
  expect(offerStatus(versionId)).toBe('draft');
}

/** … oder erlaubt (öffentlicher Link, Version „sent“). */
async function expectSendAllowed(page: Page, processId: string, versionId: string) {
  await page.goto(`/vorgaenge/${processId}/angebot`);
  await expect(page.getByRole('heading', { name: /Version 1/ })).toBeVisible();
  await page.getByRole('button', { name: 'Angebot versenden' }).click();
  await expect(page.getByTestId('public-offer-link')).toBeVisible();
  await expect(page.getByTestId('offer-error')).toHaveCount(0);
  expect(offerStatus(versionId)).toBe('sent');
}

function clearanceRow(page: Page, source: 'verified_demo' | 'override', userId: string) {
  return page.locator(
    `[data-testid="training-clearance"][data-source="${source}"][data-user="${userId}"][data-definition="offer_send"]`,
  );
}

async function revokeClearance(page: Page, row: ReturnType<typeof clearanceRow>) {
  await row.getByTestId('training-clearance-revoke').click();
  await expect(page.getByTestId('training-clearance-revoke-dialog')).toBeVisible();
  await page.getByTestId('training-clearance-revoke-confirm').click();
  await expect(row).toHaveAttribute('data-active', 'false');
  await expect(row.getByTestId('training-clearance-state')).toHaveText('widerrufen');
  await expect(row.getByTestId('training-clearance-revoke')).toHaveCount(0);
}

function gateRow(page: Page) {
  return page.locator('[data-testid="training-gate-row"][data-feature="offer.send"]');
}

/** `/training` der Mitarbeiterin: nur Hinweis + Live-Sperren, Status der Sperre `offer.send`. */
async function expectGateStatus(page: Page, cleared: boolean, statusText: string) {
  await page.goto('/training');
  await expect(page.getByTestId('training-demo-only')).toHaveText(
    'Übungen werden in der Demo-Umgebung absolviert.',
  );
  await expect(page.getByTestId('training-gates-not-enforced')).toHaveCount(0);
  await expect(page.getByTestId('training-exercise')).toHaveCount(0);
  const row = gateRow(page);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-cleared', cleared ? 'true' : 'false');
  await expect(row).toHaveAttribute('data-training', 'offer_send');
  await expect(row).toContainText('Angebot senden');
  await expect(row).toContainText('Angebot bearbeiten und versenden');
  await expect(row).toContainText(statusText);
}

function auditTypes(): string[] {
  return prodDb<{ type: string }>(
    `SELECT type FROM staff_security_events WHERE type LIKE 'training.%' ORDER BY created_at ASC`,
  ).map((row) => row.type);
}

// ── Zustand über die seriellen Tests hinweg ───────────────────────────

let adminContext: BrowserContext;
let admin: Page;
let staffContext: BrowserContext;
let mia: Page;
let adminId = '';
let miaId = '';
const processes: string[] = [];

test.describe('Live-Trainingssperren (Projekt production-gates)', () => {
  test.skip(
    () => test.info().project.name !== PROD_PROJECT,
    'Die Live-Sperren werden nur in APP_ENV=production erzwungen (Projekt production-gates).',
  );

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const health = await fetch(`${PROD_API_ORIGIN}/health`, { headers: { connection: 'close' } });
    expect(health.status).toBe(200);
    expect(((await health.json()) as { environment: string }).environment).toBe('production');
    adminId = prodDb<{ id: string }>('SELECT id FROM staff_users WHERE lower(email) = lower($1)', [
      PROD_ADMIN_EMAIL,
    ])[0]!.id;
    miaId = prodDb<{ id: string }>('SELECT id FROM staff_users WHERE lower(email) = lower($1)', [
      PROD_STAFF_EMAIL,
    ])[0]!.id;
    // Genau zwei Logins (Rate-Limit); beide Sitzungen bleiben über alle Szenarien bestehen.
    adminContext = await browser.newContext();
    admin = await adminContext.newPage();
    await login(admin, PROD_ADMIN_EMAIL, PROD_ADMIN_PASSWORD, PROD_ADMIN_FIRST_NAME);
    staffContext = await browser.newContext();
    mia = await staffContext.newPage();
    await login(mia, PROD_STAFF_EMAIL, PROD_STAFF_PASSWORD, PROD_STAFF_FIRST_NAME);
    // Drei Vorgänge mit Anfrage (je Szenario ein frischer Entwurf) – durch den Admin.
    for (const [index, customer] of [
      ['Lea', 'Live-Eins', 'lea.live-eins@live.test'],
      ['Leo', 'Live-Zwei', 'leo.live-zwei@live.test'],
      ['Lia', 'Live-Drei', 'lia.live-drei@live.test'],
    ].entries()) {
      const processId = await createProcess(admin, customer[0]!, customer[1]!, customer[2]!);
      await fillInquiry(admin, processId);
      processes[index] = processId;
    }
  });

  test.afterAll(async () => {
    await adminContext?.close();
    await staffContext?.close();
  });

  test('L Production Gate blockiert: Admin aktiviert die Sperre „Angebot senden“ ⇒ Senden zeigt den Trainingshinweis, Angebot bleibt Entwurf, direkter API-Aufruf 403 TRAINING_REQUIRED, /training zeigt die Sperre „offen“', async () => {
    test.setTimeout(180_000);
    // Ohne Sperre: keine Anforderung, keine Zeile bei der Mitarbeiterin (Gate standardmäßig aus).
    expect(prodDb(`SELECT feature_key FROM training_feature_requirements`)).toHaveLength(0);
    await mia.goto('/training');
    await expect(mia.getByTestId('training-demo-only')).toBeVisible();
    await expect(mia.getByTestId('training-gate-status-empty')).toBeVisible();

    await admin.goto('/einstellungen/training');
    await expect(admin.getByTestId('training-admin-live')).toBeVisible();
    await expect(admin.getByTestId('training-admin-demo')).toHaveCount(0);
    await expect(admin.getByTestId('training-gates-hint')).toHaveCount(0);
    const gate = admin.locator('[data-testid="training-gate"][data-feature="offer.send"]');
    await expect(gate).toBeVisible();
    await expect(gate).toHaveAttribute('data-enabled', 'false');
    await gate.getByTestId('training-gate-definition').selectOption('offer_send');
    await gate.getByTestId('training-gate-toggle').click();
    await expect(gate).toHaveAttribute('data-enabled', 'true');
    await expect(gate.getByTestId('training-gate-state')).toHaveText('Sperre aktiv');
    await expect(gate.getByTestId('training-gate-error')).toHaveCount(0);
    expect(
      prodDb<{ definition_key: string; enabled: boolean; configured_by: string }>(
        `SELECT definition_key, enabled, configured_by FROM training_feature_requirements
          WHERE feature_key = 'offer.send'`,
      )[0],
    ).toMatchObject({ definition_key: 'offer_send', enabled: true, configured_by: adminId });
    expect(auditTypes()).toContain('training.gate_enabled');

    // Mitarbeiterin: Entwurf anlegen klappt (ungegated), Senden ist gesperrt.
    const versionId = await createOfferDraft(mia, processes[0]!);
    await expectSendBlocked(mia, processes[0]!, versionId);
    // Direkter API-Aufruf umgeht die Sperre nicht (Order §65/§117).
    const direct = await browserApi<{
      error: { code: string; message: string; details: Record<string, unknown> };
    }>(mia, 'POST', `/staff/offer-versions/${versionId}/send`, {});
    expect(direct.status).toBe(403);
    expect(direct.data.error).toMatchObject({
      code: 'TRAINING_REQUIRED',
      message: GATE_TEXT,
      details: { featureKey: 'offer.send', requiredTrainingKey: 'offer_send' },
    });
    expect(offerStatus(versionId)).toBe('draft');
    await expectGateStatus(mia, false, 'offen');
  });

  test('M Verified Demo erlaubt: Admin bestätigt das Demo-Training (verified_demo) ⇒ /training „freigegeben (Demo bestätigt)“, Senden klappt; Freigabe ohne Demo-Daten, Audit training.demo_verified', async () => {
    test.setTimeout(180_000);
    await admin.goto('/einstellungen/training');
    await expect(admin.getByTestId('training-clearances-empty')).toBeVisible();
    await admin.getByTestId('training-verify-user').selectOption(miaId);
    await admin.getByTestId('training-verify-definition').selectOption('offer_send');
    await admin.getByTestId('training-verify').click();
    const verified = clearanceRow(admin, 'verified_demo', miaId);
    await expect(verified).toBeVisible();
    await expect(verified).toHaveAttribute('data-active', 'true');
    await expect(verified.getByTestId('training-clearance-state')).toHaveText('aktiv');
    await expect(admin.getByTestId('training-verify-error')).toHaveCount(0);
    const rows = prodDb<Record<string, unknown>>(
      `SELECT * FROM staff_training_clearances WHERE user_id = $1 AND definition_key = 'offer_send'`,
      [miaId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'verified_demo',
      reason: null,
      valid_until: null,
      revoked_at: null,
      granted_by: adminId,
    });
    // Nur Mitarbeiter + Übungsschlüssel – keine Demo-Businessdaten (Order §58/§125).
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        'id',
        'user_id',
        'definition_key',
        'source',
        'reason',
        'valid_from',
        'valid_until',
        'granted_by',
        'granted_at',
        'revoked_at',
        'revoked_by',
      ].sort(),
    );
    expect(auditTypes()).toContain('training.demo_verified');

    await expectGateStatus(mia, true, 'freigegeben (Demo bestätigt)');
    const versionId = prodDb<{ id: string }>(
      `SELECT v.id FROM offer_versions v JOIN offers o ON o.id = v.offer_id
        WHERE o.process_id = $1 ORDER BY v.version_number DESC LIMIT 1`,
      [processes[0]!],
    )[0]!.id;
    await expectSendAllowed(mia, processes[0]!, versionId);
    // Angebot ist versendet; die Angebotsmail liegt nur in der Outbox (Job `mail.send` läuft in
    // diesem Projekt nie – das SMTP-Ziel ist ein nie angesprochener Platzhalter): kein Versand.
    const mails = prodDb<{ status: string; sent_at: string | null }>(
      `SELECT status, sent_at FROM mail_deliveries WHERE process_id = $1 AND kind = 'offer'`,
      [processes[0]!],
    );
    expect(mails).toHaveLength(1);
    expect(mails[0]!.status).toBe('pending');
    expect(mails[0]!.sent_at).toBeNull();
  });

  test('N Override/Widerruf: Widerruf der Bestätigung ⇒ sofort gesperrt; Override ohne Begründung ⇒ Formularfehler (nichts gespeichert); Override mit Begründung ⇒ erlaubt; Widerruf ⇒ sofort wieder gesperrt; Audit ohne Begründungstext', async () => {
    test.setTimeout(240_000);
    // Widerruf der Demo-Bestätigung wirkt sofort (Order §65/§106).
    await admin.goto('/einstellungen/training');
    await revokeClearance(admin, clearanceRow(admin, 'verified_demo', miaId));
    expect(auditTypes()).toContain('training.demo_verification_revoked');
    const versionTwo = await createOfferDraft(mia, processes[1]!);
    await expectSendBlocked(mia, processes[1]!, versionTwo);
    await expectGateStatus(mia, false, 'offen');

    // Override ohne Begründung ⇒ Formularfehler, keine Zeile (Order §59/§104).
    await admin.goto('/einstellungen/training');
    await admin.getByTestId('training-override-user').selectOption(miaId);
    await admin.getByTestId('training-override-definition').selectOption('offer_send');
    await admin.getByTestId('training-override-reason').fill('');
    await admin.getByTestId('training-override').click();
    await expect(admin.getByTestId('training-override-error')).toHaveText(OVERRIDE_REASON_TEXT);
    expect(
      prodDb(`SELECT id FROM staff_training_clearances WHERE source = 'override'`),
    ).toHaveLength(0);
    await expect(clearanceRow(admin, 'override', miaId)).toHaveCount(0);

    // Override mit Begründung ⇒ erlaubt.
    await admin.getByTestId('training-override-reason').fill(OVERRIDE_REASON);
    await admin.getByTestId('training-override').click();
    const override = clearanceRow(admin, 'override', miaId);
    await expect(override).toBeVisible();
    await expect(override).toHaveAttribute('data-active', 'true');
    await expect(override).toContainText(OVERRIDE_REASON);
    await expect(admin.getByTestId('training-override-error')).toHaveCount(0);
    expect(
      prodDb<{ reason: string | null; valid_until: string | null }>(
        `SELECT reason, valid_until FROM staff_training_clearances WHERE source = 'override' AND user_id = $1`,
        [miaId],
      ),
    ).toEqual([{ reason: OVERRIDE_REASON, valid_until: null }]);
    await expectGateStatus(mia, true, 'freigegeben (Override');
    await expectSendAllowed(mia, processes[1]!, versionTwo);

    // Widerruf des Overrides ⇒ nächste Anfrage sofort gesperrt.
    await admin.goto('/einstellungen/training');
    await revokeClearance(admin, clearanceRow(admin, 'override', miaId));
    const versionThree = await createOfferDraft(mia, processes[2]!);
    await expectSendBlocked(mia, processes[2]!, versionThree);
    await expectGateStatus(mia, false, 'offen');

    // Audit (Order §84/§130): alle Ereignisse vorhanden, Begründung nie im Audit.
    const types = auditTypes();
    for (const type of [
      'training.gate_enabled',
      'training.demo_verified',
      'training.demo_verification_revoked',
      'training.override_granted',
      'training.override_revoked',
    ]) {
      expect(types, type).toContain(type);
    }
    const auditText = JSON.stringify(
      prodDb(`SELECT details FROM staff_security_events WHERE type LIKE 'training.%'`),
    );
    expect(auditText).not.toContain('Teamleitung');
    expect(auditText).not.toMatch(/@live\.test|MR-\d{4}/);
  });
});
