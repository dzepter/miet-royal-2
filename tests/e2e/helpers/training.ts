import { execFileSync } from 'node:child_process';
import { expect, type Locator, type Page } from '@playwright/test';
import { queryDatabase } from './communication-ops.ts';
import { DEMO_API_ORIGIN, DEMO_DATABASE_URL } from './demo-env.ts';
import { login, PNG_1X1, sign, wizardNext } from './settlement.ts';

/**
 * Phase 14 (E2E, Training): Helfer der Demo-Trainingsszenarien
 * (training-demo.spec.ts, Projekt `demo-communication`). Ausschließlich additiv.
 *
 * - Demo-API per Node-fetch mit explizitem Session-Cookie (das Demo-Cookie ist
 *   `Secure`; Playwrights `page.request` sendet es über http://127.0.0.1 nicht,
 *   der Browser selbst schon – daher `browserApi` für In-Page-Aufrufe).
 * - Demo-Datenbank nur lesend (Registry, Versuche, Ereignisse, Fachzustände);
 *   Reset ausschließlich über `POST /staff/demo/reset` mit Pflichtbestätigung.
 * - Katalog-Variante (Szenario O) über das Skript
 *   apps/api/scripts/e2e-training-catalog-bump.ts (Kindprozess, nur Test-DB).
 * - Staff-UI-Wege der Übungen (Training-Seite, Übergabe-/Rückgabe-Wizard) mit
 *   den data-testids der Phase-14-UI; Fachwizards wie helpers/settlement.ts,
 *   aber ohne festen Mitarbeiternamen (Trainee unterschreibt).
 */

const REPO_ROOT = `${import.meta.dirname}/../../..`;

/** Pflichtbestätigung des Demo-Resets (apps/api/src/demo/types.ts DEMO_MESSAGES). */
export const DEMO_RESET_CONFIRMATION = 'DEMO ZURÜCKSETZEN';

/** Demo-Hinweis der Abrechnung (settlement-service.ts DEMO_ACCOUNTING_UNAVAILABLE_HINT). */
export const SETTLEMENT_DEMO_UNAVAILABLE_TEXT =
  'Buchhaltungsübertragung ist in der Demo nicht verfügbar.';

// ── Demo-Datenbank (nur lesen) ───────────────────────────────────────────

export function demoDb<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  return queryDatabase<T>(DEMO_DATABASE_URL, sql, params);
}

/** Entity-ID eines Seed-Schlüssels aus der Registry (Fehler, wenn nicht registriert). */
export function seedEntityId(seedKey: string): string {
  const rows = demoDb<{ entity_id: string }>(
    'SELECT entity_id FROM demo_seed_entities WHERE seed_key = $1',
    [seedKey],
  );
  expect(rows, `Seed-Key ${seedKey}`).toHaveLength(1);
  return rows[0]!.entity_id;
}

export function processNumberOf(processId: string): string {
  const rows = demoDb<{ process_number: string }>(
    'SELECT process_number FROM processes WHERE id = $1',
    [processId],
  );
  expect(rows, `Vorgang ${processId}`).toHaveLength(1);
  return rows[0]!.process_number;
}

export function bookingIdOfProcess(processId: string): string {
  const rows = demoDb<{ id: string }>('SELECT id FROM bookings WHERE process_id = $1', [processId]);
  expect(rows, `Buchung des Vorgangs ${processId}`).toHaveLength(1);
  return rows[0]!.id;
}

/** E-Mail-Adresse des Kunden eines Vorgangs (Seed-Kunden: example.* oder Demo-Testadresse). */
export function customerEmailOfProcess(processId: string): string {
  const rows = demoDb<{ email: string | null }>(
    'SELECT c.email FROM customers c JOIN processes p ON p.customer_id = c.id WHERE p.id = $1',
    [processId],
  );
  expect(rows, `Kunde des Vorgangs ${processId}`).toHaveLength(1);
  expect(rows[0]!.email, 'Kunden-E-Mail').not.toBeNull();
  return rows[0]!.email!;
}

export function staffUserIdByEmail(email: string): string {
  const rows = demoDb<{ id: string }>('SELECT id FROM staff_users WHERE lower(email) = lower($1)', [
    email,
  ]);
  expect(rows, `Mitarbeiter ${email}`).toHaveLength(1);
  return rows[0]!.id;
}

export interface AttemptDbRow {
  id: string;
  user_id: string;
  definition_key: string;
  definition_version: number;
  status: 'in_progress' | 'passed' | 'interrupted';
  failed_check_count: number;
  interruption_code: string | null;
  completed_at: string | null;
  superseded_at: string | null;
  started_at: string;
}

/** Versuche eines Mitarbeiters zu einer Übung (neueste zuerst). */
export function attemptsOf(userId: string, definitionKey: string): AttemptDbRow[] {
  return demoDb<AttemptDbRow>(
    `SELECT a.id, a.user_id, d.key AS definition_key, a.definition_version, a.status,
            a.failed_check_count, a.interruption_code, a.completed_at, a.superseded_at, a.started_at
       FROM training_attempts a JOIN training_definitions d ON d.id = a.definition_id
      WHERE a.user_id = $1 AND d.key = $2
      ORDER BY a.started_at DESC`,
    [userId, definitionKey],
  );
}

export interface AttemptEventDbRow {
  event_key: string;
  step_key: string | null;
  result: string;
  error_code: string | null;
}

export function attemptEvents(attemptId: string): AttemptEventDbRow[] {
  return demoDb<AttemptEventDbRow>(
    `SELECT event_key, step_key, result, error_code FROM training_attempt_events
      WHERE attempt_id = $1 ORDER BY occurred_at ASC, event_key ASC`,
    [attemptId],
  );
}

// ── Demo-API (Node-fetch, Secure-Cookie explizit) ─────────────────────────

export interface DemoApiResponse<T> {
  status: number;
  data: T;
  text: string;
  headers: Headers;
}

export async function demoApi<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<DemoApiResponse<T>> {
  const response = await fetch(`${DEMO_API_ORIGIN}${path}`, {
    method,
    headers: {
      connection: 'close',
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: response.status, data: data as T, text, headers: response.headers };
}

/**
 * API-Login (eigene Session) – liefert das Session-Cookie `name=value`.
 * Die Auth-Endpunkte sind auch in der Demo limitiert (10 Logins je Minute und
 * IP + E-Mail); vorangehende Specs desselben Laufs melden den Demo-Admin
 * mehrfach an – ein 429 wird daher (nach `retry-after`) wiederholt, nie als
 * Fehlschlag gewertet.
 */
export async function demoApiLogin(email: string, password: string): Promise<string> {
  let response: Response | null = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    response = await fetch(`${DEMO_API_ORIGIN}/auth/login`, {
      method: 'POST',
      headers: { connection: 'close', 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (response.status !== 429) break;
    const retryAfter = Number(response.headers.get('retry-after') ?? '0');
    const waitMs = Math.min(15, Math.max(5, Number.isFinite(retryAfter) ? retryAfter : 5)) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  expect(response!.status, `API-Login ${email}`).toBe(200);
  const match = /(__Host-)?mr_staff_session=([^;]+)/.exec(
    response!.headers.get('set-cookie') ?? '',
  );
  expect(match, 'Demo-Session-Cookie').not.toBeNull();
  return `${match![1] ?? ''}mr_staff_session=${match![2]}`;
}

/**
 * Aufruf der Staff-API aus dem Browserkontext der Seite (Same-Origin-Proxy
 * `/api/*`): nur so reist das `Secure`-Demo-Cookie mit (siehe Kopfkommentar).
 */
export async function browserApi<T = unknown>(
  page: Page,
  method: 'GET' | 'POST' | 'DELETE',
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

export interface DemoResetResult {
  ok: boolean;
  datasetVersion: number;
  seededAt: string;
  durationMs: number;
  deleted: Record<string, number>;
  seeded: Record<string, number>;
}

/** Destruktiver Demo-Reset über die API (demo.manage) mit Pflichtbestätigung – ≈ 10 s. */
export async function resetDemoViaApi(cookie: string): Promise<DemoResetResult> {
  const result = await demoApi<DemoResetResult>('POST', '/staff/demo/reset', {
    cookie,
    body: { confirmation: DEMO_RESET_CONFIRMATION },
  });
  expect(result.status, `POST /staff/demo/reset: ${result.text}`).toBe(200);
  expect(result.data.ok).toBe(true);
  return result.data;
}

/** Mock-Jobsteuerung der Demo-API (system.settings): fällige Jobs (mail.send, whatsapp.send …) ausführen. */
export async function runDemoJobs(cookie: string): Promise<{ processed: number; failed: number }> {
  const result = await demoApi<{ processed: number; failed: number }>(
    'POST',
    '/staff/accounting/mock/run-due-jobs',
    { cookie },
  );
  expect(result.status, `run-due-jobs: ${result.text}`).toBe(200);
  return result.data;
}

/** Pfad zuweisen (training.manage) – 201 neu, 409 bei Duplikat wird toleriert (idempotent). */
export async function assignPathViaApi(
  cookie: string,
  userId: string,
  pathKey: string,
): Promise<void> {
  const result = await demoApi<{ error?: { code: string } }>(
    'POST',
    '/staff/training/admin/assignments',
    { cookie, body: { userId, pathKey } },
  );
  expect([201, 409], `Zuweisung ${pathKey}: ${result.text}`).toContain(result.status);
  if (result.status === 409) expect(result.data.error?.code).toBe('TRAINING_ASSIGNMENT_EXISTS');
}

export interface TrainingMeDefinition {
  key: string;
  version: number;
  title: string;
  active: boolean;
  state: 'passed' | 'in_progress' | 'open';
  passedAt: string | null;
  permissionMissing: boolean;
  /** Review-Fix F7: jüngster Versuch der Übung (auch ohne Zuweisung) – Serverzustand der freien Übungen. */
  attempt: { id: string; status: 'in_progress' | 'passed' | 'interrupted' } | null;
}

export interface TrainingMeView {
  environment: string;
  exercisesAvailable: boolean;
  definitions: TrainingMeDefinition[];
  assignments: {
    id: string;
    path: { key: string; title: string };
    status: string;
    round: number;
    items: { definition: { key: string }; state: string; attempt: { id: string } | null }[];
  }[];
  activeAttempts: { id: string; definitionKey: string; status: string }[];
}

export async function trainingMeViaApi(cookie: string): Promise<TrainingMeView> {
  const result = await demoApi<TrainingMeView>('GET', '/staff/training/me', { cookie });
  expect(result.status, `GET /staff/training/me: ${result.text}`).toBe(200);
  return result.data;
}

// ── Katalog-Variante (Szenario O) ─────────────────────────────────────────

export interface CatalogBumpResult {
  mode: 'bump' | 'restore';
  key: string;
  version: number;
  title: string;
}

/** Katalog-Variante einspielen (`bump`) bzw. den normalen Katalog wiederherstellen (`restore`). */
export function syncTrainingCatalog(
  mode: 'bump' | 'restore',
  definitionKey = 'offer_send',
): CatalogBumpResult {
  const output = execFileSync(
    'pnpm',
    ['--filter', '@mietroyal/api', 'exec', 'tsx', 'scripts/e2e-training-catalog-bump.ts'],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      env: {
        ...process.env,
        DATABASE_URL: DEMO_DATABASE_URL,
        LOG_LEVEL: 'error',
        E2E_CATALOG_MODE: mode,
        E2E_CATALOG_DEFINITION: definitionKey,
      },
    },
  );
  const lines = output.toString('utf8').trim().split('\n');
  return JSON.parse(lines[lines.length - 1] ?? '{}') as CatalogBumpResult;
}

// ── Staff-UI: Training-Seite ──────────────────────────────────────────────

export async function loginDemo(page: Page, email: string, password: string, firstName: string) {
  await login(page, email, password, firstName);
}

export async function openTraining(page: Page): Promise<void> {
  await page.goto('/training');
  await expect(page.getByTestId('training-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Training' })).toBeVisible();
}

/** Übungskarte (zugewiesen oder frei) nach Definition-Key. */
export function exerciseCard(page: Page, definitionKey: string): Locator {
  return page.locator(`[data-testid="training-exercise"][data-key="${definitionKey}"]`);
}

/** „Übung starten“ ⇒ laufender Versuch mit Schrittliste; liefert die Versuchs-ID aus der DB. */
export async function startExerciseViaUi(
  page: Page,
  userId: string,
  definitionKey: string,
): Promise<string> {
  const card = exerciseCard(page, definitionKey);
  await expect(card).toBeVisible();
  await expect(card.getByTestId('training-permission-missing')).toHaveCount(0);
  await card.getByTestId('training-start').click();
  await expect(card.getByTestId('training-steps')).toBeVisible();
  await expect(card.getByTestId('training-check')).toBeVisible();
  await expect(card).toHaveAttribute('data-state', 'in_progress');
  const running = attemptsOf(userId, definitionKey).filter((row) => row.status === 'in_progress');
  expect(running, 'genau ein laufender Versuch').toHaveLength(1);
  return running[0]!.id;
}

/** „Übung prüfen“ ⇒ Ergebnis-Hinweis (data-passed true|false). */
export async function checkExerciseViaUi(page: Page, definitionKey: string): Promise<Locator> {
  const card = exerciseCard(page, definitionKey);
  await card.getByTestId('training-check').click();
  const result = card.getByTestId('training-check-result');
  await expect(result).toBeVisible();
  return result;
}

/** Nach dem Fachablauf: Training neu laden ⇒ Übung „erledigt“ (automatischer Abschluss). */
export async function expectExercisePassedViaUi(page: Page, definitionKey: string): Promise<void> {
  await openTraining(page);
  const card = exerciseCard(page, definitionKey);
  await expect(card).toHaveAttribute('data-state', 'passed');
  await expect(card.getByTestId('training-exercise-state')).toHaveText('erledigt');
  await expect(card.getByTestId('training-exercise-passed')).toContainText('Bestanden');
  await expect(card.getByTestId('training-check')).toHaveCount(0);
  await expect(card.getByTestId('training-start')).toHaveCount(0);
}

// ── Staff-UI: Fachwizards (Trainee unterschreibt selbst) ──────────────────

/**
 * Übergabe-Wizard der vorbereiteten Ausgabe (Maschine zugewiesen + vorbereitet)
 * vollständig bis „Übergabe abgeschlossen“ (Prüfung, Foto, Empfänger = Kunde,
 * beide Unterschriften, Abschluss) – Muster helpers/settlement.ts issueBooking.
 */
export async function finalizeHandoverViaUi(
  page: Page,
  processId: string,
  staffName: string,
): Promise<void> {
  await page.goto(`/vorgaenge/${processId}/uebergabe`);
  await expect(page.getByRole('heading', { name: '1. Vorgang prüfen' })).toBeVisible();
  await wizardNext(page); // 1 Vorgang
  await wizardNext(page); // 2 Maschinen
  await wizardNext(page); // 3 Artikel
  await expect(
    page.getByRole('heading', { name: '4. Jede Maschine gemeinsam prüfen + Gesamtfoto' }),
  ).toBeVisible();
  const check = page.getByTestId('check-1');
  await check.getByRole('button', { name: 'Maschine gemeinsam geprüft' }).click();
  await expect(check).toContainText('✓ Maschine gemeinsam geprüft');
  await page
    .getByTestId('photo-input-1')
    .setInputFiles({ name: 'gesamtfoto.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(check.locator('img.photo-thumb')).toHaveCount(1);
  await wizardNext(page); // 4 → 5 Empfänger
  await page.getByRole('button', { name: 'Übernehmen', exact: true }).click();
  await expect(page.getByText('Empfangsperson gespeichert.')).toBeVisible();
  await wizardNext(page); // 5 → 6 Zusammenfassung
  await wizardNext(page); // 6 → 7 Unterschrift Kunde
  await sign(page, 'Kunde');
  await expect(page.getByText(/✓ Unterschrieben von/)).toBeVisible();
  await wizardNext(page);
  await sign(page, 'Mitarbeiter');
  await expect(page.getByText(new RegExp(`✓ Unterschrieben von ${staffName}`))).toBeVisible();
  await wizardNext(page);
  await expect(page.getByTestId('wizard-blockers')).toHaveCount(0);
  await page.getByTestId('finalize-button').click();
  await expect(page.getByText(/✓ Übergabe abgeschlossen am/)).toBeVisible();
}

/**
 * Rückgabe-Wizard ohne Beanstandung bis „Rückgabe abgeschlossen“ (eine
 * Maschine, Zubehör vollständig, ordnungsgemäß vorbereitet, keine Kommission/
 * Schäden/Fehlteile) – Muster helpers/settlement.ts returnBooking.
 */
export async function finalizeReturnViaUi(
  page: Page,
  processId: string,
  staffName: string,
): Promise<void> {
  await page.goto(`/vorgaenge/${processId}/rueckgabe`);
  const start = page.getByTestId('return-start');
  const stepOne = page.getByRole('heading', { name: '1. Vorgang und Rückgabeperson' });
  await expect(start.or(stepOne).first()).toBeVisible();
  if ((await start.count()) > 0) {
    await start.click();
    await expect(page.getByText('Rückgabe begonnen.')).toBeVisible();
  }
  await expect(stepOne).toBeVisible();
  await page.getByTestId('returner-save').click();
  await expect(page.getByText('Rückgabeperson übernommen.')).toBeVisible();
  await wizardNext(page);
  await expect(page.getByRole('heading', { name: '2. Maschinen bestätigen' })).toBeVisible();
  await wizardNext(page);
  await expect(page.getByRole('heading', { name: '3. Zubehör prüfen' })).toBeVisible();
  await page.getByTestId('accessory-complete-1').click();
  await expect(page.getByTestId('accessory-1')).toContainText('✓ Zubehör vollständig');
  await wizardNext(page);
  await expect(
    page.getByRole('heading', { name: '4. Rückgabevorbereitung des Kunden' }),
  ).toBeVisible();
  await page.getByTestId('cleanliness-confirm-1').click();
  await expect(page.getByTestId('cleanliness-1')).toContainText('Ordnungsgemäß vorbereitet');
  await wizardNext(page);
  await expect(page.getByRole('heading', { name: '5. Kommissionsrückgabe' })).toBeVisible();
  await wizardNext(page);
  await expect(page.getByRole('heading', { name: '6. Schäden dokumentieren' })).toBeVisible();
  await wizardNext(page);
  await expect(page.getByRole('heading', { name: '7. Zusammenfassung' })).toBeVisible();
  await expect(page.getByTestId('return-summary')).toContainText('Rückgabe ohne Beanstandung');
  await wizardNext(page);
  await expect(
    page.getByRole('heading', { name: '8. Unterschrift Kunde / Vertreter' }),
  ).toBeVisible();
  await sign(page, 'Kunde');
  await expect(page.getByText(/✓ Unterschrieben von/)).toBeVisible();
  await wizardNext(page);
  await expect(page.getByRole('heading', { name: '9. Unterschrift Mitarbeiter' })).toBeVisible();
  await sign(page, 'Mitarbeiter');
  await expect(page.getByText(new RegExp(`✓ Unterschrieben von ${staffName}`))).toBeVisible();
  await wizardNext(page);
  await expect(page.getByRole('heading', { name: '10. Rückgabe abschließen' })).toBeVisible();
  const finalize = page.getByTestId('finalize-button');
  await expect(finalize).toBeEnabled();
  await finalize.click();
  await expect(page.getByText(/✓ Rückgabe abgeschlossen am/)).toBeVisible();
}
