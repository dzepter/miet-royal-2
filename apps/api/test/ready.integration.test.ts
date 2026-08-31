/**
 * Integrationstest: API + echte Datenbank (infra/docker-compose.yml).
 * Beweist DB-Konnektivität für den Smoke-Test aus PHASE_00_FOUNDATION.md.
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool, runMigrations } from '@mietroyal/database';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://mietroyal:mietroyal_local_dev@localhost:55432/mietroyal_test';

const config = loadConfig({
  APP_ENV: 'development',
  DATABASE_URL: TEST_DATABASE_URL,
  LOG_LEVEL: 'error',
});

let pool: pg.Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool(config.databaseUrl);
  await runMigrations(createDb(pool));
  app = buildApp({ config, pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('GET /ready mit echter Datenbank', () => {
  it('antwortet 200, wenn die Datenbank erreichbar ist', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ready');
  });
});

describe('GET /ready bei nicht erreichbarer Datenbank', () => {
  it('antwortet 503 mit strukturiertem Fehler', async () => {
    const brokenPool = createPool('postgresql://mietroyal:falsch@localhost:59999/keine_db');
    const brokenApp = buildApp({ config, pool: brokenPool });
    try {
      const response = await brokenApp.inject({ method: 'GET', url: '/ready' });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('DATABASE_UNAVAILABLE');
    } finally {
      await brokenApp.close();
      await brokenPool.end();
    }
  });
});
