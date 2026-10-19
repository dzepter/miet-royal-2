import { z } from 'zod';

export const APP_ENVIRONMENTS = ['development', 'staging', 'demo', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type StorageConfig =
  | { driver: 'fs'; fsRoot: string }
  | {
      driver: 's3';
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    };

export interface AppConfig {
  appEnv: AppEnvironment;
  databaseUrl: string;
  api: { host: string; port: number; trustProxyHops: number };
  logLevel: LogLevel;
  worker: { pollIntervalMs: number };
  storage: StorageConfig;
  auth: {
    /**
     * Schlüsselmaterial für die Verschlüsselung von Auth-Geheimnissen im
     * Ruhezustand (z. B. TOTP-Secrets). Muss je Umgebung verschieden sein –
     * wird von assertConfigsIsolated geprüft.
     */
    secretKey: string;
    /** Origin-Allowlist für den CSRF-Legacy-Fallback (meist leer). */
    allowedOrigins: readonly string[];
  };
  /** Phase 10: Lexware-Office-Anbindung (Public API). */
  lexware: LexwareConfig;
  /** Phase 12: E-Mail (SMTP-Versand, IMAP-Eingang). */
  mail: MailConfig;
  /** Phase 12: Verschlüsselung von Kommunikations-Geheimnissen (Links, Codes) in der Datenbank. */
  communication: CommunicationConfig;
  /** Phase 12: WhatsApp (ausschließlich Meta WhatsApp Business Cloud API). */
  whatsapp: WhatsAppConfig;
  /** Phase 12: Web Push (RFC 8030/8291/8292, VAPID). */
  push: PushConfig;
}

/**
 * E-Mail-Konfiguration (Phase 12):
 * - Versand nur bei MAIL_ENABLED=true UND vollständigen SMTP-Daten (fail-closed).
 * - production/staging: nur TLS (implizit 465 oder STARTTLS-Pflicht); ungültige
 *   Zertifikate werden nie akzeptiert (keine Option dafür); Hosts nur per env.
 * - demo: Versand nur an die Whitelist MAIL_DEMO_WHITELIST, Betreff mit "[DEMO]".
 * - IMAP-Eingang nur bei MAIL_IMAP_ENABLED=true UND vollständigen Zugangsdaten (fail-closed).
 * Passwörter existieren ausschließlich in diesem Objekt (nie Log/DB/Antwort).
 */
export interface MailConfig {
  enabled: boolean;
  smtp: {
    host: string;
    port: number;
    /** implizites TLS (meist 465) oder STARTTLS-Pflicht (meist 587). */
    tls: 'implicit' | 'starttls';
    user: string;
    password: string;
  } | null;
  imap: {
    host: string;
    port: number;
    tls: 'implicit' | 'starttls';
    user: string;
    password: string;
    folder: string;
  } | null;
  fromName: string;
  fromAddress: string | null;
  /** Antwortadresse (Reply-To); Default = fromAddress. */
  replyAddress: string | null;
  /** Nur demo: erlaubte Empfänger (kleingeschrieben; `@domain` = ganze Domain). */
  demoWhitelist: readonly string[];
  /** Absolute Basis-URL der öffentlichen Web-App (Angebots-/Aktionslinks), ohne Slash am Ende. */
  publicWebBaseUrl: string | null;
}

export interface CommunicationConfig {
  /** Aktueller Schlüssel (>= 32 Zeichen) für AES-256-GCM-Payloads (Schlüssel-ID wird abgeleitet). */
  payloadKey: string;
  /** Genau ein Vorgängerschlüssel für die Rotation (nur Entschlüsselung), optional. */
  payloadKeyPrevious: string | null;
}

export const WHATSAPP_GRAPH_BASE_URL = 'https://graph.facebook.com';
/**
 * Graph-API-Version (verifiziert 2026-10-19, developers.facebook.com
 * „Graph API changelog / versions“): aktuell v26.0 (veröffentlicht 2026-07-29,
 * Ablauf „TBD“); auch das offizielle Cloud-API-Media-Beispiel nutzt v26.0.
 * Kein „latest“ in URLs – die Version wird immer explizit gesetzt.
 */
export const WHATSAPP_DEFAULT_GRAPH_API_VERSION = 'v26.0';
/**
 * Älteste beim Verifikationsdatum noch nicht abgelaufene Version laut
 * Meta-Versionstabelle (v21.0: verfügbar bis 2027-01-21; v20.0 seit
 * 2026-09-24 abgelaufen). Ältere explizite Werte werden abgelehnt.
 */
export const WHATSAPP_MIN_GRAPH_API_VERSION = 'v21.0';

function graphVersionNumber(version: string): number {
  const match = /^v(\d{1,3})\.(\d{1,3})$/.exec(version);
  return match === null ? Number.NaN : Number(match[1]) * 1000 + Number(match[2]);
}

/**
 * WhatsApp-Konfiguration (Phase 12):
 * - production: `live` genau dann, wenn WHATSAPP_ENABLED=true und alle Werte
 *   gesetzt sind; Host fest graph.facebook.com (WHATSAPP_BASE_URL abgelehnt);
 *   sonst `disabled`.
 * - demo: immer `mock` (simulierter Gateway); echte Zugangsdaten sind dort ein Fehler.
 * - development: `mock`, per Opt-in (WHATSAPP_ENABLED=true + Werte) `live`,
 *   WHATSAPP_BASE_URL darf auf einen lokalen Fake zeigen.
 * - staging: `disabled`, per Opt-in `live`.
 */
export interface WhatsAppConfig {
  mode: 'disabled' | 'live' | 'mock';
  accessToken: string | null;
  phoneNumberId: string | null;
  businessAccountId: string | null;
  /** App-Secret für X-Hub-Signature-256 (Webhook). */
  appSecret: string | null;
  /** Verify-Token für die Webhook-Registrierung (GET hub.verify_token). */
  verifyToken: string | null;
  graphApiVersion: string;
  baseUrl: string;
}

/**
 * Web-Push-Konfiguration (Phase 12): aktiv genau dann, wenn alle drei VAPID-
 * Werte gesetzt sind. Der private Schlüssel existiert nur hier.
 */
export interface PushConfig {
  enabled: boolean;
  vapidPublicKey: string | null;
  vapidPrivateKey: string | null;
  /** `mailto:` oder `https://` (RFC 8292 sub). */
  vapidSubject: string | null;
}

/**
 * Lexware-Konfiguration (Phase 10, Order §§4/5):
 * - production: `enabled` genau dann, wenn LEXWARE_API_KEY gesetzt ist; Host
 *   ist fest api.lexware.io (LEXWARE_BASE_URL wird in production abgelehnt).
 * - demo: niemals aktiv – ein gesetzter LEXWARE_API_KEY ist ein Konfigurationsfehler.
 * - development/staging: nur per explizitem Opt-in (LEXWARE_ENABLED=true + Key);
 *   LEXWARE_BASE_URL darf hier auf einen lokalen Fake-/Testserver zeigen.
 * Der API-Key existiert ausschließlich in diesem Objekt (nie Log/DB/Antwort).
 */
export interface LexwareConfig {
  enabled: boolean;
  /** Nur gesetzt, wenn enabled; nie serialisieren. */
  apiKey: string | null;
  baseUrl: string;
  /** Erwartete organizationId (Pinning gegen falschen Lexware-Account); optional. */
  organizationId: string | null;
  /** Öffentliche Callback-URL für Event-Subscriptions (HTTPS, production Pflicht bei enabled). */
  webhookCallbackUrl: string | null;
  /** Optionaler Ersatz für den offiziellen Lexware-Webhook-Public-Key (PEM); Tests/Fake. */
  webhookPublicKeyPem: string | null;
  /** Administrativ gesetztes Erinnerungsdatum für die Key-Rotation (YYYY-MM-DD), optional. */
  apiKeyReminderDate: string | null;
  /** Timeout je HTTP-Aufruf. */
  requestTimeoutMs: number;
}

export const LEXWARE_PRODUCTION_BASE_URL = 'https://api.lexware.io';

/**
 * Wird geworfen, wenn Umgebungsvariablen fehlen oder ungültig sind.
 * Enthält nur Variablennamen und Fehlerbeschreibungen, niemals Werte,
 * damit keine Secrets in Logs landen.
 */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Ungültige Konfiguration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const portSchema = z.coerce.number().int().min(1).max(65535);

const rawEnvSchema = z.object({
  APP_ENV: z.enum(APP_ENVIRONMENTS),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\/.+/, 'muss eine PostgreSQL-Verbindungs-URL sein')
    .optional(),
  API_PORT: portSchema.optional(),
  API_HOST: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(3_600_000).optional(),
  STORAGE_DRIVER: z.enum(['fs', 's3']).optional(),
  STORAGE_FS_ROOT: z.string().min(1).optional(),
  STORAGE_S3_ENDPOINT: z
    .string()
    .regex(/^https?:\/\/.+/, 'muss eine http(s)-URL sein')
    .optional(),
  STORAGE_S3_REGION: z.string().min(1).optional(),
  STORAGE_S3_BUCKET: z.string().min(1).optional(),
  STORAGE_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  STORAGE_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  AUTH_SECRET_KEY: z.string().min(32, 'muss mindestens 32 Zeichen lang sein').max(256).optional(),
  /** Kommagetrennte Origin-Allowlist für den CSRF-Legacy-Fallback (optional). */
  AUTH_ALLOWED_ORIGINS: z.string().optional(),
  /**
   * Anzahl vertrauenswürdiger Proxy-Hops vor der API (z. B. 1 hinter dem
   * Staff-Proxy/nginx), damit request.ip die echte Client-IP aus
   * X-Forwarded-For auflöst. 0 = keinem Proxy vertrauen (Default).
   */
  API_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).optional(),
  // Phase 10 – Lexware Office Public API
  LEXWARE_API_KEY: z.string().min(1).max(512).optional(),
  LEXWARE_ENABLED: z.enum(['true', 'false']).optional(),
  LEXWARE_BASE_URL: z
    .string()
    .regex(/^https?:\/\/.+/, 'muss eine http(s)-URL sein')
    .optional(),
  LEXWARE_ORGANIZATION_ID: z.string().min(1).max(128).optional(),
  LEXWARE_WEBHOOK_CALLBACK_URL: z
    .string()
    .regex(/^https?:\/\/.+/, 'muss eine http(s)-URL sein')
    .optional(),
  LEXWARE_WEBHOOK_PUBLIC_KEY_PEM: z.string().min(1).optional(),
  LEXWARE_API_KEY_REMINDER_DATE: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'muss YYYY-MM-DD sein')
    .optional(),
  LEXWARE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).optional(),
  // Phase 12 – E-Mail
  MAIL_ENABLED: z.enum(['true', 'false']).optional(),
  MAIL_SMTP_HOST: z.string().min(1).max(253).optional(),
  MAIL_SMTP_PORT: portSchema.optional(),
  MAIL_SMTP_SECURE: z.enum(['true', 'false']).optional(),
  MAIL_SMTP_USER: z.string().min(1).max(256).optional(),
  MAIL_SMTP_PASSWORD: z.string().min(1).max(1024).optional(),
  MAIL_IMAP_ENABLED: z.enum(['true', 'false']).optional(),
  MAIL_IMAP_HOST: z.string().min(1).max(253).optional(),
  MAIL_IMAP_PORT: portSchema.optional(),
  MAIL_IMAP_SECURE: z.enum(['true', 'false']).optional(),
  MAIL_IMAP_USER: z.string().min(1).max(256).optional(),
  MAIL_IMAP_PASSWORD: z.string().min(1).max(1024).optional(),
  MAIL_IMAP_FOLDER: z.string().min(1).max(256).optional(),
  MAIL_FROM_NAME: z.string().min(1).max(128).optional(),
  MAIL_FROM_ADDRESS: z.string().email('muss eine E-Mail-Adresse sein').max(254).optional(),
  MAIL_REPLY_ADDRESS: z.string().email('muss eine E-Mail-Adresse sein').max(254).optional(),
  /** Kommagetrennt: vollständige Adressen oder `@domain` (nur demo). */
  MAIL_DEMO_WHITELIST: z.string().max(4096).optional(),
  MAIL_PUBLIC_WEB_BASE_URL: z
    .string()
    .regex(/^https?:\/\/[^\s]+$/, 'muss eine absolute http(s)-URL sein')
    .optional(),
  // Phase 12 – Verschlüsselung von Kommunikations-Geheimnissen
  COMMUNICATION_PAYLOAD_KEY: z
    .string()
    .min(32, 'muss mindestens 32 Zeichen lang sein')
    .max(256)
    .optional(),
  COMMUNICATION_PAYLOAD_KEY_PREVIOUS: z
    .string()
    .min(32, 'muss mindestens 32 Zeichen lang sein')
    .max(256)
    .optional(),
  // Phase 12 – WhatsApp Business Cloud API
  WHATSAPP_ENABLED: z.enum(['true', 'false']).optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1).max(2048).optional(),
  WHATSAPP_PHONE_NUMBER_ID: z
    .string()
    .regex(/^\d{1,32}$/, 'muss numerisch sein')
    .optional(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z
    .string()
    .regex(/^\d{1,32}$/, 'muss numerisch sein')
    .optional(),
  WHATSAPP_APP_SECRET: z.string().min(16).max(512).optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(16).max(512).optional(),
  WHATSAPP_GRAPH_API_VERSION: z
    .string()
    .regex(/^v\d{1,3}\.\d{1,3}$/, 'muss die Form vNN.N haben')
    .optional(),
  WHATSAPP_BASE_URL: z
    .string()
    .regex(/^https?:\/\/.+/, 'muss eine http(s)-URL sein')
    .optional(),
  // Phase 12 – Web Push (VAPID)
  PUSH_VAPID_PUBLIC_KEY: z.string().min(1).max(512).optional(),
  PUSH_VAPID_PRIVATE_KEY: z.string().min(1).max(512).optional(),
  PUSH_VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/, 'muss mailto: oder https:// sein')
    .optional(),
});

/**
 * Sichere Defaults gibt es ausschließlich für APP_ENV=development,
 * passend zur lokalen Infrastruktur aus infra/docker-compose.yml.
 * staging/demo/production müssen jede sicherheitsrelevante Variable
 * explizit setzen – fehlende Werte führen zum sofortigen Startabbruch.
 */
const DEVELOPMENT_DEFAULTS = {
  DATABASE_URL: 'postgresql://mietroyal:mietroyal_local_dev@localhost:55432/mietroyal_dev',
  STORAGE_DRIVER: 'fs',
  STORAGE_FS_ROOT: '.storage',
  // Nur lokale Entwicklung – kein Geheimnis. Verschlüsselt lokale
  // TOTP-Secrets; alle anderen Umgebungen MÜSSEN einen eigenen Wert setzen.
  AUTH_SECRET_KEY: 'mietroyal-development-only-auth-secret-key',
  // Nur lokale Entwicklung – kein Geheimnis. Verschlüsselt lokale
  // Kommunikations-Payloads (Links/Codes); alle anderen Umgebungen MÜSSEN
  // einen eigenen Wert setzen.
  COMMUNICATION_PAYLOAD_KEY: 'mietroyal-development-only-communication-payload-key',
} as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = rawEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'APP_ENV'}: ${issue.message}`),
    );
  }

  const raw = parsed.data;
  const isDevelopment = raw.APP_ENV === 'development';

  const problems: string[] = [];
  const requireVar = <T>(value: T | undefined, name: string, devDefault?: T): T | undefined => {
    if (value !== undefined) return value;
    if (isDevelopment && devDefault !== undefined) return devDefault;
    problems.push(`${name}: muss für APP_ENV=${raw.APP_ENV} gesetzt sein`);
    return undefined;
  };

  const databaseUrl = requireVar(
    raw.DATABASE_URL,
    'DATABASE_URL',
    DEVELOPMENT_DEFAULTS.DATABASE_URL,
  );
  const storageDriver = requireVar(
    raw.STORAGE_DRIVER,
    'STORAGE_DRIVER',
    DEVELOPMENT_DEFAULTS.STORAGE_DRIVER,
  );
  const authSecretKey = requireVar(
    raw.AUTH_SECRET_KEY,
    'AUTH_SECRET_KEY',
    DEVELOPMENT_DEFAULTS.AUTH_SECRET_KEY,
  );

  let storage: StorageConfig | undefined;
  if (storageDriver === 'fs') {
    const fsRoot = requireVar(
      raw.STORAGE_FS_ROOT,
      'STORAGE_FS_ROOT',
      DEVELOPMENT_DEFAULTS.STORAGE_FS_ROOT,
    );
    if (fsRoot !== undefined) storage = { driver: 'fs', fsRoot };
  } else if (storageDriver === 's3') {
    const endpoint = requireVar(raw.STORAGE_S3_ENDPOINT, 'STORAGE_S3_ENDPOINT');
    const region = requireVar(raw.STORAGE_S3_REGION, 'STORAGE_S3_REGION');
    const bucket = requireVar(raw.STORAGE_S3_BUCKET, 'STORAGE_S3_BUCKET');
    const accessKeyId = requireVar(raw.STORAGE_S3_ACCESS_KEY_ID, 'STORAGE_S3_ACCESS_KEY_ID');
    const secretAccessKey = requireVar(
      raw.STORAGE_S3_SECRET_ACCESS_KEY,
      'STORAGE_S3_SECRET_ACCESS_KEY',
    );
    if (endpoint && region && bucket && accessKeyId && secretAccessKey) {
      storage = { driver: 's3', endpoint, region, bucket, accessKeyId, secretAccessKey };
    }
  }

  // Phase 10: Lexware-Konfiguration je Umgebung (fail-closed, nie Mock in production).
  const lexwareKey = raw.LEXWARE_API_KEY?.trim();
  let lexwareEnabled = false;
  let lexwareBaseUrl = LEXWARE_PRODUCTION_BASE_URL;
  if (raw.APP_ENV === 'production') {
    lexwareEnabled = lexwareKey !== undefined && lexwareKey !== '';
    if (
      raw.LEXWARE_BASE_URL !== undefined &&
      raw.LEXWARE_BASE_URL.replace(/\/+$/, '') !== LEXWARE_PRODUCTION_BASE_URL
    ) {
      problems.push(
        'LEXWARE_BASE_URL: in production ist ausschließlich https://api.lexware.io zulässig',
      );
    }
    if (
      lexwareEnabled &&
      raw.LEXWARE_WEBHOOK_CALLBACK_URL !== undefined &&
      !/^https:\/\//.test(raw.LEXWARE_WEBHOOK_CALLBACK_URL)
    ) {
      problems.push('LEXWARE_WEBHOOK_CALLBACK_URL: in production nur HTTPS');
    }
    if (
      lexwareEnabled &&
      raw.LEXWARE_WEBHOOK_CALLBACK_URL !== undefined &&
      /localhost|127\.0\.0\.1/.test(raw.LEXWARE_WEBHOOK_CALLBACK_URL)
    ) {
      problems.push('LEXWARE_WEBHOOK_CALLBACK_URL: in production keine localhost-Adresse');
    }
    if (raw.LEXWARE_WEBHOOK_PUBLIC_KEY_PEM !== undefined) {
      problems.push(
        'LEXWARE_WEBHOOK_PUBLIC_KEY_PEM: in production nicht zulässig (nur der offizielle Lexware-Schlüssel)',
      );
    }
  } else if (raw.APP_ENV === 'demo') {
    if (lexwareKey !== undefined && lexwareKey !== '') {
      problems.push('LEXWARE_API_KEY: in demo nicht zulässig (Demo bucht niemals in Lexware)');
    }
  } else {
    lexwareEnabled =
      raw.LEXWARE_ENABLED === 'true' && lexwareKey !== undefined && lexwareKey !== '';
    if (raw.LEXWARE_ENABLED === 'true' && (lexwareKey === undefined || lexwareKey === '')) {
      problems.push('LEXWARE_API_KEY: muss gesetzt sein, wenn LEXWARE_ENABLED=true');
    }
    if (raw.LEXWARE_BASE_URL !== undefined)
      lexwareBaseUrl = raw.LEXWARE_BASE_URL.replace(/\/+$/, '');
  }

  // Phase 12: Kommunikations-Payload-Schlüssel (Pflicht außerhalb von development).
  const communicationPayloadKey = requireVar(
    raw.COMMUNICATION_PAYLOAD_KEY,
    'COMMUNICATION_PAYLOAD_KEY',
    DEVELOPMENT_DEFAULTS.COMMUNICATION_PAYLOAD_KEY,
  );
  if (
    raw.COMMUNICATION_PAYLOAD_KEY_PREVIOUS !== undefined &&
    raw.COMMUNICATION_PAYLOAD_KEY_PREVIOUS === communicationPayloadKey
  ) {
    problems.push(
      'COMMUNICATION_PAYLOAD_KEY_PREVIOUS: darf nicht dem aktuellen Schlüssel gleichen',
    );
  }

  const mail = buildMailConfig(raw, problems);
  const whatsapp = buildWhatsAppConfig(raw, problems);
  const push = buildPushConfig(raw, problems);

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  if (
    databaseUrl === undefined ||
    storage === undefined ||
    authSecretKey === undefined ||
    communicationPayloadKey === undefined
  ) {
    // Durch die problems-Prüfung oben nicht erreichbar; hält die Typen eng.
    throw new ConfigError(['Konfiguration unvollständig']);
  }

  return {
    appEnv: raw.APP_ENV,
    databaseUrl,
    api: {
      host: raw.API_HOST ?? '127.0.0.1',
      port: raw.API_PORT ?? 3001,
      trustProxyHops: raw.API_TRUST_PROXY_HOPS ?? 0,
    },
    logLevel: raw.LOG_LEVEL ?? (isDevelopment ? 'debug' : 'info'),
    worker: {
      pollIntervalMs: raw.WORKER_POLL_INTERVAL_MS ?? 2000,
    },
    storage,
    auth: {
      secretKey: authSecretKey,
      allowedOrigins: (raw.AUTH_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin !== ''),
    },
    lexware: {
      enabled: lexwareEnabled,
      apiKey: lexwareEnabled && lexwareKey !== undefined ? lexwareKey : null,
      baseUrl: lexwareBaseUrl,
      organizationId: raw.LEXWARE_ORGANIZATION_ID ?? null,
      webhookCallbackUrl: raw.LEXWARE_WEBHOOK_CALLBACK_URL ?? null,
      webhookPublicKeyPem: raw.LEXWARE_WEBHOOK_PUBLIC_KEY_PEM ?? null,
      apiKeyReminderDate: raw.LEXWARE_API_KEY_REMINDER_DATE ?? null,
      requestTimeoutMs: raw.LEXWARE_REQUEST_TIMEOUT_MS ?? 15_000,
    },
    mail,
    communication: {
      payloadKey: communicationPayloadKey,
      payloadKeyPrevious: raw.COMMUNICATION_PAYLOAD_KEY_PREVIOUS ?? null,
    },
    whatsapp,
    push,
  };
}

type RawEnv = z.infer<typeof rawEnvSchema>;

const isTlsRequiredEnv = (env: AppEnvironment): boolean =>
  env === 'production' || env === 'staging';

function buildMailConfig(raw: RawEnv, problems: string[]): MailConfig {
  const enabled = raw.MAIL_ENABLED === 'true';
  const tlsRequired = isTlsRequiredEnv(raw.APP_ENV);

  let smtp: MailConfig['smtp'] = null;
  if (enabled) {
    for (const name of [
      'MAIL_SMTP_HOST',
      'MAIL_SMTP_USER',
      'MAIL_SMTP_PASSWORD',
      'MAIL_FROM_ADDRESS',
    ] as const) {
      if (raw[name] === undefined) {
        problems.push(`${name}: muss gesetzt sein, wenn MAIL_ENABLED=true`);
      }
    }
    if (tlsRequired && /^(localhost|127\.0\.0\.1)$/i.test(raw.MAIL_SMTP_HOST ?? '')) {
      problems.push(`MAIL_SMTP_HOST: in ${raw.APP_ENV} keine localhost-Adresse`);
    }
    if (
      raw.MAIL_SMTP_HOST !== undefined &&
      raw.MAIL_SMTP_USER !== undefined &&
      raw.MAIL_SMTP_PASSWORD !== undefined
    ) {
      const implicit = raw.MAIL_SMTP_SECURE === undefined ? true : raw.MAIL_SMTP_SECURE === 'true';
      smtp = {
        host: raw.MAIL_SMTP_HOST,
        port: raw.MAIL_SMTP_PORT ?? (implicit ? 465 : 587),
        tls: implicit ? 'implicit' : 'starttls',
        user: raw.MAIL_SMTP_USER,
        password: raw.MAIL_SMTP_PASSWORD,
      };
    }
  }

  let imap: MailConfig['imap'] = null;
  if (raw.MAIL_IMAP_ENABLED === 'true') {
    for (const name of ['MAIL_IMAP_HOST', 'MAIL_IMAP_USER', 'MAIL_IMAP_PASSWORD'] as const) {
      if (raw[name] === undefined) {
        problems.push(`${name}: muss gesetzt sein, wenn MAIL_IMAP_ENABLED=true`);
      }
    }
  }
  if (raw.MAIL_IMAP_ENABLED === 'true' && raw.MAIL_IMAP_HOST !== undefined) {
    if (raw.MAIL_IMAP_USER !== undefined && raw.MAIL_IMAP_PASSWORD !== undefined) {
      const implicit = raw.MAIL_IMAP_SECURE === undefined ? true : raw.MAIL_IMAP_SECURE === 'true';
      imap = {
        host: raw.MAIL_IMAP_HOST,
        port: raw.MAIL_IMAP_PORT ?? (implicit ? 993 : 143),
        tls: implicit ? 'implicit' : 'starttls',
        user: raw.MAIL_IMAP_USER,
        password: raw.MAIL_IMAP_PASSWORD,
        folder: raw.MAIL_IMAP_FOLDER ?? 'INBOX',
      };
    }
    if (tlsRequired && /^(localhost|127\.0\.0\.1)$/i.test(raw.MAIL_IMAP_HOST)) {
      problems.push(`MAIL_IMAP_HOST: in ${raw.APP_ENV} keine localhost-Adresse`);
    }
  }

  const demoWhitelist = (raw.MAIL_DEMO_WHITELIST ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  for (const entry of demoWhitelist) {
    if (!/^(@[^\s@]+\.[^\s@]+|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(entry)) {
      problems.push('MAIL_DEMO_WHITELIST: Einträge müssen Adressen oder @domain sein');
      break;
    }
  }
  if (raw.APP_ENV === 'demo') {
    if (enabled && demoWhitelist.length === 0) {
      problems.push(
        'MAIL_DEMO_WHITELIST: in demo Pflicht, wenn MAIL_ENABLED=true (Demo sendet nur an freigegebene Adressen)',
      );
    }
  } else if (raw.APP_ENV === 'production' && raw.MAIL_DEMO_WHITELIST !== undefined) {
    problems.push('MAIL_DEMO_WHITELIST: in production nicht zulässig (nur demo)');
  }

  if (
    enabled &&
    raw.APP_ENV === 'production' &&
    raw.MAIL_PUBLIC_WEB_BASE_URL !== undefined &&
    !/^https:\/\//.test(raw.MAIL_PUBLIC_WEB_BASE_URL)
  ) {
    problems.push('MAIL_PUBLIC_WEB_BASE_URL: in production nur HTTPS');
  }
  // Härtung RA-11: Angebots-, Aktions- und Dokumentmails enthalten Links – ohne Basis-URL
  // würde jede solche Mail erst im Versandjob scheitern (Angebot „versendet“, Kunde erhält
  // nichts). Außerhalb von development (dort gibt es einen lokalen Default) daher Pflicht.
  if (enabled && raw.APP_ENV !== 'development' && raw.MAIL_PUBLIC_WEB_BASE_URL === undefined) {
    problems.push(
      `MAIL_PUBLIC_WEB_BASE_URL: in ${raw.APP_ENV} Pflicht, wenn MAIL_ENABLED=true (Links in Kundenmails)`,
    );
  }

  return {
    enabled: enabled && smtp !== null,
    smtp,
    imap,
    fromName: raw.MAIL_FROM_NAME ?? 'Miet-Royal Mainz',
    fromAddress: raw.MAIL_FROM_ADDRESS ?? null,
    replyAddress: raw.MAIL_REPLY_ADDRESS ?? raw.MAIL_FROM_ADDRESS ?? null,
    demoWhitelist: raw.APP_ENV === 'demo' ? demoWhitelist : [],
    publicWebBaseUrl: raw.MAIL_PUBLIC_WEB_BASE_URL?.replace(/\/+$/, '') ?? null,
  };
}

function buildWhatsAppConfig(raw: RawEnv, problems: string[]): WhatsAppConfig {
  const secretNames = [
    'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_BUSINESS_ACCOUNT_ID',
    'WHATSAPP_APP_SECRET',
    'WHATSAPP_VERIFY_TOKEN',
  ] as const;
  const complete = secretNames.every((name) => raw[name] !== undefined);
  const anySet = secretNames.some((name) => raw[name] !== undefined);
  const optIn = raw.WHATSAPP_ENABLED === 'true';
  let mode: WhatsAppConfig['mode'] = 'disabled';
  let baseUrl = WHATSAPP_GRAPH_BASE_URL;

  if (raw.APP_ENV === 'demo') {
    mode = 'mock';
    if (anySet || optIn) {
      problems.push(
        'WHATSAPP_*: in demo nicht zulässig (Demo nutzt ausschließlich den simulierten WhatsApp-Gateway)',
      );
    }
  } else {
    if (optIn && !complete) {
      for (const name of secretNames) {
        if (raw[name] === undefined) {
          problems.push(`${name}: muss gesetzt sein, wenn WHATSAPP_ENABLED=true`);
        }
      }
    }
    if (optIn && complete) mode = 'live';
    else if (raw.APP_ENV === 'development') mode = 'mock';

    if (raw.APP_ENV === 'production') {
      if (
        raw.WHATSAPP_BASE_URL !== undefined &&
        raw.WHATSAPP_BASE_URL.replace(/\/+$/, '') !== WHATSAPP_GRAPH_BASE_URL
      ) {
        problems.push(
          'WHATSAPP_BASE_URL: in production ist ausschließlich https://graph.facebook.com zulässig',
        );
      }
    } else if (raw.WHATSAPP_BASE_URL !== undefined) {
      baseUrl = raw.WHATSAPP_BASE_URL.replace(/\/+$/, '');
    }
  }

  if (
    raw.WHATSAPP_GRAPH_API_VERSION !== undefined &&
    graphVersionNumber(raw.WHATSAPP_GRAPH_API_VERSION) <
      graphVersionNumber(WHATSAPP_MIN_GRAPH_API_VERSION)
  ) {
    problems.push(
      `WHATSAPP_GRAPH_API_VERSION: Version ist laut Meta nicht mehr verfügbar (mindestens ${WHATSAPP_MIN_GRAPH_API_VERSION})`,
    );
  }

  const live = mode === 'live';
  return {
    mode,
    accessToken: live ? (raw.WHATSAPP_ACCESS_TOKEN ?? null) : null,
    phoneNumberId: live ? (raw.WHATSAPP_PHONE_NUMBER_ID ?? null) : null,
    businessAccountId: live ? (raw.WHATSAPP_BUSINESS_ACCOUNT_ID ?? null) : null,
    appSecret: live ? (raw.WHATSAPP_APP_SECRET ?? null) : null,
    verifyToken: live ? (raw.WHATSAPP_VERIFY_TOKEN ?? null) : null,
    graphApiVersion: raw.WHATSAPP_GRAPH_API_VERSION ?? WHATSAPP_DEFAULT_GRAPH_API_VERSION,
    baseUrl,
  };
}

function buildPushConfig(raw: RawEnv, problems: string[]): PushConfig {
  const names = ['PUSH_VAPID_PUBLIC_KEY', 'PUSH_VAPID_PRIVATE_KEY', 'PUSH_VAPID_SUBJECT'] as const;
  const setCount = names.filter((name) => raw[name] !== undefined).length;
  if (setCount > 0 && setCount < names.length) {
    for (const name of names) {
      if (raw[name] === undefined) {
        problems.push(`${name}: muss gesetzt sein, wenn Web Push (PUSH_VAPID_*) konfiguriert ist`);
      }
    }
  }
  const enabled = setCount === names.length;
  return {
    enabled,
    vapidPublicKey: enabled ? (raw.PUSH_VAPID_PUBLIC_KEY ?? null) : null,
    vapidPrivateKey: enabled ? (raw.PUSH_VAPID_PRIVATE_KEY ?? null) : null,
    vapidSubject: enabled ? (raw.PUSH_VAPID_SUBJECT ?? null) : null,
  };
}
