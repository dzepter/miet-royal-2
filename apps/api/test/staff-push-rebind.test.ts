/**
 * Phase 12 Finalisierung – Punkt 4 (Auftrag P1–P10, hier „PB“ zur
 * Unterscheidung von den bestehenden P1–P17): automatisches Wiederanbinden
 * der vorhandenen Browser-Subscription nach Login/App-Start – Client-Seite
 * (apps/staff/lib/push-rebind.ts, reine Funktion mit injizierten
 * Abhängigkeiten). Server-Seite: communication-push-rebind.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPushRebindScheduler,
  rebindExistingPushSubscription,
  type PushRebindEnv,
  type PushRebindRegisterBody,
} from '../../staff/lib/push-rebind.ts';
import {
  derivePushViewState,
  PUSH_DENIED_TEXT,
  PUSH_ENABLE_LABEL,
} from '../../staff/lib/push-state.ts';

const STAFF_ROOT = join(import.meta.dirname, '..', '..', 'staff');
const ENDPOINT = `https://fcm.googleapis.com/fcm/send/rebind-${'e'.repeat(40)}`;
const KEYS = { p256dh: 'BPk'.padEnd(87, 'A'), auth: 'auth-secret-16by' };

interface FakeOptions {
  permission?: string;
  supported?: boolean;
  online?: boolean;
  registration?: boolean;
  subscription?: { endpoint: string; keys?: Record<string, string> } | null;
  register?: (body: PushRebindRegisterBody) => Promise<{ ok: boolean }>;
  getSubscriptionError?: Error;
}

/** Nachbildung von Notification/navigator.serviceWorker mit Spies auf den verbotenen APIs. */
function fakeBrowser(options: FakeOptions = {}) {
  const requestPermission = vi.fn(async () => 'granted');
  const subscribe = vi.fn(async () => {
    throw new Error('subscribe darf nie aufgerufen werden');
  });
  const subscriptionValue =
    options.subscription === undefined
      ? { endpoint: ENDPOINT, keys: { ...KEYS } }
      : options.subscription;
  const subscription =
    subscriptionValue === null
      ? null
      : {
          endpoint: subscriptionValue.endpoint,
          toJSON: () => ({ endpoint: subscriptionValue.endpoint, keys: subscriptionValue.keys }),
        };
  const getSubscription = vi.fn(async () => {
    if (options.getSubscriptionError !== undefined) throw options.getSubscriptionError;
    return subscription;
  });
  const registration = { pushManager: { getSubscription, subscribe } };
  const getRegistration = vi.fn(async () =>
    options.registration === false ? undefined : registration,
  );
  const register = vi.fn(options.register ?? (async () => ({ ok: true })));
  const notification = { permission: options.permission ?? 'granted', requestPermission };
  const env: PushRebindEnv = {
    supported: options.supported ?? true,
    online: options.online ?? true,
    notification,
    serviceWorker: { getRegistration },
    register,
    userAgentLabel: () => 'Android-Handy · Chrome',
  };
  return { env, requestPermission, subscribe, getSubscription, getRegistration, register };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PB – automatisches Wiederanbinden (Client, lib/push-rebind.ts)', () => {
  it('PB2/PB3. granted + vorhandene Subscription ⇒ genau ein POST (bestehender Registrierpfad) mit endpoint/keys aus getSubscription(), Ergebnis „rebound“', async () => {
    const browser = fakeBrowser();
    expect(await rebindExistingPushSubscription(browser.env)).toBe('rebound');
    expect(browser.getSubscription).toHaveBeenCalledTimes(1);
    expect(browser.register).toHaveBeenCalledTimes(1);
    expect(browser.register).toHaveBeenCalledWith({
      endpoint: ENDPOINT,
      keys: { p256dh: KEYS.p256dh, auth: KEYS.auth },
      userAgentLabel: 'Android-Handy · Chrome',
    });
    // Nur die bekannten Felder – keine weiteren Schlüssel aus toJSON() (z. B. expirationTime).
    const extra = fakeBrowser({
      subscription: { endpoint: ENDPOINT, keys: { ...KEYS, extra: 'x' } },
    });
    await rebindExistingPushSubscription(extra.env);
    expect(Object.keys(extra.register.mock.calls[0]![0].keys).sort()).toEqual(['auth', 'p256dh']);
  });

  it('PB4. Notification.requestPermission() und pushManager.subscribe() werden in keinem Fall aufgerufen; der Code kennt sie nicht und liest nichts aus LocalStorage/Query/Cookie, loggt nichts', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level),
    );
    const scenarios: FakeOptions[] = [
      {},
      { permission: 'default' },
      { permission: 'denied' },
      { subscription: null },
      { registration: false },
      { register: async () => ({ ok: false }) },
      {
        register: async () => {
          throw new Error('Netz');
        },
      },
      { getSubscriptionError: new Error('kaputt') },
      { online: false },
    ];
    for (const scenario of scenarios) {
      const browser = fakeBrowser(scenario);
      await rebindExistingPushSubscription(browser.env);
      expect(browser.requestPermission, JSON.stringify(scenario)).not.toHaveBeenCalled();
      expect(browser.subscribe, JSON.stringify(scenario)).not.toHaveBeenCalled();
    }
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();

    // Statisch (ohne Kommentare): keine Berechtigungsabfrage, kein neues Abo, keine
    // anderen Endpoint-Quellen, kein Logging.
    const code = readFileSync(join(STAFF_ROOT, 'lib', 'push-rebind.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      /requestPermission/,
      /\.subscribe\(/,
      /localStorage|sessionStorage|indexedDB/,
      /document\.cookie|location|URLSearchParams/,
      /console\./,
    ]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('PB5. permission „default“ ⇒ kein Prompt, kein POST, nicht einmal getSubscription(); UI zeigt weiter „Push-Benachrichtigungen aktivieren“', async () => {
    const browser = fakeBrowser({ permission: 'default' });
    expect(await rebindExistingPushSubscription(browser.env)).toBe('skipped:permission_default');
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(browser.register).not.toHaveBeenCalled();
    expect(browser.getRegistration).not.toHaveBeenCalled();
    expect(browser.getSubscription).not.toHaveBeenCalled();
    expect(
      derivePushViewState({
        supported: true,
        permission: 'default',
        serverEnabled: true,
        active: false,
      }),
    ).toEqual({ kind: 'inactive', actionLabel: PUSH_ENABLE_LABEL });
    expect(PUSH_ENABLE_LABEL).toBe('Push-Benachrichtigungen aktivieren');
  });

  it('PB6. permission „denied“ ⇒ kein Prompt, kein POST; UI zeigt nur „Push ist auf diesem Gerät im Browser nicht aktiviert.“', async () => {
    const browser = fakeBrowser({ permission: 'denied' });
    expect(await rebindExistingPushSubscription(browser.env)).toBe('skipped:permission_denied');
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(browser.register).not.toHaveBeenCalled();
    expect(browser.getSubscription).not.toHaveBeenCalled();
    expect(
      derivePushViewState({
        supported: true,
        permission: 'denied',
        serverEnabled: true,
        active: true,
      }),
    ).toEqual({ kind: 'denied', text: PUSH_DENIED_TEXT });
    expect(PUSH_DENIED_TEXT).toBe('Push ist auf diesem Gerät im Browser nicht aktiviert.');
    // Unbekannte Werte werden wie „default“ behandelt (kein POST).
    const odd = fakeBrowser({ permission: 'prompt' });
    expect(await rebindExistingPushSubscription(odd.env)).toBe('skipped:permission_default');
    expect(odd.register).not.toHaveBeenCalled();
  });

  it('PB6b. Ohne Subscription, ohne Service Worker, mit unvollständigen Schlüsseln, offline oder ohne Push-Unterstützung ⇒ kein POST', async () => {
    const cases: Array<[FakeOptions, string]> = [
      [{ subscription: null }, 'skipped:no_subscription'],
      [{ registration: false }, 'skipped:no_registration'],
      [{ subscription: { endpoint: ENDPOINT } }, 'skipped:incomplete_subscription'],
      [
        { subscription: { endpoint: ENDPOINT, keys: { p256dh: KEYS.p256dh } } },
        'skipped:incomplete_subscription',
      ],
      [{ subscription: { endpoint: '', keys: { ...KEYS } } }, 'skipped:incomplete_subscription'],
      [{ online: false }, 'skipped:offline'],
      [{ supported: false }, 'skipped:unsupported'],
    ];
    for (const [options, expected] of cases) {
      const browser = fakeBrowser(options);
      expect(await rebindExistingPushSubscription(browser.env), expected).toBe(expected);
      expect(browser.register, expected).not.toHaveBeenCalled();
    }
  });

  it('PB6c. Fehler (Server lehnt ab, Netzwerkfehler, getSubscription wirft) ⇒ „failed“ ohne Exception', async () => {
    for (const options of [
      { register: async () => ({ ok: false }) },
      {
        register: async () => {
          throw new Error('Netz');
        },
      },
      { getSubscriptionError: new Error('kaputt') },
    ] satisfies FakeOptions[]) {
      const browser = fakeBrowser(options);
      await expect(rebindExistingPushSubscription(browser.env)).resolves.toBe('failed');
    }
  });

  it('PB2b. Genau einmal je App-Start: zweiter Aufruf ⇒ „already_attempted“; nach erfolgreichem Login (armAfterLogin) erneut genau ein POST; Fehler der Umgebung ⇒ „failed“', async () => {
    const scheduler = createPushRebindScheduler();
    const browser = fakeBrowser();
    expect(await scheduler.run(() => browser.env)).toBe('rebound');
    expect(await scheduler.run(() => browser.env)).toBe('skipped:already_attempted');
    expect(browser.register).toHaveBeenCalledTimes(1);
    scheduler.armAfterLogin();
    expect(await scheduler.run(() => browser.env)).toBe('rebound');
    expect(await scheduler.run(() => browser.env)).toBe('skipped:already_attempted');
    expect(browser.register).toHaveBeenCalledTimes(2);

    const broken = createPushRebindScheduler();
    await expect(
      broken.run(() => {
        throw new Error('kein Browser');
      }),
    ).resolves.toBe('failed');
  });

  it('PB2c. Einbindung: AuthGuard ruft das Wiederanbinden erst im Online-Zustand „ready“ auf, der Login gibt es frei; Login-/Passwortseiten rufen es nicht auf', () => {
    const guard = readFileSync(join(STAFF_ROOT, 'components', 'auth-guard.tsx'), 'utf8');
    const readyIndex = guard.indexOf("setState('ready');");
    const callIndex = guard.indexOf('void rebindPushOnAppStart();');
    expect(readyIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(readyIndex);
    expect(guard.match(/rebindPushOnAppStart\(\)/g)).toHaveLength(1);
    const loginPage = readFileSync(join(STAFF_ROOT, 'app', 'login', 'page.tsx'), 'utf8');
    expect(loginPage.match(/armPushRebindAfterLogin\(\);/g)).toHaveLength(3);
    expect(loginPage).not.toMatch(/rebindPushOnAppStart/);
    for (const page of ['passwort-vergessen', 'passwort-zuruecksetzen']) {
      const source = readFileSync(join(STAFF_ROOT, 'app', page, 'page.tsx'), 'utf8');
      expect(source, page).not.toMatch(/rebindPushOnAppStart|armPushRebindAfterLogin/);
    }
    const pushLib = readFileSync(join(STAFF_ROOT, 'lib', 'push.ts'), 'utf8');
    expect(pushLib).toMatch(
      /apiFetch\('\/staff\/push\/subscriptions', \{ method: 'POST', body \}\)/,
    );
  });
});
