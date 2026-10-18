/**
 * Service Worker der Staff-PWA (Phase-8-Order §§3, 4, 70–72, 80).
 *
 * Reiner Cache-/Lifecycle-Worker ohne Fachlogik:
 * - `/_next/static/*`: cache-first (gehashte, unveränderliche Assets)
 * - Manifest, Icons, Schemata (`/sketches/*`), Fonts: stale-while-revalidate
 * - Navigationen (HTML-Shells): network-first mit Timeout, Fallback auf die
 *   gecachte Seite bzw. die Startseite; RSC-Payloads bereits besuchter Routen
 * - `/api/*` wird NIE abgefangen oder gecacht (Fachdaten, PDFs, Fotos,
 *   Unterschriften laufen ausschließlich über den verschlüsselten Store).
 * - Kein automatisches `skipWaiting`: Aktivierung nur per Nachricht nach
 *   Nutzerklick (§72). SW_VERSION bei Änderungen der Cache-Strategie erhöhen.
 * - Flüchtiger Sitzungsschlüssel (SET_KEY/GET_KEY/TOUCH_KEY/CLEAR_KEY): nur im
 *   Arbeitsspeicher dieses Workers, 15-Minuten-TTL ohne Aktivität, nie in
 *   Cache Storage/IndexedDB.
 */
const SW_VERSION = 'v3';
const SHELL_CACHE = `mr-shell-${SW_VERSION}`;
const STATIC_CACHE = `mr-static-${SW_VERSION}`;
const PAGES_CACHE = `mr-pages-${SW_VERSION}`;
const KNOWN_CACHES = [SHELL_CACHE, STATIC_CACHE, PAGES_CACHE];

const NAVIGATION_TIMEOUT_MS = 6_000;
const SESSION_KEY_TTL_MS = 15 * 60 * 1000;

/** App-Shell-Einträge, die bei der Installation vorab geladen werden (nur statisch, keine Fachdaten). */
const SHELL_URLS = [
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
];

let sessionKey = null;
let sessionKeyAt = 0;

function isApi(url) {
  return url.pathname === '/api' || url.pathname.startsWith('/api/');
}

function isNextStatic(url) {
  return url.pathname.startsWith('/_next/static/');
}

function isStaticAsset(url) {
  return (
    url.pathname === '/manifest.webmanifest' ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/sketches/') ||
    /\.(?:woff2?|ttf|otf|svg|png|ico)$/.test(url.pathname)
  );
}

function isRscRequest(request, url) {
  return request.headers.get('RSC') === '1' || url.searchParams.has('_rsc');
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  if (cached) {
    // Hintergrund-Aktualisierung, ohne auf das Netz zu warten.
    void network;
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;
  return Response.error();
}

/** QR-Deep-Link (`/qr/<token>`): trägt den Rohtoken im Pfad – nie im Seitencache ablegen. */
function isQrDeepLink(url) {
  return url.pathname.startsWith('/qr/');
}

async function networkFirstPage(request, url) {
  const cache = await caches.open(PAGES_CACHE);
  try {
    const response = await withTimeout(fetch(request), NAVIGATION_TIMEOUT_MS);
    if (response.ok && response.type === 'basic' && !isQrDeepLink(url))
      await cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: !isRscRequest(request, url) });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      // Letzter Ausweg: die Startseite – der AuthGuard startet daraus den
      // Offline-Arbeitsbereich (die Route selbst lädt clientseitig).
      const home = await cache.match('/', { ignoreSearch: true });
      if (home) return home;
    }
    return Response.error();
  }
}

const RECORD_ID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function clearIdentifiedPages() {
  const cache = await caches.open(PAGES_CACHE);
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((request) => {
        const pathname = new URL(request.url).pathname;
        return RECORD_ID_PATTERN.test(pathname) || pathname.startsWith('/qr/');
      })
      .map((request) => cache.delete(request)),
  );
}

/** Seiten-Shells vorab cachen – nur HTML derselben Origin, nie /api (§4). */
async function prefetchPages(urls) {
  const cache = await caches.open(PAGES_CACHE);
  for (const raw of urls) {
    let url;
    try {
      url = new URL(String(raw), self.location.origin);
    } catch {
      continue;
    }
    if (url.origin !== self.location.origin || isApi(url)) continue;
    try {
      const response = await fetch(url.href, { credentials: 'same-origin' });
      const type = response.headers.get('content-type') || '';
      if (response.ok && response.type === 'basic' && type.startsWith('text/html')) {
        await cache.put(url.href, response);
      }
    } catch {
      // Offline/Fehler: nächste URL.
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      for (const url of SHELL_URLS) {
        try {
          await cache.add(url);
        } catch {
          // Fehlendes Asset blockiert die Installation nicht.
        }
      }
      // KEIN skipWaiting: die neue Version wartet, bis der Nutzer sie aktiviert (§72).
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => !KNOWN_CACHES.includes(key)).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Fachdaten/Sitzung: niemals abfangen, niemals cachen.
  if (isApi(url)) return;
  if (isNextStatic(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }
  if (isStaticAsset(url)) {
    event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    return;
  }
  if (request.mode === 'navigate' || isRscRequest(request, url)) {
    event.respondWith(networkFirstPage(request, url));
  }
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data.type !== 'string') return;
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'PREFETCH_PAGES' && Array.isArray(data.urls)) {
    event.waitUntil(prefetchPages(data.urls));
  }
  if (data.type === 'SET_KEY') {
    // Nur echte CryptoKey-Objekte (structured clone) – nie Rohbytes/Strings.
    sessionKey = data.key instanceof CryptoKey ? data.key : null;
    sessionKeyAt = sessionKey === null ? 0 : Date.now();
  }
  if (data.type === 'TOUCH_KEY' && sessionKey !== null) {
    sessionKeyAt = Date.now();
  }
  if (data.type === 'CLEAR_KEY') {
    sessionKey = null;
    sessionKeyAt = 0;
  }
  if (data.type === 'CLEAR_PAGES') {
    // Abmeldung/Wipe: vorab gecachte Seiten-Shells mit Datensatz-IDs (ihre URLs verraten
    // Vorgangs-/Maschinen-IDs) für den nächsten Nutzer entfernen. Die ID-freien Shells
    // (Startseite, Listen) bleiben, damit die App offline weiterhin startet.
    event.waitUntil(clearIdentifiedPages());
  }
  if (data.type === 'GET_KEY' && event.ports && event.ports[0]) {
    if (sessionKey !== null && Date.now() - sessionKeyAt > SESSION_KEY_TTL_MS) {
      sessionKey = null;
      sessionKeyAt = 0;
    }
    event.ports[0].postMessage({ key: sessionKey });
  }
});

// ── Phase 12 (push): Web Push (Order §§29–31) ────────────────────────────────
// Reine Anzeige: die Nutzlast kommt datenminimiert vom Server ({kind, title,
// body, url, tag}); der Worker interpretiert nichts, cacht nichts und ruft
// keine API auf. Offline-/Cache-Logik oben bleibt unverändert.

function readPushPayload(event) {
  if (!event.data) return null;
  try {
    const data = event.data.json();
    if (!data || typeof data !== 'object' || typeof data.title !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

/** Nur relative Staff-Pfade derselben Origin öffnen (nie fremde URLs aus einer Nachricht). */
function safeNotificationUrl(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  try {
    const url = new URL(raw, self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  const data = readPushPayload(event);
  if (data === null) return;
  const url = safeNotificationUrl(data.url);
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeNotificationUrl(event.notification.data && event.notification.data.url);
  const target = new URL(url, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      const anyWindow = windows.find((client) => 'navigate' in client && 'focus' in client);
      if (anyWindow) {
        try {
          await anyWindow.focus();
          return await anyWindow.navigate(target);
        } catch {
          // Phase 12 Härtung: navigate() wirft bei nicht kontrollierten Clients
          // (includeUncontrolled) ⇒ stattdessen ein neues Fenster öffnen.
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
