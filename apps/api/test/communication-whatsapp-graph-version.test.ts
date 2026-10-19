/**
 * Phase-12-Finalisierung §3 (W1–W7): Graph-API-Version erneut offiziell
 * verifiziert (2026-10-19, developers.facebook.com Graph API changelog/versions:
 * aktuell v26.0). Der echte CloudApiWhatsAppGateway wird mit aufgezeichnetem
 * fetch gegen die production-Konfiguration geprüft. W4–W6 (Webhook,
 * Rohbytes-Signatur, 24-h-Fenster) decken communication-whatsapp.integration
 * und communication-hardening-whatsapp.integration ab (unverändert grün).
 */
import { loadConfig, WHATSAPP_DEFAULT_GRAPH_API_VERSION } from '@mietroyal/config';
import { describe, expect, it } from 'vitest';
import {
  createWhatsAppGateway,
  WHATSAPP_MEDIA_DOWNLOAD_HOSTS,
} from '../src/communication/whatsapp/gateways.ts';

const production = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgresql://app:pw@db.internal:5432/mietroyal_prod',
  STORAGE_DRIVER: 'fs',
  STORAGE_FS_ROOT: '/var/lib/mietroyal/prod',
  AUTH_SECRET_KEY: 'prod-auth-secret-key-0123456789abcdef',
  COMMUNICATION_PAYLOAD_KEY: 'prod-communication-payload-key-0123456789',
  WHATSAPP_ENABLED: 'true',
  WHATSAPP_ACCESS_TOKEN: 'SYNTH-token',
  WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
  WHATSAPP_BUSINESS_ACCOUNT_ID: '987654321098765',
  WHATSAPP_APP_SECRET: 'SYNTH-app-secret-0123456789',
  WHATSAPP_VERIFY_TOKEN: 'SYNTH-verify-token-0123456789',
};

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

function recordingFetch(responses: Response[]) {
  const calls: Recorded[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) throw new Error('unerwarteter Request');
    return next;
  };
  return { calls, fetch };
}

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

describe('Meta Graph API – finale Versionsverifikation (W1–W7)', () => {
  it('W1. Default ist die aktuelle offizielle Graph-Version v26.0; kein „latest“', () => {
    expect(WHATSAPP_DEFAULT_GRAPH_API_VERSION).toBe('v26.0');
    const config = loadConfig(production);
    expect(config.whatsapp.graphApiVersion).toBe('v26.0');
    expect(() => loadConfig({ ...production, WHATSAPP_GRAPH_API_VERSION: 'latest' })).toThrow();
  });

  it('W2. Send-Messages-Pfad: POST https://graph.facebook.com/v26.0/{phone-number-id}/messages mit Bearer', async () => {
    const config = loadConfig(production);
    const rec = recordingFetch([
      new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 }),
    ]);
    const gateway = createWhatsAppGateway(config, { fetch: rec.fetch });
    const result = await gateway.sendText({ to: '4961311234567', text: 'Hallo' });
    expect(result).toEqual({ outcome: 'accepted', providerMessageId: 'wamid.X' });
    expect(rec.calls[0]!.url).toBe('https://graph.facebook.com/v26.0/123456789012345/messages');
    expect(rec.calls[0]!.init?.method).toBe('POST');
    const headers = new Headers(rec.calls[0]!.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer SYNTH-token');
    expect(JSON.parse(String(rec.calls[0]!.init?.body))).toMatchObject({
      messaging_product: 'whatsapp',
      to: '4961311234567',
      type: 'text',
      text: { body: 'Hallo' },
    });
  });

  it('W3. Media-Metadaten-Pfad: GET https://graph.facebook.com/v26.0/{media-id}; Download nur vom erlaubten Host, ohne Redirects', async () => {
    const config = loadConfig(production);
    const mediaHost = WHATSAPP_MEDIA_DOWNLOAD_HOSTS[0]!;
    const rec = recordingFetch([
      new Response(
        JSON.stringify({
          url: `https://${mediaHost}/whatsapp_business/attachments/?mid=1`,
          mime_type: 'image/jpeg',
          file_size: JPEG.length,
          id: 'media-1',
        }),
        { status: 200 },
      ),
      new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    ]);
    const gateway = createWhatsAppGateway(config, { fetch: rec.fetch });
    const result = await gateway.fetchMedia('media-1');
    expect(result.outcome).toBe('ok');
    expect(rec.calls[0]!.url.startsWith('https://graph.facebook.com/v26.0/media-1')).toBe(true);
    expect(rec.calls[1]!.init?.redirect).toBe('error');

    // Unbekannter Host ⇒ MEDIA_HOST_NOT_ALLOWED, kein Bearer-Request dorthin.
    const foreign = recordingFetch([
      new Response(
        JSON.stringify({
          url: 'https://attacker.example/x',
          mime_type: 'image/jpeg',
          file_size: 10,
          id: 'media-2',
        }),
        { status: 200 },
      ),
    ]);
    const gateway2 = createWhatsAppGateway(config, { fetch: foreign.fetch });
    const blocked = await gateway2.fetchMedia('media-2');
    expect(blocked).toMatchObject({ outcome: 'permanent_error', code: 'MEDIA_HOST_NOT_ALLOWED' });
    expect(foreign.calls).toHaveLength(1);
  });

  it('W7. Production-Host ausschließlich graph.facebook.com (fremder Host abgelehnt)', () => {
    expect(loadConfig(production).whatsapp.baseUrl).toBe('https://graph.facebook.com');
    expect(() =>
      loadConfig({ ...production, WHATSAPP_BASE_URL: 'https://graph.example.com' }),
    ).toThrow(/WHATSAPP_BASE_URL/);
  });
});
