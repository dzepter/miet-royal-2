import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { StorageProvider } from '@mietroyal/integrations';
import type { FastifyInstance } from 'fastify';
import type { StaffAuthService } from '../auth/service.ts';
import type { PortalSessionAuthenticator } from '../portal/guard.ts';
import { registerWebsiteCmsRoutes } from '../routes/website-cms.ts'; // Phase 16 (CMS)
import { registerPublicConfiguratorRoutes } from '../routes/public-configurator.ts'; // Phase 16 (PUBLIC)
import { registerPublicReviewRoutes } from '../routes/public-reviews.ts'; // Phase 16 (REVIEWS)

/**
 * Phase 16 (Website + CMS + Konfigurator): einziger Einhängepunkt aller neuen
 * Routen. app.ts ruft nur `registerWebsiteModule(instance, deps)`; die Teile
 * registrieren hier ihre Routen:
 * - CMS: `/staff/cms/*` (Redaktion, Medien, Vorschau-Zugang, Veröffentlichen) und
 *   `/public/site/*`, `/public/cms/*` (veröffentlichte Inhalte, Medien, Vorschau);
 * - PUBLIC: `/public/configurator/*`, `/public/inquiries`, Staff-Hinweis zur
 *   Website-Anfrage am Vorgang;
 * - REVIEWS: `/public/reviews` hinter dem ReviewGateway.
 *
 * In demo unterliegen `/public/*`- und `/staff/*`-Mutationen bereits Reset-Gate und
 * Barrier (reset-gate.ts). CMS-Tabellen überleben den Business-Reset.
 */
export interface WebsiteModuleDeps {
  db: Database;
  config: AppConfig;
  auth: StaffAuthService;
  storage: StorageProvider;
  logger: FastifyInstance['log'];
  /** Optionale Portal-Session (Kundenbindung einer Website-Anfrage, Order §16). */
  portalSessions: PortalSessionAuthenticator;
  /** Rate-Limits öffentlicher Mutationen (Default: aktiv, wenn @fastify/rate-limit registriert ist). */
  rateLimitEnabled?: boolean | undefined;
}

export function registerWebsiteModule(instance: FastifyInstance, deps: WebsiteModuleDeps): void {
  registerWebsiteCmsRoutes(instance, deps); // Phase 16 (CMS)
  registerPublicConfiguratorRoutes(instance, deps); // Phase 16 (PUBLIC)
  registerPublicReviewRoutes(instance, deps); // Phase 16 (REVIEWS)
}
