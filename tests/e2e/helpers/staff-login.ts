import { test, type Page, type Request } from '@playwright/test';

/**
 * Phase 15 Final (E2E-Stabilität): gemeinsamer Absende-Schritt aller
 * UI-Staff-Logins, die als VORBEDINGUNG einloggen (Login-Helfer in
 * helpers/settlement.ts und helpers/tours.ts sowie die Inline-Logins der
 * Fachspecs).
 *
 * Hintergrund: `POST /auth/login` ist je IP + E-Mail auf 10 Anfragen pro
 * Minute begrenzt (apps/api/src/routes/auth.ts, `strictLimit`). Im
 * Komplettlauf (ein Worker, alle Browser von 127.0.0.1) meldet
 * communication-ops.spec.ts den Admin am Ende (Tests P–U) mehrfach kurz
 * hintereinander an; die nächsten Specs melden ihn sofort wieder an und sahen
 * „Rate limit exceeded, retry in N seconds“ statt der Startseite. Isoliert
 * liefen sie grün – das Limit ist gewolltes Produktverhalten, kein Fehler.
 *
 * Muster wie Phase 14 `demoApiLogin` (helpers/training.ts): ein 429 des
 * Logins ist kein Fehlschlag, sondern „nach Ablauf des Fensters erneut“.
 * - Wiederholt wird NUR, wenn `POST /api/auth/login` mit 429 antwortet UND die
 *   Login-Seite die explizite Meldung „Rate limit exceeded, retry in N …“
 *   zeigt. Gewartet wird die dort genannte Zeit + 1 s (je Versuch höchstens
 *   65 s, höchstens 6 Versuche); die Wartezeit wird dem Test-/Hook-Timeout
 *   gutgeschrieben, damit sie nicht das Budget der eigentlichen Prüfungen
 *   aufzehrt.
 * - Jede andere Antwort (Erfolg, falsches Passwort, Sperre, 2FA-Challenge,
 *   Passwortwechsel, Netzwerkfehler, kein Request) kehrt sofort zurück: Die
 *   bisherige Erfolgsprüfung (Heading „Heute“, „Willkommen, …“ usw.) bleibt
 *   unverändert beim Aufrufer.
 * - Kein fester Sleep auf dem Erfolgspfad: gewartet wird nur auf die Antwort
 *   des Login-Requests selbst.
 * - specs/staff-auth.spec.ts prüft das Login-Verhalten selbst (inkl.
 *   Fehlversuche, Sperre) und nutzt diesen Helfer bewusst nicht.
 */

/**
 * Explizite Meldung von @fastify/rate-limit (`retry in ${format(ttl, long)}`):
 * im 1-Minuten-Fenster „N second(s)“, an der Fenstergrenze „1 minute“ bzw. „0 ms“.
 */
export const STAFF_LOGIN_RATE_LIMIT_MESSAGE =
  /Rate limit exceeded, retry in (\d+) (ms|seconds?|minutes?)\b/;

const MAX_ATTEMPTS = 6;
const MAX_WAIT_MS = 65_000;
/** Obergrenze für das Warten auf den Login-Request/seine Antwort (kein Sleep). */
const REQUEST_TIMEOUT_MS = 30_000;
/** Obergrenze, bis die Login-Seite die Meldung zu einem 429 anzeigt. */
const NOTICE_TIMEOUT_MS = 10_000;

function isCredentialsLogin(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === '/api/auth/login';
}

/** Wartezeit laut Meldung + 1 s (gedeckelt); `null`, wenn es nicht die Rate-Limit-Meldung ist. */
function rateLimitWaitMs(notice: string): number | null {
  const match = STAFF_LOGIN_RATE_LIMIT_MESSAGE.exec(notice);
  if (match === null) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? '';
  const unitMs = unit === 'ms' ? 1 : unit.startsWith('minute') ? 60_000 : 1_000;
  return Math.min(MAX_WAIT_MS, amount * unitMs + 1_000);
}

/** Wartezeit dem laufenden Test bzw. Hook gutschreiben (0 = ohne Timeout bleibt 0). */
function creditTimeout(waitMs: number): void {
  const info = test.info();
  if (info.timeout > 0) info.setTimeout(info.timeout + waitMs);
}

/**
 * E-Mail/Passwort ausfüllen und „Anmelden“ klicken (Login-Seite muss bereits
 * geöffnet sein). Kehrt zurück, sobald der Login-Request beantwortet ist;
 * nur bei der expliziten Rate-Limit-Meldung wird gewartet und erneut
 * abgesendet. Die Prüfung des Folgezustands bleibt beim Aufrufer.
 */
export async function submitStaffLogin(page: Page, email: string, password: string) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await page.getByLabel('E-Mail').fill(email);
    await page.getByLabel('Passwort', { exact: true }).fill(password);
    const loginRequest = page
      .waitForRequest(isCredentialsLogin, { timeout: REQUEST_TIMEOUT_MS })
      .catch(() => null);
    await page.getByRole('button', { name: 'Anmelden' }).click();
    const request = await loginRequest;
    const response = request === null ? null : await request.response().catch(() => null);
    if (response === null || response.status() !== 429 || attempt === MAX_ATTEMPTS) return;

    const notice = page.getByText(STAFF_LOGIN_RATE_LIMIT_MESSAGE);
    const shown = await notice.waitFor({ state: 'visible', timeout: NOTICE_TIMEOUT_MS }).then(
      () => true,
      () => false,
    );
    if (!shown) return;
    const waitMs = rateLimitWaitMs((await notice.textContent()) ?? '');
    if (waitMs === null) return;
    console.warn(
      `[staff-login] ${email}: Login-Rate-Limit – erneuter Versuch ${attempt + 1}/${MAX_ATTEMPTS} in ${waitMs} ms`,
    );
    creditTimeout(waitMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}
