import type { AppConfig } from './load-config.ts';

/**
 * Wird geworfen, wenn zwei Umgebungen (z. B. production und demo) auf
 * dieselbe Datenbank, denselben Storage oder dieselben Zugangsdaten zeigen.
 * Meldet nur, WELCHE Konfigurationsteile kollidieren – niemals die Werte.
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
