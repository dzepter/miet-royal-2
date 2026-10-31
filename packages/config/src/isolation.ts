import type { AppConfig } from './load-config.ts';

/**
 * Wird geworfen, wenn zwei Umgebungen (z. B. production und demo) auf
 * dieselbe Datenbank, denselben Storage oder dieselben Zugangsdaten zeigen.
 * Meldet nur, WELCHE Konfigurationsteile kollidieren – niemals die Werte
 * (Ausnahme Phase 14: die Deployment-URLs des Live↔Demo-Wechsels sind keine
 * Secrets und werden zur Orientierung genannt).
 */
export class EnvironmentIsolationError extends Error {
  readonly collisions: readonly string[];

  constructor(envA: string, envB: string, collisions: readonly string[]) {
    super(`Umgebungen "${envA}" und "${envB}" sind nicht isoliert:\n- ${collisions.join('\n- ')}`);
    this.name = 'EnvironmentIsolationError';
    this.collisions = collisions;
  }
}

/**
 * Prüft die strikte technische Trennung zweier Umgebungen (ARCHITECTURE.md,
 * CLAUDE.md "Live / Demo / Staging"): getrennte Datenbanken, getrennter
 * Storage, getrennte Zugangsdaten. Wirft bei jeder Kollision.
 */
export function assertConfigsIsolated(a: AppConfig, b: AppConfig): void {
  const collisions: string[] = [];

  if (normalizeDatabaseUrl(a.databaseUrl) === normalizeDatabaseUrl(b.databaseUrl)) {
    collisions.push('DATABASE_URL: beide Umgebungen zeigen auf dieselbe Datenbank');
  }

  if (a.storage.driver === 'fs' && b.storage.driver === 'fs') {
    if (a.storage.fsRoot === b.storage.fsRoot) {
      collisions.push('STORAGE_FS_ROOT: beide Umgebungen nutzen dasselbe Storage-Verzeichnis');
    }
  } else if (a.storage.driver === 's3' && b.storage.driver === 's3') {
    if (a.storage.endpoint === b.storage.endpoint && a.storage.bucket === b.storage.bucket) {
      collisions.push(
        'STORAGE_S3_ENDPOINT/STORAGE_S3_BUCKET: beide Umgebungen nutzen denselben Bucket',
      );
    }
    if (a.storage.accessKeyId === b.storage.accessKeyId) {
      collisions.push('STORAGE_S3_ACCESS_KEY_ID: beide Umgebungen nutzen dieselben Zugangsdaten');
    }
  }

  // Phase 10: Ein Lexware-API-Key darf nie in zwei Umgebungen gleichzeitig gelten
  // (sonst bucht z. B. Staging in den Production-Account).
  if (a.lexware.apiKey !== null && a.lexware.apiKey === b.lexware.apiKey) {
    collisions.push('LEXWARE_API_KEY: beide Umgebungen nutzen denselben Lexware-API-Key');
  }
  if (a.auth.secretKey === b.auth.secretKey) {
    collisions.push('AUTH_SECRET_KEY: beide Umgebungen nutzen denselben Auth-Schlüssel');
  }

  // Phase 12: Kommunikationsschlüssel, WhatsApp-Zugänge, Push-Schlüssel und
  // das IMAP-Postfach dürfen nie in zwei Umgebungen gleichzeitig gelten.
  const keysA = [a.communication.payloadKey, a.communication.payloadKeyPrevious];
  const keysB = [b.communication.payloadKey, b.communication.payloadKeyPrevious];
  if (keysA.some((key) => key !== null && keysB.includes(key))) {
    collisions.push(
      'COMMUNICATION_PAYLOAD_KEY: beide Umgebungen nutzen denselben Kommunikationsschlüssel',
    );
  }
  if (a.whatsapp.accessToken !== null && a.whatsapp.accessToken === b.whatsapp.accessToken) {
    collisions.push('WHATSAPP_ACCESS_TOKEN: beide Umgebungen nutzen denselben WhatsApp-Zugang');
  }
  if (a.whatsapp.appSecret !== null && a.whatsapp.appSecret === b.whatsapp.appSecret) {
    collisions.push('WHATSAPP_APP_SECRET: beide Umgebungen nutzen dasselbe WhatsApp-App-Secret');
  }
  if (a.whatsapp.phoneNumberId !== null && a.whatsapp.phoneNumberId === b.whatsapp.phoneNumberId) {
    collisions.push('WHATSAPP_PHONE_NUMBER_ID: beide Umgebungen nutzen dieselbe WhatsApp-Nummer');
  }
  if (
    a.push.vapidPrivateKey !== null &&
    (a.push.vapidPrivateKey === b.push.vapidPrivateKey ||
      a.push.vapidPublicKey === b.push.vapidPublicKey)
  ) {
    collisions.push('PUSH_VAPID_PRIVATE_KEY: beide Umgebungen nutzen dasselbe VAPID-Schlüsselpaar');
  }
  if (
    a.mail.imap !== null &&
    b.mail.imap !== null &&
    a.mail.imap.host.toLowerCase() === b.mail.imap.host.toLowerCase() &&
    a.mail.imap.user.toLowerCase() === b.mail.imap.user.toLowerCase() &&
    a.mail.imap.folder.toUpperCase() === b.mail.imap.folder.toUpperCase()
  ) {
    collisions.push('MAIL_IMAP_*: beide Umgebungen lesen dasselbe IMAP-Postfach');
  }

  // Phase 13: Ein GraphHopper-API-Key darf nie in zwei Umgebungen gleichzeitig
  // gelten (sonst verbraucht z. B. Staging das Production-Kontingent).
  if (
    a.routing.graphhopper.apiKey !== null &&
    a.routing.graphhopper.apiKey === b.routing.graphhopper.apiKey
  ) {
    collisions.push('GRAPHHOPPER_API_KEY: beide Umgebungen nutzen denselben GraphHopper-API-Key');
  }
  // Phase 13 Final: ROUTING_PROVIDER_TERMS_CONFIRMED ist ein Deployment-Schalter,
  // kein Geheimnis – bewusst keine Kollisionsprüfung.

  // Phase 14 (demo): Die festen URLs des Live↔Demo-Wechsels sind keine Secrets,
  // dürfen aber nicht in beide Richtungen auf dasselbe Ziel zeigen (Live und
  // Demo wären dann dieselbe Staff-Instanz) und nie auf die eigene öffentliche
  // Web-App (MAIL_PUBLIC_WEB_BASE_URL) – beides wäre eine Verwechslung der Umgebungen.
  const linkA = a.environmentLinks.counterpart;
  const linkB = b.environmentLinks.counterpart;
  if (linkA !== null && linkB !== null && linkA.url === linkB.url) {
    collisions.push(
      `STAFF_DEMO_URL/STAFF_LIVE_URL: beide Umgebungen verlinken auf dieselbe Ziel-URL (${linkA.url})`,
    );
  }
  for (const config of [a, b]) {
    const link = config.environmentLinks.counterpart;
    const ownPublicWeb = originOf(config.mail.publicWebBaseUrl);
    if (link !== null && ownPublicWeb !== null && link.url === ownPublicWeb) {
      collisions.push(
        `${link.kind === 'demo' ? 'STAFF_DEMO_URL' : 'STAFF_LIVE_URL'}: ${config.appEnv} nennt die eigene MAIL_PUBLIC_WEB_BASE_URL als Gegen-URL (${link.url})`,
      );
    }
  }

  if (collisions.length > 0) {
    throw new EnvironmentIsolationError(a.appEnv, b.appEnv, collisions);
  }
}

/**
 * Gleiche Datenbank trotz kosmetisch unterschiedlicher URL erkennen
 * (z. B. postgres:// vs. postgresql://, Query-Parameter, Default-Port).
 */
function normalizeDatabaseUrl(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    const host = url.hostname.toLowerCase();
    const port = url.port === '' ? '5432' : url.port;
    const database = url.pathname.replace(/^\//, '');
    return `${host}:${port}/${database}`;
  } catch {
    return databaseUrl;
  }
}

/** Phase 14 (demo): Origin einer absoluten URL (null, wenn nicht gesetzt oder ungültig). */
function originOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
