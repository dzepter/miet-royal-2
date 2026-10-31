import { loadConfig, type AppConfig } from '@mietroyal/config';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppOptions } from '../src/app.ts';
import type { TestContext } from './auth-helpers.ts';

/**
 * Phase 14 (training gate): zweite App einer anderen Umgebung auf DEMSELBEN
 * Pool/Storage wie der Testkontext (Verallgemeinerung des `withEnvApp`-Musters
 * aus auth-device-identity / accounting-transfer Test 145). Die `auth`-
 * Konfiguration (Secret) wird vom Kontext übernommen, damit Session-Cookies
 * zwischen den Apps austauschbar sind (gleiche Datenbank, gleiches Secret).
 * Außerhalb development verlangt `loadConfig` die sicherheitsrelevanten
 * Variablen – hier mit festen Testwerten (nie Live-Werte).
 */

export type EnvAppEnvironment = AppConfig['appEnv'];

export const ENV_APP_AUTH_SECRET_KEY = '1'.repeat(64);
export const ENV_APP_COMMUNICATION_PAYLOAD_KEY = 'c1'.repeat(32);

export function envAppConfig(
  ctx: TestContext,
  appEnv: EnvAppEnvironment,
  extraEnv: Record<string, string> = {},
): AppConfig {
  const config = loadConfig({
    APP_ENV: appEnv,
    DATABASE_URL: ctx.config.databaseUrl,
    LOG_LEVEL: 'error',
    ...(appEnv === 'development'
      ? {}
      : {
          AUTH_SECRET_KEY: ENV_APP_AUTH_SECRET_KEY,
          COMMUNICATION_PAYLOAD_KEY: ENV_APP_COMMUNICATION_PAYLOAD_KEY,
          STORAGE_DRIVER: 'fs',
          STORAGE_FS_ROOT:
            ctx.config.storage.driver === 'fs' ? ctx.config.storage.fsRoot : '/tmp/x',
        }),
    ...extraEnv,
  });
  if (config.appEnv !== appEnv) throw new Error(`Umgebung ${appEnv} nicht geladen`);
  return { ...config, auth: ctx.config.auth };
}

export interface EnvAppOptions {
  /** Zusätzliche Umgebungsvariablen für loadConfig (z. B. VAPID-Schlüssel). */
  extraEnv?: Record<string, string>;
  /** Weitere buildApp-Optionen (Default: Mail-Adapter, Storage und Queue des Kontexts, keine Rate-Limits). */
  app?: Partial<Omit<AppOptions, 'config' | 'pool'>>;
}

/** Nicht-gestartete App der Umgebung (Aufrufer ruft `ready()`/`close()`). */
export function buildEnvApp(
  ctx: TestContext,
  appEnv: EnvAppEnvironment,
  options: EnvAppOptions = {},
): FastifyInstance {
  return buildApp({
    config: envAppConfig(ctx, appEnv, options.extraEnv),
    pool: ctx.pool,
    mailAdapter: ctx.mail,
    rateLimitEnabled: false,
    storage: ctx.storage,
    jobQueue: ctx.queue,
    ...options.app,
  });
}

/** Bereite App der Umgebung – Aufrufer schließt sie (`app.close()`). */
export async function createEnvApp(
  ctx: TestContext,
  appEnv: EnvAppEnvironment,
  options: EnvAppOptions = {},
): Promise<FastifyInstance> {
  const app = buildEnvApp(ctx, appEnv, options);
  await app.ready();
  return app;
}

/** App der Umgebung für die Dauer von `run` (Muster `withEnvApp` der Phase-12-Tests). */
export async function withEnvApp<T>(
  ctx: TestContext,
  appEnv: EnvAppEnvironment,
  run: (app: FastifyInstance) => Promise<T>,
  options: EnvAppOptions = {},
): Promise<T> {
  const app = await createEnvApp(ctx, appEnv, options);
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}
