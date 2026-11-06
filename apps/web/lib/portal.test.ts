import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PORTAL_MESSAGES,
  PORTAL_UI,
  PortalApiError,
  PortalNetworkError,
  appointmentLabel,
  base64FromDataUrl,
  customerMessageFor,
  euro,
  formatAppointmentTime,
  formatDate,
  formatDateTime,
  formatEventTime,
  formatTime,
  groupItems,
  isReauthRequired,
  isUnauthenticated,
  navigationHref,
  navigationPlatform,
  portalDocumentHref,
  portalErrorMessage,
  portalFetch,
  readTokenFromHash,
  telHref,
  validatePhotoSelection,
  type PortalBookingItem,
} from './portal.ts';

/**
 * Phase 15 (Design §5, Web-Unit ohne Next/Browser): Formatierer (Europe/Berlin,
 * de-DE), Fehler-Mapping des Portal-Clients (nie rohe Codes, 429-Text,
 * same-origin + no-store), Fragment-Parsing des Magic-Link-Tokens und die
 * Navigations-Plattformwahl. Läuft mit `node --test` (pnpm test).
 */

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('Kundenportal – Formatierer (Phase 15, Design §5)', () => {
  it('W1. euro: Integer-Cent ⇒ „1.234,56 €“ inkl. Tausenderpunkt, Null und negativen Beträgen', () => {
    assert.equal(euro(123456), '1.234,56 €');
    assert.equal(euro(0), '0,00 €');
    assert.equal(euro(5), '0,05 €');
    assert.equal(euro(100), '1,00 €');
    assert.equal(euro(123456789), '1.234.567,89 €');
    assert.equal(euro(-1234), '-12,34 €');
  });

  it('W2. formatDate/formatTime/formatDateTime: Europe/Berlin, de-DE; Datum-only ohne Zeitzonenverschiebung; null ⇒ „–“', () => {
    assert.equal(formatDate('2026-10-18'), '18.10.2026');
    assert.equal(formatDate('2026-01-05'), '05.01.2026');
    // 2026-10-17T08:00Z = Samstag 10:00 MESZ (Sommerzeit)
    assert.equal(formatDate('2026-10-17T08:00:00.000Z'), '17.10.2026');
    assert.equal(formatTime('2026-10-18T08:00:00.000Z'), '10:00');
    assert.equal(formatDateTime('2026-10-17T08:00:00.000Z'), 'Samstag, 17.10.2026, 10:00 Uhr');
    // 2026-12-24T23:30Z = 25.12. 00:30 MEZ (Winterzeit, Tageswechsel)
    assert.equal(formatDateTime('2026-12-24T23:30:00.000Z'), 'Freitag, 25.12.2026, 00:30 Uhr');
    assert.equal(formatDate(null), '–');
    assert.equal(formatTime(null), '–');
    assert.equal(formatDateTime(undefined), '–');
    assert.equal(formatDate('kein-datum'), '–');
  });

  it('W3. formatAppointmentTime: exakt ⇒ Uhrzeit, Fenster ⇒ „10:00–12:00 Uhr“, ungeplant ⇒ feste Aussage (nie erfundene Zeit)', () => {
    assert.equal(
      formatAppointmentTime({
        timing: 'exact',
        startAt: '2026-10-17T08:00:00.000Z',
        endAt: null,
      }),
      'Samstag, 17.10.2026, 10:00 Uhr',
    );
    assert.equal(
      formatAppointmentTime({
        timing: 'window',
        startAt: '2026-10-17T08:00:00.000Z',
        endAt: '2026-10-17T10:00:00.000Z',
      }),
      'Samstag, 17.10.2026, 10:00–12:00 Uhr',
    );
    assert.equal(
      formatAppointmentTime({ timing: 'unplanned', startAt: null, endAt: null }),
      PORTAL_UI.APPOINTMENT_UNPLANNED,
    );
    assert.equal(
      formatAppointmentTime({ timing: 'exact', startAt: null, endAt: null }),
      PORTAL_UI.APPOINTMENT_UNPLANNED,
    );
    assert.equal(
      formatEventTime('2026-10-18T08:00:00.000Z', '2026-10-18T16:00:00.000Z'),
      '10:00–18:00 Uhr',
    );
    assert.equal(formatEventTime(null, null), null);
  });

  it('W4. Labels: Rückgabe heißt bei Lieferung „Rückholung“; Positionen nach Art gruppiert in fester Reihenfolge', () => {
    assert.equal(appointmentLabel('return', 'pickup'), 'Rückgabe');
    assert.equal(appointmentLabel('return', 'delivery'), 'Rückholung');
    assert.equal(appointmentLabel('pickup', 'pickup'), 'Abholung');
    assert.equal(appointmentLabel('delivery', 'delivery'), 'Lieferung');
    const item = (kind: PortalBookingItem['kind'], description: string): PortalBookingItem => ({
      kind,
      description,
      quantity: 1,
      unit: 'Stück',
      agreedUnitPriceCents: 1000,
      totalCents: 1000,
      billingMode: 'fixed',
    });
    const groups = groupItems([
      item('syrup', 'Sirup Kirsche'),
      item('machine', 'Slush-Maschine'),
      item('syrup', 'Sirup Cola'),
    ]);
    assert.deepEqual(
      groups.map((g) => [g.label, g.items.map((i) => i.description)]),
      [
        ['Maschinen', ['Slush-Maschine']],
        ['Sirup', ['Sirup Kirsche', 'Sirup Cola']],
      ],
    );
  });
});

describe('Kundenportal – Fehler-Mapping und Client (Phase 15, Design §5)', () => {
  it('W5. customerMessageFor: 429 ⇒ „Zu viele Versuche. Bitte warte einen Moment.“; PORTAL_*-Texte durchgereicht; Zod/5xx neutralisiert; nie der rohe Code', () => {
    assert.equal(
      customerMessageFor(429, 'RATE_LIMITED', 'Rate limit exceeded'),
      PORTAL_UI.TOO_MANY_ATTEMPTS,
    );
    assert.equal(
      customerMessageFor(401, 'PORTAL_TOKEN_INVALID', PORTAL_MESSAGES.TOKEN_INVALID),
      PORTAL_MESSAGES.TOKEN_INVALID,
    );
    assert.equal(customerMessageFor(401, 'INVALID_TOKEN', null), PORTAL_MESSAGES.UNAUTHENTICATED);
    assert.equal(
      customerMessageFor(403, 'PORTAL_REAUTH_REQUIRED', PORTAL_MESSAGES.REAUTH_REQUIRED),
      PORTAL_MESSAGES.REAUTH_REQUIRED,
    );
    assert.equal(
      customerMessageFor(409, 'PORTAL_CANCELLATION_BLOCKED', PORTAL_MESSAGES.CANCELLATION_BLOCKED),
      PORTAL_MESSAGES.CANCELLATION_BLOCKED,
    );
    assert.equal(
      customerMessageFor(400, 'VALIDATION_ERROR', 'body.email: Invalid'),
      PORTAL_UI.INPUT_INVALID,
    );
    assert.equal(
      customerMessageFor(404, 'NOT_FOUND', 'Nicht gefunden.'),
      PORTAL_UI.BOOKING_NOT_AVAILABLE,
    );
    assert.equal(customerMessageFor(500, 'INTERNAL_ERROR', 'boom'), PORTAL_UI.GENERIC_ERROR);
    assert.equal(customerMessageFor(503, 'DEMO_RESET', 'reset'), PORTAL_UI.TEMPORARILY_UNAVAILABLE);
    assert.equal(
      customerMessageFor(413, 'FST_ERR_CTP_BODY_TOO_LARGE', 'Request body is too large'),
      PORTAL_UI.PHOTOS_TOO_LARGE,
    );
    for (const text of [
      customerMessageFor(400, 'VALIDATION_ERROR', 'x'),
      customerMessageFor(500, 'INTERNAL_ERROR', 'x'),
      customerMessageFor(429, 'RATE_LIMITED', 'x'),
    ]) {
      assert.doesNotMatch(text, /[A-Z]{3,}_[A-Z_]+/, 'kein roher Code im Kundentext');
    }
  });

  it('W6. portalFetch: same-origin + no-store + JSON; Fehlerform {error:{code,message}} ⇒ PortalApiError(code,status,message); Netzfehler ⇒ PortalNetworkError; 204 ⇒ undefined', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ bookings: [] });
    };
    const list = await portalFetch<{ bookings: unknown[] }>('/bookings', { fetchImpl: ok });
    assert.deepEqual(list, { bookings: [] });
    assert.equal(calls[0]?.url, '/api/portal/bookings');
    assert.equal(calls[0]?.init.credentials, 'same-origin');
    assert.equal(calls[0]?.init.cache, 'no-store');
    assert.equal(calls[0]?.init.method, 'GET');
    assert.equal(calls[0]?.init.body, undefined);

    await portalFetch('/auth/consume', { method: 'POST', body: { token: 'abc' }, fetchImpl: ok });
    assert.equal(calls[1]?.init.method, 'POST');
    assert.equal(calls[1]?.init.body, JSON.stringify({ token: 'abc' }));
    assert.equal(
      (calls[1]?.init.headers as Record<string, string>)['content-type'],
      'application/json',
    );

    const failing: FetchLike = async () =>
      jsonResponse(
        {
          error: {
            code: 'PORTAL_TOKEN_INVALID',
            message: PORTAL_MESSAGES.TOKEN_INVALID,
            correlationId: 'c-1',
          },
        },
        401,
      );
    await assert.rejects(
      portalFetch('/auth/consume', { method: 'POST', body: { token: 'x' }, fetchImpl: failing }),
      (error: unknown) => {
        assert.ok(error instanceof PortalApiError);
        assert.equal(error.code, 'PORTAL_TOKEN_INVALID');
        assert.equal(error.status, 401);
        assert.equal(error.message, PORTAL_MESSAGES.TOKEN_INVALID);
        assert.equal(error.correlationId, 'c-1');
        assert.equal(isUnauthenticated(error), true);
        assert.equal(isReauthRequired(error), false);
        return true;
      },
    );

    const reauth: FetchLike = async () =>
      jsonResponse({ error: { code: 'PORTAL_REAUTH_REQUIRED', message: 'x' } }, 403);
    await assert.rejects(
      portalFetch('/profile', { method: 'PATCH', body: {}, fetchImpl: reauth }),
      (error: unknown) => {
        assert.equal(isReauthRequired(error), true);
        assert.equal(isUnauthenticated(error), false);
        return true;
      },
    );

    const tooMany: FetchLike = async () => new Response('Too Many Requests', { status: 429 });
    await assert.rejects(
      portalFetch('/auth/request', { method: 'POST', body: {}, fetchImpl: tooMany }),
      (error: unknown) => {
        assert.ok(error instanceof PortalApiError);
        assert.equal(error.status, 429);
        assert.equal(portalErrorMessage(error), PORTAL_UI.TOO_MANY_ATTEMPTS);
        return true;
      },
    );

    const noContent: FetchLike = async () => new Response(null, { status: 204 });
    assert.equal(
      await portalFetch<undefined>('/auth/logout', { method: 'POST', fetchImpl: noContent }),
      undefined,
    );

    const down: FetchLike = async () => {
      throw new TypeError('Failed to fetch');
    };
    await assert.rejects(portalFetch('/me', { fetchImpl: down }), (error: unknown) => {
      assert.ok(error instanceof PortalNetworkError);
      assert.equal(portalErrorMessage(error), PORTAL_UI.OFFLINE);
      return true;
    });
    assert.equal(portalErrorMessage(new Error('irgendwas')), PORTAL_UI.GENERIC_ERROR);
  });

  it('W7. readTokenFromHash: `#token=…` (auch mit weiteren Parametern, URL-kodiert) ⇒ Token; leer/fehlend/ungültige Zeichen ⇒ null', () => {
    const token = 'AbC-_0123456789abcdefghijklmnopqrstuvwxyz01';
    assert.equal(token.length, 43);
    assert.equal(readTokenFromHash(`#token=${token}`), token);
    assert.equal(readTokenFromHash(`token=${token}`), token);
    assert.equal(readTokenFromHash(`#a=1&token=${token}&b=2`), token);
    assert.equal(readTokenFromHash(`#token=${encodeURIComponent(token)}`), token);
    assert.equal(readTokenFromHash(''), null);
    assert.equal(readTokenFromHash('#'), null);
    assert.equal(readTokenFromHash(null), null);
    assert.equal(readTokenFromHash(undefined), null);
    assert.equal(readTokenFromHash('#token='), null);
    assert.equal(readTokenFromHash('#other=1'), null);
    assert.equal(readTokenFromHash('#token=kurz'), null);
    assert.equal(readTokenFromHash('#token=<script>alert(1)</script>aaaaaaaaaaaaaaaaaaa'), null);
    assert.equal(readTokenFromHash(`#token=${token}%20`), token, 'Leerraum wird entfernt');
  });

  it('W8. navigationHref/telHref/Dokumentpfad: iOS ⇒ apple, Android ⇒ android, sonst web; null ⇒ null; tel: nur Ziffern/+; IDs URL-kodiert', () => {
    const links = {
      apple: 'https://maps.apple.com/?daddr=x',
      android: 'geo:0,0?q=x',
      web: 'https://www.google.com/maps/dir/?api=1&destination=x',
    };
    assert.equal(
      navigationPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'),
      'apple',
    );
    assert.equal(navigationPlatform('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'android');
    assert.equal(navigationPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'web');
    assert.equal(navigationHref(links, 'iPhone'), links.apple);
    assert.equal(navigationHref(links, 'Android'), links.android);
    assert.equal(navigationHref(links, 'Windows'), links.web);
    assert.equal(navigationHref(null, 'iPhone'), null);
    assert.equal(telHref('+49 6131 123-456'), 'tel:+496131123456');
    assert.equal(telHref('06131 / 12 34 56'), 'tel:06131123456');
    assert.equal(telHref(null), null);
    assert.equal(telHref(''), null);
    assert.equal(portalDocumentHref('b/1', 'd 2'), '/api/portal/bookings/b%2F1/documents/d%202');
  });

  it('W9. Foto-Vorprüfung: JPEG/PNG/WebP bis 8 MB, max. 5 Stück, Summe ≤ 8 MB; PDF/SVG abgelehnt; Base64 aus Data-URL', () => {
    assert.equal(validatePhotoSelection([{ type: 'image/jpeg', size: 1024 }]), null);
    assert.equal(
      validatePhotoSelection([{ type: 'application/pdf', size: 10 }]),
      PORTAL_UI.PHOTO_REJECTED,
    );
    assert.equal(
      validatePhotoSelection([{ type: 'image/svg+xml', size: 10 }]),
      PORTAL_UI.PHOTO_REJECTED,
    );
    assert.equal(
      validatePhotoSelection([{ type: 'image/png', size: 8 * 1024 * 1024 + 1 }]),
      PORTAL_UI.PHOTO_REJECTED,
    );
    assert.equal(
      validatePhotoSelection(Array.from({ length: 6 }, () => ({ type: 'image/webp', size: 1 }))),
      PORTAL_UI.PHOTO_LIMIT,
    );
    assert.equal(
      validatePhotoSelection([
        { type: 'image/jpeg', size: 5 * 1024 * 1024 },
        { type: 'image/jpeg', size: 5 * 1024 * 1024 },
      ]),
      PORTAL_UI.PHOTOS_TOO_LARGE,
    );
    assert.equal(base64FromDataUrl('data:image/png;base64,iVBORw0KGgo='), 'iVBORw0KGgo=');
    assert.equal(base64FromDataUrl('data:image/png;base64,'), null);
    assert.equal(base64FromDataUrl('iVBORw0KGgo='), null);
  });
});
