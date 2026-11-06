import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import nextConfig from '../next.config.ts';
import * as portal from './portal.ts';
import {
  PHOTO_MAX_BYTES,
  PHOTO_MAX_COUNT,
  PHOTO_MAX_TOTAL_BYTES,
  PORTAL_MESSAGES,
  PORTAL_UI,
  PortalApiError,
  customerMessageFor,
  type PortalBookingView,
  type PortalCancellationPreview,
} from './portal.ts';

/**
 * Phase 15 (Review R2/R3/R8, Gruppe C – Web): Regressionstests zu den Funden
 * des adversarialen Reviews (phase15_review.md). Läuft mit `node --test`
 * (pnpm test), ohne Next/Browser. Die API-Quelltexte werden nur als Text
 * gelesen (Spiegel-Abgleich), nie importiert.
 */

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const API_SRC = fileURLToPath(new URL('../../api/src/', import.meta.url));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** `export const PORTAL_MESSAGES = { KEY: '…', … } as const;` aus der API-Quelle (nur Text). */
function apiPortalMessages(): Record<string, string> {
  const source = readFileSync(join(API_SRC, 'portal/types.ts'), 'utf8');
  const block = /export const PORTAL_MESSAGES = \{([\s\S]*?)\n\} as const;/.exec(source)?.[1];
  assert.ok(block !== undefined, 'PORTAL_MESSAGES-Block der API nicht gefunden');
  const messages: Record<string, string> = {};
  for (const match of block.matchAll(/^\s*([A-Z_]+):\s*'((?:[^'\\]|\\.)*)',/gm)) {
    messages[match[1]!] = match[2]!;
  }
  return messages;
}

/** `export const NAME = 12 * 1024 * 1024;` bzw. `= 5000;` aus einer API-Quelldatei. */
function apiNumericConstant(relativePath: string, name: string): number {
  const source = readFileSync(join(API_SRC, relativePath), 'utf8');
  const expression = new RegExp(`export const ${name} = ([0-9_ *]+);`).exec(source)?.[1];
  assert.ok(expression !== undefined, `${name} in ${relativePath} nicht gefunden`);
  return expression
    .split('*')
    .map((factor) => Number(factor.replaceAll('_', '').trim()))
    .reduce((product, factor) => product * factor, 1);
}

/** Next-Default von `experimental.proxyClientMaxBodySize` (next/dist/server/config-shared.js). */
const NEXT_DEFAULT_PROXY_BODY_LIMIT = 10 * 1024 * 1024;

function proxyBodyLimitBytes(): number {
  const value = nextConfig.experimental?.proxyClientMaxBodySize;
  if (value === undefined) return NEXT_DEFAULT_PROXY_BODY_LIMIT;
  assert.equal(typeof value, 'number', 'Limit als Bytezahl (eindeutig, ohne Einheiten-Parser)');
  return value as number;
}

/** Alle Quelltexte der Web-App (Seiten, Komponenten, lib) ohne Tests. */
function webSources(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts')) {
        files.push({ path: full.slice(WEB_ROOT.length), text: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const dir of ['app', 'components', 'lib']) walk(join(WEB_ROOT, dir));
  return files;
}

const PREVIEW_ZERO: PortalCancellationPreview = {
  eventDate: '2026-11-20',
  remainingDays: 15,
  feePercent: 0,
  baseCents: 7500,
  feeCents: 0,
  allowed: true,
  blockedMessage: null,
};
const PREVIEW_HALF: PortalCancellationPreview = {
  ...PREVIEW_ZERO,
  remainingDays: 14,
  feePercent: 50,
  feeCents: 3750,
};

describe('Phase 15 – Review-Funde Web (Gruppe C)', () => {
  it('R2./R8. Texte: lib/portal.ts spiegelt PORTAL_MESSAGES der API vollständig und wortgleich (inkl. CANCELLATION_FEE_CHANGED und EMAIL_CHANGE_REQUESTED)', () => {
    const api = apiPortalMessages();
    assert.ok(Object.keys(api).length >= 11, 'API-Texte gelesen');
    assert.deepEqual({ ...PORTAL_MESSAGES }, api);
    assert.equal(
      api.CANCELLATION_FEE_CHANGED,
      'Die Stornogebühr hat sich inzwischen geändert. Bitte prüfe den neuen Betrag und bestätige erneut.',
    );
    assert.equal(
      api.EMAIL_CHANGE_REQUESTED,
      'Wenn die Adresse verwendet werden kann, erhältst du dort gleich einen Bestätigungslink.',
    );
  });

  it('R2. Storno-Bestätigung sendet die Gebühr der ANGEZEIGTEN Vorschau als expectedFeeCents (Pflichtfeld der API); kein Web-Code sendet mehr nur { confirm: true }', async () => {
    const confirm = (portal as Record<string, unknown>).confirmPortalCancellation;
    assert.equal(typeof confirm, 'function', 'confirmPortalCancellation fehlt in lib/portal.ts');
    const confirmPortalCancellation = confirm as typeof portal.confirmPortalCancellation;

    const calls: { url: string; init: RequestInit }[] = [];
    const booking = { bookingId: 'b-1', portalState: 'cancelled_fee' } as PortalBookingView;
    const ok: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(booking);
    };
    const outcome = await confirmPortalCancellation('b/1', PREVIEW_HALF, { fetchImpl: ok });
    assert.deepEqual(outcome, { kind: 'cancelled', booking });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, '/api/portal/bookings/b%2F1/cancellation');
    assert.equal(calls[0]?.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      confirm: true,
      expectedFeeCents: 3750,
    });
    // Angezeigt wird bei fehlender Gebühr „0,00 €“ – genau dieser Wert wird gebunden.
    await confirmPortalCancellation('b-1', { ...PREVIEW_ZERO, feeCents: null }, { fetchImpl: ok });
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
      confirm: true,
      expectedFeeCents: 0,
    });

    const offenders = webSources().filter((file) => /confirm:\s*true\s*}/.test(file.text));
    assert.deepEqual(
      offenders.map((file) => file.path),
      [],
      'Storno-POST ohne expectedFeeCents',
    );
  });

  it('R2. 409 PORTAL_CANCELLATION_FEE_CHANGED: Vorschau wird neu geladen, Dialog erhält neuen Betrag + Hinweistext (Bestätigung erneut möglich); andere 409 (blockiert) bleiben Fehler', async () => {
    const confirmPortalCancellation = (portal as Record<string, unknown>)
      .confirmPortalCancellation as typeof portal.confirmPortalCancellation | undefined;
    const isCancellationFeeChanged = (portal as Record<string, unknown>)
      .isCancellationFeeChanged as typeof portal.isCancellationFeeChanged | undefined;
    assert.equal(typeof confirmPortalCancellation, 'function');
    assert.equal(typeof isCancellationFeeChanged, 'function');

    // Fehler-Mapping: der API-Text kommt kundentauglich durch, nie der rohe Code.
    assert.equal(
      customerMessageFor(
        409,
        'PORTAL_CANCELLATION_FEE_CHANGED',
        PORTAL_MESSAGES.CANCELLATION_FEE_CHANGED,
      ),
      PORTAL_MESSAGES.CANCELLATION_FEE_CHANGED,
    );
    const changed = new PortalApiError(
      'PORTAL_CANCELLATION_FEE_CHANGED',
      409,
      PORTAL_MESSAGES.CANCELLATION_FEE_CHANGED,
    );
    const blocked = new PortalApiError(
      'PORTAL_CANCELLATION_BLOCKED',
      409,
      PORTAL_MESSAGES.CANCELLATION_BLOCKED,
    );
    assert.equal(isCancellationFeeChanged!(changed), true);
    assert.equal(isCancellationFeeChanged!(blocked), false);
    assert.equal(isCancellationFeeChanged!(new Error('x')), false);

    // Mitternachtsfall: gezeigt 0 €, inzwischen 50 % ⇒ 409, neue Vorschau 37,50 €.
    const calls: { url: string; init: RequestInit }[] = [];
    const feeChanged: FetchLike = async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'POST') {
        return jsonResponse(
          {
            error: {
              code: 'PORTAL_CANCELLATION_FEE_CHANGED',
              message: PORTAL_MESSAGES.CANCELLATION_FEE_CHANGED,
            },
          },
          409,
        );
      }
      return jsonResponse(PREVIEW_HALF);
    };
    const outcome = await confirmPortalCancellation!('b-1', PREVIEW_ZERO, {
      fetchImpl: feeChanged,
    });
    assert.deepEqual(outcome, {
      kind: 'fee_changed',
      preview: PREVIEW_HALF,
      message: PORTAL_MESSAGES.CANCELLATION_FEE_CHANGED,
    });
    assert.deepEqual(
      calls.map((call) => [call.init.method, call.url]),
      [
        ['POST', '/api/portal/bookings/b-1/cancellation'],
        ['GET', '/api/portal/bookings/b-1/cancellation/preview'],
      ],
    );
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      confirm: true,
      expectedFeeCents: 0,
    });

    // Erneute Bestätigung bindet den NEUEN Betrag.
    const second: { init: RequestInit }[] = [];
    await confirmPortalCancellation!('b-1', PREVIEW_HALF, {
      fetchImpl: async (_url, init) => {
        second.push({ init });
        return jsonResponse({ bookingId: 'b-1' });
      },
    });
    assert.deepEqual(JSON.parse(String(second[0]?.init.body)), {
      confirm: true,
      expectedFeeCents: 3750,
    });

    // Fachlich blockiert ⇒ unverändert als Fehler (Seite zeigt Blocker-Text + Anrufen), keine neue Vorschau.
    let previewLoads = 0;
    await assert.rejects(
      confirmPortalCancellation!('b-1', PREVIEW_ZERO, {
        fetchImpl: async (_url, init) => {
          if (init.method !== 'POST') previewLoads += 1;
          return jsonResponse(
            {
              error: {
                code: 'PORTAL_CANCELLATION_BLOCKED',
                message: PORTAL_MESSAGES.CANCELLATION_BLOCKED,
              },
            },
            409,
          );
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof PortalApiError);
        assert.equal(error.status, 409);
        assert.equal(error.code, 'PORTAL_CANCELLATION_BLOCKED');
        assert.equal(error.message, PORTAL_MESSAGES.CANCELLATION_BLOCKED);
        return true;
      },
    );
    assert.equal(previewLoads, 0);
  });

  it('R8. E-Mail-Wechsel-Anforderung: Erfolgstext ist immer der neutrale Text EMAIL_CHANGE_REQUESTED; der alte, bestätigende Text („an die neue Adresse geschickt“) existiert im Web nicht mehr', () => {
    assert.equal(
      PORTAL_MESSAGES.EMAIL_CHANGE_REQUESTED,
      'Wenn die Adresse verwendet werden kann, erhältst du dort gleich einen Bestätigungslink.',
    );
    assert.equal('EMAIL_CHANGE_SENT' in PORTAL_UI, false);
    const offenders = webSources().filter(
      (file) =>
        file.text.includes('EMAIL_CHANGE_SENT') ||
        file.text.includes('Bestätigungslink an die neue Adresse geschickt'),
    );
    assert.deepEqual(
      offenders.map((file) => file.path),
      [],
    );
    const profile = webSources().find((file) => file.path === 'app/konto/profil/page.tsx');
    assert.ok(profile?.text.includes('PORTAL_MESSAGES.EMAIL_CHANGE_REQUESTED'));
  });

  it('R3. Body-Limit-Kette Browser ≤ Next-Rewrite ≤ API: Next puffert beim Rewrite mindestens das API-Limit des Portal-Chats (12 MiB), der größte vorgeprüfte Upload (8 MiB Rohbytes als Base64-JSON) passt unter das API-Limit', () => {
    const apiLimit = apiNumericConstant('routes/portal-chat.ts', 'PORTAL_CHAT_BODY_LIMIT');
    assert.equal(apiLimit, 12 * 1024 * 1024);
    const maxChars = apiNumericConstant(
      'communication/conversation/conversation-service.ts',
      'MANUAL_REPLY_MAX_CHARS',
    );
    const nextLimit = proxyBodyLimitBytes();
    assert.ok(
      nextLimit >= apiLimit,
      `Next-Rewrite-Puffer ${nextLimit} B < API-Limit ${apiLimit} B ⇒ Body wird abgeschnitten`,
    );
    assert.equal(nextLimit, 13 * 1024 * 1024, '13 MiB = API-Limit + Reserve');

    // Größter Body, den die Client-Vorprüfung durchlässt: Rohbytes gesamt ≤ PHOTO_MAX_TOTAL_BYTES,
    // je Bild ≤ PHOTO_MAX_BYTES, höchstens PHOTO_MAX_COUNT Bilder; Text max. MANUAL_REPLY_MAX_CHARS
    // (JSON-Escape im ungünstigsten Fall 6 Byte je Zeichen, z. B. \u0001).
    assert.equal(PHOTO_MAX_TOTAL_BYTES, 8 * 1024 * 1024);
    assert.ok(PHOTO_MAX_BYTES <= PHOTO_MAX_TOTAL_BYTES);
    const base64Total = Math.ceil(PHOTO_MAX_TOTAL_BYTES / 3) * 4 + PHOTO_MAX_COUNT * 4;
    const photoWrapper = JSON.stringify({ mimeType: 'image/webp', dataBase64: '' }).length + 1;
    const envelope = JSON.stringify({ body: '', photos: [] }).length;
    const worstCase = base64Total + PHOTO_MAX_COUNT * photoWrapper + envelope + maxChars * 6;
    assert.ok(
      worstCase < apiLimit,
      `größter vorgeprüfter Body ${worstCase} B ≥ API-Limit ${apiLimit} B`,
    );
    // Realer JSON-Body eines einzelnen 8-MiB-Fotos (wie im Review gemessen: 11 184 879 B).
    const realistic = JSON.stringify({
      body: 'Foto',
      photos: [
        { mimeType: 'image/png', dataBase64: 'A'.repeat(Math.ceil(PHOTO_MAX_BYTES / 3) * 4) },
      ],
    }).length;
    assert.ok(realistic > NEXT_DEFAULT_PROXY_BODY_LIMIT, 'ohne Fix wäre er abgeschnitten');
    assert.ok(realistic < apiLimit && apiLimit <= nextLimit);
  });
});
