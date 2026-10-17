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

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  if (databaseUrl === undefined || storage === undefined || authSecretKey === undefined) {
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
  };
}
