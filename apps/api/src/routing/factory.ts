/**
 * Phase 13 (Order §5/§6, Design §2): Fabrik der Routing-Grenze nach
 * `config.routing` – genau eine Instanz je Prozess (API bzw. Worker).
 *
 * - graphhopper ⇒ GraphHopperRoutingGateway (echter Provider, Key nur hier).
 * - mock ⇒ MockRoutingGateway (demo/development) – in production verweigert
 *   die Fabrik hart, einen Mock/Fake zu erzeugen (die Konfiguration lehnt das
 *   bereits ab; hier die zweite Sperre).
 * - disabled ⇒ DisabledRoutingGateway (jede Anfrage ROUTING_DISABLED).
 * Ein einmaliger Start-Log nennt nur den Provider – nie Key oder URL.
 */
import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import {
  PostgresIntegrationRateLimiter,
  type IntegrationRateLimiter,
} from '../integrations/rate-limiter.ts';
import { DisabledRoutingGateway, MockRoutingGateway } from './fake.ts';
import {
  GRAPHHOPPER_MIN_INTERVAL_MS,
  GraphHopperRoutingGateway,
  type RoutingLogger,
} from './graphhopper.ts';
import type { RoutingGateway } from './types.ts';

export type { RoutingLogger } from './graphhopper.ts';

export const GRAPHHOPPER_RATE_LIMIT_PROVIDER = 'graphhopper';

/**
 * Phase 13 Final (§1): Abhängigkeiten der Fabrik. Für provider graphhopper
 * ist die GLOBALE Drossel Pflicht – entweder die Datenbank (⇒ Postgres-Limiter,
 * Zeile provider 'graphhopper', 1 Request/s je Umgebung) oder ein injizierter
 * Limiter (Tests). Mock/Fake/Disabled brauchen keinen Limiter.
 */
export interface RoutingGatewayDeps {
  db?: Database;
  limiter?: IntegrationRateLimiter;
}

export function createRoutingGateway(
  config: Pick<AppConfig, 'appEnv' | 'routing'>,
  logger?: RoutingLogger,
  deps: RoutingGatewayDeps = {},
): RoutingGateway {
  const routing = config.routing;
  let gateway: RoutingGateway;
  if (routing.provider === 'graphhopper') {
    if (routing.graphhopper.apiKey === null) {
      // Durch loadConfig nicht erreichbar (Key ⇔ provider graphhopper); fail-closed.
      gateway = new DisabledRoutingGateway();
    } else {
      const limiter =
        deps.limiter ??
        (deps.db === undefined
          ? null
          : new PostgresIntegrationRateLimiter(deps.db, {
              provider: GRAPHHOPPER_RATE_LIMIT_PROVIDER,
              environment: config.appEnv,
              intervalMs: GRAPHHOPPER_MIN_INTERVAL_MS,
            }));
      if (limiter === null) {
        // Nie eine nur prozesslokale Drossel im Betrieb (Auftrag §1: global je Umgebung).
        throw new Error(
          'Routing: GraphHopper braucht die globale Drossel (db oder limiter) – keine In-Process-Drossel.',
        );
      }
      gateway = new GraphHopperRoutingGateway({
        apiKey: routing.graphhopper.apiKey,
        baseUrl: routing.graphhopper.baseUrl,
        timeoutMs: routing.graphhopper.requestTimeoutMs,
        limiter,
        ...(logger === undefined ? {} : { logger }),
      });
    }
  } else if (routing.provider === 'mock') {
    if (config.appEnv === 'production') {
      throw new Error('Mock-Routing-Gateway ist in production nicht zulässig.');
    }
    gateway = new MockRoutingGateway();
  } else {
    gateway = new DisabledRoutingGateway();
  }
  if (gateway.kind === 'disabled' && config.appEnv === 'production') {
    logger?.warn(
      { routing: { provider: gateway.kind } },
      'Routing nicht konfiguriert (kein GRAPHHOPPER_API_KEY) – Touren ohne Routenberechnung',
    );
  }
  logger?.info({ routing: { provider: gateway.kind } }, `Routing: provider=${gateway.kind}`);
  return gateway;
}
