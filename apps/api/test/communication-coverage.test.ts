/**
 * Phase 12 – Vollständigkeitsprüfung der Pflichttests (Order §42) – Unit-
 * Anteil: der Service Worker der Staff-PWA (apps/staff/public/sw.js) als
 * tatsächliche Gegenstelle von Web Push (Order §§29/30, Pflichttest 122
 * „notificationclick öffnet Staff-Seite“; §44/§46 Service-Worker-Regression).
 * Der Worker wird unverändert in einer VM-Sandbox mit minimalen Fakes der
 * Service-Worker-Globals ausgeführt – kein Browser, kein Netz.
 * Zuordnung: docs/PHASE12_TEST_TRACEABILITY.md.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const SW_SOURCE = readFileSync(
  join(import.meta.dirname, '..', '..', 'staff', 'public', 'sw.js'),
  'utf8',
);
const ORIGIN = 'https://staff.miet-royal.test';
const PROCESS_PATH = '/vorgaenge/11111111-1111-4111-8111-111111111111/termine';

interface FakeWindow {
  url: string;
  focusCalls: number;
  navigations: string[];
  focus(): Promise<FakeWindow>;
  navigate(url: string): Promise<FakeWindow>;
}

function fakeWindow(url: string, options: { navigateFails?: boolean } = {}): FakeWindow {
  const window: FakeWindow = {
    url,
    focusCalls: 0,
    navigations: [],
    async focus() {
      window.focusCalls += 1;
      return window;
    },
    async navigate(target: string) {
      if (options.navigateFails === true) throw new TypeError('not controlled');
      window.navigations.push(target);
      return window;
    },
  };
  return window;
}

/** Lädt sw.js in eine Sandbox und liefert Ereignis-Dispatcher + Aufzeichnungen. */
function loadServiceWorker(windows: FakeWindow[] = []) {
  const listeners = new Map<string, (event: unknown) => void>();
  const notifications: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const networkCalls: unknown[] = [];
  const matchAllOptions: unknown[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        notifications.push({ title, options });
      },
    },
    clients: {
      matchAll: async (options: unknown) => {
        matchAllOptions.push(options);
        return windows;
      },
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
      claim: async () => undefined,
    },
    skipWaiting: () => undefined,
  };
  runInNewContext(SW_SOURCE, {
    self,
    URL,
    setTimeout,
    clearTimeout,
    Response,
    CryptoKey: class {},
    fetch: (...args: unknown[]) => {
      networkCalls.push(args);
      return Promise.reject(new Error('kein Netz im Test'));
    },
    caches: {
      open: async (...args: unknown[]) => {
        networkCalls.push(['caches.open', ...args]);
        throw new Error('kein Cache im Test');
      },
      keys: async () => [],
    },
  });

  async function dispatch(type: string, event: Record<string, unknown>): Promise<void> {
    const listener = listeners.get(type);
    if (listener === undefined) throw new Error(`Kein Listener für ${type}`);
    const pending: Promise<unknown>[] = [];
    listener({ ...event, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  }

  const push = (payload: unknown, raw = false) =>
    dispatch('push', {
      data: {
        json: () => {
          if (raw) throw new SyntaxError('Unexpected token');
          return payload;
        },
      },
    });

  const click = async (url: unknown) => {
    let closed = 0;
    await dispatch('notificationclick', {
      notification: {
        data: { url },
        close: () => {
          closed += 1;
        },
      },
    });
    return closed;
  };

  return {
    listeners,
    notifications,
    opened,
    networkCalls,
    matchAllOptions,
    dispatch,
    push,
    click,
  };
}

describe('PUSH 122 (Service Worker): Anzeige und notificationclick', () => {
  it('122b. Push-Ereignis zeigt nur Titel/Text/Tag der datenminimierten Nutzlast; fremde, absolute, protokollrelative und Skript-URLs werden zu „/“; kein Netz-/Cache-Zugriff', async () => {
    const worker = loadServiceWorker();
    expect([...worker.listeners.keys()]).toEqual(
      expect.arrayContaining(['push', 'notificationclick']),
    );
    await worker.push({
      kind: 'appointment_1h',
      title: 'Termin in 1 Stunde',
      body: 'Abholung MR-2026-0001',
      url: PROCESS_PATH,
      tag: 'appointment-1h:x:pickup',
      // Unerwartete Zusatzfelder werden nie angezeigt.
      customerName: 'Klara Kommerz',
    });
    expect(worker.notifications).toHaveLength(1);
    const shown = worker.notifications[0]!;
    expect(shown.title).toBe('Termin in 1 Stunde');
    expect(shown.options).toMatchObject({
      body: 'Abholung MR-2026-0001',
      tag: 'appointment-1h:x:pickup',
      data: { url: PROCESS_PATH },
    });
    expect(JSON.stringify(shown)).not.toContain('Klara');

    const hostile: unknown[] = [
      'https://evil.example/phish',
      '//evil.example/x',
      '/\\evil.example/x',
      'javascript:alert(1)',
      'mailto:kunde@example.org',
      42,
      undefined,
    ];
    for (const url of hostile) {
      await worker.push({ title: 'Rückgabe überfällig', body: 'MR-2026-0001', url });
    }
    expect(
      worker.notifications.slice(1).map((n) => (n.options.data as { url: string }).url),
    ).toEqual(hostile.map(() => '/'));
    // Gleiche Origin: nur Pfad + Query, kein Fragment.
    await worker.push({ title: 'x', url: '/vorgaenge?filter=heute#oben' });
    expect((worker.notifications.at(-1)!.options.data as { url: string }).url).toBe(
      '/vorgaenge?filter=heute',
    );
    // Unlesbare oder titellose Nutzlast ⇒ keine Anzeige.
    const before = worker.notifications.length;
    await worker.push(null, true);
    await worker.push({ body: 'ohne Titel', url: PROCESS_PATH });
    await worker.push('kein Objekt');
    await worker.dispatch('push', {});
    expect(worker.notifications).toHaveLength(before);
    // Der Worker ruft weder Netz noch Cache auf (keine API, kein Caching von Push-Daten).
    expect(worker.networkCalls).toEqual([]);
  });

  it('122c. notificationclick schließt die Benachrichtigung und öffnet die Staff-Seite: vorhandenes Fenster mit gleicher URL fokussieren, sonst ein Fenster navigieren; ohne Fenster oder bei Navigationsfehler neues Fenster – immer nur Staff-Origin', async () => {
    // (a) Fenster mit genau dieser URL ⇒ nur fokussieren.
    const same = fakeWindow(`${ORIGIN}${PROCESS_PATH}`);
    const a = loadServiceWorker([same]);
    expect(await a.click(PROCESS_PATH)).toBe(1);
    expect(same.focusCalls).toBe(1);
    expect(same.navigations).toEqual([]);
    expect(a.opened).toEqual([]);
    expect(a.matchAllOptions).toEqual([{ type: 'window', includeUncontrolled: true }]);

    // (b) anderes Staff-Fenster ⇒ fokussieren + dorthin navigieren.
    const other = fakeWindow(`${ORIGIN}/`);
    const b = loadServiceWorker([other]);
    await b.click(PROCESS_PATH);
    expect(other.focusCalls).toBe(1);
    expect(other.navigations).toEqual([`${ORIGIN}${PROCESS_PATH}`]);
    expect(b.opened).toEqual([]);

    // (c) kein Fenster ⇒ neues Fenster auf der Staff-Seite.
    const c = loadServiceWorker([]);
    expect(await c.click(PROCESS_PATH)).toBe(1);
    expect(c.opened).toEqual([`${ORIGIN}${PROCESS_PATH}`]);

    // (d) navigate() wirft (nicht kontrollierter Client) ⇒ neues Fenster statt Abbruch.
    const uncontrolled = fakeWindow(`${ORIGIN}/kalender`, { navigateFails: true });
    const d = loadServiceWorker([uncontrolled]);
    await d.click('/mitarbeiter');
    expect(d.opened).toEqual([`${ORIGIN}/mitarbeiter`]);

    // (e) manipulierte URL in den Notification-Daten ⇒ Startseite der Staff-App, nie fremd.
    const e = loadServiceWorker([]);
    for (const url of ['https://evil.example/x', '//evil.example', 'javascript:alert(1)', null]) {
      await e.click(url);
    }
    expect(e.opened).toEqual([`${ORIGIN}/`, `${ORIGIN}/`, `${ORIGIN}/`, `${ORIGIN}/`]);
    expect([...a.networkCalls, ...b.networkCalls, ...c.networkCalls, ...e.networkCalls]).toEqual(
      [],
    );
  });
});
