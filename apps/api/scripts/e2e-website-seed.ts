/**
 * Phase 16 (E2E, Website/CMS/Konfigurator – Szenarien A–M): bereitet die Website-Inhalte einer
 * E2E-Datenbank vor. Läuft als Kindprozess der Specs (tests/e2e/helpers/website.ts) gegen die
 * per DATABASE_URL übergebene Datenbank – Sicherheitsstopp, wenn sie nicht `mietroyal_test`
 * im Namen trägt (nie dev/produktiv).
 *
 * - CMS-Inhalte AUSSCHLIESSLICH über den echten Bootstrap (`runCmsBootstrap` mit den
 *   redaktionellen Standard-Einträgen `CMS_BOOTSTRAP_ENTRIES`) inkl. `publishDemo` – derselbe
 *   Weg wie `pnpm cms:bootstrap --publish-demo` (gleiche Prüfregeln, Audit `cms.published` mit
 *   Quelle `bootstrap`). Damit ist auch `/datenschutz` veröffentlicht (Voraussetzung jeder
 *   Website-Anfrage, Order §17). Idempotent: vorhandene Einträge bleiben unverändert.
 * - Nötig je Spec: der Basis-Seed (scripts/e2e-seed.ts) leert `staff_users … CASCADE` und
 *   damit alle CMS-Tabellen.
 * - `E2E_WEBSITE_TARGET=main` (Default, APP_ENV development): zusätzlich zwei synthetische
 *   Mitarbeiter für Szenario I – „nur cms.edit“ und „nur cms.publish“ (je eigene Rolle, Passwort
 *   über den echten Einrichtungs-Token). Zugangsdaten kommen aus der Umgebung
 *   (tests/e2e/helpers/website.ts), Akteur der Rollenanlage ist der Basis-Admin.
 * - `E2E_WEBSITE_TARGET=demo` (Demo-Datenbank `mietroyal_test_demo`, Szenario K): nur die
 *   Inhalte, veröffentlicht mit `appEnv: 'demo'`; keine Mitarbeiter.
 *
 * Ausgabe: genau eine JSON-Zeile (Eintrags-IDs/Pfade, Zähler, Mitarbeiter-IDs) – nie
 * Passwörter, Tokens oder Inhalte. Exit 1, wenn ein Eintrag ungültig ist oder nicht
 * veröffentlicht werden konnte.
 */
import { loadConfig } from '@mietroyal/config';
import { cmsEntries, createDb, createPool, staffUsers } from '@mietroyal/database';
import type { PermissionKey } from '@mietroyal/permissions';
import { asc, eq } from 'drizzle-orm';
import { StaffAdminService } from '../src/auth/admin-service.ts';
import { NoopMailAdapter } from '../src/auth/mail.ts';
import { StaffAuthService } from '../src/auth/service.ts';
import { runCmsBootstrap } from '../src/cms/bootstrap.ts';
import { CMS_BOOTSTRAP_ENTRIES } from '../src/cms/bootstrap-content.ts';

interface SeedUser {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  roleName: string;
  permissionKeys: PermissionKey[];
}

const target = process.env.E2E_WEBSITE_TARGET === 'demo' ? 'demo' : 'main';
const config = loadConfig();
const databaseName = new URL(config.databaseUrl).pathname;
if (!databaseName.includes('mietroyal_test')) {
  console.error(
    'Sicherheitsstopp: e2e-website-seed läuft nur gegen eine mietroyal_test-Datenbank.',
  );
  process.exit(2);
}
if (target === 'demo' && databaseName !== '/mietroyal_test_demo') {
  console.error('Sicherheitsstopp: Ziel demo nur gegen mietroyal_test_demo.');
  process.exit(2);
}

function seedUsersFromEnv(): SeedUser[] {
  if (target !== 'main') return [];
  const raw = process.env.E2E_WEBSITE_USERS ?? '[]';
  return JSON.parse(raw) as SeedUser[];
}

const pool = createPool(config.databaseUrl);
let exitCode = 0;
try {
  const db = createDb(pool);
  const result = await runCmsBootstrap(db, {
    entries: CMS_BOOTSTRAP_ENTRIES,
    appEnv: target === 'demo' ? 'demo' : 'development',
    publishDemo: true,
    publicWebBaseUrl: config.mail.publicWebBaseUrl,
  });
  if (result.invalid.length > 0 || result.publishFailed.length > 0) exitCode = 1;

  const users: Record<string, string> = {};
  const seedUsers = seedUsersFromEnv();
  if (seedUsers.length > 0) {
    const adminEmail = (process.env.E2E_WEBSITE_ADMIN_EMAIL ?? '').toLowerCase();
    const adminRows = await db
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(eq(staffUsers.email, adminEmail));
    const adminId = adminRows[0]?.id;
    if (adminId === undefined) throw new Error('Basis-Admin fehlt (Basis-Seed zuerst ausführen)');
    const auth = new StaffAuthService(db, config, new NoopMailAdapter());
    const admin = new StaffAdminService(auth);
    for (const user of seedUsers) {
      const existing = await auth.findUserByEmail(user.email.trim().toLowerCase());
      if (existing !== undefined) {
        users[user.email] = existing.id;
        continue;
      }
      const created = await admin.createEmployee(adminId, {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
      });
      await auth.resetPassword(created.setupToken, user.password);
      const roleId = await admin.createRole(adminId, {
        name: user.roleName,
        permissionKeys: user.permissionKeys,
      });
      await admin.setUserRoles(adminId, created.user.id, [roleId]);
      users[user.email] = created.user.id;
    }
  }

  const entries = await db
    .select({
      id: cmsEntries.id,
      kind: cmsEntries.kind,
      pageType: cmsEntries.pageType,
      path: cmsEntries.path,
      published: cmsEntries.publishedRevisionId,
    })
    .from(cmsEntries)
    .orderBy(asc(cmsEntries.kind), asc(cmsEntries.path));

  process.stdout.write(
    `${JSON.stringify({
      created: result.created.length,
      skipped: result.skipped.length,
      published: result.published.length,
      invalid: result.invalid,
      publishFailed: result.publishFailed,
      entries: entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        pageType: entry.pageType,
        path: entry.path,
        isPublished: entry.published !== null,
      })),
      users,
    })}\n`,
  );
} finally {
  await pool.end();
}
process.exit(exitCode);
