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
  api: { host: string; port: number };
  logLevel: LogLevel;
  worker: { pollIntervalMs: number };
  storage: StorageConfig;
}

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

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  if (databaseUrl === undefined || storage === undefined) {
    // Durch die problems-Prüfung oben nicht erreichbar; hält die Typen eng.
    throw new ConfigError(['Konfiguration unvollständig']);
  }

  return {
    appEnv: raw.APP_ENV,
    databaseUrl,
    api: {
      host: raw.API_HOST ?? '127.0.0.1',
      port: raw.API_PORT ?? 3001,
    },
    logLevel: raw.LOG_LEVEL ?? (isDevelopment ? 'debug' : 'info'),
    worker: {
      pollIntervalMs: raw.WORKER_POLL_INTERVAL_MS ?? 2000,
    },
    storage,
  };
}
