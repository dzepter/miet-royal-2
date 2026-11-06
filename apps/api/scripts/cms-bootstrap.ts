/**
 * Phase 16 (Order §10, Design §2.1/§11.2.4): `pnpm cms:bootstrap [--publish-demo]`.
 *
 * - Legt FEHLENDE Standard-Einträge (Website-Einstellungen, Hauptseiten, Rechtstexte,
 *   sekundäre Angebote, erste Regionsseiten) aus `CMS_BOOTSTRAP_ENTRIES` als ENTWURF an.
 *   Idempotent – vorhandene Einträge bleiben unberührt, Redaktionsarbeit wird nie
 *   überschrieben. Ohne Flag wird NICHTS veröffentlicht.
 * - `--publish-demo` NUR bei APP_ENV development/demo (bzw. test): veröffentlicht die
 *   Entwürfe aller noch nie veröffentlichten Einträge über `CmsService.publish` (gleiche
 *   Prüfungen, Audit `cms.published` mit Quelle `bootstrap`). production/staging ⇒ Abbruch
 *   (Exit 2) VOR jeder Änderung.
 * - Läuft nie automatisch (kein API-Start, keine Migration, kein Deployment).
 * - Migrationen werden NICHT angewendet (`pnpm db:migrate` ist ein eigener Schritt).
 * - Ausgabe nur Pfade, Zähler und Fehlercodes – nie Inhalte oder Secrets.
 */
import { loadConfig } from '@mietroyal/config';
import { createDb, createPool } from '@mietroyal/database';
import {
  assertPublishDemoAllowed,
  CmsBootstrapRefusedError,
  runCmsBootstrap,
} from '../src/cms/bootstrap.ts';
import { CMS_BOOTSTRAP_ENTRIES } from '../src/cms/bootstrap-content.ts';

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--publish-demo' && arg !== '--');
if (unknown.length > 0) {
  console.error(`Unbekannte Option(en): ${unknown.join(' ')} – erlaubt ist nur --publish-demo.`);
  process.exit(2);
}
const publishDemo = args.includes('--publish-demo');

function refuseUnlessAllowed(appEnv: string): void {
  try {
    assertPublishDemoAllowed(appEnv);
  } catch (error) {
    console.error(error instanceof CmsBootstrapRefusedError ? error.message : String(error));
    process.exit(2);
  }
}

// Schon VOR dem Laden der Konfiguration: production/staging veröffentlichen nie automatisch –
// auch dann nicht, wenn die übrige Konfiguration unvollständig ist.
if (publishDemo) refuseUnlessAllowed(process.env.APP_ENV ?? 'development');
const config = loadConfig();
if (publishDemo) refuseUnlessAllowed(config.appEnv);

const pool = createPool(config.databaseUrl);
try {
  const db = createDb(pool);
  console.log(
    `CMS-Bootstrap startet (APP_ENV=${config.appEnv}, ${CMS_BOOTSTRAP_ENTRIES.length} Standard-Einträge${publishDemo ? ', mit --publish-demo' : ''}).`,
  );
  const result = await runCmsBootstrap(db, {
    entries: CMS_BOOTSTRAP_ENTRIES,
    appEnv: config.appEnv,
    publishDemo,
    publicWebBaseUrl: config.mail.publicWebBaseUrl,
  });
  for (const target of result.created) console.log(`  angelegt (Entwurf): ${target}`);
  for (const target of result.skipped) console.log(`  vorhanden, unverändert: ${target}`);
  for (const issue of result.invalid) {
    console.error(`  NICHT angelegt (${issue.code}): ${issue.target}`);
  }
  for (const target of result.published) console.log(`  veröffentlicht (Demo/Test): ${target}`);
  for (const issue of result.publishFailed) {
    console.error(`  NICHT veröffentlicht (${issue.code}): ${issue.target}`);
  }
  console.log(
    `CMS-Bootstrap fertig: ${result.created.length} angelegt, ${result.skipped.length} unverändert, ${result.invalid.length} ungültig` +
      (publishDemo
        ? `, ${result.published.length} veröffentlicht, ${result.publishFailed.length} nicht veröffentlicht.`
        : '.'),
  );
  if (result.invalid.length > 0 || result.publishFailed.length > 0) process.exitCode = 1;
} catch (error) {
  // Keine Fehlermeldung ausgeben: Datenbankfehler tragen SQL samt Inhalten.
  console.error(`CMS-Bootstrap abgebrochen (${error instanceof Error ? error.name : 'Fehler'}).`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
