import { expect, type Page, type Response } from '@playwright/test';

/**
 * Phase 17 (Order §27 A – Testflake Lexware E „Abgeschlossen“): Vorgangsseite
 * `/vorgaenge/<id>` der Staff-App belastbar öffnen und den Hauptstatus prüfen.
 *
 * Hintergrund: Die Seite rendert den Hauptstatus-Badge erst, nachdem der AuthGuard
 * (`/api/auth/me` + Offline-Laufzeit) UND die Vorgangsdaten
 * (`GET /api/staff/processes/<id>`) geladen sind – zwei sequentielle Round-Trips,
 * auf der Lexware-Instanz zusätzlich hinter dem `next dev`-Rewrite-Proxy. Bis dahin
 * steht nur „Wird geladen …“ (kein `.badge`). Das frühere Muster `goto` +
 * `locator('.badge', { hasText: 'Abgeschlossen' }).first()` mit dem Playwright-
 * Default von 5 s wartete nicht auf „Daten geladen“ und konnte Ladezustand,
 * Fehlerzustand und falschen Status nicht unterscheiden; `hasText` (String) ist
 * zudem ein case-insensitiver Teilstring – „Übergabe/Rückgabe abgeschlossen“
 * passte ebenfalls.
 *
 * Hier: erst die Antwort der Vorgangsdaten abwarten (Zustandsbedingung, abonniert
 * VOR der Navigation), dann den Badge `process-main-status` mit EXAKTEM Text
 * prüfen – mit dem projektüblichen Timeout von 30 s (tours-flow
 * `toBeVisible({ timeout: 30_000 })`, staff-login `REQUEST_TIMEOUT_MS`).
 * Kein Sleep; keine Produktprüfung entfällt – die Prüfung wird schärfer.
 */

/** Projektübliche Obergrenze für Zustandswartezeiten (kein Sleep, nur Obergrenze). */
export const PROCESS_PAGE_TIMEOUT_MS = 30_000;

/** Genau die Vorgangsdaten (`GET /api/staff/processes/<id>`), keine Unterressourcen. */
function isProcessDetailResponse(processId: string): (response: Response) => boolean {
  const pathname = `/api/staff/processes/${processId}`;
  return (response) =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === pathname;
}

/**
 * Vorgangsseite öffnen und warten, bis die Vorgangsdaten mit 200 geladen sind.
 * Ein Serverfehler wird sofort mit Status und URL gemeldet statt als
 * „element(s) not found“ nach Ablauf der Frist.
 */
export async function openProcessPage(page: Page, processId: string): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse(isProcessDetailResponse(processId), {
      timeout: PROCESS_PAGE_TIMEOUT_MS,
    }),
    page.goto(`/vorgaenge/${processId}`),
  ]);
  expect(response.status(), `Vorgangsdaten geladen: ${response.url()}`).toBe(200);
}

/**
 * Hauptstatus-Badge des Vorgangs (`data-testid="process-main-status"`) mit exaktem
 * Text, z. B. „Abgeschlossen“, „Storniert“, „Offen“.
 */
export async function expectProcessMainStatus(page: Page, label: string): Promise<void> {
  await expect(page.getByTestId('process-main-status')).toHaveText(label, {
    timeout: PROCESS_PAGE_TIMEOUT_MS,
  });
}
