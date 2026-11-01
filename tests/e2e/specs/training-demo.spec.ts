/**
 * Phase-14-E2E-Szenarien (Order §109) rund um das Mitarbeitertraining in der
 * Demo-Umgebung – Projekt `demo-communication` (Demo-API 3106, Demo-Staff-
 * Instanz 3107 als Produktions-Build, Demo-Datenbank `mietroyal_test_demo`):
 *
 * - B Demo Seed: Reset per API ⇒ kanonischer Datensatz, Registry vollständig
 *   inkl. `voucher.situation` (Fixture-Gutschein ohne Transfer), Audit
 *   `demo.reset_started`/`demo.reset_completed` nur mit Meta-Details.
 * - E Offer Training: Entwurf bearbeiten (Rabatt) + versenden ⇒ bestanden;
 *   „Übung prüfen“ vor dem Versand ⇒ „Noch nicht vollständig“; Angebotsmail an
 *   die Demo-Testadresse des Seed-Kunden (Review-Fix F8, Whitelist-Domain):
 *   pending ⇒ Job `mail.send` ⇒ Senke „[DEMO] …“ ⇒ sent.
 * - F Handover Training: Übergabe-Wizard vollständig ⇒ bestanden.
 * - G Return Training: Rückgabe-Wizard vollständig ⇒ bestanden; Pfad
 *   „Grundlagen Vermietung“ abgeschlossen.
 * - K Admin Progress: Einstellungen → Training (Zuweisung, Fortschritt,
 *   Fehlprüfung STEP_NOT_COMPLETED ohne Businessdaten, Training-Reset ⇒
 *   Trainee sieht die Unterbrechung und startet neu).
 * - H Tour Training: eigene Tour mit heutigem Stopp ⇒ bereit, starten,
 *   beenden ⇒ bestanden; Routing nur Mock (kein Request am Provider-Fake).
 * - I Communication Training: E-Mail-Antwort an eine `@demo.test`-Adresse ⇒
 *   Job `mail.send` ⇒ `sent` ⇒ bestanden (eingereiht allein zählt nicht).
 * - F7 Freie Übung ohne Zuweisung (Review-Fix F7): Mitarbeiterin ohne Pfad
 *   besteht `communication_reply` unter „Weitere Übungen“ (Antwort an die
 *   Seed-Kundin mit Demo-Testadresse) ⇒ nach Reload Karte „erledigt“ mit
 *   „Bestanden am“, ohne „Übung starten“, genau ein Versuch.
 * - J Settlement Training ohne Lexware-Erfolg: Klärungen entscheiden ⇒
 *   „Bereit zur Buchhaltung“, Demo-Hinweis, kein Transfer, keine Mock-Karte.
 * - J2 Settlement Training mit Belastung (Review-Fix F8/F4): Beträge festlegen
 *   ⇒ „Kundeninformation prüfen“ ⇒ „Freigeben und senden“ (eingereiht, Prüfung
 *   offen) ⇒ Job `mail.send` ⇒ Senke „[DEMO] …“ an die Demo-Testadresse ⇒
 *   „Jetzt freigeben“ ⇒ „Bereit zur Buchhaltung“ ⇒ bestanden, kein Transfer.
 * - O Definition Update Stability: Katalog-Variante (Version +1, neuer Titel)
 *   ⇒ bestandene Übung bleibt bestanden, Katalog zeigt die neue Version.
 * - P Demo Provider Isolation: Accounting disabled, Lexware-Webhook 404,
 *   WhatsApp nur Mock (`mock-…`, kein Graph-Request), Routing Mock ohne
 *   Provider-Request, Mail an einen Seed-Kunden mit Beispieldomain blockiert
 *   mit „[DEMO]“ (die fünf Mail-Übungskunden tragen die Demo-Testadresse).
 * - D Reset + Offline Epoch: offline erfasste Übergabe-Prüfung, Reset durch
 *   den Admin, online ⇒ Banner/Dialog „Demo-Daten zurückgesetzt“, „Später“,
 *   Bestätigen ⇒ alter Stand verworfen, neues Paket mit neuer Epoch, neuer
 *   Seed unverändert.
 *
 * A (Banner), C (Reset-Dialog) und Q (Live↔Demo-Wechsel) liegen in
 * demo-environment.spec.ts. Jeder Test ist gegen den Demo-Zustand idempotent
 * (Reset per API bzw. eigene Datensätze); Trainees sind eigene Mitarbeiter mit
 * genau den Fachrechten der jeweiligen Übung (Order §55: Training erweitert
 * keine Rechte). Fakten liest die Spec direkt aus der Demo-Datenbank.
 *
 * Zeit: Szenario H legt einen Liefertermin HEUTE relativ zu jetzt an
 * (`todayWindow`) – Lauf NICHT zwischen 23:38 und 00:02 Uhr Berlin starten.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { SMTP_SINK_PASSWORD } from '../fakes/constants.ts';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  DEMO_API_ORIGIN,
  DEMO_AUTH_SECRET_KEY,
  DEMO_COMMUNICATION_PAYLOAD_KEY,
  DEMO_DATABASE_URL,
  DEMO_MAIL_WHITELIST,
} from '../helpers/demo-env.ts';
import { clearSink, expectMailCount, linkFromMail, waitForMail } from '../helpers/mail.ts';
import { resetRoutingFake, routingRequests } from '../helpers/routing.ts';
import { seedTours, todayWindow } from '../helpers/tours.ts';
import {
  assignPathViaApi,
  attemptEvents,
  attemptsOf,
  bookingIdOfProcess,
  browserApi,
  checkExerciseViaUi,
  customerEmailOfProcess,
  demoApi,
  demoApiLogin,
  demoDb,
  exerciseCard,
  expectExercisePassedViaUi,
  finalizeHandoverViaUi,
  finalizeReturnViaUi,
  loginDemo,
  openTraining,
  processNumberOf,
  resetDemoViaApi,
  runDemoJobs,
  seedEntityId,
  SETTLEMENT_DEMO_UNAVAILABLE_TEXT,
  staffUserIdByEmail,
  startExerciseViaUi,
  syncTrainingCatalog,
  type TrainingMeDefinition,
} from '../helpers/training.ts';
import { clearWhatsAppFake, whatsappRequests } from '../helpers/whatsapp.ts';

test.describe.configure({ mode: 'serial' });

const DEMO_PROJECT = 'demo-communication';

/** Pflicht-Szenarien (Order §10) – Kopie von REQUIRED_DEMO_SEED_KEYS (apps/api/src/demo/seed/data.ts). */
const REQUIRED_SEED_KEYS = [
  'customer.private.basic',
  'customer.org.basic',
  'customer.private.repeat',
  'process.inquiry.new',
  'process.offer.draft',
  'process.offer.sent',
  'process.booking.accepted.pickup',
  'process.booking.accepted.delivery',
  'process.handover.ready',
  'process.rental.active',
  'process.return.due',
  'process.return.overdue',
  'process.return.damage',
  'process.return.missing_part',
  'process.cleaning.pending',
  'process.settlement.review',
  'process.completed',
  'process.repeat.second',
  'appointment.return.planned',
  'appointment.return.due_today',
  'appointment.return.overdue',
  'conversation.email.inbound',
  'conversation.email.reply',
  'tour.today.multi_stop',
  'tour.future.planned',
  'inventory.stocktake.initial',
  'inventory.movement.incoming',
  'inventory.item.low_stock',
  'machine.ready.basic',
  'machine.assigned',
  'machine.reserved',
  'machine.rented',
  'machine.cleaning',
  'machine.blocked',
  'voucher.situation',
] as const;

interface Trainee {
  key: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  permissions: string[];
}

/**
 * Trainees mit genau den Fachrechten ihrer Übungen (Berichte TRAINING-CORE/UI):
 * - rental: E (offer.edit_draft/offer.send; Entwurfsbearbeitung hier per Rabatt ≤ 10 %),
 *   F (handover.view/perform), G (return.view/perform/complete) + Sichtrechte; `handover.view`
 *   ist zugleich ein offline-freischaltendes Recht (Szenario D).
 * - tour: H (Planer + Fahrer: calendar.view/view_all/manage, appointment.assign).
 * - contact: I (message.reply_customer).
 * - review: J (settlement.view, damage.set_cost, missing_item.set_cost).
 * - release: J2 (wie review + settlement.release für „Freigeben und senden“ und
 *   settlement.end_pre_notice_wait für „Jetzt freigeben“ – Rechte des Belastungspfads).
 * - free: F7 (message.reply_customer, OHNE Zuweisung – freie Übung „Weitere Übungen“).
 * Alle Werte sind synthetisches TEST-Material (Whitelist-Domain demo.test).
 */
const TRAINEES = {
  rental: {
    key: 'rental',
    firstName: 'Tina',
    lastName: 'Training',
    email: 'tina.training@demo.test',
    password: 'e2e-demo-training-passwort-1',
    permissions: [
      'process.view_all',
      'customer.view',
      'product.view',
      'inquiry.view',
      'offer.view',
      'offer.edit_draft',
      'offer.send',
      'offer.apply_discount',
      'discount.up_to_10',
      'handover.view',
      'handover.perform',
      'return.view',
      'return.perform',
      'return.complete',
      'machine.view',
    ],
  },
  tour: {
    key: 'tour',
    firstName: 'Timo',
    lastName: 'Tour',
    email: 'timo.tour@demo.test',
    password: 'e2e-demo-tour-passwort-1',
    permissions: [
      'process.view_all',
      'calendar.view',
      'calendar.view_all',
      'calendar.manage',
      'appointment.assign',
    ],
  },
  contact: {
    key: 'contact',
    firstName: 'Kim',
    lastName: 'Kontakt',
    email: 'kim.kontakt@demo.test',
    password: 'e2e-demo-kontakt-passwort-1',
    permissions: ['process.view_all', 'customer.view', 'message.reply_customer'],
  },
  review: {
    key: 'review',
    firstName: 'Sina',
    lastName: 'Pruefung',
    email: 'sina.pruefung@demo.test',
    password: 'e2e-demo-pruefung-passwort-1',
    permissions: [
      'process.view_all',
      'customer.view',
      'settlement.view',
      'damage.set_cost',
      'missing_item.set_cost',
    ],
  },
  release: {
    key: 'release',
    firstName: 'Samira',
    lastName: 'Senden',
    email: 'samira.senden@demo.test',
    password: 'e2e-demo-senden-passwort-1',
    permissions: [
      'process.view_all',
      'customer.view',
      'settlement.view',
      'damage.set_cost',
      'missing_item.set_cost',
      'settlement.release',
      'settlement.end_pre_notice_wait',
    ],
  },
  free: {
    key: 'free',
    firstName: 'Frida',
    lastName: 'Frei',
    email: 'frida.frei@demo.test',
    password: 'e2e-demo-frei-passwort-1',
    permissions: ['process.view_all', 'customer.view', 'message.reply_customer'],
  },
} satisfies Record<string, Trainee>;

const STEP_NOT_COMPLETED_PREFIX = 'Noch nicht vollständig – offener Schritt: ‚';

// ── Zustand über die seriellen Tests hinweg ───────────────────────────

let adminCookie = '';
let adminId = '';
const traineeIds: Record<string, string> = {};
const sessions = new Map<string, { context: BrowserContext; page: Page }>();
/** Szenario I/P: Vorgang eines Kunden mit Whitelist-Adresse (vom Admin angelegt). */
let contactProcess: { customerId: string; processId: string; processNumber: string } | null = null;

const CONTACT_CUSTOMER_EMAIL = 'kai.kunde@demo.test';
const DEMO_WA_ID = '4915100009902';
/**
 * Review-Fix F8: Seed-Kunden der Mail-Übungen tragen `<lokalteil>@<Whitelist-Domain>`
 * (apps/api/src/demo/seed/data.ts DEMO_MAIL_EXERCISE_CUSTOMERS, Demo-API mit
 * MAIL_DEMO_WHITELIST=@demo.test): Musterverein (process.offer.draft), Lena Beispiel
 * (process.inquiry.new / conversation.email.unanswered), Beispiel-Werke GmbH
 * (process.settlement.review). `process.offer.sent` (Hannah Testerin) bleibt example.com.
 */
const OFFER_CUSTOMER_EMAIL = `verein${DEMO_MAIL_WHITELIST}`;
const UNANSWERED_CUSTOMER_EMAIL = `lena.beispiel${DEMO_MAIL_WHITELIST}`;
const SETTLEMENT_CUSTOMER_EMAIL = `einkauf${DEMO_MAIL_WHITELIST}`;
/** Staff-UI nach „Freigeben und senden“ (Phase 12, Outbox) – wie settlement-flow.spec.ts. */
const NOTICE_QUEUED_TEXT =
  'Kundeninformation freigegeben – das Wartefenster beginnt mit bestätigtem Mailversand.';

interface MailDeliveryRow {
  id: string;
  status: string;
  blocked_reason: string | null;
  recipient_email: string;
  subject: string;
  sent_at: string | null;
}

/** Outbox-Zeilen eines Vorgangs je Art (älteste zuerst). */
function mailDeliveriesOf(processId: string, kind: string): MailDeliveryRow[] {
  return demoDb<MailDeliveryRow>(
    `SELECT id, status, blocked_reason, recipient_email, subject, sent_at FROM mail_deliveries
      WHERE process_id = $1 AND kind = $2::mail_delivery_kind ORDER BY created_at ASC`,
    [processId, kind],
  );
}

function settlementRow(settlementId: string) {
  const rows = demoDb<{
    status: string;
    accounting_transfer_id: string | null;
    transferred_at: string | null;
  }>('SELECT status, accounting_transfer_id, transferred_at FROM settlements WHERE id = $1', [
    settlementId,
  ]);
  expect(rows, `Abrechnung ${settlementId}`).toHaveLength(1);
  return rows[0]!;
}

async function traineePage(browser: Browser, trainee: Trainee): Promise<Page> {
  const existing = sessions.get(trainee.key);
  if (existing !== undefined) return existing.page;
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginDemo(page, trainee.email, trainee.password, trainee.firstName);
  sessions.set(trainee.key, { context, page });
  return page;
}

async function loginDemoAdmin(page: Page) {
  await loginDemo(page, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, 'Dana');
}

function traineeId(trainee: Trainee): string {
  const id = traineeIds[trainee.key];
  expect(id, `Mitarbeiter ${trainee.email}`).toBeDefined();
  return id!;
}

function assignmentCard(page: Page, pathKey: string) {
  return page.locator(`[data-testid="training-assignment"][data-key="${pathKey}"]`);
}

function adminUserRow(page: Page, userId: string) {
  return page.locator(`[data-testid="training-admin-user-row"][data-user="${userId}"]`);
}

/** Meta-Wert des lokalen Offline-Arbeitsbereichs (IndexedDB, nur technische Klartextwerte). */
async function readOfflineMeta(page: Page, key: string): Promise<string | null> {
  return page.evaluate(async (metaKey) => {
    const databases = await indexedDB.databases();
    const name = databases.map((d) => d.name ?? '').find((n) => n.startsWith('mietroyal-offline-'));
    if (name === undefined) return null;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise<{ value?: unknown } | undefined>((resolve, reject) => {
      const request = db.transaction('meta').objectStore('meta').get(metaKey);
      request.onsuccess = () => resolve(request.result as { value?: unknown } | undefined);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return typeof record?.value === 'string' ? record.value : null;
  }, key);
}

/** Service Worker aktiv + Arbeitspaket geladen (Muster offline-flow.spec.ts). */
async function waitForOfflineReady(page: Page) {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.active !== null && registration?.active !== undefined;
  });
  await page.goto('/sync');
  await expect(page.getByText(/Arbeitspaket \(heute ±3 Tage\) vom/)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'online',
  );
}

async function goOffline(page: Page) {
  await page.context().setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(page.getByTestId('offline-indicator')).toHaveAttribute(
    'data-connectivity',
    'offline',
  );
}

async function pendingCount(page: Page): Promise<number> {
  return Number((await page.getByTestId('offline-indicator').getAttribute('data-pending')) ?? '0');
}

test.describe('Training in der Demo (Projekt demo-communication)', () => {
  test.skip(
    () => test.info().project.name !== DEMO_PROJECT,
    'Trainingsszenarien laufen nur gegen die Demo-API/-Staff-Instanz (Projekt demo-communication).',
  );

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    await clearSink();
    await clearWhatsAppFake();
    await resetRoutingFake();
    const health = await demoApi<{ environment: string }>('GET', '/health');
    expect(health.data.environment).toBe('demo');
    adminCookie = await demoApiLogin(DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD);
    adminId = staffUserIdByEmail(DEMO_ADMIN_EMAIL);
    // Trainees über den bestehenden Seed-Weg (createStaffWithPermissions) – Staff-Daten
    // überleben jeden Demo-Reset (Order §18).
    const seeded = seedTours(
      {
        adminEmail: DEMO_ADMIN_EMAIL,
        users: Object.values(TRAINEES).map((trainee) => ({
          key: trainee.key,
          firstName: trainee.firstName,
          lastName: trainee.lastName,
          email: trainee.email,
          password: trainee.password,
          permissions: trainee.permissions,
        })),
      },
      DEMO_DATABASE_URL,
    );
    for (const trainee of Object.values(TRAINEES)) {
      traineeIds[trainee.key] = seeded.users[trainee.key]!.id;
    }
    // Zuweisungen (training.manage): Übungen erscheinen unter dem Pfad mit Fortschritt.
    await assignPathViaApi(adminCookie, traineeId(TRAINEES.rental), 'rental_basics');
    await assignPathViaApi(adminCookie, traineeId(TRAINEES.contact), 'communication');
    await assignPathViaApi(adminCookie, traineeId(TRAINEES.review), 'settlement');
    await assignPathViaApi(adminCookie, traineeId(TRAINEES.release), 'settlement');
    // TRAINEES.free bekommt bewusst KEINE Zuweisung (Szenario F7: freie Übung).
  });

  test.afterAll(async () => {
    for (const session of sessions.values()) await session.context.close();
    sessions.clear();
  });

  test('B Demo Seed: Reset per API ⇒ kanonischer Datensatz, Registry vollständig inkl. voucher.situation (ein aktiver Fixture-Gutschein ohne Transfer/Rechnung), Audit demo.reset_started/completed nur mit Meta-Details, Status ohne ausstehende Storage-Bereinigung', async () => {
    test.setTimeout(180_000);
    const eventsBefore = demoDb<{ n: string }>(
      `SELECT count(*)::text AS n FROM staff_security_events WHERE type LIKE 'demo.reset_%'`,
    )[0]!.n;
    const result = await resetDemoViaApi(adminCookie);
    expect(result.datasetVersion).toBe(1);
    expect(result.seeded['processes']).toBeGreaterThan(0);

    const registry = await demoApi<{
      entities: { seedKey: string; entityType: string; entityId: string }[];
    }>('GET', '/staff/demo/seed-entities', { cookie: adminCookie });
    expect(registry.status).toBe(200);
    const byKey = new Map(registry.data.entities.map((entity) => [entity.seedKey, entity]));
    for (const key of REQUIRED_SEED_KEYS) expect(byKey.has(key), `Seed-Key ${key}`).toBe(true);
    const dbKeys = new Set(
      demoDb<{ seed_key: string }>('SELECT seed_key FROM demo_seed_entities').map(
        (r) => r.seed_key,
      ),
    );
    expect([...dbKeys].sort()).toEqual([...byKey.keys()].sort());

    // W1.1: genau ein aktiver synthetischer Gutschein (Fixture), ohne Transfer/Providerreferenz.
    const voucherEntity = byKey.get('voucher.situation')!;
    expect(voucherEntity.entityType).toBe('voucher');
    const vouchers = demoDb<{ id: string; status: string; delivery_status: string }>(
      'SELECT id, status, delivery_status FROM vouchers',
    );
    expect(vouchers).toHaveLength(1);
    expect(vouchers[0]).toMatchObject({
      id: voucherEntity.entityId,
      status: 'active',
      delivery_status: 'pending',
    });
    expect(demoDb('SELECT id FROM accounting_transfers')).toHaveLength(0);
    expect(
      demoDb(
        `SELECT id FROM integration_jobs
          WHERE type = 'settlement.accounting_transfer' AND status = 'succeeded'`,
      ),
    ).toHaveLength(0);

    // Audit (Order §31): Start + Abschluss desselben Laufs, Actor Admin, nur Meta-Details.
    const events = demoDb<{
      type: string;
      actor_user_id: string | null;
      details: Record<string, unknown>;
    }>(
      `SELECT type, actor_user_id, details FROM staff_security_events
        WHERE type LIKE 'demo.reset_%' ORDER BY created_at DESC, type DESC LIMIT 2`,
    );
    expect(events.map((event) => event.type).sort()).toEqual([
      'demo.reset_completed',
      'demo.reset_started',
    ]);
    const started = events.find((event) => event.type === 'demo.reset_started')!;
    const completed = events.find((event) => event.type === 'demo.reset_completed')!;
    expect(started.actor_user_id).toBe(adminId);
    expect(completed.actor_user_id).toBe(adminId);
    expect(started.details).toMatchObject({ status: 'started', datasetVersion: 1 });
    expect(completed.details).toMatchObject({ status: 'completed', datasetVersion: 1 });
    expect(started.details['resetRunId']).toEqual(completed.details['resetRunId']);
    for (const event of events) {
      expect(Object.keys(event.details).sort()).toEqual(
        ['datasetVersion', 'resetRunId', 'status'].sort(),
      );
    }
    expect(JSON.stringify(events)).not.toMatch(/example\.com|example\.invalid|@|MR-\d{4}/);
    expect(
      Number(
        demoDb<{ n: string }>(
          `SELECT count(*)::text AS n FROM staff_security_events WHERE type LIKE 'demo.reset_%'`,
        )[0]!.n,
      ),
    ).toBe(Number(eventsBefore) + 2);

    const status = await demoApi<{
      datasetVersion: number;
      outdated: boolean;
      resetInProgress: boolean;
      storageCleanup: { pendingJobs: number; deadJobs: number };
    }>('GET', '/staff/demo/status', { cookie: adminCookie });
    expect(status.status).toBe(200);
    expect(status.data).toMatchObject({
      datasetVersion: 1,
      outdated: false,
      resetInProgress: false,
      storageCleanup: { pendingJobs: 0, deadJobs: 0 },
    });
  });

  test('E Offer Training: Übung starten → Entwurf des Demo-Vorgangs bearbeiten (Rabatt) → „Übung prüfen“ ⇒ offener Schritt „Angebot versenden“ → versenden ⇒ automatisch bestanden; Angebotsmail an die Demo-Testadresse pending ⇒ Job mail.send ⇒ Senke „[DEMO] …“ ⇒ sent', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const trainee = TRAINEES.rental;
    const userId = traineeId(trainee);
    const page = await traineePage(browser, trainee);
    const processId = seedEntityId('process.offer.draft');

    await openTraining(page);
    const assignment = assignmentCard(page, 'rental_basics');
    await expect(assignment).toBeVisible();
    await expect(assignment).toHaveAttribute('data-status', 'assigned');
    await expect(assignment.getByTestId('training-assignment-progress')).toContainText(
      '0 von 3 Pflichtübungen erledigt',
    );
    const attemptId = await startExerciseViaUi(page, userId, 'offer_send');
    const card = exerciseCard(page, 'offer_send');
    await expect(card.locator('[data-testid="training-step"][data-step="edit"]')).toHaveAttribute(
      'data-done',
      'false',
    );
    await expect(card.locator('[data-testid="training-step"][data-step="send"]')).toHaveAttribute(
      'data-done',
      'false',
    );
    await expect(card.getByTestId('training-open-step')).toContainText(
      'Angebotsentwurf anlegen oder bearbeiten',
    );
    await expect(assignment).toHaveAttribute('data-status', 'in_progress');
    // Seed-Szenario über den Link (Registry-Auflösung, Order §72).
    await expect(card.getByTestId('training-demo-link')).toHaveAttribute(
      'href',
      `/vorgaenge/${processId}`,
    );
    await card.getByTestId('training-demo-link').click();
    await expect(page).toHaveURL(new RegExp(`/vorgaenge/${processId}$`));

    // Entwurf bearbeiten: 5 % Rabatt (≤ 10 %, kein Pflichtgrund).
    await page.goto(`/vorgaenge/${processId}/angebot`);
    await expect(page.getByRole('heading', { name: /Version 1/ })).toBeVisible();
    await page.getByLabel('Art').selectOption('percent');
    await page.getByLabel('Prozent (z. B. 10)').fill('5');
    await page.getByRole('button', { name: 'Rabatt setzen' }).click();
    await expect(page.getByText(/Rabatt: -/)).toBeVisible();

    // Zwischenstand: Schritt „bearbeiten“ erledigt, „versenden“ offen ⇒ Prüfung nicht vollständig.
    await openTraining(page);
    await expect(card.locator('[data-testid="training-step"][data-step="edit"]')).toHaveAttribute(
      'data-done',
      'true',
    );
    await expect(card.locator('[data-testid="training-step"][data-step="send"]')).toHaveAttribute(
      'data-done',
      'false',
    );
    const checkResult = await checkExerciseViaUi(page, 'offer_send');
    await expect(checkResult).toHaveAttribute('data-passed', 'false');
    await expect(checkResult).toHaveText(`${STEP_NOT_COMPLETED_PREFIX}Angebot versenden‘.`);
    expect(attemptsOf(userId, 'offer_send')[0]).toMatchObject({
      id: attemptId,
      status: 'in_progress',
      failed_check_count: 1,
    });

    // Versenden ⇒ letztes Pflicht-Ereignis ⇒ automatisch bestanden (Order §45).
    await page.goto(`/vorgaenge/${processId}/angebot`);
    await page.getByRole('button', { name: 'Angebot versenden' }).click();
    await expect(page.getByTestId('public-offer-link')).toBeVisible();
    await expect(page.getByTestId('offer-error')).toHaveCount(0);
    await expectExercisePassedViaUi(page, 'offer_send');
    await expect(assignmentCard(page, 'rental_basics')).toHaveAttribute(
      'data-status',
      'in_progress',
    );
    await expect(
      assignmentCard(page, 'rental_basics').getByTestId('training-assignment-progress'),
    ).toContainText('1 von 3 Pflichtübungen erledigt');

    const attempt = attemptsOf(userId, 'offer_send')[0]!;
    expect(attempt).toMatchObject({ id: attemptId, status: 'passed', failed_check_count: 1 });
    expect(attempt.completed_at).not.toBeNull();
    const events = attemptEvents(attemptId);
    expect(events.map((event) => [event.event_key, event.result])).toEqual(
      expect.arrayContaining([
        ['offer.draft_updated', 'accepted'],
        ['offer.sent', 'accepted'],
      ]),
    );
    expect(events.some((event) => event.error_code === 'STEP_NOT_COMPLETED')).toBe(true);
    // Fachlich versendet; der Seed-Kunde trägt die Demo-Testadresse (Whitelist-Domain, Review-Fix
    // F8): die Angebotsmail ist eingereiht (pending), nicht blockiert – zugestellt wird sie erst
    // durch den Job mail.send (kein Worker im E2E-Lauf), mit „[DEMO]“-Betreff an die Senke.
    expect(
      demoDb<{ status: string }>(
        `SELECT v.status FROM offer_versions v JOIN offers o ON o.id = v.offer_id
          WHERE o.process_id = $1 ORDER BY v.version_number DESC LIMIT 1`,
        [processId],
      )[0],
    ).toMatchObject({ status: 'sent' });
    expect(customerEmailOfProcess(processId)).toBe(OFFER_CUSTOMER_EMAIL);
    const offerMails = mailDeliveriesOf(processId, 'offer');
    expect(offerMails).toHaveLength(1);
    expect(offerMails[0]).toMatchObject({
      status: 'pending',
      blocked_reason: null,
      recipient_email: OFFER_CUSTOMER_EMAIL,
      sent_at: null,
    });
    const offerSubject = offerMails[0]!.subject;
    expect(offerSubject).toBe(
      `[DEMO] Dein Angebot von Miet-Royal – Vorgang ${processNumberOf(processId)}`,
    );
    await expectMailCount({ to: OFFER_CUSTOMER_EMAIL, subject: offerSubject }, 0);
    await runDemoJobs(adminCookie);
    const offerMail = await waitForMail({ to: OFFER_CUSTOMER_EMAIL, subject: offerSubject });
    expect(offerMail.subject).toBe(offerSubject);
    expect(new URL(linkFromMail(offerMail, '/angebot/')).pathname).toMatch(/^\/angebot\/.+/);
    await expectMailCount({ to: OFFER_CUSTOMER_EMAIL, subject: offerSubject }, 1);
    const sentOfferMail = mailDeliveriesOf(processId, 'offer')[0]!;
    expect(sentOfferMail).toMatchObject({
      id: offerMails[0]!.id,
      status: 'sent',
      blocked_reason: null,
    });
    expect(sentOfferMail.sent_at).not.toBeNull();
  });

  test('F Handover Training: vorbereitete Ausgabe des Demo-Vorgangs im Übergabe-Wizard vollständig abschließen (Prüfung, Foto, Empfänger, zwei Unterschriften) ⇒ bestanden', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const trainee = TRAINEES.rental;
    const userId = traineeId(trainee);
    const page = await traineePage(browser, trainee);
    const processId = seedEntityId('process.handover.ready');
    const bookingId = bookingIdOfProcess(processId);

    await openTraining(page);
    const attemptId = await startExerciseViaUi(page, userId, 'handover_complete');
    const card = exerciseCard(page, 'handover_complete');
    await expect(card.getByTestId('training-open-step')).toContainText('Übergabe abschließen');
    await expect(card.getByTestId('training-demo-link')).toHaveAttribute(
      'href',
      `/vorgaenge/${processId}`,
    );
    await finalizeHandoverViaUi(page, processId, `${trainee.firstName} ${trainee.lastName}`);
    await expectExercisePassedViaUi(page, 'handover_complete');

    expect(
      demoDb<{ status: string }>('SELECT status FROM handovers WHERE booking_id = $1', [
        bookingId,
      ])[0],
    ).toMatchObject({ status: 'finalized' });
    expect(attemptsOf(userId, 'handover_complete')[0]).toMatchObject({
      id: attemptId,
      status: 'passed',
      failed_check_count: 0,
    });
    expect(attemptEvents(attemptId).map((event) => [event.event_key, event.result])).toEqual([
      ['handover.finalized', 'accepted'],
    ]);
  });

  test('G Return Training: fällige Rückgabe des Demo-Vorgangs im Rückgabe-Wizard ohne Beanstandung abschließen ⇒ bestanden; Pfad „Grundlagen Vermietung“ abgeschlossen', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const trainee = TRAINEES.rental;
    const userId = traineeId(trainee);
    const page = await traineePage(browser, trainee);
    const processId = seedEntityId('process.return.due');
    const bookingId = bookingIdOfProcess(processId);

    await openTraining(page);
    const attemptId = await startExerciseViaUi(page, userId, 'return_complete');
    await expect(
      exerciseCard(page, 'return_complete').getByTestId('training-demo-link'),
    ).toHaveAttribute('href', `/vorgaenge/${processId}`);
    await finalizeReturnViaUi(page, processId, `${trainee.firstName} ${trainee.lastName}`);
    await expectExercisePassedViaUi(page, 'return_complete');
    const assignment = assignmentCard(page, 'rental_basics');
    await expect(assignment).toHaveAttribute('data-status', 'completed');
    await expect(assignment.getByTestId('training-assignment-progress')).toContainText(
      '3 von 3 Pflichtübungen erledigt',
    );

    expect(
      demoDb<{ finalized_at: string | null }>(
        'SELECT finalized_at FROM rental_returns WHERE booking_id = $1',
        [bookingId],
      )[0]?.finalized_at,
    ).not.toBeNull();
    expect(attemptsOf(userId, 'return_complete')[0]).toMatchObject({
      id: attemptId,
      status: 'passed',
    });
    expect(attemptEvents(attemptId).map((event) => [event.event_key, event.result])).toEqual([
      ['return.finalized', 'accepted'],
    ]);
    expect(
      demoDb<{ status: string }>(
        `SELECT a.status FROM training_assignments a JOIN training_paths p ON p.id = a.path_id
          WHERE a.user_id = $1 AND p.key = 'rental_basics'`,
        [userId],
      )[0],
    ).toMatchObject({ status: 'completed' });
  });

  test('K Admin Progress: Einstellungen → Training zeigt Fortschritt (3/3), Zuweisung über die UI, „Übung prüfen“ ohne Erfüllung ⇒ Fehlprüfung + Ereignis STEP_NOT_COMPLETED ohne Businessdaten, Training-Reset ⇒ Trainee sieht die Unterbrechung und kann neu starten', async ({
    browser,
    page,
  }) => {
    test.setTimeout(300_000);
    const rentalId = traineeId(TRAINEES.rental);
    const tourTrainee = TRAINEES.tour;
    const tourId = traineeId(tourTrainee);

    await loginDemoAdmin(page);
    await page.goto('/einstellungen');
    await expect(page.getByTestId('settings-training-card')).toBeVisible();
    await page.getByTestId('settings-link-training').click();
    await expect(page).toHaveURL(/\/einstellungen\/training$/);
    await expect(page.getByTestId('training-admin-demo')).toBeVisible();
    await expect(page.getByTestId('training-not-available')).toHaveCount(0);

    // Fortschritt der Trainee aus E–G: Pfad abgeschlossen, 3/3.
    const rentalRow = adminUserRow(page, rentalId);
    await expect(rentalRow).toBeVisible();
    const rentalAssignment = rentalRow.locator(
      '[data-testid="training-admin-assignment"][data-path="rental_basics"]',
    );
    await expect(rentalAssignment).toHaveAttribute('data-status', 'completed');
    await expect(rentalAssignment.getByTestId('training-admin-progress')).toContainText('3/3');
    await expect(
      rentalAssignment.locator('[data-testid="training-admin-item"][data-key="offer_send"]'),
    ).toHaveAttribute('data-state', 'passed');

    // Zuweisung über die UI (Order §119).
    await page.getByTestId('training-assign-user').selectOption(tourId);
    await page.getByTestId('training-assign-path').selectOption('delivery_tour');
    await page.getByTestId('training-assign').click();
    await expect(page.getByTestId('training-admin-notice')).toContainText('zugewiesen');
    await expect(page.getByTestId('training-assign-error')).toHaveCount(0);
    const tourRow = adminUserRow(page, tourId);
    const tourAssignment = tourRow.locator(
      '[data-testid="training-admin-assignment"][data-path="delivery_tour"]',
    );
    await expect(tourAssignment).toHaveAttribute('data-status', 'assigned');
    await expect(tourAssignment.getByTestId('training-admin-progress')).toContainText('0/1');

    // Trainee: Übung starten und ohne Erfüllung prüfen ⇒ failed_check_count + 1 (Order §44/§80).
    const tourPage = await traineePage(browser, tourTrainee);
    await openTraining(tourPage);
    await expect(assignmentCard(tourPage, 'delivery_tour')).toBeVisible();
    const attemptId = await startExerciseViaUi(tourPage, tourId, 'tour_complete');
    const checkResult = await checkExerciseViaUi(tourPage, 'tour_complete');
    await expect(checkResult).toHaveAttribute('data-passed', 'false');
    await expect(checkResult).toHaveText(
      `${STEP_NOT_COMPLETED_PREFIX}Tour planen oder als bereit markieren‘.`,
    );
    expect(attemptsOf(tourId, 'tour_complete')[0]).toMatchObject({
      id: attemptId,
      status: 'in_progress',
      failed_check_count: 1,
    });

    // Admin: Fehlprüfung sichtbar, Ereignis nur mit Zeitpunkt/Training/Schritt/Hinweis (Order §54).
    await page.reload();
    await expect(page.getByTestId('training-admin-demo')).toBeVisible();
    await expect(
      adminUserRow(page, tourId).getByTestId('training-admin-failed-checks'),
    ).toContainText('1');
    await adminUserRow(page, tourId).getByTestId('training-admin-user-toggle').click();
    const detail = page.locator(`[data-testid="training-admin-user"][data-user="${tourId}"]`);
    await expect(detail).toBeVisible();
    const attemptRowUi = detail.locator(
      '[data-testid="training-admin-attempt"][data-definition="tour_complete"]',
    );
    await expect(attemptRowUi).toHaveAttribute('data-status', 'in_progress');
    const failedEvent = detail.locator(
      '[data-testid="training-admin-event"][data-error="STEP_NOT_COMPLETED"]',
    );
    await expect(failedEvent.first()).toBeVisible();
    await expect(failedEvent.first()).toContainText('Schritt nicht abgeschlossen');
    const detailText = await detail.innerText();
    expect(detailText).not.toMatch(/MR-\d{4}-\d{4}|@example|€|Lieferweg|Beispiel|Demo Kunde/);
    expect(detailText).not.toContain('STEP_NOT_COMPLETED');

    // Training-Reset des Pfads über die UI (Order §48): Versuch unterbrochen, Historie bleibt.
    await page.getByTestId('training-reset-user').selectOption(tourId);
    await page.getByTestId('training-reset-scope-path').check();
    await page.getByTestId('training-reset-path').selectOption('delivery_tour');
    await page.getByTestId('training-reset').click();
    await expect(page.getByTestId('training-reset-dialog')).toBeVisible();
    await page.getByTestId('training-reset-confirm').click();
    await expect(page.getByTestId('training-admin-notice')).toContainText('zurückgesetzt');
    await expect(page.getByTestId('training-reset-error')).toHaveCount(0);
    const afterReset = attemptsOf(tourId, 'tour_complete');
    expect(afterReset).toHaveLength(1);
    expect(afterReset[0]).toMatchObject({
      id: attemptId,
      status: 'interrupted',
      interruption_code: 'TRAINING_RESET',
      failed_check_count: 1,
    });
    expect(
      demoDb<{ round: number; status: string }>(
        `SELECT a.round, a.status FROM training_assignments a JOIN training_paths p ON p.id = a.path_id
          WHERE a.user_id = $1 AND p.key = 'delivery_tour'`,
        [tourId],
      )[0],
    ).toMatchObject({ round: 2, status: 'assigned' });
    expect(
      demoDb(
        `SELECT id FROM staff_security_events WHERE type = 'training.assignment_reset' AND actor_user_id = $1`,
        [adminId],
      ).length,
    ).toBeGreaterThan(0);

    // Trainee sieht die Unterbrechung und startet neu (neuer Versuch, alter bleibt Historie).
    await openTraining(tourPage);
    const card = exerciseCard(tourPage, 'tour_complete');
    await expect(card.getByTestId('training-interrupted')).toContainText('Training-Reset');
    await expect(card.getByTestId('training-start')).toBeVisible();
    await expect(
      assignmentCard(tourPage, 'delivery_tour').getByTestId('training-assignment-progress'),
    ).toContainText('Runde 2');
    const secondAttemptId = await startExerciseViaUi(tourPage, tourId, 'tour_complete');
    expect(secondAttemptId).not.toBe(attemptId);
    expect(attemptsOf(tourId, 'tour_complete')).toHaveLength(2);
  });

  test('H Tour Training: eigene Tour mit heutigem Liefertermin anlegen → „Bereit“ → starten → beenden (Planer mit Grund) ⇒ bestanden; Routing nur Mock, kein Request am Provider-Fake', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const trainee = TRAINEES.tour;
    const userId = traineeId(trainee);
    const page = await traineePage(browser, trainee);
    await resetRoutingFake();

    // Liefertermin HEUTE relativ zu jetzt (Sperrfenster 23:38–00:02 Uhr Berlin, s. Kopfkommentar).
    const window = todayWindow(60, 120);
    const seeded = seedTours(
      {
        adminEmail: DEMO_ADMIN_EMAIL,
        bookings: [
          {
            key: 'h1',
            customer: { firstName: 'Hanna', lastName: 'Heute' },
            outbound: { startAt: window.startAt.toISOString(), endAt: window.endAt.toISOString() },
          },
        ],
      },
      DEMO_DATABASE_URL,
    );
    const appointmentId = seeded.bookings.h1!.outbound.id;

    await openTraining(page);
    const card = exerciseCard(page, 'tour_complete');
    if ((await card.getByTestId('training-start').count()) > 0) {
      await startExerciseViaUi(page, userId, 'tour_complete');
    }
    const running = attemptsOf(userId, 'tour_complete').filter(
      (row) => row.status === 'in_progress',
    );
    expect(running).toHaveLength(1);
    const attemptId = running[0]!.id;
    await expect(card.getByTestId('training-demo-link')).toHaveAttribute(
      'href',
      `/touren/${seedEntityId('tour.today.multi_stop')}`,
    );

    // Eigene Tour: Fahrer = Trainee, Stopp aus „Verfügbare Stopps“.
    await page.goto('/touren/neu');
    await expect(page.getByTestId('tour-new-form')).toBeVisible();
    await page.getByTestId('tour-new-driver').selectOption(userId);
    await page.getByTestId('tour-new-submit').click();
    await page.waitForURL(/\/touren\/[0-9a-f-]{36}$/);
    const tourId = /\/touren\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
    await expect(page.getByTestId('tour-header')).toBeVisible();
    await page.getByTestId(`candidate-add-${appointmentId}`).click();
    await expect(
      page.locator(`[data-testid^="tour-stop-"][data-appointment-id="${appointmentId}"]`),
    ).toBeVisible();
    await page.getByTestId('tour-ready').click();
    await expect
      .poll(
        () =>
          demoDb<{ status: string }>('SELECT status FROM tours WHERE id = $1', [tourId])[0]?.status,
        { timeout: 30_000 },
      )
      .toBe('ready');

    // Bewusster Start (Bestätigung) ⇒ aktive Tour.
    await expect(page.getByTestId('tour-start')).toBeVisible();
    await page.getByTestId('tour-start').click();
    await expect(page.getByTestId('start-dialog')).toBeVisible();
    await page.getByTestId('start-confirm').click();
    await page.waitForURL(new RegExp(`/touren/aktiv\\?id=${tourId}`));
    await expect(page.getByTestId('active-tour-page')).toBeVisible();
    expect(
      demoDb<{ status: string }>('SELECT status FROM tours WHERE id = $1', [tourId])[0],
    ).toMatchObject({ status: 'active' });

    // Beenden mit offenem Stopp: Planer (calendar.manage) mit Pflichtgrund (Order §77: GPS/Stopps nicht Pflicht).
    await page.getByTestId('tour-end').click();
    await page.getByTestId('end-confirm').click();
    await expect(page.getByTestId('active-tour-error')).toHaveText(
      'Die Tour enthält noch offene Stopps.',
    );
    await expect(page.getByTestId('force-end-dialog')).toBeVisible();
    await page.getByTestId('tour-end-reason').fill('Übung beendet – Demo-Tour ohne Lieferung');
    await page.getByTestId('force-end-confirm').click();
    await expect(page.getByTestId('active-tour-notice')).toContainText('Tour beendet.');
    expect(
      demoDb<{ status: string; ended_at: string | null }>(
        'SELECT status, ended_at FROM tours WHERE id = $1',
        [tourId],
      )[0],
    ).toMatchObject({ status: 'completed' });

    await expectExercisePassedViaUi(page, 'tour_complete');
    await expect(assignmentCard(page, 'delivery_tour')).toHaveAttribute('data-status', 'completed');
    expect(attemptsOf(userId, 'tour_complete')[0]).toMatchObject({
      id: attemptId,
      status: 'passed',
    });
    expect(attemptEvents(attemptId).map((event) => [event.event_key, event.result])).toEqual([
      ['tour.ready', 'accepted'],
      ['tour.started', 'accepted'],
      ['tour.completed', 'accepted'],
    ]);
    // Demo-Routing: nie ein Provider-Aufruf (Order §27).
    expect(await routingRequests()).toHaveLength(0);
  });

  test('I Communication Training: E-Mail-Antwort an die Whitelist-Adresse eines neuen Kunden ⇒ eingereiht zählt nicht („Übung prüfen“ offen) ⇒ Job mail.send ⇒ Zustellung „[DEMO] …“ ⇒ bestanden', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const trainee = TRAINEES.contact;
    const userId = traineeId(trainee);
    await clearSink();

    // Admin legt Kunde (Whitelist-Domain) + Vorgang an – der Trainee antwortet.
    const customer = await demoApi<{ customer: { id: string } }>('POST', '/staff/customers', {
      cookie: adminCookie,
      body: { type: 'private', firstName: 'Kai', lastName: 'Kunde', email: CONTACT_CUSTOMER_EMAIL },
    });
    expect(customer.status, customer.text).toBe(200);
    const process = await demoApi<{ process: { id: string; processNumber: string } }>(
      'POST',
      '/staff/processes',
      { cookie: adminCookie, body: { customerId: customer.data.customer.id } },
    );
    expect(process.status, process.text).toBe(200);
    contactProcess = {
      customerId: customer.data.customer.id,
      processId: process.data.process.id,
      processNumber: process.data.process.processNumber,
    };

    const page = await traineePage(browser, trainee);
    await openTraining(page);
    await expect(assignmentCard(page, 'communication')).toBeVisible();
    const attemptId = await startExerciseViaUi(page, userId, 'communication_reply');
    const card = exerciseCard(page, 'communication_reply');
    await expect(card.getByTestId('training-demo-link')).toHaveAttribute('href', /^\/vorgaenge/);

    await page.goto(`/vorgaenge/${contactProcess.processId}/kommunikation`);
    await expect(page.getByTestId('reply-form')).toBeVisible();
    const emailChannel = page.getByTestId('reply-channel-email');
    if ((await emailChannel.count()) > 0) await emailChannel.check();
    await page
      .getByTestId('reply-body')
      .fill('Vielen Dank für Ihre Nachricht – wir melden uns mit allen Details. (Demo-Übung)');
    await page.getByTestId('reply-submit').click();
    await expect(page.getByTestId('reply-success')).toBeVisible();
    await expect(page.getByTestId('reply-error')).toHaveCount(0);
    const outbound = demoDb<{
      id: string;
      delivery_state: string;
      mail_delivery_id: string | null;
    }>(
      `SELECT id, delivery_state, mail_delivery_id FROM conversation_messages
        WHERE process_id = $1 AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1`,
      [contactProcess.processId],
    );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.delivery_state).toBe('queued');

    // Eingereiht ≠ gesendet (Order §42): Prüfung bleibt offen.
    await openTraining(page);
    const checkResult = await checkExerciseViaUi(page, 'communication_reply');
    await expect(checkResult).toHaveAttribute('data-passed', 'false');
    expect(attemptsOf(userId, 'communication_reply')[0]).toMatchObject({
      id: attemptId,
      status: 'in_progress',
      failed_check_count: 1,
    });

    // Job mail.send ⇒ echte Zustellung an die Senke (Whitelist), Betreff „[DEMO] …“.
    await runDemoJobs(adminCookie);
    const mail = await waitForMail({
      to: CONTACT_CUSTOMER_EMAIL,
      subject: `[DEMO] Nachricht von Miet-Royal – Vorgang ${contactProcess.processNumber}`,
    });
    expect(mail.text).toContain('Demo-Übung');
    await expect
      .poll(
        () =>
          demoDb<{ delivery_state: string }>(
            'SELECT delivery_state FROM conversation_messages WHERE id = $1',
            [outbound[0]!.id],
          )[0]?.delivery_state,
      )
      .toBe('sent');
    await expectExercisePassedViaUi(page, 'communication_reply');
    expect(attemptsOf(userId, 'communication_reply')[0]).toMatchObject({
      id: attemptId,
      status: 'passed',
    });
    expect(
      attemptEvents(attemptId).filter((event) => event.event_key === 'communication.reply_sent'),
    ).toEqual([
      expect.objectContaining({ event_key: 'communication.reply_sent', result: 'accepted' }),
    ]);
  });

  test('F7 Freie Übung ohne Zuweisung (Review-Fix F7): Mitarbeiterin ohne Pfad startet „Kundenkommunikation beantworten“ unter „Weitere Übungen“, beantwortet die unbeantwortete Seed-Nachricht (Demo-Testadresse) per E-Mail ⇒ Job mail.send ⇒ Senke „[DEMO] …“ ⇒ bestanden; nach Reload Karte „erledigt“ mit „Bestanden am“, ohne „Übung starten“, genau ein Versuch', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const trainee = TRAINEES.free;
    const userId = traineeId(trainee);
    await clearSink();
    // Seed-Szenario der Übung (Registry): unbeantwortete E-Mail von Lena Beispiel zu process.inquiry.new.
    const processId = seedEntityId('process.inquiry.new');
    const unansweredId = seedEntityId('conversation.email.unanswered');
    expect(
      demoDb<{ process_id: string; direction: string; channel: string }>(
        'SELECT process_id, direction, channel FROM conversation_messages WHERE id = $1',
        [unansweredId],
      )[0],
    ).toMatchObject({ process_id: processId, direction: 'inbound', channel: 'email' });
    const recipient = customerEmailOfProcess(processId);
    expect(recipient).toBe(UNANSWERED_CUSTOMER_EMAIL);
    expect(demoDb('SELECT id FROM training_assignments WHERE user_id = $1', [userId])).toHaveLength(
      0,
    );

    const page = await traineePage(browser, trainee);
    await openTraining(page);
    await expect(page.getByTestId('training-no-assignments')).toBeVisible();
    await expect(page.getByTestId('training-assignment')).toHaveCount(0);
    const freeSection = page.getByTestId('training-free-exercises');
    await expect(freeSection).toBeVisible();
    const card = freeSection.locator(
      '[data-testid="training-exercise"][data-key="communication_reply"]',
    );
    await expect(card).toHaveAttribute('data-state', 'open');
    await expect(card.getByTestId('training-exercise-passed')).toHaveCount(0);
    await expect(card.getByTestId('training-start')).toBeVisible();
    const attemptId = await startExerciseViaUi(page, userId, 'communication_reply');
    await expect(card).toHaveAttribute('data-state', 'in_progress');
    await expect(card.getByTestId('training-demo-link')).toHaveAttribute('href', /^\/vorgaenge/);

    await page.goto(`/vorgaenge/${processId}/kommunikation`);
    await expect(page.getByTestId('reply-form')).toBeVisible();
    const emailChannel = page.getByTestId('reply-channel-email');
    if ((await emailChannel.count()) > 0) await emailChannel.check();
    await page
      .getByTestId('reply-body')
      .fill(
        'Hallo Frau Beispiel, eine Abholung am Donnerstagabend ist möglich – die Maschine passt in einen Kleinwagen. (Demo-Übung, freie Übung)',
      );
    await page.getByTestId('reply-submit').click();
    await expect(page.getByTestId('reply-success')).toBeVisible();
    await expect(page.getByTestId('reply-error')).toHaveCount(0);
    const outbound = demoDb<{ id: string; delivery_state: string }>(
      `SELECT id, delivery_state FROM conversation_messages
        WHERE process_id = $1 AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1`,
      [processId],
    );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.delivery_state).toBe('queued');

    // Job mail.send ⇒ Zustellung an die Demo-Testadresse (Whitelist-Domain), Betreff „[DEMO] …“.
    await runDemoJobs(adminCookie);
    const mail = await waitForMail({
      to: recipient,
      subject: `[DEMO] Nachricht von Miet-Royal – Vorgang ${processNumberOf(processId)}`,
    });
    expect(mail.text).toContain('freie Übung');
    await expect
      .poll(
        () =>
          demoDb<{ delivery_state: string }>(
            'SELECT delivery_state FROM conversation_messages WHERE id = $1',
            [outbound[0]!.id],
          )[0]?.delivery_state,
      )
      .toBe('sent');

    // Review-Fix F7: der Serverzustand (`/me.definitions[]`) ist maßgeblich – auch nach einem
    // weiteren Reload bleibt die freie Übung „erledigt“ (kein „Übung starten“, kein zweiter Versuch).
    await expectExercisePassedViaUi(page, 'communication_reply');
    await page.reload();
    await expect(page.getByTestId('training-page')).toBeVisible();
    const passedCard = page
      .getByTestId('training-free-exercises')
      .locator('[data-testid="training-exercise"][data-key="communication_reply"]');
    await expect(passedCard).toHaveAttribute('data-state', 'passed');
    await expect(passedCard.getByTestId('training-exercise-state')).toHaveText('erledigt');
    await expect(passedCard.getByTestId('training-exercise-passed')).toContainText('Bestanden am');
    await expect(passedCard.getByTestId('training-start')).toHaveCount(0);
    await expect(passedCard.getByTestId('training-check')).toHaveCount(0);
    await expect(passedCard.getByTestId('training-interrupted')).toHaveCount(0);
    await expect(page.getByTestId('training-assignment')).toHaveCount(0);
    const me = await browserApi<{ definitions: TrainingMeDefinition[] }>(
      page,
      'GET',
      '/staff/training/me',
    );
    expect(me.status).toBe(200);
    const definition = me.data.definitions.find((entry) => entry.key === 'communication_reply');
    expect(definition).toMatchObject({ state: 'passed', permissionMissing: false });
    expect(definition!.passedAt).not.toBeNull();
    expect(definition!.attempt).toMatchObject({ id: attemptId, status: 'passed' });
    const attempts = attemptsOf(userId, 'communication_reply');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ id: attemptId, status: 'passed', failed_check_count: 0 });
    expect(attempts[0]!.completed_at).not.toBeNull();
    expect(
      attemptEvents(attemptId).filter((event) => event.event_key === 'communication.reply_sent'),
    ).toEqual([
      expect.objectContaining({ event_key: 'communication.reply_sent', result: 'accepted' }),
    ]);
    expect(demoDb('SELECT id FROM training_assignments WHERE user_id = $1', [userId])).toHaveLength(
      0,
    );
  });

  test('J Settlement Training ohne Lexware-Erfolg: offene Klärungen (Schaden, Fehlteil) entscheiden ⇒ „Bereit zur Buchhaltung“ mit Demo-Hinweis, kein „Jetzt an Buchhaltung übertragen“, keine Mock-Karte ⇒ bestanden; keine Übertragung, auch nicht nach Jobs', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const trainee = TRAINEES.review;
    const userId = traineeId(trainee);
    const page = await traineePage(browser, trainee);
    const processId = seedEntityId('process.settlement.review');
    const settlementId = seedEntityId('settlement.review');

    await openTraining(page);
    await expect(assignmentCard(page, 'settlement')).toBeVisible();
    const attemptId = await startExerciseViaUi(page, userId, 'settlement_review');
    const card = exerciseCard(page, 'settlement_review');
    await expect(card.getByTestId('training-demo-link')).toHaveAttribute(
      'href',
      `/vorgaenge/${processId}`,
    );
    await expect(card).toContainText('in der Demo gibt es keine Buchhaltungsübertragung');

    await page.goto(`/vorgaenge/${processId}/abrechnung`);
    await expect(page.getByTestId('settlement-page')).toBeVisible();
    const status = page.getByTestId('settlement-status');
    await expect(status).toContainText('Klärung erforderlich');
    const items = page.getByTestId('clarification-item');
    await expect(items).toHaveCount(2);
    await expect(page.getByTestId('clarifications')).toContainText('Schadenkosten');
    await expect(page.getByTestId('clarifications')).toContainText('Fehlteil');
    // Klärungen entscheiden („Nicht berechnen“) – ohne Belastung ist keine Kundeninformation nötig.
    for (let remaining = 2; remaining > 0; remaining -= 1) {
      await items.first().getByTestId('clarification-no-charge').click();
      await expect(page.getByText('Nicht berechnet – Klärung erledigt.')).toBeVisible();
      await expect(items).toHaveCount(remaining - 1);
    }
    await expect(status).toContainText('Bereit zur Buchhaltung');
    const demoHint = page.getByTestId('settlement-demo-unavailable');
    await expect(demoHint.first()).toBeVisible();
    await expect(demoHint.first()).toHaveText(SETTLEMENT_DEMO_UNAVAILABLE_TEXT);
    await expect(page.getByTestId('settlement-dominant-action')).toContainText(
      'Bereit zur Buchhaltung',
    );
    await expect(page.getByTestId('transfer-now')).toHaveCount(0);
    await expect(page.getByTestId('mock-controls')).toHaveCount(0);
    await expect(page.getByTestId('mock-badge')).toHaveCount(0);
    await expect(page.getByText('Nicht verfügbar (Demo)').first()).toBeVisible();

    await expectExercisePassedViaUi(page, 'settlement_review');
    expect(attemptsOf(userId, 'settlement_review')[0]).toMatchObject({
      id: attemptId,
      status: 'passed',
    });
    expect(attemptEvents(attemptId).map((event) => [event.event_key, event.result])).toEqual([
      ['settlement.reviewed', 'accepted'],
    ]);

    // W1/§79: kein Lexware-Erfolg, kein Transfer – auch nicht nach fälligen Jobs.
    const expectNoTransfer = () => {
      expect(
        demoDb<{
          status: string;
          accounting_transfer_id: string | null;
          transferred_at: string | null;
        }>('SELECT status, accounting_transfer_id, transferred_at FROM settlements WHERE id = $1', [
          settlementId,
        ])[0],
      ).toMatchObject({
        status: 'ready_for_accounting',
        accounting_transfer_id: null,
        transferred_at: null,
      });
      expect(demoDb('SELECT id FROM accounting_transfers')).toHaveLength(0);
      expect(
        demoDb(`SELECT id FROM integration_jobs WHERE type = 'settlement.accounting_transfer'`),
      ).toHaveLength(0);
    };
    expectNoTransfer();
    await runDemoJobs(adminCookie);
    expectNoTransfer();
    expect(
      demoDb<{ main_status: string }>('SELECT main_status FROM processes WHERE id = $1', [
        processId,
      ])[0]!.main_status,
    ).not.toBe('completed');
  });

  test('O Definition Update Stability: Katalog-Variante (offer_send Version 2, neuer Titel) ⇒ bestandene Übung bleibt bestanden, Training und Katalog zeigen die neue Version; danach normaler Katalog wiederhergestellt', async ({
    browser,
    page,
  }) => {
    test.setTimeout(240_000);
    const trainee = TRAINEES.rental;
    const userId = traineeId(trainee);
    const traineeView = await traineePage(browser, trainee);
    const before = attemptsOf(userId, 'offer_send').find((row) => row.status === 'passed');
    expect(before, 'bestandener Versuch aus E').toBeDefined();

    const bumped = syncTrainingCatalog('bump', 'offer_send');
    expect(bumped).toMatchObject({ mode: 'bump', key: 'offer_send', version: 2 });
    try {
      const me = await browserApi<{
        definitions: { key: string; version: number; title: string; state: string }[];
      }>(traineeView, 'GET', '/staff/training/me');
      expect(me.status).toBe(200);
      const definition = me.data.definitions.find((entry) => entry.key === 'offer_send')!;
      expect(definition).toMatchObject({ version: 2, title: bumped.title, state: 'passed' });
      await expectExercisePassedViaUi(traineeView, 'offer_send');
      await expect(exerciseCard(traineeView, 'offer_send')).toContainText(bumped.title);
      const after = attemptsOf(userId, 'offer_send').find((row) => row.id === before!.id)!;
      expect(after).toMatchObject({
        status: 'passed',
        completed_at: before!.completed_at,
        definition_version: before!.definition_version,
        superseded_at: null,
      });

      await loginDemoAdmin(page);
      await page.goto('/einstellungen/training');
      await expect(page.getByTestId('training-admin-catalog')).toBeVisible();
      const catalogEntry = page.locator(
        '[data-testid="training-catalog-definition"][data-key="offer_send"]',
      );
      await expect(catalogEntry.first()).toHaveAttribute('data-version', '2');
      await expect(catalogEntry.first()).toHaveAttribute('data-active', 'true');
      await expect(
        adminUserRow(page, userId).locator(
          '[data-testid="training-admin-item"][data-key="offer_send"]',
        ),
      ).toHaveAttribute('data-state', 'passed');
    } finally {
      expect(syncTrainingCatalog('restore', 'offer_send')).toMatchObject({
        mode: 'restore',
        version: 1,
      });
    }
    const restored = await browserApi<{
      definitions: { key: string; version: number; state: string }[];
    }>(traineeView, 'GET', '/staff/training/me');
    expect(restored.data.definitions.find((entry) => entry.key === 'offer_send')).toMatchObject({
      version: 1,
      state: 'passed',
    });
    await page.reload();
    await expect(
      page.locator('[data-testid="training-catalog-definition"][data-key="offer_send"]').first(),
    ).toHaveAttribute('data-version', '1');
  });

  test('P Demo Provider Isolation: Accounting disabled (Status, Lexware-Webhook 404, Mock-Steuerung 409), WhatsApp nur Mock (mock-ID, kein Graph-Request), Routing Mock ohne Provider-Request, Mail außerhalb der Whitelist blockiert mit „[DEMO]“, keine Secrets', async () => {
    test.setTimeout(180_000);
    expect(contactProcess, 'Vorgang aus Szenario I').not.toBeNull();

    // Accounting/Lexware (Order W1/§29, §101 Nr. 14/15).
    const accounting = await demoApi<Record<string, unknown>>('GET', '/staff/accounting/status', {
      cookie: adminCookie,
    });
    expect(accounting.status).toBe(200);
    expect(accounting.data).toMatchObject({
      provider: 'disabled',
      configured: false,
      mock: false,
      mockControlsAvailable: false,
      environment: 'demo',
    });
    for (const method of ['GET', 'POST'] as const) {
      const webhook = await fetch(`${DEMO_API_ORIGIN}/webhooks/lexware`, {
        method,
        headers: { connection: 'close', 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(webhook.status, `${method} /webhooks/lexware`).toBe(404);
    }
    const mockControl = await demoApi('POST', '/staff/accounting/mock/payment-status', {
      cookie: adminCookie,
      body: { status: 'paid' },
    });
    expect(mockControl.status).toBe(409);

    // WhatsApp: nur MockWhatsAppGateway, kein Meta-Zugriff (Order §26).
    const communication = await demoApi<{
      whatsapp: { mode: string; label: string | null };
      push: { enabled: boolean };
    }>('GET', '/staff/communication/status', { cookie: adminCookie });
    expect(communication.status).toBe(200);
    expect(communication.data.whatsapp).toMatchObject({ mode: 'mock', label: 'DEMO / simuliert' });
    for (const secret of [
      DEMO_AUTH_SECRET_KEY,
      DEMO_COMMUNICATION_PAYLOAD_KEY,
      SMTP_SINK_PASSWORD,
    ]) {
      expect(communication.text.includes(secret)).toBe(false);
      expect(accounting.text.includes(secret)).toBe(false);
    }
    const { customerId, processId } = contactProcess!;
    demoDb(
      `INSERT INTO conversation_messages (process_id, customer_id, channel, direction,
         sender_snapshot, body, provider_message_id, delivery_state, received_at)
       VALUES ($1, $2, 'whatsapp', 'inbound', $3::jsonb, 'Hallo (Demo-Fixture)', $4, 'received', now())`,
      [
        processId,
        customerId,
        JSON.stringify({ name: 'Demo Kunde', phone: DEMO_WA_ID }),
        `wamid.DEMOFIXTURE${Date.now()}`,
      ],
    );
    demoDb(
      `INSERT INTO whatsapp_contacts (wa_id, customer_id, last_inbound_at, profile_name)
       VALUES ($1, $2, now(), 'Demo Kunde')
       ON CONFLICT (wa_id) DO UPDATE SET last_inbound_at = now()`,
      [DEMO_WA_ID, customerId],
    );
    await clearWhatsAppFake();
    const reply = await demoApi<{ messageId: string }>(
      'POST',
      `/staff/processes/${processId}/conversation/reply`,
      {
        cookie: adminCookie,
        body: { channel: 'whatsapp', body: 'Antwort aus der Demo (simuliert).' },
      },
    );
    expect(reply.status, reply.text).toBe(201);
    await runDemoJobs(adminCookie);
    const outbound = demoDb<{ delivery_state: string; provider_message_id: string | null }>(
      'SELECT delivery_state, provider_message_id FROM conversation_messages WHERE id = $1',
      [reply.data.messageId],
    );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.delivery_state).toBe('sent');
    expect(outbound[0]!.provider_message_id).toMatch(/^mock-/);
    expect(await whatsappRequests()).toEqual([]);

    // Routing: Mock-Provider, kein Request am GraphHopper-Fake (Order §27).
    const tour = await demoApi<{ tour: { routeProvider: string | null; planningStatus: string } }>(
      'GET',
      `/staff/tours/${seedEntityId('tour.future.planned')}`,
      { cookie: adminCookie },
    );
    expect(tour.status).toBe(200);
    expect(tour.data.tour.routeProvider).toBe('mock');
    expect(JSON.stringify(tour.data)).not.toMatch(/key=|apiKey|GRAPHHOPPER/i);
    expect(await routingRequests()).toHaveLength(0);

    // Mail außerhalb der Whitelist: blocked, Betreff „[DEMO] …“, nichts in der Senke (Order §25).
    // Seit Review-Fix F8 tragen die fünf Mail-Übungskunden die Demo-Testadresse; der Kunde von
    // `process.offer.sent` (Hannah Testerin) bleibt bewusst auf der Beispieldomain.
    for (const [seedKey, email] of [
      ['process.inquiry.new', UNANSWERED_CUSTOMER_EMAIL],
      ['process.offer.draft', OFFER_CUSTOMER_EMAIL],
      ['process.settlement.review', SETTLEMENT_CUSTOMER_EMAIL],
    ] as const) {
      expect(customerEmailOfProcess(seedEntityId(seedKey)), seedKey).toBe(email);
    }
    const blockedProcessId = seedEntityId('process.offer.sent');
    const blockedRecipient = customerEmailOfProcess(blockedProcessId);
    expect(blockedRecipient).toMatch(/@example\.(com|invalid)$/);
    expect(blockedRecipient.toLowerCase().endsWith(DEMO_MAIL_WHITELIST)).toBe(false);
    const blocked = await demoApi<{ deliveryState: string; mailDeliveryId: string }>(
      'POST',
      `/staff/processes/${blockedProcessId}/conversation/reply`,
      {
        cookie: adminCookie,
        body: { channel: 'email', body: 'Antwort (darf nicht zugestellt werden).' },
      },
    );
    expect(blocked.status, blocked.text).toBe(201);
    expect(blocked.data.deliveryState).toBe('blocked');
    await runDemoJobs(adminCookie);
    const blockedRow = demoDb<{ status: string; blocked_reason: string | null; subject: string }>(
      'SELECT status, blocked_reason, subject FROM mail_deliveries WHERE id = $1',
      [blocked.data.mailDeliveryId],
    )[0]!;
    expect(blockedRow).toMatchObject({ status: 'blocked', blocked_reason: 'DEMO_NOT_WHITELISTED' });
    expect(blockedRow.subject.startsWith('[DEMO] ')).toBe(true);
    await expectMailCount({ to: blockedRecipient }, 0);
  });

  test('J2 Settlement Training mit Belastung (Review-Fix F8): Schaden- und Fehlteilkosten festlegen ⇒ „Kundeninformation prüfen“ ⇒ „Freigeben und senden“ (eingereiht, „Übung prüfen“ noch offen) ⇒ Job mail.send ⇒ Senke „[DEMO] …“ an die Demo-Testadresse ⇒ „Kundenrückmeldung abwarten“ ⇒ „Jetzt freigeben“ ⇒ „Bereit zur Buchhaltung“ mit Demo-Hinweis ⇒ bestanden (Ereignis nur beim Übergang); keine Übertragung, auch nicht nach Jobs', async ({
    browser,
  }) => {
    test.setTimeout(360_000);
    const trainee = TRAINEES.release;
    const userId = traineeId(trainee);
    // J hat das Seed-Szenario verbraucht: frischer Seed per API (Staff-/Trainingsdaten bleiben,
    // Order §18; der Vorgang aus I/P wird dabei gelöscht – P ist bereits gelaufen, D setzt erneut zurück).
    await resetDemoViaApi(adminCookie);
    await clearSink();
    const processId = seedEntityId('process.settlement.review');
    const settlementId = seedEntityId('settlement.review');
    const processNumber = processNumberOf(processId);
    const recipient = customerEmailOfProcess(processId);
    expect(recipient).toBe(SETTLEMENT_CUSTOMER_EMAIL);
    expect(settlementRow(settlementId)).toMatchObject({
      status: 'clarification_required',
      accounting_transfer_id: null,
    });

    const page = await traineePage(browser, trainee);
    await openTraining(page);
    await expect(assignmentCard(page, 'settlement')).toBeVisible();
    const attemptId = await startExerciseViaUi(page, userId, 'settlement_review');
    const card = exerciseCard(page, 'settlement_review');
    await expect(card.getByTestId('training-demo-link')).toHaveAttribute(
      'href',
      `/vorgaenge/${processId}`,
    );
    await expect(card).toContainText('Freigeben und senden');

    await page.goto(`/vorgaenge/${processId}/abrechnung`);
    await expect(page.getByTestId('settlement-page')).toBeVisible();
    const status = page.getByTestId('settlement-status');
    await expect(status).toContainText('Klärung erforderlich');
    await expect(page.getByTestId('clarification-item')).toHaveCount(2);
    // Belastungen festlegen (damage.set_cost / missing_item.set_cost): 50,00 € + 15,00 €.
    const chargeable = (label: string) =>
      page
        .getByTestId('clarification-item')
        .filter({ hasText: label })
        .filter({ has: page.getByTestId('clarification-charge') });
    await chargeable('Schadenkosten').getByTestId('clarification-charge-amount').fill('50,00');
    await chargeable('Schadenkosten').getByTestId('clarification-charge').click();
    await expect(page.getByTestId('settlement-line-damage_charge')).toContainText('50,00');
    await chargeable('Fehlteil').getByTestId('clarification-charge-amount').fill('15,00');
    await chargeable('Fehlteil').getByTestId('clarification-charge').click();
    await expect(page.getByTestId('settlement-line-missing_item_charge')).toContainText('15,00');
    // Offen bleibt nur die Kundeninformation (Order §69) – ohne Betragseingabe.
    await expect(status).toContainText('Kundeninformation erforderlich');
    await expect(page.getByTestId('clarification-item')).toHaveCount(1);
    await expect(page.getByTestId('clarification-item')).toContainText('Kundeninformation');
    await expect(page.getByTestId('clarification-charge')).toHaveCount(0);
    await expect(page.getByTestId('transfer-now')).toHaveCount(0);

    // „Kundeninformation prüfen“ ⇒ EINE kombinierte Information ⇒ „Freigeben und senden“
    // (settlement.release). Whitelist-Domain (Review-Fix F8): eingereiht statt blockiert; das
    // Wartefenster beginnt erst mit bestätigtem Mailversand (Order §12).
    await page.getByTestId('notice-review').click();
    const preview = page.getByTestId('notice-preview');
    await expect(preview).toBeVisible();
    await expect(preview.getByTestId('notice-body')).toContainText(processNumber);
    await expect(preview.getByTestId('notice-body')).toContainText('50,00');
    await expect(preview.getByTestId('notice-body')).toContainText('15,00');
    await expect(preview.getByTestId('notice-total')).toContainText('65,00');
    await expect(page.getByTestId('notice-send')).toHaveText('Freigeben und senden');
    await page.getByTestId('notice-send').click();
    await expect(page.getByText(NOTICE_QUEUED_TEXT)).toBeVisible();
    await expect(page.getByTestId('notice-send')).toHaveCount(0);
    await expect(status).not.toContainText('Kundenrückmeldung abwarten');
    await expect(page.getByTestId('settlement-wait-hint')).toHaveCount(0);
    const notices = mailDeliveriesOf(processId, 'settlement_damage_missing_notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      status: 'pending',
      blocked_reason: null,
      recipient_email: recipient,
      sent_at: null,
    });
    const noticeSubject = notices[0]!.subject;
    expect(noticeSubject.startsWith('[DEMO] ')).toBe(true);
    expect(noticeSubject).toContain(`Rückgabe – Vorgang ${processNumber}`);
    expect(settlementRow(settlementId)).toMatchObject({ status: 'customer_notice_required' });
    await expectMailCount({ to: recipient, subject: noticeSubject }, 0);
    // Noch nicht „Bereit zur Buchhaltung“ ⇒ „Übung prüfen“ bleibt offen; kein Ereignis
    // `settlement.reviewed` vor dem Übergang (Review-Fix F4).
    await openTraining(page);
    const checkResult = await checkExerciseViaUi(page, 'settlement_review');
    await expect(checkResult).toHaveAttribute('data-passed', 'false');
    await expect(checkResult).toContainText(STEP_NOT_COMPLETED_PREFIX);
    await expect(checkResult).toContainText('Abrechnung prüfen bis');
    expect(attemptsOf(userId, 'settlement_review')[0]).toMatchObject({
      id: attemptId,
      status: 'in_progress',
      failed_check_count: 1,
    });
    expect(
      attemptEvents(attemptId).filter((event) => event.event_key === 'settlement.reviewed'),
    ).toEqual([]);

    // Job mail.send ⇒ Zustellung an die Senke (Betreff „[DEMO] …“) ⇒ Wartefenster läuft.
    await runDemoJobs(adminCookie);
    const noticeMail = await waitForMail({ to: recipient, subject: noticeSubject });
    expect(noticeMail.subject).toBe(noticeSubject);
    expect(noticeMail.text).toContain(processNumber);
    expect(noticeMail.text).toContain('50,00');
    expect(noticeMail.text).toContain('15,00');
    await expectMailCount({ to: recipient, subject: noticeSubject }, 1);
    const sentNotice = mailDeliveriesOf(processId, 'settlement_damage_missing_notice')[0]!;
    expect(sentNotice).toMatchObject({ id: notices[0]!.id, status: 'sent', blocked_reason: null });
    expect(sentNotice.sent_at).not.toBeNull();
    await expect.poll(() => settlementRow(settlementId).status).toBe('customer_waiting');

    // Wartefenster vorzeitig beenden („Jetzt freigeben“, settlement.end_pre_notice_wait) ⇒
    // „Bereit zur Buchhaltung“ mit Demo-Hinweis; keine Übertragung, keine Mock-Karte (W1/§79).
    await page.goto(`/vorgaenge/${processId}/abrechnung`);
    await expect(page.getByTestId('settlement-page')).toBeVisible();
    await expect(status).toContainText('Kundenrückmeldung abwarten');
    await expect(page.getByTestId('settlement-wait-hint')).toContainText(
      'Kundenrückmeldung abwarten',
    );
    await expect(page.getByTestId('notice-send')).toHaveCount(0);
    await expect(page.getByTestId('transfer-now')).toHaveCount(0);
    const endWait = page.getByTestId('end-wait-now');
    await expect(endWait).toHaveText('Jetzt freigeben');
    await endWait.click();
    await expect(page.getByTestId('end-wait-dialog')).toBeVisible();
    await page.getByTestId('end-wait-confirm').click();
    await expect(page.getByText('Warten beendet – Übertragung erfolgt manuell.')).toBeVisible();
    await expect(status).toContainText('Bereit zur Buchhaltung');
    const demoHint = page.getByTestId('settlement-demo-unavailable');
    await expect(demoHint.first()).toBeVisible();
    await expect(demoHint.first()).toHaveText(SETTLEMENT_DEMO_UNAVAILABLE_TEXT);
    await expect(page.getByTestId('settlement-dominant-action')).toContainText(
      'Bereit zur Buchhaltung',
    );
    await expect(page.getByTestId('end-wait-now')).toHaveCount(0);
    await expect(page.getByTestId('transfer-now')).toHaveCount(0);
    await expect(page.getByTestId('mock-controls')).toHaveCount(0);
    await expect(page.getByTestId('mock-badge')).toHaveCount(0);
    await expect(page.getByText('Nicht verfügbar (Demo)').first()).toBeVisible();

    await expectExercisePassedViaUi(page, 'settlement_review');
    await expect(assignmentCard(page, 'settlement')).toHaveAttribute('data-status', 'completed');
    expect(attemptsOf(userId, 'settlement_review')[0]).toMatchObject({
      id: attemptId,
      status: 'passed',
      failed_check_count: 1,
    });
    const events = attemptEvents(attemptId);
    expect(
      events.filter((event) => event.result === 'accepted').map((event) => event.event_key),
    ).toEqual(['settlement.reviewed']);
    expect(events.some((event) => event.error_code === 'STEP_NOT_COMPLETED')).toBe(true);

    const expectNoTransfer = () => {
      expect(settlementRow(settlementId)).toMatchObject({
        status: 'ready_for_accounting',
        accounting_transfer_id: null,
        transferred_at: null,
      });
      expect(demoDb('SELECT id FROM accounting_transfers')).toHaveLength(0);
      expect(
        demoDb(`SELECT id FROM integration_jobs WHERE type = 'settlement.accounting_transfer'`),
      ).toHaveLength(0);
    };
    expectNoTransfer();
    await runDemoJobs(adminCookie);
    expectNoTransfer();
    await expectMailCount({ to: recipient, subject: noticeSubject }, 1);
    expect(
      demoDb<{ main_status: string }>('SELECT main_status FROM processes WHERE id = $1', [
        processId,
      ])[0]!.main_status,
    ).not.toBe('completed');
  });

  test('D Reset + Offline Epoch: Trainee lädt das Arbeitspaket, erfasst offline einen Übergabe-Schritt, Admin-Reset per API ⇒ online Banner/Dialog „Demo-Daten zurückgesetzt“ („Später“ lässt alles stehen), Bestätigen ⇒ Pending 0, neues Paket mit neuer Epoch, neuer Seed unverändert', async ({
    browser,
  }) => {
    test.setTimeout(480_000);
    const trainee = TRAINEES.rental;
    // Frischer Seed: die Übergabe des Pakets ist offen (F hat die alte finalisiert).
    await resetDemoViaApi(adminCookie);
    const processId = seedEntityId('process.handover.ready');
    const bookingId = bookingIdOfProcess(processId);

    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await loginDemo(page, trainee.email, trainee.password, trainee.firstName);
      await waitForOfflineReady(page);
      // Erneut laden (Tab vom Service Worker kontrolliert), Wizard-Shell online besuchen, Paket laden.
      await page.reload();
      await page.goto(`/vorgaenge/${processId}/uebergabe`);
      await expect(page.getByRole('heading', { name: '1. Vorgang prüfen' })).toBeVisible();
      await page.goto('/sync');
      await page.getByTestId('package-refresh').click();
      await expect(page.getByText('Arbeitspaket aktualisiert.')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('lease-info')).toBeVisible();
      const epochBefore = await readOfflineMeta(page, 'datasetEpoch');
      expect(epochBefore, 'Epoch des Pakets (Meta datasetEpoch)').toMatch(/^[0-9a-f-]{36}$/);
      const statusBefore = await browserApi<{ datasetEpoch: string | null; environment: string }>(
        page,
        'GET',
        '/staff/offline/status',
      );
      expect(statusBefore.data).toMatchObject({ environment: 'demo', datasetEpoch: epochBefore });

      // Offline: Übergabe-Prüfung erfassen (Mutation in der lokalen Warteschlange).
      await goOffline(page);
      await page.goto(`/vorgaenge/${processId}/uebergabe`, { waitUntil: 'commit' });
      await expect(page.getByTestId('wizard-offline-banner')).toBeVisible({ timeout: 30_000 });
      await page.getByTestId('wizard-next').click();
      await page.getByTestId('wizard-next').click();
      await page.getByTestId('wizard-next').click();
      await page.getByRole('button', { name: 'Maschine gemeinsam geprüft' }).click();
      await expect(page.getByTestId('check-1')).toContainText('Maschine gemeinsam geprüft');
      await expect.poll(() => pendingCount(page)).toBeGreaterThanOrEqual(1);
      const pendingBefore = await pendingCount(page);

      // Admin setzt die Demo zurück, während der Trainee offline ist ⇒ neue Epoch, neuer Seed.
      await resetDemoViaApi(adminCookie);
      const statusAfter = await demoApi<{ datasetEpoch: string | null }>(
        'GET',
        '/staff/offline/status',
        { cookie: adminCookie },
      );
      expect(statusAfter.status).toBe(200);
      const epochAfter = statusAfter.data.datasetEpoch;
      expect(epochAfter).toMatch(/^[0-9a-f-]{36}$/);
      expect(epochAfter).not.toBe(epochBefore);
      const newProcessId = seedEntityId('process.handover.ready');
      expect(newProcessId).not.toBe(processId);
      const newBookingId = bookingIdOfProcess(newProcessId);
      expect(demoDb('SELECT id FROM bookings WHERE id = $1', [bookingId])).toHaveLength(0);

      // Wieder online: Konnektivitätscheck erkennt die neue Epoch ⇒ Banner, kein Auto-Sync.
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect(page.getByTestId('offline-indicator')).toHaveAttribute(
        'data-connectivity',
        'online',
        { timeout: 30_000 },
      );
      await expect(page.getByTestId('dataset-changed-banner')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('dataset-changed-banner')).toContainText(
        'Die Demo-Daten wurden zurückgesetzt.',
      );
      await page.getByTestId('dataset-changed-check').click();
      await expect(page).toHaveURL(/\/sync$/);
      const dialog = page.getByTestId('dataset-changed-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(
        `Die Demo-Daten wurden zurückgesetzt. ${pendingBefore} nicht synchronisierte Erfassungen gehören zum alten Datenstand und können nicht mehr übernommen werden.`,
      );
      // „Später“: Zustand bleibt stehen, keine Synchronisierung bis zur Bestätigung.
      await page.getByTestId('dataset-changed-later').click();
      await expect(dialog).toBeHidden();
      const notice = page.getByTestId('dataset-changed-notice');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('Bis zur Bestätigung wird nicht synchronisiert.');
      await expect(page.getByTestId('sync-now')).toBeDisabled();
      expect(await pendingCount(page)).toBe(pendingBefore);
      expect(await readOfflineMeta(page, 'datasetEpoch')).toBe(epochBefore);
      await page.getByTestId('dataset-changed-reopen').click();
      await expect(dialog).toBeVisible();
      // Bestätigen: alter Stand verworfen, neues Paket mit der neuen Epoch.
      await expect(page.getByTestId('dataset-changed-confirm')).toBeEnabled();
      await page.getByTestId('dataset-changed-confirm').click();
      await expect(page.getByText(/Alter Demo-Datenstand verworfen/)).toBeVisible({
        timeout: 60_000,
      });
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId('dataset-changed-notice')).toHaveCount(0);
      await expect(page.getByTestId('offline-indicator')).toHaveAttribute('data-pending', '0', {
        timeout: 30_000,
      });
      await expect(page.getByTestId('sync-pending-row')).toHaveCount(0);
      await expect(page.getByText(/Arbeitspaket \(heute ±3 Tage\) vom/)).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId('lease-info')).toBeVisible();
      await expect
        .poll(() => readOfflineMeta(page, 'datasetEpoch'), { timeout: 30_000 })
        .toBe(epochAfter);
      await expect(page.getByTestId('sync-now')).toBeEnabled();

      // Neuer Seed unverändert: keine Prüfung/Fotos/Unterschriften auf der neuen Buchung,
      // keine alte Mutation angewendet (Order §92).
      const handover = demoDb<{ id: string; status: string }>(
        'SELECT id, status FROM handovers WHERE booking_id = $1',
        [newBookingId],
      );
      expect(handover.length).toBeLessThanOrEqual(1);
      expect(handover[0]?.status ?? 'draft').not.toBe('finalized');
      for (const table of ['handover_machine_checks', 'handover_photos', 'handover_signatures']) {
        expect(
          demoDb(
            `SELECT t.id FROM ${table} t JOIN handovers h ON h.id = t.handover_id WHERE h.booking_id = $1`,
            [newBookingId],
          ),
          table,
        ).toHaveLength(0);
      }
      expect(demoDb('SELECT client_mutation_id FROM offline_mutation_receipts')).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
