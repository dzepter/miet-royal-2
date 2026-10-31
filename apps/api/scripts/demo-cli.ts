/**
 * Phase 14: gemeinsame Bausteine der Demo-Kommandos `pnpm demo:seed` und
 * `pnpm demo:reset` – Umgebungsschutz (nur APP_ENV=demo), Akteur (erster
 * aktiver Systemadmin, nie angelegt), Logger ohne Inhalte, Datenbankname fürs
 * Protokoll (nie die Verbindungs-URL, nie Secrets).
 */
import type { AppConfig } from '@mietroyal/config';
import type { Database } from '@mietroyal/database';
import type { JobRunnerLogger } from '@mietroyal/integrations';
import { findFirstActiveSystemAdmin } from '../src/demo/seed/seed-service.ts';

export const DEMO_ONLY_MESSAGE = 'Nur in APP_ENV=demo erlaubt.';

/** Bricht mit Exit-Code 2 ab, wenn die Umgebung nicht `demo` ist. */
export function assertDemoCli(config: AppConfig): void {
  if (config.appEnv !== 'demo') {
    console.error(`${DEMO_ONLY_MESSAGE} (APP_ENV=${config.appEnv})`);
    process.exit(2);
  }
}

/** Datenbankname aus der URL (nur der Pfad – nie Host-Zugangsdaten). */
export function databaseNameOf(config: AppConfig): string {
  try {
    return new URL(config.databaseUrl).pathname.replace(/^\//, '') || '(unbekannt)';
  } catch {
    return '(unbekannt)';
  }
}

/** Erster aktiver Systemadmin oder Abbruch mit Hinweis auf den Bootstrap. */
export async function requireSystemAdmin(db: Database): Promise<string> {
  const adminId = await findFirstActiveSystemAdmin(db);
  if (adminId === null) {
    console.error(
      'Kein aktiver Systemadmin vorhanden – zuerst „pnpm staff:bootstrap-admin“ in der Demo-Umgebung ausführen.',
    );
    process.exit(2);
  }
  return adminId;
}

/** Konsolen-Logger der Kommandos: nur Zähler/Codes/Namen, nie Inhalte oder Secrets. */
export function cliLogger(): JobRunnerLogger {
  const line = (level: string, context: Record<string, unknown>, message: string) => {
    const parts = Object.entries(context)
      .filter(([, value]) => value !== undefined)
      .map(
        ([key, value]) =>
          `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`,
      );
    const text = `[${level}] ${message}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
    if (level === 'error') console.error(text);
    else if (level === 'warn') console.warn(text);
    else console.log(text);
  };
  return {
    info: (context, message) => line('info', context, message),
    warn: (context, message) => line('warn', context, message),
    error: (context, message) => line('error', context, message),
  };
}

export function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}
