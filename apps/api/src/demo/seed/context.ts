import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import type { ProcessVisibilityContext } from '../../crm/visibility.ts';
import type { DemoSeedRegistry } from '../registry.ts';
import type { DemoSeedServices } from './services.ts';
import type { DemoClock } from './time.ts';

/**
 * Phase 14 (Design §2): Kontext eines Seed-Szenarios. Szenarien sind reine
 * Funktionen `(ctx) => Promise<void>`, laufen ausschließlich über die
 * Fachservices in `ctx.services` (nie INSERT in Business-Tabellen) und
 * registrieren ihre Entitäten über `ctx.register(seedKey, entityType, id)`.
 */
export interface DemoSeedContext {
  db: Database;
  config: AppConfig;
  services: DemoSeedServices;
  /** Injizierbares „jetzt“ (Order §12) – alle Zeiten relativ dazu. */
  now: Date;
  /** Berliner Zeit-Helfer auf Basis von `now`. */
  clock: DemoClock;
  /** Fachaktor des Seeds: ein bestehender, aktiver Systemadmin der Demo-DB (nie angelegt). */
  actorId: string;
  /** Effektive Rechte des Fachaktors (Systemadmin ⇒ alle Katalogrechte). */
  effective: ReadonlySet<PermissionKey>;
  /** Sichtbarkeitskontext des Fachaktors für Vorgangs-Mutationen. */
  visibility: ProcessVisibilityContext;
  registry: DemoSeedRegistry;
  datasetVersion: number;
  register(seedKey: string, entityType: string, entityId: string): Promise<void>;
  /** Entity-ID eines zuvor registrierten Schlüssels (Szenarien bauen aufeinander auf). */
  resolve(seedKey: string): Promise<string>;
}

export interface DemoScenario {
  /** Sprechender Name für Logs/Berichte (nie Inhalte). */
  name: string;
  run(ctx: DemoSeedContext): Promise<void>;
}
