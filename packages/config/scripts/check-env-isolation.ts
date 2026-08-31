/**
 * Produktionsnaher Check: stellt sicher, dass zwei Umgebungs-Konfigurationen
 * (z. B. production und demo) nicht still auf dieselbe Datenbank oder
 * denselben Storage zusammenfallen.
 *
 * Aufruf:
 *   pnpm check:env-isolation -- <env-datei-a> <env-datei-b>
 *
 * Die Dateien sind normale .env-Dateien (KEY=VALUE) und dürfen niemals ins
 * Repository committet werden. Der Check gibt keine Variablenwerte aus.
 */
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { assertConfigsIsolated, EnvironmentIsolationError, loadConfig } from '../src/index.ts';

function loadEnvFile(path: string): Record<string, string | undefined> {
  const content = readFileSync(path, 'utf8');
  return parseEnv(content) as Record<string, string | undefined>;
}

const [fileA, fileB] = process.argv.slice(2);
if (!fileA || !fileB) {
  console.error('Aufruf: check-env-isolation <env-datei-a> <env-datei-b>');
  console.error('Beispiel: check-env-isolation /etc/mietroyal/prod.env /etc/mietroyal/demo.env');
  process.exit(2);
}

try {
  const configA = loadConfig(loadEnvFile(fileA));
  const configB = loadConfig(loadEnvFile(fileB));
  assertConfigsIsolated(configA, configB);
  console.log(
    `OK: "${configA.appEnv}" (${fileA}) und "${configB.appEnv}" (${fileB}) sind isoliert.`,
  );
} catch (error) {
  if (error instanceof EnvironmentIsolationError) {
    console.error(error.message);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}
