/**
 * Phase-13-E2E-Szenario O (Order §82) – Demo-Routing: gegen die Demo-API
 * (Projekt `demo-communication`, APP_ENV=demo, eigene Datenbank
 * `mietroyal_test_demo`). Die Demo bekommt KEINEN GraphHopper-Key und keine
 * Base-URL (playwright.config.ts) und nutzt daher immer den Mock:
 * - Routenvorschlag/Übernahme liefern `provider: 'mock'`, die Tour-View
 *   `routeProvider: 'mock'` – die Staff-UI zeigt dafür „Simulation (Demo)“
 *   (apps/staff/lib/tours.ts `providerLabel` ⇒ `route-simulation`). Das Demo-
 *   Projekt hat keine eigene Staff-Instanz; die UI-Kennzeichnung wird hier
 *   über den Provider-Wert der API geprüft, im Projekt `chromium` prüft
 *   tours-flow.spec.ts (A), dass beim echten Provider-Pfad KEIN
 *   `route-simulation` erscheint.
 * - Der GraphHopper-Contract-Fake (HTTPS 4567) zeichnet während des gesamten
 *   Demo-Laufs KEINE Anfrage auf (kein echter/externer Aufruf aus der Demo).
 *
 * Reine API-Tests (Node-fetch mit Session-Cookie, Muster communication-demo.spec.ts);
 * Buchung/Termin über apps/api/scripts/e2e-tours-seed.ts gegen die Demo-Datenbank.
 *
 * Zeit (Phase 14): Das Fenster liegt HEUTE relativ zu jetzt (`todayWindow`, helpers/
 * tours.ts: auf den Berliner Tag geklemmt, ≥ 15 min, bei knappem Resttag gestaucht).
 * Sperrfenster: Lauf NICHT zwischen 23:38 und 00:02 Uhr Berlin starten („Resttag zu kurz“).
 */
import { expect, test } from '@playwright/test';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  DEMO_API_ORIGIN,
  DEMO_DATABASE_URL,
} from '../helpers/demo-env.ts';
import { resetRoutingFake, routingRequests } from '../helpers/routing.ts';
import { seedTours, todayWindow, type ToursSeedResult } from '../helpers/tours.ts';
import { demoApiLogin } from '../helpers/training.ts';

test.describe.configure({ mode: 'serial' });

let cookie = '';
let seed: ToursSeedResult;

async function demo<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const response = await fetch(`${DEMO_API_ORIGIN}${path}`, {
    method,
    headers: {
      connection: 'close',
      ...(cookie === '' ? {} : { cookie }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: response.status, data: data as T };
}

test.beforeAll(async () => {
  await resetRoutingFake();
  const health = await demo<{ environment: string }>('GET', '/health');
  expect(health.data.environment).toBe('demo');
  // Phase 15: Vorangehende Demo-Specs (u. a. portal-demo) melden denselben Demo-Admin an; das
  // Login-Limit (10 je Minute je IP + E-Mail) gilt auch hier ⇒ 429-toleranter Helfer (wartet
  // `retry-after` ab, wie die Training-Specs seit Phase 14).
  cookie = await demoApiLogin(DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD);
  const o1Window = todayWindow(90, 150);
  seed = seedTours(
    {
      adminEmail: DEMO_ADMIN_EMAIL,
      depotAddress: 'Robert-Koch-Straße 1, 55129 Mainz',
      bookings: [
        {
          key: 'o1',
          customer: { firstName: 'Olga', lastName: 'Ortsmuster' },
          outbound: {
            startAt: o1Window.startAt.toISOString(),
            endAt: o1Window.endAt.toISOString(),
          },
        },
      ],
    },
    DEMO_DATABASE_URL,
  );
});

test('O Demo: Routing nur simuliert (Mock), kein Aufruf des Provider-Fakes, als „Simulation (Demo)“ markiert', async () => {
  test.setTimeout(120_000);
  const booking = seed.bookings.o1!;
  const adminId = seed.users.admin!.id;
  const tourDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });

  const created = await demo<{ tour: { id: string; version: number } }>('POST', '/staff/tours', {
    tourDate,
    assignedUserId: adminId,
  });
  expect(created.status).toBe(200);
  const tourId = created.data.tour.id;
  const added = await demo<{ tour: { id: string; version: number } }>(
    'POST',
    `/staff/tours/${tourId}/stops`,
    { appointmentId: booking.outbound.id },
  );
  expect(added.status).toBe(200);

  const proposed = await demo<{
    status: string;
    version: number;
    plan: { provider: string; order: string[]; feasible: boolean; totalDistanceMeters: number };
    reasons?: unknown[];
  }>('POST', `/staff/tours/${tourId}/plan/propose`, {});
  expect(proposed.status, JSON.stringify(proposed.data)).toBe(200);
  expect(proposed.data.status).toBe('ok');
  expect(proposed.data.plan.provider).toBe('mock');
  expect(proposed.data.plan.feasible).toBe(true);
  expect(proposed.data.plan.totalDistanceMeters).toBeGreaterThan(0);

  const applied = await demo<{
    tour: { routeProvider: string | null; planningStatus: string };
    plan: { provider: string };
  }>('POST', `/staff/tours/${tourId}/plan/apply`, {
    expectedVersion: proposed.data.version,
    order: proposed.data.plan.order,
  });
  expect(applied.status, JSON.stringify(applied.data)).toBe(200);
  expect(applied.data.plan.provider).toBe('mock');
  expect(applied.data.tour.routeProvider).toBe('mock');
  expect(applied.data.tour.planningStatus).toBe('planned');

  // Staff-UI-Kennzeichnung: `providerLabel('mock')` ⇒ „Simulation (Demo)“ (RouteAttribution,
  // data-testid route-simulation) – der Provider-Wert der Demo-API ist genau dieser Mock.
  expect(['mock', 'fake']).toContain(applied.data.tour.routeProvider);

  // Kein einziger Request hat den GraphHopper-Fake erreicht (Demo ruft nie einen Provider).
  expect(await routingRequests()).toHaveLength(0);
  // Kein Key in der Antwort der Demo-API.
  expect(JSON.stringify(applied.data)).not.toMatch(/key=|apiKey|GRAPHHOPPER/i);
});
