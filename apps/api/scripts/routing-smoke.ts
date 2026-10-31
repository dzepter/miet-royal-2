/**
 * Manueller Live-Smoke gegen die GraphHopper Directions API (Order §71):
 * nur mit ROUTING_SMOKE=1, nie automatisch, nie in production, nie im
 * Quality Gate. Führt GENAU EINE Geocoding-Anfrage (0,9 Credits, provider
 * nominatim) und EINE Routenberechnung (1 Credit) mit einer festen,
 * öffentlichen Testadresse aus – keine Kundendaten. Ausgabe: Status, Dauer,
 * Credits je Request und Rate-Limit-Stand; NIE der Key, NIE die URL.
 *
 * Aufruf (development/staging mit Opt-in):
 *   ROUTING_SMOKE=1 APP_ENV=development ROUTING_ENABLED=true ROUTING_PROVIDER=graphhopper \
 *   GRAPHHOPPER_API_KEY=… pnpm routing:smoke
 */
import { loadConfig } from '@mietroyal/config';
import { createRoutingGateway } from '../src/routing/factory.ts';
import { RoutingError } from '../src/routing/types.ts';

if (process.env.ROUTING_SMOKE !== '1') {
  console.error('Smoke-Test nur mit ROUTING_SMOKE=1 (bewusster manueller Aufruf).');
  process.exit(2);
}
const config = loadConfig();
if (config.appEnv === 'production') {
  console.error('Smoke-Test ist in production nicht zulässig.');
  process.exit(2);
}
if (config.routing.provider !== 'graphhopper') {
  console.error(
    `Routing ist in APP_ENV=${config.appEnv} nicht auf graphhopper konfiguriert (provider=${config.routing.provider}).`,
  );
  process.exit(2);
}

/** Nur die neutralen Felder des Gateway-Logs (endpoint, status, outcome, durationMs, credits). */
const logger = {
  info(obj: Record<string, unknown>, msg: string) {
    console.log(`  ${msg}: ${JSON.stringify(obj.routing ?? {})}`);
  },
  warn(obj: Record<string, unknown>, msg: string) {
    console.warn(`  ${msg}: ${JSON.stringify(obj.routing ?? {})}`);
  },
};

// Feste, öffentliche Testadresse (keine Kundendaten): Mainzer Rathaus.
const TEST_ADDRESS = 'Jockel-Fuchs-Platz 1, 55116 Mainz';
// Zwei feste Koordinaten (Mainz Hbf → Wiesbaden Hbf), lon/lat-unabhängig vom Geocoding.
const ROUTE_FROM = { latitude: 50.0011, longitude: 8.2588 };
const ROUTE_TO = { latitude: 50.0706, longitude: 8.2437 };

const gateway = createRoutingGateway(config, logger);
console.log(
  `Routing-Smoke (APP_ENV=${config.appEnv}, provider=${gateway.providerName}, Timeout ${config.routing.graphhopper.requestTimeoutMs} ms) – 1× geocode, 1× route`,
);
let exitCode = 0;
try {
  const geocode = await gateway.geocode({
    query: `${TEST_ADDRESS}, Deutschland`,
    limit: 3,
    locale: 'de',
  });
  console.log(`  Geocode-Treffer: ${geocode.candidates.length}`);
  for (const candidate of geocode.candidates) {
    console.log(
      `    ${candidate.label} (${candidate.point.latitude.toFixed(4)}, ${candidate.point.longitude.toFixed(4)})`,
    );
  }
  const route = await gateway.route({ points: [ROUTE_FROM, ROUTE_TO] });
  console.log(
    `  Route: ${(route.distanceMeters / 1000).toFixed(1)} km, ${Math.round(route.durationSeconds / 60)} min`,
  );
  console.log('Smoke-Test abgeschlossen.');
} catch (error) {
  console.error(
    `Smoke-Test fehlgeschlagen: ${error instanceof RoutingError ? `${error.code} (status ${error.status ?? '–'})` : 'Fehler'}`,
  );
  exitCode = 1;
}
process.exit(exitCode);
