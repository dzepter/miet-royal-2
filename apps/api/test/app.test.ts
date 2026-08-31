import { loadConfig } from '@mietroyal/config';
import { parseOrThrow, z } from '@mietroyal/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';

const config = loadConfig({ APP_ENV: 'development', LOG_LEVEL: 'error' });

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp({ config });

  // Testrouten beweisen die Validierungs- und Fehlerbehandlungs-Grundlage,
  // ohne Dummy-Endpunkte in den Produktivcode zu legen.
  app.post('/test/validated', async (request) => {
    const body = parseOrThrow(
      z.object({ name: z.string().min(1), guests: z.number().int().positive() }),
      request.body,
    );
    return { received: body.name };
  });
  app.get('/test/broken', async () => {
    throw new Error('geheime interne Details: /var/lib/secret');
  });

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('antwortet mit ok, Version und Umgebung', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.environment).toBe('development');
    expect(typeof body.version).toBe('string');
  });

  it('vergibt eine Correlation-ID', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-correlation-id']).toMatch(/[A-Za-z0-9-]{8,}/);
  });

  it('übernimmt eine gültige eingehende Correlation-ID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'test-correlation-123' },
    });
    expect(response.headers['x-correlation-id']).toBe('test-correlation-123');
  });

  it('ersetzt eine ungültige eingehende Correlation-ID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'böse;header<script>' },
    });
    expect(response.headers['x-correlation-id']).not.toContain('script');
    expect(response.headers['x-correlation-id']).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

describe('GET /ready ohne Datenbank', () => {
  it('antwortet 503 mit strukturiertem Fehler', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('DATABASE_UNAVAILABLE');
  });
});

describe('Fehlerform', () => {
  it('unbekannte Route → strukturierte 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/gibt-es-nicht' });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.error.correlationId).toBe('string');
  });

  it('Validierungsfehler → 400 mit Feldpfaden, ohne Eingabewerte', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/validated',
      payload: { name: '', guests: 'zwölf' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.issues.map((i: { path: string }) => i.path)).toContain('body.guests');
    expect(response.body).not.toContain('zwölf');
  });

  it('gültige Eingabe wird verarbeitet', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/validated',
      payload: { name: 'Sommerfest', guests: 80 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().received).toBe('Sommerfest');
  });

  it('interner Fehler → 500 ohne Stacktrace und ohne interne Details', async () => {
    const response = await app.inject({ method: 'GET', url: '/test/broken' });
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(response.body).not.toContain('geheime interne Details');
    expect(response.body).not.toContain('/var/lib/secret');
    expect(response.body).not.toContain('at '); // kein Stacktrace
  });

  it('ungültiges JSON → 400 strukturiert', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/test/validated',
      payload: '{kaputt',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.correlationId).toBeDefined();
  });
});
