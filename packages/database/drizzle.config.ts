import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit wird nur zum GENERIEREN versionierter SQL-Migrationen genutzt
 * (pnpm db:generate). Angewendet werden Migrationen ausschließlich über
 * scripts/migrate.ts (pnpm db:migrate) – reproduzierbar in jeder Umgebung.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
});
