import { expect, test } from '@playwright/test';

const API_BASE = 'http://127.0.0.1:3101';
const WEB_BASE = 'http://127.0.0.1:3100';

// Phase 16 (WEB): die technische Phase-0-Seite ist ersetzt. Die Startseite zeigt entweder den
// veröffentlichten CMS-Inhalt oder – ohne veröffentlichten Inhalt (frische Datenbank) – den
// schlichten Fallback; beides mit Website-Navigation und dem dominanten CTA „Slush konfigurieren“.
test('Web-Startseite rendert (veröffentlichter Inhalt ODER Fallback) mit Navigation und Slush-CTA', async ({
  page,
}) => {
  const response = await page.goto(`${WEB_BASE}/`);
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId('site-header')).toBeVisible();
  await expect(page.getByTestId('site-brand')).toBeVisible();

  const cta = page.getByTestId('site-cta-configure');
  await expect(cta).toBeVisible();
  await expect(cta).toHaveText('Slush konfigurieren');
  await expect(cta).toHaveAttribute('href', '/konfigurator');
  await expect(
    page.getByTestId('site-nav').getByRole('link', { name: 'Kundenbereich' }),
  ).toHaveAttribute('href', '/konto');

  const fallback = page.getByTestId('site-fallback-home');
  const published = page.getByTestId('cms-page');
  await expect(fallback.or(published)).toBeVisible();
  await expect(page.locator('h1')).toHaveCount(1);
  if (await fallback.isVisible()) {
    await expect(fallback).toContainText('Unsere neue Website wird gerade vorbereitet.');
  }
  await expect(page.getByTestId('site-footer')).toBeVisible();
  await expect(page.getByText('Web-App läuft.')).toHaveCount(0);
  await expect(page.getByText(/verbindlich buchen/i)).toHaveCount(0);
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
