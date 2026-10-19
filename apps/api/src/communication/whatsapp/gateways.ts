/**
 * Phase 12 (Order §26/§28/§39): WhatsApp-Gateways – ausschließlich die
 * offizielle Meta WhatsApp Business Cloud API (Graph API), verifiziert am
 * 2026-10-18 (phase12_whatsapp_verification.md); Versionsstand in der
 * Finalisierung am 2026-10-19 erneut gegen Meta-Primärquellen geprüft
 * (Default v26.0, docs/COMMUNICATION_INTEGRATIONS.md).
 *
 * - `CloudApiWhatsAppGateway`: POST /{version}/{phone-number-id}/messages,
 *   Bearer-Token; Medien über GET /{version}/{media-id} + Download der
 *   kurzlebigen URL (5 min). `fetch` ist injizierbar (Tests zeichnen Requests auf).
 * - `MockWhatsAppGateway`: demo/development – simuliert „accepted“, sendet nie.
 * - `FakeWhatsAppGateway`: Tests – zeichnet Aufrufe auf, konfigurierbare Fehler.
 * - `DisabledWhatsAppGateway`: nicht konfiguriert.
 * Token/App-Secret erscheinen nie in Rückgaben, Fehlern oder Logs.
 *
 * Härtung (Review B):
 * - B3: Bricht der Sende-Request NACH dem Absenden ab (Timeout/Abbruch/
 *   Verbindungsabbruch ohne Antwort), ist die Annahme durch Meta unklar ⇒
 *   `unknown` (kein Auto-Retry, Staff sendet bewusst neu). Nur Fehler VOR dem
 *   Senden (Verbindungsaufbau/DNS/TLS) bleiben transient.
 * - B4: Medien-Download nur von bekannten Hosts (Bearer-Token geht sonst an
 *   beliebige URLs der Graph-Antwort), keine Redirects, Größenbremse auf dem
 *   Stream (Content-Length vorab, Abbruch > 5 MB).
 */
import { randomUUID } from 'node:crypto';
import { WHATSAPP_GRAPH_BASE_URL, type AppConfig } from '@mietroyal/config';
import {
  detectImageMime,
  normalizeDeclaredMime,
  WHATSAPP_PHOTO_MAX_BYTES,
} from '../inbound/content.ts';
import type { WhatsAppGateway, WhatsAppOutboundText, WhatsAppSendOutcome } from '../types.ts';

/** Kennzeichnung simulierter Zustellungen (Demo-UI). */
export const WHATSAPP_MOCK_LABEL = 'DEMO / simuliert';
export const WHATSAPP_REQUEST_TIMEOUT_MS = 15_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type MediaOutcome = Awaited<ReturnType<WhatsAppGateway['fetchMedia']>>;

/**
 * Fehlerklassifikation nach offizieller Fehlercode-Liste (Verifikation 2026-10-18):
 * transient ⇒ Queue-Retry; permanent ⇒ failed. 131047 = Kunden-Service-
 * Fenster geschlossen (Template nötig – Miet-Royal nutzt keine Templates).
 */
const TRANSIENT_GRAPH_CODES = new Set([130429, 4, 80007, 131056, 131000, 131057, 1, 2, 368]);
const PERMANENT_GRAPH_CODES = new Set([
  131047, 131026, 131051, 100, 190, 133010, 131048, 131049, 131050, 130403, 131052, 131053, 131021,
  131030, 131031, 131037, 131042, 131045, 10, 200, 3,
]);

/**
 * Härtung B3: Fehlercodes (Node/undici, auch in `error.cause`), bei denen der
 * Request Meta nachweislich NICHT erreicht hat – Wiederholung ist gefahrlos.
 */
const PRE_SEND_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export const WHATSAPP_OUTCOME_UNKNOWN = 'OUTCOME_UNKNOWN';

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

/** Ausnahme beim Senden: vor dem Absenden ⇒ transient, sonst (Timeout/Abbruch) ⇒ unknown. */
export function classifySendException(
  error: unknown,
): { outcome: 'transient_error'; code: string } | { outcome: 'unknown'; code: string } {
  return errorCodes(error).some((code) => PRE_SEND_NETWORK_CODES.has(code))
    ? { outcome: 'transient_error', code: 'NETWORK' }
    : { outcome: 'unknown', code: WHATSAPP_OUTCOME_UNKNOWN };
}

/**
 * Härtung B4: Hosts, von denen Medien mit dem Bearer-Token geladen werden.
 * `lookaside.fbsbx.com` ist der in Metas Media-Beispielen übliche Download-
 * Host – NICHT amtlich verifiziert (phase12_whatsapp_verification.md nennt
 * nur „url“, keinen Host). Zusätzlich immer der Host der konfigurierten
 * Graph-Basis-URL. Ein anderer Host ⇒ permanent MEDIA_HOST_NOT_ALLOWED
 * (sichtbar am Hinweistext der Nachricht) – dann hier ergänzen.
 */
export const WHATSAPP_MEDIA_DOWNLOAD_HOSTS: readonly string[] = ['lookaside.fbsbx.com'];
/** Lokale Fake-Hosts – nur development mit WHATSAPP_BASE_URL ≠ Graph (E2E-Fake). */
const DEVELOPMENT_FAKE_MEDIA_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Erlaubte Medien-Hosts je Konfiguration (Gateway-Komposition). */
export function whatsappMediaHostsFor(config: AppConfig): string[] {
  const hosts = new Set<string>(WHATSAPP_MEDIA_DOWNLOAD_HOSTS);
  const base = hostnameOf(config.whatsapp.baseUrl);
  if (base !== null) hosts.add(base);
  if (config.appEnv === 'development' && config.whatsapp.baseUrl !== WHATSAPP_GRAPH_BASE_URL) {
    for (const host of DEVELOPMENT_FAKE_MEDIA_HOSTS) hosts.add(host);
  }
  return [...hosts];
}

/** Body mit Byte-Limit lesen; null ⇒ Limit überschritten (Stream abgebrochen). */
async function readBodyLimited(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type WhatsAppErrorOutcome =
  { outcome: 'transient_error'; code: string } | { outcome: 'permanent_error'; code: string };

export function classifyGraphError(code: number | null, httpStatus: number): WhatsAppErrorOutcome {
  if (code === 131047) return { outcome: 'permanent_error', code: 'WINDOW_CLOSED' };
  if (code !== null && TRANSIENT_GRAPH_CODES.has(code))
    return { outcome: 'transient_error', code: `GRAPH_${code}` };
  if (code !== null && PERMANENT_GRAPH_CODES.has(code))
    return { outcome: 'permanent_error', code: `GRAPH_${code}` };
  if (httpStatus === 429 || httpStatus >= 500)
    return { outcome: 'transient_error', code: `HTTP_${httpStatus}` };
  if (code !== null) return { outcome: 'permanent_error', code: `GRAPH_${code}` };
  return { outcome: 'permanent_error', code: `HTTP_${httpStatus}` };
}

function graphErrorCode(body: unknown): number | null {
  const error = (body as { error?: { code?: unknown } } | null)?.error;
  return typeof error?.code === 'number' ? error.code : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class CloudApiWhatsAppGateway implements WhatsAppGateway {
  readonly kind = 'cloud_api' as const;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly mediaHosts: ReadonlySet<string>;

  constructor(
    private readonly settings: {
      baseUrl: string;
      graphApiVersion: string;
      phoneNumberId: string;
      accessToken: string;
      /** Härtung B4: erlaubte Medien-Hosts (Default: Meta-Download-Host + Graph-Basis-Host). */
      mediaHosts?: readonly string[];
    },
    options: { fetch?: FetchLike; timeoutMs?: number } = {},
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? WHATSAPP_REQUEST_TIMEOUT_MS;
    const base = hostnameOf(settings.baseUrl);
    const hosts = settings.mediaHosts ?? [
      ...WHATSAPP_MEDIA_DOWNLOAD_HOSTS,
      ...(base === null ? [] : [base]),
    ];
    this.mediaHosts = new Set(hosts.map((host) => host.toLowerCase()));
  }

  private url(path: string): string {
    return `${this.settings.baseUrl}/${this.settings.graphApiVersion}/${path}`;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${this.settings.accessToken}`,
        },
        // Härtung B4: nie einem Redirect folgen (Bearer-Token an Dritte).
        redirect: 'error',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async sendText(message: WhatsAppOutboundText): Promise<WhatsAppSendOutcome> {
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
      type: 'text',
      text: { preview_url: false, body: message.text },
    };
    if (
      message.replyToProviderMessageId !== undefined &&
      message.replyToProviderMessageId !== null
    ) {
      payload.context = { message_id: message.replyToProviderMessageId };
    }
    let response: Response;
    try {
      response = await this.request(this.url(`${this.settings.phoneNumberId}/messages`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      // Härtung B3: nur „sicher nicht gesendet“ ist transient; sonst unklar.
      return classifySendException(error);
    }
    const body = await readJson(response);
    if (response.ok) {
      const id = (body as { messages?: { id?: unknown }[] } | null)?.messages?.[0]?.id;
      if (typeof id === 'string' && id !== '')
        return { outcome: 'accepted', providerMessageId: id };
      return { outcome: 'permanent_error', code: 'RESPONSE_WITHOUT_ID' };
    }
    return classifyGraphError(graphErrorCode(body), response.status);
  }

  /**
   * Härtung B4: Download der Medien-URL – Timeout umfasst auch das Lesen des
   * Bodys, keine Redirects, Content-Length vorab und Byte-Limit beim Lesen.
   */
  private async download(
    url: string,
  ): Promise<{ bytes: Uint8Array } | Exclude<MediaOutcome, { outcome: 'ok' }>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.settings.accessToken}` },
          redirect: 'error',
          signal: controller.signal,
        });
      } catch {
        return { outcome: 'transient_error', code: 'NETWORK' };
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return { outcome: 'transient_error', code: 'MEDIA_URL_EXPIRED' };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return response.status >= 500 || response.status === 429
          ? { outcome: 'transient_error', code: `HTTP_${response.status}` }
          : { outcome: 'permanent_error', code: `HTTP_${response.status}` };
      }
      const declared = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > WHATSAPP_PHOTO_MAX_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        return { outcome: 'permanent_error', code: 'MEDIA_TOO_LARGE' };
      }
      let bytes: Uint8Array | null;
      try {
        bytes = await readBodyLimited(response, WHATSAPP_PHOTO_MAX_BYTES);
      } catch {
        return { outcome: 'transient_error', code: 'NETWORK' };
      }
      if (bytes === null) return { outcome: 'permanent_error', code: 'MEDIA_TOO_LARGE' };
      return { bytes };
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchMedia(mediaId: string): Promise<MediaOutcome> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(mediaId))
      return { outcome: 'permanent_error', code: 'MEDIA_ID_INVALID' };
    let meta: Response;
    try {
      meta = await this.request(
        this.url(
          `${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(this.settings.phoneNumberId)}`,
        ),
        { method: 'GET' },
      );
    } catch {
      return { outcome: 'transient_error', code: 'NETWORK' };
    }
    const metaBody = await readJson(meta);
    if (!meta.ok) {
      const classified = classifyGraphError(graphErrorCode(metaBody), meta.status);
      return classified;
    }
    const info = metaBody as { url?: unknown; mime_type?: unknown; file_size?: unknown } | null;
    const url = typeof info?.url === 'string' ? info.url : null;
    const mime = normalizeDeclaredMime(typeof info?.mime_type === 'string' ? info.mime_type : null);
    const size = typeof info?.file_size === 'number' ? info.file_size : null;
    if (url === null || !/^https:\/\//.test(url))
      return { outcome: 'permanent_error', code: 'MEDIA_URL_INVALID' };
    if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') {
      return { outcome: 'permanent_error', code: 'MEDIA_TYPE_UNSUPPORTED' };
    }
    if (size !== null && size > WHATSAPP_PHOTO_MAX_BYTES)
      return { outcome: 'permanent_error', code: 'MEDIA_TOO_LARGE' };
    // Härtung B4: Bearer-Token nur an bekannte Medien-Hosts.
    const host = hostnameOf(url);
    if (host === null || !this.mediaHosts.has(host)) {
      return { outcome: 'permanent_error', code: 'MEDIA_HOST_NOT_ALLOWED' };
    }
    const downloaded = await this.download(url);
    if (!('bytes' in downloaded)) return downloaded;
    const bytes = downloaded.bytes;
    if (bytes.length === 0) return { outcome: 'permanent_error', code: 'MEDIA_TOO_LARGE' };
    const detected = detectImageMime(bytes);
    if (detected === null || detected !== mime)
      return { outcome: 'permanent_error', code: 'MEDIA_MAGIC_MISMATCH' };
    return { outcome: 'ok', mimeType: detected, bytes };
  }
}

/** Demo-Gateway: simuliert Annahme, kontaktiert nie Meta. */
export class MockWhatsAppGateway implements WhatsAppGateway {
  readonly kind = 'mock' as const;
  readonly label = WHATSAPP_MOCK_LABEL;
  readonly sent: WhatsAppOutboundText[] = [];
  async sendText(message: WhatsAppOutboundText): Promise<WhatsAppSendOutcome> {
    this.sent.push({ ...message });
    return { outcome: 'accepted', providerMessageId: `mock-${randomUUID()}` };
  }
  async fetchMedia(): Promise<MediaOutcome> {
    return { outcome: 'permanent_error', code: 'MOCK_NO_MEDIA' };
  }
}

export class DisabledWhatsAppGateway implements WhatsAppGateway {
  readonly kind = 'disabled' as const;
  async sendText(): Promise<WhatsAppSendOutcome> {
    return { outcome: 'permanent_error', code: 'WHATSAPP_NOT_CONFIGURED' };
  }
  async fetchMedia(): Promise<MediaOutcome> {
    return { outcome: 'permanent_error', code: 'WHATSAPP_NOT_CONFIGURED' };
  }
}

/**
 * Contract-Fake für Tests: zeichnet Anfragen auf, simuliert 429/Fehler und
 * liefert Medien aus einem Fixture-Speicher.
 */
export class FakeWhatsAppGateway implements WhatsAppGateway {
  readonly kind = 'fake' as const;
  readonly sendCalls: WhatsAppOutboundText[] = [];
  readonly mediaCalls: string[] = [];
  /** Nächste Sende-Ergebnisse (FIFO); leer ⇒ accepted. */
  readonly sendOutcomes: WhatsAppSendOutcome[] = [];
  readonly media = new Map<string, { mimeType: string; bytes: Uint8Array }>();
  /** Nächste Medien-Fehler (FIFO), z. B. { outcome: 'transient_error', code: 'HTTP_429' }. */
  readonly mediaOutcomes: Exclude<MediaOutcome, { outcome: 'ok' }>[] = [];

  reset(): void {
    this.sendCalls.length = 0;
    this.mediaCalls.length = 0;
    this.sendOutcomes.length = 0;
    this.mediaOutcomes.length = 0;
    this.media.clear();
  }

  async sendText(message: WhatsAppOutboundText): Promise<WhatsAppSendOutcome> {
    this.sendCalls.push({ ...message });
    const next = this.sendOutcomes.shift();
    if (next !== undefined) return next;
    return { outcome: 'accepted', providerMessageId: `wamid.fake.${randomUUID()}` };
  }

  async fetchMedia(mediaId: string): Promise<MediaOutcome> {
    this.mediaCalls.push(mediaId);
    const failure = this.mediaOutcomes.shift();
    if (failure !== undefined) return failure;
    const fixture = this.media.get(mediaId);
    if (fixture === undefined) return { outcome: 'permanent_error', code: 'MEDIA_NOT_FOUND' };
    const mime = normalizeDeclaredMime(fixture.mimeType);
    if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') {
      return { outcome: 'permanent_error', code: 'MEDIA_TYPE_UNSUPPORTED' };
    }
    if (fixture.bytes.length > WHATSAPP_PHOTO_MAX_BYTES)
      return { outcome: 'permanent_error', code: 'MEDIA_TOO_LARGE' };
    const detected = detectImageMime(fixture.bytes);
    if (detected === null || detected !== mime)
      return { outcome: 'permanent_error', code: 'MEDIA_MAGIC_MISMATCH' };
    return { outcome: 'ok', mimeType: detected, bytes: fixture.bytes };
  }
}

/**
 * Gateway-Wahl nach config.whatsapp.mode: live ⇒ Cloud API, mock ⇒ Mock,
 * disabled ⇒ Disabled. In production liefert die Konfiguration nie `mock`;
 * `buildApp` lehnt injizierte Fake-/Mock-Gateways in production zusätzlich ab.
 */
export function createWhatsAppGateway(
  config: AppConfig,
  options: { fetch?: FetchLike } = {},
): WhatsAppGateway {
  const wa = config.whatsapp;
  if (wa.mode === 'live') {
    if (wa.accessToken === null || wa.phoneNumberId === null) return new DisabledWhatsAppGateway();
    return new CloudApiWhatsAppGateway(
      {
        baseUrl: wa.baseUrl,
        graphApiVersion: wa.graphApiVersion,
        phoneNumberId: wa.phoneNumberId,
        accessToken: wa.accessToken,
        mediaHosts: whatsappMediaHostsFor(config),
      },
      options.fetch === undefined ? {} : { fetch: options.fetch },
    );
  }
  if (wa.mode === 'mock') {
    if (config.appEnv === 'production') return new DisabledWhatsAppGateway();
    return new MockWhatsAppGateway();
  }
  return new DisabledWhatsAppGateway();
}
