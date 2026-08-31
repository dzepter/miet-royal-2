import { expect, test } from '@playwright/test';

const API_BASE = 'http://127.0.0.1:3101';

test('Web-Shell rendert die neutrale Startseite', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Miet-Royal 2.0' })).toBeVisible();
  await expect(page.getByText('Web-App läuft.')).toBeVisible();
});

test('API-Healthcheck antwortet strukturiert', async ({ request }) => {
  const response = await request.get(`${API_BASE}/health`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.status).toBe('ok');
  expect(body.environment).toBe('development');
});

test('API liefert strukturierte 404 mit Correlation-ID', async ({ request }) => {
  const response = await request.get(`${API_BASE}/unbekannte-route`);
  expect(response.status()).toBe(404);
  const body = await response.json();
  expect(body.error.code).toBe('NOT_FOUND');
  expect(response.headers()['x-correlation-id']).toBeTruthy();
});
